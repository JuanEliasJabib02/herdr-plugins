// T5b: the listening ports of a Spotlight server terminal (D10). M/ports.js
// parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn`, keeps the sockets of the
// process tree under the terminal's own pid (walked with `pgrep -P`), and
// picks the port the badge and `spotlight on` show (Orca's pickPort,
// O/src/main/spotlight/spotlight-agent-servers.ts:40-48, with D10's fallback
// to the lowest port).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as portsMod from "../mods/spotlight/ports.js";
import {
  LSOF_ARGV, parseLsofListen, processTree, treePorts, pickPort, portLabel, portUrl,
  portListeners, parseLsofCwd, processCwd, processCommand, foreignListener, stopProcessTree, FREE_PORT_GRACE_MS,
  childPids, insideRoot, serverSnapshot, serverLeftovers, stopLeftovers, LEFTOVER_GRACE_MS, validPort,
  processStates, treeListening,
} from "../mods/spotlight/ports.js";
// ports.js runs every lstart read as `/usr/bin/env LC_ALL=C TZ=UTC ps …`
// (H7): unwrapEnv gives the program and args under the env words, and those
// words (`env`, null for a call that isn't wrapped).
import { unwrapEnv } from "./fake-ps.mjs";

// Review r3 helpers, destructured so a missing one fails its own tests only.
const { goneIdentities, identityKey } = portsMod;

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

