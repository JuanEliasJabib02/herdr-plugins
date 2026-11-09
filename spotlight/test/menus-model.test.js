// T23: Spotlight's items in projects-sidebar's workspace menu (D30, Orca's
// WorktreeSpotlightMenuItems and WorktreeSpotlightEnvSubMenu), built by
// M/menus-model.js from state.json, settings.json and the shared
// projects.v1 / projects.cache.v1 values, and published under
// menus.spotlight only when the value changes. Every item has to pass
// projects-sidebar's contract (its RECIPE.md "Menu items from other
// plugins"), checked here with the parser projects-sidebar draws from
// (its menus-model.js parseMenus), so an item it would drop fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMenus } from "../mods/spotlight/menus-model.js";
import { parseProjects, parseCache, nextPublish } from "../mods/spotlight/badges-model.js";
import { cliPathOf, readState, readSettings } from "../mods/spotlight/board-model.js";
import { parseMenus } from "../../projects-sidebar/mods/projects/menus-model.js";

const MOD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mods", "spotlight");
const APP = "/Users/u/.config/herdr-app";
const BIN = cliPathOf(APP);

const BACK = "/Users/u/code/back";
const FRONT = "/Users/u/code/front";
const OTHER = "/Users/u/code/other"; // registered, Spotlight off
const WS = "/Users/u/orca/workspaces";
const B1 = `${WS}/back/ax-3447`; // the holder of back
const B2 = `${WS}/back/ax-3500`;
const BN = `${WS}/back/none`; // a workspace with no task
const F1 = `${WS}/front/ax-3447`;
const O1 = `${WS}/other/ax-3447`;

const registry = {
  version: 1,
  groups: [
    { id: "ax", name: "AX", projects: [{ path: BACK, name: "back" }, { path: FRONT, name: "front" }, { path: OTHER, name: "other" }] },
  ],
};
const projects = parseProjects(registry);
const cache = parseCache({
  [BACK]: [
    { path: BACK, branch: "main", main: true },
    { path: B1, branch: "juan/AX-3447", main: false },
    { path: B2, branch: "juan/AX-3500", main: false },
    { path: BN, branch: "none", main: false },
  ],
  [FRONT]: [
    { path: FRONT, branch: "main", main: true },
    { path: F1, branch: "juan/AX-3447", main: false },
  ],
  [OTHER]: [
    { path: OTHER, branch: "main", main: true },
    { path: O1, branch: "juan/AX-3447", main: false },
  ],
});
const ENABLED = { [BACK]: true, [FRONT]: true, [OTHER]: false };

function repo(fields) {
  return {
    holder: null, lastSnapshotSha: "a".repeat(40), lastSyncAt: null, lastError: null, serverTerminal: null, serverPid: null,
    serverStartedAt: null, serverCommand: null, serverEnv: null, serverVariant: null, serverState: "stopped",
    pendingInstalls: [], ports: [], logPath: null, ...fields,
  };
}

// back is lit by AX-3447's B1, which runs the env stored for its task (dev).
function baseState({ back = {}, repos = {}, envs = {} } = {}) {
  return readState(JSON.stringify({
    version: 1,
    repos: {
      [BACK]: repo({ holder: B1, envKey: "ax/AX-3447", serverEnv: "dev", serverState: "listening", ports: [3000], ...back }),
      ...repos,
    },
    queue: { requests: [], lighting: {} },
    notes: [],
    envs: { "ax/AX-3447": "dev", ...envs },
  }));
}

const settingsOf = (raw = { version: 1 }) => readSettings(JSON.stringify(raw));

function build({ state = baseState(), settings = settingsOf(), enabled = ENABLED } = {}) {
  return buildMenus({ state, settings, projects, cache, enabled, registry, bin: BIN });
}

const ids = (list) => (list ?? []).map((it) => it.id);
const itemOf = (list, id) => (list ?? []).find((it) => it.id === id);
const checkedOf = (list) => (itemOf(list, "env")?.items ?? []).filter((it) => it.checked).map((it) => it.text);
// D41: the menu's toggle carries --note, as the badges' (a refusal toasts, exit 0).
const toggleExec = (at) => ({ exec: [BIN, "toggle", "--workspace", at, "--note"] });
const BUSY = { op: "sync", since: 5, pid: 4242 };
const codePoints = (s) => [...s].length;

