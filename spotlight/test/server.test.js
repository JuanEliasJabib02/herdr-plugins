// T5b: the repo's server terminal (D10). M/server.js drives one hidden hc
// terminal per repo through an injected exec: it creates it in the root,
// types the server line wrapped in `script -F -q -a <logPath> /bin/zsh -c
// '<line>'` only when the shell owns the foreground, never over a process
// Spotlight didn't start (ownership by the foreground's argv: `script` plus
// this repo's logPath; the recorded pid is only a cross-check), restarts it
// with `hc interrupt` + resend, stops it on toggle off, and reads it as gone,
// stopped, starting or listening. A fake hc stands in for herdr-core; the
// quoting test runs a real zsh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_LABEL, serverTerminalName, normalizeServerLine, shellQuote, wrapServerLine, createTerminalArgv,
  isShellForeground, ownsForeground, classifyTerminal, ensureServerTerminal, inspectServer, readServerState,
  startServer, restartServer, stopServer, serverLogs, peekArgv, peekServer, STOP_WAIT_MS,
} from "../mods/spotlight/server.js";
import * as serverModule from "../mods/spotlight/server.js";
// ports.js runs every lstart read as `/usr/bin/env LC_ALL=C TZ=UTC ps …`
// (H7): unwrapEnv gives the program and args under the env words.
import { unwrapEnv } from "./fake-ps.mjs";

const ROOT = "/Users/demo/code/app";
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sl-server-")));

// How zsh splits a typed line into argv (quote removal, nothing run).
const zshWords = (line) =>
  execFileSync("/bin/zsh", ["-f", "-c", `print -rN -- ${line}`], { encoding: "utf8" }).split("\0").slice(0, -1);

// ── A fake hc ──────────────────────────────────────────────────────────────
// Terminals by address, names unique among live ones, the JSON shapes and
// exit codes the real hc printed in the T5b probe (RECIPE.md "Server terminal
// probe"): `get` of a missing terminal exits 3 with error kind not_found, a
// live name taken exits 1 with name_taken, `send` to a finished one exits 11.
// A typed `script …` line becomes the foreground with zsh's argv; an
// interrupt hands the prompt back after `lingers` more reads (live, `script`
// was still the foreground right after `hc interrupt` said "stopped").
// `shellReads`: a terminal `hc run` makes shows `startupFg` (none, as live) for
// that many reads before its shell is up.
// Processes (D26): a foreground the prompt replaced has died; `children` maps
// a pid to more processes under it and `procs` gives a pid outside the
// terminals its `cwd` (`lsof -d cwd`), whether it `ignoresTerm`, and whether
// it is someone else's (`eperm`: every kill throws EPERM). `kill`
// is process.kill's shape: SIGKILL kills anything, SIGTERM what doesn't ignore
// it (`fgIgnoresTerm` for a terminal's foreground), a dead pid throws ESRCH;
// `signals` records every real signal. A dead pid lists no ports and has no
// children (its orphans belong to launchd). `ps -o pid=,ppid=,stat=,lstart=`
// answers each live pid's parent and start time (`starts[pid]`, else one
// fixed time: a test reuses a pid by giving it another), `ps -o
// pid=,command=` its `procs[pid].command`, else its foreground's argv.
// Herdr's screens (D38), with `herdr: true`: `herdr-app ls` answers `world`,
// its spaces → tabs → terminals in the shape the live Herdr printed
// (`addSpace` builds them over terminals of this fake). A terminal given
// `herdr.space` (`hc run --label`, `hc label`) shows at once in a new tab at
// the end of that space, or of a new space when Herdr doesn't know the id; a
// killed terminal leaves its tab, a tab left with no terminal goes, and so
// does a space left with no tab. `herdr-app do` applies tab.rename and
// tab.move and records each call in `did`. Without `herdr`, `herdr-app ls`
// answers "{}": a Herdr that can't say where anything is.
const FAKE_START = "Sun Nov  8 22:00:00 2026";
function fakeHc({
  lingers = 1, ports = {}, readText = "", shellReads = null, startupFg = null, children = {}, procs = {}, fgIgnoresTerm = false,
  starts = {}, herdr = false,
} = {}) {
  const terms = new Map();
  const calls = [];
  const sent = [];
  const dead = new Set();
  const signals = [];
  const world = herdr ? [] : null;
  const did = [];
  let nextTab = 1;
  const frontOf = (pid) => [...terms.values()].find((t) => t.foreground && t.foreground.pid === pid && t.foreground.pid !== t.pid);
  const exists = (pid) =>
    !dead.has(pid) &&
    ([...terms.values()].some((t) => t.state === "live" && (t.pid === pid || t.foreground?.pid === pid)) ||
      Object.values(children).some((kids) => kids.includes(pid)) || pid in procs || pid in ports);
  const parentOf = (pid) => {
    const front = frontOf(pid);
    if (front) return front.pid;
    for (const [p, kids] of Object.entries(children)) if (kids.includes(pid)) return dead.has(Number(p)) ? 1 : Number(p);
    return 1;
  };
  const commandOf = (pid) => procs[pid]?.command ?? frontOf(pid)?.foreground.argv?.join(" ") ?? "node";
  let nextAddr = 1;
  let nextPid = 1000;
  const ok = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: "" });
  const fail = (code, kind, message) => ({ code, stdout: "", stderr: JSON.stringify({ error: { kind, message } }) });
  const find = (t) =>
    terms.get(t) ??
    [...terms.values()].find((x) => x.name === t && x.state === "live") ??
    [...terms.values()].find((x) => x.name === t);
  const shellOf = (t) => ({ argv: ["/bin/zsh", "-l"], cwd: t.cwd, name: "zsh", pid: t.pid });
  const view = (t) => {
    if (t.pendingShell !== undefined && t.pendingShell-- <= 0) {
      if (t.foreground && t.foreground.pid !== t.pid) dead.add(t.foreground.pid);
      t.foreground = shellOf(t);
      delete t.pendingShell;
    }
    const { pendingShell, ...rest } = t;
    if (rest.state === "finished") delete rest.foreground;
    return rest;
  };
  // Adds a terminal as `hc run` would leave it; `fg` overrides the foreground.
  const add = ({ name = null, labels = {}, cwd = ROOT, fg, state = "live" } = {}) => {
    const t = { address: `t${nextAddr++}`, name, labels, cwd, pid: nextPid++, state, argv: ["/bin/zsh", "-l"], keep: true };
    t.foreground = fg ? { cwd, pid: nextPid++, ...fg } : shellOf(t);
    terms.set(t.address, t);
    return t;
  };
  // Herdr's view of a terminal in a tab.
  const shown = (t, app = null) => ({ terminal: t.address, pane: `p-${t.address}`, status: app ? "idle" : null, app, name: t.name, sub_agents: [] });
  // A terminal given herdr.space=<id> shows in a new tab at the end of it.
  const showIn = (t, id) => {
    if (!world || world.some((s) => s.tabs.some((tab) => tab.terminals.some((x) => x.terminal === t.address)))) return;
    let s = world.find((x) => x.id === id);
    if (!s) {
      s = { id, name: t.cwd.split("/").pop(), folder: t.cwd, machine: null, active: false, tabs: [] };
      world.push(s);
    }
    const tab = { id: `tbn${nextTab++}`, name: String(s.tabs.length + 1), active: false, settled: false, terminals: [shown(t)] };
    s.tabs.push(tab);
    t.labels = { ...t.labels, "herdr.tab": tab.id };
  };
  const unshow = (address) => {
    if (!world) return;
    for (const s of world) {
      for (const tab of s.tabs) {
        const before = tab.terminals.length;
        tab.terminals = tab.terminals.filter((x) => x.terminal !== address);
        if (before > 0 && tab.terminals.length === 0) tab.gone = true;
      }
      s.tabs = s.tabs.filter((tab) => !tab.gone);
    }
    world.splice(0, world.length, ...world.filter((s) => s.tabs.length > 0));
  };
  // A space of Herdr's: `tabs` lists each tab's terminals ({ cwd, app, fg,
  // labels, name }), made as this fake's terminals labelled with the space
  // and the tab; `active` is the active tab's place (0 = first).
  const addSpace = ({ id, folder = ROOT, active = 0, tabs = [] }) => {
    const s = { id, name: folder.split("/").pop(), folder, machine: null, active: false, tabs: [] };
    tabs.forEach((list, i) => {
      const tab = { id: `${id}-tb${i + 1}`, name: String(i + 1), active: i === active, settled: false, terminals: [] };
      for (const { cwd = folder, app = null, fg, labels = {}, name = null } of list) {
        const t = add({ name, cwd, fg, labels: { ...labels, "herdr.space": id, "herdr.tab": tab.id } });
        tab.terminals.push(shown(t, app));
      }
      s.tabs.push(tab);
    });
    world.push(s);
    return s;
  };
  const labelsOf = (args) => {
    const out = {};
    args.forEach((a, i) => {
      if (a !== "--label") return;
      const [k, ...v] = args[i + 1].split("=");
      out[k] = v.join("=");
    });
    return out;
  };
  const exec = async (rawFile, rawArgs) => {
    const { file, args } = unwrapEnv(rawFile, rawArgs);
    calls.push([file, ...args]);
    if (file === "herdr-app" && args[0] === "ls") return world ? ok({ spaces: world }) : { code: 0, stdout: "{}", stderr: "" };
    if (file === "herdr-app" && args[0] === "do") {
      let a = {};
      try {
        a = JSON.parse(args[2] ?? "{}");
      } catch {
        // `--name value` words (terminal.peek): recorded as given.
      }
      did.push({ command: args[1], args: a });
      for (const s of world ?? []) {
        const i = s.tabs.findIndex((tab) => tab.id === a.id);
        if (i < 0) continue;
        if (args[1] === "tab.rename") s.tabs[i].name = a.name;
        if (args[1] === "tab.move") s.tabs.splice(a.index - 1, 0, ...s.tabs.splice(i, 1));
      }
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (file === "herdr-app") return { code: 0, stdout: "{}", stderr: "" };
    if (file === "ps") {
      const fields = args[args.indexOf("-o") + 1];
      const pids = args[args.indexOf("-p") + 1].split(",").map(Number).filter(exists);
      const rows = pids.map((p) => (fields.includes("lstart") ? `${p} ${parentOf(p)} S ${starts[p] ?? FAKE_START}` : `${p} ${commandOf(p)}`));
      return { code: rows.length ? 0 : 1, stdout: rows.map((r) => `${r}\n`).join(""), stderr: "" };
    }
    if (file === "pgrep") {
      const pid = Number(args[1]);
      if (dead.has(pid)) return { code: 1, stdout: "", stderr: "" };
      const kids = [...terms.values()]
        .filter((t) => t.foreground && t.foreground.pid !== t.pid && t.pid === pid)
        .map((t) => t.foreground.pid)
        .concat(children[pid] ?? [])
        .filter((k) => !dead.has(k));
      return kids.length ? { code: 0, stdout: kids.map((k) => `${k}\n`).join(""), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof" && args.includes("-d")) {
      const pid = Number(args[args.indexOf("-p") + 1]);
      const cwd = dead.has(pid) ? null : procs[pid]?.cwd ?? [...terms.values()].find((t) => t.foreground?.pid === pid)?.cwd;
      return cwd ? { code: 0, stdout: `p${pid}\nfcwd\nn${cwd}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof") {
      const lines = [];
      for (const [pid, list] of Object.entries(ports)) {
        if (dead.has(Number(pid))) continue;
        lines.push(`p${pid}`, "cnode");
        for (const port of list) lines.push("f1", `n*:${port}`);
      }
      return { code: lines.length ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
    }
    assert.equal(file, "hc");
    const [verb, ...rest] = args;
    const t = find(rest[0]);
    switch (verb) {
      case "get":
        return t ? ok(view(t)) : fail(3, "not_found", `no terminal "${rest[0]}"`);
      case "run": {
        const opt = (k) => args[args.indexOf(k) + 1];
        const name = opt("--name");
        if ([...terms.values()].some((x) => x.name === name && x.state === "live")) {
          return fail(1, "name_taken", `a live terminal is already named "${name}"`);
        }
        const made = add({ name, labels: labelsOf(args), cwd: opt("--cwd") });
        if (shellReads !== null) {
          made.foreground = startupFg;
          made.pendingShell = shellReads;
        }
        if (made.labels["herdr.space"]) showIn(made, made.labels["herdr.space"]);
        return ok({ address: made.address, agent: "zsh", cwd: made.cwd, name, state: "live", turn: 0 });
      }
      case "ls":
        return ok({
          hidden_finished: 0,
          terminals: [...terms.values()].filter((x) => x.state === "live").map((x) => ({ address: x.address, agent: "zsh", cwd: x.cwd, name: x.name, state: x.state, turn: 0 })),
        });
      case "label": {
        if (!t) return fail(3, "not_found", "no terminal");
        for (const kv of rest.slice(1).filter((w) => w !== "--json")) {
          const [k, ...v] = kv.split("=");
          if (v.join("=") === "") delete t.labels[k];
          else t.labels = { ...t.labels, [k]: v.join("=") };
        }
        if (t.state === "live" && t.labels["herdr.space"]) showIn(t, t.labels["herdr.space"]);
        return ok({ address: t.address, labels: t.labels });
      }
      case "kill":
        if (!t) return fail(3, "not_found", "no terminal");
        if (t.foreground && t.foreground.pid !== t.pid) dead.add(t.foreground.pid);
        t.state = "finished";
        t.reason = "killed";
        unshow(t.address);
        return ok({ killed: t.address });
      case "send": {
        if (!t) return fail(3, "not_found", "no terminal");
        if (t.state !== "live") return fail(11, "finished", `${t.address} has finished`);
        sent.push({ terminal: t.address, text: rest[1] });
        if (rest[1].startsWith("script ")) {
          const argv = zshWords(rest[1]);
          t.foreground = { argv, cwd: t.cwd, name: "script", pid: nextPid++ };
        }
        return ok({ started: null, status: null, turn: 0 });
      }
      case "interrupt":
        if (!t) return fail(3, "not_found", "no terminal");
        if (t.foreground && t.foreground.pid !== t.pid) t.pendingShell = lingers;
        return ok({ key: "ctrl+c", outcome: "stopped" });
      case "rm":
        if (!t) return fail(3, "not_found", "no terminal");
        if (t.state === "live") return fail(1, "live", `${t.address} is still running`);
        terms.delete(t.address);
        return ok({ removed: t.address });
      case "read":
        return t ? ok({ text: readText, complete: true, how: "history" }) : fail(3, "not_found", "no terminal");
      default:
        throw new Error(`fake hc: unexpected ${verb}`);
    }
  };
  const kill = (pid, sig) => {
    if (dead.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    // Not ours to signal: it lives through anything, SIGKILL included.
    if (procs[pid]?.eperm) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    if (sig === 0) return true;
    signals.push({ pid, sig });
    // A terminal's own shell: recorded (the tests say it never is) and left alive.
    if ([...terms.values()].some((t) => t.pid === pid)) return true;
    const front = [...terms.values()].find((t) => t.foreground?.pid === pid);
    const ignores = front ? fgIgnoresTerm : Boolean(procs[pid]?.ignoresTerm);
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !ignores)) {
      dead.add(pid);
      if (front) {
        front.foreground = shellOf(front);
        delete front.pendingShell;
      }
    }
    return true;
  };
  return {
    exec, kill, calls, sent, terms, add, ports, children, procs, starts, dead, signals, world, did, addSpace,
    verbs: () => calls.filter((c) => c[0] === "hc").map((c) => c[1]),
  };
}

// A clock the waits advance instead of sleeping.
function fakeClock(start = new Date(2026, 10, 6, 22, 58, 4).getTime()) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// ── Quoting (Risk item 2) ──────────────────────────────────────────────────

test("wrapServerLine: a line with ', $ and ; reaches zsh unchanged, through the real outer shell", () => {
  const dir = tmp();
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const argvOut = join(dir, "argv.json");
  // A stand-in for `script`: records its argv, drops `-F -q -a <log>`, runs the rest.
  writeFileSync(
    join(bin, "script"),
    `#!/bin/sh\n"${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "$ARGV_OUT" "$@"\nshift 4\nexec "$@"\n`,
  );
  chmodSync(join(bin, "script"), 0o755);
  const logPath = join(dir, "it's logs", "app.log");
  const line = `printf '%s|%s\\n' "it's" '$HOME'; echo "a;b" $((1+2)) \`echo tick\` 'q"q' \\!`;
  const wrapped = wrapServerLine(line, logPath);
  const out = execFileSync("/bin/zsh", ["-f", "-c", wrapped], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARGV_OUT: argvOut, HOME: "/home/demo" },
  });
  assert.deepEqual(JSON.parse(readFileSync(argvOut, "utf8")), ["-F", "-q", "-a", logPath, "/bin/zsh", "-c", line]);
  assert.equal(out, `it's|$HOME\na;b 3 tick q"q !\n`);
  rmSync(dir, { recursive: true, force: true });
});

