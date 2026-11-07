// T11: Continuar and auto-resume (S10, S13; D13, D15). The pure rules of
// M/resume.js (the account pick, "Vuelve a las", the job's states, the
// board's Continuar slot), then the CLI's `continue`, `classify` and the
// reap's settling of the claude-accounts plugin's jobs, run as subprocesses
// in a temp world:
//   HOME, HERDR_APP_HOME  temp
//   PATH                  a temp bin (a fake `hc`), node's folder, /usr/bin, /bin:
//                         never the user's tools
//   claude-accounts       a fake at <app>/mods/claude-accounts/bin, answering
//                         the plugin's contract (CONTRACT.md) from a JSON file
// The queue is written straight into state.json (slot-only requests, so
// nothing lights). Modeled on Orca's markResuming / resumeSettled cases
// (O/src/main/spotlight/spotlight-agent-turns.test.ts "resuming"),
// spotlight-resume-account.test.ts and test-queue-continue.test.ts.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTINUE_MESSAGE, MAX_AUTO_RESUMES, RESUME_WINDOW_MS, RETRY_AFTER_RESET_MS, parseAccounts, pickAccount, pickFromText,
  returnsAtOf, formatReturn, refusalText, jobAnswer, settleFinal, continuePlan, autoResumeDue, autoRetryAt, continueView,
} from "../mods/spotlight/resume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "mods", "spotlight", "cli.mjs");
const NODE = process.execPath;
const MINUTE = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Accounts as the plugin writes them ─────────────────────────────────────

const win = (percent, resetsAt = null) => ({ percent, resetsAt });

function account(id, usage, fields = {}) {
  return {
    id, label: `${id}@x.io`, email: `${id}@x.io`, org: null, configDir: `/c/${id}`, isDefault: false, needsSignIn: false, error: null,
    usage: { session: null, weekly: null, fable: null, monthly: null, ...usage }, credits: null, usageUpdatedAt: Date.now(), ...fields,
  };
}

const doc = (accounts, active = accounts[0]?.id ?? "default") => ({ version: 1, updatedAt: 1, active, accounts });

// ── The account pick (D15, Orca's pickResumeAccount) ───────────────────────

describe("the account Continuar resumes with", () => {
  test("picks the lowest peak under 100% over session, weekly, fable and monthly", () => {
    const pick = pickAccount(doc([
      account("a", { session: win(90), weekly: win(10) }),
      account("b", { session: win(20), monthly: win(60) }),
      account("c", { session: win(30), fable: win(40) }),
    ]));
    assert.deepEqual(pick, { kind: "account", id: "c", label: "c@x.io", peak: 40 });
  });

  test("the active account wins a tie; sign-in, an error or unknown usage never win", () => {
    const accounts = [
      account("a", { session: win(30) }),
      account("b", { session: win(30) }),
      account("s", { session: win(1) }, { needsSignIn: true }),
      account("e", { session: win(2) }, { error: "rateLimited" }),
      account("u", {}),
    ];
    assert.equal(pickAccount(doc(accounts, "b")).id, "b");
    assert.equal(pickAccount(doc(accounts, "a")).id, "a");
    assert.equal(pickAccount(doc(accounts, "default")).id, "a");
  });

  test("all full: 'Vuelve a las' the minimum over accounts of the maximum reset of their full windows", () => {
    const at = (h, m) => new Date(2026, 10, 6, h, m).getTime();
    const pick = pickAccount(doc([
      // its windows come back at 15:00 and 18:30: back at 18:30
      account("a", { session: win(100, at(15, 0)), weekly: win(100, at(18, 30)) }),
      // one full window, back at 17:05 (its 9:00 window isn't full)
      account("b", { session: win(100, at(17, 5)), weekly: win(50, at(9, 0)) }),
      // full with no reset known: says nothing
      account("c", { session: win(100, null) }),
    ]));
    assert.deepEqual(pick, { kind: "none", returnsAt: at(17, 5) });
    assert.equal(formatReturn(pick.returnsAt), "Vuelve a las 17:05");
    assert.equal(formatReturn(at(9, 3)), "Vuelve a las 9:03");
    assert.equal(returnsAtOf(account("x", { session: win(100, new Date(at(8, 0)).toISOString()) })), at(8, 0));
    assert.deepEqual(pickAccount(doc([account("c", { session: win(100) })])), { kind: "none", returnsAt: null });
  });

  test("an accounts.v1.json with version 2 is refused", () => {
    assert.deepEqual(parseAccounts(JSON.stringify({ version: 2, accounts: [] })), { ok: false, reason: "version", version: 2 });
    assert.equal(pickFromText(JSON.stringify({ ...doc([account("a", { session: win(1) })]), version: 2 })), null);
    assert.equal(parseAccounts("{oops").reason, "invalid");
    assert.equal(parseAccounts(null).reason, "missing");
    assert.equal(pickFromText(JSON.stringify(doc([account("a", { session: win(1) })]))).id, "a");
  });
});

// ── The job and the window (D13, D15) ──────────────────────────────────────

