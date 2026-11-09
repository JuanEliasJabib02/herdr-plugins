// T2: the state and settings store (D7, D12). M/store.js owns state.json
// (schema v1, written only by the CLI: tmp + rename, only when it changes),
// reconcile against the refs (an injected readRefs) and the CLI's reading of
// settings.json; M/locks.js the two mkdir locks with {pid, startedAt} stale
// recovery; M/settings.js the pure settings reading (defaults, clamping,
// per-repo opt-in) the mod shares. Every path is injected: these tests run in
// temp dirs and never touch ~/.config or ~/.claude.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createStore, emptyState, emptyRepo, parseState, reconcileRepo, addNote, NOTES_MAX,
  rememberVariant, variantKey, VARIANTS_MAX,
} from "../mods/spotlight/store.js";
import * as storeModule from "../mods/spotlight/store.js";
import { withLock, LockError, OWNER_FILE } from "../mods/spotlight/locks.js";
import {
  parseSettings, defaultSettings, repoSettings, perSpaceLimit, repoEnabledFrom,
} from "../mods/spotlight/settings.js";

const STORE_URL = new URL("../mods/spotlight/store.js", import.meta.url).href;

// Destructured, not named in the imports: a helper that's missing fails its
// own tests, not the whole file's load.
const { markBusy, clearBusy, setTaskBatch, clearTaskBatch } = storeModule;

// ── Helpers ────────────────────────────────────────────────────────────────

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A fresh realpath'd temp dir, removed after the run.
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spotlight-store-")));
  dirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs an ESM snippet in a separate node process.
function runNode(code, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The pid of a process that already exited.
function deadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid));
  });
}

// A live process to own a planted lock; killed after the run.
function liveChild() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  after(() => child.kill());
  return child;
}

// A lock dir as another process would leave it.
function plantLock(dir, owner) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(owner));
}

// Releases a planted lock the way its holder would: moved away in one step,
// so the dir is never seen empty.
function releasePlanted(dir) {
  const gone = `${dir}.test-gone`;
  fs.renameSync(dir, gone);
  fs.rmSync(gone, { recursive: true, force: true });
}

// Lines appended to a file by several processes, in order.
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}

const noServer = () => false;

// ── state.json ─────────────────────────────────────────────────────────────

test("readState: no file reads as the empty v1 state; nothing is created", () => {
  const dir = tmp();
  const store = createStore({ stateDir: path.join(dir, "spotlight"), hasServerCommand: noServer });
  assert.deepEqual(store.readState(), {
    version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [], variants: {},
  });
  assert.deepEqual(emptyState(), store.readState());
  assert.equal(fs.existsSync(path.join(dir, "spotlight")), false);
});

test("updateState: writes schema v1 through tmp + rename, fills repo records, leaves no temp files", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  const res = await store.updateState((s) => {
    s.repos["/code/app"] = { holder: "/code/app-wt", serverState: "listening", ports: [3000] };
    s.queue.requests.push({ terminal: "t1", taskKey: "AX-1", state: "waiting" });
    s.queue.lighting["AX-1"] = { grantId: 1, phase: "pending" };
    return "result";
  });
  assert.equal(res.changed, true);
  assert.equal(res.result, "result");
  const onDisk = JSON.parse(fs.readFileSync(store.paths.statePath, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.repos["/code/app"], {
    ...emptyRepo(), holder: "/code/app-wt", serverState: "listening", ports: [3000],
  });
  assert.deepEqual(onDisk.queue.requests, [{ terminal: "t1", taskKey: "AX-1", state: "waiting" }]);
  assert.deepEqual(onDisk.queue.lighting, { "AX-1": { grantId: 1, phase: "pending" } });
  assert.deepEqual(store.readState(), onDisk);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["locks", "state.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
  assert.deepEqual(Object.keys(emptyRepo()), [
    "holder", "lastSnapshotSha", "lastSyncAt", "lastError", "serverTerminal", "serverPid",
    "serverStartedAt", "serverCommand", "serverEnv", "serverVariant", "serverState",
    "pendingInstalls", "ports", "logPath",
  ]);
});

test("updateState: a write that changes nothing leaves the file and its mtime alone", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await store.updateState((s) => {
    s.repos["/code/app"] = emptyRepo();
  });
  const past = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(store.paths.statePath, past, past);
  const res = await store.updateState((s) => {
    s.repos["/code/app"].holder = null;
  });
  assert.equal(res.changed, false);
  assert.equal(fs.statSync(store.paths.statePath).mtimeMs, past * 1000);
});

