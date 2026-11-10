// T3: the projects tree (M/tree-model.js): rows from the registry, the
// worktree cache and Herdr's live spaces and agents; what a click does; Add
// project; the project menu; the narrow rail; the worktree engine's helpers.
// workspace-sleep T5: Hide sleeping (D8), its popup's items, and
// projects.toggle-sleeping run from the keeper's copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import {
  emptyRegistry, addProject, addGroup, selectGroup, matchSpaces, setOrganize, parseRegistry, needsBackup,
  setProjectBase, findProject, parseUi,
} from "../projects-sidebar/mods/projects/lib.js";
import {
  buildTree, openAction, openMainAction, railAction, workspaceLabel, workspaceMenuItems, initials, mostUrgent,
  agentTitle, ago, isNarrow, projectMenuItems, withoutProject, pruneCache, projectPaths,
  watchDirs, eachLimit, liveFolder, addProjectAt, deletePrompt, deleteOutcome, terminalsStaying,
  renamePrompt, renameOutcome, reorderProject, spaceRenames, filterMenuItems, sleepCommand, SLEEP_TOOLTIP,
} from "../projects-sidebar/mods/projects/tree-model.js";
import { buildTaskTree } from "../projects-sidebar/mods/projects/task-model.js";
import { parseBadges, laneBadgeKey } from "../projects-sidebar/mods/projects/badges-model.js";
import * as badgesModel from "../projects-sidebar/mods/projects/badges-model.js";

// Spotlight T33's (its D42), read off the module so its test fails alone
// while it is missing.
const { badgeLines } = badgesModel;

const HOME = "/Users/demo";
const NOW = 1_800_000_000_000;

// Two groups: Projects (app, api) active, Clients (client).
function registry() {
  let r = emptyRegistry();
  r = addProject(r, { path: "/code/app" });
  r = addProject(r, { path: "/code/api" });
  r = addGroup(r, "Clients");
  r = addProject(r, { path: "/code/client" }, r.groups[1].id);
  return r;
}

const CACHE = {
  "/code/app": [
    { path: "/code/app", branch: "main", main: true },
    { path: "/Users/demo/orca/workspaces/app/feat-login", branch: "feat/login", main: false },
  ],
  "/code/api": [{ path: "/code/api", branch: "develop", main: true }],
  "/code/client": [{ path: "/code/client", branch: "main", main: true }],
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

const tree = (over = {}) => buildTree({
  registry: registry(), cache: CACHE, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW, ...over,
});
const brief = (rows) => rows.map((r) => (r.kind === "project" ? `P ${r.name}` : r.kind === "workspace" ? `W ${r.label}` : r.kind === "agent" ? `A ${r.title}` : `${r.kind}`));
const ws = (t, label) => t.rows.find((r) => r.kind === "workspace" && r.label === label);

// ── Rows ───────────────────────────────────────────────────────────────────

test("rows: the active group's projects, each followed by its workspaces, main first (S2, S11)", () => {
  const t = tree();
  assert.equal(t.group.name, "Projects");
  assert.equal(t.empty, false);
  assert.deepEqual(brief(t.rows), ["P app", "W main", "W login", "P api", "W develop"]);
  assert.ok(!t.rows.some((r) => r.path === "/code/client" || r.project === "/code/client"), "other groups' projects aren't shown");
});

test("labels (D8): the main checkout by its branch with the home icon, a worktree by its folder", () => {
  const t = tree();
  assert.equal(ws(t, "main").main, true);
  assert.equal(ws(t, "login").main, false);
  assert.equal(ws(t, "login").branch, "feat/login");
  assert.equal(workspaceLabel({ path: "/code/notes", branch: null, main: true }), "notes", "outside git or detached: the folder");
  assert.equal(workspaceLabel({ path: "/w/app/fix", branch: "bug/fix", main: false }), "fix");
});

test("open and selected: a workspace with a space gets the open dot, the shown space is highlighted (S10)", () => {
  const spaces = [
    space("s1", "/code/app", { active: true }),
    space("s2", "~/orca/workspaces/app/feat-login"),
  ];
  const panes = [{ pane: "s2-p", tab: "s2-t1", terminal: "t2", cwd: "/Users/demo/orca/workspaces/app/feat-login/src" }];
  const t = tree({ spaces, panes });
  assert.deepEqual([ws(t, "main").open, ws(t, "main").selected, ws(t, "main").space], [true, true, "s1"]);
  assert.deepEqual([ws(t, "login").open, ws(t, "login").selected, ws(t, "login").space], [true, false, "s2"]);
  assert.deepEqual([ws(t, "develop").open, ws(t, "develop").selected, ws(t, "develop").space], [false, false, null]);
  assert.equal(t.projects[0].selected, true);
  assert.equal(t.projects[1].selected, false);
});

test("open: two spaces on one workspace, the shown one is the one a click selects", () => {
  const spaces = [space("s1", "/code/api"), space("s2", "/code/api/src", { active: true })];
  assert.equal(ws(tree({ spaces }), "develop").space, "s2");
  assert.equal(ws(tree({ spaces: [spaces[0], { ...spaces[1], active: false }] }), "develop").space, "s1");
});

test("asleep (workspace-sleep D3): no space, or every space with all its tabs settled; one awake tab or space wakes it", () => {
  const settled = (id, folder, extra = {}) => space(id, folder, { tabs: [tab(`${id}-t1`, { settled: true }), tab(`${id}-t2`, { settled: true, active: false })], ...extra });
  assert.equal(ws(tree(), "develop").asleep, true, "never opened: asleep, as Orca infers it");
  assert.equal(ws(tree({ spaces: [space("s1", "/code/api")] }), "develop").asleep, false, "a space with a live tab");
  assert.equal(ws(tree({ spaces: [settled("s1", "/code/api")] }), "develop").asleep, true, "every tab put away");
  const half = space("s1", "/code/api", { tabs: [tab("s1-t1", { settled: true }), tab("s1-t2", { settled: false, active: false })] });
  assert.equal(ws(tree({ spaces: [half] }), "develop").asleep, false, "one tab still out");
  assert.equal(ws(tree({ spaces: [settled("s1", "/code/api"), space("s2", "/code/api/src")] }), "develop").asleep, false, "another space on it is awake");
  assert.equal(ws(tree({ spaces: [space("s1", "/code/api", { tabs: [] })] }), "develop").asleep, false, "a space with no tabs listed isn't taken as asleep");
});

test("asleep (workspace-sleep D3): the main checkout sleeps too, and an agent needing attention keeps its status", () => {
  const settled = space("s1", "/code/app", { status: "done", tabs: [tab("s1-t1", { settled: true })] });
  const main = ws(tree({ spaces: [settled] }), "main");
  assert.deepEqual([main.asleep, main.main, main.status, main.open], [true, true, "done", true]);
});

// ── Hide sleeping (workspace-sleep D8) ─────────────────────────────────────

// A space whose every tab is put away (`tab.settle`): D3's asleep. LOGIN
// (below, with the Delete dialog's cases) is feat/login's folder.
const putAway = (id, folder, extra = {}) => space(id, folder, { tabs: [tab(`${id}-t1`, { settled: true })], ...extra });

test("hide sleeping off: every row shows, asleep or not, whatever the exemption says (D8)", () => {
  const all = ["P app", "W main", "W login", "P api", "W develop"];
  assert.deepEqual(brief(tree().rows), all, "off by default: nothing is open, so every workspace is asleep, and all show");
  assert.deepEqual(brief(tree({ hideSleeping: false, exceptMain: false }).rows), all);
  assert.deepEqual(brief(tree({ hideSleeping: false, spaces: [putAway("s1", LOGIN)] }).rows), all);
});

test("hide sleeping on: asleep rows go, never-opened ones too; the main checkouts stay unless the exemption is off; a project row always stays (D8)", () => {
  assert.deepEqual(brief(tree({ hideSleeping: true }).rows), ["P app", "W main", "P api", "W develop"], "Except default branch is on by default");
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: true }).rows), ["P app", "W main", "P api", "W develop"]);
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false }).rows), ["P app", "P api"], "every workspace hidden: the project rows stay");
  const awake = [space("s1", LOGIN), putAway("s2", "/code/api")];
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false, spaces: awake }).rows), ["P app", "W login", "P api"], "an awake workspace shows, a put-away one hides");
});