describe("the plugin's job", () => {
  test("each status reads as live, final with its code, or unknown (exit 7)", () => {
    for (const state of ["queued", "waitingIdle", "stopping", "starting", "sending"]) {
      assert.equal(jobAnswer({ code: 0, json: { job: "j", state, updatedAt: 5 } }).kind, "live", state);
    }
    const finals = { done: 0, timeout: 4, landedElsewhere: 6, failed: 9, cancelled: 10 };
    for (const [state, code] of Object.entries(finals)) {
      assert.deepEqual(jobAnswer({ code: 0, json: { job: "j", state, code, detail: null, updatedAt: 5 } }), {
        kind: "final", state, code, detail: null, updatedAt: 5,
      });
    }
    assert.deepEqual(jobAnswer({ code: 7, json: null }), { kind: "final", state: "unknown", code: 7, detail: null, updatedAt: null });
    assert.equal(jobAnswer({ error: "ENOENT" }).kind, "doubt");
    assert.equal(jobAnswer({ code: 1, json: null }).kind, "doubt");
  });

  test("'runner gone' fails with its manual command in the paused row's text", () => {
    const detail = "runner gone · run by hand: claude --resume 4f1c";
    const req = { state: "paused", resumeJob: { id: "j", final: false }, handledTurn: 1 };
    const out = settleFinal(req, { state: "failed", code: 9, detail, updatedAt: 5 }, { terminal: { state: "live", turn: 3 } }, 100);
    assert.equal(out.release, undefined);
    assert.equal(out.fields.resumingUntil, null);
    assert.equal(out.fields.handledTurn, 3);
    assert.match(out.fields.resumeError.text, /No se pudo retomar: runner gone · run by hand: claude --resume 4f1c/);
    const view = continueView({ kind: "paused", request: { ...req, pauseReason: "limit", resumeJob: { id: "j", final: true }, resumeError: out.fields.resumeError }, plugin: true, pick: null, now: 100 });
    assert.match(view.note, /claude --resume 4f1c/);
  });

  test("a gone terminal is released when the job settles: failed after it left, or still gone", () => {
    const req = { state: "paused", goneInWindow: true, resumeJob: { id: "j" } };
    const live = { terminal: { state: "live", turn: 2 } };
    assert.equal(settleFinal(req, { state: "failed", code: 9 }, live, 1).release, true);
    assert.equal(settleFinal(req, { state: "done", code: 0 }, { missing: true }, 1).release, true);
    assert.equal(settleFinal(req, { state: "done", code: 0 }, live, 1).resumed, true);
  });

  test("Continuar's plan: a live job is reused, a holder gets Esc, signin never switches accounts", () => {
    const now = 1_000;
    const paused = { state: "paused", pauseReason: "limit" };
    assert.deepEqual(continuePlan({ ...paused, resumeJob: { id: "j1", final: false } }, { plugin: true, now }), { kind: "reuse", job: "j1" });
    assert.equal(continuePlan({ ...paused, resumeJob: { id: "j1", final: true } }, { plugin: true, now }).kind, "account");
    assert.equal(continuePlan({ ...paused, resumingUntil: now + 1 }, { plugin: true, now }).kind, "busy");
    assert.equal(continuePlan({ ...paused, resumingUntil: now + 1 }, { plugin: true, now, busy: false }).kind, "account");
    assert.equal(continuePlan({ state: "holding" }, { plugin: true, now }).kind, "esc");
    assert.equal(continuePlan({ state: "holding" }, { plugin: true, now, auto: true }).code, "auto-holder");
    assert.equal(continuePlan({ ...paused, pauseReason: "signin" }, { plugin: true, now }).code, "signin");
    assert.equal(continuePlan(paused, { plugin: false, now }).kind, "send");
    assert.equal(continuePlan(null, { plugin: true, now }).code, "no-place");
    assert.equal(continuePlan({ state: "waiting" }, { plugin: true, now }).code, "not-paused");
  });
});

describe("auto-resume", () => {
  const now = 10 * MINUTE;
  const limit = { state: "paused", pauseReason: "limit", pausedAt: now - MINUTE };

  test("takes a limit pause once, at most 3 in a row, never a signin or an error", () => {
    assert.equal(autoResumeDue(limit, { now, enabled: true }), true);
    assert.equal(autoResumeDue(limit, { now, enabled: false }), false);
    assert.equal(autoResumeDue({ ...limit, autoTriedPause: limit.pausedAt }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ ...limit, autoTriedPause: now - 5 * MINUTE }, { now, enabled: true }), true, "a new pause is a new chance");
    assert.equal(autoResumeDue({ ...limit, autoResumes: MAX_AUTO_RESUMES - 1 }, { now, enabled: true }), true);
    assert.equal(autoResumeDue({ ...limit, autoResumes: MAX_AUTO_RESUMES }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ ...limit, pauseReason: "signin" }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ ...limit, pauseReason: "error" }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ ...limit, resumingUntil: now + 1 }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ ...limit, resumeJob: { id: "j", final: false } }, { now, enabled: true }), false);
    assert.equal(autoResumeDue({ state: "holding", pauseReason: "limit" }, { now, enabled: true }), false);
  });

  test("with no account left, retries 60 s after the first reset", () => {
    const tried = { ...limit, autoTriedPause: limit.pausedAt, autoRetryAt: autoRetryAt(now + 5 * MINUTE, now) };
    assert.equal(tried.autoRetryAt, now + 5 * MINUTE + RETRY_AFTER_RESET_MS);
    assert.equal(autoResumeDue(tried, { now: now + 5 * MINUTE, enabled: true }), false);
    assert.equal(autoResumeDue(tried, { now: tried.autoRetryAt, enabled: true }), true);
    assert.equal(autoRetryAt(now - MINUTE, now), now + RETRY_AFTER_RESET_MS, "a reset already past waits a minute");
    assert.equal(autoRetryAt(null, now), null);
  });
});

