// Task mode's model, with no herdr or gpui-kit imports so `node --test` can
// load it: a group organized by Task (lib.js setOrganize, D29) shows its
// workspaces in lanes, one per task, instead of under their projects. Here:
// a workspace's task, ported from Orca (D30); the Task-mode tree, regrouped
// from tree-model.js buildTree so matching, agents and the rail stay Project
// mode's (D31); the group menu's items, with the Organize toggle (D32); and
// a lane's right-click menu, its note and Delete task (D35). tree.js,
// group-menu.js and task-menu.js draw and act on it.

import { baseName, noteKeyOf } from "./lib.js";
import { buildTree, mostUrgent } from "./tree-model.js";

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
      const item = { project: p, workspace: w };
      if (w.main) {
        laneOf(SERVERS_LANE, "servers", "Servers").items.push(item);
        continue;
      }
      const task = taskKeyOf(w);
      if (!task) laneOf(NO_TASK_LANE, "none", "No task").items.push(item);
      else if (task.kind === "ticket") laneOf(`${TASK}${task.key}`, "ticket", task.key).items.push(item);
      else {
        const lower = task.key.toLowerCase();
        const seen = casing.get(lower);
        if (seen === undefined || task.key < seen) casing.set(lower, task.key);
        laneOf(`${TASK}${lower}`, "name", lower).items.push(item);
      }
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
