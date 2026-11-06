// Orca's switch dialog (D8): "Switched to {account}", the sessions still on
// the previous account with a checkbox each, "Don't ask again (restart
// automatically)", "Keep as is" and "Restart {{count}} sessions". It reads
// pending-switch.json; the footer opens it when toasts.react says so. Owner:
// T7. T1 draws a placeholder.
//   props: { view: "confirm" }

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, openOverlay } from "herdr";
import { MOD } from "./store.js";

// The only place that opens it: the footer (an Ask switch, or Review) and
// the open-confirm command. modal: a click beside it doesn't close it.
export function openConfirm() {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 440, height: 300, props: { view: "confirm" } });
}

export default class Confirm {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return v_flex()
      .id("ca-confirm")
      .size_full()
      .min_h(0)
      .p(14)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Switched account"))
      .child(div().text_size(12).text_color(t.dim).child("The running sessions to restart show here (placeholder). Esc closes."));
  }
}
