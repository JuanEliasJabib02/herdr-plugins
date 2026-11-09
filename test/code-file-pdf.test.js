// The PDF reader (plan lector-md T3: S2, S7, S8, S9; D3–D7, D10, D13). pdf-model.js
// is pure and tested as such; pdf-view.js runs in a fake Herdr where `herdr`,
// `gpui-kit`, `gpui-base` and `fs/promises` resolve to stand-ins and the Swift
// helper is a fake answering JSON. How it looks stays with `herdr-app check` and the
// live cases; pdfpages.swift itself is proven against a real PDF by hand (D4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPath } from "../code-editor/mods/code-file/draft-model.js";
import {
  FIT_PADDING, MAX_ZOOM, MIN_ZOOM, PAGE_GAP, PDF_TEXT, PX_PER_PT, STRIP, ZOOM_STEP,
  anchorOf, binName, canZoomIn, canZoomOut, contentKey, currentPage, firstMatchFrom, fitZoom, matchLabel, matchRow,
  matchesByPage, pageImage, pageLayout, pagesToRender, parseInfo, parseMatches, parseRendered, renderScale, rowAt,
  rowOfAnchor, rowPast, scrollsSideways, staleKeys, statArgs, stepMatch, stepZoom, stripRects, zoomLabel,
} from "../code-editor/mods/code-file/pdf-model.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} ${a} ≉ ${b}`);

// A letter page, a landscape one among them: the widest is 792 pt.
const SIZES = [[612, 792], [612, 792], [792, 612], [612, 792]];

// ── S7: zoom ─────────────────────────────────────────────────────────────────

test("S7: 100% is one PDF point at 4/3 px; zoom goes ×1.25 per step between 25% and 500%", () => {
  close(PX_PER_PT, 4 / 3);
  assert.equal(MIN_ZOOM, 0.25);
  assert.equal(MAX_ZOOM, 5);
  assert.equal(ZOOM_STEP, 1.25);
  close(stepZoom(1, 1), 1.25);
  close(stepZoom(1.25, 1), 1.5625);
  close(stepZoom(1, -1), 0.8);
  close(stepZoom(4.5, 1), 5, "clamped at the top");
  close(stepZoom(5, 1), 5);
  close(stepZoom(0.3, -1), 0.25, "clamped at the bottom");
  close(stepZoom(0.25, -1), 0.25);
});

test("S7: Zoom out stops at ≤ 25% and Zoom in at ≥ 500%, after any number of steps", () => {
  let z = 1;
  for (let i = 0; i < 40; i++) z = stepZoom(z, -1);
  assert.equal(canZoomOut(z), false);
  assert.equal(canZoomIn(z), true);
  for (let i = 0; i < 40; i++) z = stepZoom(z, 1);
  assert.equal(canZoomIn(z), false);
  assert.equal(canZoomOut(z), true);
  assert.equal(canZoomOut(0.25), false);
  assert.equal(canZoomIn(5), false);
  assert.equal(canZoomIn(4.99), true);
});

test("S7: the label is NN%", () => {
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(0.25), "25%");
  assert.equal(zoomLabel(5), "500%");
  assert.equal(zoomLabel(960 / 1056), "91%");
  assert.equal(zoomLabel(1.5625), "156%");
});

test("S7: fit to width puts the widest page in the pane less pdf.js's 40 px, clamped to 25%–500%", () => {
  assert.equal(FIT_PADDING, 40);
  close(fitZoom(1000, SIZES), (1000 - 40) / (792 * 4 / 3), "the landscape page decides");
  close(fitZoom(1000, [[612, 792]]), 960 / 816);
  assert.equal(fitZoom(60, SIZES), 0.25);
  assert.equal(fitZoom(100000, SIZES), 5);
  assert.equal(fitZoom(0, SIZES), 1, "no width yet");
  assert.equal(fitZoom(1000, []), 1);
});

// ── S7, D5: the pages as the list's rows ─────────────────────────────────────

test("S7, D5: every page at one scale, cut in strips of 256 px, 10 px between pages and around them", () => {
  assert.equal(STRIP, 256);
  assert.equal(PAGE_GAP, 10);
  const zoom = 960 / 1056;
  const l = pageLayout(SIZES, zoom);
  close(l.scale, zoom * 4 / 3);
  assert.deepEqual(l.pages.map((p) => [p.width, p.height]), [[742, 960], [742, 960], [960, 742], [742, 960]]);
  assert.deepEqual(l.pages.map((p) => p.firstRow), [0, 4, 8, 11]);
  assert.deepEqual(l.heights, [266, 256, 256, 192, 266, 256, 256, 192, 266, 256, 230, 266, 256, 256, 202]);
  assert.deepEqual(l.rows.slice(0, 4).map((r) => [r.page, r.top, r.height]), [[0, 0, 256], [0, 256, 256], [0, 512, 256], [0, 768, 192]]);
  assert.deepEqual(l.rows[10], { page: 2, top: 512, height: 230 });
  assert.equal(l.widest, 960);
  assert.equal(l.contentWidth, 1000);
  const total = l.heights.reduce((a, b) => a + b, 0);
  assert.equal(total, 960 * 3 + 742 + 5 * PAGE_GAP, "every page and every gap, nothing else");
});

test("D5: a strip by a point on its page, and the reading place kept across a zoom", () => {
  const a = pageLayout(SIZES, 960 / 1056);
  assert.equal(rowAt(a, 1, 0), 4);
  assert.equal(rowAt(a, 1, 300), 5);
  assert.equal(rowAt(a, 1, 959), 7);
  assert.equal(rowAt(a, 1, 5000), 7, "clamped to the page");
  assert.equal(rowAt(a, 1, -3), 4);
  assert.equal(currentPage(a, { start: 6, end: 9 }), 1);
  assert.equal(currentPage(a, null), 0);
  const anchor = anchorOf(a, { start: 6, end: 9 });
  assert.deepEqual(anchor, { page: 1, fraction: 512 / 960 });
  const b = pageLayout(SIZES, 2);
  assert.equal(rowOfAnchor(b, anchor), b.pages[1].firstRow + Math.floor((512 / 960) * b.pages[1].height / STRIP));
  assert.equal(anchorOf(a, null), null);
});

// L1: "top" only brings a row below the view to its bottom edge, so a jump goes to a
// row past the target first: from there the target is above the view.
test("L1: the row past a target is the nearest whose bottom is more than a view height below the target's top, else the last", () => {
  const l = pageLayout(SIZES, 960 / 1056); // heights 266 256 256 192 | 266 256 256 192 | 266 256 230 | 266 256 256 202
  assert.equal(rowPast(l, 8, 800), 11, "266 + 256 + 230 = 752 isn't more than 800; + 266 is");
  assert.equal(rowPast(l, 0, 777), 2, "266 + 256 + 256 = 778");
  assert.equal(rowPast(l, 0, 778), 3, "more than, not as much as");
  assert.equal(rowPast(l, 3, 100), 4, "a row after the target even when the target alone fills the view");
  assert.equal(rowPast(l, 12, 800), 14, "none that far: the last row");
  assert.equal(rowPast(l, 14, 800), 14);
  assert.equal(rowPast(l, 8, null), 14, "no view height yet: the last row");
  assert.equal(rowPast(l, 8, 0), 14);
});

