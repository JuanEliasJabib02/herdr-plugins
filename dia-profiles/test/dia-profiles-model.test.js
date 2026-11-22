// What the settings dialog stores and what the plugin's folder must
// be: a dialog that docks nowhere, with no `requires` and no keys, so
// installing it never reinstalls projects-sidebar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, ARC_KEY, GROUPS_KEY, parseConfig, storedConfig, withEnabled, withName, groupsOf, isLinked } from "../mods/dia-profiles/model.js";

const plugin = (path) => new URL(`../${path}`, import.meta.url);

test("the keys are the ones the wrapper reads", () => {
  const wrapper = readFileSync(plugin("mods/dia-profiles/bin/open"), "utf8");
  assert.ok(wrapper.includes(`$s["${KEY}"] // $s["${ARC_KEY}"]`));
  assert.ok(wrapper.includes(`.["${KEY}"] // .["${ARC_KEY}"]`));
  assert.ok(wrapper.includes(`$s["${GROUPS_KEY}"]`));
});

test("the stored config is this plugin's, else the one arc-spaces left", () => {
  const ours = { enabled: false, names: { g1: "Work" } };
  const arc = { enabled: true, names: { g1: "Action" } };
  const reader = (stored) => (key) => stored[key];
  assert.deepEqual(storedConfig(reader({ [KEY]: ours, [ARC_KEY]: arc })), ours);
  assert.deepEqual(storedConfig(reader({ [ARC_KEY]: arc })), arc);
  assert.deepEqual(storedConfig(reader({})), { enabled: false, names: {} });
});

test("nothing stored, or a value of the wrong shape: off, no names", () => {
  for (const value of [undefined, null, "x", 7, [], { enabled: "yes", names: "no" }]) {
    assert.deepEqual(parseConfig(value), { enabled: false, names: {} });
  }
});

test("a stored config reads back as itself", () => {
  const config = { enabled: true, names: { g1: "Nimbus", g2: "Personal" } };
  assert.deepEqual(parseConfig(config), config);
});

test("only string names survive", () => {
  assert.deepEqual(parseConfig({ enabled: true, names: { g1: "Nimbus", g2: 7, g3: null } }), { enabled: true, names: { g1: "Nimbus" } });
});

test("switching off keeps the names", () => {
  const on = { enabled: true, names: { g1: "Nimbus" } };
  assert.deepEqual(withEnabled(on, false), { enabled: false, names: { g1: "Nimbus" } });
  assert.deepEqual(withEnabled(withEnabled(on, false), true), on);
});

test("a name is stored trimmed", () => {
  assert.deepEqual(withName({ enabled: true, names: {} }, "g1", "  Nimbus "), { enabled: true, names: { g1: "Nimbus" } });
});

test("a blank name removes the group's entry", () => {
  assert.deepEqual(withName({ enabled: true, names: { g1: "Nimbus", g2: "Personal" } }, "g1", "   "), { enabled: true, names: { g2: "Personal" } });
});

test("the same name returns the same config, so nothing is written", () => {
  const config = { enabled: true, names: { g1: "Nimbus" } };
  assert.equal(withName(config, "g1", " Nimbus "), config);
  assert.equal(withName(config, "g2", "  "), config);
  assert.equal(withEnabled(config, true), config);
});

test("changing a config never changes the one it came from", () => {
  const config = { enabled: true, names: { g1: "Nimbus" } };
  withName(config, "g1", "Other");
  withEnabled(config, false);
  assert.deepEqual(config, { enabled: true, names: { g1: "Nimbus" } });
});

test("groups come from projects-sidebar's registry, in order", () => {
  const registry = { groups: [{ id: "g1", name: "Nimbus", projects: [] }, { id: "g2", name: "Reef", projects: [] }] };
  assert.deepEqual(groupsOf(registry), [{ id: "g1", name: "Nimbus" }, { id: "g2", name: "Reef" }]);
});

test("no registry, or a bad one: no groups", () => {
  for (const value of [undefined, null, "x", {}, { groups: "no" }, { groups: [null, 7, { name: "no id" }] }]) {
    assert.deepEqual(groupsOf(value), []);
  }
});

test("the link counts only when it points at this home's installed wrapper", () => {
  assert.equal(isLinked("/h/mods/dia-profiles/bin/open\n", "/h"), true);
  assert.equal(isLinked("/other/mods/dia-profiles/bin/open\n", "/h"), false);
  assert.equal(isLinked("", "/h"), false);
});

// A plain `herdr-app check` draws the dialog with the switch off, which has no
// fields. Herdr refuses InputState.new during render, and only this one sees it.
const herdr = spawnSync("herdr-app", ["--version"]).status === 0;
test("the dialog draws with the switch on", { skip: herdr ? false : "herdr-app isn't installed" }, () => {
  const home = mkdtempSync("/tmp/dia-check-");
  try {
    writeFileSync(join(home, "shared.json"), JSON.stringify({
      [KEY]: { enabled: true, names: { g1: "Nimbus" } },
      [GROUPS_KEY]: { groups: [{ id: "g1", name: "Work", projects: [] }, { id: "g2", name: "Personal", projects: [] }], activeGroup: "g1" },
    }));
    const result = spawnSync("herdr-app", ["check", fileURLToPath(plugin("mods/dia-profiles"))], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, HERDR_APP_HOME: home },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the plugin is a dialog that docks nowhere, with no requires and no keys", () => {
  const mod = JSON.parse(readFileSync(plugin("mods/dia-profiles/mod.json"), "utf8"));
  assert.equal(mod.place, "none");
  assert.equal(mod.overlay.kind, "dialog");
  assert.equal(existsSync(plugin("requires")), false);
  assert.equal(existsSync(plugin("keys.json")), false);
  assert.equal(existsSync(plugin("layouts")), false);
});
