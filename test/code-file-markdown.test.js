// lector-md T2 (S1, S5, S6): the Markdown preview. First its pure parts: the
// block splitter (D1), where a link goes (D8), where an image comes from and how
// it lands in the cache (D3, D12), the colors of fenced code (D13), and the copy of
// the Explorer's openFile (D8, L2), held to the original by running both. Then
// MarkdownPreview itself in a fake Herdr: `herdr`, `gpui-kit`, `gpui-base` and
// `fs/promises` resolve to stand-ins, and every click also has a command, since
// real clicks can't be posted in the live cases. How it looks stays with
// `herdr-app check` and the isolated Herdr's shots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  PREVIEW_TEXT, cannotOpenDir, codeLanguage, highlight, imageSource, linkTarget, notFound, pathKind, shownPath, splitBlocks, titleCallouts,
} from "../code-editor/mods/code-file/markdown-model.js";
import { IMG_DIR, MAX_IMAGE, createImageCache, curlArgs, fitWidth, isSvg, parseSips, parseStat, svgSize } from "../code-editor/mods/code-file/image-cache.js";
import * as mine from "../code-editor/mods/code-file/open-model.js";
import * as explorer from "../code-editor/mods/code-explorer/tree-model.js";
import { SYNTAX } from "../code-editor/mods/code-file/line-view-model.js";
import { hashPath } from "../code-editor/mods/code-file/draft-model.js";

const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise(setImmediate);
};

const MD = "/repo/docs/README.md";
const md = (text) => ({ kind: "markdown", text });
const code = (lang, text) => ({ kind: "code", lang, text });
const pic = (alt, src, over = {}) => ({ alt, src, title: "", href: null, ...over });

// ── D1: the blocks TextView can't draw ───────────────────────────────────────

test("D1: plain Markdown is one run for one TextView; nothing at all is no block", () => {
  assert.deepEqual(splitBlocks("# Title\n\nText with **bold** and a [link](b.md).\n"), [md("# Title\n\nText with **bold** and a [link](b.md).")]);
  assert.deepEqual(splitBlocks(""), []);
  assert.deepEqual(splitBlocks("\n\n  \n"), []);
  assert.deepEqual(splitBlocks(null), []);
});

test("S6: front matter only at the very top, between --- or +++ lines, the text inside without its fences", () => {
  assert.deepEqual(splitBlocks("---\ntitle: Notes\ntags: [a, b]\n---\n# Hi\n"), [{ kind: "frontmatter", text: "title: Notes\ntags: [a, b]" }, md("# Hi")]);
  assert.deepEqual(splitBlocks("+++\ntitle = \"x\"\n+++\nBody"), [{ kind: "frontmatter", text: 'title = "x"' }, md("Body")]);
  assert.deepEqual(splitBlocks("---\na: 1\n---"), [{ kind: "frontmatter", text: "a: 1" }], "closed at the end of the file");
  assert.deepEqual(splitBlocks("---\nkey:\n  nested: 2\n---\n"), [{ kind: "frontmatter", text: "key:\n  nested: 2" }], "indentation inside stays");
  // Anywhere else it's Markdown: a rule, a setext heading, text.
  for (const text of ["# Hi\n\n---\na: 1\n---\n", "\n---\na: 1\n---\n", "---\na: 1\n", "---\na: 1\n+++\n", " ---\na: 1\n---\n"]) {
    assert.equal(splitBlocks(text).some((b) => b.kind === "frontmatter"), false, JSON.stringify(text));
  }
});

test("S6: a fenced block with ``` or ~~~ is code, with its language the info string's first word", () => {
  assert.deepEqual(splitBlocks("```js\nconst a = 1;\n```\n"), [code("js", "const a = 1;")]);
  assert.deepEqual(splitBlocks("~~~python title=\"x.py\"\nprint(1)\n~~~"), [code("python", "print(1)")]);
  assert.deepEqual(splitBlocks("```\nplain\n```"), [code("", "plain")]);
  assert.deepEqual(splitBlocks("Intro\n```sh\nls\n```\nOutro"), [md("Intro"), code("sh", "ls"), md("Outro")], "a fence interrupts a paragraph");
  assert.deepEqual(splitBlocks("```mermaid\ngraph TD\n  A --> B\n```"), [code("mermaid", "graph TD\n  A --> B")], "S6: Mermaid shows as its code");
  assert.deepEqual(splitBlocks("```\n\n```"), [code("", "")]);
});

test("S6: a fence closes only on the same mark, as long or longer, alone on its line", () => {
  assert.deepEqual(splitBlocks("```\na\n`````\nafter"), [code("", "a"), md("after")], "a longer closing fence");
  assert.deepEqual(splitBlocks("````\n```\nstill code\n````"), [code("", "```\nstill code")], "a shorter one is content");
  assert.deepEqual(splitBlocks("```\n~~~\n```"), [code("", "~~~")], "the other mark is content");
  assert.deepEqual(splitBlocks("```\na\n```js\n```"), [code("", "a\n```js")], "a closing fence takes no info string");
  assert.deepEqual(splitBlocks("```\na\n```   \nb"), [code("", "a"), md("b")], "trailing spaces still close");
});

test("S6: an unclosed fence runs to the end of the file", () => {
  assert.deepEqual(splitBlocks("text\n\n```sh\necho 1\n\necho 2"), [md("text"), code("sh", "echo 1\n\necho 2")]);
  assert.deepEqual(splitBlocks("```js\n![a](a.png)\n# not a heading"), [code("js", "![a](a.png)\n# not a heading")], "everything after it is code");
});

test("S6: a fence indented up to 3 spaces takes that much indentation off its lines; 4 is indented code, left to TextView", () => {
  assert.deepEqual(splitBlocks("  ```\n  a\n    b\nc\n  ```"), [code("", "a\n  b\nc")]);
  const indented = "Para\n\n    ```\n    x\n    ```\n";
  assert.deepEqual(splitBlocks(indented), [md("Para\n\n    ```\n    x\n    ```")]);
  assert.deepEqual(splitBlocks("``` a`b\ntext"), [md("``` a`b\ntext")], "a backtick in a backtick fence's info is inline code");
});

test("D1: a paragraph of images alone is ours; its images keep alt, source and title", () => {
  assert.deepEqual(splitBlocks("![logo](img/logo.png)"), [{ kind: "images", images: [pic("logo", "img/logo.png")] }]);
  assert.deepEqual(splitBlocks('![a](a.png "The title")'), [{ kind: "images", images: [pic("a", "a.png", { title: "The title" })] }]);
  assert.deepEqual(splitBlocks("![](<my pic.png>)"), [{ kind: "images", images: [pic("", "my pic.png")] }]);
  assert.deepEqual(splitBlocks("![a \\] b](x.png)"), [{ kind: "images", images: [pic("a ] b", "x.png")] }]);
  assert.deepEqual(splitBlocks("![a](a.png)\n![b](b.png)"), [{ kind: "images", images: [pic("a", "a.png"), pic("b", "b.png")] }], "lines of one paragraph flow together");
  assert.deepEqual(splitBlocks("# Title\n![a](a.png)\n\nText"), [md("# Title"), { kind: "images", images: [pic("a", "a.png")] }, md("Text")], "a heading ends its block");
  assert.deepEqual(splitBlocks("Text\n\n![a](a.png)\n- item"), [md("Text"), { kind: "images", images: [pic("a", "a.png")] }, md("- item")], "a list item interrupts it");
});

test("D1: linked badges, inline or by reference, are images with where they link", () => {
  const badges = "[![CI](https://x.io/ci.svg)](https://x.io/actions) [![npm](https://x.io/npm.svg \"npm\")](https://npm.im/x)";
  assert.deepEqual(splitBlocks(badges), [{ kind: "images", images: [
    pic("CI", "https://x.io/ci.svg", { href: "https://x.io/actions" }),
    pic("npm", "https://x.io/npm.svg", { title: "npm", href: "https://npm.im/x" }),
  ] }]);
  const refs = "[![Build][badge]][site] ![Logo][]\n\n[badge]: https://b.io/b.svg\n[site]: <https://s.io> \"Site\"\n[logo]: img/logo.png";
  assert.deepEqual(splitBlocks(refs), [{ kind: "images", images: [
    pic("Build", "https://b.io/b.svg", { href: "https://s.io" }),
    pic("Logo", "img/logo.png"),
  ] }], "definitions alone draw nothing: no run of their own");
});

