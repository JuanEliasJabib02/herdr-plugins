// T7: restart recovery (S10, D13). Every tick the coordinator keeps a `live`
// record for each running Claude that could come back. When Core loses a
// kept terminal's program (core crash, reboot, logout, `hc server stop`) the
// shell comes back on the same address with a NEW root pid: that Claude is
// put back to sleep as `by: "restart"` and resumes when its tab is shown,
// exactly once. `hc server restart` keeps programs running: nothing happens.
// A Claude you ended yourself (shell back, same root pid) just drops its
// record. Core states follow T0's fixtures (core-after-*.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIN, NOW, SID1, SHELL_BARE, EMPTY, setup, show, shellOf, exitClaude, records, resumes, exits, at,
} from "./harness.js";

const core = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const SERVER_STOP = core("core-after-server-stop.json");
const HOLDER_LOST = core("core-after-holder-lost.json");

// One tick with t1 hidden and running: its live record is written.
async function withLiveRecord() {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(records(w).t1?.state, "live");
  assert.equal(records(w).t1.rootPid, 100);
  return { w, co };
}

// Right after `hc server stop` + start, as T0 saw it: no foreground, no root
// pid yet, `reason: "stopped_by_restart"`.
function serverStopped(w, address) {
  const { reason, foreground, status, turn } = SERVER_STOP;
  const { pid, ...rest } = w.core[address];
  w.core[address] = { ...rest, reason, foreground, status, status_ms: null, turn };
  w.screens[address] = "";
}

// A few seconds later (or after a holder loss): the kept terminal's shell
// is back, with a new root pid and `reason: null`.
function shellBackWithNewPid(w, address, pid) {
  const { argv, reason } = HOLDER_LOST;
  const t = shellOf({ ...w.core[address], pid, foreground: { cwd: "/code/app" } }, { argv, reason });
  w.core[address] = t;
  w.screens[address] = SHELL_BARE;
}

test("lost in `hc server stop` (T0's fixture) + live record → asleep by restart, resumed once when shown", async () => {
  const { w, co } = await withLiveRecord();

  serverStopped(w, "t1");
  await at(co, w, NOW + MIN);
  assert.equal(records(w).t1?.state, "live", "the in-between state decides nothing");
  assert.equal(w.sends.length, 0);

  shellBackWithNewPid(w, "t1", 300);
  w.holder = "h2";
  await at(co, w, NOW + 2 * MIN);
  assert.equal(records(w).t1?.state, "asleep");
  assert.equal(records(w).t1.by, "restart");
  assert.equal(w.sends.length, 0, "hidden: nothing typed yet");
  assert.ok(w.shared["badges.hibernate"]?.["/code/app"], "the moon shows for it");

  show(w, "back");
  await at(co, w, NOW + 2 * MIN + 1000);
  await at(co, w, NOW + 2 * MIN + 2000);
  await at(co, w, NOW + 3 * MIN);
  assert.deepEqual(resumes(w).map((s) => s.text), [`claude --dangerously-skip-permissions --resume ${SID1}`]);
  assert.equal(records(w).t1, undefined, "claimed: never resumed twice");
  assert.match(w.notes.at(-1)?.title ?? "", /after a restart/);
});

test("lost with the holder (T0's holder-kill fixture) while its tab is shown → resumed at once", async () => {
  const { w, co } = await withLiveRecord();
  show(w, "back");
  await at(co, w, NOW + 1000);
  assert.equal(w.sends.length, 0, "a running Claude is never typed into");

  shellBackWithNewPid(w, "t1", 92734);
  w.holder = "h2";
  await at(co, w, NOW + MIN);
  await at(co, w, NOW + MIN + 1000);
  assert.equal(resumes(w).length, 1);
  assert.equal(resumes(w)[0].address, "t1");
});

test("`hc server restart` keeps programs running → nothing: no send, the live record untouched", async () => {
  const { w, co } = await withLiveRecord();
  const before = JSON.stringify(records(w).t1);
  const writes = w.writes.length;
  w.holder = "h2"; // a new holder, same Claude, same root pid
  show(w, "back");
  await at(co, w, NOW + MIN);
  await at(co, w, NOW + 2 * MIN);
  assert.equal(w.sends.length, 0);
  assert.equal(JSON.stringify(records(w).t1), before);
  assert.equal(w.writes.length, writes, "no write when nothing changed");
});

test("you ended Claude yourself (shell back, same root pid) → record dropped, nothing sent even when shown", async () => {
  const { w, co } = await withLiveRecord();
  exitClaude(w, "t1");
  await at(co, w, NOW + MIN);
  assert.equal(records(w).t1, undefined);
  show(w, "back");
  await at(co, w, NOW + 2 * MIN);
  await at(co, w, NOW + 3 * MIN);
  assert.equal(w.sends.length, 0);
});

test("a live record with no root pid is never taken for a lost terminal (fail closed)", async () => {
  const { w, co } = await withLiveRecord();
  const file = JSON.parse(w.files[Object.keys(w.files).find((p) => p.endsWith("sleeping.json"))]);
  file.records.t1.rootPid = null;
  const path = Object.keys(w.files).find((p) => p.endsWith("sleeping.json"));
  w.files[path] = `${JSON.stringify(file, null, 2)}\n`;
  co.records = file.records;
  shellBackWithNewPid(w, "t1", 300);
  show(w, "back");
  await at(co, w, NOW + MIN);
  await at(co, w, NOW + 2 * MIN);
  assert.equal(w.sends.length, 0);
});

test("after the loss you started another program in front → not resumed, the record dropped on reveal", async () => {
  const { w, co } = await withLiveRecord();
  shellBackWithNewPid(w, "t1", 300);
  await at(co, w, NOW + MIN);
  assert.equal(records(w).t1?.by, "restart");
  w.core.t1 = { ...w.core.t1, foreground: { argv: ["vim"], cwd: "/code/app", name: "vim", pid: 301 } };
  w.screens.t1 = EMPTY;
  show(w, "back");
  await at(co, w, NOW + 2 * MIN);
  assert.equal(w.sends.length, 0);
  assert.equal(records(w).t1, undefined);
});

test("a Claude put to sleep normally is not mistaken for a restart", async () => {
  const { w, co } = await withLiveRecord();
  await at(co, w, NOW + 30 * MIN);
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 1);
  exitClaude(w, "t1");
  await at(co, w, NOW + 31 * MIN + 13_000);
  assert.equal(records(w).t1?.state, "asleep");
  assert.equal(records(w).t1.by, "auto");
});