test("wrapServerLine: the shape D10 names; shellQuote escapes ' as '\\''", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(
    wrapServerLine("pnpm dev --port 3000", "/Users/demo/.local/state/herdr-spotlight/logs/app-abc123.log"),
    "script -F -q -a '/Users/demo/.local/state/herdr-spotlight/logs/app-abc123.log' /bin/zsh -c 'pnpm dev --port 3000'",
  );
});

test("normalizeServerLine: one non-empty line with no control bytes, trimmed (Orca's rule); anything else is never typed", () => {
  assert.equal(normalizeServerLine("  pnpm dev  "), "pnpm dev");
  // Trimmed first, as Orca does: a trailing newline is whitespace, not a second line.
  assert.equal(normalizeServerLine("pnpm dev\r\n"), "pnpm dev");
  for (const bad of ["", "   ", "pnpm dev\nrm -rf ~", "pnpm\rdev", "a\u0003b", "a\u007fb", "a\u001b[Ab", null, 3, undefined]) {
    assert.equal(normalizeServerLine(bad), null, JSON.stringify(bad));
    assert.equal(wrapServerLine(bad, "/l.log"), null, JSON.stringify(bad));
  }
});

// ── Names and argv ─────────────────────────────────────────────────────────

test("serverTerminalName: sl-<slug>, a valid hc name (1-32 of a-z 0-9 - _), one per root", () => {
  const name = serverTerminalName(ROOT);
  assert.match(name, /^sl-app-[0-9a-f]{6}$/);
  assert.notEqual(serverTerminalName("/Users/demo/other/app"), name);
  const long = serverTerminalName("/x/An Extremely Long Repository Folder Name For Testing");
  assert.match(long, /^[a-z0-9_-]{1,32}$/);
});

test("createTerminalArgv: hidden (no herdr.space), no parent, kept, labeled with the root, a login zsh in the root", () => {
  assert.deepEqual(createTerminalArgv(ROOT), [
    "hc", "run", "--bg", "--no-parent", "--keep", "--name", serverTerminalName(ROOT),
    "--label", `${SERVER_LABEL}=${ROOT}`, "--cwd", ROOT, "--json", "--", "/bin/zsh", "-l",
  ]);
  assert.equal(SERVER_LABEL, "spotlight.repo");
});

// ── Ownership and reading ─────────────────────────────────────────────────

const LOG = "/Users/demo/.local/state/herdr-spotlight/logs/app-abc123.log";
// Recorded `hc get --json` foregrounds (T5b probe), paths swapped in.
const SCRIPT_FG = { argv: ["script", "-F", "-q", "-a", LOG, "/bin/zsh", "-c", "pnpm dev"], cwd: ROOT, name: "script", pid: 25182 };
const VIM_FG = { argv: ["vim", "README.md"], cwd: ROOT, name: "vim", pid: 25300 };
const term = (over = {}) => ({
  address: "t2b", argv: ["/bin/zsh", "-l"], cwd: ROOT, keep: true, labels: { [SERVER_LABEL]: ROOT }, name: "sl-app", pid: 22976, state: "live",
  foreground: { argv: ["/bin/zsh", "-l"], cwd: ROOT, name: "zsh", pid: 22976 }, ...over,
});

test("ownsForeground: a foreground `script … <logPath>` with a stale serverPid is still Spotlight's; a vim is not", () => {
  assert.equal(ownsForeground(SCRIPT_FG, { logPath: LOG, serverPid: 11111 }), true);
  assert.equal(ownsForeground(SCRIPT_FG, { logPath: LOG }), true);
  assert.equal(ownsForeground({ ...SCRIPT_FG, argv: ["/usr/bin/script", ...SCRIPT_FG.argv.slice(1)] }, { logPath: LOG }), true);
  assert.equal(ownsForeground(VIM_FG, { logPath: LOG, serverPid: 25300 }), false, "a matching pid never makes a vim ours");
  // Another repo's script, or a script that merely mentions the path in its line.
  assert.equal(ownsForeground({ ...SCRIPT_FG, argv: SCRIPT_FG.argv.with(4, "/other.log") }, { logPath: LOG }), false);
  assert.equal(ownsForeground({ ...SCRIPT_FG, argv: ["script", "-a", "/x.log", "/bin/zsh", "-c", `cat ${LOG}`] }, { logPath: LOG }), false);
  // An unreadable argv falls back to the recorded pid.
  assert.equal(ownsForeground({ ...SCRIPT_FG, argv: [] }, { logPath: LOG, serverPid: 25182 }), true);
  assert.equal(ownsForeground({ ...SCRIPT_FG, argv: [] }, { logPath: LOG, serverPid: 1 }), false);
  assert.equal(ownsForeground(null, { logPath: LOG, serverPid: 25182 }), false);
});

test("isShellForeground: the terminal's own process leads the foreground", () => {
  assert.equal(isShellForeground(term()), true);
  assert.equal(isShellForeground(term({ foreground: SCRIPT_FG })), false);
  // A `sh` shim in front is a job, though its name is a shell's.
  assert.equal(isShellForeground(term({ foreground: { argv: ["sh", "-c", "next dev"], name: "sh", pid: 30000, cwd: ROOT } })), false);
  assert.equal(isShellForeground(term({ foreground: null })), false);
});

test("classifyTerminal: gone, shell, spotlight (stale pid flagged) or foreign", () => {
  const ctx = { logPath: LOG, serverPid: 11111 };
  assert.equal(classifyTerminal(null, ctx).kind, "gone");
  assert.equal(classifyTerminal(term({ state: "finished", foreground: undefined }), ctx).kind, "gone");
  assert.equal(classifyTerminal(term(), ctx).kind, "shell");
  assert.deepEqual(classifyTerminal(term({ foreground: SCRIPT_FG }), ctx), { kind: "spotlight", terminal: "t2b", pid: 25182, stalePid: true, rootPid: 22976 });
  assert.equal(classifyTerminal(term({ foreground: SCRIPT_FG }), { logPath: LOG, serverPid: 25182 }).stalePid, false);
  assert.equal(classifyTerminal(term({ foreground: VIM_FG }), ctx).kind, "foreign");
});

test("inspectServer: a missing terminal is gone; an hc that fails otherwise is unknown, never gone", async () => {
  const hc = fakeHc();
  assert.equal((await inspectServer({ terminal: "sl-nope", logPath: LOG }, { exec: hc.exec })).kind, "gone");
  const broken = async () => ({ code: 1, stdout: "", stderr: "hc: can't reach herdr-core" });
  assert.equal((await inspectServer({ terminal: "t1", logPath: LOG }, { exec: broken })).kind, "unknown");
  const throws = async () => { throw new Error("spawn hc ENOENT"); };
  assert.equal((await inspectServer({ terminal: "t1", logPath: LOG }, { exec: throws })).kind, "unknown");
});

test("readServerState: gone, stopped (script exited), starting (ours, no port), listening (a port in the tree)", async () => {
  const hc = fakeHc();
  const deps = { exec: hc.exec };
  assert.equal((await readServerState({ terminal: "sl-nope", logPath: LOG }, deps)).state, "gone");

  const t = hc.add({ name: "sl-app", labels: { [SERVER_LABEL]: ROOT } });
  assert.equal((await readServerState({ terminal: t.address, logPath: LOG }, deps)).state, "stopped");

  t.foreground = { ...SCRIPT_FG, pid: 5001 };
  const starting = await readServerState({ terminal: t.address, logPath: LOG }, deps);
  assert.equal(starting.state, "starting");
  assert.equal(starting.owner, "spotlight");
  assert.equal(starting.pid, 5001);

  const listening = fakeHc({ ports: { 5001: [3001, 3000], 9999: [5432] } });
  const lt = listening.add({ name: "sl-app", labels: { [SERVER_LABEL]: ROOT }, fg: { ...SCRIPT_FG, pid: 5001 } });
  lt.foreground.pid = 5001;
  const got = await readServerState({ terminal: lt.address, logPath: LOG }, { exec: listening.exec });
  assert.deepEqual(
    { state: got.state, ports: got.ports, port: got.port, url: got.url, label: got.label },
    { state: "listening", ports: [3000, 3001], port: 3000, url: "http://localhost:3000", label: ":3000+1" },
  );
  // The configured port wins when it listens.
  assert.equal((await readServerState({ terminal: lt.address, logPath: LOG, port: 3001 }, { exec: listening.exec })).label, ":3001+1");

  // A killed terminal (hc kill: state finished) reads gone.
  t.state = "finished";
  assert.equal((await readServerState({ terminal: t.address, logPath: LOG }, deps)).state, "gone");
  // hc unreachable: no state (doubt is never death).
  assert.equal((await readServerState({ terminal: "t1", logPath: LOG }, { exec: async () => ({ code: 1, stdout: "", stderr: "down" }) })).state, null);
});