test("D1: a paragraph mixing images and anything else stays text", () => {
  for (const text of [
    "See ![a](a.png) here",
    "![a](a.png)\nmore text",
    "Intro text\n![a](a.png)",
    "![a](a.png)\n---",
    "![a](a.png)\n===",
    "    ![a](a.png)",
    "> ![a](a.png)",
    "- ![a](a.png)",
    "![a](a.png) trailing",
    "![a][missing]",
    "[![a](a.png)]",
  ]) {
    assert.equal(splitBlocks(text).some((b) => b.kind === "images"), false, JSON.stringify(text));
  }
});

test("R9: a fence or an image paragraph indented under an open list item stays in the list's run, so the list isn't cut in two", () => {
  const steps = "1. Step one:\n   ```bash\n   npm i\n   ```\n2. Step two";
  assert.deepEqual(splitBlocks(steps), [{ kind: "markdown", text: steps }]);
  const shot = "- item\n\n  ![shot](a.png)\n\n- next";
  assert.deepEqual(splitBlocks(shot), [{ kind: "markdown", text: shot }]);
  const inside = "- a\n\n  ```\n  ![x](y.png)\n  # not a heading\n  ```\n- b";
  assert.deepEqual(splitBlocks(inside), [{ kind: "markdown", text: inside }], "the fence's lines go through untouched");
});

test("R9: the list ends at an unindented line after a blank one, or at a fence at column 0; what follows is ours again", () => {
  assert.deepEqual(splitBlocks("- a\n\nText\n\n  ```js\n  x\n  ```"), [
    { kind: "markdown", text: "- a\n\nText" },
    { kind: "code", lang: "js", text: "x" },
  ]);
  assert.deepEqual(splitBlocks("- a\n```js\nx\n```\n  ![p](p.png)"), [
    { kind: "markdown", text: "- a" },
    { kind: "code", lang: "js", text: "x" },
    { kind: "images", images: [{ alt: "p", src: "p.png", title: "", href: null }] },
  ]);
  assert.deepEqual(splitBlocks("- a\n\n# Title\n\n ![p](p.png)").at(-1).kind, "images", "a heading ends it too");
  assert.deepEqual(splitBlocks("- a\nlazy line\n\n  ```\n  in list\n  ```"), [{ kind: "markdown", text: "- a\nlazy line\n\n  ```\n  in list\n  ```" }], "a lazy line keeps it open");
});

test("D1: link definitions reach every run, so a reference split from its definition still links", () => {
  const blocks = splitBlocks("See [docs][d].\n\n```\nx\n```\n\nAnd [docs][d] again.\n\n[d]: https://d.io\n");
  assert.deepEqual(blocks.map((b) => b.kind), ["markdown", "code", "markdown"]);
  assert.match(blocks[0].text, /^See \[docs\]\[d\]\.\n\n\[d\]: https:\/\/d\.io$/);
  assert.equal(blocks[2].text, "And [docs][d] again.\n\n[d]: https://d.io", "its own definition isn't repeated");
  assert.deepEqual(splitBlocks("```\n[x]: https://not.a.def\n```\nText"), [code("", "[x]: https://not.a.def"), md("Text")], "nothing in code is a definition");
});

test("D1: Windows line ends read as Unix ones", () => {
  assert.deepEqual(splitBlocks("---\r\na: 1\r\n---\r\n```js\r\nx\r\n```\r\n"), [{ kind: "frontmatter", text: "a: 1" }, code("js", "x")]);
});

// ── D13: fenced code in One Dark ─────────────────────────────────────────────

test("D13: a fence's language by its name or its usual aliases, none for plain text", () => {
  for (const [name, language] of [["js", "js"], ["JavaScript", "js"], ["typescript", "js"], ["tsx", "js"], ["python", "py"], ["py", "py"], ["shell", "sh"], ["console", "sh"], ["bash", "bash"], ["yml", "yaml"], ["toml", "yaml"], ["rust", "rs"], ["go", "go"], ["sql", "sql"]]) {
    assert.equal(codeLanguage(name), language, name);
  }
  for (const name of ["", "text", "txt", "plaintext"]) assert.equal(codeLanguage(name), null, name);
});

test("D13: code lines become tokens with line-view-model's colors; no language, no colors", () => {
  const [first, empty, second] = highlight("const a = 'x'; // hi\n\n\tlet b", "js");
  assert.deepEqual(first.find((t) => t.text === "const"), { text: "const", color: SYNTAX.keyword, italic: false });
  assert.deepEqual(first.find((t) => t.text === "'x'"), { text: "'x'", color: SYNTAX.string, italic: false });
  assert.deepEqual(first.at(-1), { text: "// hi", color: SYNTAX.comment, italic: true });
  assert.equal(first.map((t) => t.text).join(""), "const a = 'x'; // hi");
  assert.deepEqual(empty, []);
  assert.equal(second.map((t) => t.text).join(""), "  let b", "a tab draws as two spaces");
  assert.deepEqual(highlight("const x = 1", ""), [[{ text: "const x = 1", color: null, italic: false }]]);
  assert.deepEqual(highlight("# comment", "python")[0], [{ text: "# comment", color: SYNTAX.comment, italic: true }]);
});

// ── D8: where a link goes ────────────────────────────────────────────────────

test("D8: http(s) is the browser's, mailto the system's, an anchor nothing's", () => {
  assert.deepEqual(linkTarget("https://x.io/a?b#c", MD), { kind: "web", url: "https://x.io/a?b#c" });
  assert.deepEqual(linkTarget("HTTP://x.io", MD), { kind: "web", url: "HTTP://x.io" });
  assert.deepEqual(linkTarget("mailto:a@b.io", MD), { kind: "mail", url: "mailto:a@b.io" });
  assert.deepEqual(linkTarget("#install", MD), { kind: "anchor" });
  assert.deepEqual(linkTarget("", MD), { kind: "anchor" });
});

test("D8: anything else is a path from the file's folder: file:// off, ?/# cut, %-decoded, dots resolved", () => {
  const path = (url) => linkTarget(url, MD);
  assert.deepEqual(path("guide.md"), { kind: "path", path: "/repo/docs/guide.md" });
  assert.deepEqual(path("./guide.md#setup"), { kind: "path", path: "/repo/docs/guide.md" });
  assert.deepEqual(path("../README.md?plain=1"), { kind: "path", path: "/repo/README.md" });
  assert.deepEqual(path("a/./b/../c.md"), { kind: "path", path: "/repo/docs/a/c.md" });
  assert.deepEqual(path("../../../../etc/hosts"), { kind: "path", path: "/etc/hosts" });
  assert.deepEqual(path("/abs/x.md"), { kind: "path", path: "/abs/x.md" });
  assert.deepEqual(path("file:///abs/my%20notes.md"), { kind: "path", path: "/abs/my notes.md" });
  assert.deepEqual(path("file://localhost/abs/x.md"), { kind: "path", path: "/abs/x.md" });
  assert.deepEqual(path("caf%C3%A9.md"), { kind: "path", path: "/repo/docs/café.md" });
  assert.deepEqual(path("100%.md"), { kind: "path", path: "/repo/docs/100%.md" }, "a stray % stays as written");
  assert.deepEqual(path("a%23b.md"), { kind: "path", path: "/repo/docs/a#b.md" }, "decoded after the cut, so an escaped # stays in the name");
  assert.deepEqual(path("sub/"), { kind: "path", path: "/repo/docs/sub" });
});

test("D8: the toasts name the path, the home as ~", () => {
  assert.equal(notFound(shownPath("/home/juan/repo/x.md", "/home/juan")), "File not found: ~/repo/x.md");
  assert.equal(cannotOpenDir(shownPath("/etc", "/home/juan")), "Cannot open directory: /etc");
  assert.equal(shownPath("/home/juanito/x", "/home/juan"), "/home/juanito/x");
});