describe("the board's Continuar", () => {
  const now = 10 * MINUTE;
  const paused = (fields = {}) => ({ state: "paused", pauseReason: "limit", ...fields });

  test("names the account, waits with 'Vuelve a las', or offers Inicia sesión", () => {
    const pick = { kind: "account", id: "b", label: "b@x.io", peak: 20 };
    assert.deepEqual(
      { ...continueView({ kind: "paused", request: paused(), plugin: true, pick, now }), tooltip: undefined },
      { action: "continue", label: "Continuar con b@x.io", disabled: false, tooltip: undefined },
    );
    const back = new Date(2026, 10, 6, 14, 30).getTime();
    const none = continueView({ kind: "paused", request: paused(), plugin: true, pick: { kind: "none", returnsAt: back }, now });
    assert.equal(none.label, "Vuelve a las 14:30");
    assert.equal(none.disabled, true);
    assert.equal(continueView({ kind: "paused", request: paused(), plugin: true, pick: { kind: "none", returnsAt: null }, now }).disabled, true);
    const signin = continueView({ kind: "paused", request: paused({ pauseReason: "signin" }), plugin: true, pick, now });
    assert.equal(signin.action, "signin");
    assert.equal(signin.label, "Inicia sesión");
    assert.equal(continueView({ kind: "paused", request: paused({ pauseReason: "signin" }), plugin: false, pick: null, now }), null);
    assert.equal(continueView({ kind: "paused", request: paused(), plugin: false, pick: null, now }).label, "Continuar");
  });

  test("reads Retomando… while its window is open or its job runs, on a paused row and on a testing row", () => {
    const open = continueView({ kind: "paused", request: paused({ resumingUntil: now + 1 }), plugin: true, pick: null, now });
    assert.deepEqual([open.label, open.disabled], ["Retomando…", true]);
    const job = continueView({ kind: "paused", request: paused({ resumeJob: { id: "j" } }), plugin: true, pick: null, now });
    assert.equal(job.label, "Retomando…");
    assert.equal(continueView({ kind: "testing", resuming: true, now }).label, "Retomando…");
    assert.deepEqual(
      [continueView({ kind: "testing", now }).label, continueView({ kind: "testing", now }).disabled],
      ["Continuar", false],
    );
    assert.equal(continueView({ kind: "waiting", now }), null);
  });
});

// ── The CLI, with a fake hc and a fake claude-accounts ─────────────────────

const worlds = [];
after(async () => {
  // Detached runs may still be finishing.
  await sleep(300);
  for (const w of worlds) rmSync(w.dir, { recursive: true, force: true });
});

// A JSON file shared by several processes, behind a mkdir lock. A hold lasts
// milliseconds, so a lock older than 2 s was left by a fake killed mid-write
// (an exec timeout on a loaded machine) and is broken.
const FAKE_LIB = (fileExpr) => `
const fs = require("fs");
const FILE = ${fileExpr};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lock() {
  for (let i = 0; i < 4000; i++) {
    try { fs.mkdirSync(FILE + ".lock"); return; } catch {}
    try { if (Date.now() - fs.statSync(FILE + ".lock").mtimeMs > 2000) fs.rmSync(FILE + ".lock", { recursive: true, force: true }); } catch {}
    pause(3);
  }
  throw new Error("fake: lock timeout");
}
const unlock = () => fs.rmSync(FILE + ".lock", { recursive: true, force: true });
const load = (empty) => { try { return { ...empty, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return empty; } };
function save(s) {
  const tmp = FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, FILE);
}
`;