test("hide sleeping on: the shown workspace is never hidden, nor one whose agent needs attention; a hidden one takes its agents along (D8, D3)", () => {
  const shown = tree({ hideSleeping: true, exceptMain: false, spaces: [putAway("s1", LOGIN, { active: true })] });
  assert.deepEqual(brief(shown.rows), ["P app", "W login", "P api"], "shown though every tab is put away");
  assert.equal(ws(shown, "login").asleep, true);
  const done = tree({ hideSleeping: true, exceptMain: false, spaces: [putAway("s1", LOGIN, { status: "done" })] });
  assert.deepEqual(brief(done.rows), ["P app", "W login", "P api"], "its status mark shows instead of the moon (D3), so the row isn't sleeping to look at");
  const idle = tree({ hideSleeping: true, exceptMain: false, spaces: [putAway("s1", LOGIN, { status: "idle" })], agents: [agent("t1", "s1", { title: "Login form" })] });
  assert.deepEqual(brief(idle.rows), ["P app", "P api"], "an idle agent is no attention: the row and its agent go");
});

test("hide sleeping on: the rail, a folded project and the rows git hasn't given yet are as before (D8)", () => {
  const off = tree();
  const on = tree({ hideSleeping: true, exceptMain: false });
  assert.deepEqual(on.projects, off.projects, "the rail and a project's click see every workspace");
  assert.deepEqual(brief(tree({ hideSleeping: true, collapsed: ["/code/app"] }).rows), ["P app", "P api", "W develop"]);
  const { "/code/api": _, ...cache } = CACHE;
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false, cache }).rows), ["P app", "P api", "loading"]);
  assert.deepEqual(brief(tree({ hideSleeping: true, exceptMain: false, cache, failed: new Set(["/code/api"]) }).rows), ["P app", "P api", "missing"]);
});

test("filter popup (D8): Hide sleeping, off by default; Except default branch only while hiding, indented, on by default", () => {
  assert.deepEqual(filterMenuItems(parseUi(undefined)), [{ id: "hide-sleeping", label: "Hide sleeping", icon: "moon", on: false }]);
  assert.deepEqual(filterMenuItems(parseUi({ exceptMain: false })), [{ id: "hide-sleeping", label: "Hide sleeping", icon: "moon", on: false }], "the exemption shows only while hiding");
  assert.deepEqual(filterMenuItems(parseUi({ hideSleeping: true })), [
    { id: "hide-sleeping", label: "Hide sleeping", icon: "moon", on: true },
    { id: "except-main", label: "Except default branch", icon: "branch", on: true, indented: true },
  ]);
  assert.equal(filterMenuItems(parseUi({ hideSleeping: true, exceptMain: false }))[1].on, false);
});

test("click (D8): an open workspace selects its space, a closed one opens a space named by its label", () => {
  const t = tree({ spaces: [space("s1", "/code/app", { active: true })] });
  assert.deepEqual(openAction(ws(t, "main")), { name: "space.select", args: { id: "s1" } });
  assert.deepEqual(openAction(ws(t, "develop")), { name: "space.new", args: { folder: "/code/api", name: "develop" } });
  assert.deepEqual(openAction(ws(t, "login")), { name: "space.new", args: { folder: "/Users/demo/orca/workspaces/app/feat-login", name: "login" } });
});

test("agent row: under its workspace, status, cleaned title and time since its tab changed (S10)", () => {
  const spaces = [space("s2", "/Users/demo/orca/workspaces/app/feat-login", { status: "working", tabs: [tab("s2-t1", { changed_at: NOW - 90_000 })] })];
  const agents = [agent("t7", "s2", { status: "working", title: "✳ Traspaso de herdr-plugins" })];
  const t = tree({ spaces, agents });
  assert.deepEqual(brief(t.rows), ["P app", "W main", "W login", "A Traspaso de herdr-plugins", "P api", "W develop"]);
  const row = t.rows.find((r) => r.kind === "agent");
  assert.deepEqual([row.status, row.since, row.pane, row.program.key], ["working", "1m", "s2-p", "claude"]);
  assert.equal(ws(t, "login").status, "working", "the workspace shows the agent's status in place of its branch icon");
  assert.equal(ws(t, "main").status, null);
});

test("agent title: a named tab wins, a bare tab number or a path says the program's name", () => {
  const live = agent("t1", "s1", { title: "⠂ Fix the login" });
  assert.equal(agentTitle(live, tab("x")), "Fix the login");
  assert.equal(agentTitle(live, tab("x", { name: "review", named: true })), "review");
  assert.equal(agentTitle(agent("t1", "s1", { title: "~/code/app" }), tab("x", { name: "2" })), "Claude Code");
  assert.equal(agentTitle(agent("t1", "s1", { title: "claude" }), undefined), "Claude Code");
});

test("time since: <1m, minutes, hours, days; nothing when the tab never changed", () => {
  assert.deepEqual([ago(20_000), ago(90_000), ago(3 * 3_600_000), ago(2 * 86_400_000), ago(null)], ["<1m", "1m", "3h", "2d", ""]);
});

test("spaces outside every project are shown nowhere: no Others section (S14, S15)", () => {
  const spaces = [
    space("tmp", "/tmp/scratch", { active: true, status: "done" }),
    space("remote", "/code/app", { machine: "vps", status: "blocked" }),
  ];
  const agents = [agent("t9", "tmp", { status: "done" }), agent("t8", "remote", { status: "blocked" })];
  const t = tree({ spaces, agents });
  assert.deepEqual(brief(t.rows), ["P app", "W main", "W login", "P api", "W develop"]);
  assert.ok(t.rows.every((r) => ["project", "workspace", "agent", "loading"].includes(r.kind)));
  assert.ok(t.rows.every((r) => !r.open && !r.selected && !r.status));
});

test("collapsed: a collapsed project shows its own row only", () => {
  const t = tree({ collapsed: ["/code/app"] });
  assert.deepEqual(brief(t.rows), ["P app", "P api", "W develop"]);
  assert.equal(t.rows[0].collapsed, true);
  assert.equal(t.rows[1].collapsed, false);
});

test("empty group: no rows and the empty state, whatever other groups hold", () => {
  const r = registry();
  const empty = buildTree({ registry: selectGroup(addGroup(r, "Empty"), "g3"), cache: CACHE, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW });
  assert.deepEqual([empty.group.name, empty.empty, empty.rows.length], ["Empty", true, 0]);
  const fresh = buildTree({ registry: emptyRegistry(), cache: {}, spaces: [space("s1", "/code/app", { active: true })], panes: [], agents: [], collapsed: [], home: HOME, now: NOW });
  assert.deepEqual([fresh.group.name, fresh.empty, fresh.rows.length], ["Projects", true, 0]);
});

test("a project not listed yet shows a loading row", () => {
  const { "/code/api": _, ...cache } = CACHE;
  const t = tree({ cache });
  assert.deepEqual(brief(t.rows), ["P app", "W main", "W login", "P api", "loading"]);
  assert.equal(t.projects[1].loading, true);
});

test("a project git couldn't list (its folder gone) says so instead of loading for ever", () => {
  const { "/code/api": _, ...cache } = CACHE;
  const t = tree({ cache, failed: new Set(["/code/api"]) });
  assert.deepEqual(brief(t.rows), ["P app", "W main", "W login", "P api", "missing"]);
  assert.deepEqual([t.projects[1].loading, t.projects[1].missing], [false, true]);
  assert.equal(tree({ failed: new Set(["/code/api"]) }).projects[1].missing, false, "a cached list still shows");
});

// ── Narrow rail (D18) ──────────────────────────────────────────────────────

test("rail: project initials, the most urgent status of its spaces, the selected project", () => {
  assert.deepEqual(["herdr-plugins", "app", ".claude", "app_english", "budget-app"].map(initials), ["HP", "A", "C", "AE", "BA"]);
  assert.equal(mostUrgent(["working", "done", null, "idle"]), "done");
  assert.equal(mostUrgent(["idle", "blocked", "done"]), "blocked");
  assert.equal(mostUrgent([null]), null);
  const spaces = [
    space("s1", "/code/app", { status: "working", active: true }),
    space("s2", "/Users/demo/orca/workspaces/app/feat-login", { status: "done" }),
  ];
  const t = tree({ spaces });
  assert.deepEqual([t.projects[0].initials, t.projects[0].status, t.projects[0].selected], ["A", "done", true]);
  assert.deepEqual([t.projects[1].initials, t.projects[1].status, t.projects[1].selected], ["A", null, false]);
});

test("rail: narrow below 160 px of sidebar, by the shown layout", () => {
  const layout = (px) => ({ id: "root", children: [{ id: "sidebar", size: { px } }, { id: "work" }] });
  assert.equal(isNarrow(layout(76)), true);
  assert.equal(isNarrow(layout(268)), false);
  assert.equal(isNarrow({ id: "root", children: [] }), false);
  assert.equal(isNarrow(null), false);
});

