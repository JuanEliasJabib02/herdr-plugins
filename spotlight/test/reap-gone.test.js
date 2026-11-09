// T24 (D34, S21): a lit repo's server that ends by hand. Since T29 (D38) the
// server runs in the root's "Spotlight" tab, so closing that tab (or its
// space) ends its terminal (`gone`), and a Ctrl-C typed there stops only the
// server (`stopped`). When the reap or `spotlight on` sees a server go
// `listening` → `gone` or `listening` → `stopped`, cli-work.mjs
// settleServerEnd re-reads the record and the terminal under the repo lock
// and, only while the record still says `listening`, writes the new state and
// one toast note in one write; the toast's click opens the server popup,
// which on `gone` has no Ver server and keeps Reiniciar and Apagar. A
// restart in flight holds that lock, so it is never taken for a stop;
// `starting` → `stopped` stays D25's dead start.
//
// The fake cx is reconcile-orca.test.js's: a real git root the holder's
// workspace is projected onto (the reap's reconcile reads its refs), an
// in-memory store, server.js's look stubbed (cx.server) with the shapes it
// answers, and a fake `ps`. Its repo lock models the real store's: held, the
// reap's store gives up (its 300 ms) and the CLI's store gives up only when
// the call names a timeout; a call that would wait fails the test.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

import * as work from "../mods/spotlight/cli-work.mjs";
import { planGit } from "../mods/spotlight/cli-env.mjs";
import { activate, gitContext } from "../mods/spotlight/sync.js";
import { emptyRepo } from "../mods/spotlight/store.js";
import { LockError } from "../mods/spotlight/locks.js";
import { nodeIo } from "../mods/spotlight/server-plan.js";
import { readSettings, readState, cliPathOf, toastMark, takeToasts } from "../mods/spotlight/board-model.js";
import { serverViewModel } from "../mods/spotlight/server-view-model.js";
import { buildBadges } from "../mods/spotlight/badges-model.js";
import { unwrapEnv } from "./fake-ps.mjs";

// Destructured, not named in the imports: a helper that's missing fails its
// own tests, not the whole file's load.
const { reap, describeServer, recordServers, serverId } = work;

