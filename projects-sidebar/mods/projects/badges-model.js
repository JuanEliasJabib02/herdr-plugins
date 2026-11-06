// Indicators from other plugins ("badges", D38), with no herdr or gpui-kit
// imports so `node --test` can load it. This plugin knows no plugin: it
// reads what they publish under config.js BADGE_KEYS, draws it after a
// workspace row's label (tree.js) and runs its action on a click. The
// contract other plugins consume is RECIPE.md "Badges from other plugins";
// it only grows (a breaking change gets a new key, e.g. badges.spotlight.v2).
//
//   each key:  { [workspacePath]: [badge] }   absolute paths, as `git
//              worktree list` prints them
//   a badge:   { icon?, text?, tone?, tooltip?, action? }
//   action:    { command: "<mod>.<command>" } | { exec: [program, ...args] }
//
// Anything else is dropped field by field: a bad icon or action goes and the
// badge stays; a badge left with neither icon nor text goes; a value that
// isn't an object is no badges at all. Never throws.

import { BADGE_KEYS } from "./config.js";
import { normPath, isAbsolute } from "./lib.js";

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
function iconOf(icon) {
  if (typeof icon !== "string" || icon.includes("\\")) return null;
  const parts = icon.split("/");
  if (parts.length < 3 || parts[0] !== "mods") return null;
  if (parts.some((p) => p === "" || p === "..")) return null;
  return /.\.svg$/.test(parts.at(-1)) ? icon : null;
}

// One line: runs of whitespace (newlines too) as one space, trimmed.
function textOf(text) {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line ? cut(line, TEXT_MAX) : null;
}

const tooltipOf = (tooltip) => (typeof tooltip === "string" && tooltip ? cut(tooltip, TOOLTIP_MAX) : null);

// argv[0] runs as given: a bare name is looked up on Herdr's PATH, an
// absolute path is that file. A relative path (./x, bin/x) would run a file
// from whatever branch the workspace has checked out, so it's refused.
const programOk = (p) => p !== "" && (p.startsWith("/") || !p.includes("/"));

function actionOf(action) {
  if (!isObject(action)) return null;
  const { command, exec } = action;
  if (command !== undefined && exec !== undefined) return null;
  if (command !== undefined) return typeof command === "string" && COMMAND.test(command) ? { command } : null;
  if (!Array.isArray(exec) || exec.length < 1 || exec.length > ARGV_MAX) return null;
  if (!exec.every((a) => typeof a === "string" && a.length <= ARG_MAX && !a.includes("\0"))) return null;
  return programOk(exec[0]) ? { exec: [...exec] } : null;
}

// One badge, or null when it has neither icon nor text. `key` and `index`
// (its place among that plugin's badges on the row) say which badge a click
// is on.
function badgeOf(raw, key, index) {
  if (!isObject(raw)) return null;
  const icon = iconOf(raw.icon);
  const text = textOf(raw.text);
  if (!icon && !text) return null;
  const tooltip = tooltipOf(raw.tooltip);
  const action = actionOf(raw.action);
  return {
    key,
    index,
    ...(icon ? { icon } : {}),
    ...(text ? { text } : {}),
    tone: BADGE_TONES.includes(raw.tone) ? raw.tone : DEFAULT_TONE,
    ...(tooltip ? { tooltip } : {}),
    ...(action ? { action } : {}),
  };
}

// Every row's badges: { [workspacePath]: [badge] }, each row's in key order
// (BADGE_KEYS'), at most 3 per plugin and 4 in all. `values`: the keys'
// shared() values, in that order (store.js badges()).
export function parseBadges(values, keys = BADGE_KEYS) {
  const rows = {};
  if (!Array.isArray(values)) return rows;
  values.forEach((value, i) => {
    if (!isObject(value)) return;
    const key = keys[i] ?? String(i);
    const mine = new Map(); // path -> this plugin's badges on it
    for (const [at, list] of Object.entries(value)) {
      if (!isAbsolute(at) || !Array.isArray(list)) continue;
      const path = normPath(at);
      const kept = mine.get(path) ?? [];
      for (const raw of list) {
        if (kept.length >= PER_PLUGIN) break;
        const b = badgeOf(raw, key, kept.length);
        if (b) kept.push(b);
      }
      mine.set(path, kept);
    }
    for (const [path, kept] of mine) {
      const row = rows[path] ?? [];
      const room = PER_ROW - row.length;
      if (room <= 0 || !kept.length) continue;
      rows[path] = [...row, ...kept.slice(0, room)];
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

// A click's exec came back: null on exit code 0, else what the warning
// toast says.
export const execFailure = (r) => (r?.code === 0 ? null : firstLine(r?.stderr) || `exited with code ${r?.code}`);

// The action couldn't start (exec rejected, or run threw).
export const startFailure = (e) => firstLine(e?.message ?? e) || "couldn't start";
