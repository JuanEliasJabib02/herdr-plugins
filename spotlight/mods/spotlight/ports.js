// The listening ports of a repo's Spotlight server (D10). Pure: shared by
// the mod and the CLI, it imports nothing and reaches lsof and pgrep only
// through an injected `exec(file, args) → { code, stdout, stderr }` (the
// shape of Herdr's exec). The server runs in its own hc terminal, so its
// ports are the TCP listeners of the process tree under that terminal's
// `pid` (the `zsh -l`): zsh → script → /bin/zsh -c → the dev server and its
// children. Anything else listening on the machine (a database, another
// repo's server) is not the server's. Also who holds the port a start will
// take, and stopping that process's tree (D24): lsof, ps and pgrep through
// the same `exec`, signals through an injected `kill`.

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

// The pids under `rootPid`, itself included, walked with `pgrep -P` (exit 1:
// no children). A pgrep that fails or can't run counts as no children.
export async function processTree(rootPid, { exec }) {
  const tree = new Set();
  if (!Number.isInteger(rootPid) || rootPid <= 0) return tree;
  const queue = [rootPid];
  while (queue.length > 0 && tree.size < MAX_TREE) {
    const pid = queue.shift();
    if (tree.has(pid)) continue;
    tree.add(pid);
    let r;
    try {
      r = await exec("pgrep", ["-P", String(pid)]);
    } catch {
      continue;
    }
    if (r?.code !== 0) continue;
    for (const line of String(r.stdout ?? "").split("\n")) {
      const child = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(child) && child > 0 && !tree.has(child)) queue.push(child);
    }
  }
  return tree;
}

// The ports the tree under `rootPid` listens on, ascending and unique: []
// when it listens on nothing (or there's no pid), null when lsof can't run or
// fails (can't tell; never read as "not listening"). lsof exits 1 when no
// socket matched at all.
export async function treePorts(rootPid, { exec }) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  let listing;
  try {
    listing = await exec(LSOF_ARGV[0], LSOF_ARGV.slice(1));
  } catch {
    return null;
  }
  if (listing?.code !== 0 && listing?.code !== 1) return null;
  const sockets = parseLsofListen(listing.stdout);
  if (sockets.length === 0) return [];
  const tree = await processTree(rootPid, { exec });
  const ports = new Set(sockets.filter((s) => tree.has(s.pid)).map((s) => s.port));
  return [...ports].sort((a, b) => a - b);
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
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
  const text = r?.code === 0 ? String(r.stdout ?? "").replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length > MAX_COMMAND_SHOWN ? `${text.slice(0, MAX_COMMAND_SHOWN - 1)}…` : text;
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

const isAlive = (kill, pid) => {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it lives, but isn't ours to signal.
    return e?.code === "EPERM";
  }
};

async function waitGone(pids, { kill, now, sleep }, ms) {
  const until = now() + ms;
  let left = pids.filter((p) => isAlive(kill, p));
  while (left.length > 0 && now() < until) {
    await sleep(Math.min(KILL_POLL_MS, until - now()));
    left = left.filter((p) => isAlive(kill, p));
  }
  return left;
}

// Stops `pid` and its descendants: SIGTERM to each, up to `graceMs` for
// them to go, then SIGKILL to the ones left. Never pid 1 or below, nor a
// tree holding a `protect`ed pid (the CLI itself, the server terminal's
// shell: a port held by one of their ancestors). `deps`: `exec` (pgrep),
// `kill(pid, signal)` with process.kill's shape, `now()`, `sleep(ms)`.
// → { ok: true, pids, killed } or { ok: false, reason: "protected", pids }.
export async function stopProcessTree(pid, deps, { graceMs = FREE_PORT_GRACE_MS, protect = [] } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: "protected", pids: [] };
  const tree = await processTree(pid, deps);
  const pids = [...tree];
  // A walk that hit its bound is no small server's tree.
  if (tree.size >= MAX_TREE || protect.some((p) => tree.has(p))) return { ok: false, reason: "protected", pids };
  const signal = (p, sig) => {
    try {
      deps.kill(p, sig);
    } catch {
      // Gone already.
    }
  };
  for (const p of pids) signal(p, "SIGTERM");
  const killed = await waitGone(pids, deps, graceMs);
  for (const p of killed) signal(p, "SIGKILL");
  if (killed.length > 0) await waitGone(killed, deps, KILL_SETTLE_MS);
  return { ok: true, pids, killed };
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