test("D8: what the shell probe says a path is", () => {
  assert.equal(pathKind("dir\n"), "dir");
  assert.equal(pathKind("file\n"), "file");
  assert.equal(pathKind("none\n"), "none");
  assert.equal(pathKind(""), "none");
});

// ── D3: where an image comes from ────────────────────────────────────────────

test("D3: a remote image is its URL; anything else is a file from the Markdown's folder; data: and other schemes draw nothing", () => {
  assert.deepEqual(imageSource("https://x.io/a.png", MD), { kind: "url", url: "https://x.io/a.png", key: "url:https://x.io/a.png" });
  assert.deepEqual(imageSource("//cdn.io/a.png", MD), { kind: "url", url: "https://cdn.io/a.png", key: "url:https://cdn.io/a.png" });
  assert.deepEqual(imageSource("img/a.png", MD), { kind: "file", path: "/repo/docs/img/a.png", key: "file:/repo/docs/img/a.png" });
  assert.deepEqual(imageSource("../a%20b.png?raw=1#x", MD), { kind: "file", path: "/repo/a b.png", key: "file:/repo/a b.png" });
  assert.deepEqual(imageSource("file:///tmp/a.png", MD), { kind: "file", path: "/tmp/a.png", key: "file:/tmp/a.png" });
  assert.equal(imageSource("data:image/png;base64,iVBOR", MD), null);
  assert.equal(imageSource("ftp://x.io/a.png", MD), null);
  assert.equal(imageSource("", MD), null);
});

// ── D3, D12: the image cache ─────────────────────────────────────────────────

test("D12, R4: curl's arguments, as an array: no ~/.curlrc, no [a-b] or {x,y} expansion, http(s) only, 15 s, 10 MiB, into the given file", () => {
  assert.deepEqual(curlArgs("https://x.io/a.png", "/h/data/code-file/img/u1.part"), [
    "-q", "--globoff", "-fsSL", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-time", "15", "--max-filesize", "10485760", "-o", "/h/data/code-file/img/u1.part", "https://x.io/a.png",
  ]);
});

