// The PDF reader (plan lector-md, T3): what code-file's body shows for a `.pdf`.
// Interface fixed by T1: new PdfViewer(host, cx), render(t, cx), command(name, arg,
// cx) → whether it was this reader's (zoom-in, zoom-out, zoom-reset, find, …), release().
// host: { file, doc, text(), visible() } — text() is unused here: a PDF has no text model.

import { div } from "gpui-kit";
import { READER_TEXT } from "./reader-model.js";

export class PdfViewer {
  constructor(host, _cx) {
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
