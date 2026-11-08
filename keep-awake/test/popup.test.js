// T2 (S1–S4, D4, D6–D9): the coffee cup in the status bar and its popup. The
// numbers (where the popup opens, how tall, what each row says) and the loop
// copy's tick are pure (popup-model.js) and tested alone; main.js and the views
// are loaded here with a fake "herdr", "gpui-kit" and "gpui-base"
// (module.registerHooks, as test/claude-accounts-footer.test.js does), so what
// a copy runs, draws, opens and shares is tested by driving it. Drawing for
// real is `herdr-app check`'s and the live check's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { MODE_KEY, MODES } from "../mods/keep-awake/model.js";
import { SPAWN_SCRIPT, caffeinateCommand } from "../mods/keep-awake/holder.js";
import {
  MOD, COFFEE, TICK_MS, VIEW_KEY, CLOSED_KEY, CLOSE_GUARD_MS, POPUP, CELL, WINDOW_LOOK_MS,
  isLoopCopy, startLoop, anchorFrom, overlayAt, zoomOf, cellBounds, popupHeight, popupSpec, closedJustNow,
  shown, cellModel, popupModel, choose, Loop,
} from "../mods/keep-awake/popup-model.js";

const mod = (f) => new URL(`../mods/keep-awake/${f}`, import.meta.url);
const src = (f) => readFileSync(mod(f), "utf8");

const LID = "Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.";
const term = (status) => ({ address: `t-${status}`, status, agent: "claude-code" });

// ── Where the popup opens (S4, D9) ─────────────────────────────────────────

// The cup's cell in a 1000 × 700 window: 64 px wide, right before
// agent-sleep's 40 px moon, in the 28 px status row (projects.json, T3).
const CELL_BOUNDS = { x: 896, y: 672, width: 64, height: 28 };

test("anchorFrom: the cell's left, its top, and its right edge as the limit", () => {
  assert.deepEqual(anchorFrom(CELL_BOUNDS), { x: 896, y: 672, limit: 960 });
  for (const bad of [null, undefined, {}, { x: 1, y: 2 }, { x: "1", y: 2, width: 3 }]) assert.equal(anchorFrom(bad), null, JSON.stringify(bad));
});

test("overlayAt: above the cell from the press bounds, its right edge 8 px inside the cell's, 8 px over the bar", () => {
  const size = { width: POPUP.width, height: popupHeight() };
  assert.deepEqual(overlayAt(anchorFrom(CELL_BOUNDS), size), { x: 960 - (264 + 8), y: 672 - (popupHeight() + 8) });
  assert.deepEqual(overlayAt(anchorFrom(CELL_BOUNDS), size, 1.5), { x: 960 - 272 * 1.5, y: 672 - (popupHeight() + 8) * 1.5 });
});

test("overlayAt: never past the window's left or top; no anchor, no place", () => {
  assert.deepEqual(overlayAt({ x: 10, y: 50, limit: 74 }, { width: 264, height: 171 }), { x: 8, y: 0 });
  assert.equal(overlayAt(null, { width: 264, height: 171 }), null);
  assert.deepEqual(overlayAt(anchorFrom(CELL_BOUNDS), { width: 264, height: 171 }, 0), { x: 688, y: 493 }, "a zoom that isn't one counts as 1");
});

test("cellBounds, the fallback with no press bounds: 64 px left of the moon's 40, the row's 28 px, times the zoom", () => {
  assert.deepEqual(CELL, { width: 64, height: 28, right: 40 });
  assert.deepEqual(cellBounds({ width: 1000, height: 700 }), CELL_BOUNDS);
  assert.deepEqual(cellBounds({ width: 1000, height: 700 }, 1.5), { x: 1000 - 60 - 96, y: 700 - 42, width: 96, height: 42 });
  assert.equal(cellBounds(null), null);
  assert.equal(cellBounds({ width: 1000 }), null);
});

test("zoomOf: the app's zoom, 1 when it says nothing", () => {
  assert.equal(zoomOf({ zoom: 1.25 }), 1.25);
  for (const bad of [null, undefined, {}, { zoom: 0 }, { zoom: -2 }, { zoom: "big" }]) assert.equal(zoomOf(bad), 1, JSON.stringify(bad));
});

