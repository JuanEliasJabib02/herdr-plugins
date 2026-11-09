// The listening ports of a repo's Spotlight server (D10). Pure: shared by
// the mod and the CLI, it imports only text.js and reaches lsof, ps and pgrep
// only through an injected `exec(file, args) → { code, stdout, stderr }` (the
// shape of Herdr's exec, which takes no env: a read that needs one carries it
// in its argv, PS_ENV). The server runs in its own hc terminal, so its
// ports are the TCP listeners of the process tree under that terminal's
// `pid` (the `zsh -l`): zsh → script → /bin/zsh -c → the dev server and its
// children. Anything else listening on the machine (a database, another
// repo's server) is not the server's. Also who holds the port a start will
// take, and stopping that process's tree (D24), who each of the server's
// listeners is (pid and start time, F2), and what a turn-off's Ctrl-C left of
// the server (D26): lsof, ps and pgrep through the same `exec`, signals only
// through an injected `kill` (requireKill).

import { oneLine } from "./text.js";

// Every TCP listener on the machine, one field per line (D10): `p<pid>`,
// `c<command>`, then `f<fd>` + `n<address:port>` per socket.
export const LSOF_ARGV = ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"];

// A process tree is a handful of pids; past this something is wrong (a pid
// cycle from reuse between two reads) and the walk stops.
const MAX_TREE = 256;

// `lsof -F pcn` output → [{ pid, command, port }], one entry per pid and
// port (an IPv4 and an IPv6 socket on one port fold into one), in the order
// lsof listed them. Names without a numeric port are skipped.
export function parseLsofListen(text) {
  const out = [];
  const seen = new Set();
  let pid = null;
  let command = "";
  for (const line of String(text ?? "").split("\n")) {
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "p") {
      pid = Number.parseInt(value, 10);
      command = "";
      if (!Number.isInteger(pid)) pid = null;
    } else if (field === "c") {
      command = value;
    } else if (field === "n" && pid !== null) {
      const m = /:(\d+)$/.exec(value);
      if (!m) continue;
      const port = Number(m[1]);
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, port });
    }
  }
  return out;
}

const validPid = (pid) => Number.isInteger(pid) && pid > 0;

// A TCP port number (1-65535). The one rule for ports here and in
// server-log.js.
export const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

// The direct children of `pid` (`pgrep -P`, exit 1: none), in pgrep's order.
// A pgrep that fails or can't run counts as no children.
export async function childPids(pid, { exec }) {
  if (!validPid(pid)) return [];
  let r;
  try {
    r = await exec("pgrep", ["-P", String(pid)]);
  } catch {
    return [];
  }
  if (r?.code !== 0) return [];
  const out = [];
  for (const line of String(r.stdout ?? "").split("\n")) {
    const child = Number.parseInt(line.trim(), 10);
    if (validPid(child) && !out.includes(child)) out.push(child);
  }
  return out;
}

// childPids behind a cache: each pid's children are read once, however many
// walks share the cache (stopLeftovers walks a tree per leftover, and those
// trees overlap).
function cachedChildren({ exec }) {
  const seen = new Map();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, childPids(pid, { exec }));
    return seen.get(pid);
  };
}

// The tree under `rootPid` walked with `pgrep -P`, breadth first: pid → the
// pid it was found under (null for the root), parents before their
// children. `childrenOf(pid)` reads a pid's children (childPids, or a
// cachedChildren shared across walks).
async function walkTree(rootPid, { exec }, childrenOf = (pid) => childPids(pid, { exec })) {
  const parents = new Map();
  if (!validPid(rootPid)) return parents;
  const queue = [[rootPid, null]];
  while (queue.length > 0 && parents.size < MAX_TREE) {
    const [pid, parent] = queue.shift();
    if (parents.has(pid)) continue;
    parents.set(pid, parent);
    for (const child of await childrenOf(pid)) {
      if (!parents.has(child)) queue.push([child, pid]);
    }
  }
  return parents;
}

// The pids of a walk (walkTree's map) under `top`, `top` included. Relies on
// the walk's order: a parent comes before its children.
function subtreeOf(parents, top) {
  const out = new Set();
  if (!parents.has(top)) return out;
  out.add(top);
  for (const [pid, parent] of parents) if (out.has(parent)) out.add(pid);
  return out;
}