test("updateState: the mutator is synchronous (the state lock never spans git); an async one writes nothing", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await assert.rejects(
    store.updateState(async (s) => {
      s.notes.push({ at: 1, text: "x" });
    }),
    TypeError,
  );
  assert.equal(fs.existsSync(store.paths.statePath), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("addNote: keeps the newest 200 notes", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer, now: () => 42 });
  await store.updateState((s) => {
    for (let i = 0; i < NOTES_MAX + 5; i++) addNote(s, { repo: "/code/app", text: `n${i}` }, 42);
    addNote(s, { repo: "/code/app", text: "toast", toast: true, action: { name: "spotlight.server.abc" } }, 43);
  });
  const notes = store.readState().notes;
  assert.equal(NOTES_MAX, 200);
  assert.equal(notes.length, 200);
  assert.equal(notes[0].text, "n6");
  assert.deepEqual(notes.at(-1), {
    at: 43, repo: "/code/app", text: "toast", toast: true, action: { name: "spotlight.server.abc" },
  });
  assert.deepEqual(notes.at(-2), { at: 42, repo: "/code/app", text: `n${NOTES_MAX + 4}`, toast: false });
});

test("variants: the per-task remembered variant, keyed <lane>/<taskKey>::<root>, at most 500, oldest dropped first", async () => {
  assert.equal(VARIANTS_MAX, 500);
  assert.equal(variantKey("g1", "AX-3447", "/code/landing/"), "g1/AX-3447::/code/landing");
  // A state written before the field existed reads with an empty map; bad values are dropped.
  const old = parseState(JSON.stringify({ version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [] }));
  assert.equal(old.valid, true);
  assert.deepEqual(old.state.variants, {});
  assert.deepEqual(
    parseState(JSON.stringify({ version: 1, variants: { "g1/A::/r": "co", "g1/B::/r": 5, "g1/C::/r": "" } })).state.variants,
    { "g1/A::/r": "co" },
  );
  assert.deepEqual(parseState(JSON.stringify({ version: 1, variants: ["co"] })).state.variants, {});
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await store.updateState((s) => {
    for (let i = 0; i < VARIANTS_MAX + 3; i++) rememberVariant(s, variantKey("g1", `T-${i}`, "/code/landing"), "co");
    // Remembering a key again makes it the newest.
    rememberVariant(s, variantKey("g1", "T-3", "/code/landing"), "mx");
  });
  const variants = store.readState().variants;
  const keys = Object.keys(variants);
  assert.equal(keys.length, VARIANTS_MAX);
  assert.equal(keys[0], "g1/T-4::/code/landing", "T-0..T-2 dropped by the cap, T-3 moved to the end");
  assert.equal(keys.at(-1), "g1/T-3::/code/landing");
  assert.equal(variants["g1/T-3::/code/landing"], "mx");
  // Any writer's map is capped the same way, oldest first.
  await store.updateState((s) => {
    s.variants["g1/extra::/code/landing"] = "co";
  });
  assert.equal(Object.keys(store.readState().variants).length, VARIANTS_MAX);
  assert.equal(Object.keys(store.readState().variants)[0], "g1/T-5::/code/landing");
});

test("parseState / updateState: a corrupt or foreign state.json reads as empty and is kept as a backup before the first write over it", async () => {
  assert.deepEqual(parseState("{oops"), { state: emptyState(), valid: false });
  assert.deepEqual(parseState(JSON.stringify({ version: 2, repos: {} })), { state: emptyState(), valid: false });
  assert.deepEqual(parseState(null), { state: emptyState(), valid: true });
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer, now: () => 1234 });
  fs.writeFileSync(path.join(dir, "state.json"), "{oops");
  assert.deepEqual(store.readState(), emptyState());
  // Reading never writes.
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  await store.updateState((s) => {
    s.notes.push({ at: 1, repo: null, text: "fresh", toast: false });
  });
  assert.equal(fs.readFileSync(path.join(dir, "state.json.corrupt-1234"), "utf8"), "{oops");
  assert.equal(store.readState().notes[0].text, "fresh");
});

