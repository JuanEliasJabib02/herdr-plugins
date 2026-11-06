// T9 (S11, S12, D14): out of the sidebar. A moon in the last cell of the status
// row opens a small popup above it. The popup only draws and asks: the loop copy
// is the one writer (D11). What can run outside Herdr is tested here: where the
// popup opens and how tall, the command table through a pulse, a request taken
// once. main.js and the views need Herdr to load, so they are checked by their
// source here and by `herdr-app check`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  Coordinator, COMMANDS, REQUEST_KEY, VIEW_KEY, MOD, stepMinutes,
} from "../mods/agent-sleep/coordinator.js";
import {
  PANEL, overlayAt, zoomOf, moonBounds, anchorFrom, panelLines, panelHeight, panelSpec, panelView, moonTone, closedJustNow, CLOSE_GUARD_MS, makeRequest,
} from "../mods/agent-sleep/panel-model.js";
import { NOW, COPY, SETTINGS, SHELL_BARE, SID1, deps, setup, exitClaude, storeRecord, records, exits, resumes, at } from "./harness.js";

const mod = (f) => new URL(`../mods/agent-sleep/${f}`, import.meta.url);
const src = (f) => readFileSync(mod(f), "utf8");
const saved = (w) => JSON.parse(w.files[SETTINGS]);

// What a click in the popup of the copy under test leaves in shared.
const ask = (w, id, command, over = {}) => {
  w.shared[REQUEST_KEY] = { id, owner: COPY, command, ...over };
};

// ── Where the popup opens (S12) ────────────────────────────────────────────

// The moon's cell at the bottom right of a 1000 × 700 window.
const CELL = { x: 960, y: 672, width: 40, height: 28 };

test("anchorFrom: the cell's left, its top, and its right edge as the limit", () => {
  assert.deepEqual(anchorFrom(CELL), { x: 960, y: 672, limit: 1000 });
  for (const bad of [null, undefined, {}, { x: 1, y: 2 }, { x: "1", y: 2, width: 3 }]) assert.equal(anchorFrom(bad), null, JSON.stringify(bad));
});

test("overlayAt: above the moon, its right edge 8 px inside the cell's, 8 px over the bar", () => {
  const size = { width: 280, height: 200 };
  assert.deepEqual(overlayAt(anchorFrom(CELL), size), { x: 1000 - 288, y: 672 - 208 });
});

test("overlayAt: width and height are layout px, multiplied by the zoom; at is in window px", () => {
  const size = { width: 280, height: 200 };
  assert.deepEqual(overlayAt(anchorFrom(CELL), size, 1.5), { x: 1000 - 288 * 1.5, y: 672 - 208 * 1.5 });
});

test("overlayAt: it never leaves the window at the left or the top", () => {
  const small = { x: 160, y: 100, limit: 200 };
  assert.deepEqual(overlayAt(small, { width: 280, height: 200 }), { x: 8, y: 0 });
  assert.deepEqual(overlayAt(small, { width: 280, height: 200 }, 2), { x: 16, y: 0 });
});

test("overlayAt: no anchor yet means no place, and a zoom that isn't one counts as 1", () => {
  assert.equal(overlayAt(null, { width: 280, height: 200 }), null);
  assert.equal(overlayAt({ x: 1, y: 2 }, { width: 280, height: 200 }), null);
  assert.deepEqual(overlayAt(anchorFrom(CELL), { width: 280, height: 200 }, 0), { x: 712, y: 464 });
});

test("zoomOf: the app's zoom, 1 when it says nothing", () => {
  assert.equal(zoomOf({ zoom: 1.2 }), 1.2);
  assert.equal(zoomOf({ zoom: "1.5" }), 1.5);
  for (const bad of [null, undefined, {}, { zoom: 0 }, { zoom: -1 }, { zoom: "big" }]) assert.equal(zoomOf(bad), 1, JSON.stringify(bad));
});

test("moonBounds: the last cell of the status row, from the window's size and the zoom, needing no press", () => {
  assert.deepEqual(moonBounds({ width: 1000, height: 700 }), CELL);
  assert.deepEqual(moonBounds({ width: 1000, height: 700 }, 1.5), { x: 940, y: 658, width: 60, height: 42 });
  assert.equal(moonBounds(null), null);
  assert.equal(moonBounds({ width: 1000 }), null);
});

