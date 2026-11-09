// workspace-sleep T3 (D9): workspaces.json, the state of the workspaces a
// person put to sleep, and its reconcile against Herdr's spaces. Pure: the
// file calls are injected, as store.js's are.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACES_VERSION, ENTRY_STATES, workspacesPaths, parseWorkspaces, serializeWorkspaces, loadWorkspaces, saveWorkspaces,
  withEntry, withoutEntry, listedTabs, terminalsOf, reconcileSpaces,
} from "../mods/agent-sleep/workspaces-store.js";

const APP = "/Users/demo/.config/herdr-app";
const p = workspacesPaths(APP);
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

// A fake readTextFile / writeTextFile pair: the write is a compare-and-swap.
function memory(files = {}) {
  return {
    files,
    read: async (path) => (Object.hasOwn(files, path) ? files[path] : null),
    write: async (path, text, expected) => {
      const current = Object.hasOwn(files, path) ? files[path] : null;
      if (current !== expected) throw new Error(`stale snapshot for ${path}`);
      files[path] = text;
      return null;
    },
    mkdirp: async () => {},
  };
}

const entry = (over = {}) => ({ spaces: { s1: ["a1", "a2"], s2: ["a3"] }, state: "asleep", at: NOW, ...over });
const file = (workspaces, version = WORKSPACES_VERSION) => JSON.stringify({ version, workspaces });

// Herdr's spaces(): `settled` per tab (TabInfo.settled).
const space = (id, tabs, over = {}) => ({
  id, machine: null, active: false, tabs: Object.entries(tabs).map(([tab, settled]) => ({ id: tab, active: false, settled })), ...over,
});
const panes = [
  { pane: "p1", terminal: "t1", tab: "a1", cwd: "/code/app" },
  { pane: "p2", terminal: "t2", tab: "a2", cwd: "/code/app" },
  { pane: "p3", terminal: "t3", tab: "a3", cwd: "/code/app" },
  { pane: "p4", terminal: null, tab: "a3", mod: "projects", cwd: null },
];

// ── The file ────────────────────────────────────────────────────────────────

test("workspaces.json and its .bak live beside sleeping.json, under appHome()/agent-sleep", () => {
  assert.deepEqual(p, {
    dir: `${APP}/agent-sleep`,
    file: `${APP}/agent-sleep/workspaces.json`,
    bak: `${APP}/agent-sleep/workspaces.json.bak`,
  });
  assert.equal(workspacesPaths(`${APP}/`).file, p.file);
  assert.deepEqual(ENTRY_STATES, ["sleeping", "asleep"]);
});

test("a missing file is no entries; a valid one reads back as itself, its optional fields kept", () => {
  assert.deepEqual(parseWorkspaces(null), { entries: {}, bad: false });
  const entries = {
    "/code/app": entry(),
    "/code/checkout-flow": entry({ spaces: { s3: ["b1"] }, state: "sleeping", shownAtSleep: true, wakeAfter: true }),
  };
  const text = serializeWorkspaces(entries);
  assert.equal(text, `${JSON.stringify({ version: 1, workspaces: entries }, null, 2)}\n`);
  assert.deepEqual(parseWorkspaces(text), { entries, bad: false });
});

test("an invalid file reads as no entries, flagged bad; a bad entry is dropped and the rest kept", () => {
  for (const text of ["{", "[]", "null", file({}, 2), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, workspaces: [] })]) {
    assert.deepEqual(parseWorkspaces(text), { entries: {}, bad: true }, text);
  }
  const good = entry();
  const bads = [
    entry({ state: "waking" }),
    entry({ spaces: {} }),
    entry({ spaces: { s1: "a1" } }),
    entry({ spaces: { s1: [""] } }),
    entry({ at: "noon" }),
    entry({ shownAtSleep: "yes" }),
    entry({ wakeAfter: 1 }),
    "asleep",
  ];
  for (const bad of bads) {
    const parsed = parseWorkspaces(file({ "/code/app": good, "/code/other": bad }));
    assert.deepEqual(parsed, { entries: { "/code/app": good }, bad: true }, JSON.stringify(bad));
  }
  for (const key of ["relative/path", ""]) {
    assert.deepEqual(parseWorkspaces(file({ [key]: good })), { entries: {}, bad: true }, key);
  }
  const proto = parseWorkspaces(`{"version":1,"workspaces":{"__proto__":${JSON.stringify(good)}}}`);
  assert.equal(proto.bad, true);
  assert.deepEqual(Object.keys(proto.entries), []);
  assert.equal(Object.getPrototypeOf(proto.entries), Object.prototype, "a __proto__ key never reaches the prototype");
});

test("an invalid file → defaults, and the bad one is kept as .bak", async () => {
  const io = memory({ [p.file]: "{ not json" });
  const loaded = await loadWorkspaces(io, p);
  assert.deepEqual(loaded, { entries: {}, text: "{ not json" });
  assert.equal(io.files[p.bak], "{ not json");
  const fine = memory({ [p.file]: file({ "/code/app": entry() }) });
  assert.deepEqual((await loadWorkspaces(fine, p)).entries, { "/code/app": entry() });
  assert.equal(Object.hasOwn(fine.files, p.bak), false, "a good file leaves no .bak");
  assert.deepEqual(await loadWorkspaces(memory(), p), { entries: {}, text: null });
});

