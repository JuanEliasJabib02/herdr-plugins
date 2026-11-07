// T8, S13, S10: the Explorer's file operations (code-explorer/ops-model.js, file-menu.js,
// file-dialog.js and main.js). Every path here lives under one mkdtemp: mv, cp, mkdir
// and rm are the real programs, with a belt that fails the test before any of them
// touches a path outside it. `trash` and `open` are never run: they answer through
// `io`. Neither is the clipboard: `cx.write_to_clipboard` is a stand-in. How it looks
// stays with `herdr-app check`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPS, OP_KEY, checkName, checkPlace, checkTarget, clearPath, closeTabs, copyText, createPath, deleteForever, draftNames, duplicateFile, duplicateNames, entryTitle, fileMenuItems, findTabs,
  folderPattern, movedFolders, nameTaken, renamePath, renameSelection, renameTarget, reopenTabs, splitTarget, targetFolder, trashOffer, trashPath, unsavedChanges, withoutFolder,
} from "../code-editor/mods/code-explorer/ops-model.js";
import { gitGrepArgs } from "../code-editor/mods/code-explorer/search-model.js";
import { DOCS_KEY, LIVE_KEY } from "../code-editor/mods/code-explorer/tree-model.js";

// Before any test(): with a test registered ahead of this await, the root's after() can
// run, and take the temp folder, before the tests below it start.
const HERDR = ["spaces", "panes", "focused", "exec", "readTextFile", "writeTextFile", "watchFolder", "theme", "shared", "setShared", "run", "notify", "nextCommand", "layout", "appHome", "home", "props", "openOverlay", "closeOverlay"];
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
const { default: CodeExplorer } = await import("../code-editor/mods/code-explorer/main.js");

const base = realpathSync(mkdtempSync(join(tmpdir(), "code-explorer-ops-")));
after(() => {
  // A test leaves read-only folders behind it.
  execFileSync("/bin/chmod", ["-R", "u+rwx", base]);
  rmSync(base, { recursive: true, force: true });
});

let serial = 0;
function folderWith(files = {}) {
  const root = join(base, `r${++serial}`);
  mkdirSync(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    if (text === null) mkdirSync(join(root, rel), { recursive: true });
    else writeFileSync(join(root, rel), text);
  }
  return root;
}
const namesIn = (root, rel = "") => readdirSync(join(root, rel)).sort();
const isThere = (path) => { try { lstatSync(path); return true; } catch { return false; } };

const realExec = (command, args = [], options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

// The belt: what changes the disk only ever sees paths under this test's folder.
const WRITERS = new Set(["/bin/mv", "/bin/cp", "/bin/rm", "/bin/mkdir", "/usr/bin/trash"]);
function belted(command, args) {
  if (!WRITERS.has(command)) return;
  for (const arg of args) if (arg.startsWith("/")) assert.ok(arg.startsWith(`${base}/`), `${command} on ${arg}, outside the test's folder`);
}

// As the real one by default, on the test's folder only: the path goes, code 0.
const trashWorks = async (args) => {
  assert.equal(args[0], "-s");
  assert.equal(args.length, 2);
  assert.ok(args[1].startsWith(`${base}/`));
  rmSync(args[1], { recursive: true, force: true });
  return { code: 0, stdout: "", stderr: "" };
};

const writeNew = async (path, text, expected) => {
  assert.equal(expected, null, "D23: New File only ever creates");
  writeFileSync(path, text, { flag: "wx" });
  return null;
};

function diskIo(over = {}) {
  const { trash = trashWorks, intercept = () => null, ...rest } = over;
  const log = [];
  return {
    log,
    ran: (program) => log.filter(([command]) => command === program),
    exec: (command, args = [], options) => {
      log.push([command, ...args]);
      belted(command, args);
      if (command === "/usr/bin/trash") return trash(args);
      if (command === "/usr/bin/open") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      return intercept(command, args) ?? realExec(command, args, options);
    },
    writeTextFile: writeNew,
    readdir: (dir) => readdir(dir),
    appHome: () => join(base, "no-app-home"),
    spaces: () => [],
    panes: () => [],
    shared: () => undefined,
    ...rest,
  };
}

const NOTHING_CHANGED = ["/bin/mv", "/bin/cp", "/bin/rm", "/bin/mkdir", "/usr/bin/trash"];
const assertUntouched = (io) => { for (const program of NOTHING_CHANGED) assert.deepEqual(io.ran(program), [], `${program} ran`); };

// ── S13: the words ─────────────────────────────────────────────────────────

test("S13: every text, as Orca words it", () => {
  assert.equal(OPS.newFile, "New File");
  assert.equal(OPS.newFolder, "New Folder");
  assert.equal(OPS.copyPath, "Copy Path");
  assert.equal(OPS.copyRelativePath, "Copy Relative Path");
  assert.equal(OPS.duplicate, "Duplicate");
  assert.equal(OPS.openInTerminal, "Open in Terminal");
  assert.equal(OPS.collapseFolder, "Collapse Folder");
  assert.equal(OPS.findInFolder, "Find in Folder");
  assert.equal(OPS.reveal, "Reveal in Finder");
  assert.equal(OPS.rename, "Rename");
  assert.equal(OPS.delete, "Delete");
  assert.equal(OPS.deletePermanently, "Delete Permanently");
  assert.equal(nameTaken("a.js"), "A file or folder named 'a.js' already exists in this location");
  assert.equal(trashOffer("a.js"), "Couldn't move 'a.js' to the Trash. Delete it permanently?");
  assert.equal(unsavedChanges("a.js"), "\"a.js\" has unsaved changes");
});

test("S13, D23: a file's menu, in Orca's order, without Copy: only text fits write_to_clipboard, and that's Copy Path", () => {
  assert.deepEqual(fileMenuItems({ rel: "a.js", dir: false }).map((i) => i.label), [
    "New File", "New Folder", "Copy Path", "Copy Relative Path", "Duplicate", "Reveal in Finder", "Rename", "Delete",
  ]);
  assert.deepEqual(fileMenuItems({ rel: "a.js", dir: false }).filter((i) => i.separator).map((i) => i.id), ["copy-path", "rename"]);
  assert.deepEqual(fileMenuItems({ rel: "a.js", dir: false }).filter((i) => i.danger).map((i) => i.id), ["delete"]);
});

test("S13: a folder's menu has no Duplicate, and has Open in Terminal and Find in Folder; Collapse Folder only while open and with no filter", () => {
  const labels = (over) => fileMenuItems({ rel: "src", dir: true, ...over }).map((i) => i.label);
  assert.deepEqual(labels({ open: false }), ["New File", "New Folder", "Copy Path", "Copy Relative Path", "Open in Terminal", "Find in Folder", "Reveal in Finder", "Rename", "Delete"]);
  assert.ok(labels({ open: true }).includes("Collapse Folder"));
  assert.deepEqual(labels({ open: true }).slice(4, 7), ["Open in Terminal", "Collapse Folder", "Find in Folder"]);
  assert.ok(!labels({ open: true, filtering: true }).includes("Collapse Folder"), "as in Orca, hidden under a filter");
});

test("S13: empty space's menu has only New File and New Folder", () => {
  assert.deepEqual(fileMenuItems({ rel: "", dir: true }).map((i) => i.label), ["New File", "New Folder"]);
});

test("S13: Copy Path is absolute and Copy Relative Path isn't", () => {
  assert.equal(copyText("path", "/r/oot", "src/a b.js"), "/r/oot/src/a b.js");
  assert.equal(copyText("relative", "/r/oot", "src/a b.js"), "src/a b.js");
});

test("S13: the duplicate's name: <stem> copy<ext>, then copy 2, up to ten; a leading dot is no extension", () => {
  assert.deepEqual(duplicateNames("a.txt").slice(0, 3), ["a copy.txt", "a copy 2.txt", "a copy 3.txt"]);
  assert.equal(duplicateNames("a.txt").length, 10);
  assert.equal(duplicateNames("a.txt").at(-1), "a copy 10.txt");
  assert.equal(duplicateNames(".env")[0], ".env copy");
  assert.equal(duplicateNames("Makefile")[1], "Makefile copy 2");
  assert.equal(duplicateNames("a.tar.gz")[0], "a.tar copy.gz");
  assert.equal(duplicateNames(".env.local")[0], ".env copy.local");
});

test("S13: renaming selects the name before its extension, or all of it", () => {
  assert.deepEqual(renameSelection("a.test.js"), { start: 0, end: 6 });
  assert.deepEqual(renameSelection("Makefile"), { start: 0, end: 8 });
  assert.deepEqual(renameSelection(".env"), { start: 0, end: 4 });
  assert.deepEqual(renameSelection(".env.local"), { start: 0, end: 10 });
});

test("S13: what the entry says it's doing", () => {
  assert.equal(entryTitle({ kind: "file", folder: "" }), "New File");
  assert.equal(entryTitle({ kind: "folder", folder: "src/util" }), "New Folder in src/util");
  assert.equal(entryTitle({ kind: "file", folder: "src" }), "New File in src");
  assert.equal(entryTitle({ kind: "rename", rel: "src/a.js" }), "Rename a.js");
});

test("S13: a new file goes in the folder pressed, or beside the file pressed, or in the root", () => {
  assert.equal(targetFolder("src/util", true), "src/util");
  assert.equal(targetFolder("src/a.js", false), "src");
  assert.equal(targetFolder("a.js", false), "");
  assert.equal(targetFolder("", true), "");
});

test("Collapse Folder takes the folder and what's open inside; a rename carries them along", () => {
  const open = new Set(["src", "src/util", "src/util/deep", "srcs", "docs"]);
  assert.deepEqual([...withoutFolder(open, "src")], ["srcs", "docs"]);
  assert.deepEqual([...movedFolders(open, "src", "lib")], ["lib", "lib/util", "lib/util/deep", "srcs", "docs"]);
});

test("D2: a command's separator is one no path and no valid name can hold", () => {
  assert.deepEqual(splitTarget("src/a b.js"), { rel: "src/a b.js", name: null });
  assert.deepEqual(splitTarget("src/a:b.js//c:d.js"), { rel: "src/a:b.js", name: "c:d.js" });
  assert.deepEqual(splitTarget("a//b/c"), { rel: "a", name: "b/c" });
  assert.deepEqual(splitTarget(""), { rel: "", name: null });
});

// ── D23: the pure guards ───────────────────────────────────────────────────

test("D23: checkName trims, a blank cancels, and it refuses /, NUL, . and ..", () => {
  assert.deepEqual(checkName("  a b.js \n"), { name: "a b.js" });
  assert.deepEqual(checkName(""), { cancel: true });
  assert.deepEqual(checkName("   "), { cancel: true });
  for (const bad of ["a/b", "/", "a\0b", ".", "..", " .. "]) assert.ok(checkName(bad).error, JSON.stringify(bad));
});

const HOSTILE = ["a b", "it's", "-rf", "--help", "$(x)", "\"q\"", "ñandú"];

test("D23: the names worth testing are all valid names", () => {
  for (const name of [...HOSTILE, "..a", "a..", "...", "a\\b"]) assert.deepEqual(checkName(name), { name });
});

test("D23: checkTarget refuses the root, .git in any case and at any depth, and any real path out of the root", () => {
  const check = (rel, realpath = `/r/${rel}`) => checkTarget({ root: "/r", rel, realpath });
  for (const rel of ["", ".", "..", "../x", "a/../../x", "a/./b", "a/", "/a", "a//b", ".git", ".git/config", ".GIT/config", "sub/.git", "sub/.Git/x", "a\0b"]) assert.ok(check(rel), JSON.stringify(rel));
  assert.ok(check("link", "/r"), "a link to the root");
  assert.ok(check("link", "/elsewhere/x"), "out through a link");
  assert.ok(check("link", "/r2/x"), "a sibling that only starts like the root");
  assert.ok(check("link", "/r/.git/config"), "into .git through a link");
  assert.ok(check("gone", null), "nothing there");
  for (const rel of ["a", "a b/c", "-rf", ".github/x", ".gitignore", "git"]) assert.equal(check(rel), null, rel);
});

test("D23: the root is a place to create things in, and everything else follows checkTarget", () => {
  assert.equal(checkPlace({ root: "/r", rel: "", realpath: "/r" }), null);
  assert.equal(checkPlace({ root: "/r", rel: "src", realpath: "/r/src" }), null);
  assert.ok(checkPlace({ root: "/r", rel: ".git", realpath: "/r/.git" }));
  assert.ok(checkPlace({ root: "/r", rel: "out", realpath: "/elsewhere" }));
  assert.ok(checkPlace({ root: "/r", rel: "", realpath: "/elsewhere" }));
});

test("D23: renameTarget: the same text cancels, the blank too, and it tells a change of capitals only", () => {
  assert.deepEqual(renameTarget("src/a.js", "a.js"), { cancel: true });
  assert.deepEqual(renameTarget("src/a.js", "  a.js "), { cancel: true });
  assert.deepEqual(renameTarget("src/a.js", ""), { cancel: true });
  assert.deepEqual(renameTarget("src/a.js", "b.js"), { name: "b.js", rel: "src/b.js", caseOnly: false });
  assert.deepEqual(renameTarget("src/a.js", "A.js"), { name: "A.js", rel: "src/A.js", caseOnly: true });
  assert.deepEqual(renameTarget("a.js", "b.js"), { name: "b.js", rel: "b.js", caseOnly: false });
  assert.ok(renameTarget("a.js", "x/y").error);
});

// ── Rename, on real files ──────────────────────────────────────────────────

const on = (root, more = {}) => ({ root, real: root, ...more });

test("D23: renaming onto a file refuses, in Orca's words, and both stay as they were", async () => {
  const root = folderWith({ a: "A", b: "B" }), io = diskIo();
  const result = await renamePath(on(root, { rel: "a", raw: "b" }), io);
  assert.deepEqual(result, { status: "error", error: nameTaken("b") });
  assert.equal(readFileSync(join(root, "a"), "utf8"), "A");
  assert.equal(readFileSync(join(root, "b"), "utf8"), "B");
  assert.deepEqual(io.ran("/bin/mv"), []);
});

test("D23: renaming onto a folder refuses too, and doesn't move it inside", async () => {
  const root = folderWith({ a: "A", "d/x": "X" }), io = diskIo();
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "d" }), io), { status: "error", error: nameTaken("d") });
  assert.deepEqual(namesIn(root, "d"), ["x"]);
  assert.ok(isThere(join(root, "a")));
});

