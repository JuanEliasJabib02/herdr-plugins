// What Contents decides, with no herdr or gpui-kit imports so `node --test` can load
// it (D8): git's and grep's arguments, what they print, the rows, the trim and the
// texts. As in Orca (shared/text-search.ts, shared/text-search-glob-patterns.ts,
// shared/text-search-match-accumulator.ts, right-sidebar/SearchResultItems.tsx), with
// git grep and grep where Orca has ripgrep (D7). main.js runs them.
import { READ_ONLY } from "./git-model.js";
import { PRUNED_NAMES, isListed, overBytes } from "./names-model.js";
import { TEXT } from "./tree-model.js";

// S11.
export const SEARCH = {
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
};

// Orca's numbers.
export const DEBOUNCE = 300;
export const SEARCH_LIMIT = 15000;
export const MAX_RESULTS = 2000;
export const BEFORE_MAX = 26;
export const MAX_LINE = 500;
// Each of the three fields; past it, no results and no error.
const FIELD_BYTES = 8 * 1024;

// What a search may print, under exec's 8 MiB, as names-model.js's listing.
const OUTPUT_BYTES = 4 * 1024 * 1024;
// A line past this isn't scanned in JS, so a minified file costs what any line costs.
const LONG_LINE = 10000;
// How far into a long line a byte column is worked out, some 20 ms of Herdr's runtime.
const LONG_WALK = 200000;
const MATCH_WINDOW = 2000;

export const newSearch = () => ({ query: "", caseSensitive: false, wholeWord: false, useRegex: false, include: "", exclude: "" });

export const isBlank = (options) => !options.query.trim();
export const overLimit = ({ query, include, exclude }) => [query, include, exclude].some((text) => overBytes(text, FIELD_BYTES));
export const noResults = () => ({ files: [], total: 0, truncated: false });

export const activeFilters = ({ include, exclude }) => Number(Boolean(include.trim())) + Number(Boolean(exclude.trim()));

// What one search asked: the same asked again needn't run again.
export const searchKey = (root, options) => JSON.stringify([root, options.query, options.caseSensitive, options.wholeWord, options.useRegex, options.include, options.exclude]);

// ── The filter fields ──────────────────────────────────────────────────────

// Commas outside groups and classes separate patterns, and a backslash keeps a comma
// in (Orca's splitSearchGlobPatterns, for its git engine).
export function splitPatterns(text) {
  const out = [];
  let current = "", escaping = false, braces = 0, classStart = -1, posixStart = -1;
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaping) { current += `\\${c}`; escaping = false; continue; }
    if (c === "\\") { escaping = true; continue; }
    if (classStart !== -1) {
      if (posixStart !== -1) {
        if (c === "]") {
          if (text[i - 1] !== ":" || i <= posixStart + 3) classStart = -1;
          posixStart = -1;
        }
      } else if (c === "[" && text[i + 1] === ":") posixStart = i;
      else if (c === "]" && i > classStart) classStart = -1;
    } else if (c === "[") {
      const next = text[i + 1];
      classStart = i + (next === "!" || next === "^" ? 2 : 1);
    } else if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    if (c === "," && braces === 0 && classStart === -1) { flush(); continue; }
    current += c;
  }
  if (escaping) current += "\\";
  flush();
  return out;
}

function classEnd(glob, at) {
  let i = at + 1;
  if (glob[i] === "!" || glob[i] === "^") i++;
  if (glob[i] === "]") i++;
  for (; i < glob.length; i++) {
    if (glob[i] === "\\") i++;
    else if (glob[i] === "]") return i;
  }
  return -1;
}

// The first group holding a comma at its own level: `{start, end, commas}`.
function firstGroup(glob) {
  let depth = 0, start = -1, commas = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") {
      const end = classEnd(glob, i);
      if (end !== -1) { i = end; continue; }
    }
    if (c === "{") {
      if (depth++ === 0) { start = i; commas = []; }
    } else if (c === "," && depth === 1) commas.push(i);
    else if (c === "}" && depth > 0 && --depth === 0 && commas.length) return { start, end: i, commas };
  }
  return null;
}

