// Spotlight T19 (its D30): workspace menu items from other plugins. P's
// menus-model.js reads what plugins publish under the fixed keys in config.js
// MENU_KEYS: each key is { [workspacePath]: [item] }, an item { id, text,
// icon?, danger?, disabled?, why?, checked?, action?, items? } with one
// submenu level. The workspace menu draws P's own items, a separator, then
// each plugin's, and runs an item's action with the menu open. Actions use
// the badge validators (badges-model.js). The contract other plugins consume
// is RECIPE.md "Menu items from other plugins".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU_KEYS } from "../projects-sidebar/mods/projects/config.js";
import {
  parseMenus, workspaceMenuList, subMenuOf, menuChoice, menuRowKey, menuHeight, MENU_ROW, MENU_SEP,
} from "../projects-sidebar/mods/projects/menus-model.js";
import { workspaceMenuItems } from "../projects-sidebar/mods/projects/tree-model.js";

const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");

const W = "/Users/demo/orca/workspaces/app/login";
const BIN = "/Users/demo/.config/herdr-app/mods/spotlight/bin/spotlight";
const ICON = "mods/spotlight/icons/flashlight.svg";
const KEY = "menus.spotlight";
const run = (...args) => ({ exec: [BIN, ...args] });

// Spotlight's own menu on an eligible workspace (its T23), as published.
const TOGGLE = { id: "toggle", text: "Proyectar este workspace", icon: ICON, action: run("toggle", "--workspace", W) };
const ENV = {
  id: "env",
  text: "Entorno de Spotlight",
  items: [
    { id: "env-local", text: "Local", checked: true, action: run("env", "--workspace", W, "--env", "local") },
    { id: "env-dev", text: "Dev", action: run("env", "--workspace", W, "--env", "dev") },
    { id: "env-prod", text: "Prod", disabled: true, why: "Sin comando para Prod" },
  ],
};

// The items one spotlight value gives "/w", or [] when none.
const on = (items, key = KEY) => parseMenus([{ "/w": items }], [key])["/w"] ?? [];
// The one item a lone spotlight value gives "/w", or null when dropped.
const one = (item) => on([item])[0] ?? null;

test("MENU_KEYS is the fixed list, and store.menus reads it through parseMenus, never writing", () => {
  assert.deepEqual(MENU_KEYS, ["menus.spotlight"]);
  assert.ok(Object.isFrozen(MENU_KEYS));
  const store = src("store.js");
  assert.match(store, /import \{[^}]*\bMENU_KEYS\b[^}]*\} from "\.\/config\.js"/);
  assert.match(store, /import \{[^}]*\bparseMenus\b[^}]*\} from "\.\/menus-model\.js"/);
  assert.match(store, /export const menus = \(\) => parseMenus\(MENU_KEYS\.map\(\(k\) => shared\(k\)\)\);/);
  assert.doesNotMatch(store, /setShared\([^)]*MENU/, "menu keys are other plugins' to write");
});

