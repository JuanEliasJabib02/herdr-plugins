// The PDF reader's arithmetic (plan lector-md T3, T5: S7, S8, S9; D3–D6, D10): zoom,
// the pages as the list's rows, what to render and how sharp, the helper's answers,
// find's navigation. No herdr or gpui-kit imports.

import { hashPath } from "./draft-model.js";

// Orca's strings (S7, S8, S9). The loading line is READER_TEXT's.
export const PDF_TEXT = Object.freeze({
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
  // D4: pages come from a helper swiftc builds on first use.
  noSwift: "Showing PDFs needs Apple's Swift compiler: run xcode-select --install",
});

// "1 of 3"; a capped search (the helper stops at 5000) says there are more.
export const matchLabel = (current, total, capped = false) =>
  total > 0 ? `${current} of ${total}${capped ? "+" : ""}` : PDF_TEXT.noMatches;

// ── Zoom (S7) ────────────────────────────────────────────────────────────────

// pdf.js: 100% is one PDF point at 4/3 CSS px.
export const PX_PER_PT = 4 / 3;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 1.25;
// pdf.js's SCROLLBAR_PADDING: what fit to width leaves of the pane.
export const FIT_PADDING = 40;

const EPS = 1e-9;

export const clampZoom = (zoom) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

// Steps multiply, so a long walk drifts: kept to six decimals.
const tidy = (zoom) => Math.round(zoom * 1e6) / 1e6;

export const widestPage = (sizes) => sizes.reduce((widest, [w]) => Math.max(widest, w), 0);

// The widest page fills the pane, so at fit no page needs a sideways scroll.
// Before the pane has a width there's nothing to fit: 100%.
export function fitZoom(width, sizes) {
  const widest = widestPage(sizes);
  if (!(width > 0) || !(widest > 0)) return 1;
  return clampZoom((width - FIT_PADDING) / (widest * PX_PER_PT));
}

// `direction` 1 in, -1 out, from wherever it is (fit included), as Orca.
export const stepZoom = (zoom, direction) => tidy(clampZoom(direction > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP));

export const canZoomIn = (zoom) => zoom < MAX_ZOOM - EPS;
export const canZoomOut = (zoom) => zoom > MIN_ZOOM + EPS;
export const zoomLabel = (zoom) => `${Math.round(zoom * 100)}%`;

// ── The pages as rows (D5) ───────────────────────────────────────────────────

// pdf.js leaves 10 px between pages; the same above the first and below the last.
export const PAGE_GAP = 10;
// A page is drawn as strips of this height, each a row of the virtual list, so a
// jump (a find match, the reading place after a zoom) can land inside a page:
// VirtualListScrollHandle only scrolls to an item.
export const STRIP = 256;

// Every page at one scale (px per point), in whole pixels so the strips add up.
// rows[r] = { page, top, height }: the slice [top, top + height) of that page.
// heights[r] is the row's, its gaps included.
export function pageLayout(sizes, zoom) {
  const scale = zoom * PX_PER_PT;
  const pages = [];
  const rows = [];
  const heights = [];
  let widest = 0;
  for (let i = 0; i < sizes.length; i++) {
    const width = Math.max(1, Math.round(sizes[i][0] * scale));
    const height = Math.max(1, Math.round(sizes[i][1] * scale));
    widest = Math.max(widest, width);
    const firstRow = rows.length;
    for (let top = 0; top < height; top += STRIP) {
      const slice = Math.min(STRIP, height - top);
      rows.push({ page: i, top, height: slice });
      heights.push(slice + (top === 0 ? PAGE_GAP : 0));
    }
    pages.push({ width, height, firstRow, rows: rows.length - firstRow });
  }
  if (heights.length > 0) heights[heights.length - 1] += PAGE_GAP;
  return { zoom, scale, pages, rows, heights, widest, contentWidth: widest + FIT_PADDING };
}

// The row showing `y` px below the top of `page`.
export function rowAt(layout, page, y) {
  const p = layout.pages[page];
  const strip = Math.floor(Math.max(0, y) / STRIP);
  return p.firstRow + Math.min(p.rows - 1, strip);
}