test("an eligible unlit workspace: Proyectar este workspace, then Entorno de Spotlight ▸ Local / Dev / Prod with D32's value checked", () => {
  const value = build();
  assert.deepEqual(ids(value[B2]), ["toggle", "env"]);
  const toggle = itemOf(value[B2], "toggle");
  assert.equal(toggle.text, "Proyectar este workspace");
  assert.equal(toggle.icon, "mods/spotlight/icons/flashlight.svg");
  assert.deepEqual(toggle.action, toggleExec(B2));
  assert.equal(toggle.disabled, undefined);
  assert.equal(toggle.danger, undefined);

  const env = itemOf(value[B2], "env");
  assert.equal(env.text, "Entorno de Spotlight");
  assert.equal(env.icon, "mods/spotlight/icons/server.svg");
  assert.equal(env.action, undefined, "a submenu parent opens its submenu");
  assert.deepEqual(env.items.map((it) => [it.id, it.text]), [["env-local", "Local"], ["env-dev", "Dev"], ["env-prod", "Prod"]]);
  for (const e of ["local", "dev", "prod"]) {
    assert.deepEqual(itemOf(env.items, `env-${e}`).action, { exec: [BIN, "env", "--workspace", B2, "--env", e] });
  }
  // Nothing stored for AX-3500: the repo's settings env, local by default.
  assert.deepEqual(checkedOf(value[B2]), ["Local"]);

  // Its task's pick in its space, `ax/AX-3500`.
  assert.deepEqual(checkedOf(build({ state: baseState({ envs: { "ax/AX-3500": "prod" } }) })[B2]), ["Prod"]);
  // The same task in another space is another key.
  assert.deepEqual(checkedOf(build({ state: baseState({ envs: { "zz/AX-3500": "prod" } }) })[B2]), ["Local"]);
  // The repo's settings env when nothing is stored.
  const devFront = settingsOf({ version: 1, repos: { [FRONT]: { enabled: true, env: "prod" } } });
  const front = build({ state: baseState({ envs: { "ax/AX-3447": null } }), settings: devFront });
  assert.deepEqual(checkedOf(front[F1]), ["Prod"]);
  // One pick sets the env of the whole task: front's AX-3447 workspace reads the task's (dev).
  assert.deepEqual(checkedOf(build()[F1]), ["Dev"]);

  // A task-less workspace's key is ws:<path>; another workspace's pick isn't its own.
  assert.deepEqual(checkedOf(build({ state: baseState({ envs: { [`ws:${BN}`]: "prod" } }) })[BN]), ["Prod"]);
  assert.deepEqual(checkedOf(build({ state: baseState({ envs: { "ax/AX-3500": "prod" } }) })[BN]), ["Local"]);
  assert.deepEqual(ids(value[BN]), ["toggle", "env"]);
});

test("the holder: Apagar Spotlight, and the env its server runs checked (D32)", () => {
  const value = build();
  assert.deepEqual(ids(value[B1]), ["toggle", "env"]);
  const toggle = itemOf(value[B1], "toggle");
  assert.equal(toggle.text, "Apagar Spotlight");
  assert.deepEqual(toggle.action, toggleExec(B1));
  assert.equal(toggle.danger, undefined, "Orca's turn-off item isn't destructive");
  assert.deepEqual(checkedOf(value[B1]), ["Dev"], "envs[record.envKey]");

  // A record lit before T22 (no envKey): its envOverride, until it turns off.
  const old = baseState({ back: { envKey: undefined, envOverride: "prod" } });
  assert.deepEqual(checkedOf(build({ state: old })[B1]), ["Prod"]);
  // Nothing stored for its key: the repo's settings env.
  const settings = settingsOf({ version: 1, repos: { [BACK]: { enabled: true, env: "dev" } } });
  assert.deepEqual(checkedOf(build({ state: baseState({ envs: { "ax/AX-3447": null } }), settings })[B1]), ["Dev"]);
});

