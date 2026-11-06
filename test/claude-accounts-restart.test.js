// claude-accounts T4: a terminal's account (D7), the switch and its restarts
// (D8), and `resume` for other plugins (D9, CONTRACT.md).
//
// Nothing here touches a real terminal. Each test runs the CLI (a copy of
// cli/ and bin/ in this run's tmp folder, so every detached runner it starts
// is named by that folder and can be found and killed) inside a sandbox:
// HOME and CLAUDE_ACCOUNTS_HOME are tmp folders, PATH starts with shims, and
// `hc` is a fake that reads a world of fake terminals from FAKE_HC_DIR:
//   - each terminal is world/terminals/<t>.json: a fake shell pid (above any
//     real pid), and the pid of its fake Claude, a real `sleep` this file
//     started, so the runner's SIGTERM stops it for real;
//   - `hc get` shows Claude in the foreground while that pid lives, else the
//     shell; `hc ls` lists the terminals, agent "claude-code" while it lives;
//   - `hc send` logs the text; a typed resume line is parsed by /bin/sh with
//     a `claude` function (so the quoting is checked by a real shell), then
//     a new fake Claude starts and writes its session file into
//     CLAUDE_ACCOUNTS_DIR's folder (System default's for ""), as the
//     launcher and Claude would. As the real Claude, it refuses a session
//     whose transcript that folder's projects/ doesn't have: it prints "No
//     conversation found with session ID: …" and the shell is back;
//   - `hc read` prints the terminal's screen: a starship-like two-line
//     prompt ("ws on  main", then "❯ "), the typed lines, Claude's error;
//   - every call is logged with whether HC_TERMINAL_ID reached it.
// Session files and transcripts are real files in fake config dirs; every
// profile's projects/ links to ~/.claude/projects, as on the person's Mac.
// The restart timings are set through CLAUDE_ACCOUNTS_RESTART_TIMING (see
// TIMING), and every wait is on a condition with a generous ceiling, since
// node --test runs this file alongside the rest of the suite.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(repo, "claude-accounts/mods/claude-accounts");
const RESTART_MJS = pathToFileURL(join(SRC, "cli/restart.mjs")).href;

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-accounts-t4-")));
const MOD = join(root, "mod");
cpSync(join(SRC, "cli"), join(MOD, "cli"), { recursive: true });
cpSync(join(SRC, "bin"), join(MOD, "bin"), { recursive: true });
const BIN = join(MOD, "bin/claude-accounts");
chmodSync(BIN, 0o755);

// Test timings: a loop polls every 25 ms, the shell back with no new Claude
// fails after 0.6 s, and claims beat every 150 ms. The caps that end a job
// (30 s for the shell and for the new Claude) and the stale window (20 s)
// stay generous, so a machine loaded by the whole suite running in parallel
// never ends a healthy job early; only the tests about those caps cut them
// to 2 s (SHORT_CAPS).
const TIMING = { poll: 25, shell: 30_000, claude: 30_000, shellBack: 600, heartbeat: 150, stale: 20_000, waitPoll: 40 };
const SHORT_CAPS = { shell: 2000, claude: 2000 };

// How long a test waits on a condition, and on one CLI run, before it fails:
// far above what any of them takes, so only a real hang reaches it.
const WAIT = 60_000;
const CLI_TIMEOUT = 120_000;

// ── Accounts used across tests (made up) ───────────────────────────────────

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const login = (email, org) => ({ emailAddress: email, organizationName: org, organizationUuid: randomUUID() });

// ── Processes this file starts ─────────────────────────────────────────────

// How long a fake Claude lives at most, so one that escapes the cleanup
// still goes on its own.
const FAKE_LIFE_S = 120;

const fakePids = [];
const sandboxes = [];

// A fake Claude: a `sleep` whose parent exits at once, so it's reaped when
// it dies. ignoreTerm: it ignores SIGTERM (a Claude that won't stop).
function startFakeClaude({ ignoreTerm = false } = {}) {
  const body = ignoreTerm ? `(trap '' TERM; exec /bin/sleep ${FAKE_LIFE_S})` : `/bin/sleep ${FAKE_LIFE_S}`;
  const r = spawnSync("/bin/sh", ["-c", `${body} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `a fake Claude started: ${r.stdout} ${r.stderr}`);
  fakePids.push(pid);
  return pid;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// This run's detached runners, by their command line.
function runnerPids() {
  const r = spawnSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return r.stdout
    .split("\n")
    .filter((line) => line.includes(`${BIN} restart --detach`))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isInteger);
}

// Every pid a shim started (the resumed fake Claudes).
const shimPids = () =>
  sandboxes.flatMap((s) => {
    const file = join(s.worldDir, "pids");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
  });

// Kills what this file started, each source on its own, so one that throws
// never spares the others.
function killAll() {
  for (const source of [runnerPids, () => fakePids, shimPids]) {
    let pids = [];
    try {
      pids = source();
    } catch {
      // Its list can't be read; the other sources still run.
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

// Polls check() until it's truthy. On a timeout, the failure carries what
// dump() returns (the queue, say), to see where things stood.
async function until(check, ms = WAIT, what = "the condition", dump = null) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}${dump ? `: ${JSON.stringify(dump())}` : ""}`);
    await sleep(25);
  }
}

