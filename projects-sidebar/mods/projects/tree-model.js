// The projects tree's model, with no herdr or gpui-kit imports so
// `node --test` can load it: the rows of the active group (projects, their
// workspaces and agents) from the registry, the worktree cache and Herdr's
// live spaces; what a click opens (D8); Add project (D10) with the herdr side
// passed in; the project and workspace menus' items; Hide sleeping and its
// popup's items (workspace-sleep D8); what the Delete and Rename dialogs say
// and what their outcomes do (D22, D25, D28); the narrow rail; and the
// helpers of the worktree engine (D6). tree.js, the menus, filter-menu.js,
// delete-workspace.js and rename-workspace.js draw and act on it.

import { normPath, baseName, placeOf, activeGroup, findProject, addProject, matchSpaces } from "./lib.js";
import { renameTarget, folderFor } from "./rename-workspace-model.js";

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

// A space nobody can see: every tab of it put away (`tab.settle`). A space
// with no tabs listed isn't taken as one.
function putAway(s) {
  const tabs = s.tabs ?? [];
  return tabs.length > 0 && tabs.every((t) => t.settled === true);
}

// A project's workspaces, from its worktree list (projects.cache.v1) and the
// spaces matchSpaces() put on each. `space` is the one a click selects: the
// shown one, else the first. `asleep` (Orca's moon, workspace-sleep D3): no
// space shows it, or every space on it is put away; nothing here knows who
// put it away.
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
      asleep: on.every(putAway),
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

// Whether Hide sleeping (workspace-sleep D8, Orca's workspace-row-filters.ts
// sleeping sweep) leaves a workspace out of the rows: it is asleep by D3's
// rule (never opened included, as in Orca), shows the moon (an agent that
// needs attention keeps its mark, D3, so it stays, as Orca keeps a worktree
// with a live agent), isn't the shown one, and isn't a main checkout kept by
// Except default branch. `w`: a workspacesOf() entry.
export function hiddenAsleep(w, { hideSleeping = false, exceptMain = true } = {}) {
  if (hideSleeping !== true || !w.asleep || w.selected) return false;
  if (Boolean(w.status) && w.status !== "idle") return false;
  return !(exceptMain !== false && w.main);
}

