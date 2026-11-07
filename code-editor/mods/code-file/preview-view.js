// The Markdown preview (plan lector-md T2): what code-file's body shows in mode
// `preview`. Interface fixed by T1: new MarkdownPreview(host), render(t, cx),
// command(name, arg, cx) → whether it was this reader's, release().
// host: { file, doc, text(), visible() } — text() is the buffer, unsaved edits included.
//
// markdown-model.js splits the text (D1): every run of plain Markdown is one
// TextView, and what TextView can't draw is drawn here: the front matter box, fenced
// code in One Dark with its chip and Copy code (S6, D13), and paragraphs of images
// from the cache (D3, D12). A plain scroll area, not a virtual list, whose rows
// would lose their handlers (D2). Every click also has a command, `link:<url>` and
// `copy-code:<n>`, since real clicks can't be posted in the live cases.

import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, TextView } from "gpui-base";
import { appHome, exec, home, notify, panes, run, settings, setShared, shared, spaces } from "herdr";
import * as fs from "fs/promises";
import {
  PATH_PROBE, PREVIEW_TEXT, cannotOpenDir, highlight, imageSource, linkTarget, notFound, pathKind, shownPath, splitBlocks,
} from "./markdown-model.js";
import { createImageCache, fitWidth } from "./image-cache.js";
import { newDoc, openFile } from "./open-model.js";
import { splitLines } from "./line-view-model.js";

const SCROLL = "md-preview";
const UI = "mods/code-file/ui";
const PAD_X = 32; // Orca's 24px 32px
const PAD_Y = 24;
const BLOCK_GAP = 14; // a paragraph's 1em at 14 px
// Herdr's UI font has no bold or italic face: TextView drew **bold** and *italic* as
// plain text (shot in the isolated Herdr). The system's font, Orca's -apple-system, has both.
export const PROSE_FONT = ".SystemUIFont";
const COPIED_FOR = 1500;
// S6's fixed alphas (D13): 6% white on a dark theme; Orca's GitHub light otherwise.
const CODE = Object.freeze({ dark: { bg: "#ffffff0f", border: "#ffffff0f" }, light: { bg: "#f6f8fa", border: "#00000014" } });

const baseName = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);

export class MarkdownPreview {
  constructor(host) {
    this.host = host;
    this.textFor = null;
    this.blocks = [];
    this.gen = 0; // one per split: local images are asked again after an edit
    this.width = 0; // the frame's, in logical px; 0 until the first layout
    this.images = new Map(); // source key → { status: loading | ready | failed, path, width, height, gen, asking }
    this.wanted = new Map(); // source key → source, for the next load
    this.loadTimer = null;
    this.copied = 0; // the code block showing Check, from 1
    this.copyTimer = null;
    this.opening = Promise.resolve(); // one open at a time, in click order
    this.cache = null; // made on the first image
    this.released = false;
  }

  // ── The text ───────────────────────────────────────────────────────────────

  // Derived from the buffer, split again only when it changed.
  sync() {
    const raw = this.host.text();
    const text = typeof raw === "string" ? raw : "";
    if (text === this.textFor) return;
    this.textFor = text;
    this.gen++;
    let n = 0;
    this.blocks = splitBlocks(text).map((block) => {
      if (block.kind === "code") return { ...block, n: ++n, lines: highlight(block.text, block.lang) };
      if (block.kind === "images") return { ...block, images: block.images.map((img) => ({ ...img, source: imageSource(img.src, this.host.file) })) };
      return block;
    });
  }

  // ── Images (D3, D12) ───────────────────────────────────────────────────────

