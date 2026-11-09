// Persisted state: the only module that reads or writes this mod's shared()
// keys (lib.js KEYS). Reads are validated (a malformed entry is dropped, a
// foreign value reads as the empty value, never throws); writes happen only
// when the value changes, because setShared re-renders every mod. A stored
// registry, or notes value, that didn't read back as itself is copied to its
// backup key before the first write over it. Never write from render().
// It also reads, and never writes, other plugins' badge keys (config.js
// BADGE_KEYS, D38), workspace menu keys (config.js MENU_KEYS, Spotlight's
// D30) and remove hook keys (config.js REMOVE_HOOK_KEYS, Spotlight's D43).

import { shared, setShared } from "herdr";
import { BADGE_KEYS, MENU_KEYS, REMOVE_HOOK_KEYS } from "./config.js";
import { parseBadges } from "./badges-model.js";
import { parseMenus } from "./menus-model.js";
import { parseRemoveHooks } from "./remove-workspace-model.js";
import { parsePrs } from "./pr-model.js";
import {
  KEYS, changed, normPath,
  parseRegistry, registryWrites, parseUi, withCollapsed, withTaskCollapsed, withHideSleeping, withExceptMain, parseCache, parseAgents,
  parseNotes, withNote, notesFull, notesWrites,
} from "./lib.js";
import { parseInicio, inicioValue } from "./inicio-model.js";

function write(key, value) {
  if (!changed(shared(key), value)) return false;
  setShared(key, value);
  return true;
}

// ── projects.v1: groups and their projects ─────────────────────────────────

export const registry = () => parseRegistry(shared(KEYS.registry));

// Before the first write over a stored value parseRegistry couldn't read
// whole (lib.js needsBackup), that value goes to projects.v1.backup as it
// was; only into an empty backup, so the first original survives. The
// writes and their order come from lib.js registryWrites.
export function saveRegistry(next) {
  const writes = registryWrites(shared(KEYS.registry), shared(KEYS.registryBackup), next);
  for (const [key, value] of writes) setShared(key, value);
  return writes.length > 0;
}

// Applies one lib.js operation to the stored registry and saves the result:
//   updateRegistry((r) => addProject(r, project))
export function updateRegistry(fn) {
  const next = fn(registry());
  saveRegistry(next);
  return next;
}

// ── projects.ui.v1: collapsed projects, folded Task lanes, Hide sleeping ───

export const ui = () => parseUi(shared(KEYS.ui));

export function saveUi(next) {
  return write(KEYS.ui, next);
}

export const isCollapsed = (path) => ui().collapsed.includes(normPath(path));

export function toggleCollapsed(path) {
  return saveUi(withCollapsed(ui(), path, !isCollapsed(path)));
}

// A Task-mode lane (D31): `task:<key>`, `task:none` or `servers`.
export function toggleTaskCollapsed(lane) {
  const now = ui();
  return saveUi(withTaskCollapsed(now, lane, !(now.tasks ?? []).includes(lane)));
}

// The sleeping filter (workspace-sleep D8), read by the tree and its popup.
// Hide sleeping: the popup's first switch and projects.toggle-sleeping, run
// in the keeper's copy (D7), which reaches the tree only through this key.
export function toggleSleeping() {
  const now = ui();
  return saveUi(withHideSleeping(now, now.hideSleeping !== true));
}

// Except default branch: the popup's second switch, shown while hiding.
export function toggleExceptMain() {
  const now = ui();
  return saveUi(withExceptMain(now, now.exceptMain === false));
}

// ── projects.cache.v1: each project's worktree list ────────────────────────
// Written by the tree copy (the worktree engine), and by the overlays that
// change one project's list: the project menu's Remove from list drops it,
// the Delete dialog stores the fresh list git gave after removing a worktree,
// so the row goes at once. Only when a list changes.

export const cache = () => parseCache(shared(KEYS.cache));

export function saveCache(next) {
  return write(KEYS.cache, next);
}