// The part of a walk under `top` that ps confirms (`states`, processStates):
// pid → its state, for each one still alive and not a zombie whose parent as
// ps reads it is the one the walk found it under, all the way up to `top`,
// itself the child of `topParent` when that is given. A pid that changed
// hands between the reads is no part of it, nor anything under it.
function confirmedSubtree(parents, top, topParent, states) {
  const out = new Map();
  for (const [pid, parent] of parents) {
    const st = states?.get(pid);
    if (!st || st.zombie) continue;
    const fits = pid === top ? topParent === null || st.ppid === topParent : out.has(parent) && st.ppid === parent;
    if (fits) out.set(pid, st);
  }
  return out;
}

// The pids under `rootPid`, itself included, walked with `pgrep -P` (exit 1:
// no children). A pgrep that fails or can't run counts as no children.
export async function processTree(rootPid, { exec }) {
  return new Set((await walkTree(rootPid, { exec })).keys());
}

// ── Who a pid is (R1, R4, G2) ──────────────────────────────────────────────
// A pid alone can be anyone's by the time it is signalled: a process is the
// same one only while its start time (`ps -o lstart=`) is. lstart is printed
// in the caller's time zone, with words of its locale ("Sun Nov  8 …", "dom
// 8 nov …"), and an identity is recorded by one process (the reap, `on`) and
// checked by another (the detached turn-off): every read that records or
// checks one runs ps under PS_ENV, so all of them print the same string. It
// is still compared as read, never parsed. A zombie (state Z) has died and
// only waits for its parent to reap it: kill 0 still answers for it, but it
// is gone.

// The env of every ps read of a start time: the C locale, UTC (G2; locks.js
// pins LC_ALL=C for its own lstart through Node's execFile).
export const PS_ENV = Object.freeze({ LC_ALL: "C", TZ: "UTC" });

// `ps` for the parent, state and start time of `pids`, run as `/usr/bin/env
// LC_ALL=C TZ=UTC ps …` (H7): PS_ENV rides in the argv, so whatever exec runs
// it, Herdr's (no env option) or the CLI's, ps reads C/UTC. lstart goes last,
// so whatever its words, the rest of the line is it.
export const psStatesArgv = (pids) => [
  "/usr/bin/env", ...Object.entries(PS_ENV).map(([k, v]) => `${k}=${v}`),
  "ps", "-o", "pid=,ppid=,stat=,lstart=", "-p", pids.join(","),
];

// psStatesArgv's output → Map pid → { ppid, zombie, start } (start on one
// line, its runs of spaces folded: the one form it is compared in).
export function parsePsStates(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { ppid: Number(m[2]), zombie: m[3].startsWith("Z"), start: oneLine(m[4]) });
  }
  return out;
}

// psStates of `pids` that ps still lists (a pid it doesn't list is gone);
// null when ps can't run or fails (can't tell). ps exits 1, saying nothing,
// when none of them is there (env passes its exit on). Run under PS_ENV
// (psStatesArgv: G2, H7).
export async function processStates(pids, { exec }) {
  const list = [...new Set(pids)].filter(validPid);
  if (list.length === 0) return new Map();
  const argv = psStatesArgv(list);
  let r;
  try {
    r = await exec(argv[0], argv.slice(1));
  } catch {
    return null;
  }
  if (r?.code === 1 && !String(r.stdout ?? "").trim() && !String(r.stderr ?? "").trim()) return new Map();
  if (r?.code !== 0) return null;
  return parsePsStates(r.stdout);
}

// An identity of a server process, as treeListening reads it and the CLI
// keeps it on the repo's record (`serverProcs`): a valid pid and a start
// time that is a non-empty string (G8). Anything else names no process.
export const isIdentity = (p) =>
  typeof p === "object" && p !== null && validPid(p.pid) && typeof p.start === "string" && oneLine(p.start) !== "";

// The one key of an identity: its pid and its start time on one line, so the
// start as ps prints it and as treeListening folded it are the same process.
export const identityKey = (p) => `${p.pid}\u0000${oneLine(p.start)}`;

