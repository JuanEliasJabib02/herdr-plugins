// T16 (D27), the reap's reconcile (cli-work.mjs reconcileFree): a root
// Orca's Spotlight took reads orca-holds, not root-diverged, and goes back to
// the usual rules once Orca lets go. Over the same real git and in-memory
// store: how a record's root and server errors stack (F6, F7), what the reap
// and `on` remember of the server's processes for the turn-off (F1, G3), a
// turn-off whose server didn't stop (F3, G4, G5, H5), what a lighting
// does with a server error (G1, H1–H3), and T20's busy mark (D33), quiet
// lights and turn-offs and the task batch marker (D31). server.js's reads
// and stop are stubbed (cx.server) with the shapes they answer; `ps` is a
// fake (psExec) answering for the pids a test says are alive. Review r5:
// K1–K3 (the server error a lighting leaves), K4/K5 (the turn-off leaves the
// stop's cause to stopServer), K6 (`on`'s merge follows its snapshot).
// Review r7: M1, M3, M5–M7 (a stuck restart, the merge rule, the lockfiles'
// base), M9 (the turn-off's fallback line). Review r8: N1–N4, N7 (what a
// stuck restart repeats, a given-up env under installs and asked syncs, a
// failed start over a server that may still run, a diverged root's base).
// Review r9: P1 (a forced sync's base over a diverged root), P3 (a restart
// whose Ctrl-C freed the prompt runs no server, whatever the next read says).
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import * as work from "../mods/spotlight/cli-work.mjs";
import * as errors from "../mods/spotlight/server-errors.js";
import { planGit } from "../mods/spotlight/cli-env.mjs";
import { activate, deactivate, gitContext } from "../mods/spotlight/sync.js";
import { emptyRepo } from "../mods/spotlight/store.js";
import { readSettings } from "../mods/spotlight/board-model.js";
import { nodeIo, planServer } from "../mods/spotlight/server-plan.js";
import { repoSettings } from "../mods/spotlight/settings.js";
import { serverViewModel } from "../mods/spotlight/server-view-model.js";
import { buildBadges } from "../mods/spotlight/badges-model.js";
import { cliPathOf } from "../mods/spotlight/board-model.js";
import { serverTerminalName } from "../mods/spotlight/server.js";
import { unwrapEnv } from "./fake-ps.mjs";

// Destructured, not named in the imports: a helper that's missing fails its
// own tests, not the whole file's load.
const {
  reconcileFree, recordServers, syncRepo, deactivateRepo, reap, describeServer, rememberProcs, SERVER_PROCS_MAX, lightTask, errorNote,
  serverId, turnOffError, ensureServer, withTaskBatch,
} = work;
const { setRootError, setServerError, clearRootError, clearServerError, serverErrorOf, isServerError, TURN_OFF_ERRORS } = errors;

const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), "t16-gitcfg-")));
writeFileSync(join(CONFIG_DIR, "gitconfig"), "[user]\n\tname = Test\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(CONFIG_DIR, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
after(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function detachOnCommitBy(root, author, text) {
  write(root, "a.txt", text);
  run(root, "add", "-A");
  const tree = run(root, "write-tree");
  const sha = run(root, "-c", `user.name=${author}`, "-c", "user.email=x@y", "commit-tree", tree, "-p", "HEAD", "-m", `${author} snapshot`);
  run(root, "checkout", "-q", "--detach");
  run(root, "reset", "-q", "--hard", sha);
  return sha;
}

const MSG = "Este root lo tiene el Spotlight de Orca: apágalo allá primero.";
let base, root, wt, state, cx, snapshot;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "t16-")));
  root = join(base, "root");
  wt = join(base, "wt");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "orig\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "init");
  run(root, "worktree", "add", "-q", wt, "-b", "feature");
  write(wt, "a.txt", "herdr\n");
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state = { version: 1, repos: { [root]: { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot } }, queue: { requests: [], lighting: {} }, notes: [] };
  const store = {
    readState: () => structuredClone(state),
    withRepoLock: async (_root, fn) => fn(),
    updateState: async (fn) => ({ result: fn(state) }),
    settingsSavedAt: () => 0,
  };
  let now = 1000;
  cx = { reapStore: store, store, shared: {}, now: () => now++ };
});

// A fake `ps -o pid=,ppid=,stat=,lstart= -p <list>` (ports.js processStates):
// it lists the pids of `alive` (pid → start time, as ps prints it) and no
// other. `calls` keeps each call's program and args (unwrapEnv's), the env
// words it ran under (G2, H7) and any exec options it was given.
function psExec(alive) {
  const calls = [];
  const exec = async (rawFile, rawArgs, opts) => {
    const { file, args, env } = unwrapEnv(rawFile, rawArgs);
    calls.push({ file, args, env, opts });
    if (file !== "ps") return { code: 1, stdout: "", stderr: `no fake ${file}` };
    const pids = args[args.indexOf("-p") + 1].split(",").map(Number).filter((p) => alive.has(p));
    const rows = pids.map((p) => `${p} 1 S ${alive.get(p)}\n`);
    return { code: rows.length > 0 ? 0 : 1, stdout: rows.join(""), stderr: "" };
  };
  return { exec, calls };
}

// The cx a sync, a turn-off or a reap needs beyond the reconcile's. Its ps
// says the F1 processes (P3000, P3001) still run.
const fullCx = (over = {}) => ({
  ...cx, gitCtx: gitContext(), planGit, nameOf: () => "root", settings: readSettings(JSON.stringify({ version: 1 })), io: nodeIo(fsp),
  serverDeps: { exec: psExec(new Map([[P3000.pid, P3000.start], [P3001.pid, P3001.start]])).exec },
  ...over,
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("Orca took the root while we held it: orca-holds, kept on the next reap, not flipped to root-diverged", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  const changes = await reconcileFree(cx);
  assert.deepEqual(changes, [{ root, action: "orca-holds" }]);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
  assert.equal(state.repos[root].lastError.message, MSG);
  assert.equal(state.repos[root].holder, wt);
  const at = state.repos[root].lastError.at;
  assert.deepEqual(await reconcileFree(cx), []);
  assert.equal(state.repos[root].lastError.at, at);
});

test("a record an older reap flagged root-diverged becomes orca-holds", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  state.repos[root].lastError = { code: "root-diverged", message: "El root se movió del snapshot de Spotlight.", at: 1 };
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
});

test("Orca let go back to our snapshot: the error goes, the holder stays", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  run(root, "reset", "-q", "--hard", snapshot);
  assert.deepEqual(await reconcileFree(cx), [{ root, action: "cleared" }]);
  assert.equal(state.repos[root].lastError, null);
  assert.equal(state.repos[root].holder, wt);
  assert.deepEqual(await reconcileFree(cx), []);
});

test("Orca let go somewhere else: root-diverged, as for any moved root", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  run(root, "reset", "-q", "--hard", "main");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "root-diverged");
});

test("someone else's detached commit is still root-diverged", async () => {
  detachOnCommitBy(root, "Someone Else", "else\n");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "root-diverged");
});

test("our refs with no record while Orca holds: orca-holds, then orphan-refs once Orca lets go", async () => {
  delete state.repos[root];
  cx.shared = { "projects.v1": { groups: [{ projects: [{ path: root }] }] } };
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
  assert.equal(state.repos[root].holder, null);
  assert.equal(state.repos[root].lastSnapshotSha, snapshot);
  run(root, "reset", "-q", "--hard", snapshot);
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orphan-refs");
});

// R8: Orca taking the root used to drop a server error that still applied
// (a busy port, a death at start: D24, D25), and Orca letting go left no
// error at all. orca-holds keeps it, and gives it back then, unless the
// server came up meanwhile.
const BUSY = { code: "port-busy", port: 3008, pid: null, command: null, cwd: null, message: "El puerto 3008 estaba ocupado al arrancar el server.", at: 7 };

test("a server error Orca's hold covers comes back once Orca lets go", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
  assert.equal(state.repos[root].lastError.message, MSG);
  run(root, "reset", "-q", "--hard", snapshot);
  assert.deepEqual(await reconcileFree(cx), [{ root, action: "cleared" }]);
  assert.deepEqual(state.repos[root].lastError, BUSY);
  assert.equal(state.repos[root].holder, wt);
});

test("a server that comes up while Orca holds ends its error: nothing comes back once Orca lets go", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  await recordServers(cx, [{ root, lit: true, serverState: "listening", ports: [3008] }]);
  assert.equal(state.repos[root].lastError.code, "orca-holds", "Orca still has the root");
  run(root, "reset", "-q", "--hard", snapshot);
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError, null);
});

test("a sync that goes through once Orca let go, before any reap, gives the kept server error back too (a sync leaves server errors)", async () => {
  const held = { code: "orca-holds", message: MSG, at: 9, serverError: BUSY };
  Object.assign(state.repos[root], { serverState: "stopped", lastError: held });
  const sx = { ...cx, gitCtx: gitContext(), planGit, nameOf: () => "root" };
  // Nothing new in the holder: the no-op sync.
  assert.equal((await syncRepo(sx, root)).skipped, true);
  assert.deepEqual(state.repos[root].lastError, BUSY);
  // An edit in the holder: a sync that runs.
  state.repos[root].lastError = held;
  write(wt, "a.txt", "edited\n");
  const r = await syncRepo(sx, root);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.deepEqual(state.repos[root].lastError, BUSY);
});

// F6, F7: a record carries one root error and one server error at most. The
// root error is on top, with the server error under it (its serverError);
// each kind is written and cleared on its own, whatever the other does.
const ORCA = { code: "orca-holds", message: MSG, at: 9 };
const DIVERGED = { code: "root-diverged", message: "El root se movió del snapshot de Spotlight.", at: 1 };
const FAILED = { code: "git-failed", message: "git exploded", at: 2 };
const EXITED = { code: "server-exited", message: "El server se cayó al arrancar.", at: 3 };
const rec = (lastError) => ({ lastError });

test("the record's two errors: a root error over a server error keeps it under it, a server error over a root error goes under it; each clears its own", () => {
  // Any root error over a server error, also written again over itself.
  for (const root of [ORCA, DIVERGED, FAILED]) {
    assert.deepEqual(setRootError(rec(BUSY), root).lastError, { ...root, serverError: BUSY }, root.code);
    assert.deepEqual(setRootError(rec({ ...root, serverError: BUSY }), { ...root, at: 10 }).lastError, { ...root, at: 10, serverError: BUSY });
  }
  // A root error replaces a root error; the server error under it stays.
  assert.deepEqual(setRootError(rec({ ...ORCA, serverError: BUSY }), DIVERGED).lastError, { ...DIVERGED, serverError: BUSY });
  assert.deepEqual(setRootError(rec(DIVERGED), ORCA).lastError, ORCA);
  assert.deepEqual(setRootError(rec(null), ORCA).lastError, ORCA);
  // A server error over a root error goes under it, replacing the one there.
  assert.deepEqual(setServerError(rec(ORCA), BUSY).lastError, { ...ORCA, serverError: BUSY });
  assert.deepEqual(setServerError(rec({ ...ORCA, serverError: BUSY }), EXITED).lastError, { ...ORCA, serverError: EXITED });
  // Over a server error or none: on top.
  assert.deepEqual(setServerError(rec(BUSY), EXITED).lastError, EXITED);
  assert.deepEqual(setServerError(rec(null), EXITED).lastError, EXITED);
  // Clearing the root error gives the server error back; a server error on top stays.
  assert.deepEqual(clearRootError(rec({ ...DIVERGED, serverError: BUSY })).lastError, BUSY);
  assert.equal(clearRootError(rec(DIVERGED)).lastError, null);
  assert.deepEqual(clearRootError(rec(BUSY)).lastError, BUSY);
  assert.equal(clearRootError(rec(null)).lastError, null);
  // Clearing the server error, wherever it is; a root error on top stays.
  assert.equal(clearServerError(rec(BUSY)).lastError, null);
  assert.deepEqual(clearServerError(rec({ ...ORCA, serverError: BUSY })).lastError, ORCA);
  assert.deepEqual(clearServerError(rec(ORCA)).lastError, ORCA);
  // The server error in force: on top, or under the root error.
  assert.deepEqual(serverErrorOf(BUSY), BUSY);
  assert.deepEqual(serverErrorOf({ ...ORCA, serverError: BUSY }), BUSY);
  assert.equal(serverErrorOf(ORCA), null);
  assert.equal(serverErrorOf(null), null);
});

test("F6: a sync refused over a server error keeps it under the root error; the Forzar sync that goes through gives it back", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  // An edit in the holder and a tracked edit made in the root: the sync refuses.
  write(wt, "b.txt", "new\n");
  write(root, "a.txt", "edited in the root\n");
  const sx = fullCx();
  const r = await syncRepo(sx, root);
  assert.equal(r.code, "root-diverged", JSON.stringify(r));
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.deepEqual(state.repos[root].lastError.serverError, BUSY);
  const forced = await syncRepo(sx, root, { force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(state.repos[root].lastError, BUSY);
});

test("F6: the reap's root-diverged over a server error keeps it under it, and keeps it on the next reap", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  detachOnCommitBy(root, "Someone Else", "else\n");
  assert.deepEqual(await reconcileFree(cx), [{ root, action: "diverged" }]);
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.deepEqual(state.repos[root].lastError.serverError, BUSY);
  assert.deepEqual(await reconcileFree(cx), []);
  assert.deepEqual(state.repos[root].lastError.serverError, BUSY);
});

test("F6: a turn-off refused over a server error keeps it under the root error", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  write(root, "a.txt", "edited in the root\n");
  const r = await deactivateRepo(fullCx(), root);
  assert.equal(r.code, "root-diverged", JSON.stringify(r));
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.deepEqual(state.repos[root].lastError.serverError, BUSY);
});

// ── F1: the server's processes, remembered for the turn-off ────────────────

// What server.js readServerState answers (procs: the listeners in the server
// terminal's tree, each with its start time), one look per call.
function looks(...list) {
  return async () => ({ terminal: "t1", owner: "spotlight", pid: 50010, port: null, url: null, label: "", ...list.shift() });
}
const P3000 = { pid: 50011, start: "Sat Nov  8 10:00:00 2026", port: 3000 };
const P3001 = { pid: 50012, start: "Sat Nov  8 10:05:00 2026", port: 3001 };

test("F1: the reap remembers every server process it saw since the last start; `ports` stays what listens now", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "starting", serverStartedAt: 5, serverPid: 50010 });
  const rx = fullCx({
    server: {
      readServerState: looks(
        { state: "listening", ports: [3000], procs: [P3000] },
        // An old child kept 3000 and left the tree: the server took 3001.
        { state: "listening", ports: [3001], procs: [P3001] },
      ),
    },
  });
  await reap(rx);
  assert.deepEqual(state.repos[root].serverProcs, [P3000]);
  assert.deepEqual(state.repos[root].ports, [3000]);
  await reap(rx);
  assert.deepEqual(state.repos[root].serverProcs, [P3000, P3001]);
  assert.deepEqual(state.repos[root].ports, [3001]);
});

test("F1: `on` remembers the server processes it saw too (describeServer, recordServers)", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "starting", serverStartedAt: 5, serverPid: 50010 });
  const ox = fullCx({
    server: { readServerState: looks({ state: "listening", ports: [3000], procs: [P3000] }, { state: "listening", ports: [3001], procs: [P3001] }) },
  });
  const member = { root, name: "root", workspace: wt, workspaces: [wt] };
  for (let i = 0; i < 2; i += 1) {
    const seen = await describeServer(ox, ox.store.readState(), member, "g1/AX-1");
    await recordServers(ox, [seen]);
  }
  assert.deepEqual(state.repos[root].serverProcs, [P3000, P3001]);
  assert.deepEqual(state.repos[root].ports, [3001]);
});

