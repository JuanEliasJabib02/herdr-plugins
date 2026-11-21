// scripts/test.mjs (split-tests D2–D6): one runner for every suite. A suite
// is the root test/ (named root) or a top-level folder with test/*.test.js.
// `--changed` runs the suites a branch touched whole, plus the test files of
// other suites that name a touched folder as a path; a suite's helper that
// names one runs its whole suite. The selection is a pure function, tested
// here on fake suites; the last tests drive the runner itself on a temporary
// repo: --changed --list (on a git one), and runs (one suite after another, a
// header line before each, a table at the end, the exit code). This repo's
// own map, who reads whom, is test-deps.test.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, foldersRead, select, everySuite, namedSuites, listLines, headLine, tableLines } from "../scripts/test.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(repo, "scripts/test.mjs");

// ── Fake suites for the pure selection ─────────────────────────────────────

// { name, dir, files: [{ path, text }], helpers: [{ path, text }] }, as
// findSuites reads them.
const suite = (name, files, helpers = {}) => ({
  name,
  dir: name === ROOT ? "" : name,
  files: Object.entries(files).map(([path, text]) => ({ path, text })),
  helpers: Object.entries(helpers).map(([path, text]) => ({ path, text })),
});
const IMPORTS_ALPHA = 'import { a } from "../../alpha/mods/a.js";\n';
const SUITES = [
  suite(ROOT, { "test/install.test.js": 'const INSTALL = join(repo, "scripts/install.sh");\n', "test/other.test.js": "test();\n" }),
  suite("alpha", { "test/a.test.js": "test();\n", "test/b.test.js": "test();\n" }),
  suite("beta", { "test/reads.test.js": IMPORTS_ALPHA, "test/alone.test.js": "test();\n" }),
  suite("gamma", { "test/g.test.js": "test();\n" }, { "test/harness.js": "export const ACCOUNTS = `${APP}/alpha/accounts.json`;\n" }),
  suite("delta", { "test/install.test.js": 'spawnSync("sh", [join(repo, "scripts/install.sh"), "delta"]);\n', "test/d.test.js": "test();\n" }),
];
const byName = (plan) => Object.fromEntries(plan.map((e) => [e.name, e]));

test("D3: a change inside a suite's folder runs that suite whole, because it changed", () => {
  const plan = select(["alpha/mods/x.js"], SUITES.filter((s) => s.name === "alpha"));
  assert.deepEqual(plan, [{ name: "alpha", dir: "alpha", files: ["test/a.test.js", "test/b.test.js"], why: "changed", reads: null }]);
  assert.equal(byName(select(["alpha/RECIPE.md"], SUITES)).alpha.why, "changed", "any file of the folder, docs included");
});

test("D3: scripts/, the root test/ and a root file run the root suite; a root *.md runs nothing", () => {
  for (const path of ["scripts/check-views.sh", "test/other.test.js", "package.json", ".gitignore"]) {
    const plan = select([path], [SUITES[0]]);
    assert.deepEqual(plan.map((e) => [e.name, e.why, e.files.length]), [[ROOT, "changed", 2]], path);
  }
  assert.deepEqual(select(["README.md"], SUITES), [], "README.md alone: nothing to test");
  assert.deepEqual(select([], SUITES), []);
});

test("D3: a changed folder that isn't a suite runs nothing by itself", () => {
  assert.deepEqual(select(["docs/notes.txt"], SUITES), []);
});

test("D4: another suite's test file that names the changed folder runs, alone, with what it reads", () => {
  const plan = byName(select(["alpha/mods/a.js"], SUITES));
  assert.deepEqual(plan.beta, {
    name: "beta",
    dir: "beta",
    files: ["test/reads.test.js"],
    why: "it reads alpha/",
    reads: [{ file: "test/reads.test.js", folders: ["alpha"] }],
  });
  assert.equal(plan.delta, undefined, "delta names no changed folder");
});

