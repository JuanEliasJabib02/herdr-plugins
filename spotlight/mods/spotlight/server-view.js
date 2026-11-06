// ServerView — stub from T0; T10 (server popup, D22) replaces this file.
import { div } from "gpui-kit";

export default class ServerView {
  init(props, cx) {
    this.props = props ?? {};
  }

  render(cx) {
    return div().text_size(12).child("spotlight-server-stub");
  }
}
