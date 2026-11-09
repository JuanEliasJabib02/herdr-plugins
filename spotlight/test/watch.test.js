// T37 (D44, S25, L31): `spotlight watch`, the background watcher. One at a
// time, in a hidden hc terminal labeled spotlight.watch=1; `--ensure`
// starts it unless one of the same identity (the installed cli.mjs's mtime)
// runs, and replaces one of another. It watches each holder with Orca's
// filter and syncs 300 ms after a burst, reads the queue's agents and the
// server terminals every 3 s and reaps on the tick that sees one change,
// runs the full reap every 30 s, and exits once nothing is lit and the queue
// is empty. The footer copy runs none of that any more: it calls ensure once.
//
// The loop and ensure take their world injected (watch.mjs): most cases run
// them over fakes, with fake time. The CLI cases run the real CLI with a
// fake `hc` on PATH (terminals in a JSON file): nothing here starts a real
// watcher terminal. The few real watcher processes (`spotlight watch` run
// directly) are killed in each test's cleanup, as are the processes they
// stand for.
//
// watch.mjs is imported inside each test, so one missing name fails its own
// tests, not the file's load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, "..", "mods", "spotlight");
const CLI = join(MOD, "cli.mjs");
const NODE = process.execPath;
const W = () => import("../mods/spotlight/watch.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const ROOT = "/Users/u/code/back";
const H = "/Users/u/orca/workspaces/back/ax-3447";
const H2 = "/Users/u/orca/workspaces/back/ax-3500";
const SERVER = "t1";
const AGENT = "t7";

// A state.json as the CLI reads it: ROOT lit by H (server in SERVER), and
// AGENT's request in line when `agent` is set.
function litState({ holder = H, agent = false } = {}) {
  return {
    version: 1,
    repos: { [ROOT]: { holder, serverTerminal: SERVER, serverState: "listening" } },
    queue: {
      requests: agent ? [{ terminal: AGENT, taskKey: "g1/AX-1", state: "holding", members: [] }] : [],
      lighting: {},
    },
    notes: [],
  };
}
const EMPTY = { version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [] };

// hc get's answer for a live terminal, as the probe printed it.
const term = (address, { fg = 50010, status = null, turn = 0, state = "live" } = {}) => ({
  terminal: { address, state, status, turn, foreground: { pid: fg, name: fg === 50010 ? "script" : "zsh" } },
});

// ── The loop over fakes ────────────────────────────────────────────────────

// runWatcher's world: state, terminal looks, the holder watches it opened,
// the reaps and syncs it ran, its timers and its sleeps, all in fake time.
// `tick()` lets the parked sleep go and waits for the next one (or the end).
function loopWorld(state) {
  const w = {
    state: structuredClone(state),
    looks: new Map(),
    dirs: new Set(),
    now: 0,
    reaps: [],
    syncs: [],
    watches: [],
    timers: [],
    mine: true,
    releases: 0,
    stop: false,
    logs: [],
    result: null,
  };
  let parked = null;
  let onPark = null;
  const parkedOrDone = () =>
    Promise.race([
      new Promise((r) => {
        if (parked) r();
        else onPark = r;
      }),
      w.done,
    ]);
  w.fire = () => {
    for (const t of w.timers) {
      if (!t.cancelled && !t.fired && t.at <= w.now) {
        t.fired = true;
        t.fn();
      }
    }
  };
  w.advance = (ms) => {
    w.now += ms;
    w.fire();
  };
  w.deps = {
    readState: () => structuredClone(w.state),
    look: async (t) => (w.looks.has(t) ? structuredClone(w.looks.get(t)) : { missing: true }),
    reap: async () => {
      w.reaps.push(w.now);
      w.onReap?.();
    },
    sync: (root) => w.syncs.push({ root, at: w.now }),
    watchFolder: (holder, onPath, onGone) => {
      const h = { holder, onPath, onGone, closed: false, close() { this.closed = true; } };
      w.watches.push(h);
      return h;
    },
    isDirectory: (p) => w.dirs.has(p),
    after: (ms, fn) => {
      const t = { at: w.now + ms, fn, cancelled: false, fired: false, cancel() { this.cancelled = true; } };
      w.timers.push(t);
      return t;
    },
    sleep: (ms) =>
      new Promise((resume) => {
        parked = { ms, resume };
        const p = onPark;
        onPark = null;
        p?.();
      }),
    now: () => w.now,
    pidAlive: (pid) => pid !== 4242,
    stillMine: () => w.mine,
    release: async () => {
      w.releases += 1;
      return w.mine ? "idle" : "replaced";
    },
    stopped: () => w.stop,
    log: (text) => w.logs.push(text),
  };
  w.start = async () => {
    const { runWatcher } = await W();
    w.done = runWatcher(w.deps).then((r) => {
      w.result = r;
      return r;
    });
    await parkedOrDone();
  };
  // One tick: the parked sleep's time passes, then the loop runs to its next sleep.
  w.tick = async () => {
    assert.ok(parked, "the loop is parked in its sleep");
    const p = parked;
    parked = null;
    w.advance(p.ms);
    p.resume();
    await parkedOrDone();
    return p.ms;
  };
  // A signal: the parked sleep ends at once, no time passing.
  w.wake = async () => {
    const p = parked;
    parked = null;
    p.resume();
    await parkedOrDone();
  };
  w.live = (h) => w.watches.filter((x) => x.holder === h && !x.closed);
  return w;
}

test("a change in a holder syncs its repo once, 300 ms after the burst; filtered paths, directory events and paths outside the holder don't", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  const [watch] = w.live(H);
  assert.ok(watch, "the holder is watched");
  for (let i = 0; i < 5; i += 1) watch.onPath(`${H}/src/app-${i}.ts`);
  w.advance(299);
  assert.deepEqual(w.syncs, []);
  w.advance(1);
  assert.deepEqual(w.syncs, [{ root: ROOT, at: 300 }]);

  // Orca's folders, a directory event, outside the holder: nothing.
  w.dirs.add(`${H}/src/components`);
  watch.onPath(`${H}/.git/index.lock`);
  watch.onPath(`${H}/node_modules/x/index.js`);
  watch.onPath(`${H}/apps/web/.next/cache/a`);
  watch.onPath(`${H}/src/components`);
  watch.onPath(`${H2}/src/a.ts`);
  w.advance(1000);
  assert.equal(w.syncs.length, 1);

  // The folder itself (an overflowed batch) syncs, as does test output now (L31).
  watch.onPath(H);
  w.advance(300);
  watch.onPath(`${H}/test-results/.last-run.json`);
  w.advance(300);
  assert.deepEqual(w.syncs.map((s) => s.root), [ROOT, ROOT, ROOT]);
  w.mine = false;
  await w.tick();
  assert.equal(w.result.reason, "replaced");
});

