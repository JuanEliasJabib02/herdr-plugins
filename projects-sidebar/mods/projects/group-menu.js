// The group-menu view (built in a later task). Placeholder.

import { div } from "gpui-kit";
import { theme } from "herdr";

export default class GroupMenu {
  init(_props, _cx) {}

  render() {
    const t = theme();
    return div().p(12).bg(t.popover).text_color(t.muted).child("group-menu");
  }
}
