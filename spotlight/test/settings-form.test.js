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
  scriptSuggestions,
  commandPlaceholder,
  NO_START,
  planSave,
  isLit,
  turnOffArgv,
  TURN_OFF_TIMEOUT_MS,
  turnOffOutcome,
  withEnabledOff,
} from "../mods/spotlight/settings-form.js";
import { parseSettings, defaultSettings, perSpaceLimit, repoSettings } from "../mods/spotlight/settings.js";
import { detectServerScripts } from "../mods/spotlight/server-plan.js";

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

// ── T26 (D37): script suggestions, placeholders, and Apagado on a lit repo ──

// A repo folder for detectServerScripts: files by path, folders by path.
function fakeIo(files, dirs = {}) {
  return {
    async readText(p) {
      return p in files ? files[p] : null;
    },
    async kind(p) {
      if (p in files) return "file";
      return p in dirs ? "dir" : "none";
    },
    async listDirs(p) {
      return dirs[p] ?? null;
    },
  };
}

test("the ▾ suggestions are detection's scriptCommands", async () => {
  const pkg = { scripts: { dev: "next dev", "dev:web": "next dev -p 3001", start: "next start", prod: "x", build: "next build", lint: "eslint" } };
  const detection = await detectServerScripts("/w/app", fakeIo({
    "/w/app/package.json": JSON.stringify(pkg),
    "/w/app/pnpm-lock.yaml": "",
  }));
  assert.deepEqual(detection.scriptCommands, ["pnpm dev", "pnpm dev:web", "pnpm prod", "pnpm start"]);
  assert.deepEqual(scriptSuggestions(detection), detection.scriptCommands);
  // Nothing detected (no package.json, detection not run): no suggestions.
  assert.deepEqual(scriptSuggestions({ detected: {}, scriptCommands: [] }), []);
  assert.deepEqual(scriptSuggestions(null), []);
});

test("a field's placeholder is the command that would run with it empty", () => {
  const detection = { detected: { dev: "pnpm dev", prod: "pnpm prod" }, scriptCommands: [] };
  const none = repoSettings(defaultSettings(), "/w/app");
  // Detected, for the field's own env.
  assert.equal(commandPlaceholder(none, detection, "dev"), "pnpm dev");
  assert.equal(commandPlaceholder(none, detection, "prod"), "pnpm prod");
  // Local falls back to Dev.
  assert.equal(commandPlaceholder(none, detection, "local"), "pnpm dev");
  // The other envs' saved commands count: a saved Dev wins over the detected one,
  // for Dev's own placeholder it doesn't (its own saved value is what the field holds).
  const savedDev = { ...none, envs: { local: "pnpm local:mine", dev: "pnpm dev:mine", prod: null }, port: 4000 };
  assert.equal(commandPlaceholder(savedDev, detection, "local"), "pnpm dev:mine");
  assert.equal(commandPlaceholder(savedDev, detection, "dev"), "pnpm dev");
  // Detected Local comes before Dev's saved command; no `--port` appended.
  assert.equal(commandPlaceholder(savedDev, { detected: { local: "pnpm local" } }, "local"), "pnpm local");
  // Nothing anywhere: "No arranca"; Prod never falls back.
  assert.equal(NO_START, "No arranca");
  assert.equal(commandPlaceholder(none, { detected: {} }, "local"), "No arranca");
  assert.equal(commandPlaceholder(savedDev, { detected: {} }, "prod"), "No arranca");
  assert.equal(commandPlaceholder(none, null, "dev"), "No arranca");
  // `{variant}` stays unfilled, as Orca shows it.
  assert.equal(commandPlaceholder(none, { detected: { dev: "pnpm dev:{variant}" } }, "local"), "pnpm dev:{variant}");
});

const LIT = (holder) => ({ repos: { "/w/ax-back": { holder, serverState: "listening" } } });

test("a lit repo switched to Apagado: turn it off first, `enabled` unchanged in the first save", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true } } });
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].enabled = false;
  form.repos["/w/ax-back"].port = "3000";
  const plan = planSave(settings, form, LIT("/w/ax-back-wt/AX-1"));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.turnOff, [{ root: "/w/ax-back", argv: ["toggle", "--workspace", "/w/ax-back", "--inline"] }]);
  // Every other field is saved; the switch waits for the turn-off.
  assert.equal(plan.settings.repos["/w/ax-back"].enabled, true);
  assert.equal(plan.settings.repos["/w/ax-back"].port, 3000);
  // A repo with nothing stored (the default) keeps nothing stored.
  const unset = defaultSettings();
  const form2 = toForm(unset, { lanes: [], repos: reposOf(REG, unset, []) });
  form2.repos["/w/ax-back"].enabled = false;
  const plan2 = planSave(unset, form2, LIT("/w/ax-back-wt/AX-1"));
  assert.deepEqual(plan2.turnOff.map((t) => t.root), ["/w/ax-back"]);
  assert.equal("/w/ax-back" in plan2.settings.repos, false);
});