test("D12: sizes: sips for rasters, the SVG's own width/height/viewBox, capped to the content width", () => {
  assert.deepEqual(parseSips("/x/a.png\n  format: png\n  pixelWidth: 256\n  pixelHeight: 128\n"), { format: "png", width: 256, height: 128 });
  assert.deepEqual(parseSips("/x/a.svg\n  format: svg\n  pixelWidth: 90.000\n  pixelHeight: 20.000\n"), { format: "svg", width: 90, height: 20 });
  assert.deepEqual(parseSips("/x/a.txt\n  format: txt\n  pixelWidth: <nil>\n"), { format: "txt", width: 0, height: 0 });
  assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20">'), { width: 90, height: 20 });
  assert.deepEqual(svgSize("<?xml version='1.0'?>\n<!-- c -->\n<svg width='12px' height='8px' viewBox='0 0 24 16'>"), { width: 12, height: 8 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 24 16"><path/></svg>'), { width: 24, height: 16 });
  assert.deepEqual(svgSize('<svg width="48" viewBox="0,0,24,16">'), { width: 48, height: 32 }, "one side and the viewBox's ratio");
  assert.deepEqual(svgSize('<svg width="100%" height="100%" viewBox="0 0 10 5">'), { width: 10, height: 5 }, "percentages say nothing");
  assert.deepEqual(svgSize("<svg>"), { width: 300, height: 150 }, "a browser's default");
  const flood = "<svg ".repeat(200000) + ' width="9 height="9';
  const started = performance.now();
  assert.deepEqual(svgSize(flood), { width: 300, height: 150 }, "a tag that never closes: the default");
  assert.ok(performance.now() - started < 100, "linear: a 1 MB body of open tags doesn't hold the thread");
  assert.deepEqual(svgSize(`<svg width="40" height="20" ${"x ".repeat(5000)}>`), { width: 40, height: 20 }, "the root tag's attributes are read from its start");
  assert.deepEqual(fitWidth({ width: 1000, height: 500 }, 400), { width: 400, height: 200 });
  assert.deepEqual(fitWidth({ width: 90, height: 20 }, 400), { width: 90, height: 20 });
  assert.deepEqual(fitWidth({ width: 90, height: 20 }, Infinity), { width: 90, height: 20 });
  assert.deepEqual(parseStat("1794074635 110 Regular File\n"), { mtime: "1794074635", size: 110, dir: false, file: true });
  assert.deepEqual(parseStat("1794074635 160 Directory\n"), { mtime: "1794074635", size: 160, dir: true, file: false });
  assert.deepEqual(parseStat("1794074635 0 Character Device\n"), { mtime: "1794074635", size: 0, dir: false, file: false }, "R1: /dev/zero");
  assert.equal(parseStat(""), null);
});

test("R7: an SVG is a document that starts with <svg, after a BOM, an XML prolog, comments or a doctype; an HTML page holding icons is not one", () => {
  assert.equal(isSvg('<svg width="9" height="9"></svg>'), true);
  assert.equal(isSvg("\uFEFF  <?xml version='1.0' encoding='UTF-8'?>\n<!-- by hand -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\">\n<SVG viewBox='0 0 1 1'>"), true);
  assert.equal(isSvg('<!DOCTYPE html><html><body><svg class="octicon" width="16" height="16"></svg></body></html>'), false);
  assert.equal(isSvg('<html><svg width="16"></svg>'), false);
  assert.equal(isSvg("plain text <svg>"), false);
  assert.equal(isSvg("<svgx>"), false);
  assert.equal(isSvg(""), false);
});

test("R7, C-2: an Adobe Illustrator export, its doctype holding an internal subset of entities, is an SVG", () => {
  const illustrator = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->",
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [',
    '\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">',
    '\t<!ENTITY ns_flows "http://ns.adobe.com/Flows/1.0/">',
    "]>",
    '<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_extend;" width="64px" height="32px" viewBox="0 0 64 32">',
  ].join("\n");
  assert.equal(isSvg(illustrator), true);
  assert.equal(isSvg('<!DOCTYPE svg [ <!ENTITY a "]>"> <!-- ] > --> ]><svg>'), true, "a ] or > inside a quoted value or a comment doesn't end the subset");
  assert.equal(isSvg('<!DOCTYPE svg [ <!ENTITY a "x">'), false, "a subset that never closes");
  assert.equal(isSvg('<!DOCTYPE html [ <!ENTITY a "x"> ]><svg>'), false, "still an svg doctype only");
});

test("R7, C-1: the check takes linear time: thousands of comments before something that isn't <svg fail at once", () => {
  const comments = "<!-- a -->".repeat(5000);
  const started = performance.now();
  assert.equal(isSvg(`${comments}<html>`), false);
  const took = performance.now() - started;
  assert.ok(took < 100, `took ${took.toFixed(1)} ms`);
  assert.equal(isSvg(`${comments}<svg>`), true);
  assert.equal(isSvg(`${comments}\n<svg/>`), true, "<svg followed by /");
  assert.equal(isSvg("<!-- a --> b --><svg>"), false, "a comment ends at its first -->");
  assert.equal(isSvg("<!-- never closed <svg>"), false);
});

const APP = "/home/juan/.config/herdr-app";
const CACHE = `${APP}/${IMG_DIR}`;

// A disk for the cache: `files` are what stat and sips see, `urls` what curl gets.
function cacheWorld({ files = {}, urls = {}, listing = [], md5 = "0123456789abcdef0123456789abcdef", texts = {}, hold = false } = {}) {
  const w = { execs: [], unlinked: [], made: [], parts: new Map(), held: [], texts: { ...texts } };
  const answer = (code, stdout = "") => ({ code, stdout, stderr: code ? "failed" : "" });
  const sizeOf = (f) => `${f.mtime ?? "100"} ${f.size ?? 10} ${f.type ?? (f.dir ? "Directory" : "Regular File")}`;
  const sips = (f) => (f ? `x\n  format: ${f.format}\n  pixelWidth: ${f.width}\n  pixelHeight: ${f.height}\n` : "");
  w.io = {
    exec: async (cmd, args) => {
      w.execs.push([cmd, ...args]);
      if (hold) await new Promise((resolve) => w.held.push(resolve));
      if (cmd === "/usr/bin/stat") return Object.hasOwn(files, args.at(-1)) ? answer(0, `${sizeOf(files[args.at(-1)])}\n`) : answer(1);
      if (cmd === "/bin/cp") { w.parts.set(args[1], files[args[0]]); return answer(0); }
      if (cmd === "/usr/bin/curl") {
        const url = args.at(-1);
        if (!Object.hasOwn(urls, url)) return answer(22);
        w.parts.set(args[args.indexOf("-o") + 1], urls[url]);
        return answer(0);
      }
      if (cmd === "/usr/bin/sips") return answer(0, sips(w.parts.get(args.at(-1)) ?? listing.find((n) => args.at(-1).endsWith(n.name))?.file));
      if (cmd === "/sbin/md5") return answer(0, `${md5}\n`);
      if (cmd === "/bin/mv") { w.made.push(args.at(-1)); return answer(0); }
      return answer(0);
    },
    mkdir: async () => {},
    readdir: async () => listing.map((n) => n.name),
    readText: async (path) => {
      const f = w.parts.get(path);
      if (f?.svg) return f.svg;
      throw new Error("not text");
    },
    unlink: async (path) => { w.unlinked.push(path); },
  };
  w.cache = createImageCache(w.io, { appHome: APP });
  w.names = () => w.execs.map(([cmd]) => cmd);
  return w;
}

test("D3: a local image is copied under the cache, named by its path, mtime and size, and drawn from there", async () => {
  const src = { kind: "file", path: "/repo/docs/img/a.png", key: "file:/repo/docs/img/a.png" };
  const w = cacheWorld({ files: { [src.path]: { mtime: "1700", size: 42, format: "png", width: 640, height: 480 } } });
  const got = await w.cache.load(src);
  const name = `f${hashPath(`${src.path}\n1700\n42`)}.png`;
  assert.deepEqual(got, { ok: true, path: `${IMG_DIR}/${name}`, width: 640, height: 480 });
  assert.equal(IMG_DIR, "data/code-file/img", "D3: relative to the Herdr home, the only kind image() draws");
  assert.deepEqual(w.names(), ["/usr/bin/stat", "/bin/cp", "/usr/bin/sips", "/bin/mv"]);
  assert.deepEqual(w.execs[0], ["/usr/bin/stat", "-L", "-f", "%m %z %HT", src.path]);
  assert.equal(w.execs[1][1], src.path);
  assert.ok(w.execs[1][2].startsWith(`${CACHE}/`) && w.execs[1][2].endsWith(".part"), "copied to a part file first");
  assert.deepEqual(w.made, [`${CACHE}/${name}`]);
  // The same file again: only asked whether it changed.
  assert.deepEqual(await w.cache.load(src), got);
  assert.deepEqual(w.names().slice(4), ["/usr/bin/stat"]);
});

test("R1: only a regular file up to 10 MiB is copied: a device, a pipe, a folder or a huge file shows its alt and nothing is copied", async () => {
  const files = {
    "/dev/zero": { size: 0, type: "Character Device" },
    "/tmp/fifo": { size: 0, type: "Fifo File" },
    "/repo/img": { size: 96, dir: true },
    "/repo/huge.png": { size: MAX_IMAGE + 1, format: "png", width: 1, height: 1 },
    "/repo/max.png": { size: MAX_IMAGE, format: "png", width: 2, height: 2 },
  };
  const w = cacheWorld({ files });
  for (const path of ["/dev/zero", "/tmp/fifo", "/repo/img", "/repo/huge.png", "/missing.png"]) {
    assert.deepEqual(await w.cache.load({ kind: "file", path, key: `file:${path}` }), { ok: false }, path);
  }
  assert.deepEqual([...new Set(w.names())], ["/usr/bin/stat"], "only asked what each one is");
  const ok = await w.cache.load({ kind: "file", path: "/repo/max.png", key: "file:/repo/max.png" });
  assert.equal(ok.ok, true, "exactly 10 MiB still draws");
});

test("R7: what came back as an HTML page holding <svg> icons is dropped, not drawn as a blank SVG", async () => {
  const url = "https://github.com/o/r/blob/main/shot.png";
  const w = cacheWorld({ urls: { [url]: { format: "", width: 0, height: 0, svg: '<!DOCTYPE html><html><svg class="octicon" width="16" height="16"></svg></html>' } } });
  assert.deepEqual(await w.cache.load({ kind: "url", url, key: `url:${url}` }), { ok: false });
  assert.deepEqual(w.made, [], "nothing named as an image");
  assert.equal(w.unlinked.length, 1, "the part file goes");
});

test("D3: a changed file gets a new name, so the loader can't show the old one", async () => {
  const path = "/repo/a.png";
  const files = { [path]: { mtime: "1", size: 5, format: "png", width: 1, height: 1 } };
  const w = cacheWorld({ files });
  const before = await w.cache.load({ kind: "file", path, key: `file:${path}` });
  files[path] = { mtime: "2", size: 5, format: "png", width: 1, height: 1 };
  const after = await w.cache.load({ kind: "file", path, key: `file:${path}` });
  assert.notEqual(before.path, after.path);
});

test("D12: an SVG's size comes from the SVG itself", async () => {
  const path = "/repo/logo.svg";
  const w = cacheWorld({ files: { [path]: { format: "svg", width: 1, height: 1, svg: '<svg width="120" height="40"></svg>' } } });
  const got = await w.cache.load({ kind: "file", path, key: `file:${path}` });
  assert.equal(got.ok, true);
  assert.match(got.path, /\.svg$/);
  assert.deepEqual([got.width, got.height], [120, 40]);
});

test("D12: missing, a folder, or not an image: a failure, with no copy left behind", async () => {
  const w = cacheWorld({ files: { "/repo/dir": { dir: true }, "/repo/a.txt": { format: "txt", width: "<nil>", height: "<nil>" } } });
  assert.deepEqual(await w.cache.load({ kind: "file", path: "/repo/none.png", key: "file:/repo/none.png" }), { ok: false });
  assert.deepEqual(await w.cache.load({ kind: "file", path: "/repo/dir", key: "file:/repo/dir" }), { ok: false });
  assert.equal(w.names().includes("/bin/cp"), false);
  assert.deepEqual(await w.cache.load({ kind: "file", path: "/repo/a.txt", key: "file:/repo/a.txt" }), { ok: false });
  assert.equal(w.unlinked.length, 1, "the part file goes");
  assert.deepEqual(w.made, []);
});

test("D3, D12: a remote image is downloaded once by curl, named by its URL's hash and its bytes", async () => {
  const url = "https://img.shields.io/badge/ci-passing-green";
  const src = { kind: "url", url, key: `url:${url}` };
  const w = cacheWorld({ urls: { [url]: { format: "svg", width: 1, height: 1, svg: '<svg width="90" height="20">' } } });
  const got = await w.cache.load(src);
  const name = `u${hashPath(url)}-0123456789ab.svg`;
  assert.deepEqual(got, { ok: true, path: `${IMG_DIR}/${name}`, width: 90, height: 20 });
  const curl = w.execs.find(([cmd]) => cmd === "/usr/bin/curl");
  assert.deepEqual(curl.slice(1), curlArgs(url, curl[curl.indexOf("-o") + 1]));
  assert.ok(curl[curl.indexOf("-o") + 1].startsWith(`${CACHE}/`));
  assert.deepEqual(w.made, [`${CACHE}/${name}`]);
  await w.cache.load(src);
  assert.equal(w.names().filter((cmd) => cmd === "/usr/bin/curl").length, 1, "once per preview");
});

test("D12: a download that fails falls back to an earlier download of that URL, else fails", async () => {
  const url = "https://x.io/a.png";
  const old = `u${hashPath(url)}-aaaaaaaaaaaa.png`;
  const offline = cacheWorld({ listing: [{ name: old, file: { format: "png", width: 8, height: 4 } }] });
  assert.deepEqual(await offline.cache.load({ kind: "url", url, key: `url:${url}` }), { ok: true, path: `${IMG_DIR}/${old}`, width: 8, height: 4 });
  const never = cacheWorld();
  assert.deepEqual(await never.cache.load({ kind: "url", url, key: `url:${url}` }), { ok: false });
  assert.equal(never.unlinked.length, 1, "curl's partial file goes");
});

test("D12: at most four images load at once", async () => {
  const paths = [1, 2, 3, 4, 5, 6].map((n) => `/r/${n}.png`);
  const files = Object.fromEntries(paths.map((p) => [p, { format: "png", width: 1, height: 1 }]));
  const w = cacheWorld({ files, hold: true });
  let finished = 0;
  const loads = paths.map((path) => w.cache.load({ kind: "file", path, key: `file:${path}` }).then((r) => { finished++; return r; }));
  await flush();
  assert.equal(w.held.length, 4, "four at work, two waiting");
  for (let i = 0; i < 100 && finished < paths.length; i++) {
    for (const go of w.held.splice(0)) go();
    await flush();
  }
  assert.equal((await Promise.all(loads)).every((r) => r.ok), true);
});

// ── D8, L2: the Explorer's openFile, copied ──────────────────────────────────

test("D8: the copy shares the Explorer's keys and doc ids", () => {
  assert.equal(mine.DOCS_KEY, "code-editor.docs");
  assert.equal(mine.LIVE_KEY, "code-editor.live");
  assert.equal(mine.FILE_MOD, explorer.FILE_MOD);
  assert.match(mine.newDoc(), /^[a-z0-9]{8,}$/);
});

const tab = (id, over = {}) => ({ id, index: 1, active: false, panes: 1, ...over });
const pane = (id, tabId, mod = null) => ({ pane: id, tab: tabId, mod });
const entry = (doc, file, preview) => ({ doc, file, preview });
const FILE = "/repo/docs/guide.md";

test("D8: planOpen, findNewTab, closeCommand and nextDocs decide as the Explorer's", () => {
  const cases = [
    { file: FILE, pin: false, tabs: [], docs: {}, live: {}, panes: [] },
    { file: FILE, pin: false, tabs: [tab("t1"), tab("t2")], docs: { t2: entry("d2", FILE, true) }, live: {}, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: true, tabs: [tab("t2")], docs: { t2: entry("d2", FILE, true) }, live: {}, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: false, tabs: [tab("t2")], docs: { t2: entry("d2", "/old.md", true) }, live: {}, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: false, tabs: [tab("t2")], docs: { t2: entry("d2", "/old.md", true) }, live: { d2: { dirty: true } }, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: false, tabs: [tab("t2", { panes: 2 })], docs: { t2: entry("d2", "/old.md", true) }, live: {}, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: false, tabs: [tab("t2")], docs: { t2: entry("d2", FILE, true) }, live: {}, panes: [pane("p2", "t2")] },
    { file: FILE, pin: false, line: 3, tabs: [tab("t2")], docs: { t2: entry("d2", FILE, false) }, live: {}, panes: [pane("p2", "t2", "code-file")] },
    { file: FILE, pin: false, tabs: [tab("t2")], docs: "broken", live: null, panes: [pane("p2", "t2", "code-file")] },
  ];
  for (const c of cases) assert.deepEqual(mine.planOpen(c), explorer.planOpen(c), JSON.stringify(c));
  const space = { tabs: [tab("old"), tab("claude"), tab("new")] };
  const panes = [pane("p1", "claude"), pane("p2", "new", "code-file")];
  assert.equal(mine.findNewTab(new Set(["old"]), space, panes), explorer.findNewTab(new Set(["old"]), space, panes));
  assert.equal(mine.findNewTab(new Set(["old"]), space, panes), "new");
  for (const t of [tab("a"), tab("b", { panes: 2 }), tab("c", { panes: 2 })]) {
    const p = [pane("pb", "b", "code-file"), pane("pc", "c")];
    assert.deepEqual(mine.closeCommand(t, p), explorer.closeCommand(t, p));
  }
  const docs = { a: entry("da", "/a", true), gone: entry("dg", "/g", false), junk: 3 };
  assert.deepEqual(mine.nextDocs(docs, ["a", "n"], "n", entry("dn", FILE, true)), explorer.nextDocs(docs, ["a", "n"], "n", entry("dn", FILE, true)));
});

// The Explorer's own test double: a new tab shows up after a wait, as in Herdr.
function fakeHerdr({ tabs = [tab("t1", { index: 1, active: true })], docs, live, showAfter = 2, panes = [], throwOnNew = false } = {}) {
  const state = { tabs: tabs.map((t) => ({ ...t })), panes: [...panes], shared: { "code-editor.docs": docs, "code-editor.live": live }, calls: [], writes: [], toasts: [], waits: 0, pending: null };
  const reindex = () => state.tabs.forEach((t, i) => { t.index = i + 1; });
  const io = {
    spaces: () => [{ id: "s1", tabs: state.tabs.map((t) => ({ ...t })) }],
    panes: () => state.panes,
    shared: (key) => state.shared[key],
    setShared: (key, value) => { state.shared[key] = value; state.writes.push([key, value]); },
    notify: (n) => { state.toasts.push(n); },
    newDoc: () => "doc1",
    wait: async () => {
      state.waits++;
      if (state.pending && state.waits >= showAfter) {
        state.pending = null;
        const active = state.tabs.findIndex((t) => t.active);
        state.tabs.forEach((t) => { t.active = false; });
        state.tabs.splice(active + 1, 0, tab("new", { active: true }));
        state.panes.push(pane("p-new", "new", "code-file"));
        reindex();
      }
    },
    run: (name, args) => {
      state.calls.push([name, args]);
      if (name === "tab.new") {
        if (throwOnNew) throw new Error("refused");
        if (showAfter !== Infinity) state.pending = { args };
      }
      if (name === "tab.move") {
        const from = state.tabs.findIndex((t) => t.id === args.id);
        const [moved] = state.tabs.splice(from, 1);
        state.tabs.splice(args.index - 1, 0, moved);
        reindex();
      }
      if (name === "tab.close") { state.tabs = state.tabs.filter((t) => t.id !== args.id); reindex(); }
      return null;
    },
  };
  return { state, io };
}

test("D8: openFile does against Herdr what the Explorer's does: new, select, pin, replace, time out, refuse, no space", async () => {
  const scenarios = [
    ["new", {}, { file: FILE, space: "s1" }],
    ["pinned", {}, { file: FILE, pin: true, space: "s1" }],
    ["select", { tabs: [tab("t1", { active: true }), tab("t2", { index: 2 })], docs: { t2: entry("d2", FILE, true) }, panes: [pane("p2", "t2", "code-file")] }, { file: FILE, space: "s1" }],
    ["select and pin", { tabs: [tab("t2", { active: true })], docs: { t2: entry("d2", FILE, true) }, panes: [pane("p2", "t2", "code-file")] }, { file: FILE, pin: true, space: "s1" }],
    ["at a line, open", { tabs: [tab("t2", { active: true })], docs: { t2: entry("d2", FILE, false) }, live: { d2: { dirty: true } }, panes: [pane("p2", "t2", "code-file"), pane("p3", "t2")] }, { file: FILE, line: 4, space: "s1" }],
    ["replace", { tabs: [tab("t1"), tab("old", { index: 2, active: true })], docs: { old: entry("d0", "/repo/old.md", true) }, panes: [pane("p0", "old", "code-file")] }, { file: FILE, space: "s1" }],
    ["reopen at a line", { tabs: [tab("old", { active: true })], docs: { old: entry("d0", FILE, true) }, panes: [pane("p0", "old", "code-file")] }, { file: FILE, line: 9, space: "s1" }],
    ["dirty preview stays", { tabs: [tab("old", { active: true })], docs: { old: entry("d0", "/repo/old.md", true) }, live: { d0: { dirty: true } }, panes: [pane("p0", "old", "code-file")] }, { file: FILE, space: "s1" }],
    ["timeout", { showAfter: Infinity }, { file: FILE, space: "s1" }],
    ["refused", { throwOnNew: true }, { file: FILE, space: "s1" }],
    ["no space", {}, { file: FILE, space: "gone" }],
  ];
  for (const [name, world, args] of scenarios) {
    const a = fakeHerdr(world);
    const b = fakeHerdr(world);
    const ours = await mine.openFile(args, a.io);
    const theirs = await explorer.openFile(args, b.io);
    assert.deepEqual(ours, theirs, name);
    assert.deepEqual(a.state.calls, b.state.calls, name);
    assert.deepEqual(a.state.writes, b.state.writes, name);
    assert.deepEqual(a.state.toasts, b.state.toasts, name);
  }
  const { state, io } = fakeHerdr();
  await mine.openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(state.calls[0], ["tab.new", { name: "guide.md", space: "s1", mod: "code-file", props: { doc: "doc1", file: FILE } }], "a code-file tab, as a preview");
  assert.deepEqual(state.writes, [["code-editor.docs", { new: entry("doc1", FILE, true) }]]);
});

// ── MarkdownPreview in a fake Herdr ──────────────────────────────────────────

const FAKES = {
  herdr: ["appHome", "exec", "home", "notify", "panes", "run", "settings", "setShared", "shared", "spaces", "theme"]
    .map((n) => `export const ${n} = (...a) => globalThis.__md.${n}(...a);`).join("\n"),
  "fs/promises": ["mkdir", "readdir", "readFile", "unlink", "writeFile"].map((n) => `export const ${n} = (...a) => globalThis.__md.fs.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__md.el(n, ...a);
    export const div = k("div"), svg = k("svg"), image = k("image");
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__md.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex");
    export const Scrollbar = { vertical: (name) => globalThis.__md.el("Scrollbar", name) };
    export const TextView = { markdown: (id, text) => globalThis.__md.el("TextView", { id, text }) };`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake-md:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake-md:") ? { format: "module", source: FAKES[url.slice(8)], shortCircuit: true } : next(url, ctx)),
});

function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {} };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "children") t.kids.push(...args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") args[0](self);
        else if (k.startsWith("on_")) t.handlers[k.slice(3)] = args[0];
        return self;
      };
    },
  });
  return self;
}
const isEl = (e) => typeof e === "object" && e !== null && e.kids;
const all = (e, test, out = []) => {
  if (!isEl(e)) return out;
  if (test(e)) out.push(e);
  for (const k of e.kids) all(k, test, out);
  return out;
};
const find = (e, id) => all(e, (x) => x.calls.id?.[0] === id)[0] ?? null;
const kinds = (e, kind) => all(e, (x) => x.kind === kind);
const textOf = (e) => (typeof e === "string" ? e : isEl(e) ? e.kids.map(textOf).filter(Boolean).join(" ") : "");

