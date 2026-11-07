// The code-tabs bar's decisions, with no Herdr running: each file is its own tab
// in the bar with its Material icon (S5, S6), a preview in italics and a dot for
// unsaved changes (D11), one way to close a file (D18), and an Explorer button
// whose per-space memory keeps the panel open across spaces (S2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DOCS_KEY,
  LIVE_KEY,
  ICON_THEME,
  parseIconTheme,
  fileIcon,
  tabView,
  closeSlot,
  closeCommand,
  doubleClickCommand,
  enabledPanels,
  panelTabs,
  panelTabClick,
  barToggle,
  openPanel,
  closePanel,
  syncPanel,
} from "../code-editor/mods/code-tabs/tabs-model.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const plugin = (p) => join(repo, "code-editor", p);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const layout = () => readJson(join(repo, "projects-sidebar/layouts/projects.json"));
const icons = parseIconTheme(readFileSync(plugin(ICON_THEME), "utf8"));
const iconOf = (name) => fileIcon(name, icons);
const ICONS = "mods/code-explorer/icons";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function mods(node, out = []) {
  if (node?.content?.mod) out.push(node.content.mod);
  for (const child of node?.children ?? []) mods(child, out);
  return out;
}

// ── S2: the panel, its button and its memory ───────────────────────────────

test("S2: the Explorer is always on offer, whatever Herdr's welcome picked; Changes follows the person's pick", () => {
  assert.deepEqual(enabledPanels(undefined), ["explorer", "changes"], "nothing picked: both, like the stock bar");
  assert.deepEqual(enabledPanels(null), ["explorer", "changes"]);
  assert.deepEqual(enabledPanels([]), ["explorer"], "the welcome's first look leaves an empty list");
  assert.deepEqual(enabledPanels(["files"]), ["explorer"]);
  assert.deepEqual(enabledPanels(["files", "changes"]), ["explorer", "changes"]);
  assert.deepEqual(enabledPanels(["changes"]), ["explorer", "changes"]);
  assert.deepEqual(enabledPanels("nonsense"), ["explorer", "changes"]);
});

const panelState = (active) => ({ panel: { hidden: active === null }, body: { active: active ?? "explorer" } });
const sync = (memory, spaceId, active, at = 0, chosen = undefined) =>
  syncPanel(memory, { space: { id: spaceId }, ...panelState(active), enabled: enabledPanels(chosen), at });
const memoryWith = (panels = {}) => ({ panels, space: undefined, pending: null });
const SHOW_EXPLORER = [
  ["layout.select", { stack: "panel-body", child: "explorer" }],
  ["layout.show", { id: "panel" }],
];

test("S2: switching spaces and back brings an open Explorer back instead of closing it", () => {
  const memory = memoryWith();
  assert.deepEqual(sync(memory, "a", "explorer"), { commands: [], save: true });
  assert.equal(memory.panels.a, "explorer", "opened with cmd-l: remembered for this space");

  assert.deepEqual(sync(memory, "b", "explorer"), { commands: [["layout.hide", { id: "panel" }]], save: false }, "b never had one");
  sync(memory, "b", null);
  assert.equal(memory.panels.b, null);

  assert.deepEqual(sync(memory, "a", null), { commands: SHOW_EXPLORER, save: false });
  assert.deepEqual(sync(memory, "a", "explorer"), { commands: [], save: false }, "the restore landed");
  assert.equal(memory.panels.a, "explorer");
});

test("S2: the memory holds with Herdr's welcome having left an empty panel list", () => {
  const memory = memoryWith({ a: "explorer", b: null });
  sync(memory, "b", null, 0, []);
  assert.deepEqual(sync(memory, "a", null, 0, []), { commands: SHOW_EXPLORER, save: false });
});

test("S2: closing the panel with cmd-l is remembered, and the space comes back closed", () => {
  const memory = memoryWith({ a: "explorer", b: null });
  sync(memory, "a", "explorer");
  assert.deepEqual(sync(memory, "a", null), { commands: [], save: true });
  assert.equal(memory.panels.a, null);
  sync(memory, "b", null);
  assert.deepEqual(sync(memory, "a", null), { commands: [], save: false });
});