test("D23: a broken link holds its name: `-e` alone wouldn't see it", async () => {
  const root = folderWith({ a: "A" });
  symlinkSync("nowhere", join(root, "l"));
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "l" }), diskIo()), { status: "error", error: nameTaken("l") });
  assert.equal(readlinkSync(join(root, "l")), "nowhere");
});

test("D23: a free name moves it, with `mv -n`, and the state says it worked", async () => {
  const root = folderWith({ "src/a.js": "A" }), io = diskIo();
  const result = await renamePath(on(root, { rel: "src/a.js", raw: " b.js " }), io);
  assert.deepEqual(result, { status: "ok", rel: "src/b.js", abs: join(root, "src/b.js"), tabs: [] });
  assert.deepEqual(namesIn(root, "src"), ["b.js"]);
  assert.equal(readFileSync(join(root, "src/b.js"), "utf8"), "A");
  assert.deepEqual(io.ran("/bin/mv"), [["/bin/mv", "-n", "--", join(root, "src/a.js"), join(root, "src/b.js")]]);
});

test("D23: the same text does nothing, and starts nothing", async () => {
  const root = folderWith({ a: "A" }), io = diskIo();
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "a" }), io), { status: "cancel" });
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "  " }), io), { status: "cancel" });
  assert.deepEqual(io.log, []);
});

test("D23: a change of capitals only renames, and its success is read from the folder's listing", async () => {
  const root = folderWith({ foo: "F", other: "O" }), io = diskIo();
  const result = await renamePath(on(root, { rel: "foo", raw: "Foo" }), io);
  assert.equal(result.status, "ok");
  assert.equal(result.rel, "Foo");
  assert.deepEqual(namesIn(root), ["Foo", "other"]);
  assert.equal(readFileSync(join(root, "Foo"), "utf8"), "F");
});

test("D23: on a volume where foo and FOO are two files, a change of capitals onto the other is a name taken", async () => {
  // `-ef` follows links, so a link FOO → foo passes it: the listing is what tells.
  const root = folderWith({ foo: "F" }), io = diskIo({
    intercept: (command, args) => {
      if (command === "/bin/sh" && args[1].includes("-ef")) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      if (command === "/bin/ls") return Promise.resolve({ code: 0, stdout: ".\n..\nFOO\nfoo\n", stderr: "" });
      if (command === "/bin/sh" && args[3].endsWith("/FOO")) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      return null;
    },
  });
  assert.deepEqual(await renamePath(on(root, { rel: "foo", raw: "FOO" }), io), { status: "error", error: nameTaken("FOO") });
  assert.deepEqual(io.ran("/bin/mv"), []);
});

test("D23: `-ef` alone isn't enough: a link to the file isn't the file, and renaming onto it would flatten it", async () => {
  const root = folderWith({ a: "A" });
  symlinkSync("a", join(root, "link"));
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "link" }), diskIo()), { status: "error", error: nameTaken("link") });
  assert.equal(readlinkSync(join(root, "link")), "a");
  assert.equal(readFileSync(join(root, "a"), "utf8"), "A");
});

test("D23: mv that says yes and did nothing is the error; the state decides", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({
    intercept: (command) => (command === "/bin/mv" ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : null),
  });
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "b" }), io), { status: "error", error: "Failed to rename 'a'." });
});

test("D23: mv that exec stopped, with the state still old, is the error", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({
    intercept: (command) => (command === "/bin/mv" ? Promise.reject(new Error("timed out")) : null),
  });
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "b" }), io), { status: "error", error: "Failed to rename 'a'." });
});

test("D23: a folder renames with what it holds", async () => {
  const root = folderWith({ "d/x/y": "Y" });
  assert.equal((await renamePath(on(root, { rel: "d", raw: "e" }), diskIo())).status, "ok");
  assert.equal(readFileSync(join(root, "e/x/y"), "utf8"), "Y");
  assert.ok(!isThere(join(root, "d")));
});

test("D23: nothing is ever named .git", async () => {
  const root = folderWith({ a: "A", "d/x": "X" }), io = diskIo();
  assert.equal((await renamePath(on(root, { rel: "a", raw: ".git" }), io)).status, "error");
  assert.equal((await renamePath(on(root, { rel: "a", raw: ".GIT" }), io)).status, "error");
  assert.equal((await createPath(on(root, { folder: "d", raw: ".git", kind: "folder" }), io)).status, "error");
  assertUntouched(io);
});

// ── New File and New Folder ────────────────────────────────────────────────

test("S13: New File creates an empty one, through writeTextFile(path, \"\", null)", async () => {
  const root = folderWith({ "src/keep": "K" });
  const writes = [];
  const io = diskIo({ writeTextFile: (...args) => { writes.push(args); return writeNew(...args); } });
  const result = await createPath(on(root, { folder: "src", raw: " b.js ", kind: "file" }), io);
  assert.deepEqual(result, { status: "ok", rel: "src/b.js", abs: join(root, "src/b.js") });
  assert.deepEqual(writes, [[join(root, "src/b.js"), "", null]]);
  assert.equal(readFileSync(join(root, "src/b.js"), "utf8"), "");
});

test("S13: New File and New Folder in the root", async () => {
  const root = folderWith();
  assert.equal((await createPath(on(root, { folder: "", raw: "f", kind: "file" }), diskIo())).rel, "f");
  assert.equal((await createPath(on(root, { folder: "", raw: "d", kind: "folder" }), diskIo())).rel, "d");
  assert.deepEqual(namesIn(root), ["d", "f"]);
  assert.ok(statSync(join(root, "d")).isDirectory());
});

test("S13: a name in use stops New File and New Folder before anything's written: a file, a folder or a broken link", async () => {
  const root = folderWith({ f: "F", "d/x": "X" });
  symlinkSync("nowhere", join(root, "l"));
  for (const kind of ["file", "folder"]) {
    for (const name of ["f", "d", "l"]) {
      const io = diskIo({ writeTextFile: () => assert.fail("wrote") });
      assert.deepEqual(await createPath(on(root, { folder: "", raw: name, kind }), io), { status: "error", error: nameTaken(name) }, `${kind} ${name}`);
      assertUntouched(io);
    }
  }
  assert.equal(readFileSync(join(root, "f"), "utf8"), "F");
});

test("S13: a blank name cancels, and a bad one says so; neither touches the disk", async () => {
  const root = folderWith(), io = diskIo();
  assert.deepEqual(await createPath(on(root, { folder: "", raw: "  ", kind: "file" }), io), { status: "cancel" });
  assert.equal((await createPath(on(root, { folder: "", raw: "a/b", kind: "file" }), io)).status, "error");
  assert.equal((await createPath(on(root, { folder: "", raw: "..", kind: "folder" }), io)).status, "error");
  assert.deepEqual(io.log, []);
  assert.deepEqual(namesIn(root), []);
});

test("D23: New Folder is mkdir without -p: a missing parent is the error, and nothing is made on the way", async () => {
  const root = folderWith(), io = diskIo();
  const result = await createPath(on(root, { folder: "no/such", raw: "d", kind: "folder" }), io);
  assert.equal(result.status, "error");
  assert.deepEqual(namesIn(root), []);
  assert.deepEqual(io.ran("/bin/mkdir"), []);
  const made = diskIo();
  await createPath(on(root, { folder: "", raw: "-rf", kind: "folder" }), made);
  assert.deepEqual(made.ran("/bin/mkdir"), [["/bin/mkdir", join(root, "-rf")]]);
});

test("S13: a name taken between the check and the write says it's taken", async () => {
  const root = folderWith();
  const io = diskIo({
    writeTextFile: async (path) => { writeFileSync(path, "theirs"); throw new Error("The file changed outside Herdr."); },
  });
  assert.deepEqual(await createPath(on(root, { folder: "", raw: "f", kind: "file" }), io), { status: "error", error: nameTaken("f") });
  assert.equal(readFileSync(join(root, "f"), "utf8"), "theirs");
});

test("S13: a failed write that left nothing is Orca's failure", async () => {
  const root = folderWith();
  const io = diskIo({ writeTextFile: async () => { throw new Error("No space left"); } });
  assert.deepEqual(await createPath(on(root, { folder: "", raw: "f", kind: "file" }), io), { status: "error", error: "Failed to create 'f'." });
});

test("D23: nowhere outside the root, or in .git, is a place to create", async () => {
  const outside = folderWith({ keep: "K" }), root = folderWith();
  mkdirSync(join(root, ".git"));
  symlinkSync(outside, join(root, "out"));
  for (const folder of ["out", ".git", "..", "../x", "out/x"]) {
    const io = diskIo({ writeTextFile: () => assert.fail("wrote") });
    for (const kind of ["file", "folder"]) assert.equal((await createPath(on(root, { folder, raw: "new", kind }), io)).status, "error", `${kind} in ${folder}`);
    assertUntouched(io);
  }
  assert.deepEqual(namesIn(outside), ["keep"]);
});

// ── Duplicate ──────────────────────────────────────────────────────────────

test("S13: Duplicate: <stem> copy<ext>, the same bytes and mode, then copy 2", async () => {
  const root = folderWith({ "src/a.sh": "#!/bin/sh\n" });
  chmodSync(join(root, "src/a.sh"), 0o755);
  const first = await duplicateFile(on(root, { rel: "src/a.sh" }), diskIo());
  assert.deepEqual(first, { status: "ok", rel: "src/a copy.sh" });
  assert.equal(readFileSync(join(root, "src/a copy.sh"), "utf8"), "#!/bin/sh\n");
  assert.equal(statSync(join(root, "src/a copy.sh")).mode & 0o777, 0o755);
  assert.equal((await duplicateFile(on(root, { rel: "src/a.sh" }), diskIo())).rel, "src/a copy 2.sh");
  assert.deepEqual(namesIn(root, "src"), ["a copy 2.sh", "a copy.sh", "a.sh"]);
});

