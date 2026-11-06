// A repo's Spotlight server terminal (D10). Node-only (it writes the log
// through server-log.js): the CLI uses it, the mod never imports it.
//
// One hidden hc terminal per repo, created in the repo root:
//   hc run --bg --no-parent --keep --name sl-<slug> --label spotlight.repo=<root> --cwd <root> -- /bin/zsh -l
// No herdr.space label, so no space shows it; "Ver server" peeks at it. The
// server line is typed into its shell wrapped for the log (D11):
//   script -F -q -a '<logPath>' /bin/zsh -c '<line>'
// -F flushes every write; `-c`, not `-lc`, so the outer login shell's PATH
// (nvm's Node) is the one the server runs on; `script` keeps a pty, so the
// server keeps its TTY behavior and `hc interrupt`'s Ctrl-C reaches it.
//
// Rules: type only when the shell owns the foreground; never over a process
// Spotlight didn't start. Spotlight's own server is the foreground whose
// argv is `script` with this repo's log as its file (that survives a `light`
// killed between typing and recording the pid); the recorded pid is only a
// cross-check, used when the argv can't be read. Restart = `hc interrupt`,
// wait for the prompt, type again. Stop (toggle off) interrupts only
// Spotlight's own server and keeps the terminal for the next start. hc is
// reached through an injected `exec(file, args) → { code, stdout, stderr }`
// and the clock through injected `now()` / `sleep(ms)`, so tests run on a
// fake hc. The probe that pinned hc's shapes is in RECIPE.md "Server
// terminal probe".

import {
  repoSlug, appendLogHeader, rotateLog, tailLog, stripTerminalSequences, DEFAULT_TAIL_LINES,
} from "./server-log.js";
import { treePorts, pickPort, portLabel, portUrl } from "./ports.js";

// The label that ties a server terminal to its repo root.
export const SERVER_LABEL = "spotlight.repo";
// The terminal's program: a login zsh (absolute: `hc run --` takes no shell).
const SHELL_ARGV = ["/bin/zsh", "-l"];

// Polling while a typed line forks or an interrupted server lets go.
const POLL_MS = 250;
// A terminal just made: how long its login shell may take to lead. hc shows no
// foreground for its first moments (live: none at +326 ms, zsh at +612 ms).
const SHELL_MS = 5000;
// After typing: how long to look for `script` in front to record its pid.
const SEEN_MS = 3000;
// After an interrupt: how long the prompt may take to come back. Live, hc
// answered "stopped" while `script` was still the foreground (probe).
const PROMPT_MS = 5000;
// `hc interrupt --timeout`: seconds it watches for an effect.
const INTERRUPT_WATCH_S = 5;

// Start decisions that typed nothing leave a line in the log, as Orca's
// spotlight-server-start-notes.ts does.
const NOTES = {
  busy: "Server left alone — the Spotlight terminal runs something Spotlight didn't start",
  "already-running": "Server left alone — Spotlight's server already runs there",
  unreadable: "Server not started — the Spotlight terminal's state could not be read",
};

const SHELL_NAMES = new Set(
  "bash zsh sh fish nu ksh mksh dash ash tcsh csh elvish xonsh".split(" "),
);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowOf = (deps) => (deps.now ?? Date.now)();
const sleepOf = (deps, ms) => (deps.sleep ?? defaultSleep)(ms);
const baseName = (p) => String(p ?? "").split("/").pop();

// ── Names, lines, argv ─────────────────────────────────────────────────────

// The server terminal's name: sl-<repo slug> (a valid hc name, ≤ 32 chars).
export function serverTerminalName(root) {
  return `sl-${repoSlug(root)}`;
}

// One non-empty line only: control bytes typed into a terminal act as
// keystrokes (Orca's normalizeSpotlightServerCommand). null when not.
export function normalizeServerLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  // eslint-disable-next-line no-control-regex
  return trimmed && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

// A single-quoted shell word: ' becomes '\'' (close, escaped quote, reopen).
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The line typed into the server terminal (D10), or null for a line that
// isn't one safe line (or a log path with control bytes).
export function wrapServerLine(line, logPath) {
  const command = normalizeServerLine(line);
  // eslint-disable-next-line no-control-regex
  if (!command || typeof logPath !== "string" || !logPath || /[\u0000-\u001f\u007f]/.test(logPath)) return null;
  return `script -F -q -a ${shellQuote(logPath)} /bin/zsh -c ${shellQuote(command)}`;
}