test("stock behavior kept: Changes is remembered per space like the Explorer", () => {
  const memory = memoryWith({ a: "changes", b: null });
  sync(memory, "b", null);
  assert.deepEqual(sync(memory, "a", null), {
    commands: [["layout.select", { stack: "panel-body", child: "changes" }], ["layout.show", { id: "panel" }]],
    save: false,
  });
});

test("stock behavior kept: a space never seen, at the very first draw, keeps the panel as it is", () => {
  const memory = memoryWith();
  assert.deepEqual(sync(memory, "a", null), { commands: [], save: true });
  assert.equal(memory.panels.a, null);
});

test("stock behavior kept: until a restore lands or a second passes, the old state isn't taken for a choice", () => {
  const memory = memoryWith({ a: "explorer", b: null });
  sync(memory, "b", null, 0);
  sync(memory, "a", null, 0);
  assert.deepEqual(sync(memory, "a", null, 500), { commands: [], save: false });
  assert.equal(memory.panels.a, "explorer");
  assert.deepEqual(sync(memory, "a", null, 1000), { commands: [], save: true }, "something else won");
  assert.equal(memory.panels.a, null);
});

test("stock behavior kept: a stored panel that is no longer on offer closes, and a layout without a panel asks nothing", () => {
  const memory = memoryWith({ a: "files", b: null });
  sync(memory, "b", null);
  assert.deepEqual(sync(memory, "a", null), { commands: [], save: true }, "files is gone: closed is what it wants");
  const none = memoryWith();
  assert.deepEqual(syncPanel(none, { space: { id: "a" }, panel: null, body: null, enabled: ["explorer"], at: 0 }), { commands: [], save: false });
  assert.deepEqual(syncPanel(none, { space: null, panel: {}, body: {}, enabled: ["explorer"], at: 0 }), { commands: [], save: false });
  assert.equal(none.space, undefined);
});

test("S2: the panel's own header offers Explorer, then Changes when picked, as icons like Orca's", () => {
  const both = panelTabs(["explorer", "changes"]);
  assert.deepEqual(both.map((b) => b.id), ["explorer", "changes"]);
  assert.deepEqual(both.map((b) => b.label), ["Explorer", "Changes"]);
  assert.equal(both[0].icon, "mods/code-tabs/files.svg");
  assert.ok(existsSync(plugin(both[0].icon)));
  assert.equal(both[1].icon, "mods/changes/changes.svg", "Herdr's own");
  assert.deepEqual(panelTabs(["explorer"]).map((b) => b.id), ["explorer"]);
});

test("S2: a header icon selects its child, and the header's toggle closes the panel", () => {
  assert.deepEqual(panelTabClick("changes"), [["layout.select", { stack: "panel-body", child: "changes" }]]);
  assert.deepEqual(panelTabClick("explorer"), [["layout.select", { stack: "panel-body", child: "explorer" }]]);
  assert.deepEqual(closePanel(), [["layout.hide", { id: "panel" }]]);
});

test("S2: the bar's toggle shows only while the panel is closed, and opens it on the child it had", () => {
  assert.equal(barToggle({ hidden: false }), null, "open: the toggle is in the panel's header");
  assert.equal(barToggle(null), null, "a layout with no panel");
  assert.deepEqual(barToggle({ hidden: true }), { id: "panel-open", icon: "mods/code-tabs/panel.svg" });
  assert.ok(existsSync(plugin("mods/code-tabs/panel.svg")));
  const showChanges = [["layout.select", { stack: "panel-body", child: "changes" }], ["layout.show", { id: "panel" }]];
  assert.deepEqual(openPanel({ active: "changes" }, ["explorer", "changes"]), showChanges);
  assert.deepEqual(openPanel({ active: "changes" }, ["explorer"]), SHOW_EXPLORER, "Changes not on offer");
  assert.deepEqual(openPanel(null, ["explorer"]), SHOW_EXPLORER);
});

