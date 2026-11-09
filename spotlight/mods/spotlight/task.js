// The task a terminal tests (D12): from the terminal's folder, its repo root
// (the main checkout), the task key by projects-sidebar's rule, the task's
// members in the requesting repo's group filtered by `enabled` (D7), the one
// workspace each member repo puts on its root, and the queue lane (the
// group). The CLI's `on` resolves a request with it; the queue (queue.js)
// takes the key, the lane and the members from here. The whole-task toggle
// (D31) resolves a lane's members by the same rules with no cwd
// (resolveGroupTask), and it and the lane's flashlight share the lit rule
// (taskLit).
//
// This module imports nothing: the mod and the CLI share it, so it can use
// neither node: nor herdr modules, and projects-sidebar's code is copied
// here, never imported, so Spotlight stays its own plugin (S7). Everything
// outside is passed in:
//   git(cwd, args) → Promise<{ ok, out, err }>, argv git run in `cwd`
//     (projects-sidebar's M/projects/git.js shape); a rejection reads as a
//     failure.
//   shared: shared.json's contents, { "projects.v1", "projects.cache.v1",
//     … }, read-only and tolerant: a missing or malformed value is no group.
//   enabled(root) → boolean | Promise<boolean>: whether Spotlight is on for
//     a repo (settings.js applies D7's default); asked only about the repos
//     the task has a worktree in.
//   terminals: Herdr terminals as `hc get --json` prints them; only `cwd`
//     and `status_ms` (null for a shell, a time for an agent) are read.
//
// Differences from Orca, on purpose (D12): Orca resolves a task across every
// worktree it knows; here only the requesting repo's group counts, as
// projects-sidebar shows the task, so two companies' same-named worktrees
// never join one task. Herdr has no per-worktree activity time, so the pick
// in a repo other than the caller's goes by agent status, then commit time.

// ── Paths and shapes (copied from projects-sidebar M/projects/lib.js) ──────

// One spelling per folder: forward slashes, no trailing slash ("/" stays
// "/"). Anything but a string is "".
function normPath(path) {
  if (typeof path !== "string" || !path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

const isAbsolute = (path) => typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:\//.test(path));

const baseName = (path) => normPath(path).split("/").filter(Boolean).pop() ?? "";

// `path` is `dir` or inside it.
const inside = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// ── Task keys (copied from projects-sidebar M/projects/task-model.js) ──────
// Keep in step with projects-sidebar's copy: a task is what its Task mode
// shows as one lane. T4's tests pin the same cases as its task-model tests.

// Orca's ticket pattern, verbatim (shared/sidebar-list/worktree-task-key.ts).
// A 2–6 char prefix, so "release-2024" isn't a ticket; the letters-only arm
// with no separator, so "ax3356" isn't AX335-6; 2+ digits without a
// separator, so "vue3" and "md5" aren't tickets.
const TICKET = /(?<![A-Za-z0-9])(?:([A-Za-z][A-Za-z0-9]{1,5})[-_ ](\d{1,6})|([A-Za-z]{2,6})(\d{2,6}))(?![A-Za-z0-9])/;

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

// ── The task as one key ────────────────────────────────────────────────────

// A checkout's task as Spotlight keys it: { key, label }, null when it has
// none. `key` is projects-sidebar's lane without "task:" (its laneKey; the
// note key too): a ticket as taskKeyOf gives it ("AX-3447"), a name
// lowercased, so "Login" and "login" are one task. The two never meet: a
// ticket starts with an uppercase letter, a lowercased name has none, and a
// name never holds a ticket (taskKeyOf would have found it). `label` is the
// key as this checkout spells it; resolveTask keeps the smallest casing the
// group shows (projects-sidebar's lane label, Orca's indexNameCasings).
export function taskOf(checkout) {
  const task = taskKeyOf(checkout);
  if (!task) return null;
  return { key: task.kind === "ticket" ? task.key : task.key.toLowerCase(), label: task.key };
}

// A task's key as a lane names it (`spotlight toggle --task <KEY>`, D31), in
// taskOf's form: a ticket in any spelling ("ax_50" → "AX-50"), else the name
// lowercased; null for what can't name a task ("none", over 200 chars, a
// special object key, nothing).
export function taskKeyFrom(raw) {
  if (typeof raw !== "string") return null;
  const ticket = findTicket(raw);
  if (ticket) return ticket;
  return usableName(raw)?.toLowerCase() ?? null;
}

// ── Lanes: the groups of projects.v1 ───────────────────────────────────────

// The lane of a repo in no group, or with no readable projects.v1: settings'
// perSpace key for it too (D7).
export const SPACELESS = "spaceless";

// The groups of a stored projects.v1 value, read as projects-sidebar's
// parseRegistry reads it: a value that isn't a v1 registry has no groups; a
// malformed group is dropped with its projects, a malformed project alone; a
// group id or a project path listed twice counts the first time only.
// [{ id, projects: [{ path, name }] }].
function groupsOf(registry) {
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.groups)) return [];
  const ids = new Set();
  const paths = new Set();
  const groups = [];
  for (const g of registry.groups) {
    if (!isObject(g) || typeof g.id !== "string" || g.id === "" || typeof g.name !== "string" || !Array.isArray(g.projects) || ids.has(g.id)) continue;
    ids.add(g.id);
    const projects = [];
    for (const p of g.projects) {
      if (!isObject(p) || !isAbsolute(p.path) || typeof p.name !== "string") continue;
      const path = normPath(p.path);
      if (paths.has(path)) continue;
      paths.add(path);
      projects.push({ path, name: p.name });
    }
    groups.push({ id: g.id, projects });
  }
  return groups;
}