// ── The terminal ─────────────────────────────────────────────────────────

test("ensureServerTerminal: creates it once with D10's argv, then reuses it", async () => {
  const hc = fakeHc();
  const first = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec });
  assert.deepEqual(first, { ok: true, terminal: "t1", created: true });
  assert.deepEqual(hc.calls.find((c) => c[1] === "run"), createTerminalArgv(ROOT));
  const again = await ensureServerTerminal({ root: ROOT, terminal: "t1" }, { exec: hc.exec });
  assert.deepEqual(again, { ok: true, terminal: "t1", created: false });
  assert.equal(hc.verbs().filter((v) => v === "run").length, 1);
});

test("ensureServerTerminal: a finished one is removed and replaced; a name taken by a foreign terminal is refused", async () => {
  const hc = fakeHc();
  const dead = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT }, state: "finished" });
  const got = await ensureServerTerminal({ root: ROOT, terminal: dead.address }, { exec: hc.exec });
  assert.equal(got.ok, true);
  assert.equal(got.created, true);
  assert.notEqual(got.terminal, dead.address);
  assert.equal(hc.terms.has(dead.address), false, "hc rm'd");

  const other = fakeHc();
  other.add({ name: serverTerminalName(ROOT), labels: {} });
  const refused = await ensureServerTerminal({ root: ROOT }, { exec: other.exec });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "name-taken");
  assert.equal(other.verbs().includes("run"), false);
});

// ── Where the server shows (D38, T29) ─────────────────────────────────────
// The server runs in the root's main terminal, as Orca: Spotlight's own
// terminal is reused; else it replaces the root's active (or first) plain
// terminal, killing what ran there; else it gets a tab of its own. Its tab
// is named "Spotlight" and never takes focus. Herdr's side is the fake
// world above (`herdr: true`).

// The new names T29 exports, read off the module so a missing one fails its
// own tests, not the whole file's load.
const { SPACE_LABEL, TAB_NAME, findRootSpace, showServerTerminal, serverTerminalHidden, showServer } = serverModule;

const SPACE_ID = /^sp[0-9a-f]{32}$/;
// Where in hc.calls the first call matching `pred` sits (-1: none).
const at = (hc, pred) => hc.calls.findIndex(pred);
const hcCall = (verb) => (c) => c[0] === "hc" && c[1] === verb;
const doCall = (command) => (c) => c[0] === "herdr-app" && c[1] === "do" && c[2] === command;
const didOf = (hc, command) => hc.did.filter((d) => d.command === command).map((d) => d.args);
const labelOf = (argv, key) => argv[argv.findIndex((a, i) => argv[i - 1] === "--label" && a.startsWith(`${key}=`))]?.slice(key.length + 1);

test("findRootSpace (D38): the root's space is the one whose first pane lives in the root, not the one whose stale `folder` says so", async () => {
  assert.equal(SPACE_LABEL, "herdr.space");
  assert.equal(TAB_NAME, "Spotlight");
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spStale", folder: ROOT, tabs: [[{ cwd: "/Users/demo/elsewhere" }]] });
  hc.addSpace({ id: "spLive", folder: "/Users/demo/old-name", tabs: [[{ cwd: ROOT }, { cwd: "/Users/demo/elsewhere" }]] });
  const found = await findRootSpace(ROOT, { exec: hc.exec });
  assert.equal(found.ok, true);
  assert.equal(found.space?.id, "spLive");

  // A space whose terminals hc doesn't list goes by the folder it was made in.
  const folder = fakeHc({ herdr: true });
  const s = folder.addSpace({ id: "spFolder", folder: ROOT, tabs: [[{ cwd: "/somewhere" }]] });
  folder.terms.delete(s.tabs[0].terminals[0].terminal);
  assert.equal((await findRootSpace(ROOT, { exec: folder.exec })).space?.id, "spFolder");

  // No space there: none. Herdr that can't say (no spaces list): not ok.
  const none = fakeHc({ herdr: true });
  none.addSpace({ id: "spOther", folder: "/Users/demo/other", tabs: [[{ cwd: "/Users/demo/other" }]] });
  assert.deepEqual(await findRootSpace(ROOT, { exec: none.exec }), { ok: true, space: null });
  assert.equal((await findRootSpace(ROOT, { exec: fakeHc().exec })).ok, false);
});

test("ensureServerTerminal (D38): the active tab's plain terminal is replaced: hc run with herdr.space=<its space>, then tab.rename Spotlight, tab.move to its tab's place, then hc kill of it, in that order", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", active: 1, tabs: [[{ app: "claude" }], [{ fg: { ...VIM_FG } }], [{}]] });
  const adopted = s.tabs[1].terminals[0].terminal;
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, ...fakeClock() });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.space, "spRoot");
  assert.equal(r.adopted, adopted);

  const run = at(hc, hcCall("run"));
  const rename = at(hc, doCall("tab.rename"));
  const move = at(hc, doCall("tab.move"));
  const kill = at(hc, hcCall("kill"));
  assert.ok(run >= 0 && run < rename && rename < move && move < kill, JSON.stringify(hc.calls));
  assert.deepEqual(hc.calls[run], createTerminalArgv(ROOT, { space: "spRoot" }));
  assert.deepEqual(didOf(hc, "tab.rename"), [{ id: r.tab, name: "Spotlight" }]);
  assert.deepEqual(didOf(hc, "tab.move"), [{ id: r.tab, index: 2 }]);
  assert.deepEqual(hc.calls[kill], ["hc", "kill", adopted, "--json"]);
  assert.equal(hc.calls.filter(hcCall("kill")).length, 1, "only that terminal goes");
  // What Juan sees: tab 2 is "Spotlight" in the old one's place; the agent's tab and tab 3 untouched; no focus asked.
  assert.deepEqual(hc.world[0].tabs.map((t) => t.name), ["1", "Spotlight", "3"]);
  assert.equal(hc.terms.get(adopted).state, "finished");
  assert.equal(hc.terms.get(s.tabs[0].terminals[0].terminal).state, "live");
  assert.deepEqual([...didOf(hc, "space.select"), ...didOf(hc, "tab.select")], []);
  assert.deepEqual(hc.sent, [], "ensuring types nothing");
});

test("ensureServerTerminal (D38): the active tab holding an agent → the first plain terminal in tab order is the one replaced; an active tab with a plain one beside its agent gives that one", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", active: 1, tabs: [[{}], [{ app: "claude" }]] });
  const first = s.tabs[0].terminals[0].terminal;
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, ...fakeClock() });
  assert.equal(r.adopted, first);
  assert.deepEqual(didOf(hc, "tab.move"), [{ id: r.tab, index: 1 }]);
  assert.deepEqual(hc.calls.filter(hcCall("kill")), [["hc", "kill", first, "--json"]]);
  assert.equal(hc.terms.get(s.tabs[1].terminals[0].terminal).state, "live", "the agent lives");
  assert.deepEqual(hc.world[0].tabs.map((t) => t.name), ["Spotlight", "2"]);

  const beside = fakeHc({ herdr: true });
  const b = beside.addSpace({ id: "spRoot", active: 1, tabs: [[{}], [{ app: "claude" }, {}]] });
  const plain = b.tabs[1].terminals[1].terminal;
  const r2 = await ensureServerTerminal({ root: ROOT }, { exec: beside.exec, ...fakeClock() });
  assert.equal(r2.adopted, plain);
  assert.deepEqual(didOf(beside, "tab.move"), [{ id: r2.tab, index: 2 }]);
  // Only that terminal goes: the agent stays, in its tab.
  assert.deepEqual(beside.world[0].tabs.map((t) => [t.name, t.terminals.length]), [["1", 1], ["Spotlight", 1], ["2", 1]]);
});

test("ensureServerTerminal (D38): the terminal Spotlight was called from is never the one replaced: the next plain one is, or with none a new tab, so `spotlight restart` typed in the root's shell doesn't kill itself", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", active: 0, tabs: [[{}], [{}]] });
  const self = s.tabs[0].terminals[0].terminal;
  const next = s.tabs[1].terminals[0].terminal;
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, self, ...fakeClock() });
  assert.equal(r.adopted, next);
  assert.deepEqual(hc.calls.filter(hcCall("kill")), [["hc", "kill", next, "--json"]]);
  assert.equal(hc.terms.get(self).state, "live", "the caller's shell lives");

  const alone = fakeHc({ herdr: true });
  const a = alone.addSpace({ id: "spRoot", tabs: [[{}]] });
  const only = a.tabs[0].terminals[0].terminal;
  const r2 = await ensureServerTerminal({ root: ROOT }, { exec: alone.exec, self: only, ...fakeClock() });
  assert.deepEqual({ created: r2.created, adopted: r2.adopted }, { created: true, adopted: null });
  assert.equal(alone.verbs().includes("kill"), false);
  assert.deepEqual(alone.world[0].tabs.map((t) => t.name), ["1", "Spotlight"]);
});

test("ensureServerTerminal (D38): no plain terminal in the root's space → only a new tab named Spotlight, at the end: no move, no kill", async () => {
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spRoot", tabs: [[{ app: "claude" }], [{ app: "codex" }]] });
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, created: r.created, space: r.space, adopted: r.adopted }, { ok: true, created: true, space: "spRoot", adopted: null });
  assert.deepEqual(hc.calls.find(hcCall("run")), createTerminalArgv(ROOT, { space: "spRoot" }));
  assert.deepEqual(didOf(hc, "tab.rename"), [{ id: r.tab, name: "Spotlight" }]);
  assert.deepEqual(didOf(hc, "tab.move"), []);
  assert.equal(hc.verbs().includes("kill"), false);
  assert.deepEqual(hc.world[0].tabs.map((t) => t.name), ["1", "2", "Spotlight"]);
});

test("ensureServerTerminal (D38): no space for the root → a fresh sp… id, so Herdr makes one; its tab is named Spotlight; nothing moved or killed", async () => {
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spOther", folder: "/Users/demo/other", tabs: [[{ cwd: "/Users/demo/other" }]] });
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, ...fakeClock() });
  const run = hc.calls.find(hcCall("run"));
  const space = labelOf(run, "herdr.space");
  assert.match(space, SPACE_ID);
  assert.deepEqual(run, createTerminalArgv(ROOT, { space }));
  assert.deepEqual({ ok: r.ok, created: r.created, space: r.space, adopted: r.adopted }, { ok: true, created: true, space, adopted: null });
  assert.deepEqual(didOf(hc, "tab.rename"), [{ id: r.tab, name: "Spotlight" }]);
  assert.deepEqual(didOf(hc, "tab.move"), []);
  assert.equal(hc.verbs().includes("kill"), false);
  assert.deepEqual(hc.world.find((x) => x.id === space).tabs.map((t) => t.name), ["Spotlight"]);
  // Two roots with no space never share an id.
  const again = fakeHc({ herdr: true });
  await ensureServerTerminal({ root: ROOT }, { exec: again.exec, ...fakeClock() });
  assert.notEqual(labelOf(again.calls.find(hcCall("run")), "herdr.space"), space);
});

test("ensureServerTerminal (D38): a live spotlight.repo terminal in the root's space is reused as it is: nothing created, labelled, renamed or killed", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", tabs: [[{}], [{ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } }]] });
  const mine = s.tabs[1].terminals[0].terminal;
  for (const terminal of [mine, undefined]) {
    const r = await ensureServerTerminal({ root: ROOT, terminal }, { exec: hc.exec, ...fakeClock() });
    assert.deepEqual(r, { ok: true, terminal: mine, created: false });
  }
  for (const verb of ["run", "label", "kill"]) assert.equal(hc.verbs().includes(verb), false, verb);
  assert.deepEqual(hc.did, []);
  assert.deepEqual(hc.world[0].tabs.map((t) => t.name), ["1", "2"]);
});

