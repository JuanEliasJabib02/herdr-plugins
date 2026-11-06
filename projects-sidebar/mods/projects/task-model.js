// Task mode's model, with no herdr or gpui-kit imports so `node --test` can
// load it: a group organized by Task (lib.js setOrganize, D29) shows its
// workspaces in lanes, one per task, instead of under their projects. Here:
// a workspace's task, ported from Orca (D30); the Task-mode tree, regrouped
// from tree-model.js buildTree so matching, agents and the rail stay Project
// mode's (D31); the group menu's items, with the Organize toggle (D32); a
// lane's right-click menu, its note and Delete task (D35); and Delete task's
// targets, what its dialog says and what its outcome does (D36). tree.js,
// group-menu.js, task-menu.js and delete-task.js draw and act on it.

import { normPath, baseName, activeGroup, noteKeyOf } from "./lib.js";
import { buildTree, mostUrgent, workspaceLabel, deletePrompt } from "./tree-model.js";

// ── Task keys (D30) ────────────────────────────────────────────────────────

// Orca's ticket pattern, verbatim (shared/sidebar-list/worktree-task-key.ts).
// A 2–6 char prefix, so "release-2024" isn't a ticket; the letters-only arm
// with no separator, so "ax3356" isn't AX335-6; 2+ digits without a
// separator, so "vue3" and "md5" aren't tickets.
const TICKET = /(?<![A-Za-z0-9])(?:([A-Za-z][A-Za-z0-9]{1,5})[-_ ](\d{1,6})|([A-Za-z]{2,6})(\d{2,6}))(?![A-Za-z0-9])/;

const TASK = "task:";

// The lanes that aren't a task: workspaces with no task, and the main
// checkouts (Orca's "Servers", where a project's server runs). Outside the
// name lanes: a name is never "none" and its lane always starts with "task:".
export const NO_TASK_LANE = `${TASK}none`;
export const SERVERS_LANE = "servers";

// The first ticket in some text, as `AX-3356` (prefix uppercased, a dash,
// the digits); null when there is none.
export function findTicket(text) {
  const m = TICKET.exec(String(text ?? ""));
  const prefix = m?.[1] ?? m?.[3];
  const digits = m?.[2] ?? m?.[4];
  return prefix && digits ? `${prefix.toUpperCase()}-${digits}` : null;
}

const stripRef = (branch) => String(branch).replace(/^refs\/heads\//, "");

// A ticket in the branch, its `/` segments read from the last one, since
// "juan/" or "feat/" come before the ticket and "team-1" reads as TEAM-1.
function branchTicket(branch) {
  for (const segment of stripRef(branch).split("/").reverse()) {
    const ticket = findTicket(segment);
    if (ticket) return ticket;
  }
  return null;
}

// What can't name a task (Orca's isUsableTaskKey, plus "none", the No task
// lane's own key): nothing, "none" in any case, over 200 chars, or a key
// that is special on a plain object.
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
function usableName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.toLowerCase() !== "none" && name.length <= 200 && !UNSAFE.has(name) ? name : null;
}

// The task a checkout ({ path, branch, main }) belongs to: { kind: "ticket",
// key: "AX-3356" } from its branch, else from its folder's name; else
// { kind: "name", key } with the branch's last segment, or the folder's name
// when the checkout is detached or that segment can't name a task (Orca
// falls back to the display name the same way); null when neither can (the
// No task lane). A main checkout has no task: it goes to Servers.
export function taskKeyOf(checkout) {
  if (!checkout || checkout.main) return null;
  const folder = baseName(checkout.path);
  const ticket = (checkout.branch ? branchTicket(checkout.branch) : null) ?? findTicket(folder);
  if (ticket) return { kind: "ticket", key: ticket };
  const leaf = checkout.branch ? stripRef(checkout.branch).split("/").pop() : null;
  const name = usableName(leaf) ?? usableName(folder);
  return name ? { kind: "name", key: name } : null;
}

