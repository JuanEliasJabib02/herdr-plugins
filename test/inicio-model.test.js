// workspace-sleep T2: Inicio and the keeper (M/inicio-model.js, D6, D7). Which
// stored id is Inicio; making it, finishing a half-made one and giving back
// one a terminal took over, against a fake Herdr whose commands land only at
// the next sleep (so every id has to be read back from spaces()); where the
// keeper puts Inicio, when it selects it, and the guards on its moves; what
// the Inicio view says.
//
// T8: the space keys over the order without Inicio, and the keeper as the
// mod's only listener (T0b item 2), run against the mod's real copies
// (main.js) with herdr, gpui-kit and gpui-base faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { matchSpaces } from "../projects-sidebar/mods/projects/lib.js";
import { spacesToClose } from "../projects-sidebar/mods/projects/remove-workspace-model.js";
import { spaceRenames, workspaceMenuItems, sleepCommand, SLEEP_TOOLTIP } from "../projects-sidebar/mods/projects/tree-model.js";
import { menuHeight } from "../projects-sidebar/mods/projects/menus-model.js";
import {
  INICIO_NAME, parseInicio, inicioValue, validInicio, inicioState, spaceNewArgs, ensureInicio,
  look, shouldSelect, targetIndex, newGuard, canMove, moved, observe, reordered,
  MOVE_WAIT, BUDGET_WINDOW, BUDGET_PAUSE, localReady, keyCaps, landing,
  SPACE_COMMANDS, spaceTarget,
} from "../projects-sidebar/mods/projects/inicio-model.js";