test("showServerTerminal (D38): Spotlight's live terminal with no herdr.space (lit before T29) → hc label <t> herdr.space=<root's space> and its tab renamed, once: no restart, no other terminal touched", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", tabs: [[{}]] });
  const plain = s.tabs[0].terminals[0].terminal;
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT }, fg: { ...SCRIPT_FG } });
  const deps = { exec: hc.exec, ...fakeClock() };
  assert.equal(await serverTerminalHidden({ root: ROOT, terminal: t.address }, deps), true);
  const r = await showServerTerminal({ root: ROOT, terminal: t.address }, deps);
  assert.equal(r.shown, true);
  assert.deepEqual(hc.calls.filter(hcCall("label")), [["hc", "label", t.address, "herdr.space=spRoot"]]);
  assert.deepEqual(didOf(hc, "tab.rename"), [{ id: r.tab, name: "Spotlight" }]);
  assert.deepEqual(hc.world[0].tabs.map((x) => x.name), ["1", "Spotlight"]);
  for (const verb of ["run", "kill", "interrupt", "send"]) assert.equal(hc.verbs().includes(verb), false, verb);
  assert.deepEqual(didOf(hc, "tab.move"), []);
  assert.equal(hc.terms.get(plain).state, "live");
  assert.equal(hc.terms.get(t.address).foreground.name, "script", "the server still runs");

  // Once: shown, it is left alone.
  assert.equal(await serverTerminalHidden({ root: ROOT, terminal: t.address }, deps), false);
  assert.equal((await showServerTerminal({ root: ROOT, terminal: t.address }, deps)).shown, false);
  assert.equal(hc.calls.filter(hcCall("label")).length, 1);
  assert.equal(didOf(hc, "tab.rename").length, 1);
  // Another repo's terminal, or one hc doesn't know, is never touched.
  const other = hc.add({ name: "sl-other-000000", labels: { [SERVER_LABEL]: "/Users/demo/other" } });
  assert.equal(await serverTerminalHidden({ root: ROOT, terminal: other.address }, deps), false);
  assert.equal((await showServerTerminal({ root: ROOT, terminal: other.address }, deps)).shown, false);
  assert.equal(await serverTerminalHidden({ root: ROOT, terminal: "t404" }, deps), false);
  assert.equal(hc.calls.filter(hcCall("label")).length, 1);
});

test("ensureServerTerminal (D38): a hidden Spotlight terminal it finds is shown the same way (label + rename) and reused: nothing created or killed", async () => {
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spRoot", tabs: [[{}]] });
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const r = await ensureServerTerminal({ root: ROOT, terminal: t.address }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual(r, { ok: true, terminal: t.address, created: false });
  assert.deepEqual(hc.calls.filter(hcCall("label")), [["hc", "label", t.address, "herdr.space=spRoot"]]);
  assert.equal(didOf(hc, "tab.rename").length, 1);
  for (const verb of ["run", "kill"]) assert.equal(hc.verbs().includes(verb), false, verb);
});

test("ensureServerTerminal (D38): another repo's Spotlight terminal is never picked: the next plain one is, and with none left only a tab is made", async () => {
  const otherRepo = { name: "sl-other-123456", labels: { [SERVER_LABEL]: "/Users/demo/other" } };
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", active: 0, tabs: [[otherRepo], [{}]] });
  const [theirs, plain] = s.tabs.map((tab) => tab.terminals[0].terminal);
  const r = await ensureServerTerminal({ root: ROOT }, { exec: hc.exec, ...fakeClock() });
  assert.equal(r.adopted, plain);
  assert.equal(hc.terms.get(theirs).state, "live");

  const only = fakeHc({ herdr: true });
  const o = only.addSpace({ id: "spRoot", tabs: [[otherRepo]] });
  const r2 = await ensureServerTerminal({ root: ROOT }, { exec: only.exec, ...fakeClock() });
  assert.equal(r2.adopted, null);
  assert.equal(only.verbs().includes("kill"), false);
  assert.equal(only.terms.get(o.tabs[0].terminals[0].terminal).state, "live");
});

test("startServer (D38): through an adopted terminal the server line, the log mirror and the terminal's argv are those of D10, unchanged", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spRoot", tabs: [[{}]] });
  const r = await startServer({ root: ROOT, line: "pnpm dev", logPath, workspace: "login", branch: "feat/login" }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started, created: r.created }, { ok: true, started: true, created: true });
  // D10's argv, with the space's label after the repo's.
  const base = createTerminalArgv(ROOT);
  const i = base.indexOf(`${SERVER_LABEL}=${ROOT}`) + 1;
  assert.deepEqual(hc.calls.find(hcCall("run")), [...base.slice(0, i), "--label", `${SPACE_LABEL}=spRoot`, ...base.slice(i)]);
  assert.deepEqual(hc.sent, [{ terminal: r.terminal, text: wrapServerLine("pnpm dev", logPath) }]);
  assert.equal(readFileSync(logPath, "utf8"), "\n── Spotlight: login (feat/login) · started: pnpm dev · 22:58:04 ──\n");
  // The kill came before the line was typed.
  assert.ok(at(hc, hcCall("kill")) < at(hc, hcCall("send")));
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: in a fresh terminal it types the wrapped line, logs a header, and reports the script's pid", async () => {
  const dir = tmp();
  const logPath = join(dir, "logs", "app.log");
  const hc = fakeHc();
  const r = await startServer({ root: ROOT, line: "pnpm dev", logPath, workspace: "login", branch: "feat/login" }, { exec: hc.exec, ...fakeClock() });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(r.created, true);
  assert.equal(r.terminal, "t1");
  assert.equal(r.command, "pnpm dev");
  assert.ok(Number.isInteger(r.pid));
  assert.deepEqual(hc.sent, [{ terminal: "t1", text: wrapServerLine("pnpm dev", logPath) }]);
  assert.equal(readFileSync(logPath, "utf8"), "\n── Spotlight: login (feat/login) · started: pnpm dev · 22:58:04 ──\n");
  // A second start finds Spotlight's own server and types nothing.
  const again = await startServer({ root: ROOT, terminal: "t1", line: "pnpm dev", logPath, serverPid: r.pid }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: again.ok, started: again.started, reason: again.reason }, { ok: true, started: false, reason: "already-running" });
  assert.equal(hc.sent.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: waits for a new terminal's shell before typing (hc shows no foreground for its first moments)", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ shellReads: 3 });
  const r = await startServer({ root: ROOT, line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started, created: r.created }, { ok: true, started: true, created: true });
  assert.deepEqual(hc.sent, [{ terminal: "t1", text: wrapServerLine("pnpm dev", logPath) }]);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: a child of a new terminal's rc files in front isn't a busy terminal", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ shellReads: 2, startupFg: { pid: 77, name: "brew", argv: ["brew", "shellenv"], cwd: ROOT } });
  const r = await startServer({ root: ROOT, line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started }, { ok: true, started: true });
  assert.equal(hc.sent.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: a new terminal whose shell never shows types nothing, and the wait ends", async () => {
  const dir = tmp();
  const hc = fakeHc({ shellReads: 1_000_000 });
  const r = await startServer({ root: ROOT, line: "pnpm dev", logPath: join(dir, "app.log") }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "unreadable" });
  assert.deepEqual(hc.sent, []);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: a terminal that was already there is read once, with no wait", async () => {
  const dir = tmp();
  const hc = fakeHc();
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  t.foreground = null;
  const clock = fakeClock();
  const before = clock.now();
  const r = await startServer({ root: ROOT, terminal: t.address, line: "pnpm dev", logPath: join(dir, "app.log") }, { exec: hc.exec, ...clock });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "unreadable" });
  assert.equal(clock.now(), before);
  rmSync(dir, { recursive: true, force: true });
});

test("restartServer: a closed terminal is made again and the server starts once its shell is up", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ shellReads: 3 });
  const r = await restartServer({ root: ROOT, terminal: "t9", line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started, created: r.created }, { ok: true, started: true, created: true });
  assert.equal(hc.verbs().includes("interrupt"), false);
  assert.equal(hc.sent.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: never types over a process Spotlight didn't start", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT }, fg: VIM_FG });
  const r = await startServer({ root: ROOT, terminal: t.address, line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started, reason: r.reason }, { ok: true, started: false, reason: "busy" });
  assert.deepEqual(hc.sent, []);
  assert.match(readFileSync(logPath, "utf8"), /Server left alone — the Spotlight terminal runs something Spotlight didn't start/);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: an invalid line types nothing and creates nothing; an unreadable terminal types nothing", async () => {
  const hc = fakeHc();
  const r = await startServer({ root: ROOT, line: "pnpm dev\nrm -rf ~", logPath: "/nope/app.log" }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual(r, { ok: false, reason: "invalid-command" });
  assert.deepEqual(hc.calls, []);

  const dir = tmp();
  let gets = 0;
  const flaky = async (file, args) => {
    if (args[0] === "get" && ++gets > 1) return { code: 1, stdout: "", stderr: "core restarting" };
    return hc.exec(file, args);
  };
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const u = await startServer({ root: ROOT, terminal: t.address, line: "pnpm dev", logPath: join(dir, "app.log") }, { exec: flaky, ...fakeClock() });
  assert.deepEqual({ ok: u.ok, reason: u.reason }, { ok: false, reason: "unreadable" });
  assert.deepEqual(hc.sent, []);
  rmSync(dir, { recursive: true, force: true });
});

test("startServer: rotates a log past 4 MB before the header", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  writeFileSync(logPath, "old line\n".repeat(500_000)); // 4.5 MB
  const hc = fakeHc();
  await startServer({ root: ROOT, line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  const text = readFileSync(logPath, "utf8");
  assert.ok(Buffer.byteLength(text) < 1.1 * 1024 * 1024);
  assert.ok(text.startsWith("[log trimmed by Spotlight]\n"));
  assert.ok(text.endsWith("── Spotlight: started: pnpm dev · 22:58:04 ──\n"));
  rmSync(dir, { recursive: true, force: true });
});

// ── Restart and stop ─────────────────────────────────────────────────────

test("restartServer: interrupt, wait for the prompt, resend; the log says restarted", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ lingers: 2 });
  const deps = { exec: hc.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath }, deps);
  const r = await restartServer({ root: ROOT, terminal: s.terminal, line: "pnpm install --frozen-lockfile && pnpm dev", logPath, serverPid: s.pid }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(r.restarted, true);
  assert.notEqual(r.pid, s.pid);
  const verbs = hc.verbs();
  assert.deepEqual(verbs.slice(verbs.indexOf("interrupt")).filter((v) => v !== "get"), ["interrupt", "send"]);
  assert.equal(hc.sent.at(-1).text, wrapServerLine("pnpm install --frozen-lockfile && pnpm dev", logPath));
  assert.match(readFileSync(logPath, "utf8"), /── Spotlight: restarted: pnpm install --frozen-lockfile && pnpm dev · \d\d:\d\d:\d\d ──\n$/);
  rmSync(dir, { recursive: true, force: true });
});

