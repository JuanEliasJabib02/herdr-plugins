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
const FAKE_START = "Sun Nov  8 22:00:00 2026";
function fakeHc({
  lingers = 1, ports = {}, readText = "", shellReads = null, startupFg = null, children = {}, procs = {}, fgIgnoresTerm = false,
  starts = {},
} = {}) {
  const terms = new Map();
  const calls = [];
  const sent = [];
  const dead = new Set();
  const signals = [];
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
  const exec = async (file, args) => {
    calls.push([file, ...args]);
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
        const [k, ...v] = opt("--label").split("=");
        const made = add({ name, labels: { [k]: v.join("=") }, cwd: opt("--cwd") });
        if (shellReads !== null) {
          made.foreground = startupFg;
          made.pendingShell = shellReads;
        }
        return ok({ address: made.address, agent: "zsh", cwd: made.cwd, name, state: "live", turn: 0 });
      }
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
    exec, kill, calls, sent, terms, add, ports, children, procs, starts, dead, signals,
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

// ── Start ─────────────────────────────────────────────────────────────────

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
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, serverPid: s.pid, ports: [3210, 8080], ...HEAD }, sd.deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal, forced: 1 });
  assert.deepEqual(sd.signals.map(({ pid, sig }) => [pid, sig]), [[7002, "SIGTERM"]]);
  assert.equal(hc.dead.has(7003), false);
  assert.ok(!hc.signals.some((x) => x.pid === shell || x.pid === 7003));

  // Only the one outside the root: nothing is killed and the stop doesn't wait on it.
  const only = fakeHc({ procs, ports: { 7003: [8080] } });
  const od = stopDeps(only);
  const s2 = await startServer({ root: ROOT, line: "pnpm dev", logPath, ...HEAD }, od.deps);
  od.mark();
  const r2 = await stopServer({ root: ROOT, terminal: s2.terminal, logPath, serverPid: s2.pid, ports: [8080], ...HEAD }, od.deps);
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
  const r = await stopServer({ root: ROOT, terminal: t.address, logPath, ports: [3210, 8080], ...HEAD }, sd.deps);
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
  const r2 = await stopServer({ root: ROOT, terminal: v.address, logPath: join(dir, "busy.log"), ports: [3210], ...HEAD }, bd.deps);
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
  const r2 = await stopServer({ root: ROOT, terminal: t.address, logPath: idleLog, ports: [3210], ...HEAD }, id.deps);
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
  const r = await stopServer({ root: ROOT, terminal: "t9", logPath, ports: [3210, 8080], ...HEAD }, sd.deps);
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
  const r2 = await stopServer({ root: ROOT, terminal: "t9", logPath: quietLog, ports: [8080], ...HEAD }, stopDeps(quiet).deps);
  assert.deepEqual(r2, { ok: true, stopped: false, reason: "terminal-gone", terminal: null, forced: 0, escaped: [] });
  assert.deepEqual(quiet.signals, []);
  assert.equal(existsSync(quietLog), false);
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
