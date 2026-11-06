// claude-accounts T10: Usage details & history (S7, D11).
//   cli/details.mjs    `details --range <7|30|90|all>`: claude-usage --json in
//                      a detached runner, its result kept in details.json per
//                      range (the cache), the last result kept while a run
//                      goes and after one fails, one run per range at a time,
//                      and a run whose runner is gone started again.
//   details-model.js   what the window draws, from details.json: the range
//                      picker, the cards, the cache figures with "since
//                      <date>" and the coverage note, the daily chart, by
//                      model, project and account, the time to each limit
//                      and recent sessions, plus "Updated Xm ago" while a run
//                      goes (the stale label).
// claude-accounts T20b (S7 S6, D24): Orca's eight cards in Orca's order, its
// cost format and unpriced suffix, by model and by project with sessions and
// turns, recent sessions with Orca's seven columns, a "since" and coverage
// note per group of figures, and "n/a" for each key an older claude-usage
// doesn't print.
//
// Every CLI run is the installed form, the bin through its shebang, inside a
// sandbox of its own: HOME and CLAUDE_ACCOUNTS_HOME are tmp folders and
// CLAUDE_ACCOUNTS_USAGE_BIN is a fake claude-usage that prints a fixture.
// Nothing here runs the real claude-usage or reaches the person's state:
// sandbox() asserts every path lies under this test's tmp root. Every
// detached runner a test starts is killed when the test ends.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readDetails } from "../claude-accounts/mods/claude-accounts/store.js";
import {
  RANGES, pickRange, formatTokens, formatCount, formatActiveTime, formatCost, chartBars, detailsModel,
} from "../claude-accounts/mods/claude-accounts/details-model.js";

// Dates are local, as in Herdr's runtime: read in Bogota, the fixtures' zone.
process.env.TZ = "America/Bogota";

const repo = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(repo, "claude-accounts/mods/claude-accounts/bin/claude-accounts");
const USAGE_FIXTURE = join(repo, "test/fixtures/claude-usage.json");
const DETAILS_FIXTURE = join(repo, "test/fixtures/claude-accounts/details.json");
const USAGE = JSON.parse(readFileSync(USAGE_FIXTURE, "utf8"));

// The fixtures' "now": Nov 6 2026, 4:20 PM in Bogota.
const NOW = 1794000000000;
const MIN = 60_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-accounts-t10-")));
const pids = new Set();
after(() => {
  for (const pid of pids) kill(pid);
  rmSync(root, { recursive: true, force: true });
});

// Only a process this file started: a details runner of this checkout's
// CLI, or a fake claude-usage under the tmp root. A pid that died and came
// back as someone else's process (another test file's restart runner too)
// is never touched.
function ours(pid) {
  const r = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const command = r.stdout ?? "";
  return command.includes(root) || command.includes(`${BIN} details --range`);
}

// Kills a detached runner's whole group (it leads its own: detached), which
// holds the fake claude-usage too, then the pid itself.
function kill(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !ours(pid)) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// ── The sandbox ────────────────────────────────────────────────────────────

// How long the fake claude-usage waits at most for its gate. A CLI run that
// waited for it couldn't be back sooner, however loaded the machine is.
const GATE_MS = 10_000;

// A fake claude-usage. It appends its args to $FAKE_OUT/calls and its pid to
// $FAKE_OUT/pids, waits for $FAKE_GATE to exist (at most GATE_MS) when set,
// writes $FAKE_STDERR to stderr, prints $FAKE_STDOUT_FILE (default: the
// claude-usage fixture), and exits $FAKE_EXIT.
const FAKE_USAGE = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_OUT/calls"
echo $$ >> "$FAKE_OUT/pids"
if [ -n "\${FAKE_GATE:-}" ]; then
  i=0
  while [ ! -f "$FAKE_GATE" ] && [ $i -lt ${GATE_MS / 50} ]; do sleep 0.05; i=$((i + 1)); done