const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), "t24-gitcfg-")));
writeFileSync(join(CONFIG_DIR, "gitconfig"), "[user]\n\tname = Test\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(CONFIG_DIR, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const BIN = cliPathOf("/app");
const SETTINGS = readSettings(JSON.stringify({ version: 1 }));
// A server process the reap and `on` saw, kept for the turn-off (F1).
const P3000 = { pid: 50011, start: "Sat Nov  8 10:00:00 2026", port: 3000 };

// The root, its workspace projected there (refs active: the reap's
// reconcile keeps the record), made once: no test moves the root.
let base, root, wt, snapshot;
before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "t24-")));
  root = join(base, "landing");
  wt = join(base, "ax-1");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "orig\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "init");
  run(root, "worktree", "add", "-q", wt, "-b", "ax-1");
  write(wt, "a.txt", "herdr\n");
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
});
after(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

// What server.js readServerState answers for t1 (the root's Spotlight tab).
const look = (state, over = {}) => ({
  terminal: state === "gone" ? null : "t1", owner: null, pid: null, state, ports: [], procs: [], port: null, url: null, label: "", ...over,
});
const LISTENING = look("listening", { owner: "spotlight", pid: 50010, ports: [3000], procs: [P3000], port: 3000, url: "http://localhost:3000", label: ":3000" });
const STARTING = look("starting", { owner: "spotlight", pid: 50020 });
// The shell is back at its prompt (a Ctrl-C typed in the tab, or the
// interrupt of a restart in flight).
const STOPPED = look("stopped");
// The tab, or its space, was closed: no terminal.
const GONE = look("gone");

let state, cx, live, held, onLock, lockCalls;

// A fake `ps` that says P3000 still runs (ports.js goneIdentities).
async function psExec(rawFile, rawArgs) {
  const { file, args } = unwrapEnv(rawFile, rawArgs);
  if (file !== "ps") return { code: 1, stdout: "", stderr: `no fake ${file}` };
  const pids = args[args.indexOf("-p") + 1].split(",").map(Number).filter((p) => p === P3000.pid);
  return { code: pids.length > 0 ? 0 : 1, stdout: pids.map((p) => `${p} 1 S ${P3000.start}\n`).join(""), stderr: "" };
}

// The in-memory store, its repo lock as the real one's: a root in `held` is
// someone else's (a restart in flight). The reap's store (`giveUp`) gives up
// on it at once, as its 300 ms default; the CLI's store gives up only when the
// call names a timeout (opts.timeoutMs) and would otherwise wait for the
// restart to end, which these tests never let happen. `onLock`: what the
// holder did before the lock came free (run as the CLI's store takes it).
function storeOf({ giveUp }) {
  return {
    readState: () => structuredClone(state),
    withRepoLock: async (r, fn, opts = {}) => {
      lockCalls.push({ store: giveUp ? "reap" : "cli", root: r, opts });
      if (held.has(r)) {
        if (giveUp || Number.isFinite(opts.timeoutMs)) throw new LockError("lock-timeout", "held by a restart");
        throw new Error("the CLI's store would wait for the restart to end");
      }
      if (!giveUp) onLock?.();
      return fn();
    },
    updateState: async (fn) => ({ result: fn(state) }),
    settingsSavedAt: () => 0,
  };
}

beforeEach(() => {
  state = {
    version: 1,
    repos: {
      [root]: {
        ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot, serverTerminal: "t1", serverPid: 50010, serverStartedAt: 5,
        serverCommand: "npm run dev --", serverEnv: "local", serverState: "listening", ports: [3000], serverProcs: [P3000],
        logPath: join(base, "landing.log"),
      },
    },
    queue: { requests: [], lighting: {} },
    notes: [],
  };
  live = LISTENING;
  held = new Set();
  onLock = null;
  lockCalls = [];
  let now = 1000;
  cx = {
    store: storeOf({ giveUp: false }),
    reapStore: storeOf({ giveUp: true }),
    shared: {},
    now: () => now++,
    gitCtx: gitContext(),
    planGit,
    nameOf: (r) => basename(r),
    settings: SETTINGS,
    io: nodeIo(fsp),
    serverDeps: { exec: psExec },
    server: { readServerState: async () => structuredClone(live), serverTerminalHidden: async () => false },
    spawn: (argv) => {
      throw new Error(`nothing is spawned here: ${argv.join(" ")}`);
    },
  };
});

const GONE_TEXT = "Cerraste la terminal del server de landing: Spotlight sigue prendido.";
const STOPPED_TEXT = "El server de landing se detuvo: Spotlight sigue prendido.";
const texts = () => state.notes.map((n) => n.text);

// `spotlight on`'s look and write: describeServer, then recordServers.
async function onLooks() {
  const member = { root, name: "landing", workspace: wt, workspaces: [wt] };
  const seen = await describeServer(cx, cx.store.readState(), member, "g1/AX-1");
  await recordServers(cx, [seen]);
}

test("listening → gone: one 'Cerraste la terminal del server de <repo>…' toast whose click opens the server popup, which has no Ver server and keeps Reiniciar and Apagar; the next reaps add none", async () => {
  live = GONE;
  await reap(cx);
  const rec = state.repos[root];
  assert.equal(rec.serverState, "gone");
  assert.deepEqual(rec.ports, []);
  assert.equal(rec.holder, wt, "Spotlight stays on");
  assert.deepEqual(rec.serverProcs, [P3000], "the turn-off still kills what escaped (F1)");
  assert.deepEqual(state.notes, [
    { at: state.notes[0].at, repo: root, text: GONE_TEXT, toast: true, action: { name: `spotlight.server.${serverId(wt)}` }, title: "Spotlight · landing" },
  ]);
  // Decided under the repo lock, with a give-up: never waiting on a restart.
  const settle = lockCalls.filter((c) => c.store === "cli");
  assert.equal(settle.length, 1);
  assert.ok(Number.isFinite(settle[0].opts.timeoutMs) && settle[0].opts.timeoutMs <= 300, JSON.stringify(settle[0].opts));

  // The footer posts it with its action; the action resolves to the holder's
  // row, so the click opens the server popup of this repo (badges.js handleCommand).
  const mod = readState(JSON.stringify(state));
  const { toasts } = takeToasts(mod.notes, toastMark(0));
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body, GONE_TEXT);
  assert.equal(toasts[0].action.name, `spotlight.server.${serverId(wt)}`);
  const { servers } = buildBadges({ state: mod, settings: SETTINGS, bin: BIN });
  assert.deepEqual(servers[serverId(wt)], { workspace: wt, root });
  const popup = serverViewModel({ state: mod, settings: SETTINGS, repo: root, workspace: wt, detection: null, bin: BIN });
  assert.deepEqual(popup.actions.map((a) => [a.id, a.label]), [["restart", "Reiniciar"], ["off", "Apagar"]]);
  assert.deepEqual(popup.actions[0].argv, [BIN, "restart", "--repo", root]);
  assert.deepEqual(popup.actions[1].argv, [BIN, "toggle", "--workspace", wt]);

  await reap(cx);
  await reap(cx);
  assert.deepEqual(texts(), [GONE_TEXT]);
  assert.equal(state.repos[root].serverState, "gone");
});

test("gone → listening → gone: a second toast (Reiniciar made the tab again, the server listened, the tab was closed again)", async () => {
  live = GONE;
  await reap(cx);
  assert.deepEqual(texts(), [GONE_TEXT]);
  // Reiniciar: a new terminal and start, then the reap sees it listen.
  Object.assign(state.repos[root], { serverTerminal: "t9", serverState: "starting", serverStartedAt: 9, serverPid: 50020 });
  live = STARTING;
  await reap(cx);
  live = LISTENING;
  await reap(cx);
  assert.equal(state.repos[root].serverState, "listening");
  assert.deepEqual(texts(), [GONE_TEXT]);
  live = GONE;
  await reap(cx);
  await reap(cx);
  assert.deepEqual(texts(), [GONE_TEXT, GONE_TEXT]);
  assert.equal(state.repos[root].serverState, "gone");
});

