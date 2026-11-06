// T1: the plugin folder is a Herdr plugin: the `projects` layout swaps the
// Spaces block for this mod and adds the groups block; the mod docks nowhere
// on its own; config is importable outside Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOD, WORKTREE_ROOT } from "../projects-sidebar/mods/projects/config.js";

const read = (p) => JSON.parse(readFileSync(new URL(`../projects-sidebar/${p}`, import.meta.url), "utf8"));

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

test("config names the mod and the worktree root", () => {
  assert.equal(MOD, "projects");
  assert.equal(WORKTREE_ROOT, "~/orca/workspaces");
});

test("mod.json keeps the mod from docking itself", () => {
  assert.deepEqual(read("mods/projects/mod.json"), { place: "none" });
});

test("projects layout: tree replaces Spaces, groups block sits above the footer", () => {
  const layout = read("layouts/projects.json");
  assert.equal(layout.preview, "layouts/projects.svg");
  assert.deepEqual(find(layout, "spaces").content, { mod: "projects" });
  assert.ok(!mods(layout).includes("spaces"), "no copy of the shipped spaces mod");
  const sidebar = find(layout, "sidebar");
  const ids = sidebar.children.map((c) => c.id);
  assert.deepEqual(ids.slice(-2), ["groups", "sidebar-footer"]);
  const groups = find(layout, "groups");
  assert.deepEqual(groups.content, { mod: "projects", props: { view: "groups" } });
  assert.deepEqual(groups.size, { px: 44 });
});

test("the workspace menu is a view of the mod (D20)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  assert.match(src("main.js"), /"workspace-menu":\s*WorkspaceMenu/);
  assert.match(src("workspace-menu.js"), /export default class WorkspaceMenu/);
  assert.match(src("tree.js"), /openWorkspaceMenu\(/, "a workspace row's right-click opens it");
});

test("the delete dialog is a view of the mod, and its delete outlives it (D22)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  assert.match(src("main.js"), /"delete-workspace":\s*DeleteWorkspace/);
  const dialog = src("delete-workspace.js");
  assert.match(dialog, /export default class DeleteWorkspace/);
  assert.match(dialog, /modal:\s*true/);
  assert.match(dialog, /\{\s*owner:\s*null\s*\}/, "the sequence runs in a task no view owns");
  assert.match(src("workspace-menu.js"), /openDeleteWorkspace\(/, "the menu's Delete… opens it");
});


test("the rename dialog is a view of the mod, and its rename outlives it (D25)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  assert.match(src("main.js"), /"rename-workspace":\s*RenameWorkspace/);
  const dialog = src("rename-workspace.js");
  assert.match(dialog, /export default class RenameWorkspace/);
  assert.match(dialog, /modal:\s*true/);
  assert.match(dialog, /\{\s*owner:\s*null\s*\}/, "the sequence runs in a task no view owns");
  assert.match(dialog, /removalCheck\(/, "it asks git on open whether the folder can move");
  assert.match(src("workspace-menu.js"), /openRenameWorkspace\(/, "the menu's Rename… opens it");
  assert.match(src("git.js"), /export const renameWorkspace\b/);
});

test("the group menu toggles Task mode, and the tree draws it (D31, D32)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const menu = src("group-menu.js");
  assert.match(menu, /groupMenuItems\(/, "the menu's items come from task-model.js");
  assert.match(menu, /setOrganize\(r, group\.id, "task"\)/);
  assert.match(menu, /setOrganize\(r, group\.id, "project"\)/);
  assert.match(menu, /height:\s*200/, "four items and a separator fit");
});

test("Task mode: lanes, their folding, and New workspace in the header (D31, D32)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const tree = src("tree.js");
  assert.match(tree, /buildTaskTree\(/);
  assert.match(tree, /r\.kind === "task"/);
  assert.match(tree, /toggleTaskCollapsed\(/);
  assert.match(tree, /"projects-new-workspace"[\s\S]*?openNewWorkspace\(focusedProject\(\)\)/, "the header's New workspace opens the dialog");
  assert.match(src("store.js"), /export function toggleTaskCollapsed/);
});
