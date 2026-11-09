// workspace-sleep T4 (S5 piece 3, S9): a workspace put to sleep wakes when one
// of its spaces is shown again, a click on its row, the picker or an agent's
// focus (D4). Its tabs come back, the Claudes that were working resume at
// once, the rest when their tab shows, in the account each one slept in. Until
// then neither the reveal path nor Wake all resumes its Claudes, and
// agent-sleep puts no moon of its own on its row (D3). The pure parts are
// tested alone, the rest through the coordinator against harness.js's world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Coordinator, PULSE_MS, REQUEST_KEY } from "../mods/agent-sleep/coordinator.js";
import { BADGE_KEY } from "../mods/agent-sleep/badges.js";
import { SLEEP_WORKSPACE, answerCommand, cameBack, wakePlan, sleptTerminals } from "../mods/agent-sleep/workspace-sleep.js";
import {
  NOW, HOME, COPY, SID1, SID2, IDLE_319, EXIT, ORCA_DEV_PROFILES, PROFILE, deps, addClaude, addProfile, exitClaude, records,
  exits, resumes, at, spacesWorld, showSpace, settledTabs, entries, workspaceSetup, storeRecord,
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