test("F1: rememberProcs dedupes by pid and start time, moves one seen again to the newest, keeps the newest SERVER_PROCS_MAX, and skips what isn't a process", () => {
  assert.equal(SERVER_PROCS_MAX, 32);
  // The same pid with another start time is another process (the pid was reused).
  const reused = { pid: P3000.pid, start: "Sat Nov  8 11:00:00 2026", port: 3000 };
  assert.deepEqual(rememberProcs([P3000], [reused]), [P3000, reused]);
  assert.deepEqual(rememberProcs([P3000, P3001], [{ ...P3000 }]), [P3001, P3000]);
  assert.deepEqual(rememberProcs(undefined, [P3000, P3000]), [P3000]);
  assert.deepEqual(rememberProcs([P3000], undefined), [P3000]);
  // G8: a start is a non-empty string, as the turn-off reads it (ports.js
  // knownIdentities): a numeric or blank one names no process.
  assert.deepEqual(
    rememberProcs([{ pid: 8, start: 99, port: 3000 }], [null, { pid: "x", start: "s" }, { pid: 5 }, { pid: 6, start: "" }, { pid: 7, start: 12, port: "3000" }, { pid: 9, start: " \t " }]),
    [],
  );
  assert.deepEqual(rememberProcs([], [{ pid: 7, start: "s7", port: "3000" }]), [{ pid: 7, start: "s7", port: null }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ pid: 60000 + i, start: `s${i}`, port: 4000 + i }));
  const kept = rememberProcs(many.slice(0, 20), many.slice(20));
  assert.equal(kept.length, SERVER_PROCS_MAX);
  assert.deepEqual(kept, many.slice(-SERVER_PROCS_MAX));
});

test("F1, G7: the turn-off hands stopServer every server process the record remembers, and as ports only the live ones (serverSnapshot adds the identities' own)", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", ports: [3001], serverProcs: [P3000, P3001] });
  let asked = null;
  const ox = fullCx({
    server: {
      stopServer: async (args) => {
        asked = args;
        return { ok: true, stopped: true, terminal: "t1", forced: 0 };
      },
    },
  });
  const r = await deactivateRepo(ox, root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(asked.procs, [P3000, P3001]);
  assert.deepEqual(asked.ports, [3001]);
  // A record that never saw one hands an empty list.
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot };
  await deactivateRepo(ox, root);
  assert.deepEqual(asked.procs, []);
});

// ── F3: a turn-off whose server didn't stop ────────────────────────────────

// stopServer's ok: false answers, with the English messages server.js gives
// them (G5: the toast says why in Spanish only, never these).
const STOP_FAILED = {
  interrupt: {
    ok: false, reason: "interrupt-failed", terminal: "t1", forced: 0,
    message: "the Ctrl-C could not be sent (hc: no route) and the terminal can't be read: the server may still be running",
  },
  running: {
    ok: false, reason: "still-running", terminal: "t1", forced: 1, pid: 50010,
    message: "Spotlight's server (pid 50010) still leads the terminal after it was killed: the server may still be running",
  },
  unreadable: {
    ok: false, reason: "unreadable", terminal: "t1",
    message: "the Spotlight terminal could not be read (no foreground): the server may still be running",
  },
};