test("D23: Duplicate copies with cp -pPn, and a link stays a link", async () => {
  const root = folderWith({ a: "A" }), io = diskIo();
  symlinkSync("a", join(root, "l"));
  await duplicateFile(on(root, { rel: "l" }), io);
  assert.equal(readlinkSync(join(root, "l copy")), "a");
  assert.deepEqual(io.ran("/bin/cp"), [["/bin/cp", "-pPn", "--", join(root, "l"), join(root, "l copy")]]);
});

test("D23: a candidate in use is passed over and never written, a broken link included", async () => {
  const root = folderWith({ a: "A", "a copy": "theirs" });
  symlinkSync("nowhere", join(root, "a copy 2"));
  assert.equal((await duplicateFile(on(root, { rel: "a" }), diskIo())).rel, "a copy 3");
  assert.equal(readFileSync(join(root, "a copy"), "utf8"), "theirs");
  assert.equal(readlinkSync(join(root, "a copy 2")), "nowhere");
});

test("D23: a candidate taken between the check and the copy goes on to the next", async () => {
  const root = folderWith({ a: "A" });
  let raced = false;
  const io = diskIo({
    intercept: (command, args) => {
      if (command === "/bin/cp" && !raced) { raced = true; writeFileSync(args[3], "theirs"); }
      return null;
    },
  });
  assert.equal((await duplicateFile(on(root, { rel: "a" }), io)).rel, "a copy 2");
  assert.equal(readFileSync(join(root, "a copy"), "utf8"), "theirs");
});

test("D23: past ten names it gives up, and touches none of them", async () => {
  const names = duplicateNames("a");
  const root = folderWith(Object.fromEntries([["a", "A"], ...names.map((name) => [name, "theirs"])]));
  const io = diskIo();
  assert.deepEqual(await duplicateFile(on(root, { rel: "a" }), io), { status: "error", error: "Failed to duplicate 'a'." });
  assert.deepEqual(io.ran("/bin/cp"), []);
});

test("D23: a copy that failed and left nothing is the failure, not nine more tries", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({
    intercept: (command) => (command === "/bin/cp" ? Promise.resolve({ code: 1, stdout: "", stderr: "denied" }) : null),
  });
  assert.deepEqual(await duplicateFile(on(root, { rel: "a" }), io), { status: "error", error: "Failed to duplicate 'a'." });
  assert.equal(io.ran("/bin/cp").length, 1);
});

test("D23: a copy cmp doesn't confirm is the failure, and what's there stays: it may be someone's", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({
    intercept: (command) => (command === "/usr/bin/cmp" ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : null),
  });
  assert.deepEqual(await duplicateFile(on(root, { rel: "a" }), io), { status: "error", error: "Failed to duplicate 'a'." });
  assert.ok(isThere(join(root, "a copy")));
});

test("S13: Duplicate is for files only", async () => {
  const root = folderWith({ "d/x": "X" }), io = diskIo();
  assert.equal((await duplicateFile(on(root, { rel: "d" }), io)).status, "error");
  assert.deepEqual(io.ran("/bin/cp"), []);
});

// ── The names D23 names, through everything ────────────────────────────────

test("D23: every hostile name is one argument through create, rename, duplicate and delete", async () => {
  for (const name of HOSTILE) {
    const root = folderWith();
    const io = diskIo();
    assert.equal((await createPath(on(root, { folder: "", raw: name, kind: "file" }), io)).status, "ok", `create ${name}`);
    assert.deepEqual(namesIn(root), [name]);
    assert.equal((await duplicateFile(on(root, { rel: name }), io)).status, "ok", `duplicate ${name}`);
    assert.equal(namesIn(root).length, 2);
    const moved = `${name}2`;
    assert.equal((await renamePath(on(root, { rel: name, raw: moved }), io)).status, "ok", `rename ${name}`);
    assert.ok(isThere(join(root, moved)));
    assert.equal((await trashPath(on(root, { rel: moved }), io)).status, "ok", `delete ${name}`);
    assert.ok(!isThere(join(root, moved)));
    assert.equal((await createPath(on(root, { folder: "", raw: name, kind: "folder" }), io)).status, "ok", `folder ${name}`);
    assert.equal((await deleteForever(on(root, { rel: name }), io)).status, "ok", `delete permanently ${name}`);
    assert.ok(!isThere(join(root, name)));
    assert.ok(!existsSync(join(root, "x")), "$(x) ran nothing");
  }
});

// ── The guards, as the operations meet them ────────────────────────────────

test("D23: rename, duplicate, Trash and rm refuse what the guards refuse, and no program that changes anything runs", async () => {
  const outside = folderWith({ keep: "K" });
  const root = folderWith({ ".git/config": "C", "d/x": "X", "a": "A" });
  symlinkSync(outside, join(root, "out"));
  symlinkSync(join(outside, "keep"), join(root, "outfile"));
  symlinkSync(".git/config", join(root, "togit"));
  symlinkSync(root, join(root, "toroot"));
  for (const rel of ["", ".", "..", "../x", "d/../..", ".git", ".git/config", ".GIT/config", "out", "out/keep", "outfile", "togit", "toroot", "d/", "/etc/hosts", "missing"]) {
    const io = diskIo();
    for (const run of [
      (req) => renamePath({ ...req, raw: "zz" }, io), (req) => duplicateFile(req, io), (req) => trashPath(req, io), (req) => deleteForever(req, io),
    ]) assert.equal((await run(on(root, { rel }))).status, "error", JSON.stringify(rel));
    assertUntouched(io);
  }
  assert.deepEqual(namesIn(outside), ["keep"]);
  assert.equal(readFileSync(join(root, ".git/config"), "utf8"), "C");
});

test("D23: a link that stays inside can be acted on, and only the link moves", async () => {
  const root = folderWith({ a: "A" });
  symlinkSync("a", join(root, "l"));
  assert.equal((await renamePath(on(root, { rel: "l", raw: "m" }), diskIo())).status, "ok");
  assert.equal(readlinkSync(join(root, "m")), "a");
  assert.equal(readFileSync(join(root, "a"), "utf8"), "A");
});

test("D23: a broken link has no real path of its own; its folder's decides, so it can still be deleted", async () => {
  const root = folderWith();
  symlinkSync("nowhere", join(root, "l"));
  assert.equal((await trashPath(on(root, { rel: "l" }), diskIo())).status, "ok");
  assert.ok(!isThere(join(root, "l")));
});

test("D23: a root reached through a link is measured by its real path", async () => {
  const real = folderWith({ a: "A" }), link = join(base, `alias${++serial}`);
  symlinkSync(real, link);
  const result = await renamePath({ root: link, real, rel: "a", raw: "b" }, diskIo());
  assert.equal(result.status, "ok");
  assert.deepEqual(namesIn(real), ["b"]);
});

// ── Delete: Trash's four outcomes, through a fake trash ────────────────────

test("D23: Trash, gone afterwards: success, with an absolute path as the one argument", async () => {
  const root = folderWith({ "src/a": "A" }), io = diskIo();
  const result = await trashPath(on(root, { rel: "src/a" }), io);
  assert.deepEqual(result, { status: "ok", name: "a", tabs: [] });
  assert.deepEqual(io.ran("/usr/bin/trash"), [["/usr/bin/trash", "-s", join(root, "src/a")]]);
});

test("D23: Trash, still there with a failing code: the offer, and nothing deleted", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({ trash: async () => ({ code: 1, stdout: "", stderr: "nope" }) });
  assert.deepEqual(await trashPath(on(root, { rel: "a" }), io), { status: "offer", error: trashOffer("a"), name: "a" });
  assert.ok(isThere(join(root, "a")));
  assert.deepEqual(io.ran("/bin/rm"), []);
});

test("D23: Trash, still there with code 0: an error with no offer", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({ trash: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(await trashPath(on(root, { rel: "a" }), io), { status: "error", error: "Failed to move 'a' to the Trash." });
});

test("D23: Trash that exec stopped says it didn't finish, and never offers to delete for good", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({ trash: async () => { throw new Error("killed after 30 s"); } });
  const result = await trashPath(on(root, { rel: "a" }), io);
  assert.equal(result.status, "error");
  assert.match(result.error, /didn't finish/);
  assert.doesNotMatch(result.error, /permanently/i);
  assert.ok(isThere(join(root, "a")));
});

test("D23: Trash that exec stopped after it had worked: the state says gone, so it's a success", async () => {
  const root = folderWith({ a: "A" });
  const io = diskIo({ trash: async (args) => { rmSync(args[1]); throw new Error("killed after 30 s"); } });
  assert.equal((await trashPath(on(root, { rel: "a" }), io)).status, "ok");
});

test("D23: when the state can't even be read after Trash, there's no offer", async () => {
  const root = folderWith({ a: "A" });
  let after = false;
  const io = diskIo({
    trash: async () => { after = true; return { code: 1, stdout: "", stderr: "" }; },
    intercept: (command) => (after && command === "/bin/sh" ? Promise.reject(new Error("no shell")) : null),
  });
  const result = await trashPath(on(root, { rel: "a" }), io);
  assert.equal(result.status, "error");
  assert.match(result.error, /didn't finish/);
});

test("D23: Delete Permanently is rm -rf -- abs: that folder goes, whole, and its neighbors stay", async () => {
  const root = folderWith({ "d/x/y": "Y", "d2/z": "Z", keep: "K" }), io = diskIo();
  assert.deepEqual(await deleteForever(on(root, { rel: "d" }), io), { status: "ok", name: "d", tabs: [] });
  assert.deepEqual(namesIn(root), ["d2", "keep"]);
  assert.deepEqual(io.ran("/bin/rm"), [["/bin/rm", "-rf", "--", join(root, "d")]]);
});

test("D23: rm that exec stopped says part of it may have gone", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({ intercept: (command) => (command === "/bin/rm" ? Promise.reject(new Error("killed")) : null) });
  const result = await deleteForever(on(root, { rel: "a" }), io);
  assert.equal(result.status, "error");
  assert.match(result.error, /part of/i);
});

test("D23: rm that said no and left it is Orca's failure", async () => {
  const root = folderWith({ a: "A" }), io = diskIo({ intercept: (command) => (command === "/bin/rm" ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : null) });
  assert.deepEqual(await deleteForever(on(root, { rel: "a" }), io), { status: "error", error: "Failed to delete 'a'." });
});

// ── D21: what's open ───────────────────────────────────────────────────────

// Herdr's tabs, as far as these operations see them: a new tab shows after a wait,
// and a tab.select of another space's tab goes to that space.
function tabsWorld(spec) {
  const state = { spaces: [], panes: [], shared: { [DOCS_KEY]: {}, [LIVE_KEY]: {} }, calls: [], toasts: [], pending: [], made: 0 };
  for (const s of spec) {
    state.spaces.push({ id: s.id, active: Boolean(s.active), machine: null, tabs: s.tabs.map((t, i) => ({ id: t.id, index: i + 1, active: Boolean(t.active), panes: t.panes ?? 1 })) });
    for (const t of s.tabs) {
      if (t.file) {
        const doc = t.doc ?? `doc-${t.id}`;
        state.shared[DOCS_KEY][t.id] = { doc, file: t.file, preview: Boolean(t.preview) };
        if (!t.noPane) state.panes.push({ pane: `p-${t.id}`, tab: t.id, mod: "code-file" });
        if (t.dirty || t.pinned) state.shared[LIVE_KEY][doc] = { dirty: Boolean(t.dirty), pinned: Boolean(t.pinned) };
      }
      if ((t.panes ?? 1) > 1 || !t.file) state.panes.push({ pane: `term-${t.id}`, tab: t.id, mod: null, cwd: t.cwd ?? null });
    }
  }
  const spaceOf = (id) => state.spaces.find((s) => s.tabs.some((t) => t.id === id));
  const reindex = (space) => space.tabs.forEach((t, i) => { t.index = i + 1; });
  const select = (id) => {
    const space = spaceOf(id);
    if (!space) return;
    space.tabs.forEach((t) => { t.active = t.id === id; });
    state.spaces.forEach((s) => { s.active = s === space; });
  };
  const flush = () => {
    for (const args of state.pending.splice(0)) {
      const space = state.spaces.find((s) => s.id === args.space), id = `n${++state.made}`;
      const at = space.tabs.findIndex((t) => t.active);
      space.tabs.forEach((t) => { t.active = false; });
      space.tabs.splice(at + 1, 0, { id, index: 0, active: true, panes: 1 });
      reindex(space);
      state.panes.push({ pane: `p-${id}`, tab: id, mod: args.mod ?? null, cwd: args.folder ?? null });
    }
  };
  const io = {
    spaces: () => state.spaces.map((s) => ({ ...s, tabs: s.tabs.map((t) => ({ ...t })) })),
    panes: () => state.panes.map((p) => ({ ...p })),
    shared: (key) => state.shared[key],
    setShared: (key, value) => { state.shared[key] = value; },
    notify: (n) => { state.toasts.push(n); },
    newDoc: () => `new-doc-${state.made + state.pending.length}`,
    wait: async () => { flush(); },
    run: (name, args) => {
      state.calls.push([name, args]);
      if (name === "tab.new") state.pending.push(args);
      if (name === "tab.select") select(args.id);
      if (name === "tab.move") {
        const space = spaceOf(args.id), from = space.tabs.findIndex((t) => t.id === args.id);
        const [moved] = space.tabs.splice(from, 1);
        space.tabs.splice(args.index - 1, 0, moved);
        reindex(space);
      }
      if (name === "tab.close") {
        const space = spaceOf(args.id);
        const wasActive = space.tabs.find((t) => t.id === args.id)?.active;
        space.tabs = space.tabs.filter((t) => t.id !== args.id);
        state.panes = state.panes.filter((p) => p.tab !== args.id);
        reindex(space);
        if (wasActive && space.tabs.length) space.tabs[0].active = true;
      }
      if (name === "pane.close") {
        const pane = state.panes.find((p) => p.pane === args.pane);
        state.panes = state.panes.filter((p) => p !== pane);
        state.spaces.flatMap((s) => s.tabs).filter((t) => t.id === pane.tab).forEach((t) => { t.panes -= 1; });
      }
      return null;
    },
  };
  return { state, io, flush };
}
const callNames = (state) => state.calls.map(([name]) => name);

const opened = (root, world, over = {}) => diskIo({ ...world.io, ...over });

test("D21: a clean tab on the path, or under it, is found; another's isn't, whatever its name starts with", async () => {
  const root = folderWith({ "d/a": "A", "d/x/b": "B", "dd/c": "C" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [
    { id: "t1", file: join(root, "d/a") }, { id: "t2", file: join(root, "d/x/b") }, { id: "t3", file: join(root, "dd/c"), active: true },
  ] }]);
  const tabs = await findTabs(join(root, "d"), opened(root, world));
  assert.deepEqual(tabs.map((t) => [t.id, t.space, t.doc, t.rest]), [["t1", "s1", "doc-t1", "/a"], ["t2", "s1", "doc-t2", "/x/b"]]);
});