fi
[ -n "\${FAKE_STDERR:-}" ] && printf '%s\\n' "$FAKE_STDERR" >&2
cat "\${FAKE_STDOUT_FILE:-$FAKE_FIXTURE}"
exit "\${FAKE_EXIT:-0}"
`;

let n = 0;
function sandbox(extra = {}) {
  const box = join(root, String(++n));
  const home = join(box, "home");
  const state = join(box, "state");
  const out = join(box, "out");
  const shims = join(box, "bin");
  for (const dir of [home, state, out, shims]) mkdirSync(dir, { recursive: true });
  for (const [name, code] of [["security", 44], ["hc", 1], ["claude", 1], ["open", 1]]) {
    writeFileSync(join(shims, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(shims, name), 0o755);
  }
  const fake = join(shims, "claude-usage");
  writeFileSync(fake, FAKE_USAGE);
  chmodSync(fake, 0o755);
  const env = {
    HOME: home,
    USER: "tester",
    PATH: [shims, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    TMPDIR: box,
    CLAUDE_ACCOUNTS_HOME: state,
    CLAUDE_ACCOUNTS_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
    CLAUDE_ACCOUNTS_USAGE_BIN: fake,
    FAKE_OUT: out,
    FAKE_FIXTURE: USAGE_FIXTURE,
    ...extra,
  };
  for (const key of ["HOME", "TMPDIR", "CLAUDE_ACCOUNTS_HOME", "CLAUDE_ACCOUNTS_USAGE_BIN"]) {
    assert.ok(env[key].startsWith(`${root}/`), `a sandbox path, never the person's: ${key}=${env[key]}`);
  }
  const file = join(state, "details.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  // Runs the bin with stdout and stderr captured, as Herdr's exec does: a
  // detached runner that kept the pipes would hold this call until it ends.
  const cli = (args) => {
    const t0 = Date.now();
    const r = spawnSync(BIN, args, { env, encoding: "utf8", timeout: 30000 });
    if (r.error) throw r.error;
    // Every runner this call started is killed when the tests end.
    let doc = null;
    try {
      doc = read();
    } catch {
      // A broken file, on purpose: no runner.
    }
    for (const entry of Object.values(doc?.ranges ?? {})) if (Number.isInteger(entry?.pid) && entry.pid !== process.pid) pids.add(entry.pid);
    return { ...r, ms: Date.now() - t0 };
  };
  const lines = (name) => {
    const f = join(out, name);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  };
  const calls = () => lines("calls");
  const track = () => {
    for (const pid of lines("pids")) pids.add(Number(pid));
  };
  const open = () => writeFileSync(join(out, "gate"), "");
  const seed = (doc) => writeFileSync(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  return { env, state, out, file, read, cli, calls, track, open, seed, gate: join(out, "gate") };
}

// Polls until check() is truthy, at most 10 s.
async function until(check, what) {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const done = (s, range) => until(() => {
  const entry = s.read()?.ranges?.[range];
  return entry && entry.running === false ? entry : null;
}, `range ${range} to finish`);

// ── details --range: the detached run ─────────────────────────────────────

test("details --range 7 runs claude-usage --json --last 7 detached: it returns at once, then details.json holds the result", async () => {
  const s = sandbox();
  s.env.FAKE_GATE = s.gate;
  const r = s.cli(["details", "--range", "7", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < GATE_MS, `returned in ${r.ms} ms, while claude-usage still waits for its gate`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.range, "7");
  assert.equal(out.started, true);
  assert.equal(out.running, true);
  assert.equal(out.error, null);

  const running = s.read().ranges["7"];
  assert.equal(running.running, true);
  assert.equal(running.result, null);
  assert.ok(Number.isInteger(running.pid) && alive(running.pid), "a live runner owns the run");
  assert.ok(running.startedAt >= Date.now() - 10_000);
  await until(() => s.calls().length === 1, "claude-usage to start");
  s.track();
  assert.deepEqual(s.calls(), ["--json --last 7"]);
  assert.equal(s.read().ranges["7"].running, true, "still running while claude-usage runs");

  s.open();
  const entry = await done(s, "7");
  assert.deepEqual(Object.keys(entry), ["result", "running", "startedAt", "finishedAt", "error"], "D2's pinned shape once it ends");
  assert.deepEqual(entry.result, USAGE);
  assert.equal(entry.error, null);
  assert.equal(entry.startedAt, running.startedAt);
  assert.ok(entry.finishedAt >= entry.startedAt);
  await until(() => !alive(running.pid), "the runner to exit");
});

test("each range asks claude-usage for its own days: 30 → --last 30, 90 → --last 90, all → --all", async () => {
  const s = sandbox();
  for (const range of ["30", "90", "all"]) assert.equal(s.cli(["details", "--range", range]).status, 0);
  for (const range of ["30", "90", "all"]) assert.deepEqual((await done(s, range)).result, USAGE);
  s.track();
  assert.deepEqual(s.calls().sort(), ["--json --all", "--json --last 30", "--json --last 90"]);
  assert.equal(s.read().ranges["7"], undefined, "a range nobody asked for stays unrun");
});

test("a run already going isn't started twice: the second call returns it", async () => {
  const s = sandbox();
  s.env.FAKE_GATE = s.gate;
  const first = JSON.parse(s.cli(["details", "--range", "7", "--json"]).stdout);
  const pid = s.read().ranges["7"].pid;
  const again = s.cli(["details", "--range", "7", "--json"]);
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.running, true);
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(s.read().ranges["7"].pid, pid);
  await until(() => s.calls().length === 1, "claude-usage to start");
  s.track();
  s.open();
  await done(s, "7");
  assert.equal(s.calls().length, 1, "claude-usage ran once");
});

// ── details.json, the cache ───────────────────────────────────────────────

test("the cache: a new run keeps the range's last result while it goes, and every other range as it was", async () => {
  const s = sandbox();
  const seeded = JSON.parse(readFileSync(DETAILS_FIXTURE, "utf8"));
  s.seed(seeded);
  const fresh = { ...USAGE, generatedAt: NOW + 5 * MIN, totals: { ...USAGE.totals, tokens: 19000000 } };
  const freshFile = join(s.out, "fresh.json");
  writeFileSync(freshFile, JSON.stringify(fresh));
  Object.assign(s.env, { FAKE_GATE: s.gate, FAKE_STDOUT_FILE: freshFile });

  assert.equal(s.cli(["details", "--range", "7"]).status, 0);
  const going = s.read();
  assert.equal(going.ranges["7"].running, true);
  assert.deepEqual(going.ranges["7"].result, seeded.ranges["7"].result, "the last result stays while the run goes");
  assert.equal(going.ranges["7"].finishedAt, seeded.ranges["7"].finishedAt);
  assert.deepEqual(going.ranges["30"], seeded.ranges["30"]);
  assert.deepEqual(going.ranges["90"], seeded.ranges["90"]);

  await until(() => s.calls().length === 1, "claude-usage to start");
  s.track();
  s.open();
  const entry = await done(s, "7");
  assert.deepEqual(entry.result, fresh);
  assert.deepEqual(s.read().ranges["90"], seeded.ranges["90"], "other ranges untouched by the runner too");
});

test("a failed run keeps the last result and records claude-usage's error", async () => {
  const s = sandbox({ FAKE_EXIT: "1", FAKE_STDERR: "claude-usage: no pude leer la caché /x/usage-cache.jsonl" });
  const seeded = JSON.parse(readFileSync(DETAILS_FIXTURE, "utf8"));
  s.seed(seeded);
  assert.equal(s.cli(["details", "--range", "7"]).status, 0);
  const entry = await done(s, "7");
  s.track();
  assert.deepEqual(entry.result, seeded.ranges["7"].result);
  assert.equal(entry.error, "claude-usage exited 1: claude-usage: no pude leer la caché /x/usage-cache.jsonl");
  assert.ok(entry.startedAt >= Date.now() - 10_000, "this run's start");
  assert.ok(entry.finishedAt >= entry.startedAt, "and its end");

  // The next good run clears the error.
  s.env.FAKE_EXIT = "0";
  delete s.env.FAKE_STDERR;
  assert.equal(s.cli(["details", "--range", "7"]).status, 0);
  await until(() => s.read().ranges["7"].running === false && s.read().ranges["7"].error === null, "the good run");
  s.track();
});

test("each other failure is recorded: no claude-usage, output that isn't JSON, another JSON version", async () => {
  const missing = sandbox();
  missing.env.CLAUDE_ACCOUNTS_USAGE_BIN = join(missing.out, "no-claude-usage");
  assert.equal(missing.cli(["details", "--range", "30"]).status, 0);
  const gone = await done(missing, "30");
  assert.equal(gone.result, null);
  assert.equal(gone.error, `claude-usage not found: ${join(missing.out, "no-claude-usage")}`);

  const garbage = sandbox();
  const text = join(garbage.out, "text.txt");
  writeFileSync(text, "Por cuenta, uso\n| a | b |\n");
  garbage.env.FAKE_STDOUT_FILE = text;
  assert.equal(garbage.cli(["details", "--range", "30"]).status, 0);
  assert.equal((await done(garbage, "30")).error, "claude-usage printed no JSON");
  garbage.track();

  const later = sandbox();
  const v2 = join(later.out, "v2.json");
  writeFileSync(v2, JSON.stringify({ ...USAGE, version: 2 }));
  later.env.FAKE_STDOUT_FILE = v2;
  assert.equal(later.cli(["details", "--range", "30"]).status, 0);
  assert.equal((await done(later, "30")).error, "claude-usage --json printed version 2; this window reads version 1");
  later.track();
});

test("a run whose runner is gone is started again: no pid, a dead pid, or older than the run's time limit", async () => {
  const s = sandbox();
  const seeded = JSON.parse(readFileSync(DETAILS_FIXTURE, "utf8"));
  // A pid that existed and is gone.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  const now = Date.now();
  seeded.ranges["90"] = { result: null, running: true, startedAt: now - 1000, finishedAt: null, error: null, pid: deadPid };
  // A live pid (this test's) whose run started longer ago than a run may take.
  seeded.ranges.all = { result: null, running: true, startedAt: now - 10 * MIN, finishedAt: null, error: null, pid: process.pid };
  s.seed(seeded);

  // The fixture's 30 is running with no pid: nobody owns it.
  for (const range of ["30", "90", "all"]) {
    const r = JSON.parse(s.cli(["details", "--range", range, "--json"]).stdout);
    assert.equal(r.started, true, `range ${range} starts again`);
  }
  for (const range of ["30", "90", "all"]) assert.deepEqual((await done(s, range)).result, USAGE);
  s.track();

  // A live runner within its time limit owns its run.
  const owned = sandbox();
  owned.seed({ ranges: { 7: { result: null, running: true, startedAt: Date.now() - 1000, finishedAt: null, error: null, pid: process.pid } } });
  const r = JSON.parse(owned.cli(["details", "--range", "7", "--json"]).stdout);
  assert.equal(r.started, false);
  await sleep(200);
  assert.deepEqual(owned.calls(), [], "no second claude-usage");
});

test("bad usage exits 64: no --range, an unknown range, a stray argument", () => {
  const s = sandbox();
  for (const args of [["details"], ["details", "--range", "14"], ["details", "--range", "7", "extra"], ["details", "--range"]]) {
    const r = s.cli(args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.equal(s.read(), null, "nothing written");
});

test("a details.json that isn't JSON stops the command with exit 1 and is never overwritten", async () => {
  const s = sandbox();
  s.seed("{ broken");
  const r = s.cli(["details", "--range", "7"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /details\.json is not valid JSON/);
  await sleep(200);
  assert.equal(readFileSync(s.file, "utf8"), "{ broken");
  assert.deepEqual(s.calls(), [], "no run started");
});

// ── details-model.js: what the window draws ───────────────────────────────

// details.json with one range's entry; the fixture's result by default.
const withRange = (range, entry) => readDetails(JSON.stringify({ ranges: { [range]: entry } }));
const ranOnce = (result = USAGE, more = {}) =>
  withRange("7", { result, running: false, startedAt: NOW - 20_000, finishedAt: NOW - 8_000, error: null, ...more });
const model = (details, extra = {}) => detailsModel({ details, range: "7", now: NOW, ...extra });

test("the range picker: Orca's four ranges and labels; an unknown or missing range is the last 7 days", () => {
  assert.deepEqual(RANGES, ["7", "30", "90", "all"]);
  const m = detailsModel({ details: readDetails(null), range: "30", now: NOW });
  assert.deepEqual(m.ranges, [
    { key: "7", label: "Last 7 days", selected: false },
    { key: "30", label: "Last 30 days", selected: true },
    { key: "90", label: "Last 90 days", selected: false },
    { key: "all", label: "All time", selected: false },
  ]);
  for (const v of ["14", null, undefined, 7, ""]) assert.equal(pickRange(v), "7", String(v));
  assert.equal(pickRange("all"), "all");
  assert.equal(detailsModel({ details: readDetails(null), range: "nope", now: NOW }).range, "7");
});

test("numbers: Orca's token format, counts with separators, active time in hours", () => {
  assert.equal(formatTokens(18450000), "18.5M");
  assert.equal(formatTokens(1450000), "1.5M");
  assert.equal(formatTokens(999950), "1.0M");
  assert.equal(formatTokens(4808500000), "4.8B");
  assert.equal(formatTokens(999950000), "1.0B");
  assert.equal(formatTokens(999949999), "999.9M");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(null), "n/a");
  assert.equal(formatCount(2310), "2,310");
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatCount(7), "7");
  assert.equal(formatActiveTime(151200), "42h");
  assert.equal(formatActiveTime(2700), "45m");
  assert.equal(formatActiveTime(11100), "3h 5m");
  assert.equal(formatActiveTime(7200), "2h");
  assert.equal(formatActiveTime(undefined), "n/a");
});

// Orca's eight cards, in Orca's order (ClaudeUsagePane.tsx:168-237).
const ORCA_CARDS = ["input", "output", "cacheRead", "cacheWrite", "reuse", "zeroCacheRead", "sessions", "cost"];
// Orca's recent sessions headings (ClaudeUsageDetails.tsx:65-73).
const ORCA_HEADINGS = ["Last active", "Project", "Model", "Turns", "Input", "Output", "Cache"];
const card = (m, key) => m.report.cards.find((c) => c.key === key);

// The fixture as an older claude-usage prints it: none of D24's keys.
function olderResult() {
  const old = structuredClone(USAGE);
  delete old.turnFiguresSince;
  for (const key of ["output", "sessions", "zeroCacheReadResponses", "turnResponses", "estimatedCostUsd", "unpricedModels", "turnFiguresCoverage"]) delete old.totals[key];
  for (const row of old.byModel) delete row.sessions;
  for (const row of old.byProject) delete row.responses;
  for (const row of old.recentSessions) for (const key of ["responses", "input", "output", "cacheRead", "cacheWrite"]) delete row[key];
  return old;
}

test("the fixture's 7 days: Updated, Orca's eight cards in Orca's order, then Herdr's tokens and active time", () => {
  const m = model(ranOnce());
  assert.equal(m.status, "Updated just now");
  assert.equal(m.running, false);
  assert.equal(m.error, null);
  assert.equal(m.notice, null);
  assert.deepEqual(m.report.cards.map((c) => c.key), ORCA_CARDS);
  assert.deepEqual(m.report.cards.map((c) => [c.label, c.value]), [
    ["Input tokens", "1.5M"],
    ["Output tokens", "9.9M"],
    ["Cache read", "15.2M"],
    ["Cache write", "1.9M"],
    ["Cache reuse rate", "91%"],
    ["Zero-cache-read turns", "4%"],
    ["Sessions / Turns", "26 / 2,310"],
    ["Est. API-equivalent cost", "$412.37"],
  ]);
  assert.equal(card(m, "input").hint, "Input tokens not read from the cache.");
  assert.equal(card(m, "zeroCacheRead").hint, "61 of 1,480 turns read nothing from the cache.");
  assert.equal(card(m, "cost").hint, null, "every model in range is priced");
  // Herdr's own figures after Orca's: how its tokens are counted, and active time.
  assert.deepEqual(m.report.extras.map((c) => [c.key, c.label, c.value]), [
    ["tokens", "Tokens", "18.5M"],
    ["active", "Active time", "42h"],
  ]);
  assert.equal(m.report.extras[0].hint, "Input, output and cache write tokens. Cache reads aren't counted.");
  assert.equal(m.report.explanation, "Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens).");
  // No reuse rate (neither input nor cache read): Orca's n/a.
  const none = model(ranOnce({ ...USAGE, totals: { ...USAGE.totals, reuseRate: null } }));
  assert.equal(card(none, "reuse").value, "n/a");
});

test("zero-cache-read turns: v5 zero-cache turns over v5 turns, Orca's rounded percent; n/a without v5 turns", () => {
  const zero = (totals) => card(model(ranOnce({ ...USAGE, totals: { ...USAGE.totals, ...totals } })), "zeroCacheRead");
  assert.equal(zero({ zeroCacheReadResponses: 37, turnResponses: 1480 }).value, "3%", "2.5% rounds up, as Math.round does");
  assert.equal(zero({ zeroCacheReadResponses: 0, turnResponses: 1480 }).value, "0%");
  const empty = zero({ zeroCacheReadResponses: 0, turnResponses: 0 });
  assert.equal(empty.value, "n/a", "no v5 turns in range");
  assert.equal(empty.hint, null);
  assert.equal(zero({ zeroCacheReadResponses: 1, turnResponses: 1 }).hint, "1 of 1 turn read nothing from the cache.");
});

test("est. API-equivalent cost: Orca's formatCost, and '• excludes unpriced models' only on a total that exists", () => {
  assert.equal(formatCost(null), "n/a");
  assert.equal(formatCost(undefined), "n/a");
  assert.equal(formatCost(0.0042), "$0.0042");
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.01), "$0.01");
  assert.equal(formatCost(12.344), "$12.34");
  assert.equal(formatCost(412.37), "$412.37");

  const cost = (totals) => card(model(ranOnce({ ...USAGE, totals: { ...USAGE.totals, ...totals } })), "cost");
  const unpriced = cost({ unpricedModels: ["opus-4-x", "mystery"] });
  assert.equal(unpriced.label, "Est. API-equivalent cost • excludes unpriced models");
  assert.equal(unpriced.value, "$412.37");
  assert.equal(unpriced.hint, "Not priced: opus-4-x, mystery.");

  // Nothing priced: no total, so nothing to exclude from (unpriced-cost-label.ts).
  const nothing = cost({ estimatedCostUsd: null, unpricedModels: ["mystery"] });
  assert.equal(nothing.label, "Est. API-equivalent cost");
  assert.equal(nothing.value, "n/a");
  assert.equal(nothing.hint, "Not priced: mystery.");
  assert.equal(cost({ estimatedCostUsd: 0.0042 }).value, "$0.0042");
});

test("since <date>: each group of figures says when its data starts, with the share of tokens it covers", () => {
  const m = model(ranOnce());
  assert.deepEqual(m.report.cards.map((c) => [c.key, c.since]), [
    ["input", "since Nov 3"],
    ["output", "since Nov 3"],
    ["cacheRead", "since Nov 3"],
    ["cacheWrite", "since Nov 3"],
    ["reuse", "since Nov 3"],
    ["zeroCacheRead", "since Nov 4"],
    ["sessions", null],
    ["cost", "since Nov 4"],
  ]);
  assert.deepEqual(m.report.coverage, [
    "Input, output and cache figures cover only sessions still on disk: 72% of this range's tokens.",
    "Zero-cache-read turns and cost cover only sessions still on disk: 65% of this range's tokens.",
  ]);
  assert.equal(m.report.recent.description, "Cache reuse rate: 91% (since Nov 3)");

  const whole = model(ranOnce({
    ...USAGE,
    cacheSince: "2026-10-01",
    turnFiguresSince: "2026-10-31",
    totals: { ...USAGE.totals, cacheCoverage: 1, turnFiguresCoverage: 1 },
  }));
  assert.ok(whole.report.cards.every((c) => c.since === null), "both groups start on or before the range's first day");
  assert.deepEqual(whole.report.coverage, []);
  assert.equal(whole.report.recent.description, "Cache reuse rate: 91%");

  const tiny = model(ranOnce({ ...USAGE, totals: { ...USAGE.totals, cacheCoverage: 0.9996, turnFiguresCoverage: 0.004 } }));
  assert.deepEqual(tiny.report.coverage, [
    "Input, output and cache figures cover only sessions still on disk: 99% of this range's tokens.",
    "Zero-cache-read turns and cost cover only sessions still on disk: <1% of this range's tokens.",
  ]);
  const noDays = model(ranOnce({ ...USAGE, cacheSince: null, turnFiguresSince: null }));
  assert.ok(noDays.report.cards.every((c) => c.since === null));
});

test("an older claude-usage without D24's keys: each figure it doesn't print reads n/a", () => {
  const m = model(ranOnce(olderResult()));
  assert.deepEqual(m.report.cards.map((c) => c.key), ORCA_CARDS);
  assert.deepEqual(m.report.cards.map((c) => [c.label, c.value]), [
    ["Input tokens", "1.5M"],
    ["Output tokens", "n/a"],
    ["Cache read", "15.2M"],
    ["Cache write", "1.9M"],
    ["Cache reuse rate", "91%"],
    ["Zero-cache-read turns", "n/a"],
    ["Sessions / Turns", "n/a / 2,310"],
    ["Est. API-equivalent cost", "n/a"],
  ]);
  assert.equal(card(m, "zeroCacheRead").since, null);
  assert.deepEqual(m.report.coverage, ["Input, output and cache figures cover only sessions still on disk: 72% of this range's tokens."]);
  assert.deepEqual(m.report.byModel.rows.map((r) => r.sub), ["n/a sessions • 1,620 turns", "n/a sessions • 690 turns"]);
  assert.deepEqual(m.report.byProject.rows.map((r) => r.sub), ["14 sessions • n/a turns", "9 sessions • n/a turns", "3 sessions • n/a turns • no longer on disk"]);
  assert.deepEqual(m.report.recent.headings, ORCA_HEADINGS);
  assert.deepEqual(m.report.recent.rows[0].cells, ["Nov 6, 4:17 PM", "herdr-plugins", "opus", "n/a", "n/a", "n/a", "n/a"]);
});

test("a path:null project: named by its slug, marked as no longer on disk, still counted", () => {
  const m = model(ranOnce());
  const rows = m.report.byProject.rows;
  assert.deepEqual(rows.map((r) => [r.label, r.value, r.sub, r.gone]), [
    ["herdr-plugins", "9.8M", "14 sessions • 1,240 turns", false],
    ["orca", "6.6M", "9 sessions • 830 turns", false],
    ["-Users-ana-src-old-app", "2.1M", "3 sessions • 240 turns • no longer on disk", true],
  ]);
  assert.equal(rows[0].hint, "/Users/ana/src/herdr-plugins");
  assert.equal(rows[2].hint, "Its transcripts are gone from disk; Claude's folder name stands in for the project.");
  assert.ok(Math.abs(rows[2].share - 2100000 / 18450000) < 1e-9);
  assert.equal(m.report.byProject.top, "Top project: herdr-plugins");
  assert.equal(m.report.recent.rows[2].cells[1], "-Users-ana-src-old-app");
  assert.equal(model(ranOnce({ ...USAGE, byProject: [{ project: "x", path: null, tokens: 1, sessions: 1, responses: 1 }] })).report.byProject.rows[0].sub, "1 session • 1 turn • no longer on disk");
});

test("the stale label: while a run goes, or after one fails, the last result shows with its own age", () => {
  const old = { ...USAGE, generatedAt: NOW - 12 * MIN };
  const going = model(withRange("7", { result: old, running: true, startedAt: NOW - 5000, finishedAt: NOW - 12 * MIN, error: null }));
  assert.equal(going.running, true);
  assert.equal(going.status, "Updated 12m ago");
  assert.equal(going.notice, null);
  assert.ok(going.report, "the last result is drawn");

  const failed = model(withRange("7", { result: old, running: false, startedAt: NOW - 9000, finishedAt: NOW - 8000, error: "claude-usage exited 1: boom" }));
  assert.equal(failed.status, "Updated 12m ago");
  assert.equal(failed.error, "Last scan error: claude-usage exited 1: boom");
  assert.ok(failed.report);

  // A run older than its time limit has lost its runner: not drawn as running.
  const lost = model(withRange("7", { result: old, running: true, startedAt: NOW - 10 * MIN, finishedAt: null, error: null }));
  assert.equal(lost.running, false);

  const first = model(withRange("7", { result: null, running: true, startedAt: NOW - 1000, finishedAt: null, error: null }));
  assert.equal(first.status, "Not yet updated");
  assert.equal(first.notice, "Loading usage…");
  assert.equal(first.report, null);

  const never = model(readDetails(null));
  assert.equal(never.status, "Not yet updated");
  assert.equal(never.notice, "No usage read for this range yet.");
  assert.equal(never.running, false);

  // The CLI itself failed to start a run.
  const refused = model(ranOnce(), { execError: "claude-accounts details: details.json is not valid JSON" });
  assert.equal(refused.error, "Last scan error: claude-accounts details: details.json is not valid JSON");
});

test("an empty range says Orca's empty message; a partial result still draws", () => {
  const empty = model(ranOnce({ ...USAGE, totals: { ...USAGE.totals, tokens: 0 }, daily: [], byModel: [], byProject: [], byAccount: [] }));
  assert.equal(empty.notice, "No local Claude usage found yet for this range.");
  assert.equal(empty.report, null);

  const partial = model(ranOnce({ version: 1, totals: { tokens: 5 } }));
  assert.equal(partial.notice, null);
  assert.deepEqual(partial.report.cards.map((c) => c.value), ["n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a / n/a", "n/a"]);
  assert.deepEqual(partial.report.extras.map((c) => c.value), ["5", "n/a"]);
  assert.deepEqual(partial.report.coverage, []);
  assert.equal(partial.report.byModel.top, "Top model: n/a");
  assert.deepEqual(partial.report.daily.bars, []);
  assert.equal(partial.report.limits.empty, "No limits recorded in this range.");
  assert.equal(partial.report.recent.empty, "No sessions in this range.");
});

test("the daily chart: one bar per day up to a month, Orca's MM-DD labels and token tooltips", () => {
  const { title, description, bars, showValues } = model(ranOnce()).report.daily;
  assert.equal(title, "Daily usage");
  assert.equal(description, "Input, output and cache write tokens by day.");
  assert.equal(showValues, true);
  assert.deepEqual(bars.map((b) => b.label), ["10-31", "11-01", "11-02", "11-03", "11-04", "11-05", "11-06"]);
  assert.deepEqual(bars.map((b) => b.value), ["1.2M", "2.5M", "900.0k", "3.8M", "4.1M", "3.3M", "2.7M"]);
  assert.equal(bars[4].share, 1, "the top day fills the chart");
  assert.ok(Math.abs(bars[0].share - 1200000 / 4100000) < 1e-9);
  assert.equal(bars[3].tooltip, "2026-11-03: 3,800,000 tokens");
});

test("the daily chart over 90 days: weekly bars ending today, at most 8 labels", () => {
  const start = Date.UTC(2026, 7, 9);
  const daily = Array.from({ length: 90 }, (_, i) => ({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), tokens: 1000 * (i + 1) }));
  const chart = chartBars(daily);
  assert.equal(chart.title, "Weekly usage");
  assert.equal(chart.description, "Input, output and cache write tokens by week.");
  assert.equal(chart.bars.length, 13);
  const last = chart.bars.at(-1);
  assert.equal(last.to, daily[89].date);
  assert.equal(last.from, daily[83].date);
  assert.equal(last.tokens, daily.slice(83).reduce((sum, d) => sum + d.tokens, 0));
  assert.equal(last.tooltip, `${daily[83].date} – ${daily[89].date}: ${formatCount(last.tokens)} tokens`);
  assert.equal(chart.bars[0].from, daily[0].date, "the oldest bucket is the partial one");
  assert.equal(chart.bars[0].to, daily[5].date);
  assert.ok(chart.bars.filter((b) => b.label).length <= 8);
  assert.ok(last.label, "the last bar is labeled");
  assert.equal(chart.showValues, true);
  assert.equal(chartBars(daily.slice(0, 31)).bars.length, 31, "a month is daily");
});

