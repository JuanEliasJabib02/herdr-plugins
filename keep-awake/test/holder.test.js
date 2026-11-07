import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Holder, paths, parsePid, caffeinateCommand, SPAWN_SCRIPT, LIVENESS_MS, RETRY_MS,
} from "../mods/keep-awake/holder.js";

const APP = "/Users/demo/.config/herdr-app";
const DIR = `${APP}/keep-awake`;
const PID_FILE = `${DIR}/caffeinate.pid`;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const HERDR = 500; // /Applications/Herdr.app/Contents/MacOS/Herdr
const CORE = 600; // herdr-core, a child of the app
const ORPHAN_CORE = 700; // herdr-core left under launchd after the app quit
const APP_COMM = "/Applications/Herdr.app/Contents/MacOS/Herdr";
const CORE_COMM = "/Users/demo/.local/bin/herdr-core";
// D1, spelled out here rather than imported, so the test pins the command line.
const D1_SCRIPT = 'nohup /usr/bin/caffeinate -i -s -w "$1" </dev/null >/dev/null 2>&1 & echo $!';
const D1_ARGV = ["/bin/sh", "-c", D1_SCRIPT, "sh", String(HERDR)];
const ours = (herdr = HERDR) => `/usr/bin/caffeinate -i -s -w ${herdr}`;

// A fake Mac shared by every copy in a test: its processes, the files under
// appHome (writeTextFile's compare-and-swap: a write lands only while the
// file still holds `expected`, null = absent) and every exec call made.
function machine({ shPpid = HERDR, files = {}, procs = {} } = {}) {
  const m = {
    shPpid,
    files: { ...files },
    procs: new Map([
      [1, { ppid: 0, comm: "/sbin/launchd", command: "/sbin/launchd" }],
      [HERDR, { ppid: 1, comm: APP_COMM, command: APP_COMM }],
      [CORE, { ppid: HERDR, comm: CORE_COMM, command: `${CORE_COMM} server` }],
      [ORPHAN_CORE, { ppid: 1, comm: CORE_COMM, command: `${CORE_COMM} server` }],
      ...Object.entries(procs).map(([pid, command]) => [Number(pid), { ppid: 1, comm: command.split(" ")[0], command }]),
    ]),
    nextPid: 9000,
    calls: [],
    dirs: [],
    spawnFails: false, // the sh exits non-zero
    spawnRejects: false, // exec can't start sh at all
    psRejects: false,
    writeFails: false, // a write that fails for another reason than a stale snapshot
    afterSpawn: null, // runs between the spawn and its pid-file write (a race)
    spawnGate: null, // a promise the spawn waits on
    ppidGate: null, // a promise `echo $PPID` waits on (a start before its spawn)
    writeGate: null, // a promise the next write waits on once its text has landed
    reads: 0, // how many times the pid file was read
  };
  m.caffeinates = () => [...m.procs].filter(([, p]) => p.comm === "/usr/bin/caffeinate").map(([pid]) => pid);
  m.spawns = () => m.calls.filter((c) => c[0] === "/bin/sh" && c[2] === D1_SCRIPT);
  m.kills = () => m.calls.filter((c) => c[0] === "kill").map((c) => Number(c[1]));
  m.exec = async (cmd, args = []) => {
    const call = [cmd, ...args];
    m.calls.push(call);
    await Promise.resolve();
    if (cmd === "/bin/sh" && args[0] === "-c" && args[1] === "echo $PPID") {
      if (m.ppidGate) await m.ppidGate;
      return ok(`${m.shPpid}\n`);
    }
    if (cmd === "/bin/sh" && args[0] === "-c" && args[1] === D1_SCRIPT) {
      if (m.spawnGate) await m.spawnGate;
      if (m.spawnRejects) throw new Error("spawn /bin/sh ENOENT");
      if (m.spawnFails) return { code: 1, stdout: "", stderr: "fork failed" };
      const pid = m.nextPid++;
      m.procs.set(pid, { ppid: 1, comm: "/usr/bin/caffeinate", command: `/usr/bin/caffeinate -i -s -w ${args[3]}` });
      const after = m.afterSpawn;
      m.afterSpawn = null;
      if (after) after();
      return ok(`${pid}\n`);
    }
    if (cmd === "ps") {
      if (m.psRejects) throw new Error("spawn ps ENOENT");
      const [flag, pid, o, fields] = args;
      assert.equal(flag, "-p");
      assert.equal(o, "-o");
      const p = m.procs.get(Number(pid));
      if (!p) return { code: 1, stdout: "", stderr: "" };
      if (fields === "command=") return ok(`${p.command}\n`);
      if (fields === "ppid=,comm=") return ok(`${String(p.ppid).padStart(5)} ${p.comm}\n`);
    }
    if (cmd === "kill" && args.length === 1) {
      const pid = Number(args[0]);
      if (!m.procs.has(pid)) return { code: 1, stdout: "", stderr: `kill: ${pid}: No such process` };
      m.procs.delete(pid);
      return ok("");
    }
    throw new Error(`unexpected exec: ${call.join(" ")}`);
  };
  m.read = async (path) => {
    m.reads++;
    await Promise.resolve();
    return Object.hasOwn(m.files, path) ? m.files[path] : null;
  };
  m.write = async (path, text, expected) => {
    await Promise.resolve();
    if (m.writeFails) throw new Error("EACCES");
    const current = Object.hasOwn(m.files, path) ? m.files[path] : null;
    if (current !== expected) throw new Error(`stale snapshot for ${path}`);
    m.files[path] = text;
    // Landed, but the promise resolves later (Herdr's writeTextFile).
    const gate = m.writeGate;
    m.writeGate = null;
    if (gate) await gate;
    return null;
  };
  m.mkdirp = async (dir) => {
    m.dirs.push(dir);
  };
  m.holder = (over = {}) =>
    new Holder({ exec: m.exec, read: m.read, write: m.write, mkdirp: m.mkdirp, appHome: APP, now: () => NOW, ...over });
  return m;
}

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

