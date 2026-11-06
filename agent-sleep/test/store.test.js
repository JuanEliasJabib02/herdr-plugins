import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, paths, parseSettings, parseRecords, serializeRecords,
  loadSettings, loadRecords, saveRecords, withRecord, withoutRecord, reconcile, claim,
} from "../mods/agent-sleep/store.js";

const HOME = "/home/x/.config/herdr-app";
const P = paths(HOME);
const MIN = 60_000;

// An in-memory stand-in for Herdr's readTextFile / writeTextFile: a write
// succeeds only when `expected` matches the current text (null = absent).
function fakeIo(files = {}) {
  const store = { ...files };
  return {
    files: store,
    read: async (path) => (path in store ? store[path] : null),
    write: async (path, text, expected) => {
      const current = path in store ? store[path] : null;
      if (current !== expected) throw new Error(`stale snapshot for ${path}`);
      store[path] = text;
      return null;
    },
  };
}

const rec = (over = {}) => ({
  state: "asleep",
  sessionId: "00000000-0000-4000-8000-000000000001",
  cwd: "/repo/ws",
  flags: ["--dangerously-skip-permissions"],
  workspacePath: "/repo/ws",
  rssKb: 300_000,
  rootPid: 100,
  holder: "h1",
  at: 1_000_000,
  by: "auto",
  ...over,
});

const shellTerm = (address, over = {}) => ({
  address, pid: 100, foreground: { name: "zsh", pid: 100 }, status: null, ...over,
});
const claudeTerm = (address, over = {}) => ({
  address, pid: 100, foreground: { name: "claude.exe", pid: 200 }, status: { app: "claude-code", state: "done" }, ...over,
});

test("paths live under appHome()/agent-sleep", () => {
  assert.equal(P.dir, `${HOME}/agent-sleep`);
  assert.equal(P.settings, `${HOME}/agent-sleep/settings.json`);
  assert.equal(P.sleeping, `${HOME}/agent-sleep/sleeping.json`);
  assert.equal(P.sleepingBak, `${HOME}/agent-sleep/sleeping.json.bak`);
  assert.equal(paths(`${HOME}/`).dir, `${HOME}/agent-sleep`);
});

test("settings: absent file → defaults (off, 30 min), not bad", () => {
  assert.deepEqual(parseSettings(null), { settings: DEFAULT_SETTINGS, bad: false });
  assert.deepEqual(DEFAULT_SETTINGS, { enabled: false, idleMinutes: 30 });
});

test("settings: valid values are kept", () => {
  const { settings, bad } = parseSettings(JSON.stringify({ enabled: false, idleMinutes: 45 }));
  assert.deepEqual(settings, { enabled: false, idleMinutes: 45 });
  assert.equal(bad, false);
});

test("settings: idleMinutes out of 1..1440 or not a whole number → 30", () => {
  for (const v of [0, 99999, -5, 1.5, "10", null]) {
    const { settings } = parseSettings(JSON.stringify({ enabled: true, idleMinutes: v }));
    assert.equal(settings.idleMinutes, 30, `idleMinutes ${JSON.stringify(v)}`);
  }
  assert.equal(parseSettings(JSON.stringify({ idleMinutes: 1 })).settings.idleMinutes, 1);
  assert.equal(parseSettings(JSON.stringify({ idleMinutes: 1440 })).settings.idleMinutes, 1440);
});

test("settings: a broken file → defaults, flagged bad", () => {
  for (const text of ["{nope", "[]", "42", '"x"']) {
    assert.deepEqual(parseSettings(text), { settings: DEFAULT_SETTINGS, bad: true }, text);
  }
  assert.equal(parseSettings(JSON.stringify({ enabled: "yes" })).settings.enabled, false);
});

test("records: absent → empty, not bad; round trip through serialize", () => {
  assert.deepEqual(parseRecords(null), { records: {}, bad: false });
  const records = { t1: rec(), t2: rec({ state: "live", by: "restart" }) };
  assert.deepEqual(parseRecords(serializeRecords(records)), { records, bad: false });
  assert.equal(JSON.parse(serializeRecords(records)).version, 1);
});

test("records: broken JSON, another version or a non-object → empty, bad", () => {
  for (const text of ["{oops", JSON.stringify({ version: 2, records: {} }), JSON.stringify({ version: 1, records: [] }), "null"]) {
    assert.deepEqual(parseRecords(text), { records: {}, bad: true }, text);
  }
});

