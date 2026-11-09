// workspace-sleep T3 (S5 piece 2, S9): `agent-sleep.sleep-workspace` puts every
// space of the shown workspace to sleep without closing it (D2): its Claudes
// end through the forced manual stop (D11), its other programs get an
// interrupt and then a hang-up, and its tabs are settled. Work in flight
// asks first (D5). The steps run across pulses (D10) and their state is
// workspaces.json (D9). Which spaces are the workspace's is
// projects-sidebar's rule (D12). The pure parts are tested alone, the rest
// through the coordinator against the fake world of harness.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Coordinator, PULSE_MS, REQUEST_KEY } from "../mods/agent-sleep/coordinator.js";
import {
  placeOf, localPlaces, kindOf, flightOf, promptStep, shownEdges, tabsToSettle, processGroups, hangUpGroup,
  didntStopNotice, parseWorkspaceCommand, answerCommand, SLEEP_WORKSPACE, WAIT_PULSES, INTERRUPT_DEADLINE_MS, PROGRAM_GRACE_MS, CLEAR_KEY,
} from "../mods/agent-sleep/workspace-sleep.js";
import { isShellRoot } from "../mods/agent-sleep/rules.js";
import {
  NOW, HOME, COPY, SID1, SID2, SUGGESTION, IDLE_319, DRAFT_319, MULTI_319, CLEARED_319, INTERRUPTED, WORKSPACES, SLEEPING,
  claude, shellOf, deps, addClaude, exitClaude, records, exits, at, spacesWorld, showSpace, settledTabs, addShell,
  addProgram, entries, workspaceSetup,
} from "./harness.js";

const SID3 = "00000000-0000-4000-8000-000000000003";
const SID4 = "00000000-0000-4000-8000-000000000004";
const IDLE = { app: "claude-code", state: "idle" };
const WORKING = { app: "claude-code", state: "working" };

// ── D12: which spaces are a workspace's ─────────────────────────────────────

const spaceOf = (id, tabs, over = {}) => ({ id, folder: "", machine: null, tabs: tabs.map((t) => ({ id: t })), ...over });

test("D12: a space is where its first pane with a folder is (panes() order), else its own folder", () => {
  const panes = [
    { pane: "p0", terminal: null, tab: "x1", mod: "projects", cwd: null },
    { pane: "p1", terminal: "t1", tab: "x1", cwd: null },
    { pane: "p2", terminal: "t2", tab: "x2", cwd: "/code/checkout-flow" },
    { pane: "p3", terminal: "t3", tab: "x1", cwd: "/code/app" },
  ];
  assert.equal(placeOf(spaceOf("s", ["x1", "x2"], { folder: "/code/x" }), panes), "/code/checkout-flow");
  assert.equal(placeOf(spaceOf("s", ["x1"], { folder: "/code/x" }), panes), "/code/app");
  assert.equal(placeOf(spaceOf("s", ["x1"], { folder: "/code/x" }), panes.slice(0, 2)), "/code/x", "no pane has a folder yet");
  assert.equal(placeOf(spaceOf("s", ["x1"]), panes.slice(0, 2)), null);
  assert.equal(placeOf(spaceOf("s", ["x1"], { folder: "~/code" }), panes.slice(0, 2), "/Users/demo"), "/Users/demo/code");
});

test("D12: a space with no terminal pane is no workspace's, Inicio included, even with a checkout as its folder", () => {
  const panes = [{ pane: "pi", terminal: null, tab: "i1", mod: "projects", cwd: null }];
  assert.equal(placeOf(spaceOf("inicio", ["i1"], { folder: HOME }), panes), null);
  assert.equal(placeOf(spaceOf("inicio", ["i1"], { folder: "/code/app" }), panes), null);
  assert.equal(placeOf(spaceOf("empty", [], { folder: "/code/app" }), panes), null);
});

test("D12: only this computer's spaces, at an absolute folder, have a place", () => {
  const panes = [
    { pane: "p1", terminal: "t1", tab: "a1", cwd: "/code/app" },
    { pane: "p2", terminal: "m1/t2", tab: "m1/b1", cwd: "/code/app" },
    { pane: "p3", terminal: "t3", tab: "c1", cwd: "relative/dir" },
  ];
  const spaces = [spaceOf("a", ["a1"]), spaceOf("m1/b", ["m1/b1"], { machine: "m1" }), spaceOf("c", ["c1"])];
  assert.deepEqual(localPlaces(spaces, panes), [{ id: "a", place: "/code/app" }]);
});

// ── D2: what each terminal gets ─────────────────────────────────────────────

test("D2: a terminal is a Claude, another program, or left alone, and why", () => {
  const t = claude("t1", { pid: 100, fgPid: 200 });
  assert.equal(isShellRoot(["/bin/zsh", "-l"]), true, "rules.js exports its shell check");
  assert.equal(kindOf(t, { claude: true }), "claude");
  assert.equal(kindOf({ ...t, foreground: { name: "node", pid: 200 } }, { claude: true }), "claude", "Claude Code by Core's report, whatever its process is called");
  assert.equal(kindOf({ ...t, foreground: { name: "less", pid: 300 } }, { claude: false }), "program");
  assert.equal(kindOf(shellOf(t), { claude: false }), "shell");
  assert.equal(kindOf({ ...t, address: "m1/t1" }, { claude: true }), "remote");
  assert.equal(kindOf({ ...t, state: "exited" }, { claude: true }), "not-live");
  assert.equal(kindOf({ ...t, parent: "t9" }, { claude: true }), "sub-agent");
  assert.equal(kindOf({ ...t, argv: ["/usr/local/bin/claude"] }, { claude: true }), "root-not-shell");
  assert.equal(kindOf({ ...t, foreground: null }, { claude: false }), "no-foreground");
  for (const state of ["asleep", "stopping"]) assert.equal(kindOf(t, { claude: true, record: { state } }), "asleep", state);
  assert.equal(kindOf(t, { claude: true, record: { state: "live" } }), "claude", "a live record is bookkeeping (agent-sleep D13)");
});

