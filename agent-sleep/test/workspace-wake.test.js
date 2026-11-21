// workspace-sleep T4 (S5 piece 3, S9): a workspace put to sleep wakes when one
// of its spaces is shown again, a click on its row, the picker or an agent's
// focus (D4). Its tabs come back, the Claudes that were working resume at
// once, the rest when their tab shows, in the account each one slept in. Until
// then neither the reveal path nor Wake all resumes its Claudes, and
// agent-sleep puts no moon of its own on its row (D3). The pure parts are
// tested alone, the rest through the coordinator against harness.js's world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Coordinator, PULSE_MS, REQUEST_KEY, RETRY_MS, WAKE_DEADLINE_MS } from "../mods/agent-sleep/coordinator.js";
import { BADGE_KEY } from "../mods/agent-sleep/badges.js";
import {
  SLEEP_WORKSPACE, answerCommand, cameBack, wakePlan, sleptTerminals, sleptBy, entryWake, wakeTargets, wakeCommand, sleepWorkspaceCommand,
} from "../mods/agent-sleep/workspace-sleep.js";
import {
  NOW, HOME, COPY, SID1, SID2, IDLE_319, EXIT, SHELL_BARE, SHELL_TYPED, ORCA_DEV_PROFILES, PROFILE, deps, addClaude, addProfile, exitClaude, records,
  exits, resumes, at, spacesWorld, showSpace, settledTabs, entries, workspaceSetup, storeRecord, logFile, stamp, setup, sleepT1,
} from "./harness.js";

const SID3 = "00000000-0000-4000-8000-000000000003";
const SID4 = "00000000-0000-4000-8000-000000000004";
const SIDS = { t1: SID1, t2: SID2, t3: SID3, t4: SID4 };
const IDLE = { app: "claude-code", state: "idle" };
const WORKING = { app: "claude-code", state: "working" };

// What a resume types in a named account (agent-sleep D15).
const named = (dir) => `CLAUDE_ACCOUNTS_DIR='${dir}' CLAUDE_CONFIG_DIR='${dir}'`;

// ── D4: coming back to a workspace (pure) ───────────────────────────────────

const entry = (over = {}) => ({ spaces: { sa: ["a1", "a2"], sa2: ["a3"] }, state: "asleep", at: NOW, ...over });
const look = (previous, shown) => ({ previous: previous === null ? null : new Set(previous), shown: new Set(shown) });

test("D4: a workspace comes back when one of its spaces goes from not shown to shown; the first look never does", () => {
  assert.equal(cameBack(entry(), look(null, ["sa"])), false, "the first look after a start or a reload");
  assert.equal(cameBack(entry(), look(["inicio"], ["sa"])), true, "the click on its row");
  assert.equal(cameBack(entry(), look(["inicio"], ["sa2"])), true, "any of its spaces");
  assert.equal(cameBack(entry(), look(["sa"], ["sa2"])), true, "another of its spaces, shown now");
  assert.equal(cameBack(entry(), look(["sa"], ["sa"])), false, "still shown is a state, not a change");
  assert.equal(cameBack(entry(), look(["inicio"], ["sb"])), false, "another workspace's space");
  assert.equal(cameBack(entry(), look(["sa"], ["inicio"])), false, "leaving it");
  assert.equal(cameBack(entry({ state: "sleeping" }), look(["inicio"], ["sa"])), true, "mid-sleep too: that is wakeAfter");
});

test("D4, no undo: one still shown when its stops began comes back only after none of its spaces was shown", () => {
  const e = entry({ shownAtSleep: true });
  assert.equal(cameBack(e, look(["sa"], ["sa"])), false);
  assert.equal(cameBack(e, look(["sa"], ["sa2"])), false, "moving inside it isn't coming back");
  assert.equal(cameBack(e, look(["inicio"], ["sa2"])), true);
  assert.equal(cameBack(e, look(null, ["sa"])), false);
});

// Two spaces of /code/app: sa (a1, a2, and a tab opened in it since) and sa2
// (a3); sb is another workspace's.
const SPACES = [
  { id: "sa", tabs: [{ id: "a1", settled: true }, { id: "a2", settled: true }, { id: "new", settled: false }] },
  { id: "sa2", tabs: [{ id: "a3", settled: false }] },
  { id: "sb", tabs: [{ id: "b1", settled: true }] },
];
const PANES = [
  { pane: "p0", terminal: null, tab: "a1", mod: "projects" },
  { pane: "p1", terminal: "t1", tab: "a1" },
  { pane: "p3", terminal: "t3", tab: "a2" },
  { pane: "p4", terminal: "t4", tab: "a3" },
  { pane: "p5", terminal: "t5", tab: "new" },
  { pane: "p2", terminal: "t2", tab: "b1" },
];