test("D21: a tab that kept its entry and lost its file's pane doesn't count: closing beside a terminal leaves both behind", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), noPane: true, dirty: true, active: true }] }]);
  assert.deepEqual(await findTabs(join(root, "a"), opened(root, world)), []);
  assert.equal((await renamePath(on(root, { rel: "a", raw: "b" }), opened(root, world))).status, "ok");
});

test("D21: an entry whose tab is gone doesn't count", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", active: true }] }]);
  world.state.shared[DOCS_KEY].gone = { doc: "dg", file: join(root, "a"), preview: false };
  world.state.shared[LIVE_KEY].dg = { dirty: true, pinned: false };
  world.state.panes.push({ pane: "p-gone", tab: "gone", mod: "code-file" });
  assert.deepEqual(await findTabs(join(root, "a"), opened(root, world)), []);
});

test("D21: the same file through another way to its folder is the same file", async () => {
  const real = folderWith({ a: "A" }), alias = join(base, `alias${++serial}`);
  symlinkSync(real, alias);
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(alias, "a"), dirty: true, active: true }] }]);
  const io = opened(real, world);
  assert.deepEqual(await renamePath(on(real, { rel: "a", raw: "b" }), io), { status: "error", error: unsavedChanges("a") });
  assert.deepEqual(namesIn(real), ["a"]);
});

test("D21: a tab on a link isn't a tab on what it points to", async () => {
  const root = folderWith({ a: "A" });
  symlinkSync("a", join(root, "l"));
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  assert.deepEqual(await findTabs(join(root, "l"), opened(root, world)), []);
  assert.equal((await findTabs(join(root, "a"), opened(root, world))).length, 1);
});

for (const [what, run] of [
  ["rename", (req, io) => renamePath({ ...req, raw: "zz" }, io)],
  ["duplicate", (req, io) => duplicateFile(req, io)],
  ["Trash", (req, io) => trashPath(req, io)],
  ["Delete Permanently", (req, io) => deleteForever(req, io)],
]) {
  test(`D21: unsaved changes stop ${what} before it touches the disk, in S12's words`, async () => {
    const root = folderWith({ a: "A" });
    const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), dirty: true, active: true }] }]);
    const io = opened(root, world);
    assert.deepEqual(await run(on(root, { rel: "a" }), io), { status: "error", error: "\"a\" has unsaved changes" });
    assertUntouched(io);
    assert.equal(readFileSync(join(root, "a"), "utf8"), "A");
    assert.deepEqual(world.state.calls, []);
  });
}

test("D21: unsaved changes anywhere under a folder stop the folder, naming the file", async () => {
  const root = folderWith({ "d/x/deep.js": "A", "d/clean.js": "B" });
  const world = tabsWorld([{ id: "s2", tabs: [{ id: "t9", file: join(root, "d/clean.js"), active: true }] }, { id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "d/x/deep.js"), dirty: true, active: true }] }]);
  const io = opened(root, world);
  assert.deepEqual(await renamePath(on(root, { rel: "d", raw: "e" }), io), { status: "error", error: unsavedChanges("deep.js") });
  assert.deepEqual(await trashPath(on(root, { rel: "d" }), io), { status: "error", error: unsavedChanges("deep.js") });
  assertUntouched(io);
});

test("D21: a draft on disk counts as unsaved when shared says clean: shared can lag after a hang", async () => {
  const root = folderWith({ a: "A" }), app = folderWith({ "code-editor/drafts/abc123-doc-t1-7": "{}\n" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  const io = opened(root, world, { appHome: () => app });
  assert.deepEqual(await renamePath(on(root, { rel: "a", raw: "b" }), io), { status: "error", error: unsavedChanges("a") });
  assert.deepEqual(namesIn(root), ["a"]);
});

test("D21: another doc's draft doesn't stop this one, nor does one that only contains its letters", async () => {
  const root = folderWith({ a: "A" }), app = folderWith({ "code-editor/drafts/abc-otherdoc-t1-7": "{}\n", "code-editor/drafts/abc-doc-t12-7": "{}\n" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  assert.equal((await renamePath(on(root, { rel: "a", raw: "b" }), opened(root, world, { appHome: () => app }))).status, "ok");
});

test("D21: no drafts folder yet is no drafts; a folder that can't be read stops the operation", async () => {
  const app = folderWith();
  assert.deepEqual(await draftNames(diskIo({ appHome: () => app })), []);
  const unreadable = folderWith({ "code-editor/drafts/x": "" });
  const io = diskIo({ appHome: () => unreadable, readdir: async () => { throw new Error("EACCES"); } });
  assert.equal(await draftNames(io), null);

  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  const stopped = opened(root, world, { appHome: () => unreadable, readdir: async () => { throw new Error("EACCES"); } });
  assert.equal((await renamePath(on(root, { rel: "a", raw: "b" }), stopped)).status, "error");
  assertUntouched(stopped);
});

test("D21: with no tab on the path, the drafts folder isn't even read", async () => {
  const root = folderWith({ a: "A" });
  const io = diskIo({ readdir: async () => assert.fail("read the drafts") });
  assert.equal((await renamePath(on(root, { rel: "a", raw: "b" }), io)).status, "ok");
});

test("D21: clearPath names what it found, and what's clean goes through", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true, preview: true }] }]);
  const cleared = await clearPath(on(root, { rel: "a" }), opened(root, world));
  assert.equal(cleared.abs, join(root, "a"));
  assert.equal(cleared.name, "a");
  assert.deepEqual(cleared.tabs.map((t) => [t.id, t.preview]), [["t1", true]]);
});

// ── D21: renaming with tabs open ───────────────────────────────────────────

const moveAll = async (root, world, rel, raw) => {
  const io = opened(root, world);
  const result = await renamePath(on(root, { rel, raw }), io);
  assert.equal(result.status, "ok");
  await reopenTabs({ tabs: result.tabs, to: result.abs }, io);
  return result;
};

test("D21: a clean tab reopens at the new path, in the old one's place, by D11's sequence", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t0" }, { id: "t1", file: join(root, "a"), active: true }, { id: "t2" }] }]);
  await moveAll(root, world, "a", "b");
  assert.deepEqual(callNames(world.state).slice(0, 3), ["tab.new", "tab.move", "tab.close"]);
  const [, args] = world.state.calls[0];
  assert.equal(args.name, "b");
  assert.equal(args.mod, "code-file");
  assert.equal(args.props.file, join(root, "b"));
  assert.deepEqual(world.state.calls[1], ["tab.move", { id: "n1", index: 2 }]);
  assert.deepEqual(world.state.calls[2], ["tab.close", { id: "t1" }]);
  assert.deepEqual(world.state.spaces[0].tabs.map((t) => t.id), ["t0", "n1", "t2"], "same place");
  assert.equal(world.state.shared[DOCS_KEY].n1.file, join(root, "b"));
});

test("D21: beside a terminal it's tab.new and pane.close of that pane, with no tab.move: the terminal stays where it is", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t0" }, { id: "t1", file: join(root, "a"), panes: 2, active: true }] }]);
  await moveAll(root, world, "a", "b");
  const names = callNames(world.state);
  assert.ok(!names.includes("tab.move"));
  assert.ok(!names.includes("tab.close"));
  assert.deepEqual(world.state.calls.find(([name]) => name === "pane.close"), ["pane.close", { pane: "p-t1" }]);
  assert.ok(world.state.panes.some((p) => p.pane === "term-t1"), "the terminal lives");
  assert.deepEqual(world.state.spaces[0].tabs.map((t) => t.id).sort(), ["n1", "t0", "t1"]);
});

test("D21: a preview stays a preview, and a pinned file stays pinned", async () => {
  const root = folderWith({ p: "P", q: "Q", r: "R" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [
    { id: "t1", file: join(root, "p"), preview: true, active: true }, { id: "t2", file: join(root, "q") }, { id: "t3", file: join(root, "r"), preview: true, pinned: true },
  ] }]);
  await moveAll(root, world, "p", "p2");
  await moveAll(root, world, "q", "q2");
  await moveAll(root, world, "r", "r2");
  const docs = world.state.shared[DOCS_KEY];
  const entry = (file) => Object.values(docs).find((e) => e.file === join(root, file));
  assert.equal(entry("p2").preview, true);
  assert.equal(entry("q2").preview, false);
  assert.equal(entry("r2").preview, false, "what code-file pinned stays pinned");
});

test("D21: a folder's tabs reopen one at a time, each at its own new path", async () => {
  const root = folderWith({ "d/a": "A", "d/x/b": "B", "other": "O" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "d/a") }, { id: "t2", file: join(root, "d/x/b"), active: true }, { id: "t3", file: join(root, "other") }] }]);
  await moveAll(root, world, "d", "e");
  const files = world.state.calls.filter(([name]) => name === "tab.new").map(([, args]) => args.props.file);
  assert.deepEqual(files, [join(root, "e/a"), join(root, "e/x/b")]);
  const names = callNames(world.state);
  assert.ok(names.indexOf("tab.close") < names.lastIndexOf("tab.new"), "the first is done before the second starts");
  assert.ok(Object.values(world.state.shared[DOCS_KEY]).some((e) => e.file === join(root, "other")), "what's elsewhere stays");
  assert.deepEqual(world.state.calls.filter(([name, args]) => name === "tab.close").map(([, args]) => args.id), ["t1", "t2"]);
});

