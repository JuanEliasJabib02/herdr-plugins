// T9: the settings dialog's pure model (settings-form.js): lanes and repos
// from projects.v1, the form built from settings.json, and a save that
// clamps, refuses a command of more than one line, and says when the queue
// changed so the dialog execs `spotlight reap`. T40 (D47): the switch saved
// on change (a lit repo turned off first, Apagar igual when refused), each
// field saved on its own through the CAS, and Orca's help texts.
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
  isLit,
  turnOffArgv,
  forceTurnOffArgv,
  TURN_OFF_TIMEOUT_MS,
  turnOffOutcome,
  offersForce,
  afterTurnOff,
  spotlightSwitch,
  flipSpotlight,
  saveChange,
  fieldText,
  casWrite,
  HELP,
  variantHelp,
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

test("the turn-off names the root, whoever holds it; lit while state.json has its record", () => {
  // The holder changed since the dialog loaded: the argv still names the root.
  for (const state of [LIT("/w/ax-back-wt/AX-1"), LIT("/w/ax-back-wt/AX-2")]) {
    assert.deepEqual(flipSpotlight("/w/ax-back", true, state).turnOff.argv, ["toggle", "--workspace", "/w/ax-back", "--inline"]);
  }
  assert.deepEqual(turnOffArgv("/w/ax-back/"), ["toggle", "--workspace", "/w/ax-back", "--inline"]);
  assert.equal(TURN_OFF_TIMEOUT_MS, 120000);
  assert.equal(isLit(LIT("/w/ax-back-wt/AX-2"), "/w/ax-back/"), true);
  assert.equal(isLit({ repos: {} }, "/w/ax-back"), false);
  // state.json unreadable: can't tell, so the CLI is asked (root-is-holder if nothing is lit).
  assert.equal(isLit(null, "/w/ax-back"), true);
});

test("the turn-off's answer: exit 0 or root-is-holder went off", () => {
  assert.deepEqual(turnOffOutcome({ code: 0, stdout: "Spotlight off in ax-back: root restored.\n", stderr: "" }), { ok: true, message: "" });
  // Nothing lit any more (the record went between the read and the turn-off).
  assert.deepEqual(
    turnOffOutcome({ code: 2, stdout: "", stderr: "root-is-holder: the repository root cannot hold the Spotlight: it is the sync target.\n" }),
    { ok: true, message: "" },
  );
});

test("a turn-off that fails: the message is stderr's first line", () => {
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
});

// ── T40 (D47): the switch saved on change, fields on blur or Enter, Orca's help ──

const FACTS_ON = { harness: false, registered: true, gitRepo: true, hasServerCommand: true };

test("Usar Spotlight shows the effective value: an unset repo shows its default", () => {
  assert.deepEqual(spotlightSwitch({ enabled: null }, FACTS_ON), { on: true, disabled: false, note: "Por defecto: encendido" });
  assert.deepEqual(spotlightSwitch({ enabled: null }, { ...FACTS_ON, hasServerCommand: false }), {
    on: false,
    disabled: false,
    note: "Por defecto: apagado (sin comando de server)",
  });
  // A stored value is what it shows, whatever the default would be.
  assert.deepEqual(spotlightSwitch({ enabled: false }, FACTS_ON), { on: false, disabled: false, note: "" });
  assert.deepEqual(spotlightSwitch({ enabled: true }, null), { on: true, disabled: false, note: "" });
  // While the default is looked up, it can't be flipped (it doesn't know what it shows).
  assert.deepEqual(spotlightSwitch({ enabled: null }, null), { on: false, disabled: true, note: "Por defecto: …" });
  // ~/.claude: always off, never flipped.
  assert.deepEqual(spotlightSwitch({ enabled: true }, { ...FACTS_ON, harness: true }), {
    on: false,
    disabled: true,
    note: "Siempre apagado (~/.claude es el harness en vivo)",
  });
});