// ── The Task-mode tree (D31) ───────────────────────────────────────────────

// The lane a checkout goes to, by D31's keys: { lane, kind, label }. A main
// checkout → Servers; no task → No task; a ticket → task:<TICKET>; a name →
// task:<lowercased name>, labelled with this checkout's casing (buildTaskTree
// keeps the smallest one seen). The one rule for the tree, Delete task's
// targets and whether a task is still used.
function laneKey(checkout) {
  if (checkout?.main) return { lane: SERVERS_LANE, kind: "servers", label: "Servers" };
  const task = taskKeyOf(checkout);
  if (!task) return { lane: NO_TASK_LANE, kind: "none", label: "No task" };
  if (task.kind === "ticket") return { lane: `${TASK}${task.key}`, kind: "ticket", label: task.key };
  return { lane: `${TASK}${task.key.toLowerCase()}`, kind: "name", label: task.key };
}

// A lane's place: tickets, then names, then No task, then Servers.
const RANK = { ticket: 0, name: 1, none: 2, servers: 3 };

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Tickets by prefix, then by number, the highest first, compared as numbers
// (AX-1000 above AX-99): Herdr has no per-worktree activity time, which is
// what Orca sorts by. Names by their lowercased form, the lane key, with <
// rather than localeCompare, so node and Herdr's engine agree.
function compareLanes(a, b) {
  if (a.kind !== b.kind) return RANK[a.kind] - RANK[b.kind];
  if (a.kind !== "ticket") return byCodeUnits(a.lane, b.lane);
  const [pa, na] = a.label.split("-");
  const [pb, nb] = b.label.split("-");
  return byCodeUnits(pa, pb) || Number(nb) - Number(na) || byCodeUnits(a.lane, b.lane);
}

// The active group's tree in Task mode: buildTree's { group, empty, projects,
// rows }, with the same arguments plus `tasks` (projects.ui.v1's folded
// lanes), and its projects' workspaces regrouped into lanes. `group`,
// `empty` and `projects` (the narrow rail) are buildTree's own; a project
// folded in Project mode hides nothing here.
// `rows`, lane by lane in lane order (compareLanes): a header { kind: "task",
// lane, label, count, collapsed, status, selected } (count: its workspaces;
// status: their most urgent; selected: one of them is shown), then, unless
// the lane is folded, its rows in the group's project order and then each
// project's list order: a workspace, { kind: "workspace", project,
// projectName, ...workspace }, followed by its agents as buildTree builds
// them. The Servers lane holds each project's main checkout and, for a
// project not listed yet or whose listing failed, its { kind: "loading" |
// "missing", project, projectName } row, so no project is ever hidden.
// Lanes:
//   task:<TICKET>; task:<lowercased name>, labelled with the smallest casing
//   seen in the group (Orca's indexNameCasings), so the same branch or
//   folder name in two projects is one task whatever their order (S26); a
//   ticket and a name never share a lane; task:none, "No task"; servers,
//   "Servers". A lane with nothing in it isn't shown.
export function buildTaskTree(args) {
  const model = buildTree(args);
  const folded = new Set(args?.tasks ?? []);
  const lanes = new Map();
  const laneOf = (lane, kind, label) => {
    if (!lanes.has(lane)) lanes.set(lane, { lane, kind, label, items: [] });
    return lanes.get(lane);
  };
  const casing = new Map();
  for (const p of model.projects) {
    if (p.loading) laneOf(SERVERS_LANE, "servers", "Servers").items.push({ row: { kind: "loading", project: p.path, projectName: p.name } });
    if (p.missing) laneOf(SERVERS_LANE, "servers", "Servers").items.push({ row: { kind: "missing", project: p.path, projectName: p.name } });
    for (const w of p.workspaces) {
      const at = laneKey(w);
      if (at.kind === "name") {
        const lower = at.label.toLowerCase();
        const seen = casing.get(lower);
        if (seen === undefined || at.label < seen) casing.set(lower, at.label);
        laneOf(at.lane, "name", lower).items.push({ project: p, workspace: w });
      } else laneOf(at.lane, at.kind, at.label).items.push({ project: p, workspace: w });
    }
  }
  const rows = [];
  for (const lane of [...lanes.values()].sort(compareLanes)) {
    const workspaces = lane.items.filter((it) => it.workspace).map((it) => it.workspace);
    const collapsed = folded.has(lane.lane);
    rows.push({
      kind: "task",
      lane: lane.lane,
      label: lane.kind === "name" ? casing.get(lane.label) : lane.label,
      count: workspaces.length,
      collapsed,
      status: mostUrgent(workspaces.map((w) => w.status)),
      selected: workspaces.some((w) => w.selected),
    });
    if (collapsed) continue;
    for (const it of lane.items) {
      if (it.row) {
        rows.push(it.row);
        continue;
      }
      const { project: p, workspace: w } = it;
      rows.push({ kind: "workspace", project: p.path, projectName: p.name, ...w });
      for (const a of w.agents) rows.push({ kind: "agent", project: p.path, workspace: w.path, ...a });
    }
  }
  return { group: model.group, empty: model.empty, projects: model.projects, rows };
}

