// T6: the `spotlight` CLI (M/cli.mjs, M/cli-*.mjs, M/bin/spotlight), the
// verbs of D1 wired over batch A's modules. Every test runs the real CLI as a
// subprocess in a temp world:
//   HOME            temp (logs under ~/.local/state, ~/.claude)
//   HERDR_APP_HOME  temp (state.json, settings.json, shared.json)
//   PATH            a temp bin first, holding a fake `hc` (terminals in a
//                   JSON file, the shapes the T5b probe pinned), `lsof` and
//                   `pgrep` answering from that file, a `herdr-app` that
//                   records its argv, and a `git` wrapper that sleeps before
//                   chosen subcommands (to hold a repo lock mid-work)
// and real git repos with real worktrees. Detached work (`light`, `sync
// --detach`, `classify`) runs as real detached processes; tests wait on
// state.json for it. Nothing here touches a real Herdr terminal.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, "..", "mods", "spotlight");
const CLI = join(MOD, "cli.mjs");
const BIN = join(MOD, "bin", "spotlight");
const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const NODE = process.execPath;

const worlds = [];
after(async () => {
  // Detached lights may still be finishing; give them a moment, then clean up.
  await sleep(300);
  for (const w of worlds) rmSync(w.dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// ── Fakes on PATH ──────────────────────────────────────────────────────────

// Shared by the fake hc, lsof and pgrep: the terminals live in
// $FAKE_HC_STATE, read-modify-written under a mkdir lock (several CLIs call
// hc at once). `$FAKE_HC_STATE.delay` holds ms every hc call sleeps first.
const FAKE_LIB = `
const fs = require("fs");
const STATE = process.env.FAKE_HC_STATE;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lock() {
  for (let i = 0; i < 4000; i++) {
    try { fs.mkdirSync(STATE + ".lock"); return; } catch { sleep(3); }
  }
  throw new Error("fake hc: lock timeout");
}
const unlock = () => fs.rmSync(STATE + ".lock", { recursive: true, force: true });
function load() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch { return { nextPid: 50000, nextAddr: 1, terminals: {}, listen: {}, reads: {}, sent: [], calls: [] }; }
}
function save(s) {
  const tmp = STATE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, STATE);
}
`;

const FAKE_HC = `#!${NODE}
${FAKE_LIB}
let delay = 0;
try { delay = Number(fs.readFileSync(STATE + ".delay", "utf8")) || 0; } catch {}
if (delay) sleep(delay);
const args = process.argv.slice(2);
const out = (code, obj, err) => {
  if (obj !== undefined) process.stdout.write(JSON.stringify(obj) + "\\n");
  if (err) process.stderr.write(JSON.stringify({ error: err }) + "\\n");
  process.exitCode = code;
};
// zsh's words of a typed line made by shellQuote: '…' runs and \\' escapes.
function words(line) {
  const list = []; let cur = null; let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " ") { if (cur !== null) { list.push(cur); cur = null; } i++; continue; }
    cur = cur ?? "";
    if (c === "'") { const j = line.indexOf("'", i + 1); cur += line.slice(i + 1, j); i = j + 1; }
    else if (c === "\\\\") { cur += line[i + 1]; i += 2; }
    else { cur += c; i++; }
  }
  if (cur !== null) list.push(cur);
  return list;
}
lock();
try {
  const s = load();
  s.calls.push(args);
  const [verb, ...rest] = args;
  const all = Object.values(s.terminals);
  const find = (t) => s.terminals[t] ?? all.find((x) => x.name === t && x.state === "live") ?? all.find((x) => x.name === t);
  const shell = (t) => ({ pid: t.pid, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: t.cwd });
  const view = (t) => {
    if (t.pendingShell !== undefined && t.pendingShell-- <= 0) { t.foreground = shell(t); delete t.pendingShell; }
    const { pendingShell, serverPorts, callerForeground, ...v } = t;
    // A command typed in a plain shell leads its foreground: the CLI that called hc.
    if (callerForeground) v.foreground = { pid: process.ppid, name: "node", argv: ["node"], cwd: t.cwd };
    if (v.state === "finished") delete v.foreground;
    return v;
  };
  const t = rest[0] ? find(rest[0]) : null;
  const missing = () => out(3, undefined, { kind: "not_found", message: "no terminal " + rest[0] });
  switch (verb) {
    case "get": t ? out(0, view(t)) : missing(); break;
    case "ls": out(0, { terminals: all.filter((x) => x.state === "live").map(view), hidden_finished: 0, machines: [] }); break;
    case "run": {
      const opt = (k) => args[args.indexOf(k) + 1];
      const name = opt("--name");
      if (all.some((x) => x.name === name && x.state === "live")) { out(1, undefined, { kind: "name_taken", message: "taken" }); break; }
      const [k, ...v] = opt("--label").split("=");
      const address = "t" + s.nextAddr++;
      const made = { address, name, labels: { [k]: v.join("=") }, cwd: opt("--cwd"), pid: s.nextPid++, state: "live",
        argv: args.slice(args.indexOf("--") + 1), turn: 0, status: null, status_ms: null };
      made.foreground = shell(made);
      s.terminals[address] = made;
      out(0, { address, name, cwd: made.cwd, state: "live", turn: 0 });
      break;
    }
    case "send": {
      if (!t) { missing(); break; }
      if (t.state !== "live") { out(11, undefined, { kind: "finished", message: "finished" }); break; }
      const text = rest[1];
      s.sent.push({ terminal: t.address, text });
      if (text.startsWith("script ")) {
        const argv = words(text);
        t.foreground = { pid: s.nextPid++, name: "script", argv, cwd: t.cwd };
        try { fs.appendFileSync(argv[4], "fake server: " + argv[7] + "\\r\\n"); } catch {}
        if (s.listen[t.cwd]) t.serverPorts = s.listen[t.cwd];
        else delete t.serverPorts;
      }
      out(0, { started: null, status: null, turn: 0 });
      break;
    }
    case "interrupt":
      if (!t) { missing(); break; }
      if (t.foreground && t.foreground.pid !== t.pid && !t.ignoresInterrupt) t.pendingShell = 1;
      out(0, { key: "ctrl+c", outcome: "stopped" });
      break;
    case "rm":
      if (!t) { missing(); break; }
      if (t.state === "live") { out(1, undefined, { kind: "live", message: "still running" }); break; }
      delete s.terminals[t.address];
      out(0, { removed: t.address });
      break;
    case "read":
      t ? out(0, { text: s.reads[t.address] ?? "", complete: true, how: "history" }) : missing();
      break;
    case "kill":
      if (!t) { missing(); break; }
      t.state = "finished"; delete t.foreground; t.reason = "killed";
      out(0, { killed: t.address });
      break;
    default:
      out(2, undefined, { kind: "usage", message: "fake hc: " + verb });
  }
  save(s);
} finally {
  unlock();
}
`;

// lsof -F pcn of the fake servers: a `script` foreground with listen ports.
const FAKE_LSOF = `#!${NODE}
${FAKE_LIB}
const s = load();
const lines = [];
for (const t of Object.values(s.terminals)) {
  if (t.state !== "live" || !t.foreground || t.foreground.name !== "script" || !t.serverPorts) continue;
  lines.push("p" + t.foreground.pid, "cnode");
  for (const p of t.serverPorts) lines.push("f20", "n*:" + p);
}
process.stdout.write(lines.length ? lines.join("\\n") + "\\n" : "");
process.exitCode = lines.length ? 0 : 1;
`;

// pgrep -P <pid>: a fake terminal's foreground is its shell's child.
const FAKE_PGREP = `#!${NODE}
${FAKE_LIB}
const pid = Number(process.argv[3]);
const s = load();
const kids = Object.values(s.terminals)
  .filter((t) => t.state === "live" && t.pid === pid && t.foreground && t.foreground.pid !== pid)
  .map((t) => t.foreground.pid);
process.stdout.write(kids.map((k) => k + "\\n").join(""));
process.exitCode = kids.length ? 0 : 1;
`;

const FAKE_HERDR_APP = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HC_STATE.herdr-app"
`;

// git, slowed down before the subcommand named in $FAKE_GIT_SLOW ("reset 2").
const FAKE_GIT = `#!/bin/sh
if [ -f "$FAKE_GIT_SLOW" ]; then
  read -r sub secs < "$FAKE_GIT_SLOW"
  for a in "$@"; do
    if [ "$a" = "$sub" ]; then sleep "$secs"; break; fi
  done
fi
exec ${REAL_GIT} "$@"
`;

// claude-accounts' contract (claude-accounts.md D9): `terminal <t> --json`,
// and `usage --refresh --json` (what `classify` runs first), which takes
// $HERDR_APP_HOME/claude-accounts/usage-delay seconds when that file says so.
const FAKE_ACCOUNTS = `#!/bin/sh
if [ "$1" = terminal ]; then
  code=$(cat "$HERDR_APP_HOME/claude-accounts/terminal-exit" 2>/dev/null || echo 0)
  [ "$code" = 0 ] || exit "$code"
  printf '{"account":"acc-1","sessionId":"s1","status":"idle"}\\n'
  exit 0
fi
if [ "$1" = usage ]; then
  sleep "$(cat "$HERDR_APP_HOME/claude-accounts/usage-delay" 2>/dev/null || echo 0)"
  cat "$HERDR_APP_HOME/claude-accounts/accounts.v1.json" 2>/dev/null
  exit 0
fi
exit 2
`;

function writeExec(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

// ── A world ────────────────────────────────────────────────────────────────

function makeWorld() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-cli-")));
  const home = join(dir, "home");
  const app = join(dir, "app");
  const bin = join(dir, "bin");
  for (const d of [home, app, bin, join(app, "spotlight"), join(dir, "repos"), join(dir, "ws")]) mkdirSync(d, { recursive: true });
  writeExec(join(bin, "hc"), FAKE_HC);
  writeExec(join(bin, "lsof"), FAKE_LSOF);
  writeExec(join(bin, "pgrep"), FAKE_PGREP);
  writeExec(join(bin, "herdr-app"), FAKE_HERDR_APP);
  writeExec(join(bin, "git"), FAKE_GIT);
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n" +
      "[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n",
  );
  const env = { ...process.env };
  for (const k of ["HC_TERMINAL_ID", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "NODE_TEST_CONTEXT"]) delete env[k];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    HERDR_APP_HOME: app,
    FAKE_HC_STATE: join(dir, "hc.json"),
    FAKE_GIT_SLOW: join(dir, "git-slow"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    SPOTLIGHT_POLL_MS: "100",
    SPOTLIGHT_PORT_POLL_MS: "100",
  });
  const statePath = join(app, "spotlight", "state.json");
  const w = {
    dir, home, app, bin, env, statePath,
    hcPath: join(dir, "hc.json"),
    state() {
      return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    },
    writeState(s) {
      writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`);
    },
    settings(value) {
      writeFileSync(join(app, "spotlight", "settings.json"), JSON.stringify({ version: 1, ...value }));
    },
    register(groups) {
      const v1 = { version: 1, groups: groups.map((g) => ({ id: g.id, name: g.name ?? g.id, projects: g.repos.map((r) => ({ path: r.root, name: r.name })) })) };
      writeFileSync(join(app, "shared.json"), JSON.stringify({ "projects.v1": v1 }));
    },
    hc() {
      return existsSync(w.hcPath) ? JSON.parse(readFileSync(w.hcPath, "utf8")) : { terminals: {}, sent: [], calls: [], listen: {} };
    },
    hcUpdate(fn) {
      const s = w.hc();
      s.nextPid ??= 50000;
      s.nextAddr ??= 1;
      s.reads ??= {};
      fn(s);
      writeFileSync(w.hcPath, JSON.stringify(s, null, 1));
    },
    hcDelay(ms) {
      writeFileSync(`${w.hcPath}.delay`, String(ms));
    },
    slowGit(sub, secs) {
      if (sub) writeFileSync(env.FAKE_GIT_SLOW, `${sub} ${secs}\n`);
      else rmSync(env.FAKE_GIT_SLOW, { force: true });
    },
    // An agent terminal in `cwd`, as Herdr shows a Claude Code one.
    agent(cwd, { turn = 0, state = "working" } = {}) {
      let address;
      w.hcUpdate((s) => {
        address = `t${s.nextAddr++}`;
        const pid = s.nextPid++;
        s.terminals[address] = {
          address, name: null, labels: {}, cwd, pid, state: "live", argv: ["/bin/zsh", "-l"], turn,
          status: { app: "claude", state }, status_ms: Date.now(),
          foreground: { pid: s.nextPid++, name: "claude", argv: ["claude"], cwd },
        };
      });
      return address;
    },
    setAgent(t, fields) {
      w.hcUpdate((s) => Object.assign(s.terminals[t], fields, { status_ms: Date.now() }));
    },
    listen(root, ports) {
      w.hcUpdate((s) => {
        s.listen[root] = ports;
      });
    },
    serverTerminal(root) {
      return Object.values(w.hc().terminals).find((t) => t.labels?.["spotlight.repo"] === root) ?? null;
    },
    cli(args, { terminal, cwd = dir, extraEnv = {} } = {}) {
      const started = Date.now();
      const e = { ...env, ...extraEnv };
      if (terminal) e.HC_TERMINAL_ID = terminal;
      return new Promise((resolve) => {
        execFile(NODE, [CLI, ...args], { cwd, env: e, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr, ms: Date.now() - started });
        });
      });
    },
    async until(pred, { ms = 20_000, what = "state" } = {}) {
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

// The test's own git reads the same config as the worlds' (never the user's).
const GIT_ENV = (() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sl-cli-gitcfg-")));
  worlds.push({ dir });
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n" +
      "[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n",
  );
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  return env;
})();