test("updateState: 8 processes adding 25 entries each under the state lock end with 200", async () => {
  const dir = tmp();
  const code = `
    import { createStore } from ${JSON.stringify(STORE_URL)};
    const store = createStore({ stateDir: process.env.SL_DIR, hasServerCommand: () => false });
    for (let j = 0; j < 25; j++) {
      await store.updateState((s) => {
        s.queue.requests.push({ terminal: process.env.SL_ID + "-" + j });
      });
    }`;
  const runs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => runNode(code, { SL_DIR: dir, SL_ID: `p${i}` })),
  );
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  const requests = createStore({ stateDir: dir, hasServerCommand: noServer }).readState().queue.requests;
  assert.equal(requests.length, 200);
  assert.equal(new Set(requests.map((r) => r.terminal)).size, 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["locks", "state.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

// ── Locks ──────────────────────────────────────────────────────────────────

test("withLock: a lock whose pid is dead is taken over at once", async () => {
  const dir = path.join(tmp(), "state");
  plantLock(dir, { pid: await deadPid(), startedAt: Date.now() - 5000 });
  const t0 = Date.now();
  const got = await withLock(dir, () => JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8")), {
    timeoutMs: 3000,
  });
  assert.ok(Date.now() - t0 < 1000, "taken over without waiting");
  assert.equal(got.pid, process.pid);
  assert.equal(typeof got.startedAt, "number");
  assert.equal(fs.existsSync(dir), false, "released");
});

test("withLock: a lock whose pid was reused (the process started after the lock) is taken over", async () => {
  const dir = path.join(tmp(), "state");
  const child = liveChild();
  plantLock(dir, { pid: child.pid, startedAt: Date.now() - 120_000 });
  const t0 = Date.now();
  assert.equal(await withLock(dir, () => "ran", { timeoutMs: 3000 }), "ran");
  assert.ok(Date.now() - t0 < 1500, "taken over without waiting for the live process");
  assert.equal(child.exitCode, null, "the process that reused the pid is left alone");
});

test("withLock: a live lock is waited on until its holder releases it, and times out otherwise", async () => {
  const dir = path.join(tmp(), "state");
  const child = liveChild();
  plantLock(dir, { pid: child.pid, startedAt: Date.now() });
  await assert.rejects(withLock(dir, () => "never", { timeoutMs: 300 }), (e) => {
    assert.ok(e instanceof LockError);
    assert.equal(e.code, "lock-timeout");
    return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8")).pid, child.pid, "not stolen");
  const t0 = Date.now();
  setTimeout(() => releasePlanted(dir), 1500);
  const waited = await withLock(dir, () => Date.now() - t0, { timeoutMs: 5000 });
  assert.ok(waited >= 1400, `ran only after the release (${waited} ms)`);
});

test("withRepoLock: held across a simulated git step while a second process waits; the state lock stays free", async () => {
  const dir = tmp();
  const marks = path.join(dir, "marks.txt");
  const code = `
    import fs from "node:fs";
    import { createStore } from ${JSON.stringify(STORE_URL)};
    const store = createStore({ stateDir: process.env.SL_DIR, hasServerCommand: () => false });
    const mark = (m) => fs.appendFileSync(process.env.SL_MARKS, m + "\\n");
    await store.withRepoLock("/code/app", async () => {
      mark(process.env.SL_ID + "-start");
      await new Promise((r) => setTimeout(r, Number(process.env.SL_HOLD)));
      mark(process.env.SL_ID + "-end");
    });`;
  const env = { SL_DIR: dir, SL_MARKS: marks };
  const a = runNode(code, { ...env, SL_ID: "A", SL_HOLD: "800" });
  await waitFor(() => lines(marks).includes("A-start"));
  const b = runNode(code, { ...env, SL_ID: "B", SL_HOLD: "0" });
  // Meanwhile a state write goes through: the repo lock never holds state.json.
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await store.updateState((s) => {
    s.notes.push({ at: 1, repo: "/code/app", text: "during", toast: false });
  });
  assert.deepEqual(lines(marks), ["A-start"], "the state write landed while A still held the repo lock");
  for (const r of await Promise.all([a, b])) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(marks), ["A-start", "A-end", "B-start", "B-end"]);
  // Another repo's lock is another dir.
  assert.notEqual(store.repoLockDir("/code/app"), store.repoLockDir("/code/other"));
  assert.match(path.basename(store.repoLockDir("/code/app")), /^repo-[0-9a-f]{40}$/);
});

test("withRepoLock: repo lock then state lock; the reverse order and re-entry are refused", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  const inOrder = await store.withRepoLock("/code/app", () =>
    store.updateState((s) => {
      s.repos["/code/app"] = emptyRepo();
    }));
  assert.equal(inOrder.changed, true);
  let inner;
  await store.updateState(() => {
    inner = store.withRepoLock("/code/app", () => "never");
    inner.catch(() => {});
  });
  await assert.rejects(inner, { code: "lock-order" });
  await assert.rejects(store.withRepoLock("/code/app", () => store.withRepoLock("/code/app", () => 1)), {
    code: "lock-reentry",
  });
  assert.deepEqual(fs.readdirSync(path.join(dir, "locks")), []);
});

test("withRepoLock: a per-call timeoutMs bounds the wait; 0 tries once (J-001)", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer, locks: { repo: { timeoutMs: 3000 } } });
  let release;
  const held = store.withRepoLock("/code/app", () => new Promise((r) => { release = r; }));
  await waitFor(() => fs.existsSync(store.repoLockDir("/code/app")));
  for (const timeoutMs of [0, 300]) {
    const t0 = Date.now();
    await assert.rejects(store.withRepoLock("/code/app", () => "never", { timeoutMs }), { code: "lock-timeout" });
    assert.ok(Date.now() - t0 < 1500, `waited ${Date.now() - t0} ms with timeoutMs ${timeoutMs}`);
  }
  release();
  await held;
  // A free lock is taken on the one try.
  assert.equal(await store.withRepoLock("/code/app", () => "ran", { timeoutMs: 0 }), "ran");
});

