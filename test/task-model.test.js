// T10: Task mode's model (M/task-model.js): a workspace's task key, ported
// from Orca (D30); the Task-mode tree, lanes regrouped from buildTree (D31);
// the group menu's items with the Organize toggle (D32); T13: the task
// menu's items (D35); T14b: Delete task's targets, what its dialog says and
// what its outcome does, and when the task's note goes (D36).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRegistry, addProject, addGroup, setOrganize, selectGroup } from "../projects-sidebar/mods/projects/lib.js";
import { buildTree } from "../projects-sidebar/mods/projects/tree-model.js";
import {
  findTicket, taskKeyOf, buildTaskTree, groupMenuItems, taskMenuItems, SERVERS_LANE, NO_TASK_LANE,
  laneTargets, deleteTaskPrompt, deleteTaskOutcome, taskStillUsed, agentTaskDelete, withTaskDelete,
} from "../projects-sidebar/mods/projects/task-model.js";

const HOME = "/Users/demo";
const NOW = 1_800_000_000_000;

// One group in Task mode with three projects: app, api, web.
function registry() {
  let r = emptyRegistry();
  for (const path of ["/code/app", "/code/api", "/code/web"]) r = addProject(r, { path });
  return setOrganize(r, "g1", "task");
}

const W = "/Users/demo/orca/workspaces";
const main = (project, branch = "main") => ({ path: project, branch, main: true });
const wt = (repo, folder, branch) => ({ path: `${W}/${repo}/${folder}`, branch, main: false });

const CACHE = {
  "/code/app": [main("/code/app"), wt("app", "login", "feat/login"), wt("app", "ax-99", "ax-99")],
  "/code/api": [main("/code/api", "develop"), wt("api", "login", "feat/login"), wt("api", "ax-1000", "user/AX-1000-auth")],
  "/code/web": [main("/code/web")],
};

const tab = (id, extra = {}) => ({ id, index: 1, name: "1", named: false, active: true, status: null, changed_at: null, ...extra });
const space = (id, folder, extra = {}) => ({
  id, index: 1, name: id, named: false, folder, machine: null, branch: null, active: false, status: null,
  tabs: [tab(`${id}-t1`)], ...extra,
});
const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: true, tile: null, color: null, shell: false, agent: true };
const agent = (address, spaceId, extra = {}) => ({
  address, pane: `${spaceId}-p`, space: spaceId, space_name: spaceId, tab: `${spaceId}-t1`, tab_index: 1, tab_name: "1",
  status: "idle", app: "claude-code", program: CLAUDE, title: "", seq: 1, pinned: false, focused: false, ...extra,
});

const ARGS = { registry: registry(), cache: CACHE, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW };
const tree = (over = {}) => buildTaskTree({ ...ARGS, ...over });

// Rows as short strings: "T <label> (<count>)", "W <label> · <project name>",
// "A <title>", "<kind> · <project name>".
const brief = (rows) => rows.map((r) => {
  if (r.kind === "task") return `T ${r.label} (${r.count})`;
  if (r.kind === "workspace") return `W ${r.label} · ${r.projectName}`;
  if (r.kind === "agent") return `A ${r.title}`;
  return `${r.kind} · ${r.projectName}`;
});
const lanes = (t) => t.rows.filter((r) => r.kind === "task").map((r) => r.lane);

// A checkout of app in a worktree folder, for the key tests.
const key = (branch, folder = "scratch") => taskKeyOf({ path: `${W}/app/${folder}`, branch, main: false });
const ticket = (k) => ({ kind: "ticket", key: k });
const named = (k) => ({ kind: "name", key: k });

// ── Task keys (D30) ────────────────────────────────────────────────────────

test("ticket from the branch: Orca's examples, the last `/` segment first, the first match in a segment", () => {
  for (const branch of ["Ax 3356", "ax_3356", "ax3356", "AX-3356", "feat/ax-3356-foo", "team-1/ax-3356", "refs/heads/feat/ax-3356"]) {
    assert.deepEqual(key(branch), ticket("AX-3356"), branch);
  }
  assert.deepEqual(key("ax-1-and-ax-2"), ticket("AX-1"));
  assert.equal(findTicket("team-1"), "TEAM-1", "team-1 alone is a ticket: the last segment has to win");
  assert.equal(findTicket("ab2-123 follow-up"), "AB2-123");
});

