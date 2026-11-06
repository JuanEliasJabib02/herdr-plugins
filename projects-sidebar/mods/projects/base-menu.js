// A project's Default branch… popup (D37, S33), opened from its right-click
// menu: the branch its new workspaces start from. First "origin's default
// (<ref>)", which clears the saved base; then the saved base, pinned when the
// listed branches lack it; then the 30 most recent origin/… branches
// (new-workspace-model.js baseMenuRows). The saved one is checked. A search
// box on top (S41) filters every origin branch, not only the 30, as you type;
// "No branch matches" when none does. It draws like group-menu.js but loads
// in init, in a spawned task, like the New workspace dialog's loadBases: "…"
// until git answers, then "Not a git repository" or "No remote branches"
// when that is so. At most LIST_ROWS rows show, then it scrolls; the
// highlighted row is kept in view, on open (the saved one), after typing (the
// first) and after every ↑/↓. Picking saves (lib.js setProjectBase) and
// closes. The keyboard stays on the box: ↑/↓ move, Enter picks, Esc closes
// (Herdr's picker mod does the same).
//   props: { view: "base-menu", project: <path> }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { findProject, setProjectBase } from "./lib.js";
import { registry, saveRegistry } from "./store.js";
import * as G from "./git.js";
import { baseMenuRows } from "./new-workspace-model.js";
import { LIST_ROWS } from "./new-workspace.js";

// A row's height, as in group-menu.js.
const ROW = 31;

// The search box's row: its height and the gap under it.
const SEARCH = 32 + 6;

// The list's id: the virtual list and the Scrollbar beside it pair by it.
const LIST = "base-menu-list";

// A row's key in the list, what on_item_click reports: its base, and for
// origin's default (base null) a name no git ref can have.
const keyOf = (row) => row.base ?? ":default";

// The only place that opens the menu, at the pointer. A popup is as tall as
// its items; height is only the most: the title, the search box and
// LIST_ROWS rows.
export function openBaseMenu(path) {
  return openOverlay({ mod: MOD, kind: "popup", width: 260, height: LIST_ROWS * ROW + 50 + SEARCH, props: { view: "base-menu", project: path } });
}

export default class BaseMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.state = "loading"; // "loading" | "ready" | "not-git"
    this.origin = null; // origin's default (defaultBaseOf)
    this.branches = []; // every origin/… branch, newest first (remoteBasesOf)
    this.query = ""; // the search box's text
    this.at = 0;
    // Scrolls the list from code, so the highlighted row stays in view.
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search branches" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      if (this.rows().length) this.scroll.scroll_to_item(0);
      cx.notify();
    });
    this.input.on("submit", () => this.choose(this.rows()[this.at]));
    this.input.focus();
    // A popup may take the keyboard a moment after it opens (mods/picker).
    cx.timer.after(600, () => this.input.focus());
    const path = this.project;
    if (!path) return;
    cx.spawn(async (cx) => {
      let origin = null;
      let branches = [];
      try {
        [origin, branches] = await Promise.all([G.defaultBase(path), G.remoteBases(path)]);
      } catch {}
      this.origin = origin;
      this.branches = branches ?? [];
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
    return baseMenuRows(this.origin, this.branches, found.project.base ?? null, this.query);
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
    const ready = Boolean(found) && this.state === "ready";
    return v_flex()
      .id("base-menu")
      // The box has the keyboard; its keys reach here (Enter is its submit).
      .on_key_down((e, cx) => {
        const n = rows.length;
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (e.key === "down" && n) this.move((this.at + 1) % n);
        else if (e.key === "up" && n) this.move((this.at + n - 1) % n);
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
      .when(Boolean(found), (el) => el.child(h_flex().h(32).mb(6).flex_none().px(8).gap(7).items_center().rounded(7)
        .border_1().border_color(t.input).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))))
      .when(Boolean(found) && this.state === "loading", (el) => el.child(line("…")))
      .when(Boolean(found) && this.state === "not-git", (el) => el.child(line("Not a git repository")))
      .when(ready && this.branches.length === 0, (el) => el.child(line("No remote branches")))
      .when(ready && this.branches.length > 0 && rows.length === 0, (el) => el.child(line("No branch matches")))
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
