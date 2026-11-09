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
// Spotlight's own server, kills what of it outlives the Ctrl-C (D26), and
// keeps the terminal for the next start. hc is
// reached through an injected `exec(file, args) → { code, stdout, stderr }`
// and the clock through injected `now()` / `sleep(ms)`, so tests run on a
// fake hc. The probe that pinned hc's shapes is in RECIPE.md "Server
// terminal probe".

import {
  repoSlug, appendLogHeader, rotateLog, tailLog, stripTerminalSequences, DEFAULT_TAIL_LINES,
} from "./server-log.js";
import {
  treeListening, pickPort, portLabel, portUrl, serverSnapshot, serverLeftovers, stopLeftovers, requireKill,
} from "./ports.js";

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
// Turn-off (D26): how long after the Ctrl-C the server gets to be gone (the
// prompt back, no process of it left, its ports free) before what's left of
// it is killed.
export const STOP_WAIT_MS = 8000;

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
// the badge text (":3000+1"), and `procs`: who listens under Spotlight's own
// server, [{ pid, start, port }] (ports.js treeListening; [] unless the
// server in front is Spotlight's). The CLI keeps those on the repo's record
// and passes them back to stopServer, which kills a listener outside the
// tree only when it is one of them (F2).
export async function readServerState({ root, terminal, logPath, serverPid, port } = {}, deps) {
  const seen = await inspectServer({ root, terminal, logPath, serverPid }, deps);
  const base = { terminal: seen.terminal ?? null, owner: null, pid: null, ports: [], procs: [], port: null, url: null, label: "" };
  if (seen.kind === "gone") return { ...base, state: "gone" };
  if (seen.kind === "unknown") return { ...base, state: null, error: seen.error ?? "no foreground" };
  const found = await treeListening(seen.rootPid, seen.kind === "spotlight" ? seen.pid : null, deps);
  const ports = found?.ports ?? [];
  const picked = pickPort(ports, port);
  const owner = seen.kind === "spotlight" ? "spotlight" : seen.kind === "foreign" ? "foreign" : null;
  const state = ports.length > 0 ? "listening" : owner === "spotlight" ? "starting" : "stopped";
  return {
    ...base, state, owner, pid: seen.pid ?? null, ports, procs: found?.procs ?? [], port: picked, url: portUrl(picked),
    label: portLabel(ports, port),
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

// The pre-Ctrl-C server still leads the terminal (its `script`, by pid).
const oldInFront = (seen, snapshot) => seen.kind === "spotlight" && seen.pid === snapshot.serverPid;

// stopLeftovers through the caller's `deps.kill` (required: never the real
// process.kill, F8) and the real clock unless `deps` brings its own; the CLI
// itself is never signalled.
function killLeftovers(left, rootPid, deps) {
  requireKill(deps, "killLeftovers");
  const killDeps = { ...deps, now: deps.now ?? Date.now, sleep: deps.sleep ?? defaultSleep };
  return stopLeftovers(left, rootPid, killDeps, { protect: [process.pid] });
}

// What of the server stopLeftovers didn't stop (F4): the processes that
// lived through the SIGKILL, then those it refused to signal (a tree holding
// the CLI or the terminal's shell, or past the walk's bound).
const notStopped = (done) => [...new Set([...done.survivors, ...done.refused])];

// `{ refused }` for a result, only when some leftover was refused.
const refusedOf = (done) => (done.refused.length > 0 ? { refused: done.refused } : {});

// The stop's line in the log: stopped, by the Ctrl-C or after signalling
// `forced` processes, or NOT stopped when some lived through the SIGKILL or
// were never signalled (`refused`, counted among the survivors).
function stopNote(logPath, head, { forced, survivors = [], refused = [] }, deps) {
  const never = refused.length > 0 ? `; not signalled: ${refused.join(", ")}` : "";
  const text =
    survivors.length > 0
      ? `Spotlight off — server NOT stopped: ${survivors.length} processes survived (pids ${survivors.join(", ")}${never})`
      : `Spotlight off — server stopped (${forced > 0 ? `forced: ${forced} processes` : "interrupt sent"})`;
  note(logPath, head, text, deps);
}

// Nothing runs in the terminal (its prompt is free, or there's no terminal):
// nothing to interrupt, but a listener Spotlight recorded while its server
// ran (`procs`: same pid, same start time), still on a recorded port with its
// folder inside `root` (a server child that escaped an earlier run), is
// killed at once. Any other listener, a server started by hand there
// included, is never signalled. `rootPid`: the terminal's shell, when there
// is one (its tree is never touched). The result carries `reason` when the
// listeners found were all stopped.
async function stopEscaped({ root, rootPid, ports, procs, logPath, head, terminal, reason }, deps) {
  const snapshot = await serverSnapshot({ rootPid, serverPid: null, ports, procs }, deps);
  const left = await serverLeftovers(snapshot, root, deps);
  if (left.escaped.length === 0) return { ok: true, stopped: false, reason, terminal, forced: 0, escaped: [] };
  const done = await killLeftovers({ escaped: left.escaped }, snapshot.rootPid, deps);
  const forced = done.pids.length;
  const escaped = left.escaped.filter((e) => !done.refused.includes(e.pid));
  const survivors = notStopped(done);
  stopNote(logPath, head, { forced, survivors, refused: done.refused }, deps);
  if (survivors.length > 0) return { ok: false, reason: "survived", terminal, forced, survivors, ...refusedOf(done), escaped };
  return { ok: true, stopped: false, reason, terminal, forced, escaped };
}

// Stop (toggle off), guaranteed (D26): Ctrl-C to Spotlight's own server, as
// Orca does (spotlight-server-turn-off.ts:48-65), then up to STOP_WAIT_MS for
// the prompt with none of the server's processes left and its ports free.
// The server is what ran under its own process (the `script` in front) right
// before the Ctrl-C, each process known by its pid and start time (ports.js
// serverSnapshot). What's left of it then is killed (ports.js stopLeftovers:
// SIGTERM, 3 s, SIGKILL): every one of those processes still alive as the
// same process, wherever it was reparented (a child that ignores the Ctrl-C
// and lost its parent to it), and a listener still on one of the server's
// ports (those it held before the Ctrl-C, plus `ports`, the recorded ones)
// that runs outside the terminal and inside `root`, when it is a process
// Spotlight recorded while its server ran: `procs`, the identities
// readServerState returned ({ pid, start, port }, same pid and same start
// time). A listener that matches none, such as a server started by hand on
// that port, is never signalled, on any path: only "Liberar puerto y
// arrancar" ever kills a process Spotlight didn't start (D24). With no
// `procs` (an old record), no listener outside the tree is killed. The
// terminal, its shell and the shell's own helpers (gitstatusd, a job put in
// the background) are never waited on nor killed; the terminal stays for the
// next start.
//
// Only what ran before the Ctrl-C is ever killed: a server typed into the
// terminal during the wait (a restart) is new, and stays, and so is a pid
// another process took since (another start time). The CLI also stops under
// the repo's lock, which every start and restart takes. A Ctrl-C that hc
// couldn't send skips the wait: what was read before it is killed at once
// (F3).
//
// Results. `ok: false` always means the server may still be up:
//   { ok: true, stopped: true, terminal, forced } — `forced`: how many
//     processes were signalled, 0 when the Ctrl-C was enough (the log says
//     which); `interruptError` too when hc couldn't send the Ctrl-C and the
//     server was killed instead
//   { ok: true, stopped: false, reason: "not-running" | "terminal-gone",
//     terminal, forced, escaped } — the prompt was free, or there's no
//     terminal: nothing is interrupted, but a recorded listener (`procs`)
//     still on a recorded port with its folder inside `root` (a server child
//     that escaped an earlier run) is killed right away; `escaped` lists
//     those ({ pid, port, cwd }) and the log says it when there were any
//   { ok: true, stopped: false, reason: "busy", terminal } — a process
//     Spotlight didn't start in front: nothing is touched
//   { ok: false, reason: "survived", terminal, forced, survivors, refused? }
//     — some process of the server lived through the SIGKILL (not ours to
//     signal, stuck in the kernel), or was never signalled because
//     stopLeftovers refused it (its tree holds the CLI or the terminal's
//     shell: `refused`, also counted in `survivors`): the server is not
//     stopped, and the log says so with their pids (`escaped` too when the
//     terminal ran nothing)
//   { ok: false, reason: "unreadable", terminal, message } — hc couldn't
//     read the terminal: no server pid to read, so nothing is signalled
//   { ok: false, reason: "interrupt-failed", terminal, forced: 0, message }
//     — hc couldn't send the Ctrl-C and, after it, neither hc nor ps showed
//     anything to kill or proved the server gone
//   { ok: false, reason: "still-running", terminal, forced, pid, message } —
//     its processes were killed, but hc still shows Spotlight's old `script`
//     (`pid`) in front
// `deps.kill` (process.kill's shape) is required: without it stopServer
// throws before it reads or sends anything (F8).
export async function stopServer({ root, terminal, logPath, serverPid, workspace, branch, ports, procs: known } = {}, deps) {
  requireKill(deps, "stopServer");
  const seen = await inspectServer({ root, terminal, logPath, serverPid }, deps);
  const t = seen.terminal ?? null;
  const head = { workspace, branch };
  if (seen.kind === "unknown") {
    const message = `the Spotlight terminal could not be read (${seen.error ?? "no foreground"}): the server may still be running`;
    return { ok: false, reason: "unreadable", terminal: t, message };
  }
  if (seen.kind === "foreign") return { ok: true, stopped: false, reason: "busy", terminal: t };
  if (seen.kind === "gone") {
    return stopEscaped({ root, rootPid: null, ports, procs: known, logPath, head, terminal: null, reason: "terminal-gone" }, deps);
  }
  if (seen.kind === "shell") {
    return stopEscaped({ root, rootPid: seen.rootPid, ports, procs: known, logPath, head, terminal: t, reason: "not-running" }, deps);
  }

  const snapshot = await serverSnapshot({ rootPid: seen.rootPid, serverPid: seen.pid, ports, procs: known }, deps);
  const r = await hc(deps, ["interrupt", t, "--timeout", String(INTERRUPT_WATCH_S), "--json"]);
  // No Ctrl-C is no reason to leave the server up (D26): no wait for it, the
  // server read above is killed at once.
  const interruptError = r.ok ? null : r.error.message || r.error.kind;

  const look = { terminal: t, logPath, serverPid };
  const until = nowOf(deps) + (r.ok ? STOP_WAIT_MS : 0);
  let front;
  let left;
  for (;;) {
    front = await inspectServer(look, deps);
    left = await serverLeftovers(snapshot, root, deps);
    const gone = !oldInFront(front, snapshot) && left.procs.length === 0 && left.escaped.length === 0;
    if (gone || nowOf(deps) >= until) break;
    await sleepOf(deps, POLL_MS);
  }
  const failed = interruptError ? { interruptError } : {};

  // The old `script` in front is a leftover even when ps couldn't read it.
  const procs = oldInFront(front, snapshot) ? [...new Set([...left.procs, front.pid])] : left.procs;
  let forced = 0;
  if (procs.length > 0 || left.escaped.length > 0) {
    const done = await killLeftovers({ procs, escaped: left.escaped }, snapshot.rootPid, deps);
    forced = done.pids.length;
    const survivors = notStopped(done);
    if (survivors.length > 0) {
      stopNote(logPath, head, { forced, survivors, refused: done.refused }, deps);
      return { ok: false, reason: "survived", terminal: t, forced, survivors, ...refusedOf(done), ...failed };
    }
    const after = await inspectUntil(look, deps, (s) => !oldInFront(s, snapshot), PROMPT_MS);
    if (oldInFront(after, snapshot)) {
      const message = `Spotlight's server (pid ${after.pid}) still leads the terminal after it was killed: the server may still be running`;
      return { ok: false, reason: "still-running", terminal: t, forced, pid: after.pid, message, ...failed };
    }
  } else if (interruptError && front.kind === "unknown") {
    // No Ctrl-C, no reading of the terminal after it, nothing ps could name:
    // nothing shows the server gone.
    const message = `the Ctrl-C could not be sent (${interruptError}) and the terminal can't be read: the server may still be running`;
    return { ok: false, reason: "interrupt-failed", terminal: t, forced: 0, message };
  }
  stopNote(logPath, head, { forced }, deps);
  return { ok: true, stopped: true, terminal: t, forced, ...failed };
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