function git(cwd, ...args) {
  return execFileSync(REAL_GIT, args, { cwd, encoding: "utf8", stdio: "pipe", env: GIT_ENV }).trim();
}

function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

// A repo `name` with one worktree per task branch. `pkg`: package.json
// (scripts make it a server repo); `files`: more committed files.
function makeRepo(w, name, { pkg, files = {}, tasks = [] } = {}) {
  const root = join(w.dir, "repos", name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", `${name}\n`);
  write(root, ".gitignore", "node_modules/\n");
  if (pkg) write(root, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const ws = {};
  for (const branch of tasks) {
    const p = join(w.dir, "ws", name, branch.toLowerCase());
    git(root, "worktree", "add", "-q", "-b", branch, p);
    ws[branch] = p;
  }
  return { root, ws, name };
}

const DEV = { scripts: { dev: "vite" } };
const refsOf = (root) => git(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/").split("\n").filter(Boolean);
const lockDirOf = (w, root) => join(w.app, "spotlight", "locks", `repo-${sha1(root)}`);
const requestOf = (s, t) => s.queue.requests.find((r) => r.terminal === t);

// ── Queue: waiting, hand-off, servers ──────────────────────────────────────

test("two terminals of one space: the second waits with its place kept; A's off hands B its turn, URLs and logs", async () => {
  const w = makeWorld();
  const front = makeRepo(w, "front", { pkg: DEV, tasks: ["AX-1"] });
  const back = makeRepo(w, "back", { pkg: DEV, tasks: ["AX-2"] });
  w.register([{ id: "g1", repos: [front, back] }]);
  w.listen(front.root, [3000]);
  w.listen(back.root, [3001, 3002]);
  const tA = w.agent(front.ws["AX-1"]);
  const tB = w.agent(back.ws["AX-2"]);

  const a = await w.cli(["on"], { terminal: tA, cwd: front.ws["AX-1"] });
  assert.equal(a.code, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /^Spotlight on for AX-1\.$/m);
  assert.match(a.stdout, /front {2}http:\/\/localhost:3000 {2}listening/);
  assert.match(a.stdout, /^Logs: spotlight logs$/m);
  assert.match(a.stdout, new RegExp(`front-[0-9a-f]{6}\\.log`));
  assert.equal(git(front.root, "rev-parse", "HEAD"), git(front.root, "rev-parse", "refs/herdr-spotlight/snapshot"));

  const b = await w.cli(["on", "--timeout-ms", "1200"], { terminal: tB, cwd: back.ws["AX-2"] });
  assert.equal(b.code, 1, b.stderr + b.stdout);
  assert.match(b.stdout, /^Waiting for a test turn for AX-2: AX-1 is testing front \(same space\)\.$/m);
  assert.match(b.stdout, /You are #1 in line\. Your place is kept: run `spotlight on` again to keep waiting\./);
  assert.equal(requestOf(w.state(), tB).state, "waiting");

  const pending = w.cli(["on", "--timeout-ms", "30000"], { terminal: tB, cwd: back.ws["AX-2"] });
  await sleep(400);
  const off = await w.cli(["off"], { terminal: tA });
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /Gave back the Spotlight turn of AX-1\. AX-2 is testing next\./);
  const on = await pending;
  assert.equal(on.code, 0, on.stderr + on.stdout);
  assert.match(on.stdout, /^Spotlight on for AX-2\.$/m);
  assert.match(on.stdout, /back {2}http:\/\/localhost:3001 {2}listening/);
  assert.match(on.stdout, /^Logs: spotlight logs$/m);
  assert.doesNotMatch(on.stdout, /Not every server/);
});

test("a holder whose repo has no server command exits 0 within ~15 s with 'no server running'", async () => {
  const w = makeWorld();
  const notes = makeRepo(w, "notes", { tasks: ["AX-3"] });
  w.register([{ id: "g1", repos: [notes] }]);
  w.settings({ repos: { [notes.root]: { enabled: true } } });
  const t = w.agent(notes.ws["AX-3"]);
  const r = await w.cli(["on"], { terminal: t, cwd: notes.ws["AX-3"] });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^Spotlight on for AX-3\.$/m);
  assert.match(r.stdout, /notes {2}- {2}no server running/);
  assert.ok(r.ms < 25_000, `took ${r.ms} ms`);
  assert.ok(r.ms >= 14_000, `the 15 s grace was skipped (${r.ms} ms)`);
});

test("a server that never opens a port exits 0 at the deadline: 'starting (port not open yet)' and the not-ready line", async () => {
  const w = makeWorld();
  const web = makeRepo(w, "web", { pkg: DEV, tasks: ["AX-4"] });
  w.register([{ id: "g1", repos: [web] }]);
  const t = w.agent(web.ws["AX-4"]);
  const r = await w.cli(["on", "--timeout-ms", "3500"], { terminal: t, cwd: web.ws["AX-4"] });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /web {2}- {2}starting \(port not open yet\)/);
  assert.match(r.stdout, /^Not every server is listening yet\. Read its log, or run `spotlight on` again to keep waiting\.$/m);
  assert.ok(r.ms >= 3000, `returned before the deadline (${r.ms} ms)`);
  const sent = w.hc().sent.map((x) => x.text);
  assert.ok(sent.some((x) => x.startsWith("script -F -q -a ") && x.endsWith("/bin/zsh -c 'npm run dev --'")), sent.join("\n"));
});

test("an edit in the holder with auto-sync off: the next `on` leaves the root with the edit", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, files: { "src/a.txt": "one\n" }, tasks: ["AX-5"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-5"];
  const t = w.agent(ws);
  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  write(ws, "src/a.txt", "two\n");
  write(ws, "src/new.txt", "fresh\n");
  const again = await w.cli(["on"], { terminal: t, cwd: ws });
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.equal(readFileSync(join(app.root, "src/a.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(app.root, "src/new.txt"), "utf8"), "fresh\n");
});

// ── toggle ─────────────────────────────────────────────────────────────────

test("toggle returns before the fake git and hc finish, and the lighting lands in state.json", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-6"] });
  w.register([{ id: "g1", repos: [app] }]);
  const ws = app.ws["AX-6"];
  w.slowGit("reset", 1.5);
  w.hcDelay(400);
  const r = await w.cli(["toggle", "--workspace", ws]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(r.ms < 1500, `toggle took ${r.ms} ms`);
  const right = w.state();
  const marker = right.queue.lighting[`direct/${app.root}`];
  assert.ok(marker && marker.phase !== "done", JSON.stringify(marker));
  w.slowGit(null);
  const s = await w.until((st) => st.queue.lighting[`direct/${app.root}`]?.phase === "done" && st, { what: "lighting done" });
  w.hcDelay(0);
  assert.equal(s.repos[app.root].holder, ws);
  assert.equal(s.repos[app.root].serverState, "starting");
  for (const ref of ["snapshot", "backup", "original-head"]) assert.ok(refsOf(app.root).includes(`refs/herdr-spotlight/${ref}`), ref);
});

test("toggle off on a root-diverged root refuses; `toggle --force` off restores it", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-7"] });
  w.register([{ id: "g1", repos: [app] }]);
  const ws = app.ws["AX-7"];
  assert.equal((await w.cli(["toggle", "--workspace", ws])).code, 0);
  await w.until((s) => s.queue.lighting[`direct/${app.root}`]?.phase === "done", { what: "lit" });
  git(app.root, "commit", "-q", "--allow-empty", "-m", "made in the root");
  const refused = await w.cli(["toggle", "--workspace", ws]);
  assert.equal(refused.code, 1, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /root-diverged/);
  assert.match(refused.stderr, /--force/);
  assert.ok(refsOf(app.root).includes("refs/herdr-spotlight/snapshot"));

  const forced = await w.cli(["toggle", "--workspace", ws, "--force"]);
  assert.equal(forced.code, 0, forced.stderr + forced.stdout);
  await w.until(() => refsOf(app.root).length === 0 && !w.state().repos[app.root], { what: "restored" });
  assert.equal(git(app.root, "symbolic-ref", "--short", "HEAD"), "main");
  const term = w.serverTerminal(app.root);
  assert.equal(term.foreground.name, "zsh", "the server was stopped");
  assert.ok(w.state().notes.some((n) => n.toast && /Spotlight off — root restaurado/.test(n.text)));
});

test("a repo that isn't enabled: `on` takes a slot-only turn and lights nothing; `toggle` on refuses not-enabled; `toggle` off still works", async () => {
  const w = makeWorld();
  const docs = makeRepo(w, "docs", { tasks: ["AX-8"] });
  w.register([{ id: "g1", repos: [docs] }]);
  const ws = docs.ws["AX-8"];
  const t = w.agent(ws);
  const on = await w.cli(["on"], { terminal: t, cwd: ws });
  assert.equal(on.code, 0, on.stderr + on.stdout);
  assert.match(on.stdout, /^Your test turn for AX-8 is on\.$/m);
  assert.match(on.stdout, /^No project of AX-8 can hold a Spotlight here, so this turn only holds a test slot: run your tests\.$/m);
  assert.match(on.stdout, /^Not included: docs\.$/m);
  assert.deepEqual(refsOf(docs.root), []);

  const refused = await w.cli(["toggle", "--workspace", ws]);
  assert.equal(refused.code, 2, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /not-enabled/);

  w.settings({ repos: { [docs.root]: { enabled: true } } });
  assert.equal((await w.cli(["toggle", "--workspace", ws])).code, 0);
  await w.until((s) => s.queue.lighting[`direct/${docs.root}`]?.phase === "done", { what: "lit" });
  assert.ok(refsOf(docs.root).length > 0);
  w.settings({ repos: { [docs.root]: { enabled: false } } });
  const off = await w.cli(["toggle", "--workspace", ws]);
  assert.equal(off.code, 0, off.stderr + off.stdout);
  await w.until(() => refsOf(docs.root).length === 0, { what: "off" });
});

// ── off, lighting hand-off, races ──────────────────────────────────────────

test("`off` gives the turn back and leaves the refs and the server terminal untouched", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-9"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-9"];
  const t = w.agent(ws);
  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  const refs = refsOf(app.root);
  const before = w.serverTerminal(app.root);
  const calls = w.hc().calls.length;
  const off = await w.cli(["off"], { terminal: t });
  assert.equal(off.code, 0);
  assert.match(off.stdout, /Gave back the Spotlight turn of AX-9\. The servers keep running until another task takes the projects\./);
  assert.deepEqual(refsOf(app.root), refs);
  const term = w.serverTerminal(app.root);
  assert.equal(term.state, "live");
  assert.deepEqual(term.foreground, before.foreground);
  assert.ok(!w.hc().calls.slice(calls).some((c) => ["interrupt", "kill", "send", "rm"].includes(c[0])));
  assert.equal(w.state().queue.requests.length, 0);
  assert.equal(w.state().repos[app.root].holder, ws);
});

test("a `light` killed mid-way: the next `on` poll lights again and exits 0", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-10"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-10"];
  const t = w.agent(ws);
  const key = `g1/AX-10`;
  w.slowGit("stash", 4);
  const pending = w.cli(["on", "--timeout-ms", "60000"], { terminal: t, cwd: ws });
  const first = await w.until((s) => (s.queue.lighting[key]?.phase === "running" && s.queue.lighting[key].pid) || null, { what: "light running" });
  await sleep(300);
  process.kill(first, "SIGKILL");
  w.slowGit(null);
  const r = await pending;
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /app {2}http:\/\/localhost:3000 {2}listening/);
  const marker = w.state().queue.lighting[key];
  assert.equal(marker.phase, "done");
  assert.notEqual(marker.pid, first);
});