test("records: an invalid entry is dropped and the file flagged bad", () => {
  const text = JSON.stringify({
    version: 1,
    records: {
      t1: rec(),
      t2: rec({ state: "dreaming" }),
      t3: rec({ sessionId: "" }),
      t4: rec({ flags: ["ok", 3] }),
      t5: rec({ by: "someone" }),
      t6: rec({ at: "yesterday" }),
    },
  });
  const { records, bad } = parseRecords(text);
  assert.deepEqual(Object.keys(records), ["t1"]);
  assert.equal(bad, true);
});

test("records: optional fields may be null", () => {
  const r = rec({ workspacePath: null, rssKb: null, rootPid: null, holder: null });
  assert.deepEqual(parseRecords(serializeRecords({ t1: r })).records, { t1: r });
});

test("loadSettings / loadRecords read through the injected io", async () => {
  const io = fakeIo({ [P.settings]: JSON.stringify({ enabled: false, idleMinutes: 10 }), [P.sleeping]: serializeRecords({ t1: rec() }) });
  assert.deepEqual(await loadSettings(io, P), { enabled: false, idleMinutes: 10 });
  const loaded = await loadRecords(io, P);
  assert.deepEqual(loaded.records, { t1: rec() });
  assert.equal(loaded.text, io.files[P.sleeping]);
});

test("a broken sleeping.json loads as empty and is kept as .bak", async () => {
  const io = fakeIo({ [P.sleeping]: "{broken" });
  const loaded = await loadRecords(io, P);
  assert.deepEqual(loaded.records, {});
  assert.equal(loaded.text, "{broken");
  assert.equal(io.files[P.sleepingBak], "{broken");
  // the next save replaces the broken file (its text is the expected snapshot)
  await saveRecords(io, P, { t1: rec() }, loaded.text);
  assert.deepEqual(parseRecords(io.files[P.sleeping]).records, { t1: rec() });
  assert.equal(io.files[P.sleepingBak], "{broken");
});

test("a .bak already there is replaced by the newer broken file", async () => {
  const io = fakeIo({ [P.sleeping]: "{second", [P.sleepingBak]: "{first" });
  await loadRecords(io, P);
  assert.equal(io.files[P.sleepingBak], "{second");
});

test("saveRecords is a compare-and-swap: a stale expected write is refused", async () => {
  const io = fakeIo();
  const first = await saveRecords(io, P, { t1: rec() }, null);
  assert.equal(first, io.files[P.sleeping]);
  const second = await saveRecords(io, P, { t1: rec(), t2: rec() }, first);
  await assert.rejects(saveRecords(io, P, {}, first), /stale/);
  assert.equal(io.files[P.sleeping], second);
});

test("saveRecords asks the io to create the folder when it can", async () => {
  const io = fakeIo();
  const made = [];
  io.mkdirp = async (dir) => { made.push(dir); };
  await saveRecords(io, P, {}, null);
  assert.deepEqual(made, [P.dir]);
});

test("withRecord / withoutRecord never mutate their input", () => {
  const before = { t1: rec() };
  const after = withRecord(before, "t2", rec({ state: "stopping" }));
  assert.deepEqual(Object.keys(before), ["t1"]);
  assert.deepEqual(Object.keys(after), ["t1", "t2"]);
  const removed = withoutRecord(after, "t1");
  assert.deepEqual(Object.keys(removed), ["t2"]);
  assert.deepEqual(Object.keys(after), ["t1", "t2"]);
});

test("reconcile: stopping → asleep when the shell is back, even at 12 s", () => {
  const records = { t1: rec({ state: "stopping", at: 1_000_000 }) };
  const out = reconcile({ records, terminals: [shellTerm("t1")], now: 1_000_000 + 12_000, idleMs: 30 * MIN });
  assert.equal(out.records.t1.state, "asleep");
  assert.equal(out.records.t1.sessionId, records.t1.sessionId);
  assert.deepEqual(out.failed, []);
  assert.equal(out.changed, true);
});

test("reconcile: stopping kept while Claude is still the foreground inside the window", () => {
  const records = { t1: rec({ state: "stopping" }) };
  const out = reconcile({ records, terminals: [claudeTerm("t1")], now: 1_000_000 + 5 * MIN, idleMs: 30 * MIN });
  assert.equal(out.records.t1.state, "stopping");
  assert.equal(out.changed, false);
});