// ── How tall it opens (S12) ────────────────────────────────────────────────

const VIEW = { headline: "Agent sleep · nothing asleep", next: null, last: null, holds: [], debug: null, asleep: 0, settings: { enabled: true, idleMinutes: 30 } };

test("panelLines counts what sits between the rows and the buttons: holds, next, last", () => {
  assert.equal(panelLines(VIEW), 0);
  assert.equal(panelLines({ ...VIEW, next: "Next: app in 3 min" }), 1);
  assert.equal(panelLines({ ...VIEW, next: "n", last: "l", holds: ["a", "b"] }), 4);
  assert.equal(panelLines({ ...VIEW, debug: "fields: terminals()" }), 0, "debug is the headline's tooltip, no line of its own");
});

test("panelHeight grows by each line and stops at 6 lines", () => {
  const height = (holds) => panelHeight({ ...VIEW, last: "l", holds: Array.from({ length: holds }, (_, i) => `hold ${i}`) });
  assert.equal(height(1) - height(0), PANEL.line + PANEL.lineGap);
  assert.equal(height(5) - height(4), PANEL.line + PANEL.lineGap);
  assert.equal(height(6), height(5), "capped: past 6 lines the text area clips");
  assert.equal(height(40), height(5));
  assert.equal(PANEL.maxLines, 6);
});

test("panelHeight keeps one line free for what the buttons report, on top of the headline, rows and buttons", () => {
  const fixed = PANEL.frame + 2 * PANEL.padY + PANEL.headline + 2 * PANEL.row + PANEL.buttons + 4 * PANEL.gap;
  assert.equal(panelHeight(VIEW), fixed + PANEL.line, "no last yet: its line is there for Sleep now's result");
  assert.equal(panelHeight({ ...VIEW, last: "Woke app" }), fixed + PANEL.line, "a last already has it");
  assert.equal(panelHeight({ ...VIEW, next: "Automatic sleep is off" }), fixed + 2 * PANEL.line + PANEL.lineGap);
});

test("panelSpec: a popup of this mod, 280 wide, above the moon, saying which copy it asks", () => {
  const view = { ...VIEW, next: "Next: app in 3 min" };
  assert.deepEqual(panelSpec({ view, anchor: anchorFrom(CELL), zoom: 1, owner: COPY }), {
    mod: MOD,
    kind: "popup",
    width: 280,
    height: panelHeight(view),
    at: overlayAt(anchorFrom(CELL), { width: 280, height: panelHeight(view) }, 1),
    props: { view: "panel", owner: COPY },
  });
  assert.equal(PANEL.width, 280);
});

test("panelSpec with no anchor has no at, so Herdr opens it at the pointer", () => {
  assert.equal("at" in panelSpec({ view: VIEW, anchor: null }), false);
});

test("panelView: what the loop copy shared, or an empty panel when it hasn't yet", () => {
  assert.deepEqual(panelView(VIEW), VIEW);
  for (const bad of [undefined, null, "x", 3, []]) {
    const v = panelView(bad);
    assert.equal(v.headline, "Agent sleep", JSON.stringify(bad));
    assert.deepEqual(v.holds, []);
    assert.deepEqual(v.settings, { enabled: false, idleMinutes: 30 });
    assert.equal(panelLines(v), 0);
  }
  const partial = panelView({ headline: "h", holds: "nope", settings: { enabled: true } });
  assert.deepEqual(partial.holds, []);
  assert.deepEqual(partial.settings, { enabled: true, idleMinutes: 30 });
});

// ── The moon (S12) ─────────────────────────────────────────────────────────

test("the moon's color: dim off, muted on, accent with something asleep, off or on", () => {
  assert.equal(moonTone({ enabled: false, asleep: 0 }), "dim");
  assert.equal(moonTone({ enabled: true, asleep: 0 }), "muted");
  assert.equal(moonTone({ enabled: true, asleep: 2 }), "accent");
  assert.equal(moonTone({ enabled: false, asleep: 1 }), "accent", "off doesn't wake anyone");
});

