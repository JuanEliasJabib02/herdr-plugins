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
//                                            git; a leading ./ is dropped, a
//                                            bare folder name is that folder)
//   add --list to print what would run and why, without running it
//
// What changed: the branch's commits, the working tree (staged or not) and
// the untracked files. A file in a suite's folder runs that suite whole; a
// file in scripts/, in the root test/ or at the root (but a root *.md) runs
// the root suite. A test file of another suite runs too when its code names
// a changed top-level folder X as a path or a data location: X/ right after
// a quote, a backtick or a slash (../ included), or X whole between two of
// the same quote ("X", 'X', `X`) as an argument after the first: right after
// a comma and optional spaces, and not followed by optional spaces and a
// colon (join(app, "X", …) counts; { name: "X" } and { "X": … } don't), on a
// line that doesn't start as a comment. A helper under a suite's test/ that
// does runs its whole suite.
//
// --files paths are relative to the repo root: an absolute one or one with
// a .. segment is a usage error. A bare name that is a suite or a folder at
// the repo root is that folder ("keep-awake" is keep-awake/, "root" the root
// suite's test/); any other bare name is a file at the root.
//
// Suites run one after another, never at once, each from its folder as
// `node --test --test-reporter=dot <files>`: a pass prints a dot, a failure
// prints in full. A test past 2 minutes fails (--test-timeout). A suite
// whose processes are still running after 15 minutes (spotlight, the
// slowest, takes about 5; HERDR_TEST_SUITE_LIMIT_MS=<ms> sets another limit)
// is stopped, its whole process group, with SIGTERM and then SIGKILL; a line
// says `<suite>: stopped after <limit>` and its row fails: a hang is a
// failed row, never a run that doesn't end. (Not --test-force-exit: it
// drops results it hasn't counted yet.) Each suite runs in a process group
// of its own, so a Ctrl-C reaches only the runner, which stops the suite
// and runs no more (a second one kills it at once). A line before each
// suite says why it runs, and a table of suite | files | pass | fail |
// seconds ends the run (cancelled counts as fail). Exit 0 when every suite
// passed or nothing maps ("nothing to test"), 1 when one failed, 2 on a
// usage error, 128 + the signal's number when interrupted.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { constants, tmpdir } from "node:os";
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
// quote as a path call's argument (a folder joined by name): right after a
// comma and any spaces, line breaks included, and not followed by any spaces
// and a colon (a key). On a line that isn't a comment.
export function foldersRead(text, folders) {
  const code = text
    .split("\n")
    .filter((line) => !COMMENT.test(line))
    .join("\n");
  return folders.filter((x) => new RegExp(`["'\`/]${escape(x)}/|,\\s*(["'\`])${escape(x)}\\1(?!\\s*:)`).test(code));
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

// How long a suite may run before it is stopped: 15 minutes (spotlight, the
// slowest, takes about 5), or HERDR_TEST_SUITE_LIMIT_MS from `env`.
export const LIMIT_VAR = "HERDR_TEST_SUITE_LIMIT_MS";
export function suiteLimit(env) {
  const value = env[LIMIT_VAR];
  if (value === undefined || value === "") return 15 * 60_000;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${LIMIT_VAR} is a whole number of milliseconds above 0, not ${JSON.stringify(value)}`);
  return Number(value);
}
const limitText = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`);

// A stopped suite's processes get this long between SIGTERM and SIGKILL.
const GRACE_MS = 2000;

// A signal to a suite's process group: node --test, its test files and what
// they started. The group may be gone already.
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // gone
  }
}

// Stops a suite's process group: SIGTERM, then SIGKILL to what is left.
function stopGroup(pid) {
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), GRACE_MS);
}

// The pid of the suite running now (its process group's), or null.
let running = null;

