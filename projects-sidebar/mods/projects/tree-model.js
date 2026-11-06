// The projects tree's model, with no herdr or gpui-kit imports so
// `node --test` can load it: the rows of the active group (projects, their
// workspaces and agents) from the registry, the worktree cache and Herdr's
// live spaces; what a click opens (D8); Add project (D10) with the herdr side
// passed in; the project and workspace menus' items; what the Delete dialog
// says and what its outcome does (D22); the narrow rail; and the helpers of
// the worktree engine (D6). tree.js, the menus and delete-workspace.js draw
// and act on it.

import { normPath, baseName, placeOf, activeGroup, findProject, addProject, matchSpaces } from "./lib.js";

// ── Statuses ───────────────────────────────────────────────────────────────

// Most urgent first (SpaceInfo.status): blocked > done > working > idle.
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// The most urgent of some statuses, or null when none is set.
export function mostUrgent(statuses) {
  let best = null;
  for (const s of statuses ?? []) if ((RANK[s] ?? 0) > (RANK[best] ?? 0)) best = s;
  return best;
}

// ── Names ──────────────────────────────────────────────────────────────────

// What a workspace row says (D8, D27): the main checkout by its branch
// (Orca); another worktree by its branch's last segment ("user/feat-x" →
// "feat-x"), so a rename shows even when the folder keeps its name; a
// detached checkout or a folder outside git by its folder.
export function workspaceLabel(checkout) {
  if (checkout.main) return checkout.branch || baseName(checkout.path);
  const leaf = String(checkout.branch ?? "").split("/").filter(Boolean).pop();
  return leaf || baseName(checkout.path);
}