test("R12, S7: at fit the pages never scroll sideways, whatever fraction the pane's width has; zoomed past it they do", () => {
  for (const width of [960.6, 960.4, 1000.5, 1000, 777.77]) {
    const fit = pageLayout(SIZES, fitZoom(width, SIZES));
    assert.equal(scrollsSideways(fit, width), false, `${width} px at fit`);
    assert.equal(scrollsSideways(pageLayout(SIZES, stepZoom(fitZoom(width, SIZES), 1)), width), true, `${width} px a step in`);
  }
  assert.equal(scrollsSideways(pageLayout(SIZES, fitZoom(60, SIZES)), 60), true, "fit clamped at 25% in a narrow pane");
});

// ── D6: what to render, and how sharp ────────────────────────────────────────

test("D6: pages render at the shown width × 2, in quarter-octave buckets, so small changes reuse the files", () => {
  const a = renderScale(960 / 1056 * 4 / 3, SIZES);
  assert.equal(a.tag, "s6");
  close(a.scale, 2 ** (6 / 4));
  assert.ok(a.scale >= 960 / 1056 * 4 / 3 * 2, "never less than the screen's pixels");
  assert.equal(renderScale(0.95 * 4 / 3, SIZES).tag, "s6", "a slightly wider pane: the same files");
  assert.equal(renderScale(1.25 * 4 / 3, SIZES).tag, "s7", "a zoom step: new ones");
});

test("D6: a page is never rendered past 4096² pixels: the bucket stops below that", () => {
  const big = renderScale(5 * 4 / 3, SIZES);
  assert.ok(612 * 792 * big.scale ** 2 <= 4096 * 4096, `${big.scale}`);
  assert.equal(big.tag, "s10");
});

test("D6: the visible pages and two on each side, minus what's there, the visible ones first, at most 10", () => {
  const l = pageLayout(SIZES, 960 / 1056);
  assert.deepEqual(pagesToRender(l, { start: 0, end: 5 }, new Set()), [0, 1, 2, 3]);
  assert.deepEqual(pagesToRender(l, { start: 0, end: 5 }, new Set([0, 2])), [1, 3]);
  assert.deepEqual(pagesToRender(l, { start: 11, end: 15 }, new Set()), [3, 2, 1]);
  assert.deepEqual(pagesToRender(l, null, new Set()), []);
  assert.deepEqual(pagesToRender(l, { start: 3, end: 3 }, new Set()), []);
  const many = pageLayout(Array.from({ length: 40 }, () => [612, 792]), 0.25);
  const want = pagesToRender(many, { start: 0, end: many.rows.length }, new Set());
  assert.equal(want.length, 10);
  assert.deepEqual(want.slice(0, 3), [0, 1, 2]);
});

// ── S8: find ─────────────────────────────────────────────────────────────────

const FOUND = JSON.stringify({
  matches: [
    { page: 2, rects: [[100, 700, 50, 12]] },
    { page: 4, rects: [[100, 100, 50, 12], [10, 112, 30, 12]] },
    { page: 4, rects: [[300, 600, 40, 12]] },
  ],
  capped: false,
});

test("S8: the helper's matches, pages from 1 to indexes from 0; anything else is no answer", () => {
  const { matches, capped } = parseMatches(FOUND, 4);
  assert.equal(capped, false);
  assert.deepEqual(matches.map((m) => m.page), [1, 3, 3]);
  assert.deepEqual(matches[1].rects, [[100, 100, 50, 12], [10, 112, 30, 12]]);
  assert.equal(parseMatches('{"matches":[],"capped":false}', 4).matches.length, 0);
  assert.equal(parseMatches('{"matches":[{"page":9,"rects":[[1,1,1,1]]}],"capped":true}', 4).matches.length, 0, "a page the file doesn't have");
  assert.equal(parseMatches("nope", 4), null);
  assert.equal(parseMatches('{"error":"locked"}', 4), null);
});

test("S8: \"{{current}} of {{total}}\" or \"No matches\"", () => {
  assert.equal(matchLabel(1, 3), "1 of 3");
  assert.equal(matchLabel(5000, 5000, true), "5000 of 5000+");
  assert.equal(matchLabel(0, 0), "No matches");
});

test("S8: the first match is the first from the page being read, else the first; next and previous wrap around", () => {
  const { matches } = parseMatches(FOUND, 4);
  assert.equal(firstMatchFrom(matches, 0), 0);
  assert.equal(firstMatchFrom(matches, 2), 1);
  assert.equal(firstMatchFrom(matches, 3), 1);
  assert.equal(firstMatchFrom([{ page: 0, rects: [] }], 3), 0, "past the last one: back to the top");
  assert.equal(firstMatchFrom([], 0), -1);
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(-1, 3, 1), 0);
  assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
});

test("S8: rects in points become pixels of a strip, cut to it; the jump goes to the strip of the match's middle", () => {
  const l = pageLayout(SIZES, 960 / 1056);
  const s = l.scale;
  const [r] = stripRects([[100, 700, 50, 12]], s, 768, 192);
  close(r[0], 100 * s);
  close(r[1], 700 * s - 768);
  close(r[2], 50 * s);
  close(r[3], 12 * s);
  assert.deepEqual(stripRects([[100, 700, 50, 12]], s, 0, 256), [], "another strip of the page");
  assert.equal(stripRects([[0, 210, 10, 12]], s, 256, 256).length, 1, "one crossing the strip's top edge is drawn in both");
  assert.equal(stripRects([[0, 210, 10, 12]], s, 0, 256).length, 1);
  const { matches } = parseMatches(FOUND, 4);
  assert.equal(matchRow(l, matches[0]), 7);
  assert.equal(matchRow(l, matches[1]), 11);
  const byPage = matchesByPage(matches);
  assert.deepEqual(byPage.get(3), [1, 2]);
  assert.equal(byPage.get(0), undefined);
});

// ── D4: the helper's answers ─────────────────────────────────────────────────

test("D4, S9: info gives sizes per page; locked is its own error; anything else fails", () => {
  assert.deepEqual(parseInfo('{"pages":2,"sizes":[[612,792],[792.5,612]]}'), { pages: 2, sizes: [[612, 792], [792.5, 612]] });
  assert.deepEqual(parseInfo('{"error":"locked"}'), { error: "locked" });
  assert.deepEqual(parseInfo('{"error":"unreadable"}'), { error: "failed" });
  assert.deepEqual(parseInfo(""), { error: "failed" });
  assert.deepEqual(parseInfo('{"pages":2,"sizes":[[612,792]]}'), { error: "failed" });
  assert.deepEqual(parseInfo('{"pages":1,"sizes":[[0,792]]}'), { error: "failed" });
  assert.deepEqual(parseInfo('{"pages":0,"sizes":[]}'), { error: "failed" });
});

test("D6: render answers the pages it wrote, from 1, as indexes", () => {
  assert.deepEqual(parseRendered('{"done":[1,3],"failed":[2]}', 4), [0, 2]);
  assert.deepEqual(parseRendered('{"done":[9]}', 4), []);
  assert.deepEqual(parseRendered("x", 4), []);
});

