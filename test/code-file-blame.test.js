// T9: the Blame column (plan D12, S7): blame-model.js against a real git in
// throwaway repos, so what's parsed is what git prints, a line with no commit
// included. The view and its button are in code-file-view.test.js, in a fake Herdr.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLAME_TEXT, blameArgs, blameDate, blameDir, blameFailure, blameLabel, blameTarget, isBlameCommand, parseBlame,
} from "../code-editor/mods/code-file/blame-model.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "code-file-blame-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args, extra = {}) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", stdio: "pipe" });

let dirs = 0;
function newRepo() {
  const dir = join(root, `repo-${++dirs}`);
  mkdirSync(dir);
  git(dir, ["init", "-q", "."]);
  return dir;
}

function commit(cwd, author, date, message = "change") {
  git(cwd, ["add", "-A"]);
  const who = { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: "a@a", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  git(cwd, ["commit", "-qm", message], who);
}

// The file as the view asks for it: the text on screen, through --contents.
let temps = 0;
function blameOf(cwd, name, text) {
  const temp = join(root, `buffer-${++temps}`);
  writeFileSync(temp, text);
  return execFileSync("git", blameArgs(name, temp), { cwd, env, encoding: "utf8", stdio: "pipe" });
}

const labels = (stdout) => Array.from(parseBlame(stdout), blameLabel);
const ANA = { author: "Ana María", date: "2024-03-05" };
const BOB = { author: "Bob", date: "2025-01-02" };
const NONE = { author: "sin commit", date: null };

function twoAuthors() {
  const dir = newRepo();
  writeFileSync(join(dir, "a.js"), "one\ntwo\nthree\n");
  commit(dir, "Ana María", "2024-03-05T23:30:00-0500", "first");
  writeFileSync(join(dir, "a.js"), "one\nTWO\nthree\nfour\n");
  commit(dir, "Bob", "2025-01-02T10:00:00+0000", "second");
  return dir;
}

// ── Done when: real porcelain, a line with no commit included ───────────────

test("S7: real porcelain: author and date per line, a commit's later lines too, and a line with no commit", () => {
  const dir = twoAuthors();
  writeFileSync(join(dir, "a.js"), "one\nTWO\nthree\nfour\non disk, never committed\n");
  const stdout = git(dir, ["blame", "--porcelain", "--", "a.js"]);
  assert.ok(stdout.includes("Not Committed Yet"), "this git says so in its own words");
  assert.deepEqual(labels(stdout), [ANA, BOB, ANA, BOB, NONE]);
});

test("S7: lines that aren't saved, through --contents, have no commit; those that are keep theirs", () => {
  const dir = twoAuthors();
  const stdout = blameOf(dir, "a.js", "one\nnot saved\nthree\nfour\nnot saved\nnor this\n");
  assert.ok(stdout.includes("External file (--contents)"), "this git says so in its own words");
  assert.deepEqual(labels(stdout), [ANA, NONE, ANA, BOB, NONE, NONE]);
});

test("S7: a clean buffer through --contents says what the file's own blame says", () => {
  const dir = twoAuthors();
  const text = "one\nTWO\nthree\nfour\n";
  assert.deepEqual(labels(blameOf(dir, "a.js", text)), labels(git(dir, ["blame", "--porcelain", "--", "a.js"])));
  assert.deepEqual(labels(blameOf(dir, "a.js", text)), [ANA, BOB, ANA, BOB]);
});

test("S7: a line's text that looks like a header or a field changes nothing", () => {
  const dir = newRepo();
  const zero = "0".repeat(40);
  writeFileSync(join(dir, "a.txt"), `author Mallory\n${zero} 1 1 1\nauthor-time 1\nsummary x\n`);
  commit(dir, "Ana María", "2024-03-05T23:30:00-0500");
  assert.deepEqual(labels(blameOf(dir, "a.txt", `author Mallory\n${zero} 1 1 1\nauthor-time 1\nsummary x\n`)), [ANA, ANA, ANA, ANA]);
});

test("S7: a file with odd names is blamed by that one name, whatever it says", () => {
  const dir = newRepo();
  const names = ["a b.js", "it's.js", "-rf", "--help", "$(x)", '"q"', "ñandú.js"];
  for (const name of names) writeFileSync(join(dir, name), "x\n");
  commit(dir, "Bob", "2025-01-02T10:00:00+0000");
  for (const name of names) assert.deepEqual(labels(blameOf(dir, name, "x\n")), [BOB], name);
});

test("S7: a file in a subfolder is blamed from its own folder", () => {
  const dir = newRepo();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), "x\n");
  commit(dir, "Bob", "2025-01-02T10:00:00+0000");
  const { cwd, name } = blameTarget(join(dir, "src/a.js"));
  assert.equal(cwd, join(dir, "src"));
  assert.equal(name, "a.js");
  assert.deepEqual(labels(blameOf(cwd, name, "x\n")), [BOB]);
});

test("S7: a symlink is blamed through its target: by its own name every line would have no commit", () => {
  const dir = newRepo();
  writeFileSync(join(dir, "a.js"), "x\n");
  symlinkSync("a.js", join(dir, "link.js"));
  commit(dir, "Bob", "2025-01-02T10:00:00+0000");
  assert.deepEqual(labels(blameOf(dir, "link.js", "x\n")), [NONE]);
  const { cwd, name } = blameTarget(realpathSync(join(dir, "link.js")));
  assert.deepEqual(labels(blameOf(cwd, name, "x\n")), [BOB]);
});