test("S2: the bar, the header and cmd-l act on the same panel, and every icon the header offers is a child of its stack", () => {
  const panel = find(layout(), "panel");
  const keys = readJson(plugin("keys.json"));
  assert.equal(keys["layout:projects"]["cmd-l"], `layout.toggle:${panel.id}`);
  assert.deepEqual(closePanel(), [["layout.hide", { id: panel.id }]]);
  assert.deepEqual(openPanel(null, ["explorer"]).at(-1), ["layout.show", { id: panel.id }]);
  const children = find(layout(), "panel-body").children.map((c) => c.id);
  for (const id of enabledPanels(undefined)) assert.ok(children.includes(id), id);
});

test("S2: the panel runs the window's full height beside the tabs and terminals, as in Orca, its header drawn by code-tabs in line with the tab bar", () => {
  const row = find(layout(), "work-row");
  assert.deepEqual(row.children.map((c) => c.id), ["work", "panel"], "the tab bar ends where the terminals do");
  assert.deepEqual(row.divider, { width: 1, color: "border" });
  const panel = find(layout(), "panel");
  assert.deepEqual(panel.children.map((c) => c.id), ["panel-header", "panel-body"]);
  assert.equal(panel.background, "chrome");
  assert.equal(panel.radius, undefined, "flush with the window's edges: no card of its own");
  assert.equal(panel.padding, undefined);
  const header = find(layout(), "panel-header");
  assert.deepEqual(header.content, { mod: "code-tabs", props: { view: "panel" } });
  assert.equal(header.size.px, find(layout(), "tabs").size.px, "its bottom line continues the tab bar's");
});

test("S2: the projects layout's tab bar is code-tabs, in the block it always had", () => {
  assert.deepEqual(find(layout(), "tabs").content, { mod: "code-tabs" });
  assert.ok(!mods(layout()).includes("tabs"), "no copy of the stock bar: it would forget the Explorer");
  assert.equal(find(layout(), "tabs").size.px, 42);
  assert.equal(find(layout(), "tabs").window_drag, true);
});

test("D1: the copy docks nowhere on its own, says where it came from, and keeps Herdr's license and window icons", () => {
  const dir = plugin("mods/code-tabs");
  assert.deepEqual(readJson(join(dir, "mod.json")), { place: "none", title: "Tabs", cloned_from: { name: "tabs", version: "0.1.13" } });
  assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /Apache License/);
  assert.equal(readFileSync(join(dir, "LICENSE"), "utf8"), readFileSync(join(repo, "projects-sidebar/mods/projects-agents/LICENSE"), "utf8"));
  const main = readFileSync(join(dir, "main.js"), "utf8");
  assert.match(main, /export default class \w+ extends View/);
  assert.match(main, /Apache License 2\.0/);
  for (const icon of ["win-min", "win-max", "win-restore", "win-close", "plus"]) assert.ok(existsSync(join(dir, `${icon}.svg`)), icon);
  assert.ok(!/mods\/tabs\//.test(main), "its assets are its own, as mod.clone leaves them");
});

// ── S5: Material icons ─────────────────────────────────────────────────────

test("S5: a file's icon is by exact name first, then by its longest suffix (D6)", () => {
  assert.equal(iconOf("package.json"), `${ICONS}/nodejs.svg`);
  assert.equal(iconOf("main.ts"), `${ICONS}/typescript.svg`);
  assert.equal(iconOf("types.d.ts"), `${ICONS}/typescript-def.svg`);
  assert.equal(iconOf("a.test.ts"), `${ICONS}/test-ts.svg`);
  assert.equal(iconOf("x.y.test.tsx"), `${ICONS}/test-jsx.svg`);
  assert.equal(iconOf(".npmrc"), `${ICONS}/npm.svg`);
});

test("S5: case doesn't matter in the name or in the suffix", () => {
  assert.equal(iconOf("PACKAGE.JSON"), `${ICONS}/nodejs.svg`);
  assert.equal(iconOf("Main.TS"), `${ICONS}/typescript.svg`);
});