test("the toggle guard: a moon click within 400 ms of the popup closing doesn't reopen it", () => {
  assert.equal(CLOSE_GUARD_MS, 400);
  assert.equal(closedJustNow(NOW, NOW + 399), true);
  assert.equal(closedJustNow(NOW, NOW + 400), false);
  for (const never of [undefined, null, "x", {}]) assert.equal(closedJustNow(never, NOW), false, JSON.stringify(never));
});

test("the toggle guard goes by the press: holding the button doesn't reopen what that press closed", () => {
  assert.equal(closedJustNow(NOW + 2, NOW + 700, NOW), true, "closed just after the press, released 700 ms later");
  assert.equal(closedJustNow(NOW - 2, NOW + 700, NOW), true, "closed just before the press reached the moon");
  assert.equal(closedJustNow(NOW, NOW + 1_100, NOW + 1_000), false, "closed long before this press: it opens");
  assert.equal(closedJustNow(NOW + 5_000, NOW, NOW), false, "a time ahead of the clock doesn't block the moon");
});

test("makeRequest: a command, the copy it asks and an id of its own", () => {
  const a = makeRequest("toggle", NOW, COPY);
  const b = makeRequest("toggle", NOW, COPY);
  assert.equal(a.command, "toggle");
  assert.equal(a.owner, COPY);
  assert.equal(typeof a.id, "string");
  assert.notEqual(a.id, b.id, "the same click twice in a millisecond is two requests");
});

// ── The command table, through a pulse (D14) ───────────────────────────────

test("one table: the two keys and the popup's three, no others", () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), ["less", "more", "sleep-now", "toggle", "wake-all"]);
});

test("toggle: a request flips enabled, the next pulse saves it", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(saved(w).enabled, true);
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  await at(co, w, NOW + 1_000);
  assert.deepEqual(saved(w), { enabled: false, idleMinutes: 30 });
  w.now = NOW + 2_000;
  ask(w, "r2", "toggle");
  await at(co, w, NOW + 2_000);
  assert.deepEqual(saved(w), { enabled: true, idleMinutes: 30 });
});

test("toggle on a fresh install: the file is written, turned on", async () => {
  const { w, co } = setup({ settings: null });
  await at(co, w, NOW);
  assert.equal(w.files[SETTINGS], undefined);
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  await at(co, w, NOW + 1_000);
  assert.deepEqual(saved(w), { enabled: true, idleMinutes: 30 });
});

test("less and more step the window as stepMinutes does, and stop at its ends", async () => {
  const { w, co } = setup();
  let now = NOW;
  await at(co, w, now);
  const press = async (command) => {
    now += 1_000;
    w.now = now;
    ask(w, `r${now}`, command);
    await at(co, w, now);
    return saved(w).idleMinutes;
  };
  assert.equal(await press("more"), stepMinutes(30, 1));
  assert.equal(await press("less"), 30);
  assert.equal(await press("less"), stepMinutes(30, -1));
  for (let i = 0; i < 20; i++) await press("less");
  assert.equal(saved(w).idleMinutes, 1);
  for (let i = 0; i < 20; i++) await press("more");
  assert.equal(saved(w).idleMinutes, 1440);
});

test("sleep-now and wake-all: a request does what the key does", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "sleep-now");
  await at(co, w, NOW + 1_000);
  assert.deepEqual(exits(w).map((s) => s.address), ["t1"]);
  exitClaude(w, "t1");
  await at(co, w, NOW + 2_000);
  assert.equal(records(w).t1.state, "asleep");
  w.now = NOW + 3_000;
  ask(w, "r2", "wake-all");
  await at(co, w, NOW + 3_000);
  assert.deepEqual(resumes(w).map((s) => s.text), [`CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume ${SID1}`]);
});

test("a key goes through the same table; an unknown one says so and does nothing", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  assert.equal(co.command("toggle"), true);
  await at(co, w, NOW + 1_000);
  assert.equal(saved(w).enabled, false);
  const before = w.files[SETTINGS];
  assert.equal(co.command("nope"), false);
  await at(co, w, NOW + 2_000);
  assert.equal(w.files[SETTINGS], before);
  assert.ok(w.logs.some((l) => l.includes('no command "nope"')));
});