// ── D5: work in flight; D11: the prompt line ────────────────────────────────

test("D5: in flight when Core says working or blocked, or its prompt line may hold unsent text", () => {
  const claudeLine = (state) => ({ program: "claude", state });
  for (const status of ["working", "blocked"]) assert.equal(flightOf({ status, prompt: claudeLine("empty"), visible: false }), "working");
  assert.equal(flightOf({ status: "idle", prompt: claudeLine("empty"), visible: true }), "clear");
  assert.equal(flightOf({ status: "done", prompt: claudeLine("text"), visible: false }), "probe", "a hidden line: the probe tells a draft from a suggestion");
  assert.equal(flightOf({ status: "done", prompt: claudeLine("text"), visible: true }), "text", "the probe never types where you can see it");
  for (const state of ["draft", "dialog", "unknown"]) assert.equal(flightOf({ status: "idle", prompt: claudeLine(state), visible: false }), "text", state);
  assert.equal(flightOf({ status: "idle", prompt: { program: "shell", state: "bare" }, visible: false }), "text", "fail closed");
});

test("D5 (step 4's F2): another agent the sleep would stop is in flight when Core says working or blocked, whatever the agent; its prompt line isn't read", () => {
  for (const status of ["working", "blocked"]) assert.equal(flightOf({ kind: "program", status }), "working", status);
  for (const status of ["idle", "done", null, undefined]) assert.equal(flightOf({ kind: "program", status }), "clear", String(status));
  assert.equal(flightOf({ kind: "claude", status: "idle", prompt: { program: "claude", state: "text" }, visible: false }), "probe", "a Claude keeps its rules");
  assert.equal(flightOf({ status: "idle", prompt: { program: "shell", state: "bare" }, visible: false }), "text", "a Claude's rules by default");
});

test("D11 step 3: an empty line exits; text gets one ctrl+c, then must be empty, or a hidden suggestion", () => {
  const line = (state) => ({ program: "claude", state });
  assert.equal(CLEAR_KEY, "ctrl+c");
  assert.equal(promptStep(line("empty"), { visible: true, cleared: false }), "exit");
  for (const state of ["text", "draft"]) assert.equal(promptStep(line(state), { visible: true, cleared: false }), "clear", state);
  assert.equal(promptStep(line("empty"), { visible: true, cleared: true }), "exit");
  assert.equal(promptStep(line("text"), { visible: false, cleared: true }), "probe");
  assert.equal(promptStep(line("text"), { visible: true, cleared: true }), "refuse");
  assert.equal(promptStep(line("draft"), { visible: false, cleared: true }), "refuse");
  for (const state of ["dialog", "unknown"]) assert.equal(promptStep(line(state), { visible: false, cleared: false }), "refuse", state);
  assert.equal(promptStep({ program: "other", state: "unknown" }, { visible: false, cleared: false }), "refuse");
});

// ── D2 (b): the hang-up ─────────────────────────────────────────────────────

test("D2 (b): `ps -o pgid=,tpgid=` read as two numbers; the hang-up goes to the foreground group, never the shell's own", () => {
  assert.deepEqual(processGroups("66496 69029\n"), { pgid: 66496, tpgid: 69029 });
  assert.deepEqual(processGroups("  72937   72937\n"), { pgid: 72937, tpgid: 72937 });
  for (const bad of ["", "abc", "1 2 3", "12\n", null, "1 -"]) assert.equal(processGroups(bad), null, JSON.stringify(bad));
  assert.equal(hangUpGroup({ pgid: 66496, tpgid: 69029 }), 69029, "T0b item 5: sleep's own group");
  assert.equal(hangUpGroup({ pgid: 72937, tpgid: 72937 }), null, "the shell's own group is in front: no signal");
  assert.equal(hangUpGroup({ pgid: 100, tpgid: 0 }), null, "no terminal");
  assert.equal(hangUpGroup({ pgid: 100, tpgid: -1 }), null);
  assert.equal(hangUpGroup(null), null);
});

// ── D4: the shown edge; D10 step 6 ──────────────────────────────────────────

test("D4: an edge is a space going from not shown to shown; the first look has none", () => {
  const spaces = (active) => ["a", "b"].map((id) => ({ id, active: id === active }));
  assert.deepEqual([...shownEdges(null, spaces("a")).edges], []);
  assert.deepEqual([...shownEdges(null, spaces("a")).shown], ["a"]);
  assert.deepEqual([...shownEdges(new Set(["a"]), spaces("a")).edges], []);
  assert.deepEqual([...shownEdges(new Set(["a"]), spaces("b")).edges], ["b"]);
  assert.deepEqual([...shownEdges(new Set(), spaces("b")).edges], ["b"]);
});

test("D10 step 6: the listed tabs that came back, and only those that still exist", () => {
  const entry = { spaces: { s1: ["a1", "a2", "gone"], s2: ["a3"] }, state: "sleeping", at: NOW };
  const spaces = [
    { id: "s1", tabs: [{ id: "a1", settled: true }, { id: "a2", settled: false }, { id: "new", settled: false }] },
    { id: "s2", tabs: [{ id: "a3", settled: false }] },
  ];
  assert.deepEqual(tabsToSettle(entry, spaces), ["a2", "a3"]);
});