// `hc run …` for a repo's server terminal (D10), with --json for its address.
export function createTerminalArgv(root) {
  return [
    "hc", "run", "--bg", "--no-parent", "--keep", "--name", serverTerminalName(root),
    "--label", `${SERVER_LABEL}=${root}`, "--cwd", root, "--json", "--", ...SHELL_ARGV,
  ];
}

// `herdr-app do terminal.peek --terminal <t>`: Herdr's peek over the tab.
export function peekArgv(terminal) {
  return ["herdr-app", "do", "terminal.peek", "--terminal", terminal];
}

// ── Reading a terminal ─────────────────────────────────────────────────────

function parseJson(text) {
  try {
    const v = JSON.parse(String(text ?? "").trim());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// One hc call: { ok: true, value } with its JSON, or { ok: false, error:
// { kind, message } } with hc's own error (`{"error":{kind,message}}`, on
// stdout or stderr; exit 3 is not_found) or why it couldn't run.
async function hc(deps, args) {
  let r;
  try {
    r = await deps.exec("hc", args);
  } catch (e) {
    return { ok: false, error: { kind: "spawn", message: String(e?.message ?? e) } };
  }
  const json = parseJson(r?.stdout) ?? parseJson(r?.stderr);
  if (r?.code === 0 && json && !json.error) return { ok: true, value: json };
  const err = json?.error && typeof json.error === "object" ? json.error : {};
  return {
    ok: false,
    error: {
      kind: err.kind ?? (r?.code === 3 ? "not_found" : "failed"),
      message: err.message ?? String(r?.stderr || r?.stdout || `hc exited ${r?.code}`).trim(),
    },
  };
}

// `hc get <t> --json`: { terminal }, { missing: true } (no such terminal), or
// { error } when hc couldn't say.
async function getTerminal(t, deps) {
  const r = await hc(deps, ["get", t, "--json"]);
  if (r.ok) return { terminal: r.value };
  if (r.error.kind === "not_found") return { missing: true };
  return { error: r.error.message || r.error.kind };
}

// The shell owns the foreground: the terminal's own process (the zsh -l)
// leads the foreground group. A `sh` shim in front (pnpm) is a job, though
// its name is a shell's. Without the terminal's pid, a shell's name decides.
export function isShellForeground(term) {
  const fg = term?.foreground;
  if (!fg) return false;
  if (Number.isInteger(term.pid)) return fg.pid === term.pid;
  return SHELL_NAMES.has(baseName(fg.name).replace(/^-/, ""));
}

// script's file operand: `script [-adeFkpqr] [-t time] [file [command …]]`.
function scriptFile(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") return argv[i + 1] ?? null;
    if (a.startsWith("-") && a.length > 1) {
      if (/^-[A-Za-z]*t$/.test(a)) i++; // -t takes the next word
      continue;
    }
    return a;
  }
  return null;
}

// Spotlight's own server is in front: `script` writing this repo's log.
// When the argv can't be read, the recorded pid decides.
export function ownsForeground(fg, { logPath, serverPid } = {}) {
  if (!fg) return false;
  const argv = Array.isArray(fg.argv) ? fg.argv : [];
  if (argv.length > 0) return baseName(argv[0]) === "script" && scriptFile(argv) === logPath;
  return serverPid != null && fg.pid === serverPid;
}

// What a terminal (an `hc get` result, or null when there's none) holds:
//   gone      — none, or finished (closed, hc kill)
//   unknown   — live, but no foreground to read
//   shell     — the prompt is free
//   spotlight — Spotlight's server (pid; stalePid when it isn't the recorded one)
//   foreign   — something Spotlight didn't start
// `rootPid` is the terminal's own process, where the ports walk starts.
export function classifyTerminal(term, { logPath, serverPid } = {}) {
  if (!term || term.state !== "live") return { kind: "gone", terminal: term?.address ?? null };
  const base = { terminal: term.address, rootPid: Number.isInteger(term.pid) ? term.pid : null };
  const fg = term.foreground;
  if (!fg) return { kind: "unknown", ...base };
  if (isShellForeground(term)) return { kind: "shell", ...base };
  if (ownsForeground(fg, { logPath, serverPid })) {
    return { kind: "spotlight", ...base, pid: fg.pid, stalePid: fg.pid !== (serverPid ?? null) };
  }
  return { kind: "foreign", ...base, pid: fg.pid, name: fg.name ?? null };
}

// classifyTerminal of the repo's terminal (`terminal`, else its name), read
// now. hc failing for any reason but "no such terminal" reads `unknown`:
// doubt is never death (Orca's isSpotlightTerminalGone).
export async function inspectServer({ root, terminal, logPath, serverPid } = {}, deps) {
  const t = terminal ?? (root ? serverTerminalName(root) : null);
  if (!t) return { kind: "gone", terminal: null };
  const got = await getTerminal(t, deps);
  if (got.missing) return { kind: "gone", terminal: null };
  if (got.error) return { kind: "unknown", terminal: t, error: got.error };
  return classifyTerminal(got.terminal, { logPath, serverPid });
}

// Inspects until `done(reading)` or `ms` pass; the last reading.
async function inspectUntil(args, deps, done, ms) {
  const until = nowOf(deps) + ms;
  for (;;) {
    const seen = await inspectServer(args, deps);
    if (done(seen) || nowOf(deps) >= until) return seen;
    await sleepOf(deps, POLL_MS);
  }
}

// The server's state for status, badges and `on` (D10):
//   gone      — no terminal, or it finished
//   listening — a TCP port open in the terminal's process tree
//   starting  — Spotlight's server in front, no port yet
//   stopped   — the prompt is free (the `script` exited), or something
//               Spotlight didn't start runs there without a port
//   null      — hc couldn't say; keep what was known
// With the ports, the picked one (`port` = the configured port), its URL and
// the badge text (":3000+1").
export async function readServerState({ root, terminal, logPath, serverPid, port } = {}, deps) {
  const seen = await inspectServer({ root, terminal, logPath, serverPid }, deps);
  const base = { terminal: seen.terminal ?? null, owner: null, pid: null, ports: [], port: null, url: null, label: "" };
  if (seen.kind === "gone") return { ...base, state: "gone" };
  if (seen.kind === "unknown") return { ...base, state: null, error: seen.error ?? "no foreground" };
  const ports = (await treePorts(seen.rootPid, deps)) ?? [];
  const picked = pickPort(ports, port);
  const owner = seen.kind === "spotlight" ? "spotlight" : seen.kind === "foreign" ? "foreign" : null;
  const state = ports.length > 0 ? "listening" : owner === "spotlight" ? "starting" : "stopped";
  return {
    ...base, state, owner, pid: seen.pid ?? null, ports, port: picked, url: portUrl(picked), label: portLabel(ports, port),
  };
}

// ── The terminal ───────────────────────────────────────────────────────────

// The repo's live server terminal, created when there's none: `terminal`
// (the recorded address) when it's still live and labeled for this root,
// else the one named sl-<slug>, else a new one. A finished one is removed
// first. A live terminal holding the name but labeled for something else is
// never used: { ok: false, reason: "name-taken" }.
export async function ensureServerTerminal({ root, terminal } = {}, deps) {
  const name = serverTerminalName(root);
  const mine = (term) => term?.labels?.[SERVER_LABEL] === root;
  const unreadable = (message) => ({ ok: false, reason: "unreadable", message });

  if (terminal && terminal !== name) {
    const got = await getTerminal(terminal, deps);
    if (got.error) return unreadable(got.error);
    if (got.terminal && mine(got.terminal)) {
      if (got.terminal.state === "live") return { ok: true, terminal: got.terminal.address, created: false };
      await hc(deps, ["rm", got.terminal.address, "--json"]);
    }
  }
  const byName = async () => {
    const got = await getTerminal(name, deps);
    if (got.error) return unreadable(got.error);
    if (got.missing) return null;
    if (got.terminal.state === "live") {
      return mine(got.terminal)
        ? { ok: true, terminal: got.terminal.address, created: false }
        : { ok: false, reason: "name-taken", message: `a live terminal named ${name} isn't Spotlight's for ${root}` };
    }
    // Finished: it no longer holds the name. Clear ours out of the list.
    if (mine(got.terminal)) await hc(deps, ["rm", got.terminal.address, "--json"]);
    return null;
  };
  const found = await byName();
  if (found) return found;

  const made = await hc(deps, createTerminalArgv(root).slice(1));
  if (made.ok && typeof made.value.address === "string") {
    return { ok: true, terminal: made.value.address, created: true };
  }
  // Another CLI created it a moment ago: use theirs.
  if (!made.ok && made.error.kind === "name_taken") {
    const raced = await byName();
    if (raced) return raced;
  }
  return { ok: false, reason: "terminal-failed", message: made.ok ? "hc run printed no address" : made.error.message };
}

// ── Start, restart, stop ───────────────────────────────────────────────────

function note(logPath, { workspace, branch }, event, deps) {
  appendLogHeader(logPath, { workspace, branch, event, at: nowOf(deps) });
}

// Types `wrapped` into `terminal` when its shell owns the foreground, after
// rotating the log and writing the header; then waits briefly to see the
// `script` in front and reports its pid (null when it already ended or
// hasn't forked yet).
async function typeWhenIdle(a, deps) {
  const { terminal, created, command, wrapped, logPath, serverPid, event } = a;
  const head = { workspace: a.workspace, branch: a.branch };
  const args = { terminal, logPath, serverPid };
  // A new terminal holds nothing of anyone else's yet: what leads it before
  // its shell is its rc files' children, so that wait goes on too.
  const seen = created
    ? await inspectUntil(args, deps, (s) => s.kind !== "unknown" && s.kind !== "foreign", SHELL_MS)
    : await inspectServer(args, deps);
  if (seen.kind === "gone") return { ok: false, reason: "terminal-gone", terminal };
  if (seen.kind === "unknown") {
    note(logPath, head, NOTES.unreadable, deps);
    return { ok: false, reason: "unreadable", terminal, message: seen.error ?? "no foreground" };
  }
  if (seen.kind === "spotlight") {
    note(logPath, head, NOTES["already-running"], deps);
    return { ok: true, started: false, reason: "already-running", terminal, created, pid: seen.pid };
  }
  if (seen.kind === "foreign") {
    note(logPath, head, NOTES.busy, deps);
    return { ok: true, started: false, reason: "busy", terminal, created };
  }
  rotateLog(logPath);
  note(logPath, head, `${event}: ${command}`, deps);
  const sent = await hc(deps, ["send", terminal, wrapped, "--json"]);
  if (!sent.ok) return { ok: false, reason: "send-failed", terminal, message: sent.error.message };
  const after = await inspectUntil({ terminal, logPath, serverPid }, deps, (s) => s.kind === "spotlight", SEEN_MS);
  return {
    ok: true, started: true, terminal, created, pid: after.kind === "spotlight" ? after.pid : null, command, line: wrapped,
  };
}

// Interrupts Spotlight's server and waits for the prompt.
async function interruptAndWait(terminal, { logPath, serverPid }, deps) {
  const r = await hc(deps, ["interrupt", terminal, "--timeout", String(INTERRUPT_WATCH_S), "--json"]);
  if (!r.ok) return { ok: false, reason: "interrupt-failed", terminal, message: r.error.message };
  const seen = await inspectUntil({ terminal, logPath, serverPid }, deps, (s) => s.kind !== "spotlight", PROMPT_MS);
  if (seen.kind === "spotlight") return { ok: false, reason: "still-running", terminal };
  return { ok: true, seen };
}

// Start the repo's server (activation): make sure its terminal exists, then
// type `line` if the prompt is free. Results:
//   { ok: true, started: true, terminal, created, pid, command, line }
//   { ok: true, started: false, reason: "already-running" | "busy", terminal, … }
//   { ok: false, reason: "invalid-command" | "name-taken" | "terminal-failed"
//     | "unreadable" | "terminal-gone" | "send-failed", … }
// `workspace` / `branch` label the log header.
export async function startServer({ root, terminal, line, logPath, serverPid, workspace, branch } = {}, deps) {
  const wrapped = wrapServerLine(line, logPath);
  if (!wrapped) return { ok: false, reason: "invalid-command" };
  const ensured = await ensureServerTerminal({ root, terminal }, deps);
  if (!ensured.ok) return ensured;
  return typeWhenIdle({
    terminal: ensured.terminal, created: ensured.created, command: normalizeServerLine(line), wrapped,
    logPath, serverPid, workspace, branch, event: "started",
  }, deps);
}

// Restart (Reiniciar, `spotlight restart`, a lockfile or command change):
// interrupt Spotlight's own server, wait for the prompt, type `line`. A gone
// terminal is recreated and started; a foreign foreground is left alone.
// `restarted: true` when a running server was interrupted and replaced.
export async function restartServer({ root, terminal, line, logPath, serverPid, workspace, branch } = {}, deps) {
  const wrapped = wrapServerLine(line, logPath);
  if (!wrapped) return { ok: false, reason: "invalid-command" };
  const ensured = await ensureServerTerminal({ root, terminal }, deps);
  if (!ensured.ok) return ensured;
  const t = ensured.terminal;
  const seen = await inspectServer({ terminal: t, logPath, serverPid }, deps);
  let restarted = false;
  if (seen.kind === "spotlight") {
    const stopped = await interruptAndWait(t, { logPath, serverPid }, deps);
    if (!stopped.ok) return stopped;
    restarted = true;
  }
  const r = await typeWhenIdle({
    terminal: t, created: ensured.created, command: normalizeServerLine(line), wrapped,
    logPath, serverPid, workspace, branch, event: "restarted",
  }, deps);
  return r.started ? { ...r, restarted } : r;
}

// Stop (toggle off): interrupt Spotlight's own server and wait for the
// prompt; the terminal stays for the next start. Nothing else is touched:
// a free prompt is `not-running`, a foreign process `busy`, no terminal
// `terminal-gone` (all ok: there's no Spotlight server running).
export async function stopServer({ root, terminal, logPath, serverPid, workspace, branch } = {}, deps) {
  const seen = await inspectServer({ root, terminal, logPath, serverPid }, deps);
  const t = seen.terminal ?? null;
  if (seen.kind === "gone") return { ok: true, stopped: false, reason: "terminal-gone", terminal: null };
  if (seen.kind === "unknown") return { ok: false, reason: "unreadable", terminal: t, message: seen.error ?? "no foreground" };
  if (seen.kind === "shell") return { ok: true, stopped: false, reason: "not-running", terminal: t };
  if (seen.kind === "foreign") return { ok: true, stopped: false, reason: "busy", terminal: t };
  const stopped = await interruptAndWait(t, { logPath, serverPid }, deps);
  if (!stopped.ok) return stopped;
  note(logPath, { workspace, branch }, "stopped", deps);
  return { ok: true, stopped: true, terminal: t };
}

// ── Logs and peek ──────────────────────────────────────────────────────────

// `spotlight logs`: the log file's last `lines` lines as plain text; when
// the file is missing, the server terminal's own history (`hc read`, which
// keeps a bounded history: RECIPE.md "Server terminal probe"). { source:
// "file" | "terminal" | null, text }.
export async function serverLogs({ logPath, terminal, lines = DEFAULT_TAIL_LINES } = {}, deps) {
  const want = Number.isInteger(lines) && lines > 0 ? lines : DEFAULT_TAIL_LINES;
  if (logPath) {
    const text = tailLog(logPath, { lines: want });
    if (text !== null) return { source: "file", text };
  }
  if (!terminal) return { source: null, text: "" };
  const r = await hc(deps, ["read", terminal, "--lines", String(want), "--json"]);
  if (!r.ok || typeof r.value.text !== "string") return { source: null, text: "" };
  const all = stripTerminalSequences(r.value.text).split("\n");
  if (all.at(-1) === "") all.pop();
  const last = all.slice(-want);
  return { source: "terminal", text: last.length > 0 ? `${last.join("\n")}\n` : "" };
}

// "Ver server": Herdr's peek over the tab at the server terminal.
export async function peekServer(terminal, deps) {
  const [file, ...args] = peekArgv(terminal);
  try {
    const r = await deps.exec(file, args);
    if (r?.code === 0) return { ok: true };
    return { ok: false, message: String(r?.stderr || r?.stdout || `herdr-app exited ${r?.code}`).trim() };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}
