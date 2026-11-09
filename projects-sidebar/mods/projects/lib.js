// The model behind the sidebar, with no herdr or gpui-kit imports so
// `node --test` can load it: the registry of groups and projects, the
// persisted keys and their validation, repo resolution and worktree lists
// (git is passed in), and the matching of Herdr's spaces to workspaces.
// Every operation returns a new value and never mutates its input. Frozen
// after T2: later tasks add their pure helpers to their own model files. The
// exceptions change the persisted keys here: T10 added two optional fields,
// a group's `organize` (D29) and the folded Task-mode lanes, `tasks` (D31);
// T13 added the task notes, `projects.notes.v1`, and their helpers (D34);
// T15 added a project's saved base, `base`, and setProjectBase (D37); the PR
// status added `projects.prs.v1`, read and merged by pr-model.js. The PR card
// shares matchSpaces' rule through checkoutAt, so the two can't drift.
// workspace-sleep T2 added Inicio's space, `projects.inicio.v1`, whose
// helpers are in inicio-model.js (D6); its T5 added the sleeping filter's two
// optional fields to projects.ui.v1, `hideSleeping` and `exceptMain` (D8).

// ── Persisted keys ─────────────────────────────────────────────────────────

// The shared() keys this mod persists, read and written only by store.js.
// A format change gets a new key (projects.v2), never a reshaped v1. An
// optional field that an older build simply drops (organize, tasks, a
// project's base) is not a format change.
export const KEYS = {
  registry: "projects.v1", // { version: 1, groups: [{ id, name, projects: [{ path, name, base? }], organize?: "task" }], activeGroup }; base: the project's saved base, "origin/<branch>" (D37)
  registryBackup: "projects.v1.backup", // the first stored projects.v1 that didn't read back as itself, as it was (needsBackup)
  ui: "projects.ui.v1", // { collapsed: [projectPath], tasks?: [lane], hideSleeping?: true, exceptMain?: false }: tasks, the folded Task-mode lanes, only when there are any; hideSleeping (Hide sleeping, off by default) only when on and exceptMain (Except default branch, on by default) only when off (workspace-sleep D8)
  cache: "projects.cache.v1", // { [projectPath]: [{ path, branch, main }] }
  agents: "projects.agents.v1", // the last knownAgents() result
  notes: "projects.notes.v1", // { [taskKey]: note }: a task's note, up to 30 chars, at most 500 notes (noteKeyOf, parseNotes)
  notesBackup: "projects.notes.v1.backup", // the first stored projects.notes.v1 that didn't read back as itself, as it was (notesWrites)
  prs: "projects.prs.v1", // { [workspacePath]: { number, state, url } }: the PR of each workspace's branch, state open | draft | merged | closed (pr-model.js parsePrs)
  prsAsk: "projects.prs-ask.v1", // a number, larger at each `projects.refresh-prs`: the tree in the window in front runs a PR round when it grows (store.js askPrs; workspace-sleep D7)
  inicio: "projects.inicio.v1", // { space: id }: the space the keeper made as Inicio (workspace-sleep D6; inicio-model.js parseInicio)
};

// Whether writing `next` over `prev` changes anything: values are plain
// JSON, built in a fixed key order by this module.
export const changed = (prev, next) => JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null);

// ── Paths ──────────────────────────────────────────────────────────────────

// One spelling per folder: forward slashes, `~` expanded when `home` is
// given, no trailing slash ("/" stays "/"). Anything but a string is "".
export function normPath(path, home) {
  if (typeof path !== "string" || !path) return "";
  let p = path.replace(/\\/g, "/");
  if (home && (p === "~" || p.startsWith("~/"))) p = normPath(home) + p.slice(1);
  return p.replace(/\/+$/, "") || "/";
}

export const isAbsolute = (path) => typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:\//.test(path));

export const baseName = (path) => normPath(path).split("/").filter(Boolean).pop() ?? "";

// `path` is `dir` or inside it.
const inside = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