test("D4: X/ counts right after a double or single quote, a backtick, ../ or /", () => {
  for (const text of ['"alpha/x"', "'alpha/x'", "`alpha/x`", '"../../alpha/x"', "`${APP}/alpha/accounts.json`", 'join(repo, "alpha/mods/x")']) {
    assert.deepEqual(foldersRead(`const p = ${text};\n`, ["alpha"]), ["alpha"], text);
  }
});

test("D4: X whole between two of the same quote counts too as a path call's argument: right after a comma", () => {
  for (const text of [
    'join(box, "alpha", "x.json")',
    "join(app, 'alpha')",
    'join(app,"alpha")',
    "join(app, `alpha`)",
    'join(app, "mods", "alpha", "bin")',
    'run(INSTALL, home, "--no-keys",   "alpha")',
  ]) {
    assert.deepEqual(foldersRead(`const p = ${text};\n`, ["alpha"]), ["alpha"], text);
  }
  assert.deepEqual(foldersRead('const p = join(\n  app,\n  "alpha",\n);\n', ["alpha"]), ["alpha"], "an argument on a line of its own");
});

test("D4: X whole between quotes as a key, a key's value or alone doesn't count: a name, not a path", () => {
  for (const text of [
    '{ name: "alpha" }',
    "{ id: 's2', mod: 'alpha' }",
    '{ "alpha": { "dev": 1 } }',
    '{ x: 1, "alpha": 2 }',
    '{ x: 1, "alpha" : 2 }',
    '"alpha"',
    "`alpha`",
    '["alpha"]',
    'list.includes("alpha")',
  ]) {
    assert.deepEqual(foldersRead(`const p = ${text};\n`, ["alpha"]), [], text);
  }
});

test("D4: a name without its slash or its quotes, inside another word, or on a comment line doesn't count", () => {
  for (const text of [
    'const p = "alpha-beta";',
    "const p = 'alphas';",
    'const p = "alpha.json";',
    "const p = \"alpha';",
    "const p = `${alpha}`;",
    'const p = "xalpha/y";',
    "const p = alpha/2;",
    "// reads ../alpha/x",
    '  // join(box, "alpha", "x.json")',
    "   * see `alpha/RECIPE.md`",
    "/* the ../alpha/ folder */",
    "# cat $HOME/alpha/x",
  ]) {
    assert.deepEqual(foldersRead(`${text}\n`, ["alpha"]), [], text);
  }
  assert.deepEqual(foldersRead('code(); // "alpha/x" after code still counts\n', ["alpha"]), ["alpha"], "only lines that start as comments");
});

test("D4: several changed folders: each file says which it reads, the suite line names them all", () => {
  const suites = [
    suite("alpha", { "test/a.test.js": "test();\n" }),
    suite("epsilon", { "test/e.test.js": "test();\n" }),
    suite("beta", { "test/one.test.js": IMPORTS_ALPHA, "test/two.test.js": 'read("../../epsilon/x.json");\n' + IMPORTS_ALPHA, "test/none.test.js": "" }),
  ];
  const { beta } = byName(select(["epsilon/x.json", "alpha/a.js"], suites));
  assert.deepEqual(beta.files, ["test/one.test.js", "test/two.test.js"]);
  assert.equal(beta.why, "they read alpha/, epsilon/");
  assert.deepEqual(beta.reads, [
    { file: "test/one.test.js", folders: ["alpha"] },
    { file: "test/two.test.js", folders: ["alpha", "epsilon"] },
  ]);
});

test("D4: a helper under test/ that names the changed folder runs its whole suite", () => {
  const { gamma } = byName(select(["alpha/accounts.json"], SUITES));
  assert.deepEqual(gamma, { name: "gamma", dir: "gamma", files: ["test/g.test.js"], why: "test/harness.js reads alpha/", reads: null });
});

