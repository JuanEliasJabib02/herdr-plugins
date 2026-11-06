// The Agent sleep block (S6), as the loop copy draws it in its layout slot:
//
//   ☾ Agent sleep · 2 asleep · ~620 MB freed          Settings
//   Next: checkout-flow in 30 min
//   Woke checkout-flow
//   <why an asleep Claude stays asleep, one line each>
//   fields: terminals()                  (which path gave Core's fields)
//   [Sleep now] [Wake all]
//
// Draws only: main.js hands it the theme, the coordinator's blockModel and
// the actions. No herdr import (main.js is the only file with one).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// A small bordered button; a disabled one is dimmed and takes no click.
export function button(t, id, text, enabled, action) {
  return h_flex().id(id).h(24).px(10).items_center().rounded(6)
    .border_1().border_color(t.input).bg(t.raised)
    .text_size(11.5).font_medium().text_color(t.foreground)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action))
    .when(!enabled, (el) => el.opacity(0.5))
    .child(text);
}

// One line of the block, cut at the block's edge (its full text as a tooltip).
const line = (id, text, color) => div().id(id).w_full().truncate().text_size(11.5).text_color(color).tooltip(text).child(text);

// { t: theme(), model: blockModel(), moon: the icon path or null,
//   onSleepNow, onWakeAll, onSettings: click handlers }
export function renderBlock({ t, model, moon, onSleepNow, onWakeAll, onSettings }) {
  return v_flex().id("agent-sleep").w_full().px(10).py(8).gap(3).text_color(t.foreground)
    .child(h_flex().items_center().gap(6)
      .when(Boolean(moon), (el) => el.child(svg(moon).size(13).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().child(model.headline))
      .child(div().id("agent-sleep-open-settings").flex_none().text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click(onSettings).child("Settings")))
    .when(Boolean(model.next), (el) => el.child(line("agent-sleep-next", model.next, t.muted)))
    .when(Boolean(model.last), (el) => el.child(line("agent-sleep-last", model.last, t.dim)))
    .children(model.holds.map((h, i) => line(`agent-sleep-hold-${i}`, h, t.blocked)))
    .when(Boolean(model.debug), (el) => el.child(line("agent-sleep-debug", model.debug, t.dim).text_size(10)))
    .child(h_flex().pt(4).gap(6)
      .child(button(t, "agent-sleep-sleep-now", "Sleep now", true, onSleepNow))
      .child(button(t, "agent-sleep-wake-all", "Wake all", model.asleep > 0, onWakeAll)));
}
