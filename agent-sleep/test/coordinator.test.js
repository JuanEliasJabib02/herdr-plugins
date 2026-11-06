// T5: the coordinator (A/coordinator.js). It runs the loop of the one copy
// with no props().view or overlay: a pulse every second, a tick every
// minute (D2), the stop sequence (re-plan, D5's prompt check and probe, the
// `stopping` record, D4's re-read, /exit), reconcile, live records (D13),
// the resume on reveal (D8), "Sleep now" / "Wake all" (D9), the block's
// lines and the moon badge (D11). Everything it touches is injected here:
// a fake Core (`hc`), exec, files, clock and Herdr's live data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  Coordinator, MOD, PULSE_MS, SETTLE_MS, isLoopCopy, startLoop, blockModel, stepMinutes, windowLabel, isClaudeCodeTerminal,
} from "../mods/agent-sleep/coordinator.js";
import { TICK_MS } from "../mods/agent-sleep/rules.js";
import { BADGE_KEY } from "../mods/agent-sleep/badges.js";

import {
  fixture, MIN, NOW, HOME, APP, SLEEPING, SETTINGS, SID1, SID2, NVM_CLAUDE, PROC_START, EMPTY, SUGGESTION, DRAFT, EXIT, SHELL_BARE, SHELL_TYPED, claude, shellOf, ok, fail, makeWorld, addClaude, putSession, exitClaude, show, liveTerminals, deps, records, exits, resumes, at, sleepT1, setup, storeRecord,
} from "./harness.js";

// ── Which copy runs the loop (D11) ────────────────────────────────────────

test("only the copy with no view and no overlay runs the loop; an overlay copy starts no timer", () => {
  const timer = () => {
    const t = { every: [], after: [] };
    return { t, api: { every: (ms, fn) => t.every.push(ms), after: (ms, fn) => t.after.push(ms) } };
  };
  for (const props of [{ overlay: "o1" }, { view: "settings" }, { view: "settings", overlay: "o2" }]) {
    const { t, api } = timer();
    assert.equal(isLoopCopy(props), false, JSON.stringify(props));
    assert.equal(startLoop(props, api, () => {}), false);
    assert.deepEqual(t, { every: [], after: [] }, JSON.stringify(props));
  }
  for (const props of [{}, null, undefined]) {
    const { t, api } = timer();
    assert.equal(isLoopCopy(props), true);
    assert.equal(startLoop(props, api, () => {}), true);
    assert.deepEqual(t.every, [PULSE_MS]);
  }
  assert.equal(MOD, "agent-sleep");
});

// ── The automatic loop (S1, S2, S4) ───────────────────────────────────────

test("a hidden Claude idle for 30 min is stopped on the second identical tick, never before (S4)", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 29 * MIN);
  await at(co, w, NOW + 30 * MIN);
  assert.equal(exits(w).length, 0, "a candidate needs a second tick");
  await at(co, w, NOW + 31 * MIN);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  assert.deepEqual(exits(w)[0].opts, [], "Core says done: no --if idle");
  const r = records(w).t1;
  assert.equal(r.state, "stopping");
  assert.equal(r.sessionId, SID1);
  assert.equal(r.cwd, "/code/app");
  assert.deepEqual(r.flags, ["--dangerously-skip-permissions"]);
  assert.equal(r.workspacePath, "/code/app");
  assert.equal(r.rssKb, 307_200);
  assert.equal(r.rootPid, 100);
  assert.equal(r.holder, "h1");
  assert.equal(r.by, "auto");
});

test("Core idle (not done) → /exit goes with --if idle (D4)", async () => {
  const { w, co } = setup();
  w.core.t1.status = { app: "claude-code", state: "idle" };
  await sleepT1(co, w);
  assert.deepEqual(exits(w).map((s) => s.opts), [["--if", "idle"]]);
});

test("a visible Claude is never stopped, automatic or manual", async () => {
  const { w, co } = setup();
  show(w, "back");
  for (let m = 0; m <= 120; m += 30) await at(co, w, NOW + m * MIN);
  co.requestSleepNow();
  await at(co, w, NOW + 121 * MIN);
  assert.equal(exits(w).length, 0);
  assert.deepEqual(w.keys, []);
});

test("a visit restarts the idle clock and the confirmation (D6)", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN); // candidate
  w.now = NOW + 30 * MIN + 20_000;
  show(w, "back");
  co.observeNow(); // a render while it's shown
  w.now = NOW + 30 * MIN + 30_000;
  show(w, "front");
  co.observeNow(); // the visit ends
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0, "idle starts again at the end of the visit");
  await at(co, w, NOW + 60 * MIN + 30_000); // a candidate again, 30 min after the leave
  assert.equal(exits(w).length, 0);
  await at(co, w, NOW + 61 * MIN + 30_000);
  assert.equal(exits(w).length, 1);
});

