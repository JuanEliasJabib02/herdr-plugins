// T4, S6: opening a file (code-explorer/tree-model.js). A file opens in a tab of
// its own, never a split. planOpen is the pure decision (select, replace or new,
// D11, D18); findNewTab accepts only a tab holding a code-file pane (D10), since
// Claude can open a tab at the same moment; openFile runs the sequence against a
// fake Herdr that, like the real one, shows a new tab only after a wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOCS_KEY, LIVE_KEY, closeCommand, findNewTab, newDoc, nextDocs, openFile, planOpen, table,
} from "../code-editor/mods/code-explorer/tree-model.js";

const FILE = "/r/src/a.js";
const tab = (id, over = {}) => ({ id, index: 1, active: false, panes: 1, ...over });
const docOf = (doc, file, preview) => ({ doc, file, preview });

// ── The keys code-tabs and code-file read ──────────────────────────────────

test("D10: the two shared keys", () => {
  assert.equal(DOCS_KEY, "code-editor.docs");
  assert.equal(LIVE_KEY, "code-editor.live");
});

test("D10: a doc id is safe in a file name and in a mod command", () => {
  const ids = new Set(Array.from({ length: 200 }, newDoc));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{8,}$/);
});

// ── planOpen: the pure decision ────────────────────────────────────────────

const plan = (over = {}) => planOpen({
  file: FILE, pin: false, tabs: [], docs: {}, live: {},
  panes: (over.tabs ?? []).map((t) => ({ tab: t.id, mod: "code-file" })),
  ...over,
});

test("D18: a tab that kept its docs entry but lost the file's pane isn't the file: it opens anew", () => {
  const tabs = [{ id: "tb1", panes: 1 }];
  const docs = { tb1: { doc: "d1", file: FILE, preview: true } };
  const panes = [{ tab: "tb1", mod: null, program: { name: "sh" } }];
  assert.deepEqual(plan({ tabs, docs, panes }), { kind: "new" });
  // And a terminal left behind is never a preview to replace, or it would go with it.
  assert.deepEqual(plan({ file: "/elsewhere.js", tabs, docs, panes }), { kind: "new" });
});

test("S6: nothing open and no preview: a new tab", () => {
  assert.deepEqual(plan(), { kind: "new" });
  assert.deepEqual(plan({ tabs: [tab("t1")] }), { kind: "new" }, "a terminal tab is never replaced");
});

test("D11: already open: select it, wherever it is, preview or not", () => {
  const tabs = [tab("t1"), tab("t2")];
  assert.deepEqual(plan({ tabs, docs: { t2: docOf("d2", FILE, false) } }), { kind: "select", id: "t2", pin: false });
  assert.deepEqual(plan({ tabs, docs: { t2: docOf("d2", FILE, true) } }), { kind: "select", id: "t2", pin: false });
});

test("D11: a double click on what's open in preview pins it; already pinned, nothing to pin", () => {
  const tabs = [tab("t2")];
  assert.deepEqual(plan({ pin: true, tabs, docs: { t2: docOf("d2", FILE, true) } }), { kind: "select", id: "t2", pin: true });
  assert.deepEqual(plan({ pin: true, tabs, docs: { t2: docOf("d2", FILE, false) } }), { kind: "select", id: "t2", pin: false });
});

test("D11: a preview of another file is replaced", () => {
  const tabs = [tab("t1"), tab("t2")];
  assert.deepEqual(plan({ tabs, docs: { t2: docOf("d2", "/r/old.js", true) } }), { kind: "replace", id: "t2" });
});

test("D11: a pinned tab of another file is left alone", () => {
  assert.deepEqual(plan({ tabs: [tab("t2")], docs: { t2: docOf("d2", "/r/old.js", false) } }), { kind: "new" });
});

test("D11: a preview with changes, or one code-file pinned, is never replaced", () => {
  const tabs = [tab("t2")], docs = { t2: docOf("d2", "/r/old.js", true) };
  assert.deepEqual(plan({ tabs, docs, live: { d2: { dirty: true, pinned: false } } }), { kind: "new" });
  assert.deepEqual(plan({ tabs, docs, live: { d2: { dirty: false, pinned: true } } }), { kind: "new" });
  assert.deepEqual(plan({ tabs, docs, live: { d2: { dirty: false, pinned: false } } }), { kind: "replace", id: "t2" });
});

test("D18: a preview with panes > 1 stays and is never replaced: a terminal lives beside it", () => {
  const docs = { t2: docOf("d2", "/r/old.js", true) };
  assert.deepEqual(plan({ tabs: [tab("t2", { panes: 2 })], docs }), { kind: "new" });
  assert.deepEqual(plan({ tabs: [tab("t2", { panes: 1 })], docs }), { kind: "replace", id: "t2" });
});