// ── The mod's copies, with herdr faked (T8) ────────────────────────────────
// main.js and every view import herdr, gpui-kit and gpui-base, which only
// Herdr provides. These stand-ins export exactly the names the mod's files
// import (read from their sources, so a new import needs no edit here):
// each herdr function forwards to `fake`, the world a test sets up; gpui's
// are inert, since nothing here draws. Registered, and main.js loaded,
// before any test() (code-explorer-ops.test.js).
const MOD_DIR = new URL("../projects-sidebar/mods/projects/", import.meta.url);
const MOD_FILES = readdirSync(MOD_DIR).filter((f) => f.endsWith(".js"));
const modSource = (f) => readFileSync(new URL(f, MOD_DIR), "utf8");
function importedFrom(spec) {
  const names = new Set();
  for (const f of MOD_FILES) {
    for (const m of modSource(f).matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${spec}"`, "g"))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}
const INERT = `const inert = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : inert), apply: () => inert, construct: () => inert });`;
const gpui = (spec) => [INERT, ...importedFrom(spec).map((n) => (n === "View" ? "export class View {}" : `export const ${n} = inert;`))].join("\n");
const FAKES = {
  herdr: importedFrom("herdr").map((n) => `export const ${n} = (...a) => globalThis.__projectsHerdr(${JSON.stringify(n)}, a);`).join("\n"),
  "gpui-kit": gpui("gpui-kit"),
  "gpui-base": gpui("gpui-base"),
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});
let fake = {};
globalThis.__projectsHerdr = (name, args) => (fake[name] ? fake[name](...args) : undefined);
const { default: Projects } = await import("../projects-sidebar/mods/projects/main.js");
const { menuOf } = await import("../projects-sidebar/mods/projects/workspace-menu.js");

const HOME = "/Users/demo";
const WT = "/Users/demo/orca/workspaces/app/feat-login";
const CACHE = {
  "/code/app": [
    { path: "/code/app", branch: "main", main: true },
    { path: WT, branch: "feat/login", main: false },
  ],
};

// ── A fake Herdr ───────────────────────────────────────────────────────────
// Spaces, tabs and panes shaped as spaces() and panes() give them. run()
// queues a command; it lands at the next sleep, as a command whose effect
// shows a moment later. spaces() and panes() return a new array after each
// change, so a list read before a command never shows it.

const base = (path) => path.split("/").filter(Boolean).pop() ?? "~";

function herdr({ spaces = [], panes = [], focused = null, stored = null, drop = [] } = {}) {
  const w = { spaces, panes, focused, stored, runs: [], queue: [], n: 0, drop: new Set(drop) };
  const renumber = () => {
    w.spaces = w.spaces.map((s, i) => ({ ...s, index: i + 1, tabs: s.tabs.map((t, k) => ({ ...t, index: k + 1 })) }));
  };
  const select = (id) => {
    w.spaces = w.spaces.map((s) => ({ ...s, active: s.id === id }));
  };
  // Herdr's rule (T0): the space now at the closed one's index, else the previous one.
  const closeSpace = (id) => {
    const at = w.spaces.findIndex((s) => s.id === id);
    if (at < 0) return;
    const was = w.spaces[at].active;
    const tabs = new Set(w.spaces[at].tabs.map((t) => t.id));
    w.spaces = w.spaces.filter((s) => s.id !== id);
    w.panes = w.panes.filter((p) => !tabs.has(p.tab));
    if (was && w.spaces.length) select((w.spaces[at] ?? w.spaces[at - 1]).id);
    renumber();
  };
  const dropTab = (tabId) => {
    const s = w.spaces.find((x) => x.tabs.some((t) => t.id === tabId));
    if (!s) return;
    w.panes = w.panes.filter((p) => p.tab !== tabId);
    if (s.tabs.length === 1) return closeSpace(s.id);
    w.spaces = w.spaces.map((x) => (x.id === s.id ? { ...x, tabs: x.tabs.filter((t) => t.id !== tabId) } : x));
    renumber();
  };
  const apply = (name, args) => {
    if (w.drop.has(name)) return;
    if (name === "space.new") {
      const id = `new${++w.n}`;
      const focus = w.focused && w.panes.find((p) => p.terminal === w.focused);
      const folder = args.folder ?? focus?.cwd ?? HOME;
      const from = w.spaces.find((s) => s.active);
      const machine = args.machine === "" ? null : args.machine ?? from?.machine ?? null;
      w.spaces = [...w.spaces, {
        id, name: args.name ?? base(folder), named: Boolean(args.name), folder, machine, branch: null, active: false, status: null,
        tabs: [{ id: `${id}-t1`, name: "1", named: false, active: true, status: null, settled: false }],
      }];
      w.panes = [...w.panes, { pane: `${id}-p1`, terminal: `${id}-term`, tab: `${id}-t1`, cwd: folder }];
      select(id);
    } else if (name === "tab.new") {
      const tid = `${args.space}-m${++w.n}`;
      w.spaces = w.spaces.map((s) => (s.id === args.space
        ? { ...s, tabs: [...s.tabs.map((t) => ({ ...t, active: false })), { id: tid, name: "1", named: false, active: true, status: null, settled: false }] }
        : s));
      w.panes = [...w.panes, args.mod
        ? { pane: `${tid}-p`, terminal: null, mod: args.mod, tab: tid, cwd: null, props: args.props }
        : { pane: `${tid}-p`, terminal: `${tid}-term`, tab: tid, cwd: HOME }];
      select(args.space); // T0b: tab.new in a hidden space shows that space
    } else if (name === "tab.close") dropTab(args.id);
    else if (name === "pane.close") {
      const p = w.panes.find((x) => x.pane === args.pane);
      if (!p) return;
      if (w.panes.filter((x) => x.tab === p.tab).length === 1) dropTab(p.tab);
      else w.panes = w.panes.filter((x) => x.pane !== args.pane);
    } else if (name === "space.rename") {
      w.spaces = w.spaces.map((s) => (s.id === args.id ? { ...s, name: args.name || base(s.folder), named: Boolean(args.name) } : s));
    } else if (name === "space.select") select(args.id);
    else if (name === "space.close") closeSpace(args.id);
    else if (name === "space.move") {
      const s = w.spaces.find((x) => x.id === args.id);
      const rest = w.spaces.filter((x) => x.id !== args.id);
      w.spaces = [...rest.slice(0, args.index - 1), s, ...rest.slice(args.index - 1)];
    }
    renumber();
  };
  renumber();
  w.io = {
    stored: () => w.stored,
    store: (id) => {
      w.stored = id;
      w.runs.push(["store", id]);
    },
    run: (name, args) => {
      w.runs.push([name, args]);
      w.queue.push(() => apply(name, args));
    },
    spaces: () => w.spaces,
    panes: () => w.panes,
    home: HOME,
    sleep: async () => {
      const q = w.queue;
      w.queue = [];
      for (const f of q) f();
    },
  };
  w.flush = () => w.io.sleep();
  w.shown = () => w.spaces.find((s) => s.active)?.id ?? null;
  return w;
}

const tab = (id, extra = {}) => ({ id, name: "1", named: false, active: true, status: null, settled: false, ...extra });
const space = (id, extra = {}) => ({
  id, name: id, named: false, folder: `/code/${id}`, machine: null, branch: null, active: false, status: null,
  tabs: [tab(`${id}-t1`)], ...extra,
});
const term = (tabId, cwd, n = 1) => ({ pane: `${tabId}-p${n}`, terminal: `${tabId}-term${n}`, tab: tabId, cwd });
const view = (tabId) => ({ pane: `${tabId}-v`, terminal: null, mod: "projects", tab: tabId, cwd: null });

// Inicio as the keeper leaves it: named, in the home folder, one tab whose
// only pane is the view.
const inicio = (id = "ini", extra = {}) => space(id, { name: INICIO_NAME, named: true, folder: HOME, tabs: [tab(`${id}-m`)], ...extra });

// Two worktree spaces, A shown, plus Inicio stored.
function withInicio(order = ["a", "b", "ini"], extra = {}) {
  const all = { a: space("a", { active: true }), b: space("b"), ini: inicio() };
  const panes = { a: term("a-t1", "/code/a"), b: term("b-t1", "/code/b"), ini: view("ini-m") };
  return herdr({ spaces: order.map((id) => all[id]), panes: order.map((id) => panes[id]), stored: "ini", ...extra });
}

const names = (runs) => runs.map(([n]) => n);

// ── Which Inicio (D6) ──────────────────────────────────────────────────────

test("stored value: { space: id } reads as the id; anything else as none", () => {
  assert.equal(parseInicio({ space: "s4" }), "s4");
  for (const bad of [undefined, null, "s4", { space: "" }, { space: 4 }, [], { id: "s4" }]) assert.equal(parseInicio(bad), null, JSON.stringify(bad));
  assert.deepEqual(inicioValue("s4"), { space: "s4" });
  assert.equal(inicioValue(null), null);
  assert.equal(parseInicio(inicioValue("s4")), "s4", "it reads back as itself");
});

test("which Inicio: a stored id whose space exists, is local and holds a projects pane is valid", () => {
  const w = withInicio();
  assert.equal(validInicio("ini", w.spaces, w.panes), true);
  assert.equal(inicioState({ stored: "ini", spaces: w.spaces, panes: w.panes }).kind, "ok");
});

test("which Inicio: gone, remote or without the projects pane is invalid", () => {
  const w = withInicio();
  assert.equal(validInicio("gone", w.spaces, w.panes), false, "gone");
  assert.equal(validInicio(null, w.spaces, w.panes), false, "none stored");
  const remote = w.spaces.map((s) => (s.id === "ini" ? { ...s, machine: "box" } : s));
  assert.equal(validInicio("ini", remote, w.panes), false, "remote");
  const other = w.panes.map((p) => (p.tab === "ini-m" ? { ...p, mod: "code-file" } : p));
  assert.equal(validInicio("ini", w.spaces, other), false, "another mod's pane");
  assert.equal(validInicio("a", w.spaces, w.panes), false, "a terminal space");
  assert.equal(inicioState({ stored: "gone", spaces: w.spaces, panes: w.panes }).kind, "stale");
});

// ── Making it (D6) ─────────────────────────────────────────────────────────

test("making: space.new with folder home() and machine \"\", then tab.new on the id read back, then its terminal tab closed, the id stored and the space shown before selected again", async () => {
  const w = herdr({ spaces: [space("a", { active: true }), space("b")], panes: [term("a-t1", "/code/a"), term("b-t1", "/code/b")] });
  const out = await ensureInicio(w.io);
  const made = w.spaces.find((s) => s.name === INICIO_NAME);
  assert.ok(made, "Inicio exists");
  assert.deepEqual(out, { id: made.id, made: true });
  assert.deepEqual(w.runs, [
    ["space.new", { name: "Inicio", folder: HOME, machine: "" }],
    ["tab.new", { space: made.id, mod: "projects", props: { view: "inicio" } }],
    ["tab.close", { id: `${made.id}-t1`, confirmed: true }],
    ["store", made.id],
    ["space.select", { id: "a" }],
  ]);
  await w.flush();
  assert.equal(w.shown(), "a", "the space shown before is shown again");
  assert.deepEqual(w.panes.filter((p) => made.tabs.some((t) => t.id === p.tab)).map((p) => p.mod ?? "terminal"), ["projects"], "only its view is left");
  assert.equal(inicioState({ stored: w.stored, spaces: w.spaces, panes: w.panes }).kind, "ok");
  assert.deepEqual(spaceNewArgs(HOME), { name: "Inicio", folder: HOME, machine: "" });
});

test("making with stay (the keeper is about to select it): Inicio stays shown, nothing else is selected", async () => {
  const w = herdr({ spaces: [space("a", { active: true })], panes: [term("a-t1", "/code/a")] });
  const out = await ensureInicio(w.io, { stay: true });
  await w.flush();
  assert.equal(out.made, true);
  assert.ok(!names(w.runs).includes("space.select"));
  assert.equal(w.shown(), out.id);
});

test("making: a view that never shows closes the space it made, selects the one before and reports nothing made", async () => {
  const w = herdr({ spaces: [space("a", { active: true })], panes: [term("a-t1", "/code/a")], drop: ["tab.new"] });
  assert.equal(await ensureInicio(w.io), null);
  await w.flush();
  assert.deepEqual(w.spaces.map((s) => s.id), ["a"], "no stray space");
  assert.equal(w.shown(), "a");
  assert.equal(w.stored, null);
});

test("making: a space.new that never shows gives up without guessing an id", async () => {
  const w = herdr({ spaces: [space("a", { active: true })], panes: [term("a-t1", "/code/a")], drop: ["space.new"] });
  assert.equal(await ensureInicio(w.io), null);
  assert.deepEqual(names(w.runs), ["space.new"]);
});

test("never a worktree's (R2#1): made while a worktree's terminal is focused, Inicio isn't listed under it, and that worktree's Delete or Rename leaves it", async () => {
  const w = herdr({
    spaces: [space("wt", { folder: WT, active: true })],
    panes: [term("wt-t1", WT)],
    focused: "wt-t1-term1",
  });
  const out = await ensureInicio(w.io);
  await w.flush();
  const ini = w.spaces.find((s) => s.id === out.id);
  assert.equal(ini.folder, HOME, "its folder is home, not the focused terminal's");
  assert.equal(ini.machine, null);
  const matches = matchSpaces(CACHE, w.spaces, w.panes, HOME);
  assert.ok(!(out.id in matches), "listed under no workspace");
  assert.deepEqual(spacesToClose(matches, WT), ["wt"], "Delete and Rename count only the worktree's own space");
  assert.deepEqual(spaceRenames({ path: WT, before: "feat/login", after: "feat/signin", spaces: w.spaces, matches }), []);
  for (const id of spacesToClose(matches, WT)) w.io.run("space.close", { id, confirmed: true });
  await w.flush();
  assert.deepEqual(w.spaces.map((s) => s.id), [out.id], "Deleting the worktree leaves Inicio");
});

test("a half-made Inicio (a reload between the steps): its terminal tab is closed and its id stored; nothing new is made", async () => {
  const half = space("h", { name: INICIO_NAME, named: true, folder: HOME, tabs: [tab("h-t1", { active: false }), tab("h-m")] });
  const w = herdr({ spaces: [space("a", { active: true }), half], panes: [term("a-t1", "/code/a"), term("h-t1", HOME), view("h-m")] });
  assert.equal(inicioState({ stored: null, spaces: w.spaces, panes: w.panes }).kind, "half");
  assert.deepEqual(await ensureInicio(w.io), { id: "h", made: false });
  assert.deepEqual(w.runs, [["tab.close", { id: "h-t1", confirmed: true }], ["store", "h"]]);
  assert.equal(w.shown(), "a", "what was shown stays");
});

test("a finished Inicio that was never stored (a reload right before the store) is stored as it is", async () => {
  const w = herdr({ spaces: [space("a", { active: true }), inicio("h")], panes: [term("a-t1", "/code/a"), view("h-m")] });
  assert.deepEqual(await ensureInicio(w.io), { id: "h", made: false });
  assert.deepEqual(w.runs, [["store", "h"]]);
});

test("a space named Inicio whose terminal tab came after its view isn't a half-made one: none of its terminals is closed", async () => {
  const mine = space("u", { name: INICIO_NAME, named: true, folder: HOME, tabs: [tab("u-m"), tab("u-t2", { active: false })] });
  const w = herdr({ spaces: [space("a", { active: true }), mine], panes: [term("a-t1", "/code/a"), view("u-m"), term("u-t2", HOME)] });
  assert.equal(inicioState({ stored: null, spaces: w.spaces, panes: w.panes }).kind, "none");
  const out = await ensureInicio(w.io);
  assert.notEqual(out.id, "u");
  assert.ok(!w.runs.some(([n, a]) => n === "tab.close" && a.id === "u-t2"));
});

test("a stored id that no longer is Inicio is forgotten and a new one made", async () => {
  const w = herdr({ spaces: [space("a", { active: true })], panes: [term("a-t1", "/code/a")], stored: "gone" });
  const out = await ensureInicio(w.io);
  assert.deepEqual(w.runs[0], ["store", null]);
  assert.equal(out.made, true);
  assert.equal(w.stored, out.id);
});

// ── Taken over (D6, R2#1) ──────────────────────────────────────────────────

test("taken over by a terminal tab (Cmd+T): its projects pane is closed, its name given back, the id forgotten, and a new Inicio made", async () => {
  const w = withInicio(["a", "ini"], {});
  w.spaces = w.spaces.map((s) => (s.id === "ini" ? { ...s, tabs: [...s.tabs, tab("ini-t2", { active: false })] } : s));
  w.panes = [...w.panes, term("ini-t2", HOME)];
  assert.equal(inicioState({ stored: "ini", spaces: w.spaces, panes: w.panes }).kind, "taken");
  const out = await ensureInicio(w.io);
  assert.deepEqual(w.runs.slice(0, 4), [
    ["pane.close", { pane: "ini-m-v" }],
    ["space.rename", { id: "ini", name: "" }],
    ["store", null],
    ["space.new", { name: "Inicio", folder: HOME, machine: "" }],
  ]);
  await w.flush();
  const old = w.spaces.find((s) => s.id === "ini");
  assert.ok(old, "the old space stays, an ordinary one");
  assert.equal(old.named, false);
  assert.deepEqual(w.panes.filter((p) => p.tab.startsWith("ini-")).map((p) => p.pane), ["ini-t2-p1"], "its terminal keeps running");
  assert.notEqual(out.id, "ini");
  assert.equal(w.stored, out.id);
});

test("taken over by a terminal split beside its view: the view pane alone is closed", async () => {
  const w = withInicio(["a", "ini"]);
  w.panes = [...w.panes, term("ini-m", HOME, 2)];
  assert.equal(inicioState({ stored: "ini", spaces: w.spaces, panes: w.panes }).kind, "taken");
  await ensureInicio(w.io);
  await w.flush();
  assert.equal(w.runs[0][0], "pane.close");
  assert.deepEqual(w.panes.filter((p) => p.tab === "ini-m").map((p) => p.pane), ["ini-m-p2"]);
});

test("taken over and renamed by the person: its name stays", async () => {
  const w = withInicio(["a", "ini"]);
  w.spaces = w.spaces.map((s) => (s.id === "ini" ? { ...s, name: "Notes", tabs: [...s.tabs, tab("ini-t2", { active: false })] } : s));
  w.panes = [...w.panes, term("ini-t2", HOME)];
  await ensureInicio(w.io);
  assert.ok(!names(w.runs).includes("space.rename"));
});

test("taken over: a view pane that won't close keeps the id, so its terminals are never taken for a half-made Inicio", async () => {
  const w = withInicio(["a", "ini"], { drop: ["pane.close"] });
  w.spaces = w.spaces.map((s) => (s.id === "ini" ? { ...s, tabs: [...s.tabs, tab("ini-t2", { active: false })] } : s));
  w.panes = [...w.panes, term("ini-t2", HOME)];
  assert.equal(await ensureInicio(w.io), null);
  assert.equal(w.stored, "ini");
  assert.deepEqual(names(w.runs), ["pane.close"]);
});

// ── The keeper's look and when it selects Inicio (D7) ──────────────────────

const settledAll = (s) => ({ ...s, tabs: s.tabs.map((t) => ({ ...t, settled: true })) });

test("look: the shown space, whether all its tabs are put away, and the order", () => {
  const w = withInicio();
  assert.deepEqual(look(w.spaces), { shown: "a", putAway: false, ids: ["a", "b", "ini"] });
  assert.equal(look(w.spaces.map((s) => (s.id === "a" ? settledAll(s) : s))).putAway, true);
  assert.deepEqual(look([]), { shown: null, putAway: false, ids: [] });
});

test("select Inicio: the same shown space went from not put away to put away", () => {
  const before = look(withInicio().spaces);
  const after = look(withInicio().spaces.map((s) => (s.id === "a" ? settledAll(s) : s)));
  assert.equal(shouldSelect(before, after, "ini"), true);
  assert.equal(shouldSelect(after, after, "ini"), false, "still put away: already handled");
});

test("select Inicio: the remembered shown space is gone and another is shown (Herdr's rule changed: a flash, then Inicio)", () => {
  const before = { shown: "a", putAway: false, ids: ["a", "b", "ini"] };
  assert.equal(shouldSelect(before, { shown: "b", putAway: false, ids: ["b", "ini"] }, "ini"), true);
  assert.equal(shouldSelect(before, { shown: "ini", putAway: false, ids: ["b", "ini"] }, "ini"), false, "Herdr already landed on Inicio");
  assert.equal(shouldSelect({ shown: "ini", putAway: false, ids: ["a", "ini"] }, { shown: "a", putAway: false, ids: ["a"] }, null), true,
    "Inicio itself closed: a new one is shown, never the next worktree (S10)");
});

test("don't select: a space that becomes shown already put away (a click: agent-sleep wakes it), the first look, Inicio shown", () => {
  const before = { shown: "a", putAway: false, ids: ["a", "b", "ini"] };
  assert.equal(shouldSelect(before, { shown: "b", putAway: true, ids: ["a", "b", "ini"] }, "ini"), false);
  assert.equal(shouldSelect(null, { shown: "a", putAway: true, ids: ["a"] }, "ini"), false, "a reload");
  assert.equal(shouldSelect({ shown: "ini", putAway: false, ids: ["ini"] }, { shown: "ini", putAway: true, ids: ["ini"] }, "ini"), false);
  assert.equal(shouldSelect(before, { shown: "a", putAway: false, ids: ["a", "ini"] }, "ini"), false, "another space closed");
});

// ── Where Inicio goes (D7) ─────────────────────────────────────────────────

test("target index: right after the shown space, 1-based, counted without Inicio", () => {
  assert.equal(targetIndex(withInicio(["a", "b", "ini"]).spaces, "ini"), 2);
  assert.equal(targetIndex(withInicio(["ini", "a", "b"]).spaces, "ini"), 2, "Inicio before the shown one");
  const four = herdr({ spaces: [space("a"), space("b", { active: true }), space("c"), inicio()] });
  assert.equal(targetIndex(four.spaces, "ini"), 3);
});

test("target index: none when Inicio already sits there, while Inicio or a remote space is shown, or without Inicio", () => {
  assert.equal(targetIndex(withInicio(["a", "ini", "b"]).spaces, "ini"), null);
  const lastShown = withInicio(["a", "b", "ini"]).spaces.map((s) => ({ ...s, active: s.id === "b" }));
  assert.equal(targetIndex(lastShown, "ini"), null, "after the last space");
  const onInicio = withInicio().spaces.map((s) => ({ ...s, active: s.id === "ini" }));
  assert.equal(targetIndex(onInicio, "ini"), null);
  const remote = [...withInicio().spaces.map((s) => ({ ...s, active: false })), space("r", { machine: "box", active: true })];
  assert.equal(targetIndex(remote, "ini"), null);
  assert.equal(targetIndex(withInicio().spaces, null), null);
  assert.equal(targetIndex(withInicio().spaces, "gone"), null);
});

test("the keeper's move lands Inicio where the next close shows it", async () => {
  const w = herdr({
    spaces: [space("a"), space("b", { active: true }), space("c"), inicio()],
    panes: [term("a-t1", "/code/a"), term("b-t1", "/code/b"), term("c-t1", "/code/c"), view("ini-m")],
    stored: "ini",
  });
  const index = targetIndex(w.spaces, "ini");
  w.io.run("space.move", { id: "ini", index });
  await w.flush();
  assert.deepEqual(w.spaces.map((s) => s.id), ["a", "b", "ini", "c"]);
  w.io.run("space.close", { id: "b", confirmed: true });
  await w.flush();
  assert.equal(w.shown(), "ini");
});

// ── Guards (D7, R1#3) ──────────────────────────────────────────────────────

const order = (ids) => ids.map((id) => space(id));

test("in flight: no new move until spaces() shows the last one applied", () => {
  const t = 1_000_000;
  let g = moved(newGuard(), 2, t);
  assert.equal(canMove(g, t), false);
  g = observe(g, order(["a", "b", "ini"]), "ini", t + 100).guard;
  assert.equal(canMove(g, t + 100), false, "not applied yet");
  g = observe(g, order(["a", "ini", "b"]), "ini", t + 200).guard;
  assert.equal(canMove(g, t + 200), true, "applied");
});

test("in flight: a move never seen applied stops waiting after MOVE_WAIT", () => {
  const t = 1_000_000;
  let g = moved(newGuard(), 2, t);
  g = observe(g, order(["a", "b", "ini"]), "ini", t + MOVE_WAIT + 1).guard;
  assert.equal(canMove(g, t + MOVE_WAIT + 1), true);
});

test("budget: 4 changes under it within 10 s stop the moves for 60 s, logged once", () => {
  const t = 1_000_000;
  let g = observe(newGuard(), order(["a", "b", "ini"]), "ini", t).guard;
  const flips = [["a", "ini", "b"], ["a", "b", "ini"], ["a", "ini", "b"], ["a", "b", "ini"]];
  const logs = [];
  flips.forEach((ids, i) => {
    const r = observe(g, order(ids), "ini", t + 1000 * (i + 1));
    g = r.guard;
    if (r.log) logs.push(r.log);
    if (i < 3) assert.equal(canMove(g, t + 1000 * (i + 1)), true, `${i + 1} changes: still moving`);
  });
  assert.equal(canMove(g, t + 4000), false, "the 4th change stops it");
  assert.equal(logs.length, 1);
  const r = observe(g, order(["a", "ini", "b"]), "ini", t + 5000);
  assert.equal(r.log, null, "logged once");
  assert.equal(canMove(r.guard, t + 4000 + BUDGET_PAUSE - 1), false);
  assert.equal(canMove(r.guard, t + 4000 + BUDGET_PAUSE), true, "60 s later it moves again");
});

test("budget: 4 changes spread over more than 10 s never stop it; a space made or closed isn't a change", () => {
  const t = 1_000_000;
  let g = observe(newGuard(), order(["a", "b", "ini"]), "ini", t).guard;
  const flips = [["a", "ini", "b"], ["a", "b", "ini"], ["a", "ini", "b"], ["a", "b", "ini"]];
  flips.forEach((ids, i) => {
    g = observe(g, order(ids), "ini", t + (BUDGET_WINDOW / 3 + 1) * (i + 1)).guard;
  });
  assert.equal(canMove(g, t + BUDGET_WINDOW * 2), true);
  assert.equal(reordered(["a", "b", "ini"], ["a", "b", "c", "ini"]), false, "a space made");
  assert.equal(reordered(["a", "b", "ini"], ["a", "ini"]), false, "a space closed");
  assert.equal(reordered(["a", "b", "ini"], ["b", "a", "ini"]), true, "a space dragged");
  assert.equal(reordered(null, ["a"]), false, "nothing seen before");
});

test("the keeper's own applied move is not a change under it", () => {
  const t = 1_000_000;
  let g = observe(newGuard(), order(["a", "b", "ini"]), "ini", t).guard;
  for (let i = 0; i < 6; i += 1) {
    const ids = i % 2 ? ["a", "b", "ini"] : ["a", "ini", "b"];
    g = moved(g, ids.indexOf("ini") + 1, t + i * 100);
    g = observe(g, order(ids), "ini", t + i * 100 + 50).guard;
  }
  assert.equal(canMove(g, t + 1000), true);
});

test("the local layout must be ready before anything is made (a loading list reads as no spaces)", () => {
  assert.equal(localReady([{ name: null, layout: "ready" }, { name: "box", layout: "unavailable" }]), true);
  assert.equal(localReady([{ name: null, layout: "loading" }]), false);
  assert.equal(localReady([{ name: "box", layout: "ready" }]), false);
  assert.equal(localReady(null), false);
});

// ── The view (D6, S2) ──────────────────────────────────────────────────────

const REG = { version: 1, groups: [{ id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }] }], activeGroup: "g1" };
const EMPTY = { version: 1, groups: [{ id: "g1", name: "Projects", projects: [] }], activeGroup: "g1" };

