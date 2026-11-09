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

test("projects layout: the status bar is a row, workspace-status, the spotlight flask, the claude-accounts footer, keep-awake's cup, then agent-sleep's moon (claude-accounts D10, spotlight D20, keep-awake D10, agent-sleep D14)", () => {
  const status = find(read("layouts/projects.json"), "status");
  assert.equal(status.type, "row");
  assert.equal(status.resizable, false);
  assert.deepEqual(status.size, { px: 28 });
  assert.deepEqual(status.children, [
    { id: "status-workspace", type: "block", size: { weight: 1 }, content: { mod: "workspace-status" } },
    { id: "status-spotlight", type: "block", size: { px: 40 }, content: { mod: "spotlight", props: { view: "footer" } } },
    { id: "status-usage", type: "block", size: { weight: 1 }, content: { mod: "claude-accounts", props: { view: "footer" } } },
    { id: "status-keep-awake", type: "block", size: { px: 64 }, content: { mod: "keep-awake" } },
    { id: "status-agent-sleep", type: "block", size: { px: 40 }, content: { mod: "agent-sleep" } },
  ]);
});

test("S6: the PR card sits atop Changes in the right panel: the stack's child `changes` is a fixed column, the card's block above Herdr's Changes (D3)", () => {
  const layout = read("layouts/projects.json");
  const body = find(layout, "panel-body");
  assert.deepEqual(body.children.map((c) => c.id), ["explorer", "changes"], "code-tabs' header selects these ids");
  const changes = find(layout, "changes");
  assert.equal(changes.type, "column");
  assert.equal(changes.resizable, false, "a dragged card would be clipped, and the drag saved");
  assert.ok(changes.gap > 0, "Changes draws its own box with no margin: a gap keeps the two apart");
  assert.deepEqual(changes.children.map((c) => c.id), ["pr-card", "changes-diff"]);
  const card = find(layout, "pr-card");
  assert.equal(card.type, "block");
  assert.deepEqual(card.content, { mod: "projects", props: { view: "pr" } });
  assert.ok(Number.isInteger(card.size?.px) && card.size.px > 0, "fixed height (D4)");
  assert.equal(card.size.weight, undefined);
  assert.deepEqual(find(layout, "changes-diff"), { id: "changes-diff", type: "block", size: { weight: 1 }, content: { mod: "changes" } });
  assert.equal(mods(layout).filter((m) => m === "changes").length, 1, "one copy of Herdr's Changes");
});

