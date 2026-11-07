// T7, S1, S11: Contents, the Explorer's search in files (code-explorer/search-model.js,
// tree-model.js's openFile and main.js). Git's arguments, the parse, the trim and the
// summaries, as Orca words them. The searches run real git and grep on real files;
// main.js runs in a fake Herdr (`herdr`, `gpui-kit`, `gpui-base` resolve to stand-ins)
// with those same real programs behind its exec. How it looks stays with `herdr-app check`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BEFORE_MAX, DEBOUNCE, GIT_SCRIPT, GREP_SCRIPT, MAX_LINE, MAX_RESULTS, SEARCH, SEARCH_LIMIT, activeFilters, expandBraces, gitGrepArgs, globPathspecs, globRegExp, grepArgs,
  killArgs, matchAt, matchParts, newSearch, newTag, parseResults, readSearch, searchError, searchMessage, searchRows, searchSummary, splitPatterns,
} from "../code-editor/mods/code-explorer/search-model.js";
import { DOCS_KEY, LIVE_KEY, TEXT, openFile, planOpen } from "../code-editor/mods/code-explorer/tree-model.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "code-explorer-search-")));
after(() => rmSync(base, { recursive: true, force: true }));

const breathe = async () => {};
const options = (over = {}) => ({ ...newSearch(), query: "needle", ...over });

