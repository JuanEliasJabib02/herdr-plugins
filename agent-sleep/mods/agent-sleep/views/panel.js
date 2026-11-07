// The popup above the moon (S12, D14), one view:
//
//   Agent sleep · 2 asleep · ~620 MB freed      (tooltip: which path gave Core's fields)
//   Sleep idle agents                                     [ ●]
//   After 30 min                                        [−][+]
//   <why an asleep Claude stays asleep, one line each>
//   Next: checkout-flow in 30 min
//   Woke checkout-flow
//   [Sleep now] [Wake all]
//
// It opens as tall as its lines (panelHeight) and can't change size, so the
// lines take what is left and clip: the last ones are cut, the buttons never
// are. "Sleep idle agents" switches automatic sleep (Sleep now works either
// way); −/+ step the idle window from 1 min to 24 h. "Hide sleeping workspaces"
// comes with projects-sidebar's filter tag (T6).
//
// Draws only: main.js hands it the view the loop copy shared and `ask`, which
// names a command for the loop copy to run. No herdr import (main.js is the only
// file with one).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { PANEL } from "../panel-model.js";
import { MIN_IDLE_MINUTES, MAX_IDLE_MINUTES } from "../rules.js";

// A small bordered button; a disabled one is dimmed and takes no click.
function button(t, id, text, enabled, action) {
  return h_flex().id(id).h(PANEL.buttons).px(10).items_center().rounded(6)
    .border_1().border_color(t.input).bg(t.raised)
    .text_size(11.5).font_medium().text_color(t.foreground)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action))
    .when(!enabled, (el) => el.opacity(0.5))
    .child(text);
}

// A switch drawn by hand (gpui-base's Switch has no styling): a pill with its
// knob on the right when on.
function toggle(t, id, on, action) {
  return h_flex().id(id).flex_none().w(28).h(16).p(2).rounded(8).cursor_pointer()
    .bg(on ? t.accent : t.input)
    .when(on, (el) => el.justify_end())
    .on_click(action)
    .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.background));
}

const row = (label, ...controls) => h_flex().flex_none().h(PANEL.row).items_center().gap(6)
  .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(label))
  .children(controls);

// One line, cut at the popup's edge, its full text as a tooltip. flex_none: a
// column short of height clips the lines past its end, it doesn't squeeze them.
const line = (id, text, color) => div().id(id).flex_none().h(PANEL.line).w_full().truncate().text_size(11.5).text_color(color).tooltip(text).child(text);

// { t: theme(), view: panelView(), windowText: "After 30 min",
//   ask(command): a click handler that asks the loop copy to run a command }
export function renderPanel({ t, view, windowText, ask }) {
  const { settings } = view;
  return v_flex().id("agent-sleep-panel").size_full().min_h(0).overflow_hidden().px(PANEL.padX).py(PANEL.padY).gap(PANEL.gap)
    .bg(t.popover).text_color(t.foreground)
    .child(div().id("agent-sleep-headline").flex_none().h(PANEL.headline).w_full().truncate().text_size(12.5).font_medium()
      .when(Boolean(view.debug), (el) => el.tooltip(view.debug))
      .child(view.headline))
    .child(row("Sleep idle agents", toggle(t, "agent-sleep-enabled", settings.enabled, ask("toggle"))))
    .child(row(windowText,
      button(t, "agent-sleep-less", "−", settings.idleMinutes > MIN_IDLE_MINUTES, ask("less")),
      button(t, "agent-sleep-more", "+", settings.idleMinutes < MAX_IDLE_MINUTES, ask("more"))))
    // Most important first: what gets cut is what matters least.
    .child(v_flex().flex_1().min_h(0).overflow_hidden().gap(PANEL.lineGap)
      .children(view.holds.map((h, i) => line(`agent-sleep-hold-${i}`, h, t.blocked)))
      .when(Boolean(view.next), (el) => el.child(line("agent-sleep-next", view.next, t.muted)))
      .when(Boolean(view.last), (el) => el.child(line("agent-sleep-last", view.last, t.dim))))
    .child(h_flex().flex_none().h(PANEL.buttons).gap(6)
      .child(button(t, "agent-sleep-sleep-now", "Sleep now", true, ask("sleep-now")))
      .child(button(t, "agent-sleep-wake-all", "Wake all", view.asleep > 0, ask("wake-all"))));
}