test("a holder that stops holding loses its watch; the new holder gets one; a pending sync dies with the watcher", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  const [first] = w.live(H);
  w.state = litState({ holder: H2 });
  await w.tick();
  assert.equal(first.closed, true);
  assert.equal(w.live(H2).length, 1);
  // A change in the old holder after it lost the root: no sync.
  first.onPath(`${H}/src/a.ts`);
  w.advance(300);
  assert.deepEqual(w.syncs, []);
  // A change in the new one, then the watcher is stopped before the 300 ms: no sync, its watch closed.
  w.live(H2)[0].onPath(`${H2}/src/a.ts`);
  w.stop = true;
  await w.wake();
  assert.equal(w.result.reason, "stopped");
  w.advance(1000);
  assert.deepEqual(w.syncs, []);
  assert.equal(w.live(H2).length, 0);
});

test("a holder whose watch can't start (its folder gone) is tried again on the next tick, and the failure logged once", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  let fail = true;
  const real = w.deps.watchFolder;
  w.deps.watchFolder = (holder, onPath, onGone) => {
    if (fail) throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${holder}'`), { code: "ENOENT" });
    return real(holder, onPath, onGone);
  };
  await w.start();
  await w.tick();
  assert.equal(w.watches.length, 0);
  assert.equal(w.logs.filter((l) => l.includes(H)).length, 1, w.logs.join("\n"));
  fail = false;
  await w.tick();
  assert.equal(w.live(H).length, 1);
  // A watch that dies (onGone) is closed, forgotten and opened again on the next tick.
  w.live(H)[0].onGone();
  assert.equal(w.watches[0].closed, true);
  await w.tick();
  assert.equal(w.watches.length, 2);
  assert.equal(w.live(H).length, 1);
  w.mine = false;
  await w.tick();
});

test("a server terminal gone reaps on the tick that sees it, not 30 s later", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  assert.deepEqual(w.reaps, [0], "the first look reaps (the watcher just started)");
  await w.tick();
  assert.deepEqual(w.reaps, [0], "nothing changed: no reap");
  w.looks.delete(SERVER);
  const ms = await w.tick();
  assert.equal(ms, 3000, "a tick is 3 s");
  assert.deepEqual(w.reaps, [0, 6000]);
  await w.tick();
  assert.deepEqual(w.reaps, [0, 6000], "gone stays gone: once");
  w.mine = false;
  await w.tick();
});

test("a server terminal whose foreground changed (a Ctrl-C: the shell leads again) reaps on the tick that sees it", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  w.looks.set(SERVER, term(SERVER, { fg: 50001 }));
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000]);
  w.mine = false;
  await w.tick();
});

test("a queue agent's terminal changing (its status, its turn, gone) reaps; an unrelated terminal or a hc error that stays never does", async () => {
  const w = loopWorld(litState({ agent: true }));
  w.looks.set(SERVER, term(SERVER));
  w.looks.set(AGENT, term(AGENT, { fg: 61000, status: "working" }));
  w.looks.set("t99", term("t99"));
  await w.start();
  w.looks.set(AGENT, term(AGENT, { fg: 61000, status: "done", turn: 1 }));
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000]);
  w.looks.set("t99", term("t99", { status: "working", turn: 4 }));
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000], "not a target");
  w.looks.set(AGENT, { error: "no route to core" });
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000, 9000], "hc stopped answering for it: a change");
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000, 9000], "still no answer: no change");
  w.looks.delete(AGENT);
  await w.tick();
  assert.deepEqual(w.reaps, [0, 3000, 9000, 15000]);
  w.mine = false;
  await w.tick();
});

