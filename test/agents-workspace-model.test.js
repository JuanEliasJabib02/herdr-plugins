// The Agents list's rows name their project and open their workspace's menu
// (projects-agents/workspace-model.js). A mod can't import another mod's
// files, so the panel keeps its own copy of projects-sidebar's rule; these
// tests hold it to the real one (projects/lib.js matchSpaces) on the same
// worlds, and check the menu it opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY_KEY, CACHE_KEY, NOTES_KEY, AGENT_MENU, workspacesBySpace, workspaceMenuSpec, noteKeyOfCheckout, parseNotes, noteOf } from "../projects-sidebar/mods/projects-agents/workspace-model.js";
import { sleepCommand } from "../projects-sidebar/mods/projects/tree-model.js";
import { sleepWorkspaceCommand, parseWorkspaceCommand } from "../agent-sleep/mods/agent-sleep/workspace-sleep.js";
import { matchSpaces, KEYS, noteKeyOf, parseNotes as sidebarParseNotes, noteOf as sidebarNoteOf, NOTES_MAX } from "../projects-sidebar/mods/projects/lib.js";
import { taskKeyOf } from "../projects-sidebar/mods/projects/task-model.js";
import { MOD } from "../projects-sidebar/mods/projects/config.js";

const HOME = "/Users/demo";
const REGISTRY = {
  version: 1,
  groups: [
    { id: "g1", name: "Reef", projects: [{ path: "/code/budget-app", name: "budget-app" }, { path: "~/code/herdr-plugins", name: "herdr-plugins" }] },
    { id: "g2", name: "AX", projects: [{ path: "/repos/backend-nimbus-app", name: "backend-nimbus" }] },
  ],
  activeGroup: "g1",
};
const CACHE = {
  "/code/budget-app": [{ path: "/code/budget-app", branch: "main", main: true }],
  "~/code/herdr-plugins": [
    { path: "~/code/herdr-plugins", branch: "main", main: true },
    { path: "/ws/herdr-plugins/wahoo", branch: "agent-sleep", main: false },
  ],
  "/repos/backend-nimbus-app": [
    { path: "/repos/backend-nimbus-app", branch: "develop", main: true },
    { path: "/ws/backend-nimbus/AX-3704", branch: "AX-3704", main: false },
  ],
  "/repos/no-name": [{ path: "/repos/no-name", branch: "main", main: true }],
};
const space = (id, name, tabs, extra = {}) => ({ id, name, tabs: tabs.map((t) => ({ id: t })), ...extra });
const SPACES = [
  space("s1", "main", ["t1"]),
  space("s2", "agent-sleep", ["t2"]),
  space("s3", "AX-3704", ["t3"]),
  space("s4", "nested", ["t4"]),
  space("s5", "folder-only", ["t5"], { folder: "/code/budget-app" }),
  space("s6", "remote", ["t6"], { machine: "vps" }),
  space("s7", "nowhere", ["t7"]),
  space("s8", "unnamed project", ["t8"]),
  space("s9", "Inicio", ["t9"]),
];
const PANES = [
  { pane: "p1", tab: "t1", terminal: "a1", cwd: "/code/budget-app" },
  { pane: "p2", tab: "t2", terminal: "a2", cwd: "/ws/herdr-plugins/wahoo/agent-sleep" },
  { pane: "p3", tab: "t3", terminal: "a3", cwd: "/ws/backend-nimbus/AX-3704" },
  { pane: "p4", tab: "t4", terminal: "a4", cwd: "~/code/herdr-plugins/sub/dir" },
  { pane: "p6", tab: "t6", terminal: "a6", cwd: "/code/budget-app" },
  { pane: "p7", tab: "t7", terminal: "a7", cwd: "/tmp/elsewhere" },
  { pane: "p8", tab: "t8", terminal: "a8", cwd: "/repos/no-name" },
  { pane: "p9", tab: "t9", terminal: null, mod: "projects" },
];
const where = () => workspacesBySpace({ registry: REGISTRY, cache: CACHE, spaces: SPACES, panes: PANES, home: HOME });

test("the shared keys are projects-sidebar's", () => {
  assert.equal(REGISTRY_KEY, KEYS.registry);
  assert.equal(CACHE_KEY, KEYS.cache);
  assert.equal(NOTES_KEY, KEYS.notes);
});

test("each space gets the workspace and project projects-sidebar's matchSpaces gives it", () => {
  const mine = where();
  const theirs = matchSpaces(CACHE, SPACES, PANES, HOME);
  assert.deepEqual(Object.fromEntries([...mine].map(([id, w]) => [id, { project: w.project, path: w.path }])), theirs);
});

test("the project's name is the sidebar's, else its folder's; the main checkout says so", () => {
  const w = where();
  assert.deepEqual(w.get("s1"), { project: "/code/budget-app", path: "/code/budget-app", main: true, name: "budget-app", task: null });
  assert.deepEqual(w.get("s2"), { project: `${HOME}/code/herdr-plugins`, path: "/ws/herdr-plugins/wahoo", main: false, name: "herdr-plugins", task: "agent-sleep" });
  assert.equal(w.get("s3").name, "backend-nimbus", "the sidebar's name, not the repo folder's");
  assert.equal(w.get("s8").name, "no-name", "a project the registry doesn't name");
  for (const id of ["s6", "s7", "s9"]) assert.equal(w.has(id), false, `${id}: remote, outside every project, or no terminal and no folder`);
});