test("valid items parse: text becomes the label, each keeps its key; one submenu level with radio marks", () => {
  const got = parseMenus([{ [W]: [TOGGLE, ENV, { id: "sync", text: "Forzar sync", danger: true, action: { command: "spotlight.sync" } }] }]);
  const item = (rest) => ({ key: KEY, ...rest });
  assert.deepEqual(got, {
    [W]: [
      item({ id: "toggle", label: "Proyectar este workspace", icon: ICON, action: TOGGLE.action }),
      item({
        id: "env",
        label: "Entorno de Spotlight",
        items: [
          item({ id: "env-local", label: "Local", checked: true, action: ENV.items[0].action }),
          item({ id: "env-dev", label: "Dev", action: ENV.items[1].action }),
          item({ id: "env-prod", label: "Prod", disabled: true, why: "Sin comando para Prod" }),
        ],
      }),
      item({ id: "sync", label: "Forzar sync", danger: true, action: { command: "spotlight.sync" } }),
    ],
  });
  // A parsed item never has `text`: in the menu, `text` is what Copy puts on
  // the clipboard (tree-model.js workspaceMenuItems).
  assert.ok(Object.values(got).flat().every((it) => !Object.hasOwn(it, "text") && (it.items ?? []).every((s) => !Object.hasOwn(s, "text"))));

  // Read in MENU_KEYS order; a value that isn't a plain object is no items.
  for (const value of [null, undefined, 7, "x", JSON.stringify({ [W]: [TOGGLE] }), [{ [W]: [TOGGLE] }]]) {
    assert.deepEqual(parseMenus([value]), {}, JSON.stringify(value));
  }
  assert.deepEqual(parseMenus(undefined), {});
  // Keys are absolute workspace paths, spelled as `git worktree list` prints
  // them (a trailing slash is ignored); any other key, a parsed `__proto__`
  // or a lane key included, is ignored. A path whose value isn't a list has none.
  const foreign = JSON.parse(`{"__proto__": [{"id": "a", "text": "p"}], "rel/x": [{"id": "a", "text": "r"}], "g1/task:AX-1": [{"id": "a", "text": "l"}], "/ok/": [{"id": "a", "text": "k"}], "/no": {"id": "a", "text": "n"}}`);
  const kept = parseMenus([foreign]);
  assert.deepEqual(Object.keys(kept), ["/ok"]);
  assert.equal(Object.getPrototypeOf(kept), Object.prototype);
});

test("a bad field drops alone, the item stays", () => {
  const base = { id: "x", text: "Item" };
  const plain = { key: KEY, id: "x", label: "Item" };
  for (const [field, value] of [
    ["icon", "mods/s/../x.svg"], ["icon", "icons/x.svg"], ["icon", 5],
    ["danger", "yes"], ["danger", 1], ["danger", false],
    ["disabled", "true"], ["disabled", false],
    ["checked", 1], ["checked", "true"], ["checked", false],
    ["why", "not disabled, so no why"],
    ["action", { command: "spotlight.x", exec: ["/usr/bin/true"] }], ["action", { exec: ["./spotlight"] }], ["action", "spotlight.x"], ["action", {}],
    ["items", "Local"], ["items", {}], ["items", []], ["items", [{ text: "no id" }, 5]],
    ["color", "#f00"], ["onClick", "rm -rf /"],
  ]) {
    assert.deepEqual(one({ ...base, [field]: value }), plain, `${field}: ${JSON.stringify(value)}`);
  }
  // A disabled item's `why` must be a non-blank string: any other drops alone.
  for (const why of [5, null, " \n ", ["x"]]) {
    assert.deepEqual(one({ ...base, disabled: true, why }), { ...plain, disabled: true }, JSON.stringify(why));
  }
  // Text: one line (runs of whitespace as one space), cut at 40 code points.
  assert.equal(one({ id: "x", text: "  Entorno\n de \t Spotlight " }).label, "Entorno de Spotlight");
  assert.equal(one({ id: "x", text: "é".repeat(50) }).label, "é".repeat(40));
  assert.equal([...one({ id: "x", text: "🔦".repeat(41) }).label].length, 40, "code points, not UTF-16 units");
  assert.equal(one({ id: "x", text: "x".repeat(40) }).label, "x".repeat(40));
  // why: one line, cut at 200 code points.
  assert.equal(one({ ...base, disabled: true, why: " Sincronizando…\n" }).why, "Sincronizando…");
  assert.equal([...one({ ...base, disabled: true, why: "w".repeat(250) }).why].length, 200);
  // tooltip: on any item, one line, cut at 200 code points; anything else drops alone.
  assert.deepEqual(one({ ...base, tooltip: " Close all active panels\n in this workspace " }), { ...plain, tooltip: "Close all active panels in this workspace" });
  assert.deepEqual(one({ ...base, disabled: true, why: "Off", tooltip: "Tip" }), { ...plain, disabled: true, why: "Off", tooltip: "Tip" });
  assert.equal([...one({ ...base, tooltip: "t".repeat(250) }).tooltip].length, 200);
  for (const tooltip of [5, null, " \n ", ["x"]]) {
    assert.deepEqual(one({ ...base, tooltip }), plain, `tooltip: ${JSON.stringify(tooltip)}`);
  }

  // A submenu parent opens its submenu: its action and radio mark drop.
  assert.deepEqual(
    one({ id: "env", text: "Entorno", checked: true, action: run("env"), items: [{ id: "a", text: "A" }] }),
    { key: KEY, id: "env", label: "Entorno", items: [{ key: KEY, id: "a", label: "A" }] },
  );
});

