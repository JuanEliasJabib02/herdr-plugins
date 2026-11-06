// Usage details & history (S7, D11), a window: the range picker (7, 30, 90
// days, all time), by model, by project and by account, the cache figures,
// recent sessions, the daily chart and the time to each limit, from
// details.json (`claude-accounts details --range <r>`). Owner: T10. T1 draws
// a placeholder.
//   props: { view: "details" }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./store.js";

// The only place that opens it: the popup's Usage details & history and the
// open-details command. A window keeps its place (key); Esc goes to the mod,
// so it has its own Close.
export function openDetails() {
  return openOverlay({ mod: MOD, kind: "window", key: "claude-accounts.details", width: 760, height: 560, props: { view: "details" } });
}

export default class Details {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return v_flex()
      .id("ca-details")
      .size_full()
      .min_h(0)
      .p(14)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).text_size(14).font_semibold().child("Usage details & history"))
        .child(div().id("ca-details-close").px(8).py(2).rounded(6).cursor_pointer().text_size(12).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(props()?.overlay))
          .child("Close")))
      .child(div().text_size(12).text_color(t.dim).child("Usage by model, project and account shows here (placeholder)."));
  }
}
