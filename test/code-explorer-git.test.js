// T4: git marks in the Explorer (code-explorer/git-model.js): the letter each
// status gets, the folder's dominant one as Orca computes it, ignored paths, the
// repo's name, against a real git in throwaway repos as well as fixed text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  GIT_COLORS, IGNORED_ARGS, ROOT_ARGS, STATUS_ARGS, buildFolderStatus, dominantStatus, isIgnored, parseIgnored, parseRepo, parseStatus, statusLetter,
} from "../code-editor/mods/code-explorer/git-model.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "code-explorer-git-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8", stdio: "pipe" });

test("D5: the letters' colors are Orca's", () => {
  assert.deepEqual(GIT_COLORS, { M: "#e2c08d", A: "#81b88b", D: "#c74e39", R: "#73c991", U: "#73c991", C: "#73c991" });
});

test("S3: U means untracked, as in Orca; a merge conflict shows as modified", () => {
  assert.equal(statusLetter("??"), "U");
  for (const xy of [" M", "M ", "MM", "UU", "AA", "DD", "AU", "UA", "DU", "UD"]) assert.equal(statusLetter(xy), "M", xy);
  for (const xy of ["A ", "AM"]) assert.equal(statusLetter(xy), "A", xy);
  for (const xy of [" D", "D ", "MD", "AD"]) assert.equal(statusLetter(xy), "D", xy);
  assert.equal(statusLetter("R "), "R");
  assert.equal(statusLetter("C "), "C");
});

test("S3: parsing porcelain -z keeps whole names and drops a truncated last entry", () => {
  const marks = parseStatus(" M a b.js\0?? it's/$(x)\0A  new.js\0?? nested/\0 M cut-off");
  assert.deepEqual([...marks], [["a b.js", "M"], ["it's/$(x)", "U"], ["new.js", "A"], ["nested", "U"]]);
  assert.equal(parseStatus("").size, 0);
});

test("S3: one path listed twice keeps the dominant status", () => {
  assert.equal(parseStatus("?? a\0D  a\0").get("a"), "D");
  assert.equal(parseStatus("D  a\0?? a\0").get("a"), "D");
});

test("S1, S3: a folder takes its dominant status: M over A and U over R over C, the first of a tie", () => {
  assert.equal(dominantStatus(["C", "R"]), "R");
  assert.equal(dominantStatus(["R", "U"]), "U");
  assert.equal(dominantStatus(["U", "A"]), "U");
  assert.equal(dominantStatus(["A", "U"]), "A");
  assert.equal(dominantStatus(["A", "M", "U"]), "M");
  assert.equal(dominantStatus(["M", "D"]), "D");
  assert.equal(dominantStatus([]), null);
  const folders = buildFolderStatus(new Map([["src/a/x.js", "A"], ["src/a/y.js", "M"], ["src/b/z.js", "C"], ["top.js", "M"]]));
  assert.deepEqual([...folders].sort(), [["src", "M"], ["src/a", "M"], ["src/b", "C"]]);
});

test("S3: a deleted file reaches no folder (Orca's shouldPropagateStatus)", () => {
  const folders = buildFolderStatus(new Map([["src/gone.js", "D"], ["src/new.js", "U"], ["only/gone.js", "D"]]));
  assert.equal(folders.get("src"), "U");
  assert.equal(folders.has("only"), false);
});

test("S3: a path is ignored if it or any folder above it is listed", () => {
  const ignored = parseIgnored("dist/\0a.log\0deep/er/\0");
  assert.deepEqual([...ignored], ["dist", "a.log", "deep/er"]);
  assert.equal(isIgnored(ignored, "dist"), true);
  assert.equal(isIgnored(ignored, "dist/x/y.js"), true);
  assert.equal(isIgnored(ignored, "deep/er/z"), true);
  assert.equal(isIgnored(ignored, "deep"), false);
  assert.equal(isIgnored(ignored, "distant"), false);
  assert.equal(isIgnored(new Set(), "a"), false);
});

test("D7: against a real git: marks and ignored paths, relative to the repo's top, with awkward names", () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, ".gitignore"), "dist/\n*.log\n");
  writeFileSync(join(repo, "src/kept.js"), "1\n");
  writeFileSync(join(repo, "src/gone.js"), "1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "first"]);
  writeFileSync(join(repo, "src/kept.js"), "2\n");
  rmSync(join(repo, "src/gone.js"));
  writeFileSync(join(repo, "it's new.js"), "");
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist/out.js"), "");
  writeFileSync(join(repo, "src/debug.log"), "");
  writeFileSync(join(repo, "staged.js"), "");
  git(repo, ["add", "staged.js"]);

  const marks = parseStatus(git(join(repo, "src"), STATUS_ARGS));
  assert.deepEqual(Object.fromEntries(marks), { "src/kept.js": "M", "src/gone.js": "D", "it's new.js": "U", "staged.js": "A" });
  assert.equal(buildFolderStatus(marks).get("src"), "M");

  const ignored = parseIgnored(git(repo, IGNORED_ARGS));
  assert.deepEqual([...ignored].sort(), ["dist", "src/debug.log"]);
});

test("D7: reading status and ignored paths writes nothing under .git, so the folder watch doesn't wake itself", () => {
  assert.deepEqual(STATUS_ARGS.slice(0, 3), ["--no-optional-locks", "-c", "core.fsmonitor=false"]);
  assert.deepEqual(STATUS_ARGS.slice(3), ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  assert.deepEqual(IGNORED_ARGS.slice(0, 3), ["--no-optional-locks", "-c", "core.fsmonitor=false"]);
});

test("S1: the header names the repo: its own folder in a main checkout, the main checkout's in a worktree", () => {
  const repo = join(root, "herdr-plugins");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "a"), "");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "first"]);
  const tree = join(root, "pipefish");
  git(repo, ["worktree", "add", "-q", tree]);
  assert.deepEqual(parseRepo(git(repo, ROOT_ARGS)), { top: repo, name: "herdr-plugins" });
  assert.deepEqual(parseRepo(git(join(repo, "sub"), ROOT_ARGS)), { top: repo, name: "herdr-plugins" });
  assert.deepEqual(parseRepo(git(tree, ROOT_ARGS)), { top: tree, name: "herdr-plugins" });
  assert.equal(basename(tree), "pipefish");
});

test("S1: a bare repo's worktree drops .git from the name; anything odd falls back to the folder", () => {
  assert.deepEqual(parseRepo("/w/feature\n/bare/app.git\n"), { top: "/w/feature", name: "app" });
  assert.deepEqual(parseRepo("/w/sub\n/super/.git/modules/sub\n"), { top: "/w/sub", name: "sub" });
  assert.equal(parseRepo(""), null);
});
