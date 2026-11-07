// T2: what the settings dialog stores (D5) and what the plugin's folder must
// be: a dialog that docks nowhere, with no `requires` and no keys, so
// installing it never reinstalls projects-sidebar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, GROUPS_KEY, parseConfig, withEnabled, withName, groupsOf, isLinked } from "../arc-spaces/mods/arc-spaces/model.js";

const plugin = (path) => new URL(`../arc-spaces/${path}`, import.meta.url);

test("the keys are the ones the wrapper reads", () => {
  const wrapper = readFileSync(plugin("mods/arc-spaces/bin/open"), "utf8");
  assert.ok(wrapper.includes(`$s["${KEY}"]`));
  assert.ok(wrapper.includes(`$s["${GROUPS_KEY}"]`));
});

test("nothing stored, or a value of the wrong shape: off, no names", () => {
  for (const value of [undefined, null, "x", 7, [], { enabled: "yes", names: "no" }]) {
    assert.deepEqual(parseConfig(value), { enabled: false, names: {} });
  }
});

test("a stored config reads back as itself", () => {
  const config = { enabled: true, names: { g1: "Action", g2: "Personal" } };
  assert.deepEqual(parseConfig(config), config);
});

test("only string names survive", () => {
  assert.deepEqual(parseConfig({ enabled: true, names: { g1: "Action", g2: 7, g3: null } }), { enabled: true, names: { g1: "Action" } });
});

test("switching off keeps the names", () => {
  const on = { enabled: true, names: { g1: "Action" } };
  assert.deepEqual(withEnabled(on, false), { enabled: false, names: { g1: "Action" } });
  assert.deepEqual(withEnabled(withEnabled(on, false), true), on);
});

test("a name is stored trimmed", () => {
  assert.deepEqual(withName({ enabled: true, names: {} }, "g1", "  Action "), { enabled: true, names: { g1: "Action" } });
});

test("a blank name removes the group's entry", () => {
  assert.deepEqual(withName({ enabled: true, names: { g1: "Action", g2: "Personal" } }, "g1", "   "), { enabled: true, names: { g2: "Personal" } });
});

test("the same name returns the same config, so nothing is written", () => {
  const config = { enabled: true, names: { g1: "Action" } };
  assert.equal(withName(config, "g1", " Action "), config);
  assert.equal(withName(config, "g2", "  "), config);
  assert.equal(withEnabled(config, true), config);
});

test("changing a config never changes the one it came from", () => {
  const config = { enabled: true, names: { g1: "Action" } };
  withName(config, "g1", "Other");
  withEnabled(config, false);
  assert.deepEqual(config, { enabled: true, names: { g1: "Action" } });
});

test("groups come from projects-sidebar's registry, in order", () => {
  const registry = { groups: [{ id: "g1", name: "Action Experience", projects: [] }, { id: "g2", name: "Arrecife", projects: [] }] };
  assert.deepEqual(groupsOf(registry), [{ id: "g1", name: "Action Experience" }, { id: "g2", name: "Arrecife" }]);
});

test("no registry, or a bad one: no groups", () => {
  for (const value of [undefined, null, "x", {}, { groups: "no" }, { groups: [null, 7, { name: "no id" }] }]) {
    assert.deepEqual(groupsOf(value), []);
  }
});

test("the link counts only when it points at this home's installed wrapper", () => {
  assert.equal(isLinked("/h/mods/arc-spaces/bin/open\n", "/h"), true);
  assert.equal(isLinked("/other/mods/arc-spaces/bin/open\n", "/h"), false);
  assert.equal(isLinked("", "/h"), false);
});

// A plain `herdr-app check` draws the dialog with the switch off, which has no
// fields. Herdr refuses InputState.new during render, and only this one sees it.
const herdr = spawnSync("herdr-app", ["--version"]).status === 0;
test("the dialog draws with the switch on", { skip: herdr ? false : "herdr-app isn't installed" }, () => {
  const home = mkdtempSync("/tmp/arc-check-");
  try {
    writeFileSync(join(home, "shared.json"), JSON.stringify({
      [KEY]: { enabled: true, names: { g1: "Action" } },
      [GROUPS_KEY]: { groups: [{ id: "g1", name: "Work", projects: [] }, { id: "g2", name: "Personal", projects: [] }], activeGroup: "g1" },
    }));
    const result = spawnSync("herdr-app", ["check", fileURLToPath(plugin("mods/arc-spaces"))], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, HERDR_APP_HOME: home },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the plugin is a dialog that docks nowhere, with no requires and no keys", () => {
  const mod = JSON.parse(readFileSync(plugin("mods/arc-spaces/mod.json"), "utf8"));
  assert.equal(mod.place, "none");
  assert.equal(mod.overlay.kind, "dialog");
  assert.equal(existsSync(plugin("requires")), false);
  assert.equal(existsSync(plugin("keys.json")), false);
  assert.equal(existsSync(plugin("layouts")), false);
});