test("D21: at the end the tab that was active is selected, or its replacement", async () => {
  const root = folderWith({ a: "A", b: "B" });
  const replaced = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }, { id: "t2" }] }]);
  await moveAll(root, replaced, "a", "a2");
  assert.deepEqual(replaced.state.calls.at(-1), ["tab.select", { id: "n1" }]);
  assert.equal(replaced.state.spaces[0].tabs.find((t) => t.active).id, "n1");

  const other = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "b") }, { id: "t2", active: true }] }]);
  await moveAll(root, other, "b", "b2");
  assert.deepEqual(other.state.calls.at(-1), ["tab.select", { id: "t2" }]);
  assert.equal(other.state.spaces[0].tabs.find((t) => t.active).id, "t2");
});

test("D21: each tab in its own space, and the window ends on the space and tab it was on", async () => {
  const root = folderWith({ a: "A" });
  const file = join(root, "a");
  const world = tabsWorld([
    { id: "far", tabs: [{ id: "f0", active: true }, { id: "f1", file }] },
    { id: "here", active: true, tabs: [{ id: "h1" }, { id: "h2", file, active: true }] },
    { id: "other", tabs: [{ id: "o1", active: true }] },
  ]);
  await moveAll(root, world, "a", "b");
  const made = world.state.calls.filter(([name]) => name === "tab.new").map(([, args]) => args.space);
  assert.deepEqual(made, ["far", "here"]);
  const selects = world.state.calls.filter(([name]) => name === "tab.select");
  assert.deepEqual(selects.at(-2), ["tab.select", { id: "f0" }], "the other space's own active tab comes back");
  assert.deepEqual(world.state.calls.at(-1), ["tab.select", { id: "n2" }], "this space last, so the window stays here");
  assert.equal(world.state.spaces.find((s) => s.active).id, "here");
  assert.deepEqual(world.state.spaces.find((s) => s.id === "far").tabs.map((t) => t.id).sort(), ["f0", "n1"]);
});

test("D21: with the window on an untouched space, it stays there", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "far", tabs: [{ id: "f1", file: join(root, "a"), active: true }] }, { id: "here", active: true, tabs: [{ id: "h1", active: true }] }]);
  await moveAll(root, world, "a", "b");
  assert.equal(world.state.spaces.find((s) => s.active).id, "here");
  assert.deepEqual(world.state.calls.at(-1), ["tab.select", { id: "h1" }]);
});

test("D21: a tab that got changes during the move isn't closed: its text is in it", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  const io = opened(root, world);
  const result = await renamePath(on(root, { rel: "a", raw: "b" }), io);
  world.state.shared[LIVE_KEY]["doc-t1"] = { dirty: true, pinned: false };
  await reopenTabs({ tabs: result.tabs, to: result.abs }, io);
  assert.ok(!callNames(world.state).includes("tab.close"));
  assert.ok(world.state.spaces[0].tabs.some((t) => t.id === "t1"));
});

test("D21: a tab that won't open leaves the old one, and says so", async () => {
  const root = folderWith({ a: "A" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
  const io = opened(root, world, { run: (name, args) => { if (name === "tab.new") throw new Error("no"); world.state.calls.push([name, args]); } });
  const result = await renamePath(on(root, { rel: "a", raw: "b" }), io);
  await reopenTabs({ tabs: result.tabs, to: result.abs }, io);
  assert.equal(world.state.toasts[0].title, "Couldn't open b");
  assert.ok(world.state.spaces[0].tabs.some((t) => t.id === "t1"));
});

// ── D21: deleting with tabs open ───────────────────────────────────────────

test("D21: Delete closes its tabs by D18, and only after the Trash worked", async () => {
  const root = folderWith({ "d/a": "A", "d/b": "B", keep: "K" });
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "d/a") }, { id: "t2", file: join(root, "d/b"), panes: 2 }, { id: "t3", file: join(root, "keep"), active: true }] }]);
  let closedBefore = null;
  const io = opened(root, world, { trash: async (args) => { closedBefore = world.state.calls.length; return trashWorks(args); } });
  const result = await trashPath(on(root, { rel: "d" }), io);
  assert.equal(closedBefore, 0);
  assert.deepEqual(world.state.calls, [], "the operation itself closes nothing");
  closeTabs(result.tabs, io);
  assert.deepEqual(world.state.calls, [["tab.close", { id: "t1" }], ["pane.close", { pane: "p-t2" }]]);
  assert.ok(world.state.calls.every(([, args]) => !("confirmed" in args)), "D18: never confirmed");
});

test("D21: a Trash that failed closes nothing, whichever way it failed", async () => {
  for (const trash of [async () => ({ code: 1, stdout: "", stderr: "" }), async () => ({ code: 0, stdout: "", stderr: "" }), async () => { throw new Error("killed"); }]) {
    const root = folderWith({ a: "A" });
    const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: join(root, "a"), active: true }] }]);
    const result = await trashPath(on(root, { rel: "a" }), opened(root, world, { trash }));
    assert.notEqual(result.status, "ok");
    assert.equal(result.tabs, undefined, "nothing to close");
    assert.deepEqual(world.state.calls, []);
  }
});

test("D21: closing skips a tab already gone, and one that got changes meanwhile", () => {
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", file: "/r/a", active: true }, { id: "t2", file: "/r/b" }] }]);
  world.state.shared[LIVE_KEY]["doc-t2"] = { dirty: true, pinned: false };
  closeTabs([{ id: "gone", doc: "x" }, { id: "t2", doc: "doc-t2" }, { id: "t1", doc: "doc-t1" }], world.io);
  assert.deepEqual(world.state.calls, [["tab.close", { id: "t1" }]]);
});

// ── Find in Folder, against real git ───────────────────────────────────────

// What the field makes of a pattern, as main.js runs it.
const searchArgs = (include) => gitGrepArgs({ query: "needle", caseSensitive: false, wholeWord: false, useRegex: false, include, exclude: "" });
const files = (stdout) => [...new Set(stdout.split("\n").filter(Boolean).map((line) => line.split("\0")[0]))].sort();

test("S13: Find in Folder's pattern finds what's in that folder and nothing else, special characters and all", () => {
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(folderPattern("src/util"), "src/util/**");
  for (const folder of ["plain", "we[ird]", "st*r", "a,b", "br{a,c}e", "sp ace", "qu?st"]) {
    const root = folderWith({ [`${folder}/in.txt`]: "needle\n", "plain2/out.txt": "needle\n", "weird/out.txt": "needle\n", "star/out.txt": "needle\n", "a/out.txt": "needle\n", "b/out.txt": "needle\n", "brae/out.txt": "needle\n", "brce/out.txt": "needle\n", "quest/out.txt": "needle\n" });
    git(root, "init", "-q");
    assert.deepEqual(files(git(root, ...searchArgs(folderPattern(folder)))), [`${folder}/in.txt`], folder);
  }
});

// ── main.js, in a fake Herdr ───────────────────────────────────────────────


function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {} };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "children") t.kids.push(...args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") args[0](self);
        else if (k === "on_mouse_down") t.handlers[`mouse_down_${args[0]}`] = args[1];
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

const THEME = new Proxy({}, { get: (_t, k) => String(k) });

async function newWorld(root, { tabs = [], machine = null, trash = trashWorks, intercept = () => null, app = join(base, "no-app-home") } = {}) {
  const world = tabsWorld([{ id: "s1", active: true, tabs: [{ id: "t1", active: true, cwd: root }, ...tabs] }]);
  const w = {
    root, world, execs: [], clipboard: [], overlays: [], closed: [], writes: [], waiters: [], watches: [], everys: [], queued: [], focus: 0, inputs: [], logged: [],
    machine,
  };
  const cx = {
    notify() {},
    spawn: (f) => { Promise.resolve().then(() => f(cx)).catch((e) => { console.log(`task failed: ${e?.stack ?? e}`); }); },
    timer: { after: (_ms, f) => { setTimeout(() => { world.flush(); f(cx); }, 0); return { cancel() {} }; }, every: (_ms, f) => { w.everys.push(() => f(cx)); return { cancel() {} }; } },
    stop_propagation() {},
    write_to_clipboard: (text) => { w.clipboard.push(text); },
    focus_handle: () => ({ focus() { w.focus++; } }),
  };
  const deliver = (raw) => {
    const waiting = w.waiters.splice(0);
    if (!waiting.length) { w.queued.push(raw); return; }
    for (const resolve of waiting) resolve(raw);
  };
  globalThis.__ce = {
    el,
    list: (id, count, size, key, draw) => { const list = el("list", id); list.rows = draw({ start: 0, end: count }); return list; },
    newInput: (options) => {
      const input = {
        options, text: "", handlers: {}, selected: null, focused: 0, value: () => input.text,
        set_value: (text) => { input.text = text; },
        set_selected_range: (range) => { input.selected = range; },
        focus: () => { input.focused++; },
        on: (event, handler) => { input.handlers[event] = handler; return true; },
      };
      w.inputs.push(input);
      return input;
    },
    spaces: () => world.io.spaces().map((s) => ({ ...s, machine: w.machine })),
    panes: () => world.io.panes(),
    focused: () => ({ pane: "term-t1" }),
    exec: (command, args = [], options) => {
      w.execs.push([command, ...args]);
      belted(command, args);
      if (command === "/usr/bin/trash") return trash(args);
      if (command === "/usr/bin/open") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      return intercept(command, args) ?? realExec(command, args, options);
    },
    readTextFile: async () => null,
    writeTextFile: async (...args) => { w.writes.push(args); return writeNew(...args); },
    watchFolder: () => new Promise((resolve) => { w.watches.push(resolve); }),
    theme: () => THEME,
    shared: (key) => world.io.shared(key),
    setShared: (key, value) => world.io.setShared(key, value),
    run: (name, args) => {
      if (name.startsWith("code-explorer.")) { world.state.calls.push([name, args]); deliver(name); return null; }
      return world.io.run(name, args);
    },
    notify: (n) => { world.io.notify(n); return "toast"; },
    nextCommand: () => new Promise((resolve) => {
      if (w.queued.length) resolve(w.queued.shift());
      else w.waiters.push(resolve);
    }),
    layout: () => null,
    appHome: () => app,
    home: () => "/no/home",
    props: () => null,
    openOverlay: (spec) => { w.overlays.push(spec); return `overlay-${w.overlays.length}`; },
    closeOverlay: (id) => { w.closed.push(id); return null; },
  };
  const view = new CodeExplorer();
  view.init({}, cx);
  Object.assign(w, {
    view, cx,
    draw: () => view.render(cx),
    snap: () => { view.render(cx); return view.snapshot(); },
    paths: () => w.snap().rows.map((r) => r.path),
    ops: () => view.opsSnapshot(),
    send: async (raw) => {
      await until("the command loop", () => w.waiters.length > 0);
      deliver(raw);
      await new Promise(setImmediate);
    },
    idle: () => until("the tree loaded", () => w.snap().root && view.state.loaded && !view.loading && !view.settling),
    // What Herdr does with props: a new copy, in the overlay.
    copy: (spec) => {
      const copy = new CodeExplorer();
      copy.init({ ...spec.props, overlay: `overlay-${w.overlays.indexOf(spec) + 1}` }, cx);
      return copy;
    },
    menu: () => w.copy(w.overlays.at(-1)),
    toasts: () => world.state.toasts.map((n) => n.title),
    lastIs: (op, status) => until(`${op} ${status}`, () => w.ops().last?.op === op && w.ops().last?.status === status),
    ran: (program) => w.execs.filter(([command]) => command === program),
  });
  if (!machine) await w.idle();
  return w;
}

const pressRow = (w, rel) => {
  const list = findKind(w.draw(), "list");
  list.handlers.item_secondary_click(rel, { position: { x: 1, y: 1 } }, w.cx);
  find(w.draw(), "explorer-tree-area").handlers.mouse_down_right({}, w.cx);
};

// ── A window that doesn't draw ─────────────────────────────────────────────

test("D2: a command works in a copy that hasn't drawn: a locked screen or a covered window draws nothing", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root);
  // As after a hot reload with the window out of sight: nothing has rendered yet.
  w.view.key = undefined; w.view.state = null; w.view.where = null; w.view.folders.clear();
  await w.send("new-file://b.txt");
  await w.lastIs("file", "ok");
  assert.deepEqual(namesIn(root).sort(), ["a.js", "b.txt"]);
});