// ── The commands and the toast ──────────────────────────────────────────────

test("the command's name, and the confirm's answers naming the question they answer", () => {
  assert.equal(SLEEP_WORKSPACE, "sleep-workspace");
  assert.deepEqual(parseWorkspaceCommand("sleep-workspace"), { kind: "sleep" });
  assert.equal(answerCommand("q1-7", true), "confirm-sleep.q1-7");
  assert.equal(answerCommand("q1-7", false), "cancel-sleep.q1-7");
  assert.deepEqual(parseWorkspaceCommand("confirm-sleep.q1-7"), { kind: "answer", question: "q1-7", yes: true });
  assert.deepEqual(parseWorkspaceCommand("cancel-sleep.q1-7"), { kind: "answer", question: "q1-7", yes: false });
  for (const name of ["confirm-sleep.", "cancel-sleep.__proto__", "confirm-sleep.a b", "sleep-workspace.", "toString", "constructor", "", 7, null]) {
    assert.equal(parseWorkspaceCommand(name), null, String(name));
  }
});

test("D10's toast: \"<workspace>: <N> terminals didn't stop\", naming each and why", () => {
  assert.equal(didntStopNotice("app", []), null);
  assert.deepEqual(didntStopNotice("app", [{ address: "t1", why: "still working after 10 s" }]), {
    title: "app: 1 terminal didn't stop", body: "t1: still working after 10 s", level: "warning",
  });
  assert.equal(didntStopNotice("app", [{ address: "t1", why: "a" }, { address: "t3", why: "b" }]).title, "app: 2 terminals didn't stop");
  assert.equal(didntStopNotice("app", [{ address: "t1", why: "a" }, { address: "t3", why: "b" }]).body, "t1: a · t3: b");
});

// ── Through the coordinator ─────────────────────────────────────────────────

// /code/app has two spaces, the shown one ("sa") with two tabs; /code/checkout-flow
// one; Inicio only projects-sidebar's pane, in ~ (workspace-sleep D6).
const LAYOUT = [
  { id: "sa", tabs: { a1: [["pa1", "t1", "/code/app"]], a2: [["pa2", "t3", "/code/app"]] } },
  { id: "sa2", tabs: { a3: [["pa3", "t4", "/code/app/src"]] } },
  { id: "sb", tabs: { b1: [["pb1", "t2", "/code/checkout-flow"]] } },
  { id: "inicio", folder: HOME, tabs: { i1: [["pi1", null, null]] } },
];

// The world above with an idle Claude in t1 (tab a1, shown) and in t2 (the
// other workspace), bare shells in t3 and t4; `build` changes it before the
// first pulse, which reads the files and runs the first tick.
async function ready(build = () => {}, { layout = LAYOUT, shown = "sa" } = {}) {
  const { w, co } = workspaceSetup();
  spacesWorld(w, layout, shown);
  addClaude(w, "t1", { pid: 100, fgPid: 200, sid: SID1, screen: IDLE_319, status: IDLE });
  addShell(w, "t3", { pid: 103 });
  addShell(w, "t4", { pid: 104, cwd: "/code/app/src" });
  addClaude(w, "t2", { pid: 101, fgPid: 201, sid: SID2, cwd: "/code/checkout-flow", screen: IDLE_319, status: IDLE });
  build(w);
  await at(co, w, NOW);
  return { w, co };
}

const step = (co, w) => at(co, w, w.now + PULSE_MS);
async function steps(co, w, n) {
  for (let i = 0; i < n; i++) await step(co, w);
}

// The bare command (a key), the pulse that takes it, then the keeper (T2)
// showing Inicio once the tabs are put away.
async function sleepShown(co, w, { keeper = true } = {}) {
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  if (keeper) showSpace(w, "inicio");
}

// A click in the confirm (T7), as a request from the popup this copy opened.
let asked = 0;
async function answer(co, w, yes) {
  w.shared[REQUEST_KEY] = { id: `answer-${++asked}`, owner: COPY, command: answerCommand(co.question.id, yes) };
  await step(co, w);
}

const touched = (w) => ({
  keys: w.keys.map((k) => `${k.address} ${k.key}`),
  sends: w.sends.map((s) => `${s.address} ${s.text}`),
  interrupts: w.interrupts.map((i) => i.address),
  kills: w.kills,
});

// ── Spaces ──

test("Spaces: the shown workspace's two spaces get every tab settled, in one entry keyed by its path; the other workspace is left", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w, { keeper: false });
  assert.deepEqual(entries(w), {
    "/code/app": { spaces: { sa: ["a1", "a2"], sa2: ["a3"] }, state: "sleeping", at: NOW + PULSE_MS },
  });
  assert.deepEqual(w.runs, [["tab.settle", { id: "a1" }], ["tab.settle", { id: "a2" }], ["tab.settle", { id: "a3" }]]);
  assert.deepEqual(settledTabs(w), ["a1", "a2", "a3"]);
  assert.equal(co.view().last, "Putting app to sleep");
});