test("a bad item drops whole: not an object, no valid id or text, a repeated id; the rest stay in order", () => {
  for (const item of [
    null, 5, "toggle", [TOGGLE],
    { text: "no id" }, { id: "", text: "x" }, { id: 5, text: "x" }, { id: "has space", text: "x" }, { id: "-x", text: "x" },
    { id: "x".repeat(65), text: "x" }, { id: "a/b", text: "x" },
    { id: "x" }, { id: "x", text: "" }, { id: "x", text: " \n\t " }, { id: "x", text: 5 },
  ]) {
    assert.equal(one(item), null, JSON.stringify(item));
  }
  // Ids: letters, digits, `.`, `_`, `:` and `-`, 64 at most, starting with a letter or digit.
  for (const id of ["toggle", "env-local", "Env_2", "a.b:c", "x".repeat(64)]) assert.equal(one({ id, text: "t" })?.id, id, id);

  // A repeated id names one row: the later one goes, at either level.
  assert.deepEqual(on([{ id: "a", text: "A" }, { id: "a", text: "B" }, { id: "b", text: "C" }]).map((i) => i.label), ["A", "C"]);
  const sub = one({ id: "env", text: "Env", items: [{ id: "a", text: "A" }, { id: "a", text: "B" }] });
  assert.deepEqual(sub.items.map((i) => i.label), ["A"]);
  // Holes don't move the rest.
  assert.deepEqual(on([5, { id: "a", text: "A" }, { text: "x" }, { id: "b", text: "B" }]).map((i) => i.id), ["a", "b"]);
});

test("caps: 8 items per plugin and 6 per submenu; dropped items don't count; two spellings of a path share the 8", () => {
  const n = (count, p = "i") => Array.from({ length: count }, (_, i) => ({ id: `${p}${i}`, text: `${p}${i}` }));
  assert.deepEqual(on(n(10)).map((i) => i.id), n(8).map((i) => i.id));
  assert.deepEqual(on([{}, 5, ...n(9)]).map((i) => i.id), n(8).map((i) => i.id), "holes don't take a place");
  const sub = one({ id: "env", text: "Env", items: [{ text: "bad" }, ...n(8, "s")] });
  assert.deepEqual(sub.items.map((i) => i.id), n(6, "s").map((i) => i.id));
  const both = parseMenus([{ "/w": n(5, "a"), "/w/": n(5, "b") }])["/w"];
  assert.deepEqual(both.map((i) => i.id), [...n(5, "a"), ...n(3, "b")].map((i) => i.id));
});

test("`items` deeper than one level drop; the submenu item stays", () => {
  const deep = one({
    id: "env",
    text: "Entorno",
    items: [{ id: "more", text: "Más", items: [{ id: "x", text: "X" }], action: run("x") }],
  });
  assert.deepEqual(deep.items, [{ key: KEY, id: "more", label: "Más", action: run("x") }]);
  assert.equal(Object.hasOwn(deep.items[0], "items"), false);
});