test("with nothing changing, the full reap every 30 s", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  for (let i = 0; i < 21; i += 1) await w.tick();
  assert.deepEqual(w.reaps, [0, 30000, 60000]);
  w.mine = false;
  await w.tick();
});

test("a reap is never run twice at once: the tick waits for it", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  let running = 0;
  let most = 0;
  w.deps.reap = async () => {
    running += 1;
    most = Math.max(most, running);
    w.reaps.push(w.now);
    await sleep(5);
    running -= 1;
  };
  await w.start();
  w.looks.delete(SERVER);
  await w.tick();
  assert.equal(most, 1);
  assert.equal(w.reaps.length, 2);
  w.mine = false;
  await w.tick();
});

test("nothing lit and the queue empty: the watcher reaps once, lets its record go and exits, its watches closed", async () => {
  const w = loopWorld(EMPTY);
  await w.start();
  assert.equal(w.result?.reason, "idle");
  assert.deepEqual(w.reaps, [0]);
  assert.equal(w.releases, 1);

  // Lit at start, then the last holder turns off: it exits on that tick.
  const v = loopWorld(litState());
  v.looks.set(SERVER, term(SERVER));
  await v.start();
  assert.equal(v.result, null);
  assert.equal(v.releases, 0, "lit: never asks to let go");
  v.state = EMPTY;
  await v.tick();
  assert.equal(v.result?.reason, "idle");
  assert.ok(v.watches.every((x) => x.closed));
  // That tick's reap (its terminals changed) ran after it last saw the repo lit: no second one.
  assert.deepEqual(v.reaps, [0, 3000]);
});

test("idle with no reap since it last saw something lit or queued (a light that died unfinished): one full reap first, then the release; a release refused (lit again under the lock) earns another", async () => {
  // A light at work, its holder not written yet: no terminal to look at, so
  // its death changes no fingerprint.
  const lighting = (pid) => ({ ...EMPTY, queue: { requests: [], lighting: { [`direct/${ROOT}`]: { phase: "running", pid, startedAt: 1 } } } });
  const w = loopWorld(lighting(777));
  const order = [];
  let refuse = false;
  w.onReap = () => order.push(`reap@${w.now}`);
  w.deps.release = async () => {
    w.releases += 1;
    order.push(`release@${w.now}`);
    return refuse ? null : "idle";
  };
  await w.start();
  await w.tick();
  assert.deepEqual(w.reaps, [0], "at work, nothing changing: no reap");
  assert.equal(w.releases, 0);

  // The light dies before it finishes: its marker and busy mark stay for the reap.
  w.state = lighting(4242);
  refuse = true;
  await w.tick();
  assert.equal(w.result, null);
  assert.deepEqual(order, ["reap@0", "reap@6000", "release@6000"], "the reap before the release");

  // Refused under the lock (something lit again): the next idle tick reaps again first.
  refuse = false;
  await w.tick();
  assert.equal(w.result?.reason, "idle");
  assert.deepEqual(order, ["reap@0", "reap@6000", "release@6000", "reap@9000", "release@9000"]);
});

test("a release refused (lit again under the lock) keeps it running", async () => {
  const w = loopWorld(EMPTY);
  let refuse = true;
  w.deps.release = async () => {
    w.releases += 1;
    return refuse ? null : "idle";
  };
  await w.start();
  assert.equal(w.result, null);
  refuse = false;
  await w.tick();
  assert.equal(w.result?.reason, "idle");
  assert.equal(w.releases, 2);
});

test("a stop (a signal) ends the loop at once, even mid-sleep", async () => {
  const w = loopWorld(litState());
  w.looks.set(SERVER, term(SERVER));
  await w.start();
  const reaps = w.reaps.length;
  w.stop = true;
  await w.wake();
  assert.equal(w.result?.reason, "stopped");
  assert.equal(w.reaps.length, reaps, "no reap on the way out");
  assert.ok(w.watches.every((x) => x.closed));
});

