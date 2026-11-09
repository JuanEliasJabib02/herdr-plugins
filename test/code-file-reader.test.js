// Which view a file gets, and the commands of the readers (plan lector-md T1:
// D7, D9, D10). Pure functions of reader-model.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_LIMIT, READER_TEXT, appZoomFor, initialMode, splitCommand, tooBigForPreview, viewKind } from "../code-editor/mods/code-file/reader-model.js";

test("D9: Markdown by its extensions, any case; a PDF by .pdf; everything else is text", () => {
  for (const f of ["/r/README.md", "/r/a.MD", "/r/b.markdown", "/r/c.mdown", "/r/d.mkd"]) assert.equal(viewKind(f), "markdown", f);
  assert.equal(viewKind("/r/book.pdf"), "pdf");
  assert.equal(viewKind("/r/BOOK.PDF"), "pdf");
  for (const f of ["/r/a.js", "/r/.md", "/r/md", "/r/a.mdx", "/r/notes.txt", "/r/a.pdf.txt"]) assert.equal(viewKind(f), "text", f);
});

test("S5, D9: Markdown opens rendered; a line asked for still opens the line view; text opens the editor", () => {
  assert.equal(initialMode("markdown", null), "preview");
  assert.equal(initialMode("markdown", 12), "lines");
  assert.equal(initialMode("text", null), "editor");
  assert.equal(initialMode("text", 3), "lines");
});

test("D9: over Orca's 600 KiB the preview gives way to Source", () => {
  assert.equal(PREVIEW_LIMIT, 600 * 1024);
  assert.equal(tooBigForPreview("x".repeat(PREVIEW_LIMIT)), false);
  assert.equal(tooBigForPreview("x".repeat(PREVIEW_LIMIT + 1)), true);
  assert.equal(tooBigForPreview(null), false);
});

test("D7: the zoom keys fall back to the window's zoom; nothing else does", () => {
  assert.equal(appZoomFor("zoom-in"), "app.zoom_in");
  assert.equal(appZoomFor("zoom-out"), "app.zoom_out");
  assert.equal(appZoomFor("zoom-reset"), "app.zoom_reset");
  assert.equal(appZoomFor("find"), null);
  assert.equal(appZoomFor("constructor"), null);
});

test("D7: a reader's command, with or without the mod's prefix, its argument after the first colon", () => {
  assert.deepEqual(splitCommand("code-file.zoom-in"), { name: "zoom-in", arg: "" });
  assert.deepEqual(splitCommand("find:a:b"), { name: "find", arg: "a:b" });
  assert.deepEqual(splitCommand("code-file.link:./b.md#x"), { name: "link", arg: "./b.md#x" });
  assert.equal(splitCommand("code-file."), null);
  assert.equal(splitCommand(""), null);
});

test("S5, S9: the toggle's labels are Orca's, and so is the loading line", () => {
  assert.deepEqual({ ...READER_TEXT }, { source: "Source", preview: "Preview", loading: "Loading preview..." });
});