test("no ticket: vue3, md5, release-2024 and a-123 are names", () => {
  for (const branch of ["vue3", "md5", "release-2024", "a-123"]) {
    assert.equal(findTicket(branch), null, branch);
    assert.deepEqual(key(branch), named(branch), branch);
  }
  assert.equal(findTicket("releaseax-3356"), null, "needs a boundary before");
  assert.equal(findTicket("ax-3356b"), null, "needs a boundary after");
});

test("ticket from the folder name when the branch has none, before any name", () => {
  assert.deepEqual(key("fix-login", "ax_77-login"), ticket("AX-77"));
  assert.deepEqual(taskKeyOf({ path: `${W}/app/AB-12`, branch: null, main: false }), ticket("AB-12"), "detached");
  assert.deepEqual(key("feat/ax-5", "bc-9"), ticket("AX-5"), "the branch's ticket wins over the folder's");
});

test("unusable names fall back to the folder name, then to No task", () => {
  const long = "x".repeat(201);
  for (const branch of ["none", "feat/NONE", "__proto__", "constructor", "prototype", long, "feat/  ", "feat/"]) {
    assert.deepEqual(key(branch, "spike"), named("spike"), JSON.stringify(branch.slice(0, 12)));
  }
  assert.deepEqual(key("x".repeat(200), "spike"), named("x".repeat(200)), "200 chars is still a name");
  assert.deepEqual(key("  login  "), named("login"), "trimmed");
  for (const folder of ["none", "__proto__", long]) assert.equal(key("none", folder), null, folder.slice(0, 12));
  const t = tree({ cache: { ...CACHE, "/code/web": [main("/code/web"), wt("web", "none", "none")] } });
  const at = t.rows.findIndex((r) => r.lane === NO_TASK_LANE);
  assert.deepEqual(brief(t.rows.slice(at, at + 2)), ["T No task (1)", "W none · web"]);
});

test("the same branch in two projects of the group is one task, both rows saying their project (S26)", () => {
  const t = tree();
  const at = t.rows.findIndex((r) => r.lane === "task:login");
  assert.deepEqual(brief(t.rows.slice(at, at + 3)), ["T login (2)", "W login · app", "W login · api"]);
  const [a, b] = t.rows.slice(at + 1, at + 3);
  assert.deepEqual([a.project, a.projectName, a.path], ["/code/app", "app", `${W}/app/login`]);
  assert.deepEqual([b.project, b.projectName, b.path], ["/code/api", "api", `${W}/api/login`]);
  assert.deepEqual(t.projects, buildTree(ARGS).projects, "the rail's projects are Project mode's");
  assert.deepEqual(t.group, { id: "g1", name: "Projects" });
  assert.equal(t.empty, false);
});

test("names merge case-insensitively: Login and login are one lane labelled Login, keyed task:login", () => {
  const cache = { ...CACHE, "/code/app": [main("/code/app"), wt("app", "login", "feat/login")], "/code/api": [main("/code/api"), wt("api", "Login", "Login")] };
  for (const order of [["/code/app", "/code/api"], ["/code/api", "/code/app"]]) {
    let r = emptyRegistry();
    for (const path of order) r = addProject(r, { path });
    const t = tree({ registry: r, cache });
    const header = t.rows.find((x) => x.kind === "task" && x.lane !== SERVERS_LANE);
    assert.deepEqual([header.lane, header.label, header.count], ["task:login", "Login", 2], order.join(" "));
    assert.equal(lanes(t).length, 2, "one task lane and Servers");
  }
});

test("a detached worktree is filed under its folder name", () => {
  assert.deepEqual(taskKeyOf({ path: `${W}/app/spike`, branch: null, main: false }), named("spike"));
  const t = tree({ cache: { ...CACHE, "/code/web": [main("/code/web"), { path: `${W}/web/spike`, branch: null, main: false }] } });
  const at = t.rows.findIndex((r) => r.lane === "task:spike");
  assert.deepEqual(brief(t.rows.slice(at, at + 2)), ["T spike (1)", "W spike · web"]);
});

test("main checkouts have no task: they are the Servers lane, last, in registry order", () => {
  assert.equal(taskKeyOf(main("/code/app")), null);
  assert.equal(taskKeyOf({ path: "/code/AX-12", branch: "AX-12", main: true }), null, "not even with a ticket");
  const t = tree();
  const at = t.rows.findIndex((r) => r.lane === SERVERS_LANE);
  assert.deepEqual(brief(t.rows.slice(at)), ["T Servers (3)", "W main · app", "W develop · api", "W main · web"]);
  assert.ok(t.rows.slice(at + 1).every((r) => r.main && r.kind === "workspace"));
});