test("Spaces: a space with panes in two worktrees is its first pane's workspace's, and all its terminals sleep with it", async () => {
  const layout = [
    ...LAYOUT,
    { id: "mixed", tabs: { m1: [["pm1", "t5", "/code/checkout-flow"], ["pm2", "t6", "/code/app"]] } },
  ];
  const { w, co } = await ready((w) => {
    addShell(w, "t5", { pid: 105, cwd: "/code/checkout-flow" });
    addClaude(w, "t6", { pid: 106, fgPid: 206, sid: SID3, screen: IDLE_319, status: IDLE });
  }, { layout, shown: "sb" });
  await sleepShown(co, w);
  assert.deepEqual(Object.keys(entries(w)), ["/code/checkout-flow"]);
  assert.deepEqual(entries(w)["/code/checkout-flow"].spaces, { sb: ["b1"], mixed: ["m1"] });
  await steps(co, w, 3);
  assert.deepEqual(exits(w).map((s) => s.address).sort(), ["t2", "t6"], "t6 is in /code/app, its space isn't");
});

test("Spaces: a space with no terminal pane is no workspace's: Inicio shown → nothing to sleep, and a mod-only space at a checkout isn't listed", async () => {
  const layout = [...LAYOUT, { id: "modonly", folder: "/code/app", tabs: { z1: [["pz1", null, null]] } }];
  const { w, co } = await ready(() => {}, { layout, shown: "inicio" });
  await sleepShown(co, w, { keeper: false });
  assert.deepEqual(entries(w), {});
  assert.deepEqual(w.runs, []);
  assert.equal(co.view().last, "The shown space is in no workspace");
  showSpace(w, "sa");
  await sleepShown(co, w, { keeper: false });
  assert.deepEqual(Object.keys(entries(w)["/code/app"].spaces), ["sa", "sa2"]);
});

test("a workspace already going to sleep isn't slept again", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w, { keeper: false });
  const runs = w.runs.length;
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(w.runs.length, runs);
  assert.equal(co.view().last, "app is already going to sleep");
});

// ── Claudes (D11) ──

test("Claudes: an idle one gets `hc send --if idle … /exit` and ends with an asleep record by: manual; the entry ends asleep", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w);
  assert.equal(exits(w).length, 0, "nothing stops in the pulse that settles");
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => [s.address, s.opts]), [["t1", ["--if", "idle"]]]);
  assert.equal(records(w).t1.state, "stopping");
  assert.equal(records(w).t1.by, "manual");
  assert.equal(Object.hasOwn(records(w).t1, "wake"), false, "it wasn't working");
  exitClaude(w, "t1");
  await steps(co, w, 5);
  assert.equal(records(w).t1.state, "asleep");
  assert.equal(records(w).t1.by, "manual");
  assert.equal(entries(w)["/code/app"].state, "asleep");
  assert.equal(exits(w).length, 1);
  assert.deepEqual(w.notes, [], "every terminal stopped: no toast");
  assert.equal(co.view().last, "app asleep");
});

test("Claudes: a done one gets a plain /exit, as agent-sleep's stop does when Core says done", async () => {
  const { w, co } = await ready((w) => {
    w.core.t1.status = { app: "claude-code", state: "done" };
  });
  await sleepShown(co, w);
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => [s.address, s.opts]), [["t1", []]]);
});

// A working Claude in t1: in flight, so the sleep asks first and goes on with "Sleep".
async function sleepWorking(build = () => {}) {
  const { w, co } = await ready((w) => {
    w.core.t1.status = WORKING;
    build(w);
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question.count, 1);
  await answer(co, w, true);
  showSpace(w, "inicio");
  return { w, co };
}

test("Claudes: a working one is interrupted in one pulse, looked at on later ones until Core reads idle, then /exit with wake: \"now\"", async () => {
  const { w, co } = await sleepWorking();
  await step(co, w);
  assert.deepEqual(w.interrupts, [{ address: "t1", args: ["--timeout", "3", "--json"] }]);
  assert.equal(exits(w).length, 0, "the interrupt's pulse sends nothing more");
  await step(co, w);
  assert.equal(exits(w).length, 0, "Core still says working");
  assert.equal(Object.hasOwn(records(w), "t1"), false, "no record before the interrupt has settled (D9)");
  w.core.t1.status = IDLE;
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => [s.address, s.opts]), [["t1", ["--if", "idle"]]]);
  assert.equal(records(w).t1.wake, "now");
  assert.equal(records(w).t1.by, "manual");
  exitClaude(w, "t1");
  await steps(co, w, 5);
  assert.equal(records(w).t1.state, "asleep");
  assert.equal(records(w).t1.wake, "now", "kept through the stop tail");
  assert.equal(entries(w)["/code/app"].state, "asleep");
  assert.equal(w.interrupts.length, 1);
  assert.equal(INTERRUPTED.trim(), '{"key":"esc","outcome":"stopped"}', "T0b's report, which decides nothing");
});

test("Claudes: still working 10 s after the interrupt → it keeps running and the toast counts it", async () => {
  const { w, co } = await sleepWorking();
  await step(co, w);
  const interruptedAt = w.now;
  while (w.now - interruptedAt < INTERRUPT_DEADLINE_MS + 2 * PULSE_MS) await step(co, w);
  assert.equal(exits(w).length, 0);
  assert.equal(Object.hasOwn(records(w), "t1"), false);
  assert.deepEqual(w.keys, []);
  await steps(co, w, 4);
  assert.deepEqual(w.notes.map((n) => n.title), ["app: 1 terminal didn't stop"]);
  assert.match(w.notes[0].body, /^t1: still working/);
  assert.equal(entries(w)["/code/app"].state, "asleep", "the rest of the workspace sleeps");
});

