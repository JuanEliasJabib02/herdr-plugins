// Usage details & history (D11, S7). Owner: T10.
//
//   details --range <7|30|90|all> [--json]
//     Refreshes one range of the details window: starts claude-usage --json
//     (paths.usageBin: --last 7, 30 or 90, or --all) in a detached runner and
//     returns at once, because a cold claude-usage run (a one-time rebuild
//     of its cache) takes 12–20 s against exec's 30 s. Exit 0, and with
//     --json { range, started, running, startedAt, finishedAt, error }:
//     started is false when a run of that range is already going, which is
//     returned instead of a second one. Exit 64 for a missing or unknown
//     range; exit 1 for a details.json that isn't JSON (never overwritten).
//   details --range <r> --detach
//     The runner itself, spawned by the command above (never typed). It runs
//     claude-usage, then writes the range's outcome into details.json under
//     the lock, if the range is still its own.
//
// details.json (D2): { ranges: { "7"|"30"|"90"|"all": { result, running,
// startedAt, finishedAt, error } } }, one entry per range ever asked for:
//   - result     claude-usage --json's object as it printed it, or null. A
//                run keeps the range's last result while it goes and after
//                it fails, so the window always has something to draw (with
//                its own generatedAt: "Updated Xm ago").
//   - running    true while a runner owns the range; that entry also has
//                pid, the runner's, which the finished entry drops.
//   - startedAt, finishedAt  epoch ms of the last run's start and end.
//   - error      why the last run failed, one line, or null.
// A running entry is void, and the next call starts the range again, when
// its pid is missing or dead, or it started longer ago than a run may take
// (RUN_TIMEOUT_MS plus a margin): D2's stale rule for claims. A runner whose
// range was taken over that way writes nothing. Other ranges, and any other
// field of the file, are kept as they are.

import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FILES, cliPath, stateHome, usageBin } from "./paths.mjs";
import { failure, isAlive, readJson, render, withLock, writeAtomic } from "./files.mjs";

// The ranges of the window (Orca's 7d, 30d, 90d and all), as claude-usage's flags.
const RANGES = Object.freeze({
  7: ["--last", "7"],
  30: ["--last", "30"],
  90: ["--last", "90"],
  all: ["--all"],
});
const RANGE_NAMES = Object.freeze({ 7: "the last 7 days", 30: "the last 30 days", 90: "the last 90 days", all: "all time" });

// A claude-usage run is stopped after this long (a cold run takes 12–20 s,
// a warm one under 1 s), and a running entry older than this plus a margin
// has lost its runner, whatever its pid says.
const RUN_TIMEOUT_MS = 120_000;
const RUN_STALE_MS = RUN_TIMEOUT_MS + 30_000;
// claude-usage prints one JSON line; an all-time range is tens of KB.
const MAX_OUTPUT = 32 * 1024 * 1024;
// The most of a failure's text an entry keeps.
const MAX_ERROR = 300;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function details(args) {
  const { values } = parseArgs({
    args,
    options: { range: { type: "string" }, json: { type: "boolean" }, detach: { type: "boolean" } },
    strict: true,
  });
  const range = values.range;
  if (range === undefined) throw failure("--range is required: 7, 30, 90 or all", 64);
  if (!Object.hasOwn(RANGES, range)) throw failure(`unknown range "${range}": 7, 30, 90 or all`, 64);
  if (values.detach) return runRange(range);

  const { started, entry } = await startRange(range);
  const out = {
    range,
    started,
    running: entry.running === true,
    startedAt: num(entry.startedAt),
    finishedAt: num(entry.finishedAt),
    error: entry.error ?? null,
  };
  const human = started ? `Refreshing ${RANGE_NAMES[range]} in the background.` : `Already refreshing ${RANGE_NAMES[range]}.`;
  process.stdout.write(values.json ? render(out) : `${human}\n`);
  return 0;
}

// ── details.json ────────────────────────────────────────────────────────────

const detailsPath = (home) => join(home, FILES.details);

// The file as an object with a ranges object. A file that isn't JSON throws
// (readJson: exit 1, never overwritten); one of another shape is ours to
// rebuild, keeping what it can.
async function readDoc(path) {
  const raw = await readJson(path);
  const doc = isObject(raw) ? raw : {};
  return { ...doc, ranges: isObject(doc.ranges) ? { ...doc.ranges } : {} };
}