test("a loading project and a failed one show their rows in Servers, each naming its project", () => {
  const cache = { "/code/app": CACHE["/code/app"] };
  const t = tree({ cache, failed: new Set(["/code/web"]) });
  const at = t.rows.findIndex((r) => r.lane === SERVERS_LANE);
  assert.deepEqual(brief(t.rows.slice(at)), ["T Servers (1)", "W main · app", "loading · api", "missing · web"]);
  assert.deepEqual(t.rows.at(-2), { kind: "loading", project: "/code/api", projectName: "api" });
  assert.deepEqual(t.rows.at(-1), { kind: "missing", project: "/code/web", projectName: "web" });
});

test("agents follow their workspace row; the lane's header shows the most urgent status and the selection", () => {
  const spaces = [
    space("s1", `${W}/api/login`, { active: true, status: "working" }),
    space("s2", `${W}/app/login`, { status: "blocked", tabs: [tab("s2-t1", { changed_at: NOW - 90_000 })] }),
  ];
  const agents = [agent("t1", "s1", { status: "working", title: "Fix the login API" }), agent("t2", "s2", { status: "blocked", title: "Login form" })];
  const t = tree({ spaces, agents });
  const at = t.rows.findIndex((r) => r.lane === "task:login");
  assert.deepEqual(brief(t.rows.slice(at, at + 5)), ["T login (2)", "W login · app", "A Login form", "W login · api", "A Fix the login API"]);
  assert.deepEqual(t.rows[at + 2], { kind: "agent", project: "/code/app", workspace: `${W}/app/login`, address: "t2", pane: "s2-p", status: "blocked", title: "Login form", since: "1m", program: CLAUDE });
  assert.deepEqual([t.rows[at].status, t.rows[at].selected], ["blocked", true]);
  assert.equal(t.rows[at + 3].space, "s1", "a click selects its space (openAction)");
  const other = t.rows.find((r) => r.lane === SERVERS_LANE);
  assert.deepEqual([other.status, other.selected], [null, false]);
});

test("lane order: tickets by prefix then number, as numbers; names lowercased with <; No task; Servers", () => {
  const cache = {
    "/code/app": [main("/code/app"), wt("app", "a", "ax-99"), wt("app", "b", "Zeta"), wt("app", "none", "none"), wt("app", "d", "bc-1")],
    "/code/api": [main("/code/api"), wt("api", "e", "AX-1000"), wt("api", "f", "Banana"), wt("api", "g", "apple"), wt("api", "h", "ab-5")],
  };
  const t = tree({ cache, registry: addProject(addProject(setOrganize(emptyRegistry(), "g1", "task"), { path: "/code/app" }), { path: "/code/api" }) });
  assert.deepEqual(lanes(t), ["task:AB-5", "task:AX-1000", "task:AX-99", "task:BC-1", "task:apple", "task:banana", "task:zeta", NO_TASK_LANE, SERVERS_LANE]);
  assert.deepEqual(t.rows.filter((r) => r.kind === "task").map((r) => r.label), ["AB-5", "AX-1000", "AX-99", "BC-1", "apple", "Banana", "Zeta", "No task", "Servers"]);
});

test("a folded lane shows only its header; the other lanes keep their rows", () => {
  const t = tree({ tasks: ["task:login", SERVERS_LANE] });
  assert.deepEqual(brief(t.rows), ["T AX-1000 (1)", "W AX-1000-auth · api", "T AX-99 (1)", "W ax-99 · app", "T login (2)", "T Servers (3)"]);
  assert.deepEqual(t.rows.filter((r) => r.kind === "task").map((r) => r.collapsed), [false, false, true, true]);
  assert.deepEqual(brief(tree({ collapsed: ["/code/app"] }).rows).slice(0, 4), ["T AX-1000 (1)", "W AX-1000-auth · api", "T AX-99 (1)", "W ax-99 · app"], "a project folded in Project mode hides nothing here");
  assert.deepEqual(tree({ registry: setOrganize(emptyRegistry(), "g1", "task"), cache: {} }), { group: { id: "g1", name: "Projects" }, empty: true, projects: [], rows: [] });
});

// ── Hide sleeping (workspace-sleep D8) ─────────────────────────────────────