test("Claudes: a tab an interrupt brought back (T0b item 8) is settled again before the entry is asleep", async () => {
  const { w, co } = await sleepWorking((w) => {
    w.onInterrupt = (address, w) => {
      w.core[address].status = IDLE;
      for (const s of w.spaces) s.tabs = s.tabs.map((t) => (t.id === "a1" ? { ...t, settled: false } : t));
    };
  });
  await step(co, w);
  assert.equal(settledTabs(w).includes("a1"), false, "Herdr brought it back");
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  exitClaude(w, "t1");
  await steps(co, w, 5);
  assert.equal(entries(w)["/code/app"].state, "asleep");
  assert.deepEqual(settledTabs(w), ["a1", "a2", "a3"]);
  assert.deepEqual(w.runs.filter(([, a]) => a.id === "a1").map(([n]) => n), ["tab.settle", "tab.settle"]);
});

test("Claudes: a draft on a hidden terminal is cleared with one ctrl+c; the probe says what's left is a suggestion, then /exit", async () => {
  const PROBED = SUGGESTION.replace("reply with the single word ok", "x");
  const { w, co } = await ready((w) => {
    w.screens.t1 = DRAFT_319;
    w.onKey.t1 = (key, screen) => (key === "ctrl+c" ? SUGGESTION : key === "x" ? PROBED : key === "backspace" ? SUGGESTION : screen);
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question.count, 1, "text on a shown terminal is in flight");
  await answer(co, w, true);
  showSpace(w, "inicio");
  await step(co, w);
  assert.deepEqual(w.keys.map((k) => `${k.address} ${k.key}`), ["t1 ctrl+c", "t1 x", "t1 backspace"]);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
});

test("Claudes: a two-line draft is cleared by one ctrl+c (T0b item 4), then /exit", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: MULTI_319, status: IDLE });
    w.onKey.t3 = (key, screen) => (key === "ctrl+c" ? CLEARED_319 : screen);
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question.count, 1, "a hidden two-line draft is in flight with no probe");
  assert.deepEqual(w.keys, []);
  await answer(co, w, true);
  showSpace(w, "inicio");
  await steps(co, w, 2);
  assert.deepEqual(w.keys.map((k) => `${k.address} ${k.key}`), ["t3 ctrl+c"]);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1", "t3"]);
});

test("Claudes: a draft that won't clear on a hidden terminal → no /exit, counted in the toast", async () => {
  const HOLAX = DRAFT_319.replace("hola", "holax");
  const { w, co } = await ready((w) => {
    w.screens.t1 = DRAFT_319;
    w.onKey.t1 = (key, screen) => (key === "x" ? HOLAX : key === "backspace" ? DRAFT_319 : screen);
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  await answer(co, w, true);
  showSpace(w, "inicio");
  await steps(co, w, 6);
  assert.deepEqual(w.keys.map((k) => `${k.address} ${k.key}`), ["t1 ctrl+c", "t1 x", "t1 backspace"]);
  assert.equal(exits(w).length, 0);
  assert.deepEqual(w.notes.map((n) => n.title), ["app: 1 terminal didn't stop"]);
  assert.match(w.notes[0].body, /^t1: /);
});

test("Claudes: text on a terminal still shown (no keeper: shownAtSleep) → one ctrl+c, never the probe, no /exit, counted", async () => {
  const { w, co } = await ready((w) => {
    w.screens.t1 = DRAFT_319;
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  await answer(co, w, true);
  await steps(co, w, WAIT_PULSES + 4);
  assert.equal(entries(w)["/code/app"].shownAtSleep, true);
  assert.deepEqual(w.keys.map((k) => `${k.address} ${k.key}`), ["t1 ctrl+c"]);
  assert.equal(exits(w).length, 0);
  assert.deepEqual(w.notes.map((n) => n.title), ["app: 1 terminal didn't stop"]);
});

test("Claudes: one that couldn't come back keeps running, working or not: never interrupted, typed into or signalled, counted", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t1", { pid: 100, fgPid: 200, sid: SID1, screen: IDLE_319, status: WORKING, flags: ["--agent-id", "x"] });
    addProgram(w, "t3", { pid: 103, fgPid: 303 });
    w.onInterrupt = (address, w) => {
      if (address === "t3") w.core.t3 = shellOf(w.core.t3);
    };
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question, null, "one that won't be stopped isn't in flight");
  showSpace(w, "inicio");
  await steps(co, w, 8);
  assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: ["t3"], kills: [] });
  assert.deepEqual(w.notes.map((n) => n.title), ["app: 1 terminal didn't stop"]);
  assert.match(w.notes[0].body, /^t1: /);
  assert.equal(Object.hasOwn(records(w), "t1"), false);
});

// ── Other programs (D2 b) ──