test("a status or screen change between ticks blocks the stop until two identical ticks", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  w.screens.t1 = EMPTY.replace("Churned for 11s", "Churned for 12s");
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0, "screen changed");
  w.core.t1.turn = 4;
  await at(co, w, NOW + 32 * MIN);
  assert.equal(exits(w).length, 0, "turn changed");
  await at(co, w, NOW + 33 * MIN);
  assert.equal(exits(w).length, 1);
});

test("the stop plans again right before /exit: Claude started working → no stop", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  let reads = 0;
  w.onRead = (address) => {
    // The tick's read happens, then the person asks Claude something.
    if (address === "t1" && ++reads === 1) w.core.t1.status = { app: "claude-code", state: "working" };
  };
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0);
  assert.notEqual(records(w).t1?.state, "stopping");
});

test("the stop plans again right before /exit: the screen changed → no stop", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  let reads = 0;
  w.onRead = (address, w) => {
    if (address === "t1" && ++reads === 2) w.screens.t1 = EMPTY.replace("⏺ ok", "⏺ ok!");
  };
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0);
});

test("the tab shown right before /exit (after the record) → no stop, the previous record back", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  const before = records(w).t1;
  assert.equal(before.state, "live");
  w.onSend = () => assert.fail("nothing is sent");
  const orig = w.core.t1;
  Object.defineProperty(w.core, "t1", {
    configurable: true,
    enumerable: true,
    get() {
      // D4's re-read is the first look at t1 once the record says stopping.
      if (records(w).t1?.state === "stopping") show(w, "back");
      return orig;
    },
  });
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0);
  assert.deepEqual(records(w).t1, before);
});

test("D4: the session file no longer idle → no /exit and the record goes back", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  w.onRead = (address, w) => putSession(w, 200, { sessionId: SID1, status: "busy" });
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 0);
  assert.equal(records(w).t1.state, "live");
});

test("never two stops at once: the second waits until the first is asleep", async () => {
  const { w, co } = setup({ t2: true });
  const t = await sleepT1(co, w);
  assert.equal(exits(w).length, 1, "one /exit on the confirming tick");
  const first = exits(w)[0].address;
  const second = first === "t1" ? "t2" : "t1";
  await at(co, w, t + 1 * MIN);
  await at(co, w, t + 2 * MIN);
  assert.equal(exits(w).length, 1, "the other waits while one is stopping");
  exitClaude(w, first);
  await at(co, w, t + 3 * MIN); // the tick sees the first asleep, then stops the second
  assert.equal(records(w)[first].state, "asleep");
  assert.deepEqual(exits(w).map((s) => s.address), [first, second]);
});

test("the exit at 12 s: the record becomes asleep on the next pulse, not on the next tick (D4)", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  await at(co, w, t + 5_000);
  assert.equal(records(w).t1.state, "stopping");
  exitClaude(w, "t1");
  await at(co, w, t + 12_000);
  const r = records(w).t1;
  assert.equal(r.state, "asleep");
  assert.equal(r.sessionId, SID1);
  assert.equal(SETTLE_MS >= 12_000, true);
});

test("an exit later than the settle window is still picked up by the next tick", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  exitClaude(w, "t1");
  await at(co, w, t + SETTLE_MS + 5_000);
  assert.equal(records(w).t1.state, "stopping", "between ticks only young stops are polled");
  await at(co, w, t + TICK_MS);
  assert.equal(records(w).t1.state, "asleep");
});

test("a stop Claude never finished is dropped after one window and parked (failed-until)", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  await at(co, w, t + 30 * MIN);
  assert.equal(records(w).t1.state, "live", "the stop is dropped; the running Claude keeps a live record");
  await at(co, w, t + 31 * MIN);
  await at(co, w, t + 32 * MIN);
  assert.equal(exits(w).length, 1, "parked for one window");
});

test("after /clear the id under 'Resume this session with:' wins", async () => {
  const { w, co } = setup();
  putSession(w, 200, { sessionId: SID2 });
  w.transcripts.add(SID2);
  const t = await sleepT1(co, w);
  assert.equal(records(w).t1.sessionId, SID2);
  exitClaude(w, "t1"); // prints SID1
  await at(co, w, t + 3_000);
  assert.equal(records(w).t1.sessionId, SID1);
});

test("a hot reload mid-stop is reconciled at start", async () => {
  const { w } = setup();
  storeRecord(w, "t1", { state: "stopping", at: NOW - 20_000 });
  exitClaude(w, "t1");
  const co = new Coordinator(deps(w));
  await at(co, w, NOW);
  assert.equal(records(w).t1.state, "asleep");
});

