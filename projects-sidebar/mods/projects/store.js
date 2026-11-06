// Persisted state: the only module that reads or writes this mod's shared()
// keys (lib.js KEYS). Reads are validated (a malformed entry is dropped, a
// foreign value reads as the empty value, never throws); writes happen only
// when the value changes, because setShared re-renders every mod. A stored
// registry, or notes value, that didn't read back as itself is copied to its
// backup key before the first write over it. Never write from render().

import { shared, setShared } from "herdr";
import {
  KEYS, changed, normPath,
  parseRegistry, registryWrites, parseUi, withCollapsed, withTaskCollapsed, parseCache, parseAgents,
  parseNotes, withNote, notesFull, notesWrites,
} from "./lib.js";

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

// ── projects.ui.v1: collapsed projects, folded Task lanes ──────────────────

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
// Read through lib.js noteKeyOf and noteOf; written only by the note dialog.

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
