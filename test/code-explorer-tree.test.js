// T4: the Explorer's tree (code-explorer/tree-model.js): Orca's order, what it
// always hides, symlinks that leave the root, lazy rows, where a space's tree
// is rooted, what a batch of disk changes reloads, and the panel's texts. The
// listing runs against a real sh and real files, with awkward names.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL, TEXT, LIST_LIMIT, LIST_SCRIPT, batchPlan, compareEntries, compareNames, contentsMessage, indentOf, isDotfile,
  isDoubleClick, isHiddenName, isShown, listingLimited, locate, mergePlans, parseCommand, parseListing, pruneExpanded,
  toggleExpanded, treeMessage, visibleRows, holdsHome } from "../code-editor/mods/code-explorer/tree-model.js";
import { buildFolderStatus } from "../code-editor/mods/code-explorer/git-model.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "code-explorer-tree-")));
after(() => rmSync(root, { recursive: true, force: true }));
const list = (dir, rootReal = dir) => parseListing(execFileSync("sh", ["-c", LIST_SCRIPT, "code-explorer", dir], { encoding: "utf8" }), rootReal);

const entry = (name, dir = false, link = null) => ({ name, dir, link });
const NO_GIT = { marks: new Map(), folders: new Map(), ignored: new Set() };
const rowsOf = (over = {}) => visibleRows({
  entries: new Map(), expanded: new Set(), git: NO_GIT, icons: null, showDotfiles: true, showIgnored: true, errors: new Map(), ...over,
});

// ── S3: Orca's order ───────────────────────────────────────────────────────

test("S3: names sort like Orca's Intl.Collator('en', {numeric:true}) with its code-unit tie-break, by hand: Herdr's runtime has no Intl", () => {
  const collator = new Intl.Collator("en", { numeric: true });
  const orca = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  const names = [
    "a10", "a2", "a1", "a", "A", "B", "b", "Z", "z", "02", "2", "10", "1", ".env", ".github", "_x", "-rf", "a b", "a-b", "a_b", "a.b",
    "é", "e", "f", "E", "file2.txt", "file10.txt", "File1.txt", "README.md", "readme.md", "$(x)", "it's", "\"q\"", "ñu", "nu", "日本語", "100", "99", "a01", "a1b",
  ];
  assert.deepEqual([...names].sort(compareNames), [...names].sort(orca));
});

test("S1: folders come first, then natural order", () => {
  const sorted = [entry("b.txt"), entry("a10"), entry("z", true), entry("a2"), entry("c", true)].sort(compareEntries);
  assert.deepEqual(sorted.map((e) => e.name), ["c", "z", "a2", "a10", "b.txt"]);
});

// ── D23: what the tree always hides, and symlinks ──────────────────────────

test("D23: .git and node_modules are always hidden, at any depth, and so are Herdr's own write temporaries", () => {
  assert.equal(isHiddenName(".git"), true);
  assert.equal(isHiddenName("node_modules"), true);
  assert.equal(isHiddenName(".herdr-app-write-abc"), true);
  assert.equal(isHiddenName(".gitignore"), false);
  assert.equal(isHiddenName(".github"), false);
  assert.equal(isHiddenName("node_modules2"), false);
});

test("D23: a real listing: awkward names come through whole, .git and node_modules don't, folders first", () => {
  const dir = join(root, "names");
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  mkdirSync(join(dir, "src"));
  for (const name of ["a b", "it's", "-rf", "--help", "$(x)", "\"q\"", "ñandú.txt", ".env", "..odd", "line\nbreak"]) writeFileSync(join(dir, name), "");
  const rows = list(dir);
  assert.deepEqual(rows.map((e) => e.name).sort(), ["a b", "it's", "-rf", "--help", "$(x)", "\"q\"", "ñandú.txt", ".env", "..odd", "line\nbreak", "src"].sort());
  assert.equal(rows[0].name, "src");
  assert.equal(rows[0].dir, true);
  assert.ok(rows.slice(1).every((e) => !e.dir));
  assert.ok(rows.every((e) => e.link === null));
});