// A space whose every tab is put away (`tab.settle`): D3's asleep.
const putAway = (id, folder, extra = {}) => space(id, folder, { tabs: [tab(`${id}-t1`, { settled: true })], ...extra });

test("hide sleeping in Task mode: off, every lane shows; on, a lane whose workspaces all hide isn't shown, and Servers keeps the main checkouts unless the exemption is off (D8)", () => {
  const all = brief(tree().rows);
  assert.deepEqual(brief(tree({ hideSleeping: false, exceptMain: false }).rows), all, "off: as before");
  assert.deepEqual(brief(tree({ hideSleeping: true }).rows), ["T Servers (3)", "W main · app", "W develop · api", "W main · web"],
    "nothing is open, so every workspace is asleep: only the exempt main checkouts stay");
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false }).rows), [], "every lane empty, so none is shown");
});

test("hide sleeping in Task mode: a lane counts only what it shows, the shown workspace stays, and Servers keeps a project's loading row (D8)", () => {
  const spaces = [space("s1", `${W}/api/login`), putAway("s2", `${W}/app/ax-99`, { active: true }), putAway("s3", `${W}/api/ax-1000`)];
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false, spaces }).rows), ["T AX-99 (1)", "W ax-99 · app", "T login (1)", "W login · api"],
    "ax-99 is shown though put away; app's login is asleep and goes, api's is awake; AX-1000 is put away");
  const at = tree({ hideSleeping: true, exceptMain: false, spaces }).rows.find((r) => r.lane === "task:AX-99");
  assert.deepEqual([at.count, at.selected], [1, true]);
  const cache = { "/code/app": CACHE["/code/app"] };
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false, cache, failed: new Set(["/code/web"]) }).rows), ["T Servers (0)", "loading · api", "missing · web"],
    "no project is ever hidden: its row git hasn't given yet stays");
  assert.deepEqual(brief(tree({ hideSleeping: true, tasks: [SERVERS_LANE] }).rows), ["T Servers (3)"], "a folded lane still counts what it would show");
});

// ── Group menu (D32) ───────────────────────────────────────────────────────

test("group menu: Organize by Project and by Task, the current one checked, a separator, then Rename… and Delete group with their why", () => {
  let r = addGroup(registry(), "Clients");
  r = addGroup(r, "Empty");
  const [work, clients] = r.groups;
  assert.deepEqual(groupMenuItems(work, r), [
    { id: "organize-project", label: "Organize by Project", mode: "project", checked: false, why: null },
    { id: "organize-task", label: "Organize by Task", mode: "task", checked: true, why: null },
    { id: "rename", label: "Rename…", why: null, separator: true },
    { id: "delete", label: "Delete group", why: "Has projects" },
  ]);
  assert.deepEqual(groupMenuItems(clients, r).map((it) => [it.id, it.checked ?? null, it.why]), [
    ["organize-project", true, null],
    ["organize-task", false, null],
    ["rename", null, null],
    ["delete", null, null],
  ]);
  const alone = emptyRegistry();
  assert.equal(groupMenuItems(alone.groups[0], alone).at(-1).why, "Last group");
  assert.deepEqual(groupMenuItems(null, r), []);
});

// ── Task menu (D35, S30) ───────────────────────────────────────────────────

test("task menu: Add note… or Edit note…, a separator, Delete task… in danger, `why` with no workspaces; [] for a lane with no note key", () => {
  const targets = [{ project: "/code/app", path: `${W}/app/ax-99`, label: "ax-99", projectName: "app" }];
  assert.deepEqual(taskMenuItems("task:AX-99", { note: null, targets }), [
    { id: "note", label: "Add note…", why: null },
    { id: "delete", label: "Delete task…", why: null, separator: true, danger: true },
  ]);
  assert.deepEqual(taskMenuItems("task:AX-99", { note: "contratos", targets }).map((it) => it.label), ["Edit note…", "Delete task…"]);
  assert.equal(taskMenuItems("task:login", { note: null, targets: [] }).at(-1).why, "No workspaces");
  assert.equal(taskMenuItems("task:login").at(-1).why, "No workspaces", "no targets given");
  for (const lane of [NO_TASK_LANE, SERVERS_LANE, "task:Constructor", "task:__PROTO__", "login", null]) {
    assert.deepEqual(taskMenuItems(lane, { note: null, targets }), [], `for ${lane}`);
  }
});

// ── Delete task (D36, S30) ─────────────────────────────────────────────────