// ── How tall it opens (S2, S3, D9) ─────────────────────────────────────────

test("popupHeight: frame, title row, separator and three mode rows, fixed (an open popup can't resize)", () => {
  assert.equal(MODES.length, 3);
  const expected = POPUP.frame + 2 * POPUP.padY + POPUP.header + POPUP.separator + 2 * POPUP.separatorGap + 3 * POPUP.row;
  assert.equal(popupHeight(), expected);
  assert.equal(popupHeight(), 183);
  assert.equal(POPUP.width, 264);
});

test("popupSpec: a popup of this mod, 264 wide, above the cell, its copy told it is the popup", () => {
  const anchor = anchorFrom(CELL_BOUNDS);
  assert.deepEqual(popupSpec({ anchor, zoom: 1 }), {
    mod: MOD,
    kind: "popup",
    width: 264,
    height: 183,
    at: overlayAt(anchor, { width: 264, height: 183 }, 1),
    props: { view: "popup" },
  });
  assert.equal(MOD, "keep-awake");
  assert.equal("at" in popupSpec({ anchor: null }), false, "no anchor: Herdr opens it at the pointer");
});

// ── The guard: the press that closed the popup doesn't reopen it (D9) ──────

test("closedJustNow: a click within 400 ms of the popup closing doesn't reopen it, by the press", () => {
  const NOW = 1_000_000;
  assert.equal(CLOSE_GUARD_MS, 400);
  assert.equal(closedJustNow(NOW, NOW + 399), true);
  assert.equal(closedJustNow(NOW, NOW + 400), false);
  assert.equal(closedJustNow(NOW + 2, NOW + 700, NOW), true, "closed just after the press, released 700 ms later");
  assert.equal(closedJustNow(NOW, NOW + 1_100, NOW + 1_000), false, "closed long before this press");
  assert.equal(closedJustNow(NOW + 5_000, NOW, NOW), false, "a time ahead of the clock doesn't block the cup");
  for (const never of [undefined, null, "x", {}]) assert.equal(closedJustNow(never, NOW), false, JSON.stringify(never));
  assert.equal(CLOSED_KEY, "keep-awake.popup-closed");
});

// ── What the cell and the popup say (S2, S3, S4, D8) ───────────────────────

test("shown: the last tick's Active while it was for the mode set now; right after a change On reads Active, the others Inactive (Orca)", () => {
  assert.deepEqual(shown("on", { mode: "on", active: false }), { mode: "on", active: false }, "a tick said it holds nothing");
  assert.deepEqual(shown("agent", { mode: "agent", active: true }), { mode: "agent", active: true });
  assert.deepEqual(shown("on", { mode: "off", active: false }), { mode: "on", active: true }, "just picked On");
  assert.deepEqual(shown("off", { mode: "on", active: true }), { mode: "off", active: false }, "just picked Off");
  assert.deepEqual(shown("agent", { mode: "on", active: true }), { mode: "agent", active: false });
  assert.deepEqual(shown(undefined, null), { mode: "off", active: false }, "nothing set: Off (D4)");
  assert.deepEqual(shown("auto", { mode: "off", active: true }), { mode: "off", active: true }, "an unknown mode is Off");
  assert.deepEqual(shown("on", "junk"), { mode: "on", active: true });
});

test("cellModel: the mode's label, Active or not, the status and the tooltip verbatim (S4, D8)", () => {
  assert.deepEqual(cellModel("on", { mode: "on", active: true }), {
    label: "On",
    active: true,
    status: "On · Active",
    tooltip: `Keep computer awake, On · Active. ${LID}`,
  });
  assert.deepEqual(cellModel("agent", { mode: "agent", active: false }), {
    label: "Agent",
    active: false,
    status: "Agent · Inactive",
    tooltip: `Keep computer awake, Agent · Inactive. ${LID}`,
  });
  assert.equal(cellModel(undefined, null).status, "Off · Inactive");
  assert.equal(COFFEE, "mods/keep-awake/icons/coffee.svg");
});