// The active group's tree: { group, empty, projects, rows }.
//   registry: projects.v1; cache: projects.cache.v1 (every group's lists, so
//   the deepest checkout wins across projects); spaces, panes, agents: Herdr's
//   live lists; collapsed: projects.ui.v1's paths; home: for `~`; now: ms;
//   failed: paths whose last listing failed (git couldn't run there);
//   hideSleeping, exceptMain: projects.ui.v1's sleeping filter (D8),
//   off and on by default.
// `projects` carry what the narrow rail shows (initials, most urgent status,
// selected), every workspace included: the filter only drops rows. `rows` is
// what the wide tree draws, in order: a project, then, unless collapsed, its
// workspaces (or, while it has no list, one loading row, or a missing row
// once listing it failed), each followed by its agents. A workspace Hide
// sleeping leaves out (hiddenAsleep) goes with its agents; its project's row
// stays. Spaces outside every registered project appear nowhere (S14, S15).
export function buildTree({ registry, cache, spaces, panes, agents, collapsed, home, now, failed, hideSleeping = false, exceptMain = true }) {
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
  const filter = { hideSleeping, exceptMain };
  const rows = [];
  for (const p of projects) {
    rows.push({ kind: "project", ...p });
    if (p.collapsed) continue;
    if (p.loading) rows.push({ kind: "loading", project: p.path });
    if (p.missing) rows.push({ kind: "missing", project: p.path });
    for (const w of p.workspaces) {
      if (hiddenAsleep(w, filter)) continue;
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

// ── Filter popup (workspace-sleep D8) ──────────────────────────────────────

// The header's filter popup, Orca's SidebarFilter.tsx: [{ id, label, icon,
// on, indented? }], each a switch. "Hide sleeping" (the moon), off by
// default; while it's on, "Except default branch" (the branch), indented,
// on by default. `ui`: projects.ui.v1 (lib.js parseUi). `icon` is one of
// this mod's icons (config.js icon).
export function filterMenuItems(ui) {
  const hiding = ui?.hideSleeping === true;
  return [
    { id: "hide-sleeping", label: "Hide sleeping", icon: "moon", on: hiding },
    ...(hiding ? [{ id: "except-main", label: "Except default branch", icon: "branch", on: ui.exceptMain !== false, indented: true }] : []),
  ];
}

// ── Workspace menu (D20) ───────────────────────────────────────────────────

// Sleep's hover text: what agent-sleep's workspace sleep does (Orca's says
// "Close all active panels in this workspace to free up memory and CPU.";
// this one closes nothing).
export const SLEEP_TOOLTIP = "Puts its agents to sleep and its tabs away, to free up memory and CPU. Opening it wakes them.";

// The command Sleep runs: agent-sleep's `sleep-workspace.<hex>`, the path's
// UTF-8 in hex (a command is only a name). A copy of agent-sleep's
// workspace-sleep.js sleepWorkspaceCommand, since a mod can't import
// another's files; the root suite holds the two together. Null for no
// absolute path.
export function sleepCommand(path) {
  if (typeof path !== "string" || !(path.startsWith("/") || /^[A-Za-z]:\//.test(path))) return null;
  let bytes;
  try {
    bytes = encodeURIComponent(path);
  } catch {
    return null; // a lone surrogate
  }
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === "%") {
      hex += bytes.slice(i + 1, i + 3).toLowerCase();
      i += 2;
    } else hex += bytes.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `agent-sleep.sleep-workspace.${hex}`;
}

// The right-click menu of a workspace row: [{ id, label, text?, tooltip?,
// disabled?, why?, separator?, danger? }]. First Sleep (workspace-sleep T6,
// Orca's, on every checkout, the main one too), then Copy Path and Copy
// Worktree Name (its folder's name, not the branch); on a worktree that isn't
// the main checkout, Rename… (S22), then, after a separator, Delete… in the
// blocked color (S20, S21). The main checkout is never renamed or deleted. A
// detached worktree gets Rename… too: its dialog says why it can't. Unknown
// row: []. `sleep`: { open, asleep } as workspacesOf says them (the moon's
// rule): Sleep is off, saying why, with no space open on it or every one put
// away; unknown (undefined), it's on, and agent-sleep says why if it can't.
export function workspaceMenuItems(row, sleep) {
  if (!row?.path) return [];
  const why = !sleep ? null : !sleep.open ? "Nothing open to put to sleep" : sleep.asleep ? "Already asleep" : null;
  return [
    { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP, ...(why ? { disabled: true, why } : {}) },
    { id: "copy-path", label: "Copy Path", text: row.path },
    { id: "copy-name", label: "Copy Worktree Name", text: baseName(row.path) },
    ...(row.main ? [] : [
      { id: "rename", label: "Rename…" },
      { id: "delete", label: "Delete…", separator: true, danger: true },
    ]),
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

// ── Rename dialog (D25) ────────────────────────────────────────────────────

// renameCheck refusals that no name changes: the workspace can't be renamed
// at all, so the dialog has no input and no Rename.
const STUCK = ["missing", "main", "detached"];

// Refusals the live line already says ("Type a new name for the branch.", or
// CASE_ONLY).
const UNNAMED = ["empty", "unchanged"];

// The live line for a name that differs from the branch only in case
// (renameTarget's caseOnly): git on macOS finds that branch already there.
const CASE_ONLY = "Only the case changes: git on macOS can't rename a branch that way.";

// renameCheck refusals of what origin has, whatever name is typed (D28):
// shown until a check says otherwise, with the input still there.
const ORIGIN_STUCK = ["unreachable", "pushed-elsewhere", "no-push"];

// What Rename does on origin, said before Rename (D28): GitHub renames it
// too, a copy is pushed, or origin no longer has it. "" for a branch no
// remote has. `name`: the new name, null while none is typed.
function originLine(origin, old, name) {
  if (!origin?.published) return "";
  if (origin.route === "github") return `Renames it on GitHub too (${origin.repo.owner}/${origin.repo.repo}).`;
  if (origin.route === "copy") return `Pushes a copy ${name ? `as ${name}` : "under the new name"}; origin keeps ${old}.`;
  return origin.gone ? `origin no longer has ${old}: renames it here only.` : "";
}

// Why the folder can't move, or "" when it can (D25, D26 step 3). git's own
// reasons first, since closing a terminal wouldn't move a locked folder.
// null while git hasn't answered.
function folderStays(check, spaces, terminals) {
  if (!check) return null;
  if (check.locked) return "locked by git";
  if (check.submodules) return "has submodules";
  if (check.failed) return "git couldn't check it";
  if (spaces > 0 || terminals > 0) return "a terminal is open there";
  return "";
}

// What the Rename dialog says about the workspace at `path` (D25).
//   row: its { path, branch, main } (removalCheck's fresh list, else the
//     cache), null when unknown; text: the name input as typed;
//   check: removalCheck's answer on open (null while asking): whether git
//     lets the folder move (locked, submodules);
//   live: the last renameCheck answer, { status, reason, err, origin,
//     folderTaken, newPath, text }, text being what it checked; null before
//     the first. It is asked with moveFolder false, so a taken folder comes
//     back as folderTaken and refuses here only when the folder would move;
//   spaces: how many spaces show the workspace; terminals: terminal panes in
//     its folder. Either keeps the folder where it is.
// Resolves { label, title, path, branch, name, line, remote, warnings,
// moveFolder, reason, checking, ready, button, editable }: branch: the
// branch now (the input's prefill); name: what the text becomes
// (renameTarget); line: the live line, "branch <old> → <new> · folder <new>"
// or "· folder stays <old> (<why>)", CASE_ONLY when only the case changes,
// else "Type a new name for the branch." while unnamed; remote: what Rename
// does on origin (D28), "" when nothing; warnings: the PRs GitHub closes;
// moveFolder: what renameWorkspace gets; reason: a refusal, of the workspace
// (detached, the main checkout: no input, no Rename; origin unreachable,
// pushed elsewhere, no push access) or of the typed name (on origin, taken),
// shown before Enter; ready: Enter may rename; button: "Rename", "Rename
// anyway" (a PR closes) or null.
export function renamePrompt({ path, row, text, check, live, spaces, terminals, home }) {
  const at = normPath(path);
  const label = row ? workspaceLabel({ ...row, path: normPath(row.path) || at }) : baseName(at);
  const old = row?.branch ?? null;
  const folder = baseName(at);
  const target = renameTarget(text, old);
  const stuck = live?.status === "refused" && STUCK.includes(live.reason);
  const why = folderStays(check, spaces, terminals);
  const moveFolder = why === "";
  const current = Boolean(live) && live.text === text;
  const originStuck = !stuck && live?.status === "refused" && ORIGIN_STUCK.includes(live.reason);
  let refusal = "";
  if (originStuck) refusal = live.err;
  else if (current && live.status === "refused" && live.reason === "folder-exists") refusal = moveFolder ? live.err : "";
  else if (current && live.status === "refused" && !STUCK.includes(live.reason) && !UNNAMED.includes(live.reason)) refusal = live.err;
  else if (current && live.status === "ok" && live.folderTaken && moveFolder) refusal = `${live.newPath} already exists.`;
  const origin = stuck || originStuck ? null : live?.origin ?? null;
  const named = Boolean(target.name) && !target.unchanged;
  const warnings = origin?.route === "github" ? origin.prs.map((pr) => `GitHub closes PR #${pr.number} when its branch is renamed.`) : [];
  let line = "";
  if (!stuck && target.caseOnly) line = CASE_ONLY;
  else if (!stuck && (!target.name || target.unchanged)) line = "Type a new name for the branch.";
  else if (!stuck && old) {
    line = `branch ${old} → ${target.name}`;
    // The folder part waits for git. A folder that already has the name
    // stays (macOS folders ignore case, as renameCheck's sameFolder).
    if (why !== null) {
      const to = folderFor(at, target.name);
      if (to.toLowerCase() === at.toLowerCase()) line += ` · folder stays ${folder}`;
      else line += moveFolder ? ` · folder ${baseName(to)}` : ` · folder stays ${folder} (${why})`;
    }
  }
  return {
    label,
    title: `Rename ${label}`,
    path: tilde(at, home),
    branch: old,
    name: target.name,
    line,
    remote: old ? originLine(origin, old, named ? target.name : null) : "",
    warnings,
    moveFolder,
    // With no branch known (the tree hasn't listed it) and git unable to
    // list, the check's own reason says why Rename stays off.
    reason: stuck ? live.err : refusal || (!old && check?.failed ? check.reason : ""),
    checking: !check,
    ready: Boolean(check) && !stuck && !refusal && Boolean(old) && Boolean(target.name) && !target.unchanged,
    button: stuck ? null : warnings.length ? "Rename anyway" : "Rename",
    editable: !stuck,
  };
}

// What a renameWorkspace result (rename-workspace-model.js) does to the
// dialog, and the toast it posts: { close, toast, error, live }.
//   label: the workspace's label before; path: its folder before; open: the
//   dialog is still there.
// A rename closes the dialog (the row has its new name); it posts a toast
// while open only when something went other than asked (git kept the folder,
// the old upstream stayed, GitHub is still finishing). A remote rename or
// copy whose local `branch -m` then failed (D28: branch is still the old
// one) closes it too, with a toast that says how to finish: a second Rename
// would find origin already has the name. "changed" (D28: what origin has
// moved since the dialog checked) stays in it, with the fresh check as
// `live`. A refusal stays in the dialog as `live`, the refusal the dialog
// shows (said once); a failure as `error`. Once the dialog closed (Esc
// during the rename), every outcome is a toast.
export function renameOutcome(r, { label, path, open }) {
  if (r?.status === "renamed" && r.name && r.branch !== r.name) {
    return { close: open, toast: { title: `Didn't rename ${label} here`, body: r.err, level: "warning" }, error: "", live: null };
  }
  if (r?.status === "renamed") {
    const folder = baseName(normPath(path));
    const there = r.remote === "renamed" ? "Renamed on GitHub too." : r.remote === "copied" ? `origin has a copy as ${r.branch}.` : "";
    const where = r.folder === "moved"
      ? `Its folder is now ${baseName(folderFor(path, r.branch))}.`
      : r.folder === "kept" ? `Its folder stays ${folder}:` : `Its folder stays ${folder}.`;
    const body = [there, where, r.err].filter(Boolean).join(" ");
    const warn = r.folder === "kept" || Boolean(r.err);
    const toast = { title: `Renamed ${label} to ${r.branch}`, body, level: warn ? "warning" : "success" };
    return { close: open, toast: open && !warn ? null : toast, error: "", live: null };
  }
  const err = r?.err || "git couldn't rename it.";
  if (!open) return { close: false, toast: { title: `Didn't rename ${label}`, body: err, level: r?.status === "failed" ? "error" : "warning" }, error: "", live: null };
  if (r?.status === "changed") return { close: false, toast: null, error: err, live: r.check ?? null };
  // An empty or unchanged name the live line would hide (the branch changed
  // outside meanwhile) is said as an error instead.
  if (r?.status === "refused" && !UNNAMED.includes(r.reason)) return { close: false, toast: null, error: "", live: { status: "refused", reason: r.reason, err } };
  return { close: false, toast: null, error: err, live: null };
}

// S39: after a branch rename, the spaces on that workspace still named after
// its old label (the name openAction gave them) take the new label, so the
// agents list, which shows space names, says what the tree says. A space
// named otherwise keeps it, and so does one nobody named (Herdr calls it
// after its repo). path: the workspace's folder before any move (a moved
// folder had no space in it). [{ id, name }] for run("space.rename").
export function spaceRenames({ path, before, after, spaces, matches }) {
  const at = normPath(path);
  if (!at || !before || !after || !Array.isArray(spaces) || !matches) return [];
  const from = workspaceLabel({ branch: before, path: at });
  const to = workspaceLabel({ branch: after, path: at });
  if (from === to) return [];
  return spaces
    .filter((s) => s?.named && s.name === from && matches[s.id]?.path === at)
    .map((s) => ({ id: s.id, name: to }));
}

// ── Project menu (D11) ─────────────────────────────────────────────────────

// D33 (S28): drag a project row to reorder its group. Moves `path` right
// before `target`, or right after it with `after`, within the project's own
// group. Nothing to move (the same place, a target in another group, an
// unknown path) → the same registry. Only the order of group.projects
// changes, so the stored value keeps its format.
export function reorderProject(registry, path, target, after) {
  const from = normPath(path);
  const to = normPath(target);
  const found = findProject(registry, from);
  if (!found || from === to) return registry;
  const list = found.group.projects;
  if (!list.some((p) => p.path === to)) return registry;
  const moved = list.find((p) => p.path === from);
  const rest = list.filter((p) => p !== moved);
  const at = rest.findIndex((p) => p.path === to) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
  if (next.every((p, k) => p === list[k])) return registry;
  return { ...registry, groups: registry.groups.map((g) => (g.id === found.group.id ? { ...g, projects: next } : g)) };
}

// The right-click menu of a project: [{ id, label, disabled?, group? }].
// `move`: the Move to group submenu, the other groups. Unknown project: [].
// Default branch… (D37) opens the base menu, where the project's saved base
// is set; it shows on every project, and the menu says when one isn't git.
export function projectMenuItems(registry, path, move = false) {
  const found = findProject(registry, path);
  if (!found) return [];
  const others = registry.groups.filter((g) => g.id !== found.group.id);
  if (move) return others.map((g) => ({ id: "move-to", label: g.name, group: g.id }));
  return [
    { id: "open-main", label: "Open main" },
    { id: "new-workspace", label: "New workspace…" },
    { id: "default-branch", label: "Default branch…" },
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