// Tests in one file run one at a time: each waits here until the runners it
// started have exited, so none outlives its test or loads the next one. A
// runner that never exits is a leak: it's killed, and its test fails.
afterEach(async () => {
  try {
    await until(() => runnerPids().length === 0, WAIT, "this test's runners to exit", runnerPids);
  } catch (error) {
    for (const pid of runnerPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    throw error;
  }
});

// ── The fake hc ────────────────────────────────────────────────────────────

const FAKE_HC = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const dir = process.env.FAKE_HC_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv, hcTerminalId: process.env.HC_TERMINAL_ID ?? null }) + "\\n");
const [cmd, ...rest] = argv;
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--") { pos.push(...rest.slice(i + 1)); break; }
  if (!rest[i].startsWith("--")) pos.push(rest[i]);
}
const file = (t) => path.join(dir, "terminals", t + ".json");
const load = (t) => { try { return JSON.parse(fs.readFileSync(file(t), "utf8")); } catch { return null; } };
const save = (t, v) => { const tmp = file(t) + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, file(t)); };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const fail = (kind, message, code) => { process.stderr.write(JSON.stringify({ error: { kind, message } }) + "\\n"); process.exit(code); };
function view(v) {
  const running = alive(v.claude);
  return {
    address: v.address,
    pid: v.own ? v.claude : v.pid,
    argv: v.own ? v.argv : ["/bin/zsh", "-l"],
    foreground: running
      ? { pid: v.claude, name: v.name || "claude.exe", argv: v.argv, cwd: "/tmp" }
      : { pid: v.pid, name: "zsh", argv: ["-zsh"], cwd: "/tmp" },
    status: running ? { app: "claude-code", state: v.state || "idle" } : null,
    state: v.own && !running ? "finished" : "live",
    title: v.title || null,
    labels: {},
  };
}
if (cmd === "ls") {
  const terminals = fs.readdirSync(path.join(dir, "terminals")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => load(f.slice(0, -5))).filter(Boolean).map((v) => {
      const x = view(v);
      return { address: v.address, agent: x.status ? "claude-code" : "zsh", state: x.state, turn: 0, where: v.where, status: x.status ? x.status.state : undefined };
    });
  process.stdout.write(JSON.stringify({ hidden_finished: 0, terminals }) + "\\n");
} else if (cmd === "get") {
  const first = load(pos[0]);
  if (first && first.getSleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, first.getSleep * 1000);
  const v = load(pos[0]);
  if (!v) fail("not_found", "no terminal " + JSON.stringify(pos[0]), 3);
  if (v.getFails) fail("io", "fake hc: get failed", 1);
  process.stdout.write(JSON.stringify(view(v)) + "\\n");
} else if (cmd === "read") {
  const v = load(pos[0]);
  if (!v) fail("not_found", "no terminal " + JSON.stringify(pos[0]), 3);
  process.stdout.write((v.screen || []).join("\\n") + "\\n");
} else if (cmd === "send") {
  const [t, text] = pos;
  const v = load(t);
  if (!v) fail("not_found", "no terminal " + JSON.stringify(t), 3);
  fs.appendFileSync(path.join(dir, "sends.log"), JSON.stringify({ terminal: t, text }) + "\\n");
  if (v.sendSleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, v.sendSleep * 1000);
  if (v.sendFails) fail("io", "fake hc: send failed", 1);
  if (/ --resume /.test(text)) {
    const r = spawnSync("/bin/sh", ["-c", 'claude() { printf "%s\\\\0" "\${CLAUDE_ACCOUNTS_DIR-__unset__}" "$@"; }\\n' + text], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    const parts = r.stdout.split("\\0").slice(0, -1);
    const typed = { terminal: t, dir: parts[0] === "__unset__" ? null : parts[0], args: parts.slice(1), shell: r.status };
    fs.appendFileSync(path.join(dir, "typed.log"), JSON.stringify(typed) + "\\n");
    const lands = v.land || (typed.dir ? typed.dir : path.join(process.env.HOME, ".claude"));
    const sid = typed.args[typed.args.indexOf("--resume") + 1];
    const prompt = ["", "ws on  main"];
    const screen = [...(v.screen || []), ...prompt, "❯ " + text];
    const projects = path.join(lands, "projects");
    let transcript = false;
    try {
      transcript = fs.readdirSync(projects).some((n) => fs.existsSync(path.join(projects, n, sid + ".jsonl")));
    } catch {}
    if (v.noStart) {
      save(t, { ...load(t), screen: [...screen, ...prompt, "❯"] });
    } else if (!transcript) {
      save(t, { ...load(t), screen: [...screen, "No conversation found with session ID: " + sid, ...prompt, "❯"] });
    } else {
      const child = spawn("/bin/sleep", [process.env.FAKE_LIFE_S], { detached: true, stdio: "ignore" });
      child.unref();
      fs.appendFileSync(path.join(dir, "pids"), child.pid + "\\n");
      fs.mkdirSync(path.join(lands, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(lands, "sessions", child.pid + ".json"), JSON.stringify({ pid: child.pid, sessionId: sid, status: v.startStatus || "idle" }));
      save(t, { ...load(t), claude: child.pid, argv: ["/Users/tester/.local/bin/claude", ...typed.args], state: "idle", screen: [...screen, "╭─ Claude Code ─╮"] });
    }
  }
  process.stdout.write(JSON.stringify({ turn: 1 }) + "\\n");
} else {
  fail("usage", "fake hc: unexpected " + argv.join(" "), 2);
}
`;

// ── The sandbox ────────────────────────────────────────────────────────────

let n = 0;
let shellPids = 2_000_000; // above macOS's pid_max: never a real process

function sandbox({ active = A, switchMode = "ask", timing = {} } = {}) {
  const box = join(root, `s${++n}`);
  const home = join(box, "home");
  const state = join(box, "state");
  const shims = join(box, "bin");
  const world = join(box, "world");
  for (const dir of [home, state, shims, join(world, "terminals")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shims, "hc"), FAKE_HC);
  chmodSync(join(shims, "hc"), 0o755);
  for (const [name, code] of [["security", 44], ["claude", 1], ["claude-usage", 1], ["open", 1]]) {
    writeFileSync(join(shims, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(shims, name), 0o755);
  }
  const env = {
    HOME: home,
    USER: "tester",
    PATH: [shims, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    TMPDIR: box,
    CLAUDE_ACCOUNTS_HOME: state,
    CLAUDE_ACCOUNTS_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
    CLAUDE_ACCOUNTS_USAGE_BIN: join(shims, "claude-usage"),
    CLAUDE_ACCOUNTS_RESTART_TIMING: JSON.stringify({ ...TIMING, ...timing }),
    FAKE_HC_DIR: world,
    FAKE_LIFE_S: String(FAKE_LIFE_S),
    // Set on purpose: no hc call may carry it (D7).
    HC_TERMINAL_ID: "t99",
  };
  for (const key of ["HOME", "TMPDIR", "CLAUDE_ACCOUNTS_HOME", "FAKE_HC_DIR"]) {
    assert.ok(env[key].startsWith(`${root}/`), `a sandbox path, never the person's: ${key}=${env[key]}`);
  }

  // Three saved accounts and System default. A's folder has a space, B's a
  // quote, a double quote, a $ and spaces (the typed line must keep them);
  // C never signed in.
  const dirs = {
    default: join(home, ".claude"),
    [A]: join(box, "profiles", "ana home", "home"),
    [B]: join(box, "profiles", `ben's "b" $HOME`, "home"),
    [C]: join(box, "profiles", "cal", "home"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  // Every profile's projects/ is a link to ~/.claude/projects (Orca's
  // provisioning, and `login new`'s), so a transcript is seen from all.
  mkdirSync(join(dirs.default, "projects"));
  for (const id of [A, B, C]) symlinkSync(join(dirs.default, "projects"), join(dirs[id], "projects"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: login("dee@example.com", "Dee") }));
  writeFileSync(join(dirs[A], ".claude.json"), JSON.stringify({ oauthAccount: login("ana@example.com", "Example Org") }));
  writeFileSync(join(dirs[B], ".claude.json"), JSON.stringify({ oauthAccount: login("ben@example.org", "Acme") }));
  const registry = [
    [A, "ana@example.com"],
    [B, "ben@example.org"],
    [C, "cal@example.net"],
  ].map(([id, email]) => ({ id, email, org: null, orgUuid: null, configDir: dirs[id], lastAuthenticatedAt: 1, source: "orca" }));
  writeFileSync(join(state, "accounts.json"), `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(state, "active"), active === "default" ? "" : dirs[active]);
  writeFileSync(join(state, "settings.json"), JSON.stringify({ switchMode }));

  // A folder no account has: an Orca profile the registry doesn't list.
  const stray = join(home, "Library", "Application Support", "Orca Dev", "claude-profiles", "dddddddd-4444-4444-8444-444444444444", "home");
  mkdirSync(stray, { recursive: true });

  const s = { box, home, state, worldDir: world, env, dirs, stray };

  s.cli = (args, extra = {}) => {
    const r = spawnSync(BIN, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: CLI_TIMEOUT });
    if (r.error) throw r.error;
    return r;
  };
  // As Herdr's exec runs it: execFile, stdout and stderr captured.
  s.exec = (args) =>
    new Promise((resolve) => {
      const started = Date.now();
      execFile(BIN, args, { env, timeout: CLI_TIMEOUT }, (error, stdout, stderr) =>
        resolve({ status: error ? error.code : 0, stdout, stderr, ms: Date.now() - started }),
      );
    });
  s.json = (args) => {
    const r = s.cli([...args, "--json"]);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  // A terminal running a fake Claude on `on` (an account id, or a folder):
  // its session file says `status`, Herdr's status says `state`.
  // transcript: the conversation has one (projects/<slug>/<sid>.jsonl in
  // its folder), so it can be resumed; false for a Claude never sent a
  // message.
  s.term = (t, { on = A, sessionId = randomUUID(), status = "idle", state = "idle", argv, own = false, title, ignoreTerm = false, session = true, transcript = true, ...flags } = {}) => {
    const pid = startFakeClaude({ ignoreTerm });
    const dir = s.dirs[on] ?? on;
    const sessionFile = join(dir, "sessions", `${pid}.json`);
    const writeSession = (patch = {}) => {
      mkdirSync(dirname(sessionFile), { recursive: true });
      writeFileSync(sessionFile, JSON.stringify({ pid, sessionId, status, cwd: "/tmp", ...patch }));
    };
    if (session) writeSession();
    const transcriptFile = join(dir, "projects", `-tmp-${t}`, `${sessionId}.jsonl`);
    if (session && transcript) {
      mkdirSync(dirname(transcriptFile), { recursive: true });
      writeFileSync(transcriptFile, `${JSON.stringify({ sessionId, type: "user" })}\n`);
    }
    s.world(t, {
      address: t,
      pid: own ? pid : ++shellPids,
      claude: pid,
      own,
      argv: argv ?? ["/Users/tester/.local/bin/claude"],
      title: title ?? `claude · ${t}`,
      screen: ["", "ws on  main", "❯ claude", "╭─ Claude Code ─╮"],
      state,
      where: `ws / ${t}`,
      ...flags,
    });
    return {
      pid,
      sessionId,
      dir,
      sessionFile,
      transcriptFile,
      setSession: (patch) => writeSession(patch),
      set: (patch) => s.world(t, { ...s.worldOf(t), ...patch }),
    };
  };
  // A terminal whose shell has nothing in the foreground.
  s.shell = (t) => s.world(t, { address: t, pid: ++shellPids, claude: null, own: false, argv: [], where: `ws / ${t}` });
  s.world = (t, value) => writeFileSync(join(world, "terminals", `${t}.json`), JSON.stringify(value));
  s.worldOf = (t) => JSON.parse(readFileSync(join(world, "terminals", `${t}.json`), "utf8"));

  const lines = (name) => {
    const file = join(world, name);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  s.calls = () => lines("calls.log");
  s.sends = (t) => lines("sends.log").filter((x) => !t || x.terminal === t);
  s.typed = (t) => lines("typed.log").filter((x) => !t || x.terminal === t);
  s.queue = () => {
    const file = join(state, "restart.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).items : [];
  };
  s.writeQueue = (items) => writeFileSync(join(state, "restart.json"), `${JSON.stringify({ items }, null, 2)}\n`);
  s.pending = () => {
    const file = join(state, "pending-switch.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  s.active = () => readFileSync(join(state, "active"), "utf8");
  s.status = (job) => {
    const r = s.cli(["resume", "--status", job, "--json"]);
    return { exit: r.status, ...(r.stdout ? JSON.parse(r.stdout) : {}), stderr: r.stderr };
  };
  s.final = (job, ms = WAIT) => until(() => {
    const st = s.status(job);
    return ["done", "timeout", "landedElsewhere", "failed", "cancelled"].includes(st.state) && st;
  }, ms, `job ${job} to end`);
  s.item = (pred) => s.queue().find(pred);
  sandboxes.push(s);
  return s;
}

// Edits restart.json the way the CLI does: under its lock (D2), so a
// runner's read-modify-write can't overwrite the edit.
function underCliLock(s, edit) {
  const lock = join(s.state, "lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    writeFileSync(join(lock, "pid"), `${process.pid}\ntest\n`);
    const doc = JSON.parse(readFileSync(join(s.state, "restart.json"), "utf8"));
    edit(doc.items);
    writeFileSync(join(s.state, "restart.json"), `${JSON.stringify(doc, null, 2)}\n`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const resumeItem = (fields) => ({
  id: `rs-${randomUUID().slice(0, 8)}`,
  kind: "resume",
  terminal: "t1",
  from: A,
  to: B,
  sessionId: randomUUID(),
  args: [],
  message: null,
  state: "queued",
  code: null,
  detail: null,
  claimedBy: null,
  updatedAt: Date.now(),
  ...fields,
});

// ── terminal <t> (D7) ──────────────────────────────────────────────────────

test("terminal: the account, session and status come from the live session file, re-read every time (/clear)", () => {
  const s = sandbox();
  const t1 = s.term("t1", { on: A, status: "idle" });
  s.term("t2", { on: "default", status: "busy", state: "working" });
  assert.deepEqual(s.json(["terminal", "t1"]), { account: A, sessionId: t1.sessionId, status: "idle", resumable: true });
  assert.deepEqual(s.json(["terminal", "t2"]).account, "default");
  assert.equal(s.json(["terminal", "t2"]).status, "busy");

  // /clear: a new session id, with no transcript until it gets a message.
  const cleared = randomUUID();
  t1.setSession({ sessionId: cleared, status: "busy" });
  assert.deepEqual(s.json(["terminal", "t1"]), { account: A, sessionId: cleared, status: "busy", resumable: false });
});

test("terminal: resumable needs the conversation's transcript, found under any project folder, links followed", () => {
  const s = sandbox();
  const fresh = s.term("t1", { on: A, transcript: false });
  const r = s.cli(["terminal", "t1", "--json"]);
  assert.equal(r.status, 0, "a Claude with nothing to resume still answers 0");
  assert.equal(JSON.parse(r.stdout).resumable, false);
  // A transcript in a project folder that is itself a link elsewhere.
  const elsewhere = join(s.box, "moved-project");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, `${fresh.sessionId}.jsonl`), "{}\n");
  symlinkSync(elsewhere, join(s.dirs.default, "projects", "-somewhere-else"));
  assert.equal(s.json(["terminal", "t1"]).resumable, true, "seen through A's projects/ link and the folder link");
  // The same session id as a folder, or a file one level too deep, isn't one.
  rmSync(join(s.dirs.default, "projects", "-somewhere-else"));
  mkdirSync(join(s.dirs.default, "projects", "-x", `${fresh.sessionId}.jsonl`), { recursive: true });
  mkdirSync(join(s.dirs.default, "projects", "-y", "deeper"), { recursive: true });
  writeFileSync(join(s.dirs.default, "projects", "-y", "deeper", `${fresh.sessionId}.jsonl`), "{}\n");
  assert.equal(s.json(["terminal", "t1"]).resumable, false);
});

test("terminal: a session in a folder no account has reads account null", () => {
  const s = sandbox();
  const t = s.term("t1", { on: s.stray });
  assert.deepEqual(s.json(["terminal", "t1"]), { account: null, sessionId: t.sessionId, status: "idle", resumable: true });
});

test("terminal: missing or not Claude exits 3, no session file yet exits 2, a bad call exits 64", () => {
  const s = sandbox();
  s.shell("t2");
  s.term("t3", { session: false });
  const missing = s.cli(["terminal", "t404", "--json"]);
  assert.equal(missing.status, 3, missing.stderr);
  assert.match(missing.stderr, /terminal t404 is missing/);
  assert.equal(missing.stdout, "");
  const shell = s.cli(["terminal", "t2", "--json"]);
  assert.equal(shell.status, 3, shell.stderr);
  assert.match(shell.stderr, /isn't running Claude/);
  const starting = s.cli(["terminal", "t3", "--json"]);
  assert.equal(starting.status, 2, starting.stderr);
  assert.match(starting.stderr, /no session file yet/);
  assert.equal(s.cli(["terminal"]).status, 64);
  assert.equal(s.cli(["terminal", "t1", "t2"]).status, 64);
});

// ── The switch (afterUse, D8) ──────────────────────────────────────────────

test("use, Ask: onAccount, elsewhere and every cantMove reason go to pending-switch.json; the target's terminals stay out; nothing restarts", () => {
  const s = sandbox({ active: A, switchMode: "ask" });
  const shared = randomUUID();
  const terms = {
    t1: s.term("t1", { on: A }),
    t2: s.term("t2", { on: "default" }),
    t3: s.term("t3", { on: A, own: true }),
    t4: s.term("t4", { on: A, sessionId: shared }),
    t5: s.term("t5", { on: A, sessionId: shared }),
    t6: s.term("t6", { session: false }),
    t7: s.term("t7", { on: s.stray }),
    t8: s.term("t8", { on: A, getFails: true }),
    t9: s.term("t9", { on: B }),
    t11: s.term("t11", { on: A, transcript: false }),
  };
  s.shell("t10");

  const out = s.json(["use", B]);
  assert.deepEqual(out, { from: A, to: B, switchMode: "ask" });
  assert.equal(s.active(), s.dirs[B], "use wrote the exact string");

  const pending = s.pending();
  assert.equal(pending.from, A);
  assert.equal(pending.to, B);
  assert.equal(pending.mode, "ask");
  assert.ok(Number.isInteger(pending.at));
  const byTerminal = Object.fromEntries(pending.sessions.map((x) => [x.terminal, x]));
  for (const x of pending.sessions) assert.deepEqual(Object.keys(x), ["terminal", "title", "account", "group", "reason"]);
  const groups = Object.fromEntries(pending.sessions.map((x) => [x.terminal, [x.group, x.reason, x.account]]));
  assert.deepEqual(groups, {
    t1: ["onAccount", null, A],
    t2: ["elsewhere", null, "default"],
    t3: ["cantMove", "own-program", A],
    t4: ["cantMove", "shared-session", A],
    t5: ["cantMove", "shared-session", A],
    t6: ["cantMove", "no-session", null],
    t7: ["cantMove", "unknown-account", null],
    t8: ["cantMove", "unreadable", null],
    t11: ["cantMove", "no-session", A],
  });
  assert.equal(byTerminal.t1.title, "claude · t1");
  assert.deepEqual(s.queue(), [], "Ask queues nothing");
  assert.deepEqual(s.typed(), []);
  for (const t of Object.values(terms)) assert.ok(alive(t.pid), "no Claude was stopped");
});

test("use, Always restart: each onAccount terminal restarts on the new account; the notice says mode restart", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  const t1 = s.term("t1", { on: A, argv: ["/Users/tester/.local/bin/claude", "--model", "opus", "build the thing"] });
  const t2 = s.term("t2", { on: "default" });

  const r = s.cli(["use", B, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { from: A, to: B, switchMode: "restart" });
  const pending = s.pending();
  assert.equal(pending.mode, "restart");
  assert.deepEqual(pending.sessions.map((x) => [x.terminal, x.group]).sort(), [["t1", "onAccount"], ["t2", "elsewhere"]]);

  const [item] = s.queue();
  assert.equal(item.kind, "switch");
  assert.equal(item.terminal, "t1");
  assert.equal(item.from, A);
  assert.equal(item.to, B);
  assert.equal(item.sessionId, t1.sessionId);
  assert.match(item.id, /^sw-/);

  const done = await until(() => s.item((i) => i.id === item.id && i.state === "done"), WAIT, "the restart");
  assert.equal(done.code, 0);
  assert.equal(done.claimedBy, null);
  assert.ok(!alive(t1.pid), "the old Claude was stopped");
  assert.ok(alive(t2.pid), "elsewhere is left alone");
  assert.deepEqual(s.typed("t1").map((x) => [x.dir, x.args]), [[s.dirs[B], ["--model", "opus", "--resume", t1.sessionId]]]);
  assert.equal(s.json(["terminal", "t1"]).account, B);
  assert.deepEqual(s.typed("t2"), []);
});

test("use, Never restart: terminals stay, nothing is queued or asked", () => {
  const s = sandbox({ active: A, switchMode: "keep" });
  const t1 = s.term("t1", { on: A });
  assert.deepEqual(s.json(["use", B]), { from: A, to: B, switchMode: "keep" });
  assert.equal(s.pending(), null);
  assert.deepEqual(s.queue(), []);
  assert.deepEqual(s.sends(), []);
  assert.ok(alive(t1.pid));
  assert.equal(s.calls().filter((c) => c.argv[0] === "ls").length, 0, "keep with nothing queued doesn't even look");
});

test("use, Ask: --answer restart queues only the listed sessions that were ticked; --answer keep drops the question", async () => {
  const s = sandbox({ active: A, switchMode: "ask" });
  const t1 = s.term("t1", { on: A });
  const t2 = s.term("t2", { on: "default" });
  s.term("t3", { on: A, own: true });
  s.json(["use", B]);
  assert.equal(s.pending().sessions.length, 3);

  const r = s.cli(["restart", "--answer", "restart", "--terminal", "t2", "--terminal", "t3", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const { queued } = JSON.parse(r.stdout);
  assert.equal(queued.length, 1, "t3 can't move, so it was never listed");
  assert.equal(s.pending(), null, "answered");
  const item = s.queue().find((i) => i.id === queued[0]);
  assert.deepEqual([item.terminal, item.from, item.to], ["t2", "default", B]);
  await until(() => s.item((i) => i.id === item.id && i.state === "done"), WAIT, "t2's restart");
  assert.ok(alive(t1.pid), "t1 wasn't ticked");
  assert.ok(!alive(t2.pid));

  s.json(["use", A]);
  assert.ok(s.pending(), "a new question");
  assert.deepEqual(s.json(["restart", "--answer", "keep"]), { queued: [] });
  assert.equal(s.pending(), null);
  assert.deepEqual(s.queue().filter((i) => i.state !== "done"), []);
});

test("queue rules: a later switch drops a waiting restart whose terminal is now on the target, and moves the rest to the new target", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  const t2 = s.term("t2", { on: A, status: "busy", state: "working" });
  s.json(["use", B]);
  await until(() => s.queue().length === 2 && s.queue().every((i) => i.state === "waitingIdle"), WAIT, "both waiting");

  // The switch goes back to A, where both terminals still run: both waiting
  // restarts are dropped.
  const back = s.cli(["use", A, "--json"]);
  assert.equal(back.status, 0, back.stderr);
  assert.deepEqual(s.queue(), []);
  assert.equal(s.pending(), null, "nothing on B to move");
  assert.ok(alive(t1.pid) && alive(t2.pid));

  // A third terminal waiting on A while the switch goes A → B → default.
  const t3 = s.term("t3", { on: A, status: "busy", state: "working" });
  s.json(["use", B]);
  const waiting = await until(() => s.item((i) => i.terminal === "t3" && i.state === "waitingIdle"), WAIT, "t3 waiting");
  s.json(["use", "default"]);
  assert.equal(s.item((i) => i.id === waiting.id).to, "default", "it follows the account selected now");
  t3.setSession({ status: "idle" });
  t3.set({ state: "idle" });
  await until(() => s.item((i) => i.id === waiting.id && i.state === "done"), WAIT, "t3's restart", () => ({
    queue: s.queue(),
    t3: s.worldOf("t3"),
    sends: s.sends(),
  }));
  assert.deepEqual(s.typed("t3").map((x) => x.dir), [""], "System default: CLAUDE_ACCOUNTS_DIR set empty");
  assert.equal(s.json(["terminal", "t3"]).account, "default");
  // t1 and t2 were queued again by A → B, and wait while busy.
  assert.deepEqual(s.queue().filter((i) => i.state === "waitingIdle").map((i) => [i.terminal, i.to]), [["t1", "default"], ["t2", "default"]]);
  s.json(["restart", "--cancel", "t1"]);
  s.json(["restart", "--cancel", "t2"]);
});

test("queue rules: a restart moved to another target while its runner was deciding stops only on the new target", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  s.json(["use", B]);
  const item = await until(() => s.item((i) => i.state === "waitingIdle"), WAIT, "waitingIdle");
  // Every hc get of t1 now takes 0.4 s: the runner reads the item (to B),
  // then sees t1 idle only after the item has moved to System default.
  t1.set({ getSleep: 0.4, state: "idle" });
  t1.setSession({ status: "idle" });
  const gets = () => s.calls().filter((c) => c.argv[0] === "get" && c.argv.includes("t1")).length;
  const before = gets();
  await until(() => gets() > before, WAIT, "the runner's next look at t1");
  underCliLock(s, (items) => {
    items.find((i) => i.id === item.id).to = "default";
  });
  const done = await until(
    () => s.item((i) => i.id === item.id && ["done", "landedElsewhere", "failed", "timeout"].includes(i.state)),
    WAIT,
    "the restart",
    s.queue,
  );
  assert.equal(done.state, "done", done.detail);
  assert.deepEqual(s.typed("t1").map((x) => x.dir), [""], "typed for the new target only");
});

test("queue rules: right before acting the terminal is re-read, and a restart already on its target is dropped untouched", async () => {
  const s = sandbox({ active: B });
  const t1 = s.term("t1", { on: B });
  s.writeQueue([{ ...resumeItem({ kind: "switch", id: "sw-recheck", terminal: "t1", from: A, to: B, sessionId: t1.sessionId }) }]);
  const r = s.cli(["restart", "--detach"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.queue(), [], "dropped");
  assert.ok(alive(t1.pid), "never stopped");
  assert.deepEqual(s.sends(), []);
});

// ── The runner, per terminal (D8) ──────────────────────────────────────────

test("a busy terminal is waited on with no cap, and restart --cancel <t> cancels it before Claude stops", async () => {
  const s = sandbox({ active: A, switchMode: "restart", timing: SHORT_CAPS });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  s.json(["use", B]);
  const item = await until(() => s.item((i) => i.state === "waitingIdle" && i.claimedBy), WAIT, "waitingIdle");
  // Longer than both step caps together (the one wait here that has to be a
  // span of time: nothing may happen during it): still waiting, its claim
  // kept fresh.
  await sleep(SHORT_CAPS.shell + SHORT_CAPS.claude + 500);
  const still = s.item((i) => i.id === item.id);
  assert.equal(still.state, "waitingIdle");
  assert.ok(alive(still.claimedBy.pid), "its runner lives");
  await until(() => s.item((i) => i.id === item.id).claimedBy?.at > still.claimedBy.at, WAIT, "the runner's next heartbeat");

  assert.deepEqual(s.json(["restart", "--cancel", "t1"]), { cancelled: [item.id] });
  const cancelled = s.item((i) => i.id === item.id);
  assert.deepEqual([cancelled.state, cancelled.code, cancelled.claimedBy], ["cancelled", 10, null]);
  await until(() => !alive(still.claimedBy.pid), WAIT, "the runner to exit");
  assert.ok(alive(t1.pid), "Claude was never stopped");
  assert.deepEqual(s.sends(), []);
  assert.deepEqual(s.json(["restart", "--cancel", "t1"]), { cancelled: [] }, "nothing left to cancel");
});

test("timeouts: a shell that doesn't come back, and a new Claude that never reports idle, end as timeout (4) with the line to run by hand", async () => {
  const s = sandbox({ timing: SHORT_CAPS });
  const t1 = s.term("t1", { on: A, ignoreTerm: true });
  const stuck = s.json(["resume", "--terminal", "t1", "--account", B]);
  const first = await s.final(stuck.job);
  assert.equal(first.state, "timeout");
  assert.equal(first.exit, 4);
  assert.equal(first.code, 4);
  assert.match(first.detail, /^the shell didn't come back within 2 s: CLAUDE_ACCOUNTS_DIR='.*' claude --resume /);
  assert.ok(first.detail.endsWith(`--resume ${t1.sessionId}`));
  assert.deepEqual(s.typed("t1"), [], "nothing typed over Claude");
  process.kill(t1.pid, "SIGKILL");

  const t2 = s.term("t2", { on: A, startStatus: "busy" });
  const silent = s.json(["resume", "--terminal", "t2", "--account", B]);
  const second = await s.final(silent.job);
  assert.equal(second.state, "timeout");
  assert.equal(second.exit, 4);
  assert.match(second.detail, /^the new Claude didn't report idle within 2 s: CLAUDE_ACCOUNTS_DIR=/);
  process.kill(s.worldOf("t2").claude, "SIGKILL");
  assert.equal(s.typed("t2").length, 1);
  assert.ok(!alive(t2.pid));
});

test("Claude stopped but the line couldn't be typed: failed (9) with the line to run by hand", async () => {
  const s = sandbox();
  const t1 = s.term("t1", { on: A, sendFails: true, argv: ["/x/claude", "--permission-mode=plan"] });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B]);
  const st = await s.final(job);
  assert.deepEqual([st.state, st.code, st.exit], ["failed", 9, 9]);
  assert.match(st.detail, /^couldn't type the resume line \(.*\): CLAUDE_ACCOUNTS_DIR='/);
  assert.ok(st.detail.endsWith(` claude --permission-mode=plan --resume ${t1.sessionId}`));
  assert.ok(!alive(t1.pid), "it was stopped");
});

test("landedElsewhere (6): the new Claude's session file lies in another account's folder", async () => {
  const s = sandbox();
  s.term("t1", { on: A });
  s.world("t1", { ...s.worldOf("t1"), land: s.dirs[C] });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B]);
  const st = await s.final(job);
  assert.deepEqual([st.state, st.code, st.exit], ["landedElsewhere", 6, 6]);
  assert.match(st.detail, new RegExp(`runs on ${C}`));
});

// ── resume (D9) ────────────────────────────────────────────────────────────

test("resume through exec returns its job at once even when hc send sleeps; the job resumes, sends the message, and leaves active alone", async () => {
  const s = sandbox({ active: A });
  // Each hc send takes 3 s: a resume that waited on it couldn't be back in 2.
  const t1 = s.term("t1", { on: A, sendSleep: 3 });
  const before = s.active();
  const r = await s.exec(["resume", "--terminal", "t1", "--account", B, "--message", "di hola", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 2000, `returned in ${r.ms} ms`);
  const { job } = JSON.parse(r.stdout);
  assert.match(job, /^rs-[0-9a-f]{8}$/);
  const queued = s.item((i) => i.id === job);
  assert.deepEqual([queued.kind, queued.terminal, queued.from, queued.to, queued.message, queued.sessionId], ["resume", "t1", A, B, "di hola", t1.sessionId]);

  // --wait answers 75 while the job runs (25 s at most per call): ask again
  // until it ends, as Spotlight does.
  let w = s.cli(["resume", "--status", job, "--wait", "25", "--json"]);
  for (let round = 1; w.status === 75 && round < 3; round += 1) w = s.cli(["resume", "--status", job, "--wait", "25", "--json"]);
  assert.equal(w.status, 0, w.stderr);
  const st = JSON.parse(w.stdout);
  assert.deepEqual(Object.keys(st), ["job", "terminal", "account", "state", "code", "detail", "updatedAt"]);
  assert.deepEqual([st.job, st.terminal, st.account, st.state, st.code, st.detail], [job, "t1", B, "done", 0, null]);
  assert.deepEqual(s.sends("t1").map((x) => x.text.startsWith("CLAUDE_ACCOUNTS_DIR=") ? "line" : x.text), ["line", "di hola"]);
  assert.equal(s.json(["terminal", "t1"]).account, B);
  assert.equal(s.active(), before, "resume never writes active");
});

test("the typed line: CLAUDE_ACCOUNTS_DIR and every kept arg survive a real shell exactly; injections and the first prompt are gone", async () => {
  const s = sandbox();
  const argv = [
    "/Users/tester/.local/bin/claude",
    '--mcp-config={"mcpServers":{"x":{"type":"http"}}}',
    "--add-dir=/Users/tester/support scripts",
    "--dangerously-skip-permissions",
    "--add-dir",
    "/a b/it's here",
    "--settings",
    '{"k":"it\'s $HOME *"}',
    "--permission-mode=plan",
    "--resume",
    "old-session",
    "fix the bug please",
  ];
  const t1 = s.term("t1", { on: A, argv });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B]);
  assert.equal((await s.final(job)).state, "done");
  const [typed] = s.typed("t1");
  assert.equal(typed.shell, 0);
  assert.equal(typed.dir, s.dirs[B], "the exact folder: quote, double quote, $ and spaces");
  assert.deepEqual(typed.args, [
    "--dangerously-skip-permissions",
    "--add-dir",
    "/a b/it's here",
    "--settings",
    '{"k":"it\'s $HOME *"}',
    "--permission-mode=plan",
    "--resume",
    t1.sessionId,
  ]);

  const t2 = s.term("t2", { on: A });
  const toDefault = s.json(["resume", "--terminal", "t2", "--account", "default"]);
  assert.equal((await s.final(toDefault.job)).state, "done");
  const [line] = s.sends("t2");
  assert.equal(line.text, `CLAUDE_ACCOUNTS_DIR='' claude --resume ${t2.sessionId}`);
});

test("--status and --wait for each final state (0, 4, 6, 9, 10), and while running (0 and 75)", () => {
  const s = sandbox();
  const now = Date.now();
  const finals = { done: 0, timeout: 4, landedElsewhere: 6, failed: 9, cancelled: 10 };
  const items = Object.entries(finals).map(([state, code]) =>
    resumeItem({ id: `rs-${state.slice(0, 8)}`, state, code, detail: state === "failed" ? "why: claude --resume x" : null, updatedAt: now - 1000 }),
  );
  // A running job whose runner lives (this test process) and beat just now.
  items.push(resumeItem({ id: "rs-running", terminal: "t2", state: "waitingIdle", claimedBy: { pid: process.pid, at: Date.now() + 60000 } }));
  s.writeQueue(items);
  for (const [state, code] of Object.entries(finals)) {
    const id = `rs-${state.slice(0, 8)}`;
    const st = s.cli(["resume", "--status", id, "--json"]);
    assert.equal(st.status, code, `${state}: ${st.stderr}`);
    const out = JSON.parse(st.stdout);
    assert.deepEqual([out.job, out.state, out.code], [id, state, code]);
    const w = s.cli(["resume", "--status", id, "--wait", "3", "--json"]);
    assert.equal(w.status, code, `${state} under --wait`);
    assert.deepEqual(JSON.parse(w.stdout), out);
  }
  const running = s.cli(["resume", "--status", "rs-running", "--json"]);
  assert.equal(running.status, 0, running.stderr);
  assert.deepEqual(JSON.parse(running.stdout).state, "waitingIdle");
  assert.equal(JSON.parse(running.stdout).code, null);
  const started = Date.now();
  const w = s.cli(["resume", "--status", "rs-running", "--wait", "0.4", "--json"]);
  assert.equal(w.status, 75, w.stderr);
  assert.ok(Date.now() - started >= 400);
  assert.equal(JSON.parse(w.stdout).state, "waitingIdle");
});

test("resume: a repeat returns the live job; --cancel ends it as cancelled; a terminal already on the target only gets the message; unknown jobs exit 7", async () => {
  const s = sandbox({ active: A });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  const first = s.json(["resume", "--terminal", "t1", "--account", B, "--message", "one"]);
  await until(() => s.item((i) => i.id === first.job && i.state === "waitingIdle"), WAIT, "waitingIdle");
  const again = s.json(["resume", "--terminal", "t1", "--account", B, "--message", "two"]);
  assert.equal(again.job, first.job);
  assert.equal(s.queue().filter((i) => i.terminal === "t1").length, 1, "never a second job");
  const w = s.cli(["resume", "--terminal", "t1", "--account", B, "--wait", "0.2", "--json"]);
  assert.equal(w.status, 75, "the repeat waits on the live job");
  assert.equal(JSON.parse(w.stdout).job, first.job);

  const c = s.cli(["resume", "--cancel", first.job, "--json"]);
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual([JSON.parse(c.stdout).state, JSON.parse(c.stdout).code], ["cancelled", 10]);
  assert.equal(s.status(first.job).exit, 10);
  assert.equal(s.cli(["resume", "--cancel", first.job]).status, 0, "cancelling twice is fine");
  assert.ok(alive(t1.pid));
  assert.deepEqual(s.sends("t1"), []);

  const t2 = s.term("t2", { on: B });
  const { job } = s.json(["resume", "--terminal", "t2", "--account", B, "--message", "carry on"]);
  const st = await s.final(job);
  assert.equal(st.state, "done");
  assert.deepEqual(s.sends("t2").map((x) => x.text), ["carry on"], "no restart, only the message");
  assert.ok(alive(t2.pid), "never stopped");

  for (const args of [["--status", "rs-nope"], ["--cancel", "rs-nope"], ["--status", "rs-nope", "--wait", "1"]]) {
    const r = s.cli(["resume", ...args]);
    assert.equal(r.status, 7, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /unknown job "rs-nope"/);
  }
});

test("job lifetime: a job whose runner is dead or stale reads failed 'runner gone' with the line; a final job answers 24 h, then 7", () => {
  const s = sandbox();
  const sid = randomUUID();
  const now = Date.now();
  s.writeQueue([
    resumeItem({ id: "rs-dead", sessionId: sid, args: ["--model", "opus"], state: "waitingIdle", claimedBy: { pid: 2_999_999, at: now } }),
    resumeItem({ id: "rs-stale", state: "waitingIdle", claimedBy: { pid: process.pid, at: now - TIMING.stale - 10_000 } }),
    resumeItem({ id: "rs-orphan", state: "queued", claimedBy: null, updatedAt: now - TIMING.stale - 10_000 }),
    resumeItem({ id: "rs-23h", state: "done", code: 0, updatedAt: now - 23 * 3600_000 }),
    resumeItem({ id: "rs-25h", state: "done", code: 0, updatedAt: now - 25 * 3600_000 }),
  ]);
  const dead = s.status("rs-dead");
  assert.deepEqual([dead.exit, dead.state, dead.code], [9, "failed", 9]);
  const quoted = `'${s.dirs[B].replaceAll("'", "'\\''")}'`;
  assert.equal(dead.detail, `runner gone: CLAUDE_ACCOUNTS_DIR=${quoted} claude --model opus --resume ${sid}`);
  for (const id of ["rs-stale", "rs-orphan"]) {
    const st = s.status(id);
    assert.deepEqual([st.exit, st.state], [9, "failed"], id);
    assert.match(st.detail, /^runner gone: /);
  }
  assert.equal(s.item((i) => i.id === "rs-dead").state, "failed", "written, so it stays failed");
  assert.equal(s.status("rs-23h").exit, 0);
  assert.equal(s.status("rs-25h").exit, 7);
  assert.equal(s.item((i) => i.id === "rs-25h"), undefined, "pruned");
});

test("a runner killed mid-wait: its job reads failed 'runner gone', Claude was never stopped, and the next resume on that terminal is a new job", async () => {
  const s = sandbox();
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B]);
  const waiting = await until(() => s.item((i) => i.id === job && i.state === "waitingIdle" && i.claimedBy), WAIT, "waitingIdle");
  process.kill(waiting.claimedBy.pid, "SIGKILL");
  await until(() => !alive(waiting.claimedBy.pid), WAIT, "the runner to die");
  const st = s.status(job);
  assert.deepEqual([st.exit, st.state], [9, "failed"]);
  assert.match(st.detail, new RegExp(`^runner gone: CLAUDE_ACCOUNTS_DIR=.* claude --resume ${t1.sessionId}$`));
  assert.ok(alive(t1.pid));

  t1.setSession({ status: "idle" });
  t1.set({ state: "idle" });
  const next = s.json(["resume", "--terminal", "t1", "--account", B]);
  assert.notEqual(next.job, job);
  assert.equal((await s.final(next.job)).state, "done");
});

test("terminals restart independently: a resume on t2 is done while a switch on busy t1 still waits", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  s.term("t2", { on: "default" });
  s.json(["use", B]);
  const sw = await until(() => s.item((i) => i.kind === "switch" && i.state === "waitingIdle"), WAIT, "the switch waiting");
  const { job } = s.json(["resume", "--terminal", "t2", "--account", A]);
  const st = await s.final(job);
  assert.equal(st.state, "done");
  assert.equal(s.item((i) => i.id === sw.id).state, "waitingIdle");
  assert.ok(alive(t1.pid));
  s.json(["restart", "--cancel", "t1"]);
});

test("two runners at once restart each terminal exactly once", async () => {
  const s = sandbox();
  const terms = ["t1", "t2", "t3", "t4"].map((t) => [t, s.term(t, { on: A })]);
  s.writeQueue(terms.map(([t, x]) => resumeItem({ id: `sw-${t}`, kind: "switch", terminal: t, sessionId: x.sessionId })));
  const runs = await Promise.all([s.exec(["restart", "--detach"]), s.exec(["restart", "--detach"])]);
  for (const r of runs) assert.equal(r.status, 0, r.stderr);
  const items = await until(() => {
    const q = s.queue();
    return q.length === 4 && q.every((i) => i.state === "done") && q;
  }, WAIT, "all four done");
  assert.equal(items.length, 4);
  for (const [t] of terms) assert.equal(s.typed(t).length, 1, `${t} typed once`);
});

// ── Exit codes and hc's environment ────────────────────────────────────────

test("resume and restart validate at once: 64, 7, 5, 3, 8, 2 (no session file, or nothing to resume) and 1 when hc can't read the terminal", () => {
  const s = sandbox();
  s.term("t1", { on: A });
  s.term("t3", { on: A, own: true });
  s.term("t4", { session: false });
  s.term("t5", { on: A, getFails: true });
  s.term("t6", { on: A, transcript: false });
  s.shell("t2");
  const cases = [
    [["resume"], 64],
    [["resume", "--terminal", "t1"], 64],
    [["resume", "--account", B], 64],
    [["resume", "--terminal", "t1", "--account", B, "--status", "rs-x"], 64],
    [["resume", "--terminal", "t1", "--account", B, "--wait", "soon"], 64],
    [["resume", "--cancel", "rs-x", "--wait", "1"], 64],
    [["resume", "--status", "rs-x", "--account", B], 64],
    [["resume", "--terminal", "t1", "--account", B, "--bogus"], 64],
    [["restart"], 64],
    [["restart", "--detach", "--cancel", "t1"], 64],
    [["restart", "--answer", "maybe"], 64],
    [["restart", "--cancel", "t1", "--terminal", "t1"], 64],
    [["resume", "--terminal", "t1", "--account", "no-such-account"], 7],
    [["resume", "--terminal", "t1", "--account", C], 5],
    [["resume", "--terminal", "t404", "--account", B], 3],
    [["resume", "--terminal", "t2", "--account", B], 3],
    [["resume", "--terminal", "t3", "--account", B], 8],
    [["resume", "--terminal", "t4", "--account", B], 2],
    [["resume", "--terminal", "t6", "--account", B], 2],
    [["resume", "--terminal", "t5", "--account", B], 1],
  ];
  for (const [args, code] of cases) {
    const r = s.cli(args);
    assert.equal(r.status, code, `${args.join(" ")} → ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout, "", `${args.join(" ")} prints nothing on stdout`);
    assert.notEqual(r.stderr.trim(), "", `${args.join(" ")} says why on stderr`);
  }
  assert.deepEqual(s.queue(), [], "no job was queued");
  const nothing = s.cli(["resume", "--terminal", "t6", "--account", B]);
  assert.match(nothing.stderr, /there's no conversation to resume yet in terminal t6/);
});

