// The PDF reader (plan lector-md T3: S2, S7, S8, S9; D3–D7, D10, D13): what
// code-file's body shows for a `.pdf`. Interface fixed by T1: new PdfViewer(host, cx),
// render(t, cx), command(name, arg, cx) → whether it was this reader's, release().
// host: { file, doc, text(), visible() } — text() is unused here: a PDF has no text model.
//
// PDFKit does the PDF, through pdfpages.swift (D4): `info` gives the page sizes,
// `render` writes PNGs under <appHome>/data/code-file/pdf/<key>/<tag>/ (D3), `find`
// gives match rects. The pages are a virtual list of strips with known heights (D5),
// rendered lazily by a timer from the range the list last drew (D6). The arithmetic
// is pdf-model.js's.

import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Input, InputState, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, home, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { batchNamesFile, holdsHome } from "./document-model.js";
import { READER_TEXT } from "./reader-model.js";
import {
  PAGE_GAP, PDF_TEXT, anchorOf, binDir, binName, cacheRoot, canZoomIn, canZoomOut, contentKey, currentPage,
  firstMatchFrom, fitZoom, helperSource, matchLabel, matchRow, matchesByPage, pageDir, pageImage, pageLayout,
  pagesToRender, parseInfo, parseMatches, parseRendered, renderScale, rowOfAnchor, staleKeys, stepMatch, stepZoom,
  stripRects, zoomLabel,
} from "./pdf-model.js";

const LIST = "pdf-pages";
const RENDER_TICK = 100; // how often the list's last range is checked for missing pages (D6)
const FIND_DELAY = 250; // after the last keystroke in the find field
const FOCUS_DELAY = 50; // the frame that draws what takes the keyboard goes first
const POLL = 10000; // when watchFolder rejects or would take the whole home, as main.js
const DENSITY = 2; // Retina (D6)

// D13: pages are white whatever the theme; matches in pdf.js's colors (what Orca
// shows), the current one distinct.
const PAGE_BG = "#ffffff";
const MATCH_BG = "#b400aa40";
const CURRENT_BG = "#00640040";

const ui = (name) => `mods/code-file/ui/${name}.svg`;
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const message = (e) => String(e?.message ?? e);

// ── The helper (D4) ──────────────────────────────────────────────────────────

// One compile per build at a time, whichever copy asks first.
const compiling = new Map();

// swiftc missing (no Command Line Tools) is the person's to fix; say how.
const swiftError = (detail) => Object.assign(new Error(`swiftc: ${detail}`), { swift: true });

async function isBuilt(bin) {
  const cut = bin.lastIndexOf("/");
  const names = await fs.readdir(bin.slice(0, cut)).catch(() => []);
  return names.includes(bin.slice(cut + 1));
}

// The build of the shipped source, compiled the first time it's asked for. Its name
// is the source's hash, so an updated pdfpages.swift gets built again.
async function helperPath() {
  const root = appHome();
  const source = helperSource(root);
  const dir = binDir(root);
  const name = binName(await fs.readFile(source, "utf8"));
  const bin = `${dir}/${name}`;
  const names = await fs.readdir(dir).catch(() => []);
  if (names.includes(name)) return bin;
  if (!compiling.has(bin)) compiling.set(bin, compile(source, dir, bin, names).finally(() => compiling.delete(bin)));
  return compiling.get(bin);
}

