// T1: the rules engine (A/rules.js). One snapshot in (Core terminals, Herdr's
// spaces/panes/focus, what this mod has seen, validated sessions, screen
// hashes, settings, records, failed-until), and out come the candidates plus
// one reason code for every other terminal (D7); visibility and lastSeen
// (D6); the signature and the two-tick confirmation with its gap reset (D2);
// manual mode, which skips only the idle window ("Sleep now", D9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TICK_MS, DEFAULT_IDLE_MINUTES, REASONS,
  idleWindowMs, visibleTerminals, observe, hashScreen, signatureOf,
  planSleep, needsScreen, confirm, stillCandidate,
} from "../mods/agent-sleep/rules.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const SID = "8f3c2a91-0000-4000-8000-000000000001";
const SCREEN = hashScreen('❯ Try "fix lint errors"');

// A Claude in a zsh root, as `hc get t1p --json` shows one (trimmed): it
// finished an hour ago, three turns in.
function claudeTerminal(address, over = {}) {
  return {
    address,
    argv: ["/bin/zsh", "-l"],
    state: "live",
    parent: null,
    foreground: {
      argv: ["/Users/demo/.nvm/versions/node/v24.14.0/bin/claude", "--dangerously-skip-permissions"],
      cwd: "/code/app",
      name: "claude.exe",
      pid: 70285,
    },
    status: { app: "claude-code", state: "done" },
    status_ms: NOW - 60 * MIN,
    turn: 3,
    ...over,
  };
}

// A shell at its prompt: no agent status.
function shellTerminal(address, over = {}) {
  return {
    address,
    argv: ["/bin/zsh", "-l"],
    state: "live",
    parent: null,
    foreground: { argv: ["/bin/zsh", "-l"], cwd: "/code/app", name: "zsh", pid: 4242 },
    status: null,
    status_ms: null,
    turn: 0,
    ...over,
  };
}

// Space s1 is shown, on its tab "shown" (t9, a shell, focused); t1's Claude
// sits in s1's other tab "back". Space s2 isn't shown; its own active tab is
// "elsewhere".
function snapshot(over = {}) {
  return {
    now: NOW,
    manual: false,
    settings: { enabled: true, idleMinutes: 30 },
    terminals: [claudeTerminal("t1"), shellTerminal("t9")],
    spaces: [
      { id: "s1", active: true, tabs: [{ id: "shown", active: true }, { id: "back", active: false }] },
      { id: "s2", active: false, tabs: [{ id: "elsewhere", active: true }] },
    ],
    panes: [
      { pane: "p9", terminal: "t9", tab: "shown" },
      { pane: "p1", terminal: "t1", tab: "back" },
    ],
    focused: { space: "s1", tab: "shown", pane: "p9", terminal: "t9", shown: null, agent: null, cwd: "/code/app" },
    previousVisible: [],
    lastSeen: {},
    firstSeen: { t1: NOW - 120 * MIN, t9: NOW - 120 * MIN },
    sessions: { t1: { sessionId: SID, transcript: true } },
    screens: { t1: SCREEN },
    records: {},
    failedUntil: {},
    ...over,
  };
}

// t1 with some fields changed, next to the shell t9.
const withT1 = (over) => ({ terminals: [claudeTerminal("t1", over), shellTerminal("t9")] });
const reasonOf = (over, address = "t1") => planSleep(snapshot(over)).reasons[address];
const candidateIds = (over) => planSleep(snapshot(over)).candidates.map((c) => c.address);

// Every terminal is either a candidate or has exactly one reason.
function assertAccounted(result, terminals) {
  const ids = terminals.map((t) => t.address).sort();
  const got = [...result.candidates.map((c) => c.address), ...Object.keys(result.reasons)].sort();
  assert.deepEqual(got, ids);
  for (const reason of Object.values(result.reasons)) assert.ok(REASONS.includes(reason), reason);
}

test("baseline: a Claude that finished an hour ago in a hidden tab is a candidate; the shell gets a reason", () => {
  const snap = snapshot();
  const result = planSleep(snap);
  assert.deepEqual(result.candidates.map((c) => c.address), ["t1"]);
  const [c] = result.candidates;
  assert.equal(c.sessionId, SID);
  assert.equal(c.state, "done");
  assert.equal(c.statusMs, NOW - 60 * MIN);
  assert.equal(c.turn, 3);
  assert.equal(c.idleStart, NOW - 60 * MIN);
  assert.equal(c.signature, signatureOf({ address: "t1", state: "done", statusMs: NOW - 60 * MIN, turn: 3, sessionId: SID, screenHash: SCREEN }));
  assert.deepEqual(result.reasons, { t9: "not-claude" });
  assertAccounted(result, snap.terminals);
});

