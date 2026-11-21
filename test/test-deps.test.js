// This repo's suites and who reads whom (split-tests D4's map, S2), through
// scripts/test.mjs's findSuites and select on the real folders. Pure
// selection, no git and nothing run: milliseconds.
//
// The plugin folders are written here as D4 matches them ("projects-sidebar/"),
// so --changed runs this file whenever a plugin changes: a change that breaks
// the map shows up on the branch that made it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ROOT, select, findSuites } from "../scripts/test.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const real = findSuites(repo);
// Each with its slash, as D4 matches it.
const PLUGINS = ["agent-sleep/", "claude-accounts/", "code-editor/", "dia-profiles/", "keep-awake/", "projects-sidebar/", "spotlight/"];
// A change to a file of that folder ("keep-awake/").
const changedIn = (folder) => select([`${folder}mods/changed.js`], real);
const filesOf = (plan, name) => plan.find((e) => e.name === name)?.files ?? [];
// The other suites' files that run because they read the change: { suite: files }.
const readersOf = (plan) => Object.fromEntries(plan.filter((e) => e.why !== "changed").map((e) => [e.name, e.files]));
const includes = (plan, name, files) => {
  for (const f of files) assert.ok(filesOf(plan, name).includes(f), `${name} runs ${f}; it runs ${JSON.stringify(filesOf(plan, name))}`);
};

test("findSuites: root and every plugin with a test folder, root first, each with its test files and helpers", () => {
  const names = real.map((s) => s.name);
  assert.equal(names[0], ROOT);
  for (const folder of PLUGINS) assert.ok(names.includes(folder.slice(0, -1)), folder);
  assert.deepEqual(names.slice(1), [...names.slice(1)].sort());
  assert.ok(!names.includes("scripts") && !names.includes("odd") && !names.includes("test"));
  const root = real[0];
  assert.equal(root.dir, "");
  assert.ok(root.files.some((f) => f.path === "test/test-runner.test.js"));
  assert.ok(root.files.every((f) => /^test\/[^/]+\.test\.js$/.test(f.path) && typeof f.text === "string"));
  const sleep = real.find((s) => s.name === "agent-sleep");
  assert.ok(sleep.helpers.some((h) => h.path === "test/harness.js"));
  assert.ok(sleep.helpers.every((h) => !h.path.endsWith(".test.js")));
});

test("a change in any plugin runs this file, and not test-runner's", () => {
  for (const plugin of PLUGINS) {
    const root = filesOf(changedIn(plugin), ROOT);
    assert.ok(root.includes("test/test-deps.test.js"), `${plugin}: root runs ${JSON.stringify(root)}`);
    assert.ok(!root.includes("test/test-runner.test.js"), `${plugin}: root runs ${JSON.stringify(root)}`);
  }
});

test("S2, projects-sidebar changed: spotlight's badges and menus, dia-profiles' open, code-editor's layout tests, the root keys test and the installer's run", () => {
  const plan = changedIn("projects-sidebar/");
  assert.equal(plan.find((e) => e.name === "projects-sidebar").why, "changed");
  includes(plan, "spotlight", ["test/badges-model.test.js", "test/menus-model.test.js"]);
  includes(plan, "dia-profiles", ["test/dia-profiles-open.test.js"]);
  includes(plan, "code-editor", ["test/code-editor-install.test.js", "test/code-tabs-model.test.js"]);
  // install.test.js installs the real plugin: run(INSTALL, home, "--no-keys", "projects-sidebar").
  includes(plan, ROOT, ["test/keys-merge.test.js", "test/install.test.js"]);
  assert.ok(!filesOf(plan, "spotlight").includes("test/queue.test.js"), "a spotlight file that doesn't read it stays out");
});

test("S2, claude-accounts changed: agent-sleep runs whole (its harness reads the accounts), spotlight's CLI and resume tests run", () => {
  const plan = changedIn("claude-accounts/");
  const sleep = plan.find((e) => e.name === "agent-sleep");
  assert.match(sleep.why, /^test\/harness\.js reads .*claude-accounts\//);
  assert.equal(sleep.files.length, real.find((s) => s.name === "agent-sleep").files.length);
  // resume.test.js builds the plugin's folders as join(app, "claude-accounts", …).
  includes(plan, "spotlight", ["test/cli.test.js", "test/resume.test.js"]);
});

test("S2, agent-sleep changed: projects-sidebar's tests that read its keys run, and claude-accounts' restart test that reads its sleeping.json", () => {
  const plan = changedIn("agent-sleep/");
  includes(plan, "projects-sidebar", ["test/agents-sleeping-model.test.js", "test/agents-workspace-model.test.js", "test/new-workspace-model.test.js"]);
  // join(box, "agent-sleep", "sleeping.json")
  includes(plan, "claude-accounts", ["test/claude-accounts-restart.test.js"]);
});

test("S2, code-editor, dia-profiles or keep-awake changed: what reads them is the layout and the installer, nothing else", () => {
  const expected = {
    "code-editor/": { [ROOT]: ["test/test-deps.test.js"] },
    "dia-profiles/": { [ROOT]: ["test/test-deps.test.js"] },
    // The installer brings keep-awake through projects-sidebar's requires; the
    // smoke test checks the layout's keep-awake block.
    "keep-awake/": { [ROOT]: ["test/install.test.js", "test/test-deps.test.js"], "projects-sidebar": ["test/smoke.test.js"] },
  };
  for (const [folder, readers] of Object.entries(expected)) assert.deepEqual(readersOf(changedIn(folder)), readers, folder);
});

test("S2, scripts changed: the root suite and the install tests of code-editor and dia-profiles run", () => {
  const plan = changedIn("scripts/");
  assert.equal(plan.find((e) => e.name === ROOT).why, "changed");
  includes(plan, "code-editor", ["test/code-editor-install.test.js"]);
  includes(plan, "dia-profiles", ["test/dia-profiles-install.test.js"]);
});

test("S1, keep-awake changed: its suite runs, and none of the suites it doesn't touch", () => {
  const names = changedIn("keep-awake/").map((e) => e.name);
  assert.equal(names.includes("keep-awake"), true);
  for (const other of ["agent-sleep", "claude-accounts", "dia-profiles", "spotlight"]) assert.equal(names.includes(other), false, other);
});