test("actions use the badge validators: a command of menus.spotlight must be spotlight's own; exec as argv", () => {
  const act = (action, key = KEY) => on([{ id: "x", text: "x", action }], key)[0]?.action ?? null;
  for (const command of ["spotlight.toggle", "spotlight.env.local", "spotlight.b.c-d"]) {
    assert.deepEqual(act({ command }), { command }, command);
  }
  // Another plugin's, P's own and Herdr's commands drop the action; the item stays.
  for (const command of ["projects.new-workspace", "pr.open", "app.quit", "window.close", "spotlights.toggle", "Spotlight.toggle", "spotlight."]) {
    assert.equal(act({ command }), null, command);
    assert.deepEqual(on([{ id: "x", text: "x", action: { command } }]), [{ key: KEY, id: "x", label: "x" }], `${command}: the item stays`);
  }
  // A breaking change's new key (menus.spotlight.v2) is still spotlight's.
  assert.deepEqual(act({ command: "spotlight.toggle" }, "menus.spotlight.v2"), { command: "spotlight.toggle" });
  // A value past the end of the list names no publisher: no command runs.
  assert.equal(parseMenus([{ "/w": [{ id: "x", text: "x", action: { command: "spotlight.x" } }] }], [])["/w"][0].action, undefined);
  // exec: 1–20 strings, no NUL, a bare or absolute program; never a relative one.
  assert.deepEqual(act(run("toggle", "--workspace", W)), run("toggle", "--workspace", W));
  assert.deepEqual(act({ exec: ["spotlight", "toggle"] }), { exec: ["spotlight", "toggle"] });
  for (const exec of [[], ["./spotlight"], ["bin/spotlight"], ["x\0"], ["prog", 5], "spotlight", Array(21).fill("a")]) {
    assert.equal(act({ exec }), null, JSON.stringify(exec));
  }
  // The same rules inside a submenu.
  const sub = one({ id: "env", text: "Env", items: [{ id: "a", text: "A", action: { command: "pr.open" } }, { id: "b", text: "B", action: { command: "spotlight.b" } }] });
  assert.deepEqual(sub.items.map((i) => i.action ?? null), [null, { command: "spotlight.b" }]);
});

test("disabled items carry their why; an enabled one has none", () => {
  const busy = one({ ...TOGGLE, disabled: true, why: "Sincronizando…" });
  assert.equal(busy.disabled, true);
  assert.equal(busy.why, "Sincronizando…");
  assert.deepEqual(busy.action, TOGGLE.action, "its action stays: the menu just doesn't run it");
  assert.equal(Object.hasOwn(one({ ...TOGGLE, why: "Sincronizando…" }), "why"), false);
  assert.deepEqual(one({ ...TOGGLE, disabled: true }), { key: KEY, id: "toggle", label: TOGGLE.text, icon: ICON, action: TOGGLE.action, disabled: true });
});

test("the merged list: P's own items, a separator, then each plugin's; no separator when no plugin publishes", () => {
  const own = workspaceMenuItems({ path: W, branch: "login", main: false });
  const plugin = parseMenus([{ [W]: [TOGGLE, ENV] }])[W];
  const list = workspaceMenuList(own, plugin);
  assert.deepEqual(list.map((i) => i.id), ["sleep", "copy-path", "copy-name", "rename", "delete", "toggle", "env"]);
  assert.deepEqual(list.slice(0, own.length), own, "P's own items, as they were");
  assert.equal(list[own.length].separator, true, "a separator before the plugin's");
  assert.equal(Object.hasOwn(list[own.length + 1], "separator"), false, "one separator per plugin");
  assert.equal(Object.hasOwn(plugin[0], "separator"), false, "the parsed items stay as they were");

  // No plugin publishes for this workspace: P's own list, unchanged.
  assert.deepEqual(workspaceMenuList(own, []), own);
  assert.deepEqual(workspaceMenuList(own, undefined), own);
  // The main checkout's own list has no separator; the plugin's still gets one.
  const main = workspaceMenuItems({ path: "/code/app", branch: "main", main: true });
  assert.deepEqual(workspaceMenuList(main, plugin).map((i) => Boolean(i.separator)), [false, false, false, true, false]);

  // Two plugins: each plugin's items start with a separator, in key order.
  const two = parseMenus([{ [W]: [{ id: "a", text: "A" }] }, { [W]: [{ id: "b", text: "B" }, { id: "c", text: "C" }] }], ["menus.spotlight", "menus.pr"])[W];
  assert.deepEqual(workspaceMenuList(own, two).slice(own.length).map((i) => `${i.key}:${i.id}:${Boolean(i.separator)}`), [
    "menus.spotlight:a:true", "menus.pr:b:true", "menus.pr:c:false",
  ]);
});

