// T8: the test queue as the footer flask and the "Cola de pruebas" popup draw
// it (M/board-model.js), plus the footer copy's bookkeepers: the toasts'
// high-water mark (D18), the state watch's batch filter, and the reaper's
// debounce (D13). Modeled on Orca's
// O/src/renderer/src/components/sidebar/test-queue/test-queue-board.test.ts,
// with the words of tester case 14 (~/Desktop/test-queue/specs/14-spanish).
// The queue in the fixtures is built with queue.js, as the CLI builds it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request, release, pause } from "../mods/spotlight/queue.js";
import {
  readState, readSettings, boardView, footerView, toastMark, takeToasts, isStateBatch, reapTargets,
  reapFingerprint, reapClock, reapTick, reapDone, stateDirOf, cliPathOf, REAP_DEBOUNCE_MS, REAP_EVERY_MS,
} from "../mods/spotlight/board-model.js";

const MINUTE = 60_000;
const T0 = 1_000 * MINUTE;

// projects-sidebar's projects.v1: Action holds action-black and action-api,
// Arrecife holds orca.
const REGISTRY = {
  version: 1,
  groups: [
    {
      id: "g-action",
      name: "Action",
      projects: [
        { path: "/code/action-black", name: "action-black" },
        { path: "/code/action-api", name: "action-api" },
      ],
    },
    { id: "g-arrecife", name: "Arrecife", projects: [{ path: "/code/orca", name: "orca" }] },
  ],
};

const SETTINGS = readSettings(JSON.stringify({ version: 1, queue: { enabled: true, cap: 2, perSpace: {} }, repos: {} }));
const qctx = (now) => ({ now, ...SETTINGS.queue });

// One `spotlight on` as cli.mjs records it.
function ask(terminal, lane, label, root, workspace, at) {
  return {
    terminal, taskKey: `${lane}/${label}`, label, lane,
    members: [{ root, name: root.split("/").pop(), workspace, workspaces: [workspace] }],
    skipped: [], slotOnly: false, root, workspace,
    requestTurn: 0, fgPid: 100, statusMs: null, resumingUntil: null, lastActivityAt: at,
  };
}

// Tester case 14: checkout-flow (action-black, Action) and test-queue (orca,
// Arrecife) test; login-fix (action-api, Action) waits behind checkout-flow
// (one task per space). Every agent asked at T0.
function caseFourteen() {
  let queue = { requests: [], lighting: {} };
  queue = request(queue, ask("t1", "g-action", "checkout-flow", "/code/action-black", "/ws/checkout-flow-black", T0), qctx(T0)).queue;
  queue = request(queue, ask("t2", "g-action", "login-fix", "/code/action-api", "/ws/login-fix-api", T0), qctx(T0)).queue;
  queue = request(queue, ask("t3", "g-arrecife", "test-queue", "/code/orca", "/ws/test-queue-orca", T0), qctx(T0)).queue;
  return {
    version: 1,
    repos: {
      "/code/action-black": { holder: "/ws/checkout-flow-black", serverTerminal: "t9", serverState: "listening", ports: [3000] },
      "/code/orca": { holder: "/ws/test-queue-orca", serverTerminal: "t8", serverState: "starting", ports: [] },
    },
    queue,
    notes: [],
  };
}

const view = (state, now) => boardView({ state, settings: SETTINGS, registry: REGISTRY, now });