test("watchIdle: idle only with no holder, no request and no lighting at work", async () => {
  const { watchIdle } = await W();
  const opts = { now: 100_000, pidAlive: (pid) => pid !== 4242 };
  assert.equal(watchIdle(EMPTY, opts), true);
  assert.equal(watchIdle(null, opts), true);
  assert.equal(watchIdle(litState(), opts), false);
  const waiting = structuredClone(EMPTY);
  waiting.queue.requests.push({ terminal: AGENT, taskKey: "g1/AX-1", state: "waiting" });
  assert.equal(watchIdle(waiting, opts), false);
  const paused = structuredClone(EMPTY);
  paused.queue.requests.push({ terminal: AGENT, taskKey: "g1/AX-1", state: "paused" });
  assert.equal(watchIdle(paused, opts), false);
  // A light at work (a toggle's, before the holder is written).
  const lighting = (m) => ({ ...EMPTY, queue: { requests: [], lighting: { [`direct/${ROOT}`]: m } } });
  assert.equal(watchIdle(lighting({ phase: "running", pid: 777, startedAt: 1 }), opts), false);
  assert.equal(watchIdle(lighting({ phase: "pending", pid: null, startedAt: 99_000 }), opts), false, "just spawned");
  assert.equal(watchIdle(lighting({ phase: "running", pid: 4242, startedAt: 1 }), opts), true, "its light died");
  assert.equal(watchIdle(lighting({ phase: "done", pid: 777, startedAt: 1 }), opts), true);
  assert.equal(watchIdle(lighting({ phase: "error", pid: 777, startedAt: 1 }), opts), true);
  // A record with no holder (a root error left after a refused light) isn't lit.
  assert.equal(watchIdle({ ...EMPTY, repos: { [ROOT]: { holder: null, lastError: { code: "root-diverged" } } } }, opts), true);
});

test("watchFingerprint: the targets' state, status, turn and foreground; gone and unreadable said apart; order-free", async () => {
  const { watchFingerprint } = await W();
  const looks = new Map([[SERVER, term(SERVER)], [AGENT, term(AGENT, { status: "working", fg: 61000 })]]);
  const look = async (t) => looks.get(t) ?? { missing: true };
  const a = await watchFingerprint([SERVER, AGENT], look);
  assert.equal(await watchFingerprint([AGENT, SERVER, SERVER], look), a);
  looks.set(SERVER, term(SERVER, { fg: 50001 }));
  const b = await watchFingerprint([SERVER, AGENT], look);
  assert.notEqual(b, a);
  looks.delete(SERVER);
  const c = await watchFingerprint([SERVER, AGENT], look);
  looks.set(SERVER, { error: "socket closed" });
  const d = await watchFingerprint([SERVER, AGENT], look);
  assert.equal(new Set([a, b, c, d]).size, 4);
  // A look that throws reads as unreadable, never as gone.
  assert.equal(await watchFingerprint([SERVER, AGENT], async (t) => (t === SERVER ? Promise.reject(new Error("x")) : look(t))), d);
  assert.equal(await watchFingerprint([], look), "");
});

// ── ensure over fakes ──────────────────────────────────────────────────────