test("terminals() empty (Core not there yet): every record is kept, nothing is decided (fail closed)", async () => {
  const { w, co } = setup({ t1: false });
  delete w.core.t9;
  storeRecord(w, "t1");
  storeRecord(w, "t2", { state: "stopping", sessionId: SID2, at: NOW - 40 * MIN });
  await at(co, w, NOW);
  await at(co, w, NOW + 1_000);
  await at(co, w, NOW + 1 * MIN);
  assert.equal(records(w).t1.state, "asleep");
  assert.equal(records(w).t2.state, "stopping");
  assert.equal(w.sends.length, 0);
});

test("a glimpse at the tab while a tick reads its screen still restarts the idle clock (D6)", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  let reads = 0;
  w.onRead = (address, w) => {
    if (address !== "t1" || ++reads !== 1) return;
    // A render while the tick awaits `hc read`: shown, then left.
    show(w, "back");
    co.observeNow();
    show(w, "front");
    co.observeNow();
  };
  await at(co, w, NOW + 30 * MIN);
  await at(co, w, NOW + 31 * MIN);
  await at(co, w, NOW + 32 * MIN);
  assert.equal(exits(w).length, 0, "idle starts again at the glimpse");
});

// ── D5: Claude's prompt line ──────────────────────────────────────────────

test("a prompt suggestion: the probe types x, sees `❯ x`, erases it and sleeps", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  // T0: a backspace brings the suggestion back.
  w.onKey.t1 = (key, screen) => (key === "x" ? SUGGESTION.replace("reply with the single word ok", "x") : key === "backspace" ? SUGGESTION : screen);
  await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"]);
  assert.equal(exits(w).length, 1);
});

// J-001: /exit goes only into a prompt line the probe left as it found it,
// never after its own `x` (Claude would get `x/exit` as a prompt).
const PROBED = SUGGESTION.replace("reply with the single word ok", "x");

test("the probe's backspace fails: no /exit, and the x is never typed again while Claude stays the same", async () => {
  const { w } = setup();
  const d = deps(w);
  const hc = d.hc;
  let erases = 0;
  d.hc = async (args) => {
    if (args[0] === "keys" && args[2] === "backspace") {
      erases += 1;
      return fail("keys failed");
    }
    return hc(args);
  };
  const co = new Coordinator(d);
  w.screens.t1 = SUGGESTION;
  w.onKey.t1 = (key, screen) => (key === "x" ? PROBED : screen);
  const t = await sleepT1(co, w);
  assert.equal(erases, 1, "the backspace was tried");
  assert.equal(exits(w).length, 0);
  for (let m = 1; m <= 5; m++) await at(co, w, t + m * MIN);
  assert.deepEqual(w.keys.map((k) => k.key), ["x"]);
  assert.equal(exits(w).length, 0);
});

test("the probe's backspace 'succeeds' but the x is still on screen: no /exit", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  w.onKey.t1 = (key, screen) => (key === "x" ? PROBED : screen); // the backspace changes nothing
  const t = await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"]);
  assert.equal(exits(w).length, 0);
  for (let m = 1; m <= 5; m++) await at(co, w, t + m * MIN);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"], "not probed again while Claude stays the same");
  assert.equal(exits(w).length, 0);
});

test("the prompt line back a moment after the backspace (Claude redrawing): read again, then it sleeps", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  let reads = 0;
  w.onKey.t1 = (key, screen) => {
    if (key === "backspace") reads = 0;
    return key === "x" ? PROBED : screen;
  };
  w.onRead = (address, w) => {
    if (address === "t1" && w.keys.at(-1)?.key === "backspace" && ++reads === 3) w.screens.t1 = SUGGESTION;
  };
  await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"]);
  assert.equal(exits(w).length, 1);
});

// J-002: the probe's own `x` changes the screen, so a refusal after a probe
// waits for Claude itself to change (status, status_ms, turn, session).
test("a probe it couldn't read is not repeated though its x changed the screen; a new turn lifts the refusal", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  let reads = 0;
  w.onKey.t1 = (key, screen) => {
    if (key !== "x") return screen;
    reads = 0;
    return undefined; // the read right after the x fails
  };
  w.onRead = (address, w) => {
    if (address === "t1" && w.screens.t1 === undefined && ++reads > 1) w.screens.t1 = PROBED;
  };
  const t = await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x"], "no backspace: the x was never seen");
  assert.equal(exits(w).length, 0);
  for (let m = 1; m <= 5; m++) await at(co, w, t + m * MIN);
  assert.equal(w.screens.t1, PROBED, "the screen differs from the one the probe started on");
  assert.deepEqual(w.keys.map((k) => k.key), ["x"], "no second x");
  assert.equal(exits(w).length, 0);
  w.core.t1.turn = 4; // Claude ran another turn
  w.screens.t1 = EMPTY;
  await at(co, w, t + 6 * MIN);
  await at(co, w, t + 7 * MIN);
  assert.equal(exits(w).length, 1, "a new turn lifts the refusal");
});