test("F3, G5: a turn-off whose server didn't stop, for any reason, restores the root and is an error that says why in Spanish only, never 'root restaurado'", async () => {
  const cases = [
    [
      STOP_FAILED.interrupt,
      "server-not-stopped", "El server no paró al apagar Spotlight: hc no pudo mandarle Ctrl-C ni leer su terminal (el root sí se restauró).",
    ],
    [
      STOP_FAILED.running,
      "server-not-stopped", "El server no paró al apagar Spotlight: el proceso 50010 siguió corriendo en su terminal (el root sí se restauró).",
    ],
    [
      { ...STOP_FAILED.running, pid: undefined },
      "server-not-stopped", "El server no paró al apagar Spotlight: siguió corriendo en su terminal (el root sí se restauró).",
    ],
    [
      STOP_FAILED.unreadable,
      "server-not-stopped", "El server no paró al apagar Spotlight: hc no pudo leer su terminal (el root sí se restauró).",
    ],
    [
      { ok: false, reason: "a-new-reason", terminal: "t1", message: "something new: the server may still be running" },
      "server-not-stopped", "El server no paró al apagar Spotlight: Spotlight no pudo confirmar que paró (a-new-reason) (el root sí se restauró).",
    ],
    [
      { ok: false, reason: "survived", terminal: "t1", forced: 1, survivors: [50013] },
      "server-survived", "El server no paró al apagar Spotlight: el proceso 50013 siguió vivo después de SIGKILL (el root sí se restauró).",
    ],
    // A refused leftover (its tree holds the CLI or the terminal's shell) is
    // counted among the survivors, but it was never signalled.
    [
      { ok: false, reason: "survived", terminal: "t1", forced: 1, survivors: [50013, 50014], refused: [50014] },
      "server-survived",
      "El server no paró al apagar Spotlight: el proceso 50013 siguió vivo después de SIGKILL y el proceso 50014 no se pudo señalar (el root sí se restauró).",
    ],
  ];
  for (const [stopped, code, message] of cases) {
    if (!state.repos[root]) {
      snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
      state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot };
    }
    // The log stays under the test's folder (a header could land there).
    Object.assign(state.repos[root], { serverTerminal: "t1", logPath: join(base, "root.log") });
    state.notes = [];
    const r = await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root);
    assert.equal(r.ok, false, stopped.reason);
    assert.equal(r.code, code, stopped.reason);
    assert.equal(r.message, message);
    assert.doesNotMatch(r.message, /may still be running|could not|still leads/, stopped.reason);
    // G9: the turn-off's codes, never a record's server error.
    assert.ok(TURN_OFF_ERRORS?.has(r.code), r.code);
    assert.equal(isServerError({ code: r.code }), false, r.code);
    // The root is restored all the same, and Spotlight's record is gone.
    assert.equal(run(root, "symbolic-ref", "--short", "HEAD"), "main", stopped.reason);
    assert.equal(state.repos[root], undefined, stopped.reason);
    assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${message}`], stopped.reason);
  }
  // A server that stopped, or had nothing to stop: "root restaurado".
  for (const stopped of [{ ok: true, stopped: true, terminal: "t1", forced: 0 }, { ok: true, stopped: false, reason: "not-running", terminal: "t1" }]) {
    snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
    state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot, serverTerminal: "t1" };
    state.notes = [];
    const r = await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), ["Spotlight off — root restaurado"]);
  }
});

// ── G4: a turn-off whose server didn't stop and whose git step failed ──────

test("G4: a turn-off whose server didn't stop and whose restore then fails reports both in one toast, with the git error's code", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", logPath: join(base, "root.log") });
  const ox = fullCx({
    server: {
      stopServer: async () => {
        // The root changes while the server is being stopped: the restore refuses it.
        write(root, "a.txt", "edited in the root meanwhile\n");
        return { ok: false, reason: "survived", terminal: "t1", forced: 1, survivors: [50013] };
      },
    },
  });
  const r = await deactivateRepo(ox, root);
  const gitMessage = "El root tiene cambios hechos fuera del workspace de Spotlight. Apagar Spotlight los descartaría.";
  const both = `${gitMessage} Además, el server no paró: el proceso 50013 siguió vivo después de SIGKILL.`;
  assert.equal(r.ok, false);
  assert.equal(r.code, "root-diverged");
  assert.equal(r.message, both);
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${both}`]);
  // The record keeps the git error, the root error the popup acts on; the
  // server's never goes on a record (G9).
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.equal(state.repos[root].lastError.message, gitMessage);
  assert.equal(state.repos[root].lastError.serverError, undefined);
  // A server that stopped: the git error alone, as before.
  state.notes = [];
  state.repos[root].lastError = null;
  const plain = await deactivateRepo(fullCx({ server: { stopServer: async () => ({ ok: true, stopped: true, terminal: "t1", forced: 0 }) } }), root);
  assert.equal(plain.message, gitMessage);
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${gitMessage}`]);
});

// ── H5, K4/K5: the stop's own cause is stopServer's to log ─────────────────

test("H5, K4/K5: a turn-off whose server didn't stop leaves the cause to stopServer's own note (server.test.js): it writes no line of its own, and the toast and the error stay Spanish only", async () => {
  const logPath = join(base, "root.log");
  const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const cause = "the Spotlight terminal could not be read (hc: no route to core): the server may still be running";
  Object.assign(state.repos[root], { serverTerminal: "t1", logPath });
  // This stopServer stands in for server.js's, whose note (with this cause)
  // is the only line a failed stop leaves: the turn-off adds none.
  const r = await deactivateRepo(fullCx({ server: { stopServer: async () => ({ ok: false, reason: "unreadable", terminal: "t1", message: cause }) } }), root);
  assert.equal(r.code, "server-not-stopped");
  assert.doesNotMatch(r.message, /no route to core/);
  assert.ok(state.notes.filter((n) => n.toast).every((n) => !n.text.includes("no route to core")), JSON.stringify(state.notes));
  assert.equal(readLog(), "", "no second NOT stopped line");

  // The restore refused too (G4): still no line from the turn-off, whatever
  // stopServer answered, a Ctrl-C hc couldn't send included.
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot, serverTerminal: "t1", logPath };
  const running = {
    ok: false, reason: "still-running", terminal: "t1", forced: 1, pid: 50010, interruptError: "herdr-core\nunreachable",
    message: "Spotlight's server (pid 50010) still leads the terminal after it was killed: the server may still be running",
  };
  const refused = await deactivateRepo(fullCx({
    server: {
      stopServer: async () => {
        write(root, "a.txt", "edited in the root meanwhile\n");
        return running;
      },
    },
  }), root);
  assert.equal(refused.code, "root-diverged");
  assert.doesNotMatch(refused.message, /still leads|herdr-core/);
  assert.equal(readLog(), "");

  // Every other answer stopServer gives, a survivor whose Ctrl-C failed
  // included: nothing from the turn-off either.
  const ok = { ok: true, stopped: true, terminal: "t1", forced: 0 };
  assert.equal((await deactivateRepo(fullCx({ server: { stopServer: async () => ok } }), root, { force: true })).ok, true);
  const answers = [
    ok,
    { ok: true, stopped: true, terminal: "t1", forced: 2, interruptError: "herdr-core unreachable" },
    { ok: false, reason: "survived", terminal: "t1", forced: 1, survivors: [50013], interruptError: "herdr-core unreachable" },
    { ok: false, reason: "interrupt-failed", terminal: "t1", forced: 0, message: "the Ctrl-C could not be sent (x): the server may still be running" },
  ];
  const relit = () => {
    rmSync(logPath, { force: true });
    return activate(gitContext(), root, wt).then((a) => {
      state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: a.snapshotSha, serverTerminal: "t1", logPath };
    });
  };
  for (const stopped of answers) {
    await relit();
    await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root);
    assert.equal(readLog(), "", stopped?.reason ?? "ok");
  }

  // L7: an answer stopServer wrote no note for (none at all, or a reason it
  // never gives) gets the turn-off's own line, once: the reason, or "no
  // answer", and the answer's own words when it has some.
  const fallback = (said) =>
    new RegExp(`^\\n── Spotlight: wt \\(feature\\) · Spotlight off — server NOT stopped ${said} · \\d\\d:\\d\\d:\\d\\d ──\\n$`);
  const unwritten = [
    [undefined, "\\(no answer\\)"],
    [null, "\\(no answer\\)"],
    [{ ok: false, terminal: "t1" }, "\\(no answer\\)"],
    [
      { ok: false, reason: "a-new-reason", terminal: "t1", message: "something new:\nthe server may still be running" },
      "\\(a-new-reason\\): something new: the server may still be running",
    ],
    // M9: words that are only control bytes say nothing.
    [{ ok: false, reason: "a-new-reason", terminal: "t1", message: "\u0007\r\n" }, "\\(a-new-reason\\)"],
  ];
  for (const [stopped, said] of unwritten) {
    await relit();
    const r = await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root);
    assert.equal(r.code, "server-not-stopped", String(stopped?.reason));
    assert.match(readLog(), fallback(said), String(stopped?.reason));
    // The toast stays Spanish only.
    assert.ok(state.notes.filter((n) => n.toast).every((n) => !/something new|no answer/.test(n.text)), JSON.stringify(state.notes));
  }
});

// ── G1: a lighting ends the server error the last holder left ──────────────
// A takeover that goes through clears the root error; its ensureServer
// decides the server error again: a start ends it, a busy port writes it
// again, and a server that starts nothing new (no command, a variant to
// pick, the same server already running) leaves none.

// A second worktree, `wt2`, takes the root from `wt` through lightTask (a
// takeover), with `files` written into it (uncommitted: the snapshot carries
// them onto the root). The record's log goes under the test's folder.
async function lightOnto(files, over = {}) {
  const wt2 = join(base, "wt2");
  run(root, "worktree", "add", "-q", wt2, "-b", "feature2", "main");
  for (const [rel, text] of Object.entries(files)) write(wt2, rel, text);
  state.repos[root].logPath = join(base, "root.log");
  const key = `direct/${root}`;
  state.queue.lighting[key] = { grantId: "g", phase: "pending", pid: null, members: [{ root, name: "root", workspace: wt2, workspaces: [wt2] }], taskKey: null, force: false };
  const r = await lightTask(fullCx(over), key);
  assert.deepEqual(r.errors, {}, JSON.stringify(r));
  assert.equal(state.repos[root].holder, wt2);
  return wt2;
}

test("G1: a new holder whose server needs nothing (no command) leaves no server error of the last holder's", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: BUSY });
  await lightOnto({ "b.txt": "no package.json here\n" });
  assert.equal(state.repos[root].lastError, null);
});

test("G1: a new holder whose server waits for a variant leaves no server error of the last holder's", async () => {
  Object.assign(state.repos[root], { serverState: "stopped", lastError: { ...EXITED } });
  const pkg = { packageManager: "pnpm@9.0.0", scripts: { "dev:co": "vite", "dev:mx": "vite" } };
  await lightOnto({ "package.json": JSON.stringify(pkg), "apps/co/index.html": "co\n", "apps/mx/index.html": "mx\n" });
  assert.equal(state.repos[root].serverState, "needs-variant");
  assert.equal(state.repos[root].lastError, null);
});

test("G1: a new holder over the same server already running leaves no server error of the last holder's, nor a root error under which it hid", async () => {
  const pkg = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { local: "vite" } });
  // The command the root will plan once it has wt2's package.json, the same text.
  const pkgDir = join(base, "pkg");
  write(pkgDir, "package.json", pkg);
  const same = await planServer({
    root: pkgDir, workspace: pkgDir, settings: repoSettings(readSettings(JSON.stringify({ version: 1 })), root), env: "local", io: nodeIo(fsp), git: planGit,
  });
  assert.equal(same.kind, "command", JSON.stringify(same));
  const logPath = join(base, "root.log");
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: same.command, serverEnv: same.env, ports: [3000],
    // A restart the busy port refused, under a refused sync's root error.
    lastError: { ...DIVERGED, serverError: BUSY },
  });
  // hc shows Spotlight's own server in front of the server terminal.
  const ps = psExec(new Map());
  const exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = { address: "t1", pid: 100, state: "live", foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", same.command] } };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
  await lightOnto({ "package.json": pkg }, { serverDeps: { exec } });
  assert.equal(state.repos[root].serverState, "listening");
  assert.equal(state.repos[root].lastError, null);
});

// ── H1–H3, K1–K3: ensureServer decides the server error a lighting leaves ──
// A takeover (another workspace, or a fresh activation, K2) ends the last
// holder's server error when its server starts nothing new (G1, above). The
// same holder lit again keeps it unless a start ends it (H1), or the plan has
// no command at all (K1: no server to be wrong about). A start that fails
// records its own, server-start-failed, whoever lights (K3, H2).

// A port-busy a refused `spotlight restart` left over a server that kept
// listening (D24: it stays, as a sync keeps it).
const REFUSED = {
  code: "port-busy", port: 3000, pid: 4242, command: "next-server (v16.0.1)", cwd: "/Users/u/other",
  message: "El puerto 3000 lo tiene next-server (v16.0.1) (pid 4242, en /Users/u/other).", at: 7,
};

test("H1: the same holder lit again over its server already running keeps the port-busy a refused restart left (D24), with or without a root error over it", async () => {
  const pkg = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { local: "vite" } });
  const pkgDir = join(base, "pkg");
  write(pkgDir, "package.json", pkg);
  const same = await planServer({
    root: pkgDir, workspace: pkgDir, settings: repoSettings(readSettings(JSON.stringify({ version: 1 })), root), env: "local", io: nodeIo(fsp), git: planGit,
  });
  assert.equal(same.kind, "command", JSON.stringify(same));
  const logPath = join(base, "root.log");
  // hc shows Spotlight's own server in front of the server terminal.
  const ps = psExec(new Map());
  const exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = { address: "t1", pid: 100, state: "live", foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", same.command] } };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
  write(wt, "package.json", pkg);
  for (const lastError of [REFUSED, { ...DIVERGED, serverError: REFUSED }]) {
    Object.assign(state.repos[root], {
      serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: same.command, serverEnv: same.env, ports: [3000], logPath, lastError,
    });
    const key = `direct/${root}`;
    state.queue.lighting[key] = { grantId: "g", phase: "pending", pid: null, members: [{ root, name: "root", workspace: wt, workspaces: [wt] }], taskKey: null, force: false };
    const r = await lightTask(fullCx({ serverDeps: { exec } }), key);
    assert.deepEqual(r.errors, {}, JSON.stringify(r));
    assert.equal(state.repos[root].holder, wt);
    assert.equal(state.repos[root].serverState, "listening");
    // The lighting ends the root error; the server error stays on top.
    assert.deepEqual(state.repos[root].lastError, REFUSED, lastError.code);
  }
});

// The command `pkg` (a package.json's text) plans once it is on the root,
// with the default settings.
async function plannedFor(pkg) {
  const pkgDir = join(base, "pkg");
  write(pkgDir, "package.json", pkg);
  const plan = await planServer({
    root: pkgDir, workspace: pkgDir, settings: repoSettings(readSettings(JSON.stringify({ version: 1 })), root), env: "local", io: nodeIo(fsp), git: planGit,
  });
  assert.equal(plan.kind, "command", JSON.stringify(plan));
  return plan;
}

// An exec whose hc shows Spotlight's own server (`command`, writing
// `logPath`) in front of the server terminal t1; ps answers as psExec's.
function ownServerExec(logPath, command) {
  const ps = psExec(new Map());
  return async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = { address: "t1", pid: 100, state: "live", foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", command] } };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
}

// An exec whose hc can't read anything: a start fails (unreadable).
const unreadableExec = async (file) =>
  file === "hc"
    ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "hc: no route to core" } }) }
    : { code: 1, stdout: "", stderr: `no fake ${file}` };

// The server error a start hc couldn't read leaves (K3), in Spanish only:
// hc's own words go to the server log (L2).
const UNREADABLE_START = {
  code: "server-start-failed", message: "El server no arrancó: hc no pudo leer su terminal",
};

const PKG = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { local: "vite" } });

test("K3, H2: a takeover whose start fails records its own server error, replacing the last holder's: no server runs, and the record says why", async () => {
  // The last holder's busy port, which names another start's pid and port.
  Object.assign(state.repos[root], { serverState: "stopped", lastError: { ...REFUSED } });
  await lightOnto({ "package.json": PKG }, { serverDeps: { exec: unreadableExec } });
  const rec = state.repos[root];
  assert.notEqual(rec.serverState, "starting");
  const { at, ...error } = rec.lastError;
  assert.deepEqual(error, UNREADABLE_START);
  assert.equal(typeof at, "number");
  assert.equal(errors.SERVER_START_FAILED, "server-start-failed");
  assert.ok(isServerError(rec.lastError), "a server error, under any root error to come");
  const toasts = state.notes.filter((n) => n.toast).map((n) => n.text);
  assert.ok(toasts.includes(`root: ${UNREADABLE_START.message}`), JSON.stringify(toasts));
  assert.ok(toasts.includes("Spotlight on · root ← wt2 · el server no arrancó"), JSON.stringify(toasts));
  // Its toast opens the popup, which offers Reintentar (as server-exited);
  // the holder's line 2 reads "no arrancó" in red, with its message (D42;
  // server-errors.js serverDown).
  const toast = state.notes.find((n) => n.text === `root: ${UNREADABLE_START.message}`);
  assert.equal(toast.action?.name, `spotlight.server.${serverId(rec.holder)}`);
  const bin = cliPathOf("/app");
  const settings = readSettings(JSON.stringify({ version: 1 }));
  const popup = serverViewModel({ state, settings, repo: root, workspace: rec.holder, detection: null, bin });
  assert.deepEqual(popup.actions.map((a) => a.label), ["Ver log", "Reintentar", "Apagar"]);
  const { value } = buildBadges({ state, settings, bin });
  const down = value[rec.holder].find((b) => b.line === 2);
  assert.deepEqual({ text: down.text, tone: down.tone, tooltip: down.tooltip }, { text: "no arrancó", tone: "blocked", tooltip: UNREADABLE_START.message });
});

test("K3, H2, L3: the same holder lit again whose start fails records its own server error over the one it had, under a root error too; a light toasts it every time", async () => {
  write(wt, "package.json", PKG);
  state.repos[root].logPath = join(base, "root.log");
  const key = `direct/${root}`;
  for (const lastError of [REFUSED, { ...DIVERGED, serverError: REFUSED }]) {
    Object.assign(state.repos[root], { serverState: "stopped", lastError });
    state.notes = [];
    state.queue.lighting[key] = markerFor(wt);
    assert.deepEqual((await lightTask(fullCx({ serverDeps: { exec: unreadableExec } }), key)).errors, {});
    assert.equal(state.repos[root].holder, wt);
    // The lighting ends the root error; the failed start's error is on top.
    const { at, ...error } = state.repos[root].lastError;
    assert.deepEqual(error, UNREADABLE_START, lastError.code);
    assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${UNREADABLE_START.message}`], lastError.code);
  }
  // The same failure again: a light always says how its start went (L3).
  state.notes = [];
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ serverDeps: { exec: unreadableExec } }), key)).errors, {});
  assert.equal(state.repos[root].lastError.code, "server-start-failed");
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${UNREADABLE_START.message}`]);
  // Under a root error a sync left meanwhile, the failed start goes under it.
  state.repos[root].lastError = { ...DIVERGED };
  const r = await ensureServer(fullCx({ serverDeps: { exec: unreadableExec } }), root, { workspace: wt, restart: true });
  assert.equal(r.state, "failed");
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.equal(state.repos[root].lastError.serverError?.code, "server-start-failed");
});

test("K3: an old server that ignored the Ctrl-C and still runs is no failed start: no server error of its own; a takeover ends the last holder's, the same holder keeps it", async () => {
  const logPath = join(base, "root.log");
  // hc shows Spotlight's server running an older command; its Ctrl-C never
  // gives the prompt back (restartServer's still-running), on a fake clock.
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const ps = psExec(new Map());
  const exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = {
        address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root },
        foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", "pnpm old"] },
      };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    if (file === "hc" && args[0] === "interrupt") return { code: 0, stdout: JSON.stringify({ key: "ctrl+c", outcome: "stopped" }), stderr: "" };
    return ps.exec(file, args, opts);
  };
  const running = { serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath };
  const still = "root: el server sigue corriendo: no paró con Ctrl-C y no se reinició";

  // The same holder lit again: its server error stays (H1), none of its own.
  write(wt, "package.json", PKG);
  Object.assign(state.repos[root], { ...running, lastError: { ...REFUSED } });
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ serverDeps: { exec, ...clock } }), key)).errors, {});
  assert.deepEqual(state.repos[root].lastError, REFUSED);
  assert.equal(state.repos[root].serverState, "listening");
  assert.ok(state.notes.some((n) => n.toast && n.text === still), JSON.stringify(state.notes));

  // A takeover: the last holder's server error goes, none of its own.
  state.notes = [];
  await lightOnto({ "package.json": PKG }, { serverDeps: { exec, ...clock } });
  assert.equal(state.repos[root].lastError, null);
  assert.equal(state.repos[root].serverState, "listening");
  assert.ok(state.notes.some((n) => n.toast && n.text === still), JSON.stringify(state.notes));
});

// An exec whose hc has no terminal at all (`hc get` of any name: not_found);
// ps answers as psExec's.
const noTerminalExec = async (file, args, opts) =>
  file === "hc"
    ? { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) }
    : psExec(new Map()).exec(file, args, opts);

test("K1: with no command there is no server to be wrong about: the same holder lit again leaves no server error, wherever it was", async () => {
  // wt has no package.json: the plan has no command (its command was removed).
  // No server terminal anywhere, by the record or by its name (M5).
  state.repos[root].logPath = join(base, "root.log");
  const nx = () => fullCx({ serverDeps: { exec: noTerminalExec } });
  const key = `direct/${root}`;
  for (const lastError of [{ ...EXITED }, { ...DIVERGED, serverError: { ...EXITED } }]) {
    Object.assign(state.repos[root], { serverState: "stopped", serverCommand: "pnpm dev", lastError });
    state.queue.lighting[key] = markerFor(wt);
    assert.deepEqual((await lightTask(nx(), key)).errors, {});
    assert.equal(state.repos[root].holder, wt);
    assert.equal(state.repos[root].lastError, null, lastError.code);
  }
  // Straight through ensureServer (a restart, Reintentar): the root error stays, the server error goes.
  state.repos[root].lastError = { ...DIVERGED, serverError: { ...EXITED } };
  assert.equal((await ensureServer(nx(), root, { workspace: wt, restart: true })).state, "none");
  assert.deepEqual(state.repos[root].lastError, DIVERGED);
});

test("K2: a fresh activation by the workspace the record already names is a takeover: a server that needs no start leaves no server error of before", async () => {
  const same = await plannedFor(PKG);
  const logPath = join(base, "root.log");
  write(wt, "package.json", PKG);
  // The refs are gone (the root was restored), and the record still names wt.
  await deactivate(gitContext(), root);
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: same.command, serverEnv: same.env, ports: [3000], logPath,
    lastError: REFUSED,
  });
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  const r = await lightTask(fullCx({ serverDeps: { exec: ownServerExec(logPath, same.command) } }), key);
  assert.deepEqual(r.errors, {}, JSON.stringify(r));
  assert.equal(state.repos[root].holder, wt);
  assert.equal(state.repos[root].serverState, "listening");
  assert.equal(state.repos[root].lastError, null);
});

// ── Review r6: L1–L6, L9 ───────────────────────────────────────────────────

// A clock the server's waits advance instead of sleeping.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// The toasts' texts, in order.
const toastTexts = () => state.notes.filter((n) => n.toast).map((n) => n.text);

test("L1: a restart whose Ctrl-C hc couldn't send leaves the old server running: no failed start, no server error of its own, its state kept; the toast says so every time, and hc's words go to the log", async () => {
  const logPath = join(base, "root.log");
  const ps = psExec(new Map());
  const exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = {
        address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root },
        foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", "pnpm old"] },
      };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    if (file === "hc" && args[0] === "interrupt") {
      return { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "hc: no route to core" } }) };
    }
    return ps.exec(file, args, opts);
  };
  const ox = () => fullCx({ serverDeps: { exec, ...fakeClock() } });
  const running = { serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath };
  const still = "root: el server sigue corriendo: hc no pudo mandarle Ctrl-C y no se reinició";

  // The same holder lit again, then Reiniciar: its server error stays (H1),
  // none of its own, and each says the server still runs.
  write(wt, "package.json", PKG);
  Object.assign(state.repos[root], { ...running, lastError: { ...REFUSED } });
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(ox(), key)).errors, {});
  const r = await ensureServer(ox(), root, { workspace: wt, keepVariant: true, restart: true });
  // Its own state, never a failed start (M3).
  assert.deepEqual({ state: r.state, reason: r.result?.reason, error: r.error }, { state: "still-running", reason: "interrupt-failed", error: undefined });
  assert.deepEqual(state.repos[root].lastError, REFUSED);
  assert.equal(state.repos[root].serverState, "listening");
  assert.deepEqual(toastTexts(), [still, still]);
  // No Reintentar: the server is up (server-errors.js serverDown).
  const popup = serverViewModel({ state, settings: readSettings(JSON.stringify({ version: 1 })), repo: root, workspace: wt, detection: null, bin: cliPathOf("/app") });
  assert.ok(popup.actions.some((a) => a.label === "Reiniciar") && !popup.actions.some((a) => a.label === "Reintentar"), JSON.stringify(popup.actions));
  // hc's words are server.js's note, never a toast's.
  assert.ok(toastTexts().every((t) => !t.includes("no route to core")));
  const noted = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("the Ctrl-C could not be sent"));
  assert.equal(noted.length, 2, JSON.stringify(noted));
  assert.match(noted[0], /\(hc: no route to core\)/);

  // A takeover: the last holder's server error goes, none of its own.
  state.notes = [];
  await lightOnto({ "package.json": PKG }, { serverDeps: { exec, ...fakeClock() } });
  assert.equal(state.repos[root].lastError, null);
  assert.equal(state.repos[root].serverState, "listening");
  assert.ok(toastTexts().includes(still), JSON.stringify(state.notes));
});

test("L2, L9: a start that didn't go through says why in Spanish only, in its error and its toast, by its reason; hc's own words go to the server log", async () => {
  const { startFailedError } = work;
  const cases = [
    [{ ok: false, reason: "send-failed", terminal: "t1", message: "t1 has finished" }, "hc no pudo escribir en su terminal"],
    [{ ok: false, reason: "terminal-failed", message: "hc: spawn failed\nexit 1" }, "hc no pudo crear su terminal"],
    [{ ok: false, reason: "name-taken", message: "a live terminal named sl-x isn't Spotlight's for /x" }, "otra terminal viva tiene el nombre de la suya"],
    [{ ok: false, reason: "unreadable", terminal: "t1", message: "hc: no route to core" }, "hc no pudo leer su terminal"],
  ];
  for (const [answer, why] of cases) {
    assert.deepEqual(startFailedError(answer), { code: "server-start-failed", message: `El server no arrancó: ${why}` }, answer.reason);
  }

  // Through ensureServer (the plan reads the root): the record, the toast and
  // the answer say the same, and the log has hc's words.
  write(root, "package.json", PKG);
  const logPath = join(base, "root.log");
  state.repos[root].logPath = logPath;
  const r = await ensureServer(fullCx({ serverDeps: { exec: unreadableExec } }), root, { workspace: wt, restart: true });
  assert.equal(r.state, "failed");
  assert.deepEqual({ code: r.error.code, message: r.error.message }, UNREADABLE_START);
  const { at, ...stored } = state.repos[root].lastError;
  assert.deepEqual(stored, UNREADABLE_START);
  assert.deepEqual(toastTexts(), [`root: ${UNREADABLE_START.message}`]);
  assert.match(readFileSync(logPath, "utf8"), /Server not started — the Spotlight terminal's state could not be read \(hc: no route to core\)/);
});

// Spotlight's server (`command`, writing `logPath`) in front of t1 until a
// Ctrl-C hands the prompt back, and an `hc send` that always fails, with
// other words each time while `vary`: every restart fails as send-failed.
// `front` is the test's to put the server back.
function sendFailsWorld(logPath, command) {
  const ps = psExec(new Map());
  const world = { front: "spotlight", sends: 0, vary: true };
  world.exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const fg = world.front === "spotlight"
        ? { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", command] }
        : { pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] };
      return { code: 0, stdout: JSON.stringify({ address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root }, foreground: fg }), stderr: "" };
    }
    if (file === "hc" && args[0] === "interrupt") {
      world.front = "shell";
      return { code: 0, stdout: JSON.stringify({ key: "ctrl+c", outcome: "stopped" }), stderr: "" };
    }
    if (file === "hc" && args[0] === "send") {
      world.sends += 1;
      const message = world.vary ? `t1 has finished (#${world.sends})` : "t1 has finished";
      return { code: 11, stdout: "", stderr: JSON.stringify({ error: { kind: "finished", message } }) };
    }
    return ps.exec(file, args, opts);
  };
  return world;
}