// Where a space is now: its first terminal's live folder, else the folder it
// was made in (mods/worktree/main.js `place`). `panes`: panes(), read once.
export function placeOf(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return (panes ?? []).find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

// ── Registry ───────────────────────────────────────────────────────────────

const DEFAULT_GROUP = "Projects";

// What a person starts with, and what a stored value with no valid group
// reads as.
export function emptyRegistry() {
  return { version: 1, groups: [{ id: "g1", name: DEFAULT_GROUP, projects: [] }], activeGroup: "g1" };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const isGroup = (g) => isObject(g) && typeof g.id === "string" && g.id !== "" && typeof g.name === "string" && Array.isArray(g.projects);

const isProject = (p) => isObject(p) && isAbsolute(p.path) && typeof p.name === "string";

// The longest saved base kept (D37).
const BASE_MAX = 200;

// A project's saved base (D37, S33): the branch its new workspaces start from,
// a short ref under origin/ ("origin/develop") of at most BASE_MAX chars that
// git would take as a ref name. The rules are modeled on slug's
// (new-workspace-model.js) and git check-ref-format's: no space or control
// character; none of ~ ^ : ? * [ \ (the last four would also make it a
// for-each-ref glob); no "..", "@{" or "//"; no trailing "/" or "."; and no
// component that starts with "." or "-" or ends with ".lock".
function isBase(value) {
  if (typeof value !== "string" || value.length > BASE_MAX || !value.startsWith("origin/")) return false;
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(value) || /\.\.|@\{|\/\//.test(value) || /[/.]$/.test(value)) return false;
  return value.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.startsWith("-") && !c.endsWith(".lock"));
}

// A stored `projects.v1` value as a registry, salvaging what it can: a
// malformed group is dropped with its projects, a malformed project alone,
// and every valid group and project is kept. A value that isn't a v1
// registry at all (another version, another mod's value) or keeps no valid
// group is the empty registry. Unknown fields are dropped, paths normalized,
// a group id or a path listed twice kept only the first time, and an active
// group that doesn't exist falls back to the first group. A group's
// `organize` is kept only when it is "task", as its last key (D29): that is
// where setOrganize puts it, so a stored Task-mode group reads back as itself
// and never needs a backup. A project's `base` (D37) is kept the same way,
// only when isBase takes it, as the project's last key, where
// setProjectBase puts it. Never throws.
export function parseRegistry(value) {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.groups)) return emptyRegistry();
  const ids = new Set();
  const paths = new Set();
  const groups = [];
  for (const g of value.groups) {
    if (!isGroup(g) || ids.has(g.id)) continue;
    ids.add(g.id);
    const projects = [];
    for (const p of g.projects) {
      if (!isProject(p)) continue;
      const path = normPath(p.path);
      if (paths.has(path)) continue;
      paths.add(path);
      projects.push({ path, name: p.name, ...(isBase(p.base) ? { base: p.base } : {}) });
    }
    groups.push({ id: g.id, name: g.name, projects, ...(g.organize === "task" ? { organize: "task" } : {}) });
  }
  if (groups.length === 0) return emptyRegistry();
  const activeGroup = ids.has(value.activeGroup) ? value.activeGroup : groups[0].id;
  return { version: 1, groups, activeGroup };
}

// Whether a stored `projects.v1` value (`raw`) must be kept in
// KEYS.registryBackup before anything is written over it: it is there and
// its reading (`parsed`: parseRegistry(raw)) isn't the same value, so the
// write would lose whatever parseRegistry dropped. Nothing stored → false.
export const needsBackup = (raw, parsed) => raw != null && changed(raw, parsed);

// The shared() writes that save `next` over the stored `projects.v1` value
// (`raw`), as ordered [key, value] pairs for store.js saveRegistry: none
// when `next` is the same value; otherwise `raw` goes to KEYS.registryBackup
// first when it needs one (needsBackup) and the backup (`backup`) is empty,
// so the first original survives, and then `next` to KEYS.registry.
export function registryWrites(raw, backup, next) {
  if (!changed(raw, next)) return [];
  const writes = [];
  if (needsBackup(raw, parseRegistry(raw)) && backup == null) writes.push([KEYS.registryBackup, raw]);
  writes.push([KEYS.registry, next]);
  return writes;
}

