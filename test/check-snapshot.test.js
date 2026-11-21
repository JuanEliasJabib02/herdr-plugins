// scripts/check-snapshot.sh (split-tests D7): a task's check on HEAD plus its
// own files, in odd/check-<task>. It runs, through the snapshot's
// scripts/test.mjs, the suites of the folders those files are in (scripts/,
// the root test/ and a root file are the suite named root), with the
// untracked files of those same folders. Each run is on a temporary git repo
// with copies of both scripts and two fake suites.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

// Git must never read the person's config nor a GIT_DIR inherited from a
// hook; the snapshot's `node --test` must not see this test's
// NODE_TEST_CONTEXT.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "check-snapshot-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "NODE_TEST_CONTEXT"]) delete ENV[k];

const PASSES = 'import { test } from "node:test";\ntest("one", () => {});\ntest("two", () => {});\n';
const FAILS = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("breaks", () => { assert.equal(1, 2); });\n';

let n = 0;
const write = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8", stdio: "pipe" });

// A committed repo with both scripts, the root suite and two plugins, plus
// `extra` files.
function fakeRepo(extra = {}) {
  const dir = join(scratch, `repo-${++n}`);
  write(dir, {
    ".gitignore": "odd/\n",
    "package.json": "{}\n",
    "test/root.test.js": PASSES,
    "alpha/mods/a.js": "export const a = 1;\n",
    "alpha/test/a.test.js": PASSES,
    "beta/test/b.test.js": PASSES,
    ...extra,
  });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const name of ["check-snapshot.sh", "test.mjs"]) copyFileSync(join(repo, "scripts", name), join(dir, "scripts", name));
  chmodSync(join(dir, "scripts/check-snapshot.sh"), 0o755);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}
const check = (dir, ...args) => spawnSync(join(dir, "scripts/check-snapshot.sh"), args, { cwd: scratch, env: ENV, encoding: "utf8" });
const out = (r) => r.stdout + r.stderr;

test("D7: a plugin's file runs that plugin's suite, with the untracked files of its folder only; another task's edit to a committed file stays out", () => {
  const dir = fakeRepo();
  write(dir, {
    "alpha/mods/a.js": "export const a = 2;\n", // the task's own file
    "alpha/test/new.test.js": PASSES, // untracked, same folder: in
    "beta/test/new.test.js": FAILS, // untracked, another folder: out
    "alpha/test/a.test.js": FAILS, // committed, edited, not given: out
  });
  const r = check(dir, "T1", "alpha/mods/a.js");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /^check-snapshot: T1: HEAD \w+ \+ 1 untracked \+ 1 own file\(s\) in odd\/check-T1$/m);
  assert.match(r.stdout, /^alpha +2 +4 +0 +\d+\.\d$/m, "alpha, its untracked test included");
  assert.doesNotMatch(r.stdout, /^(root|beta) /m, "only the given files' suites");
  assert.equal(existsSync(join(dir, "odd/check-T1/beta/test/new.test.js")), false);
  assert.match(r.stdout, /check-snapshot: T1 ok\n$/);
});

test("D7: scripts/, the root test/ and a root file run the root suite; suites run once each, root first", () => {
  const dir = fakeRepo();
  write(dir, { "test/extra.test.js": PASSES }); // untracked, in test/: in
  const r = check(dir, "simplify-check", "package.json", "beta/test/b.test.js", "test/root.test.js", "scripts/test.mjs");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /\+ 1 untracked \+ 4 own file\(s\)/);
  assert.match(r.stdout, /^suite +files +pass +fail +seconds\nroot +2 +4 +0 +\d+\.\d\nbeta +1 +2 +0 +\d+\.\d\n/m);
  assert.match(r.stdout, /check-snapshot: simplify-check ok\n$/);
});

test("D7: the snapshot runs what --changed would for the given files: a changed scripts/ also runs the other suites' files that use it", () => {
  const dir = fakeRepo({
    "scripts/install.sh": "#!/bin/sh\n",
    "beta/test/install.test.js": `const INSTALL = "../../scripts/install.sh";\n${PASSES}`,
  });
  write(dir, { "scripts/install.sh": "#!/bin/sh\nexit 0\n" });
  const r = check(dir, "T4", "scripts/install.sh");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /^suite +files +pass +fail +seconds\nroot +1 +2 +0 +\d+\.\d\nbeta +1 +2 +0 +\d+\.\d\n/m, "root whole, beta's install test alone");
  assert.doesNotMatch(r.stdout, /^alpha /m);
  assert.match(r.stdout, /check-snapshot: T4 ok\n$/);
});

test("D7: ./ in front of a file is the same file: its folder's untracked files only, never every untracked file", () => {
  const dir = fakeRepo();
  write(dir, {
    "alpha/mods/a.js": "export const a = 2;\n",
    "alpha/test/new.test.js": PASSES, // untracked, same folder: in
    "beta/test/new.test.js": FAILS, // untracked, another folder: out
  });
  const r = check(dir, "T5", "./alpha/mods/a.js");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /\+ 1 untracked \+ 1 own file\(s\)/);
  assert.match(r.stdout, /^alpha +2 +4 +0 +\d+\.\d$/m);
  assert.equal(existsSync(join(dir, "odd/check-T5/beta/test/new.test.js")), false);
  assert.equal(existsSync(join(dir, "odd/check-T5/alpha/mods/a.js")), true);
  assert.match(r.stdout, /check-snapshot: T5 ok\n$/);
});

test("D7: a folder with no test/ adds its untracked files, and nothing to test is a pass", () => {
  const dir = fakeRepo({ "docs/notes.md": "# notes\n" });
  write(dir, { "docs/notes.md": "# notes, edited\n", "docs/more.md": "# more\n" });
  const r = check(dir, "T6", "docs/notes.md");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /\+ 1 untracked \+ 1 own file\(s\)/, "docs/more.md");
  assert.equal(existsSync(join(dir, "odd/check-T6/docs/more.md")), true);
  assert.match(r.stdout, /^nothing to test\ncheck-snapshot: T6 ok\n$/m);
});

test("D7: a failing suite fails the check, and points at the full output", () => {
  const dir = fakeRepo();
  write(dir, { "alpha/test/a.test.js": FAILS });
  const r = check(dir, "T2", "alpha/test/a.test.js");
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /^alpha +1 +0 +1 +\d+\.\d$/m);
  assert.match(r.stdout, /check-snapshot: T2: a suite failed \(exit 1\); full output in odd\/check-T2\/check-snapshot\.log\n$/);
  assert.equal(existsSync(join(dir, "odd/check-T2/check-snapshot.log")), true);
});

test("D7: a task name that isn't letters, digits and dashes, or no file, is a usage error", () => {
  const dir = fakeRepo();
  for (const args of [["a/b", "alpha/mods/a.js"], ["..", "alpha/mods/a.js"], ["T1"], ["T1", "--", "footer"]]) {
    const r = check(dir, ...args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${out(r)}`);
    assert.match(r.stderr, /^usage: scripts\/check-snapshot\.sh/, args.join(" "));
  }
});