// ── The menu ───────────────────────────────────────────────────────────────

test("S13: a right click on a row opens its menu, in a popup that knows what it's for", async () => {
  const w = await newWorld(folderWith({ "a.js": "A", "src/b.js": "B" }));
  pressRow(w, "a.js");
  assert.equal(w.overlays.length, 1, "the press around the list doesn't open a second one");
  const spec = w.overlays[0];
  assert.equal(spec.mod, "code-explorer");
  assert.equal(spec.kind, "popup");
  assert.deepEqual(spec.props, { view: "file-menu", root: w.root, rel: "a.js", dir: false, open: false, filtering: false });
  const drawn = w.menu().render(w.cx);
  for (const label of ["New File", "New Folder", "Copy Path", "Copy Relative Path", "Duplicate", "Reveal in Finder", "Rename", "Delete"]) assert.ok(textOf(drawn).includes(label), label);
  assert.ok(!textOf(drawn).includes("Open in Terminal"));
});

test("S13: a folder's row says so to its menu, open or closed", async () => {
  const w = await newWorld(folderWith({ "src/b.js": "B" }));
  pressRow(w, "src");
  assert.deepEqual(w.overlays[0].props, { view: "file-menu", root: w.root, rel: "src", dir: true, open: false, filtering: false });
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/b.js"));
  pressRow(w, "src");
  assert.equal(w.overlays[1].props.open, true);
  assert.ok(textOf(w.menu().render(w.cx)).includes("Collapse Folder"));
});

test("S13: a right click on empty space offers New File and New Folder, in the root", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  find(w.draw(), "explorer-tree-area").handlers.mouse_down_right({}, w.cx);
  assert.equal(w.overlays[0].props.rel, "");
  const drawn = w.menu().render(w.cx);
  assert.ok(textOf(drawn).includes("New File"));
  assert.ok(!textOf(drawn).includes("Delete"));
});

test("S13: an empty folder has no list, and a right click there still creates", async () => {
  const w = await newWorld(folderWith());
  assert.match(textOf(w.draw()), /No files in this workspace/);
  find(w.draw(), "explorer-tree-area").handlers.mouse_down_right({}, w.cx);
  assert.equal(w.overlays[0].props.rel, "");
});

test("S13: under a filter the rows have the same menu, without Collapse Folder", async () => {
  const w = await newWorld(folderWith({ "src/needle.js": "N" }));
  await w.send("filter:needle");
  await until("the filter's rows", () => w.paths().includes("src/needle.js"));
  const list = findKind(w.draw(), "list");
  list.handlers.item_secondary_click("src", {}, w.cx);
  assert.deepEqual(w.overlays[0].props, { view: "file-menu", root: w.root, rel: "src", dir: true, open: true, filtering: true });
  assert.ok(!textOf(w.menu().render(w.cx)).includes("Collapse Folder"));
});

test("D2: menu:<rel> opens the same popup a right click does, and not for a row that isn't there", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("menu:a.js");
  assert.equal(w.overlays[0].props.rel, "a.js");
  await w.send("menu:");
  assert.equal(w.overlays[1].props.rel, "");
  await w.send("menu:nope.js");
  assert.equal(w.overlays.length, 2);
});

test("D23: a menu's item runs in the panel's copy, never its own, and then the menu closes", async () => {
  const w = await newWorld(folderWith({ "a b.js": "A" }));
  await w.send("menu:a b.js");
  const menu = w.menu();
  find(menu.render(w.cx), "file-menu-duplicate").handlers.click({}, w.cx);
  assert.deepEqual(w.world.state.calls.at(-1), ["code-explorer.duplicate:a b.js", undefined]);
  assert.deepEqual(w.closed, ["overlay-1"]);
  await until("the copy", () => existsSync(join(w.root, "a b copy.js")));
});

test("S13: Copy Path and Copy Relative Path in the menu write what they say, to the clipboard they're given", async () => {
  const w = await newWorld(folderWith({ "src/a.js": "A" }));
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/a.js"));
  await w.send("menu:src/a.js");
  find(w.menu().render(w.cx), "file-menu-copy-path").handlers.click({}, w.cx);
  assert.deepEqual(w.clipboard, [join(w.root, "src/a.js")]);
  await w.send("menu:src/a.js");
  find(w.menu().render(w.cx), "file-menu-copy-relative-path").handlers.click({}, w.cx);
  assert.deepEqual(w.clipboard, [join(w.root, "src/a.js"), "src/a.js"]);
  assert.deepEqual(w.toasts(), ["Copied", "Copied"]);
  assert.equal(w.closed.length, 2);
});

test("D2: menu-pick:<id> is the same choice as a click, and from a test it leaves the clipboard alone", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("menu:a.js");
  w.menu();
  await w.send("menu-pick:copy-path");
  assert.deepEqual(w.clipboard, []);
  assert.equal(w.toasts().at(-1), "Copied");
  await w.send("menu:a.js");
  w.menu();
  await w.send("menu-pick:duplicate");
  await until("the copy", () => existsSync(join(w.root, "a copy.js")));
  assert.ok(w.world.state.calls.some(([name]) => name === "code-explorer.duplicate:a.js"));
});

test("S13: the menu's keys: arrows move, Enter runs, Esc closes; and the panel's copy ignores what's the menu's", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("menu:a.js");
  const menu = w.menu();
  const key = (name) => find(menu.render(w.cx), "file-menu").handlers.key_down({ key: name }, w.cx);
  key("escape");
  assert.deepEqual(w.closed, ["overlay-1"]);
  key("up");
  key("enter");
  assert.equal(w.world.state.calls.at(-1)[0], "code-explorer.delete:a.js", "up from the first wraps to the last");
  const logged = [];
  const log = console.log;
  console.log = (line) => { logged.push(line); };
  await w.send("menu-pick:nothing");
  console.log = log;
  assert.deepEqual(logged, []);
});

test("D2: the empty space's items send the bare command: no dangling colon for Herdr to read a value from", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("menu:");
  find(w.menu().render(w.cx), "file-menu-new-file").handlers.click({}, w.cx);
  assert.deepEqual(w.world.state.calls.at(-1), ["code-explorer.new-file", undefined]);
  await until("the entry", () => w.ops().entry?.kind === "file");
  assert.equal(w.ops().entry.folder, "");
});

test("S10: More Explorer Actions adds Reveal in Finder, on the root", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("more");
  const item = find(w.draw(), "explorer-menu-reveal");
  assert.ok(textOf(item).includes("Reveal in Finder"));
  item.handlers.click({}, w.cx);
  await until("open", () => w.ran("/usr/bin/open").length === 1);
  assert.deepEqual(w.ran("/usr/bin/open"), [["/usr/bin/open", "-R", w.root]]);
  assert.equal(w.snap().menu, false);
});

test("S13: Reveal in Finder on a row names that path; a failure says so", async () => {
  const w = await newWorld(folderWith({ "a b.js": "A" }));
  await w.send("reveal:a b.js");
  await until("open", () => w.ran("/usr/bin/open").length === 1);
  assert.deepEqual(w.ran("/usr/bin/open")[0], ["/usr/bin/open", "-R", join(w.root, "a b.js")]);
  await w.send("reveal:../x");
  assert.equal(w.ran("/usr/bin/open").length, 1);
});

test("S13: Open in Terminal starts a terminal tab in that folder, in this space", async () => {
  const w = await newWorld(folderWith({ "src/a.js": "A", "b.js": "B" }));
  await w.send("open-in-terminal:src");
  assert.deepEqual(w.world.state.calls.at(-1), ["tab.new", { space: "s1", folder: join(w.root, "src") }]);
  const count = w.world.state.calls.length;
  await w.send("open-in-terminal:b.js");
  assert.equal(w.world.state.calls.length, count, "folders only");
});

test("S13: Collapse Folder closes it and what's open inside, and leaves the rest", async () => {
  const w = await newWorld(folderWith({ "src/util/a.js": "A", "docs/b.md": "B" }));
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/util"));
  await w.send("toggle:src/util");
  await w.send("toggle:docs");
  await until("all read", () => w.paths().includes("src/util/a.js") && w.paths().includes("docs/b.md"));
  await w.send("collapse-folder:src");
  assert.deepEqual(w.snap().expanded, ["docs"]);
});

test("S13: Find in Folder opens Contents with the folder in files to include, and keeps what's typed", async () => {
  const w = await newWorld(folderWith({ "src/util/a.js": "needle\n", "b.js": "needle\n" }));
  await w.send("search:needle");
  await w.send("names");
  await w.send("find-in-folder:src/util");
  assert.equal(w.snap().view, "contents");
  const shown = w.view.searchSnapshot();
  assert.equal(shown.include, "src/util/**");
  assert.equal(shown.query, "needle");
  assert.equal(shown.details, true, "the field shows");
});

// ── The inline entry ───────────────────────────────────────────────────────

test("S13: New File: the entry shows, takes the keyboard and says where; what's typed and Enter creates it and opens it for good", async () => {
  const w = await newWorld(folderWith({ "src/keep.js": "K" }));
  await w.send("new-file:src");
  const entry = w.ops().entry;
  assert.deepEqual([entry.kind, entry.folder, entry.text], ["file", "src", ""]);
  const drawn = w.draw();
  assert.ok(find(drawn, "explorer-entry"));
  assert.ok(textOf(drawn).includes("New File in src"));
  assert.equal(w.snap().expanded.includes("src"), true, "the folder opens first, as in Orca");
  assert.ok(w.view.entryInput.focused > 0);

  await w.send("entry:new.js");
  assert.equal(w.ops().entry.text, "new.js");
  w.view.entryInput.handlers.submit({}, w.cx);
  await w.lastIs("file", "ok");
  assert.deepEqual(w.writes, [[join(w.root, "src/new.js"), "", null]]);
  assert.equal(w.ops().entry, null);
  assert.equal(find(w.draw(), "explorer-entry"), null);
  await until("the tab", () => w.world.state.calls.some(([name]) => name === "tab.new"));
  const [, args] = w.world.state.calls.find(([name]) => name === "tab.new");
  assert.equal(args.props.file, join(w.root, "src/new.js"));
  await until("its entry", () => Object.values(w.world.state.shared[DOCS_KEY]).length === 1);
  assert.equal(Object.values(w.world.state.shared[DOCS_KEY])[0].preview, false, "as in Orca, not a preview");
  await until("the row", () => w.paths().includes("src/new.js"));
});

test("S13: New Folder creates it and opens nothing", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-folder:");
  assert.deepEqual([w.ops().entry.kind, w.ops().entry.folder], ["folder", ""]);
  await w.send("entry:made");
  await w.send("entry-submit");
  await w.lastIs("folder", "ok");
  assert.ok(statSync(join(w.root, "made")).isDirectory());
  assert.ok(!w.world.state.calls.some(([name]) => name === "tab.new"));
  await until("the row", () => w.paths().includes("made"));
});

test("S13: from a file's row the entry is for its folder", async () => {
  const w = await newWorld(folderWith({ "src/a.js": "A" }));
  await w.send("toggle:src");
  await until("src read", () => w.paths().includes("src/a.js"));
  await w.send("new-file:src/a.js");
  assert.equal(w.ops().entry.folder, "src");
});