test("Other programs: interrupted; still in front past the grace → SIGHUP to -<tpgid>; the shell back → done", async () => {
  const { w, co } = await ready((w) => {
    addShell(w, "t1", { pid: 100 });
    addProgram(w, "t3", { pid: 103, fgPid: 303 });
    w.onKill = (args, w) => {
      if (args.at(-1) === "-303") w.core.t3 = shellOf(w.core.t3);
    };
  });
  await sleepShown(co, w);
  await step(co, w);
  assert.deepEqual(w.interrupts.map((i) => [i.address, ...i.args]), [["t3", "--timeout", "3", "--json"]], "t1's bare shell takes no pulse");
  const interruptedAt = w.now;
  while (w.now - interruptedAt < PROGRAM_GRACE_MS - PULSE_MS) {
    await step(co, w);
    assert.deepEqual(w.kills, [], "Core may lag behind an interrupt that worked (T0b item 7)");
  }
  await step(co, w);
  assert.deepEqual(w.kills, [["-HUP", "--", "-303"]]);
  assert.ok(w.execs.some((e) => e.join(" ") === "ps -o pgid=,tpgid= -p 103"), "the group is read from the root's pid");
  await steps(co, w, 4);
  assert.equal(w.kills.length, 1);
  assert.deepEqual(w.notes, []);
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

test("Other programs: one the interrupt stopped gets no signal", async () => {
  const { w, co } = await ready((w) => {
    addShell(w, "t1", { pid: 100 });
    addProgram(w, "t3", { pid: 103, fgPid: 303 });
    w.onInterrupt = (address, w) => {
      w.core[address] = shellOf(w.core[address]);
    };
  });
  await sleepShown(co, w);
  await steps(co, w, 8);
  assert.deepEqual(w.interrupts.map((i) => i.address), ["t3"]);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.notes, []);
});

test("Other programs: a tpgid equal to the root's pgid → no signal; still shown in front, it is counted", async () => {
  const { w, co } = await ready((w) => {
    addShell(w, "t1", { pid: 100 });
    addProgram(w, "t3", { pid: 103, fgPid: 303 });
    w.pgids[103] = { pgid: 103, tpgid: 103 };
  });
  await sleepShown(co, w);
  await steps(co, w, 12);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.notes.map((n) => n.title), ["app: 1 terminal didn't stop"]);
  assert.match(w.notes[0].body, /^t3: /);
});

// ── Untouched (D2) ──

test("Untouched: the shell, and paneless, sub-agent, remote and root-not-shell terminals", async () => {
  const layout = [
    { id: "sa", tabs: { a1: [["pa1", "t1", "/code/app"], ["pa5", "t5", "/code/app"]], a2: [["pa7", "m1/t7", "/code/app"], ["pa8", "t8", "/code/app"]] } },
    { id: "inicio", folder: HOME, tabs: { i1: [["pi1", null, null]] } },
  ];
  const { w, co } = await ready((w) => {
    addShell(w, "t1", { pid: 100 });
    addClaude(w, "t5", { pid: 105, fgPid: 205, sid: SID3, screen: IDLE_319, status: WORKING, parent: "t1" });
    addClaude(w, "m1/t7", { pid: 107, fgPid: 207, sid: SID4, screen: IDLE_319, status: WORKING });
    addClaude(w, "t8", { pid: 108, fgPid: 208, sid: SID4, screen: DRAFT_319, status: WORKING, argv: ["/usr/local/bin/claude"] });
    addClaude(w, "t6", { pid: 106, fgPid: 206, sid: SID4, screen: DRAFT_319, status: WORKING }); // no pane
  }, { layout });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question, null, "none of them counts as in flight");
  showSpace(w, "inicio");
  await steps(co, w, 8);
  assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: [], kills: [] });
  assert.deepEqual(w.notes, [], "left alone isn't a stop that failed");
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

// ── In flight (D5) ──

test("In flight: the request is raised and nothing changes until its answer; Cancel changes nothing", async () => {
  const { w, co } = await ready((w) => {
    w.core.t1.status = WORKING;
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question.count, 1);
  assert.equal(co.question.path, "/code/app");
  assert.deepEqual(co.view().question, { id: co.question.id, label: "app", count: 1 }, "what the confirm (T7) draws");
  const nothing = () => {
    assert.equal(Object.hasOwn(w.files, WORKSPACES), false);
    assert.deepEqual(w.runs, []);
    assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: [], kills: [] });
  };
  nothing();
  await steps(co, w, 3);
  nothing();
  assert.notEqual(co.question, null, "it waits for its answer");
  await answer(co, w, false);
  assert.equal(co.question, null);
  await steps(co, w, 3);
  nothing();
  assert.equal(co.view().question, null);
});

test("In flight: an answer to an older question does nothing; Sleep on the current one goes on without asking again", async () => {
  const { w, co } = await ready((w) => {
    w.core.t1.status = WORKING;
  });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  const old = co.question.id;
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.notEqual(co.question.id, old, "a new request asks again");
  w.shared[REQUEST_KEY] = { id: "stale", owner: COPY, command: answerCommand(old, true) };
  await step(co, w);
  assert.equal(Object.hasOwn(w.files, WORKSPACES), false);
  assert.notEqual(co.question, null);
  await answer(co, w, true);
  assert.equal(co.question, null);
  assert.equal(entries(w)["/code/app"].state, "sleeping");
  assert.deepEqual(settledTabs(w), ["a1", "a2", "a3"]);
});

test("In flight: working, text where you can see it, a hidden draft; not a hidden suggestion, an empty line or one that can't come back", async () => {
  const PROBED = SUGGESTION.replace("reply with the single word ok", "x");
  const HOLAX = DRAFT_319.replace("hola", "holax");
  const layout = [
    { id: "sa", tabs: { a1: [["pa1", "t1", "/code/app"]], a2: [["pa3", "t3", "/code/app"], ["pa5", "t5", "/code/app"]] } },
    { id: "sa2", tabs: { a3: [["pa4", "t4", "/code/app"], ["pa6", "t6", "/code/app"], ["pa7", "t7", "/code/app"]] } },
    { id: "inicio", folder: HOME, tabs: { i1: [["pi1", null, null]] } },
  ];
  const { w, co } = await ready((w) => {
    w.screens.t1 = DRAFT_319; // shown: no probe
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: DRAFT_319, status: IDLE });
    w.onKey.t3 = (key, screen) => (key === "x" ? HOLAX : key === "backspace" ? DRAFT_319 : screen);
    addClaude(w, "t5", { pid: 105, fgPid: 205, sid: SID4, screen: SUGGESTION, status: IDLE });
    w.onKey.t5 = (key, screen) => (key === "x" ? PROBED : key === "backspace" ? SUGGESTION : screen);
    addClaude(w, "t4", { pid: 104, fgPid: 204, sid: SID2, screen: IDLE_319, status: WORKING });
    addClaude(w, "t6", { pid: 106, fgPid: 206, sid: SID2, screen: IDLE_319, status: IDLE });
    addClaude(w, "t7", { pid: 107, fgPid: 207, sid: SID2, screen: DRAFT_319, status: WORKING, flags: ["--agent-id", "x"] });
  }, { layout });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question.count, 3, "t1, t3 and t4");
  assert.deepEqual(w.keys.map((k) => `${k.address} ${k.key}`), ["t3 x", "t3 backspace", "t5 x", "t5 backspace"]);
});