test("paths: the pid file is appHome()/keep-awake/caffeinate.pid (D3)", () => {
  assert.deepEqual(paths(APP), { dir: DIR, pid: PID_FILE });
  assert.deepEqual(paths(`${APP}/`), { dir: DIR, pid: PID_FILE });
});

test("parsePid: a positive whole number alone on its line, else null", () => {
  assert.equal(parsePid("4242\n"), 4242);
  assert.equal(parsePid("  77 "), 77);
  for (const t of [null, undefined, "", "\n", "0", "-5", "12ab", "1 2", "3.5"]) assert.equal(parsePid(t), null, String(t));
});

test("the constants: D1's script, Orca's flags, 15 s liveness and 30 s retry (D1, D6)", () => {
  assert.equal(SPAWN_SCRIPT, D1_SCRIPT);
  assert.equal(caffeinateCommand(HERDR), "/usr/bin/caffeinate -i -s -w 500");
  assert.equal(LIVENESS_MS, 15_000);
  assert.equal(RETRY_MS, 30_000);
});

test("start: the sh command line exactly as D1, its stdout's pid written to the pid file (D1, D3)", async () => {
  const m = machine();
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), true);
  assert.deepEqual(m.spawns(), [D1_ARGV]);
  assert.equal(m.files[PID_FILE], "9000\n");
  assert.deepEqual(m.dirs, [DIR]);
  assert.deepEqual(m.caffeinates(), [9000]);
  assert.equal(m.procs.get(9000).command, ours());
  assert.equal(h.holding, true);
  assert.equal(h.pid, 9000);
});

test("held: ticks inside the 15 s window run nothing (D6)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  const before = m.calls.length;
  for (const t of [1_000, 2_000, LIVENESS_MS - 1]) assert.equal(await h.tick(true, NOW + t), true);
  assert.equal(m.calls.length, before);
});

test("off, never held: a tick runs nothing and holds nothing (D6)", async () => {
  const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  const h = m.holder();
  for (let t = 0; t < 5; t++) assert.equal(await h.tick(false, NOW + t * 1_000), false);
  assert.deepEqual(m.calls, []);
  assert.equal(m.files[PID_FILE], "4242\n");
});

test("swap lost: the copy kills its own caffeinate and keeps (adopts) the file's (D3)", async () => {
  const m = machine();
  // Another window's copy wrote its caffeinate's pid between this copy's
  // spawn and its write.
  m.afterSpawn = () => {
    m.procs.set(7777, { ppid: 1, comm: "/usr/bin/caffeinate", command: ours() });
    m.files[PID_FILE] = "7777\n";
  };
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), true);
  assert.deepEqual(m.kills(), [9000]);
  assert.equal(m.files[PID_FILE], "7777\n");
  assert.deepEqual(m.caffeinates(), [7777]);
  assert.equal(h.pid, 7777);
});