test("rail click: the shown workspace stays, else an open one is selected, else the main checkout opens", () => {
  const spaces = [space("s1", "/code/app"), space("s2", "/Users/demo/orca/workspaces/app/feat-login", { active: true })];
  const t = tree({ spaces });
  assert.deepEqual(railAction(t.projects[0]), { name: "space.select", args: { id: "s2" } });
  const t2 = tree({ spaces: [{ ...spaces[1], active: false }] });
  assert.deepEqual(railAction(t2.projects[0]), { name: "space.select", args: { id: "s2" } });
  assert.deepEqual(railAction(t2.projects[1]), { name: "space.new", args: { folder: "/code/api", name: "develop" } });
});

// ── Add project (D10; S5, S6) ──────────────────────────────────────────────

// A fake of the herdr side of Add project: an in-memory registry and cache.
function io({ reg = emptyRegistry(), cache = {}, spaces = [], resolve, list } = {}) {
  const state = { reg, cache, runs: [] };
  state.io = {
    resolve: resolve ?? (async (folder) => ({ path: folder, name: folder.split("/").pop() })),
    list: list ?? (async (path) => [{ path, branch: "main", main: true }]),
    updateRegistry: (fn) => (state.reg = fn(state.reg)),
    cache: () => state.cache,
    saveWorktrees: (path, l) => { state.cache = { ...state.cache, [path]: l }; },
    spaces: () => spaces,
    panes: () => [],
    home: HOME,
    run: (name, args) => state.runs.push([name, args]),
  };
  return state;
}

test("add project: a picked folder joins the active group as its repo's main checkout, listed, and its space opens with no space open (S5, S6)", async () => {
  const s = io({
    resolve: async () => ({ path: "/code/new", name: "new" }),
    list: async (path) => [{ path, branch: "trunk", main: true }, { path: "/w/new/fix", branch: "fix", main: false }],
  });
  const out = await addProjectAt("/w/new/fix/src", s.io);
  assert.deepEqual(out.project, { path: "/code/new", name: "new" });
  assert.deepEqual(s.reg.groups[0].projects, [{ path: "/code/new", name: "new" }]);
  assert.equal(s.cache["/code/new"].length, 2);
  assert.deepEqual(s.runs, [["space.new", { folder: "/code/new", name: "trunk" }]]);
});

test("add project: already registered in another group, not added twice; that group turns active and its open main space is selected", async () => {
  const reg = registry();
  const s = io({ reg, cache: CACHE, spaces: [space("s9", "/code/client")] });
  await addProjectAt("/code/client", s.io);
  assert.deepEqual(projectPaths(s.reg), ["/code/app", "/code/api", "/code/client"]);
  assert.equal(s.reg.activeGroup, reg.groups[1].id);
  assert.deepEqual(s.runs, [["space.select", { id: "s9" }]]);
});

test("add project: a folder git can't list is still added, and a space opens on it", async () => {
  const s = io({ list: async () => { throw new Error("gone"); } });
  await addProjectAt("/code/notes", s.io);
  assert.deepEqual(projectPaths(s.reg), ["/code/notes"]);
  assert.deepEqual(s.runs, [["space.new", { folder: "/code/notes", name: "notes" }]]);
});

test("add here: the focused space's live folder; another machine's or no space is refused (S5)", () => {
  const spaces = [space("s1", "/code/app"), space("s2", "/code/api", { machine: "vps" })];
  const panes = [{ pane: "s1-p", tab: "s1-t1", terminal: "t1", cwd: "/code/app/src" }];
  assert.deepEqual(liveFolder({ space: "s1" }, spaces, panes), { folder: "/code/app/src" });
  assert.ok(liveFolder({ space: "s2" }, spaces, panes).error);
  assert.ok(liveFolder(null, spaces, panes).error);
  assert.ok(liveFolder({ space: "gone" }, spaces, panes).error);
});

test("open main: the main checkout's space is selected when open, else opened (the project menu's Open main)", () => {
  const spaces = [space("s1", "/code/app/src")];
  assert.deepEqual(openMainAction({ project: "/code/app", cache: CACHE, spaces, panes: [], home: HOME }), { name: "space.select", args: { id: "s1" } });
  assert.deepEqual(openMainAction({ project: "/code/api", cache: CACHE, spaces, panes: [], home: HOME }), { name: "space.new", args: { folder: "/code/api", name: "develop" } });
  assert.deepEqual(openMainAction({ project: "/code/unlisted", cache: CACHE, spaces, panes: [], home: HOME }), { name: "space.new", args: { folder: "/code/unlisted", name: "unlisted" } });
});

// ── Project menu (D11) ─────────────────────────────────────────────────────

test("project menu: Open main, New workspace…, Default branch…, Move to group ▸ (the other groups), Remove from list", () => {
  const r = registry();
  assert.deepEqual(projectMenuItems(r, "/code/app").map((i) => i.label), ["Open main", "New workspace…", "Default branch…", "Move to group", "Remove from list"]);
  assert.equal(projectMenuItems(r, "/code/app").find((i) => i.id === "move").disabled, false);
  assert.deepEqual(projectMenuItems(r, "/code/app", true), [{ id: "move-to", label: "Clients", group: r.groups[1].id }]);
  assert.deepEqual(projectMenuItems(r, "/code/client", true).map((i) => i.label), ["Projects"]);
  const one = addProject(emptyRegistry(), { path: "/code/app" });
  assert.equal(projectMenuItems(one, "/code/app").find((i) => i.id === "move").disabled, true, "no other group to move to");
  assert.deepEqual(projectMenuItems(r, "/code/unknown"), []);
});

test("project menu: Default branch… comes right after New workspace…, on every project, git or not (D37, S33)", () => {
  const r = registry();
  const items = projectMenuItems(r, "/code/app");
  const at = items.findIndex((i) => i.id === "new-workspace");
  assert.deepEqual(items[at + 1], { id: "default-branch", label: "Default branch…" });
  const saved = setProjectBase(r, "/code/client", "origin/develop");
  assert.deepEqual(projectMenuItems(saved, "/code/client").map((i) => i.id), ["open-main", "new-workspace", "default-branch", "move", "remove"], "with a base saved too");
  assert.deepEqual(projectMenuItems(r, "/code/app", true).map((i) => i.id), ["move-to"], "not in the Move to group submenu");
});

test("remove from list: its cached worktrees go too, so no space matches it any more (S14, S15, D11)", () => {
  const spaces = [space("s1", "/code/app")];
  assert.deepEqual(Object.keys(matchSpaces(CACHE, spaces, [], HOME)), ["s1"]);
  const cache = withoutProject(CACHE, "/code/app/");
  assert.deepEqual(Object.keys(cache), ["/code/api", "/code/client"]);
  assert.deepEqual(matchSpaces(cache, spaces, [], HOME), {});
  assert.equal(CACHE["/code/app"].length, 2, "the input is not mutated");
});

test("cache pruning: entries of projects no longer registered are dropped; nothing to drop keeps the same value", () => {
  assert.deepEqual(Object.keys(pruneCache(CACHE, ["/code/api"])), ["/code/api"]);
  assert.equal(pruneCache(CACHE, projectPaths(registry())), CACHE);
});

// ── Worktree engine helpers (D6) ───────────────────────────────────────────

test("watch: a repo with linked worktrees is watched at .git/worktrees, else at .git", () => {
  assert.deepEqual(watchDirs("/code/app", CACHE["/code/app"]), ["/code/app/.git/worktrees", "/code/app/.git"]);
  assert.deepEqual(watchDirs("/code/api/", CACHE["/code/api"]), ["/code/api/.git"]);
  assert.deepEqual(watchDirs("/code/new", undefined), ["/code/new/.git"]);
});

test("listing every project: at most N at once, all of them, a failure doesn't stop the rest", async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  const results = await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    seen.push(n);
    if (n === 4) throw new Error("boom");
    return n * 10;
  });
  assert.ok(peak <= 3 && peak > 1, `peak ${peak}`);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(results.map((r) => (r.ok ? r.value : "err")), [10, 20, 30, "err", 50, 60, 70]);
  assert.deepEqual(await eachLimit([], 3, async () => 1), []);
});

test("project paths: every group's projects, for the engine to list and watch", () => {
  assert.deepEqual(projectPaths(registry()), ["/code/app", "/code/api", "/code/client"]);
  assert.deepEqual(projectPaths(emptyRegistry()), []);
});