test("flipping the switch on an unlit repo writes enabled at once", () => {
  const unset = defaultSettings();
  // Unset and shown on (its default): the flip writes `enabled: false` at once.
  const off = flipSpotlight("/w/ax-back/", true, { repos: { "/w/ax-admin": { holder: "/w/ax-admin-wt/AX-1" } } });
  assert.equal(off.turnOff, null);
  assert.deepEqual(off.change, { root: "/w/ax-back", field: "enabled", value: false });
  assert.equal(saveChange(unset, off.change).settings.repos["/w/ax-back"].enabled, false);
  // Shown off: on at once, even on a lit repo (only off turns off first).
  const on = flipSpotlight("/w/ax-back", false, LIT("/w/ax-back-wt/AX-1"));
  assert.equal(on.turnOff, null);
  const out = saveChange(stored({ version: 1, future: 1, repos: { "/w/ax-back": { enabled: false, port: 3000 } } }), on.change);
  assert.equal(out.settings.repos["/w/ax-back"].enabled, true);
  assert.equal(out.settings.repos["/w/ax-back"].port, 3000);
  assert.equal(out.settings.future, 1);
  assert.equal(out.needsReap, false);
  // Nothing to flip while what it shows isn't known.
  assert.equal(flipSpotlight("/w/ax-back", null, { repos: {} }), null);
});

test("flipping it off on a lit repo runs the turn-off first; OK writes enabled: false", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true, port: 3000 } } });
  const flip = flipSpotlight("/w/ax-back", true, LIT("/w/ax-back-wt/AX-1"));
  assert.deepEqual(flip.turnOff, { root: "/w/ax-back", argv: ["toggle", "--workspace", "/w/ax-back", "--inline"] });
  // The change waits for the turn-off.
  assert.deepEqual(flip.change, { root: "/w/ax-back", field: "enabled", value: false });
  // state.json unreadable: the turn-off asks the CLI first.
  assert.notEqual(flipSpotlight("/w/ax-back", true, null).turnOff, null);
  for (const result of [
    { code: 0, stdout: "Spotlight off in ax-back: root restored.\n", stderr: "" },
    { code: 2, stdout: "", stderr: "root-is-holder: the repository root cannot hold the Spotlight: it is the sync target.\n" },
  ]) {
    const after = afterTurnOff(result);
    assert.deepEqual(after, { ok: true, message: "", writeOff: true, offerForce: false });
  }
  const out = saveChange(settings, flip.change);
  assert.equal(out.settings.repos["/w/ax-back"].enabled, false);
  assert.equal(out.settings.repos["/w/ax-back"].port, 3000);
});

test("a refused turn-off leaves the switch on and offers Apagar igual, which forces and leaves it on", () => {
  const diverged = { code: 1, stdout: "", stderr: "root-diverged: El root cambió desde que se proyectó.\n" };
  assert.deepEqual(afterTurnOff(diverged), {
    ok: false,
    message: "root-diverged: El root cambió desde que se proyectó.",
    writeOff: false,
    offerForce: true,
  });
  assert.equal(afterTurnOff({ code: 1, stdout: "", stderr: "untracked-collision: x\n" }).offerForce, true);
  // A refusal no force fixes (Orca still holds the root, the server survived): no Apagar igual.
  assert.equal(afterTurnOff({ code: 1, stdout: "", stderr: "orca-holds: Orca tiene el root\n" }).offerForce, false);
  assert.equal(afterTurnOff({ error: new Error("timed out") }).offerForce, false);
  assert.equal(offersForce("root-diverged: x"), true);
  assert.equal(offersForce("server-survived: root-diverged: x"), false);
  // Apagar igual: the forced turn-off of the root.
  assert.deepEqual(forceTurnOffArgv("/w/ax-back/"), ["toggle", "--workspace", "/w/ax-back", "--inline", "--force"]);
  // Whatever it answers, the switch isn't written: it stays on, as Orca's.
  assert.deepEqual(afterTurnOff({ code: 0, stdout: "", stderr: "" }, { forced: true }), {
    ok: true,
    message: "",
    writeOff: false,
    offerForce: false,
  });
  assert.deepEqual(afterTurnOff(diverged, { forced: true }), {
    ok: false,
    message: "root-diverged: El root cambió desde que se proyectó.",
    writeOff: false,
    offerForce: false,
  });
});