test("the popup's height follows the item count: rows, separators and the title fit", () => {
  const own = workspaceMenuItems({ path: W, branch: "login", main: false });
  const plugin = parseMenus([{ [W]: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, text: `Item ${i}` })) }])[W];
  const heights = [0, 1, 2, 4, 8].map((n) => menuHeight(workspaceMenuList(own, plugin.slice(0, n))));
  for (let i = 1; i < heights.length; i++) assert.ok(heights[i] > heights[i - 1], `${heights}`);
  // Each row adds a row; a separator adds its own room.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, label: "r" }));
  assert.equal(menuHeight(rows(3)) - menuHeight(rows(2)), MENU_ROW);
  assert.equal(menuHeight([...rows(2), { id: "s", label: "s", separator: true }]) - menuHeight(rows(3)), MENU_SEP);
  // Room for every row and separator, plus the title.
  const full = workspaceMenuList(own, plugin);
  assert.ok(menuHeight(full) >= full.length * MENU_ROW + full.filter((i) => i.separator).length * MENU_SEP + 30);
  // An empty menu still has room for its title and its one line.
  assert.ok(menuHeight([]) >= 60);
});

test("subMenuOf: the parent a submenu opens from, looked up by key and id; null once it's gone", () => {
  const plugin = parseMenus([{ [W]: [TOGGLE, ENV] }])[W];
  const parent = subMenuOf(plugin, { key: KEY, id: "env" });
  assert.equal(parent.label, "Entorno de Spotlight");
  assert.deepEqual(parent.items.map((i) => i.id), ["env-local", "env-dev", "env-prod"]);
  assert.equal(subMenuOf(plugin, { key: KEY, id: "toggle" }), null, "not a submenu");
  assert.equal(subMenuOf(plugin, { key: "menus.pr", id: "env" }), null, "another plugin's");
  assert.equal(subMenuOf(plugin, { key: KEY, id: "gone" }), null);
  assert.equal(subMenuOf([], { key: KEY, id: "env" }), null);
  assert.equal(subMenuOf(plugin, null), null);
});

test("menuChoice: what a click does; a plugin's item never runs P's own (an id `delete` is not Delete…)", () => {
  const own = workspaceMenuItems({ path: W, branch: "login", main: false });
  assert.deepEqual(own.map((i) => menuChoice(i)), own.map((i) => ({ own: i })));
  const plugin = parseMenus([{ [W]: [
    TOGGLE, ENV,
    { id: "delete", text: "Apagar", action: run("toggle", "--workspace", W) },
    { id: "rename", text: "Cmd", action: { command: "spotlight.rename" } },
    { id: "busy", text: "Busy", disabled: true, why: "Sincronizando…", action: run("x") },
    { id: "label", text: "Only a label" },
  ] }])[W];
  const [toggle, env, del, ren, busy, label] = plugin;
  assert.deepEqual(menuChoice(toggle), { exec: TOGGLE.action.exec });
  assert.deepEqual(menuChoice(env), { submenu: { key: KEY, id: "env" } });
  assert.deepEqual(menuChoice(del), { exec: run("toggle", "--workspace", W).exec });
  assert.deepEqual(menuChoice(ren), { command: "spotlight.rename" });
  assert.equal(menuChoice(busy), null, "disabled: nothing runs");
  assert.equal(menuChoice(label), null, "no action and no submenu: nothing runs");
  assert.equal(menuChoice(env.items[0]) && menuChoice(env.items[0]).exec[0], BIN, "a submenu item runs its own action");
  assert.equal(menuChoice(env.items[2]), null);
  assert.equal(menuChoice(null), null);

  // A row's identity in the open menu (the one running shows "…"): P's id,
  // or the plugin's key and id, so a plugin's `delete` is another row.
  assert.notEqual(menuRowKey(del), menuRowKey(own.at(-1)));
  assert.equal(menuRowKey(own.at(-1)), "delete");
  assert.notEqual(menuRowKey(env.items[0]), menuRowKey({ ...env.items[0], key: "menus.pr" }));
});