const firstRowOf = (layout, range) =>
  range && layout.rows.length > 0 ? layout.rows[Math.min(Math.max(0, range.start), layout.rows.length - 1)] : null;

// The page at the top of the visible range (the list says nothing finer).
export const currentPage = (layout, range) => firstRowOf(layout, range)?.page ?? 0;

// Where the reader is, as a page and how far down it, to find again at another zoom.
export function anchorOf(layout, range) {
  const row = firstRowOf(layout, range);
  if (!row) return null;
  return { page: row.page, fraction: row.top / layout.pages[row.page].height };
}

export const rowOfAnchor = (layout, anchor) => rowAt(layout, anchor.page, anchor.fraction * layout.pages[anchor.page].height);

// VirtualListScrollHandle's "top" brings a row below the view only to its bottom
// edge (the near one): a jump goes first to the nearest row after `row` whose bottom
// is more than `view` px below row's top, which leaves `row` above the view, and
// "top" then brings it down to the top edge (L1). None that far, or no height yet:
// the last row, from where the end of the list is as high as `row` can go.
export function rowPast(layout, row, view) {
  const last = layout.heights.length - 1;
  if (!(view > 0)) return last;
  let below = layout.heights[row];
  for (let r = row + 1; r <= last; r++) {
    below += layout.heights[r];
    if (below > view) return r;
  }
  return last;
}

// At fit the widest page is rounded to whole pixels, half a pixel past a fractional
// pane (960.6) at most: only a whole pixel more is a sideways scroll (R12).
export const scrollsSideways = (layout, width) => layout.contentWidth - width >= 1;

// ── Rendering (D6) ───────────────────────────────────────────────────────────

// Steps per doubling of the render scale: a pane a little wider reuses the files.
const LADDER = 4;
// One page's bitmap at most: past it, deep zooms are drawn from a smaller one.
export const MAX_RENDER_PIXELS = 4096 * 4096;
export const RENDER_MARGIN = 2;
export const RENDER_BATCH = 10;

// Px per point to render at: what's shown × `density` (Retina), rounded up to the
// ladder and kept under MAX_RENDER_PIXELS for the document's biggest page. The tag
// names the bucket in the cache's paths.
export function renderScale(shownScale, sizes, density = 2) {
  let k = Math.ceil(Math.log2(shownScale * density) * LADDER - EPS);
  const area = sizes.reduce((most, [w, h]) => Math.max(most, w * h), 0);
  if (area > 0) k = Math.min(k, Math.floor(Math.log2(Math.sqrt(MAX_RENDER_PIXELS / area)) * LADDER + EPS));
  return { scale: 2 ** (k / LADDER), tag: `s${k}` };
}

// The visible pages and RENDER_MARGIN on each side that `have` lacks: the visible
// ones first, then outwards; at most RENDER_BATCH for one exec.
export function pagesToRender(layout, range, have) {
  if (!range || range.end <= range.start || layout.rows.length === 0) return [];
  const last = layout.rows.length - 1;
  const first = layout.rows[Math.min(range.start, last)].page;
  const end = layout.rows[Math.min(range.end - 1, last)].page;
  const out = [];
  const add = (i) => {
    if (i >= 0 && i < layout.pages.length && !have.has(i)) out.push(i);
  };
  for (let i = first; i <= end; i++) add(i);
  for (let d = 1; d <= RENDER_MARGIN; d++) {
    add(end + d);
    add(first - d);
  }
  return out.slice(0, RENDER_BATCH);
}

// ── The helper's answers (D4) ────────────────────────────────────────────────

const parse = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// { pages, sizes: [[w, h]] } in points, or { error: "locked" | "failed" }.
export function parseInfo(stdout) {
  const v = parse(stdout);
  if (v?.error === "locked") return { error: "locked" };
  if (!v || !Number.isInteger(v.pages) || v.pages < 1 || !Array.isArray(v.sizes) || v.sizes.length !== v.pages) return { error: "failed" };
  if (!v.sizes.every((s) => Array.isArray(s) && positive(s[0]) && positive(s[1]))) return { error: "failed" };
  return { pages: v.pages, sizes: v.sizes.map(([w, h]) => [w, h]) };
}