test("popupModel: the title, the status, and the three rows verbatim with the dot on the chosen one only (S2, S3)", () => {
  const m = popupModel("on", { mode: "on", active: true });
  assert.equal(m.title, "Keep computer awake");
  assert.equal(m.status, "On · Active");
  assert.deepEqual(m.rows, [
    { value: "on", label: "On", description: "Keep this computer awake continuously", chosen: true },
    { value: "agent", label: "Agent", description: "Stay awake while an agent is working", chosen: false },
    { value: "off", label: "Off", description: "Allow normal system sleep behavior", chosen: false },
  ]);
  assert.deepEqual(popupModel("agent", null).rows.map((r) => r.chosen), [false, true, false]);
  assert.deepEqual(popupModel("bogus", null).rows.map((r) => r.chosen), [false, false, true], "an unknown mode: Off chosen");
  assert.equal(popupModel("agent", { mode: "agent", active: false }).status, "Agent · Inactive");
});

test("choose: a click sets keep-awake.mode and closes the popup (D9)", () => {
  const log = [];
  const io = { setShared: (k, v) => log.push(["set", k, v]), closeOverlay: (id) => log.push(["close", id]) };
  choose("agent", { overlay: "o3", ...io });
  assert.deepEqual(log, [["set", MODE_KEY, "agent"], ["close", "o3"]], "set first: a closed copy may not run what it starts");
  log.length = 0;
  choose("weird", { overlay: null, ...io });
  assert.deepEqual(log, [["set", MODE_KEY, "off"]], "an unknown value is Off, and no overlay means nothing to close");
});

// ── Which copy runs the loop (D6) ──────────────────────────────────────────

test("only the copy with no view and no overlay runs the loop; an overlay copy starts no timer", () => {
  const timer = () => {
    const t = { every: [], after: [] };
    return { t, api: { every: (ms) => t.every.push(ms), after: (ms) => t.after.push(ms) } };
  };
  for (const props of [{ overlay: "o1" }, { view: "popup" }, { view: "popup", overlay: "o2" }]) {
    const { t, api } = timer();
    assert.equal(isLoopCopy(props), false, JSON.stringify(props));
    assert.equal(startLoop(props, api, () => {}), false);
    assert.deepEqual(t, { every: [], after: [] }, JSON.stringify(props));
  }
  for (const props of [{}, null, undefined]) {
    const { t, api } = timer();
    assert.equal(isLoopCopy(props), true);
    assert.equal(startLoop(props, api, () => {}), true);
    assert.deepEqual(t.every, [1000]);
  }
  assert.equal(TICK_MS, 1000);
});

// ── The loop copy's tick (S1, D5, D6) ──────────────────────────────────────

// A holder that holds whatever is wanted, unless `can` is false.
function fakeHolder() {
  const h = {
    wanted: [],
    can: true,
    released: 0,
    tick(wanted) {
      h.wanted.push(wanted);
      return Promise.resolve(wanted && h.can);
    },
    async release() {
      h.released++;
    },
  };
  return h;
}

function loopWorld({ mode = "off", terms = [], win = { platform: "macos" } } = {}) {
  const w = { mode, terms, win, holder: fakeHolder() };
  w.loop = new Loop({ holder: w.holder, live: { mode: () => w.mode, terminals: () => w.terms, window: () => w.win } });
  return w;
}

test("tick: wanted is mode On, or Agent with a terminals() entry working; blocked, done and idle let it sleep (S1, D5)", async () => {
  const cases = [
    ["on", [], true],
    ["off", [term("working")], false],
    ["agent", [], false],
    ["agent", [term("working")], true],
    ["agent", [term("blocked"), term("done"), term("idle")], false],
    ["agent", [term("idle"), term("working")], true],
    [undefined, [term("working")], false],
  ];
  for (const [mode, terms, wanted] of cases) {
    const w = loopWorld({ mode, terms });
    const view = await w.loop.tick();
    assert.deepEqual(w.holder.wanted, [wanted], `${mode} ${JSON.stringify(terms)}`);
    assert.deepEqual(view, { mode: mode ?? "off", active: wanted });
    assert.deepEqual(w.loop.last, view);
  }
});

