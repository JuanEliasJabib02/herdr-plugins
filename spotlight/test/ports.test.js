// T5b: the listening ports of a Spotlight server terminal (D10). M/ports.js
// parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn`, keeps the sockets of the
// process tree under the terminal's own pid (walked with `pgrep -P`), and
// picks the port the badge and `spotlight on` show (Orca's pickPort,
// O/src/main/spotlight/spotlight-agent-servers.ts:40-48, with D10's fallback
// to the lowest port).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LSOF_ARGV, parseLsofListen, processTree, treePorts, pickPort, portLabel, portUrl,
  portListeners, parseLsofCwd, processCwd, processCommand, foreignListener, stopProcessTree, FREE_PORT_GRACE_MS,
} from "../mods/spotlight/ports.js";

// Recorded from `lsof -nP -iTCP -sTCP:LISTEN -F pcn` on macOS (2026-11-06),
// pids renumbered: every socket carries an `f` (fd) line, IPv4 and IPv6
// sockets of one port come as two entries, `*:` is any address.
const LSOF_FIXTURE = [
  "p593", "cControlCenter", "f8", "n*:7000", "f9", "n*:7000",
  "p702", "cpostgres", "f7", "n[::1]:5432", "f8", "n127.0.0.1:5432",
  "p102", "cnode", "f23", "n*:3001", "f24", "n[::1]:3000", "f25", "n127.0.0.1:3000",
  "p103", "cesbuild", "f12", "n127.0.0.1:3000",
  "",
].join("\n");

// The server terminal's tree: zsh -l (100) → script (101) → node (102) →
// esbuild (103). 702 (postgres) and 593 are someone else's.
const CHILDREN = { 100: [101], 101: [102], 102: [103] };

// A fake exec answering `pgrep -P <pid>` from a child map and `lsof` with a
// fixture; records every call.
function fakeExec({ children = CHILDREN, lsof = { code: 0, stdout: LSOF_FIXTURE } } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "pgrep") {
      assert.equal(args[0], "-P");
      const kids = children[Number(args[1])] ?? [];
      return kids.length
        ? { code: 0, stdout: kids.map((p) => `${p}\n`).join(""), stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof") {
      if (lsof instanceof Error) throw lsof;
      return { stderr: "", ...lsof };
    }
    throw new Error(`unexpected exec ${file}`);
  };
  return { exec, calls };
}

test("parseLsofListen: one entry per pid and port, IPv4/IPv6 twins folded, fd lines ignored", () => {
  assert.deepEqual(parseLsofListen(LSOF_FIXTURE), [
    { pid: 593, command: "ControlCenter", port: 7000 },
    { pid: 702, command: "postgres", port: 5432 },
    { pid: 102, command: "node", port: 3001 },
    { pid: 102, command: "node", port: 3000 },
    { pid: 103, command: "esbuild", port: 3000 },
  ]);
  assert.deepEqual(parseLsofListen(""), []);
  assert.deepEqual(parseLsofListen(undefined), []);
  // A name with no port and an `n` before any `p` are skipped.
  assert.deepEqual(parseLsofListen("n*:80\np5\ncx\nf1\nn*:*\nf2\nn*:8080\n"), [{ pid: 5, command: "x", port: 8080 }]);
});