test("a draft: the probe sees `❯ holax`, erases the x, never sleeps and never probes it again", async () => {
  const { w, co } = setup();
  w.screens.t1 = DRAFT;
  w.onKey.t1 = (key, screen) => (key === "x" ? DRAFT.replace("hola", "holax") : key === "backspace" ? DRAFT : screen);
  const t = await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"]);
  for (let m = 1; m <= 5; m++) await at(co, w, t + m * MIN);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"], "not probed again while nothing changed");
  assert.equal(exits(w).length, 0);
});

test("a probe it can't read: no sleep, and no backspace when the x isn't on screen", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  w.onKey.t1 = (key, screen) => (key === "x" ? fixture("claude-trust-dialog.txt") : screen);
  await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x"]);
  assert.equal(exits(w).length, 0);
});

test("the tab shown during the probe → no sleep (the x is still erased)", async () => {
  const { w, co } = setup();
  w.screens.t1 = SUGGESTION;
  w.onKey.t1 = (key, screen) => {
    if (key === "x") {
      show(w, "back");
      return SUGGESTION.replace("reply with the single word ok", "x");
    }
    return EMPTY;
  };
  await sleepT1(co, w);
  assert.deepEqual(w.keys.map((k) => k.key), ["x", "backspace"]);
  assert.equal(exits(w).length, 0);
});

// ── Resumability before every stop (T2, D8) ───────────────────────────────

test("a Claude that couldn't come back is never stopped: refused flag, unsupported shell", async () => {
  for (const over of [{ flags: ["--agent-id", "x"] }, { argv: ["/usr/bin/nu"] }]) {
    const w = makeWorld();
    addClaude(w, "t1", { pid: 100, fgPid: 200, sid: SID1, ...over });
    const co = new Coordinator(deps(w));
    await sleepT1(co, w);
    co.requestSleepNow();
    await at(co, w, NOW + 32 * MIN);
    assert.equal(exits(w).length, 0, JSON.stringify(over));
    assert.equal(records(w).t1, undefined, "no live record either");
    assert.ok(!w.calls.some((c) => c[0] === "read" || c[0] === "keys"), "its screen is never read, nothing typed");
    assert.equal(co.model().next, null, "and it is never announced as Next");
  }
});

test("a session file without a cwd: never stopped", async () => {
  const { w, co } = setup();
  w.files[`${HOME}/.claude/sessions/200.json`] = JSON.stringify({ pid: 200, sessionId: SID1, procStart: PROC_START, kind: "interactive", status: "idle" });
  await sleepT1(co, w);
  assert.equal(exits(w).length, 0);
});

// ── Live records (D13) ────────────────────────────────────────────────────

test("a running Claude gets a live record once; it is rewritten only when it changes", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  const r = records(w).t1;
  assert.deepEqual({ ...r, at: undefined }, {
    state: "live", sessionId: SID1, cwd: "/code/app", flags: ["--dangerously-skip-permissions"],
    workspacePath: "/code/app", rssKb: null, rootPid: 100, holder: "h1", at: undefined, by: "auto",
  });
  const writes = w.writes.length;
  await at(co, w, NOW + 1 * MIN);
  assert.equal(w.writes.length, writes, "unchanged: no write");
  putSession(w, 200, { sessionId: SID2 }); // /clear
  w.transcripts.add(SID2);
  await at(co, w, NOW + 2 * MIN);
  assert.equal(records(w).t1.sessionId, SID2);
});

test("a Claude you ended yourself (shell back, same root pid) drops its live record", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(records(w).t1.state, "live");
  exitClaude(w, "t1");
  await at(co, w, NOW + 1 * MIN);
  assert.equal(records(w).t1, undefined);
  assert.equal(resumes(w).length, 0);
});

// ── Resume on reveal (D8, S6) ─────────────────────────────────────────────

test("an asleep Claude resumes exactly once when its tab is shown, with the toast", async () => {
  const { w, co } = setup();
  storeRecord(w, "t1");
  exitClaude(w, "t1");
  await at(co, w, NOW);
  assert.equal(resumes(w).length, 0, "hidden: stays asleep");
  show(w, "back");
  await at(co, w, NOW + 1_000);
  await at(co, w, NOW + 2_000);
  await at(co, w, NOW + 1 * MIN);
  assert.deepEqual(resumes(w), [{ address: "t1", text: `claude --dangerously-skip-permissions --resume ${SID1}`, opts: [] }]);
  assert.equal(records(w).t1, undefined);
  assert.deepEqual(w.notes, [{ title: "Resuming app", body: "Session 00000000 · same flags as before" }]);
  assert.equal(co.model().last, "Woke app");
});

test("the resume cds into the session's folder when the shell sits elsewhere", async () => {
  const { w, co } = setup();
  storeRecord(w, "t1", { cwd: "/code/it's here" });
  exitClaude(w, "t1");
  show(w, "back");
  await at(co, w, NOW);
  assert.equal(resumes(w)[0].text, `cd '/code/it'"'"'s here' && claude --dangerously-skip-permissions --resume ${SID1}`);
});

