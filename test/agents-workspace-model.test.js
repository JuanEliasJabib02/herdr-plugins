// The Agents list's rows name their project and open their workspace's menu
// (projects-agents/workspace-model.js). A mod can't import another mod's
// files, so the panel keeps its own copy of projects-sidebar's rule; these
// tests hold it to the real one (projects/lib.js matchSpaces) on the same
// worlds, and check the menu it opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY_KEY, CACHE_KEY, AGENT_MENU, workspacesBySpace, workspaceMenuSpec } from "../projects-sidebar/mods/projects-agents/workspace-model.js";
import { sleepCommand } from "../projects-sidebar/mods/projects/tree-model.js";
import { sleepWorkspaceCommand, parseWorkspaceCommand } from "../agent-sleep/mods/agent-sleep/workspace-sleep.js";
import { matchSpaces, KEYS } from "../projects-sidebar/mods/projects/lib.js";
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
});

test("each space gets the workspace and project projects-sidebar's matchSpaces gives it", () => {
  const mine = where();
  const theirs = matchSpaces(CACHE, SPACES, PANES, HOME);
  assert.deepEqual(Object.fromEntries([...mine].map(([id, w]) => [id, { project: w.project, path: w.path }])), theirs);
});

test("the project's name is the sidebar's, else its folder's; the main checkout says so", () => {
  const w = where();
  assert.deepEqual(w.get("s1"), { project: "/code/budget-app", path: "/code/budget-app", main: true, name: "budget-app" });
  assert.deepEqual(w.get("s2"), { project: `${HOME}/code/herdr-plugins`, path: "/ws/herdr-plugins/wahoo", main: false, name: "herdr-plugins" });
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