// A project in the narrow rail: the first letters of its first two words
// ("herdr-plugins" → "HP"), or of its one word ("app" → "A").
export function initials(name) {
  const words = String(name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

// A terminal title without the spinner or mark agents put in front of it
// (mods/agents/main.js `clean`).
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// An agent row's text (mods/agents/main.js `title`): the agent's live title
// when it says something (not its program, a path or user@host) and nobody
// named the tab; else the tab's name; a bare tab number says the program.
// The path test also looks at the raw title: `clean` strips a leading "~/".
const pathLike = (s) => /^[~/]|^[A-Za-z]:\\/.test(s);
export function agentTitle(agent, tab) {
  const prog = agent?.program?.name;
  const live = clean(agent?.title);
  const telling = Boolean(live) && live !== prog && !pathLike((agent?.title ?? "").trim()) && !pathLike(live) && !live.includes("@") && live.toLowerCase() !== agent?.program?.key;
  const label = tab ? ((tab.name === prog || !tab.named) && telling ? live : tab.name) : telling ? live : "";
  return label && !/^\d+$/.test(label) ? label : prog || agent?.app || "agent";
}

// Time since a change (mods/agents/main.js `duration`); "" for none.
export function ago(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// ── The tree ───────────────────────────────────────────────────────────────

// A project's workspaces, from its worktree list (projects.cache.v1) and the
// spaces matchSpaces() put on each. `space` is the one a click selects: the
// shown one, else the first.
export function workspacesOf(list, { matches, spaces, agents, tabs, now }) {
  return (list ?? []).map((c) => {
    const path = normPath(c.path);
    const on = (spaces ?? []).filter((s) => matches?.[s.id]?.path === path);
    const ids = new Set(on.map((s) => s.id));
    const shown = on.find((s) => s.active) ?? on[0];
    return {
      path,
      branch: c.branch ?? null,
      main: Boolean(c.main),
      label: workspaceLabel({ ...c, path }),
      space: shown?.id ?? null,
      open: on.length > 0,
      selected: on.some((s) => s.active),
      status: mostUrgent(on.map((s) => s.status)),
      agents: (agents ?? []).filter((a) => ids.has(a.space)).map((a) => {
        const tab = tabs?.get(a.tab);
        return {
          address: a.address,
          pane: a.pane,
          status: a.status,
          title: agentTitle(a, tab),
          since: typeof tab?.changed_at === "number" ? ago(now - tab.changed_at) : "",
          program: a.program ?? null,
        };
      }),
    };
  });
}

// The active group's tree: { group, empty, projects, rows }.
//   registry: projects.v1; cache: projects.cache.v1 (every group's lists, so
//   the deepest checkout wins across projects); spaces, panes, agents: Herdr's
//   live lists; collapsed: projects.ui.v1's paths; home: for `~`; now: ms;
//   failed: paths whose last listing failed (git couldn't run there).
// `projects` carry what the narrow rail shows (initials, most urgent status,
// selected). `rows` is what the wide tree draws, in order: a project, then,
// unless collapsed, its workspaces (or, while it has no list, one loading
// row, or a missing row once listing it failed), each followed by its
// agents. Spaces outside every registered project appear nowhere (S14, S15).
export function buildTree({ registry, cache, spaces, panes, agents, collapsed, home, now, failed }) {
  const group = activeGroup(registry);
  const matches = matchSpaces(cache, spaces, panes, home);
  const tabs = new Map((spaces ?? []).flatMap((s) => s.tabs ?? []).map((t) => [t.id, t]));
  const folded = new Set((collapsed ?? []).map((p) => normPath(p)));
  const projects = group.projects.map((p) => {
    const list = cache?.[p.path];
    const workspaces = workspacesOf(list, { matches, spaces, agents, tabs, now });
    const missing = !list && Boolean(failed?.has(p.path));
    return {
      path: p.path,
      name: p.name,
      initials: initials(p.name),
      collapsed: folded.has(p.path),
      loading: !list && !missing,
      missing,
      status: mostUrgent(workspaces.map((w) => w.status)),
      selected: workspaces.some((w) => w.selected),
      workspaces,
    };
  });
  const rows = [];
  for (const p of projects) {
    rows.push({ kind: "project", ...p });
    if (p.collapsed) continue;
    if (p.loading) rows.push({ kind: "loading", project: p.path });
    if (p.missing) rows.push({ kind: "missing", project: p.path });
    for (const w of p.workspaces) {
      rows.push({ kind: "workspace", project: p.path, ...w });
      for (const a of w.agents) rows.push({ kind: "agent", project: p.path, workspace: w.path, ...a });
    }
  }
  return { group: { id: group.id, name: group.name }, empty: projects.length === 0, projects, rows };
}

// ── What a click opens (D8) ────────────────────────────────────────────────

// A workspace's command: its space exists → select it; else a new space in
// its folder, named by its label. { name, args } for run().
export function openAction(ws) {
  return ws.space
    ? { name: "space.select", args: { id: ws.space } }
    : { name: "space.new", args: { folder: ws.path, name: ws.label } };
}

// A project's main checkout, opened per D8: Add project and Open main. A
// project with no list yet opens at its own folder.
export function openMainAction({ project, cache, spaces, panes, home }) {
  const path = normPath(project);
  const list = cache?.[path] ?? [{ path, branch: null, main: true }];
  const matches = matchSpaces({ ...cache, [path]: list }, spaces, panes, home);
  const all = workspacesOf(list, { matches, spaces });
  return openAction(all.find((w) => w.main) ?? all[0]);
}

// A project in the narrow rail: the workspace shown now stays, else the
// first one with a space is selected, else the main checkout opens.
export function railAction(project) {
  const ws = project.workspaces;
  const pick = ws.find((w) => w.selected) ?? ws.find((w) => w.open) ?? ws.find((w) => w.main) ?? ws[0];
  return openAction(pick ?? { path: project.path, label: project.name, space: null });
}

// The sidebar's rail goes by its width (mods/spaces/main.js `narrow`):
// below 160 px the tree shows initials.
export function isNarrow(layout) {
  const px = find(layout, "sidebar")?.size?.px;
  return typeof px === "number" && px < 160;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ── Add project (D10) ──────────────────────────────────────────────────────

// The focused space's live folder (Add project from here): { folder } or
// { error } when no space is focused, it's on another machine (projects
// are local) or it has no folder.
export function liveFolder(focused, spaces, panes) {
  const space = (spaces ?? []).find((s) => s.id === focused?.space);
  if (!space) return { error: "No space is focused." };
  if ((space.machine ?? null) !== null) return { error: `${space.name || "That space"} is on ${space.machine}: projects are folders on this computer.` };
  const folder = placeOf(space, panes);
  return folder ? { folder } : { error: `${space.name || "That space"} has no folder.` };
}

// Adds the project a folder belongs to and opens its main checkout. The
// folder resolves to its repo's main checkout (or itself outside git); the
// project joins the active group, or, already registered, its group becomes
// active (lib.js addProject); its worktrees are listed into the cache; then
// its main checkout's space is selected or made (D8). It needs no open
// space (S6). `io` is the herdr side:
//   { resolve(folder), list(path), updateRegistry(fn), cache(), saveWorktrees(path, list),
//     spaces(), panes(), home, run(name, args) }
// Resolves { project, action }; rejects when the folder can't be resolved.
export async function addProjectAt(folder, io) {
  const project = await io.resolve(folder);
  const path = normPath(project.path);
  io.updateRegistry((r) => addProject(r, { path, name: project.name }));
  let list = io.cache()[path];
  try {
    list = await io.list(path);
    io.saveWorktrees(path, list);
  } catch {
    // git can't run there: the project stays, listed again later.
  }
  const cache = list ? { ...io.cache(), [path]: list } : io.cache();
  const action = openMainAction({ project: path, cache, spaces: io.spaces(), panes: io.panes(), home: io.home });
  io.run(action.name, action.args);
  return { project: { path, name: project.name }, action };
}

// ── Workspace menu (D20) ───────────────────────────────────────────────────

// The right-click menu of a workspace row: [{ id, label, text?, separator?,
// danger? }]. Copy Path and Copy Worktree Name (its folder's name, not the
// branch) on every checkout; on a worktree that isn't the main checkout,
// after a separator, Delete… in the blocked color (S20, S21). The main
// checkout is never deleted. Unknown row: [].
export function workspaceMenuItems(row) {
  if (!row?.path) return [];
  return [
    { id: "copy-path", label: "Copy Path", text: row.path },
    { id: "copy-name", label: "Copy Worktree Name", text: baseName(row.path) },
    ...(row.main ? [] : [{ id: "delete", label: "Delete…", separator: true, danger: true }]),
  ];
}

// ── Delete dialog (D22) ────────────────────────────────────────────────────

// A path as people read it: the home folder as ~.
function tilde(path, home) {
  const h = normPath(home);
  if (!h || h === "/") return path;
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

// How many terminals are in the folder at `path` (or below it) and stay open
// because their space isn't one that closes: panes() whose cwd is there,
// on this computer, outside the `closing` space ids. Mod panes have no
// terminal and don't count.
export function terminalsStaying(path, closing, spaces, panes, home) {
  const dir = normPath(path, home);
  if (!dir) return 0;
  const shut = new Set(closing ?? []);
  const spaceOf = new Map();
  for (const s of spaces ?? []) for (const t of s.tabs ?? []) spaceOf.set(t.id, s);
  return (panes ?? []).filter((p) => {
    const s = spaceOf.get(p.tab);
    if (!p.terminal || !s || shut.has(s.id) || (s.machine ?? null) !== null) return false;
    const at = normPath(p.cwd, home);
    return at === dir || at.startsWith(`${dir}/`);
  }).length;
}

// What the Delete dialog says about the workspace at `path` (D22).
//   row: its { path, branch, main } (the check's fresh list, else the cache),
//     null when unknown; check: removalCheck's answer, null while asking;
//   spaces: how many of its spaces close; terminals: terminalsStaying().
// Resolves { label, title, path, branch, notes, warnings, reason, checking,
// ready, button }: notes are what closes or stays; warnings what is lost;
// reason why it can't run (locked, git unanswered, not a worktree); ready:
// Delete may run; button: "Delete", "Delete anyway" (changes or submodules:
// a forced remove), or null when it can't run at all.
export function deletePrompt({ path, row, check, spaces, terminals, home }) {
  const at = normPath(path);
  const label = row ? workspaceLabel({ ...row, path: normPath(row.path) || at }) : baseName(at);
  const notes = [];
  if (spaces === 1) notes.push("Its space closes, with its agents.");
  else if (spaces > 1) notes.push(`Its ${spaces} spaces close, with their agents.`);
  if (terminals === 1) notes.push("1 more terminal is in this folder and stays open.");
  else if (terminals > 1) notes.push(`${terminals} more terminals are in this folder and stay open.`);
  const can = Boolean(check?.deletable);
  const warnings = [];
  if (can && check.changes) warnings.push(`${label} has changes that aren't committed. They'll be lost.`);
  if (can && check.submodules) warnings.push(`${label} has submodules. They're deleted too.`);
  return {
    label,
    title: `Delete ${label}?`,
    path: tilde(at, home),
    branch: row ? (row.branch ? `Branch ${row.branch}` : "Detached HEAD") : "",
    notes,
    warnings,
    reason: check && !can ? check.reason : "",
    checking: !check,
    ready: can,
    button: check && !can ? null : warnings.length ? "Delete anyway" : "Delete",
  };
}

// What a removeWorkspace result (remove-workspace-model.js) does to the
// dialog, and the toast it posts: { close, toast, error, check }.
//   open: the dialog is still there. While it is, a removal closes it (the
//   row is gone) and only a branch that stays gets a toast; any other
//   outcome stays in it as `error`. Once it closed (Esc during the delete),
//   every outcome is a toast.
//   check: the fresh check the dialog shows from now on ("changed", "locked",
//   "refused"), null to keep its own (after "failed" Delete can run again).
export function deleteOutcome(r, { label, open }) {
  const b = r?.check?.branch;
  const into = r?.check?.mainBranch ?? "the main checkout";
  if (r?.status === "removed") {
    const kept = r.branch === "kept" ? `It isn't merged into ${into}.` : r.branch === "in-use" ? "Another workspace has it checked out." : "";
    if (open) return { close: true, toast: kept ? { title: `Kept branch ${b}`, body: kept } : null, error: "", check: null };
    const body = kept ? `Kept branch ${b}: ${kept[0].toLowerCase()}${kept.slice(1)}` : r.branch === "deleted" ? `Branch ${b} too.` : "";
    return { close: false, toast: { title: `Deleted ${label}`, body, level: "success" }, error: "", check: null };
  }
  const err = r?.err || "git couldn't delete it.";
  if (!open) return { close: false, toast: { title: `Didn't delete ${label}`, body: err, level: r?.status === "failed" ? "error" : "warning" }, error: "", check: null };
  const fresh = ["changed", "locked", "refused"].includes(r?.status) && r.check ? r.check : null;
  // A lock or a refusal is the fresh check's own reason: said once.
  return { close: false, toast: null, error: fresh?.reason === err ? "" : err, check: fresh };
}

// ── Project menu (D11) ─────────────────────────────────────────────────────

// The right-click menu of a project: [{ id, label, disabled?, group? }].
// `move`: the Move to group submenu, the other groups. Unknown project: [].
export function projectMenuItems(registry, path, move = false) {
  const found = findProject(registry, path);
  if (!found) return [];
  const others = registry.groups.filter((g) => g.id !== found.group.id);
  if (move) return others.map((g) => ({ id: "move-to", label: g.name, group: g.id }));
  return [
    { id: "open-main", label: "Open main" },
    { id: "new-workspace", label: "New workspace…" },
    { id: "move", label: "Move to group", disabled: others.length === 0 },
    { id: "remove", label: "Remove from list" },
  ];
}

// The cache without one project's list (Remove from list), so matchSpaces
// never matches a project that's gone. A new value; the input stays.
export function withoutProject(cache, path) {
  const p = normPath(path);
  return Object.fromEntries(Object.entries(cache ?? {}).filter(([k]) => k !== p));
}

// The cache with only the registered projects' lists; the same value when
// nothing goes (the tree copy writes only on change).
export function pruneCache(cache, paths) {
  const keep = new Set((paths ?? []).map((p) => normPath(p)));
  const all = cache ?? {};
  return Object.keys(all).every((k) => keep.has(k)) ? all : Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k)));
}

// ── Worktree engine (D6) ───────────────────────────────────────────────────

// Every group's project paths: the engine lists and watches them all, so the
// groups' attention dot (D9) sees every group's workspaces.
export function projectPaths(registry) {
  return registry.groups.flatMap((g) => g.projects.map((p) => p.path));
}

// Where a project's worktree changes show, in the order to try: its
// .git/worktrees while it has linked worktrees (git removes the folder with
// the last one), else its .git (the first `worktree add` creates it there).
export function watchDirs(project, list) {
  const git = `${normPath(project)}/.git`;
  return (list ?? []).some((c) => !c.main) ? [`${git}/worktrees`, git] : [git];
}

// Runs fn over items with at most `limit` at once (one git per project, ~30
// projects at start). Resolves, in items' order, [{ ok, value } | { ok: false, error }]:
// one failure never stops the rest.
export async function eachLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
