// T8: the test queue as the footer flask and the "Cola de pruebas" popup draw
// it (M/board-model.js), plus the footer copy's bookkeepers: the toasts'
// high-water mark (D18), kept in shared state so a note written while another
// layout was shown still toasts (D45), the state watch's batch filter, and
// the reaper's debounce (D13). Modeled on Orca's
// O/src/renderer/src/components/sidebar/test-queue/test-queue-board.test.ts,
// with the words of tester case 14 (~/Desktop/test-queue/specs/14-spanish).
// The queue in the fixtures is built with queue.js, as the CLI builds it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request, release, pause } from "../mods/spotlight/queue.js";
import {
  readState, readSettings, boardView, footerView, toastMark, takeToasts, isStateBatch, reapTargets,
  stateDirOf, cliPathOf,
  TOAST_KEY, TOAST_MAX_AGE_MS,
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

  test("D41: a note's title, body and timeout make its toast: title ?? \"Spotlight\", body ?? text (an empty body shows none), its own timeout over the error's 60 s; the popup hint follows the body", () => {
    const action = { name: "spotlight.server.0123456789ab" };
    const notes = [
      // A light: Orca's title, the body by what the server did; `text` stays the log's line.
      {
        at: START + 1, repo: "/code/app", text: "Spotlight on · app ← ax-1 · server arrancando", toast: true, level: "success",
        title: "Spotlight on — el root del proyecto ahora refleja este workspace", body: "Arrancando npm run dev -- — logs en /l/app.log",
      },
      // A title-only toast (Orca's plain success): the empty body is no body.
      { at: START + 2, repo: "/code/app", text: "Spotlight off — root restaurado", toast: true, level: "success", title: "Spotlight off — root del proyecto restaurado", body: "" },
      // An error naming its popup button: the hint goes after the body, never after `text`.
      {
        at: START + 3, repo: "/code/app", text: "app: The root moved.", toast: true, level: "error", action, button: "Apagar igual",
        title: "No se pudo apagar Spotlight en app", body: "El root del proyecto tiene cambios hechos fuera del workspace de Spotlight. Haz commit o descártalos ahí primero.",
      },
      // A warning with its own timeout; the variant prompt, an info for 60 s.
      { at: START + 4, repo: "/code/app", text: "app: detached", toast: true, level: "warning", title: "Spotlight off — el root del proyecto quedó detached", body: "La rama original del root ya no existe, así que quedó detached en su commit original.", timeout: 60_000 },
      { at: START + 5, repo: "/code/app", text: "Elige una variante para app", toast: true, level: "info", action, title: "Elige una variante para app", body: "Su server arranca con la que elijas, y esta tarea la recuerda.", timeout: 60_000 },
      // Herdr's own: a title over its words, the body read from `text`.
      { at: START + 6, repo: "/code/app", text: "Cerraste la terminal del server de app: Spotlight sigue prendido.", toast: true, action, title: "Spotlight · app" },
      // Fields that aren't one: an empty title, a body that isn't text, a timeout that isn't a duration.
      { at: START + 7, repo: "/code/app", text: "plain", toast: true, title: "", body: 7, timeout: -5 },
    ];
    assert.deepEqual(takeToasts(notes, toastMark(START)).toasts, [
      { title: "Spotlight on — el root del proyecto ahora refleja este workspace", body: "Arrancando npm run dev -- — logs en /l/app.log", level: "success" },
      { title: "Spotlight off — root del proyecto restaurado", level: "success" },
      {
        title: "No se pudo apagar Spotlight en app",
        body: "El root del proyecto tiene cambios hechos fuera del workspace de Spotlight. Haz commit o descártalos ahí primero. Clic: Apagar igual en el popup",
        level: "error", timeout: 60_000, action,
      },
      { title: "Spotlight off — el root del proyecto quedó detached", body: "La rama original del root ya no existe, así que quedó detached en su commit original.", level: "warning", timeout: 60_000 },
      { title: "Elige una variante para app", body: "Su server arranca con la que elijas, y esta tarea la recuerda.", level: "info", timeout: 60_000, action },
      { title: "Spotlight · app", body: "Cerraste la terminal del server de app: Spotlight sigue prendido.", level: "warning", action },
      { title: "Spotlight", body: "plain", level: "info" },
    ]);
    // An empty body with a popup to open still names its button.
    const bare = [{ at: START + 1, text: "x", toast: true, level: "error", action, button: "Forzar sync", title: "Falló el sync de Spotlight", body: "" }];
    assert.deepEqual(takeToasts(bare, toastMark(START)).toasts, [
      { title: "Falló el sync de Spotlight", body: "Clic: Forzar sync en el popup", level: "error", timeout: 60_000, action },
    ]);
  });
});