test("D4's wake: every listed tab that still exists comes back, and the Claudes asleep with wake: \"now\" resume at once", () => {
  const e = entry({ spaces: { sa: ["a1", "a2", "gone"], sa2: ["a3"] } });
  const recs = {
    t1: { state: "asleep", wake: "now" },
    t3: { state: "asleep" },
    t4: { state: "asleep", wake: "now" },
    t5: { state: "stopping", wake: "now" },
    t2: { state: "asleep", wake: "now" },
  };
  assert.deepEqual(wakePlan(e, { spaces: SPACES, panes: PANES, records: recs }), { unsettle: ["a1", "a2", "a3"], now: ["t1", "t4"] });
  assert.deepEqual(wakePlan(e, { spaces: [], panes: [], records: recs }), { unsettle: [], now: [] }, "no evidence, nothing to do");
});

test("D4: the terminals a workspace's sleep holds are every one in a space an entry lists, a tab opened since included", () => {
  assert.deepEqual([...sleptTerminals({ "/code/app": entry() }, SPACES, PANES)], ["t1", "t3", "t4", "t5"]);
  assert.deepEqual([...sleptTerminals({}, SPACES, PANES)], []);
  assert.deepEqual([...sleptTerminals(null, SPACES, PANES)], []);
  // sleptBy: each with the entry whose sleep holds it, the first entry's when two list it.
  const two = { "/code/b": entry({ spaces: { sb: ["b1"], sa2: ["a3"] } }), "/code/app": entry() };
  assert.deepEqual([...sleptBy(two, SPACES, PANES)], [["t4", "/code/b"], ["t2", "/code/b"], ["t1", "/code/app"], ["t3", "/code/app"], ["t5", "/code/app"]]);
  assert.deepEqual([...sleptTerminals(two, SPACES, PANES)].sort(), ["t1", "t2", "t3", "t4", "t5"]);
});

test("awake-agent D2, D3: what waking an entry does (entryWake), and the terminals a wake by path is for (wakeTargets)", () => {
  assert.equal(entryWake(entry()), "now");
  assert.equal(entryWake(entry({ state: "sleeping" })), "after");
  assert.equal(entryWake(entry({ state: "sleeping", wakeAfter: true })), null, "already told");
  assert.equal(entryWake(undefined), null);
  const recs = {
    t3: { state: "asleep", workspacePath: "/code/app", cwd: "/code/app/web" },
    t1: { state: "stopping", workspacePath: null, cwd: "/code/app" },
    t2: { state: "asleep", workspacePath: "/code/b", cwd: "/code/b" },
    t4: { state: "live", workspacePath: "/code/app", cwd: "/code/app" },
    t5: { state: "asleep", workspacePath: "/code/c", cwd: "/code/c" },
  };
  assert.deepEqual(wakeTargets(recs, "/code/app"), ["t1", "t3"], "asleep or being stopped, at the path; sorted");
  assert.deepEqual(wakeTargets(recs, "/code/app", new Set(["t5", "t4"])), ["t1", "t3", "t5"], "and in its workspace's tabs");
  assert.deepEqual(wakeTargets(null, "/code/app"), []);
});

// ── Through the coordinator ─────────────────────────────────────────────────

// /code/app has two spaces: sa, shown, with a Claude in each of its tabs (t1
// in a1, its active tab; t3 in a2), and sa2 with t4 in a3, which runs in an
// Orca profile's account. /code/checkout-flow has t2 in sb. Inicio holds
// only projects-sidebar's pane (workspace-sleep D6).
const LAYOUT = [
  { id: "sa", tabs: { a1: [["pa1", "t1", "/code/app"]], a2: [["pa2", "t3", "/code/app"]] } },
  { id: "sa2", tabs: { a3: [["pa3", "t4", "/code/app/src"]] } },
  { id: "sb", tabs: { b1: [["pb1", "t2", "/code/checkout-flow"]] } },
  { id: "inicio", folder: HOME, tabs: { i1: [["pi1", null, null]] } },
];

// Each Claude ends right when /exit reaches it, printing its own resume hint.
const exitOnSend = (address, text, w) => {
  if (text === "/exit") exitClaude(w, address, EXIT.replaceAll(SID1, SIDS[address]));
};