test("revealed while stopping: kept, then resumed once when the shell is back, without leaving the tab", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  show(w, "back");
  await at(co, w, t + 2_000);
  await at(co, w, t + 4_000);
  assert.equal(resumes(w).length, 0);
  assert.equal(records(w).t1.state, "stopping");
  exitClaude(w, "t1");
  await at(co, w, t + 6_000);
  await at(co, w, t + 7_000);
  await at(co, w, t + 1 * MIN);
  assert.equal(resumes(w).length, 1);
  assert.equal(resumes(w)[0].text, `claude --dangerously-skip-permissions --resume ${SID1}`);
});

test("revealing a running Claude: its live record untouched, nothing sent or written", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  const before = w.files[SLEEPING];
  const writes = w.writes.length;
  show(w, "back");
  await at(co, w, NOW + 1_000);
  await at(co, w, NOW + 1 * MIN);
  assert.equal(w.files[SLEEPING], before);
  assert.equal(w.writes.length, writes);
  assert.equal(w.sends.length, 0);
});

test("revealed with another program in front: the record is dropped (you took over), nothing sent", async () => {
  const { w, co } = setup();
  storeRecord(w, "t1");
  w.core.t1 = { ...shellOf(w.core.t1), foreground: { argv: ["vim"], cwd: "/code/app", name: "vim", pid: 300 } };
  show(w, "back");
  await at(co, w, NOW);
  assert.equal(records(w).t1, undefined);
  assert.equal(w.sends.length, 0);
});

test("revealed with a typed shell line: nothing sent, still asleep; sent once the line is bare", async () => {
  const { w, co } = setup();
  storeRecord(w, "t1");
  exitClaude(w, "t1", SHELL_TYPED);
  show(w, "back");
  await at(co, w, NOW);
  await at(co, w, NOW + 5_000);
  assert.equal(w.sends.length, 0);
  assert.equal(records(w).t1.state, "asleep");
  w.screens.t1 = SHELL_BARE;
  await at(co, w, NOW + 10_000);
  assert.equal(resumes(w).length, 1);
});

test("an asleep record whose terminal is gone is dropped", async () => {
  const { w, co } = setup({ t1: false });
  storeRecord(w, "t1");
  await at(co, w, NOW);
  assert.equal(records(w).t1, undefined);
  assert.equal(w.sends.length, 0);
});

// ── CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 (Log L10) ────────────────────────

test("an exit hint with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 is stored as env and replayed", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  exitClaude(w, "t1", EXIT.replace(`claude --resume ${SID1}`, `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${SID1}`));
  await at(co, w, t + 3_000);
  assert.equal(records(w).t1.env, "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1");
  show(w, "back");
  await at(co, w, t + 4_000);
  assert.equal(resumes(w)[0].text, `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --dangerously-skip-permissions --resume ${SID1}`);
});

test("any other env in the hint: kept asleep, never resumed without it, and the block says why", async () => {
  for (const env of ["FOO=1", "FOO=bar"]) {
    const { w, co } = setup();
    const t = await sleepT1(co, w);
    exitClaude(w, "t1", EXIT.replace(`claude --resume ${SID1}`, `${env} claude --resume ${SID1}`));
    await at(co, w, t + 3_000);
    show(w, "back");
    await at(co, w, t + 4_000);
    await at(co, w, t + 1 * MIN);
    assert.equal(resumes(w).length, 0, env);
    assert.equal(records(w).t1.state, "asleep", env);
    assert.ok(co.model().holds.some((h) => h.includes(env)), `${env}: ${JSON.stringify(co.model().holds)}`);
  }
});

// J-003: the hold lives in the record, so it outlasts the hint on screen
// and a reload of the mod.
test("an env the resume can't replay (FOO=bar) is stored; hint gone + a reload → still never resumed, the block says why", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  exitClaude(w, "t1", EXIT.replace(`claude --resume ${SID1}`, `FOO=bar claude --resume ${SID1}`));
  await at(co, w, t + 3_000);
  assert.equal(records(w).t1.state, "asleep");
  assert.equal(records(w).t1.env, "FOO=bar");
  w.screens.t1 = SHELL_BARE; // the hint left the screen (`clear`, scrollback)
  const fresh = new Coordinator(deps(w)); // a reload
  show(w, "back");
  await at(fresh, w, t + 4_000);
  await at(fresh, w, t + 1 * MIN);
  await at(fresh, w, t + 2 * MIN);
  assert.equal(resumes(w).length, 0);
  assert.equal(records(w).t1.state, "asleep");
  assert.deepEqual(fresh.model().holds, ["app stays asleep: Claude asked for FOO=bar"]);
});

// ── Sleep now / Wake all (D9) ─────────────────────────────────────────────