test("resume: a Claude with nothing to resume, already on the account, still gets the message", async () => {
  const s = sandbox();
  const t1 = s.term("t1", { on: B, transcript: false });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B, "--message", "hola"]);
  assert.equal((await s.final(job)).state, "done");
  assert.deepEqual(s.sends("t1").map((x) => x.text), ["hola"]);
  assert.ok(alive(t1.pid));
});

test("the runner re-checks before stopping: a session with no transcript any more (/clear) fails (9), and Claude is never stopped", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  const t1 = s.term("t1", { on: A, status: "busy", state: "working" });
  const t2 = s.term("t2", { on: A, status: "busy", state: "working" });
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B]);
  s.json(["use", B]);
  const sw = await until(() => s.item((i) => i.kind === "switch" && i.state === "waitingIdle"), WAIT, "the switch waiting");
  await until(() => s.item((i) => i.id === job && i.state === "waitingIdle"), WAIT, "the job waiting");
  const cleared1 = randomUUID();
  const cleared2 = randomUUID();
  t1.setSession({ sessionId: cleared1, status: "idle" });
  t1.set({ state: "idle" });
  t2.setSession({ sessionId: cleared2, status: "idle" });
  t2.set({ state: "idle" });
  const st = await s.final(job);
  assert.deepEqual([st.state, st.code, st.exit], ["failed", 9, 9]);
  assert.equal(st.detail, `there's no conversation to resume yet in terminal t1: Claude hasn't saved session ${cleared1} (it has no messages)`);
  const switched = await until(() => s.item((i) => i.id === sw.id && i.state === "failed"), WAIT, "the switch to fail", s.queue);
  assert.equal(switched.code, 9);
  assert.match(switched.detail, new RegExp(`hasn't saved session ${cleared2}`));
  assert.ok(alive(t1.pid) && alive(t2.pid), "neither Claude was stopped");
  assert.deepEqual(s.sends(), []);
});