// ── Group menu (D32) ───────────────────────────────────────────────────────

// The right-click menu of a group: [{ id, label, why, mode?, checked?,
// separator? }]. Organize by Project and Organize by Task (`mode`, what
// setOrganize gets), the group's current one `checked`; then, after a
// separator, Rename… and Delete group. `why` says why an item can't run
// now: only Delete has one, for a group with projects (they are never
// touched: move or remove them first) or the last group. The current mode
// can still be chosen, so ↑/↓ reach it; choosing it changes nothing.
// No group: [].
export function groupMenuItems(group, registry) {
  if (!group) return [];
  const mode = group.organize === "task" ? "task" : "project";
  const why = group.projects.length > 0 ? "Has projects" : registry.groups.length === 1 ? "Last group" : null;
  return [
    { id: "organize-project", label: "Organize by Project", mode: "project", checked: mode === "project", why: null },
    { id: "organize-task", label: "Organize by Task", mode: "task", checked: mode === "task", why: null },
    { id: "rename", label: "Rename…", why: null, separator: true },
    { id: "delete", label: "Delete group", why },
  ];
}

// ── Task menu (D35) ────────────────────────────────────────────────────────

// The right-click menu of a task lane: [{ id, label, why, separator?,
// danger? }]. "Add note…", or "Edit note…" when the task has one (`note`);
// then, after a separator, "Delete task…" in the blocked color, whose `why`
// says "No workspaces" when it has no `targets` (the lane's worktrees, main
// checkouts excluded). Only a lane with a note key (lib.js noteKeyOf) has a
// menu: No task and Servers get [], as in Orca.
export function taskMenuItems(lane, { note = null, targets = [] } = {}) {
  if (noteKeyOf(lane) === null) return [];
  return [
    { id: "note", label: note ? "Edit note…" : "Add note…", why: null },
    { id: "delete", label: "Delete task…", why: targets?.length ? null : "No workspaces", separator: true, danger: true },
  ];
}

// ── Delete task (D36) ──────────────────────────────────────────────────────

// The workspaces Delete task removes from a lane: in the active group's
// projects, in their order and then each project's list order (the cache,
// projects.cache.v1), every checkout that isn't a main checkout and goes to
// `lane` by laneKey, the tree's own rule. [{ project, path, label,
// projectName }], label as the row says it (workspaceLabel). Folds and
// spaces play no part: a folded lane keeps its targets (Orca deletes a
// lane's worktrees "hidden by sidebar filters or not"). Servers and anything
// that isn't a lane: [].
export function laneTargets(registry, cache, lane) {
  if (typeof lane !== "string" || !registry) return [];
  const out = [];
  for (const p of activeGroup(registry).projects) {
    for (const c of cache?.[p.path] ?? []) {
      const w = { path: normPath(c.path), branch: c.branch ?? null, main: Boolean(c.main) };
      if (w.main || laneKey(w).lane !== lane) continue;
      out.push({ project: p.path, path: w.path, label: workspaceLabel(w), projectName: p.name });
    }
  }
  return out;
}