test("D23: a symlinked folder that leaves the root is never entered; one inside the root is; a link to a file or a dangling one is a file", () => {
  const dir = join(root, "links"), away = join(root, "away");
  mkdirSync(join(dir, "inner"), { recursive: true });
  mkdirSync(away, { recursive: true });
  writeFileSync(join(away, "secret.txt"), "");
  writeFileSync(join(dir, "real.txt"), "");
  symlinkSync(away, join(dir, "out"));
  symlinkSync(join(dir, "inner"), join(dir, "in"));
  symlinkSync("..", join(dir, "inner/up"));
  symlinkSync(join(dir, "real.txt"), join(dir, "file-link"));
  symlinkSync(join(away, "secret.txt"), join(dir, "file-out"));
  symlinkSync(join(dir, "missing"), join(dir, "dangling"));
  const listed = Object.fromEntries(list(dir).map((e) => [e.name, e]));
  assert.deepEqual(listed.out, entry("out", true, "outside"));
  assert.deepEqual(listed.in, entry("in", true, "inside"));
  assert.deepEqual(listed["file-link"], entry("file-link"));
  assert.deepEqual(listed["file-out"], entry("file-out"));
  assert.deepEqual(listed.dangling, entry("dangling"));

  const expanded = new Set(["out", "in"]);
  const entries = new Map([["", list(dir)], ["in", [entry("kid")]], ["out", [entry("secret.txt")]]]);
  const rows = rowsOf({ entries, expanded });
  assert.equal(rows.find((r) => r.path === "out").enterable, false);
  assert.equal(rows.find((r) => r.path === "out").open, false);
  assert.equal(rows.find((r) => r.path === "in").open, true);
  assert.ok(rows.some((r) => r.path === "in/kid"));
  assert.ok(!rows.some((r) => r.path === "out/secret.txt"), "what's behind the link stays out of the tree");
  // Measured against the root's real path, so a root reached through a link still knows.
  assert.equal(parseListing("d\0x\0/real/root/x\0", "/real/root")[0].link, "inside");
  assert.equal(parseListing("d\0x\0/real/rootless\0", "/real/root")[0].link, "outside");
  assert.equal(parseListing("d\0x\0?\0", "/real/root")[0].link, "outside");
});

test("D23: a listing that can't be read fails, an empty folder doesn't", () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.deepEqual(list(empty), []);
  assert.throws(() => execFileSync("sh", ["-c", LIST_SCRIPT, "code-explorer", join(root, "nope")], { stdio: "pipe" }));
});

test("a listing that reached the limit says so", () => {
  const many = Array.from({ length: LIST_LIMIT + 1 }, (_, i) => `f\0n${i}\0\0`).join("");
  assert.equal(listingLimited(many), true);
  assert.equal(listingLimited("f\0a\0\0"), false);
});

// ── S1: lazy rows ──────────────────────────────────────────────────────────

const TREE = new Map([
  ["", [entry("docs", true), entry("src", true), entry(".env"), entry("a.js")]],
  ["src", [entry("lib", true), entry("index.js")]],
  ["src/lib", [entry("deep.js")]],
  ["docs", [entry("guide.md")]],
]);

test("S1: only open folders show their children, nested, with Orca's indent", () => {
  const rows = rowsOf({ entries: TREE, expanded: new Set(["src", "src/lib"]) });
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [
    ["docs", 0], ["src", 0], ["src/lib", 1], ["src/lib/deep.js", 2], ["src/index.js", 1], [".env", 0], ["a.js", 0],
  ]);
  assert.equal(rows.find((r) => r.path === "docs").open, false);
  assert.equal(rows.find((r) => r.path === "src").open, true);
  assert.equal(indentOf(0), 8);
  assert.equal(indentOf(2), 40);
});