test("L3: Reintentar, a restart or a light always toasts its failed start, the same failure too; a sync's repeat of it doesn't, whatever words hc gave each time", async () => {
  const plan = await plannedFor(PKG);
  write(wt, "package.json", PKG);
  const logPath = join(base, "root.log");
  const world = sendFailsWorld(logPath, plan.command);
  // Settings saved after each failure (J-011), so each sync tries the env
  // again (a sync doesn't try one that failed before such a save, M1).
  const ox = fullCx({ serverDeps: { exec: world.exec, ...fakeClock() }, store: { ...cx.store, settingsSavedAt: () => Infinity } });
  // Spotlight's server runs another env than the effective one: a sync
  // restarts it (J-002).
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: plan.command, serverEnv: "dev", ports: [3000], logPath,
  });
  const failed = "root: El server no arrancó: hc no pudo escribir en su terminal";
  // Spotlight's server in front again, as the reap would see it.
  const upAgain = () => {
    world.front = "spotlight";
    state.repos[root].serverState = "listening";
  };

  for (let i = 0; i < 3; i += 1) {
    upAgain();
    const r = await syncRepo(ox, root);
    assert.equal(r.restartFailed, "send-failed", JSON.stringify(r));
  }
  assert.deepEqual(toastTexts(), [failed]);

  // Reintentar (`spotlight restart`), the same words each time: toasted each time.
  world.vary = false;
  state.notes = [];
  for (let i = 0; i < 2; i += 1) {
    upAgain();
    assert.equal((await ensureServer(ox, root, { workspace: wt, keepVariant: true, restart: true })).state, "failed");
  }
  assert.deepEqual(toastTexts(), [failed, failed]);
  // A light of the same holder: toasted too.
  state.notes = [];
  upAgain();
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(ox, key)).errors, {});
  assert.deepEqual(toastTexts(), [failed]);
  assert.equal(state.repos[root].lastError.code, "server-start-failed");
  // Each failed start's own words are in the log, never in a toast.
  const noted = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("hc could not type into"));
  assert.equal(noted.length, 6, JSON.stringify(noted));
  assert.match(noted[0], /\(t1 has finished \(#1\)\)/);
});

test("L4: a look at a server restarted before its write (Reiniciar: `starting` again, a new serverStartedAt) is never merged over it, by `on` or the reap; a look at the record as it is still is", async () => {
  const before = { serverState: "listening", serverStartedAt: 5, serverPid: 50010, ports: [3000] };
  const restarted = { serverState: "starting", serverStartedAt: 9, serverPid: 50020, ports: [] };
  Object.assign(state.repos[root], { serverTerminal: "t1", serverProcs: [], ...before });
  let restartMeanwhile = true;
  // The look runs while a Reiniciar restarts the server: it saw the old one listening.
  const look = async () => {
    if (restartMeanwhile) Object.assign(state.repos[root], restarted);
    return { terminal: "t1", owner: "spotlight", pid: 50010, state: "listening", ports: [3000], procs: [P3000], port: 3000, url: null, label: "" };
  };
  const pick = (r) => ({ serverState: r.serverState, serverStartedAt: r.serverStartedAt, serverPid: r.serverPid, ports: r.ports, serverProcs: r.serverProcs });
  const member = { root, name: "root", workspace: wt, workspaces: [wt] };
  const ox = fullCx({ server: { readServerState: look } });

  // `on`: describeServer, then recordServers.
  const seen = await describeServer(ox, ox.store.readState(), member, "g1/AX-1");
  await recordServers(ox, [seen]);
  assert.deepEqual(pick(state.repos[root]), { ...restarted, serverProcs: [] });

  // The reap.
  Object.assign(state.repos[root], before);
  await reap(ox);
  assert.deepEqual(pick(state.repos[root]), { ...restarted, serverProcs: [] });

  // No restart meanwhile: merged, as ever (F1).
  restartMeanwhile = false;
  Object.assign(state.repos[root], before);
  await recordServers(ox, [await describeServer(ox, ox.store.readState(), member, "g1/AX-1")]);
  assert.deepEqual(pick(state.repos[root]), { ...before, serverProcs: [P3000] });
  state.repos[root].serverProcs = [];
  await reap(ox);
  assert.deepEqual(pick(state.repos[root]), { ...before, serverProcs: [P3000] });
});

// An exec whose hc shows t1 at its prompt (its shell in front); ps answers as
// psExec's.
function promptExec() {
  const ps = psExec(new Map());
  return async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = { address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root }, foreground: { pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] } };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
}

test("L5: with no command, the same holder's server error stays while a server of Spotlight's may still run there (in front of its terminal, or hc can't say), and goes once none does (K1)", async () => {
  // wt has no package.json: the plan has no command (as an env with none),
  // and Spotlight's server of before still runs in t1.
  const logPath = join(base, "root.log");
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm dev", serverEnv: "local", ports: [3000], logPath,
    lastError: { ...REFUSED },
  });
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ serverDeps: { exec: ownServerExec(logPath, "pnpm dev") } }), key)).errors, {});
  assert.deepEqual(state.repos[root].lastError, REFUSED);
  // The popup still explains the busy port and offers to free it.
  const popup = serverViewModel({ state, settings: readSettings(JSON.stringify({ version: 1 })), repo: root, workspace: wt, detection: null, bin: cliPathOf("/app") });
  assert.ok(popup.force.some((a) => a.label === "Liberar puerto y arrancar"), JSON.stringify(popup.force));
  // Reiniciar with hc unable to read the terminal: doubt keeps it.
  assert.equal((await ensureServer(fullCx({ serverDeps: { exec: unreadableExec } }), root, { workspace: wt, restart: true })).state, "none");
  assert.deepEqual(state.repos[root].lastError, REFUSED);
  // Its terminal back at its prompt: no server of Spotlight's runs, the error goes.
  assert.equal((await ensureServer(fullCx({ serverDeps: { exec: promptExec() } }), root, { workspace: wt, restart: true })).state, "none");
  assert.equal(state.repos[root].lastError, null);
});

test("L6: a fresh activation by the workspace the record already names (its refs gone) is a holder switch all through the light: the 'Spotlight on · … ←' toast, the D11 header, and installs counted from the root's own HEAD", async () => {
  const logPath = join(base, "root.log");
  await deactivate(gitContext(), root);
  const head = run(root, "rev-parse", "HEAD");
  state.repos[root].logPath = logPath;
  assert.notEqual(state.repos[root].lastSnapshotSha, head, "the record keeps the snapshot of before");
  const froms = [];
  const spyGit = async (cwd, args) => {
    if (args[0] === "diff-tree") froms.push(args[2]);
    return planGit(cwd, args);
  };
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ planGit: spyGit }), key)).errors, {});
  assert.equal(state.repos[root].holder, wt);
  assert.deepEqual(froms, [head], "the lockfiles are compared from what the root had");
  assert.deepEqual(toastTexts(), ["Spotlight on · root ← wt · sin server"]);
  assert.match(readFileSync(logPath, "utf8"), /^\n── Spotlight: wt \(feature\) · \d\d:\d\d:\d\d ──\n$/);
});

// ── Review r7: M1, M3, M5–M7 ───────────────────────────────────────────────

// Spotlight's server (`command`, writing `logPath`) in front of t1, ignoring
// every Ctrl-C: hc sends it, and the prompt never comes back (restartServer's
// still-running). `interrupts` counts the Ctrl-Cs sent.
function stuckWorld(logPath, command) {
  const ps = psExec(new Map());
  const world = { interrupts: 0 };
  world.exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const term = {
        address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root },
        foreground: { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", command] },
      };
      return { code: 0, stdout: JSON.stringify(term), stderr: "" };
    }
    if (file === "hc" && args[0] === "interrupt") {
      world.interrupts += 1;
      return { code: 0, stdout: JSON.stringify({ key: "ctrl+c", outcome: "stopped" }), stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
  return world;
}

const STILL = "root: el server sigue corriendo: no paró con Ctrl-C y no se reinició";

test("M1: a sync whose restart finds the old server ignoring Ctrl-C tries that env once: later syncs send no Ctrl-C and toast nothing until settings are saved after it, and a sync repeating the same cause then stays quiet; Reiniciar and a light always try and toast", async () => {
  const plan = await plannedFor(PKG);
  write(wt, "package.json", PKG);
  const logPath = join(base, "root.log");
  const world = stuckWorld(logPath, plan.command);
  let savedAt = 0;
  const ox = () => fullCx({ serverDeps: { exec: world.exec, ...fakeClock() }, store: { ...cx.store, settingsSavedAt: () => savedAt } });
  // Spotlight's server runs another env than the effective one: a sync
  // restarts it (J-002).
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: plan.command, serverEnv: "dev", ports: [3000], logPath,
  });
  const seen = () => ({ interrupts: world.interrupts, toasts: toastTexts() });

  const first = await syncRepo(ox(), root);
  assert.equal(first.restartFailed, "still-running", JSON.stringify(first));
  assert.deepEqual(seen(), { interrupts: 1, toasts: [STILL] });
  assert.equal(state.repos[root].envFailed, "local");

  // Every later auto-sync (a file saved, `on`): no Ctrl-C, no toast.
  for (let i = 0; i < 2; i += 1) {
    const r = await syncRepo(ox(), root);
    assert.equal(r.restartFailed, null, JSON.stringify(r));
  }
  assert.deepEqual(seen(), { interrupts: 1, toasts: [STILL] });

  // Settings saved after the failure (J-011): a sync tries it again, and the
  // same cause stays quiet.
  savedAt = Number.MAX_SAFE_INTEGER;
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 2, toasts: [STILL] });
  savedAt = 0;

  // Reiniciar and a light always try, and say so.
  assert.equal((await ensureServer(ox(), root, { workspace: wt, keepVariant: true, restart: true })).state, "still-running");
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(ox(), key)).errors, {});
  assert.deepEqual(seen(), { interrupts: 4, toasts: [STILL, STILL, STILL] });
  // The old server, in its env, still runs: no server error, its state kept.
  const rec = state.repos[root];
  assert.deepEqual({ serverEnv: rec.serverEnv, serverState: rec.serverState, lastError: rec.lastError }, { serverEnv: "dev", serverState: "listening", lastError: null });
});

test("M3: a restart whose old server still runs is no failed start anywhere: ensureServer answers still-running, and a takeover's 'Spotlight on' toast says the server wasn't restarted", async () => {
  const logPath = join(base, "root.log");
  const world = stuckWorld(logPath, "pnpm old");
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath,
  });
  await lightOnto({ "package.json": PKG }, { serverDeps: { exec: world.exec, ...fakeClock() } });
  assert.ok(toastTexts().includes(STILL), JSON.stringify(toastTexts()));
  assert.ok(toastTexts().includes("Spotlight on · root ← wt2 · server sin reiniciar"), JSON.stringify(toastTexts()));
  assert.ok(toastTexts().every((t) => !t.includes("no arrancó")), JSON.stringify(toastTexts()));
  const r = await ensureServer(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root, { workspace: state.repos[root].holder, keepVariant: true, restart: true });
  assert.deepEqual({ state: r.state, reason: r.result?.reason, error: r.error }, { state: "still-running", reason: "still-running", error: undefined });
});

test("M5: with no command and no server terminal on the record, hc is asked by name (sl-<slug>), as inspectServer does: Spotlight's server running there keeps the same holder's server error; nothing by that name ends it", async () => {
  const logPath = join(base, "root.log");
  Object.assign(state.repos[root], {
    serverTerminal: null, serverPid: 101, serverState: "listening", serverCommand: "pnpm dev", serverEnv: "local", ports: [3000], logPath,
    lastError: { ...REFUSED },
  });
  const asked = [];
  const own = ownServerExec(logPath, "pnpm dev");
  const exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") asked.push(args[1]);
    return own(file, args, opts);
  };
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ serverDeps: { exec } }), key)).errors, {});
  assert.deepEqual(state.repos[root].lastError, REFUSED);
  assert.ok(asked.includes(serverTerminalName(root)), JSON.stringify(asked));
  // No terminal by that name: no server of Spotlight's runs, the error goes (K1).
  assert.equal((await ensureServer(fullCx({ serverDeps: { exec: noTerminalExec } }), root, { workspace: wt, restart: true })).state, "none");
  assert.equal(state.repos[root].lastError, null);
});

test("M6: the reap's write applies the whole merge rule, as `on`'s: a record that turned to wait for a variant between the reap's look and its write keeps needs-variant, never the stale 'listening'", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "starting", serverStartedAt: 5, serverPid: 50010, ports: [], serverProcs: [] });
  const look = async () => ({ terminal: "t1", owner: "spotlight", pid: 50010, state: "listening", ports: [3000], procs: [P3000], port: 3000, url: null, label: "" });
  const ox = fullCx({ server: { readServerState: look } });
  const inner = ox.store.updateState;
  // An ask-variant plan (`spotlight env`) written between the look and the write.
  let between = (s) => Object.assign(s.repos[root], { serverState: "needs-variant", variantCandidates: ["co", "mx"] });
  ox.store = {
    ...ox.store,
    updateState: async (fn) => {
      between?.(state);
      between = null;
      return inner(fn);
    },
  };
  await reap(ox);
  assert.equal(state.repos[root].serverState, "needs-variant");
  assert.deepEqual({ ports: state.repos[root].ports, serverProcs: state.repos[root].serverProcs }, { ports: [], serverProcs: [] });
});

test("M7: a light compares the lockfiles from what the refs it found say the root had: their snapshot when they were active (a record whose lastSnapshotSha is stale, orphan refs with no record), else the root's own HEAD", async () => {
  const head = run(root, "rev-parse", "main");
  const froms = [];
  const spyGit = async (cwd, args) => {
    if (args[0] === "diff-tree") froms.push(args[2]);
    return planGit(cwd, args);
  };
  // A stale record: its lastSnapshotSha isn't the snapshot the refs projected.
  state.repos[root].lastSnapshotSha = head;
  await lightOnto({ "b.txt": "b\n" }, { planGit: spyGit });
  assert.deepEqual(froms, [snapshot]);

  // Orphan refs, no record: wt lights over the refs wt2 left.
  const projected = state.repos[root].lastSnapshotSha;
  assert.notEqual(projected, snapshot);
  delete state.repos[root];
  froms.length = 0;
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt);
  assert.deepEqual((await lightTask(fullCx({ planGit: spyGit }), key)).errors, {});
  assert.equal(state.repos[root].holder, wt);
  assert.deepEqual(froms, [projected]);
});

