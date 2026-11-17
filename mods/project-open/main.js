import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, pickFolder, spaces, panes, run, closeOverlay, props, theme, notify } from "herdr";

const pathKey = path => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "") || "/";

export default class ProjectOpen extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (checking()) return;
    cx.spawn(async cx => {
      let folder = null;
      try {
        folder = await pickFolder({ prompt: "Open Project" });
      } catch (error) {
        notify({ title: "Could not open folder picker", body: String(error?.message ?? error), level: "error" });
      }
      // Close the launcher before changing focus to the chosen project.
      closeOverlay(props().overlay);
      if (!folder) return;
      const key = pathKey(folder), ps = panes();
      const existing = spaces().find(space => {
        if (space.machine) return false;
        if (pathKey(space.folder) === key) return true;
        const tabs = new Set((space.tabs ?? []).map(tab => tab.id));
        return ps.some(pane => tabs.has(pane.tab) && pane.cwd && pathKey(pane.cwd) === key);
      });
      if (existing) run("space.select", { id: existing.id });
      else run("space.new", { name: key.split("/").pop() || folder, folder, tab: "Terminal", machine: "" });
    });
  }

  render() {
    const t = theme();
    return v_flex().id("project-open-dialog").track_focus(this.handle).w_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
      })
      .child(h_flex().gap(9).items_center().text_size(15).font_semibold()
        .child(svg("mods/workspace-chrome/folder-plus.svg").size(18)).child("Open Project"))
      .child(div().text_size(13).text_color(t.muted).child("Choose a folder to start working."))
      .child(div().text_size(12).text_color(t.dim).child("Already open? Return to your existing project."));
  }
}