test("Sleep now skips the idle window and the confirmation, one Claude at a time", async () => {
  const { w, co } = setup({ t2: true });
  co.requestSleepNow();
  await at(co, w, NOW);
  assert.equal(exits(w).length, 1);
  const first = exits(w)[0].address;
  assert.equal(records(w)[first].by, "manual");
  await at(co, w, NOW + 2_000);
  assert.equal(exits(w).length, 1, "the second waits for the first");
  exitClaude(w, first);
  await at(co, w, NOW + 4_000);
  await at(co, w, NOW + 5_000);
  assert.equal(exits(w).length, 2);
});

test("Sleep now still runs D5's guard: a draft never sleeps", async () => {
  const { w, co } = setup();
  w.screens.t1 = DRAFT;
  w.onKey.t1 = (key, screen) => (key === "x" ? DRAFT.replace("hola", "holax") : DRAFT);
  co.requestSleepNow();
  await at(co, w, NOW);
  assert.equal(exits(w).length, 0);
});

test("Wake all resumes every asleep Claude whose shell is at a bare prompt, shown or not", async () => {
  const { w, co } = setup({ t2: true });
  storeRecord(w, "t1");
  storeRecord(w, "t2", { sessionId: SID2, cwd: "/code/checkout-flow", workspacePath: "/code/checkout-flow", rootPid: 101 });
  exitClaude(w, "t1");
  exitClaude(w, "t2", SHELL_TYPED);
  co.requestWakeAll();
  await at(co, w, NOW);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"]);
  assert.equal(records(w).t2.state, "asleep");
});

// ── Terminal fields (the T5 probe: hc ls --json is a summary) ─────────────

test("summary-shaped terminals(): Claude terminals are completed with hc get, and the block says so", async () => {
  const { w, co } = setup();
  w.summary = true;
  await at(co, w, NOW);
  await at(co, w, NOW + 30 * MIN);
  assert.ok(w.calls.some((c) => c[0] === "get" && c[1] === "t1"));
  assert.ok(!w.calls.some((c) => c[0] === "get" && c[1] === "t9"), "the shell isn't fetched on ticks");
  assert.match(co.model().debug, /^fields: hc get ×1 /);
  await at(co, w, NOW + 31 * MIN);
  assert.equal(exits(w).length, 1);
});

test("full terminals(): no hc get on ticks, and the block says terminals()", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  await at(co, w, NOW + 1 * MIN);
  assert.ok(!w.calls.some((c) => c[0] === "get"));
  assert.equal(co.model().debug, "fields: terminals()");
});

test("summary shape: the child check before a stop asks Core for every terminal's parent", async () => {
  const { w, co } = setup();
  w.summary = true;
  w.core.t5 = shellOf(claude("t5", { pid: 500, fgPid: 500 }), { parent: "t1" });
  w.screens.t5 = SHELL_BARE;
  await sleepT1(co, w);
  assert.equal(exits(w).length, 0, "t1 has a live child");
});

// ── The block and the badge (S6, D11) ────────────────────────────────────

const asleep = (over = {}) => ({ state: "asleep", rssKb: 317_440, workspacePath: "/code/app", cwd: "/code/app", at: NOW, ...over });

test("block lines for 0, 1 and 2 asleep", () => {
  const base = { now: NOW, settings: { enabled: true, idleMinutes: 30 }, due: {}, labels: {}, lastEvent: null, holds: {}, fields: null };
  assert.equal(blockModel({ ...base, records: {} }).headline, "Agent sleep · nothing asleep");
  assert.equal(blockModel({ ...base, records: { t1: asleep() } }).headline, "Agent sleep · 1 asleep · ~310 MB freed");
  const two = { t1: asleep(), t2: asleep({ rssKb: 317_440 }), t3: { ...asleep(), state: "live" }, t4: { ...asleep(), state: "stopping" } };
  assert.equal(blockModel({ ...base, records: two }).headline, "Agent sleep · 2 asleep · ~620 MB freed");
  assert.equal(blockModel({ ...base, records: { t1: asleep({ rssKb: null }) } }).headline, "Agent sleep · 1 asleep");
});

test("block: Next names the earliest due workspace in whole minutes; off when automatic sleep is off", () => {
  const base = { now: NOW, records: {}, settings: { enabled: true, idleMinutes: 30 }, lastEvent: "Woke checkout-flow", holds: {}, fields: "terminals()" };
  const m = blockModel({ ...base, due: { t1: NOW + 30 * MIN, t2: NOW + 12 * MIN + 1 }, labels: { t1: "app", t2: "checkout-flow" } });
  assert.equal(m.next, "Next: checkout-flow in 13 min");
  assert.equal(m.last, "Woke checkout-flow");
  assert.equal(m.debug, "fields: terminals()");
  assert.equal(blockModel({ ...base, due: {}, labels: {} }).next, null);
  assert.equal(blockModel({ ...base, due: { t1: NOW - 5 }, labels: {} }).next, "Next: t1 in 1 min");
  assert.equal(blockModel({ ...base, settings: { enabled: false, idleMinutes: 30 }, due: { t1: NOW + MIN }, labels: {} }).next, "Automatic sleep is off");
});