test("LSOF_ARGV is the listing D10 names", () => {
  assert.deepEqual(LSOF_ARGV, ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
});

test("processTree: the root and every descendant, walked with pgrep -P", async () => {
  const { exec, calls } = fakeExec();
  assert.deepEqual([...(await processTree(100, { exec }))].sort(), [100, 101, 102, 103]);
  assert.deepEqual(calls.map((c) => c.join(" ")), ["pgrep -P 100", "pgrep -P 101", "pgrep -P 102", "pgrep -P 103"]);
  // A cycle (pid reuse between two reads) never loops.
  const loop = fakeExec({ children: { 1: [2], 2: [1] } });
  assert.deepEqual([...(await processTree(1, loop))].sort(), [1, 2]);
  // No pid: no tree, no exec.
  const none = fakeExec();
  assert.equal((await processTree(null, none)).size, 0);
  assert.equal(none.calls.length, 0);
});

test("treePorts: a server child on 3000 and 3001 and an unrelated 5432 gives [3000, 3001] and :3000+1", async () => {
  const { exec } = fakeExec();
  const ports = await treePorts(100, { exec });
  assert.deepEqual(ports, [3000, 3001]);
  assert.equal(portLabel(ports), ":3000+1");
  assert.equal(portUrl(pickPort(ports)), "http://localhost:3000");
});

test("treePorts: nothing listening is []; lsof that can't run is null (can't tell)", async () => {
  assert.deepEqual(await treePorts(100, fakeExec({ lsof: { code: 1, stdout: "" } })), []);
  // A tree that listens on nothing, though others do.
  assert.deepEqual(await treePorts(100, fakeExec({ children: {} , lsof: { code: 0, stdout: "p9\ncx\nf1\nn*:9\n" } })), []);
  assert.equal(await treePorts(100, fakeExec({ lsof: new Error("spawn lsof ENOENT") })), null);
  assert.equal(await treePorts(100, fakeExec({ lsof: { code: 2, stdout: "", stderr: "lsof: bad" } })), null);
  // No terminal pid: nothing to scan.
  assert.deepEqual(await treePorts(null, fakeExec()), []);
});

test("pickPort: the configured port when it listens, else the lowest; none listening is null", () => {
  assert.equal(pickPort([3001, 3000, 8080], 8080), 8080);
  assert.equal(pickPort([3001, 3000], 8080), 3000);
  assert.equal(pickPort([3001, 3000]), 3000);
  assert.equal(pickPort([3001, 3000], null), 3000);
  assert.equal(pickPort([], 3000), null);
  assert.equal(pickPort(null), null);
});

test("portLabel: the picked port, plus how many others listen", () => {
  assert.equal(portLabel([8080]), ":8080");
  assert.equal(portLabel([3000, 3001, 3002], 3001), ":3001+2");
  assert.equal(portLabel([]), "");
  assert.equal(portUrl(null), null);
});

// ── Who holds a port, and freeing it (T13, D24) ────────────────────────────

// lsof scoped to port 3008 (`-iTCP:3008`): the next-server someone left
// running in another checkout (900) and Spotlight's own server child (102).
const LSOF_3008 = ["p900", "cnode", "f21", "n*:3008", "f22", "n[::1]:3008", "p102", "cnode", "f23", "n*:3008", ""].join("\n");

// A fake exec for the busy-port reads: lsof by its argv (the port listing or
// one pid's cwd), ps for a pid's command, pgrep from CHILDREN.
function holderExec({ listing = { code: 0, stdout: LSOF_3008 }, cwds = { 900: "/Users/u/old/speaking-english" }, commands = { 900: "next-server (v16.0.1)" } } = {}) {
  const base = fakeExec();
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "lsof" && args.includes("-d")) {
      const pid = Number(args[args.indexOf("-p") + 1]);
      return pid in cwds ? { code: 0, stdout: `p${pid}\nfcwd\nn${cwds[pid]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof") {
      if (listing instanceof Error) throw listing;
      return { stderr: "", ...listing };
    }
    if (file === "ps") {
      const pid = Number(args[args.indexOf("-p") + 1]);
      return pid in commands ? { code: 0, stdout: `${commands[pid]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    return base.exec(file, args);
  };
  return { exec, calls };
}

test("portListeners: the listeners of one port, from lsof scoped to it; [] when none, null when lsof can't tell", async () => {
  const { exec, calls } = holderExec();
  assert.deepEqual(await portListeners(3008, { exec }), [
    { pid: 900, command: "node", port: 3008 },
    { pid: 102, command: "node", port: 3008 },
  ]);
  assert.deepEqual(calls[0], ["lsof", "-nP", "-iTCP:3008", "-sTCP:LISTEN", "-F", "pcn"]);
  // A listing that ignores the scope still answers for that port only.
  assert.deepEqual(await portListeners(3000, holderExec({ listing: { code: 0, stdout: LSOF_FIXTURE } })), [
    { pid: 102, command: "node", port: 3000 },
    { pid: 103, command: "esbuild", port: 3000 },
  ]);
  assert.deepEqual(await portListeners(3008, holderExec({ listing: { code: 1, stdout: "" } })), []);
  assert.equal(await portListeners(3008, holderExec({ listing: new Error("spawn lsof ENOENT") })), null);
  assert.equal(await portListeners(3008, holderExec({ listing: { code: 2, stdout: "" } })), null);
  assert.equal(await portListeners(0, holderExec()), null);
});

test("processCwd and processCommand: a pid's folder (lsof -d cwd) and its command line (ps), null when unknown", async () => {
  assert.equal(parseLsofCwd("p900\nfcwd\nn/Users/u/old app\n"), "/Users/u/old app");
  assert.equal(parseLsofCwd("p900\nftxt\nn/bin/node\n"), null);
  const { exec, calls } = holderExec();
  assert.equal(await processCwd(900, { exec }), "/Users/u/old/speaking-english");
  assert.deepEqual(calls.at(-1), ["lsof", "-a", "-p", "900", "-d", "cwd", "-F", "n"]);
  assert.equal(await processCommand(900, { exec }), "next-server (v16.0.1)");
  assert.deepEqual(calls.at(-1), ["ps", "-o", "command=", "-p", "900"]);
  assert.equal(await processCwd(901, { exec }), null);
  assert.equal(await processCommand(901, { exec }), null);
  // A long command line is cut, on one line.
  const long = holderExec({ commands: { 900: `node ${"x".repeat(300)}` } });
  const cut = await processCommand(900, long);
  assert.ok(cut.length <= 120 && cut.endsWith("…"), cut);
});

test("foreignListener: a listener outside the terminal's tree is reported with pid, command and cwd; one inside is not", async () => {
  // Terminal 100's tree is 100 → 101 → 102 → 103: 102 is Spotlight's server.
  assert.deepEqual(await foreignListener(3008, 100, holderExec()), {
    pid: 900, command: "next-server (v16.0.1)", cwd: "/Users/u/old/speaking-english",
  });
  const mine = holderExec({ listing: { code: 0, stdout: "p102\ncnode\nf23\nn*:3008\n" } });
  assert.equal(await foreignListener(3008, 100, mine), null);
  // No terminal yet: every listener is someone else's.
  assert.equal((await foreignListener(3008, null, mine)).pid, 102);
  // ps can't say: lsof's command name stands in; no cwd known.
  const bare = holderExec({ cwds: {}, commands: {} });
  assert.deepEqual(await foreignListener(3008, 100, bare), { pid: 900, command: "node", cwd: null });
  assert.equal(await foreignListener(3008, 100, holderExec({ listing: { code: 1, stdout: "" } })), null);
  assert.equal(await foreignListener(3008, 100, holderExec({ listing: new Error("ENOENT") })), null);
});

// A process table with a fake clock: `kill(pid, 0)` throws ESRCH once a pid
// died; SIGTERM kills those that don't ignore it, SIGKILL kills anything.
function processWorld(table) {
  let clock = 0;
  const alive = new Set(Object.keys(table).map(Number));
  const signals = [];
  const children = Object.fromEntries(Object.entries(table).map(([pid, p]) => [pid, p.children ?? []]));
  const exec = async (file, args) => {
    assert.equal(file, "pgrep");
    const kids = (children[Number(args[1])] ?? []).filter((k) => alive.has(k));
    return kids.length ? { code: 0, stdout: kids.map((k) => `${k}\n`).join(""), stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  const kill = (pid, sig) => {
    if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (sig === 0) return true;
    signals.push({ pid, sig, at: clock });
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !table[pid].ignoresTerm)) alive.delete(pid);
    return true;
  };
  return {
    deps: { exec, kill, now: () => clock, sleep: async (ms) => { clock += ms; } },
    signals, alive,
  };
}

test("stopProcessTree: TERM to the pid and its descendants, KILL after 5 s to those still alive, nobody else", async () => {
  assert.equal(FREE_PORT_GRACE_MS, 5000);
  // 900 ignores TERM; its child 901 doesn't; 902 → 903 ignores it too; 950 is a bystander.
  const w = processWorld({
    900: { children: [901, 902], ignoresTerm: true }, 901: {}, 902: { children: [903] }, 903: { ignoresTerm: true }, 950: {},
  });
  const r = await stopProcessTree(900, w.deps);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.pids].sort(), [900, 901, 902, 903]);
  assert.deepEqual([...r.killed].sort(), [900, 903]);
  const terms = w.signals.filter((s) => s.sig === "SIGTERM");
  assert.deepEqual(terms.map((s) => s.pid).sort(), [900, 901, 902, 903]);
  assert.ok(terms.every((s) => s.at === 0));
  const kills = w.signals.filter((s) => s.sig === "SIGKILL");
  assert.deepEqual(kills.map((s) => s.pid).sort(), [900, 903]);
  assert.ok(kills.every((s) => s.at >= 5000), JSON.stringify(kills));
  assert.ok(!w.signals.some((s) => s.pid === 950), "a bystander is never signalled");
  assert.deepEqual([...w.alive], [950]);
});

test("stopProcessTree: a tree that goes on TERM gets no KILL and no 5 s wait", async () => {
  const w = processWorld({ 900: { children: [901] }, 901: {} });
  const r = await stopProcessTree(900, w.deps);
  assert.deepEqual(r.killed, []);
  assert.ok(!w.signals.some((s) => s.sig === "SIGKILL"));
  assert.ok(w.deps.now() < 5000, `waited ${w.deps.now()} ms`);
});

test("stopProcessTree: never signals pid 1, nor a tree holding a protected pid (the CLI itself, the server terminal)", async () => {
  for (const pid of [1, 0, -5, null]) {
    const w = processWorld({ 1: { children: [900] }, 900: {} });
    assert.equal((await stopProcessTree(pid, w.deps)).ok, false, String(pid));
    assert.deepEqual(w.signals, []);
  }
  // 800 is an ancestor of the CLI (protected 801): its tree is never touched.
  const w = processWorld({ 800: { children: [801, 802] }, 801: {}, 802: {} });
  const r = await stopProcessTree(800, w.deps, { protect: [801] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "protected");
  assert.deepEqual(w.signals, []);
});