test("D4: a changed scripts/ runs the root suite and the other suites' files that use scripts/install.sh", () => {
  const plan = byName(select(["scripts/install.sh"], SUITES));
  assert.equal(plan[ROOT].why, "changed");
  assert.deepEqual(plan.delta.files, ["test/install.test.js"]);
  assert.equal(plan.delta.why, "it reads scripts/");
  assert.equal(plan.beta, undefined);
});

test("D4: a change in the root test/ doesn't run other suites' files that name a test/ folder", () => {
  const suites = [SUITES[0], suite("beta", { "test/t.test.js": 'new URL("test/fixtures/x.json", import.meta.url);\n' })];
  assert.deepEqual(select(["test/other.test.js"], suites).map((e) => e.name), [ROOT]);
});

test("D4: a suite that changed runs whole even when its files also read another changed folder", () => {
  const plan = byName(select(["alpha/a.js", "beta/mods/b.js"], SUITES));
  assert.equal(plan.beta.why, "changed");
  assert.deepEqual(plan.beta.files, ["test/reads.test.js", "test/alone.test.js"]);
  assert.equal(plan.beta.reads, null);
});

test("D2: suites keep their order: root first, then the folders by name", () => {
  const suites = [SUITES[0], suite("alpha", { "test/a.test.js": "" }), suite("beta", { "test/b.test.js": IMPORTS_ALPHA })];
  assert.deepEqual(select(["beta/x", "alpha/x", "package.json"], suites).map((e) => e.name), [ROOT, "alpha", "beta"]);
});

test("D2: every suite, or the named ones in the order given; an unknown name says which exist", () => {
  assert.deepEqual(everySuite(SUITES).map((e) => [e.name, e.why, e.files.length]), [
    [ROOT, "all suites", 2],
    ["alpha", "all suites", 2],
    ["beta", "all suites", 2],
    ["gamma", "all suites", 1],
    ["delta", "all suites", 2],
  ]);
  assert.deepEqual(namedSuites(["gamma", "alpha/"], SUITES).map((e) => [e.name, e.why]), [["gamma", "named"], ["alpha", "named"]], "a trailing slash (tab completion) is fine");
  assert.throws(() => namedSuites(["alpha", "nope"], SUITES), /no suite named nope; suites: root, alpha, beta, gamma, delta/);
});

test("D5: one line per suite with its name, the file count and why; --list adds each file another suite reads", () => {
  const plan = select(["alpha/a.js"], SUITES);
  assert.equal(headLine(plan[0]), "alpha: 2 files, changed");
  assert.deepEqual(listLines(plan), [
    "alpha: 2 files, changed",
    "beta: 1 file, it reads alpha/",
    "  test/reads.test.js reads alpha/",
    "gamma: 1 file, test/harness.js reads alpha/",
  ]);
});

test("D5: the table: suite | files | pass | fail | seconds, aligned; a suite with no counts shows ?", () => {
  assert.deepEqual(
    tableLines([
      { name: ROOT, files: 2, pass: 47, fail: 0, seconds: 4.04 },
      { name: "the-longest-name", files: 14, pass: 513, fail: 2, seconds: 12.3 },
      { name: "gamma", files: 1, pass: null, fail: null, seconds: 0.25 },
    ]),
    [
      "suite             files  pass  fail  seconds",
      "root                  2    47     0      4.0",
      "the-longest-name     14   513     2     12.3",
      "gamma                 1     ?     ?      0.3",
    ],
  );
});

// ── The runner on a temporary repo (D3, D5, D6) ────────────────────────────

// Git must never read the person's config (signing, hooks, default branch)
// nor a GIT_DIR inherited from a hook that runs these tests; the runner's
// own `node --test` must not see this test's NODE_TEST_CONTEXT.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "test-runner-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "NODE_TEST_CONTEXT"]) delete ENV[k];

let n = 0;
const write = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8", stdio: "pipe" });
const commitAll = (dir, message) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};