test("the coordinator's block: Next after the first tick, then asleep with MB freed", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(co.model().next, "Next: app in 30 min");
  const t = await sleepT1(co, w);
  assert.equal(co.model().last, "Putting app to sleep");
  exitClaude(w, "t1");
  await at(co, w, t + 3_000);
  assert.equal(co.model().headline, "Agent sleep · 1 asleep · ~300 MB freed");
  assert.equal(co.model().last, "Slept app");
});

test("the moon badge is published only when it changes", async () => {
  const { w, co } = setup();
  storeRecord(w, "t1");
  exitClaude(w, "t1");
  await at(co, w, NOW);
  await at(co, w, NOW + 1_000);
  await at(co, w, NOW + 1 * MIN);
  assert.equal(w.publishes.length, 1);
  assert.equal(w.publishes[0].key, BADGE_KEY);
  const [badge] = w.publishes[0].value["/code/app"];
  assert.equal(badge.icon, `mods/${MOD}/icons/moon.svg`);
  delete w.core.t1; // the terminal is gone: the record goes, the moon too
  await at(co, w, NOW + 2 * MIN);
  assert.equal(w.publishes.length, 2);
  assert.deepEqual(w.publishes[1].value, {});
  await at(co, w, NOW + 3 * MIN);
  assert.equal(w.publishes.length, 2);
});

test("nothing asleep and no moon published before: nothing is written to shared state", async () => {
  const { w, co } = setup({ t1: false });
  await at(co, w, NOW);
  assert.equal(w.publishes.length, 0);
});

test("a stale moon from an earlier run is cleared", async () => {
  const { w, co } = setup({ t1: false });
  w.shared[BADGE_KEY] = { "/code/app": [{ icon: "mods/agent-sleep/icons/moon.svg", tone: "dim", tooltip: "x" }] };
  await at(co, w, NOW);
  assert.deepEqual(w.publishes.map((p) => p.value), [{}]);
});

// ── Settings (S6) ─────────────────────────────────────────────────────────

test("settings are read each tick and saved with a compare-and-swap; out-of-range minutes clamp to 30", async () => {
  const { w, co } = setup();
  w.files[SETTINGS] = JSON.stringify({ enabled: false, idleMinutes: 45 });
  await at(co, w, NOW);
  assert.deepEqual(co.settings, { enabled: false, idleMinutes: 45 });
  assert.equal(await co.saveSettings({ enabled: true }), true);
  assert.deepEqual(JSON.parse(w.files[SETTINGS]), { enabled: true, idleMinutes: 45 });
  assert.equal(await co.saveSettings({ idleMinutes: 99999 }), true);
  assert.deepEqual(JSON.parse(w.files[SETTINGS]), { enabled: true, idleMinutes: 30 });
  w.files[SETTINGS] = JSON.stringify({ enabled: false, idleMinutes: 10 }); // changed behind its back
  assert.equal(await co.saveSettings({ idleMinutes: 60 }), false);
  assert.deepEqual(co.settings, { enabled: false, idleMinutes: 10 });
});

test("settings changed in the block: shown at once, saved by the next pulse, Next follows the new window", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(co.model().next, "Next: app in 30 min");
  co.requestSettings({ idleMinutes: 45 });
  assert.deepEqual(co.shownSettings(), { enabled: true, idleMinutes: 45 });
  assert.equal(w.files[SETTINGS], undefined, "nothing is written outside a pulse");
  await at(co, w, NOW + 1_000);
  assert.deepEqual(JSON.parse(w.files[SETTINGS]), { enabled: true, idleMinutes: 45 });
  assert.equal(co.model().next, "Next: app in 45 min", "before the next tick");
  co.requestSettings({ enabled: false });
  co.requestSettings({ idleMinutes: 99999 });
  assert.deepEqual(co.shownSettings(), { enabled: false, idleMinutes: 30 });
  await at(co, w, NOW + 2_000);
  assert.deepEqual(JSON.parse(w.files[SETTINGS]), { enabled: false, idleMinutes: 30 });
  assert.equal(co.model().next, "Automatic sleep is off");
});

test("a pulse says the block changed when its lines differ from the last pulse's, a minute rolling over included", async () => {
  const { w, co } = setup();
  assert.equal(await at(co, w, NOW), true, "the first tick: Next appears");
  assert.equal(await at(co, w, NOW + 1_000), false);
  assert.equal(await at(co, w, NOW + 1 * MIN + 1_000), true, "Next: 30 → 29 min");
  assert.equal(await at(co, w, NOW + 1 * MIN + 2_000), false);
  co.requestSettings({ enabled: false });
  assert.equal(await at(co, w, NOW + 1 * MIN + 3_000), true, "automatic sleep off");
});