// ── What git refuses ─────────────────────────────────────────────────────────

test("S7: what git refuses comes back as its own first line, without `fatal:`, and parses to nothing", () => {
  const cases = [];
  const repo = twoAuthors();
  writeFileSync(join(repo, "new.js"), "x\n");
  cases.push([repo, "new.js", "no such path 'new.js' in HEAD"]);
  const empty = newRepo();
  writeFileSync(join(empty, "n.js"), "x\n");
  cases.push([empty, "n.js", "no such ref: HEAD"]);
  const plain = join(root, "not-a-repo");
  mkdirSync(plain);
  writeFileSync(join(plain, "n.js"), "x\n");
  cases.push([plain, "n.js", "not a git repository (or any of the parent directories): .git"]);
  for (const [cwd, name, words] of cases) {
    const temp = join(root, `buffer-${++temps}`);
    writeFileSync(temp, "x\n");
    const r = spawnSync("git", blameArgs(name, temp), { cwd, env: { ...env, GIT_CEILING_DIRECTORIES: root }, encoding: "utf8" });
    assert.notEqual(r.status, 0, name);
    assert.deepEqual(parseBlame(r.stdout), [], name);
    assert.equal(blameFailure({ code: r.status, stdout: r.stdout, stderr: r.stderr }), words);
  }
});

test("S7: a failure with nothing on stderr still says something", () => {
  assert.equal(blameFailure({ code: 128, stdout: "", stderr: "" }), "git blame: exit 128");
  assert.equal(blameFailure({ code: 1, stdout: "", stderr: "\n\nwarning: x\nmore" }), "warning: x");
});

// ── Output cut short: Herdr's exec stops at 8 MiB ────────────────────────────

test("S7: output cut anywhere: never throws, and a line counts only once its text arrived, with all its fields", () => {
  const dir = twoAuthors();
  const stdout = blameOf(dir, "a.js", "one\nnot saved\nthree\nfour\n");
  const whole = parseBlame(stdout).length;
  let seen = 0;
  for (let cut = 0; cut < stdout.length; cut++) {
    const lines = parseBlame(stdout.slice(0, cut));
    assert.ok(lines.length <= whole);
    assert.ok(lines.length >= seen, "only ever more lines");
    seen = lines.length;
    for (const entry of lines) {
      assert.equal(typeof entry.author, "string");
      assert.equal(typeof entry.time, "number");
      assert.equal(typeof blameLabel(entry).author, "string");
    }
  }
  assert.equal(seen, whole);
});

test("S7: a header line cut short isn't a line: its number could be any", () => {
  const sha = "a".repeat(40);
  const stdout = `${sha} 1 1 1\nauthor A\nauthor-time 0\nauthor-tz +0000\n\tx\n${sha} 2 5`;
  assert.equal(parseBlame(stdout).length, 1);
});

test("S7: nothing printed is no lines; no entry is no label", () => {
  assert.deepEqual(parseBlame(""), []);
  assert.equal(blameLabel(undefined), null);
});

test("S7: a SHA-256 repo's line with no commit is one too", () => {
  const zero = "0".repeat(64);
  const stdout = `${zero} 1 1 1\nauthor Not Committed Yet\nauthor-time 0\nauthor-tz +0000\n\tx\n`;
  assert.deepEqual(labels(stdout), [NONE]);
});

// ── The date ─────────────────────────────────────────────────────────────────

test("S7: the date is the author's day, in the author's zone, as `git blame` prints it", () => {
  assert.equal(blameDate(1709699400, "-0500"), "2024-03-05", "already the 6th in UTC");
  assert.equal(blameDate(1735812000, "+0000"), "2025-01-02");
  assert.equal(blameDate(1735756200, "+0530"), "2025-01-02", "still the 1st in UTC");
});

test("S7: a missing or odd time is no date, not a throw in the middle of a frame", () => {
  assert.equal(blameDate(Number.NaN, "+0000"), "");
  assert.equal(blameDate(undefined, "+0000"), "");
  assert.equal(blameDate(0, "nonsense"), "1970-01-01");
  assert.equal(blameDate(0, undefined), "1970-01-01");
});

// ── The rest of the model ────────────────────────────────────────────────────

test("S7: what git is asked: porcelain, the text on screen, and the name after `--`", () => {
  assert.deepEqual(blameArgs("-rf", "/home/x/temp"), ["blame", "--porcelain", "--contents", "/home/x/temp", "--", "-rf"]);
});

test("S7: where the copy of the buffer goes is the app's folder, beside drafts and not among them", () => {
  assert.equal(blameDir("/home/x/.config/herdr-app"), "/home/x/.config/herdr-app/code-editor/blame");
  assert.equal(blameDir("/home/x/.config/herdr-app/"), "/home/x/.config/herdr-app/code-editor/blame");
});

test("S7: a file at the disk's root has a folder too", () => {
  assert.deepEqual(blameTarget("/a.js"), { cwd: "/", name: "a.js" });
});

test("S7: the command, with or without the mod's prefix, and nothing that merely looks like it", () => {
  assert.equal(isBlameCommand("blame"), true);
  assert.equal(isBlameCommand("code-file.blame"), true);
  for (const other of ["blame-d1", "other.blame", "Blame", "", null, undefined]) assert.equal(isBlameCommand(other), false, String(other));
});

test("S7: the words", () => {
  assert.equal(BLAME_TEXT.button, "Blame");
  assert.equal(BLAME_TEXT.uncommitted, "sin commit");
});