// The group F1–F3 and the tree show: the active one, else the first.
export function activeGroup(registry) {
  return registry.groups.find((g) => g.id === registry.activeGroup) ?? registry.groups[0];
}

// The group holding a project path, and that project; null when unregistered.
export function findProject(registry, path) {
  const p = normPath(path);
  for (const group of registry.groups) {
    const project = group.projects.find((x) => x.path === p);
    if (project) return { group, project };
  }
  return null;
}

// A copy of the registry with one group replaced by fn(group).
const mapGroup = (registry, id, fn) => ({ ...registry, groups: registry.groups.map((g) => (g.id === id ? fn(g) : g)) });

// Adds { path, name? } (name defaults to the folder's) to a group, the active
// one by default. A path already registered in any group is not added
// again: its group becomes the active one instead. A relative path is not a
// project: nothing changes.
export function addProject(registry, { path, name }, groupId) {
  const p = normPath(path);
  if (!isAbsolute(p)) return registry;
  const found = findProject(registry, p);
  if (found) return found.group.id === registry.activeGroup ? registry : { ...registry, activeGroup: found.group.id };
  const target = registry.groups.find((g) => g.id === groupId) ?? activeGroup(registry);
  return mapGroup(registry, target.id, (g) => ({ ...g, projects: [...g.projects, { path: p, name: name || baseName(p) }] }));
}

// Takes a project off the list (its files, worktrees and spaces stay).
export function removeProject(registry, path) {
  const found = findProject(registry, path);
  if (!found) return registry;
  return mapGroup(registry, found.group.id, (g) => ({ ...g, projects: g.projects.filter((x) => x.path !== found.project.path) }));
}

// Moves a project to the end of another group; the active group stays.
export function moveProject(registry, path, groupId) {
  const found = findProject(registry, path);
  if (!found || found.group.id === groupId || !registry.groups.some((g) => g.id === groupId)) return registry;
  const without = removeProject(registry, found.project.path);
  return mapGroup(without, groupId, (g) => ({ ...g, projects: [...g.projects, found.project] }));
}

// The next free id: g1, g2, … one past the highest in use.
function nextGroupId(registry) {
  const n = Math.max(0, ...registry.groups.map((g) => Number(/^g(\d+)$/.exec(g.id)?.[1] ?? 0)));
  return `g${n + 1}`;
}

// Appends a group (creation order is the order shown). Not selected: the
// caller selects registry.groups.at(-1) when it wants to. A blank name adds
// nothing.
export function addGroup(registry, name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return registry;
  return { ...registry, groups: [...registry.groups, { id: nextGroupId(registry), name: n, projects: [] }] };
}

export function renameGroup(registry, id, name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || !registry.groups.some((g) => g.id === id)) return registry;
  return mapGroup(registry, id, (g) => ({ ...g, name: n }));
}

// Deletes a group only when it holds no projects and isn't the last one.
// Deleting the active group makes the first remaining one active.
export function deleteGroup(registry, id) {
  const group = registry.groups.find((g) => g.id === id);
  if (!group || group.projects.length > 0 || registry.groups.length === 1) return registry;
  const groups = registry.groups.filter((g) => g.id !== id);
  return { ...registry, groups, activeGroup: groups.some((g) => g.id === registry.activeGroup) ? registry.activeGroup : groups[0].id };
}

export function selectGroup(registry, id) {
  if (id === registry.activeGroup || !registry.groups.some((g) => g.id === id)) return registry;
  return { ...registry, activeGroup: id };
}