test("S1: a folder is expanded before its listing arrives: no children yet, no failure", () => {
  const rows = rowsOf({ entries: new Map([["", [entry("src", true)]]]), expanded: new Set(["src"]) });
  assert.deepEqual(rows.map((r) => r.path), ["src"]);
  assert.equal(rows[0].open, true);
});

test("S3: collapsing a folder keeps what's open inside it, like Orca's toggleDir, and opening it shows them again", () => {
  const opened = toggleExpanded(new Set(["src", "src/lib"]), "src");
  assert.deepEqual([...opened], ["src/lib"]);
  assert.deepEqual(rowsOf({ entries: TREE, expanded: opened }).map((r) => r.path), ["docs", "src", ".env", "a.js"]);
  assert.deepEqual([...toggleExpanded(opened, "src")].sort(), ["src", "src/lib"]);
});

test("S3: a folder that's gone from its parent's listing leaves the open set, with what was inside", () => {
  const entries = new Map([["", [entry("kept", true), entry("was-a-folder")]], ["kept", []], ["gone", []], ["gone/in", []]]);
  const { expanded, gone } = pruneExpanded(new Set(["kept", "gone", "gone/in", "was-a-folder"]), entries);
  assert.deepEqual([...expanded], ["kept"]);
  assert.deepEqual(gone.sort(), ["gone", "gone/in", "was-a-folder"]);
  // A parent not read yet says nothing about its child.
  assert.deepEqual([...pruneExpanded(new Set(["unread/x"]), new Map()).expanded], ["unread/x"]);
});

test("S3: Show Dotfiles off drops them, as Orca defines one: any segment longer than one character starting with a dot", () => {
  assert.equal(isDotfile(".env"), true);
  assert.equal(isDotfile("a/.b/c"), true);
  assert.equal(isDotfile("a/b.c"), false);
  assert.equal(isDotfile("."), false);
  assert.equal(isDotfile(".."), false);
  assert.deepEqual(rowsOf({ entries: TREE, showDotfiles: false }).map((r) => r.path), ["docs", "src", "a.js"]);
});

test("S1, S3: rows carry the git mark, the folder's dominant one, and ignored files go italic only without a status", () => {
  const marks = new Map([["src/index.js", "M"], ["a.js", "U"], ["docs/guide.md", "D"]]);
  const git = { marks, folders: buildFolderStatus(marks), ignored: new Set(["dist", "docs"]) };
  const entries = new Map([...TREE, ["", [...TREE.get(""), entry("dist", true)]], ["dist", [entry("out.js")]]]);
  const rows = rowsOf({ entries, git, expanded: new Set(["src", "dist", "docs"]) });
  const of = (path) => rows.find((r) => r.path === path);
  assert.equal(of("src/index.js").status, "M");
  assert.equal(of("src").status, "M");
  assert.equal(of("a.js").status, "U");
  assert.equal(of(".env").status, null);
  assert.equal(of("dist").ignored, true);
  assert.equal(of("dist/out.js").ignored, true, "inside an ignored folder counts too");
  assert.equal(of("docs/guide.md").status, "D");
  assert.equal(of("docs/guide.md").ignored, false, "a status wins over the ignored look");
  assert.equal(of("docs").status, null, "a deleted file doesn't reach its folder");
  // A submodule shows as one path, a folder with its own status.
  const sub = rowsOf({ entries: new Map([["", [entry("sub", true)]]]), git: { ...NO_GIT, marks: new Map([["sub", "M"]]) } });
  assert.equal(sub[0].status, "M");
});

test("S3: Show Git Ignored Files off drops ignored rows and what's under them", () => {
  const entries = new Map([["", [entry("dist", true), entry("a.js"), entry("b.log")]], ["dist", [entry("out.js")]]]);
  const git = { ...NO_GIT, ignored: new Set(["dist", "b.log"]) };
  assert.deepEqual(rowsOf({ entries, git, showIgnored: false, expanded: new Set(["dist"]) }).map((r) => r.path), ["a.js"]);
});

