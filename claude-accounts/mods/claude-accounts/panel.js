// The Claude panel (S1, Image #2): `Claude  Updated 3m ago`, the active
// account's card (Session, Weekly, Fable, Monthly and credits when present),
// then the `Claude Account` list: System default plus each account, ✓ on the
// active one, the inactive ones with their `wk` and `Fable` bars. A click
// runs `use`. Owner: T6. T1 draws a placeholder.
//   props: { view: "panel" }

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, openOverlay } from "herdr";
import { MOD } from "./store.js";

// The only place that opens it: the popup's Claude row and the open-panel
// command.
export function openPanel() {
  return openOverlay({ mod: MOD, kind: "popup", width: 360, height: 420, props: { view: "panel" } });
}

export default class Panel {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return v_flex()
      .id("ca-panel")
      .size_full()
      .min_h(0)
      .p(12)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Claude"))
      .child(div().text_size(12).text_color(t.dim).child("The accounts and their usage show here (placeholder)."));
  }
}