// How a group's tree is organized (D29): "task" (lanes by task) or "project"
// (by project, the default). Task mode is `organize: "task"` on the group, as
// its last key (parseRegistry's order); Project mode is no field at all,
// never "project" or undefined, so either reads back as itself. The same
// registry when the group is unknown, the mode is neither, or the group
// already has it. Every other operation keeps the field (they spread the
// group).
export function setOrganize(registry, groupId, mode) {
  const group = registry.groups.find((g) => g.id === groupId);
  if (!group || (mode !== "task" && mode !== "project")) return registry;
  if (mode === (group.organize === "task" ? "task" : "project")) return registry;
  return mapGroup(registry, groupId, (g) => {
    if (mode === "task") return { ...g, organize: "task" };
    const { organize: _, ...rest } = g;
    return rest;
  });
}

// A project's saved base set or replaced, or, with null, removed (the key
// goes, never left undefined), like setOrganize, so the stored value reads
// back as itself. A new key goes last ({ path, name, base }, parseRegistry's
// order). The same registry when the project is unknown, it already has that
// base (or none, to clear), or `base` is one parseRegistry wouldn't keep.
// Moving, reordering and renaming keep it: they carry the project as it is.
export function setProjectBase(registry, path, base) {
  const found = findProject(registry, path);
  if (!found || (base !== null && !isBase(base))) return registry;
  if ((found.project.base ?? null) === base) return registry;
  return mapGroup(registry, found.group.id, (g) => ({
    ...g,
    projects: g.projects.map((p) => {
      if (p !== found.project) return p;
      if (base !== null) return { ...p, base };
      const { base: _, ...rest } = p;
      return rest;
    }),
  }));
}

// ── Other persisted keys ───────────────────────────────────────────────────

// A Task-mode lane key (D31, task-model.js): "servers", "task:none", or
// "task:" and 1–200 chars (a ticket, or a name of up to 200 chars).
const isLane = (s) => typeof s === "string" && (s === "servers" || (s.startsWith("task:") && s.length > 5 && s.length <= 205));

// A `projects.ui.v1` value in its one key order, with each optional field
// only when it differs from its default: { collapsed, tasks?, hideSleeping?,
// exceptMain? }. Every ui this module returns is built here, so a stored
// value reads back as itself, key order included (`changed` compares text).
function uiValue({ collapsed, tasks, hideSleeping, exceptMain }) {
  return {
    collapsed,
    ...(tasks?.length ? { tasks } : {}),
    ...(hideSleeping === true ? { hideSleeping: true } : {}),
    ...(exceptMain === false ? { exceptMain: false } : {}),
  };
}

// `projects.ui.v1`: the collapsed projects, by path; the folded Task-mode
// lanes, by lane key; and the sleeping filter (workspace-sleep D8): Hide
// sleeping, off by default, and Except default branch, on by default, which
// only counts while hiding (Orca's "absent means on"). `tasks` is there only
// when a lane is folded, `hideSleeping` only when it is true and
// `exceptMain` only when it is false, so a value without them reads as
// { collapsed }, as before T10, and an older build that drops them reads it
// as before too. Anything but a boolean is its default.
export function parseUi(value) {
  const ok = isObject(value);
  const collapsed = ok && Array.isArray(value.collapsed) ? value.collapsed : [];
  const tasks = ok && Array.isArray(value.tasks) ? [...new Set(value.tasks.filter(isLane))] : [];
  return uiValue({
    collapsed: [...new Set(collapsed.filter(isAbsolute).map((p) => normPath(p)))],
    tasks,
    hideSleeping: ok && value.hideSleeping,
    exceptMain: ok && value.exceptMain === false ? false : undefined,
  });
}

// A project folded or not; the folded lanes and the filter stay.
export function withCollapsed(ui, path, collapsed) {
  const p = normPath(path);
  const rest = ui.collapsed.filter((x) => x !== p);
  const next = collapsed ? [...rest, p] : rest;
  return next.length === ui.collapsed.length && next.every((x, i) => x === ui.collapsed[i]) ? ui : uiValue({ ...ui, collapsed: next });
}