const plural = (n, one, many) => (n === 1 ? one : many);

// What the Delete task dialog says. `label`: the lane's ("AX-3653"). `rows`:
// one per target, in its order, [{ path, row, check, projectName, spaces,
// terminals }]: the checkout ({ path, branch, main }: the check's fresh list,
// else the cache), removalCheck's answer (null while asking), how many of its
// spaces close and how many other terminals in its folder stay open. Each row
// is deletePrompt's, called once for that target: its label, warnings ("…
// They'll be lost."), reason (locked, couldn't check, not a workspace),
// checking and ready, plus the project's name and whether git locked it.
// Resolves { title, body, rows, notes, button, ready }:
//   title and body: Orca's copy, counting the rows that run (ready, or still
//     checking); none can: "None of the workspaces of <label> can be deleted.";
//   notes: the spaces that close and the terminals that stay, added up over
//     the ready rows only;
//   ready: every check answered and at least one row is ready (only those
//     run);
//   button: "Delete anyway" when a ready row has warnings (its removal is
//     forced), else "Delete"; null once nothing can run.
export function deleteTaskPrompt({ label, rows, home } = {}) {
  const out = (rows ?? []).map((r) => {
    const p = deletePrompt({ path: r.path, row: r.row ?? null, check: r.check ?? null, spaces: r.spaces, terminals: r.terminals, home });
    return {
      path: normPath(r.path),
      label: p.label,
      projectName: r.projectName ?? "",
      warnings: p.warnings,
      reason: p.reason,
      checking: p.checking,
      ready: p.ready,
      locked: Boolean(r.check?.locked),
      spaces: r.spaces ?? 0,
      terminals: r.terminals ?? 0,
    };
  });
  const ready = out.filter((r) => r.ready);
  const checking = out.some((r) => r.checking);
  const n = out.filter((r) => r.ready || r.checking).length;
  const notes = [];
  const spaces = ready.reduce((sum, r) => sum + r.spaces, 0);
  const terminals = ready.reduce((sum, r) => sum + r.terminals, 0);
  const where = plural(ready.length, "its folder", "their folders");
  if (spaces > 0) notes.push(plural(spaces, "1 space closes, with its agents.", `${spaces} spaces close, with their agents.`));
  if (terminals > 0) notes.push(plural(terminals, `1 more terminal is in ${where} and stays open.`, `${terminals} more terminals are in ${where} and stay open.`));
  return {
    title: plural(n, "Delete Workspace", "Delete Workspaces"),
    body: n === 0
      ? `None of the workspaces of ${label} can be deleted.`
      : plural(n, "Remove 1 workspace from git and delete its workspace folder.", `Remove ${n} workspaces from git and delete their workspace folders.`),
    rows: out,
    notes,
    button: !checking && ready.length === 0 ? null : ready.some((r) => r.warnings.length > 0) ? "Delete anyway" : "Delete",
    ready: !checking && ready.length > 0,
  };
}

// Why a removed workspace's branch stayed (D23), "" when it didn't.
function keptBranch(r) {
  const b = r?.check?.branch;
  if (r?.branch === "kept") return `Kept branch ${b}: it isn't merged into ${r.check?.mainBranch ?? "the main checkout"}.`;
  if (r?.branch === "in-use") return `Kept branch ${b}: another workspace has it checked out.`;
  return "";
}

