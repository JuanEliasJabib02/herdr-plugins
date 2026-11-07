// T6, S1, S10: Names' "Find files" (code-explorer/names-model.js and main.js). Each
// word somewhere in the path, a tree with its folders open, an X to clear, and
// Orca's texts. The listing runs against real git and find on real files; main.js
// runs in a fake Herdr (`herdr`, `gpui-kit`, `gpui-base` resolve to stand-ins) with
// those same real programs behind its exec. How it looks stays with `herdr-app check`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DELETED_ARGS, FIND_SCRIPT, LIST_ARGS, LIST_CAP, buildNameIndex, dressRow, filterMessage, filteredRows, isListed, lastResult, pacer, parseFilter,
  parseLists, readFileList, sameLists,
} from "../code-editor/mods/code-explorer/names-model.js";
import { IGNORED_ARGS, buildFolderStatus } from "../code-editor/mods/code-explorer/git-model.js";
import { TEXT, compareEntries, visibleRows } from "../code-editor/mods/code-explorer/tree-model.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "code-explorer-names-")));
after(() => rmSync(base, { recursive: true, force: true }));

const NO_GIT = { marks: new Map(), folders: new Map(), ignored: new Set() };
const file = (path, over = {}) => ({ path, dir: false, ignored: false, ...over });
const breathe = async () => {};
const index = (paths) => buildNameIndex(paths.map((p) => (typeof p === "string" ? file(p) : p)), breathe);
const parsed = (lists) => parseLists({ deleted: "", ignored: "", ...lists }, breathe);
const rowsOf = async (query, paths, { git = NO_GIT, icons = null, ...over } = {}) => filteredRows({
  index: await index(paths), tokens: parseFilter(query).tokens, collapsed: new Set(), ignored: git.ignored, showDotfiles: true, showIgnored: true, ...over,
}).map((row) => dressRow(row, git, icons));
const pathsOf = async (...args) => (await rowsOf(...args)).map((r) => r.path);

