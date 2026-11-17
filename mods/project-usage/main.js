import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, layout, theme } from "herdr";

const PROVIDERS = [
  { id: "codex", name: "Codex", mark: "C" },
  { id: "antigravity", name: "Antigravity", mark: "A" },
  { id: "claude", name: "Claude", mark: "C" },
];
const REFRESH_MS = 5 * 60 * 1000;
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
function visible() {
  const root = layout();
  const panel = find(root, "panel");
  return Boolean(panel && !panel.hidden && find(root, "panel-body")?.active === "usage");
}
function age(timestamp) {
  if (!timestamp) return "No data yet";
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 60));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  if (minutes < 1440) return `Updated ${Math.floor(minutes / 60)}h ago`;
  return `Updated ${Math.floor(minutes / 1440)}d ago`;
}
function resetLabel(timestamp) {
  if (!timestamp) return "Reset time unavailable";
  const minutes = Math.ceil((timestamp - Date.now() / 1000) / 60);
  if (minutes <= 0) return "Reset pending · refresh to check";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Resets in ${hours}h ${minutes % 60}m` : `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
const percent = value => `${Number(value.toFixed(1))}%`;

export default class Usage extends View {
  init(_props, cx) {
    this.providers = Object.fromEntries(PROVIDERS.map(p => [p.id, { busy: false, checked: 0, result: null }]));
    if (checking()) return;
    this.tick(cx);
    cx.timer.every(1000, cx => this.tick(cx));
  }

  tick(cx) {
    if (!visible()) return;
    const now = Date.now();
    for (const provider of PROVIDERS) {
      const state = this.providers[provider.id];
      if (!state.suspended && now - state.checked >= REFRESH_MS) this.refresh(provider.id, cx);
    }
    const minute = Math.floor(now / 60000);
    if (minute !== this.minute) { this.minute = minute; cx.notify(); }
  }

  refresh(id, cx, install = false) {
    const state = this.providers[id];
    if (state.busy) return;
    state.busy = true; state.checked = Date.now();
    cx.notify();
    cx.spawn(async cx => {
      try {
        const folder = `${appHome()}/mods/project-usage`;
        const args = install ? [`${folder}/claude_usage.py`, "--install"] : [`${folder}/collect.py`, "--provider", id];
        const response = await exec("python3", args, { timeout: 35000 });
        if (response.code !== 0) throw new Error("collector failed");
        const result = JSON.parse(response.stdout);
        if (result.provider !== id || !Array.isArray(result.windows) || !["ok", "unavailable", "error", "setup"].includes(result.status)) throw new Error("invalid response");
        state.result = result;
        // A CLI that interprets /usage as a prompt must never be polled again.
        state.suspended = id === "antigravity" && result.status === "setup";
      } catch {
        state.result = { provider: id, status: "error", windows: [], updated_at: null, message: "Cannot check usage. Make sure Python 3 and the agent CLI are available." };
      } finally {
        state.busy = false;
        cx.notify();
      }
    });
  }

  windowRow(id, window, index, stale, t) {
    const used = window.used_percent;
    if (!Number.isFinite(used) || used < 0 || used > 100) return div();
    const expired = Boolean(window.reset_at && window.reset_at <= Date.now() / 1000);
    const color = stale || expired ? t.dim : used >= 90 ? t.ansi1 : used >= 75 ? t.ansi3 : t.accent;
    return v_flex().id(`${id}-window-${index}`).gap(5).min_w(0)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().tooltip(window.label).text_color(t.foreground).child(window.label))
        .child(div().flex_none().text_color(color).child(`${percent(used)} used`)))
      .child(div().h(5).w_full().rounded(3).bg(t.hover).overflow_hidden()
        .child(div().h_full().w(`${used}%`).rounded(3).bg(color)))
      .child(h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate()
          .tooltip(window.reset_at ? new Date(window.reset_at * 1000).toLocaleString() : "The service did not provide a reset time")
          .child(resetLabel(window.reset_at)))
        .when(!expired, el => el.child(div().flex_none().child(`${percent(100 - used)} left`))));
  }

  card(provider, cx, t) {
    const state = this.providers[provider.id], data = state.result;
    const stale = Boolean(data?.stale || (data?.updated_at && Date.now() / 1000 - data.updated_at > 900));
    const status = state.busy ? "Checking…" : stale ? "Stale" : data?.status === "ok" ? "" : data?.status === "setup" ? "Set up" : data?.status === "error" ? "Try again" : data ? "Unavailable" : "";
    const credits = data?.credits;
    const creditText = credits?.unlimited ? "Unlimited" : credits?.has_credits && credits.balance !== null && credits.balance !== undefined ? String(credits.balance) : null;
    return v_flex().id(`usage-${provider.id}`).flex_none().min_w(0).p(12).gap(12).rounded(9).border(1).border_color(t.border).bg(t.surface)
      .child(h_flex().items_center().gap(8)
        .child(div().size(23).flex_none().flex().items_center().justify_center().rounded(6).bg(t.raised).text_color(t.muted).text_size(11).child(provider.mark))
        .child(div().flex_1().text_color(t.foreground).child(provider.name))
        .when(state.busy, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900)))
        .child(div().text_size(10.5).text_color(stale ? t.ansi3 : t.dim).child(status)))
      .children((data?.windows ?? []).map((window, i) => this.windowRow(provider.id, window, i, stale, t)))
      .when(creditText !== null, el => el.child(h_flex().gap(8).text_size(11).text_color(t.muted)
        .tooltip("Credits reported by Codex. This is not a token balance or currency amount.")
        .child(div().flex_1().child("Credits")).child(div().text_color(t.foreground).child(creditText))))
      .when(Boolean(data?.message), el => el.child(div().text_size(11).text_color(t.muted).child(data.message)))
      .when(!data, el => el.child(div().text_size(11).text_color(t.dim).child(state.busy ? "Reading account limits…" : "Ready to check")))
      .when(provider.id === "claude" && data?.status === "setup" && !data?.installed, el => el.child(h_flex().id("usage-claude-setup").h(28).px(9).gap(5).rounded(6).bg(t.raised).text_color(t.foreground).text_size(11)
        .tooltip("Connect Claude's status line. Keep the existing command and settings.")
        .when(!state.busy, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => this.refresh("claude", cx, true)).child("Set Up Claude")))
      .when(Boolean(data?.updated_at), el => el.child(div().text_size(10.5).text_color(t.dim)
        .tooltip(new Date(data.updated_at * 1000).toLocaleString()).child(age(data.updated_at))));
  }

  render(cx) {
    const t = theme(), busy = Object.values(this.providers).some(p => p.busy);
    return v_flex().size_full().min_w(0).text_size(12).bg(t.chrome)
      .child(h_flex().flex_none().h(38).px(12).gap(7).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/project-usage/gauge.svg").size(15).text_color(t.muted))
        .child(div().flex_1().text_color(t.foreground).child("Usage"))
        .child(h_flex().id("usage-refresh").h(25).px(7).gap(4).rounded(5).text_size(11).text_color(busy ? t.dim : t.muted)
          .tooltip("Check account limits on this computer")
          .when(!busy, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .on_click((_e, cx) => { if (!busy) for (const p of PROVIDERS) this.refresh(p.id, cx); })
          .child(svg("mods/project-usage/refresh.svg").size(12)).child("Refresh")))
      .child(div().flex_none().px(12).py(10).text_size(11).text_color(t.dim).child("Account limits · This computer"))
      .child(v_flex().id("usage-scroll").flex_1().min_h(0).min_w(0).px(8).pb(10).gap(8).overflow_y_scrollbar()
        .children(PROVIDERS.map(provider => this.card(provider, cx, t)))
        .child(div().flex_none().px(4).py(6).text_size(10.5).text_color(t.dim)
          .child("Shared across projects and agents. Limits are not remaining tokens. Refreshes every 5 minutes while open.")));
  }
}
