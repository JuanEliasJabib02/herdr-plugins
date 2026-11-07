// T9: the settings dialog's pure model (settings-form.js): lanes and repos
// from projects.v1, the form built from settings.json, and a save that
// clamps, refuses a command of more than one line, and says when the queue
// changed so the dialog execs `spotlight reap`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lanesOf,
  reposOf,
  toForm,
  applyForm,
  enabledChoice,
  isHarnessRoot,
  serializeSettings,
} from "../mods/spotlight/settings-form.js";
import { parseSettings, defaultSettings, perSpaceLimit } from "../mods/spotlight/settings.js";

const REG = {
  groups: [
    { id: "g-ax", name: "Action Experience", projects: [{ path: "/w/ax-back", name: "ax-back" }, { path: "/w/ax-admin/" }] },
    { id: "g-me", name: "Arrecife", projects: [{ path: "/w/herdr-plugins", name: "herdr-plugins" }] },
  ],
};

const stored = (value) => parseSettings(JSON.stringify(value)).settings;

test("lanes: each projects.v1 group, then the spaceless lane", () => {
  assert.deepEqual(lanesOf(REG), [
    { id: "g-ax", name: "Action Experience" },
    { id: "g-me", name: "Arrecife" },
    { id: "spaceless", name: "Sin espacio" },
  ]);
  assert.deepEqual(lanesOf(null), [{ id: "spaceless", name: "Sin espacio" }]);
});

test("repos: the registered ones by group, then the ones only settings or state know", () => {
  const settings = stored({ version: 1, repos: { "/w/other": { enabled: true }, "/w/ax-back": {} } });
  const repos = reposOf(REG, settings, ["/w/from-state", "/w/other"]);
  assert.deepEqual(repos, [
    { root: "/w/ax-back", name: "ax-back", lane: "g-ax", registered: true },
    { root: "/w/ax-admin", name: "ax-admin", lane: "g-ax", registered: true },
    { root: "/w/herdr-plugins", name: "herdr-plugins", lane: "g-me", registered: true },
    { root: "/w/other", name: "other", lane: "spaceless", registered: false },
    { root: "/w/from-state", name: "from-state", lane: "spaceless", registered: false },
  ]);
});

test("the form shows stored values as text, and the per-space limit of every lane", () => {
  const settings = stored({
    version: 1,
    queue: { enabled: false, cap: 3, perSpace: { "g-ax": 2 }, autoResume: true },
    repos: { "/w/ax-back": { enabled: false, envs: { local: "pnpm dev", dev: null }, env: "dev", port: 3000 } },
  });
  const form = toForm(settings, { lanes: lanesOf(REG), repos: reposOf(REG, settings, []) });
  assert.deepEqual(form.queue, {
    enabled: false,
    cap: "3",
    autoResume: true,
    perSpace: { "g-ax": "2", "g-me": "1", spaceless: "1" },
  });
  assert.deepEqual(form.repos["/w/ax-back"], {
    enabled: false,
    envs: { local: "pnpm dev", dev: "", prod: "" },
    env: "dev",
    port: "3000",
  });
  assert.deepEqual(form.repos["/w/herdr-plugins"], {
    enabled: null,
    envs: { local: "", dev: "", prod: "" },
    env: "local",
    port: "",
  });
});

test("a value outside its range is clamped on save", () => {
  const settings = defaultSettings();
  const form = toForm(settings, { lanes: lanesOf(REG), repos: [] });
  form.queue.cap = "9";
  form.queue.perSpace["g-ax"] = "0";
  form.queue.perSpace["g-me"] = "2.6";
  const out = applyForm(settings, form);
  assert.deepEqual(out.errors, []);
  assert.equal(out.settings.queue.cap, 4);
  assert.equal(perSpaceLimit(out.settings, "g-ax"), 1);
  assert.equal(out.settings.queue.perSpace["g-me"], 3);
});

test("text that isn't a number keeps the stored value", () => {
  const settings = stored({ version: 1, queue: { cap: 3 } });
  const form = toForm(settings, { lanes: [], repos: [] });
  form.queue.cap = "tres";
  const out = applyForm(settings, form);
  assert.equal(out.settings.queue.cap, 3);
  assert.equal(out.needsReap, false);
});

test("a two-line command is refused: errors name the field and nothing is saved", () => {
  const settings = defaultSettings();
  const repos = reposOf(REG, settings, []);
  const form = toForm(settings, { lanes: [], repos });
  form.repos["/w/ax-back"].envs.dev = "pnpm i\npnpm dev";
  const out = applyForm(settings, form);
  assert.equal(out.settings, null);
  assert.deepEqual(out.errors, [
    { field: "/w/ax-back:envs.dev", message: "El comando debe ser una sola línea." },
  ]);
});

test("a port outside 1..65535 is refused", () => {
  const settings = defaultSettings();
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].port = "70000";
  form.repos["/w/ax-admin"].port = "abc";
  const out = applyForm(settings, form);
  assert.equal(out.settings, null);
  assert.deepEqual(out.errors.map((e) => e.field), ["/w/ax-back:port", "/w/ax-admin:port"]);
});

