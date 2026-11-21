// awake-agent T2 (S1, D5): `wake-agent`, the CLI a Claude runs to list what
// agent-sleep put to sleep, wake one worktree by its path (`herdr-app do
// agent-sleep.wake.<hex>`, D1) and know when its Claudes are up. The logic
// (mods/agent-sleep/wake-cli.js) runs here against a fake world: its files,
// `hc`, `herdr-app`, `ps`, `find` and a clock that moves only when the CLI
// sleeps. Last, bin/wake-agent itself runs with fake `hc` and `herdr-app`
// first on PATH: nothing here reaches Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, USAGE, WAKE_TIMEOUT_MS, POLL_MS, claudeUp, asleepLines, wakeLogLines } from "../mods/agent-sleep/wake-cli.js";
import { MOD } from "../mods/agent-sleep/constants.js";
import { wakeCommand } from "../mods/agent-sleep/workspace-sleep.js";
import { logLine, parseLogLine, notWokenHead } from "../mods/agent-sleep/log.js";
import { parseRecords, serializeRecords } from "../mods/agent-sleep/store.js";
import { parseWorkspaces, serializeWorkspaces } from "../mods/agent-sleep/workspaces-store.js";
import { procStartCommand, sessionFilePath } from "../mods/agent-sleep/claude-session.js";
import { HOME, APP, SLEEPING, WORKSPACES, LOG, SID1, NATIVE, NATIVE_CLAUDE, sessionPath } from "./harness.js";

const LOG_1 = `${APP}/agent-sleep/log.1.txt`;
// Local time, as log.txt's stamps are.
const NOW = new Date(2026, 10, 20, 17, 0, 0).getTime();
const PROC_START = "Fri Nov 20 21:00:00 2026";
// `hc get t8h --json`, 2026-11-16 (test/claude-session.test.js:77, NATIVE_FG):
// the native installer's Claude, named by the OS after its version. Only
// programName(foreground) reads it as Claude; its raw name never does.
const NATIVE_FG = { argv: [NATIVE_CLAUDE, "--resume", SID1], cwd: "/code/app", name: NATIVE.name, pid: 2018 };
const BLOCKED = { app: "claude-code", state: "blocked" };

const wakeOf = (path) => `${MOD}.${wakeCommand(path)}`;
const sessionFile = (pid, cwd = "/code/app") =>
  JSON.stringify({ pid, sessionId: SID1, cwd, procStart: PROC_START, kind: "interactive", status: "idle" });

// A record as the mod writes it (store.js validRecord).
const record = (over = {}) => ({
  state: "asleep", sessionId: SID1, cwd: "/code/app", flags: [], at: NOW - 60_000, by: "auto", workspacePath: "/code/app", configDir: null, ...over,
});
const entry = (over = {}) => ({ spaces: { sa: ["a1"] }, state: "asleep", at: NOW - 60_000, ...over });

// ── The fake world ──────────────────────────────────────────────────────────

// `hcDown`: every `hc` fails to start, as with no Herdr server. `cwd`: the
// shell's folder the CLI runs in.
function world({ records = null, entries = null, spaces = [], hcDown = false, cwd = "/code" } = {}) {
  const w = {
    now: NOW, files: new Map(), terminals: new Map(), spaces, calls: [], sent: [], out: [], err: [], sleeps: 0,
    doReply: () => ({ code: 0, stdout: "", stderr: "" }), onSleep: null, procStarts: new Map(), hcDown, cwd,
  };
  if (records) setRecords(w, records);
  if (entries) setEntries(w, entries);
  return w;
}
// The mod's files, written and read as the mod does (store.js, workspaces-store.js).
const setRecords = (w, records) => w.files.set(SLEEPING, serializeRecords(records));
const setEntries = (w, entries) => w.files.set(WORKSPACES, serializeWorkspaces(entries));
const recordsOf = (w) => parseRecords(w.files.get(SLEEPING)).records;
const entriesOf = (w) => parseWorkspaces(w.files.get(WORKSPACES)).entries;