test("tick: not macOS, or no window (herdr-app check), wants nothing (D6)", async () => {
  for (const win of [{ platform: "linux" }, { platform: "windows" }, null]) {
    const w = loopWorld({ mode: "on", win });
    assert.deepEqual(await w.loop.tick(), { mode: "on", active: false }, JSON.stringify(win));
    assert.deepEqual(w.holder.wanted, [false]);
  }
});

test("tick: Active is what the holder holds, not what is wanted (an unknown Herdr pid reads Inactive)", async () => {
  const w = loopWorld({ mode: "on" });
  w.holder.can = false;
  assert.deepEqual(await w.loop.tick(), { mode: "on", active: false });
});

test("tick: the view is published (and redrawn) only when it changed", async () => {
  const w = loopWorld({ mode: "agent", terms: [term("working")] });
  assert.deepEqual(await w.loop.tick(), { mode: "agent", active: true }, "the first tick always publishes");
  assert.equal(await w.loop.tick(), null);
  assert.equal(await w.loop.tick(), null);
  w.terms = [term("blocked")];
  assert.deepEqual(await w.loop.tick(), { mode: "agent", active: false });
  assert.equal(await w.loop.tick(), null);
  w.mode = "off";
  assert.deepEqual(await w.loop.tick(), { mode: "off", active: false }, "a mode change is a change");
  assert.equal(await w.loop.tick(), null);
});

test("release: the holder lets go once; later ticks run nothing and publish nothing (D7)", async () => {
  const w = loopWorld({ mode: "on" });
  await w.loop.tick();
  await w.loop.release();
  assert.equal(w.holder.released, 1);
  w.mode = "off";
  assert.equal(await w.loop.tick(), null);
  assert.deepEqual(w.holder.wanted, [true], "no tick after the release");
});

// ── main.js and the views, driven through a fake Herdr ─────────────────────

const HERDR = ["props", "exec", "appHome", "readTextFile", "writeTextFile", "settings", "openOverlay", "closeOverlay", "terminals", "shared", "setShared", "theme", "window"];
const FAKES = {
  herdr: HERDR.map((n) => `export const ${n} = (...a) => globalThis.__kaFake.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__kaFake.el(n, ...a);
    export const div = k("div"), svg = k("svg");
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__kaFake.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex");`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});

// An element: every builder call is recorded and returns it. A hover style
// is recorded apart, so it doesn't overwrite what the element has.
function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {}, hovered: null };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "children") t.kids.push(...args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") t.hovered = args[0](el("hover"));
        else if (k === "on_mouse_down") t.handlers.mouse_down = args[1];
        else if (k.startsWith("on_")) t.handlers[k.slice(3)] = args[0];
        return self;
      };
    },
  });
  return self;
}

const find = (e, id) => {
  if (typeof e !== "object" || e === null) return null;
  if (e.calls.id?.[0] === id) return e;
  for (const k of e.kids) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
};
const all = (e, pred, out = []) => {
  if (typeof e !== "object" || e === null) return out;
  if (pred(e)) out.push(e);
  for (const k of e.kids) all(k, pred, out);
  return out;
};
const textOf = (e) => (typeof e === "string" ? e : typeof e === "object" && e !== null ? e.kids.map(textOf).filter(Boolean).join(" ") : "");

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise(setImmediate);
};

const APP = "/fake/app";
const PID_FILE = `${APP}/keep-awake/caffeinate.pid`;
const HERDR_PID = 500;
const APP_COMM = "/Applications/Herdr.app/Contents/MacOS/Herdr";
const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

