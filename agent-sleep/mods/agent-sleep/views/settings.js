// The block's settings (S6), drawn in place of its lines while open:
//
//   Agent sleep · Settings                                Done
//   Sleep idle agents                                     [ ●]
//   After 30 min                                        [−][+]
//
// "Sleep idle agents" switches automatic sleep (Sleep now works either
// way); −/+ step the idle window from 1 min to 24 h (stepMinutes). A change
// shows at once and is saved by the loop's next pulse (Coordinator
// requestSettings). "Hide sleeping workspaces" comes with projects-sidebar's
// filter tag (T6). No herdr import (main.js is the only file with one).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { button } from "./block.js";
import { MIN_IDLE_MINUTES, MAX_IDLE_MINUTES } from "../rules.js";

// A switch drawn by hand (gpui-base's Switch has no styling): a pill with
// its knob on the right when on.
function toggle(t, id, on, action) {
  return h_flex().id(id).flex_none().w(28).h(16).p(2).rounded(8).cursor_pointer()
    .bg(on ? t.accent : t.input)
    .when(on, (el) => el.justify_end())
    .on_click(action)
    .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.background));
}

const row = (label, ...controls) => h_flex().items_center().gap(6)
  .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(label))
  .children(controls);

// { t: theme(), settings: { enabled, idleMinutes }, windowText: "After 30 min",
//   onToggle, onLess, onMore, onDone: click handlers }
export function renderSettings({ t, settings, windowText, onToggle, onLess, onMore, onDone }) {
  return v_flex().id("agent-sleep-settings").w_full().px(10).py(8).gap(6).text_color(t.foreground)
    .child(h_flex().items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().child("Agent sleep · Settings"))
      .child(div().id("agent-sleep-settings-done").flex_none().text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click(onDone).child("Done")))
    .child(row("Sleep idle agents", toggle(t, "agent-sleep-enabled", settings.enabled, onToggle)))
    .child(row(windowText,
      button(t, "agent-sleep-less", "−", settings.idleMinutes > MIN_IDLE_MINUTES, onLess),
      button(t, "agent-sleep-more", "+", settings.idleMinutes < MAX_IDLE_MINUTES, onMore)));
}
