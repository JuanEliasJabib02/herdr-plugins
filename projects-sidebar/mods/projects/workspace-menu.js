// A workspace's right-click menu, a popup with props { project, path, sub }
// (D20): Sleep (workspace-sleep T6: agent-sleep puts the workspace to sleep,
// asking first when an agent is working), Copy Path and Copy Worktree Name;
// on a worktree that isn't the main checkout, Rename… (the Rename dialog,
// D25) and, after a separator, Delete… (the Delete dialog, D22). Then, after
// a separator, other plugins' items for that workspace (Spotlight's D30,
// menus-model.js): a submenu's item (▸) reopens the menu at the pointer on
// its items (`sub`: { key, id }), like the project menu's Move to group ▸; an
// item's action runs with the menu open,
// its row showing "…", then the menu closes. The popup's height follows the
// list. ↑/↓ move, Enter (→ on a submenu's item) runs, Esc closes. Copying
// uses gpui's clipboard (D21), then a toast says what was copied. With
// `only` (props.only, a list of own item ids) it draws just those of its own
// items and no plugin's: the Agents list's rows ask for Sleep, Rename… and
// Delete…. There, when the workspace's task has more workspaces in a group
// organized by Task (task-model.js agentTaskDelete), Delete… reads "Delete
// task AX-3743 (2)…" and opens the Delete task dialog for that task in that
// group, the one a lane's right-click opens: every workspace of the task
// goes, not just this one.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, exec, openOverlay, closeOverlay, notify, spaces, panes, home } from "herdr";
import { MOD, icon } from "./config.js";
import { normPath, baseName, matchSpaces } from "./lib.js";
import * as store from "./store.js";
import { workspaceMenuItems, workspaceLabel, workspacesOf, sleepCommand } from "./tree-model.js";
import { workspaceMenuList, subMenuOf, menuChoice, menuRowKey, menuHeight } from "./menus-model.js";
import { agentTaskDelete, withTaskDelete } from "./task-model.js";
import { execFailure, startFailure } from "./badges-model.js";
import { openDeleteWorkspace } from "./delete-workspace.js";
import { openDeleteTask } from "./delete-task.js";
import { openRenameWorkspace } from "./rename-workspace.js";

// props.only: a list of own item ids, or null for the whole menu.
const onlyOf = (v) => (Array.isArray(v) ? v.filter((id) => typeof id === "string") : null);

// The checkout as the tree lists it (main, branch), from the cache; a path
// the cache doesn't hold yet still gets its copies.
function rowOf(project, path) {
  if (!path) return null;
  const list = store.cache()[normPath(project ?? "")] ?? [];
  return list.find((c) => normPath(c.path) === normPath(path)) ?? { path, branch: null, main: false };
}

// Whether Sleep can run now: { open, asleep } of the row's workspace, as the
// tree draws its moon (tree-model.js workspacesOf over matchSpaces).
function sleepOf(row) {
  if (!row) return undefined;
  const all = spaces() ?? [];
  const [w] = workspacesOf([row], { matches: matchSpaces(store.cache(), all, panes() ?? [], home()), spaces: all });
  return w ? { open: w.open, asleep: w.asleep } : undefined;
}

// What the menu draws: { title, items, empty }. The workspace's own items,
// then the plugins' (store.menus, by its path); with `sub`, the items of that
// plugin item's submenu; with `only`, just those own items, Delete… the
// whole task's when it has more workspaces (withTaskDelete). The opener and
// the view both build it here, so the popup's height fits the list drawn.
export function menuOf(project, path, sub, only = null) {
  if (only) {
    const row = rowOf(project, path);
    const items = workspaceMenuItems(row, sleepOf(row)).filter((it) => only.includes(it.id));
    const task = only.includes("delete") ? agentTaskDelete(store.registry(), store.cache(), project, path) : null;
    return { title: row ? workspaceLabel(row) : "", items: withTaskDelete(items, task), empty: "Nothing to do here." };
  }
  const plugin = path ? store.menus()[normPath(path)] ?? [] : [];
  if (sub) {
    const parent = subMenuOf(plugin, sub);
    return { title: parent?.label ?? "", items: parent?.items ?? [], empty: "Not in the menu any more." };
  }
  const row = rowOf(project, path);
  return { title: row ? workspaceLabel(row) : "", items: workspaceMenuList(workspaceMenuItems(row, sleepOf(row)), plugin), empty: "No workspace." };
}

// The only place that opens the menu, at the pointer. A popup is as tall as
// its items; height is only the most, and it follows the list (D30).
export function openWorkspaceMenu(project, path, sub = null, only = null) {
  return openOverlay({ mod: MOD, kind: "popup", width: 220, height: menuHeight(menuOf(project, path, sub, only).items), props: { view: "workspace-menu", project, path, sub, ...(only ? { only } : {}) } });
}

const ICONS = {
  sleep: icon("moon"),
  "copy-path": icon("copy"),
  "copy-name": icon("copy"),
  rename: "mods/workspace-chrome/square-pen.svg",
  delete: "mods/workspace-chrome/x.svg",
};