// A fake hc for ensureWatcher: terminals in memory, every call recorded,
// each answering after `delay` ms (two ensures at once overlap).
function fakeHc({ delay = 0 } = {}) {
  const h = { terminals: {}, calls: [], next: 1 };
  h.hc = async (args) => {
    h.calls.push(args);
    if (delay) await sleep(delay);
    const [verb, t] = args;
    const json = (code, obj) => ({ code, stdout: obj ? `${JSON.stringify(obj)}\n` : "", stderr: "" });
    if (verb === "get") return h.terminals[t] ? json(0, h.terminals[t]) : { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found" } }) };
    if (verb === "kill") {
      if (!h.terminals[t]) return { code: 3, stdout: "", stderr: "" };
      h.terminals[t].state = "finished";
      return json(0, { killed: t });
    }
    if (verb === "run") {
      const address = `t${h.next++}`;
      const labels = {};
      args.forEach((a, i) => {
        if (a === "--label") {
          const [k, ...v] = args[i + 1].split("=");
          labels[k] = v.join("=");
        }
      });
      h.terminals[address] = { address, state: "live", labels, argv: args.slice(args.indexOf("--") + 1), cwd: args[args.indexOf("--cwd") + 1] };
      return json(0, { address, state: "live" });
    }
    return { code: 2, stdout: "", stderr: "fake hc: " + verb };
  };
  h.watchers = () => Object.values(h.terminals).filter((x) => x.labels["spotlight.watch"] === "1");
  return h;
}

async function ensureWorld(t, { delay = 0, identity = "/app/mods/spotlight/cli.mjs@100" } = {}) {
  const { watchStore } = await W();
  const stateDir = tempDir(t, "sl-watch-ensure-");
  const store = watchStore(stateDir);
  const h = fakeHc({ delay });
  const deps = {
    ...store,
    hc: h.hc,
    identity,
    argv: ["/usr/bin/env", "PATH=/bin", NODE, "/app/mods/spotlight/cli.mjs", "watch"],
    cwd: "/Users/u",
    now: () => 1234,
  };
  return { stateDir, store, h, deps };
}

test("ensure with none running starts one hidden terminal, labeled spotlight.watch=1, removed when it exits, and records it", async (t) => {
  const { ensureWatcher, WATCH_LABEL } = await W();
  assert.equal(WATCH_LABEL, "spotlight.watch");
  const { h, deps, store } = await ensureWorld(t);
  const r = await ensureWatcher(deps);
  assert.deepEqual(r, { action: "started", terminal: "t1" });
  const runs = h.calls.filter((c) => c[0] === "run");
  assert.equal(runs.length, 1);
  const run = runs[0];
  for (const flag of ["--bg", "--no-parent", "--rm", "--json"]) assert.ok(run.includes(flag), `${flag}: ${run.join(" ")}`);
  assert.ok(!run.includes("--keep"), "a watcher that exits leaves no shell behind");
  assert.ok(!run.some((a) => a.startsWith("herdr.space")), "hidden: no space");
  assert.deepEqual(run.slice(run.indexOf("--") + 1), deps.argv);
  assert.equal(run[run.indexOf("--cwd") + 1], "/Users/u");
  assert.deepEqual(h.watchers().map((x) => x.address), ["t1"]);
  assert.deepEqual(store.read(), { version: 1, terminal: "t1", pid: null, identity: deps.identity, at: 1234 });
});

test("ensure with one of the same identity running does nothing", async (t) => {
  const { ensureWatcher } = await W();
  const { h, deps } = await ensureWorld(t);
  await ensureWatcher(deps);
  const calls = h.calls.length;
  assert.deepEqual(await ensureWatcher(deps), { action: "running", terminal: "t1" });
  assert.deepEqual(h.calls.slice(calls).map((c) => c[0]), ["get"]);
  assert.equal(h.watchers().length, 1);
});

test("ensure with one of another identity (a reinstall) replaces it: the old terminal killed, a new one recorded", async (t) => {
  const { ensureWatcher } = await W();
  const { h, deps, store } = await ensureWorld(t);
  await ensureWatcher({ ...deps, identity: "/app/mods/spotlight/cli.mjs@99" });
  const r = await ensureWatcher(deps);
  assert.deepEqual(r, { action: "replaced", terminal: "t2", replaced: "t1" });
  assert.equal(h.terminals.t1.state, "finished");
  assert.deepEqual(h.calls.filter((c) => c[0] === "kill"), [["kill", "t1", "--json"]]);
  assert.equal(store.read().terminal, "t2");
  assert.equal(store.read().identity, deps.identity);
});

test("ensure starts a new one when the recorded one is gone, finished, or isn't a watcher (an address reused after hc restarted)", async (t) => {
  const { ensureWatcher } = await W();
  const { h, deps, store } = await ensureWorld(t);
  await ensureWatcher(deps);
  delete h.terminals.t1;
  assert.equal((await ensureWatcher(deps)).action, "started");
  h.terminals.t2.state = "finished";
  assert.equal((await ensureWatcher(deps)).action, "started");
  h.terminals.t3.labels = {};
  const r = await ensureWatcher(deps);
  assert.equal(r.action, "started");
  assert.ok(!h.calls.some((c) => c[0] === "kill"), "never kills a terminal that isn't a watcher");
  assert.equal(store.read().terminal, r.terminal);
});

test("ensure when hc can't say about the recorded one starts nothing; a run that fails is said, the record dropped", async (t) => {
  const { ensureWatcher } = await W();
  const { h, deps, store } = await ensureWorld(t);
  await ensureWatcher(deps);
  const real = h.hc;
  h.hc = async (args) => (args[0] === "get" ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "socket closed" } }) } : real(args));
  assert.equal((await ensureWatcher({ ...deps, hc: h.hc })).action, "unknown");
  assert.equal(h.watchers().length, 1);
  h.hc = async (args) => (args[0] === "run" ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "no route to core" } }) } : real(args));
  delete h.terminals.t1;
  const r = await ensureWatcher({ ...deps, hc: h.hc });
  assert.equal(r.action, "failed");
  assert.match(r.message, /no route to core/);
  assert.equal(store.read(), null);
});