test("swap lost to a copy that cleared the file: own one killed, nothing held, the next tick starts again (D3, D7)", async () => {
  const m = machine({ files: { [PID_FILE]: "4242\n" } }); // a caffeinate that died
  m.afterSpawn = () => {
    m.files[PID_FILE] = ""; // the closing copy released and cleared it
  };
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), false);
  assert.deepEqual(m.kills(), [9000]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(await h.tick(true, NOW + 1_000), true, "no 30 s wait after a lost race");
  assert.equal(m.files[PID_FILE], "9001\n");
});

test("a pid file that can't be written (not a race): own caffeinate killed, retried after 30 s", async () => {
  const m = machine();
  m.writeFails = true;
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), false);
  assert.deepEqual(m.kills(), [9000]);
  assert.deepEqual(m.caffeinates(), []);
  m.writeFails = false;
  assert.equal(await h.tick(true, NOW + RETRY_MS - 1), false);
  assert.equal(m.spawns().length, 1);
  assert.equal(await h.tick(true, NOW + RETRY_MS), true);
  assert.equal(m.files[PID_FILE], "9001\n");
});

test("two copies starting at once leave one caffeinate, both holding it (D3)", async () => {
  const m = machine();
  const a = m.holder();
  const b = m.holder();
  assert.deepEqual(await Promise.all([a.tick(true, NOW), b.tick(true, NOW)]), [true, true]);
  assert.equal(m.caffeinates().length, 1);
  const [only] = m.caffeinates();
  assert.equal(m.files[PID_FILE], `${only}\n`);
  assert.equal(a.pid, only);
  assert.equal(b.pid, only);
});

test("adopt: a live pid in the file whose command matches is held, nothing spawned (D3)", async () => {
  const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), true);
  assert.deepEqual(m.spawns(), []);
  assert.deepEqual(m.kills(), []);
  assert.equal(m.files[PID_FILE], "4242\n");
  assert.equal(h.pid, 4242);
  assert.ok(m.calls.some((c) => c.join(" ") === "ps -p 4242 -o command="));
});

test("a pid whose command doesn't match is forgotten, never killed, and a new one started (D3)", async () => {
  for (const command of ["/usr/bin/vim notes.txt", "/usr/bin/caffeinate -i -s -w 777", "/usr/bin/caffeinate -d"]) {
    const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: command } });
    const h = m.holder();
    assert.equal(await h.tick(true, NOW), true, command);
    assert.deepEqual(m.kills(), [], command);
    assert.ok(m.procs.has(4242), command);
    assert.equal(m.files[PID_FILE], "9000\n", command);
    assert.equal(h.pid, 9000, command);
  }
});

test("a dead pid or junk in the file: a new one is started over it (D3)", async () => {
  for (const text of ["4242\n", "", "not a pid\n"]) {
    const m = machine({ files: { [PID_FILE]: text } });
    const h = m.holder();
    assert.equal(await h.tick(true, NOW), true, JSON.stringify(text));
    assert.deepEqual(m.kills(), []);
    assert.equal(m.files[PID_FILE], "9000\n");
  }
});

test("not wanted: the held caffeinate is killed and the pid file cleared (D3, D5)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  assert.equal(await h.tick(false, NOW + 1_000), false);
  assert.deepEqual(m.kills(), [9000]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(h.holding, false);
  const before = m.calls.length;
  assert.equal(await h.tick(false, NOW + 2_000), false);
  assert.equal(m.calls.length, before, "nothing runs once released");
});