// The identities of `known` (isIdentity's; the rest is skipped) that no
// longer run as that process: ps doesn't list the pid, lists it as a zombie,
// or with another start time (a reused pid). One ps for the whole list
// (processStates, PS_ENV). → a Set of identityKey; empty when there is
// nothing to check, or when ps can't run or fails: doubt forgets none (G3).
export async function goneIdentities(known, { exec } = {}) {
  const list = (Array.isArray(known) ? known : []).filter(isIdentity);
  if (list.length === 0) return new Set();
  const states = await processStates(list.map((p) => p.pid), { exec });
  if (states === null) return new Set();
  const gone = new Set();
  for (const p of list) {
    const st = states.get(p.pid);
    if (!st || st.zombie || st.start !== oneLine(p.start)) gone.add(identityKey(p));
  }
  return gone;
}

// A command line on one line (oneLine), cut to MAX_COMMAND_SHOWN; null when
// empty.
function shownCommand(text) {
  const line = oneLine(text);
  if (!line) return null;
  return line.length > MAX_COMMAND_SHOWN ? `${line.slice(0, MAX_COMMAND_SHOWN - 1)}…` : line;
}

// Each of `pids`' command line (`ps -o pid=,command=`, shownCommand): Map
// pid → command, without the ones ps doesn't list; null when ps can't say.
export async function processCommands(pids, { exec }) {
  const list = [...new Set(pids)].filter(validPid);
  if (list.length === 0) return new Map();
  let r;
  try {
    r = await exec("ps", ["-o", "pid=,command=", "-p", list.join(",")]);
  } catch {
    return null;
  }
  if (r?.code !== 0 && r?.code !== 1) return null;
  const out = new Map();
  for (const line of String(r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const command = m ? shownCommand(m[2]) : null;
    if (command) out.set(Number(m[1]), command);
  }
  return out;
}

// Every TCP listener on the machine ([{ pid, command, port }], lsof's order):
// [] when none, null when lsof can't run or fails (can't tell). lsof exits 1
// when no socket matched at all.
export async function allListeners({ exec }) {
  let listing;
  try {
    listing = await exec(LSOF_ARGV[0], LSOF_ARGV.slice(1));
  } catch {
    return null;
  }
  if (listing?.code !== 0 && listing?.code !== 1) return null;
  return parseLsofListen(listing.stdout);
}

// The ports the tree under `rootPid` listens on, ascending and unique: []
// when it listens on nothing (or there's no pid), null when lsof can't run or
// fails (can't tell; never read as "not listening").
export async function treePorts(rootPid, { exec }) {
  const found = await treeListening(rootPid, null, { exec });
  return found === null ? null : found.ports;
}

// What the server terminal's tree listens on, and who (F2):
//   ports — treePorts: the ports of the tree under `rootPid` (the terminal's
//           shell), ascending and unique
//   procs — one identity per listener under `serverPid` (Spotlight's own
//           `script` in front; null: none): [{ pid, start, port }], `start`
//           as ps prints it under PS_ENV, folded (oneLine): the form
//           serverSnapshot compares. Sorted by port, then pid.
// Only Spotlight's own server gets identities: never the shell's helpers or a
// job put in the background there, nor anything when ps can't say or a pid
// changed hands between the reads (confirmedSubtree). The CLI keeps these
// on the repo's record and hands them back to stopServer as its `procs`, so a
// child that leaves the tree later is still known for Spotlight's (D26).
// → { ports, procs }, or null when lsof can't tell.
export async function treeListening(rootPid, serverPid, { exec }) {
  if (!validPid(rootPid)) return { ports: [], procs: [] };
  const sockets = await allListeners({ exec });
  if (sockets === null) return null;
  if (sockets.length === 0) return { ports: [], procs: [] };
  const parents = await walkTree(rootPid, { exec });
  const mine = sockets.filter((s) => parents.has(s.pid));
  const ports = [...new Set(mine.map((s) => s.port))].sort((a, b) => a - b);
  const server = validPid(serverPid) && serverPid !== rootPid ? serverPid : null;
  const under = server === null ? new Set() : subtreeOf(parents, server);
  const listening = mine.filter((s) => under.has(s.pid));
  if (listening.length === 0) return { ports, procs: [] };
  const states = await processStates([...under], { exec });
  const confirmed = confirmedSubtree(parents, server, rootPid, states);
  const procs = listening
    .filter((s) => confirmed.has(s.pid))
    .map((s) => ({ pid: s.pid, start: confirmed.get(s.pid).start, port: s.port }))
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
  return { ports, procs };
}

// ── Who holds a port, and freeing it (D24) ─────────────────────────────────
// Before a start, the port it will take may already be held by a process
// outside the server terminal's tree (a server left running in another
// checkout): the start is refused with who holds it. Only the popup's
// "Liberar puerto y arrancar" (a click) stops that process.

// How long a stopped process gets to go after SIGTERM before SIGKILL.
export const FREE_PORT_GRACE_MS = 5000;
// After SIGKILL: how long its sockets may take to close with it.
const KILL_SETTLE_MS = 1000;
const KILL_POLL_MS = 100;
// A command line shown in an error, on one line, at most this long.
const MAX_COMMAND_SHOWN = 120;

// lsof scoped to one port's listeners.
export const listenArgv = (port) => ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"];

// The listeners of `port` ([{ pid, command, port }], lsof's order): [] when
// none, null when lsof can't run or fails (can't tell).
export async function portListeners(port, { exec }) {
  if (!validPort(port)) return null;
  const argv = listenArgv(port);
  let listing;
  try {
    listing = await exec(argv[0], argv.slice(1));
  } catch {
    return null;
  }
  if (listing?.code !== 0 && listing?.code !== 1) return null;
  return parseLsofListen(listing.stdout).filter((s) => s.port === port);
}

// `lsof -a -p <pid> -d cwd -F n` output → the folder, or null.
export function parseLsofCwd(text) {
  let fd = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line[0] === "f") fd = line.slice(1).trim();
    else if (line[0] === "n" && fd === "cwd") return line.slice(1) || null;
  }
  return null;
}

