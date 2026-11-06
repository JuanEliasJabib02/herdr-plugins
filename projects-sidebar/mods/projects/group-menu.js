// A group's right-click menu (task-model.js groupMenuItems): Organize by
// Project | Task, the group's mode checked (D29, D32); then Rename… (the
// group form) and Delete group, which only an empty group that isn't the
// last one allows (its projects are never touched: move or remove them
// first). ↑/↓ move, Enter runs, Esc closes.
//   props: { view: "group-menu", group: <id> }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { deleteGroup, setOrganize } from "./lib.js";
import { registry, updateRegistry } from "./store.js";
import { openGroupForm } from "./group-form.js";
import { groupMenuItems } from "./task-model.js";

// The only place that opens the menu, at the pointer. A popup is as tall as
// its items; height is only the most.
export function openGroupMenu(groupId) {
  return openOverlay({ mod: MOD, kind: "popup", width: 210, height: 200, props: { view: "group-menu", group: groupId } });
}

// groupMenuItems with what each one does: [{ ..., run }].
function items(group, reg) {
  const runs = {
    "organize-project": () => updateRegistry((r) => setOrganize(r, group.id, "project")),
    "organize-task": () => updateRegistry((r) => setOrganize(r, group.id, "task")),
    rename: () => openGroupForm(group.id),
    delete: () => updateRegistry((r) => deleteGroup(r, group.id)),
  };
  return groupMenuItems(group, reg).map((it) => ({ ...it, run: runs[it.id] }));
}

export default class GroupMenu {
  init(p, cx) {
    this.groupId = p?.group ?? null;
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  group(reg) {
    return reg.groups.find((g) => g.id === this.groupId) ?? null;
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
    const reg = registry();
    const g = this.group(reg);
    const list = g ? items(g, reg) : [];
    return v_flex()
      .id("group-menu")
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
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(g ? g.name : "This group is gone"))
      .children(list.map((it, i) => v_flex()
        .when(Boolean(it.separator), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex()
          .id(`group-menu-${it.id}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .text_color(it.why ? t.dim : t.foreground)
          .when(!it.why && i === this.at, (el) => el.bg(t.selected))
          .when(!it.why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.choose(it)))
          .child(div().flex_1().child(it.label))
          .when(Boolean(it.checked), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))
          .when(Boolean(it.why), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.why))))));
  }
}