test("not wanted with an adopted one: killed too; the file is cleared once (D3)", async () => {
  const m = machine();
  const a = m.holder();
  const b = m.holder();
  await a.tick(true, NOW);
  await b.tick(true, NOW);
  assert.equal(b.pid, 9000);
  await Promise.all([a.tick(false, NOW + 1_000), b.tick(false, NOW + 1_000)]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(m.spawns().length, 1);
});

test("not wanted, none held: the file is looked at every 15 s, never every second, and a caffeinate of ours it lists goes (R1)", async () => {
  // Left by a close() that didn't finish, or before a reload.
  const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  const h = m.holder();
  for (let t = 0; t < LIVENESS_MS; t += 1_000) assert.equal(await h.tick(false, NOW + t), false);
  assert.equal(m.reads, 0, "not read every second");
  assert.deepEqual(m.calls, []);
  assert.equal(await h.tick(false, NOW + LIVENESS_MS), false);
  assert.deepEqual(m.kills(), [4242]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(h.holding, false);
  const reads = m.reads;
  const calls = m.calls.length;
  for (let t = LIVENESS_MS + 1_000; t < 2 * LIVENESS_MS; t += 1_000) await h.tick(false, NOW + t);
  assert.equal(m.reads, reads, "the next look is 15 s later");
  await h.tick(false, NOW + 2 * LIVENESS_MS);
  assert.equal(m.reads, reads + 1);
  assert.equal(m.calls.length, calls, "an empty file runs nothing");
});

test("not wanted, none held: what the file lists and isn't ours, or can't be looked at, is never killed (R1, D3)", async () => {
  for (const command of ["/usr/bin/vim notes.txt", "/usr/bin/caffeinate -i -s -w 777", "/usr/bin/caffeinate -d", null]) {
    const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: command ? { 4242: command } : {} });
    const h = m.holder();
    await h.tick(false, NOW + LIVENESS_MS);
    assert.deepEqual(m.kills(), [], String(command));
    assert.equal(m.files[PID_FILE], "4242\n", String(command));
  }
  const blind = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  blind.psRejects = true;
  await blind.holder().tick(false, NOW + LIVENESS_MS);
  assert.deepEqual(blind.kills(), [], "ps can't run");
  assert.equal(blind.files[PID_FILE], "4242\n");
  const lost = machine({ shPpid: ORPHAN_CORE, files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  await lost.holder().tick(false, NOW + LIVENESS_MS);
  assert.deepEqual(lost.kills(), [], "the Herdr app's pid unknown");
  assert.equal(lost.files[PID_FILE], "4242\n");
});

test("not wanted while ps can't run: the held one and the file are kept, and dropped at a later tick (R2)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  m.psRejects = true;
  assert.equal(await h.tick(false, NOW + 1_000), true, "still held: there's no telling whether it's ours");
  assert.equal(h.pid, 9000);
  assert.equal(m.files[PID_FILE], "9000\n");
  assert.deepEqual(m.kills(), []);
  m.psRejects = false;
  assert.equal(await h.tick(false, NOW + 2_000), false);
  assert.deepEqual(m.kills(), [9000]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(h.holding, false);
});

test("a failed start's 30 s wait ends when nothing is wanted: the next wish starts at once (R4, Orca's stop())", async () => {
  const m = machine();
  m.spawnFails = true;
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), false);
  m.spawnFails = false;
  assert.equal(await h.tick(false, NOW + 1_000), false);
  assert.equal(await h.tick(true, NOW + 2_000), true);
  assert.equal(m.spawns().length, 2);
  assert.equal(m.files[PID_FILE], "9000\n");
});

test("liveness: checked at 15 s; a caffeinate that died is respawned (D6)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  m.procs.delete(9000);
  assert.equal(await h.tick(true, NOW + LIVENESS_MS - 1), true, "not looked at yet");
  assert.equal(m.spawns().length, 1);
  assert.equal(await h.tick(true, NOW + LIVENESS_MS), true);
  assert.equal(m.spawns().length, 2);
  assert.equal(m.files[PID_FILE], "9001\n");
  assert.deepEqual(m.caffeinates(), [9001]);
  assert.deepEqual(m.kills(), []);
});

test("liveness: a live one is only looked at (one ps), every 15 s (D6)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  const before = m.calls.length;
  assert.equal(await h.tick(true, NOW + LIVENESS_MS), true);
  assert.deepEqual(m.calls.slice(before), [["ps", "-p", "9000", "-o", "command="]]);
  assert.equal(await h.tick(true, NOW + LIVENESS_MS + 1_000), true);
  assert.equal(m.calls.length, before + 1);
  assert.equal(await h.tick(true, NOW + 2 * LIVENESS_MS), true);
  assert.equal(m.calls.length, before + 2);
});

test("liveness: when ps can't run, the held one is kept, not respawned", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  m.psRejects = true;
  assert.equal(await h.tick(true, NOW + LIVENESS_MS), true);
  assert.equal(m.spawns().length, 1);
  assert.equal(h.pid, 9000);
});

