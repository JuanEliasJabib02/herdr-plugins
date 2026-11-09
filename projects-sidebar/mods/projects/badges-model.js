// Indicators from other plugins ("badges", D38), with no herdr or gpui-kit
// imports so `node --test` can load it. This plugin knows no plugin: it
// reads what they publish under config.js BADGE_KEYS, draws it after a
// workspace row's label, or a task lane header's (tree.js), and runs its
// action on a click. The contract other plugins consume is RECIPE.md
// "Badges from other plugins"; it only grows (a breaking change gets a new
// key, e.g. badges.spotlight.v2).
//
//   each key:  { [workspacePath | laneKey]: [badge] }
//              workspacePath: absolute, as `git worktree list` prints it
//              laneKey: `<groupId>/task:<KEY>`, a Task-mode lane of that
//              group, `task:<KEY>` exactly as task-model.js builds it
//              (Spotlight's D29)
//   a badge:   { icon?, text?, tone?, tooltip?, action?, spin?, reveal?,
//                pill?, dot?, hover?, bar?, line?, disabled?, look? }
//   action:    { command: "<mod>.<command>" } | { exec: [program, ...args] }
//              (<mod> is the key's first name after `badges.`: its own commands)
//   spin:      true turns the badge's icon (a busy mark)
//   reveal:    "hover" shows it only while its row is hovered, keeping its
//              place; "grow" also opens its width (Spotlight's D39)
//   pill:      true draws it as an outlined pill with uppercase text
//   dot:       "on" | "off", a server dot: filled, or a hollow ring
//   hover:     a tone the badge's chip and color take on hover
//   bar:       a tone: its row draws Orca's 3 px bar at its left edge
//              (Spotlight's D42; the row's first badge carrying one wins)
//   line:      2 puts it on a second line under the row's label, at its
//              right; that row grows to 42 px (a lane header keeps one line)
//   disabled:  true draws it at half opacity, inert: its action is dropped
//   look:      "secondary" | "outline" beside pill: true, Orca's filled
//              neutral badge or its outlined one, the text in its own case
//
// Anything else is dropped field by field: a bad icon or action goes and the
// badge stays; a badge left with neither icon nor text goes; a value that
// isn't an object is no badges at all. Never throws.
//
// The field validators (iconOf, textOf, actionOf, publisherOf) are exported:
// menus-model.js checks plugins' workspace menu items (`menus.*`, Spotlight's
// D30) with them, so an item's action follows a badge's rules.
//
// The look (Spotlight's D39, Orca's sidebar buttons; its D42, Orca's cards)
// is pure functions too, below the parse: the chip, the pill, the reveal,
// the dot, the widths, the lines and the bar. tree.js only applies them.

import { BADGE_KEYS } from "./config.js";
import { normPath, isAbsolute, noteKeyOf } from "./lib.js";

export const BADGE_TONES = ["accent", "dim", "working", "blocked", "done"];
const DEFAULT_TONE = "dim";
// The values `reveal` and `dot` take (Spotlight's D39), and a pill's `look`
// (its D42: Orca's Badge variants).
const REVEALS = ["hover", "grow"];
const DOTS = ["on", "off"];
const LOOKS = ["secondary", "outline"];

// Caps, in code points for the strings. Four per plugin so Spotlight's lit
// root row (its pill, port, logs and X) leaves another plugin a place
// (Spotlight's D39); the row's width may still run out before the cap does.
const PER_PLUGIN = 4; // badges per plugin on one row
const PER_ROW = 5; // badges on one row, all plugins
const TEXT_MAX = 16;
const TOOLTIP_MAX = 200;
const ARGV_MAX = 20; // strings in an exec argv
const ARG_MAX = 500; // chars in each

// A mod command, as Herdr names them: "<mod>.<command>".
const COMMAND = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s, max) => [...s].slice(0, max).join("");

// mods/<mod>/…/<name>.svg under Herdr's home: no `..`, no empty segment, no
// backslash (a separator on Windows).
export function iconOf(icon) {
  if (typeof icon !== "string" || icon.includes("\\")) return null;
  const parts = icon.split("/");
  if (parts.length < 3 || parts[0] !== "mods") return null;
  if (parts.some((p) => p === "" || p === "..")) return null;
  return /.\.svg$/.test(parts.at(-1)) ? icon : null;
}