describe("the board (Cola de pruebas)", () => {
  test("builds tester case 14's rows from a state fixture, word for word", () => {
    const board = view(caseFourteen(), T0 + 12 * MINUTE);

    assert.equal(board.title, "Cola de pruebas");
    assert.equal(board.limit, "Límite: 2 a la vez");
    assert.deepEqual(board.sections.map((s) => s.title), ["Probando", "En cola"]);
    assert.deepEqual(board.testing.map((r) => [r.name, r.meta]), [
      ["checkout-flow", "action-black · Action · sin actividad hace 12 min"],
      ["test-queue", "orca · Arrecife · sin actividad hace 12 min"],
    ]);
    assert.deepEqual(board.waiting.map((r) => [r.name, r.meta]), [["login-fix", "action-api · Action · esperando 12 min"]]);
    assert.deepEqual(board.paused, []);
    assert.equal(board.count, 3);
  });

  test("a holder idle 12 min reads \"sin actividad hace 12 min\" and offers Soltar turno for its terminals", () => {
    const board = view(caseFourteen(), T0 + 12 * MINUTE + 30_000);
    const row = board.testing[0];

    assert.equal(row.idleMinutes, 12);
    assert.match(row.meta, /sin actividad hace 12 min$/);
    assert.equal(row.release, true);
    assert.deepEqual(row.terminals, ["t1"]);
  });

  test("an active holder shows no idle time and no Soltar turno; idle counts from the grant", () => {
    const state = caseFourteen();
    state.queue.requests.find((r) => r.terminal === "t1").lastActivityAt = T0 + 8 * MINUTE;
    const board = view(state, T0 + 12 * MINUTE);
    assert.equal(board.testing[0].idleMinutes, null);
    assert.equal(board.testing[0].meta, "action-black · Action");
    assert.equal(board.testing[0].release, false);

    // An agent that sat in line for 30 min without reporting, granted 3 min
    // ago: idle counts from its grant.
    let queue = { requests: [], lighting: {} };
    queue = request(queue, ask("t0", "g-action", "busy", "/code/action-black", "/ws/busy", T0 - 40 * MINUTE), qctx(T0 - 40 * MINUTE)).queue;
    queue = request(queue, ask("t1", "g-action", "slow", "/code/action-black", "/ws/slow", T0 - 30 * MINUTE), qctx(T0 - 30 * MINUTE)).queue;
    queue = release(queue, "t0", qctx(T0 - 3 * MINUTE)).queue;
    const late = view({ version: 1, repos: {}, queue, notes: [] }, T0);
    assert.equal(late.testing[0].name, "slow");
    assert.equal(late.testing[0].idleMinutes, null);
    assert.equal(view({ version: 1, repos: {}, queue, notes: [] }, T0 + 8 * MINUTE).testing[0].idleMinutes, 11);
  });

  test("a waiter under a minute shows no wait time, and a task named after its only repo shows it once", () => {
    let queue = { requests: [], lighting: {} };
    queue = request(queue, ask("t1", "g-arrecife", "orca", "/code/orca", "/ws/orca-2", T0), qctx(T0)).queue;
    queue = request(queue, ask("t2", "g-arrecife", "other", "/code/orca", "/ws/orca-3", T0), qctx(T0)).queue;
    const board = view({ version: 1, repos: {}, queue, notes: [] }, T0 + 30_000);
    assert.equal(board.testing[0].meta, "Arrecife");
    assert.equal(board.waiting[0].meta, "orca · Arrecife");
  });

  test("a paused agent gets its own row in Pausados with its reason, and never counts", () => {
    const state = caseFourteen();
    state.queue = pause(state.queue, "t1", { reason: "error", msg: "rate_limit" }, qctx(T0 + 12 * MINUTE)).queue;
    const board = view(state, T0 + 12 * MINUTE);

    assert.deepEqual(board.sections.map((s) => s.title), ["Probando", "Pausados"]);
    assert.deepEqual(board.paused.map((r) => [r.name, r.meta, r.terminal]), [["checkout-flow", "action-black · Action · se detuvo por un error", "t1"]]);
    // login-fix took checkout-flow's slot in Action; turns show in grant order.
    assert.deepEqual(board.testing.map((r) => r.name), ["test-queue", "login-fix"]);
    assert.equal(board.count, 2);

    state.queue = pause(state.queue, "t1", { reason: "limit" }, qctx(T0 + 13 * MINUTE)).queue;
    assert.match(view(state, T0 + 13 * MINUTE).paused[0].meta, /se quedó sin límite$/);
    state.queue = pause(state.queue, "t1", { reason: "signin" }, qctx(T0 + 14 * MINUTE)).queue;
    assert.match(view(state, T0 + 14 * MINUTE).paused[0].meta, /necesita iniciar sesión$/);
  });

  test("a row click targets the server popup with D22's props: the holder's workspace in the row's first repo", () => {
    const board = view(caseFourteen(), T0);
    assert.deepEqual(board.testing[0].server, { view: "server", repo: "/code/action-black", workspace: "/ws/checkout-flow-black" });
    assert.deepEqual(board.waiting[0].server, { view: "server", repo: "/code/action-api", workspace: "/ws/login-fix-api" });

    // A slot-only turn lights nothing, so it opens no popup.
    let queue = { requests: [], lighting: {} };
    queue = request(queue, { ...ask("t5", "g-action", "docs", "/code/action-black", "/ws/docs", T0), members: [], slotOnly: true }, qctx(T0)).queue;
    assert.equal(view({ version: 1, repos: {}, queue, notes: [] }, T0).testing[0].server, null);
  });

  test("an empty line says \"Nadie está probando\", and the queue switch off is said", () => {
    const empty = view(readState(null), T0);
    assert.equal(empty.empty, true);
    assert.equal(empty.emptyText, "Nadie está probando");
    assert.deepEqual(empty.sections, []);
    assert.equal(empty.offNote, null);

    const off = boardView({ state: readState(null), settings: readSettings(JSON.stringify({ version: 1, queue: { enabled: false } })), registry: REGISTRY, now: T0 });
    assert.equal(off.queue, "off");
    assert.match(off.offNote, /apagada/);
  });
});