test("D3, D10: a content key from the path, mtime and size; the path's older keys are stale", () => {
  const k = contentKey("/r/a.pdf", "1700000000 12345\n");
  assert.match(k, /^[0-9a-f]+-[0-9a-f]+$/);
  assert.ok(k.startsWith(`${hashPath("/r/a.pdf")}-`));
  assert.notEqual(contentKey("/r/a.pdf", "1700000001 12345\n"), k);
  assert.notEqual(contentKey("/r/a.pdf", "1700000000 12346\n"), k);
  assert.notEqual(contentKey("/r/b.pdf", "1700000000 12345\n"), k);
  assert.equal(contentKey("/r/a.pdf", ""), null);
  assert.equal(contentKey("/r/a.pdf", null), null);
  const other = contentKey("/r/a.pdf", "1 2\n");
  const b = contentKey("/r/b.pdf", "1 2\n");
  assert.deepEqual(staleKeys([k, other, b, "junk"], k), [other]);
  assert.equal(pageImage(k, "s6", 0), `data/code-file/pdf/${k}/s6/p1.png`);
  assert.equal(binName("source"), `pdfpages-${hashPath("source")}`);
});

test("R3, D3: the key comes from stat -L -f '%Fm %z': a symlink by its target, the mtime to the nanosecond", () => {
  assert.deepEqual(statArgs("/r/a.pdf"), ["-L", "-f", "%Fm %z", "/r/a.pdf"]);
  const k = contentKey("/r/a.pdf", "1794072942.163216795 6661678\n");
  assert.match(k ?? "", /^[0-9a-f]+-[0-9a-f]+$/, "what macOS's stat prints");
  assert.ok(k.startsWith(`${hashPath("/r/a.pdf")}-`));
  assert.notEqual(contentKey("/r/a.pdf", "1794072942.163216796 6661678\n"), k, "a same-size rewrite within the second");
  assert.equal(contentKey("/r/a.pdf", "1794072942. 6661678\n"), null);
  assert.equal(contentKey("/r/a.pdf", "1794072942.1.2 6661678\n"), null);
});

// What the reader runs, on the real stat: a rewrite through a symlink, and one of the
// same size within the same second, are new keys.
test("R3: macOS's stat with the reader's arguments follows a symlink and tells two rewrites in one second apart", { skip: process.platform !== "darwin" && "macOS's stat" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-stat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "real.pdf");
  const link = join(dir, "link.pdf");
  writeFileSync(target, "aa");
  symlinkSync(target, link);
  const key = () => contentKey(link, execFileSync("/usr/bin/stat", statArgs(link), { encoding: "utf8" }));
  utimesSync(target, 1700000000.25, 1700000000.25);
  const first = key();
  assert.ok(first, "stat's answer makes a key");
  writeFileSync(target, "bb");
  utimesSync(target, 1700000000.75, 1700000000.75);
  const second = key();
  assert.ok(second);
  assert.notEqual(second, first, "same size, same second");
  writeFileSync(target, "ccc");
  utimesSync(target, 1700000000.75, 1700000000.75);
  assert.notEqual(key(), second, "the target's size, not the link's");
});

test("S7, S8, S9: Orca's strings", () => {
  assert.deepEqual({ ...PDF_TEXT }, {
    zoomOut: "Zoom out",
    fit: "Fit to width",
    zoomIn: "Zoom in",
    find: "Find in PDF (⌘F)",
    label: "PDF preview",
    findPlaceholder: "Find in page...",
    previous: "Previous match",
    next: "Next match",
    close: "Close",
    noMatches: "No matches",
    failed: "Failed to load PDF preview",
    locked: "This PDF is password-protected",
    noSwift: "Showing PDFs needs Apple's Swift compiler: run xcode-select --install",
  });
});

// ── The view, in a fake Herdr ────────────────────────────────────────────────