test("D11: opening pinned adds a tab and leaves the preview where it is", () => {
  assert.deepEqual(plan({ pin: true, tabs: [tab("t2")], docs: { t2: docOf("d2", "/r/old.js", true) } }), { kind: "new" });
});

test("D10: entries of tabs in another space, or gone, decide nothing here", () => {
  const docs = { other: docOf("d9", FILE, false), gone: docOf("d8", "/r/old.js", true) };
  assert.deepEqual(plan({ tabs: [tab("t1")], docs }), { kind: "new" });
});

test("Risk 1: code-editor.docs persists: a broken or foreign value decides nothing and breaks nothing", () => {
  for (const docs of [null, undefined, "x", 3, [], { t1: null }, { t1: "x" }, { t1: { file: 3 } }]) {
    assert.deepEqual(plan({ tabs: [tab("t1")], docs }), { kind: "new" }, JSON.stringify(docs));
  }
  assert.deepEqual(plan({ tabs: [tab("t2")], docs: { t2: docOf("d2", "/r/old.js", true) }, live: "x" }), { kind: "replace", id: "t2" });
  assert.deepEqual(table([]), {});
  assert.deepEqual(table("x"), {});
  assert.deepEqual(table(null), {});
  assert.deepEqual(table({ a: 1 }), { a: 1 });
  // A tab id named like something every object inherits finds nothing.
  assert.deepEqual(plan({ tabs: [tab("constructor")], docs: {} }), { kind: "new" });
});

// ── findNewTab: only a tab holding a code-file pane ────────────────────────

const pane = (id, tabId, mod) => ({ pane: id, tab: tabId, terminal: mod ? null : "a", ...(mod ? { mod } : {}) });

test("D10, Risk 4: a new tab counts only with a code-file pane in it", () => {
  const before = new Set(["t1"]);
  const space = { tabs: [tab("t1"), tab("t2")] };
  assert.equal(findNewTab(before, space, [pane("p2", "t2", "code-file")]), "t2");
  assert.equal(findNewTab(before, space, [pane("p2", "t2")]), null, "Claude's terminal tab");
  assert.equal(findNewTab(before, space, [pane("p2", "t2", "other-mod")]), null);
  assert.equal(findNewTab(before, space, []), null, "its panes aren't listed yet");
  assert.equal(findNewTab(before, { tabs: [tab("t1")] }, [pane("p1", "t1", "code-file")]), null, "an old code-file tab isn't new");
  assert.equal(findNewTab(before, undefined, []), null, "the space is gone");
});

test("D10, Risk 4: Claude's tab and ours land together: ours is the one", () => {
  const before = new Set(["t1"]);
  const space = { tabs: [tab("t1"), tab("claude"), tab("ours")] };
  assert.equal(findNewTab(before, space, [pane("c", "claude"), pane("o", "ours", "code-file")]), "ours");
});

// ── closeCommand: D18's way to close ───────────────────────────────────────

test("D18: alone in its tab, tab.close; beside a terminal, pane.close with its pane; never confirmed", () => {
  assert.deepEqual(closeCommand(tab("t2"), [pane("p2", "t2", "code-file")]), ["tab.close", { id: "t2" }]);
  const panes = [pane("term", "t2"), pane("file", "t2", "code-file")];
  assert.deepEqual(closeCommand(tab("t2", { panes: 2 }), panes), ["pane.close", { pane: "file" }]);
  assert.equal(closeCommand(tab("t2", { panes: 2 }), [pane("term", "t2")]), null, "no file pane to close: nothing, never the focused terminal");
});

// ── nextDocs ───────────────────────────────────────────────────────────────

test("D10: writing an entry drops tabs that no longer exist, in any space", () => {
  const docs = { old: docOf("d0", "/r/x", false), t1: docOf("d1", "/r/y", false), elsewhere: docOf("d3", "/s/z", true) };
  assert.deepEqual(nextDocs(docs, ["t1", "elsewhere", "t2"], "t2", docOf("d2", FILE, true)), {
    t1: docOf("d1", "/r/y", false), elsewhere: docOf("d3", "/s/z", true), t2: docOf("d2", FILE, true),
  });
  assert.deepEqual(nextDocs("broken", ["t2"], "t2", docOf("d2", FILE, true)), { t2: docOf("d2", FILE, true) });
});

// ── openFile against a fake Herdr ──────────────────────────────────────────