test("state.json keeps a repo's envOverride (the server popup's env, J-002): an additive v1 field", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await store.updateState((s) => {
    s.repos["/code/app"] = { ...emptyRepo(), holder: "/code/app-wt", envOverride: "dev" };
  });
  assert.equal(store.readState().repos["/code/app"].envOverride, "dev");
  const text = JSON.stringify({ version: 1, repos: { "/code/app": { envOverride: "prod" } } });
  assert.equal(parseState(text).state.repos["/code/app"].envOverride, "prod");
});

// ── D33: the busy mark; D31: the task batch marker ─────────────────────────

const MARK = { op: "light", since: 10, pid: 4242, workspace: "/code/app-wt" };

test("busy (D33): a record's { op, since, pid, workspace } mark is an additive v1 field, kept through a write; a malformed one is dropped", async () => {
  const read = (busy) =>
    parseState(JSON.stringify({ version: 1, repos: { "/code/app": { holder: "/code/app-wt", busy } } })).state.repos["/code/app"];
  assert.deepEqual(read(MARK).busy, MARK);
  // A fresh light's target, or a turn-off of refs with no holder.
  assert.deepEqual(read({ ...MARK, workspace: null }).busy, { ...MARK, workspace: null });
  for (const bad of [null, "light", [MARK], { ...MARK, pid: 0 }, { ...MARK, pid: "4242" }, { ...MARK, pid: 1.5 }, { ...MARK, since: "10" },
    { ...MARK, since: null }, { ...MARK, op: "" }, { ...MARK, op: 3 }, { ...MARK, workspace: "code/app-wt" }, { ...MARK, workspace: 5 }]) {
    const record = read(bad);
    assert.equal("busy" in record, false, JSON.stringify(bad));
    assert.equal(record.holder, "/code/app-wt", "the rest of the record stays");
  }
  // Not one of emptyRepo's fields: a record that isn't busy has none.
  assert.equal("busy" in emptyRepo(), false);
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  await store.updateState((s) => {
    s.repos["/code/app"] = { ...emptyRepo(), holder: "/code/app-wt", busy: MARK };
  });
  assert.deepEqual(store.readState().repos["/code/app"].busy, MARK);
});

test("markBusy / clearBusy (D33): one mark per repo, set by whoever holds its lock, cleared only by the same (pid, since); a record made only for the mark goes with it", () => {
  const s = emptyState();
  const root = "/code/app";
  assert.equal(markBusy(s, root, MARK), false, "no record, and not asked to make one");
  assert.equal(s.repos[root], undefined);
  // A fresh light: its record is made for the mark, so its target's row can spin.
  assert.equal(markBusy(s, root, MARK, { create: true }), true);
  assert.deepEqual(s.repos[root], { ...emptyRepo(), busy: MARK });
  // The same process marking again (a nested call) leaves the outer call's mark.
  assert.equal(markBusy(s, root, { ...MARK, op: "restart", since: 11 }), false);
  assert.deepEqual(s.repos[root].busy, MARK);
  // Another process's mark under the repo lock is a dead one's: replaced.
  const next = { op: "off", since: 12, pid: 4343, workspace: "/code/app-wt" };
  assert.equal(markBusy(s, root, next), true);
  assert.deepEqual(s.repos[root].busy, next);
  // Only the mark that is there is cleared.
  assert.equal(clearBusy(s, root, MARK), false);
  assert.equal(clearBusy(s, root, { ...next, since: 13 }), false);
  assert.deepEqual(s.repos[root].busy, next);
  // Cleared, the record holds nothing but emptyRepo's values: it goes.
  assert.equal(clearBusy(s, root, next), true);
  assert.equal(s.repos[root], undefined);
  assert.equal(clearBusy(s, root, next), false, "nothing to clear");
  // A record with anything of its own stays, without the mark.
  for (const own of [{ holder: "/code/app-wt" }, { envOverride: "dev" }, { lastError: { code: "git-failed", message: "x", at: 1 } }]) {
    s.repos[root] = { ...emptyRepo(), ...own };
    assert.equal(markBusy(s, root, MARK), true);
    assert.equal(clearBusy(s, root, MARK), true);
    assert.deepEqual(s.repos[root], { ...emptyRepo(), ...own }, JSON.stringify(own));
  }
});