test("two ensures at once start one watcher (the watch lock)", async (t) => {
  const { ensureWatcher } = await W();
  const { h, deps } = await ensureWorld(t, { delay: 30 });
  const [a, b] = await Promise.all([ensureWatcher(deps), ensureWatcher(deps)]);
  assert.deepEqual([a.action, b.action].sort(), ["running", "started"]);
  assert.equal(h.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal(h.watchers().length, 1);
});

test("the watcher's command carries PATH and HERDR_APP_HOME (hc gives its terminals the core's env, not the caller's)", async () => {
  const { watcherCommand } = await W();
  assert.deepEqual(
    watcherCommand({ node: "/n/node", cli: "/app/mods/spotlight/cli.mjs", env: { PATH: "/a:/b", HERDR_APP_HOME: "/h", OTHER: "x" } }),
    ["/usr/bin/env", "PATH=/a:/b", "HERDR_APP_HOME=/h", "/n/node", "/app/mods/spotlight/cli.mjs", "watch"],
  );
  assert.deepEqual(
    watcherCommand({ node: "/n/node", cli: "/c.mjs", env: { PATH: "/a" } }),
    ["/usr/bin/env", "PATH=/a", "/n/node", "/c.mjs", "watch"],
  );
});

test("the identity is the CLI's path and mtime: a reinstall (cp -R) changes it", async (t) => {
  const { watchIdentity } = await W();
  const dir = tempDir(t, "sl-watch-id-");
  const cli = join(dir, "cli.mjs");
  writeFileSync(cli, "// one\n");
  const a = watchIdentity(cli);
  assert.equal(a, `${cli}@${statSync(cli).mtimeMs}`);
  assert.equal(watchIdentity(cli), a);
  await sleep(20);
  writeFileSync(cli, "// two\n");
  assert.notEqual(watchIdentity(cli), a);
  assert.match(watchIdentity(join(dir, "missing.mjs")), /@\?$/);
});

test("claim, stillMine and release: the watcher claims the record ensure wrote for its terminal; another live watcher's record is left alone; release clears only its own, only while idle", async (t) => {
  const { watchStore, claimWatch, releaseWatch, mineOf } = await W();
  const store = watchStore(tempDir(t, "sl-watch-claim-"));
  const h = fakeHc();
  const look = { hc: h.hc };
  const me = { terminal: "t5", pid: 900 };
  // Written by ensure for t5: claimed, the pid added.
  store.write({ version: 1, terminal: "t5", pid: null, identity: "x@1", at: 1 });
  assert.equal(await claimWatch(store, me, { identity: "x@1", now: 2, ...look }), true);
  assert.deepEqual(store.read(), { version: 1, terminal: "t5", pid: 900, identity: "x@1", at: 1 });
  assert.equal(mineOf(me)(store.read()), true);
  // Another live watcher is recorded: no claim.
  h.terminals.t8 = { address: "t8", state: "live", labels: { "spotlight.watch": "1" } };
  store.write({ version: 1, terminal: "t8", pid: 800, identity: "x@1", at: 1 });
  assert.equal(await claimWatch(store, me, { identity: "x@1", now: 2, ...look }), false);
  assert.equal(store.read().terminal, "t8");
  assert.equal(mineOf(me)(store.read()), false);
  // Its terminal gone: claimed.
  delete h.terminals.t8;
  assert.equal(await claimWatch(store, me, { identity: "x@1", now: 3, ...look }), true);
  assert.deepEqual(store.read(), { version: 1, terminal: "t5", pid: 900, identity: "x@1", at: 3 });
  // Release: lit again → kept; idle → cleared; someone else's → left, and "replaced".
  assert.equal(await releaseWatch(store, me, { idle: () => false }), null);
  assert.ok(store.read());
  assert.equal(await releaseWatch(store, me, { idle: () => true }), "idle");
  assert.equal(store.read(), null);
  store.write({ version: 1, terminal: "t8", pid: 800, identity: "x@1", at: 1 });
  assert.equal(await releaseWatch(store, me, { idle: () => true }), "replaced");
  assert.equal(store.read().terminal, "t8");
  // Outside hc (no terminal): its pid names it.
  const bare = { terminal: null, pid: 901 };
  assert.equal(mineOf(bare)({ terminal: null, pid: 901 }), true);
  assert.equal(mineOf(bare)({ terminal: "t5", pid: 900 }), false);
});

// ── Node's watch ───────────────────────────────────────────────────────────

test("the holder watch (Node's recursive fs.watch) hands each changed path over, absolute; a new folder reads as a directory", async (t) => {
  const { watchFolderNode, isDirectoryNode } = await W();
  const dir = tempDir(t, "sl-watch-fs-");
  mkdirSync(join(dir, "src"));
  const seen = [];
  const h = watchFolderNode(dir, (p) => seen.push(p), () => seen.push("gone"));
  t.after(() => h?.close());
  assert.ok(h, "watching");
  await sleep(150);
  writeFileSync(join(dir, "src", "a.ts"), "x\n");
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`no event: ${JSON.stringify(seen)}`);
      await sleep(25);
    }
  };
  await until(() => seen.includes(join(dir, "src", "a.ts")));
  mkdirSync(join(dir, "src", "newdir"));
  await until(() => seen.includes(join(dir, "src", "newdir")));
  assert.equal(isDirectoryNode(join(dir, "src", "newdir")), true);
  assert.equal(isDirectoryNode(join(dir, "src", "a.ts")), false);
  assert.equal(isDirectoryNode(join(dir, "nothing")), false);
  // A folder that isn't there: no watch (the loop tries again next tick).
  assert.throws(() => watchFolderNode(join(dir, "nothing"), () => {}, () => {}));
});

// ── The CLI, with a fake hc on PATH ────────────────────────────────────────