const PASSES = 'import { test } from "node:test";\ntest("one", () => {});\ntest("two", () => {});\n';
// A repo with this runner in scripts/, three suites and a README; no git,
// which only --changed needs.
function fakeRepo(extra = {}) {
  const dir = join(scratch, `repo-${++n}`);
  write(dir, {
    "README.md": "# fake\n",
    "package.json": "{}\n",
    "test/root.test.js": PASSES,
    "alpha/mods/a.js": "export const a = 1;\n",
    "alpha/test/a.test.js": PASSES,
    "beta/test/reads.test.js": IMPORTS_ALPHA + PASSES,
    "beta/test/alone.test.js": PASSES,
    "gamma/test/g.test.js": PASSES,
    ...extra,
  });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(RUNNER, join(dir, "scripts/test.mjs"));
  return dir;
}
// The same, for --changed: all on main, then a branch `work` checked out.
function gitRepo(extra = {}) {
  const dir = fakeRepo(extra);
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "work");
  return dir;
}
// The runner, from a cwd outside the repo: it finds its repo by itself.
const runner = (dir, ...args) => spawnSync(process.execPath, [join(dir, "scripts/test.mjs"), ...args], { cwd: scratch, env: ENV, encoding: "utf8" });

test("D6, --changed --list: the branch's commits, staged, unstaged and untracked files; what reads them; nothing runs", () => {
  const dir = gitRepo();
  write(dir, { "alpha/mods/a.js": "export const a = 2;\n" });
  commitAll(dir, "alpha on the branch");
  const r = runner(dir, "--changed", "--list");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["alpha: 1 file, changed", "beta: 1 file, it reads alpha/", "  test/reads.test.js reads alpha/"]);
  assert.doesNotMatch(r.stdout, /\.\.|suite\s+files/, "--list runs nothing: no dots, no table");

  write(dir, { "gamma/test/g.test.js": `${PASSES}// edited\n` }); // unstaged
  write(dir, { "test/new.test.js": PASSES }); // untracked
  const r2 = runner(dir, "--changed", "--list");
  assert.deepEqual(r2.stdout.trim().split("\n"), ["root: 2 files, changed", "alpha: 1 file, changed", "beta: 1 file, it reads alpha/", "  test/reads.test.js reads alpha/", "gamma: 1 file, changed"]);

  git(dir, "add", "-A");
  assert.equal(runner(dir, "--changed", "--list").stdout, r2.stdout, "staged counts the same");
});

test("D3: a file moved out of a suite changes both folders; a root *.md alone is nothing to test", () => {
  const dir = gitRepo({ "gamma/test/h.test.js": PASSES });
  write(dir, { "notes.md": "x\n" });
  const md = runner(dir, "--changed", "--list");
  assert.equal(md.status, 0, md.stderr);
  assert.equal(md.stdout.trim(), "nothing to test");
  const run = runner(dir, "--changed");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "nothing to test");

  // git diff would show a rename as its new path alone: gamma, which the
  // file left, must run too.
  rmSync(join(dir, "notes.md"));
  mkdirSync(join(dir, "delta/test"), { recursive: true });
  renameSync(join(dir, "gamma/test/g.test.js"), join(dir, "delta/test/g.test.js"));
  commitAll(dir, "move g to delta");
  assert.deepEqual(runner(dir, "--changed", "--list").stdout.trim().split("\n"), ["delta: 1 file, changed", "gamma: 1 file, changed"]);
});

test("D2: --changed <base> diffs against that base; a base that doesn't exist fails with 2", () => {
  const dir = gitRepo();
  write(dir, { "alpha/mods/a.js": "export const a = 2;\n" });
  commitAll(dir, "alpha");
  git(dir, "branch", "alpha-done");
  write(dir, { "gamma/mods/g.js": "export const g = 1;\n" });
  commitAll(dir, "gamma");
  assert.deepEqual(runner(dir, "--changed", "alpha-done", "--list").stdout.trim().split("\n"), ["gamma: 1 file, changed"]);
  assert.match(runner(dir, "--changed", "--list").stdout, /^alpha: 1 file, changed$/m, "main by default");
  const bad = runner(dir, "--changed", "nope", "--list");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /nope/);
});