// One line: runs of whitespace (newlines too) as one space, trimmed, at most
// `max` code points (a badge's 16 unless told: a menu item's text takes 40).
export function textOf(text, max = TEXT_MAX) {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line ? cut(line, max) : null;
}

// One line too, like textOf, so what a click runs (badgeTooltip puts it
// after the tooltip) stays in view.
function tooltipOf(tooltip) {
  if (typeof tooltip !== "string") return null;
  const line = tooltip.replace(/\s+/g, " ").trim();
  return line ? cut(line, TOOLTIP_MAX) : null;
}

// argv[0] runs as given: a bare name is looked up on Herdr's PATH, an
// absolute path is that file. A relative path (./x, bin/x) would run a file
// from whatever branch the workspace has checked out, so it's refused.
const programOk = (p) => p !== "" && (p.startsWith("/") || !p.includes("/"));

// The keys a plugin publishes under, badges and workspace menu items (D30).
const PUBLISHED = ["badges.", "menus."];

// The plugin that published under `key`: the name right after `badges.` or
// `menus.` (badges.spotlight, badges.spotlight.v2 and menus.spotlight are
// all spotlight's). null for any other key, which then runs no command.
export function publisherOf(key) {
  if (typeof key !== "string") return null;
  const prefix = PUBLISHED.find((p) => key.startsWith(p));
  return prefix ? key.slice(prefix.length).split(".")[0] || null : null;
}

// `run` also runs Herdr's own commands (app.quit, window.close, app.reset…),
// so a command must be its publisher's: the part before its first `.` is
// the publisher's name. Any other command drops the action.
const ownCommand = (command, publisher) =>
  typeof command === "string" && COMMAND.test(command) && publisher !== null && command.split(".")[0] === publisher;

// A badge's (or a menu item's) action, or null: `publisher` is publisherOf
// the key it came under.
export function actionOf(action, publisher) {
  if (!isObject(action)) return null;
  const { command, exec } = action;
  if (command !== undefined && exec !== undefined) return null;
  if (command !== undefined) return ownCommand(command, publisher) ? { command } : null;
  if (!Array.isArray(exec) || exec.length < 1 || exec.length > ARGV_MAX) return null;
  if (!exec.every((a) => typeof a === "string" && a.length <= ARG_MAX && !a.includes("\0"))) return null;
  return programOk(exec[0]) ? { exec: [...exec] } : null;
}

// One badge, or null when it has neither icon nor text. `key` and `index`
// (its place among that plugin's badges on the row) say which badge a click
// is on. `spin`, `pill` and `disabled` are kept only as `true` and `line`
// only as 2: the other value is the default, anything else is dropped alone;
// so are a `reveal` or `dot` that isn't one of theirs, a `hover` or `bar`
// that isn't a tone, and a `look` that isn't one of LOOKS or comes without
// `pill: true`. A disabled badge loses its action (Spotlight's D42: it is
// published with none, so an older reader draws it inert too).
function badgeOf(raw, key, index) {
  if (!isObject(raw)) return null;
  const icon = iconOf(raw.icon);
  const text = textOf(raw.text);
  if (!icon && !text) return null;
  const tooltip = tooltipOf(raw.tooltip);
  const disabled = raw.disabled === true;
  const action = disabled ? null : actionOf(raw.action, publisherOf(key));
  const pill = raw.pill === true;
  return {
    key,
    index,
    ...(icon ? { icon } : {}),
    ...(text ? { text } : {}),
    tone: BADGE_TONES.includes(raw.tone) ? raw.tone : DEFAULT_TONE,
    ...(tooltip ? { tooltip } : {}),
    ...(action ? { action } : {}),
    ...(raw.spin === true ? { spin: true } : {}),
    ...(REVEALS.includes(raw.reveal) ? { reveal: raw.reveal } : {}),
    ...(pill ? { pill: true } : {}),
    ...(DOTS.includes(raw.dot) ? { dot: raw.dot } : {}),
    ...(BADGE_TONES.includes(raw.hover) ? { hover: raw.hover } : {}),
    ...(BADGE_TONES.includes(raw.bar) ? { bar: raw.bar } : {}),
    ...(raw.line === 2 ? { line: 2 } : {}),
    ...(disabled ? { disabled: true } : {}),
    ...(pill && LOOKS.includes(raw.look) ? { look: raw.look } : {}),
  };
}