export default class WorkspaceMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.path = p?.path ?? null;
    this.sub = p?.sub && typeof p.sub === "object" ? p.sub : null;
    this.only = onlyOf(p?.only);
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: an action's task outlives this copy's props
    this.running = null; // menuRowKey of the item whose program runs
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // A click or Enter on `item` (menus-model.js menuChoice): nothing while an
  // action runs, nor on a disabled item or one with nothing to run.
  choose(item, cx) {
    const c = menuChoice(item);
    if (!c || this.running) return;
    if (c.own) return this.chooseOwn(c.own, cx);
    if (c.submenu) {
      this.close();
      openWorkspaceMenu(this.project, this.path, c.submenu);
    } else if (c.command) {
      // A mod command: no args, no answer (run returns null), as a badge's.
      this.close();
      try {
        run(c.command);
      } catch (e) {
        notify({ title: c.command, body: startFailure(e), level: "warning" });
      }
    } else if (c.exec) this.act(item, c.exec, cx);
  }

  // This plugin's own items: Sleep, a copy, or the Rename / Delete dialog
  // (the Delete task dialog when Delete… carries a task, withTaskDelete).
  chooseOwn(item, cx) {
    if (item.text !== undefined) {
      cx.write_to_clipboard(item.text);
      notify({ title: "Copied", body: item.text, level: "success", timeout: 2500 });
    }
    this.close();
    if (item.id === "sleep") this.sleep();
    if (item.id === "rename") openRenameWorkspace(this.project, this.path);
    if (item.id === "delete" && item.task) openDeleteTask(item.task.lane, item.task.label, item.task.group);
    else if (item.id === "delete") openDeleteWorkspace(this.project, this.path);
  }

  // Sleep (T6): agent-sleep's `sleep-workspace.<hex>` with this workspace's
  // path, a mod command run by name as a plugin item's is. agent-sleep does
  // the rest: its confirm when an agent is working, its tabs put away (the
  // moon, and Inicio when it's the shown one), then the stops.
  sleep() {
    const name = sleepCommand(normPath(this.path ?? ""));
    if (!name) {
      notify({ title: "Sleep", body: `No workspace path to put to sleep: ${this.path ?? ""}`, level: "warning" });
      return;
    }
    try {
      run(name);
    } catch (e) {
      notify({ title: "Sleep", body: startFailure(e), level: "warning" });
    }
  }

  // A plugin item's exec (D30): argv only, never a shell, in the workspace's
  // folder, with Herdr's environment and its 30 s limit, while the menu
  // stays open with the row showing "…" (other clicks wait). Then a failure
  // (stderr's first line on a non-zero exit, or a program that can't start)
  // is a warning toast, and the menu closes. The task is no view's (owner
  // null): a menu closed meanwhile, by Esc or a click beside it, would cancel
  // its tasks after 250 ms and lose the toast.
  act(item, argv, cx) {
    if (this.running) return;
    this.running = menuRowKey(item);
    cx.notify();
    const { path, overlay } = this;
    cx.spawn(async () => {
      let failure;
      try {
        failure = execFailure(await exec(argv[0], argv.slice(1), { cwd: path }));
      } catch (e) {
        failure = startFailure(e);
      }
      if (failure) notify({ title: baseName(argv[0]), body: failure, level: "warning" });
      if (overlay) closeOverlay(overlay);
    }, { owner: null });
  }

  key(e, list, cx) {
    const n = list.length;
    if (e.key === "escape") return this.close();
    if (!n) return;
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter" || (e.key === "right" && list[this.at]?.items)) return this.choose(list[this.at], cx);
    else return;
    cx.notify();
  }

  render() {
    const t = theme();
    const m = menuOf(this.project, this.path, this.sub, this.only);
    const list = m.items;
    return v_flex()
      .id("workspace-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, list, cx))
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(m.title))
      .when(list.length === 0, (el) => el.child(div().px(8).pb(6).text_color(t.dim).child(m.empty)))
      .children(list.map((it, i) => this.row(it, i, t)));
  }

  // One row: its icon (an own item's from ICONS, a plugin's from the item,
  // else an empty slot so the labels line up), its label, and at its end a
  // plugin item's radio mark (`checked`) or a submenu's chevron. A danger
  // item is in the blocked color; a disabled one is dim, takes no click and
  // says why on hover; the one running is faded, its label ending in "…".
  row(it, i, t) {
    const off = Boolean(it.disabled);
    const busy = this.running === menuRowKey(it);
    const pic = it.key ? it.icon : ICONS[it.id];
    const tint = off ? t.dim : it.danger ? t.blocked : t.muted;
    return v_flex()
      .when(Boolean(it.separator), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex()
        .id(`wm-${i}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(off ? t.dim : it.danger ? t.blocked : t.foreground)
        .when(i === this.at && !off, (el) => el.bg(t.selected))
        .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(it, cx)))
        .when(Boolean((off && it.why) || it.tooltip), (el) => el.tooltip(off && it.why ? it.why : it.tooltip))
        .when(busy, (el) => el.opacity(0.6))
        .child(pic ? svg(pic).size(14).flex_none().text_color(tint) : div().size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(busy ? `${it.label}…` : it.label))
        .when(Boolean(it.checked), (el) => el.child(h_flex().size(14).flex_none().items_center().justify_center()
          .child(div().size(6).rounded(3).bg(off ? t.dim : t.foreground))))
        .when(Boolean(it.items), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
  }
}

// The menu opened from another mod (projects-agents' rows): a mod can't
// import another's files, so that one opens this view, a 1 px frameless
// popup at the pointer (props { project, path, only }), and this opens the
// real menu from here, at the same pointer, with its items (`only` those) and
// the height they take, then closes itself. With no workspace it only closes; not an
// overlay (herdr-app check) it does nothing.
export class WorkspaceMenuAt {
  init(p, cx) {
    const overlay = props()?.overlay ?? p?.overlay ?? null;
    const project = p?.project ?? null;
    const path = typeof p?.path === "string" && p.path ? p.path : null;
    const only = onlyOf(p?.only);
    cx.spawn(async () => {
      if (overlay === null) return;
      try {
        if (path) openWorkspaceMenu(project, path, null, only);
      } finally {
        closeOverlay(overlay);
      }
    });
  }

  render() {
    return div();
  }
}
