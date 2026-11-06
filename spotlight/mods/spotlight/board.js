// Board — stub from T0; T8 (Cola de pruebas popup) replaces this file.
import { div } from "gpui-kit";

export default class Board {
  init(props, cx) {
    this.props = props ?? {};
  }

  render(cx) {
    return div().text_size(12).child("spotlight-board-stub");
  }
}
