// Persisted state: the only module that reads or writes this mod's shared()
// keys (lib.js KEYS). Reads are validated (an invalid or foreign value reads
// as the empty value, never throws); writes happen only when the value
// changes, because setShared re-renders every mod. Never write from render().

import { shared, setShared } from "herdr";
import {
  KEYS, changed, normPath,
  parseRegistry, parseUi, withCollapsed, parseCache, parseAgents,
} from "./lib.js";

function write(key, value) {
  if (!changed(shared(key), value)) return false;
  setShared(key, value);
  return true;
}

// ── projects.v1: groups and their projects ─────────────────────────────────

export const registry = () => parseRegistry(shared(KEYS.registry));

export function saveRegistry(next) {
  return write(KEYS.registry, next);
}

// Applies one lib.js operation to the stored registry and saves the result:
//   updateRegistry((r) => addProject(r, project))
export function updateRegistry(fn) {
  const next = fn(registry());
  saveRegistry(next);
  return next;
}

// ── projects.ui.v1: collapsed projects ─────────────────────────────────────

export const ui = () => parseUi(shared(KEYS.ui));

export function saveUi(next) {
  return write(KEYS.ui, next);
}

export const isCollapsed = (path) => ui().collapsed.includes(normPath(path));

export function toggleCollapsed(path) {
  return saveUi(withCollapsed(ui(), path, !isCollapsed(path)));
}

// ── projects.cache.v1: each project's worktree list ────────────────────────
// Written by the tree copy only, and only when a list changes.

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

// ── projects.agents.v1: the last knownAgents() result ──────────────────────

export const agents = () => parseAgents(shared(KEYS.agents));

export function saveAgents(list) {
  return write(KEYS.agents, parseAgents(list));
}