test("listening → stopped: one 'El server de <repo> se detuvo…' toast that opens the popup; the next reaps add none", async () => {
  live = STOPPED;
  await reap(cx);
  const rec = state.repos[root];
  assert.equal(rec.serverState, "stopped");
  assert.deepEqual(rec.ports, []);
  assert.equal(rec.holder, wt);
  assert.deepEqual(texts(), [STOPPED_TEXT]);
  assert.deepEqual(state.notes[0].action, { name: `spotlight.server.${serverId(wt)}` });
  assert.equal(rec.lastError, null, "no server error: it didn't die at start");
  // Its terminal is still there: Ver server stays.
  const popup = serverViewModel({ state: readState(JSON.stringify(state)), settings: SETTINGS, repo: root, workspace: wt, detection: null, bin: BIN });
  assert.deepEqual(popup.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"]);
  await reap(cx);
  await reap(cx);
  assert.deepEqual(texts(), [STOPPED_TEXT]);
});

test("a sync's install restart seen in the middle (record `listening`, terminal at its prompt, the repo lock held) gives none, and neither does the server it starts", async () => {
  // The restart interrupted the server and holds the lock while it types the
  // new line: the reap reads the prompt over a record still `listening`.
  held.add(root);
  live = STOPPED;
  await reap(cx);
  assert.deepEqual(texts(), []);
  assert.equal(state.repos[root].serverState, "listening", "left for the next look");
  assert.deepEqual(state.repos[root].ports, [3000]);
  // The restart wrote its start and let go: the next looks see a new start.
  Object.assign(state.repos[root], { serverState: "starting", serverStartedAt: 9, serverPid: 50020, ports: [] });
  held.delete(root);
  live = STARTING;
  await reap(cx);
  live = LISTENING;
  await reap(cx);
  assert.deepEqual(texts(), []);
  assert.equal(state.repos[root].serverState, "listening");

  // The lock comes free just as the restart writes its start: re-read under
  // the lock, the record no longer says `listening`, so no toast and no write
  // over the restart's.
  live = STOPPED;
  onLock = () => Object.assign(state.repos[root], { serverState: "starting", serverStartedAt: 11, serverPid: 50030, ports: [] });
  await reap(cx);
  assert.deepEqual(texts(), []);
  assert.equal(state.repos[root].serverState, "starting");
  assert.equal(state.repos[root].serverStartedAt, 11);
});

test("a stop that `on`'s recordServers sees first still toasts once: the reap after it adds none", async () => {
  live = STOPPED;
  await onLooks();
  assert.equal(state.repos[root].serverState, "stopped");
  assert.deepEqual(texts(), [STOPPED_TEXT]);
  await onLooks();
  await reap(cx);
  await reap(cx);
  assert.deepEqual(texts(), [STOPPED_TEXT]);

  // The same for a closed tab, `on` first.
  state.repos[root].serverState = "listening";
  state.notes = [];
  live = GONE;
  await onLooks();
  await reap(cx);
  assert.equal(state.repos[root].serverState, "gone");
  assert.deepEqual(texts(), [GONE_TEXT]);
});

test("`on` seeing the stop while a restart holds the lock writes nothing over the record: no toast, still `listening` for the next look", async () => {
  held.add(root);
  live = STOPPED;
  await onLooks();
  assert.deepEqual(texts(), []);
  assert.equal(state.repos[root].serverState, "listening");
  assert.deepEqual(state.repos[root].ports, [3000]);
});

test("`starting` → `stopped` gives only D25's dead-start toast, by the reap or by `on`", async () => {
  for (const by of ["reap", "on"]) {
    Object.assign(state.repos[root], { serverState: "starting", serverStartedAt: 7, ports: [], lastError: null });
    state.notes = [];
    live = STOPPED;
    if (by === "reap") await reap(cx);
    else await onLooks();
    assert.equal(state.repos[root].serverState, "stopped", by);
    assert.equal(state.repos[root].lastError?.code, "server-exited", by);
    assert.equal(state.notes.length, 1, `${by}: ${JSON.stringify(texts())}`);
    assert.match(state.notes[0].text, /^landing: El server se cayó al arrancar/, by);
    await reap(cx);
    assert.equal(state.notes.length, 1, by);
  }
});

test("a server that keeps listening toasts nothing, by the reap or by `on` (their look as before)", async () => {
  await reap(cx);
  await onLooks();
  assert.deepEqual(texts(), []);
  assert.equal(state.repos[root].serverState, "listening");
  assert.deepEqual(state.repos[root].ports, [3000]);
});
