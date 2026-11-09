// Items from other plugins in a workspace's right-click menu (Spotlight's
// D30), with no herdr or gpui-kit imports so `node --test` can load it. This
// plugin knows no plugin: it reads what they publish under config.js
// MENU_KEYS, draws it in the workspace menu after its own items and a
// separator (workspace-menu.js), and runs an item's action there. The
// contract other plugins consume is RECIPE.md "Menu items from other
// plugins"; it only grows (a breaking change gets a new key, e.g.
// menus.spotlight.v2).
//
//   each key:  { [workspacePath]: [item] }
//              workspacePath: absolute, as `git worktree list` prints it
//   an item:   { id, text, icon?, danger?, disabled?, why?, checked?,
//                action?, items? }
//   action:    a badge's (badges-model.js actionOf): { command } of the
//              publisher's own mod, or { exec: [program, ...args] }
//   items:     one submenu level: the same item, without `items`
//
// Anything else is dropped field by field: a bad icon, action or flag goes
// and the item stays; an item without a valid id or text goes whole, and so
// does a later item repeating an id; a value that isn't an object is no
// items at all. Never throws.

import { MENU_KEYS } from "./config.js";
import { normPath, isAbsolute } from "./lib.js";
import { iconOf, textOf, actionOf, publisherOf } from "./badges-model.js";

// Caps: items per plugin on one workspace, items in one submenu, and code
// points in an item's text and in a disabled item's why.
const PER_PLUGIN = 8;
const PER_SUB = 6;
const TEXT_MAX = 40;
const WHY_MAX = 200;

// An item's id: it names its row (the one running shows "…") and a
// submenu's parent. Letters, digits, `.`, `_`, `:` and `-`, 64 at most.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// A list of items, valid ones only, at most `cap`, a repeated id dropped.
// `sub`: the list is a submenu, whose items can't open one.
function itemsOf(list, key, cap, sub) {
  const kept = [];
  const ids = new Set();
  for (const raw of list) {
    if (kept.length >= cap) break;
    const item = itemOf(raw, key, sub);
    if (!item || ids.has(item.id)) continue;
    ids.add(item.id);
    kept.push(item);
  }
  return kept;
}

// One item under `key`, or null. The published `text` becomes `label`: in
// the menu, an item's `text` is what Copy puts on the clipboard
// (tree-model.js workspaceMenuItems). A flag is kept only as `true`. A
// submenu parent (valid `items`) opens its submenu, so its action and radio
// mark drop; a disabled item keeps its action (drawn, never run) and its
// `why`, which an enabled item doesn't have.
function itemOf(raw, key, sub) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  const label = textOf(raw.text, TEXT_MAX);
  if (!id || !label) return null;
  const items = !sub && Array.isArray(raw.items) ? itemsOf(raw.items, key, PER_SUB, true) : [];
  const parent = items.length > 0;
  const icon = iconOf(raw.icon);
  const action = parent ? null : actionOf(raw.action, publisherOf(key));
  const disabled = raw.disabled === true;
  const why = disabled ? textOf(raw.why, WHY_MAX) : null;
  return {
    key,
    id,
    label,
    ...(icon ? { icon } : {}),
    ...(raw.danger === true ? { danger: true } : {}),
    ...(disabled ? { disabled: true } : {}),
    ...(why ? { why } : {}),
    ...(!parent && raw.checked === true ? { checked: true } : {}),
    ...(action ? { action } : {}),
    ...(parent ? { items } : {}),
  };
}

// Every workspace's plugin items: { [workspacePath]: [item] }, each path's
// in key order (MENU_KEYS'), at most 8 per plugin, each item carrying its
// key. `values`: the keys' shared() values, in that order (store.js menus()).
export function parseMenus(values, keys = MENU_KEYS) {
  const rows = {};
  if (!Array.isArray(values)) return rows;
  values.forEach((value, i) => {
    if (!isObject(value)) return;
    const key = keys[i] ?? String(i);
    const mine = new Map(); // path -> this plugin's raw items on it
    for (const [at, list] of Object.entries(value)) {
      if (!isAbsolute(at) || !Array.isArray(list)) continue;
      const path = normPath(at);
      mine.set(path, [...(mine.get(path) ?? []), ...list]);
    }
    for (const [path, list] of mine) {
      const kept = itemsOf(list, key, PER_PLUGIN, false);
      if (kept.length) rows[path] = [...(rows[path] ?? []), ...kept];
    }
  });
  return rows;
}

// The list the workspace menu draws: this plugin's own items
// (tree-model.js workspaceMenuItems), then each plugin's, each plugin's
// first item with `separator: true` (a line above it). No plugin item: the
// own list as it is.
export function workspaceMenuList(own, plugin) {
  const out = [...(own ?? [])];
  let last = null;
  for (const item of plugin ?? []) {
    out.push(item.key !== last && out.length > 0 ? { ...item, separator: true } : item);
    last = item.key;
  }
  return out;
}

// The plugin item a submenu opens from (`sub`: its { key, id }), with its
// `items`; null when it is gone or isn't a submenu any more.
export function subMenuOf(plugin, sub) {
  if (!sub) return null;
  return (plugin ?? []).find((it) => it.key === sub.key && it.id === sub.id && it.items?.length) ?? null;
}

// What a click on `item` does, or null for nothing (a disabled item, or a
// plugin's item with neither action nor submenu):
//   { own: item }            this plugin's own item (Copy, Rename…, Delete…)
//   { submenu: { key, id } } reopen the menu on that item's submenu
//   { command }              run(command)
//   { exec: argv }           exec, with the menu open until it ends
// A plugin's item is never taken for an own one, whatever its id.
export function menuChoice(item) {
  if (!item || item.disabled) return null;
  if (!item.key) return { own: item };
  if (item.items?.length) return { submenu: { key: item.key, id: item.id } };
  if (item.action?.command) return { command: item.action.command };
  if (item.action?.exec) return { exec: item.action.exec };
  return null;
}

// A row's identity in the open menu: an own item's id, a plugin item's key
// and id (two plugins, or a plugin and this one, may share an id).
export const menuRowKey = (item) => (item?.key ? `${item.key}\n${item.id}` : item?.id ?? "");

// The popup's height, which follows the list: workspace-menu.js draws each
// row 31 px tall and a separator as 4 + 1 + 4 px; the title and the padding
// take MENU_CHROME (merge-pr.js and base-menu.js keep 50 for theirs); an
// empty list draws one line instead.
export const MENU_ROW = 31;
export const MENU_SEP = 9;
const MENU_CHROME = 50;
const MENU_EMPTY = 28;

export function menuHeight(list) {
  const items = list ?? [];
  if (!items.length) return MENU_CHROME + MENU_EMPTY;
  return MENU_CHROME + items.length * MENU_ROW + items.filter((it) => it.separator).length * MENU_SEP;
}