// A lane's workspaces as buildTaskTree draws them, unfolded, in laneTargets'
// shape.
const laneRows = (t, lane) => {
  const at = t.rows.findIndex((r) => r.kind === "task" && r.lane === lane);
  const out = [];
  for (const r of t.rows.slice(at + 1)) {
    if (r.kind === "task") break;
    if (r.kind === "workspace") out.push({ project: r.project, path: r.path, label: r.label, projectName: r.projectName });
  }
  return out;
};

test("laneTargets: a lane's non-main workspaces in the active group, the same as its rows, folded or not", () => {
  // web's main checkout sits on a branch that reads as AX-99: it never counts.
  const cache = { ...CACHE, "/code/web": [main("/code/web", "ax-99"), wt("web", "AX-99", "feat/ax-99-copy")], "/code/other": [main("/code/other"), wt("other", "login", "feat/login")] };
  // /code/other has a login worktree too, in a group that isn't active.
  let r = addGroup(registry(), "Clients");
  r = addProject(r, { path: "/code/other" }, "g2");
  assert.equal(r.activeGroup, "g1");
  for (const lane of ["task:login", "task:AX-99", "task:AX-1000"]) {
    const unfolded = buildTaskTree({ ...ARGS, registry: r, cache });
    assert.deepEqual(laneTargets(r, cache, lane), laneRows(unfolded, lane), lane);
  }
  assert.deepEqual(laneTargets(r, cache, "task:login"), [
    { project: "/code/app", path: `${W}/app/login`, label: "login", projectName: "app" },
    { project: "/code/api", path: `${W}/api/login`, label: "login", projectName: "api" },
  ]);
  assert.deepEqual(laneTargets(r, cache, "task:AX-99").map((t) => t.path), [`${W}/app/ax-99`, `${W}/web/AX-99`], "main checkouts never count");
  const folded = buildTaskTree({ ...ARGS, registry: r, cache, tasks: ["task:login"] });
  assert.deepEqual(laneRows(folded, "task:login"), [], "the folded lane draws no rows");
  assert.equal(laneTargets(r, cache, "task:login").length, 2, "a folded lane keeps its targets");
  assert.deepEqual(laneTargets(r, cache, SERVERS_LANE), [], "Servers holds main checkouts only");
  assert.deepEqual(laneTargets(selectGroup(r, "g2"), cache, "task:login").map((t) => t.project), ["/code/other"], "the active group's only");
  assert.deepEqual(laneTargets(r, cache, "task:nothing"), []);
  assert.deepEqual(laneTargets(r, cache, null), []);
});

test("laneTargets: with a group id, that group's lane, active or not; an unknown group has none", () => {
  const cache = { ...CACHE, "/code/other": [main("/code/other"), wt("other", "login", "feat/login")] };
  let r = addGroup(registry(), "Clients");
  r = addProject(r, { path: "/code/other" }, "g2");
  assert.equal(r.activeGroup, "g1");
  assert.deepEqual(laneTargets(r, cache, "task:login", "g2").map((t) => t.path), [`${W}/other/login`]);
  assert.deepEqual(laneTargets(r, cache, "task:login", "g1"), laneTargets(r, cache, "task:login"));
  assert.deepEqual(laneTargets(r, cache, "task:login", null), laneTargets(r, cache, "task:login"), "null: the active group");
  assert.deepEqual(laneTargets(r, cache, "task:login", "nope"), []);
});

// ── An agent's Delete… (the Agents list) ──────────────────────────────────

test("agentTaskDelete: a worktree whose task lane, in its Task-mode group, has more workspaces", () => {
  const r = registry();
  const login = { lane: "task:login", label: "login", group: "g1", count: 2 };
  assert.deepEqual(agentTaskDelete(r, CACHE, "/code/app", `${W}/app/login`), login);
  assert.deepEqual(agentTaskDelete(r, CACHE, "/code/api/", `${W}/api/login/`), login, "paths as the Agents list may send them");
  const ax = { ...CACHE, "/code/web": [main("/code/web"), wt("web", "ax-1000-copy", "feat/AX-1000-copy")] };
  assert.deepEqual(agentTaskDelete(r, ax, "/code/web", `${W}/web/ax-1000-copy`), { lane: "task:AX-1000", label: "AX-1000", group: "g1", count: 2 });
});