// One world per test: Herdr's shared values, its files, a Mac running Herdr
// (the processes exec sees), what the copy opened, closed and ran, and a cx.
function newWorld({ props = {}, mode, platform = "macos", hasWindow = true, terms = [] } = {}) {
  const w = {
    props,
    shared: new Map(mode === undefined ? [] : [[MODE_KEY, mode]]),
    sets: [],
    files: {},
    procs: new Map([[HERDR_PID, { ppid: 1, comm: APP_COMM, command: APP_COMM }]]),
    nextPid: 9000,
    execs: [],
    log: [],
    timers: [],
    notifies: 0,
    nextId: 0,
    terms,
    platform,
    hasWindow,
    viewport: { width: 1000, height: 700 },
    spawnGate: null, // a promise caffeinate's sh waits on (an exec in flight)
  };
  w.opened = () => w.log.filter((x) => x.open).map((x) => x.open);
  w.closed = () => w.log.filter((x) => x.close).map((x) => x.close);
  w.spawns = () => w.execs.filter((c) => c[0] === "/bin/sh" && c[2] === SPAWN_SCRIPT);
  w.kills = () => w.execs.filter((c) => c[0] === "kill").map((c) => Number(c[1]));
  w.published = () => w.sets.filter(([k]) => k === VIEW_KEY).map(([, v]) => v);
  w.fire = async (ms) => {
    for (const t of w.timers.filter((x) => x.ms === ms && !x.cancelled)) t.fire();
    await flush();
  };
  const cx = {
    notify: () => {
      w.notifies++;
    },
    spawn: (f) => {
      Promise.resolve().then(() => f(cx)).catch((e) => w.log.push({ error: e }));
    },
    sleep: async () => {},
    timer: {
      every: (ms, f) => {
        const task = { ms, fire: () => f(cx), cancelled: false, cancel: () => (task.cancelled = true) };
        w.timers.push(task);
        return task;
      },
      after: (ms) => w.timers.push({ ms, after: true }),
    },
  };
  w.cx = cx;
  globalThis.window = { viewport_size: () => w.viewport };
  globalThis.__kaFake = {
    el,
    props: () => w.props,
    exec: async (cmd, args = []) => {
      w.execs.push([cmd, ...args]);
      await Promise.resolve();
      if (cmd === "/bin/sh" && args[1] === "echo $PPID") return ok(`${HERDR_PID}\n`);
      if (cmd === "/bin/sh" && args[1] === SPAWN_SCRIPT) {
        if (w.spawnGate) await w.spawnGate;
        const pid = w.nextPid++;
        w.procs.set(pid, { ppid: 1, comm: "/usr/bin/caffeinate", command: `/usr/bin/caffeinate -i -s -w ${args[3]}` });
        return ok(`${pid}\n`);
      }
      if (cmd === "ps") {
        const p = w.procs.get(Number(args[1]));
        if (!p) return { code: 1, stdout: "", stderr: "" };
        return ok(args[3] === "command=" ? `${p.command}\n` : `${p.ppid} ${p.comm}\n`);
      }
      if (cmd === "kill") {
        w.procs.delete(Number(args[0]));
        return ok("");
      }
      if (cmd === "mkdir") return ok("");
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    },
    appHome: () => APP,
    readTextFile: async (path) => w.files[path] ?? null,
    writeTextFile: async (path, text, expected) => {
      if ((w.files[path] ?? null) !== expected) throw new Error("stale snapshot");
      w.files[path] = text;
      return null;
    },
    settings: () => ({ zoom: 1 }),
    openOverlay: (spec) => {
      w.log.push({ open: spec });
      return `o${++w.nextId}`;
    },
    closeOverlay: (id) => w.log.push({ close: id }),
    terminals: () => w.terms,
    shared: (k) => w.shared.get(k),
    setShared: (k, v) => {
      w.sets.push([k, v]);
      w.shared.set(k, v);
    },
    theme: () => new Proxy({}, { get: (_t, k) => `#${String(k)}` }),
    window: () => (w.hasWindow ? { platform: w.platform, titlebar: "system", buttons: false, maximized: false, fullscreen: false, active: true } : null),
  };
  return w;
}

const { default: KeepAwake } = await import("../mods/keep-awake/main.js");

async function copy(opts = {}) {
  const w = newWorld(opts);
  const view = new KeepAwake();
  view.init(w.props, w.cx);
  await flush();
  return { w, view };
}