test("a raised cap returns needsReap: true; a repo-only change returns false", () => {
  const settings = defaultSettings();
  const lanes = lanesOf(REG);
  const repos = reposOf(REG, settings, []);
  const raised = toForm(settings, { lanes, repos });
  raised.queue.cap = "3";
  assert.equal(applyForm(settings, raised).needsReap, true);

  const repoOnly = toForm(settings, { lanes, repos });
  repoOnly.repos["/w/ax-back"].envs.local = "  pnpm dev  ";
  repoOnly.repos["/w/ax-back"].port = "3000";
  const out = applyForm(settings, repoOnly);
  assert.equal(out.needsReap, false);
  assert.deepEqual(out.settings.repos["/w/ax-back"], {
    enabled: null,
    envs: { local: "pnpm dev", dev: null, prod: null },
    env: "local",
    port: 3000,
  });
});

test("every queue field counts for needsReap: switch, auto-resume, a lane's limit", () => {
  const settings = defaultSettings();
  const lanes = lanesOf(REG);
  for (const change of [
    (f) => { f.queue.enabled = false; },
    (f) => { f.queue.autoResume = true; },
    (f) => { f.queue.perSpace["g-me"] = "2"; },
  ]) {
    const form = toForm(settings, { lanes, repos: [] });
    change(form);
    assert.equal(applyForm(settings, form).needsReap, true);
  }
  // Saving the form untouched changes nothing.
  assert.equal(applyForm(settings, toForm(settings, { lanes, repos: [] })).needsReap, false);
});

test("a save keeps unknown keys, lanes not shown and repos not shown", () => {
  const settings = stored({
    version: 1,
    future: { x: 1 },
    queue: { cap: 2, perSpace: { "g-gone": 3 }, later: true },
    repos: { "/w/elsewhere": { enabled: true, note: "keep" }, "/w/ax-back": { extra: 7 } },
  });
  const form = toForm(settings, { lanes: lanesOf(REG), repos: reposOf(REG, settings, []).filter((r) => r.root === "/w/ax-back") });
  form.repos["/w/ax-back"].enabled = true;
  const out = applyForm(settings, form);
  assert.deepEqual(out.settings.future, { x: 1 });
  assert.equal(out.settings.queue.later, true);
  assert.equal(out.settings.queue.perSpace["g-gone"], 3);
  assert.equal(out.settings.repos["/w/elsewhere"].note, "keep");
  assert.equal(out.settings.repos["/w/ax-back"].extra, 7);
  assert.equal(out.settings.repos["/w/ax-back"].enabled, true);
  // Lanes left at the default aren't written.
  assert.equal("g-me" in out.settings.queue.perSpace, false);
});

test("a repo with nothing set isn't written; one set back to the default is", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: false } } });
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].enabled = null;
  const out = applyForm(settings, form);
  assert.equal("/w/herdr-plugins" in out.settings.repos, false);
  assert.equal(out.settings.repos["/w/ax-back"].enabled, null);
});

test("serialized settings read back the same", () => {
  const settings = defaultSettings();
  const form = toForm(settings, { lanes: lanesOf(REG), repos: reposOf(REG, settings, []) });
  form.queue.cap = "3";
  form.repos["/w/ax-back"].envs.local = "pnpm dev";
  const out = applyForm(settings, form);
  const text = serializeSettings(out.settings);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseSettings(text), { settings: out.settings, valid: true });
});

test("the Spotlight switch shows the registration default when unset", () => {
  const on = { harness: false, registered: true, gitRepo: true, hasServerCommand: true };
  const noServer = { ...on, hasServerCommand: false };
  assert.deepEqual(enabledChoice({ enabled: null }, on), { value: null, effective: true, label: "Por defecto: encendido" });
  assert.deepEqual(enabledChoice({ enabled: null }, noServer), {
    value: null,
    effective: false,
    label: "Por defecto: apagado (sin comando de server)",
  });
  assert.deepEqual(enabledChoice({ enabled: null }, { ...on, registered: false }), {
    value: null,
    effective: false,
    label: "Por defecto: apagado (no está en un espacio)",
  });
  assert.deepEqual(enabledChoice({ enabled: null }, null), { value: null, effective: null, label: "Por defecto: …" });
  assert.deepEqual(enabledChoice({ enabled: false }, on), { value: false, effective: false, label: "Apagado" });
  assert.deepEqual(enabledChoice({ enabled: true }, noServer), { value: true, effective: true, label: "Encendido" });
  assert.deepEqual(enabledChoice({ enabled: true }, { ...on, harness: true }), {
    value: true,
    effective: false,
    label: "Siempre apagado (~/.claude es el harness en vivo)",
  });
});

test("~/.claude is the harness root, with or without a trailing slash", () => {
  assert.equal(isHarnessRoot("/Users/j/.claude", "/Users/j"), true);
  assert.equal(isHarnessRoot("/Users/j/.claude/", "/Users/j/"), true);
  assert.equal(isHarnessRoot("/Users/j/.claude-global", "/Users/j"), false);
});