const FAKES = {
  herdr: ["appHome", "exec", "home", "watchFolder", "theme", "notify", "props", "run", "shared", "setShared", "settings", "spaces", "panes", "nextCommand", "readTextFile", "writeTextFile"]
    .map((n) => `export const ${n} = (...a) => globalThis.__pdf.${n}(...a);`).join("\n"),
  "fs/promises": ["readFile", "writeFile", "readdir", "unlink", "mkdir", "exists", "rmdir"]
    .map((n) => `export const ${n} = (...a) => globalThis.__pdf.fs.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__pdf.el(n, ...a);
    export const div = k("div"), svg = k("svg"), image = k("image");
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__pdf.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex");
    export const v_virtual_list = (id, count, sizes, getKey, render) => globalThis.__pdf.el("list", { id, count, sizes, getKey, render });
    export const Scrollbar = { vertical: (name) => globalThis.__pdf.el("Scrollbar", name) };
    export const VirtualListScrollHandle = { new: () => globalThis.__pdf.newScroll() };
    export const Input = { new: (s) => globalThis.__pdf.el("Input", s) };
    export const InputState = { new: (o) => globalThis.__pdf.newInput(o) };`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
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
const find = (e, id) => {
  if (!isEl(e)) return null;
  if (e.calls.id?.[0] === id) return e;
  for (const k of e.kids) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
};
const findAll = (e, pred, out = []) => {
  if (!isEl(e)) return out;
  if (pred(e)) out.push(e);
  for (const k of e.kids) findAll(k, pred, out);
  return out;
};
const findKind = (e, kind) => findAll(e, (x) => x.kind === kind)[0] ?? null;
const textOf = (e) => (typeof e === "string" ? e : isEl(e) ? e.kids.map(textOf).filter(Boolean).join(" ") : "");
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise(setImmediate);
};

const HOME = "/home/juan";
const APP = `${HOME}/.config/herdr-app`;
const SOURCE = "// pdfpages\n";
const SWIFT = `${APP}/mods/code-file/pdfpages.swift`;
const BIN_DIR = `${APP}/data/code-file/bin`;
const BIN = `${BIN_DIR}/pdfpages-${hashPath(SOURCE)}`;
const FILE = "/repo/docs/book.pdf";
const INFO = JSON.stringify({ pages: 4, sizes: SIZES });
const T = new Proxy({}, { get: (_t, k) => `#${String(k)}` });

function newWorld({ file = FILE, bin = true, stat = "1700000000 12345\n", info = INFO, swiftFails = false, holdInfo = false, holdFind = false, realDir = null, watchError = null } = {}) {
  const w = {
    file,
    fs: { [SWIFT]: SOURCE, ...(bin ? { [BIN]: "binary" } : {}) },
    stat,
    info,
    findAnswer: FOUND,
    swiftFails,
    holdInfo,
    held: [],
    holdFind,
    heldFinds: [],
    realDir,
    watchError,
    execs: [],
    renders: [],
    finds: [],
    removed: [],
    notifies: 0,
    timers: [],
    watches: [],
    scrolls: [],
    inputs: [],
    focus: [],
    log: [],
  };
  const cx = {
    notify: () => { w.notifies++; },
    spawn: (f) => { const p = Promise.resolve().then(() => f(cx)); p.catch((e) => { w.crash = e; }); return { cancel() {}, is_done: () => false }; },
    timer: {
      after: (ms, f) => { const t = { ms, f, repeat: false, cancelled: false, cancel() { t.cancelled = true; } }; w.timers.push(t); return t; },
      every: (ms, f) => { const t = { ms, f, repeat: true, cancelled: false, cancel() { t.cancelled = true; } }; w.timers.push(t); return t; },
    },
    focus_handle: () => { const h = { focus() { w.focus.push("root"); }, is_focused: () => false, released: false, release() { h.released = true; return true; } }; w.handle = h; return h; },
    stop_propagation() { w.stopped = true; },
  };
  w.cx = cx;
  w.fire = async (ms) => {
    for (const t of w.timers.filter((x) => x.ms === ms && !x.cancelled && !x.fired)) {
      if (!t.repeat) t.fired = true;
      t.f(cx);
    }
    await flush();
  };
  w.batch = async (paths) => { w.watches.shift()?.resolve(paths); await flush(); };
  w.helperCalls = (kind) => w.execs.filter(([cmd, sub]) => cmd === BIN && sub === kind);
  const helper = async (args) => {
    const [sub] = args;
    if (sub === "info") {
      if (w.holdInfo) await new Promise((resolve) => w.held.push(resolve));
      return { code: w.info.includes("error") ? 3 : 0, stdout: `${w.info}\n`, stderr: "" };
    }
    if (sub === "render") {
      const [, path, dir, scale, list] = args;
      w.renders.push({ path, dir, scale: Number(scale), pages: list.split(",").map(Number) });
      return { code: 0, stdout: JSON.stringify({ done: list.split(",").map(Number), failed: [] }), stderr: "" };
    }
    if (sub === "find") {
      w.finds.push(args[2]);
      if (w.holdFind) await new Promise((resolve) => w.heldFinds.push(resolve));
      // A string is stdout of a run that exited 0; a function may throw (exec rejected)
      // or answer the whole result.
      const answer = typeof w.findAnswer === "function" ? w.findAnswer(args[2]) : w.findAnswer;
      return typeof answer === "string" ? { code: 0, stdout: answer, stderr: "" } : answer;
    }
    return { code: 64, stdout: '{"error":"usage"}', stderr: "" };
  };
  globalThis.__pdf = {
    el,
    newScroll: () => { const s = { calls: [], released: false, scroll_to_item: (i, how) => s.calls.push([i, how]), release() { s.released = true; return true; } }; w.scrolls.push(s); return s; },
    newInput: (opts) => {
      const s = { opts, text: "", handlers: {}, focused: 0, released: false, value: () => s.text, set_value: (v) => { s.text = v; }, on: (n, h) => { s.handlers[n] = h; return true; }, focus() { s.focused++; }, release() { s.released = true; return true; } };
      w.inputs.push(s);
      return s;
    },
    appHome: () => APP,
    home: () => HOME,
    exec: async (cmd, args = [], options = {}) => {
      w.execs.push([cmd, ...args]);
      if (cmd === "/usr/bin/stat") return w.stat === null ? { code: 1, stdout: "", stderr: "No such file" } : { code: 0, stdout: w.stat, stderr: "" };
      if (cmd === "/bin/pwd") return { code: 0, stdout: `${w.realDir ?? options.cwd}\n`, stderr: "" };
      if (cmd === "/usr/bin/swiftc") {
        if (w.swiftFails) return { code: 1, stdout: "", stderr: "xcrun: error: invalid active developer path" };
        w.fs[args[args.indexOf("-o") + 1]] = "binary";
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "/bin/mv") {
        const [, from, to] = args;
        w.fs[to] = w.fs[from];
        delete w.fs[from];
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "/bin/rm") {
        w.removed.push(args.at(-1));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (Object.hasOwn(w.fs, cmd)) return helper(args);
      throw new Error(`No such file or directory: ${cmd}`);
    },
    watchFolder: (dir) => {
      if (w.watchError) return Promise.reject(new Error(w.watchError));
      return new Promise((resolve) => { w.watches.push({ dir, resolve }); });
    },
    fs: {
      readFile: async (p) => {
        if (!Object.hasOwn(w.fs, p)) throw new Error(`ENOENT: ${p}`);
        return w.fs[p];
      },
      readdir: async (dir) => {
        const names = Object.keys(w.fs).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]);
        if (names.length === 0 && !(w.dirs ?? []).includes(dir)) throw new Error(`ENOENT: ${dir}`);
        return [...new Set(names)];
      },
      mkdir: async (dir) => { (w.dirs ??= []).push(dir); },
      unlink: async (p) => { w.log.push(`unlink ${p}`); delete w.fs[p]; },
      writeFile: async (p, text) => { w.fs[p] = text; },
      exists: async (p) => Object.hasOwn(w.fs, p),
      rmdir: async () => {},
    },
  };
  return w;
}

const { PdfViewer } = await import("../code-editor/mods/code-file/pdf-view.js");

async function openPdf(options = {}) {
  const w = newWorld(options);
  const viewer = new PdfViewer({ file: w.file, doc: "d1", text: () => "", visible: () => true }, w.cx);
  w.viewer = viewer;
  await flush();
  w.draw = () => viewer.render(T, w.cx);
  w.resize = async (width) => {
    const root = w.draw();
    assert.ok(root.handlers.size_change, "the root reports its size");
    root.handlers.size_change({ width, height: 800 }, w.cx);
    await flush();
  };
  w.list = () => findKind(w.draw(), "list");
  // What GPUI does in a frame: the list asks for its visible rows.
  w.frame = (start, end) => {
    const list = w.list();
    assert.ok(list, "the pages are drawn");
    return list.arg.render({ start, end }, w.cx);
  };
  w.command = async (name, arg = "") => {
    const taken = viewer.command(name, arg, w.cx);
    await flush();
    return taken;
  };
  w.input = () => w.inputs[0];
  w.scroll = () => w.scrolls[0];
  w.click = async (id) => {
    const target = find(w.draw(), id);
    assert.ok(target, `no element ${id}`);
    assert.ok(target.handlers.click, `${id} has no on_click`);
    target.handlers.click({}, w.cx);
    await flush();
  };
  w.tick = () => w.fire(100);
  return w;
}

// The pane is 1000 px wide: fit is 91%, and the first frame shows rows 0–4.
async function readyPdf(options = {}) {
  const w = await openPdf(options);
  await w.resize(1000);
  return w;
}

const KEY = contentKey(FILE, "1700000000 12345\n");

// ── S9: loading and errors ───────────────────────────────────────────────────

test("S9: \"Loading preview...\" until the helper answers, and the bottom bar from the start", async () => {
  const w = await openPdf({ holdInfo: true });
  assert.match(textOf(w.draw()), /Loading preview\.\.\./);
  assert.ok(find(w.draw(), "pdf-bar"));
  assert.equal(find(w.draw(), "pdf-zoom-in").handlers.click, undefined, "no zoom before there are pages");
  assert.equal(find(w.draw(), "pdf-zoom").kids.length, 0, "and no percent");
  w.held.shift()();
  await flush();
  await w.resize(1000);
  assert.doesNotMatch(textOf(w.draw()), /Loading preview/);
  assert.ok(w.list());
});

test("S9: a locked file says \"This PDF is password-protected\", with its name under it", async () => {
  const w = await openPdf({ info: '{"error":"locked"}' });
  const body = find(w.draw(), "pdf-error");
  assert.ok(body);
  assert.match(textOf(body), /This PDF is password-protected/);
  assert.match(textOf(body), /book\.pdf/);
  assert.equal(w.list(), null);
});

for (const [name, options] of [
  ["an unreadable file", { info: '{"error":"unreadable"}' }],
  ["an answer that isn't JSON", { info: "garbage" }],
  ["a file stat can't see", { stat: null }],
]) {
  test(`S9: ${name} says "Failed to load PDF preview"`, async () => {
    const w = await openPdf(options);
    assert.match(textOf(find(w.draw(), "pdf-error")), /Failed to load PDF preview/);
    assert.doesNotMatch(textOf(w.draw()), /Swift/);
  });
}