test("a failed lighting exits 0 with the error line", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-11"] });
  w.register([{ id: "g1", repos: [app] }]);
  git(app.root, "checkout", "-q", "--detach");
  const ws = app.ws["AX-11"];
  const t = w.agent(ws);
  const r = await w.cli(["on", "--timeout-ms", "20000"], { terminal: t, cwd: ws });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /app {2}- {2}not lit: Spotlight needs the project root checked out on a branch/);
  assert.deepEqual(refsOf(app.root), []);
  assert.equal(w.state().repos[app.root]?.lastError?.code, "not-on-primary-branch");
});

test("a sync racing a takeover ends with the new holder's tree at the root", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-12", "AX-13"] });
  w.register([{ id: "g1", repos: [app] }]);
  const [w1, w2] = [app.ws["AX-12"], app.ws["AX-13"]];
  assert.equal((await w.cli(["toggle", "--workspace", w1])).code, 0);
  await w.until((s) => s.queue.lighting[`direct/${app.root}`]?.phase === "done" && s.repos[app.root]?.holder === w1, { what: "w1 lit" });
  write(w1, "w1-edit.txt", "from w1\n");
  write(w2, "w2-marker.txt", "from w2\n");
  w.slowGit("reset", 2);
  assert.equal((await w.cli(["toggle", "--workspace", w2])).code, 0);
  const until = Date.now() + 10_000;
  while (!existsSync(lockDirOf(w, app.root))) {
    assert.ok(Date.now() < until, "the takeover never took the repo lock");
    await sleep(20);
  }
  const sync = w.cli(["sync", "--repo", app.root]);
  await sleep(200);
  w.slowGit(null);
  const r = await sync;
  assert.equal(r.code, 0, r.stderr + r.stdout);
  await w.until((s) => s.queue.lighting[`direct/${app.root}`]?.phase === "done", { what: "takeover done" });
  assert.equal(w.state().repos[app.root].holder, w2);
  assert.ok(existsSync(join(app.root, "w2-marker.txt")));
  assert.ok(!existsSync(join(app.root, "w1-edit.txt")));
});

