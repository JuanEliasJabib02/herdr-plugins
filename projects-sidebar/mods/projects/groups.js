// The groups bar, above the sidebar footer: one chip per group in creation
// order, F1–F3 on the first three (keys.json, section layout:projects), the
// active group highlighted, a dot on a group that isn't shown and holds a
// workspace whose agent is blocked or done, and "+" for a new group. Click a
// chip to show its projects; right-click it for Rename and Delete. Below
// 160 px the sidebar is a rail: chips show initials only.

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

// What a chip shows in the rail: the first letters of the first two words
// ("Arctic Grey" → "AG"), or the first two letters of a single word
// ("Clients" → "Cl").
function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const [a = "", b = ""] = [...words[0]];
    return a.toUpperCase() + b;
  }
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("");
}

// Shows the n-th group (from 1), as F1–F3 do; nothing when there is none.
function selectNth(n) {
  updateRegistry((r) => (r.groups[n - 1] ? selectGroup(r, r.groups[n - 1].id) : r));
}

// The dot color of each group, or null: the blocked color when one of its
// agents waits on the person, else the done color (lib.js attentionByGroup,
// over the same matches the tree uses).
function dots(reg, t) {
  const sp = spaces();
  const matches = matchSpaces(cache(), sp, panes(), home());
  const any = attentionByGroup(reg, matches, sp);
  const blocked = attentionByGroup(reg, matches, sp.filter((s) => s.status === "blocked"));
  return (id) => (blocked[id] ? t.blocked : any[id] ? t.done : null);
}

export default class Groups {
  init(_props, _cx) {}

  chip(g, i, { on, dot, rail }, t) {
    const key = KEYS[i] ?? null;
    return h_flex()
      .id(`group-${g.id}`)
      .relative()
      .flex_none()
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(key ? `${g.name} · ${key}` : g.name)
      .on_click(() => updateRegistry((r) => selectGroup(r, g.id)))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openGroupMenu(g.id);
      })
      .when(rail, (el) => el.h(26).min_w(26).px(3).justify_center().text_size(11).font_semibold()
        .child(initials(g.name))
        .when(Boolean(dot), (el) => el.child(div().absolute().top(2).right(2).size(6).rounded_full().bg(dot))))
      .when(!rail, (el) => el.h(28).min_w(36).max_w(160).flex_shrink(1).px(8).gap(6)
        .child(div().min_w(0).truncate().child(g.name))
        .when(Boolean(dot), (el) => el.child(div().flex_none().size(6).rounded_full().bg(dot)))
        .when(Boolean(key), (el) => el.child(div().flex_none().text_size(11).text_color(on ? t.muted : t.dim).child(key))));
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
