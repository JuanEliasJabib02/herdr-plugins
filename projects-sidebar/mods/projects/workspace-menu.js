// A workspace's right-click menu, a popup with props { project, path }
// (D20): Copy Path and Copy Worktree Name. ↑/↓ move, Enter runs, Esc closes.
// Copying uses gpui's clipboard (D21), then a toast says what was copied.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, notify } from "herdr";
import { MOD, icon } from "./config.js";
import { normPath } from "./lib.js";
import * as store from "./store.js";
import { workspaceMenuItems, workspaceLabel } from "./tree-model.js";

// The only place that opens the menu. A popup is as tall as its items;
// height is only the most.
export function openWorkspaceMenu(project, path) {
  return openOverlay({ mod: MOD, kind: "popup", width: 220, height: 200, props: { view: "workspace-menu", project, path } });
}

const ICONS = {
  "copy-path": icon("copy"),
  "copy-name": icon("copy"),
};

export default class WorkspaceMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.path = p?.path ?? null;
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  // The checkout as the tree lists it (main, branch), from the cache; a path
  // the cache doesn't hold yet still gets its copies.
  row() {
    if (!this.path) return null;
    const list = store.cache()[normPath(this.project ?? "")] ?? [];
    return list.find((c) => normPath(c.path) === normPath(this.path)) ?? { path: this.path, branch: null, main: false };
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  choose(item, cx) {
    if (!item) return;
    if (item.text !== undefined) {
      cx.write_to_clipboard(item.text);
      notify({ title: "Copied", body: item.text, level: "success", timeout: 2500 });
    }
    this.close();
  }

  key(e, list, cx) {
    const n = list.length;
    if (e.key === "escape") return this.close();
    if (!n) return;
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter") return this.choose(list[this.at], cx);
    else return;
    cx.notify();
  }

  render() {
    const t = theme();
    const row = this.row();
    const list = workspaceMenuItems(row);
    return v_flex()
      .id("workspace-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, list, cx))
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(row ? workspaceLabel(row) : ""))
      .when(list.length === 0, (el) => el.child(div().px(8).pb(6).text_color(t.dim).child("No workspace.")))
      .children(list.map((it, i) =>
        h_flex()
          .id(`wm-${i}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(it, cx))
          .child(svg(ICONS[it.id]).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it.label))));
  }
}