test("a key before the settings are read waits for them: toggle and more act on what the file says", async () => {
  const { w, co } = setup({ settings: { enabled: true, idleMinutes: 60 } });
  assert.equal(co.command("toggle"), true);
  assert.equal(co.command("more"), true);
  assert.equal(co.command("nope"), false, "an unknown one is still refused at once");
  await at(co, w, NOW);
  assert.deepEqual(saved(w), { enabled: false, idleMinutes: stepMinutes(60, 1) });
});

test("the popup's lines follow the shown setting: no \"off\" under a switch just turned on, and the other way", async () => {
  const off = setup({ settings: { enabled: false, idleMinutes: 30 } });
  await at(off.co, off.w, NOW);
  assert.equal(off.co.view().next, "Automatic sleep is off");
  off.co.command("toggle");
  assert.equal(off.co.view().next, null, "before the save");

  const on = setup();
  await at(on.co, on.w, NOW);
  on.co.command("toggle");
  assert.equal(on.co.view().next, "Automatic sleep is off", "before the save");
});

// ── A request runs once (D14) ──────────────────────────────────────────────

test("the same id runs once, however many renders and pulses see it", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  assert.equal(co.takeRequest(), true);
  assert.equal(co.takeRequest(), false);
  await at(co, w, NOW + 1_000);
  assert.equal(saved(w).enabled, false);
  assert.equal(co.takeRequest(), false);
  await at(co, w, NOW + 2_000);
  await at(co, w, NOW + 3_000);
  assert.equal(saved(w).enabled, false, "not flipped back");
});

test("taking a request does no I/O: it is shown at once, written and typed by the next pulse", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  const writes = w.writes.length;
  const calls = w.calls.length;
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  co.takeRequest();
  ask(w, "r2", "sleep-now");
  co.takeRequest();
  assert.equal(w.writes.length, writes);
  assert.equal(w.calls.length, calls);
  assert.equal(co.shownSettings().enabled, false, "the popup's switch follows at once");
  assert.equal(saved(w).enabled, true, "the file doesn't, yet");
  await at(co, w, NOW + 1_000);
  assert.equal(saved(w).enabled, false);
  assert.equal(exits(w).length, 1);
});

test("two clicks before a pulse both count: toggle twice leaves it as it was, more twice steps twice", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 500;
  ask(w, "r1", "toggle");
  co.takeRequest();
  ask(w, "r2", "toggle");
  co.takeRequest();
  ask(w, "r3", "more");
  co.takeRequest();
  ask(w, "r4", "more");
  co.takeRequest();
  await at(co, w, NOW + 1_000);
  assert.deepEqual(saved(w), { enabled: true, idleMinutes: stepMinutes(stepMinutes(30, 1), 1) });
});

test("a click while the last change is being saved counts on top of it, and the switch doesn't jump back meanwhile", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  // The second click lands inside the first one's save, as a render can.
  const write = co.d.files.write;
  let during = null;
  co.d.files.write = async (...args) => {
    if (during === null) {
      during = co.shownSettings().enabled;
      ask(w, "r2", "toggle");
      co.takeRequest();
    }
    return write(...args);
  };
  await at(co, w, NOW + 1_000);
  assert.equal(during, false, "shown as asked while it is written");
  assert.equal(co.shownSettings().enabled, true, "the second click flipped the first one's result");
  await at(co, w, NOW + 2_000);
  assert.equal(saved(w).enabled, true);
});

test("a new copy never runs its predecessor's request, however recent: a reload doesn't undo a click", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "toggle");
  await at(co, w, NOW + 1_000);
  assert.equal(saved(w).enabled, false);

  const fresh = new Coordinator({ ...deps(w), copyId: "copy-after-reload" });
  await at(fresh, w, NOW + 1_001);
  await at(fresh, w, NOW + 2_000);
  assert.equal(saved(w).enabled, false, "not flipped back");
});