// ── Lane keys (Spotlight's D29) ─────────────────────────────────────────────

const LANE = "/task:";

// The key a task lane's badges are published and looked up under: its
// group's id, then the lane as task-model.js builds it ("task:AX-3356", a
// ticket prefix uppercased with a dash; "task:login", a name lowercased).
// tree.js draws the active group's lanes only, so another group's lane of
// the same name never shows them.
export const laneBadgeKey = (groupId, lane) => `${groupId}/${lane}`;

// Whether `at` is a lane key: not absolute (that is a path), a group id
// before its first "/task:", and after it a lane that can name a task
// (lib.js noteKeyOf: not "task:" alone, nor No task's "task:none", nor a
// name over 200 chars or special on a plain object). Read as written, never
// respelled: a key in another form than the tree's is kept and matches no
// lane.
function isLaneKey(at) {
  if (typeof at !== "string" || isAbsolute(at)) return false;
  const cut = at.indexOf(LANE);
  return cut > 0 && noteKeyOf(at.slice(cut + 1)) !== null;
}

// The row a value's key puts its badges on: a path, normalized; a lane key
// as it is; or null for any other key.
function rowOf(at) {
  if (isAbsolute(at)) return normPath(at);
  return isLaneKey(at) ? at : null;
}

// Every row's badges: { [workspacePath | laneKey]: [badge] }, each row's in
// key order (BADGE_KEYS'), at most 4 per plugin and 5 in all; a lane header
// is a row with its own caps. `values`: the keys' shared() values, in that
// order (store.js badges()).
export function parseBadges(values, keys = BADGE_KEYS) {
  const rows = {};
  if (!Array.isArray(values)) return rows;
  values.forEach((value, i) => {
    if (!isObject(value)) return;
    const key = keys[i] ?? String(i);
    const mine = new Map(); // row -> this plugin's badges on it
    for (const [at, list] of Object.entries(value)) {
      const target = rowOf(at);
      if (target === null || !Array.isArray(list)) continue;
      const kept = mine.get(target) ?? [];
      for (const raw of list) {
        if (kept.length >= PER_PLUGIN) break;
        const b = badgeOf(raw, key, kept.length);
        if (b) kept.push(b);
      }
      mine.set(target, kept);
    }
    for (const [target, kept] of mine) {
      const row = rows[target] ?? [];
      const room = PER_ROW - row.length;
      if (room <= 0 || !kept.length) continue;
      rows[target] = [...row, ...kept.slice(0, room)];
    }
  });
  return rows;
}

// What a badge's hover says: its tooltip, then what a click runs, so a
// click never runs something unnamed. A disabled badge runs nothing
// (Spotlight's D42): its tooltip alone. null when there is nothing to say.
export function badgeTooltip(badge) {
  const a = badge?.disabled ? null : badge?.action;
  const runs = a?.exec ? `runs ${a.exec[0]}` : a?.command ?? null;
  return [badge?.tooltip, runs].filter(Boolean).join(" · ") || null;
}

// The row's badges share BADGE_ROOM px; one text badge alone gets at most
// BADGE_W. badgeMaxWidth is the share of each of `count` text badges.
export const BADGE_ROOM = 128;
export const BADGE_GAP = 4;
const BADGE_W = 72;
export const badgeMaxWidth = (count) => Math.min(BADGE_W, Math.floor((BADGE_ROOM - BADGE_GAP * (Math.max(count, 1) - 1)) / Math.max(count, 1)));

// ── The look (Spotlight's D39: Orca's sidebar buttons) ─────────────────────