test("labels: another worktree by its branch's last segment, so a rename shows when the folder stays (D27)", () => {
  assert.equal(workspaceLabel({ path: "/w/app/old-folder", branch: "renamed", main: false }), "renamed");
  assert.equal(workspaceLabel({ path: "/w/app/feat-login", branch: "feat/login", main: false }), "login");
  assert.equal(workspaceLabel({ path: "/w/app/detached", branch: null, main: false }), "detached", "detached: the folder");
  assert.equal(workspaceLabel({ path: "/code/app", branch: "user/main-line", main: true }), "user/main-line", "main keeps its whole branch");
});

// ── Workspace menu (D20) ───────────────────────────────────────────────────

test("workspace menu: Sleep, then Copy Path and Copy Worktree Name, on main and on the others", () => {
  const ids = (row) => workspaceMenuItems(row).map((i) => `${i.id}:${i.label}`);
  assert.deepEqual(ids({ path: "/code/app", branch: "main", main: true }), ["sleep:Sleep", "copy-path:Copy Path", "copy-name:Copy Worktree Name"]);
  assert.deepEqual(ids({ path: "/w/app/feat-login", branch: "feat/login", main: false }).slice(0, 3), ["sleep:Sleep", "copy-path:Copy Path", "copy-name:Copy Worktree Name"]);
  const [, path, name] = workspaceMenuItems({ path: "/w/app/feat-login", branch: "feat/login", main: false });
  assert.equal(path.text, "/w/app/feat-login");
  assert.equal(name.text, "feat-login", "the worktree name is the folder's, not the branch's");
  assert.deepEqual(workspaceMenuItems(null), []);
});

test("workspace menu: Delete… last, after a separator, on a worktree; never on the main checkout (S20, S21)", () => {
  const items = workspaceMenuItems({ path: "/w/app/feat-login", branch: "feat/login", main: false });
  const del = items.at(-1);
  assert.equal(`${del.id}:${del.label}`, "delete:Delete…");
  assert.equal(del.separator, true, "a separator sets it apart");
  assert.equal(del.danger, true, "drawn in the blocked color");
  assert.equal(del.text, undefined, "nothing to copy");
  assert.ok(!workspaceMenuItems({ path: "/code/app", branch: "main", main: true }).some((i) => i.id === "delete"), "the main checkout is never deleted");
});

test("workspace menu: Sleep (Orca's, first, with its moon) puts the workspace to sleep through agent-sleep; off, saying why, with nothing open or already asleep", () => {
  const row = { path: "/w/app/feat-login", branch: "feat/login", main: false };
  const sleep = (state) => workspaceMenuItems(row, state)[0];
  assert.deepEqual(sleep({ open: true, asleep: false }), { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP });
  assert.deepEqual(sleep(undefined), { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP }, "a state not known yet: on, agent-sleep says why if it can't");
  assert.deepEqual(sleep({ open: false, asleep: true }), { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP, disabled: true, why: "Nothing open to put to sleep" });
  assert.deepEqual(sleep({ open: true, asleep: true }), { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP, disabled: true, why: "Already asleep" });
  assert.equal(sleep({ open: true, asleep: false }).separator, undefined, "no separator: it opens the menu");
  assert.equal(sleepCommand("/w/app/feat-login"), "agent-sleep.sleep-workspace.2f772f6170702f666561742d6c6f67696e");
  assert.equal(sleepCommand("/code/ñ"), "agent-sleep.sleep-workspace.2f636f64652fc3b1", "the path's UTF-8");
  assert.equal(sleepCommand(""), null);
  assert.equal(sleepCommand(null), null);
});

// ── Delete dialog (D22) ────────────────────────────────────────────────────

const LOGIN = "/Users/demo/orca/workspaces/app/feat-login";
const ROW = { path: LOGIN, branch: "feat/login", main: false };
const CHECK = {
  deletable: true, reason: "", failed: false, locked: false, lockReason: null, changes: false, submodules: false,
  branch: "feat/login", mainBranch: "main", list: [{ path: "/code/app", branch: "main", main: true }, ROW],
};
const prompt = (over = {}) => deletePrompt({ path: LOGIN, row: ROW, check: CHECK, spaces: 0, terminals: 0, home: HOME, ...over });

test("delete dialog: what it says first, and Delete stays off until git answers (S21, D22)", () => {
  const asking = prompt({ check: null });
  assert.equal(asking.title, "Delete login?", "the row's label (D27)");
  assert.equal(asking.path, "~/orca/workspaces/app/feat-login");
  assert.equal(asking.branch, "Branch feat/login");
  assert.equal(asking.checking, true);
  assert.equal(asking.ready, false, "no Delete before the check");
  assert.equal(asking.button, "Delete");

  const clean = prompt();
  assert.deepEqual([clean.checking, clean.ready, clean.button, clean.reason], [false, true, "Delete", ""]);
  assert.deepEqual(clean.notes, []);
  assert.deepEqual(clean.warnings, []);

  const detached = prompt({ row: { path: LOGIN, branch: null, main: false }, check: { ...CHECK, branch: null } });
  assert.equal(detached.branch, "Detached HEAD");
  assert.equal(detached.title, "Delete feat-login?", "detached: the folder's name");
});

test("delete dialog: its spaces close with their agents, other terminals in the folder stay (D22)", () => {
  assert.deepEqual(prompt({ spaces: 2, terminals: 3 }).notes, [
    "Its 2 spaces close, with their agents.",
    "3 more terminals are in this folder and stay open.",
  ]);
  assert.deepEqual(prompt({ spaces: 1, terminals: 1 }).notes, [
    "Its space closes, with its agents.",
    "1 more terminal is in this folder and stays open.",
  ]);
});

test("delete dialog: changes or submodules ask for Delete anyway; locked, failed or the main checkout have no Delete (S21, D22)", () => {
  const dirty = prompt({ check: { ...CHECK, changes: true } });
  assert.deepEqual(dirty.warnings, ["login has changes that aren't committed. They'll be lost."]);
  assert.equal(dirty.button, "Delete anyway");
  const subs = prompt({ check: { ...CHECK, submodules: true } });
  assert.deepEqual(subs.warnings, ["login has submodules. They're deleted too."]);
  assert.equal(subs.button, "Delete anyway");

  const reason = `Locked by git: on a USB disk. Unlock it with \`git worktree unlock ${LOGIN}\`.`;
  const locked = prompt({ check: { ...CHECK, deletable: false, locked: true, lockReason: "on a USB disk", changes: true, reason } });
  assert.deepEqual([locked.button, locked.ready, locked.reason], [null, false, reason]);
  assert.deepEqual(locked.warnings, [], "nothing to confirm when it can't run");

  const failed = prompt({ check: { ...CHECK, deletable: false, failed: true, reason: "Couldn't check it." } });
  assert.deepEqual([failed.button, failed.ready, failed.reason], [null, false, "Couldn't check it."]);
  const main = prompt({ path: "/code/app", row: { path: "/code/app", branch: "main", main: true }, check: { ...CHECK, deletable: false, branch: "main", reason: "/code/app is the main checkout of app: it is never deleted." } });
  assert.equal(main.button, null);
});

test("delete dialog: terminals that stay are the ones in the folder outside the spaces that close (D22)", () => {
  const sp = [
    space("s1", LOGIN, { tabs: [tab("s1-t1")] }),
    space("s2", "/code/app", { tabs: [tab("s2-t1")] }),
    space("s3", LOGIN, { machine: "box", tabs: [tab("s3-t1")] }),
  ];
  const pane = (id, tabId, cwd, extra = {}) => ({ pane: id, terminal: `${id}-term`, tab: tabId, cwd, ...extra });
  const pn = [
    pane("p1", "s1-t1", LOGIN), // in a space that closes
    pane("p2", "s2-t1", `${LOGIN}/src`), // inside, another space: stays
    pane("p3", "s2-t1", "~/orca/workspaces/app/feat-login"), // `~` too
    pane("p4", "s2-t1", `${LOGIN}-2`), // a sibling folder: not in it
    pane("p5", "s3-t1", LOGIN), // another machine's folder
    pane("p6", "s2-t1", LOGIN, { terminal: null, mod: "files" }), // a mod pane: no terminal
  ];
  assert.equal(terminalsStaying(LOGIN, ["s1"], sp, pn, HOME), 2);
  assert.equal(terminalsStaying(LOGIN, [], sp, pn, HOME), 3);
});