test("reconcile: stopping dropped after one idle window with Claude still there", () => {
  const records = { t1: rec({ state: "stopping" }) };
  const out = reconcile({ records, terminals: [claudeTerm("t1")], now: 1_000_000 + 30 * MIN, idleMs: 30 * MIN });
  assert.equal(out.records.t1, undefined);
  assert.deepEqual(out.failed, ["t1"]);
});

test("reconcile: stopping dropped at once when Claude went back to work", () => {
  const records = { t1: rec({ state: "stopping" }) };
  for (const status of [{ app: "claude-code", state: "working" }, "working"]) {
    const out = reconcile({ records, terminals: [claudeTerm("t1", { status })], now: 1_000_000 + MIN, idleMs: 30 * MIN });
    assert.equal(out.records.t1, undefined);
    assert.deepEqual(out.failed, ["t1"]);
  }
});

test("reconcile: any record whose terminal is gone is dropped (not failed)", () => {
  const records = { t1: rec(), t2: rec({ state: "live" }), t3: rec({ state: "stopping" }) };
  const out = reconcile({ records, terminals: [], now: 2_000_000, idleMs: 30 * MIN });
  assert.deepEqual(out.records, {});
  assert.deepEqual(out.failed, []);
  assert.equal(out.changed, true);
});

test("reconcile: asleep and live records with their terminal stay as they are", () => {
  const records = { t1: rec(), t2: rec({ state: "live" }) };
  const out = reconcile({ records, terminals: [shellTerm("t1"), claudeTerm("t2")], now: 2_000_000, idleMs: 30 * MIN });
  assert.deepEqual(out.records, records);
  assert.equal(out.changed, false);
});

test("reconcile: no terminal list means no evidence, so nothing is dropped", () => {
  const records = { t1: rec(), t2: rec({ state: "stopping" }) };
  const out = reconcile({ records, terminals: undefined, now: 9_999_999, idleMs: 30 * MIN });
  assert.deepEqual(out.records, records);
});

test("claim: an asleep record is claimable once", () => {
  const records = { t1: rec(), t2: rec({ state: "live" }) };
  const first = claim(records, "t1");
  assert.deepEqual(first.claimed, records.t1);
  assert.deepEqual(Object.keys(first.records), ["t2"]);
  const second = claim(first.records, "t1");
  assert.equal(second.claimed, null);
  assert.equal(second.records, first.records);
});

test("claim: stopping and live records are not claimable by a reveal", () => {
  const records = { t1: rec({ state: "stopping" }), t2: rec({ state: "live" }) };
  assert.equal(claim(records, "t1").claimed, null);
  assert.equal(claim(records, "t2").claimed, null);
  assert.equal(claim(records, "t2", { states: ["live"] }).claimed.state, "live");
});

// T5, J-003: the optional `env` a Claude's exit hint asked for (Log L10).
// Any `NAME=VALUE` is storable, so a Claude kept asleep for an env the
// resume can't replay stays held across reloads; resume.js says which ones
// it replays.
test("records: env is optional and, when set, must be NAME=VALUE with no whitespace or control character", () => {
  const ok = [undefined, null, "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1", "_X=1", "A1=1", "FOO=bar", "lower=1", "X=1;rm", "X=a=b"];
  for (const env of ok) {
    const records = { t1: env === undefined ? rec() : rec({ env }) };
    const parsed = parseRecords(serializeRecords(records));
    assert.equal(parsed.bad, false, `env ${JSON.stringify(env)}`);
    assert.deepEqual(parsed.records, records);
  }
  const bad = [
    "", "X", "=1", "X=", "1X=1", "X-Y=1", "X=1 Y=1", "FOO=a b", "FOO=a\tb", "FOO=a\nb", "FOO=a b",
    "FOO=a\u0001b", "FOO=a\u001bb", "FOO=a\u007fb", "FOO=a\u0085b", 1, ["X=1"],
  ];
  for (const env of bad) {
    const parsed = parseRecords(serializeRecords({ t1: rec({ env }) }));
    assert.equal(parsed.bad, true, `env ${JSON.stringify(env)}`);
    assert.deepEqual(parsed.records, {}, `env ${JSON.stringify(env)}`);
  }
});

test("records: an asleep record holding an env the resume can't replay survives a save and a load (J-003)", async () => {
  const io = fakeIo();
  const records = { t1: rec({ env: "FOO=bar" }) };
  await saveRecords(io, P, records, null);
  const loaded = await loadRecords(io, P);
  assert.deepEqual(loaded.records, records);
  assert.equal(io.files[P.sleepingBak], undefined, "not a bad file");
});