test("D2: --list alone lists every suite; a named suite that doesn't exist fails with 2 and lists them", () => {
  const dir = fakeRepo();
  assert.deepEqual(runner(dir, "--list").stdout.trim().split("\n"), ["root: 1 file, all suites", "alpha: 1 file, all suites", "beta: 2 files, all suites", "gamma: 1 file, all suites"]);
  assert.deepEqual(runner(dir, "gamma", "alpha", "--list").stdout.trim().split("\n"), ["gamma: 1 file, named", "alpha: 1 file, named"]);
  const bad = runner(dir, "nope");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no suite named nope; suites: root, alpha, beta, gamma/);
  const mixed = runner(dir, "--changed", "main", "alpha");
  assert.equal(mixed.status, 2, "--changed takes one base, not suite names");
});

test("D2, --files: the given repo paths select as --changed would, without git; ./ in front is the same path", () => {
  const dir = fakeRepo({ "gamma/test/install.test.js": `const INSTALL = "../../scripts/install.sh";\n${PASSES}` });
  const lines = (...args) => runner(dir, ...args).stdout.trim().split("\n");
  assert.deepEqual(lines("--files", "scripts/install.sh", "--list"), ["root: 1 file, changed", "gamma: 1 file, it reads scripts/", "  test/install.test.js reads scripts/"]);
  assert.deepEqual(lines("--list", "--files", "./alpha/mods/a.js", "gamma/x.js"), [
    "alpha: 1 file, changed",
    "beta: 1 file, it reads alpha/",
    "  test/reads.test.js reads alpha/",
    "gamma: 2 files, changed",
  ]);
  assert.deepEqual(lines("--files", "README.md", "docs/notes.txt"), ["nothing to test"]);
  const run = runner(dir, "--files", "alpha/mods/a.js");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^alpha: 1 file, changed$/m);
  assert.match(run.stdout, /^beta +1 +2 +0 +\d+\.\d$/m, "it runs what it lists");
});

test("D2, --files: a bare name that is a suite or a folder of the repo is that folder; a root file stays a root file", () => {
  const dir = fakeRepo({ "docs/notes.md": "# notes\n", "scripts/install.sh": "#!/bin/sh\n", "gamma/test/home.test.js": `const HOME = "/root/x";\n${PASSES}` });
  const lines = (...args) => runner(dir, ...args).stdout.trim().split("\n");
  assert.deepEqual(lines("--files", "alpha", "--list"), ["alpha: 1 file, changed", "beta: 1 file, it reads alpha/", "  test/reads.test.js reads alpha/"]);
  assert.deepEqual(lines("--files", "./gamma", "--list"), ["gamma: 2 files, changed"], "./ in front too");
  assert.deepEqual(lines("--files", "docs", "--list"), ["nothing to test"], "a folder that isn't a suite, as docs/");
  assert.deepEqual(lines("--files", "scripts", "--list"), ["root: 1 file, changed"]);
  // No folder is named root: "/root/x" in gamma's test isn't the root suite.
  assert.deepEqual(lines("--files", "root", "--list"), ["root: 1 file, changed"], "the root suite by its name, alone");
  assert.deepEqual(lines("--files", "package.json", "--list"), ["root: 1 file, changed"], "a file at the root");
});