async function ready(build = () => {}) {
  const { w, co } = workspaceSetup();
  spacesWorld(w, LAYOUT, "sa");
  const profile = addProfile(w, ORCA_DEV_PROFILES, "p1");
  addClaude(w, "t1", { pid: 100, fgPid: 200, sid: SID1, screen: IDLE_319, status: IDLE });
  addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE });
  addClaude(w, "t4", { pid: 104, fgPid: 204, sid: SID4, screen: IDLE_319, status: IDLE, cwd: "/code/app/src", configDir: profile });
  addClaude(w, "t2", { pid: 101, fgPid: 201, sid: SID2, screen: IDLE_319, status: IDLE, cwd: "/code/checkout-flow" });
  w.onSend = exitOnSend;
  build(w);
  await at(co, w, NOW);
  return { w, co };
}

// Working when the sleep is asked for; its interrupt ends the turn (T0b item 4).
const working = (address) => (w) => {
  w.core[address].status = WORKING;
  w.onInterrupt = (a, w) => {
    w.core[a].status = IDLE;
  };
};

// t2 put to sleep on its own (automatic sleep), in the awake workspace.
const t2Asleep = (w) => {
  exitClaude(w, "t2", EXIT.replaceAll(SID1, SID2));
  storeRecord(w, "t2", { sessionId: SID2, cwd: "/code/checkout-flow", workspacePath: "/code/checkout-flow", rootPid: 101 });
};

const step = (co, w) => at(co, w, w.now + PULSE_MS);
async function steps(co, w, n) {
  for (let i = 0; i < n; i++) await step(co, w);
}

let asked = 0;
async function answer(co, w, yes) {
  w.shared[REQUEST_KEY] = { id: `answer-${++asked}`, owner: COPY, command: answerCommand(co.question.id, yes) };
  await step(co, w);
}

// The bare command on the shown workspace (/code/app), "Sleep" in the confirm
// when it asks, the keeper showing Inicio (T2) unless `keeper: false`, then
// pulses until its entry is asleep.
async function sleepApp(co, w, { keeper = true } = {}) {
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  if (co.question) await answer(co, w, true);
  if (keeper) showSpace(w, "inicio");
  for (let i = 0; i < 30 && entries(w)["/code/app"]?.state !== "asleep"; i++) await step(co, w);
  assert.equal(entries(w)["/code/app"]?.state, "asleep");
  assert.deepEqual(exits(w).map((s) => s.address), ["t1", "t3", "t4"]);
  for (const a of ["t1", "t3", "t4"]) assert.equal(records(w)[a]?.state, "asleep", a);
}

// Another tab of a space is shown (a click on it).
function showTab(w, space, tab) {
  w.spaces = w.spaces.map((s) => (s.id === space ? { ...s, tabs: s.tabs.map((t) => ({ ...t, active: t.id === tab })) } : s));
  showSpace(w, space);
}

const unsettled = (w, from) => w.runs.slice(from).filter(([n]) => n === "tab.unsettle").map(([, a]) => a.id);

// ── Waking ──

test("Waking: showing one of its spaces brings every listed tab back, resumes the Claude that was working at once in its account, the shown one, and drops the entry", async () => {
  const { w, co } = await ready(working("t4"));
  await sleepApp(co, w);
  assert.deepEqual(settledTabs(w), ["a1", "a2", "a3"]);
  assert.equal(records(w).t4.wake, "now");
  const from = w.runs.length;
  showSpace(w, "sa"); // the click on its row: projects-sidebar's space.select
  await step(co, w);
  assert.deepEqual(unsettled(w, from), ["a1", "a2", "a3"]);
  assert.deepEqual(settledTabs(w), []);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(resumes(w).map((s) => s.address), ["t4", "t1"], "t4 at once, though its tab is hidden; t1's tab is the one shown");
  assert.equal(resumes(w)[0].text, `${named(PROFILE)} claude --dangerously-skip-permissions --resume ${SID4}`, "in the account it slept in");
  assert.equal(resumes(w)[1].text, `CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume ${SID1}`);
  assert.equal(records(w).t3.state, "asleep", "its tab isn't shown");
  await steps(co, w, 2);
  assert.equal(resumes(w).length, 2);
  showTab(w, "sa", "a2");
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t4", "t1", "t3"], "the rest when their tab shows");
  assert.equal(co.view().last, "Woke app");
});

