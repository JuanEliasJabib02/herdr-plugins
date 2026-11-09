// `spotlight watch` (D44, S25, L31): the background watcher, Orca's main
// process for what Herdr's footer copy used to run (auto-sync, D9; the
// reaper, D13, D19). It runs in any layout, with the window shown or not:
// Herdr runs a mod's copy only while its block is in the shown layout, and
// only `projects` has the footer's (D20, D45). Node-only, like cli.mjs; the
// mod never imports it.
//
// One at a time. It runs in a hidden hc terminal (no herdr.space) labeled
// spotlight.watch=1, started `--rm` so a watcher that exits leaves nothing
// behind; `<stateDir>/watch.json` records it, `{ version, terminal, pid,
// identity, at }`, written under the `locks/watch` lock. Its identity is the
// installed cli.mjs's path and mtime (the installer's `cp -R` gives every
// install a new one).
//   - `spotlight watch --ensure` (ensureWatcher): the footer copy's start,
//     every `spotlight on` and every light call it. It starts one unless a
//     watcher of the same identity runs, and replaces one of another (a
//     reinstall): kills its terminal, starts the new one. Two at once start
//     one (the lock). hc gives a terminal the core's env, not the caller's,
//     so the command carries the caller's PATH and HERDR_APP_HOME
//     (watcherCommand).
//   - `spotlight watch` (watchMain, runWatcher): claims the record (the one
//     ensure wrote for its terminal, or a free one), then every 3 s:
//       - watches each holder (Node's recursive fs.watch) with Orca's filter
//         (watch-filter.js: its nine folders at any depth, directory events
//         dropped, paths inside the holder) and, 300 ms after a burst, spawns
//         a detached `spotlight sync --repo <root> --auto` (D18); the
//         engine's tree compare absorbs the rest;
//       - reads the terminals that matter (the queue's agents and the server
//         terminals, board-model.js reapTargets) with one `hc get` each:
//         `hc ls` has no foreground, and a server's Ctrl-C shows only there.
//         Their fingerprint (state, status, turn, foreground pid; gone and
//         unreadable apart) changed since the last tick: `spotlight reap` at
//         once, so a closed tab or a stopped server toasts within one tick;
//       - the full reap every 30 s with nothing changing, and at start;
//       - exits once no repo is lit, the queue is empty and no light is at
//         work (watchIdle), after one last full reap unless one ran since
//         it last saw something lit or queued (a light that died unfinished
//         leaves its busy mark or lighting marker for a reap), letting its
//         record go under the lock, so an
//         ensure racing it either sees the record (and the watcher, re-reading
//         state under the lock, stays) or starts a new one. The next light or
//         `on` starts it again.
//     It exits too when the record no longer names it (replaced), and on
//     SIGTERM, SIGINT or SIGHUP (`hc kill`'s hangup), dropping its record.
//     The reap runs as a child `spotlight reap`, as the footer ran it: a
//     failure there never ends the watcher. Its lines go to its terminal
//     (`hc read <terminal>`, the record names it).
//
// The loop and ensure take their world injected (runWatcher, ensureWatcher),
// so `node --test` runs them over fakes; watchMain and nodeEnsureDeps wire
// the real one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { withLock, pidAlive } from "./locks.js";
import { CLI_PATH, exec, hcGet, spawnDetached } from "./cli-env.mjs";
import { lightAlive } from "./cli-turns.mjs";
import { reapTargets } from "./board-model.js";
import { shouldSync, watchTargets, syncArgs, debouncer, SYNC_DEBOUNCE_MS } from "./watch-filter.js";

