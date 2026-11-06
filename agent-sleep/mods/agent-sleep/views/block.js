// The Agent sleep block (S6), as the loop copy draws it in its layout slot:
//
//   ☾ Agent sleep · 2 asleep · ~620 MB freed          Settings
//   <why an asleep Claude stays asleep, one line each>
//   Next: checkout-flow in 30 min
//   Woke checkout-flow
//   fields: terminals()                  (which path gave Core's fields)
//   [Sleep now] [Wake all]
//
// The layout gives it a fixed height and a hold adds a line, so the lines
// between the headline and the buttons take what is left and clip: the last
// ones are cut, the buttons never are. In the sidebar's rail (rail.js) it is
// renderRail instead.
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
// flex_none: a column short of height clips the lines past its end, it doesn't
// squeeze them all.
const line = (id, text, color) => div().id(id).flex_none().w_full().truncate().text_size(11.5).text_color(color).tooltip(text).child(text);

// { t: theme(), model: blockModel(), moon: the icon path or null,
//   onSleepNow, onWakeAll, onSettings: click handlers }
export function renderBlock({ t, model, moon, onSleepNow, onWakeAll, onSettings }) {
  return v_flex().id("agent-sleep").size_full().overflow_hidden().px(10).py(8).gap(3).text_color(t.foreground)
    .child(h_flex().flex_none().items_center().gap(6)
      .when(Boolean(moon), (el) => el.child(svg(moon).size(13).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().child(model.headline))
      .child(div().id("agent-sleep-open-settings").flex_none().text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click(onSettings).child("Settings")))
    // Most important first: what gets cut is what matters least.
    .child(v_flex().flex_1().min_h(0).overflow_hidden().gap(3)
      .children(model.holds.map((h, i) => line(`agent-sleep-hold-${i}`, h, t.blocked)))
      .when(Boolean(model.next), (el) => el.child(line("agent-sleep-next", model.next, t.muted)))
      .when(Boolean(model.last), (el) => el.child(line("agent-sleep-last", model.last, t.dim)))
      .when(Boolean(model.debug), (el) => el.child(line("agent-sleep-debug", model.debug, t.dim).text_size(10))))
    .child(h_flex().flex_none().pt(4).gap(6)
      .child(button(t, "agent-sleep-sleep-now", "Sleep now", true, onSleepNow))
      .child(button(t, "agent-sleep-wake-all", "Wake all", model.asleep > 0, onWakeAll)));
}

// The block in the sidebar's rail, 44 or 76 px wide: the moon, centered, and
// how many are asleep when any, the headline as its tooltip.
// { t: theme(), model: blockModel(), moon: the icon path or null }
export function renderRail({ t, model, moon }) {
  return v_flex().id("agent-sleep-rail").size_full().overflow_hidden().items_center().justify_center().gap(2)
    .text_color(t.muted).tooltip(model.headline)
    .when(Boolean(moon), (el) => el.child(svg(moon).size(14).flex_none().text_color(t.muted)))
    .when(model.asleep > 0, (el) => el.child(div().flex_none().text_size(10).font_medium().child(String(model.asleep))));
}
