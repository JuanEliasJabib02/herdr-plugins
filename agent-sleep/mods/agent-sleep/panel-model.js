// The moon and its popup, in numbers (S12, D14): where the popup opens, how
// tall, the moon's color, and what the popup leaves in shared. Pure: main.js
// passes it settings(), the window's size and the cell's bounds. The pattern is
// claude-accounts' footer (footer-model.js overlayAt, zoomOf, moonBounds).
//
// Units: on_size_change, a press's e.bounds and `at` are window px; an overlay's
// width and height are layout px, which Herdr multiplies by the zoom.

import { MOD } from "./coordinator.js";
import { DEFAULT_SETTINGS } from "./store.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const text = (v) => (typeof v === "string" ? v : null);

// When the popup last closed, in shared (the toggle guard below).
export const CLOSED_KEY = "agent-sleep.panel-closed";

// ── Where it opens ─────────────────────────────────────────────────────────

const GAP = 8;
const MARGIN = 8;
const round1 = (v) => Math.round(v * 10) / 10;

// The cell's bounds → { x, y, limit }: its left, its top, its right edge.
export function anchorFrom(bounds) {
  if (![bounds?.x, bounds?.y, bounds?.width].every(isNumber)) return null;
  return { x: bounds.x, y: bounds.y, limit: bounds.x + bounds.width };
}

// Above the anchor, GAP over it, kept MARGIN inside its right edge and the
// window's left. Null without an anchor (the overlay opens at the pointer).
export function overlayAt(anchor, size, zoom = 1) {
  if (!isObject(anchor) || ![anchor.x, anchor.y, anchor.limit].every(isNumber)) return null;
  const z = isNumber(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.max(MARGIN * z, Math.min(anchor.x, anchor.limit - (size.width + MARGIN) * z));
  const y = Math.max(0, anchor.y - (size.height + GAP) * z);
  return { x: round1(x), y: round1(y) };
}

// The app's zoom, 1 when it says nothing.
export function zoomOf(settings) {
  const z = Number(settings?.zoom);
  return z > 0 ? z : 1;
}

// The moon's cell before any press gave it: the status row's last cell, so at
// the window's bottom right. The layout fixes its size (projects.json, pinned
// by test/smoke.test.js), and a fixed cell gets no size event to learn it from.
// In window px: the cell's layout px times the zoom. Null without a window size.
export const MOON_CELL = Object.freeze({ width: 40, height: 28 });

export function moonBounds(viewport, zoom = 1) {
  if (![viewport?.width, viewport?.height].every(isNumber)) return null;
  const width = MOON_CELL.width * zoom;
  const height = MOON_CELL.height * zoom;
  return { x: viewport.width - width, y: viewport.height - height, width, height };
}

// ── How tall ───────────────────────────────────────────────────────────────

// views/panel.js draws each part this tall, so the popup opens exactly so.
export const PANEL = Object.freeze({
  width: 280, frame: 4, padX: 12, padY: 10, gap: 6, headline: 20, row: 24, line: 18, lineGap: 3, buttons: 24, maxLines: 6,
});

// What the loop copy shared under VIEW_KEY (Coordinator view()), or an empty
// panel while it hasn't yet: the first second after a start, or an old value.
export function panelView(raw) {
  const v = isObject(raw) ? raw : {};
  return {
    headline: text(v.headline) ?? "Agent sleep",
    next: text(v.next),
    last: text(v.last),
    holds: Array.isArray(v.holds) ? v.holds.filter((h) => typeof h === "string") : [],
    debug: text(v.debug),
    asleep: Number.isInteger(v.asleep) ? v.asleep : 0,
    settings: { ...DEFAULT_SETTINGS, ...(isObject(v.settings) ? v.settings : {}) },
  };
}

// The lines between the rows and the buttons. debug has none: it is the
// headline's tooltip.
export function panelLines(view) {
  const v = panelView(view);
  return v.holds.length + (v.next ? 1 : 0) + (v.last ? 1 : 0);
}

// From the lines at open, up to maxLines, with `last`'s line always counted:
// it is what Sleep now and Wake all report. An open popup can't change its
// size: any other line that appears later clips in the text area, never over
// the buttons.
export function panelHeight(view) {
  const lines = Math.min(panelLines(view) + (panelView(view).last ? 0 : 1), PANEL.maxLines);
  const area = lines * PANEL.line + Math.max(0, lines - 1) * PANEL.lineGap;
  return PANEL.frame + 2 * PANEL.padY + PANEL.headline + 2 * PANEL.row + area + PANEL.buttons + 4 * PANEL.gap;
}

// openOverlay's argument. `owner`: the loop copy its clicks ask (makeRequest).
// No anchor: it opens at the pointer.
export function panelSpec({ view, anchor, zoom = 1, owner = null } = {}) {
  const size = { width: PANEL.width, height: panelHeight(view) };
  const at = overlayAt(anchor, size, zoom);
  return { mod: MOD, kind: "popup", width: size.width, height: size.height, ...(at ? { at } : {}), props: { view: "panel", owner } };
}

// ── The moon ───────────────────────────────────────────────────────────────

// Its color, a key of theme(): dim off, muted on, accent with something asleep.
export function moonTone({ enabled, asleep }) {
  if (asleep > 0) return "accent";
  return enabled ? "muted" : "dim";
}

// A press beside the popup closes it and may reach the moon too: the popup
// marks when it closed, and the click that press ends doesn't open it again,
// however long the button is held. So it goes by the press (`pressedAt`, or
// `now` with none): closed after it, or just before it reached the moon. A time
// ahead of the clock isn't "just now": the moon must open.
export const CLOSE_GUARD_MS = 400;

export function closedJustNow(closedAt, now, pressedAt = now) {
  if (!isNumber(closedAt) || closedAt > now) return false;
  return closedAt > pressedAt - CLOSE_GUARD_MS;
}

// ── What the popup asks ────────────────────────────────────────────────────

// What a click leaves under REQUEST_KEY for the loop copy that opened this
// popup (Coordinator takeRequest). The counter keeps two clicks in one
// millisecond apart.
let requests = 0;

export function makeRequest(command, now, owner) {
  requests += 1;
  return { id: `${now}-${requests}`, owner, command };
}