test("the holder changed since the dialog loaded: the turn-off still names the root", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true } } });
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].enabled = false;
  const atLoad = planSave(settings, form, LIT("/w/ax-back-wt/AX-1"));
  const atSave = planSave(settings, form, LIT("/w/ax-back-wt/AX-2"));
  for (const plan of [atLoad, atSave]) {
    assert.deepEqual(plan.turnOff[0].argv, ["toggle", "--workspace", "/w/ax-back", "--inline"]);
  }
  assert.deepEqual(turnOffArgv("/w/ax-back/"), ["toggle", "--workspace", "/w/ax-back", "--inline"]);
  assert.equal(TURN_OFF_TIMEOUT_MS, 120000);
  // The re-read after the first save: still lit only while state.json has its record.
  assert.equal(isLit(LIT("/w/ax-back-wt/AX-2"), "/w/ax-back/"), true);
  assert.equal(isLit({ repos: {} }, "/w/ax-back"), false);
  // state.json unreadable: can't tell, so the CLI is asked (root-is-holder if nothing is lit).
  assert.equal(isLit(null, "/w/ax-back"), true);
});

test("an unlit repo switched to Apagado just saves enabled: false", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true } } });
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].enabled = false;
  for (const state of [{ repos: {} }, { repos: { "/w/ax-admin": { holder: "/w/ax-admin-wt/AX-1" } } }]) {
    const plan = planSave(settings, form, state);
    assert.deepEqual(plan.turnOff, []);
    assert.equal(plan.settings.repos["/w/ax-back"].enabled, false);
  }
  // state.json unreadable: the turn-off asks the CLI first.
  assert.deepEqual(planSave(settings, form, null).turnOff.map((t) => t.root), ["/w/ax-back"]);
});

test("only a switch to Apagado turns off: a lit repo already Apagado, or switched on, doesn't", () => {
  const off = stored({ version: 1, repos: { "/w/ax-back": { enabled: false } } });
  const keep = toForm(off, { lanes: [], repos: reposOf(REG, off, []) });
  assert.deepEqual(planSave(off, keep, LIT("/w/ax-back-wt/AX-1")).turnOff, []);
  const on = defaultSettings();
  const form = toForm(on, { lanes: [], repos: reposOf(REG, on, []) });
  form.repos["/w/ax-back"].enabled = true;
  const plan = planSave(on, form, LIT("/w/ax-back-wt/AX-1"));
  assert.deepEqual(plan.turnOff, []);
  assert.equal(plan.settings.repos["/w/ax-back"].enabled, true);
});

test("a refused field refuses the whole save, turn-off included", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true } } });
  const form = toForm(settings, { lanes: [], repos: reposOf(REG, settings, []) });
  form.repos["/w/ax-back"].enabled = false;
  form.repos["/w/ax-back"].port = "70000";
  const plan = planSave(settings, form, LIT("/w/ax-back-wt/AX-1"));
  assert.equal(plan.settings, null);
  assert.deepEqual(plan.turnOff, []);
  assert.deepEqual(plan.errors.map((e) => e.field), ["/w/ax-back:port"]);
});

test("the turn-off's answer: exit 0 or root-is-holder saves enabled: false", () => {
  assert.deepEqual(turnOffOutcome({ code: 0, stdout: "Spotlight off in ax-back: root restored.\n", stderr: "" }), { ok: true, message: "" });
  // Nothing lit any more (the record went between the re-read and the turn-off).
  assert.deepEqual(
    turnOffOutcome({ code: 2, stdout: "", stderr: "root-is-holder: the repository root cannot hold the Spotlight: it is the sync target.\n" }),
    { ok: true, message: "" },
  );
  const first = stored({ version: 1, future: 1, repos: { "/w/ax-back": { enabled: true, port: 3000 }, "/w/ax-admin": { enabled: true } } });
  const next = withEnabledOff(first, ["/w/ax-back/"]);
  assert.equal(next.repos["/w/ax-back"].enabled, false);
  assert.equal(next.repos["/w/ax-back"].port, 3000);
  assert.equal(next.repos["/w/ax-admin"].enabled, true);
  assert.equal(next.future, 1);
  // A repo with no record gets one with just the switch.
  assert.equal(withEnabledOff(defaultSettings(), ["/w/new"]).repos["/w/new"].enabled, false);
  // The settings given are left alone.
  assert.equal(first.repos["/w/ax-back"].enabled, true);
});

test("a turn-off that fails: enabled stays on, the message is stderr's first line", () => {
  const out = turnOffOutcome({
    code: 1,
    stdout: "",
    stderr: "\nroot-diverged: El root cambió desde que se proyectó: abre el server para forzar.\nmás detalle\n",
  });
  assert.deepEqual(out, { ok: false, message: "root-diverged: El root cambió desde que se proyectó: abre el server para forzar." });
  // No stderr: stdout's first line, else the exit code; an exec that threw: its message.
  assert.equal(turnOffOutcome({ code: 1, stdout: "algo\n", stderr: "" }).message, "algo");
  assert.equal(turnOffOutcome({ code: 137, stdout: "", stderr: "" }).message, "salió con código 137");
  assert.deepEqual(turnOffOutcome({ error: new Error("timed out after 120000 ms\nstack") }), { ok: false, message: "timed out after 120000 ms" });
  // The failed repo's switch isn't written.
  const first = stored({ version: 1, repos: { "/w/ax-back": { enabled: true } } });
  assert.equal(withEnabledOff(first, []).repos["/w/ax-back"].enabled, true);
});