test("Waking: a space already shown at the first look after a reload isn't an edge; its Claudes stay asleep until it is left and shown again", async () => {
  const { w, co } = await ready();
  await sleepApp(co, w);
  showSpace(w, "sa"); // Herdr came back showing it
  const fresh = new Coordinator({ ...deps(w), copyId: "after-reload" });
  const from = w.runs.length;
  await steps(fresh, w, 3);
  assert.deepEqual(w.runs.slice(from), []);
  assert.deepEqual(resumes(w), [], "the reveal path skips its terminals until its wake");
  assert.equal(entries(w)["/code/app"].state, "asleep");
  showSpace(w, "inicio");
  await step(fresh, w);
  showSpace(w, "sa");
  await step(fresh, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(unsettled(w, from), ["a1", "a2", "a3"]);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"]);
});

test("Whole workspace (R2#3): two slept spaces, the row's click shows one → both are unsettled", async () => {
  const { w, co } = await ready();
  await sleepApp(co, w);
  const from = w.runs.length;
  showSpace(w, "sa2");
  await step(co, w);
  assert.deepEqual(unsettled(w, from), ["a1", "a2", "a3"]);
  assert.deepEqual(settledTabs(w), []);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t4"], "the shown one; the others wait for their tab");
  assert.deepEqual(entries(w), {});
});

// ── No undo ──

test("No undo: still shown when its stops began (no keeper) → no wake and no reveal while it stays shown, nor moving inside it; left and shown again → wake", async () => {
  const { w, co } = await ready();
  await sleepApp(co, w, { keeper: false });
  assert.equal(entries(w)["/code/app"].shownAtSleep, true);
  const from = w.runs.length;
  await steps(co, w, 3);
  showSpace(w, "sa2");
  await steps(co, w, 2);
  assert.deepEqual(w.runs.slice(from), []);
  assert.deepEqual(resumes(w), [], "t1's tab is on screen, and it stays asleep");
  assert.equal(entries(w)["/code/app"].state, "asleep");
  showSpace(w, "inicio");
  await step(co, w);
  showSpace(w, "sa");
  await step(co, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(unsettled(w, from), ["a1", "a2", "a3"]);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"]);
});

// ── Mid-sleep ──

test("Mid-sleep: a shown edge while sleeping → wakeAfter and the rest of the queue dropped; step 6 wakes it instead of settling", async () => {
  const { w, co } = await ready((w) => {
    working("t1")(w);
    w.onSend = null; // Claude takes its time to exit
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  await answer(co, w, true);
  showSpace(w, "inicio");
  await step(co, w);
  assert.deepEqual(w.interrupts.map((i) => i.address), ["t1"]);
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  assert.equal(records(w).t1.wake, "now");
  showSpace(w, "sa2"); // the row's click, while t3 and t4 still wait for their stops
  await step(co, w);
  assert.equal(entries(w)["/code/app"].wakeAfter, true);
  await steps(co, w, 3);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"], "no /exit reaches a Claude you came back to");
  assert.equal(entries(w)["/code/app"].state, "sleeping", "step 6 waits for t1's exit");
  const from = w.runs.length;
  exitClaude(w, "t1");
  await step(co, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(w.runs.slice(from).map(([n, a]) => `${n} ${a.id}`), ["tab.unsettle a1", "tab.unsettle a2", "tab.unsettle a3"], "woken, not settled again");
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"], "it was working: at once, though its tab is hidden");
});

test("Mid-sleep, no undo: still shown when its stops began, moving to another of its spaces isn't coming back; its stops go on", async () => {
  const { w, co } = await ready();
  co.command(SLEEP_WORKSPACE);
  await steps(co, w, 1 + 3); // no keeper: shownAtSleep, and t1's stop
  assert.equal(entries(w)["/code/app"].shownAtSleep, true);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  showSpace(w, "sa2");
  await steps(co, w, 6);
  assert.equal(Object.hasOwn(entries(w)["/code/app"], "wakeAfter"), false);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1", "t3", "t4"]);
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

// ── Wake all and the reveal path ──

test("Wake all resumes a Claude asleep on its own and skips the Claudes of a slept workspace", async () => {
  const { w, co } = await ready(t2Asleep);
  await sleepApp(co, w);
  co.command("wake-all");
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t2"]);
  for (const a of ["t1", "t3", "t4"]) assert.equal(records(w)[a].state, "asleep", a);
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

test("Reveal: a Claude asleep on its own in an awake workspace still resumes when its tab shows, while another workspace sleeps", async () => {
  const { w, co } = await ready(t2Asleep);
  await sleepApp(co, w);
  showSpace(w, "sb");
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t2"]);
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

// ── The badge (D3) ──

test("Badge: none from agent-sleep for a workspace asleep as a whole; one for a Claude asleep in an awake workspace", async () => {
  const { w, co } = await ready(t2Asleep);
  assert.deepEqual(Object.keys(w.shared[BADGE_KEY]), ["/code/checkout-flow"]);
  await sleepApp(co, w);
  assert.ok(w.publishes.every((p) => !Object.hasOwn(p.value, "/code/app")), "projects-sidebar draws the only moon on its row");
  assert.deepEqual(Object.keys(w.shared[BADGE_KEY]), ["/code/checkout-flow"]);
  showSpace(w, "sa2");
  await step(co, w);
  assert.deepEqual(Object.keys(w.shared[BADGE_KEY]), ["/code/app", "/code/checkout-flow"], "awake again, with t1 and t3 still asleep");
  assert.match(w.shared[BADGE_KEY]["/code/app"][0].tooltip, /^2 Claudes asleep since /);
});

// ── awake-agent: a wake by path (`wake.<hex>`, D1–D3) ───────────────────────
// A Claude wakes another worktree's from a shell: `herdr-app do
// agent-sleep.wake.<hex>`. Its asleep Claudes resume, slept on their own or
// with their workspace, and nothing is shown: tab.unsettle only puts a tab
// back in its space.

const wakes = (co) => [...co.wakes.keys()];
const shownNow = (w) => ({ spaces: w.spaces.map((s) => `${s.id}:${s.active}`), focused: w.focused });
const inLog = (appends) => appends.map((a) => a.text).join("");

// t2 asleep on its own with a typed shell line: a wake keeps waiting on it.
const typedT2 = (w) => {
  t2Asleep(w);
  w.screens.t2 = SHELL_TYPED;
};

// Pulses up to the one before the deadline of a wake first seen at `since`.
async function untilDeadline(co, w, since) {
  while (w.now + PULSE_MS < since + WAKE_DEADLINE_MS) await step(co, w);
}

test("Wake by path: a Claude asleep on its own at the path, its tab hidden, is resumed at the next pulse as a wake; nothing is shown, and one asleep at another path stays asleep", async () => {
  const { w, co } = await ready((w) => {
    t2Asleep(w);
    exitClaude(w, "t3", EXIT.replaceAll(SID1, SID3));
    storeRecord(w, "t3", { sessionId: SID3, rootPid: 103 }); // /code/app's, in sa's hidden tab a2
  });
  const before = shownNow(w);
  co.command(wakeCommand("/code/checkout-flow"));
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => `${s.address} ${s.text}`), [`t2 CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume ${SID2}`]);
  assert.equal(Object.hasOwn(records(w), "t2"), false, "claimed before it was typed");
  assert.equal(records(w).t3.state, "asleep", "another path's Claude is left");
  assert.deepEqual(shownNow(w), before, "the shown space, tab and focus are unchanged");
  assert.deepEqual(w.runs, [], "no tab selected, settled or unsettled");
  assert.ok(w.logs.includes("t2: resumed (wake /code/checkout-flow)"), JSON.stringify(w.logs));
  assert.deepEqual(wakes(co), [], "nothing asleep there now: the wake is done");
  co.command(wakeCommand("/code/elsewhere"));
  await step(co, w);
  assert.ok(w.logs.includes("/code/elsewhere: wake asked, nothing asleep there"), JSON.stringify(w.logs));
  assert.deepEqual(wakes(co), []);
});

test("Wake by path: another program in front of its shell → not resumed and its record kept: a wake, never the reveal's taken-over", async () => {
  const { w, co } = await ready((w) => {
    t2Asleep(w);
    w.core.t2 = { ...w.core.t2, foreground: { argv: ["vim"], cwd: "/code/checkout-flow", name: "vim", pid: 300 } };
  });
  co.command(wakeCommand("/code/checkout-flow"));
  await steps(co, w, 3);
  assert.deepEqual(resumes(w), []);
  assert.equal(records(w).t2.state, "asleep");
  assert.deepEqual(w.logs.filter((l) => l.startsWith("t2: not resumed")), ["t2: not resumed (wake /code/checkout-flow): vim is in front of its shell"], "said once");
});

test("Wake by path: another program in front, or a terminal gone, is looked at again only after RETRY_MS, as a typed shell line is", async () => {
  const { w, co } = await ready((w) => {
    t2Asleep(w);
    w.core.t2 = { ...w.core.t2, foreground: { argv: ["vim"], cwd: "/code/checkout-flow", name: "vim", pid: 300 } };
    exitClaude(w, "t3", EXIT.replaceAll(SID1, SID3));
    storeRecord(w, "t3", { sessionId: SID3, cwd: "/code/checkout-flow", workspacePath: "/code/checkout-flow", rootPid: 103 });
  });
  delete w.core.t3; // its tab closed after the last tick
  const gets = () => ["t2", "t3"].map((a) => w.calls.filter(([c, x]) => c === "get" && x === a).length);
  co.command(wakeCommand("/code/checkout-flow"));
  const since = w.now + PULSE_MS;
  await step(co, w);
  assert.deepEqual(gets(), [1, 1], "tried at once");
  assert.deepEqual([co.retryAt.t2, co.retryAt.t3], [since + RETRY_MS, since + RETRY_MS]);
  await step(co, w);
  assert.deepEqual(gets(), [1, 1], "their retryAt hasn't passed: skipped");
  await step(co, w);
  assert.deepEqual(gets(), [2, 2], "looked at again");
  assert.deepEqual(resumes(w), []);
  assert.deepEqual(co.wakes.get("/code/checkout-flow").why, { t2: "vim is in front of its shell", t3: "terminal gone" }, "the last reason, for the deadline's lines");
});

test("Wake by path: an asleep workspace's entry is gone and every Claude it put to sleep resumes in the same pulse, idle ones too; its tabs come back, none is shown", async () => {
  const { w, co } = await ready();
  await sleepApp(co, w);
  const from = w.runs.length;
  co.command(wakeCommand("/code/app"));
  await step(co, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(w.runs.slice(from).map(([n, a]) => `${n} ${a.id}`), ["tab.unsettle a1", "tab.unsettle a2", "tab.unsettle a3"], "brought back, never selected");
  assert.deepEqual(settledTabs(w), []);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1", "t3", "t4"]);
  assert.equal(resumes(w)[2].text, `${named(PROFILE)} claude --dangerously-skip-permissions --resume ${SID4}`, "in the account it slept in");
  assert.deepEqual(records(w), {});
  assert.equal(w.spaces.find((s) => s.active).id, "inicio", "the shown space is unchanged");
  assert.deepEqual(wakes(co), []);
});

// wake-agent's CLI reads a terminal's own lines after its timeout: the entry
// is dropped the same pulse, so `<path>: woken, …` names no terminal.
const resumedLines = (w, from) => w.logs.slice(from).filter((l) => /^t\d+: resumed \(/.test(l));

test("Wake by path: the wake: \"now\" Claude its asleep workspace's wake resumes gets its own `<t>: resumed (wake <path>)` line, as the rest do", async () => {
  const { w, co } = await ready(working("t4"));
  await sleepApp(co, w);
  assert.equal(records(w).t4.wake, "now");
  const from = w.logs.length;
  co.command(wakeCommand("/code/app"));
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t4", "t1", "t3"], "t4 by its workspace's wake, the rest by the wake's own");
  assert.deepEqual(resumedLines(w, from), ["t4: resumed (wake /code/app)", "t1: resumed (wake /code/app)", "t3: resumed (wake /code/app)"]);
  assert.ok(w.logs.includes('/code/app: woken, 3 tab(s) back, 1 of 1 wake: "now" Claude(s) resumed'), JSON.stringify(w.logs));
});

test("Waking by a click, no wake by path under way: its wake: \"now\" Claude's resume writes no `resumed (wake <path>)` line, as before", async () => {
  const { w, co } = await ready(working("t4"));
  await sleepApp(co, w);
  const from = w.logs.length;
  showSpace(w, "sa");
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t4", "t1"]);
  assert.deepEqual(resumedLines(w, from), []);
  assert.ok(w.logs.includes('/code/app: woken, 3 tab(s) back, 1 of 1 wake: "now" Claude(s) resumed'), JSON.stringify(w.logs));
});

test("Wake by path mid-sleep: the wake: \"now\" Claude step 6's wake resumes for it gets its own `<t>: resumed (wake <path>)` line too", async () => {
  const { w, co } = await ready((w) => {
    working("t1")(w);
    w.onSend = null; // Claude takes its time to exit
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  if (co.question) await answer(co, w, true);
  showSpace(w, "inicio");
  for (let i = 0; i < 5 && records(w).t1?.state !== "stopping"; i++) await step(co, w);
  assert.equal(records(w).t1.state, "stopping");
  assert.equal(records(w).t1.wake, "now");
  co.command(wakeCommand("/code/app"));
  await step(co, w);
  assert.equal(entries(w)["/code/app"].wakeAfter, true);
  const from = w.logs.length;
  exitClaude(w, "t1");
  for (let i = 0; i < 5 && entries(w)["/code/app"]; i++) await step(co, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"]);
  assert.deepEqual(resumedLines(w, from), ["t1: resumed (wake /code/app)"]);
  assert.ok(w.logs.includes('/code/app: woken, 3 tab(s) back, 1 of 1 wake: "now" Claude(s) resumed'), JSON.stringify(w.logs));
});

test("Wake by path mid-sleep: wakeAfter and its job gone, so no further /exit; the wake outlives the stop under way, and the idle Claude it was stopping resumes after step 6, its tab hidden", async () => {
  const { w, co } = await ready((w) => {
    w.onSend = null; // Claude takes its time to exit
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question, null, "nothing in flight");
  showSpace(w, "inicio");
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  assert.equal(records(w).t1.state, "stopping");
  co.command(wakeCommand("/code/app"));
  await step(co, w);
  assert.equal(entries(w)["/code/app"].wakeAfter, true);
  assert.equal(Object.hasOwn(co.jobs, "/code/app"), false, "its job is gone");
  assert.ok(w.logs.includes("/code/app: asked to wake while going to sleep; its stops are dropped"), JSON.stringify(w.logs));
  await steps(co, w, 3);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"], "no /exit after the wake: t3 and t4 keep running");
  assert.equal(entries(w)["/code/app"].state, "sleeping", "step 6 waits for t1's exit");
  assert.deepEqual(wakes(co), ["/code/app"], "t1 is still being stopped: the wake waits for it");
  exitClaude(w, "t1");
  await step(co, w);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"], "resumed, though it was idle and its tab is hidden");
  assert.equal(w.spaces.find((s) => s.active).id, "inicio");
  assert.deepEqual(wakes(co), []);
});

test("Wake by path: a typed shell line is retried once its retryAt passes, never before; at WAKE_DEADLINE_MS the wake gives up with a log.txt line per terminal still down", async () => {
  const { w, co } = await ready(typedT2);
  const appends = logFile(w, co);
  const reads = () => w.calls.filter(([c, a]) => c === "read" && a === "t2").length;
  co.command(wakeCommand("/code/checkout-flow"));
  const since = w.now + PULSE_MS;
  await step(co, w);
  assert.equal(reads(), 1, "tried at once");
  assert.equal(co.retryAt.t2, since + RETRY_MS);
  await step(co, w);
  assert.equal(reads(), 1, "its retryAt hasn't passed: skipped");
  await step(co, w);
  assert.equal(reads(), 2, "retried on a later pulse");
  await untilDeadline(co, w, since);
  assert.deepEqual(wakes(co), ["/code/checkout-flow"], "still trying");
  await step(co, w);
  assert.equal(w.now, since + WAKE_DEADLINE_MS);
  assert.deepEqual(wakes(co), [], "given up");
  const line = "t2: not woken (wake /code/checkout-flow): its shell line isn't a bare prompt (shell, typed)";
  assert.ok(inLog(appends).includes(`${stamp(since + WAKE_DEADLINE_MS)} ${line}\n`), inLog(appends));
  assert.deepEqual(w.logs.filter((l) => l.startsWith("t2: not resumed")), ["t2: not resumed (wake /code/checkout-flow): its shell line isn't a bare prompt (shell, typed)"], "the wait said once");
  const after = reads();
  w.screens.t2 = SHELL_BARE;
  await steps(co, w, 3);
  assert.equal(reads(), after, "no more tries");
  assert.deepEqual(resumes(w), []);
  assert.equal(records(w).t2.state, "asleep");
});

test("Wake by path: a Claude at the path whose terminal another workspace's asleep entry holds is left asleep, that sleep isn't undone, and the wake gives up naming that workspace", async () => {
  const { w, co } = await ready((w) => {
    // t3's Claude runs in /code/checkout-flow, in a tab of /code/app's space sa: it sleeps with /code/app (D12).
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE, cwd: "/code/checkout-flow" });
  });
  await sleepApp(co, w);
  assert.equal(records(w).t3.workspacePath, "/code/checkout-flow");
  const appends = logFile(w, co);
  co.command(wakeCommand("/code/checkout-flow"));
  const since = w.now + PULSE_MS;
  await step(co, w);
  assert.deepEqual(resumes(w), []);
  assert.ok(w.logs.includes("t3: not resumed (wake /code/checkout-flow): held by workspace /code/app"), JSON.stringify(w.logs));
  await untilDeadline(co, w, since);
  await step(co, w);
  assert.deepEqual(wakes(co), []);
  assert.ok(inLog(appends).includes(`${stamp(since + WAKE_DEADLINE_MS)} t3: not woken (wake /code/checkout-flow): held by workspace /code/app\n`), inLog(appends));
  assert.deepEqual(resumes(w), []);
  assert.equal(records(w).t3.state, "asleep");
  assert.equal(entries(w)["/code/app"].state, "asleep");
  assert.deepEqual(settledTabs(w), ["a1", "a2", "a3"]);
});

test("Wake by path, then a sleep of that workspace: the last ask wins; the wake is dropped with its lines and the new sleep isn't woken", async () => {
  const { w, co } = await ready(typedT2);
  co.command(wakeCommand("/code/checkout-flow"));
  await step(co, w);
  assert.deepEqual(wakes(co), ["/code/checkout-flow"]);
  co.command(sleepWorkspaceCommand("/code/checkout-flow"));
  await steps(co, w, 3);
  assert.deepEqual(wakes(co), []);
  assert.ok(w.logs.includes("t2: not woken (wake /code/checkout-flow): put to sleep again"), JSON.stringify(w.logs));
  assert.equal(Object.hasOwn(entries(w)["/code/checkout-flow"], "wakeAfter"), false);
  assert.deepEqual(resumes(w), []);
});

test("Wake by path while automatic sleep's /exit is under way: the wake waits for that Claude to be asleep, then resumes it", async () => {
  const { w, co } = setup(); // t1 idle in a hidden tab, automatic sleep on
  const sent = await sleepT1(co, w);
  assert.equal(records(w).t1.state, "stopping");
  co.command(wakeCommand("/code/app"));
  await at(co, w, sent + PULSE_MS);
  await at(co, w, sent + 2 * PULSE_MS);
  assert.deepEqual(wakes(co), ["/code/app"], "nothing asleep there yet, but t1 is being stopped");
  exitClaude(w, "t1");
  await at(co, w, sent + 3 * PULSE_MS);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t1"]);
  assert.deepEqual(wakes(co), []);
});

test("Wake by path asked mid-pulse: the next pulse takes it, its clock starts there, and the Claude it resumes counts as found", async () => {
  const { w, co } = await ready(t2Asleep);
  // The command comes from the listener while a pulse is under way.
  const workspaceStep = co.workspaceStep.bind(co);
  co.workspaceStep = (o) => {
    co.workspaceStep = workspaceStep;
    co.command(wakeCommand("/code/checkout-flow"));
    return workspaceStep(o);
  };
  await step(co, w);
  assert.deepEqual(resumes(w), [], "that pulse leaves it");
  assert.equal(co.wakes.get("/code/checkout-flow").since, null);
  await step(co, w);
  assert.deepEqual(resumes(w).map((s) => s.address), ["t2"]);
  assert.deepEqual(wakes(co), []);
  assert.equal(w.logs.some((l) => l.includes("nothing asleep there")), false, JSON.stringify(w.logs));
});

test("Wake by path asked again, even mid-pulse at its deadline: the same wake goes on, its clock started again", async () => {
  const { w, co } = await ready(typedT2);
  co.command(wakeCommand("/code/checkout-flow"));
  const since = w.now + PULSE_MS;
  await untilDeadline(co, w, since);
  // The deadline's pulse: the command comes from the listener while that pulse reads t2.
  w.onRead = (address, w) => {
    if (address !== "t2") return;
    w.onRead = null;
    co.command(wakeCommand("/code/checkout-flow"));
  };
  await step(co, w);
  assert.equal(w.onRead, null, "asked again mid-pulse");
  assert.deepEqual(wakes(co), ["/code/checkout-flow"], "not given up: asked again");
  assert.equal(w.logs.filter((l) => l.includes("not woken")).length, 0);
  const again = w.now + PULSE_MS;
  await untilDeadline(co, w, again);
  await step(co, w);
  assert.deepEqual(wakes(co), []);
  assert.deepEqual(w.logs.filter((l) => l.includes("not woken")), ["t2: not woken (wake /code/checkout-flow): its shell line isn't a bare prompt (shell, typed)"]);
});