test("a command saves on its own, trimmed; an unchanged one writes nothing", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true, envs: { dev: "pnpm dev" }, extra: 7 } } });
  const change = { root: "/w/ax-back", field: "envs.local", value: "  pnpm dev:mine  " };
  const out = saveChange(settings, change);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.settings.repos["/w/ax-back"], {
    enabled: true,
    envs: { local: "pnpm dev:mine", dev: "pnpm dev", prod: null },
    env: "local",
    port: null,
    extra: 7,
  });
  assert.equal(out.needsReap, false);
  // What the field shows once saved: the command as stored.
  assert.equal(fieldText(out.settings, change), "pnpm dev:mine");
  // The same value again (Enter, then blur): nothing to write.
  assert.deepEqual(saveChange(out.settings, change), { settings: null, errors: [], needsReap: false });
  assert.deepEqual(saveChange(settings, { root: "/w/ax-back", field: "envs.dev", value: "pnpm dev " }).settings, null);
  // Emptied: back to the detected script.
  const cleared = saveChange(settings, { root: "/w/ax-back", field: "envs.dev", value: "" });
  assert.equal(cleared.settings.repos["/w/ax-back"].envs.dev, null);
  // An unset repo left empty writes no record.
  assert.equal(saveChange(defaultSettings(), { root: "/w/ax-admin", field: "envs.prod", value: " " }).settings, null);
  // Two lines are refused, nothing written.
  assert.deepEqual(saveChange(settings, { root: "/w/ax-back", field: "envs.prod", value: "pnpm i\npnpm dev" }), {
    settings: null,
    errors: [{ field: "/w/ax-back:envs.prod", message: "El comando debe ser una sola línea." }],
    needsReap: false,
  });
});

test("the port saves on its own; a bad one is refused, an unchanged one writes nothing", () => {
  const settings = stored({ version: 1, repos: { "/w/ax-back": { enabled: true, port: 3000 } } });
  const out = saveChange(settings, { root: "/w/ax-back", field: "port", value: " 4000 " });
  assert.equal(out.settings.repos["/w/ax-back"].port, 4000);
  assert.equal(out.settings.repos["/w/ax-back"].enabled, true);
  assert.equal(fieldText(out.settings, { root: "/w/ax-back", field: "port" }), "4000");
  assert.equal(saveChange(settings, { root: "/w/ax-back", field: "port", value: "3000" }).settings, null);
  assert.equal(saveChange(settings, { root: "/w/ax-back", field: "port", value: "" }).settings.repos["/w/ax-back"].port, null);
  assert.deepEqual(saveChange(settings, { root: "/w/ax-back", field: "port", value: "70000" }).errors, [
    { field: "/w/ax-back:port", message: "El puerto va de 1 a 65535." },
  ]);
  // The env chip saves on its own too.
  const env = saveChange(settings, { root: "/w/ax-back", field: "env", value: "dev" });
  assert.equal(env.settings.repos["/w/ax-back"].env, "dev");
  assert.equal(saveChange(env.settings, { root: "/w/ax-back", field: "env", value: "dev" }).settings, null);
});

test("queue values save one by one, as before; a queue change asks for the reap", () => {
  const settings = stored({ version: 1, queue: { cap: 2, later: true } });
  const cap = saveChange(settings, { queue: "cap", value: "9" });
  assert.equal(cap.settings.queue.cap, 4);
  assert.equal(cap.settings.queue.later, true);
  assert.equal(cap.needsReap, true);
  assert.equal(fieldText(cap.settings, { queue: "cap" }), "4");
  // Text that isn't a number keeps the stored value: nothing to write, the field shows it again.
  assert.deepEqual(saveChange(settings, { queue: "cap", value: "tres" }), { settings: null, errors: [], needsReap: false });
  assert.equal(fieldText(settings, { queue: "cap" }), "2");
  const lane = saveChange(settings, { queue: "perSpace", lane: "g-ax", value: "2" });
  assert.equal(perSpaceLimit(lane.settings, "g-ax"), 2);
  assert.equal(lane.needsReap, true);
  assert.equal(fieldText(lane.settings, { queue: "perSpace", lane: "g-ax" }), "2");
  // A lane at the default isn't written.
  assert.equal(saveChange(settings, { queue: "perSpace", lane: "g-me", value: "1" }).settings, null);
  const off = saveChange(settings, { queue: "enabled", value: false });
  assert.equal(off.settings.queue.enabled, false);
  assert.equal(off.needsReap, true);
  assert.equal(saveChange(settings, { queue: "autoResume", value: true }).settings.queue.autoResume, true);
  assert.equal(saveChange(settings, { queue: "autoResume", value: false }).settings, null);
});