// hc: get, ls, read, keys, send over the terminals in $FAKE_HC_STATE. `keys
// esc` stops a working agent (its turn ends); `send` records the text.
const FAKE_HC = `#!${NODE}
${FAKE_LIB("process.env.FAKE_HC_STATE")}
const args = process.argv.slice(2);
const [verb, ...rest] = args;
const pos = rest.filter((a) => !a.startsWith("--"));
let code = 0; let stdout; let stderr;
lock();
try {
  const s = load({ terminals: {}, sent: [], keys: [], calls: [], reads: {} });
  s.calls.push(args);
  const t = s.terminals[pos[0]];
  const missing = () => { code = 3; stderr = { error: { kind: "not_found", message: "no terminal " + pos[0] } }; };
  switch (verb) {
    case "get": t ? (stdout = t) : missing(); break;
    case "ls": stdout = { terminals: Object.values(s.terminals).filter((x) => x.state === "live") }; break;
    case "read": t ? (stdout = { text: s.reads[pos[0]] ?? "" }) : missing(); break;
    case "keys":
      if (!t) { missing(); break; }
      s.keys.push({ terminal: pos[0], keys: pos.slice(1) });
      if (pos.includes("esc") && t.status && t.status.state === "working") {
        t.status = { ...t.status, state: "idle" }; t.turn += 1; t.status_ms = Date.now();
      }
      stdout = {};
      break;
    case "send":
      if (!t) { missing(); break; }
      if (s.sendExit) { code = s.sendExit; stderr = { error: { kind: "blocked", message: "blocked" } }; break; }
      s.sent.push({ terminal: pos[0], text: pos[1], force: rest.includes("--force") });
      stdout = {};
      break;
    default:
      code = 2; stderr = { error: { kind: "usage", message: "fake hc: " + verb } };
  }
  save(s);
} finally {
  unlock();
}
if (stdout !== undefined) process.stdout.write(JSON.stringify(stdout) + "\\n");
if (stderr !== undefined) process.stderr.write(JSON.stringify(stderr) + "\\n");
process.exitCode = code;
`;

// claude-accounts per its CONTRACT.md: terminal, usage, resume (start,
// --status, --cancel). Its state: <app>/claude-accounts/fake.json.
const FAKE_ACCOUNTS = `#!${NODE}
const DIR = process.env.HERDR_APP_HOME + "/claude-accounts";
${FAKE_LIB('DIR + "/fake.json"')}
const FINAL = ["done", "timeout", "landedElsewhere", "failed", "cancelled"];
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
const EMPTY = { calls: [], jobs: {}, forgotten: [], nextJob: 1 };
if (args[0] === "usage") { const d = load(EMPTY).usageDelayMs; if (d) pause(d); }
let code = 0; let stdout; let stderr; let raw;
lock();
try {
  const s = load(EMPTY);
  s.calls.push(args);
  if (args[0] === "terminal") {
    if (s.terminalExit) { code = s.terminalExit; stderr = "fake: terminal " + s.terminalExit; }
    else {
      // After a done job the terminal runs on that job's account.
      const moved = Object.values(s.jobs).filter((j) => j.terminal === args[1] && j.state === "done").pop();
      stdout = { account: moved ? moved.account : (s.terminalAccount ?? "acc-1"), sessionId: "s1", status: "idle" };
    }
  } else if (args[0] === "usage") {
    try { raw = fs.readFileSync(DIR + "/accounts.v1.json", "utf8"); } catch { code = 1; stderr = "fake: no accounts"; }
    if (s.usageExit) code = s.usageExit;
  } else if (args[0] === "resume" && opt("--status")) {
    const j = s.jobs[opt("--status")];
    if (!j || s.forgotten.includes(j.job)) { code = 7; stderr = "unknown job"; } else stdout = j;
  } else if (args[0] === "resume" && opt("--cancel")) {
    const j = s.jobs[opt("--cancel")];
    if (j) j.state = "cancelled";
  } else if (args[0] === "resume") {
    if (s.resumeExit) { code = s.resumeExit; stderr = "fake: refused " + s.resumeExit; }
    else {
      const terminal = opt("--terminal");
      const live = Object.values(s.jobs).find((j) => j.terminal === terminal && !FINAL.includes(j.state));
      const j = live ?? { job: "job-" + s.nextJob++, terminal, account: opt("--account"), message: opt("--message"),
        state: "queued", code: null, detail: null, updatedAt: Date.now() };
      s.jobs[j.job] = j;
      stdout = { job: j.job };
    }
  } else { code = 64; stderr = "fake: usage"; }
  save(s);
} finally {
  unlock();
}
if (raw !== undefined) process.stdout.write(raw);
if (stdout !== undefined) process.stdout.write(JSON.stringify(stdout) + "\\n");
if (stderr !== undefined) process.stderr.write(stderr + "\\n");
process.exitCode = code;
`;