test("S1, S4: in mode On the cell's 1 s tick starts D1's caffeinate; the cup reads On with a bright dot and Active is shared once", async () => {
  const { w, view } = await copy({ mode: "on" });
  assert.deepEqual(w.timers.map((t) => t.ms), [TICK_MS], "one timer: the tick");
  await w.fire(TICK_MS);
  assert.deepEqual(w.spawns(), [["/bin/sh", "-c", SPAWN_SCRIPT, "sh", String(HERDR_PID)]]);
  assert.equal(w.files[PID_FILE], "9000\n");
  assert.equal(w.procs.get(9000).command, caffeinateCommand(HERDR_PID));
  assert.deepEqual(w.published(), [{ mode: "on", active: true }]);
  const cell = view.render(w.cx);
  const button = find(cell, "keep-awake-button");
  assert.equal(button.calls.tooltip[0], `Keep computer awake, On · Active. ${LID}`);
  const icon = all(button, (e) => e.kind === "svg")[0];
  assert.equal(icon.arg, "mods/keep-awake/icons/coffee.svg");
  assert.equal(icon.calls.text_color[0], "#foreground", "the icon is foreground while active");
  assert.match(textOf(button), /^On$/);
  assert.equal(find(cell, "keep-awake-dot").calls.bg[0], "#foreground", "the dot is bright while active");
  // Nothing changed: nothing shared, nothing redrawn.
  const before = w.notifies;
  await w.fire(TICK_MS);
  await w.fire(TICK_MS);
  assert.deepEqual(w.published(), [{ mode: "on", active: true }]);
  assert.equal(w.notifies, before, "a tick that changed nothing doesn't redraw");
  assert.equal(w.spawns().length, 1);
});

test("S4: Off or Agent with nobody working: the cup reads its mode with a dim dot, and Inactive", async () => {
  const { w, view } = await copy({ mode: "agent", terms: [term("blocked"), term("done")] });
  await w.fire(TICK_MS);
  assert.deepEqual(w.spawns(), []);
  assert.deepEqual(w.published(), [{ mode: "agent", active: false }]);
  const cell = view.render(w.cx);
  assert.match(textOf(find(cell, "keep-awake-button")), /^Agent$/);
  assert.equal(find(cell, "keep-awake-dot").calls.bg[0], "#dim");
  assert.equal(all(cell, (e) => e.kind === "svg")[0].calls.text_color[0], "#muted");
  assert.equal(find(cell, "keep-awake-button").calls.tooltip[0], `Keep computer awake, Agent · Inactive. ${LID}`);
  w.shared.delete(MODE_KEY);
  assert.match(textOf(find(view.render(w.cx), "keep-awake-button")), /^Off$/, "nothing set reads Off (D4)");
});

test("S1, D5: Agent mode holds while a terminal is working and lets go when none is", async () => {
  const { w, view } = await copy({ mode: "agent", terms: [term("working")] });
  await w.fire(TICK_MS);
  assert.equal(w.spawns().length, 1);
  w.terms = [term("blocked")];
  await w.fire(TICK_MS);
  assert.deepEqual(w.kills(), [9000]);
  assert.equal(w.files[PID_FILE], "", "the pid file is cleared");
  assert.deepEqual(w.published(), [{ mode: "agent", active: true }, { mode: "agent", active: false }]);
  assert.equal(find(view.render(w.cx), "keep-awake-dot").calls.bg[0], "#dim");
});

test("D7: the cell's close() releases the caffeinate it holds", async () => {
  const { w, view } = await copy({ mode: "on" });
  await w.fire(TICK_MS);
  await view.close(w.cx);
  assert.deepEqual(w.kills(), [9000]);
  assert.equal(w.files[PID_FILE], "");
  assert.equal(w.procs.has(9000), false);
  const published = w.published().length;
  await w.fire(TICK_MS);
  assert.equal(w.spawns().length, 1, "a closed copy starts nothing again");
  assert.equal(w.published().length, published);
});

test("D7, R3: the cell's close() doesn't wait for the tick in flight; that tick, once it ends, lets go of what it started", async () => {
  const { w, view } = await copy({ mode: "on" });
  let open;
  w.spawnGate = new Promise((resolve) => (open = resolve));
  await w.fire(TICK_MS);
  assert.equal(w.spawns().length, 1, "the start is in flight");
  let closed = false;
  view.close(w.cx).then(() => (closed = true));
  await flush();
  assert.equal(closed, true, "Herdr's close() isn't held by the exec in flight");
  open();
  await flush();
  assert.deepEqual(w.kills(), [9000]);
  assert.equal(w.procs.has(9000), false);
  assert.equal(w.files[PID_FILE], "");
  assert.deepEqual(w.published(), [], "a tick that ended after close() shares nothing");
});