test("planSleep is pure: a deep-frozen snapshot is read, never written", () => {
  const freeze = (o) => {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) freeze(v);
      Object.freeze(o);
    }
    return o;
  };
  const snap = freeze(snapshot({ previousVisible: ["t1"], lastSeen: { t1: NOW - 90 * MIN } }));
  assert.doesNotThrow(() => planSleep(snap));
  assert.doesNotThrow(() => observe(snap));
  // The module never imports herdr, or anything: snapshot in, decisions out.
  const src = readFileSync(new URL("../mods/agent-sleep/rules.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\brequire\(|\bDate\.now\(|\bperformance\.now\(/);
});

test("visible: a pane in the shown space's active tab", () => {
  const panes = [
    { pane: "p9", terminal: "t9", tab: "shown" },
    { pane: "p1", terminal: "t1", tab: "shown" },
  ];
  assert.equal(reasonOf({ panes }), "visible");
});

test("visible: focused().terminal (a layout terminal block), .shown and .agent", () => {
  const focus = (extra) => ({ space: "s1", tab: "shown", pane: null, terminal: "t9", shown: null, agent: null, cwd: null, ...extra });
  assert.equal(reasonOf({ focused: focus({ terminal: "t1" }) }), "visible");
  assert.equal(reasonOf({ focused: focus({ shown: "t1" }) }), "visible");
  assert.equal(reasonOf({ focused: focus({ agent: "t1" }) }), "visible");
});

test("visible: not a hidden tab, and not the active tab of a space that isn't shown", () => {
  assert.deepEqual(candidateIds(), ["t1"]);
  const panes = [
    { pane: "p9", terminal: "t9", tab: "shown" },
    { pane: "p1", terminal: "t1", tab: "elsewhere" },
  ];
  assert.deepEqual(candidateIds({ panes }), ["t1"]);
  // focused().tab counts as shown too (the window context), even when
  // spaces() says otherwise.
  const focused = { space: "s1", tab: "back", pane: null, terminal: null, shown: null, agent: null, cwd: null };
  assert.equal(reasonOf({ focused }), "visible");
});

test("visibleTerminals: panes of the shown tab plus focus's terminal, shown and agent", () => {
  const got = visibleTerminals({
    spaces: snapshot().spaces,
    panes: [
      { pane: "p9", terminal: "t9", tab: "shown" },
      { pane: "pm", terminal: null, mod: "projects", tab: "shown" },
      { pane: "p1", terminal: "t1", tab: "back" },
    ],
    focused: { space: "s1", tab: "shown", pane: "p9", terminal: "t9", shown: "t4", agent: "t5", cwd: null },
  });
  assert.deepEqual([...got].sort(), ["t4", "t5", "t9"]);
  assert.deepEqual([...visibleTerminals({})], []);
  assert.deepEqual([...visibleTerminals({ spaces: null, panes: null, focused: null })], []);
});

test("working, blocked and error never sleep, as Core's object or as Herdr's plain word", () => {
  for (const state of ["working", "blocked", "error"]) {
    assert.equal(reasonOf(withT1({ status: { app: "claude-code", state } })), state, state);
    assert.equal(reasonOf(withT1({ status: state })), state, `${state} (plain word)`);
  }
  assert.equal(reasonOf(withT1({ status: null })), "no-status");
  assert.equal(reasonOf(withT1({ status: { app: "claude-code" } })), "no-status");
  assert.equal(reasonOf(withT1({ status: "napping" })), "unknown-status");
  // done and idle are the only words that can sleep, in either shape.
  assert.deepEqual(candidateIds(withT1({ status: "done" })), ["t1"]);
  assert.deepEqual(candidateIds(withT1({ status: { app: "claude-code", state: "idle" } })), ["t1"]);
});