function writeExec(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function makeWorld({ plugin = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-resume-")));
  const home = join(dir, "home");
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  for (const d of [home, bin, join(app, "spotlight"), join(app, "claude-accounts")]) mkdirSync(d, { recursive: true });
  writeExec(join(bin, "hc"), FAKE_HC);
  if (plugin) writeExec(join(app, "mods", "claude-accounts", "bin", "claude-accounts"), FAKE_ACCOUNTS);
  const env = {};
  for (const k of ["TMPDIR", "LANG", "TZ"]) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PATH: `${bin}:${dirname(NODE)}:/usr/bin:/bin`,
    HOME: home,
    HERDR_APP_HOME: app,
    FAKE_HC_STATE: join(dir, "hc.json"),
    SPOTLIGHT_POLL_MS: "100",
  });
  const statePath = join(app, "spotlight", "state.json");
  const fakePath = join(app, "claude-accounts", "fake.json");
  const readJson = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : empty);
  const w = {
    dir, app, env, statePath,
    state: () => readJson(statePath, null),
    writeState: (s) => writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`),
    settings: (value) => writeFileSync(join(app, "spotlight", "settings.json"), JSON.stringify({ version: 1, ...value })),
    hc: () => readJson(env.FAKE_HC_STATE, { terminals: {}, sent: [], keys: [], calls: [], reads: {} }),
    hcUpdate(fn) {
      const s = w.hc();
      fn(s);
      writeFileSync(env.FAKE_HC_STATE, JSON.stringify(s, null, 1));
    },
    accounts: () => readJson(fakePath, { calls: [], jobs: {}, forgotten: [], nextJob: 1 }),
    accountsUpdate(fn) {
      const s = w.accounts();
      fn(s);
      writeFileSync(fakePath, JSON.stringify(s, null, 1));
    },
    usageFile: (value) => writeFileSync(join(app, "claude-accounts", "accounts.v1.json"), JSON.stringify(value)),
    // A Claude Code terminal as Herdr shows it.
    agent({ turn = 1, status = { state: "blocked" }, statusMs = Date.now() - 10_000 } = {}) {
      let made;
      w.hcUpdate((s) => {
        const n = Object.keys(s.terminals).length + 1;
        made = { address: `t${n}`, fgPid: 7000 + n };
        s.terminals[made.address] = {
          address: made.address, name: null, labels: {}, cwd: dir, pid: 6000 + n, state: "live", turn,
          status: { app: "claude", ...status }, status_ms: statusMs,
          foreground: { pid: made.fgPid, name: "claude", argv: ["claude"], cwd: dir },
        };
      });
      return made;
    },
    setAgent(t, fields) {
      w.hcUpdate((s) => Object.assign(s.terminals[t], fields));
    },
    cli(args, { extraEnv = {} } = {}) {
      const started = Date.now();
      return new Promise((resolve) => {
        execFile(NODE, [CLI, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr, ms: Date.now() - started });
        });
      });
    },
    async until(pred, { ms = 15_000, what = "state" } = {}) {
      const end = Date.now() + ms;
      for (;;) {
        const s = w.state();
        const v = s && pred(s);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)?.slice(0, 3000)}`);
        await sleep(50);
      }
    },
  };
  worlds.push(w);
  return w;
}

const requestOf = (s, t) => s.queue.requests.find((r) => r.terminal === t);
const resumeCalls = (w) => w.accounts().calls.filter((c) => c[0] === "resume" && c.includes("--terminal"));
const statusCalls = (w) => w.accounts().calls.filter((c) => c[0] === "resume" && c.includes("--status"));

const stateWith = (requests) => ({ version: 1, repos: {}, queue: { requests, lighting: {} }, notes: [], variants: {} });

// A slot-only request (nothing to light) as `spotlight on` and the reap leave it.
function requestFor(agent, fields = {}) {
  const now = Date.now();
  return {
    terminal: agent.address, taskKey: "spaceless/AX-1", label: "AX-1", lane: "spaceless", members: [], skipped: [], slotOnly: true,
    root: null, workspace: null, requestTurn: 0, fgPid: agent.fgPid, statusMs: null, resumingUntil: null, lastActivityAt: now - 5_000,
    state: "paused", requestedAt: now - 5_000, grantedAt: null, pausedAt: now - 4_000, pauseReason: "limit", pauseMsg: "usage limit",
    handledTurn: 1, ...fields,
  };
}

const holdingFor = (agent, fields = {}) =>
  requestFor(agent, { state: "holding", grantedAt: Date.now() - 5_000, pausedAt: null, pauseReason: null, pauseMsg: null, handledTurn: null, ...fields });

// One account with limit left, one without.
const ROOMY = () => doc([account("acc-1", { session: win(100, Date.now() + 3_600_000) }), account("acc-2", { session: win(20) })], "acc-1");

// A paused agent with Continuar started: its job is job-1.
async function continued(w, fields = {}) {
  w.usageFile(ROOMY());
  const a = w.agent();
  w.writeState(stateWith([requestFor(a, fields)]));
  const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(requestOf(w.state(), a.address).resumeJob.id, "job-1");
  return a;
}

const finish = (w, job, state, fields = {}) =>
  w.accountsUpdate((s) => Object.assign(s.jobs[job], { state, code: { done: 0, timeout: 4, landedElsewhere: 6, failed: 9, cancelled: 10 }[state], updatedAt: Date.now() }, fields));