test("fail fast: Claude refusing the resume line ends the item failed (9) as soon as the shell is back, with Claude's error from the screen", async () => {
  const s = sandbox({ active: A, switchMode: "restart" });
  // B's projects/ isn't shared here: Claude on B can't find the conversation.
  rmSync(join(s.dirs[B], "projects"));
  mkdirSync(join(s.dirs[B], "projects"));
  const t1 = s.term("t1", { on: A });
  const started = Date.now();
  const { job } = s.json(["resume", "--terminal", "t1", "--account", B, "--message", "di hola"]);
  const st = await s.final(job);
  assert.deepEqual([st.state, st.code, st.exit], ["failed", 9, 9]);
  const quoted = `'${s.dirs[B].replaceAll("'", "'\\''")}'`;
  assert.equal(
    st.detail,
    `No conversation found with session ID: ${t1.sessionId}: CLAUDE_ACCOUNTS_DIR=${quoted} claude --resume ${t1.sessionId}`,
  );
  // The new Claude's cap is 30 s here: a job that waited it out would end
  // timeout (4), not failed, and only after it.
  assert.ok(Date.now() - started < TIMING.claude, "it didn't wait out the new Claude's cap");
  assert.deepEqual(s.sends("t1").map((x) => x.text.startsWith("CLAUDE_ACCOUNTS_DIR=") ? "line" : x.text), ["line"], "no message to a shell");

  // The same for a switch restart.
  const t2 = s.term("t2", { on: A });
  s.json(["use", B]);
  const sw = await until(() => s.item((i) => i.terminal === "t2" && i.state === "failed"), WAIT, "the restart to fail", s.queue);
  assert.equal(sw.code, 9);
  assert.ok(sw.detail.startsWith(`No conversation found with session ID: ${t2.sessionId}: CLAUDE_ACCOUNTS_DIR=`), sw.detail);

  // Nothing printed and no Claude at all: the fallback reason.
  s.term("t3", { on: A, noStart: true });
  const quiet = s.json(["resume", "--terminal", "t3", "--account", "default"]);
  const q = await s.final(quiet.job);
  assert.equal(q.state, "failed");
  assert.match(q.detail, /^no new Claude came up after the resume line: CLAUDE_ACCOUNTS_DIR='' claude --resume /);
});

