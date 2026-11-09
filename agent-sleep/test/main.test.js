// The moon's copy as Herdr starts one (A/main.js), with herdr, gpui-kit and
// gpui-base faked: every herdr function main.js imports forwards to the fake
// world of harness.js (deps), and gpui's are inert, since nothing here draws.
//
// workspace-sleep step 4's F1: after a cold start the window may not be there
// yet when the status row's copies start. A copy that read window() once, at
// init, never started its loop or its listener, and a command queued for it
// ran when a reload finally started one, against whatever was shown then. So
// the loop and the listener always start, and each pulse looks for a window:
// none (`herdr-app check`, a start before the window is up) → the pulse does
// nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { PULSE_MS } from "../mods/agent-sleep/coordinator.js";
import {
  HOME, APP, SETTINGS, WORKSPACES, makeWorld, deps, spacesWorld, addShell, settledTabs, entries,
} from "./harness.js";

// Stand-ins exporting exactly the names the mod's files import, read from
// their sources (projects-sidebar's test/inicio-model.test.js does the same).
const MOD_DIR = new URL("../mods/agent-sleep/", import.meta.url);
const MOD_FILES = [
  ...readdirSync(MOD_DIR).filter((f) => f.endsWith(".js")),
  ...readdirSync(new URL("views/", MOD_DIR)).filter((f) => f.endsWith(".js")).map((f) => `views/${f}`),
];
function importedFrom(spec) {
  const names = new Set();
  for (const f of MOD_FILES) {
    const src = readFileSync(new URL(f, MOD_DIR), "utf8");
    for (const m of src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${spec}"`, "g"))) {
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
  herdr: importedFrom("herdr").map((n) => `export const ${n} = (...a) => globalThis.__agentSleepHerdr(${JSON.stringify(n)}, a);`).join("\n"),
  "gpui-kit": gpui("gpui-kit"),
  "gpui-base": gpui("gpui-base"),
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});
let fake = {};
globalThis.__agentSleepHerdr = (name, args) => {
  if (!Object.hasOwn(fake, name)) throw new Error(`herdr.${name} isn't faked`);
  return fake[name](...args);
};
const { default: AgentSleep } = await import("../mods/agent-sleep/main.js");

// Herdr's functions over harness.js's world: what herdrDeps() hands the
// Coordinator, plus the window, the copy's props and its key commands.
function herdrOf(w) {
  const d = deps(w);
  w.listens = 0;
  w.waiting = [];
  w.overlays = [];
  return {
    props: () => null, // the status row's cell: the moon
    window: () => w.window,
    hc: d.hc,
    exec: d.exec,
    run: d.herdrRun,
    home: () => HOME,
    appHome: () => APP,
    readTextFile: d.files.read,
    writeTextFile: d.files.write,
    settings: () => ({}),
    openOverlay: (spec) => {
      w.overlays.push(spec);
      return `o${w.overlays.length}`;
    },
    closeOverlay: () => null,
    terminals: d.live.terminals,
    spaces: d.live.spaces,
    panes: d.live.panes,
    focused: d.live.focused,
    notify: d.notify,
    shared: d.shared,
    setShared: d.setShared,
    theme: () => ({}),
    nextCommand: () => {
      w.listens += 1;
      return new Promise((resolve) => w.waiting.push(resolve));
    },
  };
}

// The moon's copy: init with a cx whose timers are kept, so a test fires
// them, and whose tasks are kept, so a test waits for a pulse to end.
function moonCopy(w) {
  const timers = [];
  const tasks = [];
  const cx = {
    spawn: (fn) => {
      const p = Promise.resolve().then(() => fn(cx));
      tasks.push(p);
      return p;
    },
    timer: {
      every: (ms, fn) => timers.push({ ms, fn }),
      after: (ms, fn) => timers.push({ ms, fn, once: true }),
    },
    sleep: () => Promise.resolve(),
    notify() {},
  };
  const copy = new AgentSleep();
  copy.init(null, cx);
  // One beat of every timer, and the pulses it started, to their end. The
  // listener's task never ends, so only the tasks started here are awaited.
  const beat = async () => {
    const from = tasks.length;
    for (const t of timers) t.fn(cx);
    await Promise.all(tasks.slice(from));
  };
  return { copy, timers, beat };
}

// A key command, to the copy waiting on nextCommand().
const send = async (w, name) => {
  const resolve = w.waiting.shift();
  assert.ok(resolve, `nobody waits for ${name}`);
  resolve(name);
  for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
};

// /code/app's one space, shown, with a bare shell: a sleep with nothing in
// flight. Automatic sleep is off, so a pulse does only what it is asked.
function world() {
  const w = makeWorld();
  w.files[SETTINGS] = JSON.stringify({ enabled: false, idleMinutes: 30 });
  spacesWorld(w, [{ id: "sa", tabs: { a1: [["pa1", "t3", "/code/app"]] } }], "sa");
  addShell(w, "t3", { pid: 103 });
  w.window = { active: true, platform: "macos" };
  fake = herdrOf(w);
  return w;
}

const untouched = (w) => ({ calls: w.calls, execs: w.execs, writes: w.writes, runs: w.runs, notes: w.notes, overlays: w.overlays });
const NOTHING = { calls: [], execs: [], writes: [], runs: [], notes: [], overlays: [] };

test("F1: a moon copy started before its window starts its loop and its listener anyway; with no window its pulses change nothing", async () => {
  const w = world();
  w.window = null;
  const { timers, beat } = moonCopy(w);
  assert.deepEqual(timers.map((t) => t.ms), [PULSE_MS], "the pulse timer, startLoop's only");
  await new Promise(setImmediate);
  assert.equal(w.listens, 1, "the listener waits on nextCommand()");
  for (let i = 0; i < 3; i += 1) await beat();
  assert.deepEqual(untouched(w), NOTHING, "no read, no exec, no hc, no write, no tab settled");
  assert.equal(Object.hasOwn(w.files, WORKSPACES), false);
});

test("F1: once the window is there, the same copy pulses and runs a command, with no reload", async () => {
  const w = world();
  w.window = null;
  const { beat } = moonCopy(w);
  await beat();
  assert.deepEqual(untouched(w), NOTHING);
  w.window = { active: true, platform: "macos" };
  await beat();
  assert.ok(w.calls.length + w.execs.length > 0, "the first pulse read Core");
  await new Promise(setImmediate);
  await send(w, "sleep-workspace");
  await beat();
  assert.deepEqual(settledTabs(w), ["a1"], "the shown workspace's tabs are put away");
  assert.equal(entries(w)["/code/app"]?.state, "sleeping");
});

test("a moon copy whose window is there at init pulses on its first beat and runs a command, as before", async () => {
  const w = world();
  const { timers, beat } = moonCopy(w);
  assert.deepEqual(timers.map((t) => t.ms), [PULSE_MS]);
  await beat();
  assert.ok(w.calls.length + w.execs.length > 0, "the first pulse read Core");
  await new Promise(setImmediate);
  await send(w, "sleep-workspace");
  await beat();
  assert.deepEqual(settledTabs(w), ["a1"]);
  assert.equal(entries(w)["/code/app"]?.state, "sleeping");
});

test("a copy that is no moon (the popup, an overlay) starts no timer and no listener, window or not", async () => {
  for (const window of [null, { active: true, platform: "macos" }]) {
    const w = world();
    w.window = window;
    fake.props = () => ({ view: "panel", overlay: "o9" });
    const { timers } = moonCopy(w);
    await new Promise(setImmediate);
    assert.deepEqual(timers, [], JSON.stringify(window));
    assert.equal(w.listens, 0, JSON.stringify(window));
  }
});
