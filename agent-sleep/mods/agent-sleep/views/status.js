// The moon, last in the status row (S12, D14): the moon alone, and how many are
// asleep when any, the headline as its tooltip. A click on it opens the popup.
// Same chrome as claude-accounts' footer beside it.
//
// Draws only: main.js hands it the theme, the coordinator's blockModel and the
// handlers. No herdr import (main.js is the only file with one).

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

// { t: theme(), model: blockModel(), tone: moonTone()'s key of t, moon: the icon
//   path or null, onSize, onPress: the cell's measure and press (where the popup
//   opens), onClick: the moon's }
export function renderStatus({ t, model, tone, moon, onSize, onPress, onClick }) {
  return h_flex().id("agent-sleep-status").size_full().min_w(0).overflow_hidden().items_center().justify_center()
    .bg(t.chrome).border_t(1).border_color(t.border)
    .text_size(11.8).whitespace_nowrap()
    .on_size_change(onSize)
    .on_mouse_down("left", onPress)
    .child(h_flex().id("agent-sleep-moon").flex_none().px(4).py(2).gap(3).items_center().rounded(4).cursor_pointer()
      .text_color(t[tone])
      .hover((s) => s.bg(t.hover))
      .tooltip(model.headline)
      .on_click(onClick)
      .when(Boolean(moon), (el) => el.child(svg(moon).size(13).flex_none().text_color(t[tone])))
      .when(model.asleep > 0, (el) => el.child(div().child(String(model.asleep)))));
}