const MAX_EXPANDED = 64;

// Git's globs have no braces, and ripgrep's do, so `*.{ts,tsx}` works here as in Orca.
// A field with too many groups keeps the rest as they are.
export function expandBraces(glob) {
  const done = [], pending = [glob];
  while (pending.length) {
    const next = pending.shift();
    const group = firstGroup(next);
    // One pattern becomes as many as its group has options.
    if (!group || done.length + pending.length + group.commas.length + 1 > MAX_EXPANDED) { done.push(next); continue; }
    const cuts = [group.start, ...group.commas, group.end];
    const head = next.slice(0, group.start), tail = next.slice(group.end + 1);
    pending.unshift(...cuts.slice(1).map((cut, i) => `${head}${next.slice(cuts[i] + 1, cut)}${tail}`));
  }
  return done;
}

const patternsOf = (text) => splitPatterns(text).flatMap(expandBraces);

// A word without a slash is at any depth and a folder's name reaches what's in it, as
// ripgrep's globs; a leading slash anchors it to the root.
export function globPathspecs(glob, exclude = false) {
  const directoryOnly = /\/+$/.test(glob), anchored = glob.startsWith("/");
  const body = glob.replace(/^\/+|\/+$/g, "");
  if (!body) return [];
  const spec = `${exclude ? ":(exclude,glob)" : ":(glob)"}${!anchored && !body.includes("/") ? "**/" : ""}${body}`;
  return directoryOnly ? [`${spec}/**`] : [spec, `${spec}/**`];
}

// The same pattern for grep, which has no such thing as a path's glob: in JS.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export function globRegExp(glob) {
  const directoryOnly = /\/+$/.test(glob), anchored = glob.startsWith("/");
  const body = glob.replace(/^\/+|\/+$/g, "");
  if (!body) return null;
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      source += escapeRegex(body[++i] ?? "\\");
    } else if (c === "*") {
      const whole = body[i + 1] === "*" && (i === 0 || body[i - 1] === "/");
      if (whole && body[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
      else if (whole && i + 2 === body.length) { source += ".*"; i += 1; }
      else source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "[" && classEnd(body, i) !== -1) {
      const end = classEnd(body, i), negated = body[i + 1] === "!" || body[i + 1] === "^";
      const members = body.slice(i + (negated ? 2 : 1), end).replace(/[\\\]^]/g, "\\$&");
      source += `[${negated ? "^" : ""}${members}]`;
      i = end;
    } else source += escapeRegex(c);
  }
  const start = !anchored && !body.includes("/") ? "(?:.*/)?" : "";
  try { return new RegExp(`^${start}${source}${directoryOnly ? "/.*" : "(?:/.*)?"}$`); }
  catch { return null; }
}

// ── D7: the arguments ──────────────────────────────────────────────────────

// Perl's regular expressions are what ripgrep's look like: `\d` and `\b` mean nothing
// to `-E` on macOS. Not every git has them, hence the fallback.
export function gitGrepArgs({ query, caseSensitive, wholeWord, useRegex, include, exclude }, engine = "perl") {
  const args = [...READ_ONLY, "-c", "submodule.recurse=false", "grep", "-z", "-n", "--column", "-I", "--no-color", "--untracked", "--no-recurse-submodules"];
  if (!caseSensitive) args.push("-i");
  if (wholeWord) args.push("-w");
  args.push(useRegex ? (engine === "perl" ? "-P" : "-E") : "-F", "-e", query, "--");
  const included = patternsOf(include).flatMap((glob) => globPathspecs(glob));
  const excluded = patternsOf(exclude).flatMap((glob) => globPathspecs(glob, true));
  args.push(...included, ...excluded);
  // Asked to include and nothing usable came out: nothing, as Orca's.
  if (include.trim() && !included.length) args.push(":(top,literal).git");
  else if (!included.length && !excluded.length) args.push(".");
  return args;
}