test("queue.taskBatch (D31): { op, since, pid } per <groupId>/<KEY> while a batch runs; set and cleared by the same rule; malformed entries dropped, absent stays absent", () => {
  const batch = { op: "on", since: 10, pid: 4242 };
  const s = emptyState();
  setTaskBatch(s, "g1/AX-50", batch);
  assert.deepEqual(s.queue.taskBatch, { "g1/AX-50": batch });
  assert.equal(clearTaskBatch(s, "g1/AX-50", { ...batch, since: 11 }), false);
  assert.equal(clearTaskBatch(s, "g1/AX-50", { ...batch, pid: 4343 }), false);
  assert.deepEqual(s.queue.taskBatch, { "g1/AX-50": batch });
  setTaskBatch(s, "g2/AX-50", { ...batch, op: "off" });
  assert.equal(clearTaskBatch(s, "g1/AX-50", batch), true);
  assert.deepEqual(s.queue.taskBatch, { "g2/AX-50": { ...batch, op: "off" } });
  assert.equal(clearTaskBatch(s, "g2/AX-50", { ...batch, op: "off" }), true);
  assert.equal("taskBatch" in s.queue, false, "the last one cleared leaves the queue as it was");
  assert.equal(clearTaskBatch(s, "g2/AX-50", batch), false);

  const queueOf = (taskBatch) =>
    parseState(JSON.stringify({ version: 1, queue: { requests: [], lighting: {}, ...(taskBatch === undefined ? {} : { taskBatch }) } })).state.queue;
  assert.deepEqual(
    queueOf({ "g1/AX-1": batch, "g1/AX-2": { op: "on" }, "g1/AX-3": 5, "g1/AX-4": { ...batch, pid: -1 }, "g1/AX-5": { ...batch, op: "" } }).taskBatch,
    { "g1/AX-1": batch },
  );
  assert.equal("taskBatch" in queueOf([batch]), false);
  assert.equal("taskBatch" in queueOf(undefined), false, "a state from before the field reads as it was");
  assert.deepEqual(emptyState().queue, { requests: [], lighting: {} });
});

// ── reconcile ──────────────────────────────────────────────────────────────

// T1's readRefs(root) result (sync.js): `active` only when the snapshot,
// backup and original-head refs all exist; a null rootHeadSha means the read
// failed. It never throws.
function refsOf(over = {}) {
  const r = { snapshotSha: "s1", backupSha: "b1", originalHeadSha: "h1", originalBranch: "main", rootHeadSha: "s1", ...over };
  return { ...r, active: Boolean(r.snapshotSha && r.backupSha && r.originalHeadSha) };
}
const REFS = refsOf();
const NO_REFS = refsOf({ snapshotSha: null, backupSha: null, originalHeadSha: null, originalBranch: null });
const READ_FAILED = refsOf({ snapshotSha: null, backupSha: null, originalHeadSha: null, originalBranch: null, rootHeadSha: null });