test("restartServer: a gone terminal is recreated and started (Reiniciar after a close)", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const deps = { exec: hc.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath }, deps);
  hc.terms.get(s.terminal).state = "finished"; // closed / hc kill
  const r = await restartServer({ root: ROOT, terminal: s.terminal, line: "pnpm dev", logPath, serverPid: s.pid }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(r.created, true);
  assert.notEqual(r.terminal, s.terminal);
  assert.equal(hc.sent.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("restartServer: a foreign foreground is left alone; a server that won't stop is reported, not typed over", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT }, fg: VIM_FG });
  const r = await restartServer({ root: ROOT, terminal: t.address, line: "pnpm dev", logPath }, { exec: hc.exec, ...fakeClock() });
  assert.deepEqual({ ok: r.ok, started: r.started, reason: r.reason }, { ok: true, started: false, reason: "busy" });
  assert.equal(hc.verbs().includes("interrupt"), false);
  assert.deepEqual(hc.sent, []);

  const stuck = fakeHc({ lingers: Infinity });
  const deps = { exec: stuck.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath }, deps);
  const r2 = await restartServer({ root: ROOT, terminal: s.terminal, line: "pnpm dev", logPath }, deps);
  assert.deepEqual({ ok: r2.ok, reason: r2.reason }, { ok: false, reason: "still-running" });
  assert.equal(stuck.sent.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer: a free prompt, a foreign process or no terminal is left alone: no Ctrl-C, no signal", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const deps = { exec: hc.exec, kill: hc.kill, ...fakeClock() };
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const idle = await stopServer({ root: ROOT, terminal: t.address, logPath }, deps);
  const { ok, stopped, reason, terminal } = idle;
  assert.deepEqual({ ok, stopped, reason, terminal }, { ok: true, stopped: false, reason: "not-running", terminal: t.address });
  t.foreground = { ...VIM_FG };
  const foreign = await stopServer({ root: ROOT, terminal: t.address, logPath }, deps);
  assert.deepEqual(foreign, { ok: true, stopped: false, reason: "busy", terminal: t.address });
  const gone = await stopServer({ root: ROOT, terminal: "sl-nope", logPath }, deps);
  assert.deepEqual(
    { ok: gone.ok, stopped: gone.stopped, reason: gone.reason, terminal: gone.terminal },
    { ok: true, stopped: false, reason: "terminal-gone", terminal: null },
  );
  assert.equal(hc.verbs().includes("interrupt"), false);
  assert.deepEqual(hc.signals, []);
  assert.equal(existsSync(logPath), false, "nothing logged");
  rmSync(dir, { recursive: true, force: true });
});

// ── Turn-off kills the server, guaranteed (T15, D26) ──────────────────────

// A stop's deps on the fake hc, with each real signal and its time since
// mark() (the stop's start) on the fake clock.
function stopDeps(hc, clock = fakeClock()) {
  const signals = [];
  let t0 = clock.now();
  const kill = (pid, sig) => {
    if (sig !== 0) signals.push({ pid, sig, at: clock.now() - t0 });
    return hc.kill(pid, sig);
  };
  return {
    deps: { exec: hc.exec, kill, now: clock.now, sleep: clock.sleep },
    signals,
    mark() {
      t0 = clock.now();
    },
    elapsed: () => clock.now() - t0,
  };
}

// The identities readServerState recorded for listeners that were Spotlight's
// server's children (stopServer's `procs`): 7002 on 3210 and 7003 on 8080,
// started at the fake ps's one fixed time.
const KNOWN_7002_7003 = [
  { pid: 7002, start: "Sun Nov 8 22:00:00 2026", port: 3210 },
  { pid: 7003, start: "Sun Nov 8 22:00:00 2026", port: 8080 },
];

// The stop's line at the end of the log.
const stopNote = (text) => new RegExp(`── Spotlight: login \\(feat/login\\) · Spotlight off — server stopped \\(${text}\\) · \\d\\d:\\d\\d:\\d\\d ──\\n$`);
const HEAD = { workspace: "login", branch: "feat/login" };

test("stopServer (D26): a server that exits on Ctrl-C is not killed; the log says (interrupt sent)", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.ports[s.pid] = [3000];
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 0 });
  assert.deepEqual(hc.signals, []);
  assert.ok(sd.elapsed() < 1000, `waited ${sd.elapsed()} ms`);
  assert.match(readFileSync(logPath, "utf8"), stopNote("interrupt sent"));
  const term = hc.terms.get(s.terminal);
  assert.equal(term.state, "live", "the terminal stays for the next start");
  assert.equal(term.foreground.pid, term.pid, "the prompt is back");
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (D26): a child ignoring SIGINT gets TERM after the 8 s wait, then KILL 3 s later; the log says (forced: 1 processes)", async () => {
  assert.equal(STOP_WAIT_MS, 8000);
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ lingers: Infinity, fgIgnoresTerm: true });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  const shell = hc.terms.get(s.terminal).pid;
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[s.pid, "SIGTERM"], [s.pid, "SIGKILL"]]);
  const [term, kill] = sd.signals;
  assert.ok(term.at >= 8000, `TERM at ${term.at} ms`);
  assert.ok(kill.at - term.at >= 3000, `KILL ${kill.at - term.at} ms after TERM`);
  assert.ok(!hc.signals.some((x) => x.pid === shell), "the terminal's shell is never signalled");
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 1 processes"));
  assert.equal(hc.terms.get(s.terminal).foreground.pid, shell, "the prompt is back");
  assert.equal(hc.terms.get(s.terminal).state, "live");
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (D26): a child that escaped the tree at the Ctrl-C, still on the server's port with its cwd in the root, is killed", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ procs: { 7001: { cwd: `${ROOT}/apps/web` } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  // next-server under the script, on 3210; the Ctrl-C ends the script only.
  hc.children[s.pid] = [7001];
  hc.ports[7001] = [3210];
  const shell = hc.terms.get(s.terminal).pid;
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"]]);
  assert.ok(sd.signals[0].at >= 8000, `TERM at ${sd.signals[0].at} ms`);
  assert.ok(hc.dead.has(7001));
  assert.ok(!hc.signals.some((x) => x.pid === shell), "the terminal's shell is never signalled");
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 1 processes"));
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (D26): a listener on a recorded port outside the tree is killed when its cwd is in the root, left alone when it isn't", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // 7002 runs in the root; 7003 in a sibling folder that only shares its prefix.
  const procs = { 7002: { cwd: ROOT }, 7003: { cwd: `${ROOT}-old` } };
  const hc = fakeHc({ procs, ports: { 7002: [3210], 7003: [8080] } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  const shell = hc.terms.get(s.terminal).pid;
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3210, 8080], procs: KNOWN_7002_7003, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7002, "SIGTERM"]]);
  assert.equal(hc.dead.has(7003), false);
  assert.ok(!hc.signals.some((x) => x.pid === shell || x.pid === 7003));

  // Only the one outside the root: nothing is killed and the stop doesn't wait on it.
  const only = fakeHc({ procs, ports: { 7003: [8080] } });
  const od = stopDeps(only);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, od.deps);
  od.mark();
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath, serverPid: s2.pid, ports: [8080], procs: KNOWN_7002_7003, ...HEAD }, od.deps);
  assert.deepEqual(r2, { ok: true, stopped: true, terminal: s2.terminal, forced: 0 });
  assert.deepEqual(only.signals, []);
  assert.ok(od.elapsed() < 1000, `waited ${od.elapsed()} ms`);
  assert.match(readFileSync(logPath, "utf8"), stopNote("interrupt sent"));
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (D26, Risk 4): a server typed into the terminal during the wait is never signalled; the old leftover is", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  hc.ports[7001] = [3210];
  const term = hc.terms.get(s.terminal);
  // The third look after the Ctrl-C finds a restart someone typed: a new
  // Spotlight `script` in front, on the same port.
  const NEW = 9100;
  let looks = 0;
  const exec = async (file, args) => {
    if (file === "hc" && args[0] === "get" && hc.verbs().includes("interrupt") && ++looks === 3) {
      term.foreground = { argv: ["script", "-F", "-q", "-a", logPath, "/bin/zsh", "-c", "pnpm dev"], cwd: ROOT, name: "script", pid: NEW };
      hc.ports[NEW] = [3210];
    }
    return hc.exec(file, args);
  };
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec });
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"]]);
  assert.ok(!hc.signals.some((x) => x.pid === NEW || x.pid === term.pid), "neither the restart nor the shell");
  assert.equal(term.foreground.pid, NEW, "the restart still runs");
  assert.equal(hc.dead.has(NEW), false);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (R1): the terminal shell's own helpers (gitstatusd, a job put in the background) are neither waited on nor signalled", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const procs = { 8150: { cwd: ROOT, command: "gitstatusd-darwin-arm64" }, 8151: { cwd: ROOT, command: "zsh-async worker" } };
  const hc = fakeHc({ procs });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  const shell = hc.terms.get(s.terminal).pid;
  hc.children[shell] = [8150, 8151];
  hc.ports[s.pid] = [3000];
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3000], ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 0 });
  assert.deepEqual(hc.signals, []);
  assert.ok(sd.elapsed() < 1000, `waited ${sd.elapsed()} ms`);
  assert.ok(!hc.dead.has(8150) && !hc.dead.has(8151));
  assert.match(readFileSync(logPath, "utf8"), stopNote("interrupt sent"));
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (C7): a server child that ignores INT, TERM and HUP, orphaned by the Ctrl-C and listening on nothing, gets TERM after the 8 s wait, then KILL 3 s later", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // spotlight-lab's rama-terca: `(trap '' INT TERM HUP; exec sleep 900) & exec next dev --port 3210`.
  const hc = fakeHc({ procs: { 7001: { cwd: "/tmp", command: "sleep 900", ignoresTerm: true } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const shell = hc.terms.get(s.terminal).pid;
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3210], ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"], [7001, "SIGKILL"]]);
  const [term, kill] = sd.signals;
  assert.ok(term.at >= 8000, `TERM at ${term.at} ms`);
  assert.ok(kill.at - term.at >= 3000, `KILL ${kill.at - term.at} ms after TERM`);
  assert.ok(hc.dead.has(7001));
  assert.ok(!hc.signals.some((x) => x.pid === shell), "the terminal's shell is never signalled");
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 1 processes"));
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (R1): a pid of the server taken by an unrelated process after the Ctrl-C (another start time) is never signalled", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  hc.ports[7001] = [3210];
  // The Ctrl-C ends the whole server; a server started by hand in the root
  // gets pid 7001 back, on the same port.
  let reused = false;
  const exec = async (file, args) => {
    if (!reused && file === "hc" && args[0] === "get" && hc.verbs().includes("interrupt")) {
      reused = true;
      hc.children[s.pid] = [];
      hc.starts[7001] = "Sun Nov  8 22:00:09 2026";
    }
    return hc.exec(file, args);
  };
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3210], ...HEAD }, { ...sd.deps, exec });
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 0 });
  assert.deepEqual(hc.signals, []);
  assert.equal(hc.dead.has(7001), false);
  assert.ok(sd.elapsed() < 1000, `waited ${sd.elapsed()} ms`);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (R3): at a free prompt, a listener on a recorded port with its cwd in the root (a server child that escaped earlier) is killed and the log says so; one outside the root, or anything behind a foreign foreground, is left alone", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // 7002 runs in the root; 7003 in a sibling folder that only shares its prefix.
  const procs = { 7002: { cwd: `${ROOT}/apps/web` }, 7003: { cwd: `${ROOT}-old` } };
  const hc = fakeHc({ procs, ports: { 7002: [3210], 7003: [8080] } });
  const sd = stopDeps(hc);
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: t.address, logPath, ports: [3210, 8080], procs: KNOWN_7002_7003, ...HEAD }, sd.deps);
  assert.deepEqual(r, {
    ok: true, stopped: false, reason: "not-running", terminal: t.address, forced: 1,
    escaped: [{ pid: 7002, port: 3210, cwd: `${ROOT}/apps/web` }],
  });
  // No Ctrl-C (nothing runs in the terminal), so no 8 s wait before the TERM.
  assert.deepEqual(sd.signals.map(({ pid, sig, at }) => [pid, sig, at]), [[7002, "SIGTERM", 0]]);
  assert.equal(hc.verbs().includes("interrupt"), false);
  assert.ok(hc.dead.has(7002));
  assert.equal(hc.dead.has(7003), false);
  assert.ok(!hc.signals.some((x) => x.pid === t.pid));
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 1 processes"));

  // A process Spotlight didn't start in front: nothing is touched, the listener in the root included.
  const busy = fakeHc({ procs, ports: { 7002: [3210] } });
  const bd = stopDeps(busy);
  const v = busy.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT }, fg: VIM_FG });
  const r2 = await stopServer({ root: ROOT, terminal: v.address, logPath: join(dir, "busy.log"), ports: [3210], procs: KNOWN_7002_7003, ...HEAD }, bd.deps);
  assert.deepEqual(r2, { ok: true, stopped: false, reason: "busy", terminal: v.address });
  assert.deepEqual(busy.signals, []);
  assert.equal(existsSync(join(dir, "busy.log")), false);
  rmSync(dir, { recursive: true, force: true });
});

// The note a stop leaves when something of the server lived through SIGKILL.
const survivedNote = (n, pids) =>
  new RegExp(`── Spotlight: login \\(feat/login\\) · Spotlight off — server NOT stopped: ${n} processes survived \\(pids ${pids}\\) · \\d\\d:\\d\\d:\\d\\d ──\\n$`);

