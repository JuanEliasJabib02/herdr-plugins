// The groups bar (T4 builds it). Placeholder.

import { h_flex } from "gpui-base";
import { theme } from "herdr";

export default class Groups {
  init(_props, _cx) {}

  render() {
    const t = theme();
    return h_flex().size_full().px(12).items_center().bg(t.chrome).text_size(11.5).text_color(t.dim).child("Groups");
  }
}

export const commands = {};
