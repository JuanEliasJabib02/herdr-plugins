// The popover above the footer (S1, Image #1): `Usage` with refresh and
// Detailed | Compact, the Claude row with `Resets in` and its bars (it opens
// the panel), `Usage details & history` (it opens details) and `Manage
// Accounts…`. Owner: T6. T1 draws a placeholder.
//   props: { view: "popup" }

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, openOverlay } from "herdr";
import { MOD } from "./store.js";

// The only place that opens it: the footer's click and the open-popup
// command.
export function openPopup() {
  return openOverlay({ mod: MOD, kind: "popup", width: 340, height: 220, props: { view: "popup" } });
}

export default class Popup {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return v_flex()
      .id("ca-popup")
      .size_full()
      .min_h(0)
      .p(12)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Usage"))
      .child(div().text_size(12).text_color(t.dim).child("Claude usage shows here (placeholder)."));
  }
}