test("S5: anything the table doesn't know gets the plain file icon, inherited object keys included", () => {
  for (const name of ["notes.unknownext", "LICENSE.nope", "noextension", "trailing.", "constructor", "x.constructor", "__proto__", "x.toString", ""]) {
    assert.equal(iconOf(name), `${ICONS}/file.svg`, name);
  }
});

test("S5: every icon the table names exists under the path the bar draws", () => {
  for (const table of [icons.fileNames, icons.fileExtensions]) {
    for (const rel of new Set(Object.values(table))) {
      assert.ok(existsSync(plugin(`mods/code-explorer/${rel}`)), rel);
    }
  }
  assert.ok(iconOf("x.js").startsWith("mods/code-explorer/"), "image() paths start at Herdr's home");
  assert.equal(ICON_THEME, "mods/code-explorer/icons/theme.json");
});

test("S5: with the table missing or broken, a file tab still draws the plain file icon", () => {
  for (const text of [null, "", "{ not json", "[1,2", "3", '"x"']) {
    const parsed = parseIconTheme(text);
    assert.equal(parsed, null, String(text));
    assert.equal(fileIcon("main.ts", parsed), `${ICONS}/file.svg`);
  }
  assert.equal(fileIcon("main.ts", {}), `${ICONS}/file.svg`);
});

// ── S6: one tab per file ───────────────────────────────────────────────────

const filePane = (tab, pane = `p-${tab}`) => ({ pane, mod: "code-file", tab, title: "code-file", focused: false, zoomed: false });
const termPane = (tab, program = { name: "zsh", icon: "icons/zsh.svg", tint: true, agent: false }) => ({ pane: `t-${tab}`, terminal: "t1", tab, program });
const docs = {
  tb2: { doc: "d2", file: "/repo/src/model.js", preview: false },
  tb3: { doc: "d3", file: "/repo/package.json", preview: true },
};
const world = (over = {}) => ({ docs, live: {}, panes: [filePane("tb2"), filePane("tb3"), termPane("tb1")], icons, ...over });
const tab = (id, name, over = {}) => ({ id, name, active: false, panes: 1, zoomed: false, status: null, ...over });

test("S6: the shared keys are the two D10 names, one written by the Explorer, one by the file", () => {
  assert.equal(DOCS_KEY, "code-editor.docs");
  assert.equal(LIVE_KEY, "code-editor.live");
});

test("S6: a file's tab carries its doc, its name and its own icon, one per file", () => {
  const model = tabView(tab("tb2", "model.js"), world());
  assert.equal(model.doc, "d2");
  assert.equal(model.name, "model.js");
  assert.equal(model.icon, `${ICONS}/javascript.svg`);
  const pkg = tabView(tab("tb3", "package.json"), world());
  assert.equal(pkg.doc, "d3");
  assert.equal(pkg.icon, `${ICONS}/nodejs.svg`);
});

test("S6: the icon follows the file's name, and a tab renamed by hand keeps the file's icon and the new name", () => {
  const view = tabView(tab("tb2", "my notes"), world());
  assert.equal(view.name, "my notes");
  assert.equal(view.icon, `${ICONS}/javascript.svg`);
});

test("D11: a preview tab's name is in italics until the file says it is pinned", () => {
  assert.equal(tabView(tab("tb3", "package.json"), world()).preview, true);
  assert.equal(tabView(tab("tb2", "model.js"), world()).preview, false);
  const pinned = world({ live: { d3: { dirty: false, pinned: true } } });
  assert.equal(tabView(tab("tb3", "package.json"), pinned).preview, false);
});

test("D18: dirty comes from the file's own entry, per doc", () => {
  const live = { d2: { dirty: true, pinned: true }, d3: { dirty: false, pinned: false } };
  assert.equal(tabView(tab("tb2", "model.js"), world({ live })).dirty, true);
  assert.equal(tabView(tab("tb3", "package.json"), world({ live })).dirty, false);
  assert.equal(tabView(tab("tb2", "model.js"), world({ live: undefined })).dirty, false, "before the file has written anything");
  assert.equal(tabView(tab("tb2", "model.js"), world({ docs: undefined })).doc, null, "before the Explorer has written anything");
});