test("delete outcome: removed closes the dialog; a kept branch says why; while closed, a toast says what happened (S21, D22)", () => {
  const removed = (branch) => ({ status: "removed", err: null, branch, branchErr: null, list: [], check: CHECK });
  assert.deepEqual(deleteOutcome(removed("deleted"), { label: "login", open: true }), { close: true, toast: null, error: "", check: null });
  assert.deepEqual(deleteOutcome(removed("kept"), { label: "login", open: true }).toast, { title: "Kept branch feat/login", body: "It isn't merged into main." });
  assert.deepEqual(deleteOutcome(removed("in-use"), { label: "login", open: true }).toast, { title: "Kept branch feat/login", body: "Another workspace has it checked out." });
  const gone = deleteOutcome(removed("deleted"), { label: "login", open: false });
  assert.equal(gone.close, false, "nothing left to close");
  assert.deepEqual(gone.toast, { title: "Deleted login", body: "Branch feat/login too.", level: "success" });
  assert.deepEqual(deleteOutcome(removed("kept"), { label: "login", open: false }).toast,
    { title: "Deleted login", body: "Kept branch feat/login: it isn't merged into main.", level: "success" });
});

test("delete outcome: changed shows the new check; failed and refused stay in the dialog, or toast once it closed (D22)", () => {
  const fresh = { ...CHECK, changes: true };
  const changed = { status: "changed", err: "feat-login now has changes that aren't committed.", branch: null, branchErr: null, list: [], check: fresh };
  assert.deepEqual(deleteOutcome(changed, { label: "login", open: true }), { close: false, toast: null, error: changed.err, check: fresh });
  const failed = { status: "failed", err: "fatal: cannot remove", branch: null, branchErr: null, list: [], check: CHECK };
  assert.deepEqual(deleteOutcome(failed, { label: "login", open: true }), { close: false, toast: null, error: "fatal: cannot remove", check: null }, "the confirmed check stays: Delete can be tried again");
  assert.deepEqual(deleteOutcome(failed, { label: "login", open: false }).toast, { title: "Didn't delete login", body: "fatal: cannot remove", level: "error" });
  assert.deepEqual(deleteOutcome(changed, { label: "login", open: false }).toast, { title: "Didn't delete login", body: changed.err, level: "warning" });
  const reason = `Locked by git. Unlock it with \`git worktree unlock ${LOGIN}\`.`;
  const nowLocked = { ...CHECK, deletable: false, locked: true, lockReason: "", reason };
  const locked = { status: "locked", err: reason, branch: null, branchErr: null, list: [], check: nowLocked };
  assert.deepEqual(deleteOutcome(locked, { label: "login", open: true }), { close: false, toast: null, error: "", check: nowLocked }, "the check's reason says it once");
});

// ── Rename dialog (D25) ────────────────────────────────────────────────────

test("workspace menu: Rename… on a worktree, before Delete…; never on the main checkout (S22)", () => {
  const items = workspaceMenuItems({ path: "/w/app/feat-login", branch: "feat/login", main: false });
  assert.deepEqual(items.map((i) => i.id), ["sleep", "copy-path", "copy-name", "rename", "delete"]);
  const rename = items[3];
  assert.equal(rename.label, "Rename…");
  assert.ok(!rename.separator && !rename.danger, "a plain item, above Delete…'s separator");
  assert.equal(rename.text, undefined, "nothing to copy");
  assert.ok(workspaceMenuItems({ path: "/w/app/detached", branch: null, main: false }).some((i) => i.id === "rename"), "a detached worktree too: the dialog says why it can't");
  assert.ok(!workspaceMenuItems({ path: "/code/app", branch: "main", main: true }).some((i) => i.id === "rename"), "the main checkout is never renamed");
});

const rprompt = (over = {}) => renamePrompt({ path: LOGIN, row: ROW, text: "feat/login", check: CHECK, live: null, spaces: 0, terminals: 0, home: HOME, ...over });

test("rename dialog: prefilled with the branch, which never renames; Rename waits for git (S22, D25)", () => {
  const asking = rprompt({ check: null });
  assert.equal(asking.title, "Rename login", "the row's label (D27)");
  assert.equal(asking.path, "~/orca/workspaces/app/feat-login");
  assert.equal(asking.branch, "feat/login", "the input's prefill");
  assert.deepEqual([asking.checking, asking.ready, asking.button, asking.editable], [true, false, "Rename", true]);
  assert.equal(asking.line, "Type a new name for the branch.");
  const early = rprompt({ check: null, text: "feat/signup" });
  assert.equal(early.line, "branch feat/login → feat/signup", "the folder waits for git");
  assert.equal(early.ready, false, "no Rename before git says whether the folder can move");

  const untouched = rprompt();
  assert.deepEqual([untouched.checking, untouched.ready, untouched.line], [false, false, "Type a new name for the branch."], "an untouched prefill never renames");
  assert.equal(rprompt({ text: "  " }).ready, false, "an empty name");
  assert.equal(rprompt({ text: "FEAT/LOGIN" }).ready, false, "a name that differs from the branch only in case is unchanged");
});

test("rename dialog: a name that only changes the case says so and Rename stays off; the prefill and an empty name ask for a name (L31)", () => {
  const caseOnly = "Only the case changes: git on macOS can't rename a branch that way.";
  for (const text of ["FEAT/LOGIN", "Feat/Login", "feat/LOGIN!"]) {
    const p = rprompt({ text });
    assert.deepEqual([p.line, p.ready, p.reason], [caseOnly, false, ""], text);
  }
  const live = { status: "refused", reason: "unchanged", err: "The branch is already feat/login.", text: "FEAT/LOGIN" };
  assert.deepEqual([rprompt({ text: "FEAT/LOGIN", live }).line, rprompt({ text: "FEAT/LOGIN", live }).reason], [caseOnly, ""], "said once, by the line");
  assert.equal(rprompt().line, "Type a new name for the branch.", "the untouched prefill");
  assert.equal(rprompt({ text: "  " }).line, "Type a new name for the branch.", "an empty name");
  assert.equal(rprompt({ text: "feat//login" }).line, "Type a new name for the branch.", "slugs to the branch itself: no case change");
});

test("rename dialog: the live line says the branch and the folder; a namespace survives and the name is slugged (S22, D25)", () => {
  const p = rprompt({ text: "feat/signup" });
  assert.equal(p.line, "branch feat/login → feat/signup · folder signup");
  assert.deepEqual([p.name, p.ready, p.moveFolder, p.reason], ["feat/signup", true, true, ""]);
  const slugged = rprompt({ text: "Fix Login!" });
  assert.deepEqual([slugged.name, slugged.line], ["Fix-Login", "branch feat/login → Fix-Login · folder Fix-Login"]);
  assert.equal(rprompt({ text: "team/feat-login" }).line, "branch feat/login → team/feat-login · folder stays feat-login", "the folder already has that name");
});

test("rename dialog: the folder stays while a space or a terminal is in it, or while git locks it or it has submodules (D25, D26)", () => {
  const stays = (over) => {
    const p = rprompt({ text: "feat/signup", ...over });
    return [p.moveFolder, p.line, p.ready];
  };
  const line = (why) => `branch feat/login → feat/signup · folder stays feat-login (${why})`;
  assert.deepEqual(stays({ spaces: 1 }), [false, line("a terminal is open there"), true], "the branch is still renamed");
  assert.deepEqual(stays({ terminals: 2 }), [false, line("a terminal is open there"), true]);
  assert.deepEqual(stays({ check: { ...CHECK, deletable: false, locked: true, lockReason: "usb" } }), [false, line("locked by git"), true]);
  assert.deepEqual(stays({ check: { ...CHECK, submodules: true } }), [false, line("has submodules"), true]);
  assert.deepEqual(stays({ spaces: 1, check: { ...CHECK, deletable: false, locked: true, lockReason: "" } }), [false, line("locked by git"), true],
    "git's reason first: closing the terminal wouldn't move it");
  assert.deepEqual(stays({ check: { ...CHECK, deletable: false, failed: true, reason: "Couldn't check it." } }), [false, line("git couldn't check it"), true]);
});