test("by model: Orca's sessions • turns under each row; by account keeps its turns; top row and share of the range", () => {
  const { byModel, byAccount } = model(ranOnce()).report;
  assert.equal(byModel.title, "By model");
  assert.equal(byModel.top, "Top model: opus");
  assert.deepEqual(byModel.rows.map((r) => [r.label, r.value, r.sub]), [["opus", "14.1M", "19 sessions • 1,620 turns"], ["sonnet", "4.4M", "7 sessions • 690 turns"]]);
  assert.ok(Math.abs(byModel.rows[0].share - 14100000 / 18450000) < 1e-9);
  assert.equal(byAccount.title, "By account");
  assert.equal(byAccount.top, "Top account: ana@example.com");
  assert.deepEqual(byAccount.rows.map((r) => [r.label, r.value, r.sub]), [["ana@example.com", "12.3M", "1,540 turns"], ["ben@example.org", "6.2M", "770 turns"]]);
  const odd = model(ranOnce({ ...USAGE, byModel: [{ model: null, tokens: 10, responses: 1, sessions: 1 }] })).report.byModel.rows[0];
  assert.deepEqual([odd.label, odd.sub], ["Unknown", "1 session • 1 turn"]);
});

test("the time to each limit: per account, 5-hour and weekly, hits and the average time to reach it", () => {
  const { limits } = model(ranOnce()).report;
  assert.equal(limits.title, "Time to limit");
  assert.equal(limits.empty, null);
  assert.deepEqual(limits.rows.map((r) => [r.account, ...r.cells.map((c) => `${c.label}: ${c.text}`)]), [
    ["ana@example.com", "5-hour limit: 5 hits · avg 3h 18m", "Weekly limit: Not hit"],
    ["ben@example.org", "5-hour limit: Not hit", "Weekly limit: 2 hits · avg 3d 12h"],
  ]);
  const one = model(ranOnce({ ...USAGE, limits: [{ account: "c@x.io", window: "weekly", hits: 1, avgSecondsToLimit: null }] })).report.limits.rows;
  assert.deepEqual(one[0].cells.map((c) => c.text), ["Not hit", "1 hit"]);
});

