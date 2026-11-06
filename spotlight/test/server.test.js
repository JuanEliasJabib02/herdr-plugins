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
  startServer, restartServer, stopServer, serverLogs, peekArgv, peekServer,
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
function fakeHc({ lingers = 1, ports = {}, readText = "" } = {}) {
  const terms = new Map();
  const calls = [];
  const sent = [];
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
    if (file === "pgrep") {
      const kids = [...terms.values()].filter((t) => t.foreground && t.foreground.pid !== t.pid && t.pid === Number(args[1]));
      return kids.length ? { code: 0, stdout: kids.map((t) => `${t.foreground.pid}\n`).join(""), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof") {
      const lines = [];
      for (const [pid, list] of Object.entries(ports)) {
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
  return { exec, calls, sent, terms, add, verbs: () => calls.filter((c) => c[0] === "hc").map((c) => c[1]) };
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

test("stopServer: interrupts only Spotlight's own server and logs it; a shell or a foreign process is left alone", async () => {
  const dir = tmp();
  const logPath = join(dir, "app.log");
  const hc = fakeHc();
  const deps = { exec: hc.exec, ...fakeClock() };
  const s = await startServer({ root: ROOT, line: "pnpm dev", logPath, workspace: "login", branch: "feat/login" }, deps);
  const r = await stopServer({ root: ROOT, terminal: s.terminal, logPath, workspace: "login", branch: "feat/login" }, deps);
  assert.deepEqual(r, { ok: true, stopped: true, terminal: s.terminal });
  assert.ok(readFileSync(logPath, "utf8").endsWith("── Spotlight: login (feat/login) · stopped · 22:58:04 ──\n"));
  assert.equal(hc.terms.get(s.terminal).state, "live", "the terminal stays for the next start");

  const idle = await stopServer({ root: ROOT, terminal: s.terminal, logPath }, deps);
  assert.deepEqual(idle, { ok: true, stopped: false, reason: "not-running", terminal: s.terminal });
  const n = hc.verbs().filter((v) => v === "interrupt").length;
  hc.terms.get(s.terminal).foreground = { ...VIM_FG };
  const foreign = await stopServer({ root: ROOT, terminal: s.terminal, logPath }, deps);
  assert.deepEqual(foreign, { ok: true, stopped: false, reason: "busy", terminal: s.terminal });
  assert.equal(hc.verbs().filter((v) => v === "interrupt").length, n);
  const gone = await stopServer({ root: ROOT, terminal: "sl-nope", logPath }, deps);
  assert.deepEqual(gone, { ok: true, stopped: false, reason: "terminal-gone", terminal: null });
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
