// Projects: Orca's sidebar for Herdr. One mod in views; the layout and the
// overlays give each copy props { view }:
//   (none)            the projects tree, in the layout's Spaces block. The
//                     only copy that reads key commands: it runs them all.
//   groups            the groups bar (F1–F3), above the sidebar footer
//   new-workspace     the New workspace dialog
//   project-menu      a project's right-click menu
//   base-menu         a project's Default branch… (its saved base, D37)
//   workspace-menu    a workspace's right-click menu
//   delete-workspace  the Delete dialog (a worktree, its spaces, its branch)
//   rename-workspace  the Rename dialog (a worktree's branch and folder)
//   group-menu        a group's right-click menu
//   group-form        New group / Rename group
//   task-menu         a task lane's right-click menu (Task mode)
//   task-note         a task's note
//   delete-task       the Delete task dialog (a task lane's workspaces)
//   keeper            the status row's 1 px cell: makes Inicio and keeps it
//                     right after the shown space (workspace-sleep D6, D7)
//   inicio            Inicio, the only pane of Inicio's space: Orca's
//                     Landing, shown when the shown space closes or sleeps
// Copies never reach into each other: they share state through store.js
// (setShared re-renders every copy) and act through herdr commands.

import { View, div } from "gpui-kit";
import { props, nextCommand } from "herdr";
import Tree, { commands as treeCommands } from "./tree.js";
import ProjectMenu from "./project-menu.js";
import BaseMenu from "./base-menu.js";
import WorkspaceMenu from "./workspace-menu.js";
import DeleteWorkspace from "./delete-workspace.js";
import RenameWorkspace from "./rename-workspace.js";
import Groups, { commands as groupsCommands } from "./groups.js";
import GroupForm from "./group-form.js";
import GroupMenu from "./group-menu.js";
import TaskMenu from "./task-menu.js";
import TaskNote from "./task-note.js";
import DeleteTask from "./delete-task.js";
import NewWorkspace, { commands as newWorkspaceCommands } from "./new-workspace.js";
import Inicio from "./inicio.js";
import Keeper from "./keeper.js";

// A copy without a view is the tree. scripts/check-views.sh rewrites this
// line in a tmp copy, because herdr-app check draws only the default view.
const DEFAULT_VIEW = "tree";

const VIEWS = {
  tree: Tree,
  inicio: Inicio,
  keeper: Keeper,
  groups: Groups,
  "new-workspace": NewWorkspace,
  "project-menu": ProjectMenu,
  "base-menu": BaseMenu,
  "workspace-menu": WorkspaceMenu,
  "delete-workspace": DeleteWorkspace,
  "rename-workspace": RenameWorkspace,
  "group-menu": GroupMenu,
  "group-form": GroupForm,
  "task-menu": TaskMenu,
  "task-note": TaskNote,
  "delete-task": DeleteTask,
};

// Every key command of the mod ("projects.<name>" in keys.json, or
// `herdr-app do projects.<name>`), by name. A handler gets { cx, copy }.
const COMMANDS = { ...treeCommands, ...groupsCommands, ...newWorkspaceCommands };

export default class Projects extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = pr.view ?? DEFAULT_VIEW;
    const V = VIEWS[this.name];
    this.view = V ? new V() : null;
    this.view?.init?.(pr, cx);
    if (this.name === "tree") this.listen(cx);
  }

  listen(cx) {
    const copy = Math.random().toString(36).slice(2, 7);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const handler = COMMANDS[c];
        try {
          if (handler) await handler({ cx, copy });
          else console.log(`projects: no command "${c}"`);
        } catch (e) {
          console.log(`projects: ${c} failed: ${e}`);
        }
        cx.notify();
      }
    });
  }

  async close(cx) {
    await this.view?.close?.(cx);
  }

  render(cx) {
    if (!this.view) return div().child(`projects: no view "${this.name}"`);
    return this.view.render(cx);
  }
}