test("stopServer (S17): a process of the server that lives through SIGKILL fails the stop with its pids; the log says NOT stopped", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // A server child that ignores the Ctrl-C and isn't ours to signal (EPERM).
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT, eperm: true } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: false, reason: "survived", terminal: s.terminal, forced: 1, survivors: [7001] });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"], [7001, "SIGKILL"]]);
  const log = readFileSync(logPath, "utf8");
  assert.match(log, survivedNote(1, "7001"));
  assert.doesNotMatch(log, /server stopped/);

  // The same at a free prompt, for a listener in the root that escaped earlier.
  const idle = fakeHc({ procs: { 7002: { cwd: ROOT, eperm: true } }, ports: { 7002: [3210] } });
  const id = stopDeps(idle);
  const t = idle.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const idleLog = join(dir, "idle.log");
  const r2 = await stopServer({ root: ROOT, terminal: t.address, logPath: idleLog, ports: [3210], procs: KNOWN_7002_7003, ...HEAD }, id.deps);
  assert.deepEqual(r2, {
    ok: false, reason: "survived", terminal: t.address, forced: 1, survivors: [7002],
    escaped: [{ pid: 7002, port: 3210, cwd: ROOT }],
  });
  assert.match(readFileSync(idleLog, "utf8"), survivedNote(1, "7002"));
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer: with no terminal at all, a listener on a recorded port with its cwd in the root is killed at once; one outside the root is left alone; no hc interrupt", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const procs = { 7002: { cwd: `${ROOT}/apps/web` }, 7003: { cwd: `${ROOT}-old` } };
  const hc = fakeHc({ procs, ports: { 7002: [3210], 7003: [8080] } });
  const sd = stopDeps(hc);
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: "t9", logPath, ports: [3210, 8080], procs: KNOWN_7002_7003, ...HEAD }, sd.deps);
  assert.deepEqual(r, {
    ok: true, stopped: false, reason: "terminal-gone", terminal: null, forced: 1,
    escaped: [{ pid: 7002, port: 3210, cwd: `${ROOT}/apps/web` }],
  });
  assert.deepEqual(sd.signals.map(({ pid, sig, at }) => [pid, sig, at]), [[7002, "SIGTERM", 0]]);
  assert.equal(hc.verbs().includes("interrupt"), false);
  assert.ok(hc.dead.has(7002));
  assert.equal(hc.dead.has(7003), false);
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 1 processes"));

  // Nothing of it on the recorded ports: nothing signalled, nothing logged.
  const quiet = fakeHc({ procs, ports: { 7003: [8080] } });
  const quietLog = join(dir, "quiet.log");
  const r2 = await stopServer({ root: ROOT, terminal: "t9", logPath: quietLog, ports: [8080], procs: KNOWN_7002_7003, ...HEAD }, stopDeps(quiet).deps);
  assert.deepEqual(r2, { ok: true, stopped: false, reason: "terminal-gone", terminal: null, forced: 0, escaped: [] });
  assert.deepEqual(quiet.signals, []);
  assert.equal(existsSync(quietLog), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── Who a listener is (F2), a Ctrl-C that fails (F3), a refused leftover
// (F4), no injected kill (F8) ─────────────────────────────────────────────

test("readServerState (F2): `procs` names each listener under Spotlight's own server by pid, start time (ps's, spaces folded) and port; the shell's own job, a foreign foreground or a ps that can't say give none", async () => {
  const hc = fakeHc({ ports: { 5002: [3001, 3000], 5003: [8080], 9999: [5432] } });
  const t = hc.add({ name: "sl-app", labels: { [SERVER_LABEL]: ROOT }, fg: { ...SCRIPT_FG } });
  const script = t.foreground.pid;
  // script → next-server (5002, on 3000 and 3001); 5003 is the shell's own
  // job in the background, on 8080; 9999 is a database outside the terminal.
  hc.children[script] = [5002];
  hc.children[t.pid] = [5003];
  hc.starts[5002] = "Sun Nov  8 22:00:05 2026";
  const got = await readServerState({ terminal: t.address, logPath: LOG }, { exec: hc.exec });
  assert.deepEqual({ state: got.state, ports: got.ports }, { state: "listening", ports: [3000, 3001, 8080] });
  assert.deepEqual(got.procs, [
    { pid: 5002, start: "Sun Nov 8 22:00:05 2026", port: 3000 },
    { pid: 5002, start: "Sun Nov 8 22:00:05 2026", port: 3001 },
  ]);

  // ps can't say who they are: the ports still read, no identity is made up.
  const blind = async (file, args) => (unwrapEnv(file, args).file === "ps" ? { code: 2, stdout: "", stderr: "ps: bad" } : hc.exec(file, args));
  const unsure = await readServerState({ terminal: t.address, logPath: LOG }, { exec: blind });
  assert.deepEqual({ ports: unsure.ports, procs: unsure.procs }, { ports: [3000, 3001, 8080], procs: [] });

  // A foreground Spotlight didn't start, with a listener under it.
  t.foreground = { ...VIM_FG };
  hc.children[VIM_FG.pid] = [5002];
  const foreign = await readServerState({ terminal: t.address, logPath: LOG }, { exec: hc.exec });
  assert.deepEqual({ owner: foreign.owner, procs: foreign.procs }, { owner: "foreign", procs: [] });

  // The prompt free, the shell's job still on 8080.
  t.foreground = { argv: ["/bin/zsh", "-l"], cwd: ROOT, name: "zsh", pid: t.pid };
  const idle = await readServerState({ terminal: t.address, logPath: LOG }, { exec: hc.exec });
  assert.deepEqual({ ports: idle.ports, procs: idle.procs }, { ports: [8080], procs: [] });

  // Gone, or hc can't say: none either.
  assert.deepEqual((await readServerState({ terminal: "sl-nope", logPath: LOG }, { exec: hc.exec })).procs, []);
  assert.deepEqual((await readServerState({ terminal: "t1", logPath: LOG }, { exec: async () => ({ code: 1, stdout: "", stderr: "down" }) })).procs, []);
});

test("stopServer (F2, D24): a listener on a recorded port with its cwd in the root is killed only when its pid and start time match `procs`; a server started by hand there is never signalled, with the server running, at a free prompt or with no terminal", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const ROOT_PROCS = { 7001: { cwd: `${ROOT}/apps/web` }, 7005: { cwd: ROOT, command: "next dev --port 8080" }, 7006: { cwd: ROOT } };

  // Running: next-server (7001) under the script, on 3210, read by a reap.
  const hc = fakeHc({ procs: ROOT_PROCS });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  hc.ports[7001] = [3210];
  const { procs } = await readServerState({ terminal: s.terminal, logPath, serverPid: s.pid }, sd.deps);
  assert.deepEqual(procs, [{ pid: 7001, start: "Sun Nov 8 22:00:00 2026", port: 3210 }]);
  // Then a server started by hand in the root, on 8080, a port the record holds.
  hc.ports[7005] = [8080];
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3210, 8080], procs, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"]]);
  assert.equal(hc.dead.has(7005), false, "the hand-started server lives");

  // Free prompt and no terminal: 7001 escaped the tree earlier (its parent
  // died) and is still on 3210; 7005 was started by hand on 8080; pid 7006
  // was recorded on 3211, but the process on it now started later (a pid
  // reused by a server started by hand).
  const known = [...procs, { pid: 7006, start: "Sun Nov 8 22:00:00 2026", port: 3211 }];
  for (const where of ["prompt", "gone"]) {
    const w = fakeHc({ procs: ROOT_PROCS, ports: { 7001: [3210], 7005: [8080], 7006: [3211] }, starts: { 7006: "Sun Nov  8 22:00:09 2026" } });
    const wd = stopDeps(w);
    const t = where === "prompt" ? w.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } }).address : "t9";
    const r2 = await stopServer({ root: ROOT, terminal: t, logPath: join(dir, `${where}.log`), ports: [3210, 3211, 8080], procs: known, ...HEAD }, wd.deps);
    assert.deepEqual(r2, {
      ok: true, stopped: false, reason: where === "prompt" ? "not-running" : "terminal-gone", terminal: where === "prompt" ? t : null,
      forced: 1, escaped: [{ pid: 7001, port: 3210, cwd: `${ROOT}/apps/web` }],
    }, where);
    assert.deepEqual(wd.signals.map(({ pid, sig }) => [pid, sig]), [[7001, "SIGTERM"]], where);
    assert.ok(!w.dead.has(7005) && !w.dead.has(7006), where);
  }

  // No `procs` (a record from before identities): no listener is killed on any path.
  const old = fakeHc({ procs: ROOT_PROCS, ports: { 7001: [3210], 7005: [8080] } });
  const oldT = old.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const r3 = await stopServer({ root: ROOT, terminal: oldT.address, logPath: join(dir, "old.log"), ports: [3210, 8080], ...HEAD }, stopDeps(old).deps);
  assert.deepEqual(r3, { ok: true, stopped: false, reason: "not-running", terminal: oldT.address, forced: 0, escaped: [] });
  assert.deepEqual(old.signals, []);
  rmSync(dir, { recursive: true, force: true });
});

// An hc whose `interrupt` fails (the core unreachable, say), on top of `hc`.
const interruptFails = (hc) => async (file, args) =>
  file === "hc" && args[0] === "interrupt"
    ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "failed", message: "herdr-core unreachable" } }) }
    : hc.exec(file, args);

test("stopServer (F3): a Ctrl-C hc couldn't send is no reason to leave the server up: its tree is killed at once, with no 8 s wait", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const shell = hc.terms.get(s.terminal).pid;
  sd.mark();
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec: interruptFails(hc) });
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 2, interruptError: "herdr-core unreachable" });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]).sort(), [[7001, "SIGTERM"], [s.pid, "SIGTERM"]].sort());
  assert.ok(sd.elapsed() < 1000, `waited ${sd.elapsed()} ms`);
  assert.ok(!hc.signals.some((x) => x.pid === shell), "the terminal's shell is never signalled");
  // K5: the note says the Ctrl-C couldn't be sent, in the same line.
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 2 processes; the Ctrl-C could not be sent: herdr-core unreachable"));
  assert.equal(hc.terms.get(s.terminal).foreground.pid, shell, "the prompt is back");

  // Nothing could be read after it either (hc down, ps can't say): nothing
  // proves the server died, so the stop says it may still run.
  const down = fakeHc();
  const dd = stopDeps(down);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, dd.deps);
  let sent = false;
  const exec = async (file, args) => {
    if (unwrapEnv(file, args).file === "ps") return { code: 2, stdout: "", stderr: "ps: bad" };
    if (file === "hc" && args[0] === "interrupt") sent = true;
    if (sent && file === "hc" && args[0] === "get") return { code: 1, stdout: "", stderr: "hc: can't reach herdr-core" };
    return interruptFails(down)(file, args);
  };
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath, serverPid: s2.pid, ...HEAD }, { ...dd.deps, exec });
  assert.deepEqual(r2, {
    ok: false, reason: "interrupt-failed", terminal: s2.terminal, forced: 0,
    message: "the Ctrl-C could not be sent (herdr-core unreachable) and the terminal can't be read: the server may still be running",
  });
  assert.deepEqual(down.signals, []);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (F3): an unreadable terminal, or a server still in front after its processes were killed, fails saying the server may still be running", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // hc shows the terminal live with no foreground: no server pid to read, nothing signalled.
  const hc = fakeHc({ procs: { 7002: { cwd: ROOT } }, ports: { 7002: [3210] } });
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  t.foreground = null;
  const r = await stopServer({ root: ROOT, terminal: t.address, logPath, ports: [3210], procs: KNOWN_7002_7003, ...HEAD }, stopDeps(hc).deps);
  assert.deepEqual(r, {
    ok: false, reason: "unreadable", terminal: t.address,
    message: "the Spotlight terminal could not be read (no foreground): the server may still be running",
  });
  assert.deepEqual(hc.signals, []);
  assert.equal(hc.verbs().includes("interrupt"), false);

  // hc keeps showing the old script in front after it was killed (a stale read).
  const stale = fakeHc({ lingers: Infinity });
  const sd = stopDeps(stale);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  const before = JSON.parse((await stale.exec("hc", ["get", s.terminal, "--json"])).stdout);
  const exec = async (file, args) =>
    file === "hc" && args[0] === "get" && stale.verbs().includes("interrupt")
      ? { code: 0, stdout: JSON.stringify(before), stderr: "" }
      : stale.exec(file, args);
  const r2 = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec });
  assert.deepEqual(r2, {
    ok: false, reason: "still-running", terminal: s.terminal, forced: 1, pid: s.pid,
    message: `Spotlight's server (pid ${s.pid}) still leads the terminal after it was killed: the server may still be running`,
  });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[s.pid, "SIGTERM"]]);
  rmSync(dir, { recursive: true, force: true });
});