// The page numbers render wrote, as indexes.
export function parseRendered(stdout, count) {
  const done = parse(stdout)?.done;
  if (!Array.isArray(done)) return [];
  return done.filter((n) => Number.isInteger(n) && n >= 1 && n <= count).map((n) => n - 1);
}

// { matches: [{ page (index), rects: [[x, y, w, h]] points, top-left }], capped }, or
// null when the answer isn't one.
export function parseMatches(stdout, count) {
  const v = parse(stdout);
  if (!v || !Array.isArray(v.matches)) return null;
  const matches = [];
  for (const m of v.matches) {
    if (!Number.isInteger(m?.page) || m.page < 1 || m.page > count || !Array.isArray(m.rects)) continue;
    const rects = m.rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)));
    if (rects.length > 0) matches.push({ page: m.page - 1, rects });
  }
  return { matches, capped: v.capped === true };
}

// ── Find (S8) ────────────────────────────────────────────────────────────────

// As pdf.js: from the page being read, else back to the first.
export function firstMatchFrom(matches, page) {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.page >= page);
  return i === -1 ? 0 : i;
}

// Next (1) or previous (-1), wrapping; from none, the first or the last.
export function stepMatch(current, total, direction) {
  if (total <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : total - 1;
  return (((current + direction) % total) + total) % total;
}

// page → the indexes of its matches.
export function matchesByPage(matches) {
  const out = new Map();
  matches.forEach((m, i) => {
    if (!out.has(m.page)) out.set(m.page, []);
    out.get(m.page).push(i);
  });
  return out;
}

// Rects in points to pixels of the strip starting `top` px down the page, `height`
// tall; the ones that miss it are left out (the strip clips the rest).
export function stripRects(rects, scale, top, height) {
  const out = [];
  for (const [x, y, w, h] of rects) {
    const box = [x * scale, y * scale - top, w * scale, h * scale];
    if (box[1] + box[3] <= 0 || box[1] >= height) continue;
    out.push(box);
  }
  return out;
}

// The row of the middle of a match's first line.
export function matchRow(layout, match) {
  const [, y, , h] = match.rects[0];
  return rowAt(layout, match.page, (y + h / 2) * layout.scale);
}

// ── The cache on disk (D3, D4, D10) ──────────────────────────────────────────

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

// What `/usr/bin/stat` is asked: through a symlink to the file it names (-L), the
// mtime with its fraction (%Fm, nanoseconds on APFS) and the size (R3).
export const statArgs = (path) => ["-L", "-f", "%Fm %z", path];

// `<hash of the path>-<hash of path, mtime and size>` from statArgs' answer
// ("1794072942.163216795 6661678"): a changed file gets new names, and the path's
// older keys can be found.
export function contentKey(path, statOut) {
  const m = /^(\d+(?:\.\d+)?) (\d+)\s*$/.exec(String(statOut ?? ""));
  if (!m) return null;
  return `${hashPath(path)}-${hashPath(`${path}\n${m[1]}\n${m[2]}`)}`;
}

export function staleKeys(names, key) {
  const prefix = `${key.slice(0, key.indexOf("-"))}-`;
  return names.filter((n) => n !== key && n.startsWith(prefix));
}

export const helperSource = (appHome) => `${trimSlash(String(appHome))}/mods/code-file/pdfpages.swift`;
export const binDir = (appHome) => `${trimSlash(String(appHome))}/data/code-file/bin`;
export const binName = (source) => `pdfpages-${hashPath(source)}`;
export const cacheRoot = (appHome) => `${trimSlash(String(appHome))}/data/code-file/pdf`;
export const pageDir = (appHome, key, tag) => `${cacheRoot(appHome)}/${key}/${tag}`;
// What image() takes: a path relative to the Herdr home (D3).
export const pageImage = (key, tag, page) => `data/code-file/pdf/${key}/${tag}/p${page + 1}.png`;
