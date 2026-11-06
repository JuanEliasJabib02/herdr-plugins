// Footer — stub from T0; T8 (footer flask) replaces this file.
import { div } from "gpui-kit";

export default class Footer {
  init(props, cx) {
    this.props = props ?? {};
  }

  render(cx) {
    return div().text_size(12).child("spotlight-footer-stub");
  }
}