test("S5: a row names its Material icon: open and closed folders differ, a file goes by its name", () => {
  const icons = JSON.parse(readFileSync(new URL("../code-editor/mods/code-explorer/icons/theme.json", import.meta.url), "utf8"));
  const entries = new Map([["", [entry("src", true), entry("docs", true), entry("package.json")]], ["src", []]]);
  const rows = rowsOf({ entries, icons, expanded: new Set(["src"]) });
  assert.equal(rows.find((r) => r.path === "src").icon, "mods/code-explorer/icons/folder-src-open.svg");
  assert.equal(rows.find((r) => r.path === "docs").icon, "mods/code-explorer/icons/folder-docs.svg");
  assert.equal(rows.find((r) => r.path === "package.json").icon, "mods/code-explorer/icons/nodejs.svg");
});

test("a folder whose read failed carries its error on its row", () => {
  const rows = rowsOf({ entries: new Map([["", [entry("src", true)]]]), expanded: new Set(["src"]), errors: new Map([["src", "Permission denied"]]) });
  assert.equal(rows[0].error, "Permission denied");
});

// ── Where a space's tree is rooted ─────────────────────────────────────────

const space = (over = {}) => ({ id: "s1", name: "app", active: true, folder: "/code/app", machine: null, tabs: [{ id: "t1", active: true }, { id: "t2", active: false }], ...over });

test("the focused terminal's folder decides, as in Herdr's files panel", () => {
  const where = locate({
    spaces: [space()], focused: { space: "s1", tab: "t1", pane: "p1", terminal: "a", cwd: "/ignored" },
    panes: [{ pane: "p1", tab: "t1", terminal: "a", cwd: "/code/app/src" }],
  });
  assert.deepEqual(where, { space: "s1", name: "app", machine: null, live: "/code/app/src", cwd: "/code/app/src" });
});

test("a focused mod tab (an open file) has no folder: the tree stays where it was, so opening a file never moves it", () => {
  const input = {
    spaces: [space()], focused: { space: "s1", tab: "t2", pane: "p2", terminal: null, cwd: null },
    panes: [{ pane: "p1", tab: "t1", terminal: "a", cwd: "/code/app/first" }, { pane: "p2", tab: "t2", terminal: null, mod: "code-file", cwd: null }],
  };
  assert.equal(locate({ ...input, remembered: "/code/app/src" }).cwd, "/code/app/src");
  assert.equal(locate({ ...input, remembered: "/code/app/src" }).live, null);
  assert.equal(locate(input).cwd, "/code/app/first", "nothing remembered: the space's first terminal");
  assert.equal(locate({ ...input, panes: [input.panes[1]] }).cwd, "/code/app", "no terminal at all: the space's folder");
  assert.equal(locate({ ...input, panes: [], spaces: [space({ folder: "" })] }).cwd, null);
});

test("a terminal in another space never roots this space's tree", () => {
  const where = locate({
    spaces: [space()], focused: { space: "s1", tab: "t1", pane: null, terminal: null, cwd: null },
    panes: [{ pane: "x", tab: "other", terminal: "b", cwd: "/other" }],
  });
  assert.equal(where.cwd, "/code/app");
});

test("D21: a remote space, or a remote terminal block in focus, is remote; no active space is no location", () => {
  assert.equal(locate({ spaces: [space({ machine: "vps" })], focused: null, panes: [] }).machine, "vps");
  assert.equal(locate({ spaces: [space()], focused: { pane: null, terminal: "vps/t7", cwd: "/srv" }, panes: [] }).machine, "vps");
  assert.equal(locate({ spaces: [space()], focused: { pane: null, terminal: "t7", cwd: "/srv" }, panes: [] }).machine, null);
  assert.equal(locate({ spaces: [space({ active: false })], focused: null, panes: [] }), null);
  assert.equal(locate({ spaces: [], focused: null, panes: [] }), null);
});

// ── Reacting to the disk ───────────────────────────────────────────────────

