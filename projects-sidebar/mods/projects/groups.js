// The groups bar, above the sidebar footer, drawn like Orca's: one icon chip
// per group in creation order (the code icon, so a long name never takes the
// bar), the active group highlighted, a dot on a group that isn't shown and
// holds a workspace whose agent is blocked or done, and "+" for a new group.
// The name, what needs a look and the key (F1–F3 on the first three:
// keys.json, section layout:projects) are in the chip's tooltip. Click a chip
// to show its projects; right-click it for Rename and Delete. Below 160 px the
// sidebar is a rail: the chips are smaller and centered, without "+".

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, spaces, panes, home } from "herdr";
import { icon } from "./config.js";
import { activeGroup, selectGroup, matchSpaces, attentionByGroup } from "./lib.js";
import { registry, updateRegistry, cache } from "./store.js";
import { openGroupForm } from "./group-form.js";
import { openGroupMenu } from "./group-menu.js";

// The keys keys.json binds, by position: F1 selects the first group.
const KEYS = ["F1", "F2", "F3"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's width; below 160 px it is a rail (mods/spaces/main.js).
const sidebarPx = () => find(layout(), "sidebar")?.size?.px ?? Infinity;

// Shows the n-th group (from 1), as F1–F3 do; nothing when there is none.
function selectNth(n) {
  updateRegistry((r) => (r.groups[n - 1] ? selectGroup(r, r.groups[n - 1].id) : r));
}

// The dot of each group, or null: { color, label }, the blocked color while
// one of its agents waits on the person ("Needs attention"), else the done
// color ("Agent done"). lib.js attentionByGroup, over the same matches the
// tree uses.
function dots(reg, t) {
  const sp = spaces();
  const matches = matchSpaces(cache(), sp, panes(), home());
  const any = attentionByGroup(reg, matches, sp);
  const blocked = attentionByGroup(reg, matches, sp.filter((s) => s.status === "blocked"));
  return (id) => (blocked[id] ? { color: t.blocked, label: "Needs attention" }
    : any[id] ? { color: t.done, label: "Agent done" } : null);
}

export default class Groups {
  init(_props, _cx) {}

  chip(g, i, { on, dot, rail }, t) {
    const key = KEYS[i] ?? null;
    const box = rail ? 26 : 28;
    return div()
      .id(`group-${g.id}`)
      .relative()
      .flex_none()
      .size(box)
      .flex()
      .items_center()
      .justify_center()
      .rounded(7)
      .cursor_pointer()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip([g.name, dot?.label, key].filter(Boolean).join(" · "))
      .on_click(() => updateRegistry((r) => selectGroup(r, g.id)))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openGroupMenu(g.id);
      })
      .child(svg(icon("code")).size(16))
      .when(Boolean(dot), (el) => el.child(div().absolute().top(3).right(3).size(7).rounded_full()
        .border(1).border_color(t.chrome).bg(dot.color)));
  }

  render() {
    const t = theme();
    const reg = registry();
    const px = sidebarPx();
    const rail = px < 160;
    const active = activeGroup(reg).id;
    const dotOf = dots(reg, t);
    const chips = reg.groups.map((g, i) => this.chip(g, i, { on: g.id === active, dot: dotOf(g.id), rail }, t));
    // In the rail the chips are centered while they fit; past that they
    // scroll from the first one.
    const fits = reg.groups.length * 28 <= px - 8;
    return h_flex()
      .size_full()
      .min_w(0)
      .px(rail ? 4 : 8)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .child(h_flex().id("group-chips").flex_1().min_w(0).gap(rail ? 2 : 4).items_center().overflow_x_scroll()
        .when(rail && fits, (el) => el.justify_center())
        .children(chips))
      .when(!rail, (el) => el.child(div().id("group-new").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("New group")
        .on_click(() => openGroupForm(null))
        .child(svg(icon("plus")).size(14))));
  }
}

// Key commands (projects.group1..3): F1–F3 in the projects layout.
export const commands = {
  group1: () => selectNth(1),
  group2: () => selectNth(2),
  group3: () => selectNth(3),
};