// ── The allowlist and the quoting, as functions ────────────────────────────

test("screenReason: the line Claude left under the echoed resume line, without the new prompt", async () => {
  const { screenReason } = await import(RESTART_MJS);
  const line = "CLAUDE_ACCOUNTS_DIR=/x claude --resume abc";
  const error = "No conversation found with session ID: abc";
  // starship: an info line, then ❯
  assert.equal(screenReason(["old", "", "ws on  main", `❯ ${line}`, error, "", "ws on  main", "❯"].join("\n"), line), error);
  // a one-line zsh prompt
  assert.equal(screenReason(["me@mac ws % ls", "a b", `me@mac ws % ${line}`, error, "me@mac ws %"].join("\n"), line), error);
  // the echoed line wrapped over two screen lines
  assert.equal(screenReason(["", "ws on  main", "❯ CLAUDE_ACCOUNTS_DIR=/x clau", "de --resume abc", error, "", "ws on  main", "❯"].join("\n"), line), error);
  // printed nothing
  assert.equal(screenReason(["", "ws on  main", `❯ ${line}`, "", "ws on  main", "❯"].join("\n"), line), null);
  // no echoed line: the last non-empty line; nothing at all: null
  assert.equal(screenReason("x\nlast line\n\n", line), "last line");
  assert.equal(screenReason("", line), null);
});

