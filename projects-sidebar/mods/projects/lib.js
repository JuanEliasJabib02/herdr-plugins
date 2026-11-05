// The model behind the sidebar, with no herdr or gpui-kit imports so
// `node --test` can load it: the registry of groups and projects, the
// persisted keys and their validation, repo resolution and worktree lists
// (git is passed in), and the matching of Herdr's spaces to workspaces.
// Every operation returns a new value and never mutates its input. Frozen
// after T2: later tasks add their pure helpers to their own model files.

// ── Persisted keys ─────────────────────────────────────────────────────────

// The shared() keys this mod persists, read and written only by store.js.
// A format change gets a new key (projects.v2), never a reshaped v1.
export const KEYS = {
  registry: "projects.v1", // { version: 1, groups: [{ id, name, projects: [{ path, name }] }], activeGroup }
  ui: "projects.ui.v1", // { collapsed: [projectPath] }
  cache: "projects.cache.v1", // { [projectPath]: [{ path, branch, main }] }
  agents: "projects.agents.v1", // the last knownAgents() result
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

// What a person starts with, and what any invalid stored value reads as.
export function emptyRegistry() {
  return { version: 1, groups: [{ id: "g1", name: DEFAULT_GROUP, projects: [] }], activeGroup: "g1" };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// A stored `projects.v1` value as a registry. Anything that isn't one (another
// version, another mod's value, a malformed group or project) is the empty
// registry: nothing half-trusted is kept. Unknown fields are dropped, paths
// normalized, a path listed twice kept only the first time, and an active
// group that doesn't exist falls back to the first group. Never throws.
export function parseRegistry(value) {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.groups) || value.groups.length === 0) return emptyRegistry();
  const ids = new Set();
  const paths = new Set();
  const groups = [];
  for (const g of value.groups) {
    if (!isObject(g) || typeof g.id !== "string" || !g.id || ids.has(g.id) || typeof g.name !== "string" || !Array.isArray(g.projects)) return emptyRegistry();
    ids.add(g.id);
    const projects = [];
    for (const p of g.projects) {
      if (!isObject(p) || !isAbsolute(p.path) || typeof p.name !== "string") return emptyRegistry();
      const path = normPath(p.path);
      if (paths.has(path)) continue;
      paths.add(path);
      projects.push({ path, name: p.name });
    }
    groups.push({ id: g.id, name: g.name, projects });
  }
  const activeGroup = ids.has(value.activeGroup) ? value.activeGroup : groups[0].id;
  return { version: 1, groups, activeGroup };
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

// ── Other persisted keys ───────────────────────────────────────────────────

// `projects.ui.v1`: the collapsed projects, by path.
export function parseUi(value) {
  const collapsed = isObject(value) && Array.isArray(value.collapsed) ? value.collapsed : [];
  return { collapsed: [...new Set(collapsed.filter(isAbsolute).map((p) => normPath(p)))] };
}

export function withCollapsed(ui, path, collapsed) {
  const p = normPath(path);
  const rest = ui.collapsed.filter((x) => x !== p);
  const next = collapsed ? [...rest, p] : rest;
  return next.length === ui.collapsed.length && next.every((x, i) => x === ui.collapsed[i]) ? ui : { collapsed: next };
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

// Which workspace each space shows: { [spaceId]: { project, path } }, from
// the worktree lists (`cache`: projects.cache.v1), spaces() and panes()
// (mods/worktree/main.js `spaceOf`). A space matches when it is on this
// machine and its live folder (placeOf) is a checkout or inside one; the
// deepest checkout wins. Spaces that match nothing are absent: the sidebar
// shows them nowhere. The tree and the attention dot both use this.
export function matchSpaces(cache, spaces, panes, home) {
  const checkouts = [];
  for (const [project, list] of Object.entries(cache ?? {})) {
    for (const c of Array.isArray(list) ? list : []) checkouts.push({ project: normPath(project, home), path: normPath(c?.path, home) });
  }
  const out = {};
  for (const space of spaces ?? []) {
    if ((space.machine ?? null) !== null) continue;
    const at = normPath(placeOf(space, panes), home);
    if (!isAbsolute(at)) continue;
    let best = null;
    for (const c of checkouts) if (c.path && inside(at, c.path) && (!best || c.path.length > best.path.length)) best = c;
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