test("idle with turn 0 never sleeps (started, never asked anything); done with turn 0 can", () => {
  const idle = { app: "claude-code", state: "idle" };
  assert.equal(reasonOf(withT1({ status: idle, turn: 0 })), "idle-turn-0");
  assert.equal(reasonOf(withT1({ status: idle, turn: undefined })), "idle-turn-0");
  assert.deepEqual(candidateIds(withT1({ status: idle, turn: 1 })), ["t1"]);
  assert.deepEqual(candidateIds(withT1({ turn: 0 })), ["t1"]);
});

test("no transcript: a valid session whose transcript wasn't found", () => {
  assert.equal(reasonOf({ sessions: { t1: { sessionId: SID, transcript: false } } }), "no-transcript");
  assert.equal(reasonOf({ sessions: { t1: { sessionId: SID } } }), "no-transcript");
});

test("invalid session: none validated for that terminal, or no id", () => {
  assert.equal(reasonOf({ sessions: {} }), "invalid-session");
  assert.equal(reasonOf({ sessions: undefined }), "invalid-session");
  assert.equal(reasonOf({ sessions: { t1: null } }), "invalid-session");
  assert.equal(reasonOf({ sessions: { t1: { sessionId: "", transcript: true } } }), "invalid-session");
  assert.equal(reasonOf({ sessions: { t1: { sessionId: 42, transcript: true } } }), "invalid-session");
  // Another terminal's session doesn't count.
  assert.equal(reasonOf({ sessions: { t2: { sessionId: SID, transcript: true } } }), "invalid-session");
});

test("child terminal: a live terminal started by this one blocks it; a finished one doesn't", () => {
  const child = (state) => ({ ...shellTerminal("t2", { parent: "t1", state }), argv: ["/bin/zsh"] });
  const live = snapshot({ terminals: [claudeTerminal("t1"), shellTerminal("t9"), child("live")] });
  const result = planSleep(live);
  assert.equal(result.reasons.t1, "has-child");
  assert.equal(result.reasons.t2, "sub-agent");
  assertAccounted(result, live.terminals);
  assert.deepEqual(candidateIds({ terminals: [claudeTerminal("t1"), shellTerminal("t9"), child("finished")] }), ["t1"]);
});

test("root-not-shell: /exit would end the terminal itself", () => {
  const claudeRoot = ["/Users/demo/.nvm/versions/node/v24.14.0/bin/claude", "--dangerously-skip-permissions"];
  assert.equal(reasonOf(withT1({ argv: claudeRoot })), "root-not-shell");
  assert.equal(reasonOf(withT1({ argv: [] })), "root-not-shell");
  assert.equal(reasonOf(withT1({ argv: undefined })), "root-not-shell");
  assert.equal(reasonOf(withT1({ argv: "zsh" })), "root-not-shell");
  // Login shells, other shells and bare names are shells.
  for (const argv0 of ["-zsh", "/bin/bash", "/opt/homebrew/bin/fish", "sh", "/usr/bin/dash"]) {
    assert.deepEqual(candidateIds(withT1({ argv: [argv0] })), ["t1"], argv0);
  }
});

test("sub-agent: a terminal another terminal started", () => {
  assert.equal(reasonOf(withT1({ parent: "t9" })), "sub-agent");
  // Core's default for parent is null: a missing field is a root.
  assert.deepEqual(candidateIds(withT1({ parent: undefined })), ["t1"]);
});

test("no-pane: a terminal with no pane in any tab can't be revealed", () => {
  assert.equal(reasonOf({ panes: [{ pane: "p9", terminal: "t9", tab: "shown" }] }), "no-pane");
  assert.equal(reasonOf({ panes: undefined }), "no-pane");
});

test("remote: an address with a machine prefix", () => {
  const snap = snapshot({
    terminals: [claudeTerminal("mbp/t7"), shellTerminal("t9")],
    panes: [{ pane: "p9", terminal: "t9", tab: "shown" }, { pane: "mbp/p7", terminal: "mbp/t7", tab: "back" }],
    firstSeen: { "mbp/t7": NOW - 120 * MIN },
    sessions: { "mbp/t7": { sessionId: SID, transcript: true } },
    screens: { "mbp/t7": SCREEN },
  });
  assert.equal(planSleep(snap).reasons["mbp/t7"], "remote");
});

test("not-live and not-claude: a finished terminal, and a foreground that isn't Claude", () => {
  assert.equal(reasonOf(withT1({ state: "finished", foreground: null })), "not-live");
  assert.equal(reasonOf(withT1({ foreground: { argv: ["node"], cwd: "/code/app", name: "node", pid: 7 } })), "not-claude");
  assert.equal(reasonOf(withT1({ foreground: null })), "not-claude");
  assert.deepEqual(candidateIds(withT1({ foreground: { ...claudeTerminal("t1").foreground, name: "claude" } })), ["t1"]);
});