test("saving is a compare-and-swap: written over what was read, refused over a file that changed", async () => {
  const io = memory();
  const text = await saveWorkspaces(io, p, { "/code/app": entry() }, null);
  assert.equal(io.files[p.file], text);
  const next = await saveWorkspaces(io, p, {}, text);
  assert.equal(io.files[p.file], next);
  await assert.rejects(saveWorkspaces(io, p, { "/code/app": entry() }, text), /stale/);
  assert.equal(io.files[p.file], next, "the refused write left the file alone");
});

test("updates return new values; the listed tabs and their terminals, in panes() order", () => {
  const before = { "/code/app": entry() };
  const after = withEntry(before, "/code/x", entry({ state: "sleeping" }));
  assert.deepEqual(Object.keys(before), ["/code/app"]);
  assert.deepEqual(Object.keys(after), ["/code/app", "/code/x"]);
  assert.deepEqual(Object.keys(withoutEntry(after, "/code/app")), ["/code/x"]);
  assert.deepEqual(listedTabs(entry()), ["a1", "a2", "a3"]);
  assert.deepEqual(terminalsOf(entry(), panes), ["t1", "t2", "t3"], "a mod pane has no terminal");
  assert.deepEqual(terminalsOf(entry({ spaces: { s2: ["a3"] } }), panes), ["t3"]);
});

// ── reconcileSpaces (D9's rules, in order) ──────────────────────────────────

const both = (a1, a2, a3) => [space("s1", { a1, a2 }), space("s2", { a3 })];

test("rule 1: one of two spaces gone → that space is dropped from the entry; the last one gone → the entry is dropped", () => {
  const entries = { "/code/app": entry() };
  const one = reconcileSpaces({ entries, spaces: [space("s1", { a1: true, a2: true }), space("other", { x: false })], panes, records: {} });
  assert.equal(one.changed, true);
  assert.deepEqual(one.entries, { "/code/app": entry({ spaces: { s1: ["a1", "a2"] } }) });
  const none = reconcileSpaces({ entries: one.entries, spaces: [space("other", { x: false })], panes, records: {} });
  assert.deepEqual(none.entries, {});
  assert.deepEqual(entries, { "/code/app": entry() }, "the input stays");
});

test("rule 2: an asleep entry with none of its tabs still settled (woken by hand) is dropped; one settled tab keeps it", () => {
  const entries = { "/code/app": entry() };
  assert.deepEqual(reconcileSpaces({ entries, spaces: both(false, false, false), panes, records: {} }).entries, {});
  const kept = reconcileSpaces({ entries, spaces: both(false, false, true), panes, records: {} });
  assert.equal(kept.changed, false);
  assert.deepEqual(kept, { entries, replan: [], finish: [], changed: false });
});

test("rule 2 at start: a sleeping entry whose tabs were never settled (a reload between steps 2 and 3) is dropped", () => {
  const entries = { "/code/app": entry({ state: "sleeping" }) };
  const r = reconcileSpaces({ entries, spaces: both(false, false, false), panes, records: {}, start: true });
  assert.deepEqual(r, { entries: {}, replan: [], finish: [], changed: true });
});

test("rule 2 leaves a sleep this copy is running: tabs its interrupts brought back go to step 6, which settles them again", () => {
  const entries = { "/code/app": entry({ state: "sleeping" }) };
  const running = reconcileSpaces({ entries, spaces: both(false, false, false), panes, records: {}, queued: new Set(["/code/app"]) });
  assert.deepEqual(running, { entries, replan: [], finish: [], changed: false });
  const done = reconcileSpaces({ entries, spaces: both(false, false, false), panes, records: {} });
  assert.deepEqual(done.finish, ["/code/app"]);
});

test("rule 3: at start a sleeping entry is planned again (steps 4–5); one a click already woke is not", () => {
  const entries = {
    "/code/app": entry({ state: "sleeping" }),
    "/code/x": entry({ spaces: { s3: ["c1"] }, state: "sleeping", wakeAfter: true }),
  };
  const spaces = [...both(true, true, true), space("s3", { c1: true })];
  const r = reconcileSpaces({ entries, spaces, panes, records: {}, start: true });
  assert.deepEqual(r.replan, ["/code/app"]);
  assert.deepEqual(r.finish, ["/code/x"], "rule 4: its step 6 wakes it (D4)");
  assert.equal(r.changed, false);
});

test("rule 4: sleeping with nothing queued and no stopping record left → step 6; queued, or a stop still under way → not yet", () => {
  const entries = { "/code/app": entry({ state: "sleeping" }) };
  const spaces = both(true, true, true);
  assert.deepEqual(reconcileSpaces({ entries, spaces, panes, records: {} }).finish, ["/code/app"]);
  assert.deepEqual(reconcileSpaces({ entries, spaces, panes, records: {}, queued: ["/code/app"] }).finish, []);
  const stopping = { t2: { state: "stopping" }, t9: { state: "asleep" } };
  assert.deepEqual(reconcileSpaces({ entries, spaces, panes, records: stopping }).finish, [], "t2 is still exiting");
  const elsewhere = { t9: { state: "stopping" }, t1: { state: "asleep" } };
  assert.deepEqual(reconcileSpaces({ entries, spaces, panes, records: elsewhere }).finish, ["/code/app"], "a stop in another workspace doesn't hold it");
  assert.deepEqual(reconcileSpaces({ entries: { "/code/app": entry() }, spaces, panes, records: {} }).finish, [], "asleep already");
});

test("no spaces at all (Core not there yet) is no evidence: nothing is decided", () => {
  const entries = { "/code/app": entry() };
  for (const spaces of [[], undefined, null]) {
    assert.deepEqual(reconcileSpaces({ entries, spaces, panes, records: {}, start: true }), { entries, replan: [], finish: [], changed: false });
  }
});