// A badge with an action is a button BADGE_BOX px tall, and an icon-only
// badge is that wide (Orca's `size-4`).
export const BADGE_BOX = 16;
// How opacity and width move (a reveal, a grow): Orca's Tailwind 4 timing.
// Hover colors change at once: Herdr's transition moves only opacity, width,
// height, left and top.
export const BADGE_MOTION = Object.freeze({ duration: 150, easing: "ease-in-out" });
// A pill's text, in px (Orca's `text-[10px]`), and its padding: the dim tag's
// `px-1`, the tone chip's `px-1.5`.
const PILL_TEXT = 10;
const TAG_PX = 4;
const CHIP_PX = 6;
// The server dot (Orca's `size-1.5`).
const DOT = 6;
// A look pill (Spotlight's D42, Orca's Badge): `px-1.5`, `rounded-full` on
// its 16 px, the secondary's neutral fill (the foreground at 10 %, drawn
// over the row as Orca's secondary over its sidebar, so it still shows on a
// hovered row) and the chip a look pill shows on hover.
const LOOK_PX = 6;
const LOOK_RADIUS = BADGE_BOX / 2;
const LOOK_FILL = 0.1;
const LOOK_HOVER = 0.15;
// A disabled badge's opacity (Orca's `disabled:opacity-50`).
export const DISABLED_OPACITY = 0.5;
// A row's height: one line (Orca's `h-7`), or two when a badge asks for
// line 2 (Orca's card with its details row).
export const ROW_H = 28;
export const ROW_H2 = 42;
// Orca's root bar: `w-[3px]`, `inset-y-1`.
const BAR_W = 3;
const BAR_INSET = 4;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// `color` ("#rgb", "#rrggbb" or "#rrggbbaa", as theme() spells them) at
// `fraction` of its opacity, as "#rrggbbaa"; null for any other spelling.
export function tint(color, fraction) {
  if (typeof color !== "string" || !HEX.test(color.trim())) return null;
  let hex = color.trim().slice(1).toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) : 255;
  const a = Math.round(alpha * fraction);
  return `#${hex.slice(0, 6)}${a.toString(16).padStart(2, "0")}`;
}

// The chip a button shows behind it on hover, by tone: the working tone at
// 10 % (Orca's amber), the blocked tone at 10 % (its destructive), else the
// foreground at 15 % (its accent/60): drawn over the hovered row, it shows as
// Orca's gray square, where the theme's hover color is the row's own and
// wouldn't (S24). A color the theme doesn't spell as #hex falls back to the
// hover color.
export function chipColor(tone, t) {
  const hover = t?.hover ?? null;
  if (tone === "working" || tone === "blocked") return tint(t?.[tone], 0.1) ?? hover;
  return tint(t?.foreground, 0.15) ?? hover;
}

// A pill's look (`pill: true`), 16 px tall with uppercase 10 px text. Dim:
// Orca's variant tag, the theme's border and no fill. Any other tone: its
// SPOTLIGHT chip, the tone's border at 30 % and a 5 % fill. With a `look`
// (Spotlight's D42, Orca's Badge, its test-turn badge), whatever the tone:
// "secondary", a neutral fill with the foreground text, its border the fill
// (Orca's transparent border); "outline", the theme's border, no fill, the
// dim text (Orca's muted). Both medium, round-ended (`radius`) and keeping
// the text's case (`keepCase`). null when the badge isn't a pill.
export function pillStyle(b, t) {
  if (!b?.pill) return null;
  if (b.look === "secondary") {
    const fill = tint(t?.foreground, LOOK_FILL) ?? t?.hover ?? null;
    return { border: fill, bg: fill, color: t?.foreground ?? null, px: LOOK_PX, weight: "medium", size: PILL_TEXT, radius: LOOK_RADIUS, keepCase: true };
  }
  if (b.look === "outline") {
    return { border: t?.border ?? null, bg: null, color: t?.dim ?? null, px: LOOK_PX, weight: "medium", size: PILL_TEXT, radius: LOOK_RADIUS, keepCase: true };
  }
  const color = t?.[b.tone] ?? t?.dim ?? null;
  if (b.tone === "dim") return { border: t?.border ?? null, bg: null, color, px: TAG_PX, weight: "semibold", size: PILL_TEXT };
  return { border: tint(color, 0.3) ?? color, bg: tint(color, 0.05), color, px: CHIP_PX, weight: "medium", size: PILL_TEXT };
}

