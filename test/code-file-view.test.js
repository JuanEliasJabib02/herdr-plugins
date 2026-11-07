// main.js in a fake Herdr: what the reducer asks for reaches the editor, the disk
// and the tab bar, and every banner and card button does the same through its
// on_click as through its command (plan D2: real clicks can't be posted, so the
// live cases drive the commands). `herdr`, `gpui-kit`, `gpui-base` and
// `fs/promises` resolve to stand-ins. How it looks stays with `herdr-app check`
// and the live cases. S3, S6, S8, S12.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDraft, serializeDraft, signature } from "../code-editor/mods/code-file/draft-model.js";

const HERDR = ["theme", "props", "run", "notify", "exec", "readTextFile", "writeTextFile", "watchFolder", "shared", "setShared", "settings", "spaces", "panes", "appHome", "home", "nextCommand"];
const FS = ["readFile", "writeFile", "readdir", "unlink", "mkdir"];
const FAKES = {
  herdr: HERDR.map((n) => `export const ${n} = (...a) => globalThis.__cf.${n}(...a);`).join("\n"),
  "fs/promises": FS.map((n) => `export const ${n} = (...a) => globalThis.__cf.fs.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__cf.el(n, ...a);
    export const div = k("div");
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__cf.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex");
    export const v_virtual_list = (...a) => globalThis.__cf.list(...a);
    export const Scrollbar = { vertical: (name) => globalThis.__cf.el("Scrollbar", name) };
    export const Editor = { new: (s) => globalThis.__cf.el("Editor", s) };
    export const EditorState = { new: (o) => globalThis.__cf.newEditor(o) };
    export const VirtualListScrollHandle = { new: () => globalThis.__cf.newScroll() };`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});

function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {} };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "children") t.kids.push(...args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") args[0](self);
        else if (k === "on_mouse_down") t.handlers.mouse_down = args[1];
        else if (k.startsWith("on_")) t.handlers[k.slice(3)] = args[0];
        return self;
      };
    },
  });
  return self;
}
const isEl = (e) => typeof e === "object" && e !== null && e.kids;
const find = (e, id) => {
  if (!isEl(e)) return null;
  if (e.calls.id?.[0] === id) return e;
  for (const k of e.kids) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
};
const findKind = (e, kind) => {
  if (!isEl(e)) return null;
  if (e.kind === kind) return e;
  for (const k of e.kids) {
    const hit = findKind(k, kind);
    if (hit) return hit;
  }
  return null;
};
const textOf = (e) => (typeof e === "string" ? e : isEl(e) ? e.kids.map(textOf).filter(Boolean).join(" ") : "");
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise(setImmediate);
};

const FILE = "/repo/src/a.js";
const REAL = "/private/repo/src/a.js";
const REAL_DIR = "/private/repo/src";
const HOME = "/home/juan";
const APP = `${HOME}/.config/herdr-app`;
const DRAFTS = `${APP}/code-editor/drafts`;

