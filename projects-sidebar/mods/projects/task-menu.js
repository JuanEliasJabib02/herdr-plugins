// A task lane's right-click menu (D35, S30), a popup with props { lane,
// label }: Add note… or Edit note… (the note dialog, D34), then, after a
// separator, Delete task… in the blocked color. The items come from
// task-model.js taskMenuItems. An item with a `why` is drawn dimmed with it
// and can't run: a click does nothing, ↑/↓ skip it, so Enter never reaches
// it. Esc closes. Only ticket and name lanes open it (tree.js); No task and
// Servers have no menu.
//   props: { view: "task-menu", lane: "task:AX-3695", label: "AX-3695" }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { noteKeyOf, noteOf } from "./lib.js";
import * as store from "./store.js";
import { taskMenuItems } from "./task-model.js";
import { openTaskNote } from "./task-note.js";

// The only place that opens the menu, at the pointer. A popup is as tall as
// its items; height is only the most.
export function openTaskMenu(lane, label) {
  return openOverlay({ mod: MOD, kind: "popup", width: 210, height: 140, props: { view: "task-menu", lane, label } });
}

// Delete task… isn't wired yet: T14b gives it the lane's workspaces
// (laneTargets) and its dialog. Until then it says so and can't run.
const NOT_YET = "Coming next";

export default class TaskMenu {
  init(p, cx) {
    this.lane = p?.lane ?? null;
    this.label = p?.label ?? "";
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  // taskMenuItems for this lane, with what each one does: [{ ..., run }].
  items() {
    const note = noteOf(store.notes(), noteKeyOf(this.lane));
    const runs = {
      note: () => openTaskNote(this.lane, this.label),
      delete: () => {},
    };
    return taskMenuItems(this.lane, { note, targets: [] })
      .map((it) => (it.id === "delete" ? { ...it, why: NOT_YET } : it))
      .map((it) => ({ ...it, run: runs[it.id] }));
  }

  choose(item) {
    if (!item || item.why) return;
    closeOverlay(props()?.overlay);
    item.run();
  }

  // The next item that can run, from `from` going `step` (±1); `from` when none.
  move(list, from, step) {
    for (let i = 1; i <= list.length; i++) {
      const at = (from + step * i + list.length * i) % list.length;
      if (!list[at].why) return at;
    }
    return from;
  }

  render() {
    const t = theme();
    const list = this.items();
    return v_flex()
      .id("task-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = this.move(list, this.at, 1);
        else if (e.key === "up") this.at = this.move(list, this.at, -1);
        else if (e.key === "enter") this.choose(list[this.at]);
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
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(this.label))
      .when(list.length === 0, (el) => el.child(div().px(8).pb(6).text_color(t.dim).child("No menu for this lane.")))
      .children(list.map((it, i) => v_flex()
        .when(Boolean(it.separator), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex()
          .id(`task-menu-${it.id}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .text_color(it.why ? t.dim : it.danger ? t.blocked : t.foreground)
          .when(!it.why && i === this.at, (el) => el.bg(t.selected))
          .when(!it.why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.choose(it)))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .when(Boolean(it.why), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.why))))));
  }
}