function fakeHerdr({ tabs = [tab("t1", { index: 1, active: true })], docs, live, showAfter = 2, newTabId = "new", mod = "code-file", extra = [], panes = [], onWait } = {}) {
  const state = {
    tabs: tabs.map((t) => ({ ...t })), panes: [...panes], shared: { [DOCS_KEY]: docs, [LIVE_KEY]: live }, calls: [], writes: [], toasts: [], waits: 0, pending: null,
  };
  const reindex = () => state.tabs.forEach((t, i) => { t.index = i + 1; });
  const io = {
    spaces: () => [{ id: "s1", tabs: state.tabs.map((t) => ({ ...t })) }, { id: "s2", tabs: [tab("far")] }],
    panes: () => state.panes,
    shared: (key) => state.shared[key],
    setShared: (key, value) => { state.shared[key] = value; state.writes.push([key, value]); },
    notify: (n) => { state.toasts.push(n); },
    newDoc: () => "doc1",
    wait: async (ms) => {
      assert.equal(ms, 10, "D10: polls every 10 ms");
      state.waits++;
      onWait?.(state);
      if (state.pending && state.waits >= showAfter) {
        const { args } = state.pending;
        state.pending = null;
        const active = state.tabs.findIndex((t) => t.active);
        state.tabs.forEach((t) => { t.active = false; });
        for (const made of extra) { state.tabs.push(tab(made.id, { active: false })); state.panes.push(pane(`p-${made.id}`, made.id, made.mod)); }
        state.tabs.splice(active + 1, 0, tab(newTabId, { active: true }));
        state.panes.push(pane(`p-${newTabId}`, newTabId, mod));
        reindex();
        assert.equal(args.mod, "code-file");
      }
    },
    run: (name, args) => {
      state.calls.push([name, args]);
      if (name === "tab.new") { if (showAfter !== Infinity) state.pending = { args }; }
      if (name === "tab.move") {
        const from = state.tabs.findIndex((t) => t.id === args.id);
        const [moved] = state.tabs.splice(from, 1);
        state.tabs.splice(args.index - 1, 0, moved);
        reindex();
      }
      if (name === "tab.close") { state.tabs = state.tabs.filter((t) => t.id !== args.id); reindex(); }
      return null;
    },
  };
  return { state, io };
}
const names = (state) => state.calls.map(([name]) => name);

test("S6, D10: a new file: tab.new with the mod and D10's props, in a tab of its own, then its docs entry", async () => {
  const { state, io } = fakeHerdr();
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(state.calls, [["tab.new", { name: "a.js", space: "s1", mod: "code-file", props: { doc: "doc1", file: FILE } }]]);
  assert.ok(!names(state).includes("pane.split"), "S6: never beside, always a new tab");
  assert.deepEqual(state.writes, [[DOCS_KEY, { new: docOf("doc1", FILE, true) }]]);
  assert.deepEqual(result, { kind: "new", id: "new", doc: "doc1" });
  assert.equal(state.toasts.length, 0);
});

test("D11: opened pinned, it isn't a preview", async () => {
  const { state, io } = fakeHerdr();
  await openFile({ file: FILE, pin: true, space: "s1" }, io);
  assert.deepEqual(state.shared[DOCS_KEY], { new: docOf("doc1", FILE, false) });
});

test("D10: the id comes from waiting: spaces() doesn't change in the same tick", async () => {
  const { state, io } = fakeHerdr({ showAfter: 3 });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.equal(state.waits, 3);
  assert.deepEqual(Object.keys(state.shared[DOCS_KEY]), ["new"]);
});

test("D10: no tab within 1 s: a toast, and nothing written", async () => {
  const { state, io } = fakeHerdr({ showAfter: Infinity, docs: { t1: docOf("d1", "/r/y", false) } });
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.equal(state.waits, 100);
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0].level, "error");
  assert.match(state.toasts[0].title, /a\.js/);
  assert.deepEqual(state.writes, []);
  assert.equal(result.kind, "failed");
});

test("D10, Risk 4: only Claude's tab shows up: it never lands in docs", async () => {
  const { state, io } = fakeHerdr({ mod: null, newTabId: "claude" });
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(state.writes, []);
  assert.equal(result.kind, "failed");
  assert.equal(state.toasts.length, 1);
});

test("D10, Risk 4: Claude's tab lands with ours: docs names ours", async () => {
  const { state, io } = fakeHerdr({ extra: [{ id: "claude" }] });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(Object.keys(state.shared[DOCS_KEY]), ["new"]);
});

test("a tab.new that throws is a toast too, and writes nothing", async () => {
  const { state, io } = fakeHerdr();
  io.run = () => { throw new Error("layout unavailable"); };
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.equal(result.kind, "failed");
  assert.equal(state.toasts.length, 1);
  assert.deepEqual(state.writes, []);
});