test("records: already asleep, or mid-stop, never planned again; a live record doesn't block", () => {
  const rec = (state) => ({ t1: { state, sessionId: SID } });
  assert.equal(reasonOf({ records: rec("asleep") }), "asleep");
  assert.equal(reasonOf({ records: rec("stopping") }), "stopping");
  assert.equal(reasonOf({ records: rec("dreaming") }), "bad-record");
  assert.deepEqual(candidateIds({ records: rec("live") }), ["t1"]);
});

test("failed-until: blocked while now is before it", () => {
  assert.equal(reasonOf({ failedUntil: { t1: NOW + 1 } }), "failed-until");
  assert.equal(reasonOf({ failedUntil: { t1: NOW + 30 * MIN } }), "failed-until");
  assert.deepEqual(candidateIds({ failedUntil: { t1: NOW } }), ["t1"]);
  assert.deepEqual(candidateIds({ failedUntil: { t1: NOW - 1 } }), ["t1"]);
  assert.deepEqual(candidateIds({ failedUntil: { t9: NOW + MIN } }), ["t1"]);
});

test("disabled: automatic sleep off puts every terminal on `disabled`", () => {
  const snap = snapshot({ settings: { enabled: false, idleMinutes: 30 } });
  const result = planSleep(snap);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.reasons, { t1: "disabled", t9: "disabled" });
  // Settings that never loaded: off as well (fail closed).
  assert.equal(reasonOf({ settings: undefined }), "disabled");
});

test("idle window: 29 min idle waits, 30 min sleeps", () => {
  const at = (minutes) => withT1({ status_ms: NOW - minutes * MIN });
  const early = planSleep(snapshot(at(29)));
  assert.equal(early.reasons.t1, "idle-window");
  assert.equal(early.due.t1, NOW + MIN);
  assert.deepEqual(candidateIds(at(30)), ["t1"]);
  assert.deepEqual(candidateIds(at(31)), ["t1"]);
  assert.equal(planSleep(snapshot(at(30))).due.t1, undefined);
});

test("idle start = max(status_ms, lastSeen, firstSeen): each one can hold it back", () => {
  // Last seen 29 min ago (the status changed long before).
  assert.equal(reasonOf({ lastSeen: { t1: NOW - 29 * MIN } }), "idle-window");
  assert.deepEqual(candidateIds({ lastSeen: { t1: NOW - 30 * MIN } }), ["t1"]);
  // First seen by this mod 29 min ago (the mod started then).
  assert.equal(reasonOf({ firstSeen: { t1: NOW - 29 * MIN, t9: NOW } }), "idle-window");
  // Missing evidence starts the clock now: no status time, or never seen.
  assert.equal(reasonOf(withT1({ status_ms: null })), "idle-window");
  assert.equal(reasonOf({ firstSeen: {} }), "idle-window");
  assert.equal(planSleep(snapshot({ firstSeen: {} })).due.t1, NOW + 30 * MIN);
});

test("idle window from settings: 1 min to 24 h, anything else is the 30 min default", () => {
  assert.equal(DEFAULT_IDLE_MINUTES, 30);
  assert.equal(idleWindowMs({ idleMinutes: 30 }), 30 * MIN);
  assert.equal(idleWindowMs({ idleMinutes: 5 }), 5 * MIN);
  assert.equal(idleWindowMs({ idleMinutes: 1 }), MIN);
  assert.equal(idleWindowMs({ idleMinutes: 1440 }), 24 * 60 * MIN);
  for (const bad of [0, 0.5, 1441, 99999, -5, NaN, Infinity, "10", null, undefined]) {
    assert.equal(idleWindowMs({ idleMinutes: bad }), 30 * MIN, String(bad));
  }
  assert.equal(idleWindowMs(undefined), 30 * MIN);
  // The planner uses it: a 5 min window sleeps a Claude idle for 5 min.
  const five = { settings: { enabled: true, idleMinutes: 5 }, ...withT1({ status_ms: NOW - 5 * MIN }), firstSeen: { t1: NOW - 5 * MIN } };
  assert.deepEqual(candidateIds(five), ["t1"]);
  assert.equal(reasonOf({ ...five, settings: { enabled: true, idleMinutes: 99999 } }), "idle-window");
});