// The folder a process runs in; null when lsof can't say.
export async function processCwd(pid, { exec }) {
  try {
    const r = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"]);
    return r?.code === 0 ? parseLsofCwd(r.stdout) : null;
  } catch {
    return null;
  }
}

// A process's command line (`ps -o command=`), on one line and cut to
// MAX_COMMAND_SHOWN; null when ps can't say.
export async function processCommand(pid, { exec }) {
  let r;
  try {
    r = await exec("ps", ["-o", "command=", "-p", String(pid)]);
  } catch {
    return null;
  }
  return r?.code === 0 ? shownCommand(r.stdout) : null;
}

// Who holds `port` from outside the tree under `rootPid` (the server
// terminal's own process; none yet: every listener is outside):
// { pid, command, cwd } (cwd null when unknown), or null when nobody does or
// lsof can't tell.
export async function foreignListener(port, rootPid, { exec }) {
  const listeners = await portListeners(port, { exec });
  if (!listeners || listeners.length === 0) return null;
  const tree = await processTree(rootPid, { exec });
  const other = listeners.find((l) => !tree.has(l.pid));
  if (!other) return null;
  const [command, cwd] = await Promise.all([processCommand(other.pid, { exec }), processCwd(other.pid, { exec })]);
  return { pid: other.pid, command: command ?? (other.command || null), cwd };
}

// Every signal goes through the caller's `deps.kill` (process.kill's
// shape): nothing here, nor in server.js, ever falls back to the real
// process.kill, so a test's fake pids can never reach a real process (R5,
// F8). A kill path called without one throws before it reads or sends
// anything.
export function requireKill(deps, who) {
  if (typeof deps?.kill !== "function") {
    throw new TypeError(`${who}: deps.kill(pid, signal) is required (process.kill's shape); Spotlight never signals without an injected kill`);
  }
}

const isAlive = (kill, pid) => {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it lives, but isn't ours to signal.
    return e?.code === "EPERM";
  }
};

// Those of `pids` still running: kill 0 answers for them and ps doesn't
// show them as zombies. Only a zombie state overrides kill 0: a pid ps
// doesn't list (it just ended, or ps can't say) keeps kill 0's answer, and
// the next look settles it.
async function stillAlive(pids, deps) {
  const live = pids.filter((p) => isAlive(deps.kill, p));
  if (live.length === 0) return live;
  const states = await processStates(live, deps);
  return live.filter((p) => !states?.get(p)?.zombie);
}