const LOADED = new Set(["", "src", "src/lib"]);

test("a batch reloads only the folders it touched, and the git marks", () => {
  assert.deepEqual(batchPlan(["/r/src/a.js"], "/r", LOADED), { all: false, folders: ["src"], git: true });
  assert.deepEqual(batchPlan(["/r/a.js", "/r/src/lib/b.js"], "/r", LOADED), { all: false, folders: ["", "src/lib"], git: true });
  assert.deepEqual(batchPlan(["/r/closed/a.js"], "/r", LOADED), { all: false, folders: [], git: true }, "a closed folder has nothing on screen");
  assert.deepEqual(batchPlan(["/r/src/lib"], "/r", LOADED), { all: false, folders: ["src", "src/lib"], git: true }, "a folder itself: it and where it's listed");
});

test("a batch naming the root, or a path it can't place, reloads everything (herdr.d.ts: pending paths are bounded)", () => {
  assert.deepEqual(batchPlan(["/r"], "/r", LOADED), ALL);
  assert.deepEqual(batchPlan(["/r/a.js", "/r/"], "/r", LOADED), ALL);
  assert.deepEqual(batchPlan(["/elsewhere/a.js"], "/r", LOADED), ALL);
  assert.deepEqual(batchPlan(["/r/a.js"], null, LOADED), ALL);
  assert.deepEqual(batchPlan(["/rather/a.js"], "/r", LOADED), ALL);
});

test("D19: Herdr's write temporaries and node_modules churn reload nothing; .git only touches the marks", () => {
  assert.deepEqual(batchPlan(["/r/src/.herdr-app-write-1"], "/r", LOADED), { all: false, folders: [], git: false });
  assert.deepEqual(batchPlan(["/r/node_modules/x/y.js", "/r/pkg/node_modules/z"], "/r", LOADED), { all: false, folders: [], git: false });
  assert.deepEqual(batchPlan(["/r/.git/index"], "/r", LOADED), { all: false, folders: [], git: true });
});

test("plans merge while a load is running, so a burst costs one more load", () => {
  assert.deepEqual(mergePlans(null, { all: false, folders: ["a"], git: false }), { all: false, folders: ["a"], git: false });
  assert.deepEqual(mergePlans({ all: false, folders: ["a"], git: false }, { all: false, folders: ["b", "a"], git: true }), { all: false, folders: ["a", "b"], git: true });
  assert.deepEqual(mergePlans({ all: false, folders: ["a"], git: false }, ALL), ALL);
});

test("hidden copies don't poll: the Explorer shows only with the panel open on its child", () => {
  const tree = (hidden, active) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active }] }] });
  assert.equal(isShown(tree(false, "explorer")), true);
  assert.equal(isShown(tree(true, "explorer")), false);
  assert.equal(isShown(tree(false, "changes")), false);
  assert.equal(isShown({ id: "root", children: [] }), true, "another layout placing it has no such panel");
  assert.equal(isShown(null), true);
});

// ── D2: commands, clicks ───────────────────────────────────────────────────

test("D2: commands reach the same methods as clicks; a path keeps its dots and colons", () => {
  assert.deepEqual(parseCommand("open:src/a.test.js"), { name: "open", arg: "src/a.test.js" });
  assert.deepEqual(parseCommand("pin:a:b.js"), { name: "pin", arg: "a:b.js" });
  assert.deepEqual(parseCommand("code-explorer.toggle:src"), { name: "toggle", arg: "src" });
  assert.deepEqual(parseCommand("tree"), { name: "tree", arg: "" });
  assert.deepEqual(parseCommand("collapse-all"), { name: "collapse-all", arg: "" });
});

test("D11: a virtual list's click has no click_count: the same row twice inside the window is a double click", () => {
  assert.equal(isDoubleClick(null, "a", 1000), false);
  assert.equal(isDoubleClick({ path: "a", at: 1000 }, "a", 1300), true);
  assert.equal(isDoubleClick({ path: "a", at: 1000 }, "a", 1401), false);
  assert.equal(isDoubleClick({ path: "b", at: 1000 }, "a", 1100), false);
});