test("D6: not macOS, the cell starts nothing and reads Inactive", async () => {
  const { w, view } = await copy({ mode: "on", platform: "linux" });
  await w.fire(TICK_MS);
  assert.deepEqual(w.execs, []);
  assert.deepEqual(w.published(), [{ mode: "on", active: false }]);
  assert.equal(find(view.render(w.cx), "keep-awake-dot").calls.bg[0], "#dim");
});

test("D6: no window (herdr-app check) runs nothing; a window that comes later (Herdr opening on a layout) starts the loop once", async () => {
  const { w, view } = await copy({ mode: "on", hasWindow: false });
  assert.deepEqual(w.timers.map((t) => t.ms), [WINDOW_LOOK_MS], "it only looks for the window");
  await w.fire(WINDOW_LOOK_MS);
  await w.fire(TICK_MS);
  assert.deepEqual(w.execs, []);
  assert.deepEqual(w.sets, []);
  assert.match(textOf(find(view.render(w.cx), "keep-awake-button")), /^On$/, "it still draws");
  w.hasWindow = true;
  await w.fire(WINDOW_LOOK_MS);
  assert.equal(w.timers[0].cancelled, true, "it stops looking");
  assert.deepEqual(w.timers.filter((t) => !t.cancelled).map((t) => t.ms), [TICK_MS]);
  await w.fire(TICK_MS);
  assert.equal(w.spawns().length, 1);
  w.timers[0].fire();
  await flush();
  assert.deepEqual(w.timers.filter((t) => !t.cancelled).map((t) => t.ms), [TICK_MS], "a late look starts nothing twice");
  await view.close(w.cx);
});

test("S4, D9: a click on the cup opens the popup above it, from the press's bounds", async () => {
  const { w, view } = await copy({ mode: "off" });
  const cell = view.render(w.cx);
  const outer = find(cell, "keep-awake-cell");
  outer.handlers.mouse_down({ bounds: { x: 500, y: 600, width: 64, height: 28 } });
  find(cell, "keep-awake-button").handlers.click({}, w.cx);
  const anchor = { x: 500, y: 600, limit: 564 };
  assert.deepEqual(w.opened(), [popupSpec({ anchor, zoom: 1 })]);
  assert.deepEqual(w.opened()[0].at, { x: 564 - 272, y: 600 - 191 });
  assert.equal(w.opened()[0].kind, "popup");
});

test("D9: a press with no bounds opens it above the cell where the layout puts it, from the window's size", async () => {
  const { w, view } = await copy({ mode: "off" });
  const cell = view.render(w.cx);
  find(cell, "keep-awake-cell").handlers.mouse_down({});
  find(cell, "keep-awake-button").handlers.click({}, w.cx);
  assert.deepEqual(w.opened()[0].at, overlayAt(anchorFrom(CELL_BOUNDS), { width: 264, height: 183 }, 1));
});

test("D9: the press that closed the popup doesn't reopen it; a later click does", async () => {
  const { w, view } = await copy({ mode: "off" });
  const click = () => {
    const cell = view.render(w.cx);
    find(cell, "keep-awake-cell").handlers.mouse_down({ bounds: CELL_BOUNDS });
    find(cell, "keep-awake-button").handlers.click({}, w.cx);
  };
  w.shared.set(CLOSED_KEY, Date.now());
  click();
  assert.deepEqual(w.opened(), []);
  w.shared.set(CLOSED_KEY, Date.now() - 2_000);
  click();
  assert.equal(w.opened().length, 1);
});

test("an overlay copy starts no timer and runs nothing; its close() marks when it closed", async () => {
  const { w, view } = await copy({ props: { view: "popup", overlay: "o7" }, mode: "on" });
  assert.deepEqual(w.timers, []);
  assert.deepEqual(w.execs, []);
  const before = Date.now();
  await view.close(w.cx);
  assert.ok(w.shared.get(CLOSED_KEY) >= before);
  assert.deepEqual(w.execs, []);
});

