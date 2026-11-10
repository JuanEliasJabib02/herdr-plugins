// Which workspace (a git checkout) and project each space is in, so an
// agent's row can name its project and open its workspace's menu. The rule is
// projects-sidebar's (projects/lib.js matchSpaces): the space's first
// terminal's live folder, else the folder it was made in; the deepest
// checkout of the worktree lists that is that folder or holds it; spaces on
// another machine match nothing. It reads the same shared keys the sidebar
// writes. A mod can't import another mod's files, so this is a copy, and
// the root suite holds it to matchSpaces. Pure.

export const REGISTRY_KEY = "projects.v1"; // { groups: [{ projects: [{ path, name }] }] }
export const CACHE_KEY = "projects.cache.v1"; // { [projectPath]: [{ path, branch, main }] }

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function normPath(path, home) {
  if (typeof path !== "string" || !path) return "";
  let p = path.replace(/\\/g, "/");
  if (home && (p === "~" || p.startsWith("~/"))) p = normPath(home) + p.slice(1);
  return p.replace(/\/+$/, "") || "/";
}

const isAbsolute = (path) => typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:\//.test(path));
const inside = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? "";

function placeOf(space, panes) {
  const tabs = new Set((Array.isArray(space.tabs) ? space.tabs : []).map((t) => t?.id));
  return panes.find((p) => isObject(p) && tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

// space id → { project, path, main, name }: the project's and the
// checkout's paths (`~` expanded), whether it is the main checkout, and the
// project's name as the sidebar shows it (its folder's when unnamed).
export function workspacesBySpace({ registry, cache, spaces = [], panes = [], home = "" } = {}) {
  const names = new Map();
  for (const g of isObject(registry) && Array.isArray(registry.groups) ? registry.groups : []) {
    for (const p of Array.isArray(g?.projects) ? g.projects : []) {
      const path = normPath(p?.path, home);
      if (path && typeof p.name === "string" && p.name && !names.has(path)) names.set(path, p.name);
    }
  }
  const checkouts = [];
  for (const [project, list] of Object.entries(isObject(cache) ? cache : {})) {
    for (const c of Array.isArray(list) ? list : []) {
      const path = normPath(c?.path, home);
      if (path) checkouts.push({ project: normPath(project, home), path, main: c?.main === true });
    }
  }
  const out = new Map();
  for (const space of Array.isArray(spaces) ? spaces : []) {
    if (!isObject(space) || (space.machine ?? null) !== null) continue;
    const at = normPath(placeOf(space, Array.isArray(panes) ? panes : []), home);
    if (!isAbsolute(at)) continue;
    let best = null;
    for (const c of checkouts) if (inside(at, c.path) && (!best || c.path.length > best.path.length)) best = c;
    if (best) out.set(space.id, { project: best.project, path: best.path, main: best.main, name: names.get(best.project) ?? baseName(best.project) });
  }
  return out;
}

// What an agent's row offers of its workspace's menu: Sleep, Rename… and
// Delete… (asked for: only these, plus a manual Sleep for the agent);
// the sidebar's own keeps everything.
export const AGENT_MENU = Object.freeze(["sleep", "rename", "delete"]);

// The row's right-click: the sidebar's own menu with only AGENT_MENU, as a
// 1 px frameless popup at the pointer, the projects mod's
// `workspace-menu-at` view, which opens the real one from inside that mod
// (with the height its items take) and closes itself. The main checkout's
// asks for Sleep alone: it is never renamed or deleted, whatever the menu's
// own lookup of the checkout finds. Null for no workspace.
export function workspaceMenuSpec(w) {
  if (!isObject(w) || typeof w.path !== "string" || !w.path) return null;
  const only = w.main === true ? ["sleep"] : [...AGENT_MENU];
  return { mod: "projects", kind: "popup", width: 1, height: 1, frame: "none", props: { view: "workspace-menu-at", project: w.project, path: w.path, only } };
}