test("an old click in shared.json types nothing in a new copy", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "sleep-now");
  await at(co, w, NOW + 1_000);
  assert.equal(exits(w).length, 1);
  exitClaude(w, "t1");
  await at(co, w, NOW + 2_000);

  const before = w.sends.length;
  const fresh = new Coordinator({ ...deps(w), copyId: "copy-after-restart" });
  await at(fresh, w, NOW + 2_001);
  await at(fresh, w, NOW + 3_000);
  assert.equal(w.sends.length, before);
});

test("only the copy that opened the popup runs its clicks: another window's, or none, doesn't", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  for (const [id, owner] of [["other", "copy-of-another-window"], ["none", undefined], ["number", 7]]) {
    ask(w, id, "toggle", { owner });
    assert.equal(co.takeRequest(), false, id);
  }
  assert.equal(co.shownSettings().enabled, true);
  ask(w, "mine", "toggle");
  assert.equal(co.takeRequest(), true);
  assert.equal(co.shownSettings().enabled, false);
});

test("an unknown command, or a request that isn't one, is ignored", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  const before = w.files[SETTINGS];
  for (const [i, command] of ["nope", "constructor", "__proto__", "toString", 42, null, undefined].entries()) {
    ask(w, `r${i}`, command);
    assert.equal(co.takeRequest(), false, String(command));
  }
  for (const bad of [null, undefined, "toggle", 3, [], {}, { command: "toggle", at: NOW }, { id: 7, at: NOW, command: "toggle" }]) {
    w.shared[REQUEST_KEY] = bad;
    assert.equal(co.takeRequest(), false, JSON.stringify(bad));
  }
  await at(co, w, NOW + 1_000);
  assert.equal(w.files[SETTINGS], before);
  assert.equal(w.sends.length, 0);
});

test("a request a render saw before the settings were read isn't lost nor run on the defaults", async () => {
  const { w, co } = setup({ settings: { enabled: true, idleMinutes: 45 } });
  ask(w, "r1", "toggle");
  assert.equal(co.takeRequest(), false, "too early: the defaults say off, the file says on");
  await at(co, w, NOW);
  assert.deepEqual(saved(w), { enabled: false, idleMinutes: 45 }, "the first pulse takes it, against the file");
});

test("a pulse takes a request by itself, for a render that never came", async () => {
  const { w, co } = setup();
  await at(co, w, NOW);
  w.now = NOW + 1_000;
  ask(w, "r1", "more");
  assert.equal(await at(co, w, NOW + 1_000), true, "and says the view changed, so main.js redraws");
  assert.equal(saved(w).idleMinutes, stepMinutes(30, 1));
});

// ── The loop copy shares its view (D14) ────────────────────────────────────

test("viewToPublish: nothing before the first pulse, then the view only when its JSON changed, so a redraw can't loop", async () => {
  const { w, co } = setup();
  assert.equal(co.viewToPublish(), null, "defaults aren't worth sharing over what shared.json has");
  await at(co, w, NOW);
  const first = co.viewToPublish();
  assert.deepEqual(first, co.view());
  assert.equal(first.settings.enabled, true);
  assert.equal(co.viewToPublish(), null);
  assert.equal(co.viewToPublish(), null);
  await at(co, w, NOW + 1_000);
  assert.equal(co.viewToPublish(), null, "a pulse that changed nothing");
  w.now = NOW + 2_000;
  ask(w, "r1", "toggle");
  co.takeRequest();
  assert.equal(co.viewToPublish().settings.enabled, false, "a click shows at once");
  assert.equal(co.viewToPublish(), null);
});

test("the view carries what the popup draws, and the coordinator doesn't publish it itself", async () => {
  const { w, co } = setup();
  exitClaude(w, "t1", SHELL_BARE);
  storeRecord(w, "t1");
  await at(co, w, NOW);
  const view = co.view();
  assert.equal(view.headline, "Agent sleep · 1 asleep · ~300 MB freed");
  assert.equal(view.asleep, 1);
  assert.equal(view.debug, "fields: terminals()");
  assert.deepEqual(view.settings, { enabled: true, idleMinutes: 30 });
  assert.equal(w.shared[VIEW_KEY], undefined, "main.js publishes it, from a task, never from inside render");
});