test("D10: an entry left in docs doesn't make a tab a file unless a code-file pane is in it", () => {
  // tab tb2 had a shell split in beside the file and the file was closed: only the terminal is left.
  const left = world({ panes: [termPane("tb2")] });
  const view = tabView(tab("tb2", "model.js"), left);
  assert.equal(view.doc, null);
  assert.equal(view.icon, null);
  assert.equal(view.preview, false);
  assert.deepEqual(closeCommand(tab("tb2", "model.js"), view), ["tab.close", { id: "tb2" }], "its X still closes it");
});

test("S6: a file named like a tab number keeps its own name; the terminal rule is for terminals", () => {
  const view = tabView(tab("tb7", "tb1"), world({ docs: { tb7: { doc: "d7", file: "/repo/tb1", preview: false } }, panes: [filePane("tb7")] }));
  assert.equal(view.name, "tb1");
});

test("stock behavior kept: a terminal tab has no doc, its program's name when nobody named it, and its given name otherwise", () => {
  const panes = [termPane("tb1"), termPane("tb9", undefined)];
  const plain = tabView(tab("tb1", "tb1"), world({ panes }));
  assert.deepEqual(
    { doc: plain.doc, name: plain.name, preview: plain.preview, dirty: plain.dirty, icon: plain.icon, program: plain.program?.name },
    { doc: null, name: "zsh", preview: false, dirty: false, icon: null, program: "zsh" },
  );
  assert.equal(tabView(tab("tb1", "fix login"), world({ panes })).name, "fix login");
  assert.equal(tabView(tab("tb8", "tb8"), world({ panes: [] })).name, "Terminal");
});

test("stock behavior kept: the agent in a split tab gives the tab its program", () => {
  const claude = { name: "Claude Code", icon: "icons/claude.svg", tint: false, agent: true };
  const panes = [termPane("tb1"), { ...termPane("tb1", claude), pane: "t-2" }];
  assert.equal(tabView(tab("tb1", "tb1"), world({ panes })).program.name, "Claude Code");
});

test("D18: only the active tab has an X; a dirty tab shows the dot in its place, and only the active one's dot closes", () => {
  assert.deepEqual(closeSlot(true, false), { dot: false, closes: true });
  assert.deepEqual(closeSlot(true, true), { dot: true, closes: true });
  assert.deepEqual(closeSlot(false, true), { dot: true, closes: false });
  assert.equal(closeSlot(false, false), null);
});

test("D18: the X on a file tab always asks that file, clean or dirty; one way to close", () => {
  const clean = tabView(tab("tb2", "model.js"), world());
  const dirty = tabView(tab("tb2", "model.js"), world({ live: { d2: { dirty: true } } }));
  assert.deepEqual(closeCommand(tab("tb2", "model.js"), clean), ["code-file.ask-close-d2"]);
  assert.deepEqual(closeCommand(tab("tb2", "model.js"), dirty), ["code-file.ask-close-d2"]);
  const split = tab("tb2", "model.js", { panes: 2 });
  const beside = tabView(split, world({ panes: [filePane("tb2"), termPane("tb2")] }));
  assert.deepEqual(closeCommand(split, beside), ["code-file.ask-close-d2"], "code-file knows not to kill the terminal beside it");
});

test("D18: any other tab closes with tab.close {id}, never confirmed: the last tab of a space still asks", () => {
  const term = tab("tb1", "tb1");
  assert.deepEqual(closeCommand(term, tabView(term, world())), ["tab.close", { id: "tb1" }]);
});

test("D11: a double click pins a preview through its file; a pinned file has nothing to do; a terminal tab still renames", () => {
  const preview = tab("tb3", "package.json");
  assert.deepEqual(doubleClickCommand(preview, tabView(preview, world())), ["code-file.pin-d3"]);
  const fixed = tab("tb2", "model.js");
  assert.equal(doubleClickCommand(fixed, tabView(fixed, world())), null);
  const term = tab("tb1", "tb1");
  assert.deepEqual(doubleClickCommand(term, tabView(term, world())), ["tab.rename", { id: "tb1" }]);
});