test("reconcileRepo: the port of Orca's reconcile, plus orphan refs, deciding from readRefs().active", () => {
  const rec = { ...emptyRepo(), holder: "/code/app-wt" };
  assert.equal(REFS.active, true);
  assert.deepEqual(reconcileRepo(rec, REFS, 9), { action: "keep" });
  // A failed read (rootHeadSha null) leaves the record untouched, even though nothing reads as active.
  assert.deepEqual(reconcileRepo(rec, READ_FAILED, 9), { action: "keep" });
  assert.deepEqual(reconcileRepo(rec, refsOf({ rootHeadSha: null }), 9), { action: "keep" });
  assert.deepEqual(reconcileRepo(rec, null, 9), { action: "keep" });
  // Refs gone, or partial (not active): the record is stale.
  assert.deepEqual(reconcileRepo(rec, NO_REFS, 9), { action: "clear" });
  assert.deepEqual(reconcileRepo(rec, refsOf({ snapshotSha: null }), 9), { action: "clear" });
  assert.deepEqual(reconcileRepo(rec, refsOf({ backupSha: null }), 9), { action: "clear" });
  assert.deepEqual(reconcileRepo(rec, refsOf({ originalHeadSha: null }), 9), { action: "clear" });
  const diverged = reconcileRepo(rec, { ...REFS, rootHeadSha: "other" }, 9);
  assert.equal(diverged.action, "diverged");
  assert.equal(diverged.record.holder, "/code/app-wt");
  assert.equal(diverged.record.lastError.code, "root-diverged");
  assert.equal(diverged.record.lastError.at, 9);
  // Already flagged: nothing to write.
  assert.deepEqual(reconcileRepo(diverged.record, { ...REFS, rootHeadSha: "other" }, 10), { action: "keep" });
  const orphan = reconcileRepo(null, REFS, 9);
  assert.equal(orphan.action, "orphan");
  assert.equal(orphan.record.lastError.message, "Hay refs de Spotlight en este repo sin registro de quién las tiene; apagar Spotlight restaura el root desde ellas.");
  assert.deepEqual(orphan.record, {
    ...emptyRepo(), lastSnapshotSha: "s1", lastError: { code: "orphan-refs", message: orphan.record.lastError.message, at: 9 },
  });
  assert.deepEqual(reconcileRepo(orphan.record, { ...REFS, rootHeadSha: "other" }, 10), { action: "keep" });
  assert.deepEqual(reconcileRepo(null, NO_REFS, 9), { action: "keep" });
  assert.deepEqual(reconcileRepo(null, refsOf({ backupSha: null }), 9), { action: "keep" }, "partial refs are no orphan");
  assert.deepEqual(reconcileRepo(null, READ_FAILED, 9), { action: "keep" });
});

test("reconcile: refs win; a repo whose refs are gone is cleared, failed reads keep it, orphan refs get a red record", async () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer, now: () => 77 });
  await store.updateState((s) => {
    for (const r of ["/r/gone", "/r/partial", "/r/unreadable", "/r/throws", "/r/diverged", "/r/ok"]) {
      s.repos[r] = { ...emptyRepo(), holder: `${r}-wt`, serverTerminal: `sl-${r.slice(3)}` };
    }
  });
  const refs = {
    "/r/gone": NO_REFS,
    "/r/partial": refsOf({ backupSha: null }),
    "/r/unreadable": READ_FAILED,
    "/r/diverged": { ...REFS, rootHeadSha: "moved" },
    "/r/ok": REFS,
    "/r/orphan": REFS,
    "/r/plain": NO_REFS,
  };
  const readRefs = async (root) => {
    // T1's reader never throws; one that does still leaves its repo alone.
    if (root === "/r/throws") throw new Error("disk gone");
    return refs[root];
  };
  const report = await store.reconcile({ readRefs, roots: ["/r/orphan", "/r/plain/", "/r/ok"] });
  const state = store.readState();
  assert.deepEqual(Object.keys(state.repos).sort(), ["/r/diverged", "/r/ok", "/r/orphan", "/r/throws", "/r/unreadable"]);
  assert.equal(state.repos["/r/diverged"].lastError.code, "root-diverged");
  assert.equal(state.repos["/r/orphan"].lastError.code, "orphan-refs");
  assert.equal(state.repos["/r/orphan"].holder, null);
  assert.equal(state.repos["/r/ok"].lastError, null);
  assert.deepEqual(
    report.map((r) => [r.root, r.action]).sort(),
    [["/r/diverged", "diverged"], ["/r/gone", "clear"], ["/r/orphan", "orphan"], ["/r/partial", "clear"]],
  );
  // The cleared record comes back, so the CLI can stop its server.
  assert.equal(report.find((r) => r.root === "/r/gone").record.serverTerminal, "sl-gone");
  assert.equal(state.repos["/r/unreadable"].holder, "/r/unreadable-wt", "a failed read leaves the record untouched");
  // A second run changes nothing and writes nothing.
  const past = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(store.paths.statePath, past, past);
  assert.deepEqual(await store.reconcile({ readRefs, roots: ["/r/orphan"] }), []);
  assert.equal(fs.statSync(store.paths.statePath).mtimeMs, past * 1000);
  await assert.rejects(store.reconcile({}), TypeError);
});

// ── settings.json ──────────────────────────────────────────────────────────

test("parseSettings: no file reads as the defaults (queue on, 1 per space, cap 2, auto-resume off)", () => {
  assert.deepEqual(parseSettings(null), { settings: defaultSettings(), valid: true });
  assert.deepEqual(defaultSettings(), {
    version: 1, queue: { enabled: true, perSpace: {}, cap: 2, autoResume: false }, repos: {},
  });
  const s = defaultSettings();
  assert.equal(perSpaceLimit(s, "g1"), 1);
  assert.equal(perSpaceLimit(s, "spaceless"), 1);
  assert.deepEqual(repoSettings(s, "/code/app"), {
    enabled: null, envs: { local: null, dev: null, prod: null }, env: "local", port: null,
  });
});

