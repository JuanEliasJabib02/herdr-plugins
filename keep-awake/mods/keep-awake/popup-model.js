// The cup and its popup, in numbers, and the loop copy's tick (plan D6, D8,
// D9): which copy runs the loop, what the cell and the popup say, where the
// popup opens and how tall, what a click in it does. Pure: no "herdr" import.
// main.js hands it shared(), terminals(), window(), settings(), the window's
// size and the cell's bounds; the tests drive it alone. The pattern is
// agent-sleep's panel-model.js (anchorFrom, overlayAt, zoomOf, moonBounds,
// closedJustNow).
//
// Units: a press's e.bounds and `at` are window px; an overlay's width and
// height are layout px, which Herdr multiplies by the zoom.

import { MODE_KEY, MODES, TITLE, parseMode, modeLabel, isActive, statusText, tooltip, canKeepAwake } from "./model.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// This mod's folder under mods/, and its icon (Lucide's coffee).
export const MOD = "keep-awake";
export const COFFEE = "mods/keep-awake/icons/coffee.svg";

// Shared values: what the loop copy found at its last tick (the popup's
// status), and when the popup last closed (the click guard below).
export const VIEW_KEY = "keep-awake.view";
export const CLOSED_KEY = "keep-awake.popup-closed";

// ── Which copy runs the loop (D6) ──────────────────────────────────────────

// The loop copy ticks every TICK_MS. One made before Herdr's window (Herdr
// opening on a layout does that) looks for it every WINDOW_LOOK_MS and starts
// once it is there; herdr-app check's never gets one, so it only looks.
export const TICK_MS = 1000;
export const WINDOW_LOOK_MS = 250;

// The cup in the status row: the copy with no view and no overlay. The popup
// (`{ view: "popup" }`, an overlay) and any other copy only draw.
export function isLoopCopy(props) {
  return !(isObject(props) && (props.view || props.overlay));
}

// Starts the tick in the loop copy only. `timer` is cx.timer; `onTick(cx)`
// gets each call's own cx. True when it started.
export function startLoop(props, timer, onTick) {
  if (!isLoopCopy(props)) return false;
  timer.every(TICK_MS, onTick);
  return true;
}

// ── The loop copy's tick (S1, D5, D6, D7) ──────────────────────────────────

// Each tick reads the mode and Core's terminals, tells the holder (holder.js)
// whether the Mac should be kept awake, and keeps what it answered: `last`,
// `{ mode, active }`, Active being whether a caffeinate is held now. It
// resolves to that view when it changed since the one before, else null:
// main.js shares it and redraws only then (Herdr's idle CPU), since
// setShared re-renders every mod in every window.
//
//   new Loop({ holder, live: { mode() → shared(MODE_KEY), terminals(), window() } })
export class Loop {
  constructor({ holder, live }) {
    this.holder = holder;
    this.live = live;
    this.last = null;
    this.published = null; // the JSON of the last view tick() resolved to
    this.closed = false;
  }

  async tick(now) {
    if (this.closed) return null;
    const mode = parseMode(this.live.mode());
    const wanted = canKeepAwake(this.live.window()) && isActive(mode, this.live.terminals());
    const active = (await this.holder.tick(wanted, now)) === true;
    // A tick that ended after close(): what it found is no one's to share.
    if (this.closed) return null;
    const view = { mode, active };
    this.last = view;
    const json = JSON.stringify(view);
    if (json === this.published) return null;
    this.published = json;
    return view;
  }

  // For the cell's close() (D7): the caffeinate it holds goes, and nothing
  // ticks again. Another window's copy starts one at its next liveness check.
  async release() {
    this.closed = true;
    await this.holder.release();
  }
}

// ── What the cup and the popup say (S2, S3, S4, D8) ────────────────────────