// Another agent (OSC 7501: Codex, pi, the tester's `app=fake`) in front of its
// zsh root: a program as addProgram makes one, whose Core status names its app.
function addAgent(w, address, { pid, fgPid, app, state, name = app }) {
  addProgram(w, address, { pid, fgPid, name });
  w.core[address].status = { app, state };
}

test("In flight (step 4's F2): a working agent that isn't Claude asks first too; Cancel leaves it running, and Sleep stops it as before", async () => {
  const { w, co } = await ready((w) => {
    addShell(w, "t1", { pid: 100 });
    addAgent(w, "t3", { pid: 103, fgPid: 303, app: "fake", state: "working" });
    w.onKill = (args, w) => {
      if (args.at(-1) === "-303") w.core.t3 = shellOf(w.core.t3);
    };
  });
  const nothing = () => {
    assert.equal(Object.hasOwn(w.files, WORKSPACES), false);
    assert.deepEqual(w.runs, []);
    assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: [], kills: [] });
  };
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.deepEqual(co.view().question, { id: co.question?.id, label: "app", count: 1 }, "the fake agent is working");
  nothing();
  await answer(co, w, false);
  await steps(co, w, 3);
  nothing();
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  await answer(co, w, true);
  showSpace(w, "inicio");
  await steps(co, w, 8);
  assert.deepEqual(w.interrupts.map((i) => i.address), ["t3"], "what Sleep does is unchanged: the interrupt");
  assert.deepEqual(w.kills, [["-HUP", "--", "-303"]], "then the hang-up, still in front past the grace");
  assert.equal(entries(w)["/code/app"].state, "asleep");
});

test("In flight (step 4's F2): N counts each agent the sleep would stop that Core says is working or blocked, Claude or not; not an idle or done one, a program with no status, or an agent it leaves alone", async () => {
  const layout = [
    { id: "sa", tabs: { a1: [["pa1", "t1", "/code/app"]], a2: [["pa3", "t3", "/code/app"], ["pa5", "t5", "/code/app"]] } },
    { id: "sa2", tabs: { a3: [["pa4", "t4", "/code/app"], ["pa6", "t6", "/code/app"], ["pa7", "t7", "/code/app"]], a4: [["pa8", "t8", "/code/app"], ["pa10", "t10", "/code/app"]] } },
    { id: "inicio", folder: HOME, tabs: { i1: [["pi1", null, null]] } },
  ];
  const { w, co } = await ready((w) => {
    w.core.t1.status = WORKING; // a Claude, as before
    addAgent(w, "t3", { pid: 103, fgPid: 303, app: "codex", state: "working" });
    addAgent(w, "t5", { pid: 105, fgPid: 305, app: "pi", state: "blocked" });
    addAgent(w, "t4", { pid: 104, fgPid: 304, app: "codex", state: "idle" });
    addAgent(w, "t6", { pid: 106, fgPid: 306, app: "fake", state: "done" });
    addProgram(w, "t7", { pid: 107, fgPid: 307 }); // `sleep 300`: no status
    addAgent(w, "t8", { pid: 108, fgPid: 308, app: "codex", state: "working" });
    w.core.t8.argv = ["/usr/local/bin/codex"]; // its own program: root-not-shell, never stopped
    addAgent(w, "t10", { pid: 110, fgPid: 310, app: "codex", state: "working" });
    w.core.t10.parent = "t1"; // a sub-agent: never stopped
  }, { layout });
  co.command(SLEEP_WORKSPACE);
  await step(co, w);
  assert.equal(co.question?.count, 3, "t1, t3 and t5");
  assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: [], kills: [] });
});

// ── Order (D10) ──

test("Order: the stops wait while a space of it is shown, up to 3 pulses, then shownAtSleep and they start", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w, { keeper: false });
  for (let i = 1; i < WAIT_PULSES; i++) {
    await step(co, w);
    assert.equal(exits(w).length, 0, `pulse ${i}`);
    assert.equal(Object.hasOwn(entries(w)["/code/app"], "shownAtSleep"), false);
  }
  await step(co, w);
  assert.equal(entries(w)["/code/app"].shownAtSleep, true);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"], "an empty prompt line may exit where you see it");
});

test("Order: one terminal's step per pulse, and no pulse waits on hc wait", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE });
    addClaude(w, "t4", { pid: 104, fgPid: 204, sid: SID4, screen: IDLE_319, status: IDLE, cwd: "/code/app/src" });
  });
  await sleepShown(co, w);
  const sent = [];
  for (let i = 0; i < 3; i++) {
    await step(co, w);
    sent.push(exits(w).length);
  }
  assert.deepEqual(sent, [1, 2, 3]);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1", "t3", "t4"]);
  assert.equal(w.calls.some((c) => c[0] === "wait" || c.includes("--wait")), false);
});

// ── workspaces.json (D9) ──