// ── Review r8: N1–N4, N7 ───────────────────────────────────────────────────

// Two envs with two commands: Local runs `vite`, Dev `vite --mode dev`.
const PKG2 = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { local: "vite", dev: "vite --mode dev", prod: "vite preview" } });

// The command `pkg` plans in `env` once it is on the root, with the default
// settings (plannedFor's, in any env).
async function plannedIn(pkg, env) {
  const pkgDir = join(base, "pkg");
  write(pkgDir, "package.json", pkg);
  const plan = await planServer({
    root: pkgDir, workspace: pkgDir, settings: repoSettings(readSettings(JSON.stringify({ version: 1 })), root), env, io: nodeIo(fsp), git: planGit,
  });
  assert.equal(plan.kind, "command", JSON.stringify(plan));
  return plan;
}

test("N1, N8: a sync repeats a stuck restart's toast only for the same cause, env and planned command: a settings save that changes the command, or a new env, is a new ask and toasts again; the record keeps no `at`", async () => {
  const local = await plannedIn(PKG2, "local");
  const dev = await plannedIn(PKG2, "dev");
  write(wt, "package.json", PKG2);
  const logPath = join(base, "root.log");
  const world = stuckWorld(logPath, dev.command);
  let savedAt = 0;
  let settings = readSettings(JSON.stringify({ version: 1 }));
  const ox = () => fullCx({ settings, serverDeps: { exec: world.exec, ...fakeClock() }, store: { ...cx.store, settingsSavedAt: () => savedAt } });
  // Spotlight's server runs Dev; Local is the effective env (J-002).
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: dev.command, serverEnv: "dev", ports: [3000], logPath,
  });
  const seen = () => ({ interrupts: world.interrupts, toasts: toastTexts().length });

  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 1, toasts: 1 });
  assert.deepEqual(state.repos[root].restartStuck, { reason: "still-running", env: "local", command: local.command });

  // A save that changes nothing it plans: tried again, the same cause stays quiet (M1).
  savedAt = Number.MAX_SAFE_INTEGER;
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 2, toasts: 1 });

  // A save that changes Local's command: a new ask, it toasts.
  settings = readSettings(JSON.stringify({ version: 1, repos: { [root]: { envs: { local: "pnpm exec vite --host" } } } }));
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 3, toasts: 2 });
  assert.deepEqual(state.repos[root].restartStuck, { reason: "still-running", env: "local", command: "pnpm exec vite --host" });

  // A new env (Prod saved as the repo's env): a new ask, it toasts; its repeat doesn't.
  settings = readSettings(JSON.stringify({ version: 1, repos: { [root]: { env: "prod", envs: { local: "pnpm exec vite --host" } } } }));
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 4, toasts: 3 });
  assert.equal(state.repos[root].restartStuck.env, "prod");
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 5, toasts: 3 });
  assert.equal("at" in state.repos[root].restartStuck, false, "N8: no field nobody reads");
});

// Spotlight's server (`command`, writing `logPath`) in front of t1, which
// lets go of the prompt on a Ctrl-C; `hc send` types its line (kept in
// `lines`) and that line's `script` leads the terminal again.
function restartsWorld(logPath, command) {
  const ps = psExec(new Map());
  const world = { front: command, lines: [], interrupts: 0 };
  world.exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      const fg = world.front === null
        ? { pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] }
        : { pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", world.front] };
      return { code: 0, stdout: JSON.stringify({ address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root }, foreground: fg }), stderr: "" };
    }
    if (file === "hc" && args[0] === "interrupt") {
      world.interrupts += 1;
      world.front = null;
      return { code: 0, stdout: JSON.stringify({ key: "ctrl+c", outcome: "stopped" }), stderr: "" };
    }
    if (file === "hc" && args[0] === "send") {
      world.lines.push(args[2]);
      world.front = args[2];
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
  return world;
}

test("N2: while the effective env is given up, a sync's lockfile install restarts the env that runs now (serverEnv), never the given-up one, which stays envFailed", async () => {
  const local = await plannedIn(PKG2, "local");
  const dev = await plannedIn(PKG2, "dev");
  assert.notEqual(local.command, dev.command);
  write(wt, "package.json", PKG2);
  write(wt, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const logPath = join(base, "root.log");
  const world = restartsWorld(logPath, dev.command);
  // Dev runs; Local, the effective env, couldn't run, and settings weren't saved since.
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: dev.command, serverEnv: "dev", ports: [3000], logPath,
    envFailed: "local", envFailedAt: 5,
  });
  const r = await syncRepo(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root);
  assert.deepEqual({ ok: r.ok, installs: r.installs, restarted: r.restarted }, { ok: true, installs: ["pnpm"], restarted: true }, JSON.stringify(r));
  assert.equal(world.lines.length, 1);
  const rec = state.repos[root];
  assert.deepEqual(
    { serverEnv: rec.serverEnv, serverCommand: rec.serverCommand, envFailed: rec.envFailed, pendingInstalls: rec.pendingInstalls },
    { serverEnv: "dev", serverCommand: dev.command, envFailed: "local", pendingInstalls: [] },
  );
});

test("N3: a start that fails while Spotlight's old server may still be in front (hc couldn't read it, before or during the start) keeps the record's state and restartStuck; one that found the prompt free drops them", async () => {
  write(wt, "package.json", PKG);
  write(root, "package.json", PKG);
  const logPath = join(base, "root.log");
  const STUCK = { reason: "still-running", env: "local", command: "pnpm old" };
  const running = { serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath };
  // Spotlight's server in front for the first `hc get`, then hc can't read the terminal.
  let gets = 0;
  const own = ownServerExec(logPath, "pnpm old");
  const darkens = async (file, args, opts) =>
    file === "hc" && args[0] === "get" && ++gets > 1
      ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "hc: no route to core" } }) }
      : own(file, args, opts);
  for (const [name, exec] of [["spotlight, then unreadable", darkens], ["unreadable", unreadableExec]]) {
    gets = 0;
    Object.assign(state.repos[root], running, { restartStuck: { ...STUCK }, lastError: null });
    const r = await ensureServer(fullCx({ serverDeps: { exec, ...fakeClock() } }), root, { workspace: wt, keepVariant: true, restart: true });
    assert.equal(r.state, "failed", name);
    const rec = state.repos[root];
    assert.deepEqual({ serverState: rec.serverState, restartStuck: rec.restartStuck }, { serverState: "listening", restartStuck: STUCK }, name);
    assert.equal(rec.lastError?.code, "server-start-failed", name);
  }

  // The prompt was free (no old server in front): the start fails as before.
  const world = sendFailsWorld(logPath, "pnpm old");
  world.front = "shell";
  Object.assign(state.repos[root], running, { restartStuck: { ...STUCK }, lastError: null });
  const r = await ensureServer(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root, { workspace: wt, keepVariant: true, restart: true });
  assert.equal(r.result?.reason, "send-failed");
  assert.equal(state.repos[root].serverState, "stopped");
  assert.equal("restartStuck" in state.repos[root], false);
});

test("N4: Forzar sync and a hand-typed `spotlight sync` (asked) are a new ask: they retry a given-up env and toast its stuck restart every time, as Reiniciar; auto-sync and `on` stay silenced", async () => {
  const plan = await plannedFor(PKG);
  write(wt, "package.json", PKG);
  const logPath = join(base, "root.log");
  const world = stuckWorld(logPath, plan.command);
  const ox = () => fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } });
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: plan.command, serverEnv: "dev", ports: [3000], logPath,
  });
  const seen = () => ({ interrupts: world.interrupts, toasts: toastTexts() });
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 1, toasts: [STILL] });
  // An automatic sync: given up, nothing sent.
  assert.equal((await syncRepo(ox(), root)).restartFailed, null);
  assert.deepEqual(seen(), { interrupts: 1, toasts: [STILL] });

  // Forzar sync goes through (D35: it says so), and its restart is stuck.
  const RESYNCED = "Spotlight re-sincronizado: el root refleja el workspace otra vez.";
  assert.equal((await syncRepo(ox(), root, { force: true })).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 2, toasts: [STILL, RESYNCED, STILL] });
  for (let i = 0; i < 2; i += 1) assert.equal((await syncRepo(ox(), root, { asked: true })).restartFailed, "still-running");
  assert.deepEqual(seen(), { interrupts: 4, toasts: [STILL, RESYNCED, STILL, STILL, STILL] });

  // Automatic again: still given up.
  assert.equal((await syncRepo(ox(), root)).restartFailed, null);
  assert.deepEqual(seen(), { interrupts: 4, toasts: [STILL, RESYNCED, STILL, STILL, STILL] });
});

test("N4: the reap's sync for a drifted env is an automatic one (`sync --repo <root> --auto`)", async () => {
  write(root, "package.json", PKG);
  const plan = await plannedFor(PKG);
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverStartedAt: 5, serverCommand: plan.command, serverEnv: "dev", ports: [3000], serverProcs: [],
  });
  const look = async () => ({ terminal: "t1", owner: "spotlight", pid: 101, state: "listening", ports: [3000], procs: [], port: 3000, url: null, label: "" });
  const spawned = [];
  await reap(fullCx({ server: { readServerState: look }, spawn: (argv) => (spawned.push(argv), 1) }));
  assert.deepEqual(spawned, [["sync", "--repo", root, "--auto"]]);
});

test("N7: a forced takeover of a diverged root compares the lockfiles from the root's own HEAD, not the snapshot it moved away from", async () => {
  write(root, "c.txt", "a commit made in the root\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "moved");
  const moved = run(root, "rev-parse", "HEAD");
  assert.notEqual(moved, snapshot);
  const froms = [];
  const spyGit = async (cwd, args) => {
    if (args[0] === "diff-tree") froms.push(args[2]);
    return planGit(cwd, args);
  };
  const wt2 = worktree("wt2");
  const key = `direct/${root}`;
  state.queue.lighting[key] = { ...markerFor(wt2), force: true };
  assert.deepEqual((await lightTask(fullCx({ planGit: spyGit }), key)).errors, {});
  assert.equal(state.repos[root].holder, wt2);
  assert.deepEqual(froms, [moved]);
});

// ── Review r9: P1, P3 ──────────────────────────────────────────────────────

test("P1: Forzar sync over a root that checked out another branch with another lockfile compares the lockfiles from the root's own HEAD, so the install is chained", async () => {
  // The holder's lockfile (A) is on the root, as the snapshot it projected,
  // and its install ran.
  write(wt, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# A\n");
  assert.equal((await syncRepo(fullCx(), root)).ok, true);
  state.repos[root].pendingInstalls = [];
  const projected = state.repos[root].lastSnapshotSha;
  // The root checks out another branch, with another lockfile (B), and installs there.
  run(root, "checkout", "-q", "-b", "other", "main");
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# B\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "another branch's lockfile");
  const moved = run(root, "rev-parse", "HEAD");
  assert.notEqual(moved, projected);
  const froms = [];
  const spyGit = async (cwd, args) => {
    if (args[0] === "diff-tree") froms.push(args[2]);
    return planGit(cwd, args);
  };
  const r = await syncRepo(fullCx({ planGit: spyGit }), root, { force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(froms, [moved]);
  assert.deepEqual(r.installs, ["pnpm"], "the root's B goes back to the holder's A: its node_modules are B's");
  assert.deepEqual(state.repos[root].pendingInstalls, ["pnpm"]);
});

// Spotlight's server (`command`, writing `logPath`) in front of t1 until a
// Ctrl-C; what hc reads of t1 after it, read by read, is `after`'s (the
// prompt back, or hc failing), its last entry for every read past them.
function interruptedWorld(logPath, command, after) {
  const ps = psExec(new Map());
  const world = { interrupts: 0, sends: 0, reads: 0 };
  const shown = (fg) => ({ code: 0, stdout: JSON.stringify({ address: "t1", pid: 100, state: "live", labels: { "spotlight.repo": root }, foreground: fg }), stderr: "" });
  world.exec = async (file, args, opts) => {
    if (file === "hc" && args[0] === "get") {
      if (world.interrupts === 0) return shown({ pid: 101, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", command] });
      const read = after[Math.min(world.reads, after.length - 1)];
      world.reads += 1;
      return read === "shell"
        ? shown({ pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] })
        : { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "hc: no route to core" } }) };
    }
    if (file === "hc" && args[0] === "interrupt") {
      world.interrupts += 1;
      return { code: 0, stdout: JSON.stringify({ key: "ctrl+c", outcome: "stopped" }), stderr: "" };
    }
    if (file === "hc" && args[0] === "send") {
      world.sends += 1;
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return ps.exec(file, args, opts);
  };
  return world;
}

test("P3: a restart whose Ctrl-C brought the prompt back, then hc couldn't read the terminal, runs no server: the record goes stopped and drops restartStuck; one whose Ctrl-C hc couldn't follow keeps them (doubt)", async () => {
  write(wt, "package.json", PKG);
  write(root, "package.json", PKG);
  const logPath = join(base, "root.log");
  const STUCK = { reason: "still-running", env: "local", command: "pnpm old" };
  const running = { serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath };

  // The prompt came back after the Ctrl-C; the read before typing failed.
  let world = interruptedWorld(logPath, "pnpm old", ["shell", "unreadable"]);
  Object.assign(state.repos[root], running, { restartStuck: { ...STUCK }, lastError: null });
  let r = await ensureServer(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root, { workspace: wt, keepVariant: true, restart: true });
  assert.deepEqual({ state: r.state, reason: r.result?.reason, interrupted: r.result?.interrupted }, { state: "failed", reason: "unreadable", interrupted: true });
  assert.deepEqual({ interrupts: world.interrupts, sends: world.sends }, { interrupts: 1, sends: 0 });
  assert.equal(state.repos[root].serverState, "stopped");
  assert.equal("restartStuck" in state.repos[root], false);
  assert.equal(state.repos[root].lastError?.code, "server-start-failed");

  // hc couldn't read the terminal from the Ctrl-C on: the old server may still run (N3).
  world = interruptedWorld(logPath, "pnpm old", ["unreadable"]);
  Object.assign(state.repos[root], running, { restartStuck: { ...STUCK }, lastError: null });
  r = await ensureServer(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root, { workspace: wt, keepVariant: true, restart: true });
  assert.deepEqual({ state: r.state, reason: r.result?.reason, interrupted: r.result?.interrupted }, { state: "failed", reason: "unreadable", interrupted: undefined });
  assert.deepEqual({ serverState: state.repos[root].serverState, restartStuck: state.repos[root].restartStuck }, { serverState: "listening", restartStuck: STUCK });
  assert.equal(state.repos[root].lastError?.code, "server-start-failed");
});

// ── G3: the identities the reap and `on` keep are the live ones ────────────

test("G3: the reap forgets remembered identities that no longer run before it merges (one ps, pinned env), so a watch server's respawns never push out a live escaped listener", async () => {
  const ESCAPED = { pid: 51000, start: "Sat Nov  8 09:00:00 2026", port: 3001 };
  const alive = new Map([[ESCAPED.pid, ESCAPED.start]]);
  const ps = psExec(alive);
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "listening", serverPid: 50010, serverProcs: [ESCAPED] });
  const start = (n) => `Sat Nov  8 10:${String(n).padStart(2, "0")}:00 2026`;
  let n = 0;
  const rx = fullCx({
    serverDeps: { exec: ps.exec },
    server: {
      // Every save the watcher respawns its listener on 3000: the last one
      // died, a new pid listens.
      readServerState: async () => {
        n += 1;
        alive.delete(52000 + n - 1);
        alive.set(52000 + n, start(n));
        const procs = [{ pid: 52000 + n, start: start(n), port: 3000 }];
        return { terminal: "t1", owner: "spotlight", pid: 50010, state: "listening", ports: [3000], procs, port: 3000, url: null, label: "" };
      },
    },
  });
  const RESPAWNS = SERVER_PROCS_MAX + 2;
  for (let i = 0; i < RESPAWNS; i += 1) await reap(rx);
  assert.deepEqual(state.repos[root].serverProcs, [ESCAPED, { pid: 52000 + RESPAWNS, start: start(RESPAWNS), port: 3000 }]);
  const reads = ps.calls.filter((c) => c.file === "ps");
  assert.equal(reads.length, RESPAWNS, "one ps per reap");
  // H7: the env rides in the argv, never in an exec option.
  for (const c of reads) assert.deepEqual({ env: c.env, opts: c.opts }, { env: { LC_ALL: "C", TZ: "UTC" }, opts: undefined });
});

test("G3: `on` forgets the dead identities too (recordServers), read with one ps before its write; doubt forgets none", async () => {
  const ESCAPED = { pid: 51000, start: "Sat Nov  8 09:00:00 2026", port: 3001 };
  const DEAD = { pid: 51001, start: "Sat Nov  8 09:01:00 2026", port: 3000 };
  // 51002 runs, but ps gives it another start time: the recorded one is gone.
  const REUSED = { pid: 51002, start: "Sat Nov  8 09:02:00 2026", port: 3000 };
  const NOW = { pid: 51003, start: "Sat Nov  8 09:03:00 2026", port: 3000 };
  const ps = psExec(new Map([[ESCAPED.pid, ESCAPED.start], [REUSED.pid, "Sat Nov  8 11:11:11 2026"], [NOW.pid, NOW.start]]));
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "listening", serverProcs: [DEAD, ESCAPED, REUSED] });
  const ox = fullCx({ serverDeps: { exec: ps.exec } });
  await recordServers(ox, [{ root, lit: true, serverState: "listening", ports: [3000], procs: [NOW] }]);
  assert.deepEqual(state.repos[root].serverProcs, [ESCAPED, NOW]);
  assert.equal(ps.calls.filter((c) => c.file === "ps").length, 1);
  // ps can't say: nothing is forgotten.
  state.repos[root].serverProcs = [DEAD, ESCAPED];
  const blind = fullCx({ serverDeps: { exec: async () => ({ code: 2, stdout: "", stderr: "ps: bad" }) } });
  await recordServers(blind, [{ root, lit: true, serverState: "listening", ports: [3000], procs: [NOW] }]);
  assert.deepEqual(state.repos[root].serverProcs, [DEAD, ESCAPED, NOW]);
});