test("S5: the PR card is the mod's `pr` view, checked by check-views through DEFAULT_VIEW (D2)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const main = src("main.js");
  assert.match(main, /^\s+pr:\s*PrCard,$/m);
  assert.match(main, /^import PrCard from "\.\/pr-card\.js";$/m);
  // scripts/check-views.sh rewrites this line to check each view.
  assert.match(main, /^const DEFAULT_VIEW = "tree";$/m);
  assert.match(main, /pr\.view \?\? DEFAULT_VIEW/);
  const card = src("pr-card.js");
  assert.match(card, /export default class PrCard\b/);
  assert.match(card, /cardState\(/, "it draws T2's state (pr-card-model.js)");
  assert.match(src("git.js"), /export const readPrCard = [\s\S]*?readCard\(/, "git.js binds readCard to exec");
});

test("S5: the card shows the workspace of the folder Changes shows, asks one at a time by key, only while shown, and hides when it has nothing to say (D5, D9, D10)", () => {
  const card = readFileSync(new URL("../projects-sidebar/mods/projects/pr-card.js", import.meta.url), "utf8");
  assert.match(card, /pane\?\.cwd \|\| f\?\.cwd \|\| space\?\.folder/, "Changes' folder: the focused pane's, then focused()'s, then the space's");
  assert.match(card, /checkoutAt\(/, "matched as the sidebar matches spaces");
  assert.match(card, /if \(this\.busy\) return;/, "one read at a time");
  assert.match(card, /this\.key === key/, "an answer for a key that moved on is never drawn");
  assert.match(card, /active === "changes"/, "the timer asks only while Changes shows");
  assert.match(card, /Date\.now\(\) - this\.at < EVERY \|\| !window\(\)\.active/, "the 30 s re-read only from the window in front, as the sidebar's colors (D1)");
  assert.match(card, /run\("layout\.hide", \{ id: BLOCK \}\)/);
  assert.match(card, /run\("layout\.show", \{ id: BLOCK \}\)/);
  assert.match(card, /const BLOCK = "pr-card";/);
  assert.match(card, /exec\("open", \[url\]\)/, "Abrir en GitHub goes through `open`, so arc-spaces picks the Arc space");
  assert.match(card, /url\.startsWith\("https:\/\/github\.com\/"\)/, "only a GitHub URL reaches it");
  assert.doesNotMatch(card, /open_url\(/);
});

test("J-001, J-010: the tree, started fresh on every layout load, shows the card's block when Herdr kept it hidden and the card has something to say, watching every tick until a show it ran is seen shown (at most 5 shows) or the block is seen shown 2 ticks in a row with no show run (J-014: shown at load, the copy runs), so the card's copy starts and its own place() decides again, even after a start on a main checkout (D9)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const card = src("pr-card.js");
  // One rule for where the card has something to say: the card's own, which
  // the tree asks too.
  assert.match(card, /^export function cardTarget\(\) \{$/m, "pr-card.js exports its target() decision");
  assert.doesNotMatch(card, /^function target\(\)/m, "no second copy of the rule");
  assert.equal(card.match(/const now = cardTarget\(\);/g)?.length, 2, "the card's tick and render follow it");
  const at = card.indexOf("export function showPrCard(say) {");
  assert.ok(at >= 0, "pr-card.js exports showPrCard(say)");
  const show = card.slice(at, card.indexOf("\n}\n", at));
  assert.match(show, /const node = find\(layout\(\), BLOCK\);/, "the card's block in the layout now");
  assert.match(show, /if \(!node\) return "missing";/, "no block yet (layout not applied): the tree tries again");
  assert.match(show, /if \(!node\.hidden\) return "shown";/, "a shown block is left alone");
  assert.match(show, /if \(!say\) return "hidden";/, "never shown where the card has nothing to say: a main checkout doesn't flash");
  assert.match(show, /try \{\s+run\("layout\.show", \{ id: BLOCK \}\);\s+return "asked";\s+\} catch \{/, "the show, kept in its try/catch");
  const tree = src("tree.js");
  assert.match(tree, /^import \{ showPrCard, cardTarget \} from "\.\/pr-card\.js";$/m);
  assert.match(tree, /^const CARD_ASKS = 5;$/m, "at most 5 shows: a card that hides itself right away (origin not GitHub) can't make it flash forever");
  assert.doesNotMatch(tree, /CARD_TICKS/, "no limit in ticks: a start on a main checkout must still show the card on the first workspace with a PR, however late (live)");
  assert.equal(tree.match(/showPrCard\(/g)?.length, 1, "called in one place only");
  assert.equal(tree.match(/this\.cardTick\(\)/g)?.length, 1);
  const start = tree.indexOf("  init(_props, cx) {");
  const init = tree.slice(start, tree.indexOf("\n  }\n", start));
  assert.doesNotMatch(init, /showPrCard\(/, "never from init itself, where Herdr ignores it on a cold start (live, after a restart)");
  assert.match(init, /this\.cardAsks = 0;/);
  assert.match(init, /this\.cardDone = false;/);
  assert.match(init, /cx\.timer\.every\(1000, \(cx\) => \{\s+if \(!this\.cardDone\) this\.cardTick\(\);/, "on every 1 s tick until done");
  const tickAt = tree.indexOf("  cardTick() {");
  assert.ok(tickAt >= 0, "tree.js runs one try in cardTick");
  const tick = tree.slice(tickAt, tree.indexOf("\n  }\n", tickAt));
  assert.match(tick, /const step = showPrCard\(cardTarget\(\) !== null\);/, "shown only where the card's own rule says it has something to say");
  assert.match(tree, /^const CARD_SEEN = 2;$/m, "J-014: shown 2 ticks in a row, the card's copy runs");
  assert.match(init, /this\.cardSeen = 0;/);
  assert.match(tick, /if \(step === "asked"\) \{\s+this\.cardSeen = 0;\s+this\.cardAsks\+\+;\s+if \(this\.cardAsks >= CARD_ASKS\) this\.cardDone = true;\s+\}/, "each show counted, at most CARD_ASKS");
  assert.match(tick, /else if \(step === "shown"\) \{\s+this\.cardSeen\+\+;\s+if \(this\.cardAsks > 0 \|\| this\.cardSeen >= CARD_SEEN\) this\.cardDone = true;\s+\}/, "shown after a show, or shown CARD_SEEN ticks in a row (J-014: a block shown at load, so the tree stops before the card's hide on a non-GitHub origin turns into flashes)");
  assert.match(tick, /\} else this\.cardSeen = 0;/, "a tick with the block hidden or missing starts the count again");
});

test("J-005, J-006: the head truncates on its own and → base never shrinks; Mergear off says why on the card, dim and truncated beside it, keeping the hover (D6)", () => {
  const card = readFileSync(new URL("../projects-sidebar/mods/projects/pr-card.js", import.meta.url), "utf8");
  const at = card.indexOf("function prRows(");
  const rows = card.slice(at, card.indexOf("\n}\n", at));
  assert.match(rows, /div\(\)\.min_w\(0\)\.truncate\(\)\.child\(s\.head\)/, "the head gives way first");
  assert.match(rows, /div\(\)\.flex_none\(\)\.child\(`→ \$\{s\.base\}`\)/, "the base always shows");
  assert.doesNotMatch(rows, /\.child\(s\.branches\)/, "never one string truncated as a whole");
  assert.match(rows, /div\(\)\.flex_none\(\)\.text_size\(11\)\.text_color\(t\.dim\)\.child\(s\.sync\)/, "↑↓ stays at the right");
  assert.match(rows, /\.when\(Boolean\(s\.merge\?\.reason\), \(el\) => el\.tooltip\(s\.merge\.reason\)\)/, "the hover stays");
  assert.match(rows, /\.when\(Boolean\(s\.merge\?\.reason\), \(el\) => el\.child\(div\(\)\.flex_1\(\)\.min_w\(0\)\.truncate\(\)\.text_size\(11\)\.text_color\(t\.dim\)\.child\(s\.merge\.reason\)\)\)/, "the reason on the button row: no row added to the 176 px card");
});

test("J-011: the merge and create dialogs draw head → base as the card does: the head truncates on its own and → base never shrinks", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const merge = src("merge-pr.js");
  assert.match(merge, /div\(\)\.min_w\(0\)\.truncate\(\)\.child\(this\.seen\.head\)/, "Mergear's head gives way first");
  assert.match(merge, /div\(\)\.flex_none\(\)\.child\(`→ \$\{this\.seen\.base\}`\)/, "Mergear's base always shows");
  assert.doesNotMatch(merge, /p\.branches/, "never one string as a whole");
  const create = src("create-pr.js");
  assert.match(create, /div\(\)\.min_w\(0\)\.truncate\(\)\.child\(this\.seen\.branch\)/, "Crear PR's head gives way first");
  assert.match(create, /div\(\)\.flex_none\(\)\.child\(`→ \$\{base \|\| "…"\}`\)/, "Crear PR's base, or … until one is picked, always shows");
  assert.doesNotMatch(create, /p\.branches/, "never one string as a whole");
});

test("S4: Mergear ▾ opens the methods popup, which opens a modal confirm dialog; both are views of the mod, and the merge outlives the dialog (D6)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const main = src("main.js");
  assert.match(main, /"merge-menu":\s*MergeMenu,/);
  assert.match(main, /"merge-pr":\s*MergePr,/);
  assert.match(main, /^import MergePr, \{ MergeMenu \} from "\.\/merge-pr\.js";$/m);
  const merge = src("merge-pr.js");
  assert.match(merge, /export default class MergePr\b/);
  assert.match(merge, /export class MergeMenu\b/);
  assert.match(merge, /kind:\s*"popup"[\s\S]*?view:\s*"merge-menu"/);
  assert.match(merge, /kind:\s*"dialog",\s*modal:\s*true[\s\S]*?view:\s*"merge-pr"/, "a click beside it doesn't close it");
  assert.match(merge, /\{\s*owner:\s*null\s*\}/, "the merge runs in a task no view owns: Esc can't cut it");
  assert.match(merge, /mergePullRequest\(/);
  assert.match(merge, /mergeReport\(/, "what it says comes from pr-card-model.js");
  assert.match(merge, /seenOf\(/, "the props are checked before anything is shown or sent");
  assert.doesNotMatch(merge, /"pr",\s*"merge"|pr merge|delete_branch|"DELETE"/, "never `gh pr merge` (it checks out the base), never a branch delete");
  assert.match(src("git.js"), /export const mergePullRequest = [\s\S]*?mergePr\(/, "git.js binds mergePr to exec");
  const card = src("pr-card.js");
  assert.match(card, /mergeRequest\(/, "the card hands the popup what it read");
  assert.match(card, /openMergeMenu\(/, "an enabled Mergear ▾ opens the popup");
});

test("D8: after a merge the dialog asks the tree for a PR round; the tree runs one, or one more after the one running; the card reads again when the tree's word changes", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const merge = src("merge-pr.js");
  assert.match(merge, /run\("projects\.refresh-prs"\)/);
  const tree = src("tree.js");
  assert.match(tree, /"refresh-prs":\s*\(\{ cx, view \}\) => view\?\.askPrs\?\.\(cx\)/, "a key command, run only in the tree copy");
  const ask = tree.slice(tree.indexOf("  askPrs("), tree.indexOf("\n  }\n", tree.indexOf("  askPrs(")));
  assert.match(ask, /if \(this\.prBusy\) \{\s*this\.prAgain = true;/, "a round in flight gets one more after it");
  const round = tree.slice(tree.indexOf("  refreshPrs("), tree.indexOf("\n  }\n", tree.indexOf("  refreshPrs(")));
  assert.match(round, /this\.prAgain = false;/, "a round started now covers what was asked before it");
  assert.match(round, /finally \{[\s\S]*?this\.prBusy = false;[\s\S]*?if \(this\.prAgain\)[\s\S]*?this\.refreshPrs\(/, "the queued round runs once this one ends");
  assert.match(src("main.js"), /handler\(\{ cx, copy, view: this\.view \}\)/, "the tree's commands reach the tree");
  const card = src("pr-card.js");
  assert.match(card, /store\.prs\(\)/, "the card follows the tree's stored PR for its workspace");
  for (const f of ["pr-card.js", "merge-pr.js"]) assert.doesNotMatch(src(f), /savePrs\(/, `${f}: the tree is the only writer of projects.prs.v1`);
});

test("S4: the card's Crear PR, on a branch without one, opens a modal dialog, a view of the mod; the create outlives it and asks the tree for a round (D4, D7, D8)", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const main = src("main.js");
  assert.match(main, /^\s+"create-pr":\s*CreatePr,$/m);
  assert.match(main, /^import CreatePr from "\.\/create-pr\.js";$/m);
  const dialog = src("create-pr.js");
  assert.match(dialog, /export default class CreatePr\b/);
  assert.match(dialog, /export function openCreatePr\(/);
  assert.match(dialog, /kind:\s*"dialog",\s*modal:\s*true[\s\S]*?view:\s*"create-pr"/, "a click beside it doesn't close it");
  assert.match(dialog, /\{\s*owner:\s*null\s*\}/, "the push and the create run in a task no view owns: Esc can't cut them");
  assert.match(dialog, /createPullRequest\(/);
  assert.match(dialog, /createReport\(/, "what it says comes from pr-card-model.js");
  assert.match(dialog, /createSeenOf\(/, "the props are checked before anything is shown or sent");
  assert.match(dialog, /run\("projects\.refresh-prs"\)/, "D8: the tree asks GitHub, so the sidebar and the card show the new PR");
  assert.match(dialog, /G\.createPrFacts\(/, "the title and whether to publish first, read when it opens");
  assert.match(dialog, /G\.baseExists\(/, "a saved base counts only when git has it (D37)");
  assert.match(dialog, /TextareaState\.new\(/, "the description takes several lines");
  assert.doesNotMatch(dialog, /savePrs\(/, "the tree is the only writer of projects.prs.v1");
  assert.doesNotMatch(dialog, /"pr",\s*"create"|pr create|--force/, "GitHub's REST create, never `gh pr create`; never a forced push");
  const git = src("git.js");
  assert.match(git, /export const createPullRequest = [\s\S]*?createPr\(/, "git.js binds createPr to exec");
  assert.match(git, /export const createPrFacts = [\s\S]*?readCreateFacts\(/, "and readCreateFacts");
  assert.match(git, /exec\("git", args, timeout \? \{ cwd, timeout \} : \{ cwd \}\)/, "a push may take longer than exec's 30 s");
  const card = src("pr-card.js");
  assert.match(card, /createRequest\(/, "the card hands the dialog what it read");
  assert.match(card, /openCreatePr\(/);
  assert.match(card, /"Crear PR"/);
});

test("projects layout: keep-awake's cup sits right before the moon, with no props so it runs the loop, and requires installs it (keep-awake D10)", () => {
  const cells = find(read("layouts/projects.json"), "status").children;
  assert.deepEqual(cells.at(-2), { id: "status-keep-awake", type: "block", size: { px: 64 }, content: { mod: "keep-awake" } });
  const requires = readFileSync(new URL("../projects-sidebar/requires", import.meta.url), "utf8");
  assert.ok(requires.split("\n").includes("keep-awake"));
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
  assert.match(dialog, /spaceRenames\(\{ path, before: r\.check\?\.branch, after: r\.branch,[\s\S]{0,120}run\("space\.rename", s\)/, "S39: the spaces named after the old branch take the new name");
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
  const statusMark = tree.slice(tree.indexOf("function statusMark("), tree.indexOf("function programIcon("));
  assert.ok(statusMark.length > 0, "statusMark is found");
  assert.doesNotMatch(statusMark, /\.spin\(/, "no spin() on the working mark: Herdr turns it at about 30 fps, which stutters");
  // The only spin() in the file turns a plugin badge's icon while it asks for it (spotlight D29: a short busy mark).
  assert.equal(tree.match(/\.spin\(/g)?.length, 1, "spin() appears once");
  assert.match(tree, /function badgeIcon\([^)]*\) \{[^}]*\.spin\(BADGE_SPIN\)/, "and it is badgeIcon's");
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
