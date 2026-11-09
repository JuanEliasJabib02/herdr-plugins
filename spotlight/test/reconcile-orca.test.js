// T16 (D27), the reap's reconcile (cli-work.mjs reconcileFree): a root
// Orca's Spotlight took reads orca-holds, not root-diverged, and goes back to
// the usual rules once Orca lets go. Over the same real git and in-memory
// store: how a record's root and server errors stack (F6, F7), what the reap
// and `on` remember of the server's processes for the turn-off (F1), and a
// turn-off whose server didn't stop (F3). server.js's reads and stop are
// stubbed (cx.server) with the shapes they answer.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import * as work from "../mods/spotlight/cli-work.mjs";
import * as errors from "../mods/spotlight/server-errors.js";
import { planGit } from "../mods/spotlight/cli-env.mjs";
import { activate, gitContext } from "../mods/spotlight/sync.js";
import { emptyRepo } from "../mods/spotlight/store.js";
import { readSettings } from "../mods/spotlight/board-model.js";
import { nodeIo } from "../mods/spotlight/server-plan.js";

// Destructured, not named in the imports: a helper that's missing fails its
// own tests, not the whole file's load.
const { reconcileFree, recordServers, syncRepo, deactivateRepo, reap, describeServer, rememberProcs, SERVER_PROCS_MAX } = work;
const { setRootError, setServerError, clearRootError, clearServerError, serverErrorOf } = errors;

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

// The cx a sync, a turn-off or a reap needs beyond the reconcile's.
const fullCx = (over = {}) => ({
  ...cx, gitCtx: gitContext(), planGit, nameOf: () => "root", settings: readSettings(JSON.stringify({ version: 1 })), io: nodeIo(fsp),
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
  assert.deepEqual(rememberProcs([], [null, { pid: "x", start: "s" }, { pid: 5 }, { pid: 6, start: "" }, { pid: 7, start: 12, port: "3000" }]), [
    { pid: 7, start: 12, port: null },
  ]);
  const many = Array.from({ length: 40 }, (_, i) => ({ pid: 60000 + i, start: `s${i}`, port: 4000 + i }));
  const kept = rememberProcs(many.slice(0, 20), many.slice(20));
  assert.equal(kept.length, SERVER_PROCS_MAX);
  assert.deepEqual(kept, many.slice(-SERVER_PROCS_MAX));
});

test("F1: the turn-off hands stopServer every server process the record remembers, and their ports beside the live ones", async () => {
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
  assert.deepEqual([...asked.ports].sort(), [3000, 3001]);
  // A record that never saw one hands an empty list.
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state.repos[root] = { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot };
  await deactivateRepo(ox, root);
  assert.deepEqual(asked.procs, []);
});

// ── F3: a turn-off whose server didn't stop ────────────────────────────────

test("F3: a turn-off whose server didn't stop, for any reason, restores the root and is an error that says why, never 'root restaurado'", async () => {
  const cases = [
    [
      { ok: false, reason: "interrupt-failed", terminal: "t1", message: "hc: no route" },
      "server-not-stopped", "El server no paró al apagar Spotlight: hc no pudo mandarle Ctrl-C (hc: no route) (el root sí se restauró).",
    ],
    [
      { ok: false, reason: "still-running", terminal: "t1", forced: 1 },
      "server-not-stopped", "El server no paró al apagar Spotlight: siguió corriendo en su terminal (el root sí se restauró).",
    ],
    [
      { ok: false, reason: "unreadable", terminal: "t1", message: "no foreground" },
      "server-not-stopped", "El server no paró al apagar Spotlight: hc no pudo leer su terminal (no foreground) (el root sí se restauró).",
    ],
    [
      { ok: false, reason: "a-new-reason", terminal: "t1" },
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
    state.repos[root].serverTerminal = "t1";
    state.notes = [];
    const r = await deactivateRepo(fullCx({ server: { stopServer: async () => stopped } }), root);
    assert.equal(r.ok, false, stopped.reason);
    assert.equal(r.code, code, stopped.reason);
    assert.equal(r.message, message);
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