test("H8: `on` runs no ps for a root its write then skips: one waiting for a variant, or a dead start left `starting` (its lock was busy)", async () => {
  const ps = psExec(new Map([[P3000.pid, P3000.start]]));
  const ox = fullCx({ serverDeps: { exec: ps.exec } });
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "needs-variant", serverProcs: [P3000] });
  await recordServers(ox, [{ root, lit: true, serverState: "stopped", ports: [], procs: [] }]);
  assert.equal(state.repos[root].serverState, "needs-variant");
  state.repos[root].serverState = "starting";
  await recordServers(ox, [{ root, lit: true, serverState: "stopped", ports: [], procs: [], deadStart: true }]);
  assert.equal(state.repos[root].serverState, "starting");
  // A look at a repo with no record, or one not lit, asks nothing either.
  await recordServers(ox, [{ root: join(base, "elsewhere"), lit: true, serverState: "listening", ports: [3000], procs: [P3000] }, { root, lit: false }]);
  assert.deepEqual(ps.calls, []);
  assert.deepEqual(state.repos[root].serverProcs, [P3000]);
  // A look its write merges still gets its one ps.
  await recordServers(ox, [{ root, lit: true, serverState: "listening", ports: [3000], procs: [P3000] }]);
  assert.equal(ps.calls.length, 1);
  assert.equal(state.repos[root].serverState, "listening");
});

test("K6: `on` merges only the roots its snapshot looked at: a record that turns mergeable between the snapshot and the write waits for the next round, never merged without its ps", async () => {
  const DEAD = { pid: 51001, start: "Sat Nov  8 09:01:00 2026", port: 3000 };
  const ps = psExec(new Map([[P3000.pid, P3000.start]]));
  // At the snapshot it waits for a variant (no ps for it); a light picks the
  // variant and starts the server before the write.
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "needs-variant", serverProcs: [DEAD], ports: [] });
  const ox = fullCx({ serverDeps: { exec: ps.exec } });
  const inner = ox.store.updateState;
  let between = (s) => {
    s.repos[root].serverState = "starting";
  };
  ox.store = {
    ...ox.store,
    updateState: async (fn) => {
      between?.(state);
      return inner(fn);
    },
  };
  const look = [{ root, lit: true, serverState: "listening", ports: [3000], procs: [P3000] }];
  await recordServers(ox, look);
  assert.deepEqual(ps.calls, []);
  assert.equal(state.repos[root].serverState, "starting");
  assert.deepEqual(state.repos[root].serverProcs, [DEAD]);
  assert.deepEqual(state.repos[root].ports, []);
  // The next round's snapshot sees it: merged after its one ps, the dead identity dropped.
  between = null;
  await recordServers(ox, look);
  assert.equal(ps.calls.length, 1);
  assert.equal(state.repos[root].serverState, "listening");
  assert.deepEqual(state.repos[root].serverProcs, [P3000]);
  assert.deepEqual(state.repos[root].ports, [3000]);
  // And the other way: looked at, then waiting for a variant by the write: not merged.
  between = (s) => {
    s.repos[root].serverState = "needs-variant";
  };
  await recordServers(ox, [{ ...look[0], serverState: "stopped", ports: [], procs: [] }]);
  assert.equal(state.repos[root].serverState, "needs-variant");
  assert.deepEqual(state.repos[root].ports, [3000]);
});

// ── G10: a server error toasted under a root error ─────────────────────────

test("G10: a server error toasted under a root error says the root goes first; it opens the popup only when the popup can act on that root error", () => {
  for (const [top, opens] of [[DIVERGED, true], [ORCA, false]]) {
    const s = { notes: [] };
    errorNote(s, { root, name: "root", workspace: wt, error: BUSY, now: 5, top: { ...top, serverError: BUSY } });
    assert.equal(s.notes[0].text, `root: ${BUSY.message} Antes resuelve el root: ${top.message}`, top.code);
    assert.deepEqual(s.notes[0].action, opens ? { name: `spotlight.server.${serverId(wt)}` } : undefined, top.code);
  }
  // A server error on top, or a root error toasted itself: its own message.
  const s = { notes: [] };
  errorNote(s, { root, name: "root", workspace: wt, error: BUSY, now: 5, top: BUSY });
  errorNote(s, { root, name: "root", workspace: wt, error: DIVERGED, now: 6 });
  assert.deepEqual(s.notes.map((n) => n.text), [`root: ${BUSY.message}`, `root: ${DIVERGED.message}`]);
  assert.ok(s.notes.every((n) => n.action?.name === `spotlight.server.${serverId(wt)}`));
});

test("H6: the root error a server error's toast names reads on one line, whatever lines git gave it", () => {
  const top = { ...FAILED, message: "git exploded:\n  fatal: bad object HEAD\r\n\tcould not read\n", serverError: BUSY };
  const s = { notes: [] };
  errorNote(s, { root, name: "root", workspace: wt, error: BUSY, now: 5, top });
  assert.equal(s.notes[0].text, `root: ${BUSY.message} Antes resuelve el root: git exploded: fatal: bad object HEAD could not read`);
});

// ── G11: a server stopped by hand ──────────────────────────────────────────

test("G11: a listening server whose terminal is back at its prompt (a Ctrl-C typed by hand) reads stopped on the next reap", async () => {
  Object.assign(state.repos[root], { serverTerminal: "t1", serverState: "listening", serverPid: 50010, ports: [3000] });
  const rx = fullCx({
    server: { readServerState: async () => ({ terminal: "t1", owner: null, pid: null, state: "stopped", ports: [], procs: [], port: null, url: null, label: "" }) },
  });
  await reap(rx);
  assert.equal(state.repos[root].serverState, "stopped");
  assert.deepEqual(state.repos[root].ports, []);
});

// ── T20 (D33): the busy mark ───────────────────────────────────────────────
// Every light and turn-off, a Forzar sync and a server restart mark the
// repo's record `busy: { op, since, pid, workspace }` under its lock, and
// clear it in `finally`; a sync that isn't forced never marks it.

// Every write `sx` makes, as the root's record reads after it: whether it
// exists, its holder and its busy mark.
function traceWrites(sx) {
  const trace = [];
  const inner = sx.store.updateState;
  sx.store = {
    ...sx.store,
    updateState: async (fn) => {
      const out = await inner(fn);
      const r = state.repos[root];
      trace.push({ record: Boolean(r), holder: r?.holder ?? null, busy: r?.busy ? structuredClone(r.busy) : null });
      return out;
    },
  };
  return trace;
}

// The marks a trace saw, the first one's `since` set aside (a clock reading).
const marksOf = (trace) => trace.map((t) => t.busy).filter(Boolean);
const shapeOf = (mark) => ({ ...mark, since: typeof mark.since });

// Another worktree of the repo, with an uncommitted file, so lighting it moves the root.
function worktree(name) {
  const dir = join(base, name);
  run(root, "worktree", "add", "-q", dir, "-b", name, "main");
  write(dir, `${name}.txt`, `${name}\n`);
  return dir;
}

const markerFor = (workspace, taskKey = null) => ({
  grantId: "g", phase: "pending", pid: null, members: [{ root, name: "root", workspace, workspaces: [workspace] }], taskKey, force: false,
});

const STOPPED = { ok: true, stopped: true, terminal: "t1", forced: 0 };

test("D33: a light marks the repo busy with op `light` and its target workspace, one mark for the whole light, cleared after; also when it's refused or throws", async () => {
  state.repos[root].logPath = join(base, "root.log");
  // A takeover: wt2 takes the root from wt.
  const wt2 = worktree("wt2");
  const key = `direct/${root}`;
  state.queue.lighting[key] = markerFor(wt2);
  const lx = fullCx();
  const trace = traceWrites(lx);
  const r = await lightTask(lx, key);
  assert.deepEqual(r.errors, {}, JSON.stringify(r));
  assert.equal(state.repos[root].holder, wt2);
  const marks = marksOf(trace);
  assert.ok(marks.length > 0, JSON.stringify(trace));
  assert.deepEqual(shapeOf(marks[0]), { op: "light", since: "number", pid: process.pid, workspace: wt2 });
  assert.ok(marks.every((m) => m.since === marks[0].since), "one mark, never re-marked mid-light");
  // Marked before any git work: the first write after the claim holds the old holder.
  assert.deepEqual(trace.find((t) => t.busy), { record: true, holder: wt, busy: marks[0] });
  assert.equal(trace.at(-1).busy, null);
  assert.equal("busy" in state.repos[root], false);

  // A fresh light (no holder: a record the server popup's env left): the
  // target is the workspace being lit, whose row spins before it holds.
  assert.equal((await deactivateRepo(fullCx({ server: { stopServer: async () => STOPPED } }), root)).ok, true);
  state.repos[root] = { ...emptyRepo(), envOverride: "local", logPath: join(base, "root.log") };
  state.queue.lighting[key] = markerFor(wt);
  const fx = fullCx();
  const fresh = traceWrites(fx);
  assert.deepEqual((await lightTask(fx, key)).errors, {});
  assert.deepEqual(fresh.find((t) => t.busy), { record: true, holder: null, busy: { ...marksOf(fresh)[0], workspace: wt } });
  assert.equal(state.repos[root].holder, wt);
  assert.equal("busy" in state.repos[root], false);

  // Refused (the root's HEAD detached: not on its primary branch): marked,
  // then cleared; the error stays on the record.
  assert.equal((await deactivateRepo(fullCx({ server: { stopServer: async () => STOPPED } }), root)).ok, true);
  run(root, "checkout", "-q", "--detach");
  state.repos[root] = { ...emptyRepo(), logPath: join(base, "root.log") };
  state.queue.lighting[key] = markerFor(wt2);
  const nx = fullCx();
  const refused = traceWrites(nx);
  const no = await lightTask(nx, key);
  assert.ok(no.errors[root], JSON.stringify(no));
  assert.deepEqual(shapeOf(marksOf(refused)[0]), { op: "light", since: "number", pid: process.pid, workspace: wt2 });
  assert.equal(state.repos[root].lastError.code, "not-on-primary-branch");
  assert.equal("busy" in state.repos[root], false);
  run(root, "checkout", "-q", "main");

  // Throws mid-way (the write that records the new holder fails): cleared all the same.
  state.repos[root] = { ...emptyRepo(), logPath: join(base, "root.log") };
  state.queue.lighting[key] = markerFor(wt2);
  const tx = fullCx();
  const thrown = traceWrites(tx);
  const traced = tx.store.updateState;
  tx.store.updateState = async (fn) => {
    const probe = structuredClone(state);
    fn(probe);
    if (probe.repos[root]?.holder === wt2 && state.repos[root]?.holder !== wt2) throw new Error("disk full");
    return traced(fn);
  };
  const boom = await lightTask(tx, key);
  assert.equal(boom.errors[root], "disk full");
  assert.ok(marksOf(thrown).length > 0);
  assert.equal(state.repos[root].busy, undefined);
});

test("D33: an agent's light (a queue turn's key) marks the repo busy too", async () => {
  state.repos[root].logPath = join(base, "root.log");
  const wt2 = worktree("wt2");
  state.queue.lighting["g1/AX-50"] = markerFor(wt2, "g1/AX-50");
  const ax = fullCx();
  const trace = traceWrites(ax);
  assert.deepEqual((await lightTask(ax, "g1/AX-50")).errors, {});
  assert.deepEqual(shapeOf(marksOf(trace)[0]), { op: "light", since: "number", pid: process.pid, workspace: wt2 });
  assert.equal("busy" in state.repos[root], false);
});