// Terminals in $FAKE_HC_STATE; every call recorded. Enough of hc for
// `watch --ensure`, `on` outside a task and `light`: get, run, kill, ls,
// read.
const FAKE_HC = `#!${NODE}
const fs = require("fs");
const STATE = process.env.FAKE_HC_STATE;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; ; i++) {
  try { fs.mkdirSync(STATE + ".lock"); break; } catch { if (i > 4000) throw new Error("fake hc: lock"); nap(3); }
}
try {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { s = { next: 1, terminals: {}, calls: [] }; }
  const args = process.argv.slice(2);
  s.calls.push(args);
  const [verb, t] = args;
  const out = (code, obj, err) => {
    if (obj !== undefined) process.stdout.write(JSON.stringify(obj) + "\\n");
    if (err) process.stderr.write(JSON.stringify({ error: err }) + "\\n");
    process.exitCode = code;
  };
  const x = s.terminals[t];
  if (verb === "get") x ? out(0, x) : out(3, undefined, { kind: "not_found", message: "no terminal " + t });
  else if (verb === "kill") { if (x) { x.state = "finished"; out(0, { killed: t }); } else out(3, undefined, { kind: "not_found" }); }
  else if (verb === "run") {
    const address = "t" + s.next++;
    const labels = {};
    args.forEach((a, i) => { if (a === "--label") { const [k, ...v] = args[i + 1].split("="); labels[k] = v.join("="); } });
    s.terminals[address] = { address, state: "live", labels, argv: args.slice(args.indexOf("--") + 1), cwd: args[args.indexOf("--cwd") + 1], turn: 0, status: null };
    out(0, { address, state: "live", turn: 0 });
  } else if (verb === "ls") out(0, { terminals: Object.values(s.terminals).filter((y) => y.state === "live") });
  else if (verb === "read") out(0, { text: "" });
  else out(2, undefined, { kind: "usage", message: "fake hc: " + verb });
  fs.writeFileSync(STATE + ".tmp", JSON.stringify(s));
  fs.renameSync(STATE + ".tmp", STATE);
} finally {
  fs.rmSync(STATE + ".lock", { recursive: true, force: true });
}
`;

function cliWorld(t) {
  const dir = tempDir(t, "sl-watch-cli-");
  const home = join(dir, "home");
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  for (const d of [home, app, bin, join(app, "spotlight"), join(dir, "elsewhere")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "hc"), FAKE_HC);
  chmodSync(join(bin, "hc"), 0o755);
  const env = { ...process.env };
  for (const k of ["HC_TERMINAL_ID", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "NODE_TEST_CONTEXT"]) delete env[k];
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, FAKE_HC_STATE: join(dir, "hc.json") });
  const w = {
    dir, home, app, env,
    hcPath: join(dir, "hc.json"),
    watchPath: join(app, "spotlight", "watch.json"),
    hc: () => (existsSync(join(dir, "hc.json")) ? JSON.parse(readFileSync(join(dir, "hc.json"), "utf8")) : { terminals: {}, calls: [] }),
    record: () => (existsSync(w.watchPath) ? JSON.parse(readFileSync(w.watchPath, "utf8")) : null),
    watchers: () => Object.values(w.hc().terminals).filter((x) => x.labels?.["spotlight.watch"] === "1"),
    runs: () => w.hc().calls.filter((c) => c[0] === "run"),
    cli(args, { cwd = dir, extraEnv = {} } = {}) {
      return new Promise((resolve) => {
        execFile(NODE, [CLI, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
        });
      });
    },
  };
  return w;
}

test("`spotlight watch --ensure`: none running → one hidden labeled terminal running this CLI's watch; again → nothing", async (t) => {
  const w = cliWorld(t);
  const first = await w.cli(["watch", "--ensure"]);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /started/);
  const [made] = w.watchers();
  assert.ok(made, JSON.stringify(w.hc()));
  assert.equal(made.cwd, w.home);
  assert.deepEqual(made.argv, ["/usr/bin/env", `PATH=${w.env.PATH}`, `HERDR_APP_HOME=${w.app}`, NODE, CLI, "watch"]);
  const run = w.runs()[0];
  for (const flag of ["--bg", "--no-parent", "--rm"]) assert.ok(run.includes(flag), run.join(" "));
  assert.deepEqual(w.record(), { version: 1, terminal: made.address, pid: null, identity: `${CLI}@${statSync(CLI).mtimeMs}`, at: w.record().at });

  const again = await w.cli(["watch", "--ensure"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /running/);
  assert.equal(w.runs().length, 1);
});