// A Task-mode lane folded or not; the folded projects and the filter stay.
// The same `ui` when nothing changes, or for a key parseUi wouldn't keep.
// Unfolding the last lane drops `tasks`, which is how parseUi reads it.
export function withTaskCollapsed(ui, lane, folded) {
  if (!isLane(lane)) return ui;
  const now = ui.tasks ?? [];
  const rest = now.filter((x) => x !== lane);
  const next = folded ? [...rest, lane] : rest;
  if (next.length === now.length && next.every((x, i) => x === now[i])) return ui;
  return uiValue({ ...ui, tasks: next });
}

// Hide sleeping on or off (D8: the filter popup and projects.toggle-sleeping);
// the folds and Except default branch stay. The same `ui` when it already is.
export function withHideSleeping(ui, on) {
  return (ui.hideSleeping === true) === (on === true) ? ui : uiValue({ ...ui, hideSleeping: on === true });
}

// Except default branch on or off (D8: the filter popup); kept while
// sleeping rows show, for the next hide. The same `ui` when it already is.
export function withExceptMain(ui, on) {
  return (ui.exceptMain !== false) === (on !== false) ? ui : uiValue({ ...ui, exceptMain: on !== false });
}

// `projects.notes.v1`: one short note per task (S29; S31, S32: a word or two
// to recall the task by), { [taskKey]: note }. Global like Orca's
// taskNoteByTaskKey, not per group, and content, not view state, so not in
// projects.ui.v1. The key is a Task-mode lane without "task:": a ticket
// ("AX-3695") or a name lane's lowercased name. The tree, the task menu and
// the note dialog read notes only through noteKeyOf and noteOf.

// A note keeps this many characters (code points: an emoji is never cut in
// half).
export const NOTE_LENGTH = 30;
// At most this many notes are kept: a new one past it would vanish at the
// next read, so withNote refuses it (Orca's cap).
export const NOTES_MAX = 500;

// What can't key a note, compared lowercased (Orca's isUsableTaskKey, plus
// "none", the No task lane's own key): nothing, "none", over 200 chars, or a
// key that is special on a plain object.
const SPECIAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isNoteKey(key) {
  if (typeof key !== "string") return false;
  const k = key.toLowerCase();
  return k !== "" && k !== "none" && k.length <= 200 && !SPECIAL_KEYS.has(k);
}

// A lane's note key: the lane without "task:", or null for No task, Servers,
// anything that isn't a task lane, or a key isNoteKey refuses
// ("task:Constructor", "task:__PROTO__").
export function noteKeyOf(lane) {
  if (typeof lane !== "string" || !lane.startsWith("task:")) return null;
  const key = lane.slice(5);
  return isNoteKey(key) ? key : null;
}

// The note stored under `key`, or null. Own keys only (Object.hasOwn, like
// Orca's getTaskNote), so "constructor" is never Object.prototype's.
export function noteOf(notes, key) {
  if (!isObject(notes) || typeof key !== "string" || !Object.hasOwn(notes, key)) return null;
  return typeof notes[key] === "string" ? notes[key] : null;
}

// A note as it is stored: every run of whitespace, newlines included, one
// space; trimmed; cut to NOTE_LENGTH characters; its end trimmed again.
// "" means no note. Anything but a string is "".
export function normalizeNote(text) {
  if (typeof text !== "string") return "";
  const one = text.replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, NOTE_LENGTH).join("").trimEnd();
}

// A stored `projects.notes.v1` value as notes: the entries with a usable key
// (isNoteKey) whose value is a string that normalizes to a note, each value
// normalized, the first NOTES_MAX of them. Anything else reads as {}. Never
// throws.
export function parseNotes(value) {
  if (!isObject(value)) return {};
  const out = {};
  let n = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (n >= NOTES_MAX) break;
    if (!isNoteKey(key) || typeof raw !== "string") continue;
    const note = normalizeNote(raw);
    if (!note) continue;
    out[key] = note;
    n += 1;
  }
  return out;
}