test("D33: a turn-off and a Forzar sync mark the repo busy; a sync that isn't forced (auto-sync, `on`'s) never does", async () => {
  state.repos[root].logPath = join(base, "root.log");
  // Auto-sync's call, and `on`'s (only its own holder, within its deadline).
  write(wt, "b.txt", "edit\n");
  const sx = fullCx();
  const plain = traceWrites(sx);
  assert.equal((await syncRepo(sx, root)).skipped, false);
  write(wt, "c.txt", "edit\n");
  assert.equal((await syncRepo(sx, root, { onlyIf: (rec) => rec.holder === wt, lockTimeoutMs: 1000 })).skipped, false);
  assert.ok(plain.length >= 2, "the syncs wrote");
  assert.deepEqual(marksOf(plain), []);

  // Forzar sync: marked with the holder as target, cleared after.
  write(wt, "d.txt", "edit\n");
  const fx = fullCx();
  const forced = traceWrites(fx);
  assert.equal((await syncRepo(fx, root, { force: true })).ok, true);
  assert.deepEqual(shapeOf(marksOf(forced)[0]), { op: "sync", since: "number", pid: process.pid, workspace: wt });
  assert.equal(forced.at(-1).busy, null);
  assert.equal("busy" in state.repos[root], false);

  // A turn-off refused (a tracked edit in the root): marked, cleared, the error kept.
  write(root, "a.txt", "edited in the root\n");
  const rx = fullCx({ server: { stopServer: async () => STOPPED } });
  const refused = traceWrites(rx);
  assert.equal((await deactivateRepo(rx, root)).code, "root-diverged");
  assert.deepEqual(shapeOf(marksOf(refused)[0]), { op: "off", since: "number", pid: process.pid, workspace: wt });
  assert.equal(state.repos[root].lastError.code, "root-diverged");
  assert.equal("busy" in state.repos[root], false);

  // The turn-off that goes through: marked until the record goes with it.
  const ox = fullCx({ server: { stopServer: async () => STOPPED } });
  const off = traceWrites(ox);
  assert.equal((await deactivateRepo(ox, root, { force: true })).ok, true);
  assert.deepEqual(shapeOf(marksOf(off)[0]), { op: "off", since: "number", pid: process.pid, workspace: wt });
  assert.deepEqual(off.at(-1), { record: false, holder: null, busy: null });
});

test("D33: a server restart marks the repo busy (restart, Liberar puerto, env, variant); the server work a light or a sync asks for doesn't mark by itself", async () => {
  state.repos[root].logPath = join(base, "root.log");
  const cases = [
    [{ restart: true }, "restart"],
    [{ restart: true, freePort: true }, "restart"],
    [{ envName: "dev", keepVariant: true }, "env"],
    [{ chosenVariant: "co" }, "variant"],
    [{ envName: "dev", chosenVariant: "co" }, "env"],
    // A sync's installs, and a lighting's server.
    [{ keepVariant: true, ifRunning: true }, null],
    [{ taskKey: "g1/AX-50", takeover: true }, null],
  ];
  for (const [opts, op] of cases) {
    const ex = fullCx();
    const trace = traceWrites(ex);
    await ensureServer(ex, root, { workspace: wt, ...opts });
    const marks = marksOf(trace);
    if (op) {
      assert.deepEqual(shapeOf(marks[0] ?? {}), { op, since: "number", pid: process.pid, workspace: wt }, JSON.stringify(opts));
      assert.equal(trace.at(-1).busy, null, JSON.stringify(opts));
    } else {
      assert.deepEqual(marks, [], JSON.stringify(opts));
    }
    assert.equal("busy" in state.repos[root], false, JSON.stringify(opts));
  }
  // No record: nothing to mark, and none made for it.
  const elsewhere = join(base, "elsewhere");
  await ensureServer(fullCx(), elsewhere, { workspace: wt, restart: true });
  assert.equal(state.repos[elsewhere], undefined);
});

// The pid of a process that already exited.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("D33: the reap clears a busy mark or a task batch whose process is gone (dead, or its pid now another process), keeps a live one, and keeps one replaced after its liveness read", async () => {
  const dead = deadPid();
  // `since` 5 is long before this process started: its pid is another process now.
  const cases = [
    ["dead", { op: "light", since: 5, pid: dead, workspace: wt }, false],
    ["reused", { op: "light", since: 5, pid: process.pid, workspace: wt }, false],
    ["live", { op: "light", since: Date.now(), pid: process.pid, workspace: wt }, true],
  ];
  for (const [what, mark, kept] of cases) {
    const batch = { op: "on", since: mark.since, pid: mark.pid };
    state.repos[root].busy = mark;
    state.queue.taskBatch = { "g1/AX-50": batch };
    await reap(fullCx());
    assert.deepEqual(state.repos[root].busy, kept ? mark : undefined, what);
    assert.deepEqual(state.queue.taskBatch?.["g1/AX-50"], kept ? batch : undefined, what);
  }

  // Read stale, then a new light takes the repo (and a new batch its key)
  // before the reap writes: the new ones stay.
  const stale = { op: "light", since: 5, pid: dead, workspace: wt };
  const fresh = { op: "light", since: Date.now(), pid: process.pid, workspace: wt };
  const freshBatch = { op: "off", since: fresh.since, pid: process.pid };
  state.repos[root].busy = stale;
  state.queue.taskBatch = { "g1/AX-50": { op: "on", since: 5, pid: dead } };
  let asked = 0;
  const rx = fullCx({
    isStale: () => {
      asked += 1;
      state.repos[root].busy = fresh;
      state.queue.taskBatch["g1/AX-50"] = freshBatch;
      return true;
    },
  });
  await reap(rx);
  assert.ok(asked >= 2, "liveness read for the mark and the batch");
  assert.deepEqual(state.repos[root].busy, fresh);
  assert.deepEqual(state.queue.taskBatch["g1/AX-50"], freshBatch);
});

// ── T20 for T21 (D31): quiet, and the task batch marker ────────────────────

test("D31: a quiet light and a quiet turn-off add no 'Spotlight on · …' / 'Spotlight off — root restaurado' note; quiet never lands on the marker, so a later forced re-light of it toasts", async () => {
  state.repos[root].logPath = join(base, "root.log");
  const wt2 = worktree("wt2");
  const key = `direct/${root}`;
  const lit = () => state.notes.filter((n) => /^Spotlight on · /.test(n.text)).map((n) => n.text);
  state.queue.lighting[key] = markerFor(wt2);
  assert.deepEqual((await lightTask(fullCx(), key, { quiet: true })).errors, {});
  assert.equal(state.repos[root].holder, wt2);
  assert.deepEqual(lit(), []);
  assert.equal("quiet" in state.queue.lighting[key], false);
  assert.equal(state.queue.lighting[key].phase, "done");

  // wt takes the root back through another turn, then Proyectar igual
  // re-lights the same marker, forced and not quiet: it says so.
  state.queue.lighting["g1/AX-9"] = markerFor(wt, "g1/AX-9");
  assert.deepEqual((await lightTask(fullCx(), "g1/AX-9")).errors, {});
  assert.equal(state.repos[root].holder, wt);
  state.notes = [];
  assert.deepEqual((await lightTask(fullCx(), key, { force: true })).errors, {});
  assert.equal(state.repos[root].holder, wt2);
  assert.deepEqual(lit(), ["Spotlight on · root ← wt2 · sin server"]);

  // The quiet turn-off.
  state.notes = [];
  const off = await deactivateRepo(fullCx({ server: { stopServer: async () => STOPPED } }), root, { quiet: true });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(state.repos[root], undefined);
  assert.deepEqual(state.notes.filter((n) => n.text.includes("Spotlight off")), []);
  // Not quiet: as always.
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot, logPath: join(base, "root.log") };
  assert.equal((await deactivateRepo(fullCx({ server: { stopServer: async () => STOPPED } }), root)).ok, true);
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), ["Spotlight off — root restaurado"]);
});

test("D31: a quiet turn-off still toasts a server that didn't stop: quiet drops only the success note", async () => {
  state.repos[root].logPath = join(base, "root.log");
  const stopped = { ok: false, reason: "survived", terminal: "t1", forced: 1, survivors: [50013] };
  const r = await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root, { quiet: true });
  assert.equal(r.code, "server-survived");
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => n.text), [`root: ${r.message}`]);
});

test("D31: withTaskBatch marks queue.taskBatch[<groupId>/<KEY>] { op, since, pid } while the batch runs and clears it after, also when it throws; a mark someone replaced stays", async () => {
  const bx = fullCx();
  let seen = null;
  assert.equal(await withTaskBatch(bx, "g1/AX-50", "on", async () => {
    seen = structuredClone(state.queue.taskBatch);
    return 7;
  }), 7);
  assert.deepEqual(Object.keys(seen), ["g1/AX-50"]);
  assert.deepEqual({ ...seen["g1/AX-50"], since: typeof seen["g1/AX-50"].since }, { op: "on", since: "number", pid: process.pid });
  assert.equal(state.queue.taskBatch, undefined);
  await assert.rejects(withTaskBatch(bx, "g1/AX-50", "off", async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(state.queue.taskBatch, undefined);
  const other = { op: "off", since: 99, pid: 4343 };
  await withTaskBatch(bx, "g1/AX-50", "on", async () => {
    state.queue.taskBatch["g1/AX-50"] = other;
  });
  assert.deepEqual(state.queue.taskBatch, { "g1/AX-50": other });
});

// ── D38 (T29), D40 (T35): the server runs in the root's own terminal ───────
// A fake Herdr and hc around the root: its space spRoot (made in the root)
// with tab "1" holding Juan's plain terminal t5, in `cwd`. `busy`: t5 runs a
// server Juan started by hand (npm, pid 7000; 7001 listens on 3008 for as
// long as it runs); otherwise its shell (pid 500) is at the prompt.
// Spotlight's own terminals are made by `hc run` (t9, t10…); a terminal
// given herdr.space (`hc run --label`, `hc label`) that Herdr shows nowhere
// yet shows as a new tab at the end of spRoot. `hidden`: a terminal of
// Spotlight's lit before T29, with no herdr.space. A typed
// `[cd '<dir>' && ]spotlight-serve '<command>'` moves the terminal there and
// leads it with what the helper execs: `script -F -q -a <log> /bin/zsh -c
// <command>`, `log` being what `spotlight logs --path` prints (the record's).
// `trace` keeps each call's words, in order; ps answers as psExec's.
// `elsewhere`: 3008 is held by another process, outside t5, that never goes.
function rootWorld({ hidden = null, busy = false, cwd = root, elsewhere = false, log = join(base, "root.log") } = {}) {
  const trace = [];
  const ps = psExec(new Map());
  const shell = (t) => ({ pid: t.pid, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: t.cwd });
  const terms = {
    t5: { address: "t5", pid: 500, state: "live", cwd, labels: { "herdr.space": "spRoot", "herdr.tab": "tb1" } },
  };
  terms.t5.foreground = busy ? { pid: 7000, name: "npm", argv: ["npm", "run", "dev"], cwd } : shell(terms.t5);
  if (hidden) terms[hidden.address] = hidden;
  const shown = (t) => ({ terminal: t.address, pane: `p-${t.address}`, status: null, app: null, name: t.name ?? null, sub_agents: [] });
  const space = { id: "spRoot", name: "root", folder: root, machine: null, active: true, tabs: [{ id: "tb1", name: "1", active: true, settled: false, terminals: [shown(terms.t5)] }] };
  const inTab = (t) => space.tabs.some((tab) => tab.terminals.some((x) => x.terminal === t.address));
  const show = (t) => {
    if (!inTab(t)) space.tabs.push({ id: `tb-${t.address}`, name: String(space.tabs.length + 1), active: false, settled: false, terminals: [shown(t)] });
  };
  const json = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const labelsOf = (words) => Object.fromEntries(words.map((kv) => kv.split("=")).map(([k, ...v]) => [k, v.join("=")]));
  const unquote = (word) => word.slice(1, -1).replace(/'\\''/g, "'");
  let next = 9;
  const exec = async (file, args, opts) => {
    trace.push([file, ...args].join(" "));
    if (file === "herdr-app" && args[0] === "ls") return json({ spaces: [space] });
    if (file === "herdr-app" && args[0] === "do") {
      const a = JSON.parse(args[2]);
      const i = space.tabs.findIndex((t) => t.id === a.id);
      if (args[1] === "tab.rename" && i >= 0) space.tabs[i].name = a.name;
      if (args[1] === "tab.move" && i >= 0) space.tabs.splice(a.index - 1, 0, ...space.tabs.splice(i, 1));
      return json({});
    }
    if (file === "hc") {
      const term = terms[args[1]] ?? Object.values(terms).find((x) => x.name === args[1] && x.state === "live");
      switch (args[0]) {
        case "get":
          return term ? json(term) : { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) };
        case "ls":
          return json({ terminals: Object.values(terms).filter((x) => x.state === "live").map(({ address }) => ({ address, cwd: terms[address].cwd })) });
        case "run": {
          const address = `t${next++}`;
          const labels = labelsOf(args.filter((_, i) => args[i - 1] === "--label"));
          const pid = 900 + next;
          terms[address] = { address, name: args[args.indexOf("--name") + 1], pid, state: "live", cwd: root, labels, foreground: { pid, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: root } };
          if (labels["herdr.space"]) show(terms[address]);
          return json({ address, state: "live" });
        }
        case "label":
          Object.assign(term.labels, labelsOf(args.slice(2).filter((w) => w !== "--json")));
          if (term.labels["herdr.space"]) show(term);
          return json({ address: term.address });
        case "kill":
          Object.assign(term, { state: "finished", reason: "killed" });
          delete term.foreground;
          for (const tab of space.tabs) tab.terminals = tab.terminals.filter((x) => x.terminal !== term.address);
          space.tabs = space.tabs.filter((tab) => tab.terminals.length > 0);
          return json({ killed: term.address });
        case "send": {
          const m = /^(?:cd ('(?:[^']|'\\'')*') && )?spotlight-serve ('(?:[^']|'\\'')*')$/.exec(args[2]);
          if (m) {
            if (m[1]) term.cwd = unquote(m[1]);
            term.foreground = { pid: 950, name: "script", argv: ["script", "-F", "-q", "-a", log, "/bin/zsh", "-c", unquote(m[2])], cwd: term.cwd };
          }
          return json({ started: null });
        }
        default:
          return { code: 2, stdout: "", stderr: `fake hc: ${args[0]}` };
      }
    }
    if (file === "lsof" && args.includes("-iTCP:3008")) {
      const held = elsewhere || (terms.t5.state === "live" && terms.t5.foreground?.pid === 7000);
      return held ? { code: 0, stdout: "p7001\ncnode\nf20\nn*:3008\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof" && args.includes("-d")) return { code: 0, stdout: `p7001\nfcwd\nn${root}\n`, stderr: "" };
    if (file === "pgrep") return { code: 1, stdout: "", stderr: "" };
    return ps.exec(file, args, opts);
  };
  return { exec, trace, terms, space, first: (prefix) => trace.findIndex((l) => l.startsWith(prefix)) };
}

const NEXT_3008 = JSON.stringify({ scripts: { local: "next dev -p 3008" } });
// The calls of `verb` (hc's, by its first word) in a world's trace.
const callsOf = (w, verb) => w.trace.filter((l) => l.startsWith(`hc ${verb} `));

test("D40: lighting a root whose own terminal is at its prompt types the server there: t5 labeled for the root and its tab renamed Spotlight, the port checked, then `cd '<root>' && spotlight-serve '<command>'` typed (the cd always: hc's folder may be stale); no terminal made, killed or moved", async () => {
  const w = rootWorld();
  await lightOnto({ "package.json": NEXT_3008 }, { serverDeps: { exec: w.exec, ...fakeClock() } });
  const rec = state.repos[root];
  assert.equal(rec.lastError, null, JSON.stringify(rec.lastError));
  assert.equal(rec.serverState, "starting");
  assert.equal(rec.serverTerminal, "t5");
  assert.equal(rec.serverPid, 950, "the helper's script is Spotlight's own server");
  assert.equal("serverReason" in rec, false);
  assert.equal(w.terms.t5.labels["spotlight.repo"], root);
  assert.deepEqual(w.space.tabs.map((x) => x.name), ["Spotlight"]);
  assert.deepEqual(callsOf(w, "send"), [`hc send t5 cd '${root}' && spotlight-serve '${rec.serverCommand}' --json`]);
  for (const verb of ["run", "kill", "interrupt"]) assert.deepEqual(callsOf(w, verb), [], verb);
  assert.equal(w.first("herdr-app do tab.move"), -1);
  const order = [`hc label t5 spotlight.repo=${root}`, "herdr-app do tab.rename", "lsof -nP -iTCP:3008", "hc send t5"].map(w.first);
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), JSON.stringify(w.trace));
});