test("the holder on a root-diverged root: Forzar sync too, danger, the popup's sync --force --detach; never elsewhere, nor for another error", () => {
  const diverged = { code: "root-diverged", message: "the root has changes", at: 9 };
  const value = build({ state: baseState({ back: { lastError: diverged } }) });
  assert.deepEqual(ids(value[B1]), ["toggle", "force-sync", "env"]);
  const force = itemOf(value[B1], "force-sync");
  assert.equal(force.text, "Forzar sync");
  assert.equal(force.danger, true);
  assert.equal(force.icon, "mods/spotlight/icons/flashlight.svg");
  assert.deepEqual(force.action, { exec: [BIN, "sync", "--repo", BACK, "--force", "--detach"] });
  assert.equal(typeof force.tooltip, "string");
  assert.equal(itemOf(value[B2], "force-sync"), undefined, "held here only");
  assert.equal(itemOf(value[BACK], "force-sync"), undefined, "the root holds nothing");

  // A server error under the root error still is a diverged root.
  const under = { ...diverged, serverError: { code: "port-busy", port: 3000, message: "busy", at: 8 } };
  assert.ok(itemOf(build({ state: baseState({ back: { lastError: under } }) })[B1], "force-sync"));
  // Orca offers it on root-diverged only.
  for (const code of ["untracked-collision", "port-busy", "orca-holds"]) {
    const other = build({ state: baseState({ back: { lastError: { code, message: code, at: 9 } } }) });
    assert.equal(itemOf(other[B1], "force-sync"), undefined, code);
  }
});

test("the root while lit: Apagar Spotlight alone; unlit: nothing; refs nobody holds (orphan-refs): Apagar Spotlight", () => {
  const value = build();
  assert.deepEqual(ids(value[BACK]), ["toggle"]);
  assert.equal(itemOf(value[BACK], "toggle").text, "Apagar Spotlight");
  assert.deepEqual(itemOf(value[BACK], "toggle").action, toggleExec(BACK));
  assert.equal(value[FRONT], undefined, "front isn't lit");

  const orphan = baseState({ repos: { [FRONT]: repo({ lastError: { code: "orphan-refs", message: "refs", at: 3 } }) } });
  assert.deepEqual(ids(build({ state: orphan })[FRONT]), ["toggle"]);
  assert.equal(itemOf(build({ state: orphan })[FRONT], "toggle").text, "Apagar Spotlight");
  // A refused fresh activation (an error, no holder, no refs) lights nothing on the root.
  const refused = baseState({ repos: { [FRONT]: repo({ lastError: { code: "root-diverged", message: "x", at: 3 } }) } });
  assert.equal(build({ state: refused })[FRONT], undefined);
});

test("a busy repo: its toggles and Forzar sync disabled with Sincronizando…; the env submenu stays, as in Orca", () => {
  const diverged = { code: "root-diverged", message: "the root has changes", at: 9 };
  const value = build({ state: baseState({ back: { lastError: diverged, busy: { ...BUSY, workspace: B1 } } }) });
  for (const [at, id] of [[B1, "toggle"], [B1, "force-sync"], [B2, "toggle"], [BN, "toggle"], [BACK, "toggle"]]) {
    const it = itemOf(value[at], id);
    assert.equal(it.disabled, true, `${at} ${id}`);
    assert.equal(it.why, "Sincronizando…", `${at} ${id}`);
  }
  for (const at of [B1, B2]) {
    const env = itemOf(value[at], "env");
    assert.equal(env.disabled, undefined);
    assert.ok(env.items.every((it) => it.disabled === undefined));
  }
  assert.equal(itemOf(value[F1], "toggle").disabled, undefined, "front isn't busy");

  // A fresh light: a record holding only the mark, no holder yet.
  const fresh = baseState({ repos: { [FRONT]: repo({ lastSnapshotSha: null, busy: { ...BUSY, op: "light", workspace: F1 } }) } });
  const lighting = build({ state: fresh });
  assert.equal(itemOf(lighting[F1], "toggle").text, "Proyectar este workspace");
  assert.equal(itemOf(lighting[F1], "toggle").disabled, true);
  assert.equal(lighting[FRONT], undefined, "the root isn't lit yet");
});