describe("spotlight continue", () => {
  test("a paused agent resumes on the account with limit left, through the plugin's job", async () => {
    const w = makeWorld();
    const a = await continued(w);
    const calls = resumeCalls(w);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["resume", "--terminal", a.address, "--account", "acc-2", "--message", CONTINUE_MESSAGE, "--json"]);
    assert.ok(w.accounts().calls.some((c) => c[0] === "usage" && c.includes("--refresh")), "the usage is read fresh before the pick");
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused", "Continuar never grants a turn by itself");
    assert.ok(req.resumingUntil > Date.now(), "the window is open while the job runs");
    assert.equal(req.handledTurn, 1);
    assert.deepEqual(
      { account: req.resumeJob.account, label: req.resumeJob.label, auto: req.resumeJob.auto, final: req.resumeJob.final },
      { account: "acc-2", label: "acc-2@x.io", auto: false, final: false },
    );
  });

  test("each immediate refusal (2, 3, 5, 7, 8, 64) leaves the agent paused with its text and the window closed", async () => {
    const w = makeWorld();
    w.usageFile(ROOMY());
    const a = w.agent();
    for (const code of [2, 3, 5, 7, 8, 64]) {
      w.writeState(stateWith([requestFor(a)]));
      w.accountsUpdate((s) => {
        s.resumeExit = code;
      });
      const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
      assert.equal(r.code, 1, `exit ${code}: ${r.stderr}${r.stdout}`);
      assert.match(r.stderr, new RegExp(refusalText(code).en.slice(0, 20).replace(/[()]/g, ".")));
      const req = requestOf(w.state(), a.address);
      assert.equal(req.state, "paused", `exit ${code}`);
      assert.equal(req.resumingUntil, null, `exit ${code}`);
      assert.equal(req.resumeError.code, code);
      assert.equal(req.resumeError.text, refusalText(code).es);
      assert.equal(req.resumeJob ?? null, null);
    }
    assert.equal(refusalText(8).es, "Claude es el programa de la terminal: abre Claude desde una shell para poder cambiar de cuenta");
  });

  test("a repeated Continuar reuses the live job", async () => {
    const w = makeWorld();
    const a = await continued(w);
    const again = await w.cli(["continue", "--terminal", a.address]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /job-1/);
    const inline = await w.cli(["continue", "--terminal", a.address, "--inline"]);
    assert.equal(inline.code, 0, inline.stderr);
    assert.equal(resumeCalls(w).length, 1, "no second job");
  });

  test("`continue` returns at once; the detached run lands the job", async () => {
    const w = makeWorld();
    w.usageFile(ROOMY());
    w.accountsUpdate((s) => {
      s.usageDelayMs = 1500;
    });
    const a = w.agent();
    w.writeState(stateWith([requestFor(a)]));
    const r = await w.cli(["continue", "--terminal", a.address]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 1500, `continue waited ${r.ms} ms`);
    assert.ok(requestOf(w.state(), a.address).resumingUntil > Date.now(), "the window opens before it acts");
    await w.until((s) => requestOf(s, a.address)?.resumeJob?.id === "job-1", { what: "the job" });
  });

  test("an accounts.v1.json with version 2 is refused: no pick, no job", async () => {
    const w = makeWorld();
    w.usageFile({ ...ROOMY(), version: 2 });
    const a = w.agent();
    w.writeState(stateWith([requestFor(a)]));
    const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /version/);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused");
    assert.equal(req.resumeError.code, "accounts-version");
    assert.equal(resumeCalls(w).length, 0);
  });

  test("no account with limit: stays paused, 'Vuelve a las', and auto-resume retries 60 s after the reset", async () => {
    const w = makeWorld();
    const back = Date.now() + 30 * MINUTE;
    w.usageFile(doc([account("acc-1", { session: win(100, back) })]));
    const a = w.agent();
    w.writeState(stateWith([requestFor(a, { autoTriedPause: 1 })]));
    const r = await w.cli(["continue", "--terminal", a.address, "--inline", "--auto"]);
    assert.equal(r.code, 1);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused");
    assert.equal(req.resumeError.code, "no-account");
    assert.match(req.resumeError.text, new RegExp(formatReturn(back)));
    assert.equal(req.autoRetryAt, back + RETRY_AFTER_RESET_MS);
    assert.equal(resumeCalls(w).length, 0);
  });

  test("a signin pause is never switched: Continuar refuses and points at the sign-in", async () => {
    const w = makeWorld();
    w.usageFile(ROOMY());
    const a = w.agent();
    w.writeState(stateWith([requestFor(a, { pauseReason: "signin" })]));
    const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /sign/);
    assert.equal(resumeCalls(w).length, 0);
    assert.equal(requestOf(w.state(), a.address).resumingUntil, null);
  });

  test("without the plugin, Continuar types 'Continue where you left off.' into the same agent", async () => {
    const w = makeWorld({ plugin: false });
    const a = w.agent({ turn: 1, status: { state: "error" } });
    w.writeState(stateWith([requestFor(a)]));
    const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(w.hc().sent.map((s) => [s.terminal, s.text]), [[a.address, CONTINUE_MESSAGE]]);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "holding", "the pause ends: it asks for its place back, at the front");
    assert.equal(req.resumingUntil, null);
    assert.equal(req.requestTurn, 1, "the resumed session's first turn end is the one decided next");
  });

  test("an idle holder: Esc, then the message, in the same account; it keeps its turn", async () => {
    const w = makeWorld();
    w.usageFile(ROOMY());
    w.accountsUpdate((s) => {
      s.terminalAccount = "acc-2";
    });
    const a = w.agent({ turn: 2, status: { state: "working" } });
    w.writeState(stateWith([holdingFor(a, { requestTurn: 2, lastActivityAt: Date.now() - 20 * MINUTE })]));
    const r = await w.cli(["continue", "--terminal", a.address, "--inline"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const hc = w.hc();
    const keysAt = hc.calls.findIndex((c) => c[0] === "keys");
    const sendAt = hc.calls.findIndex((c) => c[0] === "send");
    assert.deepEqual(hc.keys, [{ terminal: a.address, keys: ["esc"] }]);
    assert.ok(keysAt !== -1 && keysAt < sendAt, "Esc first, then the message");
    assert.deepEqual(hc.sent.map((s) => [s.terminal, s.text]), [[a.address, CONTINUE_MESSAGE]]);
    assert.equal(resumeCalls(w).length, 0, "no account switch");
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "holding");
    assert.equal(req.resumingUntil, null);
    assert.equal(req.handledTurn, 3, "the Esc's turn end is spent");
    assert.ok(req.lastActivityAt > Date.now() - MINUTE);
    // The message's own turn end gives the turn back.
    w.setAgent(a.address, { turn: 4, status: { app: "claude", state: "done" }, status_ms: Date.now() });
    assert.equal((await w.cli(["reap"])).code, 0);
    assert.equal(requestOf(w.state(), a.address), undefined);
  });
});