// The notes with `key`'s note set to `text` (normalizeNote), replaced, or
// deleted when it normalizes to "". The same `notes` when nothing changes,
// for a key isNoteKey refuses, and for a new key while NOTES_MAX notes are
// stored (notesFull says so).
export function withNote(notes, key, text) {
  if (!isNoteKey(key)) return notes;
  const note = normalizeNote(text);
  const has = Object.hasOwn(notes, key);
  if (!note) {
    if (!has) return notes;
    const { [key]: _, ...rest } = notes;
    return rest;
  }
  if (has ? notes[key] === note : Object.keys(notes).length >= NOTES_MAX) return notes;
  return { ...notes, [key]: note };
}

// Whether withNote refused `text` for `key` because NOTES_MAX notes are
// stored: a new key with a note. Saving empty is never refused.
export const notesFull = (notes, key, text) =>
  normalizeNote(text) !== "" && !Object.hasOwn(notes, key) && Object.keys(notes).length >= NOTES_MAX;

// The shared() writes that save `next` over the stored `projects.notes.v1`
// value (`raw`), as ordered [key, value] pairs, like registryWrites: none
// when `next` is the same value; otherwise `raw` goes to KEYS.notesBackup
// first when it doesn't read back as itself (parseNotes) and the backup
// (`backup`) is empty, so the first original survives, and then `next`.
export function notesWrites(raw, backup, next) {
  if (!changed(raw, next)) return [];
  const writes = [];
  if (raw != null && changed(raw, parseNotes(raw)) && backup == null) writes.push([KEYS.notesBackup, raw]);
  writes.push([KEYS.notes, next]);
  return writes;
}

const isCheckout = (c) => isObject(c) && isAbsolute(c.path) && (c.branch === null || typeof c.branch === "string") && typeof c.main === "boolean";

// `projects.cache.v1`: the last worktree list of each project. A cache, so a
// malformed project entry is dropped alone (it is listed again).
export function parseCache(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [project, list] of Object.entries(value)) {
    if (!isAbsolute(project) || !Array.isArray(list) || !list.every(isCheckout)) continue;
    out[normPath(project)] = list.map((c) => ({ path: normPath(c.path), branch: c.branch, main: c.main }));
  }
  return out;
}

// `projects.agents.v1`: the last knownAgents() result, shown while it is
// asked again (mods/new-menu/main.js). Entries need a key and a run argv.
const AGENT_FIELDS = ["key", "name", "icon", "tint", "tile", "color", "shell", "agent", "run", "installed"];
export function parseAgents(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => isObject(a) && typeof a.key === "string" && a.key && Array.isArray(a.run) && a.run.length > 0 && a.run.every((s) => typeof s === "string"))
    .map((a) => Object.fromEntries(AGENT_FIELDS.filter((k) => k in a).map((k) => [k, a[k]])));
}

// ── Repos and worktrees ────────────────────────────────────────────────────
// `git(cwd, args)` resolves { ok, out, err } (M/git.js; tests pass a real one).

// The repo's shared .git folder, absolute: <main checkout>/.git for a normal
// repo (from the main checkout, a linked worktree or any folder inside them),
// the repo itself when bare.
export const COMMON_DIR = ["rev-parse", "--path-format=absolute", "--git-common-dir"];

// Takes no optional locks and starts no fsmonitor, so a listing writes
// nothing under .git and never wakes the watch on it (mods/spaces/main.js).
export const WORKTREE_LIST = ["--no-optional-locks", "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain"];

// The project a folder belongs to, { path, name }: its repo's main checkout
// (mods/worktree/main.js `repoOf`), or, outside git, the folder itself.
// `git --show-toplevel` would answer the worktree, not the repo.
export async function resolveProject(folder, git) {
  const dir = normPath(folder);
  const r = await git(dir, COMMON_DIR);
  const common = r.ok ? normPath(r.out.trim()) : "";
  if (!isAbsolute(common)) return { path: dir, name: baseName(dir) };
  const normal = common.endsWith("/.git");
  const path = normal ? common.slice(0, -5) || "/" : common;
  return { path, name: normal ? baseName(path) : baseName(path).replace(/\.git$/, "") };
}