test("D2: <rel>//<name> is the entry, the text and Enter in one command", async () => {
  const w = await newWorld(folderWith({ "src/keep": "K" }));
  await w.send("new-file:src//a b.js");
  await w.lastIs("file", "ok");
  assert.ok(existsSync(join(w.root, "src/a b.js")));
  await w.send("new-folder://top");
  await w.lastIs("folder", "ok");
  assert.ok(statSync(join(w.root, "top")).isDirectory());
});

test("S13: a name in use: the toast in Orca's words, and the entry stays with its text to fix", async () => {
  const w = await newWorld(folderWith({ taken: "T" }));
  await w.send("new-file:");
  await w.send("entry:taken");
  await w.send("entry-submit");
  await w.lastIs("file", "error");
  assert.deepEqual(w.toasts(), [nameTaken("taken")]);
  assert.equal(w.ops().entry.text, "taken");
  assert.deepEqual(w.writes, []);
  await w.send("entry:free");
  await w.send("entry-submit");
  await w.lastIs("file", "ok");
  assert.equal(w.ops().entry, null);
});

test("S13: Esc cancels, the X cancels, and a blank Enter cancels; none of them writes, and leaving the input doesn't either", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-file:");
  await w.send("entry:half");
  find(w.draw(), "explorer-entry").handlers.key_down({ key: "enter" }, w.cx);
  assert.ok(w.ops().entry, "Enter is the input's submit, not this handler's");
  w.view.entryInput.handlers.blur?.({}, w.cx);
  assert.ok(w.ops().entry, "D23: focus can leave on its own here, and half a name is not a name");
  find(w.draw(), "explorer-entry").handlers.key_down({ key: "escape" }, w.cx);
  assert.equal(w.ops().entry, null);
  await w.send("new-file:");
  find(w.draw(), "explorer-entry-cancel").handlers.click({}, w.cx);
  assert.equal(w.ops().entry, null);
  await w.send("new-file:");
  await w.send("entry-submit");
  await w.lastIs("file", "cancel");
  assert.equal(w.ops().entry, null);
  await w.send("new-file:");
  await w.send("entry-cancel");
  assert.equal(w.ops().entry, null);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(namesIn(w.root), ["a.js"]);
});

test("S13: Rename: the entry holds the name with its stem selected", async () => {
  const w = await newWorld(folderWith({ "a.test.js": "A" }));
  await w.send("rename:a.test.js");
  assert.equal(w.ops().entry.text, "a.test.js");
  assert.deepEqual(w.view.entryInput.selected, { start: 0, end: 6 });
  assert.ok(textOf(w.draw()).includes("Rename a.test.js"));
  await w.send("entry-submit");
  await w.lastIs("rename", "cancel");
  assert.equal(w.ops().entry, null);
  assert.deepEqual(namesIn(w.root), ["a.test.js"]);
});

test("D2: rename:<rel>//<name> renames, colons and spaces included", async () => {
  const w = await newWorld(folderWith({ "a:1 b.js": "A" }));
  await w.send("rename:a:1 b.js//c:2 d.js");
  await w.lastIs("rename", "ok");
  assert.deepEqual(namesIn(w.root), ["c:2 d.js"]);
  await until("the row", () => w.paths().includes("c:2 d.js"));
});

test("S13: renaming an open folder keeps it open under its new name", async () => {
  const w = await newWorld(folderWith({ "d/x/y.js": "Y" }));
  await w.send("toggle:d");
  await until("d read", () => w.paths().includes("d/x"));
  await w.send("toggle:d/x");
  await until("x read", () => w.paths().includes("d/x/y.js"));
  await w.send("rename:d//e");
  await w.lastIs("rename", "ok");
  await until("the new rows", () => w.paths().includes("e/x/y.js"));
  assert.deepEqual(w.snap().expanded.sort(), ["e", "e/x"]);
  assert.ok(!w.paths().some((p) => p === "d" || p.startsWith("d/")));
});

test("D21: rename with a clean tab open reopens it with the new path", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "a.js") }] });
  await w.send("rename:a.js//b.js");
  await w.lastIs("rename", "ok");
  await until("the old tab closed", () => w.world.state.calls.some(([name, args]) => name === "tab.close" && args.id === "t2"));
  const [, args] = w.world.state.calls.find(([name]) => name === "tab.new");
  assert.equal(args.props.file, join(root, "b.js"));
  assert.equal(args.name, "b.js");
  await until("the last select", () => w.world.state.calls.at(-1)[0] === "tab.select");
  assert.deepEqual(w.world.state.calls.at(-1), ["tab.select", { id: "t1" }]);
});

test("D21: rename with a dirty tab open is refused, the toast says so, the entry stays and the file's as it was", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "a.js"), dirty: true }] });
  await w.send("rename:a.js//b.js");
  await w.lastIs("rename", "error");
  assert.deepEqual(w.toasts(), ["\"a.js\" has unsaved changes"]);
  assert.deepEqual(namesIn(root), ["a.js"]);
  assert.ok(!w.world.state.calls.some(([name]) => name === "tab.new" || name === "tab.close"));
  assert.ok(w.ops().entry);
});

test("D21: the entry goes when the tree moves to another root, and so does nothing else", async () => {
  const first = folderWith({ "a.js": "A" }), second = folderWith({ "z.js": "Z" });
  const w = await newWorld(first);
  await w.send("new-file:");
  w.world.state.panes.find((p) => p.pane === "term-t1").cwd = second;
  await until("the second root", () => w.snap().root === second);
  assert.equal(w.ops().entry, null);
});

test("D2: an entry asked for from Contents goes to Names, where it shows", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("contents");
  await w.send("new-file:");
  assert.equal(w.snap().view, "names");
  assert.ok(find(w.draw(), "explorer-entry"));
});

test("D21: an entry doesn't survive going to a remote space, where a submit would act on a local path", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-file:");
  await w.send("entry:x");
  w.machine = "far";
  w.draw();
  assert.equal(w.ops().entry, null);
  await w.send("entry-submit");
  await w.view.working;
  assert.deepEqual(w.writes, []);
  assert.deepEqual(namesIn(w.root), ["a.js"]);
});

test("S13: Contents hides the entry; back on Names it's gone, not half typed", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-file:");
  await w.send("contents");
  assert.equal(find(w.draw(), "explorer-entry"), null);
  await w.send("names");
  assert.equal(w.ops().entry, null);
});

// ── Duplicate and the copies, as commands ──────────────────────────────────

test("S13: duplicate:<rel> copies it, doesn't open it, and the row shows", async () => {
  const w = await newWorld(folderWith({ "a.txt": "A" }));
  await w.send("duplicate:a.txt");
  await w.lastIs("duplicate", "ok");
  assert.equal(readFileSync(join(w.root, "a copy.txt"), "utf8"), "A");
  assert.ok(!w.world.state.calls.some(([name]) => name === "tab.new"));
  await until("the row", () => w.paths().includes("a copy.txt"));
});

test("D2: copy-path and copy-relative-path never reach the clipboard: a test window would overwrite the person's. `ops` reports them", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("copy-path:a.js");
  assert.deepEqual(w.ops().copied, { kind: "path", text: join(w.root, "a.js") });
  await w.send("copy-relative-path:a.js");
  assert.deepEqual(w.ops().copied, { kind: "relative", text: "a.js" });
  assert.deepEqual(w.clipboard, []);
});

test("D2: `ops` prints the state of the operations to the log", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-file:");
  await w.send("entry:x");
  const logged = [];
  const log = console.log;
  console.log = (line) => { logged.push(line); };
  await w.send("ops");
  console.log = log;
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^code-explorer: ops /);
  const shown = JSON.parse(logged[0].slice("code-explorer: ops ".length));
  assert.equal(shown.entry.text, "x");
  assert.deepEqual(Object.keys(shown).sort(), ["copied", "deleting", "entry", "last"]);
});

// ── The Delete dialog ──────────────────────────────────────────────────────

const dialogOf = (w) => w.copy(w.overlays.find((spec) => spec.props.view === "file-dialog"));

test("D23: Delete asks first, in a modal dialog, and nothing's moved until it's confirmed", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  const spec = w.overlays[0];
  assert.deepEqual([spec.mod, spec.kind, spec.modal, spec.props], ["code-explorer", "dialog", true, { view: "file-dialog" }]);
  assert.deepEqual(w.ran("/usr/bin/trash"), []);
  const drawn = dialogOf(w).render(w.cx);
  assert.ok(textOf(drawn).includes("a.js"));
  assert.ok(find(drawn, "file-dialog-cancel"));
  assert.ok(find(drawn, "file-dialog-delete"));
  assert.equal(find(drawn, "file-dialog-permanent"), null);
});

test("D23: confirmed, it goes to the Trash with an absolute path, the dialog closes and the row goes", async () => {
  const w = await newWorld(folderWith({ "a.js": "A", "b.js": "B" }));
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await w.lastIs("delete", "ok");
  assert.deepEqual(w.ran("/usr/bin/trash"), [["/usr/bin/trash", "-s", join(w.root, "a.js")]]);
  assert.deepEqual(w.closed, ["overlay-1"]);
  assert.equal(w.ops().deleting, null);
  assert.equal(w.world.state.shared[OP_KEY], null);
  await until("the row", () => !w.paths().includes("a.js"));
  assert.deepEqual(w.toasts(), []);
});

test("D23: the dialog's button is the command's method, and Enter does nothing", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  const dialog = dialogOf(w);
  find(dialog.render(w.cx), "file-dialog").handlers.key_down({ key: "enter" }, w.cx);
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/usr/bin/trash"), []);
  find(dialog.render(w.cx), "file-dialog-delete").handlers.click({}, w.cx);
  assert.deepEqual(w.world.state.calls.at(-1), ["code-explorer.delete-confirm", undefined]);
  await w.lastIs("delete", "ok");
});

test("D23: Cancel and Esc close it and nothing happens, and the panel lets go of it", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  const dialog = dialogOf(w);
  find(dialog.render(w.cx), "file-dialog-cancel").handlers.click({}, w.cx);
  assert.deepEqual(w.closed, ["overlay-1"]);
  await dialog.close(w.cx);
  await until("the panel to let go", () => w.ops().deleting === null);

  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 2);
  const again = w.copy(w.overlays[1]);
  find(again.render(w.cx), "file-dialog").handlers.key_down({ key: "escape" }, w.cx);
  assert.deepEqual(w.closed, ["overlay-1", "overlay-2"]);

  await w.send("delete-cancel");
  assert.equal(w.ops().deleting, null);
  await w.send("delete-confirm");
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/usr/bin/trash"), [], "nothing left to confirm");
  assert.ok(existsSync(join(w.root, "a.js")));
});

test("D23: unsaved changes stop Delete at the question, with no dialog", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "a.js"), dirty: true }] });
  await w.send("delete:a.js");
  await w.lastIs("delete", "error");
  assert.deepEqual(w.overlays, []);
  assert.deepEqual(w.toasts(), ["\"a.js\" has unsaved changes"]);
});

test("D23: changes made while the dialog waits stop it at the confirmation", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "a.js") }] });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  w.world.state.shared[LIVE_KEY]["doc-t2"] = { dirty: true, pinned: false };
  await w.send("delete-confirm");
  await w.lastIs("delete", "error");
  assert.deepEqual(w.ran("/usr/bin/trash"), []);
  assert.equal(w.ops().deleting.error, "\"a.js\" has unsaved changes");
  assert.ok(textOf(dialogOf(w).render(w.cx)).includes("has unsaved changes"));
  assert.deepEqual(w.closed, []);
});

test("D21: Delete closes the file's tab, once the Trash worked", async () => {
  const root = folderWith({ "a.js": "A" });
  let closedAtTrash = null;
  const w = await newWorld(root, {
    tabs: [{ id: "t2", file: join(root, "a.js") }],
    trash: async (args) => { closedAtTrash = w.world.state.calls.some(([name]) => name === "tab.close"); return trashWorks(args); },
  });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await w.lastIs("delete", "ok");
  assert.equal(closedAtTrash, false);
  assert.ok(w.world.state.calls.some(([name, args]) => name === "tab.close" && args.id === "t2"));
});