// A live terminal with its shell in front (its own pid), or with a Claude
// (`claude`: the native installer's, with its session file unless `session:
// false`). `status`: Herdr's, or none (a Claude that missed its startup check).
function shell(w, address, { cwd = "/code/app", pid = 100 } = {}) {
  w.terminals.set(address, { address, state: "live", cwd, pid, foreground: { argv: ["/bin/zsh", "-l"], cwd, name: "zsh", pid }, status: null });
}
function claude(w, address, { cwd = "/code/app", pid = 100, fgPid = 2018, status = null, session = true } = {}) {
  w.terminals.set(address, { address, state: "live", cwd, pid, foreground: { ...NATIVE_FG, cwd, pid: fgPid }, status });
  w.procStarts.set(fgPid, PROC_START);
  if (session) w.files.set(sessionPath(fgPid), sessionFile(fgPid, cwd));
}

// t1's Claude asleep at /code/app, its shell back in its tab.
function oneAsleep() {
  const w = world({ records: { t1: record() } });
  shell(w, "t1");
  return w;
}

const json = (v, code = 0) => ({ code, stdout: `${JSON.stringify(v)}\n`, stderr: "" });

async function exec(w, file, args) {
  w.calls.push([file, ...args]);
  if (file === "hc" && w.hcDown) throw new Error("hc: no server");
  if (file === "hc" && args[0] === "ls") {
    // `hc ls --json` has no foreground (plan review v2, Suggestion 3), and its status is a word.
    const terminals = [...w.terminals.values()].map(({ address, state, cwd, status }) => ({ address, state, cwd, status: status?.state, agent: "claude-code" }));
    return json({ hidden_finished: [], terminals });
  }
  if (file === "hc" && args[0] === "get") {
    const t = w.terminals.get(args[1]);
    return t ? json(t) : json({ error: { hint: "see `hc ls --all`", kind: "not_found", message: `no terminal "${args[1]}"` } }, 3);
  }
  if (file === "herdr-app" && args[0] === "ls") return json({ spaces: w.spaces, recent: [] });
  if (file === "herdr-app" && args[0] === "do") {
    w.sent.push(args.slice(1).join(" "));
    return w.doReply(w);
  }
  const pid = Number(args.at(-1));
  if ([file, ...args].join(" ") === procStartCommand(pid)?.join(" ")) {
    const started = w.procStarts.get(pid);
    return started ? { code: 0, stdout: `${started}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
  }
  if (file === "find") return { code: 1, stdout: "", stderr: "find: no such folder" };
  throw new Error(`not faked: ${file} ${args.join(" ")}`);
}

const deps = (w) => ({
  exec: (file, args) => exec(w, file, args),
  readText: async (path) => (w.files.has(path) ? w.files.get(path) : null),
  resolve, // bin/wake-agent.mjs's, node's path.resolve
  now: () => w.now,
  sleep: async (ms) => {
    w.now += ms;
    w.sleeps += 1;
    w.onSleep?.(w);
  },
  home: HOME,
  appHome: APP,
  cwd: w.cwd,
  out: (text) => w.out.push(text),
  err: (text) => w.err.push(text),
});

const run = async (w, ...argv) => ({ code: await main(argv, deps(w)), out: w.out.join("\n"), err: w.err.join("\n") });
const hcGets = (w) => w.calls.filter(([f, a]) => f === "hc" && a === "get").length;

// What the mod's pulse does to a wake (T1), in the files: the record claimed
// before typing, then Claude in front of the terminal with its session file.
function resumed(w, address, over = {}) {
  const { [address]: _gone, ...rest } = recordsOf(w);
  setRecords(w, rest);
  claude(w, address, { cwd: w.terminals.get(address)?.cwd, ...over });
}

test("--help prints the usage, exit 0; a second argument or an unknown flag is a usage error, exit 2, and nothing is read", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const w = world();
    const r = await run(w, flag);
    assert.equal(r.code, 0, flag);
    assert.equal(r.out, USAGE);
  }
  assert.match(USAGE, /^wake-agent: /);
  for (const argv of [["/code/a", "/code/b"], ["--force"], [""]]) {
    const w = world({ records: { t1: record() } });
    const r = await run(w, ...argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /USAGE|wake-agent <path>/);
    assert.deepEqual(w.sent, []);
  }
});

// ── wake-agent: what sleeps ─────────────────────────────────────────────────

test("wake-agent with nothing asleep says so, exit 0, without asking Herdr anything", async () => {
  const w = world();
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.equal(r.out, "wake-agent: nothing asleep.");
  assert.deepEqual(w.calls, []);
});

test("wake-agent lists each asleep worktree once: its path, its terminals, idle or workspace (going to sleep too); not a closed tab, a live or a stopping record", async () => {
  const w = world({
    records: {
      t1: record(),
      t2: record({ cwd: "/code/shop", workspacePath: "/code/shop", by: "manual" }),
      // Its Claude runs in /code/checkout, in a tab of /code/shop's space: it sleeps and wakes with /code/shop.
      t3: record({ cwd: "/code/checkout", workspacePath: "/code/checkout", by: "manual" }),
      t4: record({ cwd: "/code/old", workspacePath: "/code/old" }),
      t5: record({ state: "live", cwd: "/code/api", workspacePath: "/code/api" }),
      t6: record({ state: "stopping", cwd: "/code/api", workspacePath: "/code/api" }),
      t7: record({ cwd: "/code/app/web", workspacePath: "/code/app" }),
    },
    entries: {
      "/code/shop": entry({ spaces: { sa: ["a1"] } }),
      "/code/blog": entry({ spaces: { sb: ["b1"] }, state: "sleeping" }),
    },
    spaces: [
      { id: "sa", tabs: [{ id: "a1", settled: true, terminals: [{ terminal: "t2" }] }, { id: "a2", settled: true, terminals: [{ terminal: "t3" }] }] },
      { id: "sb", tabs: [{ id: "b1", settled: false, terminals: [{ terminal: "t8" }] }] },
    ],
  });
  for (const a of ["t1", "t2", "t3", "t6", "t7", "t8"]) shell(w, a);
  claude(w, "t5"); // t4's tab was closed: no terminal
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.out, [
    "/code/app  t1, t7  idle",
    "/code/blog  -  workspace (going to sleep)",
    "/code/shop  t2, t3  workspace",
  ]);
  assert.deepEqual(w.sent, [], "a list wakes nothing");
});

test("wake-agent only has closed tabs asleep: nothing asleep; without hc's list it lists every record, and says why", async () => {
  const w = world({ records: { t4: record() } });
  assert.equal((await run(w)).out, "wake-agent: nothing asleep.");
  const blind = world({ records: { t4: record() }, hcDown: true });
  const r = await run(blind);
  assert.equal(r.code, 0);
  assert.deepEqual(blind.out, ["/code/app  t4  idle"]);
  assert.match(r.err, /hc ls --json/);
});

// ── wake-agent <path>: the argument ─────────────────────────────────────────

test("the path is made absolute against the shell's folder (path.resolve, injected), with no trailing slash, as the mod's decoder wants it", async () => {
  for (const [arg, cwd, path] of [
    ["app/", "/code", "/code/app"],
    ["/code/app//", "/elsewhere", "/code/app"],
    ["../code/./app", "/x", "/code/app"],
    [".", "/code/app", "/code/app"],
    ["/", "/code", "/"],
    ["a b/ñ", "/code", "/code/a b/ñ"],
  ]) {
    const r = await run(world({ cwd }), arg);
    assert.equal(r.out, `wake-agent: nothing asleep at ${path}. No Claude is up there either.`, `${arg} from ${cwd}`);
  }
});

test("wake-agent app/ from /code wakes /code/app: the command carries the absolute path, its slash dropped", async () => {
  const w = oneAsleep();
  w.doReply = (w) => {
    resumed(w, "t1");
    return json({});
  };
  const r = await run(w, "app/");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.sent, [wakeOf("/code/app")]);
  assert.deepEqual(w.calls.find(([f, a]) => f === "herdr-app" && a === "do"), ["herdr-app", "do", wakeOf("/code/app")]);
});

// ── Nothing asleep at the path: exit 2 ──────────────────────────────────────

test("nothing asleep at the path and no Claude up there: exit 2, says both, sends nothing", async () => {
  const w = world({ records: { t1: record({ cwd: "/code/other", workspacePath: "/code/other" }) } });
  shell(w, "t1", { cwd: "/code/other" });
  shell(w, "t2", { cwd: "/code/app" });
  claude(w, "t3", { cwd: "/code/app-two", fgPid: 2003 }); // a sibling folder, not under the path
  const r = await run(w, "/code/app/");
  assert.equal(r.code, 2);
  assert.equal(r.out, "wake-agent: nothing asleep at /code/app. No Claude is up there either.");
  assert.deepEqual(w.sent, []);
});

test("nothing asleep at the path with a Claude already up there (its folder or under it, version-named, no Herdr status): exit 2 names it", async () => {
  const w = world();
  claude(w, "t5", { cwd: "/code/app/src", fgPid: 2005 });
  claude(w, "t6", { cwd: "/code/app", fgPid: 2006, session: false }); // Claude in front, no session file: not up
  const r = await run(w, "/code/app");
  assert.equal(r.code, 2);
  assert.equal(r.out, "wake-agent: nothing asleep at /code/app. A Claude is already up there: t5.");
  assert.deepEqual(w.sent, []);
});

test("nothing asleep at the path but a record whose tab was closed: exit 2 says so, sends nothing; without hc it can't tell who is up", async () => {
  const w = world({ records: { t1: record() } });
  const r = await run(w, "/code/app");
  assert.equal(r.code, 2);
  assert.equal(r.out, "wake-agent: nothing asleep at /code/app. No Claude is up there either. t1 slept there, but its tab was closed.");
  assert.deepEqual(w.sent, []);
  const b = await run(world({ hcDown: true }), "/nowhere/");
  assert.equal(b.code, 2);
  assert.match(b.out, /^wake-agent: nothing asleep at \/nowhere\. Whether a Claude is up there can't be told: /);
});

test("a path whose only state is a sleeping workspace entry sends the wake instead of exiting 2, and waits for the mod to take it", async () => {
  const w = world({ entries: { "/code/app": entry({ state: "sleeping" }) } });
  w.onSleep = (w) => {
    // The mod's pulse (T1): wakeAfter on the sleeping entry, then step 6 drops it.
    if (w.sleeps === 2) setEntries(w, { "/code/app": entry({ state: "sleeping", wakeAfter: true }) });
  };
  const r = await run(w, "/code/app");
  assert.deepEqual(w.sent, [wakeOf("/code/app")]);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.sleeps, 2, "not done before the mod marked the entry");
  assert.match(r.out, /\/code\/app is awake/);
});

// ── Herdr refuses: exit 1 at once ───────────────────────────────────────────

test("herdr-app do printing {error} (exit 1): exit 1 at once with Herdr's error, nothing polled", async () => {
  const w = oneAsleep();
  w.doReply = () => json({ error: "no command agent-sleep.wake.2f636f64652f617070: agent-sleep isn't loaded in this layout" }, 1);
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, "wake-agent: Herdr refused the wake of /code/app: no command agent-sleep.wake.2f636f64652f617070: agent-sleep isn't loaded in this layout");
  assert.equal(w.sleeps, 0);
  assert.equal(hcGets(w), 0);
});

test("herdr-app do exiting non-zero with no JSON, or not starting at all: exit 1 at once with what it said", async () => {
  const w = oneAsleep();
  w.doReply = () => ({ code: 2, stdout: "", stderr: "herdr-app: Herdr isn't running\n" });
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, "wake-agent: Herdr refused the wake of /code/app: herdr-app: Herdr isn't running");
  assert.equal(w.sleeps, 0);

  const gone = oneAsleep();
  gone.doReply = () => {
    throw Object.assign(new Error("spawn herdr-app ENOENT"), { code: "ENOENT" });
  };
  const g = await run(gone, "/code/app");
  assert.equal(g.code, 1);
  assert.equal(g.err, "wake-agent: Herdr refused the wake of /code/app: spawn herdr-app ENOENT");
  assert.equal(gone.sleeps, 0);
});

// ── Readiness: a Claude in front with its session file ──────────────────────

const look = (t, configDirs = [null]) => {
  const w = world();
  claude(w, "tx", { fgPid: 2018 });
  return claudeUp(t, { home: HOME, configDirs, readText: deps(w).readText, exec: deps(w).exec });
};

test("readiness: the version-named Claude with its session file is up with no Herdr status at all; blocked is up, waiting for an answer", async () => {
  assert.deepEqual(await look({ address: "tx", state: "live", foreground: NATIVE_FG, status: null }), { up: true, blocked: false });
  assert.deepEqual(await look({ address: "tx", state: "live", foreground: NATIVE_FG, status: BLOCKED }), { up: true, blocked: true });
  assert.deepEqual(await look({ address: "tx", state: "live", foreground: NATIVE_FG, status: "blocked" }), { up: true, blocked: true }, "hc ls's word too");
});

test("readiness reads the session file and looks for no transcript (no `find` over projects/)", async () => {
  const w = world();
  claude(w, "tx", { fgPid: 2018 });
  const seen = await claudeUp({ address: "tx", state: "live", foreground: NATIVE_FG, status: null }, { home: HOME, configDirs: [null], readText: deps(w).readText, exec: deps(w).exec });
  assert.deepEqual(seen, { up: true, blocked: false });
  assert.deepEqual(w.calls.map(([f]) => f), ["env"], "ps only");
});

test("after the wake is sent, the first look waits one poll: the mod acts at its next pulse", async () => {
  const w = oneAsleep();
  let looked = null;
  w.onSleep = (w) => {
    looked ??= hcGets(w);
    resumed(w, "t1");
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 0, r.err);
  assert.equal(looked, 0, "no `hc get` before the first sleep");
  assert.equal(w.sleeps, 1);
  assert.equal(w.now - NOW, POLL_MS);
});

test("readiness: a shell in front, Claude with no session file, or nothing in front is down, with why", async () => {
  const shellFg = { argv: ["/bin/zsh", "-l"], cwd: "/code/app", name: "zsh", pid: 100 };
  assert.deepEqual(await look({ foreground: shellFg }), { up: false, why: "zsh in front" });
  const noFile = await look({ foreground: { ...NATIVE_FG, pid: 2099 } });
  assert.equal(noFile.up, false);
  assert.match(noFile.why, /^Claude in front, no session file \(no-session-file\)$/);
  assert.deepEqual(await look({ foreground: null }), { up: false, why: "nothing in front" });
});

test("a wake waits for each Claude: still asleep, then Claude in front without its session file, then up; a blocked one prints blocked; exit 0", async () => {
  const w = world({ records: { t1: record(), t2: record({ cwd: "/code/app/api" }) } });
  shell(w, "t1", { pid: 101 });
  shell(w, "t2", { pid: 102, cwd: "/code/app/api" });
  w.onSleep = (w) => {
    if (w.sleeps === 1) {
      resumed(w, "t1", { pid: 101, fgPid: 2001, session: false });
      resumed(w, "t2", { pid: 102, fgPid: 2002, status: BLOCKED });
    }
    if (w.sleeps === 3) w.files.set(sessionPath(2001), sessionFile(2001));
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 0, r.err);
  assert.equal(w.sleeps, 3);
  assert.equal(w.now - NOW, 3 * POLL_MS);
  assert.deepEqual(w.out, [
    "wake-agent: waking /code/app: t1, t2 (up to 90 s).",
    "wake-agent: /code/app is up.",
    "t1: up",
    "t2: up, blocked: it waits for an answer in its tab",
  ]);
});

test("a record still being stopped is down even with Claude in front: its /exit is on its way", async () => {
  const w = world({ records: { t1: record({ state: "stopping" }) } });
  claude(w, "t1", { fgPid: 2001 });
  w.onSleep = (w) => {
    if (w.sleeps === 1) {
      setRecords(w, { t1: record() });
      shell(w, "t1");
    }
    if (w.sleeps === 2) resumed(w, "t1", { fgPid: 2011 });
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 0, r.err);
  assert.equal(w.sleeps, 2);
});

test("an asleep workspace entry: the Claudes asleep in its tabs are the targets, one sleeping in another folder too; a plain shell of it isn't", async () => {
  const w = world({
    records: {
      t2: record({ cwd: "/code/shop", workspacePath: "/code/shop", by: "manual" }),
      t3: record({ cwd: "/code/checkout", workspacePath: "/code/checkout", by: "manual" }),
    },
    entries: { "/code/shop": entry() },
    spaces: [{ id: "sa", tabs: [{ id: "a1", settled: true, terminals: [{ terminal: "t2" }, { terminal: "t3" }, { terminal: "t7" }] }] }],
  });
  shell(w, "t2", { cwd: "/code/shop", pid: 102 });
  shell(w, "t3", { cwd: "/code/checkout", pid: 103 });
  shell(w, "t7", { cwd: "/code/shop", pid: 107 });
  w.doReply = (w) => {
    setEntries(w, {}); // wakeWorkspace drops it in the same pulse
    return json({});
  };
  w.onSleep = (w) => {
    resumed(w, "t2", { pid: 102, fgPid: 2002 });
    resumed(w, "t3", { pid: 103, fgPid: 2003 });
  };
  const r = await run(w, "/code/shop");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.out, ["wake-agent: waking /code/shop: t2, t3 (up to 90 s).", "wake-agent: /code/shop is up.", "t2: up", "t3: up"]);
  assert.equal(entriesOf(w)["/code/shop"], undefined);
});

test("a target whose tab closes while it is waited on is named gone and not waited on; one closed before is named and skipped", async () => {
  const w = world({ records: { t1: record(), t2: record(), t3: record() } });
  shell(w, "t1", { pid: 101 });
  shell(w, "t2", { pid: 102 });
  w.onSleep = (w) => {
    w.terminals.delete("t2");
    resumed(w, "t1", { pid: 101, fgPid: 2001 });
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.out, [
    "wake-agent: waking /code/app: t1, t2 (up to 90 s). t3 slept there, but its tab was closed.",
    "wake-agent: /code/app is up.",
    "t1: up",
    "t2: gone (its tab was closed)",
  ]);
});

test("every target's tab closes before one is up: nothing left to wake, exit 1, naming them", async () => {
  const w = oneAsleep();
  w.onSleep = (w) => w.terminals.delete("t1");
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, "wake-agent: nothing left to wake at /code/app.\nt1: gone (its tab was closed)");
  assert.equal(w.sleeps, 1);
});

test("a path the mod's encoder refuses (a lone surrogate) is a usage error, exit 2, nothing sent", async () => {
  const w = world({ records: { t1: record({ cwd: "/code/\uD800", workspacePath: "/code/\uD800" }) } });
  shell(w, "t1");
  const r = await run(w, "/code/\uD800");
  assert.equal(r.code, 2);
  assert.match(r.err, /^wake-agent: .* isn't a path agent-sleep can be told/);
  assert.deepEqual(w.sent, []);
});

// ── Not up after 90 s: exit 1 with the mod's lines ──────────────────────────

const NOT_WOKEN = "t1: not woken (wake /code/app): its shell line isn't a bare prompt (shell, typed)";

test("not up after 90 s: exit 1 naming the terminals still down, then the mod's lines about them since the wake, its `not woken (wake <path>)` ones included", async () => {
  const w = world({ records: { t1: record(), t2: record() } });
  shell(w, "t1", { pid: 101 });
  shell(w, "t2", { pid: 102 });
  w.files.set(LOG_1, `${logLine(NOW - 120_000, "t1: not woken (wake /code/app): an older wake's")}\n`);
  w.files.set(LOG, [
    logLine(NOW - 30_000, "t2: not woken (wake /code/app): an older wake's"),
    logLine(NOW + 1_000, "t1: not resumed (wake /code/app): its shell line isn't a bare prompt (shell, typed)"),
    logLine(NOW + 2_000, "t2: resumed (wake /code/app)"),
    logLine(NOW + 60_000, NOT_WOKEN),
    logLine(NOW + 60_000, "t9: not woken (wake /code/other): another path's"),
    logLine(NOW + 60_000, "t10: not woken (wake /code/app): another terminal's"),
    logLine(NOW + 60_000, "t1: not woken (wake /code/app/web): a longer path's"),
    "",
  ].join("\n"));
  w.onSleep = (w) => {
    if (w.sleeps === 1) resumed(w, "t2", { pid: 102, fgPid: 2002 });
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(w.now - NOW, WAKE_TIMEOUT_MS);
  assert.equal(r.err, [
    "wake-agent: /code/app isn't up after 90 s:",
    "t1: still asleep (zsh in front)",
    "agent-sleep's log:",
    logLine(NOW + 1_000, "t1: not resumed (wake /code/app): its shell line isn't a bare prompt (shell, typed)"),
    logLine(NOW + 60_000, NOT_WOKEN),
    logLine(NOW + 60_000, "t1: not woken (wake /code/app/web): a longer path's"),
  ].join("\n"));
});

// The mod claims a record (deletes it) before it types the resume, so a wake
// whose resume was typed, or failed to be, ends as done and gives up on
// nothing: its own line about the terminal is the cause, not a closed window.
const claimed = (w, address) => {
  const { [address]: _claimed, ...rest } = recordsOf(w);
  setRecords(w, rest);
};

test("not up after 90 s, its resume typed but Claude never up: the mod's `resumed (wake <path>)` line, no window hint", async () => {
  const w = oneAsleep();
  const line = "t1: resumed (wake /code/app)";
  w.files.set(LOG, `${logLine(NOW + 2_000, line)}\n`);
  w.onSleep = (w) => {
    if (w.sleeps === 1) claimed(w, "t1"); // its shell stays in front
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, [
    "wake-agent: /code/app isn't up after 90 s:",
    "t1: zsh in front",
    "agent-sleep's log:",
    logLine(NOW + 2_000, line),
  ].join("\n"));
});

test("not up after 90 s, its resume not sent: the mod's `resume not sent` line, no window hint", async () => {
  const w = oneAsleep();
  const line = `t1: resume not sent (no terminal "t1"); type it yourself: claude --resume ${SID1}`;
  w.files.set(LOG, `${logLine(NOW + 2_000, line)}\n`);
  w.onSleep = (w) => {
    if (w.sleeps === 1) claimed(w, "t1");
  };
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, [
    "wake-agent: /code/app isn't up after 90 s:",
    "t1: zsh in front",
    "agent-sleep's log:",
    logLine(NOW + 2_000, line),
  ].join("\n"));
});

test("not up after 90 s, its workspace woken and dropped, its wake: \"now\" Claude's resume typed but Claude never up: the mod's `resumed (wake <path>)` line, no window hint", async () => {
  const w = world({
    records: { t2: record({ cwd: "/code/shop", workspacePath: "/code/shop", by: "manual", wake: "now" }) },
    entries: { "/code/shop": entry() },
    spaces: [{ id: "sa", tabs: [{ id: "a1", settled: true, terminals: [{ terminal: "t2" }] }] }],
  });
  shell(w, "t2", { cwd: "/code/shop", pid: 102 });
  // What the mod's wakeWorkspace writes (coordinator.js): the entry's line
  // names no terminal, and the path is no subject once the entry is gone.
  const line = "t2: resumed (wake /code/shop)";
  w.files.set(LOG, [
    logLine(NOW + 2_000, line),
    logLine(NOW + 2_000, '/code/shop: woken, 1 tab(s) back, 1 of 1 wake: "now" Claude(s) resumed'),
    "",
  ].join("\n"));
  w.onSleep = (w) => {
    if (w.sleeps !== 1) return;
    setEntries(w, {}); // dropped in the same pulse
    claimed(w, "t2"); // its shell stays in front
  };
  const r = await run(w, "/code/shop");
  assert.equal(r.code, 1);
  assert.equal(r.err, [
    "wake-agent: /code/shop isn't up after 90 s:",
    "t2: zsh in front",
    "agent-sleep's log:",
    logLine(NOW + 2_000, line),
  ].join("\n"));
});

test("not up after 90 s with no such line since the wake: Herdr's window may be closed; an older wake's line doesn't count", async () => {
  const w = oneAsleep();
  w.files.set(LOG, `${logLine(NOW - 1_000, NOT_WOKEN)}\n`);
  const r = await run(w, "/code/app");
  assert.equal(r.code, 1);
  assert.equal(r.err, [
    "wake-agent: /code/app isn't up after 90 s:",
    "t1: still asleep (zsh in front)",
    "agent-sleep logged nothing about them since the wake was sent: Herdr's window may be closed (agent-sleep acts only while one is open, in a layout with its moon).",
  ].join("\n"));
});

test("not up after 90 s, its workspace still asleep: named, with the mod's line for the path", async () => {
  const w = world({ entries: { "/code/shop": entry() } });
  const line = "/code/shop: not woken (wake /code/shop): its workspace is still asleep";
  w.files.set(LOG, `${logLine(NOW + 60_000, line)}\n`);
  const r = await run(w, "/code/shop");
  assert.equal(r.code, 1);
  assert.equal(r.err, [
    "wake-agent: /code/shop isn't up after 90 s:",
    "its workspace: still asleep",
    "agent-sleep's log:",
    logLine(NOW + 60_000, line),
  ].join("\n"));
});

test("wakeLogLines keeps only the `<subject>: ` lines of the given subjects, stamped at or after the wake's second", () => {
  const since = NOW + 400; // the send, mid-second: a line stamped in that second counts
  const text = [
    logLine(NOW, NOT_WOKEN),
    logLine(NOW - 1_000, NOT_WOKEN),
    logLine(NOW + 1_000, "t1: resumed (wake /code/app)"),
    logLine(NOW + 5_000, "t2: not woken (wake /code/app): x"),
    logLine(NOW + 5_000, "t10: resumed (wake /code/app)"),
    logLine(NOW + 5_000, "pulse failed: t1: x"),
    "t1: garbage line",
    "",
  ].join("\n");
  assert.deepEqual(wakeLogLines(text, { subjects: ["t1"], since }), [logLine(NOW, NOT_WOKEN), logLine(NOW + 1_000, "t1: resumed (wake /code/app)")]);
  assert.deepEqual(wakeLogLines(null, { subjects: ["t1"], since }), []);
  // log.js, both directions: the line the mod writes, read back.
  assert.equal(NOT_WOKEN.startsWith(notWokenHead("t1", "/code/app")), true);
  assert.deepEqual(parseLogLine(logLine(NOW + 999, NOT_WOKEN)), { at: NOW, text: NOT_WOKEN });
  assert.equal(parseLogLine("garbage line"), null);
});

test("asleepLines is the list's pure part: nothing asleep gives no line", () => {
  assert.deepEqual(asleepLines({ records: {}, entries: {}, live: null, slept: new Map() }), []);
});

// ── bin/wake-agent, run for real with fake hc and herdr-app on PATH ──────────

const BIN = fileURLToPath(new URL("../mods/agent-sleep/bin/wake-agent", import.meta.url));

// A fake HOME with Herdr's home inside, and a bin folder whose `hc` and
// `herdr-app` answer from files in it (`do` appends its argv to do.log).
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "wake-agent-"));
  const home = join(root, "home");
  const app = join(home, ".config/herdr-app");
  const bin = join(root, "bin");
  mkdirSync(join(app, "agent-sleep"), { recursive: true });
  mkdirSync(bin);
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\ndir=$(dirname "$0")\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("hc", [
    'case "$1" in',
    '  ls) cat "$dir/hc-ls.json" ;;',
    '  get) if [ -f "$dir/hc-get-$2.json" ]; then cat "$dir/hc-get-$2.json"; else echo \'{"error":{"kind":"not_found","message":"no terminal"}}\'; exit 3; fi ;;',
    "  *) exit 2 ;;",
    "esac",
  ].join("\n"));
  script("herdr-app", [
    'case "$1" in',
    '  ls) echo \'{"spaces":[]}\' ;;',
    '  do) shift; echo "$*" >> "$dir/do.log"; if [ -f "$dir/do.json" ]; then cat "$dir/do.json"; exit 1; fi; echo "{}" ;;',
    "  *) exit 2 ;;",
    "esac",
  ].join("\n"));
  writeFileSync(join(bin, "hc-ls.json"), JSON.stringify({ hidden_finished: [], terminals: [] }));
  const env = { ...process.env, HOME: home, HERDR_APP_HOME: app, PATH: `${bin}:${process.env.PATH}` };
  const runBin = (...args) => spawnSync(BIN, args, { encoding: "utf8", env, cwd: root });
  return { root, home, app, bin, runBin };
}

test("bin/wake-agent: an empty Herdr home has nothing asleep (exit 0); /nowhere/ has nothing asleep and no Claude up (exit 2)", () => {
  const s = sandbox();
  const list = s.runBin();
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, "wake-agent: nothing asleep.\n");
  const at = s.runBin("/nowhere/");
  assert.equal(at.status, 2, at.stderr);
  assert.equal(at.stdout, "wake-agent: nothing asleep at /nowhere. No Claude is up there either.\n");
  assert.equal(existsSync(join(s.bin, "do.log")), false);
  const help = s.runBin("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^wake-agent: /);
});

test("bin/wake-agent wakes a path through `herdr-app do agent-sleep.wake.<hex>` and sees this very process as an up Claude (real ps, its session file under HOME)", () => {
  const s = sandbox();
  const pid = process.pid;
  const [cmd, ...args] = procStartCommand(pid);
  const ps = spawnSync(cmd, args, { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stderr);
  const session = sessionFilePath(s.home, pid);
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, JSON.stringify({ pid, sessionId: SID1, cwd: "/code/app", procStart: ps.stdout, kind: "interactive" }));
  writeFileSync(join(s.app, "agent-sleep/sleeping.json"), serializeRecords({ t1: record() }));
  writeFileSync(join(s.bin, "hc-ls.json"), JSON.stringify({ hidden_finished: [], terminals: [{ address: "t1", state: "live", cwd: "/code/app" }] }));
  writeFileSync(join(s.bin, "hc-get-t1.json"), JSON.stringify({ address: "t1", state: "live", cwd: "/code/app", foreground: { ...NATIVE_FG, pid }, status: null }));
  const r = s.runBin("/code/app");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(s.bin, "do.log"), "utf8"), `${wakeOf("/code/app")}\n`);
  assert.match(r.stdout, /\/code\/app is up\.\nt1: up\n$/);

  writeFileSync(join(s.bin, "do.json"), JSON.stringify({ error: "agent-sleep isn't loaded" }));
  const refused = s.runBin("/code/app");
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, "wake-agent: Herdr refused the wake of /code/app: agent-sleep isn't loaded\n");
});
