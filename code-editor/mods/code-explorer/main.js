// Placeholder for the Explorer block in the projects layout's right panel: it
// draws the block so the plugin's wiring (the layout, ctrl-l, the theme) can be
// seen working. The file tree replaces it.
import { View, div } from "gpui-kit";
import { theme } from "herdr";

export default class CodeExplorer extends View {
  render() {
    const t = theme();
    return div().id("code-explorer").size_full().min_h(0).p(12).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.muted).text_size(13)
      .child("Explorer");
  }
}
