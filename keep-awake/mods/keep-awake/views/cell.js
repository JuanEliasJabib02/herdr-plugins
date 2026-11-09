// The cup in projects-sidebar's status row (S4, D8): the coffee icon, the
// mode's label and a small round dot, bright (foreground, the icon too) while
// the Mac is held awake and dim while it isn't; the status and the lid note
// as its tooltip. A click opens the popup above it. Orca's
// CaffeinateStatusSegment trigger, in the chrome of agent-sleep's moon beside
// it.
//
// Draws only: main.js hands it the theme, cellModel() and the handlers. No
// herdr import (main.js is the only file with one).

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

// { t: theme(), model: cellModel(), icon: the coffee's path, onPress: the
//   cell's press (where the popup opens), onClick: the cup's }
export function renderCell({ t, model, icon, onPress, onClick }) {
  const ink = model.active ? t.foreground : t.muted;
  return h_flex().id("keep-awake-cell").size_full().min_w(0).overflow_hidden().items_center().justify_center()
    .bg(t.chrome).border_t(1).border_color(t.border)
    .text_size(11.8).text_color(t.muted).whitespace_nowrap()
    .on_mouse_down("left", onPress)
    .child(h_flex().id("keep-awake-button").flex_none().px(3).py(2).gap(3).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(model.tooltip)
      .on_click(onClick)
      .child(svg(icon).size(12).flex_none().text_color(ink))
      .child(div().text_size(11).font_medium().child(model.label))
      .child(div().id("keep-awake-dot").flex_none().size(6).rounded_full().bg(model.active ? t.foreground : t.dim)));
}