test("a caffeinate another copy respawned is adopted at the next liveness check (D3, D6)", async () => {
  const m = machine();
  const a = m.holder();
  const b = m.holder();
  await a.tick(true, NOW);
  await b.tick(true, NOW + 500);
  m.procs.delete(9000);
  await a.tick(true, NOW + LIVENESS_MS); // respawns 9001
  assert.equal(await b.tick(true, NOW + 500 + LIVENESS_MS), true);
  assert.equal(b.pid, 9001);
  assert.deepEqual(m.caffeinates(), [9001]);
  assert.equal(m.spawns().length, 2);
});

test("failed start: not retried before 30 s, retried at 30 s (D6)", async () => {
  for (const how of ["spawnFails", "spawnRejects"]) {
    const m = machine();
    m[how] = true;
    const h = m.holder();
    assert.equal(await h.tick(true, NOW), false, how);
    assert.equal(m.spawns().length, 1, how);
    assert.equal(m.files[PID_FILE], undefined, how);
    m[how] = false;
    for (const t of [1_000, 15_000, RETRY_MS - 1]) assert.equal(await h.tick(true, NOW + t), false, how);
    assert.equal(m.spawns().length, 1, how);
    assert.equal(await h.tick(true, NOW + RETRY_MS), true, how);
    assert.equal(m.spawns().length, 2, how);
    assert.equal(m.files[PID_FILE], "9000\n", how);
  }
});

test("Herdr's pid via $PPID: the sh's parent is the app (D2)", async () => {
  const m = machine({ shPpid: HERDR });
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), true);
  assert.equal(h.herdrPid, HERDR);
  assert.deepEqual(m.calls.slice(0, 2), [
    ["/bin/sh", "-c", "echo $PPID"],
    ["ps", "-p", String(HERDR), "-o", "ppid=,comm="],
  ]);
  assert.equal(m.procs.get(9000).command, ours(HERDR));
});

test("Herdr's pid via the ancestor walk: the sh's parent is herdr-core, its parent the app (D2)", async () => {
  const m = machine({ shPpid: CORE });
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), true);
  assert.equal(h.herdrPid, HERDR);
  assert.deepEqual(m.spawns(), [D1_ARGV]);
  // Found once: a respawn doesn't ask again.
  m.procs.delete(9000);
  await h.tick(true, NOW + LIVENESS_MS);
  assert.equal(m.calls.filter((c) => c[1] === "-c" && c[2] === "echo $PPID").length, 1);
});

test("unknown Herdr pid: nothing started, no -w-less caffeinate, retried after 30 s (D2)", async () => {
  for (const shPpid of [ORPHAN_CORE, 1, 31337]) {
    const m = machine({ shPpid });
    const h = m.holder();
    assert.equal(await h.tick(true, NOW), false, String(shPpid));
    assert.deepEqual(m.spawns(), [], String(shPpid));
    assert.equal(m.files[PID_FILE], undefined);
    assert.equal(h.herdrPid, null);
    const asked = m.calls.length;
    assert.equal(await h.tick(true, NOW + RETRY_MS - 1), false);
    assert.equal(m.calls.length, asked, "not asked again before 30 s");
  }
});

