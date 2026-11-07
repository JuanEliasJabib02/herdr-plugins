// What Names' "Find files" filter decides, with no herdr or gpui-kit imports so
// `node --test` can load it (D8): the query, the list of the root's files, and the
// tree of what matches, the same rows the plain tree gives. As in Orca
// (shared/file-name-filter-tokens.ts, right-sidebar/file-explorer-name-filter-projection.ts):
// no fuzzy match and no ranking, each word is a substring of the lower-cased path.
import { fileIcon, folderIcon } from "./icon-model.js";
import { IGNORED_ARGS, isIgnored } from "./git-model.js";
import { TEXT, compareEntries, isDotfile, isHiddenName } from "./tree-model.js";

// ── The query ──────────────────────────────────────────────────────────────

const QUERY_MAX_BYTES = 2 * 1024;

export function overBytes(text, limit) {
  if (text.length > limit) return true;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    // A surrogate pair is four bytes in two units.
    else if (code >= 0xd800 && code < 0xe000) bytes += 2;
    else bytes += 3;
  }
  return bytes > limit;
}

// `active`: there's a filter, so the tree gives way to its results. Spaces alone are
// none. JS's \s is exactly Orca's list of whitespace. Too large a query is a filter
// that matches nothing and reads no list.
export function parseFilter(query) {
  const active = query.trim().length > 0;
  const tooLarge = overBytes(query, QUERY_MAX_BYTES);
  return { active, tooLarge, tokens: active && !tooLarge ? query.toLowerCase().split(/\s+/).filter(Boolean) : [] };
}

// ── The list (D7) ──────────────────────────────────────────────────────────

// Orca's QUICK_OPEN_LISTING_MAX_RESULTS, and what a keystroke can walk in time.
export const LIST_CAP = 20000;
// What find may print, under exec's 8 MiB: a home folder stops here, not at exec's 30 s.
const FIND_BYTES = 4 * 1024 * 1024;

// shared/quick-open-filter.ts: generated caches and state, never hand-edited, plus
// what the tree always hides. Names can't find what's in them, tracked or not.
export const PRUNED_NAMES = [".git", "node_modules", ".next", ".nuxt", ".cache", ".stably", ".vscode", ".idea", ".yarn", ".pnpm-store", ".terraform", ".docker", ".husky", ".npm", ".npm-global", ".gvfs"];
const PRUNED = new Set(PRUNED_NAMES);
const LOCAL_SHARE = ".local/share";

function inLocalShare(path) {
  return path === LOCAL_SHARE || path.startsWith(`${LOCAL_SHARE}/`) || path.endsWith(`/${LOCAL_SHARE}`) || path.includes(`/${LOCAL_SHARE}/`);
}

export const isListed = (path) => !inLocalShare(path) && !path.split("/").some((part) => PRUNED.has(part) || isHiddenName(part));

// The same read-only flags as the git marks, so reading wakes no watch.
const READ_ONLY = IGNORED_ARGS.slice(0, IGNORED_ARGS.indexOf("ls-files"));
// D7's -co, with -s to tell a submodule from a file: a tracked path comes as
// `<mode> <hash> <stage>\t<path>`, an untracked one bare.
export const LIST_ARGS = [...READ_ONLY, "ls-files", "-z", "-s", "-c", "-o", "--exclude-standard"];
// -c still names a tracked file that's gone from disk.
export const DELETED_ARGS = [...READ_ONLY, "ls-files", "-z", "-d"];
// Outside git. Pruned here too, or a home folder walks all its caches. A link is
// listed and never followed.
export const FIND_SCRIPT = `find . \\( ${PRUNED_NAMES.map((name) => `-name ${name}`).join(" -o ")} -o -path '*/${LOCAL_SHARE}' \\) -prune -o \\( -type f -o -type l \\) -print0 | head -c ${FIND_BYTES}`;