test("S9, D4: with no Swift compiler it fails to load, and says what's missing", async () => {
  const w = await openPdf({ bin: false, swiftFails: true });
  const body = textOf(find(w.draw(), "pdf-error"));
  assert.match(body, /Failed to load PDF preview/);
  assert.match(body, /xcode-select --install/);
});

// ── D4: the helper ───────────────────────────────────────────────────────────

test("D4: compiled once from mods/code-file/pdfpages.swift with swiftc -O into data/code-file/bin/pdfpages-<hash>, through a temporary name", async () => {
  const w = await openPdf({ bin: false });
  const compiles = w.execs.filter(([cmd]) => cmd === "/usr/bin/swiftc");
  assert.equal(compiles.length, 1);
  const [, flag, source, o, temp] = compiles[0];
  assert.deepEqual([flag, source, o], ["-O", SWIFT, "-o"]);
  assert.ok(temp.startsWith(`${BIN}.`), temp);
  assert.deepEqual(w.execs.find(([cmd]) => cmd === "/bin/mv"), ["/bin/mv", "-f", temp, BIN]);
  assert.ok(w.dirs.includes(BIN_DIR));
  assert.equal(w.helperCalls("info").length, 1);
  assert.deepEqual(w.helperCalls("info")[0], [BIN, "info", FILE]);
});

test("D4: an existing build is used as is, and older builds go when a new one is made", async () => {
  const w = await openPdf();
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/swiftc").length, 0);
  const old = newWorld({ bin: false });
  old.fs[`${BIN_DIR}/pdfpages-0ld`] = "binary";
  const viewer = new PdfViewer({ file: FILE, doc: "d1", text: () => "", visible: () => true }, old.cx);
  await flush();
  assert.ok(old.log.includes(`unlink ${BIN_DIR}/pdfpages-0ld`));
  viewer.release();
});

test("R5, D4: a build that failed isn't tried again by the same reader, on a reload or a change; reopening the tab tries again", async () => {
  const w = await openPdf({ bin: false, swiftFails: true });
  const compiles = () => w.execs.filter(([cmd]) => cmd === "/usr/bin/swiftc").length;
  assert.equal(compiles(), 1);
  await w.batch([FILE]);
  w.stat = "1700000099 22222\n";
  await w.batch([FILE]);
  assert.equal(compiles(), 1, "swiftc ran once");
  const body = textOf(find(w.draw(), "pdf-error"));
  assert.match(body, /Failed to load PDF preview/);
  assert.match(body, /xcode-select --install/, "and the reason stays");
  const reopened = new PdfViewer({ file: FILE, doc: "d1", text: () => "", visible: () => true }, w.cx);
  await flush();
  assert.equal(compiles(), 2);
  reopened.release();
});