test("visit 40 min, leave, next tick: idle starts at the leave", () => {
  const T0 = NOW;
  const inView = [{ pane: "p9", terminal: "t9", tab: "shown" }, { pane: "p1", terminal: "t1", tab: "shown" }];
  const away = snapshot().panes;
  // Done an hour before the visit, first seen long ago.
  const base = { ...withT1({ status_ms: T0 - 60 * MIN }), firstSeen: { t1: T0 - 120 * MIN, t9: T0 - 120 * MIN } };
  let seen = { visible: [], lastSeen: {}, firstSeen: base.firstSeen };
  const step = (now, panes) => snapshot({ ...base, now, panes, previousVisible: seen.visible, lastSeen: seen.lastSeen, firstSeen: seen.firstSeen });

  // T0: the user shows t1's tab (a render). A quiet visit: no render for 40 min.
  seen = observe(step(T0, inView));
  assert.ok(seen.visible.includes("t1"));
  // T0+40: he leaves (a render): t1 just left the visible set.
  seen = observe(step(T0 + 40 * MIN, away));
  assert.equal(seen.lastSeen.t1, T0 + 40 * MIN);
  assert.ok(!seen.visible.includes("t1"));
  // Next tick, T0+41: idle since the leave, not since the visit began or
  // since the status changed.
  let result = planSleep(step(T0 + 41 * MIN, away));
  assert.equal(result.reasons.t1, "idle-window");
  assert.equal(result.due.t1, T0 + 70 * MIN);
  seen = result.seen;
  assert.equal(seen.lastSeen.t1, T0 + 40 * MIN);
  result = planSleep(step(T0 + 70 * MIN - 1, away));
  assert.equal(result.reasons.t1, "idle-window");
  result = planSleep(step(T0 + 70 * MIN, away));
  assert.deepEqual(result.candidates.map((c) => [c.address, c.idleStart]), [["t1", T0 + 40 * MIN]]);
});

test("visit with no render at the leave: the first tick after it stamps the leave", () => {
  const inView = [{ pane: "p9", terminal: "t9", tab: "shown" }, { pane: "p1", terminal: "t1", tab: "shown" }];
  const away = snapshot().panes;
  const first = planSleep(snapshot({ now: NOW, panes: inView }));
  assert.equal(first.reasons.t1, "visible");
  assert.equal(first.seen.lastSeen.t1, NOW);
  const s = first.seen;
  const next = planSleep(snapshot({ now: NOW + 40 * MIN, panes: away, previousVisible: s.visible, lastSeen: s.lastSeen, firstSeen: s.firstSeen }));
  assert.equal(next.reasons.t1, "idle-window");
  assert.equal(next.seen.lastSeen.t1, NOW + 40 * MIN);
  assert.equal(next.due.t1, NOW + 70 * MIN);
});