test("validPort (R9): one rule for a TCP port, shared with server-log.js", () => {
  for (const ok of [1, 80, 3000, 65535]) assert.equal(validPort(ok), true, String(ok));
  for (const bad of [0, -1, 65536, 3000.5, "3000", null, undefined, Number.NaN]) assert.equal(validPort(bad), false, String(bad));
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
// An entry's `ports` are its listening sockets (`lsof -F pcn`) and `cwd` its
// folder (`lsof -a -p <pid> -d cwd`); `children` is read on every pgrep, so a
// test reparents a process by editing the table (a dead parent has none:
// its orphans belong to launchd). `ps -o pid=,ppid=,stat=,lstart=` answers
// each live pid's parent, state and `start` (lstart, opaque: the locale
// decides its words); `ps -o pid=,command=` its `command`. `eperm`: a
// process that isn't ours (kill throws EPERM, so it lives through SIGKILL);
// `zombieOnDeath`: one whose parent doesn't reap it (dead, but kill 0 still
// answers and ps shows state Z).
const START = "Sun Nov  8 10:00:00 2026";
function processWorld(table) {
  let clock = 0;
  const alive = new Set(Object.keys(table).map(Number));
  const zombies = new Set();
  const signals = [];
  const parentOf = (pid) => {
    for (const [p, entry] of Object.entries(table)) {
      if (alive.has(Number(p)) && !zombies.has(Number(p)) && entry.children?.includes(pid)) return Number(p);
    }
    return 1;
  };
  const exec = async (rawFile, rawArgs) => {
    const { file, args } = unwrapEnv(rawFile, rawArgs);
    if (file === "ps") {
      const fields = args[args.indexOf("-o") + 1];
      const pids = args[args.indexOf("-p") + 1].split(",").map(Number).filter((p) => alive.has(p));
      const rows = pids.map((p) =>
        fields.includes("lstart")
          ? `${String(p).padStart(5)} ${String(parentOf(p)).padStart(5)} ${zombies.has(p) ? "Z" : "S"}    ${table[p].start ?? START}    `
          : `${String(p).padStart(5)} ${table[p].command ?? "node"}`,
      );
      return { code: rows.length ? 0 : 1, stdout: rows.map((r) => `${r}\n`).join(""), stderr: "" };
    }
    if (file === "lsof" && args.includes("-d")) {
      const pid = Number(args[args.indexOf("-p") + 1]);
      const cwd = alive.has(pid) ? table[pid]?.cwd : undefined;
      return cwd ? { code: 0, stdout: `p${pid}\nfcwd\nn${cwd}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (file === "lsof") {
      const lines = [];
      for (const pid of alive) {
        if (!table[pid].ports?.length) continue;
        lines.push(`p${pid}`, "cnode");
        for (const port of table[pid].ports) lines.push("f20", `n*:${port}`);
      }
      return { code: lines.length ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
    }
    assert.equal(file, "pgrep");
    const parent = Number(args[1]);
    const kids = alive.has(parent) && !zombies.has(parent) ? (table[parent]?.children ?? []).filter((k) => alive.has(k)) : [];
    return kids.length ? { code: 0, stdout: kids.map((k) => `${k}\n`).join(""), stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  const kill = (pid, sig) => {
    if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (table[pid].eperm) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    if (sig === 0) return true;
    signals.push({ pid, sig, at: clock });
    if (zombies.has(pid)) return true;
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !table[pid].ignoresTerm)) {
      if (table[pid].zombieOnDeath) zombies.add(pid);
      else alive.delete(pid);
    }
    return true;
  };
  return {
    deps: { exec, kill, now: () => clock, sleep: async (ms) => { clock += ms; } },
    signals, alive, zombies, table,
    // A process that starts now (a restart typed into the terminal).
    spawn(pid, entry = {}) {
      table[pid] = entry;
      alive.add(pid);
    },
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

test("stopProcessTree (R4): a process still alive after SIGKILL makes it fail with the survivors; a zombie counts as gone", async () => {
  // 900 isn't ours to signal (EPERM: alive, and SIGKILL can't reach it); its child 901 goes on TERM.
  const w = processWorld({ 900: { children: [901], eperm: true }, 901: {} });
  const r = await stopProcessTree(900, w.deps);
  assert.deepEqual(
    { ok: r.ok, reason: r.reason, pids: [...r.pids].sort(), killed: r.killed, survivors: r.survivors },
    { ok: false, reason: "survived", pids: [900, 901], killed: [900], survivors: [900] },
  );
  assert.deepEqual([...w.alive], [900]);

  // 910 ignores TERM and turns zombie on KILL; its child 911 turns zombie on
  // TERM. kill 0 still answers for both, ps shows them Z: both are gone, and
  // the zombie child is neither waited on nor sent a KILL.
  const z = processWorld({ 910: { children: [911], ignoresTerm: true, zombieOnDeath: true }, 911: { zombieOnDeath: true } });
  const ok = await stopProcessTree(910, z.deps);
  assert.deepEqual({ ok: ok.ok, killed: ok.killed, survivors: ok.survivors }, { ok: true, killed: [910], survivors: undefined });
  assert.deepEqual(z.signals.filter((s) => s.sig === "SIGKILL").map((s) => s.pid), [910]);
  assert.deepEqual([...z.zombies].sort(), [910, 911]);
});

// ── What a turn-off's Ctrl-C leaves behind (T15, D26) ──────────────────────

const APP = "/Users/demo/code/app";
// The identities Spotlight recorded while its server ran (readServerState's
// `procs`, the start time as ps reads it with its spaces folded): 600 and
// 610, each on 8080. stopServer gets them back as its `procs`.
const KNOWN = [
  { pid: 600, start: "Sun Nov 8 10:00:00 2026", port: 8080 },
  { pid: 610, start: "Sun Nov 8 10:00:00 2026", port: 8080 },
];

// A Spotlight server terminal at turn-off: zsh -l (100) → script (101) →
// zsh -c (102) → next-server (103, on 3210, in apps/web) and a `sleep` (104)
// that ignores INT, TERM and HUP (the spotlight-lab fixture's
// `(trap '' INT TERM HUP; exec sleep 900) &`), listening on nothing. The
// shell has its own helpers: gitstatusd (150) and a job someone put in the
// background (151, on the recorded 8080, in the root). 600 listens on 8080
// from a sibling folder that only shares the root's prefix; 610 on 8080
// inside the root, outside the terminal (a server child that escaped
// earlier); 702 is a database nobody recorded.
function serverWorld(over = {}) {
  const at = (s) => `Sun Nov  8 10:00:${String(s).padStart(2, "0")} 2026`;
  return processWorld({
    100: { children: [101, 150, 151], cwd: APP, start: at(0), command: "-zsh" },
    101: { children: [102], cwd: APP, start: at(1), command: "script -F -q -a /logs/app.log /bin/zsh -c pnpm dev" },
    102: { children: [103, 104], cwd: APP, start: at(2), command: "next dev --port 3210" },
    103: { ports: [3210], cwd: `${APP}/apps/web`, start: at(3), command: "next-server (v16.0.1)" },
    104: { cwd: APP, start: at(3), command: "sleep 900", ignoresTerm: true },
    150: { cwd: APP, start: at(0), command: "gitstatusd-darwin-arm64" },
    151: { ports: [8080], cwd: APP, start: at(4), command: "python3 -m http.server 8080" },
    600: { ports: [8080], cwd: `${APP}-old`, start: at(0) },
    610: { ports: [8080], cwd: `${APP}/apps/api`, start: at(0), command: "node api.js" },
    702: { ports: [5432], cwd: "/opt/homebrew/var/postgres", start: at(0) },
    ...over,
  });
}

test("insideRoot: the root itself or a folder under it; a sibling sharing its prefix, or a root of /, never", () => {
  assert.equal(insideRoot(APP, APP), true);
  assert.equal(insideRoot(`${APP}/apps/web`, `${APP}/`), true);
  assert.equal(insideRoot(`${APP}-old`, APP), false);
  assert.equal(insideRoot("/Users/demo/code", APP), false);
  assert.equal(insideRoot("/Users/demo", "/"), false);
  assert.equal(insideRoot(null, APP), false);
  assert.equal(insideRoot(APP, null), false);
  assert.equal(insideRoot("app/x", "app"), false);
});

test("childPids: the direct children only (pgrep -P); none, or no pid, is []", async () => {
  const { exec } = fakeExec();
  assert.deepEqual(await childPids(100, { exec }), [101]);
  assert.deepEqual(await childPids(103, { exec }), []);
  assert.deepEqual(await childPids(null, { exec }), []);
});

test("serverSnapshot (R1): before the Ctrl-C, the server's own tree from its pid, each process with its start time and command; never the terminal's shell nor its helpers", async () => {
  const w = serverWorld();
  const snap = await serverSnapshot({ rootPid: 100, serverPid: 101, ports: [8080, 0, "x"], procs: KNOWN }, w.deps);
  assert.equal(snap.rootPid, 100);
  assert.equal(snap.serverPid, 101);
  // The ports the server listens on, plus the recorded ones.
  assert.deepEqual(snap.ports, [3210, 8080]);
  // script and everything under it; not the shell (100), its gitstatusd (150) or its job (151).
  assert.deepEqual([...snap.procs.keys()].sort(), [101, 102, 103, 104]);
  // ps's lstart is kept as it reads (its words follow the locale), spaces folded.
  assert.deepEqual(snap.procs.get(103), { start: "Sun Nov 8 10:00:03 2026", command: "next-server (v16.0.1)" });
  // Who else listens on those ports, outside the terminal's tree: 600 and
  // 610 (the shell's own job 151 is not; 702's 5432 is nobody's).
  assert.deepEqual([...snap.listeners.keys()].sort(), [600, 610]);
  assert.deepEqual(snap.listeners.get(610), { start: "Sun Nov 8 10:00:00 2026", command: "node api.js" });

  // A server pid that isn't the shell's child (hc's read went stale and the
  // pid is someone else's now) is no server: nothing of its tree is kept.
  const stale = await serverSnapshot({ rootPid: 100, serverPid: 103, ports: [] }, w.deps);
  assert.equal(stale.procs.size, 0);
  assert.deepEqual(stale.ports, []);
  // No shell pid from hc: the server's own tree still counts.
  const bare = await serverSnapshot({ rootPid: null, serverPid: 101, ports: [] }, w.deps);
  assert.deepEqual([...bare.procs.keys()].sort(), [101, 102, 103, 104]);
  assert.deepEqual(bare.ports, [3210]);
  // The prompt is free (no server): only who listens on the recorded ports.
  const idle = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [8080], procs: KNOWN }, w.deps);
  assert.equal(idle.procs.size, 0);
  assert.deepEqual([...idle.listeners.keys()].sort(), [600, 610]);
  // No server and no recorded port: nothing to read.
  const calls = [];
  const none = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [] }, { exec: async (...a) => { calls.push(a); return w.deps.exec(...a); } });
  assert.deepEqual({ procs: none.procs.size, listeners: none.listeners.size, ports: none.ports, calls }, { procs: 0, listeners: 0, ports: [], calls: [] });
});

test("serverLeftovers (R1, C7): each process of the server still alive as the same process, wherever it was reparented; a reused pid is not; a listener on its ports runs inside the root", async () => {
  const w = serverWorld();
  const snap = await serverSnapshot({ rootPid: 100, serverPid: 101, ports: [8080], procs: KNOWN }, w.deps);
  const escaped = [{ pid: 610, port: 8080, cwd: `${APP}/apps/api` }];
  // Nothing moved yet: the whole server, and 610 (on the recorded 8080, in
  // the root). Never the shell's gitstatusd or its job; never 600, whose
  // folder only shares the root's prefix.
  assert.deepEqual(await serverLeftovers(snap, APP, w.deps), { procs: [101, 102, 103, 104], escaped });

  // The Ctrl-C took script and zsh -c. next-server and the sleep that ignores
  // it live on, reparented to launchd, the sleep listening on nothing: both
  // are still the server's.
  w.alive.delete(101);
  w.alive.delete(102);
  assert.deepEqual(await serverLeftovers(snap, APP, w.deps), { procs: [103, 104], escaped });
  // No root to compare with: the server's own processes still are leftovers; no listener is.
  assert.deepEqual(await serverLeftovers(snap, null, w.deps), { procs: [103, 104], escaped: [] });

  // next-server ends and its pid goes to an unrelated process (another start
  // time) in the root on 3210; a restart typed during the wait (110, the
  // shell's new child, on 3210 too) and a server started by hand in the root
  // (111, on 8080): none of them was there before the Ctrl-C.
  w.alive.delete(103);
  w.spawn(103, { ports: [3210], cwd: APP, start: "Sun Nov  8 10:00:09 2026" });
  w.spawn(110, { ports: [3210], cwd: APP, start: "Sun Nov  8 10:00:09 2026" });
  w.table[100].children.push(110);
  w.spawn(111, { ports: [8080], cwd: APP, start: "Sun Nov  8 10:00:09 2026" });
  assert.deepEqual(await serverLeftovers(snap, APP, w.deps), { procs: [104], escaped });

  // A zombie is gone.
  w.zombies.add(104);
  assert.deepEqual(await serverLeftovers(snap, APP, w.deps), { procs: [], escaped });

  // ps can't run: doubt never kills.
  const blind = async (file, args) => (unwrapEnv(file, args).file === "ps" ? Promise.reject(new Error("spawn ps ENOENT")) : w.deps.exec(file, args));
  assert.deepEqual(await serverLeftovers(snap, APP, { exec: blind }), { procs: [], escaped: [] });
});

test("stopLeftovers: TERM once to every process of the leftovers' trees, KILL 3 s later to those still alive; never the terminal's shell", async () => {
  assert.equal(LEFTOVER_GRACE_MS, 3000);
  // The whole server is left (overlapping trees: each process is signalled
  // once); the sleep (104) ignores TERM; 610 escaped earlier and goes on TERM.
  const w = serverWorld();
  const r = await stopLeftovers({ procs: [101, 102, 103, 104], escaped: [{ pid: 610, port: 8080, cwd: `${APP}/apps/api` }] }, 100, w.deps);
  assert.deepEqual([...r.pids].sort(), [101, 102, 103, 104, 610]);
  assert.deepEqual(r.killed, [104]);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.survivors, []);
  const term = w.signals.filter((s) => s.sig === "SIGTERM");
  assert.deepEqual(term.map((s) => s.pid).sort(), [101, 102, 103, 104, 610]);
  assert.ok(term.every((s) => s.at === 0));
  const kills = w.signals.filter((s) => s.sig === "SIGKILL");
  assert.deepEqual(kills.map((s) => s.pid), [104]);
  assert.ok(kills[0].at >= 3000, JSON.stringify(kills));
  assert.ok(!w.signals.some((s) => [100, 150, 151].includes(s.pid)), "the shell and its helpers are never signalled");
  assert.deepEqual([...w.alive].sort(), [100, 150, 151, 600, 702]);

  // The shell passed as a leftover, or a tree holding a protected pid (the
  // CLI), is refused and nothing in it is signalled.
  const v = serverWorld();
  const refused = await stopLeftovers({ procs: [100, 101], escaped: [] }, 100, v.deps, { protect: [103] });
  assert.deepEqual(refused.pids, []);
  assert.deepEqual(refused.refused.sort(), [100, 101]);
  assert.deepEqual(v.signals, []);

  // One that lives through SIGKILL (not ours to signal) is a survivor (R4).
  const stuck = serverWorld({ 610: { ports: [8080], cwd: `${APP}/apps/api`, eperm: true } });
  const s = await stopLeftovers({ escaped: [{ pid: 610, port: 8080, cwd: `${APP}/apps/api` }] }, 100, stuck.deps);
  assert.deepEqual({ pids: s.pids, killed: s.killed, survivors: s.survivors }, { pids: [610], killed: [610], survivors: [610] });

  // Nothing left: nothing signalled, no wait.
  const quiet = serverWorld();
  assert.deepEqual(await stopLeftovers({ procs: [], escaped: [] }, 100, quiet.deps), { pids: [], killed: [], refused: [], survivors: [] });
  assert.equal(quiet.deps.now(), 0);
});

test("serverSnapshot and serverLeftovers (F2): a listener outside the server's tree counts only when its pid and start time match an identity Spotlight recorded while its server ran; none recorded, none watched", async () => {
  const w = serverWorld();
  // An old record (no identities): neither 600 nor 610 is watched, on the
  // running path or at a free prompt; the server's own tree still is.
  const snap = await serverSnapshot({ rootPid: 100, serverPid: 101, ports: [8080] }, w.deps);
  assert.equal(snap.listeners.size, 0);
  assert.deepEqual([...snap.procs.keys()].sort(), [101, 102, 103, 104]);
  assert.deepEqual(await serverLeftovers(snap, APP, w.deps), { procs: [101, 102, 103, 104], escaped: [] });
  const idle = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [8080] }, w.deps);
  assert.equal(idle.listeners.size, 0);
  assert.deepEqual(await serverLeftovers(idle, APP, w.deps), { procs: [], escaped: [] });

  // 610 recorded as readServerState reads it (spaces folded) or as ps prints
  // it (raw): the same. 600's pid was recorded with another start time: the
  // process on it now (a server started by hand) is someone else.
  for (const start of ["Sun Nov 8 10:00:00 2026", "Sun Nov  8 10:00:00 2026"]) {
    const procs = [{ pid: 610, start, port: 8080 }, { pid: 600, start: "Sun Nov 8 09:59:00 2026", port: 8080 }];
    const known = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [8080], procs }, w.deps);
    assert.deepEqual([...known.listeners.keys()], [610], start);
    assert.deepEqual(await serverLeftovers(known, APP, w.deps), { procs: [], escaped: [{ pid: 610, port: 8080, cwd: `${APP}/apps/api` }] });
  }
  // An identity brings its port: with no ports recorded, 610 on 8080 is found.
  const byId = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [], procs: [KNOWN[1]] }, w.deps);
  assert.deepEqual({ listeners: [...byId.listeners.keys()], ports: byId.ports }, { listeners: [610], ports: [8080] });
  // Malformed identities (no pid, no start) count for nothing.
  const junk = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [8080], procs: [{ pid: 610 }, { start: KNOWN[1].start, port: 8080 }, null, "x"] }, w.deps);
  assert.equal(junk.listeners.size, 0);

  // Ports recorded but no server and no identity: nothing to read at all.
  const calls = [];
  const exec = async (...a) => {
    calls.push(a);
    return w.deps.exec(...a);
  };
  const none = await serverSnapshot({ rootPid: 100, serverPid: null, ports: [8080] }, { exec });
  assert.deepEqual({ listeners: none.listeners.size, calls }, { listeners: 0, calls: [] });
});

test("stopLeftovers (F5): each process's children are read once, however the leftovers' trees overlap or are ordered", async () => {
  // A chain 201 → 202 → … → 206, every one a leftover, listed deepest first
  // (the costliest order for one walk per pid), and 610 escaped.
  const table = { 610: { ports: [8080] } };
  for (let p = 201; p <= 206; p++) table[p] = { children: p < 206 ? [p + 1] : [] };
  for (const order of [[206, 205, 204, 203, 202, 201], [201, 202, 203, 204, 205, 206]]) {
    const w = processWorld(structuredClone(table));
    const calls = [];
    const deps = {
      ...w.deps,
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return w.deps.exec(file, args);
      },
    };
    const r = await stopLeftovers({ procs: order, escaped: [{ pid: 610, port: 8080, cwd: `${APP}/apps/api` }] }, 100, deps);
    assert.deepEqual([...r.pids].sort(), [201, 202, 203, 204, 205, 206, 610]);
    assert.deepEqual(r.refused, []);
    const pgreps = calls.filter((c) => c[0] === "pgrep").map((c) => Number(c[2]));
    assert.deepEqual(pgreps.sort(), [201, 202, 203, 204, 205, 206, 610], `order ${order}: one pgrep per pid`);
  }
});

test("F8: stopProcessTree and stopLeftovers need an injected kill: without one they throw and signal nobody", async () => {
  const w = processWorld({ 900: { children: [901] }, 901: {} });
  const { kill, ...noKill } = w.deps;
  assert.equal(typeof kill, "function");
  await assert.rejects(stopProcessTree(900, noKill), /deps\.kill/);
  await assert.rejects(stopLeftovers({ procs: [900] }, 100, noKill), /deps\.kill/);
  await assert.rejects(stopLeftovers({ procs: [900] }, 100, { ...noKill, kill: "process.kill" }), /deps\.kill/);
  assert.deepEqual(w.signals, []);
  assert.deepEqual([...w.alive].sort(), [900, 901]);
});

// ── Review r3: identities read the same in every process (G2, G3) ──────────

// serverWorld's exec, recording each call's program and args (unwrapEnv's),
// the env words it ran under and any exec options it was given.
function recordingWorld(over) {
  const w = serverWorld(over);
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ ...unwrapEnv(file, args), opts });
    return w.deps.exec(file, args);
  };
  return { w, calls, deps: { ...w.deps, exec } };
}
const lstartReads = (calls) => calls.filter((c) => c.file === "ps" && c.args.some((a) => a.includes("lstart")));
// H7: the pinned env rides in the argv, never in an exec option.
const PINNED = { env: { LC_ALL: "C", TZ: "UTC" }, opts: undefined };

test("G2: every ps read that records or checks an identity runs with LC_ALL=C and TZ=UTC", async () => {
  const { calls, deps } = recordingWorld();
  await processStates([101, 103], deps);
  // treeListening records the identities; serverSnapshot and serverLeftovers check them.
  const found = await treeListening(100, 101, deps);
  assert.deepEqual(found.procs, [{ pid: 103, start: "Sun Nov 8 10:00:03 2026", port: 3210 }]);
  const snap = await serverSnapshot({ rootPid: 100, serverPid: 101, ports: [8080], procs: KNOWN }, deps);
  await serverLeftovers(snap, APP, deps);
  const reads = lstartReads(calls);
  assert.ok(reads.length >= 4, `${reads.length} lstart reads`);
  for (const c of reads) assert.deepEqual({ env: c.env, opts: c.opts }, PINNED, c.args.join(" "));
});

// K9, L8: the real ps runs under a caller's own TZ and locale handed to a
// child process (execFile's `env`), never written into this test process's
// env. The time zones are checked under LC_ALL=C (TZ_ENVS) wherever the
// system has their tzdata, else those cases are skipped with the reason
// (M8: without /usr/share/zoneinfo/<zone>, TZ=<zone> reads as UTC and the
// case proves nothing); the locales (LOCALE_ENVS) only where `locale -a` has
// them, and their zones too.
const TZ_ENVS = [["Pacific/Kiritimati", "C"], ["America/Bogota", "C"]];
const LOCALE_ENVS = [["Pacific/Kiritimati", "es_ES.UTF-8"], ["America/Bogota", "fr_FR.UTF-8"]];
const ZONEINFO = "/usr/share/zoneinfo";
// The zones of `envs` whose tzdata `dir` lacks, as a skip reason, or false.
function missingZones(envs, dir = ZONEINFO) {
  const missing = [...new Set(envs.map(([tz]) => tz))].filter((tz) => !existsSync(`${dir}/${tz}`));
  return missing.length > 0 ? `no tzdata for ${missing.join(", ")} in ${dir}` : false;
}
const TZ_SKIP = missingZones(TZ_ENVS);
const callerEnv = (tz, lc) => ({ ...process.env, TZ: tz, LC_ALL: lc, LANG: lc });
function missingLocales() {
  try {
    const have = new Set(execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").map((l) => l.trim()));
    const missing = LOCALE_ENVS.map(([, lc]) => lc).filter((lc) => !have.has(lc));
    return missing.length > 0 ? `locale -a lacks ${missing.join(", ")}` : false;
  } catch (e) {
    return `locale -a failed: ${e.message}`;
  }
}
const LOCALES_SKIP = missingLocales() || missingZones(LOCALE_ENVS);
// ps's lstart of `pid` under `env`, spaces folded.
const lstartUnder = (pid, env) =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env }).replace(/\s+/g, " ").trim();
// The env words this test process had, which no case may change.
const ownEnv = () => ({ TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG });

// G2, K9: a CLI process started with each of `envs` reads an identity the
// same as C/UTC, through the CLI's exec (which passes no env: its children
// inherit the CLI process's).
function cliReadsPinned(envs) {
  const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
  const script = `
    import { execFileSync } from "node:child_process";
    import { exec } from ${url("../mods/spotlight/cli-env.mjs")};
    import { processStates } from ${url("../mods/spotlight/ports.js")};
    const read = (env) => execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env }).replace(/\\s+/g, " ").trim();
    const states = await processStates([process.pid], { exec });
    process.stdout.write(JSON.stringify({
      start: states?.get(process.pid)?.start ?? null,
      pinned: read({ ...process.env, LC_ALL: "C", TZ: "UTC" }),
      own: read(process.env),
    }));
  `;
  const before = ownEnv();
  for (const [tz, lc] of envs) {
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: callerEnv(tz, lc) }));
    // The child really ran under that env: its own words differ from C/UTC's.
    assert.notEqual(out.own, out.pinned, `${tz} ${lc}`);
    assert.equal(out.start, out.pinned, `${tz} ${lc}`);
  }
  assert.deepEqual(ownEnv(), before, "this process's env untouched");
}

test("M8: a time zone the system has no tzdata for skips its cases with the reason, never fails them", () => {
  assert.equal(missingZones([["Not/AZone", "C"], ["Not/AZone", "C"]], ZONEINFO), `no tzdata for Not/AZone in ${ZONEINFO}`);
  assert.equal(missingZones(TZ_ENVS, "/nonexistent-zoneinfo"), "no tzdata for Pacific/Kiritimati, America/Bogota in /nonexistent-zoneinfo");
  assert.equal(missingZones([]), false);
});

test("G2, K9, L8: an identity reads the same whatever the caller's time zone (under LC_ALL=C): the real ps through the CLI's exec, in a CLI process started with that env", { skip: TZ_SKIP }, () => {
  cliReadsPinned(TZ_ENVS);
});

test("G2, K9: an identity reads the same whatever the caller's locale and time zone: the real ps through the CLI's exec, in a CLI process started with that env", { skip: LOCALES_SKIP }, () => {
  cliReadsPinned(LOCALE_ENVS);
});

test("H7: the pinned locale and time zone ride in ps's argv (/usr/bin/env LC_ALL=C TZ=UTC ps …), so an exec of Herdr's shape, which takes no env, reads C/UTC too", async () => {
  // Herdr's exec is (command, args, { cwd, on, timeout }): an env option would be dropped.
  const calls = [];
  const herdrShaped = async (...call) => {
    calls.push(call);
    return { code: 1, stdout: "", stderr: "" };
  };
  await processStates([101, 103], { exec: herdrShaped });
  assert.deepEqual(calls, [["/usr/bin/env", ["LC_ALL=C", "TZ=UTC", "ps", "-o", "pid=,ppid=,stat=,lstart=", "-p", "101,103"]]]);
});

// H7, K9: the real ps through an exec that adds no env of its own reads
// C/UTC under each of `envs` (the child's env, never this process's).
async function bareExecReadsPinned(envs) {
  const pinned = lstartUnder(process.pid, { ...process.env, LC_ALL: "C", TZ: "UTC" });
  const before = ownEnv();
  for (const [tz, lc] of envs) {
    const env = callerEnv(tz, lc);
    // That env reaches the child: ps's own words under it differ from C/UTC's.
    assert.notEqual(lstartUnder(process.pid, env), pinned, `${tz} ${lc}`);
    // An exec that adds nothing: its child runs under the caller's env, and
    // the argv still pins them.
    const bare = (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { encoding: "utf8", env }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
        );
      });
    const states = await processStates([process.pid], { exec: bare });
    assert.equal(states?.get(process.pid)?.start, pinned, `${tz} ${lc}`);
  }
  assert.deepEqual(ownEnv(), before, "this process's env untouched");
}

test("H7, K9, L8: the real ps through an exec that adds no env of its own reads C/UTC under any caller's time zone (under LC_ALL=C)", { skip: TZ_SKIP }, async () => {
  await bareExecReadsPinned(TZ_ENVS);
});

test("H7, K9: the real ps through an exec that adds no env of its own reads C/UTC under any caller's locale and time zone", { skip: LOCALES_SKIP }, async () => {
  await bareExecReadsPinned(LOCALE_ENVS);
});

test("G3: goneIdentities names the identities that no longer run as that process, from one ps with the pinned env; doubt forgets none", async () => {
  const { w, calls, deps } = recordingWorld();
  w.zombies.add(104);
  const alive = [
    { pid: 103, start: "Sun Nov 8 10:00:03 2026", port: 3210 }, // as treeListening folds it
    { pid: 610, start: "Sun Nov  8 10:00:00 2026", port: 8080 }, // as ps prints it
  ];
  const gone = [
    { pid: 600, start: "Sun Nov 8 09:59:00 2026", port: 8080 }, // its pid runs another process
    { pid: 640, start: "Sun Nov 8 10:00:00 2026", port: 8080 }, // ps doesn't list it
    { pid: 104, start: "Sun Nov 8 10:00:03 2026", port: null }, // a zombie
  ];
  const junk = [null, { pid: 5 }, { pid: 6, start: 12 }, { pid: 7, start: "  " }, { pid: -1, start: "x" }];
  const found = await goneIdentities([...alive, ...gone, ...junk], deps);
  assert.deepEqual([...found].sort(), gone.map(identityKey).sort());
  // The same start as ps prints it or folded is one identity.
  assert.equal(identityKey(alive[1]), identityKey({ pid: 610, start: "Sun Nov 8 10:00:00 2026" }));
  const reads = lstartReads(calls);
  assert.equal(reads.length, 1, "one ps for the whole list");
  assert.deepEqual({ env: reads[0].env, opts: reads[0].opts }, PINNED);
  assert.deepEqual(reads[0].args.at(-1).split(",").map(Number).sort((a, b) => a - b), [103, 104, 600, 610, 640]);

  // Nothing to check: no ps at all.
  calls.length = 0;
  assert.deepEqual([...(await goneIdentities([], deps))], []);
  assert.deepEqual([...(await goneIdentities(junk, deps))], []);
  assert.deepEqual(calls, []);
  // ps can't run, or fails: nothing is gone.
  const blind = async (file, args) => (unwrapEnv(file, args).file === "ps" ? Promise.reject(new Error("spawn ps ENOENT")) : { code: 1, stdout: "", stderr: "" });
  assert.deepEqual([...(await goneIdentities(gone, { exec: blind }))], []);
  const failing = async () => ({ code: 2, stdout: "", stderr: "ps: bad" });
  assert.deepEqual([...(await goneIdentities(gone, { exec: failing }))], []);
});
