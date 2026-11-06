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

test("projects layout: agent-sleep's moon is the status bar's last cell, nothing of it in the sidebar, and requires installs it (agent-sleep D14)", () => {
  const layout = read("layouts/projects.json");
  const cells = find(layout, "status").children;
  // No props: the copy with no view runs the plugin's loop.
  assert.deepEqual(cells.at(-1), { id: "status-agent-sleep", type: "block", size: { px: 40 }, content: { mod: "agent-sleep" } });
  assert.equal(find(layout, "agent-sleep"), null, "the sidebar's block is gone");
  assert.ok(!mods(find(layout, "sidebar")).includes("agent-sleep"));
  assert.deepEqual(find(layout, "sidebar").children.map((c) => c.id), ["brand", "sidebar-lists", "groups", "sidebar-footer"]);
  const requires = readFileSync(new URL("../projects-sidebar/requires", import.meta.url), "utf8");
  assert.ok(requires.split("\n").includes("agent-sleep"));
});

test("projects layout: the status bar is a row, workspace-status, the claude-accounts footer, then agent-sleep's moon (claude-accounts D10, agent-sleep D14)", () => {
  const status = find(read("layouts/projects.json"), "status");
  assert.equal(status.type, "row");
  assert.equal(status.resizable, false);
  assert.deepEqual(status.size, { px: 28 });
  assert.deepEqual(status.children, [
    { id: "status-workspace", type: "block", size: { weight: 1 }, content: { mod: "workspace-status" } },
    { id: "status-usage", type: "block", size: { weight: 1 }, content: { mod: "claude-accounts", props: { view: "footer" } } },
    { id: "status-agent-sleep", type: "block", size: { px: 40 }, content: { mod: "agent-sleep" } },
  ]);
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

test("working mark: Claude Code's glyphs change in place with frames(), never spin()'s ~30 fps turn (S36)", () => {
  const tree = readFileSync(new URL("../projects-sidebar/mods/projects/tree.js", import.meta.url), "utf8");
  assert.match(tree, /WORKING_FRAMES = Object\.freeze\(\["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"\]\)/);
  assert.match(tree, /\.frames\(WORKING_FRAMES, 120\)\.child\(WORKING_FRAMES\[0\]\)/, "native frames, starting on the first glyph");
  assert.match(tree, /const CLAUDE_ORANGE = "#D97757"/, "Claude's orange, the fill of Herdr's icons/claude.svg (S37)");
  assert.match(tree, /\.text_color\(CLAUDE_ORANGE\)\s*\.frames\(WORKING_FRAMES/, "the glyphs are drawn in it");
  assert.doesNotMatch(tree, /\.spin\(/, "no spin(): Herdr turns it at about 30 fps, which stutters");
});

test("the agents list is projects-agents, a copy of Herdr's agents mod with only the working mark changed (S38)", () => {
  assert.deepEqual(find(read("layouts/projects.json"), "agents").content, { mod: "projects-agents" });
  assert.deepEqual(read("mods/projects-agents/mod.json"), { place: "none", title: "Agents", cloned_from: { name: "agents", version: "0.1.13" } });
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/${f}`, import.meta.url), "utf8");
  const copy = src("projects-agents/main.js");
  const tree = src("projects/tree.js");
  const constant = (s, name) => s.match(new RegExp(`const ${name} = .*;`))?.[0];
  for (const name of ["WORKING_FRAMES", "CLAUDE_ORANGE"]) {
    assert.ok(constant(copy, name), `${name} is defined`);
    assert.equal(constant(copy, name), constant(tree, name), `${name} matches the projects tree`);
  }
  assert.match(copy, /a\.status === "working"[\s\S]{0,200}\.text_color\(CLAUDE_ORANGE\)\s*\.frames\(WORKING_FRAMES, 120\)\.child\(WORKING_FRAMES\[0\]\)/);
  assert.doesNotMatch(copy, /\.spin\(/, "no spin(), and no Herdr spinner");
  assert.match(copy, /openOverlay\(\{ mod: "projects-agents",/, "the sort menu opens the copy's own overlay, as mod.clone rewrites it");
  assert.doesNotMatch(copy, /mod: "agents"/);
  assert.match(src("projects-agents/LICENSE"), /Apache License\s+Version 2\.0/, "Herdr's license travels with the copy");
});

test("Task notes and the task menu: a lane's right-click and its tooltip, and their views (D34, D35)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const tree = src("tree.js");
  const start = tree.indexOf("function taskRow(");
  assert.ok(start >= 0, "tree.js draws task rows in taskRow");
  const taskRow = tree.slice(start, tree.indexOf("\n}\n", start));
  assert.match(taskRow, /on_mouse_down\("right"[\s\S]*?cx\.stop_propagation\(\)[\s\S]*?openTaskMenu\(/, "a lane's right-click opens the task menu");
  assert.match(taskRow, /\.tooltip\(/, "a lane with a note shows it on hover");
  const main = src("main.js");
  assert.match(main, /"task-menu":\s*TaskMenu/);
  assert.match(main, /"task-note":\s*TaskNote/);
  assert.match(src("task-menu.js"), /taskMenuItems\(/, "the menu's items come from task-model.js");
  const dialog = src("task-note.js");
  assert.match(dialog, /modal:\s*true/);
  assert.match(dialog, /setNote\(/, "Save goes through store.js");
  assert.match(src("store.js"), /export function setNote/);
});

test("Delete task: the task menu's Delete task… opens its dialog, a view of the mod whose run outlives it (D36)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const menu = src("task-menu.js");
  assert.match(menu, /openDeleteTask\(/, "the menu's Delete task… opens the dialog");
  assert.match(menu, /laneTargets\(/, "the menu reads the lane's workspaces on render");
  assert.doesNotMatch(menu, /Coming next/, "Delete task… is wired");
  assert.match(src("main.js"), /"delete-task":\s*DeleteTask/);
  const dialog = src("delete-task.js");
  assert.match(dialog, /export default class DeleteTask/);
  assert.match(dialog, /view:\s*"delete-task"/);
  assert.match(dialog, /modal:\s*true/);
  assert.match(dialog, /laneTargets\(/, "it captures the targets once, on open");
  assert.match(dialog, /removeTask\(/);
  assert.match(dialog, /\{\s*owner:\s*null\s*\}/, "the run lives in a task no view owns");
  assert.match(dialog, /alive:\s*\(\)\s*=>\s*bg\.sleep\(0\)/, "a reload stops the run between targets");
  assert.match(dialog, /taskStillUsed\(/, "the note goes only when no other workspace has the task");
  const del = src("delete-workspace.js");
  assert.match(del, /export async function closeSpaces\b/);
  assert.match(del, /export const closingSpaces\b/);
});

test("New workspace's add-project click hands addToGroup the spawn's async context, not the click's (R1-A)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const dialog = src("new-workspace.js");
  const start = dialog.indexOf('"nw-add-project"');
  assert.ok(start >= 0, "the folder icon beside Project is drawn");
  const click = dialog.slice(start).match(/\.on_click\(\(_e, cx\) => cx\.spawn\(async \((\w*)\) => this\.addToGroup\((\w+)\)\)\)/);
  assert.ok(click, "its click runs addToGroup in a spawned task");
  assert.ok(click[1], "the spawn callback takes the AsyncContext it is handed");
  assert.equal(click[2], click[1], "addToGroup gets that AsyncContext, valid across the picker's await");
  assert.doesNotMatch(dialog, /spawn\(async \(\) => this\.addToGroup\(cx\)\)/, "the click's cx is never kept across an await");
});

test("Default branch…: the project menu opens the base menu, a view of the mod that loads in init with cx.spawn and scrolls past LIST_ROWS (D37, S33)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const pm = src("project-menu.js");
  assert.match(pm, /"default-branch":\s*icon\("branch"\)/, "the menu draws it with the branch icon");
  assert.match(pm, /case "default-branch":\s*openBaseMenu\(path\)/, "Default branch… opens the base menu");
  assert.match(src("main.js"), /"base-menu":\s*BaseMenu/);
  const menu = src("base-menu.js");
  assert.match(menu, /export default class BaseMenu/);
  assert.match(menu, /export function openBaseMenu\(path\)/);
  assert.match(menu, /kind:\s*"popup"[\s\S]*?view:\s*"base-menu"/);
  const start = menu.indexOf("  init(");
  assert.ok(start >= 0, "the base menu has an init");
  const init = menu.slice(start, menu.indexOf("\n  }\n", start));
  assert.match(init, /cx\.spawn\(async \(cx\) =>[\s\S]*?G\.defaultBase\(path\)[\s\S]*?G\.recentBases\(path\)/, "it loads in init, in a spawned task");
  assert.match(menu, /baseMenuRows\(/, "its rows come from new-workspace-model.js");
  assert.match(menu, /setProjectBase\(/, "picking saves through lib.js");
  assert.match(menu, /import \{[^}]*\bLIST_ROWS\b[^}]*\} from "\.\/new-workspace\.js"/, "at most the dialog's LIST_ROWS rows show");
  assert.match(menu, /v_virtual_list\(/, "then it scrolls");
  assert.match(menu, /\.track_scroll\(this\.scroll\)/, "a list the menu scrolls from code");
  assert.match(menu, /scroll_to_item\(/, "the highlighted row is kept in view");
  for (const state of ["Not a git repository", "No remote branches"]) assert.ok(menu.includes(`"${state}"`), `it says "${state}"`);
  const dialog = src("new-workspace.js");
  assert.match(dialog, /export const LIST_ROWS = 7/);
  assert.match(dialog, /baseFor\(/, "the dialog's default is the saved base when git has it");
  assert.match(dialog, /G\.baseExists\(/, "found by the same exact lookup");
  assert.match(dialog, /rememberBase\(/, "a successful Create remembers the primary's base");
  assert.match(dialog, /origin's default/);
  assert.match(src("git.js"), /export const baseExists\b/);
});

test("A press that isn't a drag start never leaves a project drag set (D33, R1b-C)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const tree = src("tree.js");
  const start = tree.indexOf("function projectRow(");
  assert.ok(start >= 0, "tree.js draws project rows in projectRow");
  const projectRow = tree.slice(start, tree.indexOf("\n}\n", start));
  const plus = projectRow.slice(projectRow.indexOf("`p+:"));
  assert.match(plus, /\.on_click\([\s\S]*?drag = null[\s\S]*?openNewWorkspace\(/, "the \"+\" clears the drag its press started");
  assert.match(projectRow, /\.on_mouse_down_out\([\s\S]*?drag = null/, "a press outside the row cancels a drag");
});