// What one removeTask entry (remove-workspace-model.js) says in its row of
// the dialog: { project, path, status, text }. Removed: "Deleted." with its
// branch, or why the branch stayed; anything else: its err.
export function taskRowOutcome(r) {
  let text = r?.err || "git couldn't delete it.";
  if (r?.status === "removed") {
    const kept = keptBranch(r);
    text = r.branch === "deleted" ? `Deleted, with branch ${r.check?.branch}.` : kept ? `Deleted. ${kept}` : "Deleted.";
  }
  return { project: r?.project ?? null, path: r?.path ?? null, status: r?.status ?? "failed", text };
}

// What a Delete task run does to its dialog and the toast it posts.
// results: removeTask's entries for the rows that ran, in order, each with
//   the `label` and `projectName` of its target (status "skipped": the
//   reload stopped the run before it); label: the lane's; skipped: the
//   dialog's rows that weren't ready (deleteTaskPrompt's, with `locked`);
//   open: the dialog is still there.
// Resolves { close, toast, rows, error, done }:
//   - Every row that ran was removed: the dialog closes (when open) and a
//     toast says "Deleted N workspaces of <label>", the skipped ones ("Kept
//     1 locked workspace.", "Skipped 1 other workspace.") and the branches
//     that stayed.
//   - Otherwise, open: no toast; the dialog keeps each row's outcome
//     (`rows`, taskRowOutcome) and `error` says how many went.
//   - Otherwise, closed: one toast with the count and the first failure.
// done: every target was removed and none was skipped, so the task may be
// gone and its note with it (the dialog asks taskStillUsed first).
export function deleteTaskOutcome(results, { label, skipped = [], open } = {}) {
  const all = Array.isArray(results) ? results : [];
  const rows = all.map(taskRowOutcome);
  const removed = all.filter((r) => r?.status === "removed");
  const name = (r) => r?.label || baseName(r?.path ?? "");
  const each = all.length > 0 && removed.length === all.length;
  const done = each && (skipped ?? []).length === 0;
  if (each) {
    const locked = (skipped ?? []).filter((r) => r?.locked).length;
    const others = (skipped ?? []).length - locked;
    const body = [
      locked ? plural(locked, "Kept 1 locked workspace.", `Kept ${locked} locked workspaces.`) : "",
      others ? plural(others, "Skipped 1 other workspace.", `Skipped ${others} other workspaces.`) : "",
      ...removed.map(keptBranch),
    ].filter(Boolean).join(" ");
    const title = plural(removed.length, `Deleted 1 workspace of ${label}`, `Deleted ${removed.length} workspaces of ${label}`);
    return { close: Boolean(open), toast: { title, body, level: "success" }, rows, error: "", done };
  }
  if (open) {
    const error = removed.length ? `Deleted ${removed.length} of ${all.length} workspaces.` : "Nothing was deleted.";
    return { close: false, toast: null, rows, error, done: false };
  }
  const first = all.find((r) => r?.status !== "removed");
  const where = first ? [name(first), first.projectName].filter(Boolean).join(" · ") : "";
  const body = first ? `${where}: ${first.err || "git couldn't delete it."}` : "";
  return {
    close: false,
    toast: { title: `Deleted ${removed.length} of ${all.length} workspaces of ${label}`, body, level: removed.length ? "warning" : "error" },
    rows,
    error: "",
    done: false,
  };
}

// Whether a task's note still has a task: some checkout that isn't a main
// checkout, in any project's list (projects.cache.v1, every group: notes
// are global), goes to the note's lane by laneKey, compared lowercased
// (Orca's task-note-delete-cleanup). `key`: lib.js noteKeyOf's ("AX-3653",
// or a name lane's lowercased name).
export function taskStillUsed(cache, key) {
  if (typeof key !== "string" || !key) return false;
  const want = `${TASK}${key}`.toLowerCase();
  return Object.values(cache ?? {}).some((list) => (list ?? []).some((c) =>
    !c?.main && laneKey({ path: normPath(c?.path), branch: c?.branch ?? null, main: false }).lane.toLowerCase() === want));
}
