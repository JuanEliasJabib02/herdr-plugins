// The Markdown preview (plan lector-md, T2): what code-file's body shows in mode
// `preview`. Interface fixed by T1: new MarkdownPreview(host), render(t, cx),
// command(name, arg, cx) → whether it was this reader's, release().
// host: { file, doc, text(), visible() } — text() is the buffer, unsaved edits included.

import { div } from "gpui-kit";
import { READER_TEXT } from "./reader-model.js";

export class MarkdownPreview {
  constructor(host) {
    this.host = host;
  }

  render(t, _cx) {
    return div().p(12).text_color(t.dim).child(READER_TEXT.loading);
  }

  command(_name, _arg, _cx) {
    return false;
  }

  release() {}
}