test("agentTaskDelete: null, so Delete… deletes the workspace alone", () => {
  const r = registry();
  assert.equal(agentTaskDelete(r, CACHE, "/code/app", `${W}/app/ax-99`), null, "alone in its task");
  assert.equal(agentTaskDelete(r, CACHE, "/code/app", "/code/app"), null, "the main checkout");
  assert.equal(agentTaskDelete(setOrganize(r, "g1", "project"), CACHE, "/code/app", `${W}/app/login`), null, "a group organized by Project");
  const none = { ...CACHE, "/code/app": [main("/code/app"), wt("app", "none", "feat/none")], "/code/api": [main("/code/api"), wt("api", "none", "x/none")] };
  assert.equal(agentTaskDelete(r, none, "/code/app", `${W}/app/none`), null, "No task is no task");
  assert.equal(agentTaskDelete(r, CACHE, "/code/app", `${W}/app/gone`), null, "a path the cache doesn't hold");
  assert.equal(agentTaskDelete(r, CACHE, "/code/nowhere", `${W}/app/login`), null, "a project no group has");
  assert.equal(agentTaskDelete(null, CACHE, "/code/app", `${W}/app/login`), null);
});

test("agentTaskDelete: the workspace's own group, not the active one", () => {
  const cache = {
    ...CACHE,
    "/code/other": [main("/code/other"), wt("other", "login", "feat/login")],
    "/code/more": [main("/code/more"), wt("more", "login", "feat/login")],
  };
  let r = addGroup(registry(), "Clients");
  r = addProject(r, { path: "/code/other" }, "g2");
  assert.equal(agentTaskDelete(setOrganize(r, "g2", "task"), cache, "/code/other", `${W}/other/login`), null, "g2's login lane has one");
  r = setOrganize(addProject(r, { path: "/code/more" }, "g2"), "g2", "task");
  assert.equal(r.activeGroup, "g1");
  assert.deepEqual(agentTaskDelete(r, cache, "/code/other", `${W}/other/login`), { lane: "task:login", label: "login", group: "g2", count: 2 });
  assert.deepEqual(agentTaskDelete(r, cache, "/code/app", `${W}/app/login`), { lane: "task:login", label: "login", group: "g1", count: 2 });
});

test("withTaskDelete: Delete… names the task and carries it; without one, the items as they are", () => {
  const items = [{ id: "sleep", label: "Sleep" }, { id: "rename", label: "Rename…" }, { id: "delete", label: "Delete…", separator: true, danger: true }];
  const task = { lane: "task:AX-3743", label: "AX-3743", group: "g1", count: 2 };
  assert.deepEqual(withTaskDelete(items, task), [
    items[0],
    items[1],
    { id: "delete", label: "Delete task AX-3743 (2)…", separator: true, danger: true, task: { lane: "task:AX-3743", label: "AX-3743", group: "g1" } },
  ]);
  assert.equal(withTaskDelete(items, null), items);
  assert.deepEqual(withTaskDelete(items.slice(0, 2), task), items.slice(0, 2), "no Delete…, nothing to name");
});

const APP_LOGIN = `${W}/app/login`;
const API_LOGIN = `${W}/api/login`;
const WEB_LOGIN = `${W}/web/login`;
const checkout = (path, branch = "feat/login") => ({ path, branch, main: false });
const checkOf = (project, path, over = {}) => ({
  deletable: true, reason: "", failed: false, locked: false, lockReason: null, changes: false, submodules: false,
  branch: "feat/login", mainBranch: "main", list: [main(project), checkout(path)], ...over,
});
// One of the dialog's rows before deleteTaskPrompt: what the dialog knows of a target.
const target = (project, path, projectName, over = {}) => ({
  path, row: checkout(path), check: checkOf(project, path), projectName, spaces: 0, terminals: 0, ...over,
});
const APP = () => target("/code/app", APP_LOGIN, "app");
const API = (over) => target("/code/api", API_LOGIN, "api", over);