describe("toasts while another layout was shown (D45)", () => {
  const NOW = T0 + 60 * MINUTE;
  const note = (at, text) => ({ at, repo: "/code/app", text, toast: true });
  // What the stored mark goes through: shared.json is JSON.
  const stored = (mark) => JSON.parse(JSON.stringify(mark));

  test("the mark is kept under spotlight.toasts.v1, and a note older than 10 minutes is too old", () => {
    assert.equal(TOAST_KEY, "spotlight.toasts.v1");
    assert.equal(TOAST_MAX_AGE_MS, 10 * MINUTE);
  });

  test("notes newer than the stored mark toast once, those older than 10 minutes don't; the whole mark moves to the last one toasted", () => {
    // The last copy toasted a note 30 minutes ago, then `projects` stopped showing.
    const kept = stored({ at: NOW - 30 * MINUTE, seen: [`${NOW - 30 * MINUTE}\n/code/app\nlast shown`] });
    const mark = toastMark(NOW, kept);
    assert.deepEqual(mark, kept);
    const notes = [
      note(NOW - 40 * MINUTE, "before the mark"),
      note(NOW - 30 * MINUTE, "last shown"),
      note(NOW - 20 * MINUTE, "newer than the mark, 20 minutes old"),
      note(NOW - 10 * MINUTE, "exactly 10 minutes old"),
      note(NOW - 9 * MINUTE, "9 minutes old"),
      note(NOW - 2 * MINUTE, "2 minutes old, first"),
      note(NOW - 2 * MINUTE, "2 minutes old, second"),
    ];
    const first = takeToasts(notes, mark, { now: NOW, stored: kept });
    assert.deepEqual(first.toasts.map((t) => t.body), ["9 minutes old", "2 minutes old, first", "2 minutes old, second"]);
    assert.deepEqual(first.mark, {
      at: NOW - 2 * MINUTE,
      seen: [`${NOW - 2 * MINUTE}\n/code/app\n2 minutes old, first`, `${NOW - 2 * MINUTE}\n/code/app\n2 minutes old, second`],
    });

    // Written back: the next read, and a copy started from it, toast nothing again,
    // not even the notes in the very millisecond of the last one toasted.
    const written = stored(first.mark);
    assert.deepEqual(takeToasts(notes, first.mark, { now: NOW + 1000, stored: written }).toasts, []);
    const restarted = toastMark(NOW + 5 * MINUTE, written);
    assert.deepEqual(takeToasts(notes, restarted, { now: NOW + 5 * MINUTE, stored: written }).toasts, []);

    // A note written later in that same millisecond still toasts.
    const later = [...notes, note(NOW - 2 * MINUTE, "2 minutes old, third")];
    const third = takeToasts(later, restarted, { now: NOW + 5 * MINUTE, stored: written });
    assert.deepEqual(third.toasts.map((t) => t.body), ["2 minutes old, third"]);
    assert.deepEqual(third.mark.seen.length, 3);
  });

  test("only notes too old to toast: nothing toasts and the mark stays", () => {
    const kept = stored({ at: NOW - 30 * MINUTE, seen: [] });
    const { toasts, mark } = takeToasts([note(NOW - 20 * MINUTE, "old")], toastMark(NOW, kept), { now: NOW, stored: kept });
    assert.deepEqual(toasts, []);
    assert.deepEqual(mark, kept);
  });

  test("with no stored mark, or an unreadable one, the copy's start time is the mark", () => {
    const unreadable = [
      undefined, null, "mark", 5, [], {}, { at: "1", seen: [] }, { at: NaN, seen: [] },
      { at: NOW - MINUTE }, { at: NOW - MINUTE, seen: "x" }, { at: NOW - MINUTE, seen: [1] },
    ];
    for (const value of unreadable) {
      const mark = toastMark(NOW, value);
      assert.deepEqual(mark, { at: NOW, seen: [] }, JSON.stringify(value) ?? String(value));
      const { toasts } = takeToasts([note(NOW - 1000, "before start"), note(NOW + 1000, "after start")], mark, { now: NOW + 2000, stored: value });
      assert.deepEqual(toasts.map((t) => t.body), ["after start"]);
    }
  });

  test("a second copy reading the same stored mark doesn't toast a note the first already moved past", () => {
    // Two copies shown at once (two windows), both started before any mark was stored.
    const a = toastMark(NOW, null);
    const b = toastMark(NOW, null);
    const notes = [note(NOW + 1000, "Spotlight on")];

    const first = takeToasts(notes, a, { now: NOW + 1500, stored: null });
    assert.deepEqual(first.toasts.map((t) => t.body), ["Spotlight on"]);
    const written = stored(first.mark);

    const second = takeToasts(notes, b, { now: NOW + 1600, stored: written });
    assert.deepEqual(second.toasts, []);
    assert.deepEqual(second.mark, written);

    // Each copy's own mark and the stored one, in the same millisecond, add up.
    const more = [...notes, note(NOW + 1000, "Spotlight off")];
    const own = { at: NOW + 1000, seen: [`${NOW + 1000}\n/code/app\nSpotlight off`] };
    const merged = takeToasts(more, own, { now: NOW + 2000, stored: written });
    assert.deepEqual(merged.toasts, []);
    assert.deepEqual(new Set(merged.mark.seen), new Set([...own.seen, ...written.seen]));

    // A stored mark older than the copy's own doesn't take it back.
    assert.deepEqual(takeToasts(notes, first.mark, { now: NOW + 2000, stored: { at: NOW - MINUTE, seen: [] } }).toasts, []);
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

describe("the reaper's targets (D13, D44)", () => {
  test("the requesting agents and the server terminals only, each once", () => {
    assert.deepEqual(reapTargets(caseFourteen()), ["t1", "t2", "t3", "t9", "t8"]);
  });
});