test("D40: the root's terminal at a prompt in another folder gets `cd '<root>' && ` before the helper", async () => {
  write(root, "package.json", NEXT_3008);
  // Lit before: t5 is the root's Spotlight terminal, Juan cd'd into a subfolder since.
  const w = rootWorld({ cwd: join(root, "apps") });
  w.terms.t5.labels["spotlight.repo"] = root;
  Object.assign(state.repos[root], { serverTerminal: "t5", logPath: join(base, "root.log") });
  const r = await ensureServer(fullCx({ serverDeps: { exec: w.exec, ...fakeClock() } }), root, { workspace: wt, restart: true });
  assert.equal(r.state, "started", JSON.stringify(r));
  assert.deepEqual(callsOf(w, "send"), [`hc send t5 cd '${root}' && spotlight-serve '${r.plan.command}' --json`]);
  assert.equal(w.terms.t5.cwd, root);
  assert.equal(state.repos[root].serverPid, 950);
});

test("D40: a root whose own terminal runs something is left alone: nothing typed, no Ctrl-C, its port never checked; the record's server is stopped with terminal-busy, no error and no toast of it; the log and the popup say so; once it is free, Reiniciar types the server there", async () => {
  const w = rootWorld({ busy: true });
  await lightOnto({ "package.json": NEXT_3008 }, { serverDeps: { exec: w.exec, ...fakeClock() } });
  const rec = state.repos[root];
  assert.deepEqual(
    { serverState: rec.serverState, serverReason: rec.serverReason, lastError: rec.lastError, serverTerminal: rec.serverTerminal },
    { serverState: "stopped", serverReason: "terminal-busy", lastError: null, serverTerminal: "t5" },
  );
  for (const verb of ["send", "interrupt", "kill", "run"]) assert.deepEqual(callsOf(w, verb), [], verb);
  assert.equal(w.first("lsof -nP -iTCP:3008"), -1, "no port-busy for its own server");
  assert.equal(w.terms.t5.foreground.name, "npm", "what ran there still runs");
  // Chosen all the same: labeled and named, so Reiniciar finds it.
  assert.equal(w.terms.t5.labels["spotlight.repo"], root);
  assert.deepEqual(w.space.tabs.map((x) => x.name), ["Spotlight"]);
  // No toast of its own: no server error, only the light's line.
  assert.deepEqual(toastTexts().filter((t) => !t.startsWith("Spotlight on")), []);
  assert.match(readFileSync(join(base, "root.log"), "utf8"), /· Server left alone — the Spotlight terminal is busy · \d\d:\d\d:\d\d ──\n$/);
  const popup = serverViewModel({ state, settings: readSettings(JSON.stringify({ version: 1 })), repo: root, workspace: rec.holder, detection: null, bin: cliPathOf("/app") });
  assert.equal(popup.serverNote, "Su terminal está ocupada: no se tocó.");
  assert.deepEqual(popup.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"]);

  // The reap reads Juan's server listening in t5: no server of Spotlight's
  // all the same, so the record stays as the start left it, with no toast.
  const juans = { terminal: "t5", owner: "foreign", pid: 7000, state: "listening", ports: [3008], procs: [], port: 3008, url: "http://localhost:3008", label: ":3008" };
  await reap(fullCx({ serverDeps: { exec: w.exec }, server: { readServerState: async () => juans } }));
  const after = state.repos[root];
  assert.deepEqual(
    { serverState: after.serverState, serverReason: after.serverReason, ports: after.ports },
    { serverState: "stopped", serverReason: "terminal-busy", ports: [] },
  );
  assert.deepEqual(toastTexts().filter((t) => !t.startsWith("Spotlight on")), []);

  // Juan stops his server: Reiniciar types Spotlight's there, and the line goes.
  w.terms.t5.foreground = { pid: 500, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: root };
  const r = await ensureServer(fullCx({ serverDeps: { exec: w.exec, ...fakeClock() } }), root, { workspace: rec.holder, restart: true });
  assert.equal(r.state, "started", JSON.stringify(r));
  assert.deepEqual(callsOf(w, "send"), [`hc send t5 cd '${root}' && spotlight-serve '${r.plan.command}' --json`]);
  assert.equal(callsOf(w, "interrupt").length, 0);
  assert.equal("serverReason" in state.repos[root], false);
  assert.equal(serverViewModel({ state, settings: readSettings(JSON.stringify({ version: 1 })), repo: root, workspace: rec.holder, detection: null, bin: cliPathOf("/app") }).serverNote, null);
});

test("D40: once the program Spotlight left alone ends (its shell free again, nothing listening), the next look drops terminal-busy, the reap's and `on`'s alike; while the terminal still runs it, the reason stays", async () => {
  const w = rootWorld({ busy: true });
  const holder = await lightOnto({ "package.json": NEXT_3008 }, { serverDeps: { exec: w.exec, ...fakeClock() } });
  assert.equal(state.repos[root].serverReason, "terminal-busy");
  const noteOf = () => serverViewModel({ state, settings: readSettings(JSON.stringify({ version: 1 })), repo: root, workspace: holder, detection: null, bin: cliPathOf("/app") }).serverNote;
  const look = { terminal: "t5", ports: [], procs: [], port: null, url: null, label: "", state: "stopped" };
  const juans = { ...look, owner: "foreign", pid: 7000 };
  const free = { ...look, owner: null, pid: 500 };
  const member = { root, name: "root", workspace: holder, workspaces: [holder] };
  const reapReading = (live) => reap(fullCx({ serverDeps: { exec: w.exec }, server: { readServerState: async () => live } }));
  const onReading = async (live) => {
    const ox = fullCx({ serverDeps: { exec: w.exec }, server: { readServerState: async () => live } });
    await recordServers(ox, [await describeServer(ox, ox.store.readState(), member, "g1/AX-1")]);
  };

  for (const [what, read] of [["the reap", reapReading], ["on", onReading]]) {
    state.repos[root].serverReason = "terminal-busy";
    // His program still runs there, no port open: the reason stays.
    await read(juans);
    assert.equal(state.repos[root].serverReason, "terminal-busy", what);
    assert.equal(noteOf(), "Su terminal está ocupada: no se tocó.", what);
    // It ended: the shell leads again. Stopped, and no longer busy.
    await read(free);
    assert.equal("serverReason" in state.repos[root], false, what);
    assert.equal(state.repos[root].serverState, "stopped", what);
    assert.equal(noteOf(), null, what);
  }
});

test("D38: the reap shows a server lit before T29 (its terminal hidden) as the root's Spotlight tab, once: no restart, no kill, no other terminal touched", async () => {
  const logPath = join(base, "root.log");
  const hidden = {
    address: "t3", name: "sl-root", pid: 300, state: "live", cwd: root, labels: { "spotlight.repo": root },
    foreground: { pid: 301, name: "script", argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", "npm run local --"] },
  };
  const w = rootWorld({ hidden });
  Object.assign(state.repos[root], {
    serverTerminal: "t3", serverPid: 301, serverState: "listening", serverCommand: "npm run local --", serverEnv: "local", ports: [3008], logPath,
  });
  const live = { terminal: "t3", owner: "spotlight", pid: 301, state: "listening", ports: [3008], procs: [], port: 3008, url: "http://localhost:3008", label: ":3008" };
  const rx = fullCx({ serverDeps: { exec: w.exec }, server: { readServerState: async () => live } });
  await reap(rx);
  assert.deepEqual(w.trace.filter((l) => l.startsWith("hc label")), ["hc label t3 herdr.space=spRoot"]);
  assert.deepEqual(w.space.tabs.map((x) => x.name), ["1", "Spotlight"]);
  for (const verb of ["run", "kill", "send", "interrupt"]) assert.equal(w.first(`hc ${verb}`), -1, verb);
  assert.equal(w.terms.t5.state, "live");
  // Once: the next reap leaves it as it is.
  await reap(rx);
  assert.equal(w.trace.filter((l) => l.startsWith("hc label")).length, 1);
  assert.equal(w.trace.filter((l) => l.startsWith("herdr-app do tab.rename")).length, 1);
  assert.equal(state.repos[root].serverTerminal, "t3");
  assert.equal(state.repos[root].serverState, "listening");
});

test("D40: a port held outside the root's terminal is still D24's port-busy: nothing typed, and the record keeps that terminal", async () => {
  const w = rootWorld({ elsewhere: true });
  await lightOnto({ "package.json": NEXT_3008 }, { serverDeps: { exec: w.exec, ...fakeClock() } });
  const rec = state.repos[root];
  assert.equal(rec.lastError?.code, "port-busy");
  assert.equal(rec.serverTerminal, "t5");
  assert.equal("serverReason" in rec, false);
  assert.deepEqual(callsOf(w, "send"), [], "nothing typed");
  assert.deepEqual(w.space.tabs.map((x) => x.name), ["Spotlight"]);
  assert.equal(w.terms.t5.state, "live");
});

test("D40: Spotlight's own server (its `script` writing the repo's log) running another command restarts as today: one Ctrl-C, then the helper line with the new command in the same terminal", async () => {
  write(root, "package.json", PKG);
  const plan = await plannedFor(PKG);
  const logPath = join(base, "root.log");
  const world = restartsWorld(logPath, "pnpm old");
  Object.assign(state.repos[root], {
    serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: "pnpm old", serverEnv: "local", ports: [3000], logPath,
  });
  const r = await ensureServer(fullCx({ serverDeps: { exec: world.exec, ...fakeClock() } }), root, { workspace: wt });
  assert.equal(r.state, "started", JSON.stringify(r));
  assert.equal(r.result.restarted, true);
  assert.equal(world.interrupts, 1);
  assert.equal(world.lines.length, 1);
  assert.match(world.lines[0], new RegExp(`spotlight-serve '${plan.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`));
  assert.equal(state.repos[root].serverTerminal, "t1");
  assert.equal(state.repos[root].serverCommand, plan.command);
});

// ── T22 (D32): the env per task ────────────────────────────────────────────
// A light writes the holder's env key on its record (record.envKey), so the
// env in force needs no git: envs[record.envKey], else the settings' env. A
// record lit before T22 (envOverride, no envKey) keeps reading its
// envOverride while the same workspace holds it.

test("D32: a light keys its record with the holder's env key: the task's (the marker's), else ws:<path>; the same holder lit again keeps a record lit before T22 as it was; a takeover keys it and drops envOverride", async () => {
  const key = `direct/${root}`;
  // The same holder lit again (a relight of its turn), record from before T22.
  Object.assign(state.repos[root], { envOverride: "dev" });
  state.queue.lighting[key] = markerFor(wt, "g1/AX-1");
  assert.deepEqual((await lightTask(fullCx(), key)).errors, {});
  assert.equal(state.repos[root].envOverride, "dev");
  assert.equal("envKey" in state.repos[root], false);
  // A record with no envOverride gets the key.
  delete state.repos[root].envOverride;
  state.queue.lighting[key] = markerFor(wt, "g1/AX-1");
  assert.deepEqual((await lightTask(fullCx(), key)).errors, {});
  assert.equal(state.repos[root].envKey, "task:AX-1");
  // A takeover by a workspace with no task: keyed by its path; envOverride goes.
  state.repos[root].envOverride = "prod";
  const wt2 = await lightOnto({ "b.txt": "two\n" });
  assert.equal(state.repos[root].envKey, `ws:${wt2}`);
  assert.equal("envOverride" in state.repos[root], false);
});

test("D32: the env in force: envs[record.envKey], else the settings' env; a record with no envKey reads its envOverride", () => {
  const ex = fullCx({ settings: readSettings(JSON.stringify({ version: 1, repos: { [root]: { env: "dev" } } })) });
  const env = (record, envs) => work.effectiveEnv(ex, root, record, envs);
  assert.equal(env({ envKey: "g1/AX-1" }, { "g1/AX-1": "prod" }), "prod");
  assert.equal(env({ envKey: "g1/AX-1" }, { "g1/AX-2": "prod" }), "dev");
  assert.equal(env({ envKey: "g1/AX-1", envOverride: "local" }, undefined), "dev");
  assert.equal(env({ envOverride: "local" }, { "g1/AX-1": "prod" }), "local");
  assert.equal(env(null, {}), "dev");
});

test("D32: an env picked now restarts only when its command changes: Spotlight's server already running that command stays and now runs the pick's env; a sync over a changed env still restarts it (J-002)", async () => {
  const pkg = JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { dev: "vite", prod: "vite preview" } });
  write(root, "package.json", pkg);
  const plan = async (env) =>
    (await planServer({ root, workspace: wt, settings: repoSettings(readSettings(JSON.stringify({ version: 1 })), root), env, io: nodeIo(fsp), git: planGit })).command;
  // Local has no script: it runs Dev's command.
  const local = await plan("local");
  assert.equal(local, await plan("dev"));
  const logPath = join(base, "root.log");
  const running = (env) => ({ serverTerminal: "t1", serverPid: 101, serverState: "listening", serverCommand: local, serverEnv: env, ports: [3000], logPath });
  const world = stuckWorld(logPath, local);
  const ox = (over = {}) => fullCx({ serverDeps: { exec: world.exec, ...fakeClock() }, ...over });

  Object.assign(state.repos[root], running("local"), { envFailed: "dev", envFailedAt: 5 });
  const same = await ensureServer(ox(), root, { workspace: wt, envName: "dev", keepVariant: true });
  assert.equal(same.state, "running");
  assert.equal(world.interrupts, 0, "no Ctrl-C: the command is the same");
  assert.equal(state.repos[root].serverEnv, "dev");
  assert.equal("envFailed" in state.repos[root], false, "the env asked for runs now");

  // Another command: the pick tries it (an explicit request, as Reiniciar).
  assert.equal((await ensureServer(ox(), root, { workspace: wt, envName: "prod", keepVariant: true })).state, "still-running");
  assert.equal(world.interrupts, 1);

  // A sync over a changed env keeps J-002's rule: another env restarts, the same command too.
  Object.assign(state.repos[root], running("dev"));
  delete state.repos[root].envFailed;
  delete state.repos[root].restartStuck;
  assert.equal((await syncRepo(ox(), root)).restartFailed, "still-running");
  assert.equal(world.interrupts, 2);
});

test("D32: an env write adopts each lit record with no envKey whose holder's key it is (its envOverride dropped, in the same write); a keyed record, or another key's, stays", async () => {
  // shared has no projects.v1: wt's lane is spaceless, its task the branch "feature".
  const other = join(base, "other-root");
  Object.assign(state.repos[root], { envOverride: "prod" });
  state.repos[other] = { ...emptyRepo(), holder: wt, envKey: "spaceless/feature" };
  const ex = fullCx();
  const writes = traceWrites(ex);
  await work.writeEnv(ex, "g1/AX-9", "dev");
  assert.deepEqual(state.envs, { "g1/AX-9": "dev" });
  assert.equal(state.repos[root].envOverride, "prod", "another key: not adopted");
  assert.equal(writes.length, 1);
  await work.writeEnv(ex, "spaceless/feature", "local");
  assert.deepEqual(state.envs, { "g1/AX-9": "dev", "spaceless/feature": "local" });
  assert.equal(state.repos[root].envKey, "spaceless/feature");
  assert.equal("envOverride" in state.repos[root], false);
  assert.equal(writes.length, 2, "one write: the pick and the adoption together");
  assert.equal(state.repos[other].envKey, "spaceless/feature");
});