// What a badge with an action shows on hover: { bg, color }, the chip behind
// it and the color its icon and text take. Its `hover` tone if it names one,
// else its own: a dim badge lifts to the foreground, any other keeps its
// color. A pill's chip is its own: the dim tag takes the hover color, a tone
// chip its tone at 15 %; a look pill (Spotlight's D42) a neutral chip, the
// foreground at 15 %, its text lifting to the foreground, unless `hover`
// names a tone. null without an action, or disabled: a badge with nothing
// to click has no hover look (Orca's logs icon, its disabled X).
export function badgeHover(b, t) {
  if (!b?.action || b.disabled) return null;
  const tone = b.hover ?? b.tone;
  const color = tone === "dim" && !b.hover ? t?.foreground ?? null : t?.[tone] ?? null;
  if (b.pill && b.look && !b.hover) return { bg: tint(t?.foreground, LOOK_HOVER) ?? t?.hover ?? null, color: t?.foreground ?? null };
  if (!b.pill) return { bg: chipColor(tone, t), color };
  if (tone === "dim") return { bg: t?.hover ?? null, color };
  return { bg: tint(t?.[tone], 0.15) ?? t?.hover ?? null, color };
}

// A badge's opacity and width this frame, by its `reveal`. "hover": opacity
// 0 until its row is hovered, keeping its place (width null: its own).
// "grow": also width 0 until then, and its `measured` width once hovered
// (null before it is measured: its own). Any other badge: shown at its own
// width. Both move at BADGE_MOTION.
export function revealStyle(b, { hovered = false, measured = null } = {}) {
  if (!b?.reveal) return { opacity: 1, width: null };
  const opacity = hovered ? 1 : 0;
  if (b.reveal !== "grow") return { opacity, width: null };
  if (!hovered) return { opacity, width: 0 };
  return { opacity, width: Number.isFinite(measured) ? measured : null };
}

// Whether a badge's click runs: never a disabled one (Spotlight's D42); a
// reveal badge only while its row is hovered, since at opacity 0 it doesn't
// show; any other always.
export const badgeClickable = (b, hovered) => !b?.disabled && (!b?.reveal || hovered === true);

// Whether a row has a badge that waits for its hover: only such a row tracks
// its hover (tree.js on_hover).
export const hasReveal = (badges) => Array.isArray(badges) && badges.some((b) => Boolean(b?.reveal));

// A badge's server dot (Orca's SpotlightServerDot): DOT px, filled in the
// done tone ("on") or a hollow dim ring ("off"), at the icon's bottom-right
// on a badge with an icon, after the text on a pill or a badge with no icon.
// null without a dot. Never clickable.
export function dotStyle(b, t) {
  if (!b?.dot) return null;
  const place = b.icon && !b.pill ? "corner" : "after";
  const on = b.dot === "on";
  return { place, size: DOT, fill: on ? t?.done ?? null : null, ring: on ? null : t?.dim ?? null };
}

// What each of a row's badges may take, in px. A pill: its own width, never
// cut (null; Orca's `shrink-0` chip), outside the room. An icon-only badge:
// BADGE_BOX. Text badges: an equal share of what is left of BADGE_ROOM after
// the icon-only badges and the gaps between the badges in the room, at most
// BADGE_W, cut with "…". A row of text badges only shares as badgeMaxWidth.
// The row's name gives way before any of this (tree.js).
export function badgeWidths(badges) {
  const list = Array.isArray(badges) ? badges : [];
  const room = list.filter((b) => !b?.pill);
  const icons = room.filter((b) => !b?.text).length;
  const texts = room.length - icons;
  const left = BADGE_ROOM - BADGE_BOX * icons - BADGE_GAP * Math.max(room.length - 1, 0);
  const share = texts ? Math.max(0, Math.min(BADGE_W, Math.floor(left / texts))) : 0;
  return list.map((b) => (b?.pill ? null : b?.text ? share : BADGE_BOX));
}