// Under a temporary name and then moved, so a build cut short is never run.
async function compile(source, dir, bin, names) {
  await fs.mkdir(dir, { recursive: true });
  const temp = `${bin}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let r;
  try {
    r = await exec("/usr/bin/swiftc", ["-O", source, "-o", temp]);
  } catch (e) {
    throw swiftError(message(e));
  }
  if (r.code !== 0) {
    if (/xcrun|developer/i.test(r.stderr)) throw swiftError(r.stderr);
    throw new Error(`swiftc: ${r.stderr}`);
  }
  const moved = await exec("/bin/mv", ["-f", temp, bin]);
  if (moved.code !== 0) throw new Error(`mv: ${moved.stderr}`);
  // Builds of older sources, and temporaries a crash left, are never run again.
  for (const n of names) {
    if (n.startsWith("pdfpages-") && `${dir}/${n}` !== bin) await fs.unlink(`${dir}/${n}`).catch(() => {});
  }
  return bin;
}

// watchFolder hands out resolved paths (/private/tmp/...): the folder's, as `pwd -P` sees it.
async function realDirOf(dir) {
  try {
    const r = await exec("/bin/pwd", ["-P"], { cwd: dir });
    const real = r.code === 0 ? r.stdout.trim() : "";
    return real || dir;
  } catch {
    return dir;
  }
}

export class PdfViewer {
  constructor(host, cx) {
    this.host = host;
    this.file = host.file;
    this.name = baseName(host.file);
    this.status = "loading"; // "ready", "failed" or "locked" (S9)
    this.detail = null; // what to do about a failure, when there's something
    this.key = null; // contentKey of what's shown (D3)
    this.triedKey = null; // of the last info asked, failed or not
    this.sizes = null; // per page, points
    this.width = null; // the pane's, logical px (D5)
    this.fit = true; // S7: fit to width until a zoom step
    this.zoomValue = 1;
    this.memo = null;
    this.range = null; // the rows the list drew last (D6)
    this.place = null; // the reading place across scale changes before a frame
    this.goal = null; // a page to go to once the list can
    this.tried = new Map(); // render tag → pages asked at it (done or failed)
    this.latest = new Map(); // page → the tag of its last render that landed
    this.rendering = false;
    this.loading = false;
    this.loadAgain = false;
    this.released = false;
    this.finder = { open: false, searched: null, matches: [], byPage: new Map(), capped: false, current: -1, seq: 0 };
    this.bin = null;
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: PDF_TEXT.findPlaceholder });
    this.input.on("change", (_event, cx) => this.typed(cx));
    this.input.on("submit", (event, cx) => this.submit(event, cx));
    this.watch(cx);
    this.reload(cx);
  }

  // ── Loading and the disk (D4, D10) ─────────────────────────────────────────

  async helper(args) {
    this.bin ??= await helperPath();
    try {
      return await exec(this.bin, args);
    } catch (e) {
      // The build went away (its folder was cleared): built again, once.
      if (await isBuilt(this.bin)) throw e;
      this.bin = await helperPath();
      return exec(this.bin, args);
    }
  }

  async statKey() {
    try {
      const r = await exec("/usr/bin/stat", ["-f", "%m %z", this.file]);
      return r.code === 0 ? contentKey(this.file, r.stdout) : null;
    } catch {
      return null;
    }
  }

  // One load at a time; what's asked meanwhile runs once more behind it.
  reload(cx) {
    if (this.released) return;
    if (this.loading) {
      this.loadAgain = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.loadAgain = false;
          await this.loadOnce(cx);
        } while (this.loadAgain && !this.released);
      } finally {
        this.loading = false;
      }
    });
  }

  // Same path, mtime and size: the same pages, nothing to ask.
  async loadOnce(cx) {
    const key = await this.statKey();
    if (this.released) return;
    if (!key) {
      // Gone, or mid-replace: pages on screen stay until it's back.
      this.triedKey = null;
      if (this.status !== "ready") this.fail("failed", null, cx);
      return;
    }
    if (key === this.triedKey) return;
    this.triedKey = key;
    let answer;
    try {
      answer = await this.helper(["info", this.file]);
    } catch (e) {
      this.triedKey = null;
      if (!this.released) this.fail("failed", e, cx);
      return;
    }
    if (this.released) return;
    const info = parseInfo(answer.stdout);
    if (info.error) {
      if (info.error !== "locked") console.log(`code-file: pdf ${this.file}: ${answer.stderr || answer.stdout}`);
      this.fail(info.error, null, cx);
      return;
    }
    this.show(key, info.sizes, cx);
  }

  fail(status, error, cx) {
    if (error) console.log(`code-file: pdf ${this.file}: ${message(error)}`);
    this.status = status;
    this.detail = error?.swift ? PDF_TEXT.noSwift : null;
    cx.notify();
  }

  // New pages, the same place: the page being read stays (D10).
  show(key, sizes, cx) {
    const layout = this.layout();
    const keep = layout && this.range ? currentPage(layout, this.range) : this.goal;
    this.key = key;
    this.sizes = sizes;
    this.status = "ready";
    this.detail = null;
    this.memo = null;
    this.range = null;
    this.place = null;
    this.goal = keep ?? null;
    this.tried = new Map();
    this.latest = new Map();
    this.ticker ??= cx.timer.every(RENDER_TICK, (cx) => this.tick(cx));
    this.forget();
    if (this.finder.open && this.input.value().trim() !== "") this.runSearch(cx);
    this.prune(key, cx);
    cx.notify();
  }

  // The file's older renders go: their names can't come back (D3).
  prune(key, cx) {
    cx.spawn(async () => {
      const root = cacheRoot(appHome());
      let names;
      try {
        names = await fs.readdir(root);
      } catch {
        return;
      }
      for (const stale of staleKeys(names, key)) await exec("/bin/rm", ["-rf", `${root}/${stale}`]).catch(() => {});
    });
  }

  // main.js's rules: the folder is watched unless it holds the home, then polled.
  watch(cx) {
    const cut = this.file.lastIndexOf("/");
    const dir = cut > 0 ? this.file.slice(0, cut) : "/";
    const name = this.file.slice(cut + 1);
    cx.spawn(async (cx) => {
      const realDir = await realDirOf(dir);
      if (this.released) return;
      if (holdsHome(dir, home()) || holdsHome(realDir, home())) {
        this.poll(cx);
        return;
      }
      for (;;) {
        let batch;
        try {
          batch = await watchFolder(dir);
        } catch {
          if (!this.released) this.poll(cx);
          return;
        }
        if (this.released) return;
        if (batchNamesFile(batch, { dir, realDir, name })) this.reload(cx);
      }
    });
  }

  poll(cx) {
    this.poller = cx.timer.every(POLL, (cx) => this.reload(cx));
  }

  // ── Scale and place (S7, D5) ───────────────────────────────────────────────

  zoom() {
    return this.fit ? fitZoom(this.width, this.sizes) : this.zoomValue;
  }

  // Null until there are pages and a width to lay them out in.
  layout() {
    if (this.status !== "ready" || !(this.width > 0)) return null;
    const zoom = this.zoom();
    if (!this.memo || this.memo.sizes !== this.sizes || this.memo.zoom !== zoom) {
      this.memo = { sizes: this.sizes, zoom, layout: pageLayout(this.sizes, zoom) };
    }
    return this.memo.layout;
  }

  // The list keeps its pixel offset, which at another scale is another page: the
  // place is taken before the change and gone back to after it.
  rescale(change, cx) {
    const before = this.layout();
    const place = (before && anchorOf(before, this.range)) ?? this.place;
    change();
    const after = this.layout();
    if (after && after !== before) {
      this.range = null;
      this.place = place;
      if (place) this.jump(rowOfAnchor(after, place), "top", cx);
    }
    cx.notify();
  }

  resize(size, cx) {
    const width = size?.width;
    if (!(width > 0) || width === this.width) return;
    this.rescale(() => {
      this.width = width;
    }, cx);
  }

  zoomBy(direction, cx) {
    const layout = this.layout();
    if (!layout) return;
    const next = stepZoom(layout.zoom, direction);
    if (next === layout.zoom) return;
    this.rescale(() => {
      this.fit = false;
      this.zoomValue = next;
    }, cx);
  }

  fitWidth(cx) {
    if (!this.layout() || this.fit) return;
    this.rescale(() => {
      this.fit = true;
    }, cx);
  }

  // Once now and once after the frame that lays the list out with its new rows.
  jump(row, how, cx) {
    if (this.released) return;
    this.scroll.scroll_to_item(row, how);
    this.jumpTimer?.cancel();
    this.jumpTimer = cx.timer.after(FOCUS_DELAY, () => {
      if (!this.released) this.scroll.scroll_to_item(row, how);
    });
  }

  goToPage(arg, cx) {
    const n = Number.parseInt(String(arg), 10);
    if (!Number.isInteger(n)) return;
    this.goal = Math.max(1, n) - 1;
    this.applyGoal(cx);
  }

  applyGoal(cx) {
    const layout = this.layout();
    if (this.goal === null || !layout) return;
    const page = Math.min(this.goal, layout.pages.length - 1);
    this.goal = null;
    this.jump(layout.pages[page].firstRow, "top", cx);
  }

  // ── Lazy pages (D6) ────────────────────────────────────────────────────────

  // The list's last range against what's on disk: what's missing, in one exec.
  tick(cx) {
    if (this.released || this.status !== "ready") return;
    const layout = this.layout();
    if (!layout) return;
    this.applyGoal(cx);
    if (this.rendering) return;
    const { scale, tag } = renderScale(layout.scale, this.sizes, DENSITY);
    if (!this.tried.has(tag)) this.tried.set(tag, new Set());
    const tried = this.tried.get(tag);
    const want = pagesToRender(layout, this.range, tried);
    if (want.length === 0) return;
    // A page that fails isn't asked again at this scale: a zoom tries again.
    for (const page of want) tried.add(page);
    this.rendering = true;
    const key = this.key;
    const count = this.sizes.length;
    cx.spawn(async (cx) => {
      try {
        const answer = await this.helper(["render", this.file, pageDir(appHome(), key, tag), String(scale), want.map((p) => p + 1).join(",")]);
        if (this.released || key !== this.key) return;
        for (const page of parseRendered(answer.stdout, count)) this.latest.set(page, tag);
        cx.notify();
      } catch (e) {
        console.log(`code-file: pdf render ${this.file}: ${message(e)}`);
      } finally {
        this.rendering = false;
      }
    });
  }

  // ── Find (S8) ──────────────────────────────────────────────────────────────

  forget() {
    const f = this.finder;
    f.seq++;
    f.searched = null;
    f.matches = [];
    f.byPage = new Map();
    f.capped = false;
    f.current = -1;
  }

  focusLater(focus, cx) {
    this.focusTimer?.cancel();
    this.focusTimer = cx.timer.after(FOCUS_DELAY, () => {
      this.focusTimer = null;
      if (!this.released) focus();
    });
  }

  // `find:<text>` types it and searches at once (the live cases drive it).
  openFind(text, cx) {
    this.finder.open = true;
    if (text) this.input.set_value(text);
    if (this.input.value() !== this.finder.searched) this.runSearch(cx);
    this.focusLater(() => this.input.focus(), cx);
    cx.notify();
  }

  closeFind(cx) {
    this.finder.open = false;
    this.findTimer?.cancel();
    this.findTimer = null;
    this.forget();
    this.focusLater(() => this.handle.focus(), cx);
    cx.notify();
  }

  typed(cx) {
    this.findTimer?.cancel();
    this.findTimer = cx.timer.after(FIND_DELAY, (cx) => {
      this.findTimer = null;
      if (this.input.value() !== this.finder.searched) this.runSearch(cx);
    });
    cx.notify();
  }

  // Enter: next, Shift+Enter: previous; on text not searched yet, the search.
  submit(event, cx) {
    if (this.input.value() !== this.finder.searched) {
      this.runSearch(cx);
      return;
    }
    this.stepFind(event?.shift ? -1 : 1, cx);
  }

  // Only the last search counts. One asked before the pages are there runs in show().
  runSearch(cx) {
    const f = this.finder;
    const query = this.input.value();
    this.findTimer?.cancel();
    this.findTimer = null;
    this.forget();
    if (query.trim() === "") {
      f.searched = query;
      cx.notify();
      return;
    }
    if (this.status !== "ready") return;
    const seq = f.seq;
    const key = this.key;
    const count = this.sizes.length;
    cx.spawn(async (cx) => {
      let found = null;
      try {
        found = parseMatches((await this.helper(["find", this.file, query])).stdout, count);
      } catch (e) {
        console.log(`code-file: pdf find ${this.file}: ${message(e)}`);
      }
      if (this.released || seq !== f.seq || key !== this.key) return;
      f.searched = query;
      f.matches = found?.matches ?? [];
      f.capped = found?.capped ?? false;
      f.byPage = matchesByPage(f.matches);
      const layout = this.layout();
      f.current = firstMatchFrom(f.matches, layout ? currentPage(layout, this.range) : 0);
      this.reveal(cx);
      cx.notify();
    });
  }

  stepFind(direction, cx) {
    const f = this.finder;
    if (f.matches.length === 0) {
      if (f.open && this.input.value() !== f.searched) this.runSearch(cx);
      return;
    }
    f.current = stepMatch(f.current, f.matches.length, direction);
    this.reveal(cx);
    cx.notify();
  }

  // The strip with the match in the middle of the pane.
  reveal(cx) {
    const f = this.finder;
    if (f.current < 0) return;
    const layout = this.layout();
    if (!layout) {
      this.goal = f.matches[f.current].page;
      return;
    }
    this.jump(matchRow(layout, f.matches[f.current]), "center", cx);
  }

  findKey(event, cx) {
    if (event?.key !== "escape") return;
    cx.stop_propagation();
    this.closeFind(cx);
  }

  // ── The interface (T1) ─────────────────────────────────────────────────────

  command(name, arg, cx) {
    if (this.released) return false;
    switch (name) {
      case "zoom-in":
        this.zoomBy(1, cx);
        return true;
      case "zoom-out":
        this.zoomBy(-1, cx);
        return true;
      case "zoom-reset":
      case "zoom-fit":
        this.fitWidth(cx);
        return true;
      case "find":
        this.openFind(arg, cx);
        return true;
      case "find-next":
        this.stepFind(1, cx);
        return true;
      case "find-prev":
        this.stepFind(-1, cx);
        return true;
      case "find-close":
        this.closeFind(cx);
        return true;
      case "page":
        this.goToPage(arg, cx);
        return true;
      default:
        return false;
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    for (const timer of [this.ticker, this.poller, this.findTimer, this.focusTimer, this.jumpTimer]) timer?.cancel();
    this.scroll.release();
    this.input.release();
    this.handle.release();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  render(t, _cx) {
    const layout = this.layout();
    const area = div().id("pdf-area").relative().flex_1().min_h(0).overflow_hidden().bg(t.canvas);
    const body = layout
      ? area.child(this.pages(layout)).child(Scrollbar.vertical(LIST).absolute().inset_0())
      : area.when(this.status !== "ready", (el) => el.child(this.message(t)));
    return v_flex().id("pdf-view").size_full().min_h(0).track_focus(this.handle)
      .on_size_change((size, cx) => this.resize(size, cx))
      .child(body.when(this.finder.open, (el) => el.child(this.findBar(t))))
      .child(this.bar(t, layout));
  }

  // S9, as Orca's: an image icon, the error, the file's name.
  message(t) {
    if (this.status === "loading") {
      return div().id("pdf-loading").size_full().flex().items_center().justify_center().text_size(14).text_color(t.dim).child(READER_TEXT.loading);
    }
    const text = this.status === "locked" ? PDF_TEXT.locked : PDF_TEXT.failed;
    return v_flex().id("pdf-error").size_full().items_center().justify_center().gap(12).p(32).bg(t.background).text_size(14).text_color(t.muted)
      .child(svg(ui("image")).size(40))
      .child(div().child(text))
      .child(div().max_w(448).text_center().text_size(12).child(this.name))
      .when(Boolean(this.detail), (el) => el.child(div().max_w(448).text_center().text_size(12).text_color(t.dim).child(this.detail)));
  }

  // Wider than the pane (zoomed in), the pages scroll sideways too.
  pages(layout) {
    const wide = layout.contentWidth > this.width;
    const list = v_virtual_list(LIST, layout.rows.length, layout.heights, (r) => `${layout.rows[r].page}-${layout.rows[r].top}`, (range) => this.rows(range, layout))
      .track_scroll(this.scroll)
      .h_full();
    return div().id("pdf-scroll-x").size_full().when(wide, (el) => el.overflow_x_scrollbar())
      .child(wide ? list.w(layout.contentWidth) : list.w_full());
  }

  // Called from the list's layout: records the range and draws, nothing else (D6).
  rows(range, layout) {
    this.range = { start: range.start, end: range.end };
    const out = [];
    const end = Math.min(range.end, layout.rows.length);
    for (let r = range.start; r < end; r++) out.push(this.row(r, layout));
    return out;
  }

  // A strip: its slice of the page's image (white until rendered), and the matches on it.
  row(r, layout) {
    const { page, top, height } = layout.rows[r];
    const { width, height: full } = layout.pages[page];
    const tag = this.latest.get(page);
    return div().w_full().h(layout.heights[r]).flex().flex_col().items_center().when(top === 0, (el) => el.pt(PAGE_GAP))
      .child(div().relative().flex_none().w(width).h(height).overflow_hidden().bg(PAGE_BG)
        .when(Boolean(tag), (el) => el.child(image(pageImage(this.key, tag, page)).absolute().left(0).top(top === 0 ? 0 : -top).w(width).h(full)))
        .children(this.marks(page, layout.scale, top, height)));
  }

  marks(page, scale, top, height) {
    const f = this.finder;
    const indexes = f.open ? f.byPage.get(page) : null;
    if (!indexes) return [];
    const out = [];
    for (const i of indexes) {
      const bg = i === f.current ? CURRENT_BG : MATCH_BG;
      for (const [x, y, w, h] of stripRects(f.matches[i].rects, scale, top, height)) out.push(div().absolute().left(x).top(y).w(w).h(h).bg(bg));
    }
    return out;
  }

  iconButton(t, id, icon, tip, enabled, go) {
    return div().id(id).flex_none().p(4).rounded(4).tooltip(tip)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_event, cx) => go(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(svg(ui(icon)).size(14));
  }

  // S7: Orca's bottom bar. No zoom before there are pages to measure.
  bar(t, layout) {
    const zoom = layout ? layout.zoom : null;
    return h_flex().id("pdf-bar").flex_none().items_center().gap(16).px(16).py(8).border_t_1().border_color(t.border).text_size(12).text_color(t.muted)
      .child(h_flex().flex_none().items_center().gap(4)
        .child(this.iconButton(t, "pdf-zoom-out", "zoom-out", PDF_TEXT.zoomOut, zoom !== null && canZoomOut(zoom), (cx) => this.zoomBy(-1, cx)))
        .child(this.iconButton(t, "pdf-fit", "rotate-ccw", PDF_TEXT.fit, zoom !== null, (cx) => this.fitWidth(cx)))
        .child(this.iconButton(t, "pdf-zoom-in", "zoom-in", PDF_TEXT.zoomIn, zoom !== null && canZoomIn(zoom), (cx) => this.zoomBy(1, cx)))
        .child(div().id("pdf-zoom").ml(4).flex_none().when(zoom !== null, (el) => el.child(zoomLabel(zoom)))))
      .child(this.iconButton(t, "pdf-find", "search", PDF_TEXT.find, true, (cx) => this.openFind("", cx)))
      .child(div().id("pdf-name").min_w(0).truncate().tooltip(this.name).child(this.name))
      .child(div().id("pdf-label").flex_none().child(PDF_TEXT.label));
  }

  // S8: Orca's floating bar, top-right, 300 px.
  findBar(t) {
    const f = this.finder;
    const query = this.input.value();
    const counted = query.trim() !== "" && f.searched === query;
    const rule = () => div().flex_none().mx(2).w(1).h(16).bg(t.border);
    return h_flex().id("pdf-find-bar").absolute().top(8).right(8).w(300).items_center().gap(4).px(8).py(4)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_color(t.muted)
      .on_key_down((event, cx) => this.findKey(event, cx))
      .child(Input.new(this.input).flex_1().min_w(0).text_size(14).text_color(t.foreground))
      .when(counted, (el) => el.child(div().id("pdf-find-count").flex_none().text_size(12).text_color(t.dim).child(matchLabel(f.current + 1, f.matches.length, f.capped))))
      .child(rule())
      .child(this.iconButton(t, "pdf-find-prev", "chevron-up", PDF_TEXT.previous, true, (cx) => this.stepFind(-1, cx)))
      .child(this.iconButton(t, "pdf-find-next", "chevron-down", PDF_TEXT.next, true, (cx) => this.stepFind(1, cx)))
      .child(rule())
      .child(this.iconButton(t, "pdf-find-close", "x", PDF_TEXT.close, true, (cx) => this.closeFind(cx)));
  }
}