test("parseSettings: values are clamped or fall back field by field", () => {
  const { settings, valid } = parseSettings(JSON.stringify({
    version: 1,
    queue: { enabled: false, perSpace: { g1: 0, g2: 3.4, g3: "x", spaceless: 7 }, cap: 9, autoResume: true },
    repos: {
      "/code/app/": {
        enabled: false,
        envs: { local: "  pnpm dev  ", dev: "pnpm dev\nrm -rf x", prod: 5 },
        env: "dev",
        port: 3000,
      },
      "/code/web": { enabled: "yes", envs: "nope", env: "staging", port: 70000 },
      "relative/path": { enabled: true },
      "/code/bad": "nope",
    },
  }));
  assert.equal(valid, true);
  assert.deepEqual(settings.queue, { enabled: false, perSpace: { g1: 1, g2: 3, spaceless: 4 }, cap: 4, autoResume: true });
  assert.deepEqual(settings.repos, {
    "/code/app": { enabled: false, envs: { local: "pnpm dev", dev: null, prod: null }, env: "dev", port: 3000 },
    "/code/web": { enabled: null, envs: { local: null, dev: null, prod: null }, env: "local", port: null },
  });
  assert.equal(perSpaceLimit(settings, "g2"), 3);
  assert.equal(perSpaceLimit(settings, "g3"), 1);
  assert.deepEqual(repoSettings(settings, "/code/app/"), settings.repos["/code/app"]);
  assert.equal(parseSettings({ version: 1, queue: { cap: 0 } }).settings.queue.cap, 1);
  assert.equal(parseSettings({ version: 1, queue: { cap: -3, enabled: "no", autoResume: 1 } }).settings.queue.cap, 1);
  assert.deepEqual(parseSettings({ version: 1, queue: { enabled: "no", autoResume: 1 } }).settings.queue, defaultSettings().queue);
  assert.equal(parseSettings({ version: 1, queue: { cap: 3 } }).settings.queue.cap, 3);
  assert.deepEqual(parseSettings({ version: 1, repos: { "/a": { port: 3000.5 } } }).settings.repos["/a"].port, null);
});

test("readSettings: an invalid settings file falls back to the defaults and is kept as a backup, once", () => {
  const dir = tmp();
  const store = createStore({ stateDir: dir, hasServerCommand: noServer });
  fs.writeFileSync(store.paths.settingsPath, "{ queue: broken");
  const first = store.readSettings();
  assert.deepEqual(first.settings, defaultSettings());
  assert.equal(first.valid, false);
  assert.equal(fs.readFileSync(first.backupPath, "utf8"), "{ queue: broken");
  assert.equal(path.dirname(first.backupPath), dir);
  // The CLI never writes settings.json itself, and the same bad content is backed up only once.
  assert.equal(fs.readFileSync(store.paths.settingsPath, "utf8"), "{ queue: broken");
  assert.equal(store.readSettings().backupPath, first.backupPath);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.")).length, 1);
  // A foreign version is invalid too; a missing file is just the defaults.
  fs.writeFileSync(store.paths.settingsPath, JSON.stringify({ version: 2 }));
  assert.equal(store.readSettings().valid, false);
  fs.rmSync(store.paths.settingsPath);
  assert.deepEqual(store.readSettings(), { settings: defaultSettings(), valid: true, backupPath: null });
  assert.equal(store.paths.settingsPath, path.join(dir, "settings.json"));
});

// A machine: app home (shared.json), a ~/.claude stand-in, and repos.
function machine() {
  const root = tmp();
  const app = path.join(root, "app");
  const repo = (name, scripts, { git = true } = {}) => {
    const r = path.join(root, name);
    fs.mkdirSync(r, { recursive: true });
    if (git) fs.mkdirSync(path.join(r, ".git"));
    if (scripts) fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ scripts }));
    return r;
  };
  const web = repo("web", { dev: "next dev", build: "next build" });
  const plain = repo("plain", { lint: "eslint ." });
  const loose = repo("loose", { dev: "vite" });
  const nogit = repo("nogit", { dev: "vite" }, { git: false });
  const claude = repo("claude-home", null);
  const claudeLink = path.join(root, "claude-link");
  fs.symlinkSync(claude, claudeLink);
  const registry = {
    version: 1,
    activeGroup: "g1",
    groups: [{ id: "g1", name: "Arrecife", projects: [web, plain, nogit, claudeLink].map((p) => ({ path: p, name: path.basename(p) })) }],
  };
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "shared.json"), JSON.stringify({ "projects.v1": registry, layout: {} }));
  const calls = [];
  // Stands in for T5a: a server command when package.json has local/dev/prod.
  const hasServerCommand = (r) => {
    calls.push(r);
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(r, "package.json"), "utf8")).scripts ?? {};
      return ["local", "dev", "prod"].some((k) => typeof scripts[k] === "string");
    } catch {
      return false;
    }
  };
  return { root, app, web, plain, loose, nogit, claude, claudeLink, registry, calls, hasServerCommand };
}