describe("the footer flask", () => {
  test("counts the tasks testing plus waiting, dimmed only when nothing is in line", () => {
    const busy = footerView(view(caseFourteen(), T0));
    assert.deepEqual(busy, { count: 3, quiet: false, tooltip: "Cola de pruebas" });

    assert.deepEqual(footerView(view(readState(null), T0)), { count: 0, quiet: true, tooltip: "Nadie está probando" });

    // Paused agents never count, but keep the flask lit: they wait for a Continuar.
    let queue = { requests: [], lighting: {} };
    queue = request(queue, ask("t1", "g-action", "a", "/code/action-black", "/ws/a", T0), qctx(T0)).queue;
    queue = pause(queue, "t1", { reason: "limit" }, qctx(T0)).queue;
    assert.deepEqual(footerView(view({ version: 1, repos: {}, queue, notes: [] }, T0)), { count: 0, quiet: false, tooltip: "Nadie está probando" });
  });
});

describe("reading state.json", () => {
  test("anything but a v1 state reads as the empty state, and bad entries are dropped", () => {
    for (const text of [null, "", "{", "[]", JSON.stringify({ version: 2, repos: { "/a": {} } })]) {
      assert.deepEqual(readState(text), { version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [] });
    }
    const state = readState(JSON.stringify({
      version: 1,
      repos: { "/a/": { holder: "/w" }, "/b": 3 },
      queue: { requests: [{ terminal: "t1", taskKey: "x/y", members: "no" }, 4, { taskKey: "no-terminal" }], lighting: { k: 1, j: { phase: "done" } } },
      notes: [{ at: 1, text: "n" }, "bad"],
    }));
    assert.deepEqual(Object.keys(state.repos), ["/a"]);
    assert.deepEqual(state.queue.requests, [{ terminal: "t1", taskKey: "x/y", members: [] }]);
    assert.deepEqual(state.queue.lighting, { j: { phase: "done" } });
    assert.deepEqual(state.notes, [{ at: 1, text: "n" }]);
  });

  test("the paths: the state folder and the CLI inside the app home", () => {
    assert.equal(stateDirOf("/h/.config/herdr-app/"), "/h/.config/herdr-app/spotlight");
    assert.equal(cliPathOf("/h/.config/herdr-app"), "/h/.config/herdr-app/mods/spotlight/bin/spotlight");
  });
});