test("an env Claude asked for that can't be replayed is a hold in the block from the moment Claude exits", async () => {
  const { w, co } = setup();
  const t = await sleepT1(co, w);
  exitClaude(w, "t1", EXIT.replace(`claude --resume ${SID1}`, `FOO=1 claude --resume ${SID1}`));
  await at(co, w, t + 3_000);
  assert.equal(records(w).t1.env, "FOO=1");
  assert.deepEqual(co.model().holds, ["app stays asleep: Claude asked for FOO=1"]);
  const fresh = new Coordinator(deps(w)); // a reload keeps saying it: it comes from the record
  await at(fresh, w, t + 4_000);
  assert.deepEqual(fresh.model().holds, ["app stays asleep: Claude asked for FOO=1"]);
});

test("automatic sleep off: nothing is stopped automatically, a reveal still resumes", async () => {
  const { w, co } = setup();
  w.files[SETTINGS] = JSON.stringify({ enabled: false, idleMinutes: 30 });
  await sleepT1(co, w);
  assert.equal(exits(w).length, 0);
  storeRecord(w, "t2", { sessionId: SID2, rootPid: 101 });
  w.core.t2 = shellOf(claude("t2", { pid: 101, fgPid: 101 }));
  w.screens.t2 = EXIT.replace(SID1, SID2);
  w.spaces[0].active = false;
  w.spaces[1].active = true;
  w.focused = { space: "s2", tab: "ws2", pane: "p2", terminal: "t2", shown: null, agent: null, cwd: "/code/app" };
  await at(co, w, NOW + 40 * MIN);
  assert.equal(resumes(w).length, 1);
});

test("the settings view steps the window through whole minutes, 1 min to 24 h", () => {
  assert.equal(stepMinutes(30, 1), 45);
  assert.equal(stepMinutes(30, -1), 20);
  assert.equal(stepMinutes(1, -1), 1);
  assert.equal(stepMinutes(1440, 1), 1440);
  assert.equal(stepMinutes(37, 1), 45, "a hand-written value snaps to the next step");
  assert.equal(stepMinutes(37, -1), 30);
});

test("the settings view names the window in minutes, or in hours when it is whole hours", () => {
  assert.equal(windowLabel(30), "After 30 min");
  assert.equal(windowLabel(1), "After 1 min");
  assert.equal(windowLabel(90), "After 90 min");
  assert.equal(windowLabel(60), "After 1 h");
  assert.equal(windowLabel(1440), "After 24 h");
});

test("Claude Code is recognised in every terminal shape", () => {
  assert.equal(isClaudeCodeTerminal({ address: "t1", agent: "claude-code" }), true); // hc ls --json
  assert.equal(isClaudeCodeTerminal({ address: "t1", status: { app: "claude-code", state: "idle" } }), true); // hc get
  assert.equal(isClaudeCodeTerminal({ address: "t1", report: { app: "claude-code" } }), true); // terminals()
  assert.equal(isClaudeCodeTerminal({ address: "t1", program: { key: "claude" } }), true);
  assert.equal(isClaudeCodeTerminal({ address: "t1", foreground: { name: "claude.exe" } }), true);
  assert.equal(isClaudeCodeTerminal({ address: "t1", agent: "zsh", status: "idle" }), false);
});

// ── Purity ────────────────────────────────────────────────────────────────

test("coordinator.js never imports herdr: everything comes injected", () => {
  const src = readFileSync(new URL("../mods/agent-sleep/coordinator.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["'](herdr|gpui-kit|gpui-base)["']/);
  assert.doesNotMatch(src, /\bDate\.now\(|setTimeout|setInterval|node:child_process|node:fs/);
});

// main.js needs Herdr to load, so it is checked by its source (and by
// `herdr-app check` in T5's Verify).
test("main.js is the only file importing herdr; its only timer is startLoop's (an overlay copy starts none)", () => {
  const mod = new URL("../mods/agent-sleep/", import.meta.url);
  const views = existsSync(new URL("views/", mod)) ? readdirSync(new URL("views/", mod)).map((f) => `views/${f}`) : [];
  const files = [...readdirSync(mod), ...views].filter((f) => f.endsWith(".js"));
  assert.ok(files.includes("main.js"));
  for (const f of files) {
    const src = readFileSync(new URL(f, mod), "utf8");
    assert.equal(/from\s+["']herdr["']/.test(src), f === "main.js", f);
  }
  const main = readFileSync(new URL("main.js", mod), "utf8");
  assert.match(main, /startLoop\(\s*\w+,\s*cx\.timer,/);
  assert.doesNotMatch(main, /\.timer\.(every|after)\(|setTimeout|setInterval/);
  const manifest = JSON.parse(readFileSync(new URL("mod.json", mod), "utf8"));
  assert.equal(manifest.place, "none", "placed by projects-sidebar's slot (D10, T6), never docked by Herdr");
});