  cacheOf() {
    this.cache ??= createImageCache({
      exec,
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }),
      readdir: (dir) => fs.readdir(dir),
      readText: (path) => fs.readFile(path, "utf8"),
      unlink: (path) => fs.unlink(path),
    }, { appHome: appHome() });
    return this.cache;
  }

  // From render: only notes what's missing and leaves the work to a timer.
  askImages(cx) {
    for (const block of this.blocks) {
      if (block.kind !== "images") continue;
      for (const { source } of block.images) {
        if (!source) continue;
        const state = this.images.get(source.key);
        if (!state || (source.kind === "file" && state.gen !== this.gen && !state.asking)) this.wanted.set(source.key, source);
      }
    }
    if (this.wanted.size === 0 || this.loadTimer || this.released) return;
    this.loadTimer = cx.timer.after(0, (cx) => {
      this.loadTimer = null;
      this.loadWanted(cx);
    });
  }

  // An image already drawn stays while it's asked again.
  loadWanted(cx) {
    if (this.released) return;
    const cache = this.cacheOf();
    const gen = this.gen;
    for (const [key, source] of this.wanted) {
      this.images.set(key, { ...(this.images.get(key) ?? { status: "loading" }), gen, asking: true });
      cx.spawn(async (cx) => {
        const got = await cache.load(source);
        if (this.released) return;
        this.images.set(key, got.ok ? { status: "ready", path: got.path, width: got.width, height: got.height, gen } : { status: "failed", gen });
        cx.notify();
      });
    }
    this.wanted.clear();
  }

  // R8: shown again (the tab back in view, or Source → Preview): local images are
  // asked again, so a regenerated file shows (its new mtime is a new key), and the
  // URLs that failed are tried again. Nothing watches the image files themselves.
  refresh() {
    this.gen++;
    for (const [key, state] of this.images) if (state.status === "failed" && !state.asking) this.images.delete(key);
  }

  hasImages() {
    return this.blocks.some((b) => b.kind === "images");
  }

  resize(size, cx) {
    const width = Math.round(size?.width ?? 0);
    if (width === this.width) return;
    this.width = width;
    if (this.hasImages()) cx.notify();
  }

  contentWidth() {
    return this.width > 0 ? Math.max(1, this.width - 2 * PAD_X) : Infinity;
  }

  // ── Links (D8) ─────────────────────────────────────────────────────────────

  openLink(url, cx) {
    const target = linkTarget(url, this.host.file);
    if (target.kind === "web") {
      // It refuses a URL without a host; that's the link's problem, not the preview's.
      try {
        cx.open_url(target.url);
      } catch (e) {
        console.log(`code-file: open ${target.url}: ${e}`);
      }
      return;
    }
    if (target.kind === "mail") {
      cx.spawn(async () => {
        try {
          await exec("/usr/bin/open", [target.url]);
        } catch (e) {
          console.log(`code-file: open ${target.url}: ${e}`);
        }
      });
      return;
    }
    if (target.kind !== "path") return; // an anchor: no way to scroll to it (D2)
    cx.spawn(async (cx) => {
      const kind = await this.kindOf(target.path);
      const shown = shownPath(target.path, home());
      if (kind === "none") notify({ title: notFound(shown), level: "error" });
      else if (kind === "dir") notify({ title: cannotOpenDir(shown), level: "error" });
      else await this.open(target.path, cx);
    });
  }

  async kindOf(path) {
    try {
      return pathKind((await exec("/bin/sh", ["-c", PATH_PROBE, "sh", path])).stdout);
    } catch {
      return "none";
    }
  }

  // As the Explorer: one at a time, so a second click finds the tab the first made.
  async open(file, cx) {
    const turn = this.opening;
    let done;
    this.opening = new Promise((resolve) => { done = resolve; });
    await turn;
    try {
      const space = spaces().find((s) => s.active)?.id;
      await openFile({ file, space }, {
        spaces, panes, shared, setShared, run, notify, newDoc,
        wait: (ms) => new Promise((resolve) => { cx.timer.after(ms, () => resolve()); }),
      });
    } catch (e) {
      console.log(`code-file: open ${file}: ${e}`);
    } finally {
      done();
    }
  }

  // ── Copy code ──────────────────────────────────────────────────────────────

  copy(n, cx) {
    const block = this.blocks.find((b) => b.kind === "code" && b.n === n);
    if (!block) return;
    cx.write_to_clipboard(block.text);
    this.copied = n;
    this.copyTimer?.cancel();
    this.copyTimer = cx.timer.after(COPIED_FOR, (cx) => {
      this.copyTimer = null;
      this.copied = 0;
      cx.notify();
    });
    cx.notify();
  }

  // ── The reader's interface ─────────────────────────────────────────────────

  command(name, arg, cx) {
    if (name === "link") {
      if (arg) this.openLink(arg, cx);
      return true;
    }
    if (name === "copy-code") {
      this.sync();
      this.copy(Number(arg || 1), cx);
      return true;
    }
    return false;
  }

  release() {
    this.released = true;
    this.copyTimer?.cancel();
    this.copyTimer = null;
    this.loadTimer?.cancel();
    this.loadTimer = null;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  frontMatter(block, t, mono) {
    return v_flex().id("front-matter").w_full().px(12).py(8).rounded(4).border_1().border_color(t.border).bg(t.surface)
      .child(div().mb(4).text_size(10).font_medium().text_color(t.muted).child(PREVIEW_TEXT.frontMatter.toUpperCase()))
      .child(v_flex().id("front-matter-text").w_full().max_h(192).overflow_y_scroll().text_size(12).line_height(1.5).text_color(t.muted)
        .when(Boolean(mono), (el) => el.font_family(mono))
        .children(splitLines(block.text).map((line) => div().child(line || " "))));
  }

  codeLine(tokens) {
    if (tokens.length === 0) return div().child(" ");
    return h_flex().whitespace_nowrap().children(tokens.map((token) => div().flex_none()
      .when(Boolean(token.color), (el) => el.text_color(token.color))
      .when(token.italic, (el) => el.italic())
      .child(token.text)));
  }

  codeBlock(block, t, mono, look) {
    const n = block.n;
    const copied = this.copied === n;
    const chip = div().id(`code-chip-${n}`).px(4).py(1).rounded(4).border_1().border_color(t.border).bg(t.background).text_color(t.muted).text_size(11)
      .when(Boolean(mono), (el) => el.font_family(mono))
      .child(block.lang);
    const copy = h_flex().id(`copy-code-${n}`).p(4).gap(3).items_center().rounded(4).cursor_pointer().tooltip(PREVIEW_TEXT.copy)
      .text_color(copied ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => this.copy(n, cx))
      .child(svg(`${UI}/${copied ? "check" : "copy"}.svg`).size(14))
      .when(copied, (el) => el.child(div().text_size(11).child(PREVIEW_TEXT.copied)));
    return div().id(`code-${n}`).relative().w_full().rounded(8).border_1().border_color(look.border).bg(look.bg)
      .child(v_flex().id(`code-lines-${n}`).w_full().overflow_x_scroll().px(18).py(14).text_size(13).line_height(1.55)
        .when(Boolean(mono), (el) => el.font_family(mono))
        .children(block.lines.map((tokens) => this.codeLine(tokens))))
      .child(h_flex().absolute().top(6).right(6).gap(4).items_center()
        .when(Boolean(block.lang), (el) => el.child(chip))
        .child(copy));
  }

  picture(img, id, t) {
    const state = img.source ? this.images.get(img.source.key) : { status: "failed" };
    const label = img.alt || baseName(img.src);
    let shown;
    if (state?.status === "ready") {
      const size = fitWidth(state, this.contentWidth());
      shown = image(state.path).w(size.width).h(size.height).flex_none().rounded(6);
    } else if (state?.status === "failed") {
      shown = div().text_color(t.dim).child(label);
    } else {
      shown = h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
        .child(svg(`${UI}/image.svg`).size(14))
        .when(Boolean(label), (el) => el.child(label));
    }
    return div().id(id).flex_none()
      .when(Boolean(img.href), (el) => el.cursor_pointer().on_click((_event, cx) => this.openLink(img.href, cx)))
      .when(Boolean(img.title), (el) => el.tooltip(img.title))
      .child(shown);
  }

  block(block, i, t, mono, look) {
    switch (block.kind) {
      case "frontmatter":
        return this.frontMatter(block, t, mono);
      case "code":
        return this.codeBlock(block, t, mono, look);
      case "images":
        return h_flex().id(`images-${i}`).w_full().flex_wrap().gap(4).items_center()
          .children(block.images.map((img, k) => this.picture(img, `image-${i}-${k}`, t)));
      default:
        return TextView.markdown(`md-${i}`, block.text).selectable().w_full().font_family(PROSE_FONT)
          .on_link_click((url, cx) => this.openLink(url, cx));
    }
  }

  render(t, cx) {
    this.sync();
    this.askImages(cx);
    const s = settings() ?? {};
    const mono = typeof s.font_family === "string" ? s.font_family : null;
    const look = s.dark === false ? CODE.light : CODE.dark;
    const content = v_flex().w_full().pt(PAD_Y).pb(PAD_Y).px(PAD_X).gap(BLOCK_GAP).text_size(14).line_height(1.7)
      .children(this.blocks.map((block, i) => this.block(block, i, t, mono, look)));
    return div().id("md-frame").relative().flex_1().min_h(0).size_full()
      .on_size_change((size, cx) => this.resize(size, cx))
      .child(div().id(SCROLL).size_full().overflow_y_scroll().child(content))
      .child(Scrollbar.vertical(SCROLL).absolute().inset_0());
  }
}