// As Herdr's exec: rejects when it can't start, resolves with the code otherwise.
const realExec = (command, args = [], opts = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
function write(root, rel, text = "needle\n") {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const A_TS = "hello World\nfoo bar foo\nñandú Foo\n  const needle = 1; // needle\nx.y and xzy\nñ NEEDLE here\n";

function makeRepo(name) {
  const root = join(base, name);
  mkdirSync(root);
  git(root, "init", "-q");
  write(root, ".gitignore", "dist/\n");
  write(root, "src/a.ts", A_TS);
  write(root, ".github/ci.yml");
  write(root, "docs/guide.md", "a needle in docs\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  write(root, "untracked.md", "needle digit 42\n");
  write(root, "dist/out.js");
  write(root, "bin.dat", "bin\0needle\n");
  for (const rel of ["a b.txt", "it's a:b.txt", "-rf", "$(x)", "\"q\"", "ñandú.txt"]) write(root, rel);
  return root;
}

let shared = null;
const sharedRepo = () => (shared ??= makeRepo("shared"));

async function search(root, over = {}, exec = realExec) {
  const opts = options(over);
  const output = await readSearch({ root, options: opts, tag: newTag() }, exec);
  return { output, results: await parseResults(output, opts, breathe) };
}
const hits = ({ results }) => results.files.flatMap((f) => f.matches.map((m) => `${f.path}:${m.line}:${m.column}`));
const pathsOf = ({ results }) => results.files.map((f) => f.path);

// ── S11: Orca's words ──────────────────────────────────────────────────────

test("S11: every text, as Orca words it", () => {
  assert.deepEqual(SEARCH, {
    placeholder: "Search",
    label: "Search files",
    clear: "Clear search",
    matchCase: "Match Case",
    wholeWord: "Match Whole Word",
    regex: "Use Regular Expression",
    details: "Toggle search details",
    include: "files to include",
    includeHint: "e.g. *.ts, src/**",
    exclude: "files to exclude",
    excludeHint: "e.g. *.min.js, dist/**",
    truncated: "(results truncated)",
    noResults: "No results. Try another search or adjust your filters.",
    failed: "Search failed. Try again.",
  });
  assert.equal(TEXT.typeToSearch, "Type to search in files");
  assert.equal(TEXT.noWorkspaceSearch, "Select a workspace to search");
});

test("S1: Orca's numbers: 300 ms of wait, 2000 results, 26 characters before the match", () => {
  assert.equal(DEBOUNCE, 300);
  assert.equal(MAX_RESULTS, 2000);
  assert.equal(BEFORE_MAX, 26);
  assert.equal(MAX_LINE, 500);
  assert.equal(SEARCH_LIMIT, 15000);
});

test("S11: the summary: \"5 results in 2 files\", the singulars, and \"(results truncated)\" after it", () => {
  assert.equal(searchSummary({ total: 5, files: [1, 2], truncated: false }), "5 results in 2 files");
  assert.equal(searchSummary({ total: 1, files: [1], truncated: false }), "1 result in 1 file");
  assert.equal(searchSummary({ total: 2, files: [1], truncated: false }), "2 results in 1 file");
  assert.equal(searchSummary({ total: 2000, files: [1, 2], truncated: true }), "2000 results in 2 files (results truncated)");
  assert.equal(searchSummary({ total: 0, files: [], truncated: true }), "0 results in 0 files (results truncated)", "shown for truncation alone, as in Orca");
  assert.equal(searchSummary({ total: 0, files: [], truncated: false }), null, "nothing found says so elsewhere");
  assert.equal(searchSummary(null), null);
});

test("S11: what shows in place of results", () => {
  const message = (over) => searchMessage({ query: "x", results: null, loading: false, error: null, ...over });
  assert.deepEqual(message({ query: "" }), { text: "Type to search in files", failed: false });
  assert.deepEqual(message({ query: "   " }), { text: "Type to search in files", failed: false });
  assert.deepEqual(message({ results: { total: 0, files: [] } }), { text: "No results. Try another search or adjust your filters.", failed: false });
  assert.equal(message({ results: { total: 0, files: [] }, loading: true }), null, "still looking");
  assert.equal(message({ results: { total: 3, files: [1] } }), null);
  assert.equal(message({ loading: true }), null);
  assert.deepEqual(message({ error: "fatal: nope" }), { text: "fatal: nope", failed: true });
});

test("S11: \"{{count}} active\" counts the filter fields with something in them", () => {
  assert.equal(activeFilters(newSearch()), 0);
  assert.equal(activeFilters({ include: "*.ts", exclude: "" }), 1);
  assert.equal(activeFilters({ include: "*.ts", exclude: "dist/**" }), 2);
  assert.equal(activeFilters({ include: "   ", exclude: "" }), 0);
});

// ── D7: git's arguments ────────────────────────────────────────────────────

const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const BASE = [...READ_ONLY, "-c", "submodule.recurse=false", "grep", "-z", "-n", "--column", "-I", "--no-color", "--untracked", "--no-recurse-submodules"];

test("D7: the default: fixed string, any case, the whole tree, and it writes nothing under .git", () => {
  assert.deepEqual(gitGrepArgs(options()), [...BASE, "-i", "-F", "-e", "needle", "--", "."]);
});

test("S11: Match Case drops -i, Match Whole Word adds -w, Use Regular Expression swaps -F for Perl's", () => {
  assert.deepEqual(gitGrepArgs(options({ caseSensitive: true })), [...BASE, "-F", "-e", "needle", "--", "."]);
  assert.deepEqual(gitGrepArgs(options({ wholeWord: true })), [...BASE, "-i", "-w", "-F", "-e", "needle", "--", "."]);
  assert.deepEqual(gitGrepArgs(options({ useRegex: true })), [...BASE, "-i", "-P", "-e", "needle", "--", "."]);
  assert.deepEqual(gitGrepArgs(options({ useRegex: true }), "extended"), [...BASE, "-i", "-E", "-e", "needle", "--", "."]);
});

test("D7: a query starting with a dash stays the pattern", () => {
  assert.deepEqual(gitGrepArgs(options({ query: "--help" })).slice(-4), ["-e", "--help", "--", "."]);
});

test("S11: include and exclude become pathspecs; a word without a slash is at any depth", () => {
  const specs = (over) => { const args = gitGrepArgs(options(over)); return args.slice(args.indexOf("--") + 1); };
  assert.deepEqual(specs({ include: "*.ts" }), [":(glob)**/*.ts", ":(glob)**/*.ts/**"]);
  assert.deepEqual(specs({ include: "src/**" }), [":(glob)src/**", ":(glob)src/**/**"]);
  assert.deepEqual(specs({ exclude: "dist/" }), [":(exclude,glob)**/dist/**"]);
  assert.deepEqual(specs({ include: "*.ts, src/**", exclude: "*.min.js" }), [":(glob)**/*.ts", ":(glob)**/*.ts/**", ":(glob)src/**", ":(glob)src/**/**", ":(exclude,glob)**/*.min.js", ":(exclude,glob)**/*.min.js/**"]);
  assert.deepEqual(specs({ include: "/top.txt" }), [":(glob)top.txt", ":(glob)top.txt/**"], "a leading slash anchors it to the root");
  assert.deepEqual(specs({ include: ",", exclude: "" }), [":(top,literal).git"], "asked to include and nothing usable: nothing, as in Orca");
  assert.deepEqual(specs({ include: "/" }), [":(top,literal).git"]);
  assert.deepEqual(specs({ exclude: "," }), ["."]);
});

test("S11: the fields split on commas outside groups, as Orca's splitSearchGlobPatterns", () => {
  const table = [
    ["", []],
    [" , *.ts,, *.md, ", ["*.ts", "*.md"]],
    ["}.ts, *.md", ["}.ts", "*.md"]],
    ["*.{ts,tsx}, *.md", ["*.{ts,tsx}", "*.md"]],
    ["{src,{lib,test}}/**, *.md", ["{src,{lib,test}}/**", "*.md"]],
    ["*[a,b].ts, *.md", ["*[a,b].ts", "*.md"]],
    ["[{},].ts, *.md", ["[{},].ts", "*.md"]],
    ["[]a,b].ts, *.md", ["[]a,b].ts", "*.md"]],
    ["[!]a,b].ts, *.md", ["[!]a,b].ts", "*.md"]],
    ["[[:alpha:],].ts, *.md", ["[[:alpha:],].ts", "*.md"]],
    ["[a\\],b].ts, *.md", ["[a\\],b].ts", "*.md"]],
    ["foo\\,bar/**, *.ts", ["foo\\,bar/**", "*.ts"]],
    ["src\\", ["src\\"]],
    ["*.{ts,tsx", ["*.{ts,tsx"]],
    ["[a,b", ["[a,b"]],
  ];
  for (const [text, expected] of table) assert.deepEqual(splitPatterns(text), expected, text);
});

test("S11: git's globs have no braces, so a group becomes one pattern each", () => {
  assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"]);
  assert.deepEqual(expandBraces("{src,{lib,test}}/**"), ["src/**", "lib/**", "test/**"]);
  assert.deepEqual(expandBraces("{a,b}{c,d}"), ["ac", "ad", "bc", "bd"]);
  for (const literal of ["plain", "*.{ts", "{one}", "\\{a,b\\}", "[{,}].ts"]) assert.deepEqual(expandBraces(literal), [literal]);
  assert.ok(expandBraces("{a,b}".repeat(40)).length <= 64, "a pathological field stays a few patterns");
  assert.deepEqual(expandBraces(`${"{".repeat(2000)}a,b${"}".repeat(2000)}`).length > 0, true);
});

test("S11: the pathspec of one pattern", () => {
  assert.deepEqual(globPathspecs("*.ts"), [":(glob)**/*.ts", ":(glob)**/*.ts/**"]);
  assert.deepEqual(globPathspecs("*.ts", true), [":(exclude,glob)**/*.ts", ":(exclude,glob)**/*.ts/**"]);
  assert.deepEqual(globPathspecs("/"), []);
});

// ── Real git ───────────────────────────────────────────────────────────────

test("D7: a real repo: tracked, untracked and dotfiles are searched; what's ignored and binary isn't; awkward names come whole", async () => {
  const found = await search(sharedRepo());
  assert.deepEqual(pathsOf(found).sort(), [
    "\"q\"", "$(x)", "-rf", ".github/ci.yml", "a b.txt", "docs/guide.md", "it's a:b.txt", "src/a.ts", "untracked.md", "ñandú.txt",
  ].sort());
  assert.equal(found.results.truncated, false);
  assert.equal(searchError(found.output), null);
});

test("S11: any case by default, and Match Case narrows it", async () => {
  const root = sharedRepo();
  assert.deepEqual(hits(await search(root, { query: "FOO", include: "src/**" })), ["src/a.ts:2:1", "src/a.ts:2:9", "src/a.ts:3:7"]);
  assert.deepEqual(hits(await search(root, { query: "Foo", include: "src/**", caseSensitive: true })), ["src/a.ts:3:7"]);
});

test("S1: not a regular expression unless asked: a dot is a dot", async () => {
  const root = sharedRepo();
  assert.deepEqual(hits(await search(root, { query: "x.y", include: "src/**" })), ["src/a.ts:5:1"]);
  assert.deepEqual(hits(await search(root, { query: "x.y", include: "src/**", useRegex: true })), ["src/a.ts:5:1", "src/a.ts:5:9"]);
});

test("S11: Match Whole Word", async () => {
  const root = sharedRepo();
  assert.deepEqual(hits(await search(root, { query: "need", include: "src/**" })).length, 3);
  assert.deepEqual(hits(await search(root, { query: "need", include: "src/**", wholeWord: true })), []);
  assert.deepEqual(hits(await search(root, { query: "needle", include: "src/**", wholeWord: true })), ["src/a.ts:4:9", "src/a.ts:4:24", "src/a.ts:6:3"]);
});

test("S11: Use Regular Expression understands \\d and \\b, and the highlight is what matched", async () => {
  const root = sharedRepo();
  const digits = await search(root, { query: "\\d+", include: "*.md", useRegex: true });
  assert.deepEqual(hits(digits), ["untracked.md:1:14"]);
  assert.equal(digits.results.files[0].matches[0].length, 2);
  assert.deepEqual(hits(await search(root, { query: "\\bneedl\\b", include: "*.md", useRegex: true })), []);
  assert.deepEqual(hits(await search(root, { query: "\\bneedle\\b", include: "untracked.md", useRegex: true })), ["untracked.md:1:1"]);
});

test("S11: a git without Perl's regular expressions falls back to extended ones", async () => {
  const root = sharedRepo();
  const asked = [];
  const exec = (command, args, opts) => {
    if (args.includes("-P")) { asked.push("P"); return Promise.resolve({ code: 0, stdout: "", stderr: "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE\nstatus:128\n" }); }
    if (args.includes("-E")) asked.push("E");
    return realExec(command, args, opts);
  };
  const found = await search(root, { query: "dig[a-z]+", include: "*.md", useRegex: true }, exec);
  assert.deepEqual(asked, ["P", "E"]);
  assert.deepEqual(hits(found), ["untracked.md:1:8"]);
});

test("S11: a pattern git refuses is a failure that says why; no match isn't one", async () => {
  const root = sharedRepo();
  const refused = await search(root, { query: "(", useRegex: true });
  assert.match(searchError(refused.output), /\(/);
  assert.deepEqual(hits(refused), []);
  const none = await search(root, { query: "zzzzzz-nothing" });
  assert.equal(searchError(none.output), null);
  assert.deepEqual(none.results, { files: [], total: 0, truncated: false });
});

test("S11: include and exclude, on real files", async () => {
  const root = sharedRepo();
  assert.deepEqual(pathsOf(await search(root, { include: "*.md" })).sort(), ["docs/guide.md", "untracked.md"]);
  assert.deepEqual(pathsOf(await search(root, { include: "*.{md,yml}" })).sort(), [".github/ci.yml", "docs/guide.md", "untracked.md"]);
  assert.deepEqual(pathsOf(await search(root, { include: "src/**" })), ["src/a.ts"]);
  assert.deepEqual(pathsOf(await search(root, { include: "docs" })), ["docs/guide.md"], "a folder's name reaches what's in it");
  assert.ok(!pathsOf(await search(root, { exclude: "*.md" })).some((p) => p.endsWith(".md")));
  assert.ok(!pathsOf(await search(root, { exclude: "src/**" })).includes("src/a.ts"));
  assert.deepEqual(pathsOf(await search(root, { include: "*.md", exclude: "docs/**" })), ["untracked.md"]);
  assert.deepEqual(pathsOf(await search(root, { include: "," })), [], "nothing usable to include: nothing");
});

test("S1: the column is in characters though git counts bytes: JS disagreeing with git keeps the hit, at git's column, with no highlight", async () => {
  const root = sharedRepo();
  // Perl's inline flag is a syntax error in JS, so only git's column is left.
  const found = await search(root, { query: "(?-i)NEEDLE", include: "src/**", useRegex: true });
  assert.deepEqual(hits(found), ["src/a.ts:6:3"]);
  const [match] = found.results.files[0].matches;
  assert.equal(match.length, 0);
  assert.deepEqual(matchParts(match), { before: "ñ ", match: "", after: "NEEDLE here" });
});

// ── Outside git: grep -rnI (D7) ────────────────────────────────────────────

let plainRoot = null;
function plain() {
  if (plainRoot) return plainRoot;
  plainRoot = join(base, "plain");
  for (const [rel, text] of [
    ["a.txt", "needle here\nno\nneedle needle\n"], ["src/b c.ts", "ñ needle\n"], ["src/keep.min.js", "needle\n"], ["it's a:b.txt", "needle:1:2\n"], ["-rf", "needle\n"],
    ["node_modules/x/c.js", "needle\n"], [".git/h", "needle\n"], [".cache/d", "needle\n"], [".local/share/e", "needle\n"], [".local/f", "needle\n"], [".hidden", "needle\n"],
  ]) write(plainRoot, rel, text);
  write(plainRoot, "bin.dat", "bin\0needle\n");
  return plainRoot;
}

test("D7: outside git: grep's arguments, with what the file list prunes", () => {
  const args = grepArgs(options());
  assert.deepEqual(args.slice(0, 2), ["-rnIs", "--null"]);
  for (const name of [".git", "node_modules", ".cache"]) assert.ok(args.includes(`--exclude-dir=${name}`), name);
  assert.deepEqual(args.slice(-6), ["-i", "-F", "-e", "needle", "--", "."]);
  assert.deepEqual(grepArgs(options({ caseSensitive: true, wholeWord: true, useRegex: true })).slice(-6), ["-w", "-E", "-e", "needle", "--", "."]);
});

test("D7: outside git, real grep: paths without ./, every match, no prunes, no binaries", async () => {
  const found = await search(plain());
  assert.equal(found.output.plain, true);
  assert.deepEqual(pathsOf(found).sort(), ["-rf", ".hidden", ".local/f", "a.txt", "it's a:b.txt", "src/b c.ts", "src/keep.min.js"].sort());
  const a = found.results.files.find((f) => f.path === "a.txt");
  assert.deepEqual(a.matches.map((m) => [m.line, m.column, m.length]), [[1, 1, 6], [3, 1, 6], [3, 8, 6]]);
  const colons = found.results.files.find((f) => f.path === "it's a:b.txt");
  assert.deepEqual(colons.matches.map((m) => [m.line, m.column, m.text]), [[1, 1, "needle:1:2"]], "a colon in the name and the text");
  const accents = found.results.files.find((f) => f.path === "src/b c.ts");
  assert.equal(accents.matches[0].column, 3);
});

test("D7: outside git, include and exclude filter the same way as in git", async () => {
  const root = plain();
  assert.deepEqual(pathsOf(await search(root, { include: "*.txt" })).sort(), ["a.txt", "it's a:b.txt"]);
  assert.deepEqual(pathsOf(await search(root, { include: "src/**" })).sort(), ["src/b c.ts", "src/keep.min.js"]);
  assert.deepEqual(pathsOf(await search(root, { include: "src/**", exclude: "*.min.js" })), ["src/b c.ts"]);
  assert.deepEqual(pathsOf(await search(root, { include: "," })), []);
});

test("D7: outside git, a pattern grep refuses is a failure; no match isn't one", async () => {
  const root = plain();
  assert.ok(searchError((await search(root, { query: "(", useRegex: true })).output));
  assert.equal(searchError((await search(root, { query: "zzzzzz-nothing" })).output), null);
});

test("D7: no git at all: grep", async () => {
  const exec = (command, args, opts) => (command === "git" ? Promise.reject(new Error("git not found")) : realExec(command, args, opts));
  const found = await search(plain(), {}, exec);
  assert.equal(found.output.plain, true);
  assert.ok(pathsOf(found).includes("a.txt"));
});

test("S11: a glob in JS means what the pathspec means", () => {
  const yes = (glob, path) => assert.equal(globRegExp(glob).test(path), true, `${glob} ${path}`);
  const no = (glob, path) => assert.equal(globRegExp(glob).test(path), false, `${glob} ${path}`);
  yes("*.ts", "a.ts"); yes("*.ts", "x/y/a.ts"); no("*.ts", "a.tsx"); no("*.ts", "a.ts.bak");
  yes("src/**", "src/a"); yes("src/**", "src/x/y"); no("src/**", "lib/src/a"); no("src/**", "srcs/a");
  yes("src", "src/a"); yes("src", "x/src/a"); no("src", "srcs");
  yes("dist/", "dist/a"); yes("dist/", "x/dist/a"); no("dist/", "dist");
  yes("/top.txt", "top.txt"); no("/top.txt", "x/top.txt");
  yes("**/a.js", "a.js"); yes("**/a.js", "x/y/a.js"); yes("x/**/a.js", "x/a.js"); yes("x/**/a.js", "x/y/z/a.js");
  yes("a?c", "abc"); no("a?c", "a/c");
  yes("[ab].js", "a.js"); no("[ab].js", "c.js"); yes("[!ab].js", "c.js"); no("[!ab].js", "a.js");
  yes("a\\*b", "a*b"); no("a\\*b", "axb");
  yes("a.b", "a.b"); no("a.b", "axb");
  assert.equal(globRegExp("/"), null);
});

// ── D8: the parse ──────────────────────────────────────────────────────────

const record = (path, line, column, text) => `${path}\0${line}\0${column}\0${text}\n`;
const parsed = (stdout, over = {}, extra = {}) => parseResults({ stdout, stderr: "", ...extra }, options(over), breathe);

test("S1: grouped by file, in git's order, each match numbered across them", async () => {
  const results = await parsed(record("b.js", 3, 1, "needle") + record("a.js", 1, 5, "the needle") + record("b.js", 9, 1, "needle"));
  assert.deepEqual(results.files.map((f) => f.path), ["b.js", "a.js"]);
  assert.deepEqual(results.files[0].matches.map((m) => [m.n, m.line]), [[0, 3], [2, 9]]);
  assert.deepEqual(results.files[1].matches.map((m) => [m.n, m.line, m.column]), [[1, 1, 5]]);
  assert.equal(results.total, 3);
  assert.equal(results.truncated, false);
});

test("S1: one result per match, also in one line", async () => {
  const results = await parsed(record("a.js", 1, 1, "needle and Needle and NEEDLE"));
  assert.deepEqual(results.files[0].matches.map((m) => [m.column, m.length]), [[1, 6], [12, 6], [23, 6]]);
  assert.equal(results.total, 3);
});

test("S1: an older git separates the numbers with colons", async () => {
  const results = await parsed("a:b.js\x0012:7:a needle: x\n");
  assert.deepEqual(results.files.map((f) => f.path), ["a:b.js"]);
  assert.deepEqual(results.files[0].matches.map((m) => [m.line, m.column, m.text]), [[12, 3, "a needle: x"]]);
});

test("S1: awkward records: CRLF, a newline in a name, a NUL in the text", async () => {
  const crlf = await parsed(record("a.js", 1, 1, "needle\r"));
  assert.equal(crlf.files[0].matches[0].text, "needle");
  const newline = await parsed(record("odd\nname.js", 2, 1, "needle"));
  assert.deepEqual(newline.files.map((f) => f.path), ["odd\nname.js"]);
  const nul = await parsed(record("a.js", 1, 1, "needle\0more"));
  assert.equal(nul.files[0].matches[0].length, 6);
});

test("S1: a record cut short by the output limit is dropped and says so; what can't be read says so too", async () => {
  const cut = await parsed(`${record("a.js", 1, 1, "needle")}b.js\x002\x001\x00need`);
  assert.deepEqual(cut.files.map((f) => f.path), ["a.js"]);
  assert.equal(cut.truncated, true);
  const nameCut = await parsed(`${record("a.js", 1, 1, "needle")}b.j`);
  assert.equal(nameCut.truncated, true);
  const junk = await parsed(`b.js\0nonsense\n${record("a.js", 1, 1, "needle")}`);
  assert.deepEqual(junk.files.map((f) => f.path), ["a.js"]);
  assert.equal(junk.truncated, true);
  assert.deepEqual(await parsed(""), { files: [], total: 0, truncated: false });
});

test("S1: 2000 results exactly isn't truncated; one more is", async () => {
  const lines = (n) => Array.from({ length: n }, (_v, i) => record("a.js", i + 1, 1, "needle")).join("");
  const at = await parsed(lines(MAX_RESULTS));
  assert.equal(at.total, MAX_RESULTS);
  assert.equal(at.truncated, false);
  const over = await parsed(lines(MAX_RESULTS + 1));
  assert.equal(over.total, MAX_RESULTS);
  assert.equal(over.truncated, true);
});

test("S1: the cap counts matches, not lines", async () => {
  const dense = await parsed(record("a.js", 1, 1, "needle ".repeat(1200)) + record("b.js", 1, 1, "needle ".repeat(1200)));
  assert.equal(dense.total, MAX_RESULTS);
  assert.equal(dense.truncated, true);
  assert.deepEqual(dense.files.map((f) => f.matches.length), [1200, 800]);
  const exact = await parsed(record("a.js", 1, 1, "n ".repeat(MAX_RESULTS)), { query: "n" });
  assert.equal(exact.total, MAX_RESULTS);
  assert.equal(exact.truncated, false);
});

test("S1: an empty regular-expression match isn't a result, and it doesn't hang", async () => {
  const results = await parsed(record("a.js", 1, 1, "xbbx"), { query: "x*", useRegex: true });
  assert.deepEqual(results.files[0].matches.map((m) => [m.column, m.length]), [[1, 1], [4, 1]]);
  const only = await parsed(record("a.js", 1, 1, "bbb"), { query: "x*", useRegex: true });
  assert.deepEqual(only.files[0].matches.map((m) => [m.column, m.length]), [[1, 0]], "git said it matches: it stays");
});

test("S11: a whole word starting with a symbol still highlights", async () => {
  const results = await parsed(record("a.js", 1, 3, "x -foo y"), { query: "-foo", wholeWord: true });
  assert.deepEqual(results.files[0].matches.map((m) => [m.column, m.length]), [[3, 4]]);
});

test("S1: it gives way while parsing: Herdr interrupts a script that runs too long", async () => {
  let breaths = 0;
  await parseResults({ stdout: Array.from({ length: 1000 }, (_v, i) => record("a.js", i + 1, 1, "needle")).join(""), stderr: "" }, options(), async () => { breaths++; });
  assert.ok(breaths >= 5, `breathed ${breaths} times`);
});

test("S1: a very long line isn't scanned: git's own first match, in characters, in a window around it, and it says the count is short", async () => {
  const text = `${"ñ".repeat(12000)}needle${"b".repeat(12000)} needle`;
  const results = await parsed(record("min.js", 1, 24001, text));
  assert.equal(results.total, 1);
  assert.equal(results.truncated, true);
  const [match] = results.files[0].matches;
  assert.equal(match.column, 12001, "24001 bytes in, 12000 characters");
  assert.equal(match.length, 6);
  assert.ok(match.text.length <= MAX_LINE + 2, `${match.text.length}`);
  assert.equal(matchParts(match).match, "needle");
  assert.equal(matchParts(match).before.length, BEFORE_MAX + 1);
});

test("S1: a long line without a column (outside git) shows its start, with no highlight", async () => {
  const text = `${"b".repeat(12000)} needle`;
  const results = await parsed(`./min.js\x001:${text}\n`, {}, { plain: true });
  const [match] = results.files[0].matches;
  assert.deepEqual([match.column, match.length], [1, 0]);
  assert.ok(match.text.length <= MAX_LINE + 2);
});

// ── D8: the trim ───────────────────────────────────────────────────────────

const partsOf = async (text, query = "needle") => matchParts((await parsed(record("a.js", 1, 1, text), { query })).files[0].matches[0]);

test("S1: 26 characters before the match, left-trimmed, an ellipsis if cut; the rest whole", async () => {
  assert.deepEqual(await partsOf("  x = needle; y"), { before: "x = ", match: "needle", after: "; y" });
  assert.deepEqual(await partsOf(`${"a".repeat(26)}needle`), { before: "a".repeat(26), match: "needle", after: "" });
  assert.deepEqual(await partsOf(`${"z".repeat(10)}${"a".repeat(26)}needle tail`), { before: `…${"a".repeat(26)}`, match: "needle", after: " tail" });
  assert.deepEqual(await partsOf("Needle"), { before: "", match: "Needle", after: "" });
});

test("S1: the cut never splits a character in two", async () => {
  const { before } = await partsOf(`${"😀".repeat(20)}needle`);
  assert.equal(before.startsWith("…"), true);
  assert.equal(before.slice(1).charCodeAt(0) >= 0xdc00 && before.slice(1).charCodeAt(0) < 0xe000, false);
});

test("S1: a tab draws as two spaces, as in the line view, and doesn't count against the 26", async () => {
  assert.deepEqual(await partsOf("a\tneedle\tb"), { before: "a  ", match: "needle", after: "  b" });
});

test("S1: a line past 500 characters is a window around the match, with its ellipses", async () => {
  const text = `${"a".repeat(1000)}needle${"b".repeat(1000)}`;
  const { files } = await parsed(record("a.js", 1, 1, text));
  const [match] = files[0].matches;
  assert.equal(match.column, 1001, "the real column, for what opens");
  assert.equal(match.text.startsWith("…"), true);
  assert.equal(match.text.endsWith("…"), true);
  assert.equal(match.text.length, MAX_LINE + 2);
  assert.deepEqual(matchParts(match).match, "needle");
  assert.equal(matchParts(match).after.endsWith("…"), true);
  const short = await parsed(record("a.js", 1, 1, "needle"));
  assert.equal(short.files[0].matches[0].text, "needle");
});

// ── The rows ───────────────────────────────────────────────────────────────

test("S1: one row per file, then one per match; a collapsed file keeps only its own", async () => {
  const results = await parsed(record("src/a.js", 3, 1, "needle") + record("src/a.js", 4, 1, "needle") + record("b.js", 1, 1, "needle"));
  const rows = searchRows(results, new Set());
  assert.deepEqual(rows.map((r) => r.key), ["file:src/a.js", "match:0", "match:1", "file:b.js", "match:2"]);
  assert.deepEqual([rows[0].kind, rows[0].name, rows[0].dir, rows[0].count, rows[0].collapsed], ["file", "a.js", "src", 2, false]);
  assert.deepEqual([rows[3].name, rows[3].dir], ["b.js", ""]);
  assert.deepEqual([rows[1].kind, rows[1].path, rows[1].match.line], ["match", "src/a.js", 3]);
  const shut = searchRows(results, new Set(["src/a.js"]));
  assert.deepEqual(shut.map((r) => r.key), ["file:src/a.js", "file:b.js", "match:2"]);
  assert.equal(shut[0].collapsed, true);
  assert.deepEqual(searchRows(null, new Set()), []);
});

test("D2: a result by its number, wherever its file is and collapsed or not", async () => {
  const results = await parsed(record("a.js", 3, 1, "needle") + record("b.js", 7, 1, "needle"));
  assert.deepEqual(matchAt(results, 1), { path: "b.js", line: 7 });
  assert.deepEqual(matchAt(results, 0), { path: "a.js", line: 3 });
  for (const n of [2, -1, NaN, 0.5]) assert.equal(matchAt(results, n), null, String(n));
  assert.equal(matchAt(null, 0), null);
});

// ── Risk 4: stopping a search for real ─────────────────────────────────────

// A git that prints one hit and then never ends, as one searching a huge repo.
function endlessGit() {
  const dir = join(base, `shim-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  const shim = join(dir, "git");
  writeFileSync(shim, `#!/bin/sh
case "$*" in *rev-parse*) echo true; exit 0;; esac
printf 'a.js\\0001\\0001\\000needle\\n'
while :; do sleep 0.05; done
`);
  chmodSync(shim, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  return (command, args, opts = {}) => realExec(command, args, { ...opts, env });
}

test("Risk 4: pkill stops the search and only the search: the shell and head live to hand over what it found", async () => {
  const tag = newTag(), exec = endlessGit();
  assert.match(tag, /^[a-z0-9-]+$/, "safe in a pattern and in a command line");
  const running = readSearch({ root: base, options: options(), tag }, exec);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const [command, args] = killArgs(tag);
  assert.equal(command, "pkill");
  assert.equal((await realExec(command, args)).code, 0, "it found the process");
  const output = await running;
  assert.equal(searchError(output), null, "stopped isn't failed");
  const results = await parseResults(output, options(), breathe);
  assert.deepEqual(results.files.map((f) => f.path), ["a.js"]);
  assert.equal((await realExec(command, args)).code, 1, "nothing left under that tag");
});

test("Risk 4: the tag is whole only in what searches, not in the shell around it", () => {
  for (const script of [GIT_SCRIPT, GREP_SCRIPT]) assert.match(script, /^tag=\$1\$2; shift 2; /);
});

test("Risk 4: a search stopped before it started runs nothing", async () => {
  const ran = [];
  const output = await readSearch({ root: sharedRepo(), options: options(), tag: newTag(), live: () => false }, (command, args, opts) => { ran.push(command); return realExec(command, args, opts); });
  assert.equal(output, null);
  assert.deepEqual(ran, ["git"], "only the check that it's a repo");
});

test("D7: stderr and the status: a warning beside no results is no failure; a refusal is; exec's own failure is the fallback text", () => {
  assert.equal(searchError({ stdout: "", stderr: "status:1\n" }), null);
  assert.equal(searchError({ stdout: "", stderr: "warning: could not open directory 'x/': Permission denied\nstatus:1\n" }), null);
  assert.equal(searchError({ stdout: "", stderr: "fatal: bad\nstatus:128\n" }), "fatal: bad");
  assert.equal(searchError({ stdout: "", stderr: "fatal: bad\nmore\nstatus:128\n" }), "fatal: bad");
  assert.equal(searchError({ stdout: "x", stderr: "fatal: bad\nstatus:128\n" }), null, "what it found stands");
  assert.equal(searchError({ stdout: "", stderr: "status:143\n" }), null, "stopped");
  assert.equal(searchError({ stdout: "", stderr: "status:141\n" }), null, "head had enough");
  assert.equal(searchError({ stdout: "", stderr: "status:2\n" }), null, "grep with only unreadable files, silenced");
  assert.equal(searchError({ stdout: "", stderr: "" }), null);
  assert.equal(searchError({ stdout: "", stderr: "sh: not found\n", code: 127 }), "sh: not found");
});

// ── D10, D11, D21: opening at a line ───────────────────────────────────────

const FILE = "/r/src/a.js";
const tab = (id, over = {}) => ({ id, index: 1, active: false, panes: 1, ...over });
const docOf = (doc, file, preview) => ({ doc, file, preview });
const pane = (id, tabId, mod) => ({ pane: id, tab: tabId, terminal: mod ? null : "a", ...(mod ? { mod } : {}) });

function fakeHerdr({ tabs = [tab("t1", { index: 1, active: true })], docs, live, panes = [], onWait } = {}) {
  const state = { tabs: tabs.map((t) => ({ ...t })), panes: [...panes], shared: { [DOCS_KEY]: docs, [LIVE_KEY]: live }, calls: [], toasts: [], pending: false };
  const reindex = () => state.tabs.forEach((t, i) => { t.index = i + 1; });
  const io = {
    spaces: () => [{ id: "s1", tabs: state.tabs.map((t) => ({ ...t })) }],
    panes: () => state.panes,
    shared: (key) => state.shared[key],
    setShared: (key, value) => { state.shared[key] = value; },
    notify: (n) => { state.toasts.push(n); },
    newDoc: () => "doc1",
    wait: async () => {
      onWait?.(state);
      if (!state.pending) return;
      state.pending = false;
      const active = state.tabs.findIndex((t) => t.active);
      state.tabs.forEach((t) => { t.active = false; });
      state.tabs.splice(active + 1, 0, tab("new", { active: true }));
      state.panes.push(pane("p-new", "new", "code-file"));
      reindex();
    },
    run: (name, args) => {
      state.calls.push([name, args]);
      if (name === "tab.new") state.pending = true;
      if (name === "tab.move") {
        const from = state.tabs.findIndex((t) => t.id === args.id);
        const [moved] = state.tabs.splice(from, 1);
        state.tabs.splice(args.index - 1, 0, moved);
        reindex();
      }
      if (name === "tab.close") { state.tabs = state.tabs.filter((t) => t.id !== args.id); reindex(); }
      return null;
    },
  };
  return { state, io };
}
const names = (state) => state.calls.map(([name]) => name);

test("S1, D16: a click opens at that line: props carries it, in a tab of its own, pinned (D11)", async () => {
  const { state, io } = fakeHerdr();
  const result = await openFile({ file: FILE, pin: true, line: 12, space: "s1" }, io);
  assert.deepEqual(state.calls, [["tab.new", { name: "a.js", space: "s1", mod: "code-file", props: { doc: "doc1", file: FILE, line: 12 } }]]);
  assert.deepEqual(state.shared[DOCS_KEY], { new: docOf("doc1", FILE, false) });
  assert.equal(result.kind, "new");
});

test("pin: without a line, props stay as they were and an open file is only selected", async () => {
  const opened = fakeHerdr();
  await openFile({ file: FILE, space: "s1" }, opened.io);
  assert.deepEqual(opened.state.calls[0][1].props, { doc: "doc1", file: FILE });
  const docs = { t2: docOf("d2", FILE, false) };
  const tabs = [tab("t1", { active: true }), tab("t2", { index: 2 })];
  const panes = [pane("p2", "t2", "code-file")];
  const selected = fakeHerdr({ tabs, docs, panes });
  await openFile({ file: FILE, space: "s1" }, selected.io);
  assert.deepEqual(selected.state.calls, [["tab.select", { id: "t2" }]]);
  assert.deepEqual(planOpen({ file: FILE, pin: false, tabs, docs, live: {}, panes }), { kind: "select", id: "t2", pin: false });
});

test("D21: the file is open and clean: props can't change, so a new copy at that line takes its place", async () => {
  const docs = { t2: docOf("d2", FILE, false), t3: docOf("d3", "/r/b.js", false) };
  const { state, io } = fakeHerdr({
    tabs: [tab("t1"), tab("t2", { index: 2, active: true }), tab("t3", { index: 3 })], docs, live: { d2: { dirty: false, pinned: true } }, panes: [pane("p2", "t2", "code-file"), pane("p3", "t3", "code-file")],
  });
  const result = await openFile({ file: FILE, pin: true, line: 40, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new", "tab.move", "tab.close"]);
  assert.deepEqual(state.calls[0][1].props, { doc: "doc1", file: FILE, line: 40 });
  assert.deepEqual(state.calls[2][1], { id: "t2" }, "no confirmed: on the last tab it closes the space without asking");
  assert.deepEqual(state.tabs.map((t) => t.id), ["t1", "new", "t3"]);
  assert.equal(state.shared[DOCS_KEY].new.preview, false);
  assert.equal(result.kind, "reopen");
  assert.equal(state.toasts.length, 0);
});

test("D21: open in preview and clean: the same, and the new copy is pinned", async () => {
  const docs = { t2: docOf("d2", FILE, true) };
  const { state, io } = fakeHerdr({ tabs: [tab("t2", { active: true })], docs, panes: [pane("p2", "t2", "code-file")] });
  await openFile({ file: FILE, pin: true, line: 5, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new", "tab.move", "tab.close"]);
  assert.deepEqual(state.shared[DOCS_KEY].new, docOf("doc1", FILE, false));
});

test("D21: open with unsaved changes: never touched: selected, pinned if it was a preview, and a toast names the line", async () => {
  const docs = { t2: docOf("d2", FILE, true) };
  const { state, io } = fakeHerdr({ tabs: [tab("t1", { active: true }), tab("t2", { index: 2 })], docs, live: { d2: { dirty: true } }, panes: [pane("p2", "t2", "code-file")] });
  const result = await openFile({ file: FILE, pin: true, line: 12, space: "s1" }, io);
  assert.deepEqual(state.calls, [["tab.select", { id: "t2" }]]);
  assert.equal(state.shared[DOCS_KEY].t2.preview, false);
  assert.equal(result.kind, "select");
  assert.equal(state.toasts.length, 1);
  assert.match(state.toasts[0].title, /a\.js.*12/);
  assert.equal(state.toasts[0].level, "info");
});

test("D18, D21: open beside a terminal: selected, since closing could take the terminal along", async () => {
  const docs = { t2: docOf("d2", FILE, false) };
  const { state, io } = fakeHerdr({ tabs: [tab("t2", { panes: 2, active: true })], docs, panes: [pane("term", "t2"), pane("p2", "t2", "code-file")] });
  await openFile({ file: FILE, pin: true, line: 12, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.select"]);
  assert.equal(state.toasts.length, 1);
});

test("D21, Risk 4: edited while the new tab was on its way: it stays, and nothing is lost", async () => {
  const docs = { t2: docOf("d2", FILE, false) };
  const { state, io } = fakeHerdr({
    tabs: [tab("t2", { active: true })], docs, panes: [pane("p2", "t2", "code-file")],
    onWait: (s) => { s.shared[LIVE_KEY] = { d2: { dirty: true } }; },
  });
  await openFile({ file: FILE, pin: true, line: 12, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
  assert.deepEqual(state.tabs.map((t) => t.id).sort(), ["new", "t2"]);
});

test("D18: an entry whose pane is gone isn't the file: a new tab at the line", async () => {
  const docs = { t2: docOf("d2", FILE, false) };
  const { state, io } = fakeHerdr({ tabs: [tab("t2", { active: true })], docs, panes: [pane("term", "t2")] });
  await openFile({ file: FILE, pin: true, line: 7, space: "s1" }, io);
  assert.deepEqual(names(state), ["tab.new"]);
  assert.equal(state.calls[0][1].props.line, 7);
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
const findAll = (e, kind, out = []) => {
  if (!isEl(e)) return out;
  if (e.kind === kind) out.push(e);
  for (const k of e.kids) findAll(k, kind, out);
  return out;
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

async function newWorld(root, { execFn = realExec, setValueFires = false, machine = null, cwd = true } = {}) {
  const w = { root, execFn, execs: [], runs: [], shared: new Map(), waiters: [], timers: [], inputs: {}, toasts: [], logs: [], nextTab: 2, extraTabs: [], extraPanes: [] };
  const cx = {
    notify() {},
    spawn: (f) => { Promise.resolve().then(() => f(cx)).catch((e) => { console.log(`task failed: ${e?.stack ?? e}`); }); },
    timer: {
      // The search's own waits are the test's to fire; the rest run at once.
      after: (ms, f) => {
        const timer = { ms, f, cancelled: false, fired: false };
        if (ms === DEBOUNCE || ms === SEARCH_LIMIT) w.timers.push(timer);
        else setTimeout(() => { if (!timer.cancelled) f(cx); }, 0);
        return { cancel() { timer.cancelled = true; }, is_done: () => timer.fired };
      },
      every: () => ({ cancel() {} }),
    },
    stop_propagation() { w.stopped = true; },
  };
  globalThis.__ce = {
    el,
    list: (id, count, size, key, draw) => { const list = el("list", id); list.rows = draw({ start: 0, end: count }); list.keys = Array.from({ length: count }, (_v, i) => key(i)); list.size = size; return list; },
    newInput: (opts) => {
      const input = {
        options: opts, text: "", handlers: {}, value: () => input.text,
        set_value: (text) => { input.text = text; if (setValueFires) input.handlers.change?.({}, cx); },
        on: (event, handler) => { input.handlers[event] = handler; return true; },
      };
      w.inputs[opts.placeholder] = input;
      return input;
    },
    spaces: () => [{ id: "s1", name: "space", active: true, machine, tabs: [{ id: "t1", index: 1, active: !w.extraTabs.length, panes: 1 }, ...w.extraTabs] }],
    panes: () => [{ pane: "p1", tab: "t1", cwd: cwd ? w.root : null }, ...w.extraPanes],
    focused: () => ({ pane: "p1" }),
    exec: (command, args, opts) => { w.execs.push([command, args ?? []]); return w.execFn(command, args, opts); },
    readTextFile: async () => null,
    watchFolder: () => new Promise(() => {}),
    theme: () => THEME,
    shared: (key) => w.shared.get(key),
    setShared: (key, value) => { w.shared.set(key, value); },
    run: (name, args) => {
      w.runs.push([name, args]);
      if (name === "tab.new") {
        const id = `t${w.nextTab++}`;
        w.extraTabs.forEach((t) => { t.active = false; });
        w.extraTabs.push({ id, index: w.extraTabs.length + 2, active: true, panes: 1 });
        w.extraPanes.push({ pane: `p-${id}`, tab: id, mod: "code-file" });
      }
      if (name === "tab.close") {
        w.extraTabs = w.extraTabs.filter((t) => t.id !== args.id);
        w.extraPanes = w.extraPanes.filter((p) => p.tab !== args.id);
      }
      return null;
    },
    notify: (n) => { w.toasts.push(n); },
    nextCommand: () => new Promise((resolve) => { w.waiters.push(resolve); }),
    layout: () => null,
    appHome: () => "/no/app",
    home: () => "/no/home",
  };
  const view = new CodeExplorer();
  view.init({}, cx);
  const fire = (ms) => {
    const due = w.timers.filter((t) => t.ms === ms && !t.cancelled && !t.fired);
    for (const t of due) { t.fired = true; t.f(cx); }
    return due.length;
  };
  Object.assign(w, {
    view, cx, fire,
    draw: () => view.render(cx),
    snap: () => { view.render(cx); return view.searchSnapshot(); },
    box: () => w.inputs[SEARCH.placeholder],
    type: (text, input = w.box()) => { input.text = text; input.handlers.change({}, cx); },
    send: async (raw) => {
      await until("the command loop", () => w.waiters.length > 0);
      w.waiters.shift()(raw);
      await new Promise(setImmediate);
    },
    list: () => findAll(w.draw(), "list")[0],
    // What every search the test started ran: a search without the repo check.
    greps: () => w.execs.filter(([command, args]) => command === "sh" && args.some((a) => a === "grep" || a === "-rnIs")),
    kills: () => w.execs.filter(([command]) => command === "pkill"),
    settled: () => until("the search", () => !view.found.loading),
    // Types and waits the search out.
    go: async (text) => { w.type(text); assert.equal(w.fire(DEBOUNCE), 1, "one wait to fire"); await w.settled(); },
  });
  if (cwd && !machine) await until("the tree loaded", () => { view.render(cx); return view.state?.loaded && !view.loading && !view.settling; });
  else view.render(cx);
  return w;
}

const inContents = async (root, over) => {
  const w = await newWorld(root, over);
  await w.send("contents");
  return w;
};

test("S11: Contents, before a search: its input, its toggles and the text that invites to type", async () => {
  const w = await inContents(sharedRepo());
  const drawn = w.draw();
  assert.ok(w.box(), "an input with the placeholder Search");
  assert.ok(findAll(drawn, "Input").some((i) => i.arg === w.box()));
  assert.equal(findAll(drawn, "Input").length, 1, "the filter's input is Names', and the details start closed");
  assert.match(textOf(drawn), /Type to search in files/);
  assert.equal(find(drawn, "explorer-clear-search"), null);
  for (const [id, label] of [["explorer-search-case", "Match Case"], ["explorer-search-word", "Match Whole Word"], ["explorer-search-regex", "Use Regular Expression"], ["explorer-search-details", "Toggle search details"]]) {
    assert.equal(find(drawn, id).calls.tooltip[0], label);
    assert.equal(find(drawn, id).calls.accessibility_label[0], label);
  }
  assert.equal(findAll(drawn, "Input")[0].calls.accessibility_label[0], "Search files");
});

test("S11: no workspace says so, and so does a remote space, with no input", async () => {
  const none = await newWorld(base, { cwd: false });
  await none.send("contents");
  assert.match(textOf(none.draw()), /Select a workspace to search/);
  assert.equal(findAll(none.draw(), "Input").length, 0);
  const remote = await newWorld(base, { machine: "far" });
  await remote.send("contents");
  assert.match(textOf(remote.draw()), /Explorer works on this computer only/);
  assert.equal(findAll(remote.draw(), "Input").length, 0);
});

test("S1: 300 ms after the last key, one search; none before it", async () => {
  const w = await inContents(sharedRepo());
  w.type("n");
  w.type("ne");
  w.type("needle");
  assert.equal(w.greps().length, 0, "nothing runs on a key");
  assert.deepEqual(w.timers.map((t) => [t.ms, t.cancelled]), [[300, true], [300, true], [300, false]]);
  assert.ok(find(w.draw(), "explorer-search-loading"), "the spinner shows from the first key");
  w.fire(DEBOUNCE);
  await w.settled();
  assert.equal(w.greps().length, 1);
  assert.equal(find(w.draw(), "explorer-search-loading"), null);
  assert.match(w.snap().summary, /results in \d+ files/);
});

test("S1, S11: results grouped by file: the summary, the file's row with its count, the match's row with its line and the 26 characters", async () => {
  const root = join(base, "groups");
  mkdirSync(root);
  git(root, "init", "-q");
  write(root, "src/a.js", `${"x".repeat(40)}needle tail\nneedle\n`);
  write(root, "b.js");
  const w = await inContents(root);
  await w.go("needle");
  const snap = w.snap();
  assert.equal(snap.summary, "3 results in 2 files");
  assert.equal(snap.total, 3);
  const list = w.list();
  assert.deepEqual(list.keys.length, 5);
  const fileRow = list.keys.indexOf("file:src/a.js"), first = list.rows[fileRow + 1];
  assert.match(textOf(list.rows[fileRow]), /a\.js/);
  assert.match(textOf(list.rows[fileRow]), /src/);
  assert.match(textOf(list.rows[fileRow]), /\b2\b/);
  assert.match(textOf(first), /^1 /);
  assert.ok(textOf(first).includes(`…${"x".repeat(26)}`));
  assert.ok(textOf(first).includes("needle"));
  assert.ok(textOf(first).includes("tail"));
  assert.match(textOf(w.draw()), /3 results in 2 files/);
  assert.equal(list.arg, "explorer-search");
  assert.equal(findAll(w.draw(), "Scrollbar")[0].arg, "explorer-search");
});

test("S11: nothing found says so; a pattern git refuses says why, in red", async () => {
  const w = await inContents(sharedRepo());
  await w.go("zzzzzz-nothing");
  assert.match(textOf(w.draw()), /No results\. Try another search or adjust your filters\./);
  assert.equal(findAll(w.draw(), "list").length, 0);
  assert.equal(w.snap().summary, null);

  await w.send("regex");
  w.fire(DEBOUNCE);
  await w.settled();
  await w.go("(");
  const failed = find(w.draw(), "explorer-search-error");
  assert.ok(failed, textOf(w.draw()));
  assert.equal(failed.calls.text_color[0], "ansi1");
  assert.match(textOf(failed), /\(/);
  assert.ok(w.snap().error);
  w.type("(a)");
  assert.equal(find(w.draw(), "explorer-search-error"), null, "the next search takes it away at once");
  w.fire(DEBOUNCE);
  await w.settled();
});

test("S11: exec failing to run says \"Search failed. Try again.\"", async () => {
  const root = sharedRepo();
  const w = await inContents(root, { execFn: (command, args, opts) => (command === "sh" && args.includes("grep") ? Promise.reject(new Error("exec stopped it")) : realExec(command, args, opts)) });
  await w.go("needle");
  assert.equal(w.snap().error, "Search failed. Try again.");
  assert.match(textOf(find(w.draw(), "explorer-search-error")), /Search failed\. Try again\./);
  assert.equal(find(w.draw(), "explorer-search-loading"), null);
});

const heldExec = () => {
  const held = [];
  const execFn = (command, args, opts) => {
    if (command === "sh" && args.includes("grep")) return new Promise((resolve) => { held.push(() => resolve(realExec(command, args, opts))); });
    return realExec(command, args, opts);
  };
  return { execFn, held };
};

test("S1, Risk 4: a new search cancels the running one: its program is stopped and what it finds is dropped", async () => {
  const { execFn, held } = heldExec();
  const w = await inContents(sharedRepo(), { execFn });
  w.type("FOO");
  w.fire(DEBOUNCE);
  await until("the first search to run", () => held.length === 1);
  const [, firstArgs] = w.greps()[0];
  assert.equal(w.kills().length, 0);

  w.type("needle");
  await until("the stop", () => w.kills().length === 1);
  const tag = w.kills()[0][1][1];
  assert.deepEqual(w.kills()[0][1], ["-f", tag]);
  assert.ok(firstArgs.join(" ").includes(tag.slice(0, 4)), "that search's tag");

  w.fire(DEBOUNCE);
  await until("the second search to run", () => held.length === 2);
  held[1]();
  await w.settled();
  const total = w.snap().total;
  assert.ok(total > 3);

  held[0]();
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(w.snap().total, total, "the old one's answer never lands");
  assert.equal(w.snap().query, "needle");
});

test("Risk 4: a search still waiting its 300 ms is simply dropped: no program, nothing to stop", async () => {
  const w = await inContents(sharedRepo());
  w.type("needle");
  w.type("");
  assert.equal(w.fire(DEBOUNCE), 0);
  await new Promise(setImmediate);
  assert.equal(w.kills().length, 0);
  assert.equal(w.greps().length, 0);
  assert.equal(find(w.draw(), "explorer-search-loading"), null);
});

test("S1, Risk 4: results stay on screen while the next search runs, then give way", async () => {
  const { execFn, held } = heldExec();
  const w = await inContents(sharedRepo(), { execFn });
  w.type("World");
  w.fire(DEBOUNCE);
  await until("the first", () => held.length === 1);
  held[0]();
  await w.settled();
  assert.equal(w.snap().total, 1);
  w.type("needle");
  assert.equal(w.snap().total, 1);
  assert.ok(find(w.draw(), "explorer-search-loading"));
  w.fire(DEBOUNCE);
  await until("the second", () => held.length === 2);
  held[1]();
  await w.settled();
  assert.ok(w.snap().total > 1);
});

test("S11: a search running past 15 s is stopped and what it found says \"(results truncated)\"", async () => {
  const release = [];
  const w = await inContents(sharedRepo(), {
    execFn: (command, args, opts) => {
      if (command === "pkill") { release.forEach((f) => f()); return Promise.resolve({ code: 0, stdout: "", stderr: "" }); }
      if (command === "sh" && args.includes("grep")) return new Promise((resolve) => { release.push(() => resolve({ code: 0, stdout: "a.js\x001\x001\x00needle\n", stderr: "status:143\n" })); });
      return realExec(command, args, opts);
    },
  });
  w.type("needle");
  w.fire(DEBOUNCE);
  await until("it runs", () => release.length === 1);
  assert.equal(w.timers.filter((t) => t.ms === SEARCH_LIMIT).length, 1);
  w.fire(SEARCH_LIMIT);
  await w.settled();
  const snap = w.snap();
  assert.equal(snap.summary, "1 result in 1 file (results truncated)");
  assert.equal(snap.error, null);
  assert.equal(w.kills().length, 1);
});

test("S11: a search that ends in time cancels its limit", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  assert.equal(w.fire(SEARCH_LIMIT), 0);
  assert.equal(w.kills().length, 0);
});

test("S11: each toggle re-runs the search and shows it's on; the commands do what the clicks do", async () => {
  const w = await inContents(sharedRepo());
  await w.go("FOO");
  const count = () => w.snap().total;
  assert.ok(count() >= 3);

  find(w.draw(), "explorer-search-case").handlers.click({}, w.cx);
  assert.equal(find(w.draw(), "explorer-search-case").calls.bg[0], "selected");
  w.fire(DEBOUNCE);
  await w.settled();
  assert.equal(count(), 0, "no FOO in capitals anywhere");
  await w.send("match-case");
  assert.notEqual(find(w.draw(), "explorer-search-case").calls.bg[0], "selected");
  w.fire(DEBOUNCE);
  await w.settled();
  assert.ok(count() >= 3);

  const greps = w.greps().length;
  await w.send("whole-word");
  w.fire(DEBOUNCE);
  await w.settled();
  assert.equal(w.greps().length, greps + 1);
  assert.ok(w.greps().at(-1)[1].includes("-w"));
  assert.equal(w.snap().wholeWord, true);
  find(w.draw(), "explorer-search-word").handlers.click({}, w.cx);
  w.fire(DEBOUNCE);
  await w.settled();
  assert.ok(!w.greps().at(-1)[1].includes("-w"));

  find(w.draw(), "explorer-search-regex").handlers.click({}, w.cx);
  w.fire(DEBOUNCE);
  await w.settled();
  assert.ok(w.greps().at(-1)[1].includes("-P"));
  assert.equal(w.snap().useRegex, true);
});

test("S11: a toggle with nothing typed runs nothing", async () => {
  const w = await inContents(sharedRepo());
  await w.send("regex");
  assert.equal(w.fire(DEBOUNCE), 0);
  assert.equal(w.greps().length, 0);
  assert.equal(w.snap().useRegex, true);
});

test("S11: the details open on the button, with Orca's labels and hints; a pattern counts as active and re-runs", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  const all = w.snap().total;
  assert.equal(findAll(w.draw(), "Input").length, 1);
  find(w.draw(), "explorer-search-details").handlers.click({}, w.cx);
  const open = w.draw();
  assert.equal(findAll(open, "Input").length, 3);
  assert.match(textOf(open), /files to include/);
  assert.match(textOf(open), /files to exclude/);
  assert.ok(w.inputs[SEARCH.includeHint], "e.g. *.ts, src/**");
  assert.ok(w.inputs[SEARCH.excludeHint], "e.g. *.min.js, dist/**");
  assert.doesNotMatch(textOf(open), /active/);

  w.type("*.md", w.inputs[SEARCH.includeHint]);
  assert.match(textOf(w.draw()), /1 active/);
  w.fire(DEBOUNCE);
  await w.settled();
  assert.ok(w.snap().total < all);
  assert.ok(w.snap().rows.filter((r) => r.file).every((r) => r.file.endsWith(".md")));

  w.type("docs/**", w.inputs[SEARCH.excludeHint]);
  assert.match(textOf(w.draw()), /2 active/);
  w.fire(DEBOUNCE);
  await w.settled();
  assert.deepEqual(w.snap().rows.filter((r) => r.file).map((r) => r.file), ["untracked.md"]);

  await w.send("search-details");
  assert.equal(findAll(w.draw(), "Input").length, 1, "closed, and its filters still apply");
  assert.match(textOf(w.draw()), /2 active/);
});

test("D2: include:<text> and exclude:<text> do what typing does, and show what they set", async () => {
  for (const setValueFires of [false, true]) {
    const w = await inContents(sharedRepo(), { setValueFires });
    await w.go("needle");
    await w.send("include:*.md");
    assert.equal(w.inputs[SEARCH.includeHint].value(), "*.md");
    await w.send("exclude:docs/**");
    assert.equal(w.inputs[SEARCH.excludeHint].value(), "docs/**");
    assert.equal(findAll(w.draw(), "Input").length, 3, "the details open to show them");
    w.fire(DEBOUNCE);
    await w.settled();
    assert.deepEqual(w.snap().rows.filter((r) => r.file).map((r) => r.file), ["untracked.md"]);
  }
});

test("S11: Escape clears the search and stops what's running; another key does nothing", async () => {
  const { execFn, held } = heldExec();
  const w = await inContents(sharedRepo(), { execFn });
  w.type("needle");
  w.fire(DEBOUNCE);
  await until("it runs", () => held.length === 1);
  const bar = find(w.draw(), "explorer-search-bar");
  bar.handlers.key_down({ key: "a", keystroke: "a" }, w.cx);
  assert.equal(w.box().value(), "needle");
  assert.equal(w.stopped, undefined);
  bar.handlers.key_down({ key: "escape", keystroke: "escape" }, w.cx);
  assert.equal(w.stopped, true);
  assert.equal(w.box().value(), "");
  const snap = w.snap();
  assert.equal(snap.query, "");
  assert.equal(snap.loading, false);
  assert.equal(snap.total, null);
  assert.match(textOf(w.draw()), /Type to search in files/);
  await until("the stop", () => w.kills().length === 1);
  held[0]();
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(w.snap().total, null, "what it would have found never lands");
});

test("S11: Escape with nothing typed lets the key go on", async () => {
  const w = await inContents(sharedRepo());
  find(w.draw(), "explorer-search-bar").handlers.key_down({ key: "escape", keystroke: "escape" }, w.cx);
  assert.equal(w.stopped, undefined);
});

test("S11: the X says \"Clear search\" only with something typed, and clears as the command does", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  const x = find(w.draw(), "explorer-clear-search");
  assert.equal(x.calls.tooltip[0], "Clear search");
  assert.equal(x.calls.accessibility_label[0], "Clear search");
  x.handlers.click({}, w.cx);
  assert.equal(w.box().value(), "");
  assert.equal(w.snap().total, null);
  assert.equal(findAll(w.draw(), "list").length, 0);

  await w.go("needle");
  await w.send("clear-search");
  assert.equal(w.box().value(), "");
  assert.equal(w.snap().query, "");
  assert.equal(w.snap().total, null);
});

test("S11: what the patterns hold stays through a clear, as in Orca's query-only Escape", async () => {
  const w = await inContents(sharedRepo());
  await w.send("include:*.md");
  await w.go("needle");
  await w.send("clear-search");
  assert.equal(w.snap().include, "*.md");
});

test("S1: Enter searches again, after the same 300 ms", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  const greps = w.greps().length;
  w.box().handlers.submit({}, w.cx);
  assert.equal(w.fire(DEBOUNCE), 1);
  await w.settled();
  assert.equal(w.greps().length, greps + 1);
});

test("D2: search:<text> does what typing does, spaces and colons included, and shows Contents", async () => {
  for (const setValueFires of [false, true]) {
    const w = await newWorld(sharedRepo(), { setValueFires });
    await w.send("code-explorer.search:const needle = 1");
    assert.equal(w.view.view, "contents");
    assert.equal(w.box().value(), "const needle = 1");
    assert.equal(w.fire(DEBOUNCE), 1);
    await w.settled();
    assert.equal(w.snap().total, 1);
  }
  const w = await inContents(sharedRepo());
  await w.send("search:a:b");
  assert.equal(w.snap().query, "a:b");
  w.fire(DEBOUNCE);
  await w.settled();
  await w.send("search:");
  assert.equal(w.box().value(), "");
  assert.equal(w.snap().total, null);
});

test("D2: results reports the state, for what a click would have done", async () => {
  const w = await inContents(sharedRepo());
  await w.go("World");
  const logged = [];
  const log = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try { await w.send("results"); } finally { console.log = log; }
  const report = JSON.parse(logged.at(-1).replace(/^code-explorer: /, ""));
  assert.equal(report.view, "contents");
  assert.equal(report.query, "World");
  assert.equal(report.summary, "1 result in 1 file");
  assert.equal(report.loading, false);
  assert.deepEqual(report.rows[0], { file: "src/a.ts", count: 1, collapsed: false });
  assert.deepEqual(report.rows[1], { n: 0, path: "src/a.ts", line: 1, before: "hello ", match: "World", after: "" });
});

test("S1: a click on a match opens that file at that line, pinned; open-result:<n> does the same", async () => {
  const root = sharedRepo();
  const w = await inContents(root);
  await w.go("World");
  w.list().handlers.item_click("match:0", w.cx);
  await until("the tab", () => w.runs.some(([name]) => name === "tab.new"));
  const [, args] = w.runs.find(([name]) => name === "tab.new");
  assert.equal(args.mod, "code-file");
  assert.equal(args.name, "a.ts");
  assert.equal(args.space, "s1");
  assert.deepEqual([args.props.file, args.props.line], [join(root, "src/a.ts"), 1]);
  await until("its entry", () => Object.keys(w.shared.get(DOCS_KEY) ?? {}).length === 1);
  assert.equal(Object.values(w.shared.get(DOCS_KEY))[0].preview, false, "D11: opening from Contents pins");

  const c = await inContents(root);
  await c.go("World");
  await c.send("open-result:0");
  await until("the tab", () => c.runs.some(([name]) => name === "tab.new"));
  const [, same] = c.runs.find(([name]) => name === "tab.new");
  assert.deepEqual([same.props.file, same.props.line], [args.props.file, args.props.line]);
});

test("D2: open-result of nothing opens nothing", async () => {
  const w = await inContents(sharedRepo());
  await w.go("World");
  for (const raw of ["open-result:9", "open-result:abc", "open-result:", "open-result:-1"]) await w.send(raw);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(w.runs.length, 0);
});

test("D21: a second result in the same file takes the tab's place at its own line; a double click opens once", async () => {
  const root = sharedRepo();
  const w = await inContents(root);
  await w.go("foo");
  const list = w.list();
  list.handlers.item_click("match:0", w.cx);
  list.handlers.item_click("match:0", w.cx);
  await until("the first tab", () => Object.keys(w.shared.get(DOCS_KEY) ?? {}).length === 1);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(w.runs.filter(([name]) => name === "tab.new").length, 1, "the second press of a double click does nothing");
  const line = (n) => w.snap().rows.find((r) => r.n === n).line;
  assert.equal(w.runs[0][1].props.line, line(0));

  const last = w.snap().rows.filter((r) => r.n !== undefined).at(-1).n;
  w.list().handlers.item_click(`match:${last}`, w.cx);
  await until("the second tab", () => w.runs.filter(([name]) => name === "tab.new").length === 2);
  await until("the first closed", () => w.runs.some(([name]) => name === "tab.close"));
  assert.equal(w.runs.filter(([name]) => name === "tab.new")[1][1].props.line, line(last));
  assert.deepEqual(w.extraTabs.map((t) => t.id), ["t3"]);
});

test("S1: a click on a file's row folds its matches; the command does the same", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  const count = () => w.list().keys.length;
  const before = count();
  const file = w.list().keys.find((k) => k === "file:src/a.ts");
  w.list().handlers.item_click(file, w.cx);
  assert.ok(count() < before);
  const row = w.snap().rows.find((r) => r.file === "src/a.ts");
  assert.equal(row.collapsed, true);
  assert.equal(row.count, 3, "its count stays");
  assert.equal(w.snap().total, w.view.found.results.total, "and the total too");
  await w.send("toggle-result:src/a.ts");
  assert.equal(count(), before);
  w.list().handlers.item_click("file:src/a.ts", w.cx);
  await w.go("needle ");
  assert.equal(w.snap().rows.find((r) => r.file === "src/a.ts")?.collapsed ?? true, true, "a new search keeps it folded");
});

test("S1: going to Names cancels what's pending; back on Contents it searches what's typed, and doesn't repeat what it has", async () => {
  const w = await inContents(sharedRepo());
  w.type("needle");
  await w.send("names");
  assert.equal(w.fire(DEBOUNCE), 0, "cancelled");
  assert.equal(w.snap().loading, false);
  await w.send("contents");
  assert.equal(w.fire(DEBOUNCE), 1, "searched on return");
  await w.settled();
  const greps = w.greps().length;
  await w.send("names");
  assert.equal(findAll(w.draw(), "Input").some((i) => i.arg === w.box()), false, "its input goes with it");
  await w.send("contents");
  assert.equal(w.fire(DEBOUNCE), 0, "nothing changed: nothing to do");
  assert.equal(w.greps().length, greps);
  assert.ok(w.snap().total > 0, "the results are still there");
});

test("S1: a search running when the view changes is stopped, and it runs again on the way back", async () => {
  const { execFn, held } = heldExec();
  const w = await inContents(sharedRepo(), { execFn });
  w.type("needle");
  w.fire(DEBOUNCE);
  await until("it runs", () => held.length === 1);
  await w.send("names");
  await until("the stop", () => w.kills().length === 1);
  held[0]();
  await w.send("contents");
  assert.equal(w.fire(DEBOUNCE), 1);
  await until("again", () => held.length === 2);
  held[1]();
  await w.settled();
  assert.ok(w.snap().total > 0);
});

test("S1: typing while on Names can't happen, but a text that came along waits for Contents", async () => {
  const w = await newWorld(sharedRepo());
  w.type("needle");
  assert.equal(w.fire(DEBOUNCE), 0);
  assert.equal(w.greps().length, 0);
  await w.send("contents");
  assert.equal(w.fire(DEBOUNCE), 1);
  await w.settled();
  assert.ok(w.snap().total > 0);
});

test("S1: another space's folder: the results go at once, the text stays and searches there", async () => {
  const first = sharedRepo(), second = join(base, "other-root");
  write(second, "elsewhere.txt", "needle over here\n");
  const w = await inContents(first);
  await w.go("needle");
  assert.ok(w.snap().total > 1);

  w.root = second;
  w.draw();
  await until("the second root", () => w.view.state?.root === second);
  assert.equal(w.snap().total, null, "nothing of the first root");
  assert.equal(w.box().value(), "needle");
  await until("its search to wait", () => w.fire(DEBOUNCE) === 1);
  await w.settled();
  assert.deepEqual(w.snap().rows.filter((r) => r.file).map((r) => r.file), ["elsewhere.txt"]);
});

test("S1, Risk 4: a root that changes under a running search drops what it finds", async () => {
  const { execFn, held } = heldExec();
  const first = sharedRepo(), second = join(base, "other-root-2");
  write(second, "elsewhere.txt", "needle over here\n");
  const w = await inContents(first, { execFn });
  w.type("needle");
  w.fire(DEBOUNCE);
  await until("it runs", () => held.length === 1);
  w.root = second;
  w.draw();
  await until("the second root", () => w.view.state?.root === second);
  await until("the stop", () => w.kills().length === 1);
  held[0]();
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(w.snap().total, null);
});

test("D7: outside git the panel searches with grep", async () => {
  const w = await inContents(plain());
  await w.go("needle");
  assert.ok(w.greps().at(-1)[1].includes("-rnIs"));
  assert.ok(w.snap().rows.some((r) => r.file === "a.txt"));
});

test("S1: a query over 8 KiB, as in Orca: no program and no results, with no error", async () => {
  const w = await inContents(sharedRepo());
  w.type("a".repeat(8 * 1024 + 1));
  assert.equal(w.fire(DEBOUNCE), 0);
  assert.equal(w.greps().length, 0);
  assert.equal(w.snap().total, 0);
  assert.equal(w.snap().error, null);
  assert.match(textOf(w.draw()), /No results/);
  w.type("a".repeat(8 * 1024));
  assert.equal(w.fire(DEBOUNCE), 1);
  await w.settled();
});

test("S1: render works nothing out: Herdr interrupts a slow one, so the rows are ready when it comes", async () => {
  const w = await inContents(sharedRepo());
  await w.go("needle");
  const rows = w.view.found.rows;
  w.draw();
  w.draw();
  assert.equal(w.view.found.rows, rows);
});

// ── What the change touches, pinned ────────────────────────────────────────

test("S1: Names keeps working while a search runs, and its filter's input is its own", async () => {
  const { execFn, held } = heldExec();
  const w = await inContents(sharedRepo(), { execFn });
  w.type("needle");
  w.fire(DEBOUNCE);
  await until("it runs", () => held.length === 1);
  await w.send("names");
  const drawn = w.draw();
  assert.ok(findAll(drawn, "Input").some((i) => i.arg === w.inputs["Find files"]));
  w.type("readme", w.inputs["Find files"]);
  assert.equal(w.view.filter, "readme");
  assert.equal(w.snap().query, "needle", "two texts, each its own");
  await w.send("clear-filter");
  held[0]();
});

test("pin: the tree's click still opens in preview, with no line", async () => {
  const w = await newWorld(sharedRepo());
  await w.send("open:untracked.md");
  await until("the tab", () => w.runs.some(([name]) => name === "tab.new"));
  const [, args] = w.runs.find(([name]) => name === "tab.new");
  assert.equal(Object.hasOwn(args.props, "line"), false);
  await until("its entry", () => Object.keys(w.shared.get(DOCS_KEY) ?? {}).length === 1);
  assert.equal(Object.values(w.shared.get(DOCS_KEY))[0].preview, true);
});

test("pin: the header's Refresh and Collapse All stay Names' own", async () => {
  const w = await inContents(sharedRepo());
  assert.equal(find(w.draw(), "explorer-refresh").handlers.click, undefined);
  assert.equal(find(w.draw(), "explorer-collapse").handlers.click, undefined);
  await w.send("names");
  assert.ok(find(w.draw(), "explorer-refresh").handlers.click);
});