async function waitGone(pids, deps, ms) {
  const until = deps.now() + ms;
  let left = await stillAlive(pids, deps);
  while (left.length > 0 && deps.now() < until) {
    await deps.sleep(Math.min(KILL_POLL_MS, until - deps.now()));
    left = await stillAlive(left, deps);
  }
  return left;
}

// SIGTERM to each of `pids`, up to `graceMs` for them to go, SIGKILL to the
// ones left, up to KILL_SETTLE_MS for those. → { killed: those that needed
// SIGKILL, survivors: those still alive after it (not ours to signal, or
// stuck in the kernel) }.
async function termThenKill(pids, deps, graceMs) {
  const signal = (p, sig) => {
    try {
      deps.kill(p, sig);
    } catch {
      // Gone already, or not ours (EPERM): stillAlive tells.
    }
  };
  for (const p of pids) signal(p, "SIGTERM");
  const killed = await waitGone(pids, deps, graceMs);
  for (const p of killed) signal(p, "SIGKILL");
  const survivors = killed.length > 0 ? await waitGone(killed, deps, KILL_SETTLE_MS) : [];
  return { killed, survivors };
}

// The tree under `pid` when it may be stopped: never pid 1 or below, nor a
// tree holding a `protect`ed pid, nor one whose walk hit its bound (no small
// server's tree). `childrenOf`: walkTree's, to share one cache across trees.
// → { ok: true, tree } or { ok: false, pids }.
async function stoppableTree(pid, deps, protect, childrenOf) {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, pids: [] };
  const tree = new Set((await walkTree(pid, deps, childrenOf)).keys());
  if (tree.size >= MAX_TREE || protect.some((p) => tree.has(p))) return { ok: false, pids: [...tree] };
  return { ok: true, tree };
}

// Stops `pid` and its descendants: SIGTERM to each, up to `graceMs` for
// them to go, then SIGKILL to the ones left. Never pid 1 or below, nor a
// tree holding a `protect`ed pid (the CLI itself, the server terminal's
// shell: a port held by one of their ancestors). `deps`: `exec` (pgrep,
// ps), `kill(pid, signal)` with process.kill's shape (required: requireKill),
// `now()`, `sleep(ms)`.
// → { ok: true, pids, killed }, { ok: false, reason: "protected", pids }, or
// { ok: false, reason: "survived", pids, killed, survivors } when some are
// still alive after the SIGKILL (a zombie counts as gone).
export async function stopProcessTree(pid, deps, { graceMs = FREE_PORT_GRACE_MS, protect = [] } = {}) {
  requireKill(deps, "stopProcessTree");
  const found = await stoppableTree(pid, deps, protect);
  if (!found.ok) return { ok: false, reason: "protected", pids: found.pids };
  const pids = [...found.tree];
  const { killed, survivors } = await termThenKill(pids, deps, graceMs);
  if (survivors.length > 0) return { ok: false, reason: "survived", pids, killed, survivors };
  return { ok: true, pids, killed };
}

// ── What a turn-off's Ctrl-C leaves behind (D26) ───────────────────────────
// Turn-off interrupts the server first, as Orca does, and that is usually
// all it takes. A child that ignores SIGINT can outlive it, and one whose
// parent the Ctrl-C took is reparented to launchd: it leaves the terminal's
// tree, with or without a port. server.js stopServer reads the server before
// the Ctrl-C (serverSnapshot: the processes under the server's own pid, each
// with its start time), waits, and stops what of it is still there, wherever
// it went (serverLeftovers, stopLeftovers). The terminal's shell and its own
// helpers (gitstatusd, a zsh-async worker, a job put in the background) are
// no part of the server: never waited on, never signalled.

// How long a leftover gets after SIGTERM before SIGKILL.
export const LEFTOVER_GRACE_MS = 3000;

// `dir` is `root` or a folder under it. A root of "/" (or a relative one)
// holds nothing here: every folder would be inside it.
export function insideRoot(dir, root) {
  if (typeof dir !== "string" || typeof root !== "string") return false;
  const base = root.replace(/\/+$/, "");
  if (!base.startsWith("/")) return false;
  return dir === base || dir.startsWith(`${base}/`);
}