test("workspaces.json: a stale compare-and-swap reloads and retries, keeping what the other write put there", async () => {
  const { w, co } = await ready();
  const other = { spaces: { sb: ["b1"] }, state: "asleep", at: NOW };
  w.files[WORKSPACES] = `${JSON.stringify({ version: 1, workspaces: { "/code/checkout-flow": other } })}\n`;
  await sleepShown(co, w, { keeper: false });
  assert.deepEqual(Object.keys(entries(w)).sort(), ["/code/app", "/code/checkout-flow"]);
  assert.deepEqual(entries(w)["/code/checkout-flow"], other);
  assert.ok(w.logs.some((l) => l.includes("workspaces.json changed under it")));
});

test("workspaces.json: an invalid file → no entries, kept as .bak; a sleep then writes a fresh one", async () => {
  const { w, co } = await ready((w) => {
    w.files[WORKSPACES] = "{ broken";
  });
  assert.equal(w.files[`${WORKSPACES}.bak`], "{ broken");
  await sleepShown(co, w, { keeper: false });
  assert.deepEqual(Object.keys(entries(w)), ["/code/app"]);
});

// ── Reconcile (D9's rules) through the coordinator ──

test("Reconcile: one of its two spaces closed → dropped from the entry; the last one closed → the entry dropped", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w);
  exitClaude(w, "t1");
  await steps(co, w, 6);
  assert.equal(entries(w)["/code/app"].state, "asleep");
  w.spaces = w.spaces.filter((s) => s.id !== "sa2");
  await at(co, w, NOW + 2 * 60_000);
  assert.deepEqual(entries(w)["/code/app"].spaces, { sa: ["a1", "a2"] });
  w.spaces = w.spaces.filter((s) => s.id !== "sa");
  await at(co, w, NOW + 3 * 60_000);
  assert.deepEqual(entries(w), {});
});

test("Reconcile: an asleep entry whose tabs were all brought back by hand is dropped", async () => {
  const { w, co } = await ready();
  await sleepShown(co, w);
  exitClaude(w, "t1");
  await steps(co, w, 6);
  for (const s of w.spaces) s.tabs = s.tabs.map((t) => ({ ...t, settled: false }));
  await at(co, w, NOW + 2 * 60_000);
  assert.deepEqual(entries(w), {});
});

test("Reconcile: a reload between steps 2 and 3 (entry written, no tab settled) → dropped at start, nothing stopped", async () => {
  const { w } = await ready();
  w.files[WORKSPACES] = `${JSON.stringify({ version: 1, workspaces: { "/code/app": { spaces: { sa: ["a1", "a2"], sa2: ["a3"] }, state: "sleeping", at: NOW } } })}\n`;
  showSpace(w, "inicio");
  const fresh = new Coordinator({ ...deps(w), copyId: "after-reload" });
  await at(fresh, w, NOW + PULSE_MS);
  await steps(fresh, w, 5);
  assert.deepEqual(entries(w), {});
  assert.deepEqual(touched(w), { keys: [], sends: [], interrupts: [], kills: [] });
  assert.deepEqual(w.runs, []);
});

test("Reconcile: a reload during step 5 → steps 4–5 planned again; what already slept is skipped, and it ends asleep", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE });
  });
  await sleepShown(co, w);
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  exitClaude(w, "t1");
  const fresh = new Coordinator({ ...deps(w), copyId: "after-reload" });
  await step(fresh, w);
  assert.equal(records(w).t1.state, "asleep", "the reload's own stop tail");
  await steps(fresh, w, 2);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1", "t3"], "t1 not stopped twice");
  exitClaude(w, "t3");
  await steps(fresh, w, 5);
  assert.equal(entries(w)["/code/app"].state, "asleep");
  assert.equal(records(w).t3.state, "asleep");
});

test("Reconcile: a click on its row during step 5 → wakeAfter, the rest of the queue dropped, no further /exit", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE });
    addClaude(w, "t4", { pid: 104, fgPid: 204, sid: SID4, screen: IDLE_319, status: IDLE, cwd: "/code/app/src" });
  });
  await sleepShown(co, w);
  await step(co, w);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  showSpace(w, "sa2"); // the row's click selects one of its spaces
  await step(co, w);
  assert.equal(entries(w)["/code/app"].wakeAfter, true);
  await steps(co, w, 8);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  assert.equal(entries(w)["/code/app"].state, "sleeping", "step 6 wakes it instead (T4)");
});

test("Reconcile: a space already shown at the first pulse after a reload isn't an edge", async () => {
  const { w, co } = await ready((w) => {
    addClaude(w, "t3", { pid: 103, fgPid: 203, sid: SID3, screen: IDLE_319, status: IDLE });
  });
  await sleepShown(co, w, { keeper: false });
  const fresh = new Coordinator({ ...deps(w), copyId: "after-reload" });
  await steps(fresh, w, WAIT_PULSES + 3);
  assert.equal(Object.hasOwn(entries(w)["/code/app"], "wakeAfter"), false);
  assert.equal(entries(w)["/code/app"].shownAtSleep, true);
});

// ── The command table ──

test("the bare command and the answers go through command(); the popup's table stays as it is", async () => {
  const { co } = await ready();
  assert.equal(co.command(SLEEP_WORKSPACE), true);
  assert.equal(co.command("confirm-sleep.no-such-question"), true, "a well-formed answer is taken, and answers nothing");
  assert.equal(co.command("confirm-sleep."), false);
  assert.equal(co.command("sleep-workspace.0123456789ab"), false, "T6's targets aren't here yet");
  assert.equal(SLEEPING.endsWith("/agent-sleep/sleeping.json"), true);
});
