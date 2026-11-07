// What the Explorer decides, with no herdr or gpui-kit imports so `node --test` can
// load it (D8): the listing, the rows, where a space's tree is rooted, what a batch
// of disk changes reloads, and what opening a file does. main.js draws and runs it.
import { fileIcon, folderIcon } from "./icon-model.js";
import { isIgnored } from "./git-model.js";

// S10, D21's, and S11's for before a search; the rest of S11 in search-model.js.
export const TEXT = {
  collapseAll: "Collapse All",
  refresh: "Refresh Explorer",
  more: "More Explorer Actions",
  showDotfiles: "Show Dotfiles",
  showIgnored: "Show Git Ignored Files",
  names: "Names",
  contents: "Contents",
  findFiles: "Find files",
  clearFilter: "Clear file filter",
  noMatches: "No files match this filter",
  noFiles: "No files in this workspace",
  noWorkspace: "Select a workspace to browse files",
  ignored: "Ignored by .gitignore",
  remote: "Explorer works on this computer only",
  noWorkspaceSearch: "Select a workspace to search",
  typeToSearch: "Type to search in files",
  loadFailed: "Could not load files for this workspace:",
  retry: "Retry",
};

// ── Order ──────────────────────────────────────────────────────────────────

// Orca sorts with Intl.Collator("en", {numeric: true}) and breaks ties by code
// unit (shared/file-name-sort.ts). Herdr's runtime has no Intl, and its
// localeCompare is plain code-unit order, so this is that collation by hand:
// spaces and punctuation in ICU's order, then digits by value, then letters without
// regard to accents or case; those two only settle what's otherwise equal.
const PUNCTUATION = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
const isDigit = (c) => c >= "0" && c <= "9";

function weight(c) {
  const punctuation = PUNCTUATION.indexOf(c);
  if (punctuation !== -1) return punctuation;
  return isDigit(c) ? 100 + Number(c) : 1000 + c.charCodeAt(0);
}

const fold = (name) => (name.normalize?.("NFD") ?? name).replace(/[̀-ͯ]/g, "").toLowerCase();
const digitsEnd = (text, from) => {
  let end = from;
  while (end < text.length && isDigit(text[end])) end++;
  return end;
};

export function compareNames(a, b) {
  const x = fold(a), y = fold(b);
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (isDigit(x[i]) && isDigit(y[j])) {
      const iEnd = digitsEnd(x, i), jEnd = digitsEnd(y, j);
      const n = x.slice(i, iEnd).replace(/^0+(?=\d)/, ""), m = y.slice(j, jEnd).replace(/^0+(?=\d)/, "");
      if (n.length !== m.length) return n.length - m.length;
      if (n !== m) return n < m ? -1 : 1;
      i = iEnd; j = jEnd;
      continue;
    }
    if (x[i] !== y[j]) return weight(x[i]) - weight(y[j]);
    i++; j++;
  }
  if (x.length - i !== y.length - j) return x.length - i - (y.length - j);
  // Equal so far: accents and leading zeros by code unit (`e` before `é`, `02`
  // before `2`), then case with lower first (`a` before `A`).
  const lowerA = a.toLowerCase(), lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a === b ? 0 : a > b ? -1 : 1;
}

// Folders first (shared/file-name-sort.ts compareDirEntries).
export const compareEntries = (a, b) => Number(b.dir) - Number(a.dir) || compareNames(a.name, b.name);

// ── The listing ────────────────────────────────────────────────────────────

const TEMPORARY = ".herdr-app-write-";

// D23: always hidden, as in Orca, and D19: writeTextFile's temporaries never show.
export const isHiddenName = (name) => name === ".git" || name === "node_modules" || name.startsWith(TEMPORARY);