test("observe: stamps visible and just-left terminals, first sightings, and forgets gone ones; inputs untouched", () => {
  const input = snapshot({
    now: NOW,
    previousVisible: ["t1", "t8"],
    lastSeen: { t1: NOW - 5 * MIN, t8: NOW - 5 * MIN, t3: NOW - 9 * MIN },
    firstSeen: { t1: NOW - 120 * MIN, t8: NOW - 120 * MIN },
    terminals: [claudeTerminal("t1"), shellTerminal("t9"), claudeTerminal("t3")],
  });
  const before = JSON.stringify(input);
  const seen = observe(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(seen.visible, ["t9"]);
  // t9 visible now, t1 just left: both stamped. t3 keeps its old stamp. t8
  // is gone from Core: forgotten.
  assert.deepEqual(seen.lastSeen, { t1: NOW, t9: NOW, t3: NOW - 9 * MIN });
  // t9 and t3 seen for the first time now; t1 keeps its first sighting.
  assert.deepEqual(seen.firstSeen, { t1: NOW - 120 * MIN, t9: NOW, t3: NOW });
  // Without a terminal list nothing is forgotten or first seen.
  const blind = observe({ ...input, terminals: undefined });
  assert.deepEqual(blind.firstSeen, input.firstSeen);
  assert.equal(blind.lastSeen.t8, NOW);
});

test("manual mode skips only the idle window", () => {
  const fresh = withT1({ status_ms: NOW - MIN });
  assert.equal(reasonOf(fresh), "idle-window");
  assert.deepEqual(candidateIds({ ...fresh, manual: true }), ["t1"]);
  assert.deepEqual(candidateIds({ ...fresh, firstSeen: {}, manual: true }), ["t1"]);
  // Every other reason still holds.
  const inView = [{ pane: "p9", terminal: "t9", tab: "shown" }, { pane: "p1", terminal: "t1", tab: "shown" }];
  assert.equal(reasonOf({ ...fresh, manual: true, panes: inView }), "visible");
  assert.equal(reasonOf({ ...withT1({ status: "working", status_ms: NOW - MIN }), manual: true }), "working");
  assert.equal(reasonOf({ ...fresh, manual: true, failedUntil: { t1: NOW + MIN } }), "failed-until");
  assert.equal(reasonOf({ ...fresh, manual: true, sessions: {} }), "invalid-session");
  assert.equal(reasonOf({ ...fresh, manual: true, screens: {} }), "no-screen");
  // "Sleep now" works with automatic sleep switched off.
  assert.deepEqual(candidateIds({ ...fresh, manual: true, settings: { enabled: false, idleMinutes: 30 } }), ["t1"]);
});

test("no-screen: an otherwise eligible terminal waits for its screen hash; needsScreen lists them", () => {
  const blind = planSleep(snapshot({ screens: {} }));
  assert.equal(blind.reasons.t1, "no-screen");
  assert.deepEqual(needsScreen(blind), ["t1"]);
  assert.deepEqual(needsScreen(planSleep(snapshot())), []);
  assert.equal(reasonOf({ screens: { t1: hashScreen(undefined) } }), "no-screen");
  assert.equal(reasonOf({ screens: { t1: "" } }), "no-screen");
  // Only would-be candidates are listed: a working Claude's screen is never read.
  assert.deepEqual(needsScreen(planSleep(snapshot({ ...withT1({ status: "working" }), screens: {} }))), []);
});

test("hashScreen: same text, same hash; any change, another; not text, null", () => {
  assert.equal(hashScreen("❯ "), hashScreen("❯ "));
  assert.notEqual(hashScreen("❯ "), hashScreen("❯  "));
  assert.notEqual(hashScreen("abc"), hashScreen("abd"));
  assert.match(hashScreen(""), /^[0-9a-f]+$/);
  assert.equal(hashScreen(null), null);
  assert.equal(hashScreen(undefined), null);
  assert.equal(hashScreen(7), null);
});

test("signature: address | status | status_ms | turn | sessionId | screen hash; each part changes it", () => {
  const base = { address: "t1", state: "done", statusMs: NOW - 60 * MIN, turn: 3, sessionId: SID, screenHash: SCREEN };
  const sig = signatureOf(base);
  assert.equal(sig, `t1|done|${NOW - 60 * MIN}|3|${SID}|${SCREEN}`);
  for (const [key, value] of Object.entries({ address: "t2", state: "idle", statusMs: NOW, turn: 4, sessionId: "other", screenHash: hashScreen("draft") })) {
    assert.notEqual(signatureOf({ ...base, [key]: value }), sig, key);
  }
});

test("candidates come oldest idle first, then by address", () => {
  const snap = snapshot({
    terminals: [claudeTerminal("t5", { status_ms: NOW - 40 * MIN }), claudeTerminal("t3", { status_ms: NOW - 90 * MIN }), claudeTerminal("t4", { status_ms: NOW - 40 * MIN })],
    panes: ["t3", "t4", "t5"].map((t) => ({ pane: `p${t}`, terminal: t, tab: "back" })),
    firstSeen: { t3: NOW - 120 * MIN, t4: NOW - 120 * MIN, t5: NOW - 120 * MIN },
    sessions: Object.fromEntries(["t3", "t4", "t5"].map((t) => [t, { sessionId: `${SID}${t}`, transcript: true }])),
    screens: { t3: SCREEN, t4: SCREEN, t5: SCREEN },
  });
  assert.deepEqual(planSleep(snap).candidates.map((c) => c.address), ["t3", "t4", "t5"]);
});

// One tick: plan, then confirm against the previous tick's state.
function tick(state, over, intervalMs) {
  const plan = planSleep(snapshot(over));
  return confirm({ previous: state, candidates: plan.candidates, now: over.now ?? NOW, intervalMs });
}
const confirmedIds = (r) => r.confirmed.map((c) => c.address);

test("confirmation: a candidate is confirmed only on the second identical tick", () => {
  assert.equal(TICK_MS, 60_000);
  const one = tick(undefined, { now: NOW });
  assert.deepEqual(confirmedIds(one), []);
  assert.equal(one.state.at, NOW);
  const two = tick(one.state, { now: NOW + TICK_MS });
  assert.deepEqual(confirmedIds(two), ["t1"]);
  // And on every identical tick after that.
  assert.deepEqual(confirmedIds(tick(two.state, { now: NOW + 2 * TICK_MS })), ["t1"]);
});

test("confirmation: a change between ticks (screen, status time, turn) restarts it", () => {
  const one = tick(undefined, { now: NOW });
  // The screen changed: not confirmed; the tick after, with the same new screen, is.
  const drawn = { t1: hashScreen("❯ hola") };
  const two = tick(one.state, { now: NOW + TICK_MS, screens: drawn });
  assert.deepEqual(confirmedIds(two), []);
  assert.deepEqual(confirmedIds(tick(two.state, { now: NOW + 2 * TICK_MS, screens: drawn })), ["t1"]);
  // A new turn that ended between the ticks: status_ms and turn moved.
  const moved = withT1({ status_ms: NOW - 50 * MIN, turn: 4 });
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW + TICK_MS, ...moved })), []);
});