// Runs one suite from its folder, in a process group of its own: dots on
// stdout, a TAP copy in tmp for the counts. Past `limit` ms the group is
// stopped. Resolves to its table row, whether it passed and whether the
// limit stopped it.
async function runSuite(repo, e, tmp, limit) {
  const tap = join(tmp, `${e.name}.tap`);
  const args = [
    "--test",
    "--test-timeout=120000",
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tap}`,
    ...e.files,
  ];
  const started = performance.now();
  let stopped = false;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: join(repo, e.dir), stdio: ["ignore", "inherit", "inherit"], detached: true });
    running = child.pid ?? null;
    const watchdog = setTimeout(() => {
      stopped = true;
      stopGroup(child.pid);
    }, limit);
    const done = (status) => {
      clearTimeout(watchdog);
      running = null;
      resolve(status);
    };
    child.on("error", () => done(-1));
    child.on("close", (status) => done(status ?? -1));
  });
  const seconds = (performance.now() - started) / 1000;
  const text = existsSync(tap) ? readFileSync(tap, "utf8") : "";
  const fail = tapCount(text, "fail");
  const cancelled = tapCount(text, "cancelled");
  return {
    ok: code === 0 && !stopped,
    stopped,
    row: { name: e.name, files: e.files.length, pass: tapCount(text, "pass"), fail: fail === null ? null : fail + (cancelled ?? 0), seconds },
  };
}

// A repo path as given to --files: "./keep-awake/x" is "keep-awake/x". An
// absolute path, or one with a .. segment, is a usage error.
function repoPath(given) {
  const path = given.replace(/^(\.\/)+/, "");
  if (path.startsWith("/")) throw new UsageError(`--files: ${given} is absolute; give it relative to the repo root`);
  if (path.split("/").includes("..")) throw new UsageError(`--files: ${given} has a .. segment; give it relative to the repo root, inside it`);
  return path;
}

// A bare --files name (no slash) that is a suite or a folder at the repo
// root, as that folder: "keep-awake" is "keep-awake/". The root suite has
// no folder of its own name: "root" is its test/, so that "/root/…" in
// another suite's code doesn't read as it. Any other path, a file at the
// root included, as it is.
function asFolder(path, repo, names) {
  if (path.includes("/") || path === "" || path === ".") return path;
  if (path === ROOT) return "test/";
  return names.has(path) || statSync(join(repo, path), { throwIfNoEntry: false })?.isDirectory() ? `${path}/` : path;
}

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

async function main(argv, repo, env) {
  let plan, limit;
  try {
    const opts = parseArgs(argv);
    limit = suiteLimit(env);
    const suites = findSuites(repo);
    if (opts.changed) plan = select(changedFiles(repo, opts.base), suites);
    else if (opts.files) {
      const names = new Set(suites.map((s) => s.name));
      plan = select(opts.files.map((p) => asFolder(p, repo, names)), suites);
    }
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
  // A suite runs in a process group of its own, so a Ctrl-C (or a hangup)
  // reaches only the runner: it stops the suite running and runs no more. A
  // second one kills the suite's group and exits at once.
  let interrupted = null;
  const onSignal = (signal) => {
    if (interrupted) {
      if (running !== null) signalGroup(running, "SIGKILL");
      process.exit(128 + constants.signals[signal]);
    }
    interrupted = signal;
    if (running !== null) stopGroup(running);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  const tmp = mkdtempSync(join(tmpdir(), "herdr-plugins-test-"));
  try {
    const rows = [];
    let failed = false;
    for (const e of plan) {
      if (interrupted) break;
      await say(headLine(e));
      const { ok, stopped, row } = await runSuite(repo, e, tmp, limit);
      // On a line of its own: the stopped suite's dots never ended theirs.
      if (stopped) await say(`\n${e.name}: stopped after ${limitText(limit)}`);
      rows.push(row);
      failed ||= !ok;
    }
    if (interrupted) return 128 + constants.signals[interrupted];
    await say(["", ...tableLines(rows)].join("\n"));
    return failed ? 1 : 0;
  } finally {
    for (const s of signals) process.off(s, onSignal);
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
if (invoked) process.exitCode = await main(process.argv.slice(2), fileURLToPath(new URL("..", import.meta.url)), process.env);