// ── K4/K5: the stop's own note says why, on every path ────────────────────

// The last line of a log, and that it is the only stop note there.
const lastLine = (path) => readFileSync(path, "utf8").trimEnd().split("\n").at(-1);
const stopNotes = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.includes("Spotlight off —")).length;

test("stopServer (K4): every NOT stopped return writes its cause in its own note, once: unreadable, interrupt-failed, still-running (with the Ctrl-C hc couldn't send)", async () => {
  const dir = tmp();
  const notStopped = (reason, cause) =>
    new RegExp(`^── Spotlight: login \\(feat/login\\) · Spotlight off — server NOT stopped \\(${reason}\\): ${cause} · \\d\\d:\\d\\d:\\d\\d ──$`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Unreadable: hc shows the terminal live with no foreground.
  const unreadableLog = join(dir, "unreadable.log");
  const hc = fakeHc();
  const t = hc.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  t.foreground = null;
  const r = await stopServer({ root: ROOT, terminal: t.address, logPath: unreadableLog, ...HEAD }, stopDeps(hc).deps);
  assert.equal(r.reason, "unreadable");
  assert.match(lastLine(unreadableLog), notStopped("unreadable", esc(r.message)));
  assert.equal(stopNotes(unreadableLog), 1);
  assert.match(r.message, /^the Spotlight terminal could not be read \(no foreground\): the server may still be running$/);

  // Interrupt-failed: no Ctrl-C, and nothing read after it.
  const ifLog = join(dir, "interrupt.log");
  const down = fakeHc();
  const dd = stopDeps(down);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath: ifLog, ...HEAD }, dd.deps);
  let sent = false;
  const blind = async (file, args) => {
    if (unwrapEnv(file, args).file === "ps") return { code: 2, stdout: "", stderr: "ps: bad" };
    if (file === "hc" && args[0] === "interrupt") sent = true;
    if (sent && file === "hc" && args[0] === "get") return { code: 1, stdout: "", stderr: "hc: can't reach herdr-core" };
    return interruptFails(down)(file, args);
  };
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath: ifLog, serverPid: s2.pid, ...HEAD }, { ...dd.deps, exec: blind });
  assert.equal(r2.reason, "interrupt-failed");
  assert.match(lastLine(ifLog), notStopped("interrupt-failed", esc(r2.message)));
  assert.equal(stopNotes(ifLog), 1);

  // Still-running, with the Ctrl-C hc couldn't send: one note says both.
  for (const ctrlC of [true, false]) {
    const srLog = join(dir, `still-${ctrlC}.log`);
    const stale = fakeHc({ lingers: Infinity });
    const sd = stopDeps(stale);
    const s = await startServer({ root: ROOT, line: "pnpm dev", logPath: srLog, ...HEAD }, sd.deps);
    const before = JSON.parse((await stale.exec("hc", ["get", s.terminal, "--json"])).stdout);
    let interrupted = false;
    const exec = async (file, args) => {
      if (file === "hc" && args[0] === "interrupt") {
        interrupted = true;
        if (ctrlC) return { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "failed", message: "herdr-core\nunreachable" } }) };
      }
      if (interrupted && file === "hc" && args[0] === "get") return { code: 0, stdout: JSON.stringify(before), stderr: "" };
      return stale.exec(file, args);
    };
    const r3 = await stopServer({ root: ROOT, terminal: s.terminal, logPath: srLog, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec });
    assert.equal(r3.reason, "still-running", String(ctrlC));
    const tail = ctrlC ? "; the Ctrl-C could not be sent: herdr-core unreachable" : "";
    assert.match(lastLine(srLog), notStopped("still-running", esc(r3.message + tail)), String(ctrlC));
    assert.equal(stopNotes(srLog), 1, String(ctrlC));
  }
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (K5): a Ctrl-C hc couldn't send is in the stop's one note, stopped or not: (forced: …; the Ctrl-C could not be sent: …), and a survivor's NOT stopped line", async () => {
  const dir = tmp();
  // Survived: a child that isn't ours to signal, and no Ctrl-C.
  const logPath = join(dir, "survived.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT, eperm: true } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec: interruptFails(hc) });
  assert.equal(r.reason, "survived");
  assert.equal(r.interruptError, "herdr-core unreachable");
  assert.match(
    lastLine(logPath),
    /^── Spotlight: login \(feat\/login\) · Spotlight off — server NOT stopped: 1 processes survived \(pids 7001; the Ctrl-C could not be sent: herdr-core unreachable\) · \d\d:\d\d:\d\d ──$/,
  );
  assert.equal(stopNotes(logPath), 1);

  // Nothing left to kill once read, and no Ctrl-C: stopped, never "interrupt sent".
  const goneLog = join(dir, "gone.log");
  const quick = fakeHc();
  const qd = stopDeps(quick);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath: goneLog, ...HEAD }, qd.deps);
  const exec = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") {
      // The server exits on its own as the Ctrl-C fails.
      const term = quick.terms.get(s2.terminal);
      quick.dead.add(term.foreground.pid);
      term.foreground = { argv: ["/bin/zsh", "-l"], cwd: ROOT, name: "zsh", pid: term.pid };
      return { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "failed", message: "herdr-core unreachable" } }) };
    }
    return quick.exec(file, args);
  };
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath: goneLog, serverPid: s2.pid, ...HEAD }, { ...qd.deps, exec });
  assert.deepEqual(r2, { ok: true, stopped: true, terminal: s2.terminal, forced: 0, interruptError: "herdr-core unreachable" });
  assert.match(lastLine(goneLog), /· Spotlight off — server stopped \(nothing left to kill; the Ctrl-C could not be sent: herdr-core unreachable\) · /);
  rmSync(dir, { recursive: true, force: true });
});

// The note of a stop that refused to signal some of the server.
const refusedNote = (n, pids, refused) =>
  new RegExp(`── Spotlight: login \\(feat/login\\) · Spotlight off — server NOT stopped: ${n} processes survived \\(pids ${pids}; not signalled: ${refused}\\) · \\d\\d:\\d\\d:\\d\\d ──\\n$`);

test("stopServer (F4): a leftover stopLeftovers refuses (its tree holds the CLI itself) is not stopped: the stop fails as survived, with the refused pids and the NOT stopped note", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  // At a free prompt: 7002 escaped earlier and is still on 3210 in the root,
  // but the CLI runs under it.
  const idle = fakeHc({ procs: { 7002: { cwd: ROOT } }, ports: { 7002: [3210] } });
  idle.children[7002] = [process.pid];
  const id = stopDeps(idle);
  const t = idle.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const r = await stopServer({ root: ROOT, terminal: t.address, logPath, ports: [3210], procs: KNOWN_7002_7003, ...HEAD }, id.deps);
  assert.deepEqual(r, { ok: false, reason: "survived", terminal: t.address, forced: 0, survivors: [7002], refused: [7002], escaped: [] });
  assert.deepEqual(idle.signals, []);
  assert.match(readFileSync(logPath, "utf8"), refusedNote(1, "7002", "7002"));

  // With the server running: its child 7001 ignores the Ctrl-C, and the CLI
  // ends up under it during the wait.
  const runLog = join(dir, "run.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath: runLog, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const exec = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") hc.children[7001] = [process.pid];
    return hc.exec(file, args);
  };
  const r2 = await stopServer({ root: ROOT, terminal: s.terminal, logPath: runLog, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec });
  assert.deepEqual(r2, { ok: false, reason: "survived", terminal: s.terminal, forced: 0, survivors: [7001], refused: [7001] });
  assert.deepEqual(sd.signals, []);
  const log = readFileSync(runLog, "utf8");
  assert.match(log, refusedNote(1, "7001", "7001"));
  assert.doesNotMatch(log, /server stopped/);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (F8): without an injected kill it throws before doing anything, and never falls back to the real process.kill", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT, ignoresTerm: true } } });
  const clock = fakeClock();
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, { exec: hc.exec, ...clock });
  hc.children[s.pid] = [7001];
  // For this test only, the real process.kill is a stand-in that records and
  // signals nobody: a fallback to it shows up here, and reaches no process.
  const real = process.kill;
  const used = [];
  process.kill = (pid, sig) => {
    used.push([pid, sig]);
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  try {
    await assert.rejects(stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { exec: hc.exec, ...clock }), /deps\.kill/);
  } finally {
    process.kill = real;
  }
  assert.deepEqual(used, []);
  assert.equal(hc.verbs().includes("interrupt"), false, "no Ctrl-C either");
  rmSync(dir, { recursive: true, force: true });
});

// ── L1, L2: a start that didn't go through says why in the log ────────────

// An exec whose hc answers `verb` with hc's error, the rest as `hc`'s.
const failing = (hc, verb, code, kind, message) => async (file, args) =>
  file === "hc" && args[0] === verb ? { code, stdout: "", stderr: JSON.stringify({ error: { kind, message } }) } : hc.exec(file, args);