// One folder's entries, as `kind\0name\0link\0`: `d` or `f`, and for a symlink to a
// folder where it really leads (`?` if it can't be followed). `cd` and `pwd -P`
// are the shell's own, so a folder of links starts no program per link. Past
// LIST_LIMIT it stops; `test -d` fails the listing when the folder is gone.
export const LIST_LIMIT = 5000;
export const LIST_SCRIPT = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; link=; if [ "$kind" = d ] && [ -L "$p" ]; then link=$(cd "$p" 2>/dev/null && pwd -P) || link='?'; fi; printf '%s\\0%s\\0%s\\0' "$kind" "\${p##*/}" "$link"; n=$((n+1)); [ "$n" -gt ${LIST_LIMIT} ] && break; done; test -d "$1"`;

const fieldsOf = (stdout) => stdout.split("\0").slice(0, -1);

// D23: a symlinked folder that leaves the root's real path is shown but never
// entered; `rootReal` because the root itself may be reached through a link.
function linkKind(link, rootReal) {
  if (!link) return null;
  return link === rootReal || link.startsWith(`${rootReal}/`) ? "inside" : "outside";
}

export function parseListing(stdout, rootReal) {
  const fields = fieldsOf(stdout), out = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const name = fields[i + 1];
    if (!isHiddenName(name)) out.push({ name, dir: fields[i] === "d", link: linkKind(fields[i + 2], rootReal) });
  }
  return out.sort(compareEntries);
}

export const listingLimited = (stdout) => fieldsOf(stdout).length / 3 > LIST_LIMIT;

// ── Rows ───────────────────────────────────────────────────────────────────

// Orca's indent; rows are 24 px.
export const indentOf = (depth) => depth * 16 + 8;
export const ROW_HEIGHT = 24;

// A link inside the root can point back up: the tree opens by hand, one level per
// click, and stops here.
const MAX_DEPTH = 40;

// Orca's definition: any segment longer than one character starting with a dot.
export const isDotfile = (path) => path.split("/").some((part) => part.length > 1 && part !== ".." && part.startsWith("."));

// The rows on screen, flat. The filter gives the same shape.
export function visibleRows({ entries, expanded, git, icons, showDotfiles, showIgnored, errors }) {
  const rows = [];
  const walk = (folder, depth) => {
    for (const entry of entries.get(folder) ?? []) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (!showDotfiles && isDotfile(path)) continue;
      const ignored = isIgnored(git.ignored, path);
      if (!showIgnored && ignored) continue;
      const enterable = entry.dir && entry.link !== "outside", open = enterable && expanded.has(path);
      // A folder's own letter covers a submodule, which git lists as one path.
      const status = (entry.dir ? git.folders.get(path) : null) ?? git.marks.get(path) ?? null;
      rows.push({
        path, name: entry.name, depth, dir: entry.dir, enterable, open, status,
        // A status wins over the ignored look (Orca's shouldShowIgnoredDecoration).
        ignored: ignored && !status,
        icon: entry.dir ? folderIcon(icons, entry.name, open) : fileIcon(icons, entry.name),
        error: errors?.get(path) ?? null,
      });
      if (open && depth < MAX_DEPTH) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

// Only that folder, as Orca's toggleDir: what's open inside stays open for next time.
export function toggleExpanded(expanded, path) {
  const next = new Set(expanded);
  if (!next.delete(path)) next.add(path);
  return next;
}

// A folder its parent no longer lists as one leaves the open set, with what was
// inside. A parent not read yet says nothing.
export function pruneExpanded(expanded, entries) {
  const roots = [...expanded].filter((folder) => {
    const cut = folder.lastIndexOf("/");
    const listed = entries.get(cut === -1 ? "" : folder.slice(0, cut));
    const name = folder.slice(cut + 1);
    return listed && !listed.some((e) => e.name === name && e.dir && e.link !== "outside");
  });
  const inside = (folder) => roots.some((gone) => folder === gone || folder.startsWith(`${gone}/`));
  return { expanded: new Set([...expanded].filter((f) => !inside(f))), gone: [...expanded].filter(inside) };
}

// What the tree says in place of rows, or null: rows, or a spinner while loading.
export function treeMessage({ hasFolder, remote, loaded, error, rows }) {
  if (remote) return TEXT.remote;
  if (!hasFolder) return TEXT.noWorkspace;
  if (error) return `${TEXT.loadFailed} ${error}`;
  if (!loaded || rows > 0) return null;
  return TEXT.noFiles;
}

// Contents with nowhere to search. With somewhere, search-model.js's searchMessage.
export function contentsMessage({ hasFolder, remote }) {
  if (remote) return TEXT.remote;
  return hasFolder ? TEXT.typeToSearch : TEXT.noWorkspaceSearch;
}

// ── Where a space's tree is rooted ─────────────────────────────────────────

// As Herdr's files panel: the focused terminal's folder. A focused mod tab (an open
// file) has none, so the space's last known one stays, or opening a file would
// move the tree under the person's hand; then its first terminal, then its folder.
// `live` is what's worth remembering.
export function locate({ spaces, focused, panes, remembered }) {
  const space = spaces.find((s) => s.active);
  if (!space) return null;
  const pane = focused?.pane ? panes.find((p) => p.pane === focused.pane) : null;
  const live = pane?.cwd || focused?.cwd || null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const first = panes.find((p) => tabs.has(p.tab) && p.cwd);
  const block = focused && !focused.pane && focused.terminal?.includes("/") ? focused.terminal.split("/")[0] : null;
  return {
    space: space.id, name: space.name, machine: space.machine ?? block, live,
    cwd: live || remembered || first?.cwd || space.folder || null,
  };
}

// ── Reacting to the disk ───────────────────────────────────────────────────

export const ALL = { all: true, folders: [], git: true };

// What a watchFolder batch reloads: the loaded folders it touched, and the marks.
// The root, or a path that can't be placed, means everything (herdr.d.ts: pending
// paths are bounded). `.git` only moves marks; node_modules is hidden and busy.
export function batchPlan(paths, rootReal, loaded) {
  if (!rootReal) return ALL;
  const folders = new Set();
  let git = false;
  for (const raw of paths) {
    const path = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (path === rootReal || !path.startsWith(`${rootReal}/`)) return ALL;
    const rel = path.slice(rootReal.length + 1), parts = rel.split("/");
    if (parts.at(-1).startsWith(TEMPORARY) || parts.includes("node_modules")) continue;
    git = true;
    if (parts[0] === ".git") continue;
    const parent = parts.slice(0, -1).join("/");
    if (loaded.has(parent)) folders.add(parent);
    if (loaded.has(rel)) folders.add(rel);
  }
  return { all: false, folders: [...folders], git };
}

export function mergePlans(a, b) {
  if (!a) return b;
  if (a.all || b.all) return ALL;
  return { all: false, folders: [...new Set([...a.folders, ...b.folders])], git: a.git || b.git };
}

const findNode = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
};

// A copy stays alive while hidden, and its timers run (AGENTS.md: poll gently): this
// is whether anyone can see it. Another layout placing it has no such panel.
export function isShown(layout) {
  const panel = findNode(layout, "panel");
  if (panel?.hidden) return false;
  const body = findNode(layout, "panel-body");
  return !body?.active || body.active === "explorer";
}

// ── Commands and clicks ────────────────────────────────────────────────────

// D2: `<name>` or `<name>:<argument>`; a path keeps its dots and colons.
export function parseCommand(raw) {
  const text = String(raw).replace(/^code-explorer\./, "");
  const cut = text.indexOf(":");
  return cut === -1 ? { name: text, arg: "" } : { name: text.slice(0, cut), arg: text.slice(cut + 1) };
}

// A virtual list's on_item_click has no click_count.
const DOUBLE_CLICK = 400;
export const isDoubleClick = (last, path, now) => Boolean(last) && last.path === path && now - last.at <= DOUBLE_CLICK;

// ── Opening a file (D10, D11, D18) ─────────────────────────────────────────

export const DOCS_KEY = "code-editor.docs";
export const LIVE_KEY = "code-editor.live";

const FILE_MOD = "code-file";
const OPEN_POLL = 10, OPEN_TIMEOUT = 1000;

// `shared` persists: what comes back may be anything an older build or a broken
// file left, and an inherited name must not read as an entry.
export const table = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const entryOf = (docs, id) => {
  const entry = Object.hasOwn(docs, id) ? docs[id] : null;
  return entry && typeof entry === "object" && typeof entry.file === "string" ? entry : null;
};

// Letters and digits only: it goes in a draft's file name and a mod command.
export const newDoc = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, "0");

// D11, D18: replaceable is a preview with no changes that code-file hasn't pinned,
// alone in its tab: a terminal beside it would go with it.
function replaceable(tab, entry, live) {
  if (!entry?.preview || tab.panes > 1) return false;
  const state = table(live)[entry.doc];
  return !state?.dirty && !state?.pinned;
}

// D21: a tab that can go for a copy of the same file, at a line: props can't change, and
// nothing is lost with no changes and nothing beside it.
function reopenable(tab, entry, live) {
  return Boolean(entry) && tab.panes <= 1 && !table(live)[entry.doc]?.dirty;
}

// The decision, for the tabs of one space: { kind: "select", id, pin }, select what's
// open and maybe pin it; { kind: "replace", id }, a new tab in that preview's place;
// { kind: "reopen", id }, the same for a copy of this file, to show `line`;
// or { kind: "new" }. Opening pinned leaves a preview where it is.
export function planOpen({ file, pin, tabs, docs, live, panes, line = null }) {
  const known = table(docs);
  // An entry alone isn't enough: closing a file with a terminal beside it leaves the
  // tab and the entry, and that tab no longer holds the file.
  const entryHere = (tab) => (panes.some((p) => p.tab === tab.id && p.mod === FILE_MOD) ? entryOf(known, tab.id) : null);
  for (const tab of tabs) {
    const entry = entryHere(tab);
    if (entry?.file !== file) continue;
    return line && reopenable(tab, entry, live) ? { kind: "reopen", id: tab.id } : { kind: "select", id: tab.id, pin: Boolean(pin && entry.preview) };
  }
  if (!pin) for (const tab of tabs) if (replaceable(tab, entryHere(tab), live)) return { kind: "replace", id: tab.id };
  return { kind: "new" };
}

// D10: the tab tab.new made. A tab Claude opened at the same moment is also new, so
// only one holding a code-file pane counts.
export function findNewTab(before, space, panes) {
  for (const tab of space?.tabs ?? []) {
    if (!before.has(tab.id) && panes.some((p) => p.tab === tab.id && p.mod === FILE_MOD)) return tab.id;
  }
  return null;
}

// D18, the one way to close a file's tab. Never `confirmed: true`, which on the last
// tab closes the space without asking; pane.close always names its pane, since
// without one it can end the focused terminal.
export function closeCommand(tab, panes) {
  if (tab.panes <= 1) return ["tab.close", { id: tab.id }];
  const pane = panes.find((p) => p.tab === tab.id && p.mod === FILE_MOD);
  return pane ? ["pane.close", { pane: pane.pane }] : null;
}

// The next code-editor.docs: this entry in; tabs that no longer exist out (D10), and
// anything that isn't an entry, so a broken value heals on the next open.
export function nextDocs(docs, tabIds, id, entry) {
  const known = table(docs), next = {};
  for (const tab of tabIds) if (tab !== id && entryOf(known, tab)) next[tab] = known[tab];
  next[id] = entry;
  return next;
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// Runs the decision against Herdr. `io`: { spaces, panes, shared, setShared, run,
// notify, wait, newDoc }. Only code-explorer writes code-editor.docs (D10), and
// main.js runs one of these at a time.
export async function openFile({ file, pin = false, space, line = null }, io) {
  const spaceNow = () => io.spaces().find((s) => s.id === space);
  const name = baseName(file);
  const failed = () => {
    io.notify({ title: `Couldn't open ${name}`, level: "error" });
    return { kind: "failed" };
  };
  const target = spaceNow();
  if (!target) return failed();

  const plan = planOpen({ file, pin, line, tabs: target.tabs, docs: io.shared(DOCS_KEY), live: io.shared(LIVE_KEY), panes: io.panes() });
  if (plan.kind === "select") {
    io.run("tab.select", { id: plan.id });
    if (plan.pin) {
      const docs = table(io.shared(DOCS_KEY));
      io.setShared(DOCS_KEY, { ...docs, [plan.id]: { ...docs[plan.id], preview: false } });
    }
    // D21: it can't go to a line and it can't be replaced, so it says which.
    if (line) io.notify({ title: `${name} is already open: line ${line}`, level: "info" });
    return plan;
  }

  const before = new Set(target.tabs.map((t) => t.id));
  const doc = io.newDoc();
  try {
    io.run("tab.new", { name, space, mod: FILE_MOD, props: line ? { doc, file, line } : { doc, file } });
  } catch {
    return failed();
  }
  // spaces() doesn't change in the same tick (D10).
  let id = null;
  for (let waited = 0; !id && waited < OPEN_TIMEOUT; waited += OPEN_POLL) {
    await io.wait(OPEN_POLL);
    id = findNewTab(before, spaceNow(), io.panes());
  }
  if (!id) return failed();

  const allTabs = io.spaces().flatMap((s) => s.tabs.map((t) => t.id));
  io.setShared(DOCS_KEY, nextDocs(io.shared(DOCS_KEY), allTabs, id, { doc, file, preview: !pin }));
  if (!spaceNow().tabs.find((t) => t.id === id)?.active) io.run("tab.select", { id });

  if (plan.kind === "replace" || plan.kind === "reopen") {
    // Asked again: the tab may have been edited, closed or split meanwhile.
    const old = spaceNow().tabs.find((t) => t.id === plan.id);
    const entry = entryOf(table(io.shared(DOCS_KEY)), plan.id);
    const free = plan.kind === "reopen" ? reopenable : replaceable;
    if (old && free(old, entry, io.shared(LIVE_KEY))) {
      const close = closeCommand(old, io.panes());
      io.run("tab.move", { id, index: old.index });
      if (close) io.run(...close);
    }
  }
  return { kind: plan.kind, id, doc };
}