describe("toasts (D18)", () => {
  const START = T0;

  test("a toast: true note becomes one toast, once, with its action", () => {
    let mark = toastMark(START);
    const notes = [
      { at: START + 1, repo: "/code/orca", text: "Spotlight on · orca ← test-queue-orca · started", toast: true },
      { at: START + 2, repo: "/code/orca", text: "only for the log", toast: false },
      { at: START + 3, repo: "/code/orca", text: "orca: The repository root moved off the Spotlight snapshot.", toast: true, action: { name: "spotlight.server.0123456789ab" } },
    ];
    const first = takeToasts(notes, mark);
    assert.deepEqual(first.toasts, [
      { title: "Spotlight", body: "Spotlight on · orca ← test-queue-orca · started", level: "info" },
      { title: "Spotlight", body: "orca: The repository root moved off the Spotlight snapshot.", level: "warning", action: { name: "spotlight.server.0123456789ab" } },
    ]);
    mark = first.mark;
    assert.deepEqual(takeToasts(notes, mark).toasts, []);

    // A later note written in the same millisecond as the last one shown still shows.
    const same = [...notes, { at: START + 3, repo: null, text: "Spotlight off — root restaurado", toast: true }];
    const second = takeToasts(same, mark);
    assert.deepEqual(second.toasts.map((t) => t.body), ["Spotlight off — root restaurado"]);
    assert.deepEqual(takeToasts(same, second.mark).toasts, []);
  });

  test("a copy that starts with 5 old toast notes shows none of them", () => {
    const old = Array.from({ length: 5 }, (_, i) => ({ at: START - 1000 + i, repo: null, text: `old ${i}`, toast: true }));
    const { toasts } = takeToasts(old, toastMark(START));
    assert.deepEqual(toasts, []);
  });

  test("an action that isn't a command name is dropped, the toast kept", () => {
    const { toasts } = takeToasts([{ at: START + 1, text: "x", toast: true, action: { name: 3 } }], toastMark(START));
    assert.deepEqual(toasts, [{ title: "Spotlight", body: "x", level: "info" }]);
  });

  test("D35: an error note toasts as an error for 60 s, its body naming the popup button its click leads to", () => {
    const action = { name: "spotlight.server.0123456789ab" };
    const notes = [
      { at: START + 1, repo: "/code/app", text: "app: El root se movió del snapshot de Spotlight.", toast: true, level: "error", action, button: "Forzar sync" },
      // An error the popup can't act on (orca-holds): no action, no button, still 60 s.
      { at: START + 2, repo: "/code/app", text: "app: Este root lo tiene el Spotlight de Orca: apágalo allá primero.", toast: true, level: "error" },
      // A button with no action has no popup to name.
      { at: START + 3, repo: "/code/app", text: "app: sin popup", toast: true, level: "error", button: "Forzar sync" },
    ];
    assert.deepEqual(takeToasts(notes, toastMark(START)).toasts, [
      {
        title: "Spotlight", body: "app: El root se movió del snapshot de Spotlight. Clic: Forzar sync en el popup", level: "error", timeout: 60_000, action,
      },
      { title: "Spotlight", body: "app: Este root lo tiene el Spotlight de Orca: apágalo allá primero.", level: "error", timeout: 60_000 },
      { title: "Spotlight", body: "app: sin popup", level: "error", timeout: 60_000 },
    ]);
  });

  test("D35: any other note keeps Herdr's default timeout; a known level is kept, an unknown one reads as before", () => {
    const action = { name: "spotlight.server.0123456789ab" };
    const notes = [
      { at: START + 1, repo: "/code/app", text: "Spotlight re-sincronizado: el root refleja el workspace otra vez.", toast: true, level: "success" },
      { at: START + 2, repo: "/code/app", text: "Elige una variante para app", toast: true, level: "info", action },
      { at: START + 3, repo: "/code/app", text: "odd", toast: true, level: "loud", action },
      { at: START + 4, repo: "/code/app", text: "plain", toast: true },
    ];
    assert.deepEqual(takeToasts(notes, toastMark(START)).toasts, [
      { title: "Spotlight", body: "Spotlight re-sincronizado: el root refleja el workspace otra vez.", level: "success" },
      { title: "Spotlight", body: "Elige una variante para app", level: "info", action },
      { title: "Spotlight", body: "odd", level: "warning", action },
      { title: "Spotlight", body: "plain", level: "info" },
    ]);
  });
});

