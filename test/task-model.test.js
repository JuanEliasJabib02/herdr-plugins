// T10: Task mode's model (M/task-model.js): a workspace's task key, ported
// from Orca (D30); the Task-mode tree, lanes regrouped from buildTree (D31);
// the group menu's items with the Organize toggle (D32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRegistry, addProject, addGroup, setOrganize } from "../projects-sidebar/mods/projects/lib.js";
import { buildTree } from "../projects-sidebar/mods/projects/tree-model.js";
import {
  findTicket, taskKeyOf, buildTaskTree, groupMenuItems, SERVERS_LANE, NO_TASK_LANE,
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
