// The listening ports of a repo's Spotlight server (D10). Pure: shared by
// the mod and the CLI, it imports nothing and reaches lsof and pgrep only
// through an injected `exec(file, args) → { code, stdout, stderr }` (the
// shape of Herdr's exec). The server runs in its own hc terminal, so its
// ports are the TCP listeners of the process tree under that terminal's
// `pid` (the `zsh -l`): zsh → script → /bin/zsh -c → the dev server and its
// children. Anything else listening on the machine (a database, another
// repo's server) is not the server's.

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
