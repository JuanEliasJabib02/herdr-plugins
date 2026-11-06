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