// Stores one project's list (lib.js listCheckouts); false when it was the same.
export function saveWorktrees(project, list) {
  const all = cache();
  const key = normPath(project);
  if (!changed(all[key], list)) return false;
  return saveCache({ ...all, [key]: list });
}

// ── projects.notes.v1: a task's note (D34) ─────────────────────────────────
// Read through lib.js noteKeyOf and noteOf; written by the note dialog, and
// cleared by delete-task.js after a full Delete task.

export const notes = () => parseNotes(shared(KEYS.notes));

// Sets, replaces or (empty) removes a task's note. Like saveRegistry, a
// stored value that didn't read back as itself goes to
// projects.notes.v1.backup first, only into an empty backup (lib.js
// notesWrites). "saved"; "same" when nothing changed; "full" when it is a
// new note and 500 are stored (nothing is written).
export function setNote(key, text) {
  const raw = shared(KEYS.notes);
  const now = parseNotes(raw);
  const next = withNote(now, key, text);
  if (next === now) return notesFull(now, key, text) ? "full" : "same";
  for (const [k, value] of notesWrites(raw, shared(KEYS.notesBackup), next)) setShared(k, value);
  return "saved";
}

// ── projects.agents.v1: the last knownAgents() result ──────────────────────

export const agents = () => parseAgents(shared(KEYS.agents));

export function saveAgents(list) {
  return write(KEYS.agents, parseAgents(list));
}

// ── projects.prs.v1: the PR of each workspace's branch ─────────────────────
// Written by the tree copy in the window in front, after asking GitHub
// (pr-model.js mergePrs), only when a PR changed; read once per render.

export const prs = () => parsePrs(shared(KEYS.prs));

export function savePrs(next) {
  return write(KEYS.prs, next);
}

// projects.prs-ask.v1: a round asked for (`projects.refresh-prs`, run by
// Mergear and Crear PR). Commands run in the keeper's copy (workspace-sleep
// D7), never the tree's, so the ask waits here for the tree's next tick
// (tree.js prTick), which stays the only writer of projects.prs.v1. Each ask
// is larger than the last, even within the same millisecond.
export const prsAsked = () => {
  const v = shared(KEYS.prsAsk);
  return Number.isFinite(v) ? v : 0;
};

export function askPrs() {
  setShared(KEYS.prsAsk, Math.max(Date.now(), prsAsked() + 1));
}

// ── badges.*: other plugins' indicators (D38) ──────────────────────────────
// Read only: each key belongs to the plugin that publishes it, which also
// clears its own paths. { [workspacePath]: [badge] }, validated and capped
// by badges-model.js; tree.js reads it once per render.

export const badges = () => parseBadges(BADGE_KEYS.map((k) => shared(k)));

// ── menus.*: other plugins' workspace menu items (Spotlight's D30) ────────
// Read only, like badges.*: each key belongs to the plugin that publishes it.
// { [workspacePath]: [item] }, validated and capped by menus-model.js;
// workspace-menu.js reads it when it opens and on every render.

export const menus = () => parseMenus(MENU_KEYS.map((k) => shared(k)));

// ── removeHooks.*: other plugins' remove hooks (Spotlight's D43) ──────────
// Read only, like menus.*: each key belongs to the plugin that publishes it.
// { workspace: [argv], project: [argv] }, validated by
// remove-workspace-model.js parseRemoveHooks; Delete, Delete task and
// Remove from list read it when they run.

export const removeHooks = () => parseRemoveHooks(REMOVE_HOOK_KEYS.map((k) => shared(k)));

// ── projects.inicio.v1: Inicio's space (workspace-sleep D6) ─────────────────
// Written only by the keeper (keeper.js), from a spawned task: the id it
// made, or null once that space is no longer Inicio. panes() exposes no
// props, so Inicio is remembered by id (R1#7); only one a reload left
// half-made, never stored, is told by its shape (inicio-model.js
// inicioState).

export const inicio = () => parseInicio(shared(KEYS.inicio));

export function saveInicio(id) {
  return write(KEYS.inicio, inicioValue(id));
}