test("startServer, restartServer (L2): a start that didn't go through leaves one note with its reason and hc's own words, which the CLI's Spanish error never carries; an invalid command, which touched no terminal, leaves none", async () => {
  const dir = tmp();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noteOf = (text) => new RegExp(`^── Spotlight: login \\(feat/login\\) · ${esc(text)} · \\d\\d:\\d\\d:\\d\\d ──$`);
  const notes = (path) => readFileSync(path, "utf8").split("\n").filter((l) => /Server not (re)?started/.test(l)).length;
  const logOf = (name) => join(dir, `${name}.log`);
  const check = (name, r, reason, text) => {
    assert.equal(r.reason, reason, name);
    assert.match(lastLine(logOf(name)), noteOf(text), name);
    assert.equal(notes(logOf(name)), 1, name);
  };

  // name-taken: a live terminal that isn't Spotlight's holds sl-<slug>.
  const taken = fakeHc();
  taken.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: "/somewhere/else" } });
  const r1 = await startServer({ root: ROOT, line: "pnpm dev", logPath: logOf("taken"), ...HEAD }, { exec: taken.exec, ...fakeClock() });
  check("taken", r1, "name-taken", `Server not started — the server terminal's name is taken (${r1.message})`);

  // terminal-failed: hc couldn't make it.
  const made = fakeHc();
  const r2 = await startServer(
    { root: ROOT, line: "pnpm dev", logPath: logOf("made"), ...HEAD }, { exec: failing(made, "run", 1, "io", "hc: no route to core"), ...fakeClock() },
  );
  check("made", r2, "terminal-failed", "Server not started — hc could not make the server terminal (hc: no route to core)");
  // M9: hc's words that are only control bytes say nothing: no empty "( )".
  const mute2 = fakeHc();
  const r2b = await startServer(
    { root: ROOT, line: "pnpm dev", logPath: logOf("made2"), ...HEAD }, { exec: failing(mute2, "run", 1, "io", "\u0007\r\n"), ...fakeClock() },
  );
  check("made2", r2b, "terminal-failed", "Server not started — hc could not make the server terminal");

  // unreadable: hc can't read the terminal, before typing or as it would type.
  const blind = fakeHc();
  const bt = blind.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  const r3 = await startServer(
    { root: ROOT, terminal: bt.address, line: "pnpm dev", logPath: logOf("blind"), ...HEAD }, { exec: failing(blind, "get", 1, "io", "core restarting"), ...fakeClock() },
  );
  check("blind", r3, "unreadable", "Server not started — the Spotlight terminal's state could not be read (core restarting)");
  let gets = 0;
  const flaky = async (file, args) => (file === "hc" && args[0] === "get" && ++gets > 1 ? { code: 1, stdout: "", stderr: "core restarting" } : blind.exec(file, args));
  const r4 = await startServer({ root: ROOT, terminal: bt.address, line: "pnpm dev", logPath: logOf("flaky"), ...HEAD }, { exec: flaky, ...fakeClock() });
  check("flaky", r4, "unreadable", "Server not started — the Spotlight terminal's state could not be read (core restarting)");

  // terminal-gone: it closed between its check and the line.
  const closing = fakeHc();
  const ct = closing.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  let seen = 0;
  const closes = async (file, args) =>
    file === "hc" && args[0] === "get" && ++seen > 1
      ? { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) }
      : closing.exec(file, args);
  const r5 = await startServer({ root: ROOT, terminal: ct.address, line: "pnpm dev", logPath: logOf("gone"), ...HEAD }, { exec: closes, ...fakeClock() });
  check("gone", r5, "terminal-gone", "Server not started — the Spotlight terminal closed");

  // send-failed: hc couldn't type the line.
  const mute = fakeHc();
  const r6 = await startServer(
    { root: ROOT, line: "pnpm dev", logPath: logOf("mute"), ...HEAD }, { exec: failing(mute, "send", 11, "finished", "t1 has finished"), ...fakeClock() },
  );
  check("mute", r6, "send-failed", "Server not started — hc could not type into the Spotlight terminal (t1 has finished)");
  assert.equal(r6.oldServerRuns, undefined, "no server of before in a new terminal");

  // A restart whose old server never stopped (L1): hc couldn't send the
  // Ctrl-C, or the server ignored it. Either way it still runs.
  const up = fakeHc();
  const deps = { exec: up.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath: logOf("interrupt"), ...HEAD }, deps);
  const r7 = await restartServer(
    { root: ROOT, terminal: s.terminal, line: "pnpm dev", logPath: logOf("interrupt"), serverPid: s.pid, ...HEAD },
    { ...deps, exec: failing(up, "interrupt", 1, "io", "hc: no route to core") },
  );
  check("interrupt", r7, "interrupt-failed", "Server not restarted — the Ctrl-C could not be sent: the old server still runs (hc: no route to core)");
  assert.equal(r7.oldServerRuns, true);
  const stuck = fakeHc({ lingers: Infinity });
  const sd = { exec: stuck.exec, ...fakeClock() };
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath: logOf("stuck"), ...HEAD }, sd);
  const r8 = await restartServer({ root: ROOT, terminal: s2.terminal, line: "pnpm dev", logPath: logOf("stuck"), serverPid: s2.pid, ...HEAD }, sd);
  check("stuck", r8, "still-running", "Server not restarted — the old server did not stop on Ctrl-C and still runs");
  assert.equal(r8.oldServerRuns, true);

  // invalid-command: nothing touched, nothing logged.
  const r9 = await startServer({ root: ROOT, line: "pnpm dev\nrm -rf ~", logPath: logOf("invalid"), ...HEAD }, { exec: fakeHc().exec, ...fakeClock() });
  assert.deepEqual(r9, { ok: false, reason: "invalid-command" });
  assert.equal(existsSync(logOf("invalid")), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── M4: a Ctrl-C hc couldn't send, looked at again ─────────────────────────

test("restartServer (M4): a Ctrl-C hc couldn't send is an old server still running only while hc still shows it in front, or can't say; a terminal that closed meanwhile is a failed start (terminal-gone), and one back at its prompt starts", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const refused = (message) => ({ code: 11, stdout: "", stderr: JSON.stringify({ error: { kind: "finished", message } }) });

  // It closed between the look and the Ctrl-C.
  const closing = fakeHc();
  const deps = { exec: closing.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, deps);
  const closes = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") {
      closing.terms.get(s.terminal).state = "finished";
      return refused(`${s.terminal} has finished`);
    }
    return closing.exec(file, args);
  };
  const r1 = await restartServer({ root: ROOT, terminal: s.terminal, line: "pnpm dev", logPath, serverPid: s.pid, ...HEAD }, { ...deps, exec: closes });
  assert.deepEqual({ ok: r1.ok, reason: r1.reason, oldServerRuns: r1.oldServerRuns }, { ok: false, reason: "terminal-gone", oldServerRuns: undefined });
  assert.match(lastLine(logPath), /Server not started — the Spotlight terminal closed/);

  // Its server let go of the prompt by itself: the line is typed.
  const ended = fakeHc();
  const ed = { exec: ended.exec, ...fakeClock() };
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, ed);
  const lets = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") {
      const t = ended.terms.get(s2.terminal);
      t.foreground = { argv: ["/bin/zsh", "-l"], cwd: t.cwd, name: "zsh", pid: t.pid };
      return refused("hc: no route to core");
    }
    return ended.exec(file, args);
  };
  const r2 = await restartServer({ root: ROOT, terminal: s2.terminal, line: "pnpm dev", logPath, serverPid: s2.pid, ...HEAD }, { ...ed, exec: lets });
  assert.deepEqual({ ok: r2.ok, started: r2.started }, { ok: true, started: true });
  assert.equal(ended.sent.length, 2);

  // hc can't read the terminal after it either: doubt is never death.
  const blind = fakeHc();
  const bd = { exec: blind.exec, ...fakeClock() };
  const s3 = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, bd);
  let dark = false;
  const darkens = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") {
      dark = true;
      return refused("hc: no route to core");
    }
    if (dark && file === "hc" && args[0] === "get") return { code: 1, stdout: "", stderr: "core restarting" };
    return blind.exec(file, args);
  };
  const r3 = await restartServer({ root: ROOT, terminal: s3.terminal, line: "pnpm dev", logPath, serverPid: s3.pid, ...HEAD }, { ...bd, exec: darkens });
  assert.deepEqual({ ok: r3.ok, reason: r3.reason, oldServerRuns: r3.oldServerRuns }, { ok: false, reason: "interrupt-failed", oldServerRuns: true });
  assert.equal(blind.sent.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── Review r8: N5, N6 ──────────────────────────────────────────────────────

test("restartServer (N5): a Ctrl-C hc couldn't send, with no message, carries hc's error kind, as stopServer's interruptError does, and its log line names it", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const up = fakeHc();
  const deps = { exec: up.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, deps);
  const r = await restartServer(
    { root: ROOT, terminal: s.terminal, line: "pnpm dev", logPath, serverPid: s.pid, ...HEAD },
    { ...deps, exec: failing(up, "interrupt", 1, "io", "") },
  );
  assert.deepEqual({ reason: r.reason, message: r.message, oldServerRuns: r.oldServerRuns }, { reason: "interrupt-failed", message: "io", oldServerRuns: true });
  assert.match(lastLine(logPath), /· Server not restarted — the Ctrl-C could not be sent: the old server still runs \(io\) · \d\d:\d\d:\d\d ──$/);
  rmSync(dir, { recursive: true, force: true });
});

test("stopServer (N6): a Ctrl-C hc couldn't send whose words are only control bytes says so with no empty words after it, in the forced line and the nothing-left-to-kill one", async () => {
  const dir = tmp();
  const mute = async (file, args, hc) =>
    file === "hc" && args[0] === "interrupt"
      ? { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "failed", message: "\u0007\r\n" } }) }
      : hc.exec(file, args);

  // Its tree is killed (forced).
  const logPath = join(dir, "forced.log");
  const hc = fakeHc({ procs: { 7001: { cwd: ROOT } } });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.children[s.pid] = [7001];
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, { ...sd.deps, exec: (f, a) => mute(f, a, hc) });
  assert.equal(r.ok, true);
  assert.match(readFileSync(logPath, "utf8"), stopNote("forced: 2 processes; the Ctrl-C could not be sent"));

  // The server exits on its own as the Ctrl-C fails: nothing left to kill.
  const goneLog = join(dir, "gone.log");
  const quick = fakeHc();
  const qd = stopDeps(quick);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath: goneLog, ...HEAD }, qd.deps);
  const exits = async (file, args) => {
    if (file === "hc" && args[0] === "interrupt") {
      const term = quick.terms.get(s2.terminal);
      quick.dead.add(term.foreground.pid);
      term.foreground = { argv: ["/bin/zsh", "-l"], cwd: ROOT, name: "zsh", pid: term.pid };
    }
    return mute(file, args, quick);
  };
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath: goneLog, serverPid: s2.pid, ...HEAD }, { ...qd.deps, exec: exits });
  assert.equal(r2.ok, true);
  assert.match(lastLine(goneLog), /· Spotlight off — server stopped \(nothing left to kill; the Ctrl-C could not be sent\) · \d\d:\d\d:\d\d ──$/);
  rmSync(dir, { recursive: true, force: true });
});

// ── Logs and peek ────────────────────────────────────────────────────────

test("serverLogs: the log file's plain tail; hc read is the fallback when the file is missing", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  writeFileSync(logPath, "\u001b[32mready\u001b[39m\r\nGET / 200\r\n");
  const hc = fakeHc({ readText: "\u001b[31mfrom screen\u001b[39m\nline 2\n" });
  const t = hc.add({ name: "sl-app", labels: { [SERVER_LABEL]: ROOT } });
  assert.deepEqual(await serverLogs({ logPath, terminal: t.address, lines: 1 }, { exec: hc.exec }), { source: "file", text: "GET / 200\n" });
  assert.equal(hc.verbs().includes("read"), false);
  rmSync(logPath);
  assert.deepEqual(await serverLogs({ logPath, terminal: t.address, lines: 50 }, { exec: hc.exec }), { source: "terminal", text: "from screen\nline 2\n" });
  assert.deepEqual(hc.calls.find((c) => c[1] === "read"), ["hc", "read", t.address, "--lines", "50", "--json"]);
  assert.deepEqual(await serverLogs({ logPath, terminal: "sl-nope" }, { exec: hc.exec }), { source: null, text: "" });
  assert.deepEqual(await serverLogs({ logPath }, { exec: hc.exec }), { source: null, text: "" });
  assert.equal(existsSync(logPath), false);
  rmSync(dir, { recursive: true, force: true });
});

test("peek: `herdr-app do terminal.peek --terminal <server t>`", async () => {
  assert.deepEqual(peekArgv("t2b"), ["herdr-app", "do", "terminal.peek", "--terminal", "t2b"]);
  const hc = fakeHc();
  assert.deepEqual(await peekServer("t2b", { exec: hc.exec }), { ok: true });
  assert.deepEqual(hc.calls, [peekArgv("t2b")]);
  const failing = async () => ({ code: 1, stdout: "", stderr: '{"error":"no window"}' });
  assert.deepEqual(await peekServer("t2b", { exec: failing }), { ok: false, message: '{"error":"no window"}' });
});

test("showServer (D38, Ver server): a server terminal in a tab → space.select + tab.select of it, no peek; with no tab → the peek overlay as before", async () => {
  const hc = fakeHc({ herdr: true });
  const s = hc.addSpace({ id: "spRoot", tabs: [[{}], [{ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } }]] });
  const mine = s.tabs[1].terminals[0].terminal;
  for (const terminal of [mine, serverTerminalName(ROOT)]) {
    hc.did.length = 0;
    assert.deepEqual(await showServer(terminal, { exec: hc.exec }), { ok: true, how: "tab" });
    assert.deepEqual(hc.did, [
      { command: "space.select", args: { id: "spRoot" } },
      { command: "tab.select", args: { id: s.tabs[1].id } },
    ]);
  }
  assert.equal(hc.calls.some((c) => c[2] === "terminal.peek"), false);

  // Hidden (no tab): Herdr's peek, the argv of before.
  const hidden = fakeHc({ herdr: true });
  const t = hidden.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  assert.deepEqual(await showServer(t.address, { exec: hidden.exec }), { ok: true, how: "peek" });
  assert.deepEqual(hidden.calls.filter((c) => c[1] === "do"), [peekArgv(t.address)]);
  // Herdr that can't say where it is: the peek too.
  const blind = fakeHc();
  const b = blind.add({ name: serverTerminalName(ROOT), labels: { [SERVER_LABEL]: ROOT } });
  assert.deepEqual(await showServer(b.address, { exec: blind.exec }), { ok: true, how: "peek" });
  assert.deepEqual(blind.calls.filter((c) => c[1] === "do"), [peekArgv(b.address)]);
});

test("stopServer (D38): the turn-off of a server in its Spotlight tab is D26's, unchanged: no Herdr call, no label, no kill; the terminal and its tab stay", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc({ herdr: true });
  hc.addSpace({ id: "spRoot", tabs: [[{}]] });
  const sd = stopDeps(hc);
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, sd.deps);
  hc.ports[s.pid] = [3000];
  const from = hc.calls.length;
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 0 });
  const during = hc.calls.slice(from);
  assert.equal(during.some((c) => c[0] === "herdr-app"), false, JSON.stringify(during));
  for (const verb of ["label", "kill", "run", "rm"]) assert.equal(during.some(hcCall(verb)), false, verb);
  assert.match(readFileSync(logPath, "utf8"), stopNote("interrupt sent"));
  assert.equal(hc.terms.get(s.terminal).state, "live");
  assert.deepEqual(hc.world[0].tabs.map((t) => t.name), ["Spotlight"]);
  rmSync(dir, { recursive: true, force: true });
});