test("repoEnabled: on by default only for a registered git repo with a server command; ~/.claude is always off", async () => {
  const m = machine();
  const store = createStore({
    appHome: m.app, stateDir: path.join(m.app, "spotlight"), claudeDir: m.claude, hasServerCommand: m.hasServerCommand,
  });
  assert.equal(await store.repoEnabled(m.web), true, "registered, with a dev script");
  assert.equal(await store.repoEnabled(`${m.web}/`), true, "same root with a trailing slash");
  assert.equal(await store.repoEnabled(m.plain), false, "registered, no server script");
  assert.equal(await store.repoEnabled(m.loose), false, "not registered");
  assert.equal(await store.repoEnabled(m.nogit), false, "registered, but not a git repo");
  assert.equal(store.isRegistered(m.web), true);
  assert.equal(store.isRegistered(m.claude), true, "registered through its symlink");
  assert.equal(store.isHarnessRoot(m.claudeLink), true);
  assert.equal(store.isHarnessRoot(m.web), false);

  // The setting wins over the default, except for ~/.claude.
  fs.mkdirSync(path.dirname(store.paths.settingsPath), { recursive: true });
  fs.writeFileSync(store.paths.settingsPath, JSON.stringify({
    version: 1,
    repos: { [m.web]: { enabled: false }, [m.loose]: { enabled: true }, [m.claudeLink]: { enabled: true }, [m.claude]: { enabled: true } },
  }));
  m.calls.length = 0;
  assert.equal(await store.repoEnabled(m.web), false, "turned off in settings");
  assert.equal(await store.repoEnabled(m.loose), true, "turned on in settings");
  assert.equal(await store.repoEnabled(m.claudeLink), false, "~/.claude-like path through a symlink, enabled: true");
  assert.equal(await store.repoEnabled(m.claude), false, "~/.claude-like path, enabled: true");
  assert.deepEqual(m.calls, [], "an explicit setting or the harness never asks for a server command");
  // Settings already read can be passed in.
  assert.equal(await store.repoEnabled(m.plain, parseSettings({ version: 1, repos: { [m.plain]: { enabled: true } } }).settings), true);
});

test("repoEnabled: a missing or malformed shared.json registers nothing; a missing server check fails loudly", async () => {
  const m = machine();
  fs.writeFileSync(path.join(m.app, "shared.json"), "{not json");
  const store = createStore({
    appHome: m.app, stateDir: path.join(m.app, "spotlight"), claudeDir: m.claude, hasServerCommand: m.hasServerCommand,
  });
  assert.equal(store.isRegistered(m.web), false);
  assert.equal(await store.repoEnabled(m.web), false);
  const injected = createStore({
    stateDir: path.join(m.app, "spotlight"), claudeDir: m.claude, readProjects: () => m.registry, hasServerCommand: m.hasServerCommand,
  });
  assert.equal(await injected.repoEnabled(m.web), true, "an injected projects.v1 reader");
  const unwired = createStore({ stateDir: path.join(m.app, "spotlight"), claudeDir: m.claude, readProjects: () => m.registry });
  await assert.rejects(unwired.repoEnabled(m.web), /hasServerCommand/);
});

test("repoEnabledFrom: the pure rule the settings view shares", () => {
  const unset = repoSettings(defaultSettings(), "/code/app");
  const facts = { harness: false, registered: true, gitRepo: true, hasServerCommand: true };
  assert.equal(repoEnabledFrom(unset, facts), true);
  assert.equal(repoEnabledFrom(unset, { ...facts, hasServerCommand: false }), false);
  assert.equal(repoEnabledFrom(unset, { ...facts, registered: false }), false);
  assert.equal(repoEnabledFrom(unset, { ...facts, gitRepo: false }), false);
  assert.equal(repoEnabledFrom({ ...unset, enabled: false }, facts), false);
  assert.equal(repoEnabledFrom({ ...unset, enabled: true }, { ...facts, registered: false }), true);
  assert.equal(repoEnabledFrom({ ...unset, enabled: true }, { ...facts, harness: true }), false);
});
