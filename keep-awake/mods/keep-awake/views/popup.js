// The popup above the cup (S2, S3, D8), Orca's Caffeinate dropdown:
//
//   Keep computer awake                    On · Active
//   ─────────────────────────────────────────────────
//   ●  On
//      Keep this computer awake continuously
//      Agent
//      Stay awake while an agent is working
//      Off
//      Allow normal system sleep behavior
//
// The title in medium weight, the status dim at its right, a separator, then
// one row per mode: a dot column (filled on the chosen mode only), the label
// in normal text and the description dim below it. A click on a row picks
// that mode and closes the popup. It opens as tall as popupHeight() says, so
// each part is drawn exactly POPUP's size.
//
// Draws only: main.js hands it the theme, popupModel() and `onPick(value)`.
// No herdr import (main.js is the only file with one).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { POPUP } from "../popup-model.js";

// One mode: the whole row is the click target, raised under the pointer.
function row(t, r, onPick) {
  return h_flex().id(`keep-awake-mode-${r.value}`).flex_none().h(POPUP.row).mx(4).px(6).gap(8).items_center().rounded(4).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => onPick(r.value))
    .child(h_flex().flex_none().w(12).items_center().justify_center()
      .when(r.chosen, (el) => el.child(div().id(`keep-awake-dot-${r.value}`).size(8).rounded_full().bg(t.foreground))))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().text_size(12.5).child(r.label))
      .child(div().truncate().text_size(11).text_color(t.muted).child(r.description)));
}

// { t: theme(), model: popupModel(), onPick(value): a row's click }
export function renderPopup({ t, model, onPick }) {
  return v_flex().id("keep-awake-popup").size_full().min_h(0).overflow_hidden().py(POPUP.padY)
    .bg(t.popover).text_color(t.foreground)
    .child(h_flex().id("keep-awake-header").flex_none().h(POPUP.header).px(10).gap(8).items_center().justify_between()
      .child(div().min_w(0).truncate().text_size(12.5).font_medium().child(model.title))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(model.status)))
    .child(div().id("keep-awake-separator").flex_none().h(POPUP.separator).my(POPUP.separatorGap).bg(t.border))
    .children(model.rows.map((r) => row(t, r, onPick)));
}
