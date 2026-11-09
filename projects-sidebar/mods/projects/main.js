// Projects: Orca's sidebar for Herdr. One mod in views; the layout and the
// overlays give each copy props { view }:
//   (none)            the projects tree, in the layout's Spaces block
//   groups            the groups bar (F1–F3), above the sidebar footer
//   new-workspace     the New workspace dialog
//   project-menu      a project's right-click menu
//   base-menu         a project's Default branch… (its saved base, D37)
//   workspace-menu    a workspace's right-click menu, other plugins' items
//                     after its own, or one of their submenus (props.sub)
//   delete-workspace  the Delete dialog (a worktree, its spaces, its branch)
//   rename-workspace  the Rename dialog (a worktree's branch and folder)
//   group-menu        a group's right-click menu
//   filter-menu       the header's filter popup: Hide sleeping and Except
//                     default branch (workspace-sleep D8)
//   group-form        New group / Rename group
//   task-menu         a task lane's right-click menu (Task mode)
//   task-note         a task's note
//   delete-task       the Delete task dialog (a task lane's workspaces)
//   pr                the PR card, above Changes in the right panel (the
//                     PR of the branch Changes shows)
//   merge-menu        the card's Mergear ▾ popup (the merge methods)
//   merge-pr          the Mergear confirm dialog
//   create-pr         the Crear PR dialog (the card's branch has no PR)
//   keeper            the status row's 1 px cell: makes Inicio and keeps it
//                     right after the shown space (workspace-sleep D6, D7).
//                     The only copy that reads key commands: it runs them
//                     all, the sidebar shown or not (D7, T0b item 2)
//   inicio            Inicio, the only pane of Inicio's space: Orca's
//                     Landing, shown when the shown space closes or sleeps
// Copies never reach into each other: they share state through store.js
// (setShared re-renders every copy) and act through herdr commands.

import { View, div } from "gpui-kit";
import { props } from "herdr";
import Tree, { commands as treeCommands } from "./tree.js";
import ProjectMenu from "./project-menu.js";
import BaseMenu from "./base-menu.js";
import WorkspaceMenu from "./workspace-menu.js";
import DeleteWorkspace from "./delete-workspace.js";
import RenameWorkspace from "./rename-workspace.js";
import Groups, { commands as groupsCommands } from "./groups.js";
import GroupForm from "./group-form.js";
import GroupMenu from "./group-menu.js";
import FilterMenu from "./filter-menu.js";
import TaskMenu from "./task-menu.js";
import TaskNote from "./task-note.js";
import DeleteTask from "./delete-task.js";
import NewWorkspace, { commands as newWorkspaceCommands } from "./new-workspace.js";
import PrCard from "./pr-card.js";
import MergePr, { MergeMenu } from "./merge-pr.js";
import CreatePr from "./create-pr.js";
import Inicio from "./inicio.js";
import Keeper, { commands as keeperCommands } from "./keeper.js";

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
  "filter-menu": FilterMenu,
  "group-form": GroupForm,
  "task-menu": TaskMenu,
  "task-note": TaskNote,
  "delete-task": DeleteTask,
  pr: PrCard,
  "merge-menu": MergeMenu,
  "merge-pr": MergePr,
  "create-pr": CreatePr,
};

// Every key command of the mod ("projects.<name>" in keys.json, `herdr-app
// do projects.<name>`, or run() from another copy), by name. A handler gets
// { cx, copy }. They all run in the keeper's copy (keeper.js listen), so none
// may rely on the state of the copy that defines it: only the shared keys
// and herdr.
const COMMANDS = { ...treeCommands, ...groupsCommands, ...newWorkspaceCommands, ...keeperCommands };

export default class Projects extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = pr.view ?? DEFAULT_VIEW;
    const V = VIEWS[this.name];
    this.view = V ? new V() : null;
    this.view?.init?.(pr, cx);
    // One command reaches one shown copy only, the first one started (T0b
    // item 2): the keeper, in the status row from the window's start, is the
    // only listener. In a layout without it, no copy reads commands.
    if (this.name === "keeper") this.view.listen(cx, COMMANDS);
  }

  async close(cx) {
    await this.view?.close?.(cx);
  }

  render(cx) {
    if (!this.view) return div().child(`projects: no view "${this.name}"`);
    return this.view.render(cx);
  }
}