// The label every watcher terminal carries: what ensure checks before it
// takes a recorded terminal for a watcher (an address hc reused after a
// restart isn't one), and before it kills one.
export const WATCH_LABEL = "spotlight.watch";
// How often the terminals are read (D44).
export const WATCH_TICK_MS = 3_000;
// The full reap with nothing changing (the footer's old reaper's, D13).
export const WATCH_FULL_REAP_MS = 30_000;
// The watch lock's wait: ensure and the watcher hold it for a few hc calls.
const WATCH_LOCK_MS = 10_000;
// A reap returns in under a second (D18); this bounds a stuck one.
const REAP_TIMEOUT_MS = 60_000;
// hc's own answer for get, run and kill.
const HC_TIMEOUT_MS = 10_000;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(text) {
  try {
    const v = JSON.parse(String(text ?? "").trim());
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

// ── The record ─────────────────────────────────────────────────────────────

// watch.json and its lock, in the state dir. read() → the record or null
// (none, unreadable); write(null) removes it; lock(fn) runs fn holding
// `locks/watch`.
export function watchStore(stateDir, { lockTimeoutMs = WATCH_LOCK_MS } = {}) {
  const file = path.join(stateDir, "watch.json");
  const lockDir = path.join(stateDir, "locks", "watch");
  return {
    file,
    lockDir,
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8"));
        return isObject(v) && v.version === 1 ? v : null;
      } catch {
        return null;
      }
    },
    write(record) {
      if (!record) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
    lock(fn, opts = {}) {
      return withLock(lockDir, fn, { timeoutMs: lockTimeoutMs, ...opts });
    },
  };
}

// The CLI's path and mtime: what makes two watchers the same build.
export function watchIdentity(cliPath = CLI_PATH) {
  try {
    return `${cliPath}@${fs.statSync(cliPath).mtimeMs}`;
  } catch {
    return `${cliPath}@?`;
  }
}

// What the watcher terminal runs: this CLI's `watch`, through env so it gets
// the caller's PATH (hc, git, lsof, ps) and app home.
export function watcherCommand({ node = process.execPath, cli = CLI_PATH, env = process.env } = {}) {
  const pass = ["PATH", "HERDR_APP_HOME"].filter((k) => typeof env[k] === "string" && env[k] !== "").map((k) => `${k}=${env[k]}`);
  return ["/usr/bin/env", ...pass, node, cli, "watch"];
}

// hc's answer as { value } (its JSON), { missing } (no such terminal) or
// { error } (hc couldn't say). `hc(args)` is the CLI's exec shape.
async function hcJson(hc, args) {
  let r;
  try {
    r = await hc(args);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  const json = parseJson(r.stdout) ?? parseJson(r.stderr);
  if (r.code === 0 && json && !json.error) return { value: json };
  if (r.code === 3 || json?.error?.kind === "not_found") return { missing: true };
  return { error: String(json?.error?.message ?? (r.stderr || `hc exited ${r.code}`)).trim() };
}

/**
 * Whether the recorded watcher runs: "live" (its terminal is live and
 * carries the watch label), "gone", or "unknown" (hc couldn't say: doubt is
 * never death).
 */
export async function watcherLook(record, { hc }) {
  if (!record || typeof record.terminal !== "string" || !record.terminal) return "gone";
  const got = await hcJson(hc, ["get", record.terminal, "--json"]);
  if (got.error) return "unknown";
  if (got.missing) return "gone";
  const t = got.value;
  return t.state === "live" && isObject(t.labels) && t.labels[WATCH_LABEL] != null ? "live" : "gone";
}

/**
 * `spotlight watch --ensure`. deps: { lock, read, write } (watchStore's),
 * hc(args) → { code, stdout, stderr }, identity, argv (watcherCommand's),
 * cwd, now(). → { action: "running" | "started" | "replaced" | "unknown" |
 * "failed", terminal?, replaced?, message? }. "unknown": hc couldn't read
 * the recorded terminal, so nothing is started over it.
 */
export async function ensureWatcher(deps) {
  return deps.lock(async () => {
    const record = deps.read();
    const look = record ? await watcherLook(record, deps) : "gone";
    if (look === "unknown") return { action: "unknown", terminal: record.terminal };
    if (look === "live" && record.identity === deps.identity) return { action: "running", terminal: record.terminal };
    // Another build's: its terminal goes (hangup, then escalate); with --rm, so does the terminal.
    if (look === "live") await hcJson(deps.hc, ["kill", record.terminal, "--json"]);
    const made = await hcJson(deps.hc, [
      "run", "--bg", "--no-parent", "--rm", "--label", `${WATCH_LABEL}=1`, "--cwd", deps.cwd, "--json", "--", ...deps.argv,
    ]);
    const address = made.value?.address;
    if (typeof address !== "string" || !address) {
      // Nothing runs for the record any more: the next ensure tries again.
      deps.write(null);
      return { action: "failed", message: made.error ?? "hc run printed no address" };
    }
    deps.write({ version: 1, terminal: address, pid: null, identity: deps.identity, at: deps.now() });
    return look === "live" ? { action: "replaced", terminal: address, replaced: record.terminal } : { action: "started", terminal: address };
  });
}

// Whether a record names this watcher: its terminal ($HC_TERMINAL_ID), or,
// run outside hc, its pid.
export const mineOf = (me) => (record) =>
  Boolean(record) && (me.terminal ? record.terminal === me.terminal : record.pid === me.pid);

/**
 * The watcher's claim at start, under the lock: the record ensure wrote for
 * its terminal gets its pid; with no record, or one whose watcher is gone,
 * it records itself. False when another watcher's record stands (live, or
 * hc can't say).
 */
export async function claimWatch(store, me, { identity, now, hc }) {
  return store.lock(async () => {
    const record = store.read();
    if (mineOf(me)(record)) {
      store.write({ ...record, pid: me.pid });
      return true;
    }
    if (record && (await watcherLook(record, { hc })) !== "gone") return false;
    store.write({ version: 1, terminal: me.terminal, pid: me.pid, identity, at: now });
    return true;
  });
}

/**
 * The watcher letting go, under the lock: "replaced" when the record no
 * longer names it (left as it is); null when `idle()`, asked there, says
 * something is lit again (it keeps running); else it removes its record:
 * "idle".
 */
export async function releaseWatch(store, me, { idle }) {
  return store.lock(async () => {
    if (!mineOf(me)(store.read())) return "replaced";
    if (!idle()) return null;
    store.write(null);
    return "idle";
  });
}

// ── The loop ───────────────────────────────────────────────────────────────

/**
 * Nothing for the watcher to do: no repo has a holder, the queue has no
 * request (waiting, holding or paused) and no lighting marker is at work
 * (a light spawned a moment ago, or whose pid lives: a toggle's, before it
 * wrote its holder).
 */
export function watchIdle(state, { now, pidAlive: alive }) {
  if (!isObject(state)) return true;
  const repos = isObject(state.repos) ? Object.values(state.repos) : [];
  if (repos.some((r) => typeof r?.holder === "string" && r.holder !== "")) return false;
  const q = isObject(state.queue) ? state.queue : {};
  if (Array.isArray(q.requests) && q.requests.length > 0) return false;
  const lighting = isObject(q.lighting) ? Object.values(q.lighting) : [];
  return !lighting.some((m) => isObject(m) && lightAlive(m, { now, pidAlive: alive }));
}

// One terminal's line: its state, status, turn and foreground pid; gone and
// unreadable said apart. A title or the screen never moves it.
function lookLine(t, got) {
  if (!got || got.error) return `${t}|?`;
  if (got.missing || !isObject(got.terminal)) return `${t}|gone`;
  const x = got.terminal;
  return [t, x.state ?? "", JSON.stringify(x.status ?? null), x.turn ?? "", x.foreground?.pid ?? ""].join("|");
}

/** The targets' looks as one string, order-free. `look(t)` is hcGet's shape. */
export async function watchFingerprint(targets, look) {
  const ids = [...new Set((Array.isArray(targets) ? targets : []).filter((t) => typeof t === "string" && t))];
  const lines = await Promise.all(
    ids.map(async (t) => {
      let got;
      try {
        got = await look(t);
      } catch (e) {
        got = { error: String(e?.message ?? e) };
      }
      return lookLine(t, got);
    }),
  );
  return lines.sort().join("\n");
}

// reapTargets over a state that may lack a queue or repos.
function targetsOf(state) {
  const queue = isObject(state?.queue) ? state.queue : {};
  return reapTargets({
    queue: { requests: Array.isArray(queue.requests) ? queue.requests : [] },
    repos: isObject(state?.repos) ? state.repos : {},
  });
}

/**
 * The watcher's loop, until it is replaced, stopped or idle. deps:
 *   readState()                     state.json, parsed
 *   look(t)                         hcGet's answer for one terminal
 *   reap()                          `spotlight reap`, awaited (never two at once)
 *   sync(root)                      the detached automatic sync
 *   watchFolder(holder, onPath, onGone) → { close() }; throws when it can't
 *   isDirectory(path), after(ms, fn) → { cancel() }, sleep(ms), now()
 *   pidAlive(pid), stillMine(), release() → "idle" | "replaced" | null
 *   stopped()                       a signal asked it to stop
 *   log(text)
 * → { reason: "idle" | "replaced" | "stopped" }. Its watches close and a
 * pending sync is dropped on the way out.
 */
export async function runWatcher(deps) {
  const log = deps.log ?? (() => {});
  const watches = new Map(); // holder → { root, handle }
  const failed = new Set(); // holders whose watch couldn't start, logged once
  const bounce = debouncer(deps.after, SYNC_DEBOUNCE_MS);
  let lastPrint = null;
  let lastReapAt = null;
  // Whether a full reap ran since the loop last saw something lit or queued
  // (J-003): a light that died unfinished leaves its busy mark or lighting
  // marker for a reap, and an idle watcher reaps once more before it goes.
  let reapedSinceBusy = false;

  // `spotlight reap`, awaited; a failure is logged, never the loop's end.
  const fullReap = async () => {
    lastReapAt = deps.now();
    reapedSinceBusy = true;
    try {
      await deps.reap();
    } catch (e) {
      log(`reap: ${e?.message ?? e}`);
    }
  };

  const forget = (holder, entry) => {
    if (watches.get(holder) !== entry) return;
    watches.delete(holder);
    try {
      entry.handle?.close();
    } catch {
      // Already closed.
    }
  };

  // One watch per holder state.json names; a holder no longer holding (or
  // now another repo's) loses its watch. A watch that couldn't start is
  // tried again on the next tick.
  const follow = (state) => {
    const want = new Map(watchTargets(state).map((t) => [t.holder, t.root]));
    for (const [holder, entry] of [...watches]) {
      if (want.get(holder) !== entry.root) forget(holder, entry);
    }
    for (const [holder, root] of want) {
      if (watches.has(holder)) continue;
      const entry = { root, handle: null };
      const onPath = (p) => {
        if (watches.get(holder) !== entry) return;
        if (shouldSync([{ path: p, isDirectory: () => deps.isDirectory(p) }], holder)) bounce(root, () => deps.sync(root));
      };
      try {
        entry.handle = deps.watchFolder(holder, onPath, () => forget(holder, entry));
      } catch (e) {
        if (!failed.has(holder)) log(`can't watch ${holder}: ${e?.message ?? e}`);
        failed.add(holder);
        continue;
      }
      failed.delete(holder);
      watches.set(holder, entry);
    }
  };

  try {
    for (;;) {
      if (deps.stopped()) return { reason: "stopped" };
      if (!deps.stillMine()) return { reason: "replaced" };
      let state = null;
      try {
        state = deps.readState();
      } catch (e) {
        log(`can't read state.json: ${e?.message ?? e}`);
      }
      if (state) {
        follow(state);
        const print = await watchFingerprint(targetsOf(state), deps.look);
        const changed = lastPrint !== null && print !== lastPrint;
        lastPrint = print;
        if (changed || lastReapAt === null || deps.now() - lastReapAt >= WATCH_FULL_REAP_MS) await fullReap();
        if (deps.stopped()) return { reason: "stopped" };
        let idle = false;
        try {
          idle = watchIdle(deps.readState(), { now: deps.now(), pidAlive: deps.pidAlive });
        } catch {
          // Unreadable: not idle, look again next tick.
        }
        if (!idle) reapedSinceBusy = false;
        else {
          // The last full reap first, unless one ran since it last saw
          // something lit or queued; the release re-checks idle under the lock.
          if (!reapedSinceBusy) {
            await fullReap();
            if (deps.stopped()) return { reason: "stopped" };
          }
          const released = await deps.release();
          if (released) return { reason: released };
          // Lit or queued again under the lock.
          reapedSinceBusy = false;
        }
      }
      await deps.sleep(WATCH_TICK_MS);
    }
  } finally {
    bounce.cancelAll();
    for (const [holder, entry] of [...watches]) forget(holder, entry);
  }
}

// ── Node's world ───────────────────────────────────────────────────────────

// Node's recursive fs.watch on a holder: onPath(absolute path) per event,
// the holder itself when Node gives no name (an overflow); onGone() once the
// watch fails. Throws when the folder can't be watched (it's gone).
export function watchFolderNode(holder, onPath, onGone) {
  const watcher = fs.watch(holder, { recursive: true }, (_type, name) => {
    onPath(name ? path.join(holder, String(name)) : holder);
  });
  watcher.on("error", () => {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    onGone();
  });
  return { close: () => watcher.close() };
}

export function isDirectoryNode(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const hcExec = (args) => exec("hc", args, { timeoutMs: HC_TIMEOUT_MS });

// ensureWatcher's real world, from the CLI's context.
export function nodeEnsureDeps(cx, { env = process.env } = {}) {
  return {
    ...watchStore(cx.store.paths.stateDir),
    hc: hcExec,
    identity: watchIdentity(),
    argv: watcherCommand({ env }),
    cwd: os.homedir(),
    now: Date.now,
  };
}

export const ensureWatch = (cx) => ensureWatcher(nodeEnsureDeps(cx));

function logLine(text) {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

/**
 * `spotlight watch`: claims the record, runs the loop over the real world,
 * and drops its record when a signal stopped it. → { reason }: "idle",
 * "replaced", "stopped", or "another" (another watcher's record stands).
 */
export async function watchMain(cx, { env = process.env } = {}) {
  const store = watchStore(cx.store.paths.stateDir);
  const me = { terminal: String(env.HC_TERMINAL_ID ?? "").trim() || null, pid: process.pid };
  const mine = mineOf(me);
  if (!(await claimWatch(store, me, { identity: watchIdentity(), now: Date.now(), hc: hcExec }))) return { reason: "another" };
  logLine(`spotlight watch: watching (pid ${process.pid}${me.terminal ? `, ${me.terminal}` : ""})`);

  let stop = false;
  let wake = null;
  const onSignal = () => {
    stop = true;
    wake?.();
  };
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const s of SIGNALS) process.on(s, onSignal);
  const sleepUnlessStopped = (ms) =>
    new Promise((resolve) => {
      if (stop) return resolve();
      const done = () => {
        wake = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  try {
    const r = await runWatcher({
      readState: () => cx.store.readState(),
      look: hcGet,
      reap: async () => {
        const out = await exec(process.execPath, [CLI_PATH, "reap"], { timeoutMs: REAP_TIMEOUT_MS });
        if (out.code !== 0) logLine(`reap exited ${out.code}: ${out.stderr.trim()}`);
      },
      sync: (root) => {
        spawnDetached(syncArgs(root));
      },
      watchFolder: watchFolderNode,
      isDirectory: isDirectoryNode,
      after: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(timer) };
      },
      sleep: sleepUnlessStopped,
      now: Date.now,
      pidAlive,
      stillMine: () => mine(store.read()),
      release: async () => {
        try {
          return await releaseWatch(store, me, { idle: () => watchIdle(cx.store.readState(), { now: Date.now(), pidAlive }) });
        } catch (e) {
          // The lock never came: look again next tick.
          logLine(`release: ${e?.message ?? e}`);
          return null;
        }
      },
      stopped: () => stop,
      log: logLine,
    });
    if (r.reason === "stopped") {
      try {
        await store.lock(async () => {
          if (mine(store.read())) store.write(null);
        }, { timeoutMs: 2_000 });
      } catch {
        // The lock never came: the next ensure finds the terminal gone.
      }
    }
    return r;
  } finally {
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}