test("the view follows Orca's Landing: Herdr, the hint, Add project and Create workspace, no Star on GitHub", () => {
  const l = landing({ registry: REG, bindings: [], layout: "projects", platform: "macos" });
  assert.equal(l.title, "Herdr");
  assert.equal(l.hint, "Select a workspace from the sidebar to begin.");
  assert.deepEqual(l.buttons.map((b) => b.label), ["Add project", "Create workspace"]);
  assert.ok(!JSON.stringify(l).includes("Star"));
  assert.equal(landing({ registry: EMPTY, bindings: [], layout: "projects", platform: "macos" }).hint, "Add a project to get started.");
});

test("shortcut rows only for commands with a key: global and this layout's, a layout key shadowing a global one", () => {
  const bindings = [
    { section: "global", keys: "cmd-alt-]", action: "space.next" },
    { section: "global", keys: "cmd-alt-[", action: "space.prev" },
    { section: "terminal", keys: "cmd-n", action: "projects.new-workspace" },
  ];
  const l = landing({ registry: REG, bindings, layout: "projects", platform: "macos" });
  assert.deepEqual(l.shortcuts, [
    { label: "Move up workspace", caps: ["⌘", "⌥", "["] },
    { label: "Move down workspace", caps: ["⌘", "⌥", "]"] },
  ], "a terminal-only key doesn't count in Inicio");
  const shadowed = [...bindings, { section: "layout:projects", keys: "cmd-alt-]", action: "projects.group1" }];
  assert.deepEqual(landing({ registry: REG, bindings: shadowed, layout: "projects", platform: "macos" }).shortcuts.map((s) => s.label), ["Move up workspace"]);
  const other = [{ section: "layout:main", keys: "cmd-shift-n", action: "projects.new-workspace" }];
  assert.deepEqual(landing({ registry: REG, bindings: other, layout: "projects", platform: "macos" }).shortcuts, [], "another layout's key");
  const routed = [{ section: "layout:projects", keys: "cmd-alt-]", action: "projects.space-next" }, { section: "global", keys: "cmd-shift-n", action: "projects.new-workspace" }];
  assert.deepEqual(landing({ registry: REG, bindings: routed, layout: "projects", platform: "macos" }).shortcuts, [
    { label: "Create workspace", caps: ["⌘", "⇧", "N"] },
    { label: "Move down workspace", caps: ["⌘", "⌥", "]"] },
  ]);
});