test("a repo with Spotlight off: nothing; lit anyway, only its root's Apagar Spotlight (Orca's turn-off on main)", () => {
  const value = build();
  assert.equal(value[O1], undefined);
  assert.equal(value[OTHER], undefined);
  // Not in the enabled map at all reads as off.
  assert.equal(build({ enabled: { [BACK]: true } })[F1], undefined);

  const litOff = baseState({ repos: { [OTHER]: repo({ holder: O1, envKey: "ax/AX-3447", serverState: "listening" }) } });
  const off = build({ state: litOff });
  assert.equal(off[O1], undefined, "not eligible: Spotlight off there");
  assert.deepEqual(ids(off[OTHER]), ["toggle"]);
  assert.equal(itemOf(off[OTHER], "toggle").text, "Apagar Spotlight");
});

test("every item passes projects-sidebar's contract: its parser keeps each one as published, texts within 40 code points", () => {
  const diverged = { code: "root-diverged", message: "the root has changes", at: 9 };
  const states = [
    baseState(),
    baseState({ back: { lastError: diverged } }),
    baseState({ back: { lastError: diverged, busy: { ...BUSY, workspace: B1 } } }),
    baseState({ repos: { [FRONT]: repo({ lastError: { code: "orphan-refs", message: "refs", at: 3 } }) } }),
  ];
  for (const state of states) {
    const value = build({ state });
    const parsed = parseMenus([value], ["menus.spotlight"]);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(value).sort(), "no path dropped");
    for (const [at, list] of Object.entries(value)) {
      assert.ok(at.startsWith("/") && !at.endsWith("/"), `absolute, no trailing slash: ${at}`);
      assert.ok(list.length >= 1 && list.length <= 8, `1..8 items on ${at}`);
      const kept = parsed[at];
      assert.deepEqual(ids(kept), ids(list), `every item kept on ${at}`);
      const each = (published, read) => {
        assert.equal(read.label, published.text, `${at} ${published.id} text`);
        assert.ok(codePoints(published.text) <= 40 && !/\s{2}|\n/.test(published.text), `text "${published.text}"`);
        for (const flag of ["danger", "disabled", "checked"]) assert.equal(read[flag], published[flag], `${at} ${published.id} ${flag}`);
        assert.equal(read.why, published.why, `${at} ${published.id} why`);
        assert.equal(read.tooltip, published.tooltip, `${at} ${published.id} tooltip`);
        assert.equal(read.icon, published.icon, `${at} ${published.id} icon`);
        if (published.icon) assert.ok(fs.existsSync(path.join(MOD_DIR, "icons", path.basename(published.icon))), `${published.icon} exists`);
        assert.deepEqual(read.action, published.action, `${at} ${published.id} action kept`);
        if (published.action) {
          const { command, exec } = published.action;
          if (command !== undefined) assert.match(command, /^spotlight\./);
          else assert.ok(exec[0].startsWith("/") && exec[0] === BIN, "argv0: the absolute CLI");
        }
      };
      list.forEach((published, i) => {
        each(published, kept[i]);
        if (published.items) {
          assert.ok(published.items.length <= 6, "a submenu holds 6 at most");
          assert.deepEqual(ids(kept[i].items), ids(published.items), `${at} submenu kept`);
          published.items.forEach((sub, j) => each(sub, kept[i].items[j]));
        }
      });
    }
  }
});

test("nothing to offer: null, so menus.spotlight is cleared; an unchanged value writes nothing", () => {
  const none = buildMenus({ state: readState(null), settings: settingsOf(), projects, cache, enabled: {}, registry, bin: BIN });
  assert.equal(none, null);
  assert.deepEqual(nextPublish({ [B2]: [] }, none), { write: true, value: null });
  const value = build();
  assert.equal(nextPublish(JSON.parse(JSON.stringify(value)), build()).write, false);
});
