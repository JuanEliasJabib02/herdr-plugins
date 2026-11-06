// A project's Default branch… popup (D37, S33), opened from its right-click
// menu: the branch its new workspaces start from. First "origin's default
// (<ref>)", which clears the saved base; then the saved base, pinned when the
// recent branches lack it; then the 30 most recent origin/… branches
// (new-workspace-model.js baseMenuRows). The saved one is checked. It draws
// like group-menu.js but loads in init, in a spawned task, like the New
// workspace dialog's loadBases: "…" until git answers, then "Not a git
// repository" or "No remote branches" when that is so. At most LIST_ROWS
// rows show, then it scrolls; the highlighted row is kept in view, on open
// (the saved one) and after every ↑/↓. Picking saves (lib.js setProjectBase)
// and closes. ↑/↓ move, Enter picks, Esc closes.
//   props: { view: "base-menu", project: <path> }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { findProject, setProjectBase } from "./lib.js";
import { registry, saveRegistry } from "./store.js";
import * as G from "./git.js";
import { baseMenuRows } from "./new-workspace-model.js";
import { LIST_ROWS } from "./new-workspace.js";

// A row's height, as in group-menu.js.
const ROW = 31;

// The list's id: the virtual list and the Scrollbar beside it pair by it.
const LIST = "base-menu-list";

// A row's key in the list, what on_item_click reports: its base, and for
// origin's default (base null) a name no git ref can have.
const keyOf = (row) => row.base ?? ":default";

// The only place that opens the menu, at the pointer. A popup is as tall as
// its items; height is only the most: the title and LIST_ROWS rows.
export function openBaseMenu(path) {
  return openOverlay({ mod: MOD, kind: "popup", width: 260, height: LIST_ROWS * ROW + 50, props: { view: "base-menu", project: path } });
}

export default class BaseMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.state = "loading"; // "loading" | "ready" | "not-git"
    this.origin = null; // origin's default (defaultBaseOf)
    this.recent = []; // the recent origin/… branches
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Scrolls the list from code, so the highlighted row stays in view.
    this.scroll = VirtualListScrollHandle.new();
    const path = this.project;
    if (!path) return;
    cx.spawn(async (cx) => {
      let origin = null;
      let recent = [];
      try {
        [origin, recent] = await Promise.all([G.defaultBase(path), G.recentBases(path)]);
      } catch {}
      this.origin = origin;
      this.recent = recent ?? [];
      this.state = origin === null ? "not-git" : "ready";
      const rows = this.rows();
      this.at = Math.max(0, rows.findIndex((r) => r.checked));
      // The saved one may sit below the first LIST_ROWS: bring it into view.
      if (rows.length) this.scroll.scroll_to_item(this.at);
      cx.notify();
    });
  }

  found() {
    return this.project ? findProject(registry(), this.project) : null;
  }

  rows() {
    const found = this.found();
    if (this.state !== "ready" || !found) return [];
    return baseMenuRows(this.origin, this.recent, found.project.base ?? null);
  }

  // Saves the row's base (null: origin's default) and closes. Nothing is
  // written when it is already the saved one.
  choose(row) {
    if (!row) return;
    closeOverlay(props()?.overlay);
    const now = registry();
    const next = setProjectBase(now, this.project, row.base);
    if (next !== now) saveRegistry(next);
  }

  // Highlights row `at` (↑/↓, wrapping round) and scrolls it into view.
  move(at) {
    this.at = at;
    this.scroll.scroll_to_item(at);
  }

  render() {
    const t = theme();
    const found = this.found();
    const rows = this.rows();
    const line = (text) => div().px(8).pb(6).text_color(t.dim).child(text);
    return v_flex()
      .id("base-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const n = rows.length;
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (e.key === "down" && n) this.move((this.at + 1) % n);
        else if (e.key === "up" && n) this.move((this.at + n - 1) % n);
        else if (e.key === "enter") this.choose(rows[this.at]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate()
        .child(found ? `Default branch · ${found.project.name}` : "Not in the list any more."))
      .when(Boolean(found) && this.state === "loading", (el) => el.child(line("…")))
      .when(Boolean(found) && this.state === "not-git", (el) => el.child(line("Not a git repository")))
      .when(Boolean(found) && this.state === "ready" && this.recent.length === 0, (el) => el.child(line("No remote branches")))
      // Whole rows only, LIST_ROWS of them; with more, the scrollbar always
      // shows that the list goes on (new-workspace.js's select). A virtual
      // list, because only one can be scrolled from code (this.scroll): a
      // click is the list's on_item_click, since a row can't hold a handler,
      // and a row's identity is its key (keyOf).
      .when(rows.length > 0, (el) => el.child(div().relative().h(Math.min(rows.length, LIST_ROWS) * ROW)
        .child(v_virtual_list(LIST, rows.length, ROW, (i) => keyOf(rows[i]), (range) => rows.slice(range.start, range.end).map((row, k) => h_flex()
          .w_full()
          .h(ROW)
          .flex_none()
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .when(range.start + k === this.at, (r) => r.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .child(div().flex_1().min_w(0).truncate().child(row.label))
          .when(row.checked, (r) => r.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))))
          .track_scroll(this.scroll)
          .on_item_click((key) => this.choose(rows.find((row) => keyOf(row) === key)))
          .size_full())
        .child(Scrollbar.vertical(LIST).absolute().inset_0()
          .when(rows.length > LIST_ROWS, (l) => l.mode("always")))));
  }
}