test("key caps: macOS glyphs, words elsewhere, a minus key kept", () => {
  assert.deepEqual(keyCaps("cmd-shift-up", "macos"), ["⌘", "⇧", "↑"]);
  assert.deepEqual(keyCaps("cmd--", "macos"), ["⌘", "-"]);
  assert.deepEqual(keyCaps("ctrl-1", "macos"), ["⌃", "1"]);
  assert.deepEqual(keyCaps("f2", "macos"), ["F2"]);
  assert.deepEqual(keyCaps("ctrl-shift-n", "linux"), ["Ctrl", "Shift", "N"]);
  assert.deepEqual(keyCaps("alt-enter", null), ["Alt", "Enter"]);
});

// ── Space keys skip Inicio (D7, T8, S10) ───────────────────────────────────

// Spaces in this order, `shown` shown; "ini" is Inicio.
const ordered = (ids, shown) => ids.map((id) => (id === "ini" ? inicio() : space(id))).map((s) => ({ ...s, active: s.id === shown }));
const keyOn = (command, ids, shown) => spaceTarget(command, ordered(ids, shown), "ini");

test("space keys: the eleven commands keys.json binds (cmd-alt-] / cmd-alt-[, ctrl-1…ctrl-9)", () => {
  assert.deepEqual(SPACE_COMMANDS, ["space-next", "space-prev", ...Array.from({ length: 9 }, (_, i) => `space-${i + 1}`)]);
});