// ── main.js and the views, by their source ─────────────────────────────────

test("the sidebar block is gone: its files, the rail and the settings mode", () => {
  for (const f of ["rail.js", "views/block.js", "views/settings.js"]) assert.equal(existsSync(mod(f)), false, f);
  assert.equal(existsSync(new URL("./rail.test.js", import.meta.url)), false);
  assert.doesNotMatch(src("main.js"), /\bmode\b/, "no Settings/Done mode");
});

test("only the loop copy has a coordinator: the panel view draws from shared and asks by naming a command", () => {
  const main = src("main.js");
  assert.match(main, /if \(!isLoopCopy\(pr\)\) return;\s*this\.co = new Coordinator\(/);
  assert.match(main, /panelView\(shared\(VIEW_KEY\)\)/);
  assert.match(main, /setShared\(REQUEST_KEY, makeRequest\(/);
  const panel = src("views/panel.js");
  for (const io of [/\bCoordinator\b/, /writeTextFile|readTextFile|\bhc\(|\bexec\(/]) assert.doesNotMatch(panel, io);
});

test("the view is published after render, by a task that yields first", () => {
  assert.match(src("main.js"), /viewToPublish\(view\)[\s\S]{0,160}cx\.spawn\(async \(cx\) => \{\s*await cx\.sleep\(0\);\s*setShared\(VIEW_KEY, published\);/);
});

test("the first frame has no window size yet: pulses redraw the moon until its place is known", () => {
  assert.match(src("main.js"), /\(await this\.co\.pulse\(\{[^}]*\}\)\) \|\| this\.anchor === null\) cx\.notify\(\)/);
});

test("a key opens over the moon's cell as it is now: a press's bounds only ever reach its own click", () => {
  const main = src("main.js");
  assert.match(main, /this\.anchor = anchorFrom\(moonBounds\(window\.viewport_size\(\), zoomOf\(settings\(\)\)\)\);/);
  assert.match(main, /toggle\(\) \{\s*const pressedAt = this\.pressedAt \?\? undefined;\s*const anchor = anchorFrom\(this\.pressed\) \?\? this\.anchor;\s*this\.pressed = null;\s*this\.pressedAt = null;/, "cleared before the guard can return");
});

test("the moon knows its cell with no press and no size event, and the popup marks its close", () => {
  const main = src("main.js");
  assert.match(main, /moonBounds\(window\.viewport_size\(\), zoomOf\(settings\(\)\)\)/);
  assert.doesNotMatch(main, /this\.size|measure\(/, "a fixed cell has no size change to wait for");
  assert.match(main, /async close\(\) \{\s*if \(this\.overlay\) setShared\(CLOSED_KEY, Date\.now\(\)\);/);
  assert.match(main, /closedJustNow\(shared\(CLOSED_KEY\), Date\.now\(\), pressedAt\)/);
  const status = src("views/status.js");
  assert.doesNotMatch(status, /on_size_change/);
  assert.match(status, /\.on_mouse_down\("left", onPress\)/);
  assert.match(status, /\.tooltip\(model\.headline\)/);
});

test("the popup's text area gives way, its buttons never: flex_1 + min_h(0) + overflow_hidden, then a flex_none row", () => {
  const panel = src("views/panel.js");
  assert.match(panel, /v_flex\(\)\.flex_1\(\)\.min_h\(0\)\.overflow_hidden\(\)/);
  assert.match(panel, /h_flex\(\)\.flex_none\(\)[^\n]*\n[^\n]*"agent-sleep-sleep-now"/);
  assert.match(panel, /\.tooltip\(view\.debug\)/, "the headline's tooltip is the debug line");
});

test("herdr-app check has no window: that copy draws and starts nothing", () => {
  assert.match(src("main.js"), /if \(!appWindow\(\)\) return;\s*startLoop\(/);
});

test("the panel command opens the popup from main.js; every other name goes to the table", () => {
  assert.match(src("main.js"), /c === "panel"[\s\S]{0,60}this\.openPanel\(\)[\s\S]{0,60}this\.co\.command\(c\)/);
  assert.equal(Object.hasOwn(COMMANDS, "panel"), false);
});