// stopServer's `procs`, the identities treeListening read while Spotlight's
// server ran: pid → the start times recorded for it (folded), and the ports
// they were on. An entry that isn't an identity (isIdentity: a valid pid and
// a non-empty string start) counts for nothing; one without a valid port
// still names its process. These ports are the only place the identities'
// ports join the turn-off's (G7): the CLI passes only the live ones.
function knownIdentities(list) {
  const byPid = new Map();
  const ports = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!isIdentity(p)) continue;
    if (!byPid.has(p.pid)) byPid.set(p.pid, new Set());
    byPid.get(p.pid).add(oneLine(p.start));
    if (validPort(p.port)) ports.add(p.port);
  }
  return { byPid, ports };
}

// The server right before its Ctrl-C:
//   rootPid   — the terminal's shell (never part of the server)
//   serverPid — the server's own process (Spotlight's `script` in front)
//   procs     — the tree under `serverPid`, itself included: pid → { start,
//               command }. The server's process must be the shell's child
//               and each other one its walk parent's (ps says so): a pid that
//               changed hands between the reads is no part of it.
//   listeners — who else listened on `ports`, outside the terminal's tree,
//               and is a process Spotlight recorded while its server ran
//               (`known`, stopServer's `procs`: same pid, same start time): a
//               server child that escaped an earlier run. pid → { start,
//               command }
//   ports     — those the server listens on, plus the `ports` recorded for it
//               and those of `known`
//   cwds      — each listener's folder, filled while the stop waits
// Only a process the snapshot holds is ever a leftover: whatever starts
// during the wait (a restart typed into the terminal, a server started by
// hand) is new, and stays. A listener Spotlight never recorded (a server
// started by hand, or one on a pid since reused) is never in it, on any path
// (D24, F2); with no `known` (an old record) it holds no listener at all. With
// no server (`serverPid` null: the prompt is free) it holds only the
// recorded listeners still on those ports.
export async function serverSnapshot({ rootPid, serverPid, ports: recorded, procs: known } = {}, { exec }) {
  const shell = validPid(rootPid) ? rootPid : null;
  const server = validPid(serverPid) && serverPid !== shell ? serverPid : null;
  const parents = await walkTree(server, { exec });
  // The shell under its own child: a pid cycle from reuse, no server's tree.
  if (shell !== null && parents.has(shell)) parents.clear();
  const ids = knownIdentities(known);
  const given = [...(Array.isArray(recorded) ? recorded : []).filter(validPort), ...ids.ports];
  const wanted = new Set(given);
  const sockets = parents.size > 0 || ids.byPid.size > 0 ? ((await allListeners({ exec })) ?? []) : [];
  for (const s of sockets) if (parents.has(s.pid)) wanted.add(s.port);
  let outside = [
    ...new Set(sockets.filter((s) => wanted.has(s.port) && !parents.has(s.pid) && ids.byPid.has(s.pid)).map((s) => s.pid)),
  ];
  if (outside.length > 0) {
    const terminal = await processTree(shell, { exec });
    outside = outside.filter((p) => !terminal.has(p) && p !== shell);
  }
  const states = await processStates([...parents.keys(), ...outside], { exec });
  const procs = new Map();
  for (const [pid, st] of confirmedSubtree(parents, server, shell, states)) procs.set(pid, { start: st.start, command: null });
  const ports = new Set(given);
  for (const s of sockets) if (procs.has(s.pid)) ports.add(s.port);
  const listeners = new Map();
  for (const pid of outside) {
    const st = states?.get(pid);
    const same = Boolean(st) && !st.zombie && ids.byPid.get(pid).has(st.start);
    if (same && sockets.some((s) => s.pid === pid && ports.has(s.port))) listeners.set(pid, { start: st.start, command: null });
  }
  const kept = [...procs, ...listeners];
  const commands = kept.length > 0 ? await processCommands(kept.map(([pid]) => pid), { exec }) : null;
  for (const [pid, rec] of kept) rec.command = commands?.get(pid) ?? null;
  return { rootPid: shell, serverPid: server, procs, listeners, ports: [...ports].sort((a, b) => a - b), cwds: new Map() };
}