const HOME = "/home/juan";
const DOC = `${HOME}/repo/docs/README.md`;

function previewWorld({ text = "", kinds: pathKinds = {}, files = {}, urls = {}, dark = true } = {}) {
  const w = {
    text, runs: [], toasts: [], execs: [], timers: [], notifies: 0, opened: [], clipboard: [], crashes: [],
    shared: new Map(), parts: new Map(),
    spaceList: [{ id: "s1", active: true, tabs: [tab("t1", { active: true })] }],
    paneList: [pane("p1", "t1", "code-file")],
  };
  const answer = (code, stdout = "") => ({ code, stdout, stderr: "" });
  const cx = {
    notify: () => { w.notifies++; },
    spawn: (f) => { Promise.resolve().then(() => f(cx)).catch((e) => { w.crashes.push(e); }); return { cancel() {} }; },
    timer: {
      after: (ms, f) => { const t = { ms, f, cancelled: false, cancel() { t.cancelled = true; } }; w.timers.push(t); return t; },
      every: (ms, f) => { const t = { ms, f, repeat: true, cancelled: false, cancel() { t.cancelled = true; } }; w.timers.push(t); return t; },
    },
    open_url: (url) => { w.opened.push(url); },
    write_to_clipboard: (text) => { w.clipboard.push(text); },
  };
  w.cx = cx;
  w.fire = async (ms) => {
    for (const t of w.timers.filter((x) => x.ms === ms && !x.cancelled && !x.fired)) {
      t.fired = true;
      t.f(cx);
    }
    await flush();
  };
  globalThis.__md = {
    el,
    theme: () => new Proxy({}, { get: (_t, k) => `#${String(k)}` }),
    settings: () => ({ font_family: "Mono", dark }),
    appHome: () => APP,
    home: () => HOME,
    spaces: () => w.spaceList,
    panes: () => w.paneList,
    shared: (k) => w.shared.get(k),
    setShared: (k, v) => { w.shared.set(k, v); },
    notify: (n) => { w.toasts.push(n); return "id"; },
    run: (name, args) => {
      w.runs.push([name, args]);
      if (name === "tab.new") {
        w.spaceList = [{ id: "s1", active: true, tabs: [tab("t1"), tab("t2", { active: true, index: 2 })] }];
        w.paneList = [...w.paneList, pane("p2", "t2", "code-file")];
      }
      return null;
    },
    exec: async (cmd, args = []) => {
      w.execs.push([cmd, ...args]);
      if (cmd === "/bin/sh") return answer(0, `${pathKinds[args.at(-1)] ?? "none"}\n`);
      if (cmd === "/usr/bin/stat") return Object.hasOwn(files, args.at(-1)) ? answer(0, "100 10 Regular File\n") : answer(1);
      if (cmd === "/bin/cp") { w.parts.set(args[1], files[args[0]]); return answer(0); }
      if (cmd === "/usr/bin/curl") {
        if (!Object.hasOwn(urls, args.at(-1))) return answer(22);
        w.parts.set(args[args.indexOf("-o") + 1], urls[args.at(-1)]);
        return answer(0);
      }
      if (cmd === "/usr/bin/sips") {
        const f = w.parts.get(args.at(-1));
        return answer(0, f ? `x\n  format: ${f.format}\n  pixelWidth: ${f.width}\n  pixelHeight: ${f.height}\n` : "");
      }
      if (cmd === "/sbin/md5") return answer(0, "feedfacefeedfacefeedfacefeedface\n");
      return answer(0);
    },
    fs: {
      mkdir: async () => {},
      readdir: async () => [],
      readFile: async (path) => { const f = w.parts.get(path); if (f?.svg) return f.svg; throw new Error("ENOENT"); },
      unlink: async () => {},
      writeFile: async () => {},
    },
  };
  return w;
}