// As Herdr's exec: rejects when it can't start, resolves with the code otherwise.
const realExec = (command, args = [], options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
function write(root, rel, text = "x\n") {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function makeRepo(name) {
  const root = join(base, name);
  mkdirSync(root);
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\n.env\nnode_modules/\n");
  for (const rel of ["README.md", "src/App.tsx", "src/app.test.ts", "src/util/Strings.js", "docs/README.md", ".github/ci.yml", ".vscode/settings.json", ".local/share/data.txt", ".local/keep.txt", "gone.txt"]) write(root, rel);
  git(root, "add", "-A", "-f");
  const inner = join(root, "sub");
  mkdirSync(inner);
  git(inner, "init", "-q");
  write(inner, "in-submodule.txt");
  git(inner, "add", "-A");
  git(inner, "commit", "-qm", "inner");
  git(root, "add", "sub");
  git(root, "commit", "-qm", "first");
  rmSync(join(root, "gone.txt"));
  for (const rel of ["dist/out.js", ".env", "node_modules/x/index.js", "untracked.txt", "a b.txt", "it's.txt", "-rf", "$(x)", "\"q\"", "ñandú.txt", ".herdr-app-write-abc"]) write(root, rel);
  git(root, "init", "-q", "nested");
  return root;
}

// A repo takes a few git commands to make: tests that only read it share this one.
let shared = null;
const sharedRepo = () => (shared ??= makeRepo("shared"));

// ── S1: each word somewhere in the path ────────────────────────────────────

test("S1: every word must be in the path, in any order, and folder names count", async () => {
  const paths = ["src/App.tsx", "src/util/Strings.js", "docs/README.md"];
  assert.deepEqual(await pathsOf("app", paths), ["src", "src/App.tsx"]);
  assert.deepEqual(await pathsOf("tsx src", paths), ["src", "src/App.tsx"], "any order");
  assert.deepEqual(await pathsOf("src", paths), ["src", "src/util", "src/util/Strings.js", "src/App.tsx"], "a folder's name matches all it holds");
  assert.deepEqual(await pathsOf("util str", paths), ["src", "src/util", "src/util/Strings.js"], "across segments");
  assert.deepEqual(await pathsOf("app docs", paths), [], "one word missing, no match");
});

test("S1: capitals don't matter, in the query or in the path", async () => {
  const paths = ["src/App.tsx", "README.md"];
  assert.deepEqual(await pathsOf("APP", paths), ["src", "src/App.tsx"]);
  assert.deepEqual(await pathsOf("readme", paths), ["README.md"]);
  assert.deepEqual(await pathsOf("ReAdMe.Md", paths), ["README.md"]);
  assert.deepEqual(await pathsOf("ÑANDÚ", ["ñandú.txt"]), ["ñandú.txt"]);
});

test("S1: it's a plain substring, as in Orca: no fuzzy match, no special characters", async () => {
  const paths = ["src/App.tsx", "a.b", "axb", "(x)"];
  assert.deepEqual(await pathsOf("sapp", paths), []);
  assert.deepEqual(await pathsOf("a.b", paths), ["a.b"]);
  assert.deepEqual(await pathsOf("(x", paths), ["(x)"]);
  assert.deepEqual(await pathsOf("*", paths), []);
});

test("S1: the query: any Unicode whitespace splits it, lower-cased; blank is no filter", () => {
  assert.deepEqual(parseFilter("Foo  BAR\tbaz qux　End"), { active: true, tooLarge: false, tokens: ["foo", "bar", "baz", "qux", "end"] });
  assert.deepEqual(parseFilter("  x  "), { active: true, tooLarge: false, tokens: ["x"] });
  assert.deepEqual(parseFilter(""), { active: false, tooLarge: false, tokens: [] });
  assert.deepEqual(parseFilter(" \t 　 "), { active: false, tooLarge: false, tokens: [] });
});

test("S1: a query over 2 KiB, in bytes, matches nothing and reads no list, as in Orca", () => {
  assert.deepEqual(parseFilter("a".repeat(2048)).tooLarge, false);
  assert.deepEqual(parseFilter("a".repeat(2049)), { active: true, tooLarge: true, tokens: [] });
  assert.equal(parseFilter("ñ".repeat(1024)).tooLarge, false, "2048 bytes");
  assert.equal(parseFilter(`ñ${"ñ".repeat(1024)}`).tooLarge, true, "2050 bytes in 1025 characters");
  assert.equal(parseFilter("😀".repeat(512)).tooLarge, false, "2048 bytes in 1024 UTF-16 units");
  assert.equal(parseFilter("😀".repeat(513)).tooLarge, true);
});

// ── S1: the tree, with its folders open ────────────────────────────────────

test("S1: a tree, not a flat list: every folder on the way open, indented by depth", async () => {
  const rows = await rowsOf("deep", ["a/b/c/deep.txt", "a/other.txt"]);
  assert.deepEqual(rows.map((r) => [r.path, r.name, r.depth, r.dir, r.enterable, r.open]), [
    ["a", "a", 0, true, true, true],
    ["a/b", "b", 1, true, true, true],
    ["a/b/c", "c", 2, true, true, true],
    ["a/b/c/deep.txt", "deep.txt", 3, false, false, false],
  ]);
});

test("S1: same order as the tree: folders first, then natural order", async () => {
  const paths = ["m/a10.js", "m/a2.js", "m/z/1.js", "m/B.js", "m/c/1.js", "top.js", "n/1.js"];
  assert.deepEqual(await pathsOf("", paths), [], "no words, nothing to show: main.js draws the tree instead");
  assert.deepEqual(await pathsOf("js", paths), ["m", "m/c", "m/c/1.js", "m/z", "m/z/1.js", "m/a2.js", "m/a10.js", "m/B.js", "n", "n/1.js", "top.js"]);
});

test("S1: a folder stays only if something below it matches", async () => {
  assert.deepEqual(await pathsOf("keep", ["a/keep.txt", "a/b/drop.txt", "c/drop.txt"]), ["a", "a/keep.txt"]);
});

test("S1: a chevron collapses that folder; the rest stay open, and it still shows while something below matches", async () => {
  const paths = ["a/x/one.js", "a/two.js", "b/three.js"];
  const collapsed = new Set(["a"]);
  const rows = await rowsOf("js", paths, { collapsed });
  assert.deepEqual(rows.map((r) => [r.path, r.open]), [["a", false], ["b", true], ["b/three.js", false]]);
  assert.equal(rows[0].enterable, true);
  assert.deepEqual(await pathsOf("nothing", paths, { collapsed }), [], "collapsed with nothing below: gone");
  assert.deepEqual(await pathsOf("js", paths, { collapsed: new Set(["a/x"]) }), ["a", "a/x", "a/two.js", "b", "b/three.js"]);
});

test("S1: the same rows as the tree: same fields, status letters, the folder's dominant status, the ignored look, icons", async () => {
  const marks = new Map([["src/App.tsx", "M"], ["src/new.ts", "U"]]);
  const git = { marks, folders: buildFolderStatus(marks), ignored: new Set(["src/skip.js", "built"]) };
  const icons = { icons: { file: "icons/file.svg", folder: "icons/folder.svg", "folder-open": "icons/folder-open.svg" }, fileExtensions: { tsx: "icons/react.svg" }, folderNames: { src: "icons/folder-src.svg" }, folderNamesExpanded: { src: "icons/folder-src-open.svg" } };
  const rows = await rowsOf("s", ["src/App.tsx", "src/new.ts", "src/skip.js", "built/s.js"], { git, icons });
  const by = new Map(rows.map((r) => [r.path, r]));
  assert.equal(by.get("src").status, "M");
  assert.equal(by.get("src").icon, "mods/code-explorer/icons/folder-src-open.svg");
  assert.equal(by.get("src/App.tsx").status, "M");
  assert.equal(by.get("src/App.tsx").icon, "mods/code-explorer/icons/react.svg");
  assert.equal(by.get("src/new.ts").status, "U");
  assert.equal(by.get("src/skip.js").ignored, true);
  assert.equal(by.get("built/s.js").ignored, true, "under an ignored folder");
  assert.equal(by.get("src/App.tsx").ignored, false);

  const [tree] = visibleRows({
    entries: new Map([["", [{ name: "a.js", dir: false, link: null }]]]), expanded: new Set(), git: NO_GIT, icons: null, showDotfiles: true, showIgnored: true, errors: new Map(),
  });
  assert.deepEqual(Object.keys(by.get("src/App.tsx")).sort(), Object.keys(tree).sort(), "main.js draws both with one row()");
});

test("S1: Show Dotfiles off drops a path with a dot segment anywhere; Show Git Ignored Files off drops what's ignored", async () => {
  const paths = [".env-a", ".github/a.yml", "src/.hidden/a.txt", "src/a.txt", "built/a.txt", file("dist-a", { dir: true, ignored: true }), file(".secret-a", { ignored: true })];
  const git = { ...NO_GIT, ignored: new Set(["built"]) };
  assert.deepEqual(await pathsOf("a", paths, { showDotfiles: false, git }), ["built", "built/a.txt", "dist-a", "src", "src/a.txt"]);
  assert.deepEqual(await pathsOf("a", paths, { showIgnored: false, git }), [".github", ".github/a.yml", "src", "src/.hidden", "src/.hidden/a.txt", "src/a.txt", ".env-a"]);
});

test("S1: a folder git names as a whole (ignored, a submodule, a nested repo) matches by its own path and can't be opened here", async () => {
  const rows = await rowsOf("dist", ["src/a.js", file("dist", { dir: true, ignored: true }), file("sub/dist", { dir: true })]);
  assert.deepEqual(rows.map((r) => [r.path, r.dir, r.enterable, r.open, r.ignored]), [
    ["dist", true, false, false, true],
    ["sub", true, true, true, false],
    ["sub/dist", true, false, false, false],
  ]);
});

// ── S10: the texts ─────────────────────────────────────────────────────────

test("S10: no results says \"No files match this filter\"; loading says nothing, for the spinner", () => {
  assert.equal(filterMessage({ loaded: true, rows: 0 }), "No files match this filter");
  assert.equal(filterMessage({ loaded: false, rows: 0 }), null);
  assert.equal(filterMessage({ loaded: true, rows: 3 }), null);
  assert.equal(filterMessage({ tooLarge: true, loaded: false, rows: 0 }), "No files match this filter");
  assert.equal(filterMessage({ loaded: true, error: "boom", rows: 0 }), "Could not load files for this workspace: boom");
});

// ── D7: the list ───────────────────────────────────────────────────────────

test("D7: the commands: git ls-files -co --exclude-standard, deleted aside, ignored with --directory, and they never write under .git", () => {
  for (const args of [LIST_ARGS, DELETED_ARGS, IGNORED_ARGS]) {
    assert.deepEqual(args.slice(0, 3), ["--no-optional-locks", "-c", "core.fsmonitor=false"]);
    assert.ok(args.includes("ls-files") && args.includes("-z"));
  }
  for (const flag of ["-c", "-o", "--exclude-standard", "-s"]) assert.ok(LIST_ARGS.slice(3).includes(flag), flag);
  assert.ok(DELETED_ARGS.includes("-d"));
  assert.match(FIND_SCRIPT, /^find \. /);
});

test("D7: a real repo: tracked, untracked and ignored come back, awkward names whole; what's deleted and what Orca prunes don't", async () => {
  const root = makeRepo("listing");
  const { files, limited } = await parsed(await readFileList(root, realExec));
  const by = new Map(files.map((f) => [f.path, f]));
  assert.equal(limited, false);
  for (const path of ["README.md", "src/App.tsx", "src/util/Strings.js", ".github/ci.yml", ".gitignore", ".local/keep.txt"]) assert.deepEqual(by.get(path), file(path), path);
  for (const path of ["untracked.txt", "a b.txt", "it's.txt", "-rf", "$(x)", "\"q\"", "ñandú.txt"]) assert.deepEqual(by.get(path), file(path), path);
  assert.deepEqual(by.get(".env"), file(".env", { ignored: true }));
  assert.deepEqual(by.get("dist"), file("dist", { dir: true, ignored: true }), "--directory: the ignored folder, not what's in it");
  assert.equal(by.has("dist/out.js"), false);
  assert.deepEqual(by.get("sub"), file("sub", { dir: true }), "a submodule is a folder, not a file to open");
  assert.equal(by.has("sub/in-submodule.txt"), false);
  assert.deepEqual(by.get("nested"), file("nested", { dir: true }), "a nested repo is a folder");
  assert.equal(by.has("gone.txt"), false, "tracked but deleted: not on disk");
  for (const path of ["node_modules", "node_modules/x/index.js", ".vscode/settings.json", ".local/share/data.txt", ".herdr-app-write-abc"]) assert.equal(by.has(path), false, path);
  assert.equal(files.some((f) => f.path.startsWith(".git/")), false);
});

test("D7: a staged removal whose file is back on disk is listed: only a missing file is deleted", async () => {
  const root = join(base, "back");
  mkdirSync(root);
  git(root, "init", "-q");
  write(root, "back.txt");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  git(root, "rm", "-q", "--cached", "back.txt");
  assert.equal((await parsed(await readFileList(root, realExec))).files.some((f) => f.path === "back.txt"), true);
});

test("D7: outside git: find, with the same prunes, and it doesn't walk through a link", async () => {
  const root = join(base, "plain"), away = join(base, "plain-away");
  for (const rel of ["a.txt", "src/b c.js", "node_modules/x/c.js", ".cache/d", ".local/share/e", ".local/f", ".vscode/g", ".git/h", "-rf", "$(x)"]) write(root, rel);
  write(away, "secret.txt");
  symlinkSync(away, join(root, "out"));
  symlinkSync(join(root, "a.txt"), join(root, "file-link"));
  const execs = [];
  const { files, limited } = await parsed(await readFileList(root, (command, args, options) => { execs.push(command); return realExec(command, args, options); }));
  assert.ok(execs.includes("git") && execs.includes("sh"), "git is tried first");
  assert.equal(limited, false);
  assert.deepEqual(files.map((f) => f.path).sort(), ["$(x)", "-rf", ".local/f", "a.txt", "file-link", "out", "src/b c.js"].sort());
  assert.ok(files.every((f) => !f.dir && !f.ignored));
});

test("D7: no git at all: find; find failing too rejects with what it said, or with what exec refused", async () => {
  const noGit = (command, args, options) => (command === "git" ? Promise.reject(new Error("git not found")) : realExec(command, args, options));
  const root = join(base, "no-git");
  write(root, "a.txt");
  assert.deepEqual((await parsed(await readFileList(root, noGit))).files, [file("a.txt")]);
  await assert.rejects(readFileList(join(base, "missing-folder"), realExec));
  await assert.rejects(readFileList(root, async (command) => (command === "git" ? { code: 128, stdout: "", stderr: "" } : { code: 2, stdout: "", stderr: " nope \n" })), /nope/);
});

test("D7: a pass that fails beside a good one costs only that pass", async () => {
  const root = makeRepo("half");
  const lists = await readFileList(root, (command, args, options) => (args.includes("-d") || args.includes("--directory") ? Promise.resolve({ code: 1, stdout: "junk\0", stderr: "" }) : realExec(command, args, options)));
  assert.equal(lists.deleted, "");
  assert.equal(lists.ignored, "");
  assert.ok((await parsed(lists)).files.some((f) => f.path === "README.md"));
});

test("D7: parseLists: a merge conflict's three stages are one path; a cut last entry is dropped and says so", async () => {
  const staged = (path, stage = 0, mode = "100644") => `${mode} 3c9a0f08d68d0d4b3d19fd401acf0004b72df44c ${stage}\t${path}\0`;
  assert.deepEqual(await parsed({ listed: staged("a.txt", 1) + staged("a.txt", 2) + staged("a.txt", 3) }), { files: [file("a.txt")], limited: false });
  assert.deepEqual((await parsed({ listed: `${staged("link", 0, "120000")}${staged("sub", 0, "160000")}plain\0tab\tname\0` })).files, [file("link"), file("sub", { dir: true }), file("plain"), file("tab\tname")]);
  assert.deepEqual(await parsed({ listed: "a\0b\0cu" }), { files: [file("a"), file("b")], limited: true });
  assert.deepEqual((await parsed({ listed: "./x/y\0" })).files, [file("x/y")], "find's ./");
  assert.deepEqual(await parsed({ listed: "" }), { files: [], limited: false });
});

test("D7: past Orca's cap the list stops and says so; exactly at it doesn't", async () => {
  const names = (n, prefix = "f") => Array.from({ length: n }, (_v, i) => `${prefix}${i}\0`).join("");
  const at = await parsed({ listed: names(LIST_CAP) });
  assert.equal(at.files.length, LIST_CAP);
  assert.equal(at.limited, false);
  const over = await parsed({ listed: names(LIST_CAP), ignored: names(1, "ignored") });
  assert.equal(over.files.length, LIST_CAP);
  assert.equal(over.limited, true);
  assert.equal((await parsed({ listed: names(LIST_CAP + 1) })).limited, true);
});

test("D7: what Orca never lists, at any depth", () => {
  for (const path of ["node_modules/a", "x/node_modules/a", ".git/config", ".next/a", "p/.nuxt/a", ".cache/a", ".stably/a", ".vscode/a", ".idea/a", ".yarn/a", ".pnpm-store/a", ".terraform/a", ".docker/a", ".husky/a", ".npm/a", ".npm-global/a", ".gvfs/a", ".local/share", ".local/share/a", "x/.local/share/a", ".herdr-app-write-1"]) assert.equal(isListed(path), false, path);
  for (const path of ["a.txt", ".local/a", ".localshare/a", "x.local/share/a", ".config/a", ".github/a", ".env", "node_modules2/a", ".vscode2/a"]) assert.equal(isListed(path), true, path);
});

test("D7: sameLists: only a change in what git or find said counts", () => {
  const lists = { listed: "a\0", deleted: "", ignored: "b\0" };
  assert.equal(sameLists(lists, { ...lists }), true);
  assert.equal(sameLists(null, lists), false);
  assert.equal(sameLists(lists, null), false);
  for (const key of ["listed", "deleted", "ignored"]) assert.equal(sameLists(lists, { ...lists, [key]: "c\0" }), false, key);
});

// ── The index: the slow part, once per list and never in one go ────────────

test("S1: the order is compareEntries', and a big folder is sorted in slices, breathing between them", async () => {
  const names = Array.from({ length: 4500 }, (_v, i) => `File${(i * 7919) % 4500}.js`);
  let breaths = 0;
  const built = await buildNameIndex([...names.map((n) => file(`big/${n}`)), file("big/inner/x.js")], async () => { breaths++; });
  const big = built.children[0];
  const expected = [{ name: "inner", dir: true }, ...names.map((name) => ({ name, dir: false }))].sort(compareEntries);
  assert.deepEqual(big.children.map((n) => n.name), expected.map((n) => n.name));
  assert.ok(breaths >= 4500 / 250, `breathed ${breaths} times`);
});

test("S1: many small folders breathe too, and so does reading a long list", async () => {
  let breaths = 0;
  const count = async () => { breaths++; };
  await buildNameIndex(Array.from({ length: 3000 }, (_v, i) => file(`d${i}/a.js`)), count);
  assert.ok(breaths >= 10, `breathed ${breaths} times`);
  breaths = 0;
  await parseLists({ listed: Array.from({ length: 3000 }, (_v, i) => `f${i}\0`).join(""), deleted: "", ignored: "" }, count);
  assert.ok(breaths >= 5, `breathed ${breaths} times`);
});

test("the pacer gives way only once the script has run a while, then starts counting again", async () => {
  let clock = 1000, pauses = 0;
  const breathe = pacer(async () => { pauses++; clock += 5; }, () => clock);
  await breathe();
  clock += 11;
  await breathe();
  assert.equal(pauses, 0, "a small repo never waits on a timer");
  clock += 1;
  await breathe();
  assert.equal(pauses, 1);
  await breathe();
  assert.equal(pauses, 1, "the time paused doesn't count");
  clock += 12;
  await breathe();
  assert.equal(pauses, 2);
});

test("the rows stay until an input changes: render runs on every setShared in the window", () => {
  let runs = 0;
  const rows = lastResult((a, b) => { runs++; return [a, b]; });
  const one = {}, two = {};
  const first = rows(one, two);
  assert.equal(rows(one, two), first);
  assert.equal(runs, 1);
  assert.notEqual(rows(two, two), first);
  assert.equal(runs, 2);
  rows(two, one);
  assert.equal(runs, 3);
});

// ── main.js, in a fake Herdr ───────────────────────────────────────────────

const HERDR = ["spaces", "panes", "focused", "exec", "readTextFile", "watchFolder", "theme", "shared", "setShared", "run", "notify", "nextCommand", "layout", "appHome", "home"];
const FAKES = {
  herdr: HERDR.map((n) => `export const ${n} = (...a) => globalThis.__ce.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__ce.el(n, ...a);
    export const div = k("div"), svg = k("svg"), image = k("image");
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__ce.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex");
    export const v_virtual_list = (...a) => globalThis.__ce.list(...a);
    export const Scrollbar = { vertical: (name) => globalThis.__ce.el("Scrollbar", name) };
    export const Input = { new: (s) => globalThis.__ce.el("Input", s) };
    export const InputState = { new: (o) => globalThis.__ce.newInput(o) };`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });

function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {} };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") args[0](self);
        else if (k === "on_mouse_down") t.handlers.mouse_down = args[1];
        else if (k.startsWith("on_")) t.handlers[k.slice(3)] = args[0];
        return self;
      };
    },
  });
  return self;
}
const isEl = (e) => typeof e === "object" && e !== null && Boolean(e.kids);
const find = (e, id) => {
  if (!isEl(e)) return null;
  if (e.calls.id?.[0] === id) return e;
  for (const k of e.kids) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
};
const findKind = (e, kind) => {
  if (!isEl(e)) return null;
  if (e.kind === kind) return e;
  for (const k of e.kids) {
    const hit = findKind(k, kind);
    if (hit) return hit;
  }
  return null;
};
const textOf = (e) => (typeof e === "string" ? e : isEl(e) ? e.kids.map(textOf).filter(Boolean).join(" ") : "");
const until = async (what, ok) => {
  for (let i = 0; i < 1000; i++) {
    if (ok()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail(`never happened: ${what}`);
};

const { default: CodeExplorer } = await import("../code-editor/mods/code-explorer/main.js");
const THEME = new Proxy({}, { get: (_t, k) => String(k) });

async function newWorld(root, { execFn = realExec, setValueFires = false } = {}) {
  const w = { root, execFn, execs: [], runs: [], shared: new Map(), waiters: [], watches: [], everys: [], lists: [], notifies: 0, input: null };
  const cx = {
    notify: () => { w.notifies++; },
    spawn: (f) => { Promise.resolve().then(() => f(cx)).catch((e) => { console.log(`task failed: ${e?.stack ?? e}`); }); },
    timer: { after: (_ms, f) => { setTimeout(() => f(cx), 0); }, every: (ms, f) => { w.everys.push(() => f(cx)); return { cancel() {} }; } },
    stop_propagation() {},
  };
  globalThis.__ce = {
    el,
    list: (id, count, size, key, draw) => { const list = el("list", id); list.rows = draw({ start: 0, end: count }); w.lists.push(id); return list; },
    newInput: (options) => {
      const input = {
        options, text: "", handlers: {}, value: () => input.text,
        set_value: (text) => { input.text = text; if (setValueFires) input.handlers.change?.({}, cx); },
        on: (event, handler) => { input.handlers[event] = handler; return true; },
      };
      w.input = input;
      return input;
    },
    spaces: () => [{ id: "s1", name: "space", active: true, machine: null, tabs: [{ id: "t1", index: 1, active: true, panes: 1 }, ...(w.extraTabs ?? [])] }],
    panes: () => [{ pane: "p1", tab: "t1", cwd: w.root }, ...(w.extraPanes ?? [])],
    focused: () => ({ pane: "p1" }),
    exec: (command, args, options) => { w.execs.push(args ?? []); return w.execFn(command, args, options); },
    readTextFile: async () => null,
    watchFolder: () => new Promise((resolve) => { w.watches.push(resolve); }),
    theme: () => THEME,
    shared: (key) => w.shared.get(key),
    setShared: (key, value) => { w.shared.set(key, value); },
    run: (name, args) => {
      w.runs.push([name, args]);
      if (name === "tab.new") { w.extraTabs = [{ id: "t2", index: 2, active: true, panes: 1 }]; w.extraPanes = [{ pane: "p2", tab: "t2", mod: "code-file" }]; }
      return null;
    },
    notify() {},
    nextCommand: () => new Promise((resolve) => { w.waiters.push(resolve); }),
    layout: () => null,
    appHome: () => "/no/app",
    home: () => "/no/home",
  };
  const view = new CodeExplorer();
  view.init({}, cx);
  Object.assign(w, {
    view, cx,
    draw: () => view.render(cx),
    snap: () => { view.render(cx); return view.snapshot(); },
    paths: () => w.snap().rows.map((r) => r.path),
    type: (text) => { w.input.text = text; w.input.handlers.change({}, cx); },
    send: async (raw) => {
      await until("the command loop", () => w.waiters.length > 0);
      w.waiters.shift()(raw);
      await new Promise(setImmediate);
    },
    listed: () => until("the list loaded", () => w.snap().listed?.loaded === true && !view.state.list.reading),
    idle: () => until("the tree loaded", () => w.snap().root && view.state.loaded && !view.loading && !view.settling),
    gitReads: () => w.execs.filter((args) => args.includes("ls-files") && args.includes("-s")).length,
  });
  await w.idle();
  return w;
}

const collapseEnabled = (w) => Boolean(find(w.draw(), "explorer-collapse").handlers.click);

test("S1: typing filters the tree to a tree of what matches; clearing brings the tree back as it was", async () => {
  const w = await newWorld(sharedRepo());
  const tree = w.paths();
  assert.ok(tree.includes("src") && !tree.includes("src/App.tsx"));
  w.type("app TSX");
  await w.listed();
  assert.deepEqual(w.paths(), ["src", "src/App.tsx"]);
  assert.deepEqual(w.snap().rows.map((r) => r.open), [true, false]);
  w.type("");
  assert.deepEqual(w.paths(), tree);
});

test("S1: typing further narrows at once, without reading the list again", async () => {
  const w = await newWorld(sharedRepo());
  w.type("s");
  await w.listed();
  const reads = w.gitReads();
  w.type("st");
  assert.ok(w.paths().includes("src/util/Strings.js"));
  w.type("strings");
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"]);
  assert.equal(w.gitReads(), reads);
});

test("S1: spaces alone are no filter: the tree shows and no list is read, and the X is there to clear them", async () => {
  const w = await newWorld(sharedRepo());
  const tree = w.paths();
  w.type("   ");
  assert.deepEqual(w.paths(), tree);
  assert.equal(w.gitReads(), 0);
  assert.ok(find(w.draw(), "explorer-clear-filter"));
});

test("S10: the input says \"Find files\", and the X \"Clear file filter\" only with something typed", async () => {
  const w = await newWorld(sharedRepo());
  assert.equal(w.input.options.placeholder, "Find files");
  assert.equal(find(w.draw(), "explorer-clear-filter"), null);
  w.type("x");
  const x = find(w.draw(), "explorer-clear-filter");
  assert.equal(x.calls.tooltip[0], "Clear file filter");
  assert.equal(x.calls.accessibility_label[0], "Clear file filter");
  await w.listed();
});

test("S1, S10: the X empties the input and the filter, as the clear-filter command does", async () => {
  const w = await newWorld(sharedRepo());
  const tree = w.paths();
  w.type("app");
  await w.listed();
  find(w.draw(), "explorer-clear-filter").handlers.click({}, w.cx);
  assert.equal(w.input.value(), "");
  assert.equal(w.snap().filter, "");
  assert.deepEqual(w.paths(), tree);

  w.type("app");
  await w.listed();
  await w.send("clear-filter");
  assert.equal(w.input.value(), "");
  assert.deepEqual(w.paths(), tree);
});

test("D2: filter:<text> does what typing does, spaces and colons included; set_value firing change or not", async () => {
  for (const setValueFires of [false, true]) {
    const w = await newWorld(sharedRepo(), { setValueFires });
    await w.send("code-explorer.filter:src tsx");
    await w.listed();
    assert.equal(w.input.value(), "src tsx");
    assert.equal(w.snap().filter, "src tsx");
    assert.deepEqual(w.paths(), ["src", "src/App.tsx"]);
    await w.send("filter:");
    assert.equal(w.input.value(), "");
    assert.equal(w.snap().filtering, false);
  }
  const w = await newWorld(makeRepo("colon"));
  write(w.root, "a:b.txt");
  await w.send("filter:a:b");
  await w.listed();
  assert.deepEqual(w.paths(), ["a:b.txt"]);
});

test("S10: nothing matches: the message, not the list and not a spinner", async () => {
  const w = await newWorld(sharedRepo());
  w.type("zzzzzz");
  await w.listed();
  const drawn = w.draw();
  assert.match(textOf(drawn), /No files match this filter/);
  assert.equal(findKind(drawn, "list"), null);
  assert.equal(w.snap().rows.length, 0);
});

test("S1: a query over 2 KiB reads nothing and matches nothing", async () => {
  const w = await newWorld(sharedRepo());
  w.type("a ".repeat(1100));
  assert.match(textOf(w.draw()), /No files match this filter/);
  assert.equal(w.gitReads(), 0);
  w.type("readme");
  await w.listed();
  assert.ok(w.paths().includes("README.md"), "back under the limit it reads");
});

test("S1: while the list loads: a spinner in the input and in the list, never what an earlier filter left", async () => {
  const root = makeRepo("loading");
  let hold = null;
  const held = (command, args, options) => (hold && args.includes("-s") ? hold.then(() => realExec(command, args, options)) : realExec(command, args, options));
  const w = await newWorld(root, { execFn: held });
  w.type("readme");
  await w.listed();
  assert.ok(w.paths().includes("README.md"));
  w.type("");
  rmSync(join(root, "README.md"));

  let release;
  hold = new Promise((resolve) => { release = resolve; });
  w.type("readme");
  const loading = w.draw();
  assert.deepEqual(w.snap().rows, []);
  assert.equal(findKind(loading, "list"), null);
  assert.doesNotMatch(textOf(loading), /No files match/);
  assert.ok(find(loading, "explorer-filter-loading"), "the input's spinner");
  release();
  hold = null;
  await w.listed();
  assert.equal(find(w.draw(), "explorer-filter-loading"), null);
  assert.deepEqual(w.paths(), ["docs", "docs/README.md"]);
});

test("S1: the list that can't load says so, with Retry, and Retry reads it again", async () => {
  const root = makeRepo("failing");
  let fail = false;
  const w = await newWorld(root, { execFn: (command, args, options) => (fail ? Promise.reject(new Error("nope")) : realExec(command, args, options)) });
  fail = true;
  w.type("readme");
  await w.listed();
  assert.match(textOf(w.draw()), /Could not load files for this workspace: nope/);
  fail = false;
  find(w.draw(), "explorer-retry").handlers.click({}, w.cx);
  await until("the retry", () => w.paths().includes("README.md"));
});

test("S1: a failed read keeps a list already on screen", async () => {
  const root = makeRepo("keeps");
  let fail = false;
  const w = await newWorld(root, { execFn: (command, args, options) => (fail && args?.includes("-s") ? Promise.reject(new Error("nope")) : realExec(command, args, options)) });
  w.type("readme");
  await w.listed();
  const reads = w.gitReads();
  fail = true;
  w.everys[0]();
  await until("the failed read", () => w.gitReads() > reads && !w.view.state.list.reading);
  assert.ok(w.paths().includes("README.md"));
  assert.equal(w.snap().listed.error, null);
});

test("S1: a click on a folder's chevron collapses it under the filter and leaves the tree's own open folders alone", async () => {
  const w = await newWorld(sharedRepo());
  await w.send("toggle:docs");
  await until("docs open", () => w.paths().includes("docs/README.md"));
  w.type("js");
  await w.listed();
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"]);
  await w.send("toggle:src");
  assert.deepEqual(w.snap().rows.map((r) => [r.path, r.open]), [["src", false]]);
  assert.deepEqual(w.snap().filterCollapsed, ["src"]);
  w.type("jsx");
  w.type("js");
  assert.deepEqual(w.paths(), ["src"], "typing keeps it collapsed");
  await w.send("toggle:src");
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"], "and the same click opens it");
  await w.send("toggle:src/util");
  w.type("");
  assert.deepEqual(w.snap().filterCollapsed, [], "emptying forgets it");
  assert.deepEqual(w.snap().expanded, ["docs"]);
  assert.ok(w.paths().includes("docs/README.md"));
  w.type("js");
  await w.listed();
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"]);
});

test("S1: a real click on a filtered row does what the command does", async () => {
  const w = await newWorld(sharedRepo());
  w.type("strings");
  await w.listed();
  const list = findKind(w.draw(), "list");
  list.handlers.item_click("src", w.cx);
  assert.deepEqual(w.paths(), ["src"]);
  list.handlers.item_click("src", w.cx);
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"]);
  findKind(w.draw(), "list").handlers.item_click("src/util/Strings.js", w.cx);
  await until("the tab", () => w.runs.some(([name]) => name === "tab.new"));
  const [, args] = w.runs.find(([name]) => name === "tab.new");
  assert.equal(args.mod, "code-file");
  assert.equal(args.props.file, join(w.root, "src/util/Strings.js"));
});

test("S1: a whole folder from git shows without a chevron, and a click does nothing, however it's asked", async () => {
  const w = await newWorld(sharedRepo());
  w.type("dist");
  await w.listed();
  const [row] = w.snap().rows;
  assert.deepEqual([row.path, row.dir, row.enterable, row.ignored], ["dist", true, false, true]);
  findKind(w.draw(), "list").handlers.item_click("dist", w.cx);
  await w.send("toggle:dist");
  await w.send("open:dist");
  assert.deepEqual(w.snap().filterCollapsed, []);
  assert.equal(w.runs.some(([name]) => name === "tab.new"), false);
});

test("S1: the filter draws from its own list, so the tree keeps its scroll", async () => {
  const w = await newWorld(sharedRepo());
  const treeList = findKind(w.draw(), "list");
  w.type("readme");
  await w.listed();
  const filterList = findKind(w.draw(), "list");
  assert.notEqual(filterList.arg, treeList.arg);
  assert.equal(filterList.rows.length, w.snap().rows.length);
  assert.ok(findKind(w.draw(), "Scrollbar").arg === filterList.arg);
  w.type("");
  assert.equal(findKind(w.draw(), "list").arg, treeList.arg);
});

test("S1: it keeps up with the disk: a watch batch, the timer and Refresh read the list again; what's unchanged isn't rebuilt", async () => {
  const w = await newWorld(makeRepo("fresh"));
  w.type("fresh");
  await w.listed();
  assert.deepEqual(w.paths(), []);

  write(w.root, "fresh-one.txt");
  w.watches.shift()([join(realpathSync(w.root), "fresh-one.txt")]);
  await until("the batch's new file", () => w.paths().includes("fresh-one.txt"));

  write(w.root, "fresh-two.txt");
  w.everys[0]();
  await until("the timer's new file", () => w.paths().includes("fresh-two.txt"));

  write(w.root, "fresh-three.txt");
  find(w.draw(), "explorer-refresh").handlers.click({}, w.cx);
  await until("Refresh's new file", () => w.paths().includes("fresh-three.txt"));

  await until("reads done", () => !w.view.state.list.reading);
  const index = w.view.state.list.index, reads = w.gitReads();
  w.everys[0]();
  await until("another read", () => w.gitReads() > reads && !w.view.state.list.reading && !w.view.loading);
  assert.equal(w.view.state.list.index, index);
});

test("S1: a change during a read reads again", async () => {
  const root = makeRepo("again");
  let hold = null;
  const w = await newWorld(root, { execFn: (command, args, options) => (hold && args.includes("-s") ? hold.then(() => realExec(command, args, options)) : realExec(command, args, options)) });
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  w.type("late");
  await until("the read to start", () => w.gitReads() > 0);
  write(root, "late.txt");
  w.everys[0]();
  await until("the tree's read", () => !w.view.loading && !w.view.settling);
  release();
  hold = null;
  await until("the second read", () => w.paths().includes("late.txt"));
});

test("S1: the Show toggles apply to the filter at once", async () => {
  const w = await newWorld(sharedRepo());
  await until("git marks", () => w.view.state.git);
  w.type(".");
  await w.listed();
  const shown = w.paths();
  assert.ok(shown.includes(".env") && shown.includes(".github"));
  await w.send("dotfiles");
  assert.ok(!w.paths().includes(".github"));
  assert.ok(!w.paths().includes(".env"));
  await w.send("dotfiles");
  assert.ok(w.paths().includes(".env"));
  await w.send("ignored");
  assert.ok(!w.paths().includes(".env"));
  assert.ok(w.paths().includes(".github"));
});

test("S1: a git mark moves under the filter, and the rows aren't rebuilt without a reason", async () => {
  const w = await newWorld(makeRepo("marks"));
  await until("git marks", () => w.view.state.git);
  w.type("readme");
  await w.listed();
  const rows = w.view.rows();
  w.draw();
  assert.equal(w.view.rows(), rows, "a render with nothing new walks nothing");
  write(w.root, "README.md", "changed\n");
  w.everys[0]();
  await until("the mark", () => w.snap().rows.find((r) => r.path === "README.md")?.status === "M");
});

test("S1: another space's folder: the text goes along, and the rows and collapsed folders are that root's", async () => {
  const first = makeRepo("root-one"), second = join(base, "root-two");
  write(second, "src/App-two.js");
  const w = await newWorld(first);
  w.type("app");
  await w.listed();
  await w.send("toggle:src");
  assert.deepEqual(w.snap().filterCollapsed, ["src"]);

  w.root = second;
  await until("the second root", () => w.snap().root === second);
  assert.deepEqual(w.snap().filterCollapsed, []);
  assert.deepEqual(w.snap().rows, [], "nothing of the first root while it reads");
  assert.equal(w.input.value(), "app");
  await until("its rows", () => w.paths().includes("src/App-two.js"));

  w.root = first;
  await until("the first root again", () => w.snap().root === first);
  assert.deepEqual(w.snap().rows, []);
  await until("its rows", () => w.paths().includes("src/App.tsx"));
});

test("S1: render never works the filter's rows out: Herdr interrupts a slow one, so what changes them does it first", async () => {
  const w = await newWorld(sharedRepo());
  await until("git marks", () => w.view.state.git);
  let last = null, inRender = false, computed = 0;
  const memo = w.view.filterRows;
  w.view.filterRows = (...now) => {
    if (inRender && (!last || now.some((value, i) => value !== last[i]))) computed++;
    last = now;
    return memo(...now);
  };
  const draw = () => { inRender = true; w.draw(); inRender = false; };
  w.type("s");
  draw();
  await until("the list", () => w.view.state.list?.loaded && !w.view.state.list.reading);
  draw();
  w.type("st");
  draw();
  await w.send("toggle:src");
  draw();
  await w.send("toggle:src");
  draw();
  await w.send("dotfiles");
  draw();
  await w.send("ignored");
  draw();
  w.everys[0]();
  await until("the timer's read", () => !w.view.loading && !w.view.settling && !w.view.state.list.reading);
  draw();
  assert.equal(computed, 0);
});

test("S1: a list past the cap says it searched only the first files", async () => {
  const w = await newWorld(sharedRepo(), {
    execFn: (command, args, options) => (args.includes("-s") ? Promise.resolve({ code: 0, stdout: Array.from({ length: LIST_CAP + 1 }, (_v, i) => `f${i}.txt\0`).join(""), stderr: "" }) : realExec(command, args, options)),
  });
  w.type("f19999");
  await w.listed();
  assert.equal(w.snap().listed.limited, true);
  assert.ok(textOf(w.draw()).includes(`first ${LIST_CAP} files`));
  assert.deepEqual(w.paths(), ["f19999.txt"]);
});

// ── What the change touches, pinned ────────────────────────────────────────

test("pin: without a filter the tree works as before: a folder opens lazily, a row opens its file, and Collapse All collapses", async () => {
  const w = await newWorld(sharedRepo());
  assert.equal(collapseEnabled(w), false);
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/App.tsx"));
  assert.deepEqual(w.snap().expanded, ["src"]);
  assert.equal(collapseEnabled(w), true);
  assert.equal(w.gitReads(), 0, "no filter, no file list");
  await w.send("open:src/App.tsx");
  await until("the tab", () => w.runs.some(([name]) => name === "tab.new"));
  await w.send("collapse-all");
  assert.deepEqual(w.snap().expanded, []);
});

test("pin: the timer and watch batches read no file list without a filter", async () => {
  const w = await newWorld(makeRepo("pin-quiet"));
  w.everys[0]();
  await until("the timer's read", () => !w.view.loading && !w.view.settling);
  write(w.root, "new.txt");
  w.watches.shift()([join(realpathSync(w.root), "new.txt")]);
  await until("the batch's read", () => w.paths().includes("new.txt"));
  assert.equal(w.gitReads(), 0);
});

test("S1: Collapse All is off under a filter, as in Orca, and back on after it", async () => {
  const w = await newWorld(sharedRepo());
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/App.tsx"));
  assert.equal(collapseEnabled(w), true);
  w.type("app");
  await w.listed();
  assert.equal(collapseEnabled(w), false);
  await w.send("collapse-all");
  assert.deepEqual(w.snap().expanded, ["src"]);
  w.type("   ");
  assert.equal(collapseEnabled(w), true, "spaces alone aren't a filter");
  w.type("");
  assert.equal(collapseEnabled(w), true);
});

test("S1: Contents hides the filter and keeps its text; back on Names it filters again, its collapsed folders forgotten", async () => {
  const w = await newWorld(sharedRepo());
  w.type("strings");
  await w.listed();
  await w.send("toggle:src");
  assert.deepEqual(w.paths(), ["src"]);
  await w.send("contents");
  const drawn = w.draw();
  assert.notEqual(findKind(drawn, "Input").arg, w.input, "the filter's input is Names'");
  assert.match(textOf(drawn), new RegExp(TEXT.typeToSearch));
  assert.equal(w.snap().filtering, false);
  const reads = w.gitReads();
  await w.send("names");
  assert.equal(w.input.value(), "strings");
  assert.deepEqual(w.paths(), ["src", "src/util", "src/util/Strings.js"]);
  await until("a fresh read", () => w.gitReads() > reads);
  await w.listed();
});

test("pin: every T4 command still answers", async () => {
  const w = await newWorld(sharedRepo());
  for (const raw of ["more", "more", "refresh", "dotfiles", "dotfiles", "ignored", "ignored", "names", "contents", "names"]) await w.send(raw);
  await until("the refresh", () => !w.view.loading && !w.view.settling);
  assert.equal(w.snap().view, "names");
  assert.equal(w.snap().menu, false);
});
