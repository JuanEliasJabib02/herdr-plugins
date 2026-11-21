// The test runner (split-tests D2–D5). Each plugin owns its suite in
// <plugin>/test/*.test.js, and the root test/ (the suite named root) tests
// scripts/. No list to keep: a suite is any top-level folder with
// test/*.test.js.
//
//   node scripts/test.mjs                    every suite
//   node scripts/test.mjs <suite>...         the named ones, in that order
//   node scripts/test.mjs --changed [<base>] what the branch touched since its
//                                            merge base with <base> (main),
//                                            and the test files that read it
//   node scripts/test.mjs --files <path>...  what --changed would run if those
//                                            repo paths were what changed (no
//                                            git; a leading ./ is dropped)
//   add --list to print what would run and why, without running it
//
// What changed: the branch's commits, the working tree (staged or not) and
// the untracked files. A file in a suite's folder runs that suite whole; a
// file in scripts/, in the root test/ or at the root (but a root *.md) runs
// the root suite. A test file of another suite runs too when its code names
// a changed top-level folder X as a path or a data location: X/ right after
// a quote, a backtick or a slash (../ included), or X whole between two of
// the same quote ("X", 'X', `X`: join(app, "X", …)), on a line that doesn't
// start as a comment. A helper under a suite's test/ that does runs its
// whole suite.
//
// Suites run one after another, never at once, each from its folder as
// `node --test --test-reporter=dot <files>`: a pass prints a dot, a failure
// prints in full. A test past 2 minutes fails (--test-timeout), and a suite
// ends once its tests have, whatever they left running (--test-force-exit):
// a hang is a failed row, never a run that doesn't end. A line before each
// suite says why it runs, and a table of suite | files | pass | fail |
// seconds ends the run (cancelled counts as fail). Exit 0 when every suite
// passed or nothing maps ("nothing to test"), 1 when one failed, 2 on a
// usage error.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = "root";
// The root suite's folders: a change in them runs it.
const ROOT_FOLDERS = new Set(["scripts", "test"]);
const USAGE = "usage: node scripts/test.mjs [<suite>... | --changed [<base>] | --files <path>...] [--list]";

class UsageError extends Error {}

// The top-level folder of a repo path, or null for a file at the root.
const topFolder = (path) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : null);

// The suite a changed path runs whole, or null.
function suiteOf(path, names) {
  const top = topFolder(path);
  if (top === null) return path.endsWith(".md") ? null : ROOT;
  if (ROOT_FOLDERS.has(top)) return ROOT;
  return names.has(top) ? top : null;
}

const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The folders, of those given, that a file's code names as a path: X/ right
// after a quote, a backtick or a slash, or X whole between two of the same
// quote (a folder joined by name), on a line that isn't a comment.
export function foldersRead(text, folders) {
  const code = text
    .split("\n")
    .filter((line) => !COMMENT.test(line))
    .join("\n");
  return folders.filter((x) => new RegExp(`["'\`/]${escape(x)}/|(["'\`])${escape(x)}\\1`).test(code));
}

const slashed = (folders) => folders.map((f) => `${f}/`).join(", ");
const entry = (suite, files, why, reads = null) => ({ name: suite.name, dir: suite.dir, files, why, reads });
const allFiles = (suite) => suite.files.map((f) => f.path);

// What --changed (and --files) runs, from the changed repo paths and the suites as
// findSuites reads them ({ name, dir, files: [{ path, text }], helpers:
// [{ path, text }] }, paths relative to dir), in the suites' order:
// [{ name, dir, files, why, reads }]. reads is null when the whole suite
// runs, else [{ file, folders }], one per file that runs.
export function select(changed, suites) {
  const names = new Set(suites.map((s) => s.name));
  const whole = new Set(changed.map((p) => suiteOf(p, names)).filter(Boolean));
  // The root test/ isn't read by other suites; "test/" in their code is
  // their own test folder.
  const folders = [...new Set(changed.map(topFolder).filter((f) => f !== null && f !== "test"))].sort();
  // Of the given [{ path, text }], those that name a changed folder, with
  // the folders each names.
  const readers = (list) => list.map((f) => ({ file: f.path, folders: foldersRead(f.text, folders) })).filter((r) => r.folders.length);
  const plan = [];
  for (const suite of suites) {
    if (whole.has(suite.name)) {
      plan.push(entry(suite, allFiles(suite), "changed"));
      continue;
    }
    const helpers = readers(suite.helpers);
    if (helpers.length) {
      plan.push(entry(suite, allFiles(suite), helpers.map((h) => `${h.file} reads ${slashed(h.folders)}`).join("; ")));
      continue;
    }
    const reads = readers(suite.files);
    if (!reads.length) continue;
    const read = [...new Set(reads.flatMap((r) => r.folders))].sort();
    plan.push(entry(suite, reads.map((r) => r.file), `${reads.length === 1 ? "it reads" : "they read"} ${slashed(read)}`, reads));
  }
  return plan;
}

// Every suite, whole.
export const everySuite = (suites) => suites.map((s) => entry(s, allFiles(s), "all suites"));

// The named suites, whole, in the order given ("keep-awake/" is keep-awake).
export function namedSuites(names, suites) {
  return names.map((given) => {
    const name = given.replace(/\/+$/, "");
    const suite = suites.find((s) => s.name === name);
    if (!suite) throw new UsageError(`no suite named ${name}; suites: ${suites.map((s) => s.name).join(", ")}`);
    return entry(suite, allFiles(suite), "named");
  });
}