// `git worktree list --porcelain` as [{ path, branch, main }]: the main
// checkout first, then the linked worktrees in git's order. Bare and
// prunable (folder gone) entries are skipped; detached ones have branch null.
export function parseWorktrees(out) {
  const blocks = String(out ?? "").replace(/\r/g, "").split(/\n\n+/).filter((b) => b.trim());
  const list = [];
  blocks.forEach((block, i) => {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) return;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    list.push({ path: normPath(path), branch, main: i === 0 });
  });
  return list.sort((a, b) => b.main - a.main);
}

// A project's workspaces. A folder outside git is a project with one row:
// itself. Rejects when git can't start there (the folder is gone): the
// caller keeps what it had.
export async function listCheckouts(project, git) {
  const dir = normPath(project);
  const r = await git(dir, WORKTREE_LIST);
  const list = r.ok ? parseWorktrees(r.out) : [];
  return list.length ? list : [{ path: dir, branch: null, main: true }];
}

// ── Spaces ─────────────────────────────────────────────────────────────────

// Every checkout of the worktree lists (`cache`: projects.cache.v1), paths
// normalized once: [{ project, path, branch, main }].
function checkoutList(cache, home) {
  const checkouts = [];
  for (const [project, list] of Object.entries(cache ?? {})) {
    for (const c of Array.isArray(list) ? list : []) {
      checkouts.push({ project: normPath(project, home), path: normPath(c?.path, home), branch: c?.branch ?? null, main: c?.main === true });
    }
  }
  return checkouts;
}

// The checkout that is the normalized folder `at` or holds it, the deepest
// when several do; null when none does or `at` isn't absolute.
function deepestAt(checkouts, at) {
  if (!isAbsolute(at)) return null;
  let best = null;
  for (const c of checkouts) if (c.path && inside(at, c.path) && (!best || c.path.length > best.path.length)) best = c;
  return best;
}

// The checkout a folder of this machine is in, { project, path, branch, main
// }, from the worktree lists (`cache`: projects.cache.v1): the one that is
// the folder or holds it, the deepest when several do; null when none does or
// the folder isn't absolute. `~` is expanded with `home`. The PR card
// (pr-card.js) places the folder Changes shows with it, by matchSpaces' own
// rule (the same two steps), so the card and the sidebar never disagree (D5).
export function checkoutAt(cache, folder, home) {
  const c = deepestAt(checkoutList(cache, home), normPath(folder, home));
  return c && { ...c };
}

// Which workspace each space shows: { [spaceId]: { project, path } }, from
// the worktree lists (`cache`: projects.cache.v1), spaces() and panes()
// (mods/worktree/main.js `spaceOf`). A space matches when it is on this
// machine and its live folder (placeOf) is a checkout or inside one; the
// deepest checkout wins (checkoutAt's rule: the list is built once here).
// Spaces that match nothing are absent: the sidebar shows them nowhere. The
// tree and the attention dot both use this.
export function matchSpaces(cache, spaces, panes, home) {
  const checkouts = checkoutList(cache, home);
  const out = {};
  for (const space of spaces ?? []) {
    if ((space.machine ?? null) !== null) continue;
    const best = deepestAt(checkouts, normPath(placeOf(space, panes), home));
    if (best) out[space.id] = { project: best.project, path: best.path };
  }
  return out;
}

// Which groups need a look: { [groupId]: boolean }, true for a group that
// isn't the active one and holds a matched space whose status is blocked or
// done. `matches`: matchSpaces().
export function attentionByGroup(registry, matches, spaces) {
  const groupOf = new Map();
  for (const g of registry.groups) for (const p of g.projects) groupOf.set(normPath(p.path), g.id);
  const active = activeGroup(registry).id;
  const out = Object.fromEntries(registry.groups.map((g) => [g.id, false]));
  for (const space of spaces ?? []) {
    if (space.status !== "blocked" && space.status !== "done") continue;
    const group = groupOf.get(matches?.[space.id]?.project);
    if (group && group !== active) out[group] = true;
  }
  return out;
}
