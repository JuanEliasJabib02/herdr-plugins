// SettingsView — stub from T0; T9 (settings dialog) replaces this file.
import { div } from "gpui-kit";

export default class SettingsView {
  init(props, cx) {
    this.props = props ?? {};
  }

  render(cx) {
    return div().text_size(12).child("spotlight-settings-stub");
  }
}