test("D2, --files: an absolute path or one with a .. segment fails with 2 and says why", () => {
  const dir = fakeRepo();
  for (const [path, why] of [
    ["/abs/alpha/x.js", /^test: --files: \/abs\/alpha\/x\.js is absolute; give it relative to the repo root$/m],
    [`${dir}/alpha/mods/a.js`, /is absolute; give it relative to the repo root$/m],
    ["../x", /^test: --files: \.\.\/x has a \.\. segment; give it relative to the repo root, inside it$/m],
    ["alpha/../../x", /^test: --files: alpha\/\.\.\/\.\.\/x has a \.\. segment/m],
    ["./..", /^test: --files: \.\/\.\. has a \.\. segment/m],
  ]) {
    const r = runner(dir, "--files", "alpha/mods/a.js", path, "--list");
    assert.equal(r.status, 2, `${path}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, why, path);
    assert.equal(r.stdout, "", `${path}: nothing listed`);
  }
});

test("D2, --files: no path, or with --changed or suite names, fails with 2", () => {
  const dir = fakeRepo();
  for (const args of [["--files"], ["--files", "--list"], ["--files", "alpha/x", "--changed"], ["alpha", "--files", "alpha/x"]]) {
    const r = runner(dir, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^test: --files takes /, args.join(" "));
  }
});

test("D5: a run: suites one after another, a header line before each, dots for passes, a table, exit 0", () => {
  const times = join(scratch, `times-${++n}.txt`);
  // Each suite's test waits 100 ms between two stamps: overlapping stamps
  // would mean two suites ran at once.
  const timed = (name) =>
    `import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\nconst TIMES = ${JSON.stringify(times)};\ntest("${name}", async () => {\n  appendFileSync(TIMES, "${name} start " + Date.now() + "\\n");\n  await new Promise((r) => setTimeout(r, 100));\n  appendFileSync(TIMES, "${name} end " + Date.now() + "\\n");\n});\n`;
  const dir = fakeRepo({ "alpha/test/t.test.js": timed("alpha"), "gamma/test/t.test.js": timed("gamma") });
  const r = runner(dir, "alpha", "gamma");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], "alpha: 2 files, named");
  assert.match(lines[1], /^\.{3}$/, "three passing tests, as dots");
  assert.equal(lines[2], "gamma: 2 files, named");
  assert.match(lines[3], /^\.{3}$/);
  assert.equal(lines[4], "");
  assert.equal(lines[5], "suite  files  pass  fail  seconds");
  assert.match(lines[6], /^alpha      2     3     0 +\d+\.\d$/);
  assert.match(lines[7], /^gamma      2     3     0 +\d+\.\d$/);
  const stamp = Object.fromEntries(readFileSync(times, "utf8").trim().split("\n").map((l) => { const [who, what, at] = l.split(" "); return [`${who} ${what}`, Number(at)]; }));
  assert.ok(stamp["alpha end"] <= stamp["gamma start"], `gamma started after alpha ended: ${JSON.stringify(stamp)}`);
});

test("D5: a failing suite prints its failure in full, the others still run, and the run exits 1", () => {
  const dir = fakeRepo({ "alpha/test/broken.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("alpha breaks", () => { assert.equal(1, 2); });\n' });
  const r = runner(dir, "alpha", "gamma");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✖ alpha breaks/);
  assert.match(r.stdout, /1 !== 2/);
  assert.match(r.stdout, /^gamma: 1 file, named$/m, "the suites after it still run");
  assert.match(r.stdout, /^alpha +2 +2 +1 +\d+\.\d$/m);
  assert.match(r.stdout, /^gamma +1 +2 +0 +\d+\.\d$/m);
});

test("D5: a test that leaves something running doesn't hold its suite: the run ends and goes on", () => {
  const dir = fakeRepo({ "alpha/test/open.test.js": 'import { test } from "node:test";\ntest("leaves a timer", () => { setTimeout(() => {}, 20_000); });\n' });
  const started = performance.now();
  const r = runner(dir, "alpha", "gamma");
  const seconds = (performance.now() - started) / 1000;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(seconds < 10, `the run waited on the timer: ${seconds.toFixed(1)} s`);
  assert.match(r.stdout, /^alpha +2 +3 +0 +\d+\.\d$/m);
  assert.match(r.stdout, /^gamma +1 +2 +0 +\d+\.\d$/m, "the next suite ran");
});