test("keptArgs: D8's allowlist", async () => {
  const { keptArgs } = await import(RESTART_MJS);
  const cases = [
    [["claude", "fix the bug"], []],
    [["claude", '--mcp-config={"m":1}', "--add-dir=/support", "--model", "opus"], ["--model", "opus"]],
    [["claude", '--mcp-config={"m":1}', "--dangerously-skip-permissions"], ["--dangerously-skip-permissions"]],
    [["claude", "--add-dir", "/a b/c", "do it"], ["--add-dir", "/a b/c"]],
    [["claude", "--settings", '{"x":"a b"}'], ["--settings", '{"x":"a b"}']],
    [["claude", "--permission-mode=plan", "--effort=high", "--model=opus"], ["--permission-mode=plan", "--effort=high", "--model=opus"]],
    [["claude", "--resume", "abc", "-c", "--append-system-prompt", "be nice", "--verbose", "-p"], []],
    [["node", "/x/bin/claude", "--model", "sonnet", "hello"], ["--model", "sonnet"]],
    [["claude", "--model", "opus", "--add-dir=/mine"], ["--model", "opus", "--add-dir=/mine"]],
    [["claude", "--model"], []],
    [["claude", "--", "--model", "opus"], []],
  ];
  for (const [argv, kept] of cases) assert.deepEqual(keptArgs(argv), kept, JSON.stringify(argv));
});