test("deleteTaskPrompt: Orca's singular and plural copy; Delete anyway for one row with changes; off while checking; no button when nothing is ready", () => {
  const one = deleteTaskPrompt({ label: "login", rows: [APP()] });
  assert.deepEqual([one.title, one.body], ["Delete Workspace", "Remove 1 workspace from git and delete its workspace folder."]);
  assert.deepEqual([one.ready, one.button, one.notes], [true, "Delete", []]);

  const two = deleteTaskPrompt({ label: "login", rows: [APP(), API()] });
  assert.deepEqual([two.title, two.body], ["Delete Workspaces", "Remove 2 workspaces from git and delete their workspace folders."]);
  assert.deepEqual(two.rows.map((r) => [r.label, r.projectName, r.ready, r.checking]), [["login", "app", true, false], ["login", "api", true, false]]);

  const dirty = deleteTaskPrompt({ label: "login", rows: [APP(), API({ check: checkOf("/code/api", API_LOGIN, { changes: true }) })] });
  assert.equal(dirty.button, "Delete anyway");
  assert.deepEqual(dirty.rows.map((r) => r.warnings), [[], ["login has changes that aren't committed. They'll be lost."]]);
  assert.equal(dirty.ready, true);

  const asking = deleteTaskPrompt({ label: "login", rows: [APP(), API({ check: null })] });
  assert.deepEqual([asking.ready, asking.button, asking.rows[1].checking], [false, "Delete", true], "Delete waits for every check");
  assert.equal(asking.title, "Delete Workspaces", "a row still checking may run");

  const reason = `Locked by git. Unlock it with \`git worktree unlock ${APP_LOGIN}\`.`;
  const none = deleteTaskPrompt({ label: "login", rows: [target("/code/app", APP_LOGIN, "app", { check: checkOf("/code/app", APP_LOGIN, { deletable: false, locked: true, lockReason: "", reason }) })] });
  assert.deepEqual([none.ready, none.button], [false, null]);
  assert.equal(none.body, "None of the workspaces of login can be deleted.");
  assert.deepEqual(none.rows[0].reason, reason);
});

test("deleteTaskPrompt: a locked target and a stale one are skipped; spaces and terminals add up over the ready rows only", () => {
  const lockReason = `Locked by git: on a USB disk. Unlock it with \`git worktree unlock ${API_LOGIN}\`.`;
  const locked = checkOf("/code/api", API_LOGIN, { deletable: false, locked: true, lockReason: "on a USB disk", changes: true, reason: lockReason });
  const staleReason = `${WEB_LOGIN} isn't one of web's workspaces.`;
  const stale = checkOf("/code/web", WEB_LOGIN, { deletable: false, reason: staleReason, branch: null, list: [main("/code/web")] });
  const p = deleteTaskPrompt({ label: "login", rows: [
    target("/code/app", APP_LOGIN, "app", { spaces: 1, terminals: 2 }),
    API({ check: locked, spaces: 2, terminals: 1 }),
    target("/code/web", WEB_LOGIN, "web", { check: stale, spaces: 1, terminals: 3 }),
  ] });
  assert.deepEqual(p.rows.map((r) => [r.projectName, r.ready, r.locked, r.reason]), [
    ["app", true, false, ""],
    ["api", false, true, lockReason],
    ["web", false, false, staleReason],
  ]);
  assert.deepEqual(p.rows[1].warnings, [], "nothing to confirm on a row that doesn't run");
  assert.deepEqual([p.title, p.body, p.ready, p.button], ["Delete Workspace", "Remove 1 workspace from git and delete its workspace folder.", true, "Delete"]);
  assert.deepEqual(p.notes, ["1 space closes, with its agents.", "2 more terminals are in its folder and stay open."]);

  const sum = deleteTaskPrompt({ label: "login", rows: [
    target("/code/app", APP_LOGIN, "app", { spaces: 1, terminals: 1 }),
    API({ spaces: 2, terminals: 0 }),
    target("/code/web", WEB_LOGIN, "web", { check: stale, spaces: 4, terminals: 4 }),
  ] });
  assert.deepEqual(sum.notes, ["3 spaces close, with their agents.", "1 more terminal is in their folders and stays open."]);
});

// removeTask's entries (remove-workspace-model.js), with the label and the
// project's name the dialog adds from its targets.
const CHECKED = checkOf("/code/app", APP_LOGIN);
const ran = (path, projectName, status, more = {}) => ({
  project: `/code/${projectName}`, path, status, err: null, branch: null, branchErr: null, list: [], check: CHECKED,
  label: "login", projectName, ...more,
});
const removed = (path, projectName, branch = "deleted") => ran(path, projectName, "removed", { branch });
const failed = (path, projectName, err) => ran(path, projectName, "failed", { err });