// One suite's files, or null when it has no test/ or its test/ has no
// *.test.js: the test files right under test/, and the helpers (any other
// .js or .mjs under test/, at any depth, outside node_modules), each with
// its text.
function readSuite(repo, name, dir) {
  const testDir = join(repo, dir, "test");
  let paths;
  try {
    paths = readdirSync(testDir, { recursive: true }).sort();
  } catch {
    return null;
  }
  const read = (path) => ({ path: `test/${path}`, text: readFileSync(join(testDir, path), "utf8") });
  const files = paths.filter((p) => !p.includes("/") && p.endsWith(".test.js")).map(read);
  if (!files.length) return null;
  const helpers = paths.filter((p) => /\.m?js$/.test(p) && !p.endsWith(".test.js") && !p.split("/").includes("node_modules")).map(read);
  return { name, dir, files, helpers };
}

// The repo's suites: root first, then the top-level folders with a test
// folder, by name.
export function findSuites(repo) {
  const folders = readdirSync(repo, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => d.name)
    .sort();
  return [readSuite(repo, ROOT, ""), ...folders.map((f) => readSuite(repo, f, f))].filter(Boolean);
}

// The repo paths changed since the merge base of <base> and HEAD: commits,
// the working tree (staged or not), and untracked files. A moved file
// counts at both paths.
function changedFiles(repo, base) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let since;
  try {
    since = git("merge-base", base, "HEAD").trim();
  } catch (e) {
    throw new UsageError(`--changed: no merge base of ${base} and HEAD (${String(e.stderr || e.message).trim().split("\n")[0]})`);
  }
  const paths = (out) => out.split("\0").filter(Boolean);
  const diff = paths(git("diff", "--name-only", "--no-renames", "-z", since, "--"));
  const untracked = paths(git("ls-files", "--others", "--exclude-standard", "-z"));
  return [...new Set([...diff, ...untracked])].sort();
}

const count = (n) => `${n} ${n === 1 ? "file" : "files"}`;

// The line before a suite: its name, file count and why it runs.
export const headLine = (e) => `${e.name}: ${count(e.files.length)}, ${e.why}`;

// --list: each suite's line, then, for a suite that runs only some files,
// each of them and what it reads.
export const listLines = (plan) => plan.flatMap((e) => [headLine(e), ...(e.reads ?? []).map((r) => `  ${r.file} reads ${slashed(r.folders)}`)]);

// The table that ends a run, from [{ name, files, pass, fail, seconds }];
// pass and fail are null when the suite left no counts.
export function tableLines(rows) {
  const head = ["suite", "files", "pass", "fail", "seconds"];
  const cells = rows.map((r) => [r.name, String(r.files), String(r.pass ?? "?"), String(r.fail ?? "?"), r.seconds.toFixed(1)]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join("  ");
  return [line(head), ...cells.map(line)];
}

// A line on stdout, written before the next suite's output starts.
const say = (text) => new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));

// The last value of a TAP summary line ("# pass 12"), or null.
function tapCount(tap, key) {
  const all = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
  return all.length ? Number(all.at(-1)[1]) : null;
}

// Runs one suite from its folder: dots on stdout, a TAP copy in tmp for the
// counts. Resolves to its table row and whether it passed.
async function runSuite(repo, e, tmp) {
  const tap = join(tmp, `${e.name}.tap`);
  const args = [
    "--test",
    "--test-timeout=120000",
    "--test-force-exit",
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tap}`,
    ...e.files,
  ];
  const started = performance.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: join(repo, e.dir), stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(-1));
    child.on("close", (status) => resolve(status ?? -1));
  });
  const seconds = (performance.now() - started) / 1000;
  const text = existsSync(tap) ? readFileSync(tap, "utf8") : "";
  const fail = tapCount(text, "fail");
  const cancelled = tapCount(text, "cancelled");
  return {
    ok: code === 0,
    row: { name: e.name, files: e.files.length, pass: tapCount(text, "pass"), fail: fail === null ? null : fail + (cancelled ?? 0), seconds },
  };
}

// A repo path as given to --files: "./keep-awake/x" is "keep-awake/x".
const repoPath = (path) => path.replace(/^(\.\/)+/, "");

function parseArgs(argv) {
  const opts = { list: false, changed: false, base: "main", names: [], files: null };
  const next = (i) => argv[i + 1] !== undefined && !argv[i + 1].startsWith("-");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") opts.list = true;
    else if (a === "--changed") {
      opts.changed = true;
      if (next(i)) opts.base = argv[++i];
    } else if (a === "--files") {
      opts.files ??= [];
      while (next(i)) opts.files.push(repoPath(argv[++i]));
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else opts.names.push(a);
  }
  if (opts.changed && opts.names.length) throw new UsageError("--changed takes one base, not suite names");
  if (opts.files && !opts.files.length) throw new UsageError("--files takes at least one path");
  if (opts.files && (opts.changed || opts.names.length)) throw new UsageError("--files takes repo paths, not --changed or suite names");
  return opts;
}

async function main(argv, repo) {
  let plan;
  try {
    const opts = parseArgs(argv);
    const suites = findSuites(repo);
    if (opts.changed) plan = select(changedFiles(repo, opts.base), suites);
    else if (opts.files) plan = select(opts.files, suites);
    else if (opts.names.length) plan = namedSuites(opts.names, suites);
    else plan = everySuite(suites);
    if (!plan.length) {
      await say("nothing to test");
      return 0;
    }
    if (opts.list) {
      await say(listLines(plan).join("\n"));
      return 0;
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`test: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), "herdr-plugins-test-"));
  try {
    const rows = [];
    let failed = false;
    for (const e of plan) {
      await say(headLine(e));
      const { ok, row } = await runSuite(repo, e, tmp);
      rows.push(row);
      failed ||= !ok;
    }
    await say(["", ...tableLines(rows)].join("\n"));
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2), fileURLToPath(new URL("..", import.meta.url)));