const { MarkdownPreview } = await import("../code-editor/mods/code-file/preview-view.js");

async function preview(options = {}) {
  const w = previewWorld(options);
  const view = new MarkdownPreview({ file: DOC, doc: "d1", text: () => w.text, visible: () => true });
  w.view = view;
  w.draw = () => view.render(globalThis.__md.theme(), w.cx);
  w.click = async (id, handler = "click") => {
    const target = find(w.draw(), id);
    assert.ok(target, `no element ${id}`);
    assert.ok(target.handlers[handler], `${id} has no on_${handler}`);
    target.handlers[handler]({}, w.cx);
    await flush();
  };
  w.link = async (url) => {
    const run = kinds(w.draw(), "TextView")[0];
    run.handlers.link_click(url, w.cx);
    await flush();
  };
  return w;
}

test("S6: an empty file draws an empty preview and asks for nothing", async () => {
  const w = await preview({ text: "" });
  const root = w.draw();
  assert.ok(isEl(root));
  assert.deepEqual(kinds(root, "TextView"), []);
  assert.deepEqual(w.timers, []);
  assert.deepEqual(w.execs, []);
});

test("S6, D2: Orca's padding and line height, no max width, in a plain scroll area with its scrollbar", async () => {
  const w = await preview({ text: "# Title\n\nText." });
  const root = w.draw();
  const scroll = find(root, "md-preview");
  assert.ok(scroll.calls.overflow_y_scroll, "scrolls");
  assert.deepEqual(kinds(root, "Scrollbar").map((s) => s.arg), ["md-preview"]);
  const content = scroll.kids[0];
  assert.deepEqual([content.calls.pt[0], content.calls.pb[0], content.calls.px[0]], [24, 24, 32]);
  assert.equal(content.calls.line_height[0], 1.7);
  assert.equal(all(root, (e) => e.calls.max_w).length, 0, "no max width");
  assert.equal(kinds(root, "list").length, 0, "not a virtual list (D2)");
});