test("each save goes through the CAS: a stale snapshot reads the file again and applies the change to it", async () => {
  // Another writer stored ax-admin's switch after the dialog read the file.
  let file = serializeSettings(stored({ version: 1, repos: { "/w/ax-admin": { enabled: true } } }));
  const first = { text: serializeSettings(defaultSettings()), settings: defaultSettings() };
  const writes = [];
  const io = {
    read: async () => file,
    write: async (text, expected) => {
      if (expected !== file) throw new Error("stale snapshot");
      writes.push(text);
      file = text;
    },
  };
  const port = (value) => (s) => saveChange(s, { root: "/w/ax-back", field: "port", value });
  const r = await casWrite(io, first, port("3000"));
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.equal(writes.length, 1);
  assert.equal(r.text, file);
  const now = parseSettings(file).settings;
  assert.equal(now.repos["/w/ax-back"].port, 3000);
  assert.equal(now.repos["/w/ax-admin"].enabled, true);
  assert.deepEqual(r.settings, now);
  // The same value again: nothing written, the snapshot kept.
  const same = await casWrite(io, { text: r.text, settings: r.settings }, port("3000"));
  assert.deepEqual([same.ok, same.wrote, writes.length], [true, false, 1]);
  // A refused value writes nothing.
  const bad = await casWrite(io, { text: r.text, settings: r.settings }, port("0"));
  assert.deepEqual([bad.ok, bad.wrote, bad.errors.map((e) => e.field), writes.length], [false, false, ["/w/ax-back:port"], 1]);
  // No file yet: created (expected null).
  let created = null;
  const fresh = await casWrite(
    { read: async () => null, write: async (text, expected) => { assert.equal(expected, null); created = text; } },
    { text: null, settings: defaultSettings() },
    port("3001"),
  );
  assert.equal(fresh.wrote, true);
  assert.equal(parseSettings(created).settings.repos["/w/ax-back"].port, 3001);
  // Stale every time: it gives up after three tries.
  let tries = 0;
  const busy = await casWrite(
    { read: async () => file, write: async () => { tries++; throw new Error("stale snapshot"); } },
    { text: r.text, settings: r.settings },
    port("3002"),
  );
  assert.deepEqual([busy.ok, busy.wrote, tries], [false, false, 3]);
});

test("the help texts are Orca's, in Spanish; the variant help only when the repo has variants", () => {
  assert.deepEqual(HELP, {
    section: "Prueba los cambios de un workspace en el root del proyecto sin duplicar dependencias instaladas ni builds.",
    logs: "Con Spotlight encendido, la salida de la terminal del server queda en un log que los agentes de cualquier workspace leen con `spotlight logs`.",
    switchLabel: "Usar Spotlight",
    switch: "Muestra un botón de Spotlight en los workspaces de este proyecto que refleja sus cambios en el root del proyecto.",
    serverTitle: "Server",
    server: "Spotlight corre este comando en la terminal de Spotlight al prenderse y le agrega --port N. Un campo vacío usa el script detectado en package.json. Local usa Dev si no tiene.",
    portLabel: "Puerto",
    port: "Se agrega al comando como --port N. Vacío deja el puerto del comando.",
    portPlaceholder: "Por defecto del comando",
    forceOff: "Apagar igual",
  });
  assert.equal(
    variantHelp({ detected: {}, scriptCommands: [], variants: ["co", "do"] }),
    "Este proyecto corre uno de CO, DO a la vez. Escribe {variant} en un comando para correr el de cada tarea: Spotlight lo elige por las apps que cambió la rama de la tarea, o pregunta.",
  );
  assert.equal(variantHelp({ detected: {}, scriptCommands: [] }), null);
  assert.equal(variantHelp({ variants: [] }), null);
  assert.equal(variantHelp(null), null);
});