// ── S10: Orca's texts ──────────────────────────────────────────────────────

test("S10: Orca's Explorer texts, word for word", () => {
  assert.deepEqual(TEXT, {
    collapseAll: "Collapse All",
    refresh: "Refresh Explorer",
    more: "More Explorer Actions",
    showDotfiles: "Show Dotfiles",
    showIgnored: "Show Git Ignored Files",
    names: "Names",
    contents: "Contents",
    findFiles: "Find files",
    clearFilter: "Clear file filter",
    noMatches: "No files match this filter",
    noFiles: "No files in this workspace",
    noWorkspace: "Select a workspace to browse files",
    ignored: "Ignored by .gitignore",
    remote: "Explorer works on this computer only",
    noWorkspaceSearch: "Select a workspace to search",
    typeToSearch: "Type to search in files",
    loadFailed: "Could not load files for this workspace:",
    retry: "Retry",
  });
});

test("S10, D21: what the tree says when it has no rows", () => {
  const base = { hasFolder: true, remote: false, loaded: true, error: null, rows: 0 };
  assert.equal(treeMessage({ ...base, remote: true }), "Explorer works on this computer only");
  assert.equal(treeMessage({ ...base, hasFolder: false }), "Select a workspace to browse files");
  assert.equal(treeMessage({ ...base }), "No files in this workspace");
  assert.equal(treeMessage({ ...base, error: "gone" }), "Could not load files for this workspace: gone");
  assert.equal(treeMessage({ ...base, loaded: false }), null, "still loading: a spinner, no text");
  assert.equal(treeMessage({ ...base, rows: 3 }), null);
});

test("S11, D21: Contents says its empty text until T7 searches", () => {
  assert.equal(contentsMessage({ hasFolder: true, remote: false }), "Type to search in files");
  assert.equal(contentsMessage({ hasFolder: false, remote: false }), "Select a workspace to search");
  assert.equal(contentsMessage({ hasFolder: true, remote: true }), "Explorer works on this computer only");
});

// ── The mod itself ─────────────────────────────────────────────────────────

const MAIN = readFileSync(new URL("../code-editor/mods/code-explorer/main.js", import.meta.url), "utf8");

test("S5, D6: icons draw with image(), in color; the mod still docks nowhere on its own", () => {
  assert.match(MAIN, /image\(row\.icon\)/);
  assert.doesNotMatch(MAIN, /svg\(row\.icon\)/);
  assert.deepEqual(JSON.parse(readFileSync(new URL("../code-editor/mods/code-explorer/mod.json", import.meta.url), "utf8")), { place: "none" });
});

test("D2: every button and row has a command that runs the same method as its click", () => {
  for (const command of ["open", "pin", "toggle", "tree", "collapse-all", "refresh", "more", "dotfiles", "ignored", "names", "contents"]) {
    assert.ok(MAIN.includes(`"${command}":`) || new RegExp(`\\b${command}: \\(\\)`).test(MAIN), command);
  }
});

test("S1, D5: the panel uses theme() colors; the only hex colors in it are D5's git letters, kept in git-model.js", () => {
  assert.doesNotMatch(MAIN, /#[0-9a-fA-F]{3,8}\b/);
});

test("S6: the mod opens files only through the model's tab.new, never a split, never confirmed", () => {
  assert.doesNotMatch(MAIN, /pane\.split/);
  assert.doesNotMatch(MAIN, /confirmed/);
  assert.match(MAIN, /openFile\(/);
});

test("D22: the Explorer watches neither the home nor anything above it", () => {
  const home = "/Users/juan";
  for (const dir of ["/", "/Users", home]) assert.equal(holdsHome(dir, home), true, dir);
  for (const dir of [`${home}/repo`, "/Users/juana", "/tmp"]) assert.equal(holdsHome(dir, home), false, dir);
});
