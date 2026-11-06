// T8 (D11, L20): automatic sleep is off until you turn it on, because
// installing projects-sidebar installs this plugin too. While off it does
// nothing on its own: no stops, no probes, no live records, no restart
// recovery. Sleep now, Wake all and the reveal of a Claude already asleep
// still work: those are things you asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../mods/agent-sleep/store.js";
import { readPrompt } from "../mods/agent-sleep/prompt.js";
import {
  MIN, NOW, SID1, SETTINGS, SLEEPING, SHELL_BARE, SUGGESTION, setup, show, shellOf, exitClaude, storeRecord, records, resumes, exits, at, sleepT1,
} from "./harness.js";

const OFF = { enabled: false, idleMinutes: 30 };

test("the default is off", () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false);
});

test("a fresh install (no settings file): a Claude idle for hours is left alone, nothing typed or written", async () => {
  const { w, co } = setup({ settings: null });
  const last = await sleepT1(co, w);
  await at(co, w, last + 10 * MIN);
  assert.equal(w.sends.length, 0);
  assert.equal(w.keys.length, 0);
  assert.equal(w.files[SLEEPING], undefined, "no live record");
  assert.equal(w.files[SETTINGS], undefined, "turning it on is yours");
  assert.match(co.model().next, /Automatic sleep is off/);
});

test("off: a Claude with a suggestion on its prompt, where the probe would type, gets no key and no send", async () => {
  const { w, co } = setup({ settings: null });
  w.screens.t1 = SUGGESTION;
  w.onKey.t1 = (key, screen) => (key === "x" ? SUGGESTION.replace("reply with the single word ok", "x") : key === "backspace" ? SUGGESTION : screen);
  assert.equal(readPrompt(w.screens.t1, w.core.t1.foreground.name).state, "text", "the state D5 probes");
  const last = await sleepT1(co, w);
  await at(co, w, last + 10 * MIN);
  assert.deepEqual(w.keys, []);
  assert.deepEqual(w.sends, []);
});

test("turned off with a live record left: it is dropped, so a later restart resumes nothing", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(records(w).t1?.state, "live");
  w.files[SETTINGS] = JSON.stringify(OFF);
  await at(co, w, NOW + MIN);
  assert.equal(records(w).t1, undefined);
  w.core.t1 = shellOf({ ...w.core.t1, pid: 300, foreground: { cwd: "/code/app" } });
  w.screens.t1 = SHELL_BARE;
  show(w, "back");
  await at(co, w, NOW + 2 * MIN);
  await at(co, w, NOW + 3 * MIN);
  assert.equal(w.sends.length, 0);
});

test("off: Sleep now still stops a Claude, and showing its tab wakes it", async () => {
  const { w, co } = setup({ settings: OFF });
  await at(co, w, NOW);
  co.requestSleepNow();
  await at(co, w, NOW + 1_000);
  assert.equal(exits(w).length, 1);
  exitClaude(w, "t1");
  await at(co, w, NOW + 2_000);
  assert.equal(records(w).t1?.state, "asleep");
  show(w, "back");
  await at(co, w, NOW + 3_000);
  assert.deepEqual(resumes(w).map((s) => s.text), [`CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume ${SID1}`]);
});

test("off: a Claude already asleep keeps its record and still wakes when shown", async () => {
  const { w, co } = setup({ settings: OFF });
  exitClaude(w, "t1", SHELL_BARE);
  storeRecord(w, "t1");
  await at(co, w, NOW);
  assert.equal(records(w).t1?.state, "asleep");
  show(w, "back");
  await at(co, w, NOW + 1_000);
  assert.equal(resumes(w).length, 1);
});

test("off: Wake all resumes a Claude asleep in a hidden tab, exactly once", async () => {
  const { w, co } = setup({ settings: OFF });
  exitClaude(w, "t1", SHELL_BARE);
  storeRecord(w, "t1");
  await at(co, w, NOW);
  assert.equal(resumes(w).length, 0, "hidden, and nobody asked yet");
  co.requestWakeAll();
  await at(co, w, NOW + 1_000);
  await at(co, w, NOW + 2_000);
  await at(co, w, NOW + MIN);
  assert.deepEqual(resumes(w).map((s) => s.text), [`CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume ${SID1}`]);
  assert.equal(records(w).t1, undefined);
});

test("turned on from the popup: live records start and the next one due shows", async () => {
  const { w, co } = setup({ settings: null });
  await at(co, w, NOW);
  assert.equal(w.files[SLEEPING], undefined);
  co.requestSettings({ enabled: true });
  await at(co, w, NOW + 1_000);
  assert.deepEqual(JSON.parse(w.files[SETTINGS]), { enabled: true, idleMinutes: 30 });
  await at(co, w, NOW + MIN);
  assert.equal(records(w).t1?.state, "live");
  assert.match(co.model().next, /^Next: app in /);
});