export function grepArgs({ query, caseSensitive, wholeWord, useRegex }) {
  const args = ["-rnIs", "--null", ...PRUNED_NAMES.map((name) => `--exclude-dir=${name}`)];
  if (!caseSensitive) args.push("-i");
  if (wholeWord) args.push("-w");
  args.push(useRegex ? "-E" : "-F", "-e", query, "--", ".");
  return args;
}

// exec can't be cancelled, so a search is stopped by name (killArgs): the tag goes in
// the searching program's own arguments, as a config nothing reads or an exclude
// nothing matches. It comes in two pieces so the shell's arguments never hold it whole:
// only the program dies, and the shell and head stay to hand over what it found.
// A pipeline hides the program's exit code, so the program's group reports it on stderr.
export const GIT_SCRIPT = `tag=$1$2; shift 2; { git -c "code-explorer.search=$tag" "$@"; echo "status:$?" >&2; } | head -n ${MAX_RESULTS + 1} | head -c ${OUTPUT_BYTES}`;
// What's filtered comes after this, so no cap on lines.
export const GREP_SCRIPT = `tag=$1$2; shift 2; { grep --exclude="$tag" "$@"; echo "status:$?" >&2; } | head -c ${OUTPUT_BYTES}`;

export const newTag = () => `code-explorer-search-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const killArgs = (tag) => ["pkill", ["-f", tag]];

const IN_REPO_ARGS = ["rev-parse", "--is-inside-work-tree"];

// What the search printed, or null when it stopped being wanted before it ran.
// `live`: whether it's still wanted. `exec` as Herdr's.
export async function readSearch({ root, options, tag, live = () => true }, exec) {
  const repo = await exec("git", IN_REPO_ARGS, { cwd: root }).then((r) => r.code === 0 && r.stdout.trim() === "true").catch(() => false);
  if (!live()) return null;
  const cut = Math.floor(tag.length / 2), pieces = [tag.slice(0, cut), tag.slice(cut)];
  const run = (script, args) => exec("sh", ["-c", script, "code-explorer", ...pieces, ...args], { cwd: root });
  if (!repo) return { ...(await run(GREP_SCRIPT, grepArgs(options))), plain: true };
  const first = await run(GIT_SCRIPT, gitGrepArgs(options));
  if (options.useRegex && !first.stdout && first.stderr.includes("USE_LIBPCRE") && live()) return run(GIT_SCRIPT, gitGrepArgs(options, "extended"));
  return first;
}

const STATUS = /(?:^|\n)status:(\d+)\n?$/;

// What went wrong, in the program's words, or null. 1 is no match, and past 128 a
// signal: head had enough, or it was stopped. What it found stands whatever it said.
export function searchError({ stdout, stderr, code = 0 }) {
  if (stdout) return null;
  const status = STATUS.exec(stderr);
  const said = (status ? stderr.slice(0, status.index) : stderr).trim().split("\n")[0];
  const number = status ? Number(status[1]) : code;
  return number >= 2 && number <= 128 ? said || null : null;
}

// ── The parse ──────────────────────────────────────────────────────────────

// Finds what git found, for the columns and lengths it doesn't give, as Orca's
// buildSubmatchRegex: null if JS can't read the pattern. git's -w looks at the
// characters around the match, which `\b` doesn't for a word starting with a symbol.
function finderOf({ query, caseSensitive, wholeWord, useRegex }) {
  const pattern = useRegex ? query : escapeRegex(query);
  try { return new RegExp(wholeWord ? `(?<!\\w)(?:${pattern})(?!\\w)` : pattern, caseSensitive ? "g" : "gi"); }
  catch { return null; }
}

function allMatches(text, finder, limit) {
  const found = [];
  finder.lastIndex = 0;
  for (let m = finder.exec(text); m; m = finder.exec(text)) {
    if (m[0].length) found.push({ start: m.index, length: m[0].length });
    else finder.lastIndex++;
    if (found.length > limit) break;
  }
  return found;
}

const ASCII = /^[\x00-\x7f]*$/;

// git's column counts bytes from 1; null past what's worth walking.
function charIndex(text, column) {
  const bytes = column - 1;
  if (ASCII.test(text)) return Math.min(bytes, text.length);
  let at = 0;
  for (let i = 0; i < text.length && i < LONG_WALK; i++) {
    if (at >= bytes) return i;
    const code = text.charCodeAt(i);
    if (code < 0x80) at += 1;
    else if (code < 0x800) at += 2;
    // A surrogate pair is four bytes in two units.
    else if (code >= 0xd800 && code < 0xe000) at += 2;
    else at += 3;
  }
  return at >= bytes ? Math.min(LONG_WALK, text.length) : null;
}

// When JS can't say, or the line's too long to ask: where git says, or the start. How
// long only if JS finds it right there; a hit git confirmed stays either way.
function fallbackMatch(text, column, finder) {
  const start = (column && charIndex(text, column)) ?? 0;
  if (!finder || !column) return { start, length: 0 };
  finder.lastIndex = 0;
  const m = finder.exec(text.slice(start, start + MATCH_WINDOW));
  return { start, length: m?.index === 0 ? m[0].length : 0 };
}

// Past MAX_LINE, a window around the match, as Orca's clampLineContext.
function clamped(text, start, length) {
  if (text.length <= MAX_LINE) return { text, start, shown: length };
  const room = MAX_LINE - Math.min(length, MAX_LINE);
  let from = Math.max(0, start - Math.floor(room / 2));
  const to = Math.min(text.length, from + MAX_LINE);
  from = Math.max(0, to - MAX_LINE);
  const shownStart = Math.max(from, Math.min(start, to));
  const shown = Math.max(0, Math.min(start + length, to) - shownStart);
  const lead = from > 0 ? "…" : "";
  return { text: `${lead}${text.slice(from, to)}${to < text.length ? "…" : ""}`, start: shownStart - from + lead.length, shown };
}

// `path\0line\0column\0text\n`; an older git, `path\0line:column:text\n`; grep,
// `./path\0line:text\n`.
const GIT_NUMBERS = /^(\d+)[\0:](\d+)[\0:]/;
const GREP_NUMBERS = /^(\d+):/;
// Yields to the window this often: 2000 records parse in a few ms, the scan is what costs.
const RECORD_SLICE = 100;

function acceptOf(options) {
  const included = patternsOf(options.include).map(globRegExp).filter(Boolean);
  const excluded = patternsOf(options.exclude).map(globRegExp).filter(Boolean);
  const wanted = Boolean(options.include.trim());
  return (path) => isListed(path) && (!wanted || included.some((re) => re.test(path))) && !excluded.some((re) => re.test(path));
}

// `{ files: [{ path, matches }], total, truncated }`; a match is `{ n, line, column,
// length, text, start, shown }`: n across all files, column and length in the line as
// it is, and text, start and shown what draws it. `breathe` as names-model.js's pacer.
export async function parseResults({ stdout, plain = false }, options, breathe) {
  const files = new Map(), finder = finderOf(options);
  const numbers = plain ? GREP_NUMBERS : GIT_NUMBERS;
  // Outside git include and exclude are still to be applied, and what's pruned by a
  // whole path, which grep's --exclude-dir can't name.
  const accept = plain ? acceptOf(options) : () => true;
  let total = 0, truncated = false, at = 0, seen = 0;
  while (at < stdout.length) {
    const nameEnd = stdout.indexOf("\0", at);
    const end = nameEnd === -1 ? -1 : stdout.indexOf("\n", nameEnd + 1);
    if (end === -1) { truncated = true; break; }
    const rawPath = stdout.slice(at, nameEnd);
    const rest = stdout.slice(nameEnd + 1, end);
    at = end + 1;
    const head = numbers.exec(rest);
    if (!head) { truncated = true; continue; }
    const path = plain ? rawPath.replace(/^\.\//, "") : rawPath;
    if (!accept(path)) continue;
    if (total === MAX_RESULTS) { truncated = true; break; }
    const line = Number(head[1]), column = plain ? null : Number(head[2]);
    const text = rest.slice(head[0].length).replace(/\r$/, "");
    const room = MAX_RESULTS - total;
    const long = text.length > LONG_LINE;
    let found = !long && finder ? allMatches(text, finder, room) : [];
    if (!found.length) found = [fallbackMatch(text, column, finder)];
    if (long || found.length > room) truncated = true;
    let file = files.get(path);
    if (!file) { file = { path, matches: [] }; files.set(path, file); }
    for (const { start, length } of found.slice(0, room)) {
      file.matches.push({ n: total++, line, column: start + 1, length, ...clamped(text, start, length) });
    }
    if (++seen % RECORD_SLICE === 0) await breathe();
  }
  return { files: [...files.values()], total, truncated };
}

// ── The rows ───────────────────────────────────────────────────────────────

const isLowSurrogate = (code) => code >= 0xdc00 && code < 0xe000;
const asDrawn = (text) => text.replaceAll("\t", "  ");

// The row's three pieces, as Orca's MatchResultRow: at most 26 characters before the
// match, the rest whole for the row to cut. A tab draws as two spaces, as the line view.
export function matchParts({ text, start, shown }) {
  const before = text.slice(0, start).trimStart();
  let cut = before;
  if (before.length > BEFORE_MAX) {
    const from = before.length - BEFORE_MAX;
    cut = `…${before.slice(isLowSurrogate(before.charCodeAt(from)) ? from + 1 : from)}`;
  }
  return { before: asDrawn(cut), match: asDrawn(text.slice(start, start + shown)), after: asDrawn(text.slice(start + shown)) };
}

// One row per file and then one per match, flat, for the list: each key is what a
// click reports. `collapsed`: the paths whose matches don't show.
export function searchRows(results, collapsed) {
  const rows = [];
  for (const file of results?.files ?? []) {
    const cut = file.path.lastIndexOf("/"), shut = collapsed.has(file.path);
    rows.push({
      kind: "file", key: `file:${file.path}`, path: file.path, name: file.path.slice(cut + 1), dir: cut === -1 ? "" : file.path.slice(0, cut), count: file.matches.length, collapsed: shut,
    });
    if (!shut) for (const match of file.matches) rows.push({ kind: "match", key: `match:${match.n}`, path: file.path, match });
  }
  return rows;
}

// What result number n opens.
export function matchAt(results, n) {
  for (const file of results?.files ?? []) {
    const match = file.matches.find((m) => m.n === n);
    if (match) return { path: file.path, line: match.line };
  }
  return null;
}

// ── The texts ──────────────────────────────────────────────────────────────

const counted = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// "5 results in 2 files", when there's anything to say.
export function searchSummary(results) {
  if (!results || (!results.total && !results.truncated)) return null;
  const summary = `${counted(results.total, "result")} in ${counted(results.files.length, "file")}`;
  return results.truncated ? `${summary} ${SEARCH.truncated}` : summary;
}

// What shows in place of results, or null: results, or the input's spinner.
export function searchMessage({ query, results, loading, error }) {
  if (error) return { text: error, failed: true };
  if (!query.trim()) return { text: TEXT.typeToSearch, failed: false };
  if (results?.total === 0 && !loading) return { text: SEARCH.noResults, failed: false };
  return null;
}
