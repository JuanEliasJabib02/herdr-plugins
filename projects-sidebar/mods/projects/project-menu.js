// A project's right-click menu, a popup with props { project, move }:
// Open main, New workspace…, Default branch… (the base menu, D37), Move to
// group ▸, Remove from list. `move`: the Move to group submenu (the other
// groups), reopened at the pointer.
// ↑/↓ move, Enter (→ on Move to group) runs, Esc closes. Remove from list
// never touches files, worktrees or spaces itself (D11): it first runs other
// plugins' project hooks (Spotlight's D43: Spotlight turns the project's root
// off), then takes the project off the list. The menu only asks for it: the
// keeper's copy runs it (commands, below), because this popup's copy closes
// on the click and a closing copy's tasks are cancelled.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, spaces, panes, home } from "herdr";
import { MOD, icon } from "./config.js";
import { findProject, moveProject, removeProject } from "./lib.js";
import * as store from "./store.js";
import { runRemoveHooks } from "./git.js";
import { drainRemoveAsks } from "./remove-workspace-model.js";
import { projectMenuItems, openMainAction, withoutProject } from "./tree-model.js";
import { openNewWorkspace } from "./new-workspace.js";
import { openBaseMenu } from "./base-menu.js";

// The only place that opens the menu. A popup is as tall as its items;
// height is only the most.
export function openProjectMenu(path, move = false) {
  return openOverlay({ mod: MOD, kind: "popup", width: 220, height: 300, props: { view: "project-menu", project: path, move } });
}

const ICONS = {
  "open-main": icon("home"),
  "new-workspace": icon("plus"),
  "default-branch": icon("branch"),
  move: icon("folder"),
  "move-to": icon("folder"),
  remove: "mods/workspace-chrome/x.svg",
};

// The copies (keeper.js listen's `copy`) running a drain now: one at a time
// per copy, since a running drain takes new asks itself.
const draining = new Set();

// Key commands of this menu (main.js COMMANDS), run in the keeper's copy.
// `remove-asked`: every Remove from list asked (store.js removeAsks), in a
// task of the keeper's own view, which lives as long as the window, so a
// hook that waits (up to 120 s each) never holds up the other commands.
export const commands = {
  "remove-asked": ({ cx, copy }) => {
    if (draining.has(copy)) return;
    draining.add(copy);
    cx.spawn(async () => {
      try {
        await drainRemoveAsks({
          asks: store.removeAsks,
          beforeRemove: (p) => runRemoveHooks(store.removeHooks().project, p),
          remove: (p) => {
            store.updateRegistry((r) => removeProject(r, p));
            store.saveCache(withoutProject(store.cache(), p));
            store.dropRemoveAsk(p);
          },
        });
      } finally {
        draining.delete(copy);
      }
    });
  },
};

export default class ProjectMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.move = Boolean(p?.move);
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    return projectMenuItems(store.registry(), this.project, this.move);
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  choose(item) {
    if (!item || item.disabled) return;
    const path = this.project;
    this.close();
    switch (item.id) {
      case "open-main": {
        const a = openMainAction({ project: path, cache: store.cache(), spaces: spaces(), panes: panes(), home: home() });
        run(a.name, a.args);
        break;
      }
      case "new-workspace":
        openNewWorkspace(path);
        break;
      case "default-branch":
        openBaseMenu(path);
        break;
      case "move":
        openProjectMenu(path, true);
        break;
      case "move-to":
        store.updateRegistry((r) => moveProject(r, path, item.group));
        break;
      case "remove":
        // Asked, not run here: this popup's copy has just closed, and Herdr
        // cancels a closing copy's tasks, owner null too, so the hooks'
        // exec would never come back. The keeper's copy runs it.
        store.askRemove(path);
        run(`${MOD}.remove-asked`);
        break;
    }
  }

  key(e, list, cx) {
    const n = list.length;
    if (e.key === "escape") return this.close();
    if (!n) return;
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter" || (e.key === "right" && list[this.at]?.id === "move")) return this.choose(list[this.at]);
    else return;
    cx.notify();
  }

  render() {
    const t = theme();
    const list = this.items();
    const name = findProject(store.registry(), this.project ?? "")?.project.name ?? "";
    const title = this.move ? `Move ${name} to` : name;
    return v_flex()
      .id("project-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, list, cx))
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(title))
      .when(list.length === 0, (el) => el.child(div().px(8).pb(6).text_color(t.dim).child(this.move ? "No other group." : "Not in the list any more.")))
      .children(list.map((it, i) =>
        v_flex()
          .when(it.id === "remove", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
          .child(h_flex()
            .id(`pm-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(it.disabled ? t.dim : t.foreground)
            .when(i === this.at && !it.disabled, (el) => el.bg(t.selected))
            .when(!it.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.choose(it)))
            .child(svg(ICONS[it.id]).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(it.label))
            .when(it.id === "move", (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))))));
  }
}