// A real PDF, one page, "React hooks" in Helvetica: the offsets in its xref are counted.
function tinyPdf() {
  const content = "BT /F1 12 Tf 20 60 Td (React hooks) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const HELPER_SOURCE = new URL("../code-editor/mods/code-file/pdfpages.swift", import.meta.url).pathname;
const SWIFTC = "/usr/bin/swiftc";

// The real helper, built as the reader builds it.
test("R15, D4: pdfpages render leaves a page whose PNG is already there, which it only ever writes atomically", { skip: !(process.platform === "darwin" && existsSync(SWIFTC)) && "needs macOS's swiftc" }, (t) => {
  assert.match(readFileSync(HELPER_SOURCE, "utf8"), /data\.write\(to: url, options: \.atomic\)/, "a PNG on disk is a whole one");
  const dir = mkdtempSync(join(tmpdir(), "pdfpages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "pdfpages");
  try {
    execFileSync(SWIFTC, ["-O", HELPER_SOURCE, "-o", bin], { stdio: "pipe" });
  } catch (e) {
    t.skip(`swiftc: ${String(e.stderr ?? e.message).trim()}`);
    return;
  }
  const pdf = join(dir, "tiny.pdf");
  writeFileSync(pdf, tinyPdf());
  const out = join(dir, "s4");
  const png = join(out, "p1.png");
  const render = () => JSON.parse(execFileSync(bin, ["render", pdf, out, "2", "1"], { encoding: "utf8" }));
  assert.deepEqual(render(), { done: [1], failed: [] });
  assert.deepEqual([...readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");
  writeFileSync(png, "already here");
  assert.deepEqual(render(), { done: [1], failed: [] }, "still done");
  assert.ok(readFileSync(png).equals(Buffer.from("already here")), "and not drawn again");
  rmSync(png);
  assert.deepEqual(render(), { done: [1], failed: [] });
  assert.deepEqual([...readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a missing one is drawn");
});

// ── S7: the pages and the bottom bar ─────────────────────────────────────────

test("S7, D5: a virtual list of strips, heights known, fit to the pane's width, on the canvas color", async () => {
  const w = await readyPdf();
  const list = w.list();
  assert.equal(list.arg.id, "pdf-pages");
  assert.deepEqual(list.arg.sizes, pageLayout(SIZES, 960 / 1056).heights);
  assert.equal(list.arg.count, 15);
  assert.equal(list.calls.track_scroll[0], w.scroll());
  assert.equal(find(w.draw(), "pdf-area").calls.bg[0], "#canvas");
  assert.ok(findKind(w.draw(), "Scrollbar"));
  assert.equal(find(w.draw(), "pdf-zoom").kids[0], "91%");
});

test("S7: the bottom bar, left to right: Zoom out, Fit to width, Zoom in, NN%, Find in PDF (⌘F), the name, PDF preview", async () => {
  const w = await readyPdf();
  const bar = find(w.draw(), "pdf-bar");
  assert.ok(bar.calls.border_t_1);
  assert.equal(bar.calls.border_color[0], "#border");
  assert.deepEqual([bar.calls.px[0], bar.calls.py[0], bar.calls.gap[0], bar.calls.text_size[0]], [16, 8, 16, 12]);
  const order = findAll(bar, (e) => typeof e.calls.id?.[0] === "string").map((e) => e.calls.id[0]);
  assert.deepEqual(order.filter((id) => id !== "pdf-bar"), ["pdf-zoom-out", "pdf-fit", "pdf-zoom-in", "pdf-zoom", "pdf-find", "pdf-name", "pdf-label"]);
  assert.equal(find(bar, "pdf-zoom-out").calls.tooltip[0], "Zoom out");
  assert.equal(find(bar, "pdf-fit").calls.tooltip[0], "Fit to width");
  assert.equal(find(bar, "pdf-zoom-in").calls.tooltip[0], "Zoom in");
  assert.equal(find(bar, "pdf-find").calls.tooltip[0], "Find in PDF (⌘F)");
  assert.equal(textOf(find(bar, "pdf-name")), "book.pdf");
  assert.ok(find(bar, "pdf-name").calls.truncate);
  assert.equal(textOf(find(bar, "pdf-label")), "PDF preview");
  assert.equal(findKind(find(bar, "pdf-fit"), "svg").arg, "mods/code-file/ui/rotate-ccw.svg");
  assert.equal(findKind(find(bar, "pdf-find"), "svg").arg, "mods/code-file/ui/search.svg");
});

for (const [name, zoomIn, zoomOut, fit] of [
  ["the commands", (w) => w.command("zoom-in"), (w) => w.command("zoom-out"), (w) => w.command("zoom-reset")],
  ["the buttons", (w) => w.click("pdf-zoom-in"), (w) => w.click("pdf-zoom-out"), (w) => w.click("pdf-fit")],
]) {
  test(`S7, D7: ${name}: ×1.25 from where it is, disabled at the ends, and fit comes back`, async () => {
    const w = await readyPdf();
    const label = () => find(w.draw(), "pdf-zoom").kids[0];
    await zoomIn(w);
    assert.equal(label(), "114%");
    await zoomIn(w);
    assert.equal(label(), "142%");
    await zoomOut(w);
    assert.equal(label(), "114%");
    for (let i = 0; i < 12 && find(w.draw(), "pdf-zoom-out").handlers.click; i++) await zoomOut(w);
    assert.equal(label(), "25%");
    assert.equal(find(w.draw(), "pdf-zoom-out").handlers.click, undefined);
    assert.equal(find(w.draw(), "pdf-zoom-out").calls.opacity[0], 0.5);
    for (let i = 0; i < 20 && find(w.draw(), "pdf-zoom-in").handlers.click; i++) await zoomIn(w);
    assert.equal(label(), "500%");
    assert.equal(find(w.draw(), "pdf-zoom-in").handlers.click, undefined);
    assert.equal(find(w.draw(), "pdf-zoom-in").calls.opacity[0], 0.5);
    await fit(w);
    assert.equal(label(), "91%");
  });
}

test("D7: every zoom key and find is the reader's, and nothing else is", async () => {
  const w = await readyPdf();
  for (const name of ["zoom-in", "zoom-out", "zoom-reset", "zoom-fit", "find", "find-next", "find-prev", "find-close", "page"]) {
    assert.equal(await w.command(name, name === "page" ? "2" : ""), true, name);
  }
  assert.equal(await w.command("source"), false);
  assert.equal(await w.command("blame"), false);
  const loading = await openPdf({ holdInfo: true });
  assert.equal(await loading.command("zoom-in"), true, "a PDF still loading never zooms the window");
});

test("S7, L1: zoom keeps the page being read: the same place on it comes to the top edge, from a row past it", async () => {
  const w = await readyPdf();
  w.frame(6, 9);
  await w.command("zoom-in");
  const after = pageLayout(SIZES, stepZoom(960 / 1056, 1));
  const want = rowOfAnchor(after, { page: 1, fraction: 512 / 960 });
  const past = rowPast(after, want, 800);
  assert.ok(past > want);
  assert.deepEqual(w.scroll().calls.at(-1), [past, "top"], "first a row whose bottom is more than the pane's 800 px below");
  const before = w.notifies;
  await w.fire(50);
  assert.deepEqual(w.scroll().calls.at(-1), [want, "top"], "then the place, now above the view");
  assert.ok(w.notifies > before, "with a frame to land in");
});

test("S7: wider than the pane, the pages scroll sideways; at fit they don't", async () => {
  const w = await readyPdf();
  assert.equal(find(w.draw(), "pdf-scroll-x").calls.overflow_x_scrollbar, undefined);
  await w.command("zoom-in");
  const wide = find(w.draw(), "pdf-scroll-x");
  assert.ok(wide.calls.overflow_x_scrollbar);
  assert.equal(w.list().calls.w[0], pageLayout(SIZES, stepZoom(960 / 1056, 1)).contentWidth);
});

test("R12, S7: at fit a pane 960.6 px wide doesn't scroll sideways", async () => {
  const w = await openPdf();
  await w.resize(960.6);
  assert.equal(find(w.draw(), "pdf-zoom").kids[0], "87%");
  assert.equal(find(w.draw(), "pdf-scroll-x").calls.overflow_x_scrollbar, undefined);
  assert.ok(w.list().calls.w_full);
});

test("D5, L1: page:<n> brings that page's top to the top edge: a row past it first, the page after the frame", async () => {
  const w = await readyPdf();
  await w.command("page", "3");
  assert.deepEqual(w.scroll().calls.at(-1), [11, "top"], "the nearest row whose bottom is more than the pane's 800 px below the page's top");
  await w.fire(50);
  assert.deepEqual(w.scroll().calls.at(-1), [8, "top"]);
  await w.command("page", "99");
  assert.deepEqual(w.scroll().calls.at(-1), [14, "top"], "near the end: the last row");
  await w.fire(50);
  assert.deepEqual(w.scroll().calls.at(-1), [11, "top"], "past the end: the last page");
});

test("L1: a pane whose height alone changes keeps its scale; the next jump measures the new height", async () => {
  const w = await readyPdf();
  const root = w.draw();
  root.handlers.size_change({ width: 1000, height: 300 }, w.cx);
  await flush();
  assert.equal(find(w.draw(), "pdf-zoom").kids[0], "91%");
  await w.command("page", "3");
  assert.deepEqual(w.scroll().calls.at(-1), [9, "top"], "266 + 256 is more than 300");
});

// ── D6: lazy pages ───────────────────────────────────────────────────────────

test("D6: the row renderer only records the range; a timer renders the missing pages ±2 in one exec, then redraws", async () => {
  const w = await readyPdf();
  const before = w.notifies;
  const rows = w.frame(0, 5);
  assert.equal(rows.length, 5);
  assert.equal(w.notifies, before, "no notify inside the list's layout");
  assert.equal(w.renders.length, 0, "and no exec");
  assert.deepEqual(findAll({ kids: rows, calls: {}, handlers: {} }, (e) => Object.keys(e.handlers).length > 0), [], "rows carry no handlers");
  assert.equal(findAll({ kids: rows, calls: {}, handlers: {} }, (e) => e.kind === "image").length, 0, "white pages until rendered");
  await w.tick();
  assert.equal(w.renders.length, 1);
  const tag = renderScale(960 / 1056 * 4 / 3, SIZES);
  assert.deepEqual(w.renders[0], { path: FILE, dir: `${APP}/data/code-file/pdf/${KEY}/${tag.tag}`, scale: tag.scale, pages: [1, 2, 3, 4] });
  assert.equal(w.notifies, before + 1);
  const shown = w.frame(0, 5);
  const images = findAll({ kids: shown, calls: {}, handlers: {} }, (e) => e.kind === "image");
  assert.equal(images.length, 5);
  assert.equal(images[0].arg, pageImage(KEY, tag.tag, 0), "relative to the Herdr home (D3)");
  assert.equal(images[4].arg, pageImage(KEY, tag.tag, 1));
  assert.deepEqual([images[1].calls.top[0], images[1].calls.w[0], images[1].calls.h[0]], [-256, 742, 960], "each strip shows its slice of the page");
  await w.tick();
  assert.equal(w.renders.length, 1, "nothing missing: no exec");
});

test("D6: after a zoom the old images stay until the new ones land", async () => {
  const w = await readyPdf();
  w.frame(0, 5);
  await w.tick();
  const old = renderScale(960 / 1056 * 4 / 3, SIZES).tag;
  await w.command("zoom-in");
  const images = findAll({ kids: w.frame(0, 5), calls: {}, handlers: {} }, (e) => e.kind === "image");
  assert.ok(images.length > 0);
  assert.ok(images.every((e) => e.arg.includes(`/${old}/`)));
  await w.tick();
  assert.equal(w.renders.length, 2);
  assert.notEqual(w.renders[1].dir, w.renders[0].dir);
});

test("R2, D6: zoomed out and back in, the pages are drawn from the sharp files again, with nothing rendered again", async () => {
  const w = await readyPdf();
  const imagesOf = (rows) => findAll({ kids: rows, calls: {}, handlers: {} }, (e) => e.kind === "image");
  w.frame(0, 5);
  await w.tick();
  const sharp = renderScale(960 / 1056 * 4 / 3, SIZES).tag;
  await w.command("zoom-out");
  const low = renderScale(stepZoom(960 / 1056, -1) * 4 / 3, SIZES).tag;
  assert.notEqual(low, sharp);
  w.frame(0, 5);
  await w.tick();
  assert.equal(w.renders.length, 2);
  assert.ok(w.renders[1].dir.endsWith(`/${low}`));
  assert.ok(imagesOf(w.frame(0, 5)).every((e) => e.arg.includes(`/${low}/`)));
  await w.command("zoom-in");
  const images = imagesOf(w.frame(0, 5));
  assert.equal(images.length, 5);
  assert.ok(images.every((e) => e.arg.includes(`/${sharp}/`)), images.map((e) => e.arg).join(" "));
  await w.tick();
  assert.equal(w.renders.length, 2, "they're on disk and known: no exec");
});

// ── S8: find ─────────────────────────────────────────────────────────────────

test("S8: cmd-f opens a 300 px bar top-right with \"Find in page...\", and focuses its field", async () => {
  const w = await readyPdf();
  assert.equal(w.input().opts.placeholder, "Find in page...");
  assert.equal(find(w.draw(), "pdf-find-bar"), null);
  await w.command("find");
  const bar = find(w.draw(), "pdf-find-bar");
  assert.ok(bar);
  assert.equal(bar.calls.w[0], 300);
  assert.ok(bar.calls.absolute && bar.calls.top && bar.calls.right);
  assert.ok(findKind(bar, "Input"));
  assert.equal(find(bar, "pdf-find-prev").calls.tooltip[0], "Previous match");
  assert.equal(find(bar, "pdf-find-next").calls.tooltip[0], "Next match");
  assert.equal(find(bar, "pdf-find-close").calls.tooltip[0], "Close");
  assert.equal(find(bar, "pdf-find-count"), null, "nothing to count with an empty field");
  await w.fire(50);
  assert.equal(w.input().focused, 1);
});

test("S8: find:<text> searches at once: \"1 of N\", the match highlighted and in view, the current one distinct", async () => {
  const w = await readyPdf();
  w.frame(0, 5);
  await w.command("find", "React");
  assert.deepEqual(w.finds, ["React"]);
  assert.equal(w.input().value(), "React");
  assert.equal(textOf(find(w.draw(), "pdf-find-count")), "1 of 3");
  assert.deepEqual(w.scroll().calls.at(-1), [7, "center"]);
  const row = w.frame(7, 8)[0];
  const boxes = findAll(row, (e) => e.calls.absolute && e.calls.bg);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].calls.bg[0], "#00640040", "the current match: pdf.js's selected color");
  const s = pageLayout(SIZES, 960 / 1056).scale;
  close(boxes[0].calls.top[0], 700 * s - 768);
  await w.command("find-next");
  assert.equal(textOf(find(w.draw(), "pdf-find-count")), "2 of 3");
  assert.deepEqual(w.scroll().calls.at(-1), [11, "center"]);
  const other = findAll(w.frame(7, 8)[0], (e) => e.calls.absolute && e.calls.bg);
  assert.equal(other[0].calls.bg[0], "#b400aa40", "the others: pdf.js's highlight");
  const page4 = findAll(w.frame(11, 12)[0], (e) => e.calls.absolute && e.calls.bg);
  assert.equal(page4.filter((e) => e.calls.bg[0] === "#00640040").length, 2, "a match on two lines lights both");
});

test("S8: next and previous wrap around, by command, by button, and by Enter / Shift+Enter", async () => {
  const w = await readyPdf();
  await w.command("find", "React");
  const count = () => textOf(find(w.draw(), "pdf-find-count"));
  await w.command("find-prev");
  assert.equal(count(), "3 of 3");
  await w.command("find-next");
  assert.equal(count(), "1 of 3");
  await w.click("pdf-find-next");
  assert.equal(count(), "2 of 3");
  await w.click("pdf-find-prev");
  assert.equal(count(), "1 of 3");
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.equal(count(), "2 of 3");
  w.input().handlers.submit({ shift: true }, w.cx);
  await flush();
  assert.equal(count(), "1 of 3");
  assert.deepEqual(w.finds, ["React"], "stepping never searches again");
});

test("S8: typing searches after a pause; Enter on new text searches at once", async () => {
  const w = await readyPdf();
  await w.command("find");
  w.input().text = "Rea";
  w.input().handlers.change({}, w.cx);
  w.input().text = "React";
  w.input().handlers.change({}, w.cx);
  await flush();
  assert.deepEqual(w.finds, []);
  await w.fire(250);
  assert.deepEqual(w.finds, ["React"], "once, with the last text");
  w.input().text = "hooks";
  w.input().handlers.change({}, w.cx);
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.deepEqual(w.finds, ["React", "hooks"]);
  await w.fire(250);
  assert.deepEqual(w.finds, ["React", "hooks"], "the pause's search was the same one");
});

test("S8: \"No matches\"; an empty field searches nothing", async () => {
  const w = await readyPdf();
  w.findAnswer = '{"matches":[],"capped":false}';
  await w.command("find", "zebra");
  assert.equal(textOf(find(w.draw(), "pdf-find-count")), "No matches");
  w.input().text = "  ";
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.deepEqual(w.finds, ["zebra"]);
  assert.equal(find(w.draw(), "pdf-find-count"), null);
});

test("R14, S8: while a search runs, Enter, Next and the pause wait for it: one find, then Enter steps", async () => {
  const w = await readyPdf({ holdFind: true });
  const count = () => textOf(find(w.draw(), "pdf-find-count"));
  await w.command("find");
  w.input().text = "React";
  w.input().handlers.change({}, w.cx);
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.deepEqual(w.finds, ["React"]);
  w.input().handlers.submit({}, w.cx);
  w.input().handlers.submit({ shift: true }, w.cx);
  await w.click("pdf-find-next");
  await w.fire(250);
  await w.command("find", "React");
  assert.deepEqual(w.finds, ["React"], "the running search is the one");
  assert.equal(find(w.draw(), "pdf-find-count"), null, "no count until it answers");
  w.heldFinds.shift()();
  await flush();
  assert.equal(count(), "1 of 3");
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.equal(count(), "2 of 3");
  assert.deepEqual(w.finds, ["React"]);
});

test("R14, S8: new text while a search runs searches the new text; the old answer is dropped", async () => {
  const w = await readyPdf({ holdFind: true });
  await w.command("find", "React");
  w.input().text = "zebra";
  w.input().handlers.submit({}, w.cx);
  await flush();
  assert.deepEqual(w.finds, ["React", "zebra"]);
  w.heldFinds.shift()();
  await flush();
  assert.equal(find(w.draw(), "pdf-find-count"), null, "React's answer isn't zebra's");
  w.findAnswer = '{"matches":[],"capped":false}';
  w.heldFinds.shift()();
  await flush();
  assert.equal(textOf(find(w.draw(), "pdf-find-count")), "No matches");
});

for (const [name, answer] of [
  ["a helper that can't run or ran out of time (exec rejects)", () => { throw new Error("timed out"); }],
  ["a helper cut off", () => ({ code: 137, stdout: "", stderr: "killed" })],
  ["a helper's error", () => ({ code: 2, stdout: '{"error":"unreadable"}\n', stderr: "" })],
  ["an answer that isn't one", () => "garbage"],
]) {
  test(`R14, S8: ${name}: no count, never "No matches", and Enter searches again`, async () => {
    const w = await readyPdf();
    w.findAnswer = answer;
    await w.command("find", "React");
    assert.deepEqual(w.finds, ["React"]);
    assert.equal(find(w.draw(), "pdf-find-count"), null);
    assert.doesNotMatch(textOf(w.draw()), /No matches/);
    w.findAnswer = FOUND;
    w.input().handlers.submit({}, w.cx);
    await flush();
    assert.deepEqual(w.finds, ["React", "React"]);
    assert.equal(textOf(find(w.draw(), "pdf-find-count")), "1 of 3");
  });
}

for (const [name, closeIt] of [
  ["Esc", async (w) => {
    const bar = find(w.draw(), "pdf-find-bar");
    bar.handlers.key_down({ key: "escape", keystroke: "escape", modifiers: {} }, w.cx);
    await flush();
  }],
  ["Close", (w) => w.click("pdf-find-close")],
  ["find-close", (w) => w.command("find-close")],
]) {
  test(`S8: ${name} closes the bar and takes the highlights with it; the keyboard goes back to the pages`, async () => {
    const w = await readyPdf();
    await w.command("find", "React");
    await closeIt(w);
    assert.equal(find(w.draw(), "pdf-find-bar"), null);
    assert.equal(findAll(w.frame(7, 8)[0], (e) => e.calls.absolute && e.calls.bg).length, 0);
    await w.fire(50);
    assert.ok(w.focus.includes("root"));
  });
}

test("S8: other keys in the bar are left alone", async () => {
  const w = await readyPdf();
  await w.command("find", "React");
  find(w.draw(), "pdf-find-bar").handlers.key_down({ key: "a", keystroke: "a", modifiers: {} }, w.cx);
  await flush();
  assert.ok(find(w.draw(), "pdf-find-bar"));
  assert.equal(w.stopped, undefined);
});

test("S8: the Find button opens the bar", async () => {
  const w = await readyPdf();
  await w.click("pdf-find");
  assert.ok(find(w.draw(), "pdf-find-bar"));
});

test("S8: a search asked while loading runs once the pages are there", async () => {
  const w = await openPdf({ holdInfo: true });
  await w.command("find", "React");
  assert.deepEqual(w.finds, []);
  w.held.shift()();
  await flush();
  assert.deepEqual(w.finds, ["React"]);
});

// ── D10: the file changing on disk ───────────────────────────────────────────

test("D10: the file's folder is watched; a change re-reads it under a new key and keeps the page", async () => {
  const w = await readyPdf();
  assert.equal(w.watches[0].dir, "/repo/docs");
  w.frame(4, 7);
  await w.tick();
  w.stat = "1700000099 22222\n";
  await w.batch(["/repo/docs/book.pdf"]);
  assert.equal(w.helperCalls("info").length, 2);
  const key2 = contentKey(FILE, w.stat);
  await w.tick();
  await w.fire(50);
  assert.deepEqual(w.scroll().calls.at(-1), [4, "top"], "the page it was on");
  w.frame(4, 7);
  await w.tick();
  assert.ok(w.renders.at(-1).dir.includes(`/${key2}/`));
  const images = findAll({ kids: w.frame(4, 7), calls: {}, handlers: {} }, (e) => e.kind === "image");
  assert.ok(images.every((e) => e.arg.includes(`/${key2}/`)), "nothing of the old file");
});

test("D10: a change elsewhere in the folder, or one that leaves the key, reads nothing", async () => {
  const w = await readyPdf();
  await w.batch(["/repo/docs/other.pdf"]);
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/stat").length, 1);
  await w.batch(["/repo/docs/book.pdf"]);
  assert.equal(w.execs.filter(([cmd]) => cmd === "/usr/bin/stat").length, 2);
  assert.equal(w.helperCalls("info").length, 1, "same mtime and size: same pages");
});

test("R3, D10: the reader stats the file with -L and a fractional mtime; a same-size rewrite within the second is read again", async () => {
  const w = await readyPdf({ stat: "1794072942.163216795 6661678\n" });
  assert.deepEqual(w.execs.find(([cmd]) => cmd === "/usr/bin/stat"), ["/usr/bin/stat", "-L", "-f", "%Fm %z", FILE]);
  assert.ok(w.list(), "stat's answer loads");
  w.stat = "1794072942.163216796 6661678\n";
  await w.batch([FILE]);
  assert.equal(w.helperCalls("info").length, 2);
});

test("D10: the folder's real path counts too (watchFolder hands out resolved paths)", async () => {
  const w = await readyPdf({ realDir: "/private/repo/docs" });
  w.stat = "1700000099 22222\n";
  await w.batch(["/private/repo/docs/book.pdf"]);
  assert.equal(w.helperCalls("info").length, 2);
});

test("D10: a file in the home folder itself is polled every 10 s instead of watched, as in main.js", async () => {
  const w = await readyPdf({ file: `${HOME}/book.pdf` });
  assert.equal(w.watches.length, 0);
  assert.ok(w.timers.some((t) => t.ms === 10000 && t.repeat));
  w.stat = "1700000099 22222\n";
  await w.fire(10000);
  assert.equal(w.helperCalls("info").length, 2);
});

test("D10: a folder watchFolder refuses is polled instead", async () => {
  const w = await readyPdf({ watchError: "too many directories" });
  assert.ok(w.timers.some((t) => t.ms === 10000 && t.repeat));
});

test("D10: an open search runs again on the new file", async () => {
  const w = await readyPdf();
  await w.command("find", "React");
  w.stat = "1700000099 22222\n";
  await w.batch(["/repo/docs/book.pdf"]);
  assert.deepEqual(w.finds, ["React", "React"]);
});

test("D3: a new key removes the file's older renders", async () => {
  const w = newWorld();
  w.fs[`${APP}/data/code-file/pdf/${contentKey(FILE, "1 2\n")}/s6/p1.png`] = "png";
  w.fs[`${APP}/data/code-file/pdf/${contentKey("/other.pdf", "1 2\n")}/s6/p1.png`] = "png";
  const viewer = new PdfViewer({ file: FILE, doc: "d1", text: () => "", visible: () => true }, w.cx);
  await flush();
  assert.deepEqual(w.removed, [`${APP}/data/code-file/pdf/${contentKey(FILE, "1 2\n")}`]);
  viewer.release();
});

// ── Closing ──────────────────────────────────────────────────────────────────

test("release() stops the timers and frees the handles; nothing redraws after it", async () => {
  const w = await readyPdf();
  await w.command("find", "React");
  w.viewer.release();
  assert.ok(w.timers.filter((t) => t.repeat).every((t) => t.cancelled));
  assert.equal(w.scroll().released, true);
  assert.equal(w.input().released, true);
  const before = w.notifies;
  w.stat = "1700000099 22222\n";
  await w.batch(["/repo/docs/book.pdf"]);
  assert.equal(w.notifies, before);
  assert.equal(w.helperCalls("info").length, 1);
});