// The group holding `root`, { id, projects: [{ path, name }] }, or null.
const groupOf = (registry, root) => groupsOf(registry).find((g) => g.projects.some((p) => p.path === root)) ?? null;

// Whether a stored projects.v1 value has group `id` (groupsOf's rules).
export const hasGroup = (registry, id) => groupsOf(registry).some((g) => g.id === id);

// The queue lane of a repo root (D12): the id of the projects.v1 group that
// holds it, else SPACELESS.
export function laneOf(registry, root) {
  return groupOf(registry, normPath(root))?.id ?? SPACELESS;
}

const isCheckout = (c) => isObject(c) && isAbsolute(c.path) && (c.branch === null || typeof c.branch === "string") && typeof c.main === "boolean";

// projects.cache.v1, the last worktree list of each project, as
// projects-sidebar's parseCache reads it: a malformed project entry is
// dropped alone.
function parseCache(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [project, list] of Object.entries(value)) {
    if (!isAbsolute(project) || !Array.isArray(list) || !list.every(isCheckout)) continue;
    out[normPath(project)] = list.map((c) => ({ path: normPath(c.path), branch: c.branch, main: c.main }));
  }
  return out;
}

// ── git (argv copied from projects-sidebar M/projects/lib.js) ──────────────

const TOPLEVEL = ["rev-parse", "--show-toplevel"];
const COMMON_DIR = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
// Takes no optional locks and starts no fsmonitor, so a listing writes
// nothing under .git.
const WORKTREE_LIST = ["--no-optional-locks", "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain"];
const COMMIT_TIME = ["log", "-1", "--format=%ct"];