test("S2, S3: the popup: the title, the status at its right, a separator, three rows, the dot on the chosen one only", async () => {
  const { w, view } = await copy({ props: { view: "popup", overlay: "o7" }, mode: "agent" });
  w.shared.set(VIEW_KEY, { mode: "agent", active: true });
  const popup = view.render(w.cx);
  const header = find(popup, "keep-awake-header");
  assert.deepEqual(header.kids.map(textOf), ["Keep computer awake", "Agent · Active"]);
  assert.equal(header.calls.justify_between !== undefined, true, "title left, status right");
  assert.equal(header.kids[1].calls.text_color[0], "#muted", "the status is dim");
  const sep = find(popup, "keep-awake-separator");
  assert.deepEqual([sep.calls.h[0], sep.calls.bg[0]], [1, "#border"]);
  const rows = MODES.map((m) => find(popup, `keep-awake-mode-${m.value}`));
  assert.deepEqual(rows.map(textOf), [
    "On Keep this computer awake continuously",
    "Agent Stay awake while an agent is working",
    "Off Allow normal system sleep behavior",
  ]);
  for (const r of rows) {
    const [label, description] = all(r, (e) => e.kids.length === 1 && typeof e.kids[0] === "string");
    assert.equal(label.calls.text_color, undefined, "the label in normal text");
    assert.equal(description.calls.text_color[0], "#muted", "the description dim below it");
  }
  assert.deepEqual(MODES.map((m) => Boolean(find(popup, `keep-awake-dot-${m.value}`))), [false, true, false]);
  assert.equal(find(popup, "keep-awake-dot-agent").calls.bg[0], "#foreground");
  // A view the loop copy shared for another mode: right after a change.
  w.shared.set(VIEW_KEY, { mode: "on", active: true });
  assert.equal(textOf(find(view.render(w.cx), "keep-awake-header").kids[1]), "Agent · Inactive");
});

test("D9: a click on a row sets keep-awake.mode and closes the popup", async () => {
  const { w, view } = await copy({ props: { view: "popup", overlay: "o7" }, mode: "off" });
  find(view.render(w.cx), "keep-awake-mode-on").handlers.click({}, w.cx);
  assert.equal(w.shared.get(MODE_KEY), "on");
  assert.deepEqual(w.closed(), ["o7"]);
  assert.deepEqual(w.sets, [[MODE_KEY, "on"]]);
});

test("a copy with a view it doesn't know only says so", async () => {
  const { w, view } = await copy({ props: { view: "nope" } });
  assert.deepEqual(w.timers, []);
  assert.match(textOf(view.render(w.cx)), /keep-awake: no view "nope"/);
});

// ── By their source ────────────────────────────────────────────────────────

test("main.js is the only file importing herdr; its only timers are the tick (startLoop) and the window look", () => {
  const views = readdirSync(mod("views/")).map((f) => `views/${f}`);
  const files = [...readdirSync(mod("")), ...views].filter((f) => f.endsWith(".js"));
  for (const f of ["main.js", "model.js", "holder.js", "popup-model.js", "views/cell.js", "views/popup.js"]) assert.ok(files.includes(f), f);
  for (const f of files) assert.equal(/from\s+["']herdr["']/.test(src(f)), f === "main.js", f);
  const main = src("main.js");
  assert.match(main, /startLoop\(\s*\w+,\s*cx\.timer,/);
  assert.equal((main.match(/\.timer\.(every|after)\(/g) ?? []).length, 1, "the window look");
  assert.doesNotMatch(main, /setTimeout|setInterval/);
  assert.equal(JSON.parse(src("mod.json")).place, "none", "placed by projects-sidebar's status row, never docked by Herdr");
});

test("the coffee icon: Lucide's coffee, 24×24, stroked in currentColor", () => {
  const svg = readFileSync(mod("icons/coffee.svg"), "utf8");
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /width="24" height="24"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /stroke="currentColor"/);
  for (const d of ["M10 2v2", "M14 2v2", "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1", "M6 2v2"]) {
    assert.ok(svg.includes(`d="${d}"`), d);
  }
});