test("shellQuote and resumeLine: bare when safe, single-quoted otherwise", async () => {
  const { shellQuote, resumeLine } = await import(RESTART_MJS);
  assert.equal(shellQuote("--permission-mode=plan"), "--permission-mode=plan");
  assert.equal(shellQuote("/a/b.c"), "/a/b.c");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("~/x"), "'~/x'");
  assert.equal(shellQuote("=x"), "'=x'");
  assert.equal(shellQuote("*"), "'*'");
  assert.equal(resumeLine("", [], "abc"), "CLAUDE_ACCOUNTS_DIR='' claude --resume abc");
  assert.equal(resumeLine("/p q/home", ["--model", "opus"], "abc"), "CLAUDE_ACCOUNTS_DIR='/p q/home' claude --model opus --resume abc");
});

// ── Last: what every test left behind ──────────────────────────────────────

test("every hc call ran without HC_TERMINAL_ID, and no runner or fake Claude outlives the tests", async () => {
  const calls = sandboxes.flatMap((s) => s.calls());
  assert.ok(calls.length > 0);
  const kinds = new Set(calls.map((c) => c.argv[0]));
  for (const kind of ["ls", "get", "send"]) assert.ok(kinds.has(kind), `hc ${kind} was called`);
  assert.deepEqual(calls.filter((c) => c.hcTerminalId !== null), [], "HC_TERMINAL_ID never reaches hc");

  await until(() => runnerPids().length === 0, WAIT, "every runner to exit", runnerPids);
  killAll();
  await until(() => [...fakePids, ...shimPids()].every((pid) => !alive(pid)), WAIT, "every fake Claude to be gone");
});