// The range's entry, or an empty one.
function entryOf(doc, range) {
  return isObject(doc.ranges[range]) ? doc.ranges[range] : {};
}

// A runner owns the range: its pid lives and its run is within the time a
// run may take.
function isRunning(entry, now) {
  return (
    entry.running === true &&
    Number.isInteger(entry.pid) &&
    entry.pid > 0 &&
    isAlive(entry.pid) &&
    num(entry.startedAt) !== null &&
    now - entry.startedAt < RUN_STALE_MS
  );
}

// ── The command: start a run ─────────────────────────────────────────────────

// Under the lock: returns the range's live run, or spawns a runner and
// marks the range running with its pid (keeping the last result). The
// runner waits on the same lock to write, so it never finishes before its
// start is written.
async function startRange(range) {
  const home = stateHome();
  const path = detailsPath(home);
  return withLock(home, async () => {
    const doc = await readDoc(path);
    const last = entryOf(doc, range);
    const now = Date.now();
    if (isRunning(last, now)) return { started: false, entry: last };
    const result = isObject(last.result) ? last.result : null;
    const pid = spawnRunner(range);
    if (!pid) {
      doc.ranges[range] = { result, running: false, startedAt: now, finishedAt: now, error: "the details runner couldn't start" };
      await writeAtomic(path, render(doc));
      throw failure("the details runner couldn't start");
    }
    const entry = { result, running: true, startedAt: now, finishedAt: num(last.finishedAt), error: null, pid };
    doc.ranges[range] = entry;
    await writeAtomic(path, render(doc));
    return { started: true, entry };
  });
}

// D8's detached runner: it outlives exec, and stdio "ignore" keeps it off
// the caller's pipes, so exec returns at once.
function spawnRunner(range) {
  const child = spawn(process.execPath, [cliPath(), "details", "--range", range, "--detach"], {
    detached: true,
    stdio: "ignore",
    cwd: "/",
  });
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

// ── The runner ───────────────────────────────────────────────────────────────

async function runRange(range) {
  const home = stateHome();
  const path = detailsPath(home);
  const outcome = await usageJson(range);
  await withLock(home, async () => {
    const doc = await readDoc(path);
    const current = entryOf(doc, range);
    // Taken over (this run was judged gone): the newer run owns the range.
    if (current.pid !== process.pid) return;
    doc.ranges[range] = {
      result: outcome.result ?? (isObject(current.result) ? current.result : null),
      running: false,
      startedAt: num(current.startedAt),
      finishedAt: Date.now(),
      error: outcome.error ?? null,
    };
    await writeAtomic(path, render(doc));
  });
  return 0;
}

// claude-usage --json for the range: { result } or { error }.
function usageJson(range) {
  const bin = usageBin();
  return new Promise((resolve) => {
    execFile(bin, ["--json", ...RANGES[range]], { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      resolve(err ? { error: describe(err, stderr, bin) } : parseResult(stdout));
    });
  });
}

function parseResult(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout).trim());
  } catch {
    return { error: "claude-usage printed no JSON" };
  }
  if (!isObject(value)) return { error: "claude-usage printed no JSON object" };
  if (value.version !== 1) return { error: `claude-usage --json printed version ${JSON.stringify(value.version ?? null)}; this window reads version 1` };
  return { result: value };
}

// One line for a failed run.
function describe(err, stderr, bin) {
  if (err.code === "ENOENT") return `claude-usage not found: ${bin}`;
  if (err.code === "EACCES") return `claude-usage can't run: ${bin}`;
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `claude-usage printed more than ${MAX_OUTPUT / 1024 / 1024} MiB`;
  if (err.killed) return `claude-usage took over ${RUN_TIMEOUT_MS / 1000} s and was stopped`;
  const last = lastLine(stderr);
  if (Number.isInteger(err.code)) return clip(`claude-usage exited ${err.code}${last ? `: ${last}` : ""}`);
  if (err.signal) return clip(`claude-usage was stopped by ${err.signal}${last ? `: ${last}` : ""}`);
  return clip(`claude-usage failed: ${err.message}`);
}

const lastLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
const clip = (text) => (text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text);