// Where the gap between two badges of a row goes: { ml, pl, pr } per badge,
// in px. A "grow" badge carries the gap before it inside its width (pl), so
// collapsed it takes none (Orca's env pill cancels the gap with -ml-1.5);
// before any other badge the gap is a margin (ml), except when every badge
// before it grows: then the one just before carries it (pr), so nothing is
// left at the row's start. A row's reveal badges show and hide together
// (its hover), so this keeps one gap between what shows, shown or not.
export function badgeGaps(badges) {
  const list = Array.isArray(badges) ? badges : [];
  const gaps = list.map(() => ({ ml: 0, pl: 0, pr: 0 }));
  const grows = (b) => b?.reveal === "grow";
  for (let i = 1; i < list.length; i++) {
    if (grows(list[i])) gaps[i].pl = BADGE_GAP;
    else if (list.slice(0, i).some((b) => !grows(b))) gaps[i].ml = BADGE_GAP;
    else gaps[i - 1].pr = BADGE_GAP;
  }
  return gaps;
}

// A line of a row's badges laid out (badgeLines' line 1 or line 2, each
// with its own BADGE_ROOM), one { maxW, ml, pl, pr, opacity, width,
// clickable } per badge: badgeWidths' cap, badgeGaps' gap, revealStyle's
// opacity, halved when disabled (Spotlight's D42), and width (for a grow
// badge, the width of its clip, the gap it carries included), and
// badgeClickable. `hovered`: whether the row is; `measured`: each badge's
// own width as last drawn, or null.
export function badgeLayout(badges, { hovered = false, measured = [] } = {}) {
  const list = Array.isArray(badges) ? badges : [];
  const widths = badgeWidths(list);
  const gaps = badgeGaps(list);
  return list.map((b, i) => {
    const { opacity, width } = revealStyle(b, { hovered, measured: measured?.[i] ?? null });
    const g = gaps[i];
    const clip = b?.reveal === "grow" && width !== null && width > 0 ? width + g.pl + g.pr : width;
    const shown = b?.disabled ? opacity * DISABLED_OPACITY : opacity;
    return { maxW: widths[i], ...g, opacity: shown, width: clip, clickable: badgeClickable(b, hovered) };
  });
}

// A row's badges by line (Spotlight's D42, Orca's card): { line1, line2,
// height }. A `line: 2` badge goes under the label (Orca's details row), the
// rest stay after it, each in its order; a row with any on line 2 is ROW_H2
// tall, else ROW_H. A lane header (`lane: true`) has one line: its line-2
// badges join line 1 at its end, and it stays ROW_H. The row's caps were
// already counted over both lines (parseBadges).
export function badgeLines(badges, { lane = false } = {}) {
  const list = Array.isArray(badges) ? badges : [];
  const line1 = list.filter((b) => b?.line !== 2);
  const line2 = list.filter((b) => b?.line === 2);
  if (lane) return { line1: [...line1, ...line2], line2: [], height: ROW_H };
  return { line1, line2, height: line2.length ? ROW_H2 : ROW_H };
}

// The bar a row draws at its left edge (Spotlight's D42, Orca's amber root
// bar): { color, width, inset } in px, from the first of its badges whose
// `bar` is a tone; null with none, or when the theme lacks that color.
export function rowBar(badges, t) {
  const list = Array.isArray(badges) ? badges : [];
  const tone = list.find((b) => BADGE_TONES.includes(b?.bar))?.bar;
  const color = tone ? t?.[tone] ?? null : null;
  return color ? { color, width: BAR_W, inset: BAR_INSET } : null;
}

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// Where a click's exec runs, and the id its in-flight guard keeps (tree.js
// runBadge): `target` is the row the badge is on, { path } for a workspace
// row, { group, lane } for a task lane header. A workspace's runs in its
// folder, keyed by its path, the badge's key and index (as before lanes); a
// lane has no folder, so its runs in the home folder (`home`), keyed by its
// lane key (group and lane), so the same lane name in two groups is two
// guards.
export function badgeRun({ target, badge, home } = {}) {
  const lane = typeof target?.lane === "string";
  const row = lane ? laneBadgeKey(target.group, target.lane) : target?.path;
  return { id: `${row}\n${badge?.key}\n${badge?.index}`, cwd: lane ? home : target?.path };
}

// A click's exec came back: null on exit code 0, else what the warning
// toast says.
export const execFailure = (r) => (r?.code === 0 ? null : firstLine(r?.stderr) || `exited with code ${r?.code}`);

// The action couldn't start (exec rejected, or run threw).
export const startFailure = (e) => firstLine(e?.message ?? e) || "couldn't start";