test("nothing stored yet, or malformed, is no workspaces", () => {
  for (const [registry, cache] of [[undefined, undefined], [null, "x"], [REGISTRY, { "/code/budget-app": "x" }]]) {
    assert.equal(workspacesBySpace({ registry, cache, spaces: SPACES, panes: PANES, home: HOME }).size, 0);
  }
  assert.equal(workspacesBySpace({ registry: REGISTRY, cache: CACHE }).size, 0);
});

test("the menu opens through the projects mod's relay, at the pointer, with Sleep, Rename… and Delete… only", () => {
  assert.deepEqual(AGENT_MENU, ["sleep", "rename", "delete"]);
  const w = where().get("s3");
  assert.deepEqual(workspaceMenuSpec(w), {
    mod: MOD, kind: "popup", width: 1, height: 1, frame: "none",
    props: { view: "workspace-menu-at", project: "/repos/backend-nimbus-app", path: "/ws/backend-nimbus/AX-3704", only: ["sleep", "rename", "delete"] },
  });
  assert.equal(workspaceMenuSpec(null), null);
  // The main checkout sleeps too (Orca's Sleep is on every workspace), and
  // asks for Sleep alone: never Rename… or Delete…, whatever the menu's own
  // lookup of the checkout finds.
  const main = where().get("s1");
  assert.equal(main.main, true);
  assert.deepEqual(workspaceMenuSpec(main).props, { view: "workspace-menu-at", project: main.project, path: main.path, only: ["sleep"] });
});

test("the Sleep command projects-sidebar runs is the one agent-sleep reads (two copies, mods can't import each other)", () => {
  for (const path of ["/ws/backend-nimbus/AX-3704", "/Users/alex/orca/workspaces/herdr-plugins/sleep-agent", "/code/ñandú app", "/"]) {
    assert.equal(sleepCommand(path), `agent-sleep.${sleepWorkspaceCommand(path)}`, path);
    assert.deepEqual(parseWorkspaceCommand(sleepCommand(path).slice("agent-sleep.".length)), { kind: "sleep", path });
  }
});

// A row's tooltip starts with its task's note, the one the sidebar shows on
// the task's lane: the workspace's task key, as Task mode keys its lane
// (task-model.js taskKeyOf, lib.js noteKeyOf), looked up in projects.notes.v1.
const sidebarNoteKey = (c) => {
  const t = taskKeyOf(c);
  return noteKeyOf(t ? `task:${t.kind === "ticket" ? t.key : t.key.toLowerCase()}` : null);
};

test("a workspace's task is the key the sidebar files its note under", () => {
  const checkouts = [
    { path: "/ws/backend/AX-3797", branch: "AX-3797", main: false },
    { path: "/ws/backend/whatever", branch: "refs/heads/feat/ax-3697-cancel", main: false },
    { path: "/ws/backend/AX-3653", branch: null, main: false },
    { path: "/ws/backend/team_12", branch: "alex/team_12", main: false },
    { path: "/ws/herdr-plugins/feedback-agentbar", branch: "Feedback-AgentBar", main: false },
    { path: "/ws/herdr-plugins/x", branch: "feat/vue3", main: false },
    { path: "/ws/x/Constructor", branch: "Constructor", main: false },
    { path: "/ws/x/none", branch: "none", main: false },
    { path: "/ws/x/__proto__", branch: null, main: false },
    { path: "/code/budget-app", branch: "AX-1234", main: true },
    { path: "/", branch: null, main: false },
  ];
  for (const c of checkouts) assert.equal(noteKeyOfCheckout(c), sidebarNoteKey(c), JSON.stringify(c));
  assert.equal(noteKeyOfCheckout(checkouts[0]), "AX-3797");
  assert.equal(noteKeyOfCheckout(checkouts[4]), "feedback-agentbar");
  assert.equal(noteKeyOfCheckout(checkouts[9]), null, "a main checkout has no task");
  assert.equal(where().get("s3").task, "AX-3704");
});

test("the note read is the one the sidebar reads", () => {
  const many = Object.fromEntries(Array.from({ length: NOTES_MAX + 2 }, (_, i) => [`T-${i}`, `n${i}`]));
  const values = [
    undefined, null, "x", ["a"],
    { "AX-3797": "cncelaciones", "AX-3653": "  two\n  lines  ", "feedback-agentbar": "a".repeat(40), "AX-1": "", "AX-2": 7, constructor: "no", none: "no" },
    many,
  ];
  const keys = ["AX-3797", "AX-3653", "feedback-agentbar", "AX-1", "AX-2", "constructor", "none", "T-0", `T-${NOTES_MAX}`, null, undefined];
  for (const v of values) {
    for (const k of keys) assert.equal(noteOf(parseNotes(v), k), sidebarNoteOf(sidebarParseNotes(v), k), `${JSON.stringify(v)?.slice(0, 40)} ${k}`);
  }
  const notes = parseNotes(values[4]);
  assert.equal(noteOf(notes, "AX-3797"), "cncelaciones");
  assert.equal(noteOf(notes, "AX-3653"), "two lines");
  assert.equal(noteOf(notes, "AX-9999"), null);
});