describe("the job settles on reap (D15)", () => {
  test("done: the pause ends (it asks again, at the front), the window closes, the turn is re-baselined", async () => {
    const w = makeWorld();
    const a = await continued(w);
    w.setAgent(a.address, { turn: 4, status: { app: "claude", state: "idle" }, status_ms: Date.now() - 1_000 });
    finish(w, "job-1", "done");
    assert.equal((await w.cli(["reap"])).code, 0);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "holding");
    assert.equal(req.resumingUntil, null);
    assert.equal(req.requestTurn, 4);
    assert.equal(req.resumeJob.final, true);
    assert.equal(req.resumeJob.state, "done");
    // The resumed session's first turn end is decided as any other (its new account has limit).
    w.setAgent(a.address, { turn: 5, status: { app: "claude", state: "done" }, status_ms: Date.now() });
    assert.equal((await w.cli(["reap"])).code, 0);
    assert.equal(requestOf(w.state(), a.address), undefined);
  });

  test("done after the resumed session already ended its first turn: that end is decided at once", async () => {
    const w = makeWorld();
    const a = await continued(w);
    finish(w, "job-1", "done", { updatedAt: Date.now() - 2_000 });
    w.setAgent(a.address, { turn: 6, status: { app: "claude", state: "error" }, status_ms: Date.now() });
    assert.equal((await w.cli(["reap"])).code, 0);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused", "a resumed agent that fails again is paused anew");
    assert.equal(req.pauseReason, "error");
  });

  test("timeout, landedElsewhere, failed (with its manual command) and cancelled stay paused with their text", async () => {
    for (const [state, code, detail, text] of [
      ["timeout", 4, null, refusalText("timeout").es],
      ["landedElsewhere", 6, null, refusalText("landedElsewhere").es],
      ["failed", 9, "runner gone · run by hand: claude --resume s1", "No se pudo retomar: runner gone · run by hand: claude --resume s1"],
      ["cancelled", 10, null, refusalText("cancelled").es],
    ]) {
      const w = makeWorld();
      const a = await continued(w);
      // The restart's own turn ends happened inside the window.
      w.setAgent(a.address, { turn: 3, status: { app: "claude", state: "idle" }, status_ms: Date.now() });
      finish(w, "job-1", state, { detail });
      assert.equal((await w.cli(["reap"])).code, 0, state);
      const req = requestOf(w.state(), a.address);
      assert.equal(req.state, "paused", state);
      assert.equal(req.resumingUntil, null, state);
      assert.deepEqual([req.resumeError.code, req.resumeError.text], [code, text], state);
      assert.deepEqual([req.resumeJob.state, req.resumeJob.final], [state, true], state);
      assert.equal(req.handledTurn, 3, `${state}: the restart's turn ends are spent`);
      assert.equal((await w.cli(["reap"])).code, 0);
      assert.equal(requestOf(w.state(), a.address)?.state, "paused", `${state}: still paused on the next reap`);
    }
  });

  test("a final state is cached: a later --status exit 7 changes nothing, and the job is never polled again", async () => {
    const w = makeWorld();
    const a = await continued(w);
    finish(w, "job-1", "failed", { detail: "runner gone · run by hand: claude --resume s1" });
    assert.equal((await w.cli(["reap"])).code, 0);
    const before = requestOf(w.state(), a.address);
    const polls = statusCalls(w).length;
    w.accountsUpdate((s) => {
      s.forgotten.push("job-1");
    });
    assert.equal((await w.cli(["reap"])).code, 0);
    assert.deepEqual(requestOf(w.state(), a.address), before);
    assert.equal(statusCalls(w).length, polls, "a settled job is never polled again");
  });

  test("a job forgotten before Spotlight saw it final reads as unknown: paused with its text", async () => {
    const w = makeWorld();
    const a = await continued(w);
    w.accountsUpdate((s) => {
      s.forgotten.push("job-1");
    });
    assert.equal((await w.cli(["reap"])).code, 0);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused");
    assert.equal(req.resumeError.code, 7);
    assert.equal(req.resumeJob.final, true);
  });

  test("inside the window, the relaunch's idle and a gone terminal don't release; the job then decides", async () => {
    const w = makeWorld();
    const a = await continued(w);
    // The old Claude stops and the new one sits idle: turn ends inside the window.
    w.setAgent(a.address, { turn: 3, status: { app: "claude", state: "idle" }, status_ms: Date.now(), foreground: { pid: 1, name: "zsh" } });
    w.accountsUpdate((s) => {
      s.jobs["job-1"].state = "starting";
    });
    assert.equal((await w.cli(["reap"])).code, 0);
    let req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused");
    assert.ok(req.resumingUntil > Date.now() + RESUME_WINDOW_MS - MINUTE, "a live job extends the window");
    w.hcUpdate((s) => {
      delete s.terminals[a.address];
    });
    assert.equal((await w.cli(["reap"])).code, 0);
    req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused", "a gone terminal inside the window keeps its place");
    assert.equal(req.goneInWindow, true);
    finish(w, "job-1", "failed", { detail: "runner gone" });
    assert.equal((await w.cli(["reap"])).code, 0);
    assert.equal(requestOf(w.state(), a.address), undefined, "released: the job failed after its terminal left");
  });

  test("a terminal still gone when the job is done is released", async () => {
    const w = makeWorld();
    const a = await continued(w);
    w.hcUpdate((s) => {
      delete s.terminals[a.address];
    });
    finish(w, "job-1", "done");
    assert.equal((await w.cli(["reap"])).code, 0);
    assert.equal(requestOf(w.state(), a.address), undefined);
  });
});