test("D11: already open: only selected; no new tab, no write", async () => {
  const { state, io } = fakeHerdr({ tabs: [tab("t1", { active: true }), tab("t2", { index: 2 })], docs: { t2: docOf("d2", FILE, true) }, panes: [pane("p2", "t2", "code-file")] });
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(state.calls, [["tab.select", { id: "t2" }]]);
  assert.deepEqual(state.writes, []);
  assert.equal(result.kind, "select");
});

test("D11: pinning what's open as a preview flips only that entry and keeps the rest", async () => {
  const docs = { t2: docOf("d2", FILE, true), t3: docOf("d3", "/r/b.js", false) };
  const { state, io } = fakeHerdr({ tabs: [tab("t2", { active: true }), tab("t3", { index: 2 })], docs, panes: [pane("p2", "t2", "code-file")] });
  await openFile({ file: FILE, pin: true, space: "s1" }, io);
  assert.deepEqual(state.calls, [["tab.select", { id: "t2" }]]);
  assert.deepEqual(state.shared[DOCS_KEY], { t2: docOf("d2", FILE, false), t3: docOf("d3", "/r/b.js", false) });
});

test("D11, D18: replacing a preview: new tab, moved to the old one's place, the old one closed, never confirmed", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({ tabs: [tab("t1"), tab("old", { index: 2, active: true }), tab("t3", { index: 3 })], docs, panes: [pane("p0", "old", "code-file")] });
  const result = await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new", "tab.move", "tab.close"]);
  assert.deepEqual(state.calls[1][1], { id: "new", index: 2 });
  assert.deepEqual(state.calls[2][1], { id: "old" }, "no confirmed: on the last tab it closes the space without asking");
  assert.deepEqual(state.tabs.map((t) => t.id), ["t1", "new", "t3"], "it took the old one's place");
  assert.equal(result.kind, "replace");
});

test("D11: the entry is written before the old tab closes, so code-file finds its doc whatever happens next", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({ tabs: [tab("old", { active: true })], docs, panes: [pane("p0", "old", "code-file")] });
  const run = io.run;
  io.run = (name, args) => {
    if (name === "tab.move") assert.ok(state.shared[DOCS_KEY].new, "written by tab.move");
    return run(name, args);
  };
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(state.tabs.map((t) => t.id), ["new"]);
});

test("D11, Risk 4: the preview got edited while the new tab was on its way: it stays", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({
    tabs: [tab("old", { active: true })], docs, panes: [pane("p0", "old", "code-file")],
    onWait: (s) => { s.shared[LIVE_KEY] = { d0: { dirty: true, pinned: true } }; },
  });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
  assert.deepEqual(state.tabs.map((t) => t.id).sort(), ["new", "old"]);
});

test("D18, Risk 4: a terminal opened beside the preview while waiting: it stays", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({
    tabs: [tab("old", { active: true })], docs, panes: [pane("p0", "old", "code-file")],
    onWait: (s) => { s.tabs.find((t) => t.id === "old").panes = 2; },
  });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
});

test("D11: the preview was closed while waiting: nothing to move to or close", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({
    tabs: [tab("t1", { active: true }), tab("old", { index: 2 })], docs, panes: [pane("p0", "old", "code-file")],
    onWait: (s) => { s.tabs = s.tabs.filter((t) => t.id !== "old"); },
  });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
});

test("D11: a preview that can't be replaced keeps its place: the new file gets its own tab", async () => {
  const docs = { old: docOf("d0", "/r/old.js", true) };
  const { state, io } = fakeHerdr({ tabs: [tab("old", { active: true })], docs, live: { d0: { dirty: true } }, panes: [pane("p0", "old", "code-file")] });
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
  assert.deepEqual(Object.keys(state.shared[DOCS_KEY]).sort(), ["new", "old"]);
});

test("D10: a tab that isn't selected on its own gets selected", async () => {
  const { state, io } = fakeHerdr();
  const spaces = io.spaces;
  io.spaces = () => spaces().map((s) => ({ ...s, tabs: s.tabs.map((t) => ({ ...t, active: false })) }));
  await openFile({ file: FILE, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new", "tab.select"]);
  assert.deepEqual(state.calls[1][1], { id: "new" });
});

test("a space that's gone opens nothing", async () => {
  const { state, io } = fakeHerdr();
  const result = await openFile({ file: FILE, space: "nope" }, io);
  assert.deepEqual(state.calls, []);
  assert.equal(result.kind, "failed");
});
