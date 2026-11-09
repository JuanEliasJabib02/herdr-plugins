// The Projects header's filter popup (workspace-sleep D8), Orca's
// SidebarFilter.tsx: "Hide sleeping", off by default, and, while it's on,
// "Except default branch", indented, on by default, each with a switch
// (tree-model.js filterMenuItems). A click on a row, or Enter or Space on the
// highlighted one, flips its switch, and the popup stays open, as Orca's
// does: the second row shows as soon as the first turns on. ↑/↓ move, Esc
// closes. Both live in projects.ui.v1 (store.js toggleSleeping,
// toggleExceptMain), which every tree copy draws; projects.toggle-sleeping
// flips the first from a key.
//   props: { view: "filter-menu" }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD, icon } from "./config.js";
import * as store from "./store.js";
import { filterMenuItems } from "./tree-model.js";

// A row's height, as in group-menu.js.
const ROW = 31;

// The only place that opens the popup, at the pointer (the header's filter
// button). A popup is as tall as its items; height is only the most: both
// rows.
export function openFilterMenu() {
  return openOverlay({ mod: MOD, kind: "popup", width: 240, height: 2 * ROW + 10, props: { view: "filter-menu" } });
}

// What each row's switch flips.
const RUNS = {
  "hide-sleeping": () => store.toggleSleeping(),
  "except-main": () => store.toggleExceptMain(),
};

// A switch drawn by hand (gpui-base's Switch has no styling), as
// agent-sleep's popup draws it: a pill with its knob on the right when on.
function toggle(t, on) {
  return h_flex().flex_none().w(28).h(16).p(2).rounded(8)
    .bg(on ? t.accent : t.input)
    .when(on, (el) => el.justify_end())
    .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.background));
}

export default class FilterMenu {
  init(_p, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  // Flips the row's setting; the store's write draws every copy again.
  choose(item) {
    if (item) RUNS[item.id]();
  }

  render() {
    const t = theme();
    const list = filterMenuItems(store.ui());
    // The second row goes when Hide sleeping turns off.
    this.at = Math.min(this.at, list.length - 1);
    return v_flex()
      .id("filter-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const n = list.length;
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else if (e.key === "enter" || e.key === "space") this.choose(list[this.at]);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .children(list.map((it, i) => h_flex()
        .id(`filter-menu-${it.id}`)
        .h(ROW)
        .flex_none()
        // Orca indents the exemption under the filter it belongs to.
        .pl(it.indented ? 28 : 8)
        .pr(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(it.indented ? t.muted : t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.at = i;
          this.choose(it);
          cx.notify();
        })
        .child(svg(icon(it.icon)).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .child(toggle(t, it.on))));
  }
}