test("space keys: next and prev from every position skip Inicio, and wrap at the ends as Herdr's do (T0b item 3)", () => {
  // Inicio right after b, as the keeper keeps it. shown → [next, prev].
  const want = { a: ["b", "c"], b: ["c", "a"], c: ["a", "b"], ini: ["c", "b"] };
  for (const [shown, [next, prev]] of Object.entries(want)) {
    assert.equal(keyOn("space-next", ["a", "b", "ini", "c"], shown), next, `next from ${shown}`);
    assert.equal(keyOn("space-prev", ["a", "b", "ini", "c"], shown), prev, `prev from ${shown}`);
  }
  assert.equal(keyOn("space-next", ["a", "b", "ini"], "b"), "a", "the last space wraps to the first, past Inicio at the end");
  assert.equal(keyOn("space-prev", ["ini", "a", "b"], "a"), "b", "the first space wraps to the last, past Inicio at the start");
  assert.equal(keyOn("space-next", ["a", "b", "ini"], "ini"), "a", "from Inicio at the end: wraps to the first");
});

test("space keys act exactly as Herdr's own over the order without Inicio, wherever Inicio sits", () => {
  const plain = ["a", "b", "c", "d"];
  for (const shown of plain) {
    const i = plain.indexOf(shown);
    for (let at = 0; at <= plain.length; at += 1) {
      const ids = [...plain.slice(0, at), "ini", ...plain.slice(at)];
      const where = `${shown} shown, Inicio at ${at + 1}`;
      // Herdr's: next = index + 1, prev = index - 1, both wrapping; select:N = the Nth.
      assert.equal(keyOn("space-next", ids, shown), plain[(i + 1) % 4], `next, ${where}`);
      assert.equal(keyOn("space-prev", ids, shown), plain[(i + 3) % 4], `prev, ${where}`);
      for (let n = 1; n <= 4; n += 1) assert.equal(keyOn(`space-${n}`, ids, shown), plain[n - 1] === shown ? null : plain[n - 1], `space-${n}, ${where}`);
    }
    assert.equal(spaceTarget("space-next", ordered(plain, shown), null), plain[(i + 1) % 4], "no Inicio: Herdr's next");
  }
});