test("S1, D1: each run of Markdown is a selectable TextView with the run's text", async () => {
  const w = await preview({ text: "# Title\n\n```js\nx\n```\n\nAfter **this**." });
  const runs = kinds(w.draw(), "TextView");
  assert.deepEqual(runs.map((r) => r.arg.text), ["# Title", "After **this**."]);
  for (const r of runs) {
    assert.ok(r.calls.selectable, "selectable");
    assert.ok(r.handlers.link_click, "links are ours (D8)");
    assert.equal(r.calls.font_family?.[0], ".SystemUIFont", "Herdr's UI font has no bold or italic face");
  }
  assert.notEqual(runs[0].arg.id, runs[1].arg.id);
});

test("S6: GitHub's callouts get Orca's title, bold and on its own line, in any case; other quotes stay", () => {
  assert.equal(titleCallouts("> [!NOTE]\n> Works on macOS only."), "> **Note**\n>\n> Works on macOS only.");
  assert.equal(titleCallouts(">[!warning]\n>Careful"), ">**Warning**\n>\n>Careful");
  assert.equal(titleCallouts("> [!TIP] inline text"), "> [!TIP] inline text", "only a marker alone on its line");
  assert.equal(titleCallouts("> [!OTHER]"), "> [!OTHER]");
  assert.deepEqual(splitBlocks("> [!CAUTION]\n> Hot.\n\n```\n> [!NOTE]\n```"), [
    { kind: "markdown", text: "> **Caution**\n>\n> Hot." },
    { kind: "code", lang: "", text: "> [!NOTE]" },
  ]);
});

test("S6, D9: the preview draws the buffer: what the host's text says now", async () => {
  const w = await preview({ text: "# One" });
  assert.equal(kinds(w.draw(), "TextView")[0].arg.text, "# One");
  w.text = "# Two, unsaved";
  assert.equal(kinds(w.draw(), "TextView")[0].arg.text, "# Two, unsaved");
});

test("S6: front matter is a box labeled FRONT MATTER, the text in mono, at most 192 px and scrolling", async () => {
  const w = await preview({ text: "---\ntitle: Notes\nkey:\n  nested: 1\n---\n# Body" });
  const root = w.draw();
  const box = find(root, "front-matter");
  assert.ok(box, "the box");
  assert.equal(box.calls.border_1 !== undefined, true);
  const label = box.kids[0];
  assert.equal(textOf(label), "FRONT MATTER");
  assert.equal(PREVIEW_TEXT.frontMatter, "Front Matter");
  assert.equal(label.calls.text_size[0], 10);
  const body = find(root, "front-matter-text");
  assert.equal(body.calls.max_h[0], 192);
  assert.ok(body.calls.overflow_y_scroll);
  assert.equal(body.calls.font_family[0], "Mono");
  assert.deepEqual(body.kids.map(textOf), ["title: Notes", "key:", "  nested: 1"]);
  assert.deepEqual(kinds(root, "TextView").map((r) => r.arg.text), ["# Body"], "never a setext heading");
});

test("S6, D13: fenced code: radius 8, 14/18 padding, 1.55, 6% white, One Dark colors, the language chip in 11 px mono", async () => {
  const w = await preview({ text: "```js\nconst a = 1; // one\n\n```" });
  const root = w.draw();
  const block = find(root, "code-1");
  assert.equal(block.calls.rounded[0], 8);
  assert.equal(block.calls.bg[0], "#ffffff0f");
  assert.equal(block.calls.border_color[0], "#ffffff0f");
  const lines = find(root, "code-lines-1");
  assert.deepEqual([lines.calls.px[0], lines.calls.py[0], lines.calls.line_height[0]], [18, 14, 1.55]);
  assert.equal(lines.calls.font_family[0], "Mono");
  assert.ok(lines.calls.overflow_x_scroll, "a long line scrolls sideways");
  const keyword = all(lines, (e) => e.kids[0] === "const")[0];
  assert.equal(keyword.calls.text_color[0], SYNTAX.keyword);
  const comment = all(lines, (e) => e.kids[0] === "// one")[0];
  assert.equal(comment.calls.text_color[0], SYNTAX.comment);
  assert.ok(comment.calls.italic);
  const chip = find(root, "code-chip-1");
  assert.equal(textOf(chip), "js");
  assert.equal(chip.calls.text_size[0], 11);
  assert.equal(chip.calls.font_family[0], "Mono");
});

test("D13: a light theme gets Orca's light code background", async () => {
  const w = await preview({ text: "```\nx\n```", dark: false });
  assert.equal(find(w.draw(), "code-1").calls.bg[0], "#f6f8fa");
});

test("S6: no language, no chip", async () => {
  const w = await preview({ text: "```\nplain\n```" });
  assert.equal(find(w.draw(), "code-chip-1"), null);
});

for (const [how, act] of [
  ["its button", (w) => w.click("copy-code-1")],
  ["its command", async (w) => { assert.equal(w.view.command("copy-code", "1", w.cx), true); await flush(); }],
]) {
  test(`S6: Copy code by ${how}: the code to the clipboard, Check for 1500 ms, then Copy again`, async () => {
    const w = await preview({ text: "```sh\nls -la\necho hi\n```" });
    const button = find(w.draw(), "copy-code-1");
    assert.equal(button.calls.tooltip[0], "Copy code");
    assert.deepEqual(kinds(button, "svg").map((s) => s.arg), ["mods/code-file/ui/copy.svg"]);
    await act(w);
    assert.deepEqual(w.clipboard, ["ls -la\necho hi"]);
    const copied = find(w.draw(), "copy-code-1");
    assert.deepEqual(kinds(copied, "svg").map((s) => s.arg), ["mods/code-file/ui/check.svg"]);
    assert.match(textOf(copied), /Copied/);
    assert.ok(w.notifies > 0);
    assert.deepEqual(w.timers.filter((t) => !t.cancelled).map((t) => t.ms), [1500]);
    await w.fire(1500);
    assert.deepEqual(kinds(find(w.draw(), "copy-code-1"), "svg").map((s) => s.arg), ["mods/code-file/ui/copy.svg"]);
  });
}

test("S6: a second copy restarts the 1500 ms, and only the copied block shows Check", async () => {
  const w = await preview({ text: "```\na\n```\n\n```\nb\n```" });
  w.view.command("copy-code", "1", w.cx);
  w.view.command("copy-code", "2", w.cx);
  assert.deepEqual(w.clipboard, ["a", "b"]);
  assert.deepEqual(w.timers.map((t) => t.cancelled), [true, false]);
  assert.deepEqual(kinds(find(w.draw(), "copy-code-1"), "svg").map((s) => s.arg), ["mods/code-file/ui/copy.svg"]);
  assert.deepEqual(kinds(find(w.draw(), "copy-code-2"), "svg").map((s) => s.arg), ["mods/code-file/ui/check.svg"]);
  w.view.release();
  assert.equal(w.timers.every((t) => t.cancelled), true, "release cancels the timer");
});