test("`spotlight watch --ensure` replaces a watcher of another identity", async (t) => {
  const w = cliWorld(t);
  await w.cli(["watch", "--ensure"]);
  const old = w.record();
  writeFileSync(w.watchPath, JSON.stringify({ ...old, identity: "/old/cli.mjs@1" }));
  const r = await w.cli(["watch", "--ensure"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /replaced/);
  assert.equal(w.hc().terminals[old.terminal].state, "finished");
  assert.equal(w.watchers().filter((x) => x.state === "live").length, 1);
  assert.notEqual(w.record().terminal, old.terminal);
});

test("two `spotlight watch --ensure` at once start one watcher", async (t) => {
  const w = cliWorld(t);
  const rs = await Promise.all([w.cli(["watch", "--ensure"]), w.cli(["watch", "--ensure"]), w.cli(["watch", "--ensure"])]);
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  assert.equal(w.runs().length, 1, JSON.stringify(w.hc().calls));
  assert.equal(w.watchers().length, 1);
});

test("`spotlight on` ensures the watcher once its request is in line", async (t) => {
  const w = cliWorld(t);
  const r = await w.cli(["on", "--terminal", "t900", "--timeout-ms", "2000"], { cwd: join(w.dir, "elsewhere") });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(w.watchers().length, 1, JSON.stringify(w.hc().calls));
  const calls = w.hc().calls;
  const ensured = calls.findIndex((c) => c[0] === "run");
  assert.ok(ensured >= 0);
});

test("`spotlight light` ensures the watcher", async (t) => {
  const w = cliWorld(t);
  const r = await w.cli(["light", "--task", "direct/nothing"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(w.watchers().length, 1, JSON.stringify(w.hc().calls));
});

test("`spotlight watch` with nothing lit and the queue empty claims its record, reaps once and exits 0, the record gone", async (t) => {
  const w = cliWorld(t);
  writeFileSync(w.watchPath, JSON.stringify({ version: 1, terminal: "tw", pid: null, identity: "x@1", at: 1 }));
  const r = await w.cli(["watch"], { extraEnv: { HC_TERMINAL_ID: "tw" } });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /idle/);
  assert.equal(w.record(), null);
});

// A real watcher process, kept running by a lighting marker whose pid (a
// child of this test) lives: killed in the test's cleanup, with that child.
function startWatcher(t, w) {
  const keeper = spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => keeper.kill("SIGKILL"));
  const state = {
    version: 1, repos: {}, notes: [],
    queue: { requests: [], lighting: { "direct/x": { grantId: 1, phase: "running", pid: keeper.pid, startedAt: Date.now(), members: [] } } },
  };
  writeFileSync(join(w.app, "spotlight", "state.json"), JSON.stringify(state));
  writeFileSync(w.watchPath, JSON.stringify({ version: 1, terminal: "tw", pid: null, identity: "x@1", at: 1 }));
  const child = spawn(NODE, [CLI, "watch"], { cwd: w.dir, env: { ...w.env, HC_TERMINAL_ID: "tw" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => out };
}

async function untilTrue(pred, ms, what) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

test("a real watcher claims its record (its pid), exits within a tick once another watcher is recorded, and leaves that record alone", async (t) => {
  const w = cliWorld(t);
  const p = startWatcher(t, w);
  await untilTrue(() => w.record()?.pid === p.child.pid, 10_000, `the claim: ${JSON.stringify(w.record())}`);
  const other = { version: 1, terminal: "t77", pid: 4, identity: "y@2", at: 2 };
  writeFileSync(w.watchPath, JSON.stringify(other));
  const end = await Promise.race([p.exited, sleep(8000).then(() => null)]);
  assert.ok(end, `still running: ${p.out()}`);
  assert.equal(end.code, 0, p.out());
  assert.match(p.out(), /replaced/);
  assert.deepEqual(w.record(), other);
});

test("a real watcher stopped by SIGTERM exits 0 and drops its record", async (t) => {
  const w = cliWorld(t);
  const p = startWatcher(t, w);
  await untilTrue(() => w.record()?.pid === p.child.pid, 10_000, `the claim: ${JSON.stringify(w.record())}`);
  p.child.kill("SIGTERM");
  const end = await Promise.race([p.exited, sleep(8000).then(() => null)]);
  assert.ok(end, `still running: ${p.out()}`);
  assert.equal(end.code, 0, p.out());
  assert.equal(w.record(), null);
});

// ── The footer copy ────────────────────────────────────────────────────────

test("the footer copy starts no reaper and no holder watch, and calls `spotlight watch --ensure` once at start", () => {
  const src = (f) => readFileSync(join(MOD, f), "utf8");
  assert.equal(existsSync(join(MOD, "reaper.js")), false, "reaper.js is gone");
  assert.equal(existsSync(join(MOD, "autosync.js")), false, "autosync.js is gone");
  const main = src("main.js");
  const footer = src("footer.js");
  const badges = src("badges.js");
  for (const [name, text] of [["main.js", main], ["footer.js", footer], ["badges.js", badges]]) {
    for (const gone of ["startReaper", "startAutosync", "setReapTargets", "followHolders", "./reaper.js", "./autosync.js", "terminals()"]) {
      assert.ok(!text.includes(gone), `${name} still has ${gone}`);
    }
  }
  assert.ok(!/watchFolder\(/.test(main + footer + badges), "no folder watch in the footer copy");
  const ensures = main.match(/\["watch", "--ensure"\]/g) ?? [];
  assert.equal(ensures.length, 1, "one ensure");
  // In init's footer branch.
  const init = /init\(p, cx\) \{([\s\S]*?)\n {2}\}/.exec(main)?.[1] ?? "";
  const branch = /if \(this\.name === "footer"\) \{([\s\S]*?)\n {4}\}/.exec(init)?.[1] ?? "";
  assert.ok(/ensureWatcher\(cx\);/.test(branch) || branch.includes('["watch", "--ensure"]'), branch);
  if (!branch.includes('["watch", "--ensure"]')) assert.match(main, /function ensureWatcher\(cx\) \{[\s\S]*?\["watch", "--ensure"\]/);
});