test("confirmation: a candidate that drops out (a visit) must be seen twice again", () => {
  const inView = [{ pane: "p9", terminal: "t9", tab: "shown" }, { pane: "p1", terminal: "t1", tab: "shown" }];
  const one = tick(undefined, { now: NOW });
  const two = tick(one.state, { now: NOW + TICK_MS, panes: inView });
  assert.deepEqual(confirmedIds(two), []);
  assert.deepEqual(two.state.signatures, {});
  const three = tick(two.state, { now: NOW + 2 * TICK_MS });
  assert.deepEqual(confirmedIds(three), []);
  assert.deepEqual(confirmedIds(tick(three.state, { now: NOW + 3 * TICK_MS })), ["t1"]);
});

test("confirmation: ticks more than 2x the interval apart (laptop asleep) restart it", () => {
  const one = tick(undefined, { now: NOW });
  const late = tick(one.state, { now: NOW + 2 * TICK_MS + 1 });
  assert.deepEqual(confirmedIds(late), []);
  assert.equal(late.state.at, NOW + 2 * TICK_MS + 1);
  assert.deepEqual(confirmedIds(tick(late.state, { now: NOW + 3 * TICK_MS + 1 })), ["t1"]);
  // Exactly 2x still counts.
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW + 2 * TICK_MS })), ["t1"]);
  // A custom interval scales the gap.
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW + 21_000 }, 10_000)), []);
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW + 20_000 }, 10_000)), ["t1"]);
});

test("confirmation: a tick at or before the previous one (clock went back, duplicate) confirms nothing", () => {
  const one = tick(undefined, { now: NOW });
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW })), []);
  assert.deepEqual(confirmedIds(tick(one.state, { now: NOW - TICK_MS })), []);
  assert.deepEqual(confirmedIds(tick({ signatures: one.state.signatures }, { now: NOW + TICK_MS })), []);
});

test("a clock that isn't a number is the caller's bug: planSleep, observe and confirm throw", () => {
  for (const now of [undefined, NaN, "12:00"]) {
    assert.throws(() => planSleep(snapshot({ now })), TypeError);
    assert.throws(() => observe(snapshot({ now })), TypeError);
    assert.throws(() => confirm({ previous: undefined, candidates: [], now }), TypeError);
  }
});

test("re-plan right before the stop: stillCandidate needs the same address and signature", () => {
  const confirmed = planSleep(snapshot()).candidates[0];
  assert.equal(stillCandidate(planSleep(snapshot({ now: NOW + 5_000 })), confirmed), true);
  assert.equal(stillCandidate(planSleep(snapshot(withT1({ status: "working" }))), confirmed), false);
  assert.equal(stillCandidate(planSleep(snapshot({ screens: { t1: hashScreen("❯ hola") } })), confirmed), false);
  assert.equal(stillCandidate(planSleep(snapshot({ records: { t1: { state: "stopping" } } })), confirmed), false);
});
