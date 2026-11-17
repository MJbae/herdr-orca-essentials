// Modified from Herdr 0.1.16; see NOTICE and LICENSE.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, checking } from "herdr";
import { parseStatus, stageAll, stageFile, unstageFile, commitStaged, readPushState, pushBranch } from "./git.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: space?.folder || pane?.cwd || f?.cwd, on: space?.machine ?? on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.summary = { total: 0, staged: 0, unstaged: 0, conflicts: 0 };
    this.pushState = null; this.selectedRemote = null; this.remoteOpen = false;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.pushState = null; this.selectedRemote = null; this.remoteOpen = false;
      this.summary = { total: 0, staged: 0, unstaged: 0, conflicts: 0 };
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.pushState = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a Git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [status, head, pushState] = await Promise.all([
          git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
          git(["rev-parse", "--verify", "HEAD"]),
          readPushState(exec, root, on, this.selectedRemote).catch(() => ({ canPush: false, reason: "Cannot read branch status.", remotes: [] })),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const state = parseStatus(status.stdout), entries = state.entries;
        for (const entry of entries.slice(0, 1000)) {
          const { xy, path, fresh, conflict } = entry;
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ ...entry, status: s, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.summary = state; this.limited = entries.length > 1000; this.error = null;
        this.pushState = pushState;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  stage(cx) {
    if (!this.root || this.busy || this.loading || !this.summary.unstaged || this.summary.conflicts || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = "stage"; this.note = null;
    cx.spawn(async cx => {
      try {
        await stageAll(exec, root, on);
        if (key() === context) { this.note = "All changes staged."; this.noteError = false; }
      } catch (error) {
        if (key() === context) { this.note = `Could not stage changes: ${error.message ?? error}`; this.noteError = true; }
      } finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  changeStage(file, cx) {
    if (!this.root || this.busy || this.loading || file.conflict || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, removing = file.staged;
    this.busy = "file"; this.busyFile = file.path; this.note = null;
    cx.spawn(async cx => {
      try {
        await (removing ? unstageFile : stageFile)(exec, root, on, file.path);
        if (key() === context) {
          this.note = removing ? "File unstaged. Your edits are kept." : "File staged.";
          this.noteError = false;
        }
      } catch (error) {
        if (key() === context) { this.note = `Could not update staging: ${error.message ?? error}`; this.noteError = true; }
      } finally { this.busy = false; this.busyFile = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || !this.summary.staged || this.summary.conflicts || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = "commit"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        await commitStaged(exec, root, on, message);
        if (key() === context) { this.message = ""; this.input.set_value(""); this.note = "Committed."; this.noteError = false; }
      } catch (e) { if (key() === context) { this.note = `Could not commit: ${e.message ?? e}`; this.noteError = true; } }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  chooseRemote(remote, cx) {
    if (this.busy || this.loading || this.context !== key()) return;
    this.selectedRemote = remote; this.remoteOpen = false; this.pushState = null; this.note = null;
    this.refresh(cx); cx.notify();
  }

  push(cx) {
    if (!this.root || !this.pushState?.canPush || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, expected = this.pushState;
    this.busy = "push"; this.note = null; this.remoteOpen = false;
    cx.spawn(async cx => {
      try {
        const result = await pushBranch(exec, root, on, expected);
        if (key() === context) { this.note = result.message; this.noteError = false; }
      } catch (error) {
        if (key() === context) { this.note = `Could not push: ${error.message ?? error}`; this.noteError = true; }
      } finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const ready = Boolean(this.root && !this.busy && !this.loading && this.context === key());
    const enabled = Boolean(ready && this.message.trim() && this.summary.staged && !this.summary.conflicts);
    const canStage = Boolean(ready && this.summary.unstaged && !this.summary.conflicts);
    const pushState = this.pushState, canPush = Boolean(ready && pushState?.canPush);
    const remoteChoices = pushState?.remotes ?? [];
    const canChooseRemote = remoteChoices.length > 1 || (remoteChoices.length > 0 && !remoteChoices.includes(pushState?.remote));
    const destination = pushState?.remote && pushState?.target ? `${pushState.remote}/${pushState.target}` : null;
    const branchLabel = pushState?.branch ?? (this.root ? pushState ? "Detached HEAD" : "Checking branch…" : "No project");
    const pushHint = pushState?.canPush && destination ? `Push committed changes to ${destination}. Uncommitted edits stay here.` : pushState?.reason || "Checking push destination…";
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/project-changes/changes.svg").size(15).flex_none().text_color(t.muted))
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(this.summary.total)))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(`Staged ${this.summary.staged} · Unstaged ${this.summary.unstaged}`))
        .child(h_flex().id("stage-all").h(30).px(8).gap(5).flex_none().items_center().rounded(7)
          .bg(canStage ? t.solid : t.raised).text_color(canStage ? t.solid_foreground : t.dim).text_size(12)
          .tooltip("Stage all changes for the next commit")
          .when(canStage, el => el.cursor_pointer().hover(s => s.opacity(0.88)))
          .on_click((_e, cx) => this.stage(cx))
          .child(svg(this.busy === "stage" ? "mods/workspace-chrome/spinner.svg" : "mods/project-changes/stage-all.svg").size(14).flex_none().when(this.busy === "stage", el => el.spin(900)))
          .child(this.busy === "stage" ? "Staging…" : "Stage All")))
      .when(this.summary.conflicts > 0, el => el.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(`Resolve ${this.summary.conflicts} ${this.summary.conflicts === 1 ? "conflict" : "conflicts"} first.`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().id(`file-status-${f.path}`).w(14).flex_none().text_size(11).tooltip(f.status === "A" ? "Added" : f.status === "D" ? "Deleted" : f.status === "U" ? "Conflict" : "Modified").text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.staged, el => el.child(h_flex().id(`staging-status-${f.path}`).flex_none().tooltip(f.unstaged ? "Partially staged" : "Staged").child(svg(`mods/project-changes/${f.unstaged ? "partial" : "staged"}.svg`).size(12).text_color(t.ansi2))))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          .child(h_flex().id(`stage-file-${f.path}`).h(22).px(6).gap(3).flex_none().items_center().rounded(5)
            .bg(t.raised).text_size(11).text_color(ready && !f.conflict ? t.foreground : t.dim)
            .tooltip(f.conflict ? "Resolve conflicts in this file first" : f.staged ? "Unstage this file. Keep your edits." : "Stage this file")
            .when(ready && !f.conflict, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.changeStage(f, cx); })
            .child(svg(this.busyFile === f.path ? "mods/workspace-chrome/spinner.svg" : `mods/project-changes/${f.conflict ? "conflict" : f.staged ? "unstage" : "stage"}.svg`).size(12).flex_none().when(this.busyFile === f.path, el => el.spin(900)))
            .child(this.busyFile === f.path ? "…" : f.conflict ? "Conflict" : f.staged ? "Unstage" : "Stage"));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No changes" : "No project open")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(this.noteError ? t.ansi1 : t.ansi2).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("commit").h(32).px(10).gap(5).flex_none().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
          .tooltip("Commit staged changes · Enter")
          .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
          .child(svg(this.busy === "commit" ? "mods/workspace-chrome/spinner.svg" : "mods/project-changes/commit.svg").size(14).flex_none().when(this.busy === "commit", el => el.spin(900)))
          .child(this.busy === "commit" ? "Committing…" : "Commit")))
      .child(v_flex().flex_none().px(10).pb(10).gap(7)
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(svg("mods/project-changes/branch.svg").size(13).flex_none())
          .child(div().flex_1().min_w(0).truncate().tooltip(destination ? `${branchLabel} → ${destination}` : branchLabel).child(branchLabel))
          .when(pushState?.ahead !== null && pushState?.ahead !== undefined, el => el.child(div().flex_none()
            .tooltip("Commits ahead / behind the locally cached remote branch")
            .child(`↑${pushState.ahead} ↓${pushState.behind ?? 0}`))))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().id("push-remote").flex_1().min_w(0).h(28).px(6).gap(4).items_center().rounded(5).text_size(11).text_color(t.muted)
            .tooltip(destination ? `Push destination: ${destination}${pushState?.publish ? " · sets upstream" : ""}` : pushHint)
            .when(ready && canChooseRemote, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
            .on_click((_e, cx) => { if (ready && canChooseRemote) { this.remoteOpen = !this.remoteOpen; cx.notify(); } })
            .child(div().flex_1().min_w(0).truncate().child(destination ?? (!pushState && this.root ? "Checking…" : remoteChoices.length ? "Choose remote" : "No remote")))
            .when(canChooseRemote, el => el.child(svg("mods/project-changes/chevron-down.svg").size(12).flex_none())))
          .child(h_flex().id("push").h(30).px(10).gap(5).flex_none().items_center().rounded(7)
            .bg(canPush ? t.solid : t.raised).text_color(canPush ? t.solid_foreground : t.dim).text_size(12).tooltip(pushHint)
            .when(canPush, el => el.cursor_pointer().hover(s => s.opacity(0.88)))
            .on_click((_e, cx) => this.push(cx))
            .child(svg(this.busy === "push" ? "mods/workspace-chrome/spinner.svg" : "mods/project-changes/push.svg").size(14).flex_none().when(this.busy === "push", el => el.spin(900)))
            .child(this.busy === "push" ? "Pushing…" : "Push")))
        .when(this.remoteOpen && canChooseRemote, el => el.child(v_flex().gap(2).p(4).rounded(6).bg(t.raised)
          .children(remoteChoices.map(remote => div().id(`push-remote-${remote}`).px(8).py(5).rounded(4).text_size(11)
            .text_color(remote === pushState.remote ? t.foreground : t.muted).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.chooseRemote(remote, cx)).child(remote)))))
        .when(Boolean(this.root && pushState?.reason), el => el.child(div().text_size(10.5).text_color(t.dim).child(pushState.reason))));
  }
}
