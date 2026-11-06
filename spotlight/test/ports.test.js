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