test("space-N reaches the Nth space without Inicio, and does nothing past the last", () => {
  const ids = ["ini", "a", "b", "c"];
  assert.equal(keyOn("space-1", ids, "c"), "a");
  assert.equal(keyOn("space-3", ids, "a"), "c");
  assert.equal(keyOn("space-4", ids, "a"), null, "three spaces besides Inicio");
  assert.equal(keyOn("space-9", ids, "a"), null);
  assert.equal(keyOn("space-1", ids, "ini"), "a", "from Inicio too");
  assert.equal(keyOn("space-2", ["a", "b"], null), "b", "with no space shown");
});

test("space keys do nothing when nothing would change: the shown space is the only one besides Inicio, only Inicio, none shown, or no such command", () => {
  for (const c of ["space-next", "space-prev", "space-1"]) assert.equal(keyOn(c, ["a", "ini"], "a"), null, c);
  for (const c of ["space-next", "space-prev", "space-1"]) assert.equal(keyOn(c, ["ini"], "ini"), null, `only Inicio: ${c}`);
  assert.equal(keyOn("space-next", ["a", "b"], null), null, "none shown");
  assert.equal(keyOn("space-prev", [], null), null);
  for (const c of ["space-0", "space-x", "space-", "next", "space-1.5"]) assert.equal(keyOn(c, ["a", "b"], "a"), null, c);
});

// ── The keeper is the mod's only listener (D7, T8, T0b item 2) ─────────────