test("D23: the Trash said no: the dialog turns into the offer, with its own button; tabs stay", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "a.js") }], trash: async () => ({ code: 1, stdout: "", stderr: "" }) });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await w.lastIs("delete", "offer");
  assert.equal(w.ops().deleting.step, "offer");
  const drawn = dialogOf(w).render(w.cx);
  assert.ok(textOf(drawn).includes("Couldn't move 'a.js' to the Trash. Delete it permanently?"));
  assert.ok(textOf(drawn).includes("This cannot be undone."));
  assert.ok(textOf(find(drawn, "file-dialog-permanent")).includes("Delete Permanently"));
  assert.equal(find(drawn, "file-dialog-delete"), null);
  assert.deepEqual(w.ran("/bin/rm"), [], "the offer alone deletes nothing");
  assert.ok(!w.world.state.calls.some(([name]) => name === "tab.close"));
  assert.deepEqual(w.closed, []);
});

test("D23: Delete Permanently, from the offer: rm, the tabs close, the dialog closes; Enter never does it", async () => {
  const root = folderWith({ "d/a.js": "A", keep: "K" });
  const w = await newWorld(root, { tabs: [{ id: "t2", file: join(root, "d/a.js") }], trash: async () => ({ code: 1, stdout: "", stderr: "" }) });
  await w.send("delete:d");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await w.lastIs("delete", "offer");
  const dialog = dialogOf(w);
  find(dialog.render(w.cx), "file-dialog").handlers.key_down({ key: "enter" }, w.cx);
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/bin/rm"), []);
  find(dialog.render(w.cx), "file-dialog-permanent").handlers.click({}, w.cx);
  assert.deepEqual(w.world.state.calls.at(-1), ["code-explorer.delete-permanent", undefined]);
  await w.lastIs("delete", "ok");
  assert.deepEqual(w.ran("/bin/rm"), [["/bin/rm", "-rf", "--", join(root, "d")]]);
  assert.deepEqual(namesIn(root), ["keep"]);
  assert.ok(w.world.state.calls.some(([name, args]) => name === "tab.close" && args.id === "t2"));
  assert.deepEqual(w.closed, ["overlay-1"]);
});

test("D23: delete-permanent does nothing without the Trash's no: not alone, and not before confirming", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("delete-permanent");
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-permanent");
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/bin/rm"), []);
  assert.ok(existsSync(join(w.root, "a.js")));
});

test("D23: a Trash that said yes and did nothing is an error in the dialog, with no offer", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }), { trash: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await w.lastIs("delete", "error");
  const drawn = dialogOf(w).render(w.cx);
  assert.ok(textOf(drawn).includes("Failed to move 'a.js' to the Trash."));
  assert.equal(find(drawn, "file-dialog-permanent"), null);
  await w.send("delete-permanent");
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/bin/rm"), []);
});

test("D23: busy: while it runs the buttons do nothing, a second confirm starts nothing, and Esc in the dialog doesn't let go", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const w = await newWorld(folderWith({ "a.js": "A" }), { trash: async (args) => { await held; return trashWorks(args); } });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await until("it to start", () => w.ran("/usr/bin/trash").length === 1);
  assert.equal(w.ops().deleting.busy, true);
  const dialog = dialogOf(w), drawn = dialog.render(w.cx);
  assert.equal(find(drawn, "file-dialog-cancel").handlers.click, undefined);
  assert.equal(find(drawn, "file-dialog-delete").handlers.click, undefined);
  assert.ok(textOf(drawn).includes("Deleting…"));
  find(drawn, "file-dialog").handlers.key_down({ key: "escape" }, w.cx);
  assert.deepEqual(w.closed, []);
  await w.send("delete-confirm");
  await w.send("delete-cancel");
  assert.equal(w.ran("/usr/bin/trash").length, 1);
  assert.ok(w.ops().deleting);
  release();
  await w.lastIs("delete", "ok");
});

test("D23: Herdr's Esc closed the dialog mid-run: the run goes on, and what it ends in goes to a toast, never an offer to no one", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const w = await newWorld(folderWith({ "a.js": "A" }), { trash: async () => { await held; return { code: 1, stdout: "", stderr: "" }; } });
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await w.send("delete-confirm");
  await until("it to start", () => w.ran("/usr/bin/trash").length === 1);
  await dialogOf(w).close(w.cx);
  await until("the panel to hear", () => w.ops().deleting?.open === false);
  release();
  await until("the toast", () => w.toasts().length === 1);
  assert.deepEqual(w.toasts(), ["Failed to move 'a.js' to the Trash."]);
  assert.equal(w.ops().deleting, null);
  assert.deepEqual(w.closed, [], "there's nothing to close");
  await w.send("delete-permanent");
  await new Promise(setImmediate);
  assert.deepEqual(w.ran("/bin/rm"), []);
});

test("D23: the last dialog's goodbye doesn't end the next one", async () => {
  const w = await newWorld(folderWith({ "a.js": "A", "b.js": "B" }));
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  const first = dialogOf(w);
  await w.send("delete-cancel");
  await w.send("delete:b.js");
  await until("the second", () => w.overlays.length === 2);
  await first.close(w.cx);
  await new Promise(setImmediate);
  assert.equal(w.ops().deleting.rel, "b.js");
  assert.equal(w.ops().deleting.open, true);
  await w.send("delete-confirm");
  await w.lastIs("delete", "ok");
  assert.deepEqual(namesIn(w.root), ["a.js"]);
});

test("D23: a dialog opened with nothing to delete says so, and closes", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  const spec = { props: { view: "file-dialog" } };
  w.overlays.push(spec);
  const drawn = w.copy(spec).render(w.cx);
  assert.equal(find(drawn, "file-dialog-delete"), null);
  assert.equal(find(drawn, "file-dialog-permanent"), null);
  find(drawn, "file-dialog-cancel").handlers.click({}, w.cx);
  assert.equal(w.closed.length, 1);
});

test("D23: a command naming the root or going up changes nothing, and neither does one for a row that's gone", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  for (const raw of ["delete:", "delete:..", "delete:../x", "delete:gone.js", "duplicate:", "duplicate:..", "rename:..//x", "rename:a.js//../x", "new-file:..//x", "new-folder:..//x"]) {
    await w.send(raw);
    await w.view.working;
  }
  assert.equal(w.toasts().length, 10, "each one says why");
  assertNothingRan(w);
  assert.deepEqual(w.overlays, []);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(namesIn(w.root), ["a.js"]);
});

const assertNothingRan = (w) => { for (const program of NOTHING_CHANGED) assert.deepEqual(w.ran(program), [], program); };

// ── D21: another machine ───────────────────────────────────────────────────

test("D21: in a remote space the panel says so, and nothing here runs: no local path by mistake", async () => {
  const root = folderWith({ "a.js": "A" });
  const w = await newWorld(root, { machine: "far" });
  assert.match(textOf(w.draw()), /Explorer works on this computer only/);
  w.execs.length = 0;
  for (const raw of ["menu:a.js", "menu:", "new-file:", "new-file://x", "new-folder://x", "rename:a.js", "rename:a.js//b.js", "duplicate:a.js", "delete:a.js", "delete-confirm", "delete-permanent", "copy-path:a.js", "reveal:a.js", "reveal:", "open-in-terminal:a.js", "collapse-folder:a.js", "find-in-folder:a.js", "entry-submit"]) {
    await w.send(raw);
  }
  await new Promise(setImmediate);
  assert.deepEqual(w.execs, []);
  assert.deepEqual(w.overlays, []);
  assert.deepEqual(w.writes, []);
  assert.equal(w.ops().copied, null);
  assert.equal(w.ops().entry, null);
  assert.ok(!w.world.state.calls.some(([name]) => name === "tab.new"));
  assert.deepEqual(namesIn(root), ["a.js"]);
});

// ── The copies ─────────────────────────────────────────────────────────────

test("A menu or a dialog is a copy that reads no tree and starts no timer or watch", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  const everys = w.everys.length, watches = w.watches.length, execs = w.execs.length;
  w.copy({ props: { view: "file-menu", root: w.root, rel: "a.js", dir: false } });
  w.copy({ props: { view: "file-dialog" } });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(w.everys.length, everys);
  assert.equal(w.watches.length, watches);
  assert.equal(w.execs.length, execs);
});

test("close() reaches the overlay's view, and is nothing on the panel", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.view.close(w.cx);
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 1);
  await dialogOf(w).close(w.cx);
  await until("the panel to let go", () => w.ops().deleting === null);
  assert.ok(w.world.state.calls.some(([name]) => name === "code-explorer.delete-closed:overlay-1"));
});

test("Render reads and runs nothing: Herdr interrupts a slow one", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("new-file:");
  await w.send("menu:a.js");
  const menu = w.menu();
  await w.send("delete:a.js");
  await until("the dialog", () => w.overlays.length === 2);
  const dialog = dialogOf(w);
  await until("settled", () => !w.view.loading && !w.view.settling);
  const execs = w.execs.length;
  w.view.render(w.cx);
  menu.render(w.cx);
  dialog.render(w.cx);
  assert.equal(w.execs.length, execs);
});

// ── What the change touches, pinned ────────────────────────────────────────

test("pin: a left click on a row still opens its file in a preview, and a folder still toggles", async () => {
  const w = await newWorld(folderWith({ "a.js": "A", "src/b.js": "B" }));
  findKind(w.draw(), "list").handlers.item_click("src", w.cx);
  await until("src read", () => w.paths().includes("src/b.js"));
  findKind(w.draw(), "list").handlers.item_click("a.js", w.cx);
  await until("the tab", () => w.world.state.calls.some(([name]) => name === "tab.new"));
  await until("its entry", () => Object.keys(w.world.state.shared[DOCS_KEY]).length === 1);
  assert.equal(Object.values(w.world.state.shared[DOCS_KEY])[0].preview, true);
  assert.equal(w.overlays.length, 0);
});

test("pin: clicks in order still open in order, the second finding the tab of the first", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  await w.send("open:a.js");
  await w.send("pin:a.js");
  await until("the tab", () => Object.keys(w.world.state.shared[DOCS_KEY]).length === 1);
  await until("the pin", () => Object.values(w.world.state.shared[DOCS_KEY])[0].preview === false);
  assert.equal(w.world.state.calls.filter(([name]) => name === "tab.new").length, 1);
});

test("pin: Show Dotfiles and Show Git Ignored Files are still in More Explorer Actions, and their commands still answer", async () => {
  const root = folderWith({ "a.js": "A", ".dot": "D" });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const w = await newWorld(root);
  await until("git marks", () => w.view.state.git);
  await w.send("more");
  const drawn = w.draw();
  assert.ok(textOf(find(drawn, "explorer-menu-dotfiles")).includes("Show Dotfiles"));
  assert.ok(textOf(find(drawn, "explorer-menu-ignored")).includes("Show Git Ignored Files"));
  find(drawn, "explorer-menu-dotfiles").handlers.click({}, w.cx);
  assert.ok(!w.paths().includes(".dot"));
  await w.send("dotfiles");
  assert.ok(w.paths().includes(".dot"));
});

test("pin: the filter's input is still the last one made: the names test treats that one as \"the\" input", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  assert.equal(w.inputs.at(-1).options.placeholder, "Find files");
  assert.equal(w.inputs.at(-2).options.placeholder !== "Find files", true);
});

test("The entry's input is made once, in init, never in render", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  const made = w.inputs.length;
  assert.ok(w.inputs.includes(w.view.entryInput));
  await w.send("new-file:");
  w.draw();
  assert.equal(w.inputs.length, made);
});

test("pin: every command from before still answers, and an unknown one still only logs", async () => {
  const w = await newWorld(folderWith({ "a.js": "A" }));
  for (const raw of ["more", "more", "refresh", "dotfiles", "dotfiles", "ignored", "ignored", "names", "contents", "names", "tree", "results", "collapse-all"]) await w.send(raw);
  const logged = [];
  const log = console.log;
  console.log = (line) => { logged.push(line); };
  await w.send("no-such-thing");
  console.log = log;
  assert.deepEqual(logged, ["code-explorer: no command \"no-such-thing\""]);
});