test("a sync that changes pnpm-lock.yaml restarts the server with the install chained; a killed server terminal reads gone", async () => {
  const w = makeWorld();
  const shop = makeRepo(w, "shop", {
    pkg: { packageManager: "pnpm@9.0.0", scripts: { dev: "vite" } },
    files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" },
    tasks: ["AX-14"],
  });
  mkdirSync(join(shop.root, "node_modules"));
  w.register([{ id: "g1", repos: [shop] }]);
  const ws = shop.ws["AX-14"];
  assert.equal((await w.cli(["toggle", "--workspace", ws])).code, 0);
  await w.until((s) => s.queue.lighting[`direct/${shop.root}`]?.phase === "done", { what: "lit" });
  const first = w.hc().sent.map((x) => x.text);
  assert.equal(first.length, 1, first.join("\n"));
  assert.match(first[0], /\/bin\/zsh -c 'pnpm dev'$/);

  write(ws, "pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n");
  const r = await w.cli(["sync", "--repo", shop.root]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const hc = w.hc();
  assert.ok(hc.calls.some((c) => c[0] === "interrupt"), "the running server was interrupted");
  assert.match(hc.sent.at(-1).text, /\/bin\/zsh -c 'pnpm install --frozen-lockfile && pnpm dev'$/);
  assert.deepEqual(w.state().repos[shop.root].pendingInstalls, []);

  const server = w.serverTerminal(shop.root);
  w.hcUpdate((s) => {
    s.terminals[server.address].state = "finished";
    delete s.terminals[server.address].foreground;
  });
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal(w.state().repos[shop.root].serverState, "gone");
});

// ── Turn ends (D13) ────────────────────────────────────────────────────────

// A slot-only task per case, so the turn-end rules run without lighting.
function turnWorld({ accounts } = {}) {
  const w = makeWorld();
  const tasks = ["AX-20", "AX-21", "AX-22", "AX-23", "AX-24", "AX-25", "AX-26"];
  const repo = makeRepo(w, "slots", { tasks });
  w.register([{ id: "g1", repos: [repo] }]);
  w.settings({ queue: { perSpace: { g1: 4 }, cap: 4 } });
  if (accounts) {
    const dir = join(w.app, "mods", "claude-accounts", "bin");
    mkdirSync(dir, { recursive: true });
    writeExec(join(dir, "claude-accounts"), FAKE_ACCOUNTS);
    mkdirSync(join(w.app, "claude-accounts"), { recursive: true });
  }
  const holding = async (task) => {
    const t = w.agent(repo.ws[task]);
    const r = await w.cli(["on"], { terminal: t, cwd: repo.ws[task] });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(requestOf(w.state(), t).state, "holding");
    return t;
  };
  const usage = (percent, ageMs) => {
    writeFileSync(join(w.app, "claude-accounts", "accounts.v1.json"), JSON.stringify({
      version: 1, updatedAt: new Date().toISOString(), active: "acc-1",
      accounts: [{
        id: "acc-1", label: "Main", email: "a@b.c", configDir: null, isDefault: true, needsSignIn: false, error: null,
        usage: { session: { percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, weekly: { percent: 10, resetsAt: null }, fable: null },
        usageUpdatedAt: new Date(Date.now() - ageMs).toISOString(),
      }],
    }));
  };
  return { w, repo, holding, usage };
}

test("turn end without the accounts plugin: done releases, permission/question keep, error pauses, auth pauses signin, a limit msg pauses limit", async () => {
  const { w, holding } = turnWorld();

  const done = await holding("AX-20");
  w.setAgent(done, { turn: 1, status: { app: "claude", state: "done" } });
  const permission = await holding("AX-21");
  w.setAgent(permission, { turn: 1, status: { app: "claude", state: "blocked", kind: "permission", msg: "approve Write: x" } });
  const question = await holding("AX-22");
  w.setAgent(question, { turn: 1, status: { app: "claude", state: "blocked", kind: "question" } });
  const error = await holding("AX-23");
  w.setAgent(error, { turn: 1, status: { app: "claude", state: "error", msg: "API Error" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  let s = w.state();
  assert.equal(requestOf(s, done), undefined, "done with the turn up releases");
  assert.equal(requestOf(s, permission).state, "holding");
  assert.equal(requestOf(s, question).state, "holding");
  assert.equal(requestOf(s, error).state, "paused");
  assert.equal(requestOf(s, error).pauseReason, "error");

  for (const t of [permission, question]) assert.equal((await w.cli(["off"], { terminal: t })).code, 0);
  const auth = await holding("AX-24");
  w.setAgent(auth, { turn: 1, status: { app: "claude", state: "blocked", kind: "auth", msg: "Login reached its time limit · Please run /login" } });
  const limit = await holding("AX-25");
  w.setAgent(limit, { turn: 1, status: { app: "claude", state: "blocked", msg: "You've hit your usage limit" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  s = w.state();
  assert.equal(requestOf(s, auth).state, "paused");
  assert.equal(requestOf(s, auth).pauseReason, "signin");
  assert.equal(requestOf(s, limit).pauseReason, "limit");
});

test("turn end with the accounts plugin: done with the account at 100% pauses limit; stale usage spawns classify", async () => {
  const { w, holding, usage } = turnWorld({ accounts: true });
  usage(100, 10_000);
  const full = await holding("AX-20");
  w.setAgent(full, { turn: 1, status: { app: "claude", state: "done" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal(requestOf(w.state(), full).state, "paused");
  assert.equal(requestOf(w.state(), full).pauseReason, "limit");

  usage(30, 10 * 60_000);
  // classify's fresh read takes a moment, so the second reap runs while it works.
  writeFileSync(join(w.app, "claude-accounts", "usage-delay"), "2");
  const stale = await holding("AX-21");
  w.setAgent(stale, { turn: 1, status: { app: "claude", state: "done" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  const r = requestOf(w.state(), stale);
  assert.equal(r.state, "holding", "a stale read decides nothing yet");
  assert.equal(r.classifyTurn, 1);
  assert.ok(Number.isInteger(r.classifyPid) && r.classifyPid > 0);
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal(requestOf(w.state(), stale).classifyPid, r.classifyPid, "classify is spawned once per turn end");
  // T11: classify decides with the fresh read (30%: the turn end releases).
  await w.until((s) => !requestOf(s, stale), { what: "classify's release" });
});

test("a second `on` re-baselines requestTurn and clears resumingUntil", async () => {
  const { w, holding } = turnWorld();
  const t = await holding("AX-26");
  assert.equal(requestOf(w.state(), t).requestTurn, 0);
  w.setAgent(t, { turn: 3 });
  const s = w.state();
  requestOf(s, t).resumingUntil = Date.now() + 60_000;
  w.writeState(s);
  const cwd = w.hc().terminals[t].cwd;
  assert.equal((await w.cli(["on"], { terminal: t, cwd })).code, 0);
  const r = requestOf(w.state(), t);
  assert.equal(r.requestTurn, 3);
  assert.equal(r.resumingUntil, null);
});

// ── status ─────────────────────────────────────────────────────────────────

test("`status --json` takes no lock, reaps nothing, and says queue: \"off\" when the switch is off", async () => {
  const { w, holding } = turnWorld();
  const t = await holding("AX-20");
  w.setAgent(t, { turn: 1, status: { app: "claude", state: "done" } });
  w.settings({ queue: { enabled: false } });
  const lockDir = join(w.app, "spotlight", "locks", "state");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const before = readFileSync(w.statePath, "utf8");
  const r = await w.cli(["status", "--json"], { terminal: t });
  rmSync(lockDir, { recursive: true, force: true });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 3000, `status waited ${r.ms} ms`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result.queue, "off");
  assert.equal(out.result.mine.kind, "holding");
  assert.equal(readFileSync(w.statePath, "utf8"), before, "status wrote nothing");
});

test("tester case 13: `status` shows the limit, this terminal's place and who blocks it", async () => {
  const w = makeWorld();
  const ag = makeRepo(w, "arctic-grey", { tasks: ["ag-checkout"] });
  const admin = makeRepo(w, "ag-admin", { tasks: ["ag-reports"] });
  const action = makeRepo(w, "action-black", { tasks: ["checkout-flow"] });
  const exp = makeRepo(w, "expenses-logs", { tasks: ["expenses-export"] });
  w.register([
    { id: "ag", repos: [ag, admin] },
    { id: "action", repos: [action] },
    { id: "arrecife", repos: [exp] },
  ]);
  const term = (repo, task) => ({ t: w.agent(repo.ws[task]), cwd: repo.ws[task] });
  const checkout = term(ag, "ag-checkout");
  const flow = term(action, "checkout-flow");
  const reports = term(admin, "ag-reports");
  const expenses = term(exp, "expenses-export");
  for (const x of [checkout, flow]) assert.equal((await w.cli(["on"], { terminal: x.t, cwd: x.cwd })).code, 0);
  for (const x of [reports, expenses]) assert.equal((await w.cli(["on", "--timeout-ms", "300"], { terminal: x.t, cwd: x.cwd })).code, 1);

  const same = await w.cli(["status"], { terminal: reports.t });
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /^Limit: 2 tasks at a time$/m);
  assert.match(same.stdout, /This terminal: #1 in line for ag-reports: ag-checkout is testing \(same space\)/);
  assert.match(same.stdout, /^ {2}ag-checkout {2}arctic-grey {2}\(1 agent/m);
  assert.match(same.stdout, /^ {2}ag-reports {2}ag-admin {2}\(since/m);

  const limit = await w.cli(["status"], { terminal: expenses.t });
  assert.match(limit.stdout, /This terminal: #2 in line for expenses-export/);
  assert.match(limit.stdout, /\(limit reached\)/);

  const holding = await w.cli(["status", "--json"], { terminal: checkout.t });
  const out = JSON.parse(holding.stdout);
  assert.equal(out.result.cap, 2);
  assert.equal(out.result.queue, "on");
  assert.deepEqual({ kind: out.result.mine.kind, taskKey: out.result.mine.taskKey }, { kind: "holding", taskKey: "ag-checkout" });
  const none = await w.cli(["status", "--json"], { terminal: "t999" });
  assert.equal(JSON.parse(none.stdout).result.mine.kind, "none");
});

// ── Usage, small verbs, the launcher ───────────────────────────────────────

test("usage errors exit 2; continue and classify with nothing to act on", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-30"] });
  w.register([{ id: "g1", repos: [app] }]);
  const noTerminal = await w.cli(["on"], { cwd: app.ws["AX-30"] });
  assert.equal(noTerminal.code, 2);
  assert.match(noTerminal.stderr, /--terminal/);
  // A Herdr terminal outside git takes a slot-only turn (J-003, its own test).
  const t = w.agent(w.dir);
  assert.equal((await w.cli(["frobnicate"])).code, 2);
  for (const verb of ["continue", "classify"]) assert.equal((await w.cli([verb])).code, 2, verb);
  // T11: no place in the queue, nothing to continue; no turn end to classify.
  const cont = await w.cli(["continue", "--terminal", t]);
  assert.equal(cont.code, 1);
  assert.match(cont.stderr, /no place in the test queue/);
  const classify = await w.cli(["classify", "--terminal", t]);
  assert.equal(classify.code, 0, classify.stderr);
  assert.match(classify.stdout, /Nothing to classify/);
});

test("logs --path, logs after the notes, peek, and env --variant checked before it is stored", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-31"] });
  w.register([{ id: "g1", repos: [app] }]);
  const ws = app.ws["AX-31"];
  assert.equal((await w.cli(["toggle", "--workspace", ws])).code, 0);
  await w.until((s) => s.queue.lighting[`direct/${app.root}`]?.phase === "done", { what: "lit" });

  const p = await w.cli(["logs", "--path", "--repo", app.root]);
  assert.equal(p.code, 0, p.stderr);
  const logPath = p.stdout.trim();
  assert.equal(logPath, w.state().repos[app.root].logPath);
  assert.ok(logPath.startsWith(join(w.home, ".local", "state", "herdr-spotlight", "logs")));
  const logs = await w.cli(["logs", "--repo", "app"], { cwd: ws });
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.stdout, /fake server: npm run dev --/);
  assert.doesNotMatch(logs.stdout, /\r/);
  const fromCwd = await w.cli(["logs", "--path"], { cwd: ws });
  assert.equal(fromCwd.stdout.trim(), logPath);

  const peek = await w.cli(["peek", "--workspace", ws]);
  assert.equal(peek.code, 0, peek.stderr);
  const server = w.serverTerminal(app.root);
  assert.equal(readFileSync(`${w.hcPath}.herdr-app`, "utf8").trim(), `do terminal.peek --terminal ${server.address}`);

  const bad = await w.cli(["env", "--workspace", ws, "--variant", "co;rm -rf x"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /variant/);
  assert.deepEqual(w.state().variants, {});
});

test("bin/spotlight runs the CLI through a symlink", async () => {
  const w = makeWorld();
  const link = join(w.dir, "bin", "spotlight");
  symlinkSync(BIN, link);
  const r = await new Promise((resolve) => {
    execFile(link, ["status", "--json"], { env: w.env, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result.queue, "on");
  assert.equal(basename(BIN), "spotlight");
});

// ── Turn ends seen by `on` and `off`, the queue switch, a raised cap ───────

test("`on` and `off` check turn ends too: a waiter gets the turn of a holder whose agent finished, without a reap", async () => {
  const { w, repo } = turnWorld();
  w.settings({});
  const a = w.agent(repo.ws["AX-20"]);
  assert.equal((await w.cli(["on"], { terminal: a, cwd: repo.ws["AX-20"] })).code, 0);
  w.setAgent(a, { turn: 1, status: { app: "claude", state: "done" } });
  const b = w.agent(repo.ws["AX-21"]);
  const r = await w.cli(["on", "--timeout-ms", "3000"], { terminal: b, cwd: repo.ws["AX-21"] });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^Your test turn for AX-21 is on\.$/m);
  assert.equal(requestOf(w.state(), a), undefined);

  const c = w.agent(repo.ws["AX-22"]);
  assert.equal((await w.cli(["on", "--timeout-ms", "300"], { terminal: c, cwd: repo.ws["AX-22"] })).code, 1);
  w.setAgent(b, { turn: 1, status: { app: "claude", state: "done" } });
  const d = w.agent(repo.ws["AX-23"]);
  assert.equal((await w.cli(["off"], { terminal: d })).code, 0);
  const s = w.state();
  assert.equal(requestOf(s, b), undefined, "off released the finished holder");
  assert.equal(requestOf(s, c).state, "holding");
});

test("queue off: `on` takes no turn and never waits", async () => {
  const { w, repo } = turnWorld();
  w.settings({ queue: { enabled: false } });
  for (const task of ["AX-20", "AX-21"]) {
    const t = w.agent(repo.ws[task]);
    const r = await w.cli(["on", "--timeout-ms", "300"], { terminal: t, cwd: repo.ws[task] });
    assert.equal(r.code, 0, r.stderr + r.stdout);
  }
  assert.deepEqual(w.state().queue.requests, []);
});

test("a raised cap lets the next waiter in on the next reap; status shows a paused terminal as paused", async () => {
  const { w, repo, holding } = turnWorld();
  w.settings({ queue: { perSpace: { g1: 4 }, cap: 1 } });
  const a = await holding("AX-20");
  const b = w.agent(repo.ws["AX-21"]);
  assert.equal((await w.cli(["on", "--timeout-ms", "300"], { terminal: b, cwd: repo.ws["AX-21"] })).code, 1);
  w.settings({ queue: { perSpace: { g1: 4 }, cap: 2 } });
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal(requestOf(w.state(), b).state, "holding");

  w.setAgent(a, { turn: 1, status: { app: "claude", state: "error" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  const st = JSON.parse((await w.cli(["status", "--json"], { terminal: a })).stdout).result;
  assert.equal(st.mine.kind, "paused");
  assert.equal(st.mine.reason, "error");
  assert.equal(st.paused[0].terminal, a);
});

// ── The rules behind reap, in-process (cli-turns.mjs) ──────────────────────

test("D13 table: resume window, a gone terminal, an agent that left, re-baselining", async () => {
  const { decideTurnEnd, activityUpdate, needsLight, IDLE_MS } = await import("../mods/spotlight/cli-turns.mjs");
  const now = 1_000_000;
  const term = (fields) => ({ state: "live", pid: 10, turn: 1, status: { state: "done" }, foreground: { pid: 11, name: "claude" }, ...fields });
  const req = (fields) => ({ state: "holding", requestTurn: 0, fgPid: 11, resumingUntil: null, ...fields });
  const window = { resumingUntil: now + 60_000 };

  assert.equal(decideTurnEnd(req(), null, now, null).action, "release");
  assert.equal(decideTurnEnd(req(window), null, now, null).action, "keep");
  assert.equal(decideTurnEnd(req(), term({ state: "finished" }), now, null).action, "release");
  assert.equal(decideTurnEnd(req(window), term(), now, null).action, "keep");
  const shell = { foreground: { pid: 12, name: "zsh" }, status: { state: "working" }, turn: 0 };
  assert.deepEqual(decideTurnEnd(req(), term(shell), now, null), { action: "release", why: "agent-left" });
  assert.equal(decideTurnEnd(req(window), term(shell), now, null).action, "keep");
  assert.equal(decideTurnEnd(req({ fgPid: 10 }), term({ ...shell, foreground: { pid: 10, name: "zsh" } }), now, null).action, "keep");
  assert.deepEqual(decideTurnEnd(req({ requestTurn: null }), term(), now, null), { action: "baseline", turn: 1 });
  assert.equal(decideTurnEnd(req({ handledTurn: 1 }), term(), now, null).action, "keep");
  assert.equal(decideTurnEnd(req(), term({ status: { state: "idle" } }), now, undefined).action, "need-usage");
  assert.equal(decideTurnEnd(req(), term({ status: { state: "blocked", kind: "auth", msg: "usage limit" } }), now, undefined).reason, "signin");
  assert.equal(decideTurnEnd(req(), term({ status: { state: "error" } }), now, { fresh: true, atLimit: true }).reason, "limit");
  assert.equal(decideTurnEnd(req(), term({ status: { state: "error" } }), now, { fresh: true, atLimit: false }).reason, "error");
  assert.equal(decideTurnEnd(req(), term({ status: { state: "error" } }), now, { fresh: false }).action, "classify");
  assert.equal(decideTurnEnd(req({ state: "paused" }), term({ status: { state: "error" } }), now, null).action, "keep");

  // D19: status_ms moved, or the screen's hash did.
  assert.equal(IDLE_MS, 10 * 60_000);
  assert.deepEqual(activityUpdate({ statusMs: 5 }, { statusMs: 6 }, now), { lastActivityAt: now, statusMs: 6 });
  assert.deepEqual(activityUpdate({ statusMs: 5, outputHash: "a" }, { statusMs: 5, outputHash: "b" }, now), { lastActivityAt: now, outputHash: "b" });
  assert.equal(activityUpdate({ statusMs: 5, outputHash: "a" }, { statusMs: 5, outputHash: "a" }, now), null);

  // D12: a light per grant; again when the repos grew or the light died.
  const turn = { grantedAt: 7, members: [{ root: "/r", workspace: "/w", workspaces: ["/w"] }] };
  const alive = () => true;
  const dead = () => false;
  assert.equal(needsLight(undefined, turn, { now, pidAlive: alive }), true);
  const marker = { grantId: 7, phase: "running", pid: 99, startedAt: now, members: [{ root: "/r" }] };
  assert.equal(needsLight(marker, turn, { now, pidAlive: alive }), false);
  assert.equal(needsLight(marker, turn, { now, pidAlive: dead }), true);
  assert.equal(needsLight({ ...marker, grantId: 6 }, turn, { now, pidAlive: alive }), true);
  const grown = { ...turn, members: [...turn.members, { root: "/s", workspace: "/x", workspaces: ["/x"] }] };
  assert.equal(needsLight(marker, grown, { now, pidAlive: alive }), true);
  const done = { ...marker, phase: "done" };
  assert.equal(needsLight(done, turn, { now, pidAlive: dead, repos: {} }), false);
  assert.equal(needsLight(done, turn, { now, pidAlive: dead, repos: {}, checkLit: true }), true);
  assert.equal(needsLight(done, turn, { now, pidAlive: dead, repos: { "/r": { holder: "/w" } }, checkLit: true }), false);
});

// ── Review round 1 (code-review-strict): J-001 … J-005 ─────────────────────

const pidGone = async (pid) => {
  const end = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > end) throw new Error(`pid ${pid} still alive`);
    await sleep(50);
  }
};

test("J-001: past its deadline `on` never waits on the repo lock a `light` holds: one 'still being lit' line, the not-ready line, exit 0; a later `on` syncs it", async () => {
  const w = makeWorld();
  const app = makeRepo(w, "app", { pkg: DEV, tasks: ["AX-15"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-15"];
  const t = w.agent(ws);
  // The light holds the repo lock across its slow git step.
  w.slowGit("stash", 6);
  const r = await w.cli(["on", "--timeout-ms", "1500"], { terminal: t, cwd: ws });
  w.slowGit(null);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(r.ms < 5500, `on overran its deadline waiting on the repo lock (${r.ms} ms)`);
  assert.equal(r.stdout.match(/the root is still being lit: run `spotlight on` again to sync it/g)?.length, 1, r.stdout);
  assert.match(r.stdout, /^Not every server is listening yet\. Read its log, or run `spotlight on` again to keep waiting\.$/m);

  await w.until((s) => s.queue.lighting["g1/AX-15"]?.phase === "done", { what: "the light done" });
  write(ws, "later.txt", "from the holder\n");
  const again = await w.cli(["on"], { terminal: t, cwd: ws });
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /still being lit/);
  assert.equal(readFileSync(join(app.root, "later.txt"), "utf8"), "from the holder\n");
});

test("J-002: the settings' env is the default and a change restarts the server on the next `on` or reap; the popup's override wins until toggle off", async () => {
  const w = makeWorld();
  const pkg = { scripts: { local: "vite", dev: "vite --mode dev", prod: "vite --mode prod" } };
  const app = makeRepo(w, "app", { pkg, tasks: ["AX-16"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-16"];
  const t = w.agent(ws);
  const typed = () => w.hc().sent.map((x) => x.text);
  const runs = (env) => new RegExp(`/bin/zsh -c 'npm run ${env} --'$`);
  const record = () => w.state().repos[app.root];

  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  assert.match(typed().at(-1), runs("local"));
  assert.equal(record().serverEnv, "local");

  // A settings env change: the next `on` restarts the server in it.
  w.settings({ repos: { [app.root]: { env: "dev" } } });
  const on = await w.cli(["on"], { terminal: t, cwd: ws });
  assert.equal(on.code, 0, on.stderr + on.stdout);
  assert.match(typed().at(-1), runs("dev"));
  assert.equal(record().serverEnv, "dev");

  // Another one: the next reap restarts it (detached, D18).
  w.settings({ repos: { [app.root]: { env: "prod" } } });
  assert.equal((await w.cli(["reap"])).code, 0);
  await w.until((s) => s.repos[app.root]?.serverEnv === "prod", { what: "the server in prod after the reap" });
  assert.match(typed().at(-1), runs("prod"));

  // The popup picks Dev: an override on the state record, over the settings' Prod.
  const pick = await w.cli(["env", "--workspace", ws, "--env", "dev"]);
  assert.equal(pick.code, 0, pick.stderr + pick.stdout);
  assert.equal(record().envOverride, "dev");
  assert.equal(record().serverEnv, "dev");
  assert.match(typed().at(-1), runs("dev"));
  const sent = typed().length;
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  await sleep(1500);
  assert.equal(typed().length, sent, "the override holds: neither the reap nor `on` went back to the settings' env");
  assert.equal(record().serverEnv, "dev");

  // Toggle off clears the override: the next lighting runs the settings' env.
  assert.equal((await w.cli(["toggle", "--workspace", ws])).code, 0);
  await w.until((s) => !s.repos[app.root], { what: "turned off" });
  const back = await w.cli(["on"], { terminal: t, cwd: ws });
  assert.equal(back.code, 0, back.stderr + back.stdout);
  assert.match(typed().at(-1), runs("prod"));
  assert.equal(record().serverEnv, "prod");
  assert.equal(record().envOverride ?? null, null);
});

test("J-008: a foreign process in the server terminal leaves the recorded env alone: nothing ran in the new one", async () => {
  const w = makeWorld();
  const pkg = { scripts: { local: "vite", dev: "vite --mode dev" } };
  const app = makeRepo(w, "app", { pkg, tasks: ["AX-17"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-17"];
  const t = w.agent(ws);
  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  const record = () => w.state().repos[app.root];
  assert.equal(record().serverEnv, "local");

  const server = w.serverTerminal(app.root);
  w.hcUpdate((s) => {
    s.terminals[server.address].foreground = { pid: s.nextPid++, name: "vim", argv: ["vim"], cwd: app.root };
  });
  const sent = w.hc().sent.length;
  await w.cli(["env", "--workspace", ws, "--env", "dev"]);
  assert.equal(w.hc().sent.length, sent, "nothing typed over the foreign process");
  assert.equal(record().envOverride, "dev");
  assert.equal(record().serverEnv, "local", "serverEnv says what ran");
});

test("J-009: env drift the reap can't resolve isn't retried: a foreign process is never synced for, a server that ignores Ctrl-C isn't interrupted again", async () => {
  const w = makeWorld();
  const pkg = { scripts: { local: "vite", dev: "vite --mode dev" } };
  const app = makeRepo(w, "app", { pkg, tasks: ["AX-18"] });
  w.register([{ id: "g1", repos: [app] }]);
  w.listen(app.root, [3000]);
  const ws = app.ws["AX-18"];
  const t = w.agent(ws);
  assert.equal((await w.cli(["on"], { terminal: t, cwd: ws })).code, 0);
  const record = () => w.state().repos[app.root];
  const server = w.serverTerminal(app.root).address;
  const interrupts = () => w.hc().calls.filter((c) => c[0] === "interrupt").length;
  const own = w.hc().terminals[server].foreground;

  // Someone else's process holds a port there: the reap leaves it, no detached sync.
  w.hcUpdate((s) => {
    s.terminals[server].foreground = { pid: s.nextPid++, name: "script", argv: ["script", "-q", "/other.log", "x"], cwd: app.root };
  });
  w.settings({ repos: { [app.root]: { env: "dev" } } });
  assert.equal((await w.cli(["reap"])).code, 0);
  const calls = w.hc().calls.length;
  await sleep(1500);
  assert.equal(w.hc().calls.length, calls, "no sync was spawned for a foreign process");

  // Spotlight's server again, and it ignores Ctrl-C: one try, then the reap stops.
  w.hcUpdate((s) => {
    s.terminals[server].foreground = own;
    s.terminals[server].ignoresInterrupt = true;
  });
  assert.equal((await w.cli(["reap"])).code, 0);
  await w.until((s) => s.repos[app.root]?.envFailed === "dev", { what: "the failed restart's mark" });
  assert.equal(interrupts(), 1);
  assert.equal(record().serverEnv, "local");
  assert.equal((await w.cli(["reap"])).code, 0);
  await sleep(1500);
  assert.equal(interrupts(), 1, "the reap didn't interrupt it again");

  // Ctrl-C works again: Reiniciar runs the env asked for, and the mark goes.
  w.hcUpdate((s) => {
    delete s.terminals[server].ignoresInterrupt;
  });
  const again = await w.cli(["restart", "--repo", app.root]);
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.equal(record().serverEnv, "dev");
  assert.equal(record().envFailed ?? null, null);
});

test("J-003: a Herdr terminal on a main checkout or outside git takes a slot-only turn keyed by its folder; two terminals in one folder share it", async () => {
  const w = makeWorld();
  const harness = makeRepo(w, "harness", { pkg: DEV });
  w.register([{ id: "arrecife", repos: [harness] }]);
  w.settings({ queue: { perSpace: { arrecife: 1, spaceless: 1 }, cap: 4 } });
  const slotOnly = (label) => new RegExp(`^No project of ${label} can hold a Spotlight here, so this turn only holds a test slot: run your tests\\.$`, "m");
  const mine = async (t) => JSON.parse((await w.cli(["status", "--json"], { terminal: t })).stdout).result;

  // A main checkout (as ~/.claude): its group's lane, nothing lit.
  const t1 = w.agent(harness.root);
  const main = await w.cli(["on"], { terminal: t1, cwd: harness.root });
  assert.equal(main.code, 0, main.stderr + main.stdout);
  assert.match(main.stdout, /^Your test turn for harness is on\.$/m);
  assert.match(main.stdout, slotOnly("harness"));
  const req = requestOf(w.state(), t1);
  assert.equal(req.taskKey, `arrecife/cwd:${harness.root}`);
  assert.equal(req.lane, "arrecife");
  assert.equal(req.state, "holding");
  assert.deepEqual(refsOf(harness.root), []);
  assert.equal(w.serverTerminal(harness.root), null, "nothing was lit");
  assert.equal((await mine(t1)).mine.kind, "holding");

  // A second terminal in the same folder joins that task, past the space's limit of 1.
  const t2 = w.agent(harness.root);
  const joined = await w.cli(["on", "--timeout-ms", "300"], { terminal: t2, cwd: harness.root });
  assert.equal(joined.code, 0, joined.stderr + joined.stdout);
  assert.equal(requestOf(w.state(), t2).taskKey, req.taskKey);
  const both = await mine(t2);
  assert.equal(both.mine.kind, "holding");
  assert.equal(both.turns.length, 1);
  assert.deepEqual([...both.turns[0].terminals].sort(), [t1, t2].sort());

  // Outside git: the folder's own task, in no space.
  const plain = join(w.dir, "plain");
  mkdirSync(plain);
  const t3 = w.agent(plain);
  const out = await w.cli(["on"], { terminal: t3, cwd: plain });
  assert.equal(out.code, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /^Your test turn for plain is on\.$/m);
  assert.match(out.stdout, slotOnly("plain"));
  assert.equal(requestOf(w.state(), t3).taskKey, `spaceless/cwd:${plain}`);
  assert.equal((await mine(t3)).mine.kind, "holding");

  // No terminal at all is still a usage error.
  const none = await w.cli(["on"], { cwd: plain });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--terminal/);
});

test("J-004: `spotlight on` typed in a plain shell records the shell's pid, so the prompt coming back doesn't release the turn", async () => {
  const { w, repo } = turnWorld();
  const cwd = repo.ws["AX-20"];
  let t;
  let shellPid;
  w.hcUpdate((s) => {
    t = `t${s.nextAddr++}`;
    shellPid = s.nextPid++;
    s.terminals[t] = {
      address: t, name: null, labels: {}, cwd, pid: shellPid, state: "live", argv: ["/bin/zsh", "-l"], turn: 0,
      status: null, status_ms: null, callerForeground: true,
    };
  });
  const r = await w.cli(["on"], { terminal: t, cwd });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(requestOf(w.state(), t).fgPid, shellPid);
  // The CLI exits: the shell's prompt leads the foreground again.
  w.hcUpdate((s) => {
    delete s.terminals[t].callerForeground;
    s.terminals[t].foreground = { pid: shellPid, name: "zsh", argv: ["/bin/zsh", "-l"], cwd };
  });
  assert.equal((await w.cli(["reap"])).code, 0);
  assert.equal(requestOf(w.state(), t)?.state, "holding", "the returning shell is not an agent that left");
});

test("J-005: a classify that dies is respawned for the same turn and decides it; past the respawn cap the reap decides with the last usage read", async () => {
  const { w, holding, usage } = turnWorld({ accounts: true });
  const delay = join(w.app, "claude-accounts", "usage-delay");
  usage(30, 10 * 60_000);
  writeFileSync(delay, "30");
  const t = await holding("AX-20");
  w.setAgent(t, { turn: 1, status: { app: "claude", state: "done" } });
  assert.equal((await w.cli(["reap"])).code, 0);
  const first = requestOf(w.state(), t);
  assert.ok(Number.isInteger(first.classifyPid) && first.classifyPid > 0, JSON.stringify(first));
  // It dies (with its stuck usage read) before deciding.
  process.kill(-first.classifyPid, "SIGKILL");
  await pidGone(first.classifyPid);
  writeFileSync(delay, "0");
  const reap = await w.cli(["reap"]);
  assert.equal(reap.code, 0, reap.stderr);
  assert.match(reap.stdout, / 1 to classify,/, "respawned once");
  await w.until((s) => !requestOf(s, t), { what: "the respawned classify's release", ms: 15_000 });

  // Every respawn spent and the last classify dead: the reap decides with
  // the usage it has (stale, at 100%: paused for the limit).
  usage(100, 10 * 60_000);
  const t2 = await holding("AX-21");
  w.setAgent(t2, { turn: 1, status: { app: "claude", state: "done" } });
  const dead = spawnSync(NODE, ["-e", ""]).pid;
  const s = w.state();
  Object.assign(requestOf(s, t2), { classifyTurn: 1, classifyAt: Date.now() - 1000, classifyPid: dead, classifySpawns: 4 });
  w.writeState(s);
  const last = await w.cli(["reap"]);
  assert.equal(last.code, 0, last.stderr);
  assert.match(last.stdout, / 0 to classify,/);
  const req = requestOf(w.state(), t2);
  assert.equal(req.state, "paused");
  assert.equal(req.pauseReason, "limit");
});

test("J-004, J-005: the pure rules (requestFgPid, classifyStep)", async () => {
  const { requestFgPid, classifyStep, CLASSIFY_STALE_MS, CLASSIFY_RESPAWNS } = await import("../mods/spotlight/cli-turns.mjs");
  const self = { pid: 100, ppid: 99, cliPath: "/app/mods/spotlight/cli.mjs" };
  const term = (foreground) => ({ pid: 10, foreground });
  // The CLI leads the foreground: its own pid, its bin/spotlight parent, or argv running cli.mjs.
  assert.equal(requestFgPid(term({ pid: 100, name: "node", argv: ["node"] }), self), 10);
  assert.equal(requestFgPid(term({ pid: 99, name: "sh", argv: ["/bin/sh", "/Users/u/.local/bin/spotlight", "on"] }), self), 10);
  assert.equal(requestFgPid(term({ pid: 77, name: "node", argv: ["node", "/elsewhere/mods/spotlight/cli.mjs", "on"] }), self), 10);
  // An agent leads it: its pid, even when it is the CLI's parent.
  assert.equal(requestFgPid(term({ pid: 99, name: "claude", argv: ["claude"] }), self), 99);
  assert.equal(requestFgPid(term({ pid: 55, name: "claude", argv: ["claude"] }), self), 55);
  assert.equal(requestFgPid({ pid: 10 }, self), null);
  assert.equal(requestFgPid(null, self), null);

  // classify's bound covers its own worst case: usage --refresh (20 s), three hc gets (10 s each), the accounts lookup (5 s), a state lock (10 s).
  assert.ok(CLASSIFY_STALE_MS >= 20_000 + 3 * 10_000 + 1_000 + 5_000 + 10_000);
  assert.equal(CLASSIFY_RESPAWNS, 3);
  const now = 1_000_000;
  const alive = () => true;
  const dead = () => false;
  const req = (fields) => ({ classifyTurn: 1, classifyAt: now - 1000, classifyPid: 5, classifySpawns: 1, ...fields });
  assert.deepEqual(classifyStep({}, 1, { now, pidAlive: alive }), { action: "spawn", spawns: 1 });
  assert.deepEqual(classifyStep(req({ classifyTurn: 0 }), 1, { now, pidAlive: alive }), { action: "spawn", spawns: 1 });
  assert.deepEqual(classifyStep(req(), 1, { now, pidAlive: alive }), { action: "wait" });
  assert.deepEqual(classifyStep(req(), 1, { now, pidAlive: dead }), { action: "spawn", spawns: 2 });
  assert.deepEqual(classifyStep(req({ classifyAt: now - CLASSIFY_STALE_MS }), 1, { now, pidAlive: alive }), { action: "spawn", spawns: 2 });
  // Spawned a moment ago, its pid not written yet: wait; a pid that never came: spawn again.
  assert.deepEqual(classifyStep(req({ classifyPid: null }), 1, { now, pidAlive: dead }), { action: "wait" });
  assert.deepEqual(classifyStep(req({ classifyPid: null, classifyAt: now - 10_000 }), 1, { now, pidAlive: dead }), { action: "spawn", spawns: 2 });
  assert.deepEqual(classifyStep(req({ classifySpawns: 1 + CLASSIFY_RESPAWNS }), 1, { now, pidAlive: dead }), { action: "fallback" });
  assert.deepEqual(classifyStep(req({ classifySpawns: 1 + CLASSIFY_RESPAWNS }), 1, { now, pidAlive: alive }), { action: "wait" });
});