// The fake world the copies see: a registry with two groups, the worktree
// lists the tree copy writes (projects.cache.v1), Inicio stored and right
// after the shown space b (so the keeper's own look moves nothing), and the
// herdr functions that act, recorded.
const REG2 = {
  version: 1,
  groups: [{ id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }] }, { id: "g2", name: "Side", projects: [] }],
  activeGroup: "g1",
};
function world({ spaces: sp, panes: ps, shown = "b" } = {}) {
  const w = {
    shared: { "projects.v1": REG2, "projects.cache.v1": CACHE, "projects.inicio.v1": { space: "ini" } },
    runs: [], toasts: [], overlays: [], closed: [], picks: [], listens: 0, waiting: [], queued: [], timers: [],
  };
  const all = sp ?? ordered(["a", "b", "ini", "c"], shown);
  const panesNow = ps ?? [term("a-t1", "/code/a"), term("b-t1", WT), view("ini-m"), term("c-t1", "/code/c")];
  fake = {
    props: () => w.props,
    window: () => w.window,
    machines: () => [{ name: null, layout: "ready" }],
    spaces: () => all,
    panes: () => panesNow,
    home: () => HOME,
    focused: () => null,
    agents: () => [],
    knownAgents: () => [],
    keys: () => [],
    layout: () => null,
    theme: () => ({}),
    shared: (k) => w.shared[k],
    setShared: (k, v) => {
      w.shared[k] = v;
      return null;
    },
    run: (name, args) => {
      w.runs.push([name, args]);
      return null;
    },
    notify: (n) => {
      w.toasts.push(n);
      return null;
    },
    openOverlay: (spec) => {
      w.overlays.push(spec);
      return "o1";
    },
    closeOverlay: (id) => {
      w.closed.push(id);
      return null;
    },
    pickFolder: async (o) => {
      w.picks.push(o);
      return null;
    },
    exec: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
    watchFolder: () => new Promise(() => {}),
    nextCommand: () => {
      w.listens += 1;
      return new Promise((resolve) => (w.queued.length ? resolve(w.queued.shift()) : w.waiting.push(resolve)));
    },
  };
  w.window = { active: true, platform: "macos" };
  return w;
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
};

// A copy of the mod as Herdr starts one: props() set, then init with a cx
// whose tasks run and whose timers fire only when a test says (fire).
async function copyOf(w, view, extra = {}) {
  w.props = view ? { view, ...extra } : null;
  const cx = {
    spawn: (fn) => fn(cx)?.catch?.(() => {}),
    timer: { every: (_ms, fn) => w.timers.push(() => fn(cx)) },
    sleep: () => Promise.resolve(),
    notify() {},
    focus_handle: () => ({ focus() {} }),
    write_to_clipboard() {},
  };
  const c = new Projects();
  c.init(null, cx);
  await settle();
  return c;
}

// Every timer of the copies started in `w` fires once.
async function fire(w) {
  for (const f of w.timers) f();
  await settle();
}

// A key command, as Herdr delivers one: to a copy waiting on nextCommand().
async function send(w, name) {
  const waiting = w.waiting.shift();
  if (waiting) waiting(name);
  else w.queued.push(name);
  await settle();
}

const selects = (w) => w.runs.filter(([n]) => n === "space.select").map(([, a]) => a.id);

test("only the keeper copy listens: one command reaches one shown copy only (T0b item 2), so the tree, groups and Inicio copies never wait on nextCommand()", async () => {
  for (const view of [null, "tree", "groups", "inicio"]) {
    const w = world();
    await copyOf(w, view);
    assert.equal(w.listens, 0, `${view ?? "no view"} doesn't listen`);
  }
  const w = world();
  await copyOf(w, "keeper");
  assert.equal(w.listens, 1, "the keeper listens");
  const src = MOD_FILES.filter((f) => /\bnextCommand\(/.test(modSource(f)));
  assert.deepEqual(src, ["keeper.js"], "no other file of the mod reads commands");
});

test("the keeper listens without a window too: commands come only from one, and it still acts on nothing on its own", async () => {
  const w = world();
  w.window = null;
  await copyOf(w, "keeper");
  assert.equal(w.listens, 1);
  assert.deepEqual(w.runs, [], "inert: no look, no move, no making");
});

test("a keeper started before its window (a cold start) looks once one is there, with no reload; while there is none it makes, moves and selects nothing (step 4's F1)", async () => {
  // b shown, Inicio last: its place is right after b, index 3.
  const w = world({ spaces: ordered(["a", "b", "c", "ini"], "b") });
  w.window = null;
  const c = await copyOf(w, "keeper");
  assert.equal(w.timers.length, 1, "its look's timer started anyway");
  assert.equal(w.listens, 1, "and its listener");
  await fire(w);
  c.render({ spawn: (fn) => fn({ sleep: () => Promise.resolve() }) });
  await fire(w);
  assert.deepEqual(w.runs, [], "no window: no look, no move, no making");
  w.window = { active: true, platform: "macos" };
  await fire(w);
  assert.deepEqual(w.runs, [["space.move", { id: "ini", index: 3 }]], "the window is there: Inicio goes right after b");
});

test("every existing projects.* command runs from the keeper copy, the tree copy's state reached through the store", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const w = world();
  await copyOf(w, "keeper");

  await send(w, "group2");
  assert.equal(w.shared["projects.v1"].activeGroup, "g2", "F2: the stored registry the tree draws");
  await send(w, "group1");
  assert.equal(w.shared["projects.v1"].activeGroup, "g1");
  await send(w, "group3");
  assert.equal(w.shared["projects.v1"].activeGroup, "g1", "no third group: nothing");

  await send(w, "new-workspace");
  assert.deepEqual(w.overlays.map((o) => o.props), [{ view: "new-workspace", project: "/code/app" }],
    "the shown space's project, from the worktree lists the tree copy stored");
  assert.equal(w.overlays[0].kind, "dialog", "a centered dialog: where the copy sits doesn't matter");

  await send(w, "add");
  assert.deepEqual(w.picks, [{ prompt: "Add project" }], "the folder picker");

  await send(w, "add-here");
  assert.deepEqual(w.toasts.at(-1), { title: "Add project", body: "No space is focused.", level: "warning" });

  await send(w, "ping");
  assert.equal(w.toasts.at(-1).title, "projects: ping");
  assert.match(w.toasts.at(-1).body, /^view keeper, copy [a-z0-9]+$/, "it says the keeper ran it");

  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]).filter((l) => /no command|failed/.test(l)), []);
  await send(w, "nope");
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'projects: no command "nope"'), "an unknown command is logged");
  await send(w, "ping");
  assert.equal(w.toasts.filter((n) => n.title === "projects: ping").length, 2, "the loop goes on after it");
});