test("rename dialog: a refusal of the typed name shows before Enter; detached, the main checkout or a stray path have no Rename (S22, D25)", () => {
  const pushed = { status: "refused", reason: "remote-exists", err: "origin already has feat/signup.", text: "feat/signup" };
  const p = rprompt({ text: "feat/signup", live: pushed });
  assert.deepEqual([p.reason, p.ready, p.button, p.editable], [pushed.err, false, "Rename", true]);
  const other = rprompt({ text: "feat/other", live: pushed });
  assert.deepEqual([other.reason, other.ready], ["", true], "a check of another text is stale: Rename checks again anyway");
  assert.equal(rprompt({ live: { status: "refused", reason: "unchanged", err: "The branch is already feat/login.", text: "feat/login" } }).reason, "", "the hint already says it");
  const exists = { status: "refused", reason: "folder-exists", err: "/w/app/signup already exists.", text: "feat/signup" };
  assert.deepEqual([rprompt({ text: "feat/signup", live: exists }).reason, rprompt({ text: "feat/signup", live: exists }).ready], [exists.err, false]);

  const detachedRow = { path: LOGIN, branch: null, main: false };
  const detached = { status: "refused", reason: "detached", err: "feat-login is detached or in the middle of a rebase.", text: "" };
  const d = rprompt({ row: detachedRow, text: "", live: detached });
  assert.equal(d.title, "Rename feat-login", "detached: the folder's name");
  assert.deepEqual([d.reason, d.button, d.ready, d.editable, d.line], [detached.err, null, false, false, ""]);
  assert.equal(rprompt({ row: detachedRow, text: "x", live: detached }).button, null, "whatever is typed");
  const main = { status: "refused", reason: "main", err: "The main checkout isn't renamed: rename one of its workspaces.", text: "main" };
  assert.deepEqual([rprompt({ path: "/code/app", row: { path: "/code/app", branch: "main", main: true }, text: "main", live: main }).button], [null]);
  const missing = { status: "refused", reason: "missing", err: `${LOGIN} isn't a workspace of app.`, text: "feat/login" };
  assert.equal(rprompt({ live: missing }).reason, missing.err);
  const unlisted = { ...CHECK, deletable: false, failed: true, branch: null, list: null, reason: "Couldn't list the workspaces of app: git didn't answer." };
  assert.deepEqual([rprompt({ row: null, text: "x", check: unlisted }).reason, rprompt({ row: null, text: "x", check: unlisted }).ready], [unlisted.reason, false],
    "no branch known and git couldn't list: says why instead of nothing");
});

test("rename outcome: renamed closes the dialog; a folder git kept says why; while closed, a toast says what happened (S22, D26)", () => {
  const renamed = (folder, err = "") => ({ status: "renamed", reason: null, branch: "feat/signup", folder, err, list: [] });
  const open = { label: "login", path: LOGIN, open: true };
  const closed = { ...open, open: false };
  assert.deepEqual(renameOutcome(renamed("moved"), open), { close: true, toast: null, error: "", live: null });
  assert.deepEqual(renameOutcome(renamed("stays"), open), { close: true, toast: null, error: "", live: null }, "the live line said so before");
  assert.deepEqual(renameOutcome(renamed("kept", "fatal: cannot move a locked working tree"), open),
    { close: true, toast: { title: "Renamed login to feat/signup", body: "Its folder stays feat-login: fatal: cannot move a locked working tree", level: "warning" }, error: "", live: null });
  assert.deepEqual(renameOutcome(renamed("moved", "Couldn't unset the upstream of feat/signup: x"), open).toast,
    { title: "Renamed login to feat/signup", body: "Its folder is now signup. Couldn't unset the upstream of feat/signup: x", level: "warning" });
  assert.deepEqual(renameOutcome(renamed("moved"), closed), { close: false, toast: { title: "Renamed login to feat/signup", body: "Its folder is now signup.", level: "success" }, error: "", live: null });
  assert.deepEqual(renameOutcome(renamed("stays"), closed).toast, { title: "Renamed login to feat/signup", body: "Its folder stays feat-login.", level: "success" });
});

test("rename outcome: a refusal stays in the dialog as its reason, a failure as an error; once closed, a toast (S22, D25)", () => {
  const open = { label: "login", path: LOGIN, open: true };
  const closed = { ...open, open: false };
  const refused = { status: "refused", reason: "branch-exists", branch: "feat/login", folder: null, err: "Branch feat/signup already exists.", list: [] };
  assert.deepEqual(renameOutcome(refused, open), { close: false, toast: null, error: "", live: { status: "refused", reason: "branch-exists", err: refused.err } }, "said once, as the refusal");
  const failed = { status: "failed", reason: null, branch: "feat/login", folder: null, err: "fatal: x", list: null };
  assert.deepEqual(renameOutcome(failed, open), { close: false, toast: null, error: "fatal: x", live: null });
  assert.deepEqual(renameOutcome(failed, closed).toast, { title: "Didn't rename login", body: "fatal: x", level: "error" });
  assert.deepEqual(renameOutcome(refused, closed).toast, { title: "Didn't rename login", body: refused.err, level: "warning" });
  assert.equal(renameOutcome({ status: "failed", err: "" }, open).error, "git couldn't rename it.");
  const already = { status: "refused", reason: "unchanged", branch: "feat/signup", folder: null, err: "The branch is already feat/signup.", list: [] };
  assert.deepEqual(renameOutcome(already, open), { close: false, toast: null, error: already.err, live: null }, "a refusal the live line hides is said as an error");
});

// ── Rename of a pushed branch (T9c, D28) ───────────────────────────────────

const ORIGIN = { published: true, route: "github", gone: false, repo: { owner: "acme", repo: "shop" }, prs: [], sha: "s1" };
const ok = (over = {}) => ({ status: "ok", reason: null, err: "", folderTaken: false, newPath: "/Users/demo/orca/workspaces/app/signup", origin: ORIGIN, text: "feat/signup", ...over });

test("rename dialog (T9c 17): a pushed branch states the path on open, before a name is typed (S23, D28)", () => {
  const onOpen = (origin) => rprompt({ live: { status: "refused", reason: "unchanged", err: "The branch is already feat/login.", origin, text: "feat/login" } });
  const github = onOpen(ORIGIN);
  assert.equal(github.remote, "Renames it on GitHub too (acme/shop).");
  assert.equal(github.line, "Type a new name for the branch.", "the name line is unchanged");
  assert.equal(onOpen({ ...ORIGIN, route: "copy", repo: null }).remote, "Pushes a copy under the new name; origin keeps feat/login.");
  assert.equal(onOpen({ ...ORIGIN, route: "local", gone: true, repo: null, sha: null }).remote, "origin no longer has feat/login: renames it here only.");
  assert.equal(onOpen({ ...ORIGIN, published: false, route: "local", repo: null, sha: null }).remote, "", "a branch no remote has: nothing to say");
  assert.equal(rprompt().remote, "", "before git answers");
  const typed = rprompt({ text: "feat/signup", live: ok({ origin: { ...ORIGIN, route: "copy", repo: null } }) });
  assert.equal(typed.remote, "Pushes a copy as feat/signup; origin keeps feat/login.");
  assert.equal(rprompt({ text: "feat/other", live: ok() }).remote, "Renames it on GitHub too (acme/shop).", "the path doesn't depend on the name: an older check says it");
});

test("rename dialog (T9c 13): an open PR from the branch is warned about and Rename reads 'Rename anyway'; none, or the copy path, no warning (S23, D28)", () => {
  const pr = { number: 12, url: "https://github.example/acme/shop/pull/12" };
  const warned = rprompt({ text: "feat/signup", live: ok({ origin: { ...ORIGIN, prs: [pr] } }) });
  assert.deepEqual(warned.warnings, ["GitHub closes PR #12 when its branch is renamed."]);
  assert.deepEqual([warned.button, warned.ready], ["Rename anyway", true]);
  const quiet = rprompt({ text: "feat/signup", live: ok() });
  assert.deepEqual([quiet.warnings, quiet.button], [[], "Rename"]);
  const copy = rprompt({ text: "feat/signup", live: ok({ origin: { ...ORIGIN, route: "copy", repo: null, prs: [] } }) });
  assert.deepEqual([copy.warnings, copy.button, copy.remote], [[], "Rename", "Pushes a copy as feat/signup; origin keeps feat/login."], "a PR list that failed: only the copy path");
});

test("rename dialog (T9c): origin unreachable, pushed elsewhere or no push access refuse whatever is typed; the input stays (D28)", () => {
  for (const [reason, err] of [
    ["unreachable", "Couldn't reach origin: fatal: x."],
    ["pushed-elsewhere", "Also pushed as github/feat/login: renaming would split it."],
    ["no-push", "You can't push to acme/shop."],
  ]) {
    const live = { status: "refused", reason, err, text: "feat/login" };
    const p = rprompt({ text: "feat/later", live });
    assert.deepEqual([p.reason, p.ready, p.editable, p.button], [err, false, true, "Rename"], reason);
    const carried = rprompt({ text: "feat/later", live: { ...live, origin: { ...ORIGIN, prs: [{ number: 3, url: "u" }] } } });
    assert.deepEqual([carried.remote, carried.warnings], ["", []], "a path read earlier isn't stated under a refusal of origin");
  }
});