test("recent sessions: Orca's seven columns; a session without cache figures reads n/a; its account and length on hover", () => {
  const { recent } = model(ranOnce()).report;
  assert.equal(recent.title, "Recent sessions");
  assert.deepEqual(recent.headings, ORCA_HEADINGS);
  assert.deepEqual(recent.rows.map((r) => r.cells), [
    ["Nov 6, 4:17 PM", "herdr-plugins", "opus", "212", "64.0k", "1.2M", "6.6M"],
    ["Nov 6, 9:40 AM", "orca", "sonnet", "58", "21.0k", "312.0k", "2.2M"],
    // A frozen pre-v4 line: its turns, and no cache figures.
    ["Nov 2, 12:00 PM", "-Users-ana-src-old-app", "opus", "31", "n/a", "n/a", "n/a"],
  ]);
  assert.equal(recent.rows[0].key, "3f1c2b7e-8a4d-4e55-9a51-0c2d6f1b7a10");
  assert.equal(recent.rows[0].hint, "ana@example.com · 3h 17m");
  assert.equal(recent.rows[1].hint, "ben@example.org · 1h 40m");
  const short = model(ranOnce({ ...USAGE, recentSessions: [{ id: "s", project: null, account: null, model: null, startedAt: NOW - 30_000, endedAt: NOW, tokens: 12, responses: 1, input: 3, output: 9, cacheRead: 0, cacheWrite: 0 }] }));
  assert.deepEqual(short.report.recent.rows[0].cells, ["Nov 6, 4:20 PM", "Unknown", "Unknown", "1", "3", "9", "0"]);
  assert.equal(short.report.recent.rows[0].hint, "Unknown · <1m");
  // Cache is read + write: one of them missing is n/a, never half a sum.
  const half = model(ranOnce({ ...USAGE, recentSessions: [{ ...USAGE.recentSessions[0], cacheWrite: null }] }));
  assert.equal(half.report.recent.rows[0].cells[6], "n/a");
  assert.equal(recent.empty, null);
});

// ── Last: nothing outlives the tests ─────────────────────────────────────────

test("no details runner or fake claude-usage outlives the tests", async () => {
  const left = () => {
    const r = spawnSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
    return r.stdout.split("\n").filter((line) => line.includes(`${BIN} details --range`) || line.includes(`${root}/`));
  };
  await until(() => left().length === 0, "every runner and fake claude-usage to exit");
});