async function runGit(git, cwd, args) {
  try {
    const r = await git(cwd, args);
    return { ok: Boolean(r?.ok), out: String(r?.out ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// `git worktree list --porcelain` as [{ path, branch, main }]: the main
// checkout first, then the linked worktrees in git's order. Bare and
// prunable (folder gone) entries are skipped; detached ones have branch null.
function parseWorktrees(out) {
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

// A repo's checkouts now; [] when git can't list them.
async function listCheckouts(root, git) {
  const r = await runGit(git, root, WORKTREE_LIST);
  return r.ok ? parseWorktrees(r.out) : [];
}

// The repo root of a checkout: its main checkout, from the shared .git
// folder (<root>/.git), or the repo itself when bare. "" outside git.
async function rootOf(workspace, git) {
  const r = await runGit(git, workspace, COMMON_DIR);
  const common = r.ok ? normPath(r.out) : "";
  if (!isAbsolute(common)) return "";
  return common.endsWith("/.git") ? common.slice(0, -5) || "/" : common;
}

// The time of a checkout's last commit (seconds), -Infinity when git can't
// say (an unborn branch, a folder gone).
async function commitTime(path, git) {
  const r = await runGit(git, path, COMMIT_TIME);
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : -Infinity;
}

// ── The pick: one workspace per repo ───────────────────────────────────────

// The last time an agent terminal in `path` changed status (hc's status_ms),
// -Infinity when none did: a shell's status_ms is null.
function lastStatus(path, terminals) {
  let last = -Infinity;
  for (const t of Array.isArray(terminals) ? terminals : []) {
    if (!Number.isFinite(t?.status_ms)) continue;
    const cwd = normPath(t.cwd);
    if (cwd && inside(cwd, path) && t.status_ms > last) last = t.status_ms;
  }
  return last;
}

// The workspace a repo other than the caller's puts on its root (D12, Orca's
// most recently active pick, task-spotlight-members.ts:61-65): the one whose
// agent terminal changed status last, else the newest commit, else the first
// in list order (projects.cache.v1's). Only a strictly later time beats an
// earlier entry, so the pick is stable. git is asked for commit times only
// when the status leaves a tie.
async function pickWorkspace(workspaces, terminals, git) {
  if (workspaces.length === 1) return workspaces[0].path;
  const status = workspaces.map((c) => lastStatus(c.path, terminals));
  const latest = Math.max(...status);
  const tied = workspaces.filter((_, i) => status[i] === latest);
  if (tied.length === 1) return tied[0].path;
  const times = await Promise.all(tied.map((c) => commitTime(c.path, git)));
  return tied[times.indexOf(Math.max(...times))].path;
}

// ── The task of a terminal ─────────────────────────────────────────────────

const NO_TASK = "This workspace is not part of a task (main checkouts never are).";

// The task the terminal in `cwd` tests, its members and its lane. Resolves:
//   { ok: true, root, workspace, branch, taskKey, label, lane, members,
//     skipped, slotOnly }
//     root: the caller's repo root; workspace and branch: the caller's
//       checkout (branch null when detached); taskKey and label: taskOf's,
//       label in the smallest casing the group shows; lane: laneOf's.
//     members: one per enabled repo of the lane's group with a worktree of
//       the task, in the group's order, { root, name, workspace, workspaces }:
//       name as projects.v1 has it (the folder's in no group); workspace:
//       the one lit on that root (the caller's own in its repo, else
//       pickWorkspace's); workspaces: every worktree of the task in that
//       repo, in list order (holding any of them counts as lit, Orca's
//       taskWorktreeIds).
//     skipped: the names of the repos with a worktree of the task that
//       `enabled` keeps out ("Not included: …").
//     slotOnly: no member left; the task still takes a test turn (D12).
//   { ok: false, code: "not-a-repo", message }: `cwd` isn't in a git work
//     tree (the CLI's usage error).
//   { ok: false, code: "no-task", message }: a main checkout, or a worktree
//     whose branch and folder can't name a task.
// Lists: the caller's repo is listed with git (a worktree the cache hasn't
// seen yet still counts); the others come from projects.cache.v1, or from
// git when it has no usable entry for them. A repo in no group, or with no
// readable projects.v1, is a lane of its own (SPACELESS) whose only member
// can be itself. Never rejects.
export async function resolveTask({ cwd, shared, git, enabled, terminals = [] } = {}) {
  const dir = normPath(cwd);
  const top = isAbsolute(dir) ? await runGit(git, dir, TOPLEVEL) : { ok: false, out: "" };
  const workspace = top.ok ? normPath(top.out) : "";
  const root = isAbsolute(workspace) ? await rootOf(workspace, git) : "";
  if (!root) return { ok: false, code: "not-a-repo", message: `${dir || "This folder"} is not in a git repository.` };

  const live = await listCheckouts(root, git);
  const caller = live.find((c) => c.path === workspace) ?? { path: workspace, branch: null, main: workspace === root };
  const task = taskOf(caller);
  if (!task) return { ok: false, code: "no-task", message: NO_TASK };
  const own = live.includes(caller) ? live : [...live, caller];

  const values = isObject(shared) ? shared : {};
  const group = groupOf(values["projects.v1"], root);
  const cache = parseCache(values["projects.cache.v1"]);
  const projects = group ? group.projects : [{ path: root, name: baseName(root) }];

  const { members, skipped, label } = await collectMembers({
    projects,
    key: task.key,
    label: task.label,
    list: async (p) => (p === root ? own : cache[p] ?? (await listCheckouts(p, git))),
    enabled,
    pick: async (p, workspaces) => (p === root ? workspace : pickWorkspace(workspaces, terminals, git)),
  });

  return {
    ok: true,
    root,
    workspace,
    branch: caller.branch,
    taskKey: task.key,
    label,
    lane: group?.id ?? SPACELESS,
    members,
    skipped,
    slotOnly: members.length === 0,
  };
}

// The members of task `key` among `projects` (one group's, in order), the
// rule resolveTask and resolveGroupTask share: one per enabled repo with a
// worktree of the task, { root, name, workspace, workspaces }, `workspace`
// from `pick(root, checkouts)`; `skipped`, the names of the repos with one
// that `enabled` keeps out; `label`, the smallest casing seen, starting from
// `label` (null: the first seen).
//   list(root) → Promise<[{ path, branch, main }]>: the repo's checkouts.
async function collectMembers({ projects, key, label, list, enabled, pick }) {
  const members = [];
  const skipped = [];
  for (const p of projects) {
    const workspaces = [];
    for (const c of await list(p.path)) {
      const t = taskOf(c);
      if (t?.key !== key) continue;
      workspaces.push(c);
      if (label === null || t.label < label) label = t.label;
    }
    if (workspaces.length === 0) continue;
    if (!(await enabled(p.path))) {
      skipped.push(p.name);
      continue;
    }
    const workspace = await pick(p.path, workspaces);
    members.push({ root: p.path, name: p.name, workspace, workspaces: workspaces.map((c) => c.path) });
  }
  return { members, skipped, label };
}

// ── The task of a lane: one group, no cwd (D31) ────────────────────────────

// A task lane's members, for the whole-task toggle (`spotlight toggle --task
// <KEY> --group <id>`): the lane header has no folder, so the task comes from
// its key and its group, and every repo of the group is listed the way
// resolveTask lists the others (projects.cache.v1, else git). Per enabled
// repo with a worktree of the task, the one put on its root: the task's
// workspace holding it now (`holders`: { [root]: holder path }, state.json's),
// else pickWorkspace's. Resolves:
//   { ok: true, group, taskKey, label, members, skipped, projects }
//     taskKey: taskKeyFrom(task); label: the smallest casing the group shows;
//     members and skipped: resolveTask's; projects: the group's repos in
//     order, [{ root, name }] (the switch-away turns off those lit by no member).
//   { ok: false, code: "no-group" | "no-task", message }
// Never rejects.
export async function resolveGroupTask({ group, task, shared, git, enabled, terminals = [], holders = {} } = {}) {
  const key = taskKeyFrom(task);
  if (!key) return { ok: false, code: "no-task", message: `"${task}" can't name a task.` };
  const values = isObject(shared) ? shared : {};
  const found = groupsOf(values["projects.v1"]).find((g) => g.id === group);
  if (!found) return { ok: false, code: "no-group", message: `No group "${group}" in projects-sidebar's spaces.` };
  const cache = parseCache(values["projects.cache.v1"]);
  const held = (root) => normPath(isObject(holders) ? holders[root] : null);
  const { members, skipped, label } = await collectMembers({
    projects: found.projects,
    key,
    label: null,
    list: async (p) => cache[p] ?? (await listCheckouts(p, git)),
    enabled,
    pick: async (p, workspaces) => workspaces.find((c) => c.path === held(p))?.path ?? pickWorkspace(workspaces, terminals, git),
  });
  return {
    ok: true,
    group: found.id,
    taskKey: key,
    label: label ?? key,
    members,
    skipped,
    projects: found.projects.map((p) => ({ root: p.path, name: p.name })),
  };
}

// Whether a task is lit (D31): it has members, and every member's root is
// held by one of the task's workspaces in that repo (`repos`: state.json's).
// Shared by the CLI's toggle and the lane's flashlight (badges-model.js).
export function taskLit(members, repos) {
  if (!Array.isArray(members) || members.length === 0) return false;
  return members.every((m) => {
    const holder = normPath(isObject(repos) ? repos[m.root]?.holder : null);
    return holder !== "" && (m.workspaces ?? []).includes(holder);
  });
}