describe("auto-resume on reap", () => {
  test("a limit pause resumes alone with a toast; the count goes up; at most 3 in a row; signin never", async () => {
    const w = makeWorld();
    w.settings({ queue: { autoResume: true } });
    w.usageFile(ROOMY());
    const a = w.agent();
    const signin = w.agent();
    const spent = w.agent();
    w.writeState(stateWith([
      requestFor(a),
      requestFor(signin, { taskKey: "spaceless/AX-2", label: "AX-2", pauseReason: "signin" }),
      requestFor(spent, { taskKey: "spaceless/AX-3", label: "AX-3", autoResumes: MAX_AUTO_RESUMES }),
    ]));
    assert.equal((await w.cli(["reap"])).code, 0);
    await w.until((s) => requestOf(s, a.address)?.resumeJob?.id, { what: "the automatic job" });
    assert.equal(requestOf(w.state(), a.address).resumeJob.auto, true);
    finish(w, "job-1", "done");
    assert.equal((await w.cli(["reap"])).code, 0);
    const s = w.state();
    assert.equal(requestOf(s, a.address).autoResumes, 1);
    assert.equal(requestOf(s, a.address).state, "holding");
    const toast = s.notes.find((n) => n.toast && /Reanudado con/.test(n.text));
    assert.ok(toast, JSON.stringify(s.notes));
    assert.match(toast.text, /Reanudado con acc-2@x\.io/);
    await sleep(500);
    assert.deepEqual(resumeCalls(w).map((c) => c[2]), [a.address], "the signin pause and the spent one were left alone");
    assert.equal(requestOf(w.state(), signin.address).resumingUntil, null);
    assert.equal(requestOf(w.state(), spent.address).resumingUntil, null);
  });

  test("with the setting off, nothing resumes alone", async () => {
    const w = makeWorld();
    w.usageFile(ROOMY());
    const a = w.agent();
    w.writeState(stateWith([requestFor(a)]));
    assert.equal((await w.cli(["reap"])).code, 0);
    await sleep(500);
    assert.equal(resumeCalls(w).length, 0);
  });
});

describe("spotlight classify (D13)", () => {
  // A holder whose turn ended (done, turn up) while its usage was stale: the
  // reap marked it and spawned classify, which reads the usage fresh.
  async function staleHolder(percent) {
    const w = makeWorld();
    w.usageFile(doc([account("acc-1", { session: win(percent, Date.now() + MINUTE) }, { usageUpdatedAt: Date.now() - 10 * MINUTE })]));
    const a = w.agent({ turn: 1, status: { state: "done" } });
    w.writeState(stateWith([holdingFor(a, { classifyTurn: 1, classifyAt: Date.now(), classifyPid: null })]));
    const r = await w.cli(["classify", "--terminal", a.address]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(w.accounts().calls.some((c) => c[0] === "usage" && c.includes("--refresh")), "usage --refresh first");
    return { w, a };
  }

  test("the account has limit: the turn end releases", async () => {
    const { w, a } = await staleHolder(30);
    assert.equal(requestOf(w.state(), a.address), undefined);
  });

  test("the account is at 100%: paused for the limit, place kept", async () => {
    const { w, a } = await staleHolder(100);
    const req = requestOf(w.state(), a.address);
    assert.equal(req.state, "paused");
    assert.equal(req.pauseReason, "limit");
  });

  test("nothing to classify: exit 0, nothing written", async () => {
    const w = makeWorld();
    const a = w.agent();
    w.writeState(stateWith([holdingFor(a)]));
    const before = readFileSync(w.statePath, "utf8");
    const r = await w.cli(["classify", "--terminal", a.address]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(w.statePath, "utf8"), before);
  });
});
