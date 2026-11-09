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
//   a badge:   { icon?, text?, tone?, tooltip?, action?, spin? }
//   action:    { command: "<mod>.<command>" } | { exec: [program, ...args] }
//              (<mod> is the key's first name after `badges.`: its own commands)
//   spin:      true turns the badge's icon (a busy mark)
//
// Anything else is dropped field by field: a bad icon or action goes and the
// badge stays; a badge left with neither icon nor text goes; a value that
// isn't an object is no badges at all. Never throws.
//
// The field validators (iconOf, textOf, actionOf, publisherOf) are exported:
// menus-model.js checks plugins' workspace menu items (`menus.*`, Spotlight's
// D30) with them, so an item's action follows a badge's rules.

import { BADGE_KEYS } from "./config.js";
import { normPath, isAbsolute, noteKeyOf } from "./lib.js";

export const BADGE_TONES = ["accent", "dim", "working", "blocked", "done"];
const DEFAULT_TONE = "dim";

// Caps, in code points for the strings.
const PER_PLUGIN = 3; // badges per plugin on one row
const PER_ROW = 4; // badges on one row, all plugins
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
// is on. `spin` is kept only as `true`: false is the default, anything else
// is dropped alone.
function badgeOf(raw, key, index) {
  if (!isObject(raw)) return null;
  const icon = iconOf(raw.icon);
  const text = textOf(raw.text);
  if (!icon && !text) return null;
  const tooltip = tooltipOf(raw.tooltip);
  const action = actionOf(raw.action, publisherOf(key));
  return {
    key,
    index,
    ...(icon ? { icon } : {}),
    ...(text ? { text } : {}),
    tone: BADGE_TONES.includes(raw.tone) ? raw.tone : DEFAULT_TONE,
    ...(tooltip ? { tooltip } : {}),
    ...(action ? { action } : {}),
    ...(raw.spin === true ? { spin: true } : {}),
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
// key order (BADGE_KEYS'), at most 3 per plugin and 4 in all; a lane header
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
// click never runs something unnamed. null when there is nothing to say.
export function badgeTooltip(badge) {
  const a = badge?.action;
  const runs = a?.exec ? `runs ${a.exec[0]}` : a?.command ?? null;
  return [badge?.tooltip, runs].filter(Boolean).join(" · ") || null;
}

// The row's badges share BADGE_ROOM px, so even four leave the label room;
// one badge alone gets at most BADGE_W.
export const BADGE_ROOM = 128;
export const BADGE_GAP = 4;
const BADGE_W = 72;
export const badgeMaxWidth = (count) => Math.min(BADGE_W, Math.floor((BADGE_ROOM - BADGE_GAP * (Math.max(count, 1) - 1)) / Math.max(count, 1)));

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