describe("the state watch", () => {
  const DIR = "/h/.config/herdr-app/spotlight";

  test("a batch without state.json is ignored", () => {
    assert.equal(isStateBatch(DIR, [`${DIR}/locks/state/owner.json`, `${DIR}/locks/state`]), false);
    assert.equal(isStateBatch(DIR, [`${DIR}/settings.json`]), false);
    assert.equal(isStateBatch(DIR, [`${DIR}/state.json.tmp-123-abcd`]), false);
    assert.equal(isStateBatch(DIR, []), false);
  });

  test("a batch with state.json, or with the folder itself (refresh everything), is read", () => {
    assert.equal(isStateBatch(DIR, [`${DIR}/state.json.tmp-1-ff`, `${DIR}/state.json`]), true);
    assert.equal(isStateBatch(`${DIR}/`, [DIR]), true);
  });
});

describe("the reaper (D13)", () => {
  // The terminals of the state above: the agents in line and the servers.
  const TARGETS = reapTargets(caseFourteen());

  test("watches the requesting agents and the server terminals only", () => {
    assert.deepEqual(TARGETS, ["t1", "t2", "t3", "t9", "t8"]);
    const terms = [
      { address: "t1", state: "live", status: "working", turn: 3 },
      { address: "t7", state: "live", status: "working", turn: 1 },
      { address: "t8", name: "sl-orca", state: "live" },
    ];
    const before = reapFingerprint(terms, TARGETS);
    // An unrelated terminal's status never wakes the reaper.
    assert.equal(reapFingerprint([terms[0], { ...terms[1], status: "done" }, terms[2]], TARGETS), before);
    assert.notEqual(reapFingerprint([{ ...terms[0], status: "done", turn: 4 }, terms[1], terms[2]], TARGETS), before);
    // A server terminal that went away does.
    assert.notEqual(reapFingerprint(terms.slice(0, 2), TARGETS), before);
  });

  test("a burst of 10 terminals() changes runs one reap, 1 s after the last", () => {
    let clock = reapClock();
    let reaps = 0;
    const tick = (now, print) => {
      const r = reapTick(clock, { now, print });
      clock = r.clock;
      if (r.reap) {
        reaps += 1;
        clock = reapDone(clock);
      }
      return r.reap;
    };
    // The first look reaps once (the copy just started) and sets the baseline.
    assert.equal(tick(0, "p0"), true);
    reaps = 0;
    for (let i = 1; i <= 10; i++) tick(1_000 + i * 100, `p${i}`);
    assert.equal(reaps, 0);
    assert.equal(tick(2_000 + REAP_DEBOUNCE_MS - 1, "p10"), false);
    assert.equal(tick(2_000 + REAP_DEBOUNCE_MS, "p10"), true);
    for (let now = 3_500; now < REAP_EVERY_MS; now += 500) tick(now, "p10");
    assert.equal(reaps, 1);
  });

  test("reaps every 30 s with nothing changing, and never two at once", () => {
    let clock = reapClock();
    let r = reapTick(clock, { now: 0, print: "" });
    assert.equal(r.reap, true);
    clock = r.clock;
    // Still running at the next change and at the 30 s mark: no second reap.
    r = reapTick(clock, { now: 500, print: "x" });
    clock = r.clock;
    assert.equal(reapTick(clock, { now: REAP_EVERY_MS, print: "x" }).reap, false);
    clock = reapDone(clock);
    // The change seen while it ran is reaped once it ends.
    r = reapTick(clock, { now: REAP_EVERY_MS + 1, print: "x" });
    assert.equal(r.reap, true);
    clock = reapDone(r.clock);
    assert.equal(reapTick(clock, { now: 2 * REAP_EVERY_MS, print: "x" }).reap, false);
    assert.equal(reapTick(clock, { now: 2 * REAP_EVERY_MS + 1, print: "x" }).reap, true);
  });
});