// What of `snapshot` is still there now:
//   procs   — its server processes still alive as the same process (same
//             start time, not a zombie), wherever they were reparented
//   escaped — its listeners, the same processes, still on one of its ports,
//             whose folder is inside `root` ({ pid, port, cwd })
// A pid now held by another process is never a leftover, nor is a listener
// running outside the root or one lsof can't place, nor anything when ps
// can't say (doubt never kills).
export async function serverLeftovers(snapshot, root, { exec }) {
  const { procs, listeners, ports, cwds } = snapshot;
  const watched = [...procs.keys(), ...listeners.keys()];
  if (watched.length === 0) return { procs: [], escaped: [] };
  const states = await processStates(watched, { exec });
  if (states === null) return { procs: [], escaped: [] };
  const same = (pid, rec) => {
    const st = states.get(pid);
    return Boolean(st) && !st.zombie && st.start === rec.start;
  };
  const left = [...procs].filter(([pid, rec]) => same(pid, rec)).map(([pid]) => pid);
  const still = new Set([...listeners].filter(([pid, rec]) => same(pid, rec)).map(([pid]) => pid));
  const escaped = [];
  if (still.size === 0 || ports.length === 0 || !insideRoot(root, root)) return { procs: left, escaped };
  for (const s of (await allListeners({ exec })) ?? []) {
    if (!ports.includes(s.port) || !still.has(s.pid) || escaped.some((e) => e.pid === s.pid)) continue;
    if (!cwds.has(s.pid)) {
      const cwd = await processCwd(s.pid, { exec });
      if (cwd) cwds.set(s.pid, cwd);
    }
    const cwd = cwds.get(s.pid) ?? null;
    if (insideRoot(cwd, root)) escaped.push({ pid: s.pid, port: s.port, cwd });
  }
  return { procs: left, escaped };
}

// Stops serverLeftovers' finds, each with what runs under it now: SIGTERM
// once to every process of those trees, up to `graceMs`, SIGKILL to the ones
// left. A leftover whose tree holds the terminal's shell (`rootPid`) or a
// `protect`ed pid (the CLI itself), or that hits the walk's bound, is refused
// whole: never signalled, and the caller counts it as not stopped. Each
// pid's children are read once (one pgrep per pid, F5): the trees share a
// cache, and a leftover already inside a tree that is stopped whole adds
// nothing. `deps.kill` is required (requireKill). → { pids: every pid
// signalled, killed: those that needed SIGKILL, refused: the leftovers left
// untouched, survivors: those still alive after the SIGKILL }.
export async function stopLeftovers({ procs = [], escaped = [] } = {}, rootPid, deps, { graceMs = LEFTOVER_GRACE_MS, protect = [] } = {}) {
  requireKill(deps, "stopLeftovers");
  const targets = [...new Set([...procs, ...escaped.map((e) => e.pid)])];
  const guard = [rootPid, ...protect].filter(validPid);
  const childrenOf = cachedChildren(deps);
  const pids = new Set();
  const refused = [];
  for (const pid of targets) {
    if (pids.has(pid)) continue;
    const found = await stoppableTree(pid, deps, guard, childrenOf);
    if (!found.ok) refused.push(pid);
    else for (const p of found.tree) pids.add(p);
  }
  const all = [...pids];
  if (all.length === 0) return { pids: [], killed: [], refused, survivors: [] };
  const { killed, survivors } = await termThenKill(all, deps, graceMs);
  return { pids: all, killed, refused, survivors };
}

// The port to show and link to: the configured one when it listens, else the
// lowest that does (D10; Orca's pickPort, spotlight-agent-servers.ts:40-48,
// which stops at the configured one); null when nothing listens.
export function pickPort(ports, configured) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  if (configured != null && ports.includes(configured)) return configured;
  return ports.reduce((low, p) => (p < low ? p : low), ports[0]);
}

// The server badge's text (S5, D17): ":3000", or ":3000+1" when one more
// port listens; "" when none does.
export function portLabel(ports, configured) {
  const picked = pickPort(ports, configured);
  if (picked === null) return "";
  return ports.length > 1 ? `:${picked}+${ports.length - 1}` : `:${picked}`;
}

// The URL `spotlight on` and the badge's tooltip print for a port (D1).
export function portUrl(port) {
  return port == null ? null : `http://localhost:${port}`;
}