test("rename dialog (T9c 16): a taken folder only refuses when the folder would move; with a terminal there, only the branch is renamed (D25)", () => {
  const taken = ok({ folderTaken: true, origin: { ...ORIGIN, published: false, route: "local", repo: null } });
  const moving = rprompt({ text: "feat/signup", live: taken });
  assert.deepEqual([moving.reason, moving.ready], ["/Users/demo/orca/workspaces/app/signup already exists.", false]);
  const staying = rprompt({ text: "feat/signup", live: taken, spaces: 1 });
  assert.deepEqual([staying.reason, staying.ready, staying.moveFolder], ["", true, false]);
  assert.equal(staying.line, "branch feat/login → feat/signup · folder stays feat-login (a terminal is open there)");
  const atClick = { status: "refused", reason: "folder-exists", err: "/w/app/signup already exists.", text: "feat/signup" };
  assert.equal(rprompt({ text: "feat/signup", live: atClick, check: { ...CHECK, locked: true, deletable: false } }).ready, true, "locked: the folder stays, the name is free");
});

test("rename outcome (T9c 21, 9): changed shows the fresh check; a remote done with the local branch left behind says how to finish (D28)", () => {
  const open = { label: "login", path: LOGIN, open: true };
  const closed = { ...open, open: false };
  const fresh = { status: "ok", reason: null, err: "", origin: { ...ORIGIN, prs: [{ number: 7, url: "u" }] } };
  const changed = { status: "changed", reason: "prs", branch: "feat/login", name: "feat/signup", folder: null, err: "PR #7 was opened from feat/login since the dialog checked it.", list: [], remote: null, prs: [], check: fresh };
  assert.deepEqual(renameOutcome(changed, open), { close: false, toast: null, error: changed.err, live: fresh });
  assert.deepEqual(renameOutcome(changed, closed).toast, { title: "Didn't rename login", body: changed.err, level: "warning" });
  const fix = "Renamed on GitHub to feat/signup, but the local branch is still feat/login: run `git branch -m feat/login feat/signup`.";
  const split = { status: "renamed", reason: null, branch: "feat/login", name: "feat/signup", folder: "stays", err: fix, list: [], remote: "renamed", prs: [] };
  assert.deepEqual(renameOutcome(split, open), { close: true, toast: { title: "Didn't rename login here", body: fix, level: "warning" }, error: "", live: null });
  const there = { status: "renamed", reason: null, branch: "feat/signup", name: "feat/signup", folder: "moved", err: "", list: [], remote: "renamed", prs: [] };
  assert.deepEqual(renameOutcome(there, open), { close: true, toast: null, error: "", live: null }, "as the dialog said");
  assert.equal(renameOutcome(there, closed).toast.body, "Renamed on GitHub too. Its folder is now signup.");
  assert.equal(renameOutcome({ ...there, remote: "copied" }, closed).toast.body, "origin has a copy as feat/signup. Its folder is now signup.");
  const finishing = renameOutcome({ ...there, err: "GitHub is still finishing the rename." }, open);
  assert.deepEqual(finishing.toast, { title: "Renamed login to feat/signup", body: "Renamed on GitHub too. Its folder is now signup. GitHub is still finishing the rename.", level: "warning" });
});

// ── Drag to reorder (D33, S28) ─────────────────────────────────────────────

// One group with a, b, c (in that order), plus Clients with client.
function three() {
  let r = registry();
  r = addProject(r, { path: "/code/web" }, r.groups[0].id);
  return r;
}
const order = (r, i = 0) => r.groups[i].projects.map((p) => p.path);

test("reorder: before or after a target in the same group (D33)", () => {
  const r = three();
  assert.deepEqual(order(r), ["/code/app", "/code/api", "/code/web"]);
  assert.deepEqual(order(reorderProject(r, "/code/web", "/code/app", false)), ["/code/web", "/code/app", "/code/api"]);
  assert.deepEqual(order(reorderProject(r, "/code/app", "/code/api", true)), ["/code/api", "/code/app", "/code/web"]);
  assert.deepEqual(order(reorderProject(r, "/code/app", "/code/web", true)), ["/code/api", "/code/web", "/code/app"]);
  assert.deepEqual(order(reorderProject(r, "/code/web/", "/code/api", false)), ["/code/app", "/code/web", "/code/api"], "paths are normalized");
});

test("reorder: nothing moves → the same registry (D33)", () => {
  const r = three();
  assert.equal(reorderProject(r, "/code/app", "/code/app", false), r, "onto itself");
  assert.equal(reorderProject(r, "/code/app", "/code/api", false), r, "already right before it");
  assert.equal(reorderProject(r, "/code/api", "/code/app", true), r, "already right after it");
  assert.equal(reorderProject(r, "/code/app", "/code/client", false), r, "a target in another group");
  assert.equal(reorderProject(r, "/code/nope", "/code/app", false), r, "an unknown project");
  assert.equal(reorderProject(r, "/code/app", "/code/nope", false), r, "an unknown target");
});

test("reorder: other groups, the mode, a project's saved base and the stored value are kept (D33, D29, D37)", () => {
  const r = setProjectBase(setOrganize(three(), "g1", "task"), "/code/web", "origin/develop");
  const next = reorderProject(r, "/code/web", "/code/app", false);
  assert.deepEqual(order(next, 1), ["/code/client"]);
  assert.equal(next.groups[0].organize, "task");
  assert.equal(findProject(next, "/code/web").project.base, "origin/develop", "the base follows a dragged project");
  assert.equal(next.activeGroup, r.activeGroup);
  const stored = JSON.parse(JSON.stringify(next));
  assert.deepEqual(parseRegistry(stored), next);
  assert.equal(needsBackup(stored, parseRegistry(stored)), false, "a reordered registry reads back as itself");
});

// Spotlight T18 (its D29): other plugins' badges on a Task-mode lane header.
test("lane badges (D29): a lane finds what was published under its group and its lane exactly as the tree builds it; other groups' and other spellings draw nowhere", () => {
  const W = "/Users/demo/orca/workspaces";
  let r = emptyRegistry();
  r = addProject(r, { path: "/code/app" });
  r = addProject(r, { path: "/code/api" });
  r = setOrganize(r, "g1", "task");
  r = addGroup(r, "Clients");
  r = addProject(r, { path: "/code/client" }, "g2");
  r = setOrganize(r, "g2", "task");
  const cache = {
    "/code/app": [
      { path: "/code/app", branch: "main", main: true },
      { path: `${W}/app/ax-3653-fix`, branch: "alex/ax-3653-fix", main: false },
      { path: `${W}/app/login`, branch: "feat/Login", main: false },
    ],
    "/code/api": [{ path: "/code/api", branch: "develop", main: true }, { path: `${W}/api/ax-3653`, branch: "AX_3653", main: false }],
    "/code/client": [{ path: "/code/client", branch: "main", main: true }, { path: `${W}/client/ax-3653`, branch: "ax-3653", main: false }],
  };
  const published = parseBadges([{
    "g1/task:AX-3653": [{ text: "on" }],
    "g1/task:login": [{ text: "Dev" }],
    "g2/task:AX-3653": [{ text: "client" }],
    // Not the tree's form of these lanes (P's ticket is uppercased with a
    // dash; a name lane is lowercased): kept by the parse, drawn nowhere.
    "g1/task:ax-3653": [{ text: "lower" }],
    "g1/task:AX_3653": [{ text: "underscore" }],
    "g1/task:Login": [{ text: "cased" }],
  }]);
  // What render hands each lane header (tree.js row): its texts by lane.
  const drawn = (registry) => {
    const t = buildTaskTree({ registry, cache, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW, tasks: [] });
    const lanes = t.rows.filter((x) => x.kind === "task");
    return Object.fromEntries(lanes.map((l) => [l.lane, (published[laneBadgeKey(t.group.id, l.lane)] ?? []).map((b) => b.text)]));
  };
  // Both checkouts of AX-3653 (two spellings in their branches) are one
  // lane, and it finds g1's badges; Servers finds none.
  assert.deepEqual(drawn(r), { "task:AX-3653": ["on"], "task:login": ["Dev"], servers: [] });
  // Another group active: its own lane of the same name, never g1's.
  assert.deepEqual(drawn(selectGroup(r, "g2")), { "task:AX-3653": ["client"], servers: [] });
});