// What git or find said, whole, for parseLists and to tell whether anything changed.
export async function readFileList(root, exec) {
  const [listed, deleted, ignored] = await Promise.all([LIST_ARGS, DELETED_ARGS, IGNORED_ARGS].map((args) => exec("git", args, { cwd: root }))).catch(() => []);
  if (listed?.code === 0) {
    return { listed: listed.stdout, deleted: deleted.code === 0 ? deleted.stdout : "", ignored: ignored.code === 0 ? ignored.stdout : "" };
  }
  const found = await exec("sh", ["-c", FIND_SCRIPT, "code-explorer"], { cwd: root });
  if (found.code !== 0) throw new Error(found.stderr.trim() || "Cannot list this folder");
  return { listed: found.stdout, deleted: "", ignored: "" };
}

export const sameLists = (a, b) => Boolean(a && b) && a.listed === b.listed && a.deleted === b.deleted && a.ignored === b.ignored;

// What follows the last NUL is an entry cut short by exec's limit or by head.
const fieldsOf = (stdout) => stdout.split("\0").slice(0, -1);

// Herdr interrupts a script that runs too long, and calls it an error (measured: some
// 50 ms in render, 500 ms in init, a task's unknown). Building the index takes longer
// on a big repo, so it goes in slices: every slice calls `breathe`, and this one
// gives way to the window once the script has run a while, so a small repo never
// waits on a timer. `pause` lets the window draw.
const BURST = 12;

export function pacer(pause, now = Date.now) {
  let since = now();
  return async () => {
    if (now() - since < BURST) return;
    await pause();
    since = now();
  };
}

const STAGED = /^(\d{6}) [0-9a-f]+ \d\t/;
const GITLINK = "160000";
// Some 3 µs a path, here and to insert it in the tree, in Herdr's runtime.
const PATH_SLICE = 500;

// The root's files, `{path, dir, ignored}`: `dir` is a folder git names as a whole,
// with a trailing slash (ignored, or a nested repo) or as a submodule. A merge
// conflict lists a path once per stage.
export async function parseLists({ listed, deleted, ignored }, breathe) {
  const gone = new Set(fieldsOf(deleted));
  const files = new Map();
  let limited = listed !== "" && !listed.endsWith("\0");
  const add = (raw, gitlink, isIgnoredPass) => {
    const slash = raw.endsWith("/"), path = slash ? raw.slice(0, -1) : raw;
    if (path && !files.has(path) && isListed(path)) files.set(path, { path, dir: slash || gitlink, ignored: isIgnoredPass });
  };
  let seen = 0;
  const pass = async (fields, visit) => {
    for (const field of fields) {
      if (files.size === LIST_CAP) { limited = true; return; }
      visit(field);
      if (++seen % PATH_SLICE === 0) await breathe();
    }
  };
  await pass(fieldsOf(listed), (field) => {
    const staged = STAGED.exec(field);
    // find prints `./a`, and no git path starts so.
    const raw = staged ? field.slice(staged[0].length) : field.replace(/^\.\//, "");
    if (!gone.has(raw)) add(raw, staged?.[1] === GITLINK, false);
  });
  await pass(fieldsOf(ignored), (field) => add(field, false, true));
  return { files: [...files.values()], limited };
}

// ── The index ──────────────────────────────────────────────────────────────

// compareNames does Orca's collation by hand, about 4 µs a comparison in Herdr's
// runtime: 250 names take some 8 ms, and 20000 get the script interrupted anywhere.
// Hence once per list, ahead of the keystrokes, in sorted slices and then merged.
const SORT_SLICE = 250;

async function merged(a, b, breathe) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    out.push(compareEntries(b[j], a[i]) < 0 ? b[j++] : a[i++]);
    if (out.length % SORT_SLICE === 0) await breathe();
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

async function sorted(nodes, breathe) {
  if (nodes.length <= SORT_SLICE) return nodes.sort(compareEntries);
  let runs = [];
  for (let at = 0; at < nodes.length; at += SORT_SLICE) {
    runs.push(nodes.slice(at, at + SORT_SLICE).sort(compareEntries));
    await breathe();
  }
  while (runs.length > 1) {
    const next = [];
    for (let at = 0; at < runs.length; at += 2) next.push(at + 1 < runs.length ? await merged(runs[at], runs[at + 1], breathe) : runs[at]);
    runs = next;
  }
  return runs[0];
}

const nodeOf = (path, dir, ignored) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, lower: path.toLowerCase(), dotted: isDotfile(name), dir, ignored, children: dir ? [] : null };
};