test("unknown Herdr pid: even a matching caffeinate in the file isn't adopted (D2)", async () => {
  const m = machine({ shPpid: ORPHAN_CORE, files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  const h = m.holder();
  assert.equal(await h.tick(true, NOW), false);
  assert.equal(h.holding, false);
  assert.deepEqual(m.kills(), []);
});

test("release(): kills what this copy started and clears the file (D7)", async () => {
  const m = machine();
  const h = m.holder();
  await h.tick(true, NOW);
  await h.release();
  assert.deepEqual(m.kills(), [9000]);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(h.holding, false);
  const before = m.calls.length;
  assert.equal(await h.tick(true, NOW + RETRY_MS), false, "a released holder starts nothing");
  assert.equal(m.calls.length, before);
});

test("release(): kills an adopted one; another copy respawns it at its liveness check (D7)", async () => {
  const m = machine();
  const a = m.holder();
  const b = m.holder();
  await a.tick(true, NOW);
  await b.tick(true, NOW);
  await b.release(); // the window that adopted closes
  assert.deepEqual(m.kills(), [9000]);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(await a.tick(true, NOW + LIVENESS_MS), true);
  assert.deepEqual(m.caffeinates(), [9001]);
  assert.equal(m.files[PID_FILE], "9001\n");
});

test("release(): a copy that holds nothing kills nothing and leaves the file (D3, D7)", async () => {
  const m = machine({ files: { [PID_FILE]: "4242\n" }, procs: { 4242: ours() } });
  const h = m.holder();
  await h.tick(false, NOW);
  await h.release();
  assert.deepEqual(m.kills(), []);
  assert.ok(m.procs.has(4242));
  assert.equal(m.files[PID_FILE], "4242\n");
});

test("release(): its caffeinate died and another copy started one: nothing killed, the file kept (D3, D7)", async () => {
  const m = machine();
  const a = m.holder();
  const b = m.holder();
  await a.tick(true, NOW);
  await b.tick(true, NOW + 500);
  m.procs.delete(9000);
  await b.tick(true, NOW + 500 + LIVENESS_MS); // b respawns 9001
  // 9000's pid now belongs to some other program.
  m.procs.set(9000, { ppid: 1, comm: "/usr/bin/vim", command: "/usr/bin/vim notes.txt" });
  await a.release();
  assert.deepEqual(m.kills(), []);
  assert.ok(m.procs.has(9000) && m.procs.has(9001));
  assert.equal(m.files[PID_FILE], "9001\n");
});

test("release() during a start in flight: the one it starts is released too (D7)", async () => {
  const m = machine();
  let open;
  m.spawnGate = new Promise((resolve) => (open = resolve));
  const h = m.holder();
  const ticking = h.tick(true, NOW);
  await new Promise((resolve) => setImmediate(resolve));
  const releasing = h.release();
  open();
  await Promise.all([ticking, releasing]);
  assert.deepEqual(m.caffeinates(), []);
  assert.deepEqual(m.kills(), [9000]);
  assert.equal(m.files[PID_FILE], "");
});

// Every fake call settles in microtasks: one macrotask turn lets them all run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("release() doesn't wait for a start in flight; that start, once it ends, kills what it spawned and clears the file (R3, D7)", async () => {
  const m = machine();
  let open;
  m.spawnGate = new Promise((resolve) => (open = resolve));
  const h = m.holder();
  const ticking = h.tick(true, NOW);
  await settle();
  let released = false;
  h.release().then(() => (released = true));
  await settle();
  assert.equal(released, true, "close() isn't held by the exec in flight");
  assert.deepEqual(m.kills(), []);
  open();
  assert.equal(await ticking, false);
  assert.deepEqual(m.caffeinates(), []);
  assert.deepEqual(m.kills(), [9000]);
  assert.equal(m.files[PID_FILE], "");
  assert.equal(h.holding, false);
});

test("release() while the start's pid-file write is landing: the one the file lists is killed now, and not twice (R3, D3)", async () => {
  const m = machine();
  let open;
  m.writeGate = new Promise((resolve) => (open = resolve));
  const h = m.holder();
  const ticking = h.tick(true, NOW);
  await settle();
  assert.equal(m.files[PID_FILE], "9000\n", "written, its promise not resolved yet");
  assert.equal(h.holding, false);
  let released = false;
  h.release().then(() => (released = true));
  await settle();
  assert.equal(released, true);
  assert.deepEqual(m.kills(), [9000]);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], "");
  open();
  assert.equal(await ticking, false);
  assert.deepEqual(m.kills(), [9000], "the start's own look finds it gone");
  assert.equal(h.holding, false);
});

test("released before its start spawned: the start runs nothing more (R3)", async () => {
  const m = machine();
  let open;
  m.ppidGate = new Promise((resolve) => (open = resolve));
  const h = m.holder();
  const ticking = h.tick(true, NOW);
  await settle();
  let released = false;
  h.release().then(() => (released = true));
  await settle();
  assert.equal(released, true);
  open();
  assert.equal(await ticking, false);
  assert.deepEqual(m.spawns(), []);
  assert.deepEqual(m.caffeinates(), []);
  assert.equal(m.files[PID_FILE], undefined);
});

test("overlapping ticks: one start, not two", async () => {
  const m = machine();
  const h = m.holder();
  const results = await Promise.all([h.tick(true, NOW), h.tick(true, NOW + 1), h.tick(true, NOW + 2)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(m.spawns().length, 1);
  assert.deepEqual(m.caffeinates(), [9000]);
});

test("tick() without `now` reads the injected clock", async () => {
  const m = machine();
  let clock = NOW;
  const h = m.holder({ now: () => clock });
  m.spawnFails = true;
  assert.equal(await h.tick(true), false);
  m.spawnFails = false;
  clock = NOW + RETRY_MS - 1;
  assert.equal(await h.tick(true), false);
  clock = NOW + RETRY_MS;
  assert.equal(await h.tick(true), true);
});