test("workspace-menu.js draws the merged list, opens the submenu at the pointer and runs an action with the menu open", () => {
  const menu = src("workspace-menu.js");
  const body = (name) => {
    const start = menu.indexOf(`  ${name}(`);
    assert.ok(start >= 0, `workspace-menu.js has ${name}`);
    return menu.slice(start, menu.indexOf("\n  }\n", start));
  };
  // The popup is as tall as the list it will draw, at the pointer (a popup's default).
  const open = menu.slice(menu.indexOf("export function openWorkspaceMenu("), menu.indexOf("\n}\n", menu.indexOf("export function openWorkspaceMenu(")));
  assert.match(open, /height: menuHeight\(/);
  assert.doesNotMatch(open, /height: 200/);
  assert.match(open, /props: \{ view: "workspace-menu", project, path, sub, \.\.\.\(only \? \{ only \} : \{\}\) \}/);
  // P's own items, then the plugins' (store.menus, by the row's path); the
  // opener and the view build the list in one place, so the height fits it.
  const of = menu.slice(menu.indexOf("function menuOf("), menu.indexOf("\n}\n", menu.indexOf("function menuOf(")));
  assert.match(of, /store\.menus\(\)\[normPath\(path\)\]/);
  assert.match(of, /workspaceMenuList\(workspaceMenuItems\(row, sleepOf\(row\)\), plugin\)/);
  assert.match(of, /subMenuOf\(plugin, sub\)/);
  assert.match(open, /menuOf\(project, path, sub, only\)/);
  assert.match(body("render"), /menuOf\(this\.project, this\.path, this\.sub, this\.only\)/);

  // A click goes through menuChoice: P's own by id, a submenu reopened at
  // the pointer, a command run, an exec run with the menu open.
  const choose = body("choose");
  assert.match(choose, /menuChoice\(item\)/);
  assert.match(choose, /openWorkspaceMenu\(this\.project, this\.path, c\.submenu\)/);
  assert.match(choose, /run\(c\.command\)/);
  assert.match(choose, /c\.own/);

  // The exec: argv only, in the workspace's folder; the row shows "…" while
  // it runs, other clicks wait; a failure toasts its first stderr line (or
  // start failure) as a warning, then the menu closes. The task is no view's,
  // so a menu closed meanwhile (Esc, a click beside it) still gets its toast.
  const act = body("act");
  assert.match(act, /if \(this\.running\) return;/);
  assert.match(act, /this\.running = menuRowKey\(item\);/);
  assert.match(act, /exec\(argv\[0\], argv\.slice\(1\), \{ cwd: path \}\)/);
  assert.match(act, /execFailure\(/);
  assert.match(act, /startFailure\(/);
  assert.match(act, /level: "warning"/);
  assert.match(act, /closeOverlay\(overlay\)/);
  assert.match(act, /\{ owner: null \}/);
  assert.doesNotMatch(act, /"sh"|"-c"/, "never a shell");
  assert.match(menu, /this\.running === menuRowKey\(it\)/);
  assert.match(menu, /`\$\{it\.label\}…`/);
  // A disabled item is dim, takes no click and says why on hover; a checked
  // one draws a radio mark; a parent its chevron.
  assert.match(menu, /it\.why/);
  assert.match(menu, /it\.checked/);
  assert.match(menu, /chevron-right\.svg/);
});