function newWorld({ disk = { [FILE]: "one\n" }, props = { doc: "d1", file: FILE }, tabId = "t1", tabPanes = 1, active = true, docs, fsFiles = {}, realpath = true, writable = true } = {}) {
  const w = {
    disk: { ...disk },
    props,
    shared: new Map(Object.entries({ "code-editor.docs": docs ?? { [tabId]: { doc: props?.doc, file: props?.file, preview: true } } })),
    fsFiles: { ...fsFiles },
    fsLog: [],
    runs: [],
    toasts: [],
    execs: [],
    writes: [],
    sets: [],
    notifies: 0,
    timers: [],
    sleeps: [],
    watches: [],
    commands: [],
    commandWaiters: [],
    editors: [],
    scrolls: [],
    focus: [],
    holdWrite: false,
    heldWrites: [],
    holdDraft: false,
    heldDrafts: [],
    writeError: null,
    readError: null,
    watchError: null,
    changeOnSet: false,
    realpath,
    writable,
    spaceList: [{ id: "s1", active: true, machine: null, tabs: [{ id: "t0", active: !active, panes: 1 }, { id: tabId, active, panes: tabPanes }] }],
    paneList: [{ pane: "p0", tab: "t0", terminal: "w0" }, { pane: "p1", tab: tabId, mod: "code-file" }, ...(tabPanes > 1 ? [{ pane: "p2", tab: tabId, terminal: "w1" }] : [])],
  };
  const cx = {
    notify: () => { w.notifies++; },
    spawn: (f) => { const p = Promise.resolve().then(() => f(cx)); w.spawned = p.catch((e) => { w.crash = e; }); return { cancel() {}, is_done: () => false }; },
    sleep: async (ms) => { w.sleeps.push(ms); },
    timer: {
      after: (ms, f) => { const t = { ms, f, repeat: false, cancelled: false, cancel() { t.cancelled = true; }, is_done: () => false }; w.timers.push(t); return t; },
      every: (ms, f) => { const t = { ms, f, repeat: true, cancelled: false, cancel() { t.cancelled = true; }, is_done: () => false }; w.timers.push(t); return t; },
    },
    focus_handle: () => { const n = (w.handles = (w.handles ?? 0) + 1); return { n, focus() { w.focus.push(`handle${n}`); }, is_focused: () => false, release() {} }; },
    stop_propagation() { w.stopped = true; },
  };
  w.cx = cx;
  // Fires timers of that delay, once; a repeating one stays.
  w.fire = async (ms) => {
    const due = w.timers.filter((t) => t.ms === ms && !t.cancelled && !t.fired);
    for (const t of due) { if (!t.repeat) t.fired = true; t.f(cx); }
    await flush();
  };
  w.batch = async (paths) => { w.watches.shift()?.resolve(paths); await flush(); };
  w.command = async (raw) => { w.commandWaiters.shift()?.(raw); await flush(); };
  w.draftFiles = () => Object.keys(w.fsFiles).map((p) => p.slice(p.lastIndexOf("/") + 1)).sort();
  w.closes = () => w.runs.filter(([n]) => n === "tab.close" || n === "pane.close");
  w.type = async (text) => { w.editor().type(text); await flush(); };
  w.editor = () => w.editors.at(-1);
  w.live = () => w.shared.get("code-editor.live")?.[props?.doc];

  const fake = {
    el,
    list: (id, count, size, getKey, render) => el("line_list", { id, count, size, getKey, render }),
    newEditor: (opts) => {
      const ed = {
        opts,
        text: opts.value ?? "",
        released: false,
        handlers: {},
        value: () => ed.text,
        set_value: (v) => { ed.text = v; ed.sets = (ed.sets ?? 0) + 1; if (w.changeOnSet) ed.handlers.change?.({}, cx); },
        on: (name, h) => { ed.handlers[name] = h; return true; },
        release: () => { ed.released = true; return true; },
        type: (v) => { ed.text = v; ed.handlers.change?.({}, cx); },
      };
      w.editors.push(ed);
      return ed;
    },
    newScroll: () => { const s = { calls: [], scroll_to_item: (i, how) => s.calls.push([i, how]), release() {} }; w.scrolls.push(s); return s; },
    theme: () => new Proxy({}, { get: (_t, k) => `#${String(k)}` }),
    props: () => w.props,
    run: (name, args) => { w.runs.push([name, args]); return null; },
    notify: (n) => { w.toasts.push(n); return "id"; },
    exec: async (cmd, args = []) => {
      w.execs.push([cmd, ...args]);
      if (cmd === "/bin/realpath") {
        if (!w.realpath) return { code: 1, stdout: "", stderr: "No such file" };
        const p = args[0];
        if (p === FILE) return Object.hasOwn(w.disk, FILE) ? { code: 0, stdout: `${REAL}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "No such file" };
        return { code: 0, stdout: `/private${p}\n`, stderr: "" };
      }
      if (cmd === "/bin/sh") return { code: w.writable ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readTextFile: async (p) => {
      if (w.readError) throw new Error(w.readError);
      return Object.hasOwn(w.disk, p) ? w.disk[p] : null;
    },
    writeTextFile: async (p, text, expected) => {
      w.writes.push({ path: p, text, expected });
      if (w.holdWrite) await new Promise((resolve) => w.heldWrites.push(resolve));
      if (w.writeError) throw new Error(w.writeError);
      const current = Object.hasOwn(w.disk, p) ? w.disk[p] : null;
      if (current !== expected) throw new Error("The file changed outside Herdr. Reload before saving; your draft is still here.");
      w.disk[p] = text;
      return null;
    },
    watchFolder: (dir) => {
      if (w.watchError) return Promise.reject(new Error(w.watchError));
      return new Promise((resolve) => { w.watches.push({ dir, resolve }); });
    },
    shared: (k) => w.shared.get(k),
    setShared: (k, v) => { w.sets.push([k, v]); w.shared.set(k, v); return null; },
    settings: () => ({ font_family: "Mono" }),
    spaces: () => w.spaceList,
    panes: () => w.paneList,
    appHome: () => APP,
    home: () => HOME,
    nextCommand: () => new Promise((resolve) => { w.commandWaiters.push(resolve); }),
    fs: {
      mkdir: async () => {},
      readdir: async (dir) => {
        const names = Object.keys(w.fsFiles).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
        if (names.length === 0 && !w.draftDirExists) throw new Error("ENOENT");
        return names;
      },
      readFile: async (p) => { if (!(p in w.fsFiles)) throw new Error("ENOENT"); return w.fsFiles[p]; },
      writeFile: async (p, t) => {
        w.draftDirExists = true;
        w.fsLog.push(`write ${p.slice(p.lastIndexOf("/") + 1)}`);
        if (w.holdDraft) await new Promise((resolve) => w.heldDrafts.push(resolve));
        w.fsFiles[p] = t;
      },
      unlink: async (p) => { w.fsLog.push(`unlink ${p.slice(p.lastIndexOf("/") + 1)}`); delete w.fsFiles[p]; },
    },
  };
  globalThis.__cf = fake;
  globalThis.window = { focus_next: () => { w.focus.push("focus_next"); } };
  return w;
}

const { default: CodeFile } = await import("../code-editor/mods/code-file/main.js");

async function open(options = {}) {
  const w = newWorld(options);
  const view = new CodeFile();
  view.init({}, w.cx);
  await flush();
  w.view = view;
  w.draw = () => view.render(w.cx);
  w.click = async (id) => {
    const target = find(w.draw(), id);
    assert.ok(target, `no element ${id}`);
    assert.ok(target.handlers.click, `${id} has no on_click`);
    target.handlers.click({}, w.cx);
    await flush();
  };
  return w;
}
const draftOf = (w, name) => parseDraft(w.fsFiles[`${DRAFTS}/${name}`]);
const DRAFT_DELAY = 300;

// ── herdr-app check's copy ───────────────────────────────────────────────────

test("D18: with empty props (herdr-app check) init touches nothing and it only draws", async () => {
  const w = await open({ props: {}, docs: {} });
  assert.deepEqual(w.execs, []);
  assert.deepEqual(w.watches, []);
  assert.deepEqual(w.timers, []);
  assert.deepEqual(w.commandWaiters, []);
  assert.deepEqual(w.sets, []);
  assert.ok(isEl(w.draw()));
  assert.equal(await w.view.close(), undefined);
});

// ── S6, S8: a file in its own tab, written and saved ─────────────────────────

test("S6, S8: opens the file in an editor with D5's colors, and a save writes the typed text over what was read", async () => {
  const w = await open();
  const ed = w.editor();
  assert.equal(ed.text, "one\n");
  assert.equal(ed.opts.language, "js");
  assert.equal(ed.opts.syntax.keyword, "#c678dd");
  assert.equal(ed.opts.font_family, "Mono");
  assert.ok(findKind(w.draw(), "Editor"));
  await w.type("one\ntwo\n");
  assert.equal(w.live().dirty, true);
  await w.command("save");
  assert.deepEqual(w.writes, [{ path: FILE, text: "one\ntwo\n", expected: "one\n" }]);
  assert.equal(w.disk[FILE], "one\ntwo\n");
  assert.equal(w.live().dirty, false);
});

test("D18: the keys.json command arrives with or without the mod's prefix", async () => {
  const w = await open();
  await w.type("x");
  await w.command("code-file.save");
  assert.equal(w.disk[FILE], "x");
});

test("S8: the second cmd-s waits for the first, with no false conflict", async () => {
  const w = await open();
  w.holdWrite = true;
  await w.type("a");
  await w.command("save");
  await w.type("ab");
  await w.command("save");
  assert.equal(w.writes.length, 1);
  w.holdWrite = false;
  w.heldWrites.shift()();
  await flush();
  assert.deepEqual(w.writes.map((x) => [x.text, x.expected]), [["a", "one\n"], ["ab", "a"]]);
  assert.equal(w.disk[FILE], "ab");
  assert.equal(find(w.draw(), "banner"), null);
});

test("D22: the text typed during the write stays dirty and goes on to a draft", async () => {
  const w = await open();
  w.holdWrite = true;
  await w.type("a");
  await w.command("save");
  await w.type("ab");
  w.holdWrite = false;
  w.heldWrites.shift()();
  await flush();
  assert.equal(w.disk[FILE], "a");
  assert.equal(w.live().dirty, true);
  await w.fire(DRAFT_DELAY);
  assert.equal(parseDraft(Object.values(w.fsFiles)[0]).text, "ab");
});

test("a command that throws doesn't end the loop: the next cmd-s still saves", async () => {
  const w = await open();
  await w.type("x");
  const realSpaces = globalThis.__cf.spaces;
  const log = console.log;
  console.log = () => {};
  globalThis.__cf.spaces = () => { globalThis.__cf.spaces = realSpaces; throw new Error("boom"); };
  await w.command("save");
  console.log = log;
  await w.command("save");
  assert.equal(w.disk[FILE], "x");
});

test("D20: Discard with the file gone shows the limit view; when the file is back the old editor shows the disk", async () => {
  const seeded = await open();
  await seeded.type("mine");
  await seeded.fire(DRAFT_DELAY);
  const w = await open({ disk: {}, fsFiles: seeded.fsFiles });
  assert.equal(w.editor().text, "mine");
  await w.command("discard");
  assert.deepEqual(w.draftFiles(), []);
  assert.ok(textOf(w.draw()).includes("Unable to load file"));
  w.disk[FILE] = "back\n";
  await w.command("retry");
  assert.equal(w.editors.length, 1);
  assert.equal(w.editor().text, "back\n");
  assert.equal(w.view.model.value, "back\n");
  assert.equal(w.live().dirty, false);
});

// ── D10: live, only when it changes ──────────────────────────────────────────

test("D10: live is written only when dirty or pinned change", async () => {
  const w = await open();
  assert.deepEqual(w.sets, [], "a clean file publishes nothing");
  await w.type("a");
  await w.type("ab");
  await w.type("abc");
  assert.equal(w.sets.length, 1);
  assert.deepEqual(w.live(), { dirty: true, pinned: true });
});

test("D10: live keeps other docs' entries", async () => {
  const w = newWorld({ docs: { t1: { doc: "d1", file: FILE }, t0: { doc: "other", file: "/x" } } });
  w.shared.set("code-editor.live", { other: { dirty: true, pinned: true } });
  const view = new CodeFile();
  view.init({}, w.cx);
  await flush();
  w.editor().type("a");
  assert.deepEqual(w.shared.get("code-editor.live"), { other: { dirty: true, pinned: true }, d1: { dirty: true, pinned: true } });
});

test("T3's pin-<doc>: sets pinned in live, and a copy ignores a doc that isn't its own", async () => {
  const w = await open();
  await w.command("pin-other");
  assert.equal(w.live(), undefined);
  await w.command("pin-d1");
  assert.deepEqual(w.live(), { dirty: false, pinned: true });
  await w.command("code-file.pin-d1");
  assert.equal(w.sets.length, 1, "already pinned");
});

test("D10: a pinned tab stays pinned across a restart", async () => {
  const w = newWorld();
  w.shared.set("code-editor.live", { d1: { dirty: false, pinned: true } });
  const view = new CodeFile();
  view.init({}, w.cx);
  await flush();
  assert.equal(view.model.pinned, true);
  assert.deepEqual(w.sets, []);
});

test("D18: a preview with a pane beside it stays pinned", async () => {
  const w = await open({ tabPanes: 2 });
  assert.equal(w.live(), undefined);
  w.draw();
  await w.fire(0);
  assert.deepEqual(w.live(), { dirty: false, pinned: true });
});

// ── Closing (D18) ────────────────────────────────────────────────────────────

test("D18: closing a clean file closes its tab, never `confirmed`", async () => {
  const w = await open();
  await w.command("close");
  assert.deepEqual(w.closes(), [["tab.close", { id: "t1" }]]);
});

test("D18: with a terminal beside it only its pane closes, naming the pane", async () => {
  const w = await open({ tabPanes: 2 });
  await w.command("close");
  assert.deepEqual(w.closes(), [["pane.close", { pane: "p1" }]]);
});

test("D18: ask-close-<doc> is the same path; another doc's is ignored", async () => {
  const w = await open();
  await w.command("ask-close-other");
  assert.deepEqual(w.closes(), []);
  assert.equal(find(w.draw(), "close-card"), null);
  await w.command("code-file.ask-close-other");
  assert.deepEqual(w.closes(), []);
  await w.command("ask-close-d1");
  assert.deepEqual(w.closes(), [["tab.close", { id: "t1" }]]);
});

test("D18: a doc nobody listed closes the shown tab, which is where a command reaches", async () => {
  const w = await open({ docs: {} });
  await w.command("close");
  assert.deepEqual(w.closes(), [["tab.close", { id: "t1" }]]);
});

test("D18: no tab to close: a toast and nothing run", async () => {
  const w = await open({ docs: {} });
  w.paneList = [];
  await w.command("close");
  assert.deepEqual(w.closes(), []);
  assert.equal(w.toasts.length, 1);
});

test("S12: closing a dirty file: the card, with Orca's strings, taking the keyboard; no close yet", async () => {
  const w = await open();
  await w.type("x");
  await w.command("ask-close-d1");
  assert.deepEqual(w.closes(), []);
  const card = find(w.draw(), "close-card");
  assert.ok(card);
  const text = textOf(card);
  assert.ok(text.includes("Unsaved Changes"));
  assert.ok(text.includes('"a.js" has unsaved changes. Do you want to save before closing?'));
  assert.ok(text.includes("Cancel") && text.includes("Don't Save") && text.includes("Save"));
  assert.ok(card.calls.track_focus);
  w.focus.length = 0;
  w.draw();
  await w.fire(50);
  assert.deepEqual(w.focus, [`handle${card.calls.track_focus[0].n}`]);
});

test("D18: Esc on the card is Cancel and gives the keyboard back; Enter does nothing", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  const card = find(w.draw(), "close-card");
  card.handlers.key_down({ key: "enter", keystroke: "enter" }, w.cx);
  await flush();
  assert.ok(find(w.draw(), "close-card"), "no default on Enter");
  assert.deepEqual(w.closes(), []);
  assert.deepEqual(w.writes, []);
  w.focus.length = 0;
  w.timers.length = 0;
  card.handlers.key_down({ key: "escape", keystroke: "escape" }, w.cx);
  await flush();
  assert.equal(find(w.draw(), "close-card"), null);
  await w.fire(50);
  assert.deepEqual(w.focus.at(-1), "focus_next");
});

test("D18: Save on the card closes only after the write landed", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  w.holdWrite = true;
  await w.command("card-save");
  assert.deepEqual(w.closes(), []);
  w.holdWrite = false;
  w.heldWrites.shift()();
  await flush();
  assert.equal(w.disk[FILE], "x");
  assert.deepEqual(w.closes(), [["tab.close", { id: "t1" }]]);
});

test("D18: cmd-s while the card is up is its Save", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  await w.command("save");
  assert.equal(w.disk[FILE], "x");
  assert.equal(w.closes().length, 1);
});

test("D18: a failed Save takes the card away and leaves the banner; the tab stays", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  w.writeError = "disk on fire";
  await w.command("card-save");
  const drawn = w.draw();
  assert.equal(find(drawn, "close-card"), null);
  assert.ok(textOf(find(drawn, "banner")).includes("Failed to save the file. Please try again."));
  assert.deepEqual(w.closes(), []);
  assert.equal(w.editor().text, "x");
});

test("D18: Don't Save deletes the draft, then closes, and close() writes none: reopening shows no banner", async () => {
  const w = await open();
  await w.type("x");
  await w.fire(DRAFT_DELAY);
  assert.equal(w.draftFiles().length, 1);
  await w.command("close");
  await w.command("dont-save");
  assert.deepEqual(w.draftFiles(), []);
  assert.deepEqual(w.closes(), [["tab.close", { id: "t1" }]]);
  await w.view.close();
  assert.deepEqual(w.draftFiles(), [], "close() with discard writes nothing");
  // Reopening, as a new doc.
  const again = await open({ props: { doc: "d2", file: FILE }, fsFiles: w.fsFiles, disk: w.disk, docs: { t1: { doc: "d2", file: FILE } } });
  assert.equal(again.editor().text, "one\n");
  assert.equal(find(again.draw(), "banner"), null);
});

test("D18, D20: a write running plus Don't Save: no draft at the end, and the close waits for it", async () => {
  const w = await open();
  await w.type("x");
  w.holdDraft = true;
  await w.fire(DRAFT_DELAY);
  await w.command("close");
  await w.command("dont-save");
  assert.deepEqual(w.closes(), [], "it waits for the write that's running");
  w.heldDrafts.shift()();
  await flush();
  assert.deepEqual(w.draftFiles(), []);
  assert.equal(w.closes().length, 1);
});

test("D18: Don't Save doesn't hang behind a stuck draft write: the wait is bounded, and close() still writes nothing", async () => {
  const w = await open();
  await w.type("x");
  w.holdDraft = true;
  await w.fire(DRAFT_DELAY);
  await w.command("close");
  await w.command("dont-save");
  assert.deepEqual(w.closes(), []);
  await w.fire(1000);
  assert.equal(w.closes().length, 1);
  w.holdDraft = false;
  await w.view.close();
  assert.equal(w.fsLog.filter((l) => l.startsWith("write")).length, 1, "only the write that was already stuck");
});

test("D18: the tab survives Don't Save (the last tab asks): the discard timer brings the draft back", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  await w.command("dont-save");
  assert.deepEqual(w.draftFiles(), []);
  assert.equal(w.view.discard, true);
  await w.fire(1500);
  assert.equal(w.view.discard, false);
  await w.fire(DRAFT_DELAY);
  assert.equal(w.draftFiles().length, 1);
});

test("D18: a press on the dim area goes no further and leaves the keyboard on the card", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  const drawn = w.draw();
  const handle = find(drawn, "close-card").calls.track_focus[0];
  w.focus.length = 0;
  find(drawn, "close-dim").handlers.mouse_down({}, w.cx);
  assert.equal(w.stopped, true);
  assert.deepEqual(w.focus, [`handle${handle.n}`]);
  assert.equal(w.view.model.card, true);
});

test("D18: Cancel keeps the buffer; a later close asks again", async () => {
  const w = await open();
  await w.type("x");
  await w.command("close");
  await w.command("cancel");
  assert.equal(find(w.draw(), "close-card"), null);
  assert.equal(w.editor().text, "x");
  await w.command("close");
  assert.ok(find(w.draw(), "close-card"));
});

// ── Every button: the click and the command are the same path ────────────────

async function conflictWorld() {
  const w = await open();
  await w.type("mine");
  w.disk[FILE] = "theirs";
  await w.batch([REAL]);
  return w;
}

for (const [id, command] of [["banner-reload", "reload"], ["banner-overwrite", "overwrite"], ["banner-keep-mine", "keep-mine"]]) {
  test(`D2: ${id} and the command ${command} do the same`, async () => {
    const a = await conflictWorld();
    await a.click(id);
    const clicked = { model: a.view.model, writes: a.writes, text: a.editor().text, disk: a.disk[FILE] };
    const b = await conflictWorld();
    await b.command(command);
    assert.deepEqual({ model: b.view.model, writes: b.writes, text: b.editor().text, disk: b.disk[FILE] }, clicked);
    assert.equal(a.view.model.banner, null);
  });
}

for (const [id, command] of [["card-cancel", "cancel"], ["card-dont-save", "dont-save"], ["card-save", "card-save"]]) {
  test(`D2: ${id} and the command ${command} do the same`, async () => {
    const run = async (act) => {
      const w = await open();
      await w.type("x");
      await w.command("close");
      await act(w);
      return { model: w.view.model, closes: w.closes(), disk: w.disk[FILE] };
    };
    assert.deepEqual(await run((w) => w.command(command)), await run((w) => w.click(id)));
  });
}

test("D2: Discard: the banner's button and the command do the same", async () => {
  const run = async (act) => {
    const fsFiles = { [`${DRAFTS}/abc-d1-1`]: serializeDraft({ path: REAL, baseSig: signature("one\n"), length: 5, at: 1 }, "draft") };
    const w = await open({ fsFiles });
    await act(w);
    return { model: w.view.model, text: w.editor().text, files: w.draftFiles() };
  };
  const clicked = await run((w) => w.click("banner-discard"));
  assert.deepEqual(await run((w) => w.command("discard")), clicked);
  assert.equal(clicked.text, "one\n");
  assert.deepEqual(clicked.files, []);
});

test("D2: Retry: the limit view's button and the command do the same", async () => {
  const run = async (act) => {
    const w = await open({ disk: {} });
    w.disk[FILE] = "back\n";
    await act(w);
    return { phase: w.view.model.phase, text: w.editor()?.text };
  };
  const clicked = await run((w) => w.click("limit-retry"));
  assert.deepEqual(await run((w) => w.command("retry")), clicked);
  assert.deepEqual(clicked, { phase: "ready", text: "back\n" });
});

// ── S12: the disk changes ────────────────────────────────────────────────────

test("S12: dirty and the file changes: conflict banner with its three buttons and Orca's words", async () => {
  const w = await conflictWorld();
  const banner = find(w.draw(), "banner");
  const text = textOf(banner);
  assert.ok(text.includes("This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content."));
  assert.ok(text.includes("Reload from Disk") && text.includes("Overwrite") && text.includes("Keep My Edits"));
  assert.equal(find(banner, "banner-keep-mine").calls.tooltip[0], "Keeps your version. Your next save replaces the version on disk.");
  assert.equal(banner.calls.bg[0], "#38342a");
  assert.equal(w.editor().text, "mine");
});

test("S12: Reload from Disk: takes the disk, toast, draft gone", async () => {
  const w = await conflictWorld();
  await w.fire(DRAFT_DELAY);
  assert.equal(w.draftFiles().length, 1);
  await w.command("reload");
  assert.equal(w.editor().text, "theirs");
  assert.deepEqual(w.draftFiles(), []);
  assert.equal(w.toasts.at(-1).title, "Reloaded from disk");
  assert.equal(w.toasts.at(-1).body, "a.js");
  assert.equal(w.live().dirty, false);
});

test("S12: Overwrite replaces the newer text; Keep My Edits lets the next save do it", async () => {
  const over = await conflictWorld();
  await over.command("overwrite");
  assert.equal(over.disk[FILE], "mine");
  const keep = await conflictWorld();
  await keep.command("keep-mine");
  assert.equal(keep.disk[FILE], "theirs");
  assert.equal(find(keep.draw(), "banner"), null);
  await keep.command("save");
  assert.equal(keep.disk[FILE], "mine");
});

test("D9: a write that loses to someone else's never replaces it: banner and toast", async () => {
  const w = await open();
  await w.type("mine");
  w.disk[FILE] = "theirs";
  await w.command("save");
  assert.equal(w.disk[FILE], "theirs");
  assert.equal(w.view.model.banner, "conflict");
  assert.equal(w.toasts.at(-1).title, "This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.");
  assert.equal(w.editor().text, "mine");
});

test("S12: any other write failure: Failed to save, buffer and draft intact", async () => {
  const w = await open();
  await w.type("mine");
  await w.fire(DRAFT_DELAY);
  w.writeError = "No space left on device";
  await w.command("save");
  assert.ok(textOf(find(w.draw(), "banner")).includes("Failed to save the file. Please try again."));
  assert.equal(w.editor().text, "mine");
  assert.equal(w.draftFiles().length, 1);
});

test("D15: clean on screen: Cambió en disco with Recargar, the editor untouched until clicked", async () => {
  const w = await open();
  w.disk[FILE] = "theirs";
  await w.batch([REAL]);
  assert.equal(w.editor().text, "one\n");
  const banner = find(w.draw(), "banner");
  assert.ok(textOf(banner).includes("Cambió en disco"));
  assert.ok(textOf(banner).includes("Recargar"));
  await w.click("banner-reload");
  assert.equal(w.editor().text, "theirs");
  assert.equal(w.toasts.length, 0);
});

test("D15: clean and hidden: reloads quietly; no pin, no draft, whether set_value fires change or not", async () => {
  for (const changeOnSet of [false, true]) {
    const w = await open({ active: false });
    w.changeOnSet = changeOnSet;
    w.disk[FILE] = "theirs";
    await w.batch([REAL]);
    assert.equal(w.editor().text, "theirs");
    assert.equal(find(w.draw(), "banner"), null);
    assert.equal(w.view.model.pinned, false);
    assert.equal(w.live(), undefined);
    await w.fire(DRAFT_DELAY);
    assert.deepEqual(w.draftFiles(), []);
  }
});

test("D15: a hidden tab in another space counts as hidden too", async () => {
  const w = await open();
  w.spaceList = [{ id: "s0", active: true, tabs: [{ id: "x", active: true, panes: 1 }] }, { id: "s1", active: false, tabs: [{ id: "t1", active: true, panes: 1 }] }];
  w.disk[FILE] = "theirs";
  await w.batch([REAL]);
  assert.equal(w.editor().text, "theirs");
});

test("D22: text typed while a read is out: the check runs again on arrival, no set_value", async () => {
  const w = await open({ active: false });
  const realRead = globalThis.__cf.readTextFile;
  let release;
  globalThis.__cf.readTextFile = async (p) => { await new Promise((r) => { release = r; }); return realRead(p); };
  w.disk[FILE] = "theirs";
  await w.batch([REAL]);
  w.editor().text = "typed before the change event";
  release();
  await flush();
  assert.equal(w.editor().sets, undefined, "never set_value");
  assert.equal(w.view.model.banner, "conflict");
});

test("D22: a read that started during a save reads again instead of raising a conflict", async () => {
  const w = await open();
  await w.type("mine");
  const realRead = globalThis.__cf.readTextFile;
  let release;
  const stale = w.disk[FILE];
  globalThis.__cf.readTextFile = async () => { await new Promise((r) => { release = r; }); globalThis.__cf.readTextFile = realRead; return stale; };
  await w.batch([REAL]);
  await w.command("save");
  assert.equal(w.disk[FILE], "mine");
  release();
  await flush();
  assert.equal(w.view.model.banner, null);
});

// ── Watch ────────────────────────────────────────────────────────────────────

test("D19: it watches the file's folder, and a batch of temporaries or of other files reads nothing", async () => {
  const w = await open();
  assert.equal(w.watches[0].dir, "/repo/src");
  const reads = [];
  const realRead = globalThis.__cf.readTextFile;
  globalThis.__cf.readTextFile = async (p) => { reads.push(p); return realRead(p); };
  await w.batch([`${REAL_DIR}/.herdr-app-write-123`, `${REAL_DIR}/b.js`]);
  assert.deepEqual(reads, []);
  await w.batch([REAL]);
  assert.deepEqual(reads, [FILE]);
});

test("D22: the watch's root reads everything", async () => {
  const w = await open();
  w.disk[FILE] = "theirs";
  await w.batch([REAL_DIR]);
  assert.equal(w.view.model.banner, "changed");
});

test("D22: the own write's batch is no change", async () => {
  const w = await open();
  await w.type("mine");
  await w.command("save");
  await w.batch([REAL]);
  assert.equal(w.view.model.banner, null);
});

test("D22: a watch that rejects falls back to a 10 s timer", async () => {
  const w = newWorld();
  w.watchError = "too many directories";
  const view = new CodeFile();
  view.init({}, w.cx);
  await flush();
  assert.ok(w.timers.some((t) => t.ms === 10000 && t.repeat));
  w.disk[FILE] = "theirs";
  await w.fire(10000);
  assert.equal(view.model.banner, "changed");
});

test("D22: a vanished file waits 250 ms before it counts, and the buffer is never touched", async () => {
  const w = await open();
  await w.type("mine");
  delete w.disk[FILE];
  await w.batch([REAL]);
  assert.ok(w.sleeps.includes(250));
  assert.equal(w.view.model.deleted, true);
  assert.equal(w.editor().text, "mine");
  assert.ok(textOf(w.draw()).includes("Deleted on disk"));
  await w.command("save");
  assert.deepEqual(w.writes.at(-1), { path: FILE, text: "mine", expected: null });
  assert.equal(w.disk[FILE], "mine");
  assert.equal(w.view.model.deleted, false);
});

test("D22: a file back within the 250 ms isn't deleted", async () => {
  const w = await open();
  const realSleep = w.cx.sleep;
  w.cx.sleep = async (ms) => { w.disk[FILE] = "one\n"; return realSleep(ms); };
  delete w.disk[FILE];
  await w.batch([REAL]);
  assert.equal(w.view.model.deleted, false);
});

// ── Drafts: restore (D20) ────────────────────────────────────────────────────

test("D20: drafts go to appHome()/code-editor/drafts with path, baseSig, length, and a hash of the realpath", async () => {
  const w = await open();
  await w.type("mine");
  await w.fire(DRAFT_DELAY);
  const [name] = w.draftFiles();
  assert.match(name, /^[0-9a-f]+-d1-1$/);
  const { meta, text } = draftOf(w, name);
  assert.equal(text, "mine");
  assert.equal(meta.path, REAL);
  assert.equal(meta.baseSig, signature("one\n"));
  assert.equal(meta.length, 4);
});

test("D20: each change restarts the delay, so a burst writes once", async () => {
  const w = await open();
  await w.type("a");
  await w.type("ab");
  assert.equal(w.timers.filter((t) => t.ms === DRAFT_DELAY && !t.cancelled).length, 1);
  await w.fire(DRAFT_DELAY);
  assert.equal(w.fsLog.filter((l) => l.startsWith("write")).length, 1);
  assert.equal(draftOf(w, w.draftFiles()[0]).text, "ab");
});

test("D20: undoing back to clean, and saving, delete the draft", async () => {
  const w = await open();
  await w.type("a");
  await w.fire(DRAFT_DELAY);
  await w.type("one\n");
  assert.deepEqual(w.draftFiles(), []);
  await w.type("b");
  await w.fire(DRAFT_DELAY);
  assert.equal(w.draftFiles().length, 1);
  await w.command("save");
  assert.deepEqual(w.draftFiles(), []);
});

test("D20: a hot reload (no close()) brings the edits back by doc, with the Restored banner", async () => {
  const w = await open();
  await w.type("mine");
  await w.fire(DRAFT_DELAY);
  const next = await open({ fsFiles: w.fsFiles, disk: w.disk });
  assert.equal(next.editor().text, "mine");
  assert.equal(next.view.model.value, "mine");
  assert.equal(next.live().dirty, true);
  const banner = find(next.draw(), "banner");
  assert.ok(textOf(banner).includes("Restored unsaved changes"));
  assert.ok(textOf(banner).includes("Discard"));
});

test("D20: a restored dirty buffer doesn't count the editor's first text as an edit", async () => {
  const fsFiles = { [`${DRAFTS}/abc-d1-1`]: serializeDraft({ path: REAL, baseSig: signature("one\n"), length: 5, at: 1 }, "draft") };
  const w = await open({ fsFiles });
  assert.equal(w.timers.filter((t) => t.ms === DRAFT_DELAY).length, 0, "its draft is already there");
});

test("D20: close() writes the next sequence straight, past a hung write; a silent close keeps the edits", async () => {
  const w = await open();
  await w.type("older");
  w.holdDraft = true;
  await w.fire(DRAFT_DELAY);
  w.holdDraft = false;
  await w.type("last words");
  await w.view.close();
  const names = w.draftFiles();
  assert.equal(names.length, 1);
  assert.match(names[0], /-d1-2$/);
  assert.equal(draftOf(w, names[0]).text, "last words");
  assert.ok(w.editor().released);
});

test("D20: close() on a clean file writes nothing; one with a leftover draft clears it", async () => {
  const w = await open();
  await w.view.close();
  assert.deepEqual(w.fsLog, []);
  const v = await open();
  await v.type("a");
  v.holdDraft = false;
  await v.fire(DRAFT_DELAY);
  v.editor().text = "one\n";
  await v.view.close();
  assert.deepEqual(v.draftFiles(), []);
});

test("D10: entries of tabs that are gone go when the next file opens; those with a tab, and its own, stay", async () => {
  const w = newWorld({ docs: { t1: { doc: "d1", file: FILE }, t0: { doc: "other", file: "/x" }, gone: { doc: "stale", file: "/y" } } });
  w.shared.set("code-editor.live", { other: { dirty: true, pinned: true }, stale: { dirty: true, pinned: false }, nobody: { dirty: false, pinned: false }, d1: { dirty: false, pinned: true } });
  new CodeFile().init({}, w.cx);
  await flush();
  assert.deepEqual(w.shared.get("code-editor.live"), { other: { dirty: true, pinned: true }, d1: { dirty: false, pinned: true } });
});

test("D10: with no spaces yet (a restart), nothing is pruned, so pinned survives", async () => {
  const w = newWorld();
  w.spaceList = [];
  w.shared.set("code-editor.live", { other: { dirty: false, pinned: true } });
  new CodeFile().init({}, w.cx);
  await flush();
  assert.deepEqual(w.shared.get("code-editor.live"), { other: { dirty: false, pinned: true } });
});

test("D10: close() leaves live alone: it also runs on quit, and pinned has to survive", async () => {
  const w = await open();
  await w.command("pin-d1");
  await w.view.close();
  assert.deepEqual(w.live(), { dirty: false, pinned: true });
});

test("D20: reopening with a new doc finds the closed tab's draft by its path, and the disk having moved is the conflict banner", async () => {
  const w = await open();
  await w.type("mine");
  await w.view.close();
  w.disk[FILE] = "theirs";
  const again = await open({ props: { doc: "d2", file: FILE }, disk: w.disk, fsFiles: w.fsFiles, docs: { t1: { doc: "d2", file: FILE } } });
  assert.equal(again.editor().text, "mine");
  assert.ok(textOf(find(again.draw(), "banner")).includes("This file changed on disk while you have unsaved edits."));
  await again.command("save");
  assert.equal(again.disk[FILE], "theirs", "no expected until Keep My Edits or Overwrite");
  await again.command("keep-mine");
  await again.command("save");
  assert.equal(again.disk[FILE], "mine");
  assert.deepEqual(again.draftFiles(), []);
});

test("D20: a draft reopened under a new doc moves to that doc", async () => {
  const w = await open();
  await w.type("mine");
  await w.view.close();
  const again = await open({ props: { doc: "d2", file: FILE }, disk: w.disk, fsFiles: w.fsFiles, docs: { t1: { doc: "d2", file: FILE } } });
  await again.fire(DRAFT_DELAY);
  const names = again.draftFiles();
  assert.equal(names.length, 1);
  assert.match(names[0], /-d2-1$/);
});

test("D20: a draft of a doc alive in another tab is left alone", async () => {
  const w = await open();
  await w.type("mine");
  await w.fire(DRAFT_DELAY);
  const docs = { t1: { doc: "d1", file: FILE }, t2: { doc: "d2", file: FILE } };
  const other = newWorld({ props: { doc: "d2", file: FILE }, disk: w.disk, fsFiles: w.fsFiles, docs });
  other.spaceList[0].tabs.push({ id: "t2", active: true, panes: 1 });
  const view = new CodeFile();
  view.init({}, other.cx);
  await flush();
  assert.equal(other.editor().text, "one\n");
});

test("D20: realpath failing on a missing file still restores by doc, as deleted, and save creates it", async () => {
  const seeded = await open();
  await seeded.type("mine");
  await seeded.fire(DRAFT_DELAY);
  const gone = await open({ disk: {}, fsFiles: seeded.fsFiles, realpath: false });
  assert.equal(gone.editor().text, "mine");
  assert.equal(gone.view.model.deleted, true);
  await gone.command("save");
  assert.deepEqual(gone.writes, [{ path: FILE, text: "mine", expected: null }]);
});

test("D20: a draft equal to the disk is dropped at open, with no banner", async () => {
  const fsFiles = { [`${DRAFTS}/abc-d1-1`]: serializeDraft({ path: REAL, baseSig: "old", length: 4, at: 1 }, "one\n") };
  const w = await open({ fsFiles });
  assert.equal(find(w.draw(), "banner"), null);
  assert.deepEqual(w.draftFiles(), []);
});

test("D20: nothing but broken drafts: opens from disk and clears them", async () => {
  const w = await open({ fsFiles: { [`${DRAFTS}/abc-d1-1`]: "garbage" } });
  assert.equal(w.editor().text, "one\n");
  assert.deepEqual(w.draftFiles(), []);
});

// ── Limits (D22, S12) ────────────────────────────────────────────────────────

test("S12: the limit views: no editor, Orca's words", async () => {
  const cases = [
    [{ readError: "Text file exceeds 1 MiB" }, "File too large: exceeds the 1 MiB limit"],
    [{ readError: "stream did not contain valid UTF-8" }, "This file isn't UTF-8 text"],
    [{ disk: { [FILE]: "a\0b" } }, "Binary file — cannot display"],
  ];
  for (const [setup, words] of cases) {
    const w = newWorld(setup.disk ? { disk: setup.disk } : {});
    if (setup.readError) w.readError = setup.readError;
    const view = new CodeFile();
    view.init({}, w.cx);
    await flush();
    assert.equal(w.editors.length, 0);
    assert.ok(textOf(view.render(w.cx)).includes(words), words);
  }
});

test("S12: a missing file with no draft: Unable to load file, Retry", async () => {
  const w = await open({ disk: {} });
  const text = textOf(w.draw());
  assert.ok(text.includes("Unable to load file"));
  assert.ok(text.includes("Retry"));
  assert.equal(w.editors.length, 0);
});

test("D22: a limit view opens by itself once the file is fine, from the watch", async () => {
  const w = await open({ disk: {} });
  w.disk[FILE] = "back\n";
  await w.batch([REAL]);
  assert.equal(w.editor().text, "back\n");
});

test("D22: closing a limit view closes at once", async () => {
  const w = await open({ disk: {} });
  await w.command("close");
  assert.equal(w.closes().length, 1);
});

test("D22: a read-only file opens read-only and says so; Read-only is checked with `test -w`", async () => {
  const w = await open({ writable: false });
  assert.equal(w.editor().opts.readonly, true);
  assert.ok(textOf(w.draw()).includes("Read-only"));
  assert.deepEqual(w.execs.find(([c]) => c === "/bin/sh").slice(-1), [FILE]);
  await w.command("save");
  assert.deepEqual(w.writes, []);
});

test("D14: over 256 KB opens as txt and the header says so", async () => {
  const w = await open({ disk: { [FILE]: "x".repeat(256 * 1024 + 1) } });
  assert.equal(w.editor().opts.language, "txt");
  assert.ok(textOf(w.draw()).includes("Sin colores: archivo grande"));
});

// ── Look ─────────────────────────────────────────────────────────────────────

test("header: 30 px, the path with ~, and Language · UTF-8 · LF", async () => {
  const file = `${HOME}/src/a.js`;
  const w = await open({ props: { doc: "d1", file }, disk: { [file]: "x\n" }, docs: { t1: { doc: "d1", file } } });
  const header = find(w.draw(), "file-header");
  assert.equal(header.calls.h[0], 30);
  assert.ok(textOf(header).includes("~/src/a.js"));
  assert.ok(textOf(header).includes("JavaScript · UTF-8 · LF"));
});

test("header: CRLF shows", async () => {
  const w = await open({ disk: { [FILE]: "x\r\ny\r\n" } });
  assert.ok(textOf(find(w.draw(), "file-header")).includes("JavaScript · UTF-8 · CRLF"));
});

// ── Focus (D17) ──────────────────────────────────────────────────────────────

test("D17: once open, the keyboard goes to the editor: focus, then focus_next, outside render", async () => {
  const w = await open();
  const wrap = find(w.draw(), "file-body");
  assert.ok(wrap.calls.track_focus);
  assert.deepEqual(w.focus, [], "nothing while it draws");
  await w.fire(50);
  assert.deepEqual(w.focus, [`handle${wrap.calls.track_focus[0].n}`, "focus_next"]);
});

test("D17: a hidden copy doesn't take the keyboard; it does when its tab comes back", async () => {
  const w = await open({ active: false });
  await w.fire(50);
  assert.deepEqual(w.focus, []);
  w.draw();
  w.spaceList[0].tabs[0].active = false;
  w.spaceList[0].tabs[1].active = true;
  w.draw();
  await w.fire(50);
  assert.equal(w.focus.at(-1), "focus_next");
});

test("D17: a tab left and come back takes the keyboard again, though a hidden copy never renders", async () => {
  const w = await open();
  await w.fire(50);
  w.focus.length = 0;
  // It leaves: Herdr draws nothing for a hidden copy (measured), so only a timer can see it.
  w.spaceList[0].tabs[1].active = false;
  w.spaceList[0].tabs[0].active = true;
  await w.fire(150);
  w.spaceList[0].tabs[0].active = false;
  w.spaceList[0].tabs[1].active = true;
  w.draw();
  await w.fire(50);
  assert.equal(w.focus.at(-1), "focus_next");
});

test("the `focus` command gives it the keyboard back", async () => {
  const w = await open();
  await w.fire(50);
  w.focus.length = 0;
  await w.command("focus");
  assert.equal(w.focus.at(-1), "focus_next");
});

// ── D16: the line view ───────────────────────────────────────────────────────

const lineWorld = (over = {}) => open({ props: { doc: "d1", file: FILE, line: 3 }, disk: { [FILE]: "// a\nconst b = 1;\nc\nd\n" }, ...over });

test("D16: props.line: read-only rows, scrolled to the line and marked, no EditorState yet, Línea N and Editar in the header", async () => {
  const w = await lineWorld();
  assert.equal(w.editors.length, 0);
  assert.deepEqual(w.scrolls[0].calls[0], [2, "center"]);
  const drawn = w.draw();
  const list = findKind(drawn, "line_list");
  assert.equal(list.arg.count, 5);
  assert.equal(list.arg.size, 20);
  assert.ok(list.calls.track_scroll);
  assert.equal(findKind(drawn, "Scrollbar").arg, list.arg.id, "the bar pairs with the list by name");
  const rows = list.arg.render({ start: 0, end: 5 }, w.cx);
  assert.equal(rows.length, 5);
  assert.notEqual(rows[2].calls.bg, undefined, "the line is marked");
  assert.equal(rows[1].calls.bg, undefined);
  assert.ok(textOf(rows[1]).includes("const"));
  const header = find(drawn, "file-header");
  assert.ok(textOf(header).includes("Línea 3"));
  assert.ok(textOf(header).includes("Editar"));
});

test("D16: it scrolls again after the first frame, when the list exists", async () => {
  const w = await lineWorld();
  assert.equal(w.scrolls[0].calls.length, 1);
  await w.fire(50);
  assert.deepEqual(w.scrolls[0].calls, [[2, "center"], [2, "center"]]);
});

test("D16: a line past the end goes to the last row", async () => {
  const w = await open({ props: { doc: "d1", file: FILE, line: 99 }, disk: { [FILE]: "a\nb" } });
  assert.deepEqual(w.scrolls[0].calls[0], [1, "center"]);
});

test("D16: the row's tokens carry D5's colors", async () => {
  const w = await lineWorld();
  const list = findKind(w.draw(), "line_list");
  const [comment] = list.arg.render({ start: 0, end: 1 }, w.cx);
  const colored = (e, out = []) => { if (isEl(e)) { if (e.calls.text_color) out.push(e.calls.text_color[0]); e.kids.forEach((k) => colored(k, out)); } return out; };
  assert.ok(colored(comment).includes("#7f848e"));
});

test("D16: Editar opens the editor, on the click and the command; the header keeps Línea N because the editor opens at the top", async () => {
  for (const act of [(w) => w.click("header-edit"), (w) => w.command("edit")]) {
    const w = await lineWorld();
    await act(w);
    assert.equal(w.editors.length, 1);
    assert.equal(w.editor().text, "// a\nconst b = 1;\nc\nd\n");
    const drawn = w.draw();
    assert.ok(findKind(drawn, "Editor"));
    assert.equal(findKind(drawn, "line_list"), null);
    const header = find(drawn, "file-header");
    assert.ok(textOf(header).includes("Línea 3"));
    assert.equal(textOf(header).includes("Editar"), false);
  }
});

test("D16: a change on disk in the line view just shows the new text: no cursor to move", async () => {
  const w = await lineWorld();
  w.disk[FILE] = "new\n";
  await w.batch([REAL]);
  assert.equal(w.view.model.banner, null);
  assert.equal(findKind(w.draw(), "line_list").arg.count, 2);
});

test("D16: a line view with a draft to bring back opens in the editor", async () => {
  const fsFiles = { [`${DRAFTS}/abc-d1-1`]: serializeDraft({ path: REAL, baseSig: signature("x\n"), length: 5, at: 1 }, "draft") };
  const w = await open({ props: { doc: "d1", file: FILE, line: 3 }, disk: { [FILE]: "x\n" }, fsFiles });
  assert.equal(w.editor().text, "draft");
  assert.ok(findKind(w.draw(), "Editor"));
});

test("D16: the line view closes and ignores cmd-s like any clean file", async () => {
  const w = await lineWorld();
  await w.command("save");
  assert.deepEqual(w.writes, []);
  await w.command("close");
  assert.equal(w.closes().length, 1);
});

test("D16: a line that isn't a positive whole number opens the editor", async () => {
  for (const line of [0, -1, 2.5, "3", null]) {
    const w = await open({ props: { doc: "d1", file: FILE, line } });
    assert.equal(w.editors.length, 1, String(line));
  }
});

// ── The mod as Herdr gets it ─────────────────────────────────────────────────

const repo = fileURLToPath(new URL("..", import.meta.url));

test("S6: code-file docks nowhere on its own: each file comes in its own tab", () => {
  assert.deepEqual(JSON.parse(readFileSync(join(repo, "code-editor/mods/code-file/mod.json"), "utf8")), { place: "none" });
});

test("S6: installing code-editor installs code-file with its models, and uninstalling takes it away", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "code-file-install-")));
  try {
    const home = join(root, "herdr-app");
    mkdirSync(join(home, "mods"), { recursive: true });
    mkdirSync(join(home, "layouts"));
    const env = { ...process.env, HOME: root, HERDR_APP_HOME: home };
    const install = spawnSync("sh", [join(repo, "scripts/install.sh"), "--no-keys", "code-editor"], { encoding: "utf8", env });
    assert.equal(install.status, 0, install.stderr);
    for (const f of ["main.js", "mod.json", "document-model.js", "draft-model.js", "line-view-model.js"]) {
      assert.ok(existsSync(join(home, "mods/code-file", f)), f);
    }
    const gone = spawnSync("sh", [join(repo, "scripts/install.sh"), "--uninstall", "code-editor"], { encoding: "utf8", env });
    assert.equal(gone.status, 0, gone.stderr);
    assert.equal(existsSync(join(home, "mods/code-file")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