// The files as a tree, each folder's children in the tree's order.
export async function buildNameIndex(files, breathe) {
  const root = { children: [] };
  const folders = new Map([["", root]]);
  const folderAt = (path) => {
    let node = folders.get(path);
    if (node) return node;
    node = nodeOf(path, true, false);
    parentOf(path).children.push(node);
    folders.set(path, node);
    return node;
  };
  const parentOf = (path) => {
    const cut = path.lastIndexOf("/");
    return folderAt(cut === -1 ? "" : path.slice(0, cut));
  };
  let seen = 0;
  for (const file of files) {
    if (file.dir) folderAt(file.path).ignored = file.ignored;
    else parentOf(file.path).children.push(nodeOf(file.path, false, file.ignored));
    if (++seen % PATH_SLICE === 0) await breathe();
  }
  let names = 0;
  for (const node of folders.values()) {
    node.children = await sorted(node.children, breathe);
    names += node.children.length;
    if (names >= SORT_SLICE) { names = 0; await breathe(); }
  }
  return root;
}

// ── The rows ───────────────────────────────────────────────────────────────

// The tree of what matches, flat. A folder shows while something below it matches,
// open unless its chevron collapsed it (Orca keeps those apart from the tree's open
// folders); one git named as a whole has nothing below it here, so it matches by its
// own path and doesn't open. This runs per keystroke with up to LIST_CAP paths, so it
// stops at what doesn't cost much: dressRow does the rest for the rows on screen.
// `ignored`: what's ignored, read only with Show Git Ignored Files off. Those two
// toggles drop a folder with all it holds, so each path asks only about its own name.
export function filteredRows({ index, tokens, collapsed, ignored, showDotfiles, showIgnored }) {
  const rows = [];
  const dropped = (node) => (!showDotfiles && node.dotted) || (!showIgnored && (node.ignored || ignored.has(node.path)));
  const rowOf = (node, depth, enterable, open) => ({ path: node.path, name: node.name, depth, dir: node.dir, enterable, open, listedIgnored: node.ignored });
  // `drawn`: false below a collapsed folder, which only asks whether anything matches.
  const walk = (folder, depth, drawn) => {
    let found = false;
    for (const node of folder.children) {
      if (dropped(node)) continue;
      if (node.children?.length) {
        const at = rows.length, open = !collapsed.has(node.path);
        if (drawn) rows.push(null);
        const below = walk(node, depth + 1, drawn && open);
        if (drawn) {
          if (below) rows[at] = rowOf(node, depth, true, open);
          else rows.length = at;
        }
        found ||= below;
      } else if (tokens.every((token) => node.lower.includes(token))) {
        if (drawn) rows.push(rowOf(node, depth, false, false));
        found = true;
      }
      if (found && !drawn) return true;
    }
    return found;
  };
  if (tokens.length) walk(index, 0, true);
  return rows;
}

// A row of filteredRows as main.js's row() draws it, in visibleRows' shape.
export function dressRow(row, git, icons) {
  const status = (row.dir ? git.folders.get(row.path) : null) ?? git.marks.get(row.path) ?? null;
  return {
    path: row.path, name: row.name, depth: row.depth, dir: row.dir, enterable: row.enterable, open: row.open, status,
    // A status wins over the ignored look, as in the tree.
    ignored: (row.listedIgnored || isIgnored(git.ignored, row.path)) && !status,
    icon: row.dir ? folderIcon(icons, row.name, row.open) : fileIcon(icons, row.name),
    error: null,
  };
}

// What the list says in place of rows, or null: rows, or a spinner while loading.
export function filterMessage({ tooLarge, loaded, error, rows }) {
  if (tooLarge) return TEXT.noMatches;
  if (error) return `${TEXT.loadFailed} ${error}`;
  if (!loaded || rows > 0) return null;
  return TEXT.noMatches;
}

// The last answer, until an input changes: render runs on every setShared in the
// window, and thousands of rows are worth keeping.
export function lastResult(compute) {
  let inputs = null, result;
  return (...now) => {
    if (!inputs || now.length !== inputs.length || now.some((value, i) => value !== inputs[i])) {
      inputs = now;
      result = compute(...now);
    }
    return result;
  };
}