test("the space keys run from the keeper copy over the order without Inicio", async () => {
  const w = world(); // a, b (shown), Inicio, c
  await copyOf(w, "keeper");
  assert.deepEqual(w.runs, [], "Inicio already sits right after b");
  await send(w, "space-next");
  await send(w, "space-prev");
  await send(w, "space-3");
  await send(w, "space-2");
  await send(w, "space-9");
  assert.deepEqual(selects(w), ["c", "a", "c"], "next skips Inicio, prev is a, ctrl-3 is c; ctrl-2 is b, already shown, and ctrl-9 is past the last");

  // D6's rule decides what Inicio is: one a terminal took over is an
  // ordinary space until the keeper gives it back (no window here, so the
  // keeper's own look stays out of it).
  const taken = world({ panes: [term("a-t1", "/code/a"), term("b-t1", WT), view("ini-m"), term("ini-m", HOME, 2), term("c-t1", "/code/c")] });
  taken.window = null;
  await copyOf(taken, "keeper");
  await send(taken, "space-next");
  assert.deepEqual(selects(taken), ["ini"], "a taken-over Inicio is next after b");
});

test("every projects.* key in keys.json has a command in the keeper", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const keys = JSON.parse(readFileSync(new URL("../projects-sidebar/keys.json", import.meta.url), "utf8"));
  const actions = Object.values(keys).flatMap((m) => Object.values(m)).filter((a) => typeof a === "string" && a.startsWith("projects."));
  assert.ok(actions.length >= 14);
  const w = world();
  await copyOf(w, "keeper");
  for (const a of actions) await send(w, a.slice("projects.".length));
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]).filter((l) => /no command|failed/.test(l)), []);
});

// ── The workspace menu opened from another mod (projects-agents' rows) ────

test("workspace-menu-at opens the workspace's own menu at the pointer, as tall as its items, then closes itself", async () => {
  const w = world();
  await copyOf(w, "workspace-menu-at", { project: "/code/app", path: WT, overlay: "o9" });
  assert.deepEqual(w.overlays, [{
    mod: "projects", kind: "popup", width: 220, height: menuHeight(workspaceMenuItems({ path: WT, main: false })),
    props: { view: "workspace-menu", project: "/code/app", path: WT, sub: null },
  }]);
  assert.deepEqual(w.closed, ["o9"]);
});

test("workspace-menu-at with `only` (the Agents rows: Rename… and Delete…) opens just those, as tall as they take", async () => {
  const w = world();
  await copyOf(w, "workspace-menu-at", { project: "/code/app", path: WT, overlay: "o9", only: ["rename", "delete"] });
  const items = workspaceMenuItems({ path: WT, main: false }).filter((it) => it.id === "rename" || it.id === "delete");
  assert.equal(items.length, 2);
  assert.deepEqual(w.overlays, [{
    mod: "projects", kind: "popup", width: 220, height: menuHeight(items),
    props: { view: "workspace-menu", project: "/code/app", path: WT, sub: null, only: ["rename", "delete"] },
  }]);
  assert.ok(w.overlays[0].height < menuHeight(workspaceMenuItems({ path: WT, main: false })), "shorter than the whole menu");
  assert.deepEqual(w.closed, ["o9"]);
});

test("workspace-menu-at with the Agents rows' `only` (Sleep, Rename…, Delete…): a worktree gets the three, the main checkout Sleep alone", async () => {
  const w = world();
  const only = ["sleep", "rename", "delete"];
  await copyOf(w, "workspace-menu-at", { project: "/code/app", path: WT, overlay: "o9", only });
  await copyOf(w, "workspace-menu-at", { project: "/code/app", path: "/code/app", overlay: "o8", only });
  assert.deepEqual(w.overlays.map((o) => o.props.only), [only, only]);
  assert.deepEqual(menuOf("/code/app", WT, null, only).items.map((i) => i.id), only);
  assert.deepEqual(menuOf("/code/app", "/code/app", null, only).items.map((i) => i.id), ["sleep"]);
  assert.deepEqual(w.overlays.map((o) => o.height), [menuHeight(menuOf("/code/app", WT, null, only).items), menuHeight(menuOf("/code/app", "/code/app", null, only).items)]);
});

test("the menu's Sleep (T6): agent-sleep puts that workspace to sleep by its path, and the menu closes", async () => {
  const w = world();
  const c = await copyOf(w, "workspace-menu", { project: "/code/app", path: WT, overlay: "o5" });
  const sleep = menuOf("/code/app", WT).items[0];
  assert.equal(sleep.id, "sleep");
  assert.equal(sleep.disabled, undefined, "b, open on WT, isn't put away");
  c.view.choose(sleep, {});
  assert.deepEqual(w.runs, [[sleepCommand(WT), undefined]]);
  assert.deepEqual(w.closed, ["o5"]);
  assert.deepEqual(w.toasts, [], "agent-sleep says the rest (its confirm, its popup)");
});

test("the menu's Sleep is off, saying why, while every space on the workspace is put away, or none is open on it", async () => {
  const asleep = ordered(["a", "b", "ini", "c"], "a").map((s) => (s.id === "b" ? { ...s, tabs: s.tabs.map((t) => ({ ...t, settled: true })) } : s));
  world({ spaces: asleep });
  assert.deepEqual(menuOf("/code/app", WT).items[0], { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP, disabled: true, why: "Already asleep" });
  world({ panes: [term("a-t1", "/code/a"), view("ini-m"), term("c-t1", "/code/c")], spaces: ordered(["a", "ini", "c"], "a") });
  assert.deepEqual(menuOf("/code/app", WT).items[0], { id: "sleep", label: "Sleep", tooltip: SLEEP_TOOLTIP, disabled: true, why: "Nothing open to put to sleep" });
  const w = world();
  const c = await copyOf(w, "workspace-menu", { project: "/code/app", path: WT, overlay: "o5" });
  c.view.choose({ ...menuOf("/code/app", WT).items[0], disabled: true }, {});
  assert.deepEqual(w.runs, [], "a disabled Sleep runs nothing");
});

test("workspace-menu-at with no workspace closes itself and opens nothing; not an overlay (herdr-app check), it does nothing", async () => {
  const none = world();
  await copyOf(none, "workspace-menu-at", { project: "/code/app", path: null, overlay: "o9" });
  assert.deepEqual([none.overlays, none.closed], [[], ["o9"]]);
  const check = world();
  await copyOf(check, "workspace-menu-at", { project: "/code/app", path: WT });
  assert.deepEqual([check.overlays, check.closed], [[], []]);
});