// The mode set now, and whether the Mac is held awake. Orca's
// CaffeinateStatusSegment: the loop's last tick says, while it was for this
// same mode; right after a change, until the next tick, On reads Active and
// the others Inactive.
export function shown(mode, last) {
  const m = parseMode(mode);
  const same = isObject(last) && last.mode === m;
  return { mode: m, active: same ? last.active === true : m === "on" };
}

// The cup: its label ("On"), whether its dot is bright, and its tooltip.
export function cellModel(mode, last) {
  const s = shown(mode, last);
  const status = statusText(s.mode, s.active);
  return { label: modeLabel(s.mode), active: s.active, status, tooltip: tooltip(status) };
}

// The popup: the title, the status at its right, and one row per mode with
// the dot on the chosen one.
export function popupModel(mode, last) {
  const s = shown(mode, last);
  return {
    title: TITLE,
    status: statusText(s.mode, s.active),
    rows: MODES.map((m) => ({ value: m.value, label: m.label, description: m.description, chosen: m.value === s.mode })),
  };
}

// A row's click (D9): the mode for every window's copy (shared.json keeps
// it), then the popup closes. Set first: what a closed copy starts may not run.
export function choose(value, { overlay, setShared, closeOverlay }) {
  setShared(MODE_KEY, parseMode(value));
  if (overlay) closeOverlay(overlay);
}

// ── Where it opens (S4, D9) ────────────────────────────────────────────────

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

// The cup's cell when a press gave no bounds: where projects-sidebar's
// status row puts it (projects.json, pinned by test/smoke.test.js), 64 px
// wide right before agent-sleep's 40 px moon, the row 28 px tall, at the
// window's bottom. In window px: layout px times the zoom. Null without a
// window size.
export const CELL = Object.freeze({ width: 64, height: 28, right: 40 });

export function cellBounds(viewport, zoom = 1) {
  if (![viewport?.width, viewport?.height].every(isNumber)) return null;
  const z = isNumber(zoom) && zoom > 0 ? zoom : 1;
  const width = CELL.width * z;
  const height = CELL.height * z;
  return { x: viewport.width - CELL.right * z - width, y: viewport.height - height, width, height };
}

// ── How tall ───────────────────────────────────────────────────────────────

// views/popup.js draws each part this tall, so the popup opens exactly so; it
// has three rows whatever the mode, so its height never changes (an open
// popup can't resize).
// A row is 44: the label's 16 px line, 1 px, the description's 14 px line, and
// the rest as space around them. Without set lines the two texts took Herdr's
// default line height and filled the row, touching the next one.
export const POPUP = Object.freeze({ width: 264, frame: 4, padY: 4, header: 30, separator: 1, separatorGap: 4, row: 44, labelLine: 16, descriptionLine: 14 });

export function popupHeight() {
  return POPUP.frame + 2 * POPUP.padY + POPUP.header + POPUP.separator + 2 * POPUP.separatorGap + MODES.length * POPUP.row;
}

// openOverlay's argument. No anchor: it opens at the pointer.
export function popupSpec({ anchor, zoom = 1 } = {}) {
  const size = { width: POPUP.width, height: popupHeight() };
  const at = overlayAt(anchor, size, zoom);
  return { mod: MOD, kind: "popup", width: size.width, height: size.height, ...(at ? { at } : {}), props: { view: "popup" } };
}

// ── The click guard (D9) ───────────────────────────────────────────────────

// A press beside the popup closes it and may reach the cup too: the popup
// marks when it closed, and the click that press ends doesn't open it again,
// however long the button is held. So it goes by the press (`pressedAt`, or
// `now` with none): closed after it, or just before it reached the cup. A
// time ahead of the clock isn't "just now": the cup must open.
export const CLOSE_GUARD_MS = 400;

export function closedJustNow(closedAt, now, pressedAt = now) {
  if (!isNumber(closedAt) || closedAt > now) return false;
  return closedAt > pressedAt - CLOSE_GUARD_MS;
}