test("deleteTaskOutcome: all that ran removed closes with a toast naming the skipped and kept branches; a partial run stays open; a closed dialog gets one toast", () => {
  const lockedRow = { label: "login", projectName: "api", ready: false, locked: true, reason: "Locked by git." };
  const kept = deleteTaskOutcome([removed(APP_LOGIN, "app")], { label: "login", skipped: [lockedRow], open: true });
  assert.deepEqual([kept.close, kept.error], [true, ""]);
  assert.deepEqual(kept.toast, { title: "Deleted 1 workspace of login", body: "Kept 1 locked workspace.", level: "success" });
  assert.equal(kept.done, false, "a skipped workspace keeps the task: its note stays");

  const all = deleteTaskOutcome([removed(APP_LOGIN, "app"), removed(API_LOGIN, "api", "kept"), removed(WEB_LOGIN, "web", "in-use")], { label: "AX-3653", skipped: [], open: true });
  assert.deepEqual(all.toast, {
    title: "Deleted 3 workspaces of AX-3653",
    body: "Kept branch feat/login: it isn't merged into main. Kept branch feat/login: another workspace has it checked out.",
    level: "success",
  });
  assert.deepEqual([all.close, all.done], [true, true]);
  const other = { label: "spike", projectName: "web", ready: false, locked: false, reason: "Couldn't check it." };
  assert.equal(deleteTaskOutcome([removed(APP_LOGIN, "app")], { label: "login", skipped: [lockedRow, lockedRow, other], open: true }).toast.body,
    "Kept 2 locked workspaces. Skipped 1 other workspace.");

  const part = deleteTaskOutcome([removed(APP_LOGIN, "app"), failed(API_LOGIN, "api", "fatal: cannot remove")], { label: "login", skipped: [], open: true });
  assert.deepEqual([part.close, part.toast, part.done, part.error], [false, null, false, "Deleted 1 of 2 workspaces."]);
  assert.deepEqual(part.rows.map((r) => [r.path, r.status, r.text]), [
    [APP_LOGIN, "removed", "Deleted, with branch feat/login."],
    [API_LOGIN, "failed", "fatal: cannot remove"],
  ]);
  const stopped = ran(WEB_LOGIN, "web", "skipped", { err: "Stopped: the plugin was reloaded.", check: null, list: null });
  const cut = deleteTaskOutcome([removed(APP_LOGIN, "app"), stopped], { label: "login", skipped: [], open: true });
  assert.deepEqual([cut.close, cut.done, cut.rows[1].text], [false, false, "Stopped: the plugin was reloaded."], "a run the reload stopped isn't all removed");
  assert.equal(deleteTaskOutcome([failed(APP_LOGIN, "app", "x")], { label: "login", skipped: [], open: true }).error, "Nothing was deleted.");

  const gone = deleteTaskOutcome([removed(APP_LOGIN, "app"), failed(API_LOGIN, "api", "fatal: cannot remove"), failed(WEB_LOGIN, "web", "fatal: other")], { label: "login", skipped: [], open: false });
  assert.deepEqual([gone.close, gone.done], [false, false]);
  assert.deepEqual(gone.toast, { title: "Deleted 1 of 3 workspaces of login", body: "login · api: fatal: cannot remove", level: "warning" });
  assert.equal(deleteTaskOutcome([failed(APP_LOGIN, "app", "x")], { label: "login", skipped: [], open: false }).toast.level, "error");
  const closedAll = deleteTaskOutcome([removed(APP_LOGIN, "app")], { label: "login", skipped: [], open: false });
  assert.deepEqual([closedAll.close, closedAll.done, closedAll.toast.title], [false, true, "Deleted 1 workspace of login"], "nothing left to close");
});

test("taskStillUsed: another non-main checkout with the task's key, names compared lowercased; a folder's ticket counts; main checkouts don't", () => {
  assert.equal(taskStillUsed({ "/code/api": [main("/code/api"), wt("api", "Login", "Login")] }, "login"), true, "Login keeps login");
  assert.equal(taskStillUsed({ "/code/api": [main("/code/api"), wt("api", "ax_77-login", "fix-login")] }, "AX-77"), true, "a ticket from the folder name");
  assert.equal(taskStillUsed({ "/code/api": [main("/code/api", "login"), wt("api", "other", "other")] }, "login"), false, "a main checkout on the branch doesn't count");
  assert.equal(taskStillUsed({ "/code/AX-12": [{ path: "/code/AX-12", branch: "AX-12", main: true }] }, "AX-12"), false);
  assert.equal(taskStillUsed(CACHE, "login"), true, "every project's cache, not only the active group's");
  assert.equal(taskStillUsed(CACHE, "logout"), false);
  assert.equal(taskStillUsed({}, "login"), false);
  assert.equal(taskStillUsed(null, "login"), false);
});