// Spotlight T33 (its D42): a badge's `line: 2` puts it under a workspace
// row's label, which grows to 42 px; a lane header keeps one 28 px line.
test("badge lines (D42): a workspace row with a line-2 badge is two lines, 42 px; a lane header joins its line-2 badges to its one line", () => {
  const W = "/Users/demo/orca/workspaces";
  let r = emptyRegistry();
  r = addProject(r, { path: "/code/app" });
  const cache = { "/code/app": [{ path: "/code/app", branch: "main", main: true }, { path: `${W}/app/ax-3653`, branch: "ax-3653", main: false }] };
  const published = parseBadges([{
    "/code/app": [{ text: "Spotlight", pill: true, bar: "working" }, { text: ":3000", line: 2 }],
    [`${W}/app/ax-3653`]: [{ text: "on" }],
    "g1/task:AX-3653": [{ text: ":3000", line: 2 }, { text: "Probando", pill: true, look: "secondary" }],
  }]);
  const texts = (lines) => [lines.line1.map((b) => b.text), lines.line2.map((b) => b.text), lines.height];
  // Project mode: the root's port under its label; the other row one line.
  const rows = buildTree({ registry: r, cache, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW }).rows.filter((x) => x.kind === "workspace");
  assert.deepEqual(Object.fromEntries(rows.map((w) => [w.path, texts(badgeLines(published[w.path] ?? []))])), {
    "/code/app": [["Spotlight"], [":3000"], 42],
    [`${W}/app/ax-3653`]: [["on"], [], 28],
  });
  // Task mode: the lane header has one line, its line-2 badge at its end.
  const t = buildTaskTree({ registry: setOrganize(r, "g1", "task"), cache, spaces: [], panes: [], agents: [], collapsed: [], home: HOME, now: NOW, tasks: [] });
  const lane = t.rows.find((x) => x.kind === "task" && x.lane === "task:AX-3653");
  assert.deepEqual(texts(badgeLines(published[laneBadgeKey(t.group.id, lane.lane)], { lane: true })), [["Probando", ":3000"], [], 28]);
});

test("reorder: the drag is wired into the tree (D33)", async () => {
  const { readFileSync } = await import("node:fs");
  const tree = readFileSync(new URL("../projects-sidebar/mods/projects/tree.js", import.meta.url), "utf8");
  assert.match(tree, /on_mouse_move\(/);
  assert.match(tree, /reorderProject\(/);
});

// S39: after a rename, the spaces named after the old branch take the new name.
test("spaceRenames: a space the mod named after the old branch takes the new name (S39)", () => {
  const at = "/w/app/resume-previous";
  const matches = { s1: { project: "/r/app", path: at } };
  const spaces = [{ id: "s1", name: "resume-previous", named: true }];
  assert.deepEqual(
    spaceRenames({ path: at, before: "resume-previous", after: "agent-doc-open-endpoint", spaces, matches }),
    [{ id: "s1", name: "agent-doc-open-endpoint" }],
  );
  assert.deepEqual(
    spaceRenames({ path: at, before: "alex/feat-a", after: "alex/feat-b", spaces: [{ id: "s1", name: "feat-a", named: true }], matches }),
    [{ id: "s1", name: "feat-b" }],
    "a namespaced branch: the label is its last segment, as openAction named it",
  );
});

test("spaceRenames: a space someone named otherwise, an unnamed one, and another workspace's keep their names (S39)", () => {
  const at = "/w/app/old";
  const matches = { mine: { path: at }, unnamed: { path: at }, other: { path: "/w/app/else" }, s1: { path: at } };
  const spaces = [
    { id: "mine", name: "my notes", named: true },
    { id: "unnamed", name: "old", named: false },
    { id: "other", name: "old", named: true },
    { id: "loose", name: "old", named: true },
    { id: "s1", name: "old", named: true },
  ];
  assert.deepEqual(spaceRenames({ path: at, before: "old", after: "new", spaces, matches }), [{ id: "s1", name: "new" }]);
});

test("spaceRenames: nothing to rename when the label stays or an input is missing (S39)", () => {
  const at = "/w/app/feat";
  const matches = { s1: { path: at } };
  const spaces = [{ id: "s1", name: "feat", named: true }];
  assert.deepEqual(spaceRenames({ path: at, before: "user/feat", after: "other/feat", spaces, matches }), [], "same last segment");
  assert.deepEqual(spaceRenames({ path: at, before: null, after: "x", spaces, matches }), []);
  assert.deepEqual(spaceRenames({ path: at, before: "feat", after: "x", spaces: null, matches }), []);
  assert.deepEqual(spaceRenames({ path: at, before: "feat", after: "x", spaces, matches: null }), []);
});

// ── projects.toggle-sleeping, from the keeper's copy (workspace-sleep D8) ──
// Every projects.* command runs in the keeper's copy (keeper.js listen,
// workspace-sleep D7), never the tree's, so the filter's command is run
// there, as Herdr delivers it, and has only the store to reach the tree by.
// main.js and its views import herdr, gpui-kit and gpui-base, which only
// Herdr provides: the stand-ins export exactly the names the mod's files
// import, read from their sources (test/inicio-model.test.js has the same).
// Each herdr function forwards to `fake`; gpui's are inert, since nothing
// here draws.
const MOD_DIR = new URL("../projects-sidebar/mods/projects/", import.meta.url);
function importedFrom(spec) {
  const names = new Set();
  for (const f of readdirSync(MOD_DIR).filter((x) => x.endsWith(".js"))) {
    for (const m of readFileSync(new URL(f, MOD_DIR), "utf8").matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${spec}"`, "g"))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}
const INERT = `const inert = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : inert), apply: () => inert, construct: () => inert });`;
const gpui = (spec) => [INERT, ...importedFrom(spec).map((n) => (n === "View" ? "export class View {}" : `export const ${n} = inert;`))].join("\n");
const FAKES = {
  herdr: importedFrom("herdr").map((n) => `export const ${n} = (...a) => globalThis.__projectsHerdr(${JSON.stringify(n)}, a);`).join("\n"),
  "gpui-kit": gpui("gpui-kit"),
  "gpui-base": gpui("gpui-base"),
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});
let fake = {};
globalThis.__projectsHerdr = (name, args) => (fake[name] ? fake[name](...args) : undefined);
const { default: Projects } = await import("../projects-sidebar/mods/projects/main.js");

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
};

// The keeper's copy with no window: it listens all the same (T8) and makes
// or moves nothing, so the shared keys hold only what the commands wrote.
async function keeperWith(shared) {
  const w = { shared: { ...shared }, waiting: [], logs: [] };
  fake = {
    props: () => ({ view: "keeper" }),
    window: () => null,
    shared: (k) => w.shared[k],
    setShared: (k, v) => {
      w.shared[k] = v;
      return null;
    },
    nextCommand: () => new Promise((resolve) => w.waiting.push(resolve)),
  };
  const cx = { spawn: (fn) => fn(cx)?.catch?.(() => {}), timer: { every() {} }, sleep: () => Promise.resolve(), notify() {} };
  new Projects().init(null, cx);
  await settle();
  return w;
}
// A key command, as Herdr delivers one: to the copy waiting on nextCommand().
async function send(w, name) {
  w.waiting.shift()?.(name);
  await settle();
}

test("projects.toggle-sleeping flips Hide sleeping in projects.ui.v1 from the keeper's copy, keeping the folds and the exemption, and the tree reads it back (D8)", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const w = await keeperWith({ "projects.ui.v1": { collapsed: ["/code/app"], tasks: ["servers"], exceptMain: false } });
  await send(w, "toggle-sleeping");
  assert.deepEqual(w.shared["projects.ui.v1"], { collapsed: ["/code/app"], tasks: ["servers"], hideSleeping: true, exceptMain: false }, "on");
  const ui = parseUi(w.shared["projects.ui.v1"]);
  assert.deepEqual(brief(tree({ hideSleeping: ui.hideSleeping, exceptMain: ui.exceptMain }).rows), ["P app", "P api"], "what the tree draws from the stored value");
  await send(w, "toggle-sleeping");
  assert.deepEqual(w.shared["projects.ui.v1"], { collapsed: ["/code/app"], tasks: ["servers"], exceptMain: false }, "off again: no key, as parseUi reads it");
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]).filter((l) => /no command|failed/.test(l)), []);

  const fresh = await keeperWith({});
  await send(fresh, "toggle-sleeping");
  assert.deepEqual(fresh.shared["projects.ui.v1"], { collapsed: [], hideSleeping: true }, "nothing stored yet: the default ui, hiding");
});