test("D3, D12: a local image shows its alt while it loads, then draws from the cache at its natural size", async () => {
  const path = `${HOME}/repo/docs/img/shot.png`;
  const w = await preview({ text: "![A screenshot](img/shot.png)", files: { [path]: { format: "png", width: 300, height: 200 } } });
  const first = w.draw();
  assert.match(textOf(find(first, "image-0-0")), /A screenshot/);
  assert.deepEqual(kinds(first, "svg").map((s) => s.arg), ["mods/code-file/ui/image.svg"], "a placeholder");
  assert.deepEqual(kinds(first, "image"), []);
  assert.deepEqual(w.timers.map((t) => t.ms), [0], "render only schedules the load");
  assert.deepEqual(w.execs, []);
  await w.fire(0);
  assert.deepEqual(w.execs.map(([cmd]) => cmd), ["/usr/bin/stat", "/bin/cp", "/usr/bin/sips", "/bin/mv"]);
  const drawn = kinds(w.draw(), "image");
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].arg, `data/code-file/img/f${hashPath(`${path}\n100\n10`)}.png`);
  assert.deepEqual([drawn[0].calls.w[0], drawn[0].calls.h[0]], [300, 200]);
  w.draw();
  assert.equal(w.timers.filter((t) => !t.fired).length, 0, "nothing more to load");
});

test("D12: an image wider than the content shrinks to it, keeping its ratio", async () => {
  const path = `${HOME}/repo/docs/wide.png`;
  const w = await preview({ text: "![w](wide.png)", files: { [path]: { format: "png", width: 1000, height: 500 } } });
  w.draw();
  await w.fire(0);
  const frame = find(w.draw(), "md-frame");
  frame.handlers.size_change({ width: 464, height: 300 }, w.cx);
  const img = kinds(w.draw(), "image")[0];
  assert.deepEqual([img.calls.w[0], img.calls.h[0]], [400, 200], "464 less 32 on each side");
});

test("D12: a remote image downloads with curl; one that fails shows its alt in dim", async () => {
  const ok = "https://x.io/ok.png";
  const w = await preview({ text: `![ok](${ok}) ![broken](https://x.io/404.png)`, urls: { [ok]: { format: "png", width: 20, height: 10 } } });
  w.draw();
  await w.fire(0);
  const curls = w.execs.filter(([cmd]) => cmd === "/usr/bin/curl").map((c) => c.at(-1)).sort();
  assert.deepEqual(curls, ["https://x.io/404.png", ok]);
  const root = w.draw();
  assert.equal(kinds(root, "image").length, 1);
  const broken = find(root, "image-0-1");
  assert.equal(textOf(broken), "broken");
  assert.equal(all(broken, (e) => e.calls.text_color?.[0] === "#dim").length > 0, true);
});

test("D3: an edit re-checks local images; a file that didn't change keeps its copy", async () => {
  const path = `${HOME}/repo/docs/a.png`;
  const w = await preview({ text: "![a](a.png)", files: { [path]: { format: "png", width: 1, height: 1 } } });
  w.draw();
  await w.fire(0);
  w.text = "![a](a.png)\n\nmore";
  w.draw();
  await w.fire(0);
  assert.deepEqual(w.execs.map(([cmd]) => cmd), ["/usr/bin/stat", "/bin/cp", "/usr/bin/sips", "/bin/mv", "/usr/bin/stat"]);
  assert.equal(kinds(w.draw(), "image").length, 1, "drawn all along");
});

test("R8: shown again, the preview asks its local images again and retries the URLs that failed", async () => {
  const path = `${HOME}/repo/docs/a.png`;
  const late = "https://x.io/late.png";
  const urls = {};
  const w = await preview({ text: `![a](a.png) ![late](${late})`, files: { [path]: { format: "png", width: 1, height: 1 } }, urls });
  w.draw();
  await w.fire(0);
  assert.equal(kinds(w.draw(), "image").length, 1, "the URL failed: offline");
  urls[late] = { format: "png", width: 4, height: 2 };
  w.draw();
  await w.fire(0);
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/curl").length, 1, "not retried on every frame");
  w.view.refresh();
  w.draw();
  await w.fire(0);
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/stat").length, 2, "the local file asked again");
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/curl").length, 2, "the failed URL tried again");
  assert.equal(kinds(w.draw(), "image").length, 2);
});

test("R8: the cache keeps no failure: the next load of a URL that failed tries again", async () => {
  const url = "https://x.io/b.png";
  const urls = {};
  const w = cacheWorld({ urls });
  assert.deepEqual(await w.cache.load({ kind: "url", url, key: `url:${url}` }), { ok: false });
  urls[url] = { format: "png", width: 3, height: 3 };
  assert.equal((await w.cache.load({ kind: "url", url, key: `url:${url}` })).ok, true);
});

test("D8: a linked badge opens its link by its click", async () => {
  const w = await preview({ text: "[![CI](https://x.io/ci.svg)](https://x.io/actions)" });
  await w.click("image-0-0");
  assert.deepEqual(w.opened, ["https://x.io/actions"]);
});

test("D8: links: http(s) to the browser, mailto to /usr/bin/open, an anchor nowhere", async () => {
  const w = await preview({ text: "[a](https://x.io)" });
  await w.link("https://x.io/page");
  assert.deepEqual(w.opened, ["https://x.io/page"]);
  await w.link("mailto:a@b.io");
  assert.deepEqual(w.execs, [["/usr/bin/open", "mailto:a@b.io"]]);
  await w.link("#install");
  assert.deepEqual(w.opened, ["https://x.io/page"]);
  assert.equal(w.execs.length, 1);
  assert.deepEqual(w.toasts, []);
});

for (const [how, go] of [
  ["a click", (w, url) => w.link(url)],
  ["the link command", async (w, url) => { assert.equal(w.view.command("link", url, w.cx), true); await flush(); }],
]) {
  test(`S6, D8: by ${how}, a missing path or a folder is a toast; a file opens as the Explorer opens one`, async () => {
    const guide = `${HOME}/repo/docs/guide.md`;
    const w = await preview({ text: "x", kinds: { [guide]: "file", [`${HOME}/repo/src`]: "dir" } });
    await go(w, "missing.md");
    assert.deepEqual(w.toasts, [{ title: "File not found: ~/repo/docs/missing.md", level: "error" }]);
    await go(w, "../src/");
    assert.deepEqual(w.toasts[1], { title: "Cannot open directory: ~/repo/src", level: "error" });
    assert.deepEqual(w.runs, []);
    await go(w, "./guide.md#setup");
    await w.fire(10); // openFile's poll for the new tab
    const opened = w.runs.find(([name]) => name === "tab.new");
    assert.deepEqual(opened?.[1].props.file, guide);
    assert.equal(opened[1].mod, "code-file");
    assert.equal(opened[1].space, "s1", "in the active space");
    const docs = w.shared.get("code-editor.docs");
    assert.deepEqual(docs.t2, { doc: opened[1].props.doc, file: guide, preview: true });
    const probe = w.execs.find(([cmd]) => cmd === "/bin/sh");
    assert.equal(probe.at(-1), `${HOME}/repo/docs/missing.md`);
  });
}

test("D8: a file already open is selected, not opened again", async () => {
  const guide = `${HOME}/repo/docs/guide.md`;
  const w = await preview({ text: "x", kinds: { [guide]: "file" } });
  w.spaceList = [{ id: "s1", active: true, tabs: [tab("t1", { active: true }), tab("t9", { index: 2 })] }];
  w.paneList = [pane("p1", "t1", "code-file"), pane("p9", "t9", "code-file")];
  w.shared.set("code-editor.docs", { t9: entry("d9", guide, false) });
  await w.link("guide.md");
  assert.deepEqual(w.runs, [["tab.select", { id: "t9" }]]);
});

test("D7: commands that aren't the preview's go back to code-file", async () => {
  const w = await preview({ text: "x" });
  for (const name of ["zoom-in", "find", "source", "preview", "save"]) assert.equal(w.view.command(name, "", w.cx), false, name);
});

test("D2: nothing the preview draws throws, links and buttons included", async () => {
  const w = await preview({ text: "---\na: 1\n---\n# T\n\n```js\nx\n```\n\n![i](https://x.io/i.png)\n\n[l](b.md)" });
  w.draw();
  await w.fire(0);
  w.draw();
  assert.deepEqual(w.crashes, []);
});
