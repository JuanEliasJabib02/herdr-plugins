// The Explorer, in the projects layout's right panel, built from how Orca does it
// (S1, S3): the repo's name and its three buttons, Names and Contents, and a lazy
// tree with Material icons and git marks. A file opens in a tab of its own (S6).
//
// tree-model.js, names-model.js, search-model.js, ops-model.js, git-model.js and
// icon-model.js decide; this file draws and runs programs. Every click goes through a
// method a `code-explorer.<command>` can also call (D2), since real clicks can't be
// posted to Herdr: see command().
//
// One mod in views, as projects-sidebar's: the layout's copy has no props { view } and
// is the panel, the only one that runs operations; file-menu.js and file-dialog.js are
// the copies its overlays get.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, shared, setShared, run, notify, nextCommand, layout, appHome, home,
} from "herdr";
// What's used from here by name would fail this whole file at load in a test whose
// stand-in for Herdr lacks it: writeTextFile, closeOverlay and props.
import * as herdr from "herdr";
import * as fs from "fs/promises";
import { ICON_THEME, fileIcon, folderIcon, parseIconTheme } from "./icon-model.js";
import { GIT_COLORS, IGNORED_ARGS, ROOT_ARGS, STATUS_ARGS, buildFolderStatus, parseIgnored, parseRepo, parseStatus } from "./git-model.js";
import {
  ALL, DOCS_KEY, LIST_LIMIT, LIST_SCRIPT, ROW_HEIGHT, TEXT, batchPlan, contentsMessage, indentOf, isDoubleClick, isShown, listingLimited, locate,
  holdsHome, mergePlans, newDoc, openFile, parseCommand, parseListing, pruneExpanded, table, toggleExpanded, treeMessage, visibleRows,
} from "./tree-model.js";
import { LIST_CAP, buildNameIndex, dressRow, filterMessage, filteredRows, lastResult, pacer, parseFilter, parseLists, readFileList, sameLists } from "./names-model.js";
import {
  DEBOUNCE, SEARCH, SEARCH_LIMIT, activeFilters, isBlank, killArgs, matchAt, matchParts, newSearch, newTag, noResults, overLimit, parseResults, readSearch, searchError, searchKey,
  searchMessage, searchRows, searchSummary,
} from "./search-model.js";
import {
  OPS, OP_KEY, clearPath, closeTabs, copyText, createPath, deleteForever, duplicateFile, entryTitle, folderPattern, movedFolders, relProblem, renamePath, renameSelection,
  reopenTabs, splitTarget, targetFolder, trashPath, withoutFolder,
} from "./ops-model.js";
import FileMenu, { openFileMenu } from "./file-menu.js";
import FileDialog, { openFileDialog } from "./file-dialog.js";

// Changes a watch can't see (a commit in a worktree writes outside it), and every
// change when the watch is refused. As Herdr's files panel.
const FALLBACK = 10000;
// After a watch wakes: a burst of writes reloads once.
const SETTLE = 100;
// Orca shows the refresh spinner only for a refresh this slow.
const SPINNER_DELAY = 200;

const LIST = "explorer-tree";
// Its own list, so a filter neither starts from the tree's scroll nor moves it.
const FILTER_LIST = "explorer-filter";
const SEARCH_LIST = "explorer-search";
// What the `results` command prints of a long list.
const REPORTED_ROWS = 200;
// A popup closing hands the keyboard back a moment after the entry took it.
const ENTRY_REFOCUS = 150;
const NO_GIT = { marks: new Map(), folders: new Map(), ignored: new Set() };

// Herdr's shipped chrome icons, there in every install; the rest are this mod's.
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;
const ui = (name) => `mods/code-explorer/ui/${name}.svg`;
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

const stop = (_e, cx) => cx.stop_propagation();

// The copies an overlay gets.
const OVERLAYS = { "file-menu": FileMenu, "file-dialog": FileDialog };

// What a folder belongs to: its repo's top in git, so a `cd` into a subfolder keeps
// the same tree, else itself. `real` is what watchFolder and symlinks are measured
// against, `pwd -P` since macOS's /tmp is a link.
async function resolveFolder(cwd) {
  const repo = await exec("git", ROOT_ARGS, { cwd }).then((r) => (r.code === 0 ? parseRepo(r.stdout) : null)).catch(() => null);
  const root = repo?.top ?? cwd;
  const real = await exec("sh", ["-c", 'cd "$1" && pwd -P', "code-explorer", root]).then((r) => (r.code === 0 ? r.stdout.replace(/\n$/, "") : null)).catch(() => null);
  return { root, real: real ?? root, repo: repo?.name ?? baseName(root) };
}

export default class CodeExplorer extends View {
  init(p, cx) {
    const given = herdr.props?.() ?? p ?? {};
    if (Object.hasOwn(OVERLAYS, given.view ?? "")) {
      this.overlayView = new OVERLAYS[given.view]();
      this.overlayView.init(given, cx);
      return;
    }
    this.overlayView = null;
    // What's known of each root visited, so going back to a space is instant.
    this.roots = new Map();
    this.folders = new Map();
    this.lastCwd = new Map();
    this.where = null;
    this.state = null;
    this.key = undefined;
    this.view = "names";
    this.menu = false;
    this.icons = null;
    this.rowsNow = [];
    this.lastClick = null;
    this.plan = null;
    this.loading = false;
    this.settling = false;
    this.stale = false;
    this.manual = false;
    this.spinning = false;
    this.opening = Promise.resolve();
    // The disk's turn, apart: a Trash stuck for exec's 30 s doesn't hold up opening files.
    this.working = Promise.resolve();
    // Which row, if any, the press now reaching the panel was on.
    this.rowPressed = false;
    this.entry = null;
    this.deleting = null;
    this.lastOp = null;
    this.copied = null;
    this.dotfiles = table(this.stored("dotfiles", {}));
    this.showIgnored = this.stored("ignored", true);
    this.search = newSearch();
    this.searchDetails = false;
    this.searchFocus = null;
    // `id` is whose answer still counts; `wait` the 300 ms, `limit` the 15 s, `tag` the
    // name of the program running; `ranKey` what the results on screen answer. The rows
    // are worked out with the results: render only reads them.
    this.found = { id: 0, wait: null, limit: null, tag: null, loading: false, results: null, error: null, ranKey: null, rows: [], collapsed: new Set(), lastClick: null };
    this.searchInput = this.newField(SEARCH.placeholder, "search", (text, cx) => this.setSearch(text, cx));
    this.searchInput.on("submit", (_e, cx) => { this.restartSearch(cx); cx.notify(); });
    this.includeInput = this.newField(SEARCH.includeHint, "include", (text, cx) => this.setPattern("include", text, cx));
    this.excludeInput = this.newField(SEARCH.excludeHint, "exclude", (text, cx) => this.setPattern("exclude", text, cx));
    this.entryInput = InputState.new({});
    this.entryInput.on("submit", (_e, cx) => { this.submitEntry(cx); cx.notify(); });
    this.filter = "";
    this.query = parseFilter("");
    this.filterCollapsed = new Set();
    this.filterRows = lastResult((index, query, collapsed, showDotfiles, showIgnored, ignored) => filteredRows({
      index, tokens: query.tokens, collapsed, ignored, showDotfiles, showIgnored,
    }));
    this.filterFocused = false;
    this.filterInput = InputState.new({ placeholder: TEXT.findFiles });
    this.filterInput.on("change", (_e, cx) => { this.setFilter(this.filterInput.value(), cx); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.filterFocused = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filterFocused = false; cx.notify(); });
    this.loadIcons(cx);
    this.listen(cx);
    cx.timer.every(FALLBACK, (cx) => { if (this.state) this.request(ALL, cx); });
  }

  stored(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  loadIcons(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/${ICON_THEME}`).catch(() => null);
      this.icons = parseIconTheme(text);
      cx.notify();
    });
  }

  // ── Commands: the same methods the clicks call (D2) ──────────────────────

  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const raw = await nextCommand();
        try {
          this.sync(cx);
          if (!this.state) await this.ready(cx);
          this.command(raw, cx);
        } catch (e) { console.log(`code-explorer: ${raw} failed: ${e}`); }
        cx.notify();
      }
    });
  }

  command(raw, cx) {
    const { name, arg } = parseCommand(raw);
    const commands = {
      open: () => this.open(arg, false, cx),
      pin: () => this.open(arg, true, cx),
      toggle: () => this.toggle(arg, cx),
      tree: () => console.log(`code-explorer: ${JSON.stringify(this.snapshot())}`),
      "collapse-all": () => this.collapseAll(),
      refresh: () => this.refresh(cx),
      more: () => this.toggleMenu(),
      dotfiles: () => this.toggleDotfiles(),
      ignored: () => this.toggleIgnored(),
      names: () => this.setView("names", cx),
      contents: () => this.setView("contents", cx),
      filter: () => this.typeFilter(arg, cx),
      "clear-filter": () => this.typeFilter("", cx),
      search: () => { this.setView("contents", cx); this.typeSearch(arg, cx); },
      "clear-search": () => this.typeSearch("", cx),
      "match-case": () => this.toggleSearch("caseSensitive", cx),
      "whole-word": () => this.toggleSearch("wholeWord", cx),
      regex: () => this.toggleSearch("useRegex", cx),
      "search-details": () => this.toggleDetails(),
      include: () => this.typePattern("include", arg, cx),
      exclude: () => this.typePattern("exclude", arg, cx),
      "open-result": () => this.openResult(arg.trim() ? Number(arg) : null, cx),
      "toggle-result": () => this.toggleResultFile(arg),
      results: () => console.log(`code-explorer: ${JSON.stringify(this.searchSnapshot())}`),
      menu: () => this.openMenu(arg),
      // A menu's own, read by its copy: nothing to do in this one.
      "menu-pick": () => {},
      "new-file": () => this.startEntry("file", arg, cx),
      "new-folder": () => this.startEntry("folder", arg, cx),
      rename: () => this.startEntry("rename", arg, cx),
      entry: () => this.typeEntry(arg),
      "entry-submit": () => this.submitEntry(cx),
      "entry-cancel": () => this.cancelEntry(),
      duplicate: () => this.duplicate(arg, cx),
      delete: () => this.askDelete(arg, cx),
      "delete-confirm": () => this.confirmDelete(cx),
      "delete-permanent": () => this.deletePermanently(cx),
      "delete-cancel": () => this.cancelDelete(),
      "delete-closed": () => this.deleteClosed(arg),
      "copy-path": () => this.copy("path", arg),
      "copy-relative-path": () => this.copy("relative", arg),
      reveal: () => this.reveal(arg, cx),
      "open-in-terminal": () => this.openInTerminal(arg),
      "collapse-folder": () => this.collapseFolder(arg),
      "find-in-folder": () => this.findInFolder(arg, cx),
      ops: () => console.log(`code-explorer: ops ${JSON.stringify(this.opsSnapshot())}`),
    };
    if (Object.hasOwn(commands, name)) commands[name]();
    else console.log(`code-explorer: no command "${raw}"`);
  }

  // The state the `tree` command prints, to test what a click would have done.
  snapshot() {
    const state = this.state, list = state?.list, rows = this.rows();
    return {
      where: this.where, root: state?.root ?? null, repo: state?.repo ?? null, git: state?.git ?? null, view: this.view, menu: this.menu,
      showDotfiles: this.showDotfilesNow(), showIgnored: this.showIgnored, filter: this.filter, error: state?.error ?? null,
      filtering: this.filtering(), filterCollapsed: [...this.filterCollapsed],
      listed: list ? { loaded: list.loaded, error: list.error, limited: list.limited } : null,
      expanded: state ? [...state.expanded] : [], rows: this.filtering() ? rows.map((row) => dressRow(row, state.marks, this.icons)) : rows, docs: table(shared(DOCS_KEY)),
    };
  }

  // What the `results` command prints, to test what a click would have done.
  searchSnapshot() {
    const found = this.found, results = found.results;
    return {
      view: this.view, root: this.state?.root ?? null, ...this.search, details: this.searchDetails, loading: found.loading, error: found.error,
      summary: found.error ? null : searchSummary(results), message: searchMessage({ query: this.search.query, results, loading: found.loading, error: found.error })?.text ?? null,
      total: results?.total ?? null, files: results?.files.length ?? null, truncated: results?.truncated ?? null,
      rows: found.rows.slice(0, REPORTED_ROWS).map((row) => (row.kind === "file"
        ? { file: row.path, count: row.count, collapsed: row.collapsed }
        : { n: row.match.n, path: row.path, line: row.match.line, ...matchParts(row.match) })),
    };
  }

  // What the `ops` command prints, to test what a click would have done.
  opsSnapshot() {
    const entry = this.entry, deleting = this.deleting;
    return {
      entry: entry ? { kind: entry.kind, rel: entry.rel, folder: entry.folder, busy: entry.busy, text: this.entryInput.value() } : null,
      deleting: deleting ? { ...this.publicDelete(), open: deleting.open } : null,
      last: this.lastOp,
      copied: this.copied,
    };
  }

  // ── Which root ───────────────────────────────────────────────────────────

  // sync runs in render, and a covered window or a locked screen draws nothing, so a
  // command can be the first thing to need the root.
  async ready(cx) {
    const cwd = this.where?.cwd;
    if (!cwd || this.where.machine) return;
    const found = this.folders.get(cwd) ?? await resolveFolder(cwd);
    this.folders.set(cwd, found);
    if (this.where?.cwd === cwd) this.enter(found, cx);
  }

  sync(cx) {
    const all = spaces(), active = all.find((s) => s.active);
    const where = locate({ spaces: all, focused: focused(), panes: panes(), remembered: this.lastCwd.get(active?.id) });
    if (where?.live) this.lastCwd.set(where.space, where.live);
    const key = JSON.stringify([where?.space, where?.machine, where?.cwd]);
    if (key === this.key) return;
    const sameSpace = this.where?.space === where?.space;
    this.key = key;
    this.where = where;
    // D21: writeTextFile and watchFolder are local only, and nothing here may
    // touch a local path by mistake.
    if (!where?.cwd || where.machine) { this.state = null; this.entry = null; return; }
    const known = this.folders.get(where.cwd);
    if (known) { this.enter(known, cx); return; }
    if (!sameSpace) this.state = null;
    cx.spawn(async (cx) => {
      const found = await resolveFolder(where.cwd);
      this.folders.set(where.cwd, found);
      if (this.key === key) this.enter(found, cx);
      cx.notify();
    });
  }

  enter(found, cx) {
    let state = this.roots.get(found.root);
    if (!state) {
      state = {
        ...found, git: false, entries: new Map(), expanded: new Set(), errors: new Map(), limited: new Set(),
        marks: NO_GIT, loaded: false, error: null, watching: false, list: null,
      };
      this.roots.set(found.root, state);
    }
    if (this.state === state) return;
    this.state = state;
    this.plan = null;
    this.entry = null;
    // A filter's text goes along to the new root; what it read or collapsed in the old
    // one doesn't, and neither does what it left here. ALL below reads the list.
    state.list = null;
    this.filterCollapsed = new Set();
    // The search's text goes along too, and searches there.
    this.dropResults();
    // sync runs in render: the tree swaps now, and timers start from a task.
    cx.spawn(async (cx) => {
      this.request(ALL, cx);
      this.watch(state, cx);
      this.restartSearch(cx);
      cx.notify();
    });
  }

  // ── Keeping up with the disk ─────────────────────────────────────────────

  watch(state, cx) {
    // The timer covers what it doesn't watch.
    if (state.watching || holdsHome(state.root, home()) || holdsHome(state.real, home())) return;
    state.watching = true;
    cx.spawn(async (cx) => {
      try {
        while (this.state === state) {
          const paths = await watchFolder(state.root);
          if (this.state === state) this.request(batchPlan(paths, state.real, new Set(state.entries.keys())), cx);
        }
      } catch { /* Refused (too big a tree on Linux): the timer keeps it fresh. */ }
      finally { state.watching = false; }
    });
  }

  // A hidden copy stays alive: it loads when it shows again.
  request(plan, cx) {
    if (!isShown(layout())) { this.stale = true; return; }
    this.plan = mergePlans(this.plan, plan);
    if (this.loading || this.settling) return;
    this.settling = true;
    cx.timer.after(SETTLE, (cx) => { this.settling = false; this.drain(cx); });
  }

  // One load at a time; what arrives during one waits and goes next, merged.
  drain(cx) {
    if (this.loading || !this.plan || !this.state) return;
    const plan = this.plan, state = this.state;
    this.plan = null;
    if (!plan.all && !plan.folders.length && !plan.git) return;
    if (plan.all || plan.git) this.readList(cx);
    this.loading = true;
    cx.spawn(async (cx) => {
      try { await this.load(plan, state); }
      catch (e) { console.log(`code-explorer: load failed: ${e}`); }
      finally {
        this.loading = false;
        if (!this.plan) { this.manual = false; this.spinning = false; }
        else this.drain(cx);
        cx.notify();
      }
    });
  }

  async load(plan, state) {
    for (const folder of plan.all ? ["", ...state.expanded] : plan.folders) {
      if (this.state !== state) return;
      await this.readFolder(state, folder);
    }
    if (this.state === state && (plan.all || plan.git)) await this.readGit(state);
    this.prepareRows();
  }

  async readFolder(state, folder) {
    try {
      const r = await exec("sh", ["-c", LIST_SCRIPT, "code-explorer", folder ? `${state.root}/${folder}` : state.root]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot list this folder");
      state.entries.set(folder, parseListing(r.stdout, state.real));
      if (listingLimited(r.stdout)) state.limited.add(folder);
      else state.limited.delete(folder);
      state.errors.delete(folder);
      if (!folder) { state.loaded = true; state.error = null; }
      const { expanded, gone } = pruneExpanded(state.expanded, state.entries);
      state.expanded = expanded;
      for (const path of gone) { state.entries.delete(path); state.errors.delete(path); state.limited.delete(path); }
    } catch (e) {
      const message = String(e?.message ?? e);
      if (folder) state.errors.set(folder, message);
      else { state.loaded = true; state.error = message; }
    }
  }

  // Marks only when the root is the repo's top: status names paths from there.
  async readGit(state) {
    const cwd = state.root;
    const repo = await exec("git", ROOT_ARGS, { cwd }).then((r) => (r.code === 0 ? parseRepo(r.stdout) : null)).catch(() => null);
    if (!repo || (repo.top !== state.real && repo.top !== state.root)) { state.git = false; state.marks = NO_GIT; return; }
    state.git = true;
    state.repo = repo.name;
    // A failed read keeps the marks on screen; the next one fixes them.
    const status = await exec("git", STATUS_ARGS, { cwd }).catch(() => null);
    const ignored = await exec("git", IGNORED_ARGS, { cwd }).catch(() => null);
    const marks = status?.code === 0 ? parseStatus(status.stdout) : state.marks.marks;
    state.marks = {
      marks,
      folders: status?.code === 0 ? buildFolderStatus(marks) : state.marks.folders,
      ignored: ignored?.code === 0 ? parseIgnored(ignored.stdout) : state.marks.ignored,
    };
  }

  // ── The list the filter searches ─────────────────────────────────────────

  // Only while there's a filter, and on its own: a slow tree read doesn't hold up the
  // first results. One read at a time per list; a change during one reads again.
  readList(cx) {
    const state = this.state;
    if (!this.filtering() || this.query.tooLarge) return;
    state.list ??= { lists: null, index: null, limited: false, loaded: false, error: null, reading: false, again: false };
    const list = state.list;
    if (list.reading) { list.again = true; return; }
    list.reading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          list.again = false;
          await this.loadList(state.root, list, cx);
        } while (list.again && state.list === list);
      } finally {
        list.reading = false;
        cx.notify();
      }
    });
  }

  async loadList(root, list, cx) {
    try {
      const lists = await readFileList(root, exec);
      // The timer's read finds the same list nearly every time, and sorting is the slow part.
      if (!sameLists(lists, list.lists)) {
        const breathe = pacer(() => new Promise((resolve) => { cx.timer.after(1, () => resolve()); }));
        const { files, limited } = await parseLists(lists, breathe);
        list.index = await buildNameIndex(files, breathe);
        list.limited = limited;
        list.lists = lists;
      }
      list.error = null;
    } catch (e) {
      // As the marks: a failed read keeps what's on screen, and the next one fixes it.
      list.error = list.index ? null : String(e?.message ?? e);
    }
    list.loaded = true;
    this.prepareRows();
    cx.notify();
  }

  // ── What the clicks do ───────────────────────────────────────────────────

  clickRow(path, cx) {
    const row = this.rowsNow.find((r) => r.path === path);
    if (!row) return;
    if (row.dir) { if (row.enterable) this.toggle(path, cx); return; }
    const double = isDoubleClick(this.lastClick, path, Date.now());
    this.lastClick = double ? null : { path, at: Date.now() };
    this.open(path, double, cx);
  }

  toggle(path, cx) {
    const state = this.state;
    // D23: only a row that can be entered, so a command can't walk out of the root
    // through a symlink any more than a click can.
    if (!state || !this.rows().find((r) => r.path === path)?.enterable) return;
    // Under a filter every folder is open but these, and the tree's own stay as they are.
    if (this.filtering()) {
      this.filterCollapsed = toggleExpanded(this.filterCollapsed, path);
      this.prepareRows();
      return;
    }
    state.expanded = toggleExpanded(state.expanded, path);
    if (!state.expanded.has(path)) return;
    // Lazy: read when opened. What's cached shows at once, and this brings it up to date.
    this.plan = mergePlans(this.plan, { all: false, folders: [path], git: false });
    this.drain(cx);
  }

  // One at a time, in click order: a double click's second click must find the tab
  // its first one made.
  open(path, pin, cx, line = null) {
    const state = this.state, space = this.where?.space;
    if (!state || !space || !path || this.rows().find((r) => r.path === path)?.dir) return;
    const file = `${state.root}/${path}`;
    this.inTurn("opening", cx, (cx) => openFile({ file, pin, space, line }, this.tabIo(cx)));
  }

  // One at a time in each lane, in the order asked.
  inTurn(lane, cx, work) {
    cx.spawn(async (cx) => {
      const turn = this[lane];
      let done;
      this[lane] = new Promise((resolve) => { done = resolve; });
      await turn;
      try { await work(cx); }
      catch (e) { console.log(`code-explorer: ${lane} failed: ${e}`); }
      finally { done(); cx.notify(); }
    });
  }

  tabIo(cx) {
    return {
      spaces, panes, shared, setShared, run, notify, newDoc,
      wait: (ms) => new Promise((resolve) => { cx.timer.after(ms, () => resolve()); }),
    };
  }

  // What ops-model.js runs against.
  opIo(cx) {
    return { ...this.tabIo(cx), exec, appHome, writeTextFile: herdr.writeTextFile, readdir: (dir) => fs.readdir(dir) };
  }

  canCollapse() {
    return this.view === "names" && !this.query.active && Boolean(this.state?.expanded.size);
  }

  collapseAll() {
    if (this.canCollapse()) this.state.expanded = new Set();
  }

  canRefresh() {
    return this.view === "names" && Boolean(this.state);
  }

  refresh(cx) {
    if (!this.canRefresh()) return;
    this.manual = true;
    cx.timer.after(SPINNER_DELAY, (cx) => { if (this.manual) { this.spinning = true; cx.notify(); } });
    this.plan = mergePlans(this.plan, ALL);
    this.drain(cx);
  }

  setView(view, cx) {
    const from = this.view;
    this.view = view;
    this.menu = false;
    if (view !== "names") this.entry = null;
    // As in Orca: the text stays, and what was collapsed under it goes.
    if (view === "names") this.readList(cx);
    else this.filterCollapsed = new Set();
    if (view === from) return;
    // Leaving Contents stops its search, as in Orca. Back, what's typed gets its answer
    // unless the one on screen is it.
    if (view === "names") this.stopSearch(cx);
    else if (this.found.ranKey !== searchKey(this.state?.root ?? null, this.search)) this.restartSearch(cx);
  }

  // ── File operations (S13, D21, D23) ──────────────────────────────────────

  // What's said of the last one, in the log's terms, and to the person if it failed.
  report(op, result, { quiet = false } = {}) {
    this.lastOp = { op, status: result.status, error: result.error ?? null, rel: result.rel ?? null };
    if (result.error && !quiet) notify({ title: result.error, level: "error" });
  }

  // Every folder is read again, its open ones included: a rename can touch any of them.
  reload(cx) {
    this.plan = mergePlans(this.plan, ALL);
    this.drain(cx);
  }

  isFolder(rel) {
    if (!rel) return true;
    const row = this.rows().find((r) => r.path === rel);
    if (row) return row.dir;
    const cut = rel.lastIndexOf("/");
    const listed = this.state?.entries.get(cut === -1 ? "" : rel.slice(0, cut))?.find((e) => e.name === rel.slice(cut + 1));
    // Past what's been read: a file here fails at the write, with nothing changed.
    return listed ? listed.dir : true;
  }

  openMenu(rel) {
    const state = this.state;
    if (!state) return;
    const row = rel ? this.rows().find((r) => r.path === rel) : null;
    if (rel && !row) return;
    openFileMenu({ root: state.root, rel, dir: rel ? row.dir : true, open: Boolean(row?.open), filtering: this.filtering() });
  }

  // A right click reaches the row first and then what's around the list, so what's
  // around it opens the menu of the empty space only if no row took the press.
  pressRow(path) {
    this.rowPressed = true;
    this.openMenu(path);
  }

  pressArea() {
    if (!this.rowPressed) this.openMenu("");
    this.rowPressed = false;
  }

  // The entry: the same for New File, New Folder and Rename. A command's `<rel>//<name>`
  // is the text and Enter too (D2).
  startEntry(kind, arg, cx) {
    const state = this.state;
    if (!state || this.entry?.busy) return;
    const { rel, name } = splitTarget(arg);
    if (kind === "rename" && !rel) return;
    if (this.view !== "names") this.setView("names", cx);
    const folder = kind === "rename" ? rel.slice(0, Math.max(rel.lastIndexOf("/"), 0)) : targetFolder(rel, this.isFolder(rel));
    this.entry = { kind, rel, folder, busy: false, state };
    if (kind !== "rename" && this.rows().find((r) => r.path === folder)?.enterable && !state.expanded.has(folder) && !this.filtering()) this.toggle(folder, cx);
    const text = kind === "rename" ? baseName(rel) : "";
    this.entryInput.set_value(text);
    this.focusEntry(text, cx);
    if (name !== null) {
      this.typeEntry(name);
      this.submitEntry(cx);
    }
  }

  focusEntry(text, cx) {
    const take = () => {
      this.entryInput.focus();
      if (text) this.entryInput.set_selected_range(renameSelection(text));
    };
    take();
    cx.timer.after(ENTRY_REFOCUS, () => { if (this.entry && this.entryInput.value() === text) take(); });
  }

  typeEntry(text) {
    if (this.entry) this.entryInput.set_value(text);
  }

  cancelEntry() {
    if (!this.entry?.busy) this.entry = null;
  }

  entryKey(event, cx) {
    if (event.key !== "escape") return;
    cx.stop_propagation();
    this.cancelEntry();
    cx.notify();
  }

  // A failure keeps the entry and its text, to fix.
  submitEntry(cx) {
    const entry = this.entry;
    if (!entry || entry.busy) return;
    const raw = this.entryInput.value(), { state } = entry, where = { root: state.root, real: state.real };
    entry.busy = true;
    this.inTurn("working", cx, async (cx) => {
      const io = this.opIo(cx);
      const result = entry.kind === "rename"
        ? await renamePath({ ...where, rel: entry.rel, raw }, io)
        : await createPath({ ...where, folder: entry.folder, raw, kind: entry.kind }, io);
      entry.busy = false;
      this.report(entry.kind, result);
      if (result.status === "error") return;
      if (this.entry === entry) this.entry = null;
      if (result.status === "cancel") return;
      if (entry.kind === "rename") {
        state.expanded = movedFolders(state.expanded, entry.rel, result.rel);
        if (result.tabs.length) this.inTurn("opening", cx, (cx) => reopenTabs({ tabs: result.tabs, to: result.abs }, this.opIo(cx)));
      }
      // As in Orca: a new file opens for good; a new folder doesn't open.
      if (entry.kind === "file" && this.state === state) this.open(result.rel, true, cx);
      if (this.state === state) this.reload(cx);
    });
  }

  duplicate(rel, cx) {
    const state = this.state;
    if (!state) return;
    this.inTurn("working", cx, async (cx) => {
      const result = await duplicateFile({ root: state.root, real: state.real, rel }, this.opIo(cx));
      this.report("duplicate", result);
      if (result.status === "ok" && this.state === state) this.reload(cx);
    });
  }

  // What the dialog draws, in code-editor.op. D23: the run is here, never in the dialog.
  publicDelete() {
    const { rel, name, folder, step, busy, error } = this.deleting;
    return { rel, name, folder, step, busy, error };
  }

  publishDelete() {
    setShared(OP_KEY, this.deleting ? this.publicDelete() : null);
  }

  // The question, once nothing stops it: unsaved changes never get as far as a dialog.
  askDelete(rel, cx) {
    const state = this.state;
    if (!state || this.deleting?.busy) return;
    const folder = this.isFolder(rel);
    this.inTurn("working", cx, async (cx) => {
      const cleared = await clearPath({ root: state.root, real: state.real, rel }, this.opIo(cx));
      if (cleared.error) { this.report("delete", { status: "error", error: cleared.error }); return; }
      this.cancelDelete();
      if (this.deleting) return;
      this.deleting = { root: state.root, real: state.real, state, rel, name: cleared.name, folder, step: "confirm", busy: false, error: null, open: true, overlay: null };
      this.publishDelete();
      this.deleting.overlay = openFileDialog();
    });
  }

  confirmDelete(cx) {
    if (this.deleting?.step === "confirm") this.runDelete(trashPath, cx);
  }

  // D23: only once the Trash said no, which is what makes this step exist.
  deletePermanently(cx) {
    if (this.deleting?.step === "offer") this.runDelete(deleteForever, cx);
  }

  runDelete(action, cx) {
    const del = this.deleting;
    if (del.busy) return;
    del.busy = true;
    del.error = null;
    this.publishDelete();
    this.inTurn("working", cx, async (cx) => {
      const io = this.opIo(cx), result = await action({ root: del.root, real: del.real, rel: del.rel }, io);
      del.busy = false;
      // With the dialog open, or with an offer no one would see, it's not a toast of its own.
      this.report("delete", result, { quiet: del.open || result.status === "offer" });
      if (result.status === "ok") {
        closeTabs(result.tabs, io);
        if (this.state === del.state) this.reload(cx);
      } else if (del.open) {
        if (result.status === "offer") del.step = "offer";
        else del.error = result.error;
        this.publishDelete();
        return;
      } else if (result.status === "offer") {
        // Esc took the dialog away during the run: no offer to no one.
        notify({ title: `Failed to move '${del.name}' to the Trash.`, level: "error" });
      }
      this.endDelete();
    });
  }

  endDelete() {
    const del = this.deleting;
    this.deleting = null;
    if (del?.open) herdr.closeOverlay(del.overlay);
    this.publishDelete();
  }

  cancelDelete() {
    if (this.deleting && !this.deleting.busy) this.endDelete();
  }

  // The dialog went, by whatever way. A run still going ends in a toast.
  deleteClosed(overlay) {
    const del = this.deleting;
    if (!del || (overlay && del.overlay !== overlay)) return;
    del.open = false;
    if (!del.busy) this.endDelete();
  }

  // D2: a click copies in the menu's copy. This reports instead of writing, because a
  // test window's clipboard is the person's.
  copy(kind, rel) {
    const state = this.state;
    if (!state || !rel) return;
    this.copied = { kind, text: copyText(kind, state.root, rel) };
  }

  // Nothing here changes a file, so the root is fine, and only the path's shape is asked.
  reveal(rel, cx) {
    const state = this.state;
    if (!state || (rel && relProblem(rel))) return;
    const abs = rel ? `${state.root}/${rel}` : state.root;
    cx.spawn(async () => {
      const r = await exec("/usr/bin/open", ["-R", abs]).catch(() => null);
      if (r?.code !== 0) notify({ title: `Couldn't reveal ${baseName(abs)}`, level: "error" });
    });
  }

  openInTerminal(rel) {
    const state = this.state;
    if (!state || (rel && relProblem(rel)) || !this.isFolder(rel)) return;
    run("tab.new", { space: this.where.space, folder: rel ? `${state.root}/${rel}` : state.root });
  }

  collapseFolder(rel) {
    if (this.state) this.state.expanded = withoutFolder(this.state.expanded, rel);
  }

  findInFolder(rel, cx) {
    if (!this.state) return;
    this.setView("contents", cx);
    this.typePattern("include", folderPattern(rel), cx);
  }

  // ── The filter ───────────────────────────────────────────────────────────

  filtering() {
    return this.view === "names" && Boolean(this.state) && this.query.active;
  }

  // What typing does. Only for the first word does it read the list: the rest narrow
  // what's read already. A filter starting over never shows what an earlier one left.
  setFilter(text, cx) {
    if (text === this.filter) return;
    const was = this.query.active;
    this.filter = text;
    this.query = parseFilter(text);
    if (!this.query.active) this.filterCollapsed = new Set();
    if (this.state && !(was && this.query.active)) this.state.list = null;
    if (!this.state?.list) this.readList(cx);
    this.prepareRows();
  }

  // Herdr interrupts a render past some 50 ms (measured), and a keystroke's walk comes
  // near it in a big repo on a busy machine. So what changes the filter's rows works
  // them out first, and render finds them ready.
  prepareRows() {
    if (this.filtering()) this.rows();
  }

  // What the X and the filter commands do: the input shows it too.
  typeFilter(text, cx) {
    this.filterInput.set_value(text);
    this.setFilter(text, cx);
  }

  toggleMenu() {
    if (this.state) this.menu = !this.menu;
  }

  // Per root and on by default, as in Orca; Show Git Ignored Files is for all of them.
  showDotfilesNow() {
    const root = this.state?.root;
    return !root || !Object.hasOwn(this.dotfiles, root) || this.dotfiles[root] !== false;
  }

  toggleDotfiles() {
    const root = this.state?.root;
    if (!root) return;
    if (this.showDotfilesNow()) this.dotfiles[root] = false;
    else delete this.dotfiles[root];
    localStorage.setItem("dotfiles", JSON.stringify(this.dotfiles));
    this.menu = false;
    this.prepareRows();
  }

  toggleIgnored() {
    this.showIgnored = !this.showIgnored;
    localStorage.setItem("ignored", JSON.stringify(this.showIgnored));
    this.menu = false;
    this.prepareRows();
  }

  // ── The search ───────────────────────────────────────────────────────────

  newField(placeholder, name, change) {
    const input = InputState.new({ placeholder });
    input.on("change", (_e, cx) => { change(input.value(), cx); cx.notify(); });
    input.on("focus", (_e, cx) => { this.searchFocus = name; cx.notify(); });
    input.on("blur", (_e, cx) => { if (this.searchFocus === name) this.searchFocus = null; cx.notify(); });
    return input;
  }

  // What typing does. All of these start over.
  setSearch(text, cx) {
    if (text === this.search.query) return;
    this.search.query = text;
    this.restartSearch(cx);
  }

  setPattern(field, text, cx) {
    if (text === this.search[field]) return;
    this.search[field] = text;
    this.restartSearch(cx);
  }

  // What the X and the commands do: the inputs show it too.
  typeSearch(text, cx) {
    this.searchInput.set_value(text);
    this.setSearch(text, cx);
  }

  typePattern(field, text, cx) {
    this.searchDetails = true;
    (field === "include" ? this.includeInput : this.excludeInput).set_value(text);
    this.setPattern(field, text, cx);
  }

  toggleSearch(option, cx) {
    this.search[option] = !this.search[option];
    this.restartSearch(cx);
  }

  toggleDetails() {
    this.searchDetails = !this.searchDetails;
  }

  // Herdr has no way to blur an input from here, so it clears and keeps the keyboard.
  searchKeyDown(event, cx) {
    if (event.key !== "escape" || !this.search.query) return;
    cx.stop_propagation();
    this.typeSearch("", cx);
    cx.notify();
  }

  // The one way a search starts: 300 ms from the last change. What was waiting or
  // running stops, and its answer is dropped: the results on screen stay until the
  // new ones come. Off Contents, or with no root yet, setView and enter pick it up.
  restartSearch(cx) {
    this.stopSearch(cx);
    const found = this.found;
    found.error = null;
    if (isBlank(this.search) || overLimit(this.search)) {
      this.showResults(isBlank(this.search) ? null : noResults(), null);
      return;
    }
    if (this.view !== "contents" || !this.state) return;
    const id = found.id;
    found.loading = true;
    found.wait = cx.timer.after(DEBOUNCE, (cx) => {
      found.wait = null;
      this.runSearch(id, cx);
    });
  }

  stopSearch(cx) {
    const found = this.found;
    found.id++;
    found.loading = false;
    found.wait?.cancel();
    found.limit?.cancel();
    found.wait = null;
    found.limit = null;
    if (found.tag) this.killSearch(found.tag, cx);
    found.tag = null;
  }

  // exec has no cancel. Without pkill the program ends at exec's own 30 s, unheard.
  killSearch(tag, cx) {
    const [command, args] = killArgs(tag);
    cx.spawn(async () => { await exec(command, args).catch(() => null); });
  }

  runSearch(id, cx) {
    const found = this.found, state = this.state, options = { ...this.search };
    if (id !== found.id || !state) return;
    const live = () => id === found.id, tag = newTag();
    let overtime = false;
    found.tag = tag;
    // As in Orca: what it found by then is the answer, and says it's short.
    found.limit = cx.timer.after(SEARCH_LIMIT, (cx) => {
      overtime = true;
      found.limit = null;
      this.killSearch(tag, cx);
    });
    cx.spawn(async (cx) => {
      let results = null, error = null;
      try {
        const output = await readSearch({ root: state.root, options, tag, live }, exec);
        if (!live() || !output) return;
        error = searchError(output);
        if (!error) {
          results = await parseResults(output, options, pacer(() => new Promise((resolve) => { cx.timer.after(1, () => resolve()); })));
          if (overtime) results.truncated = true;
        }
      } catch (e) {
        console.log(`code-explorer: search failed: ${e}`);
        error = SEARCH.failed;
      }
      if (!live()) return;
      found.limit?.cancel();
      found.limit = null;
      found.tag = null;
      found.loading = false;
      this.showResults(results, error);
      cx.notify();
    });
  }

  showResults(results, error) {
    const found = this.found;
    found.results = results;
    found.error = error;
    found.ranKey = searchKey(this.state?.root ?? null, this.search);
    found.rows = searchRows(results, found.collapsed);
  }

  // Another root's: nothing of it shows here, and what's running answers no one.
  dropResults() {
    const found = this.found;
    found.id++;
    found.loading = false;
    found.results = null;
    found.error = null;
    found.ranKey = null;
    found.rows = [];
    found.collapsed = new Set();
  }

  toggleResultFile(path) {
    const found = this.found;
    found.collapsed = toggleExpanded(found.collapsed, path);
    found.rows = searchRows(found.results, found.collapsed);
  }

  // D11, D16: a result opens at its line, pinned. Its second press isn't another open.
  clickResult(key, cx) {
    if (key.startsWith("file:")) { this.toggleResultFile(key.slice("file:".length)); return; }
    const found = this.found, double = isDoubleClick(found.lastClick, key, Date.now());
    found.lastClick = double ? null : { path: key, at: Date.now() };
    if (!double) this.openResult(Number(key.slice("match:".length)), cx);
  }

  openResult(n, cx) {
    const hit = matchAt(this.found.results, n);
    if (hit) this.open(hit.path, true, cx, hit.line);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  rows() {
    const state = this.state;
    if (!state) return [];
    if (this.filtering()) {
      if (this.query.tooLarge || !state.list?.index) return [];
      return this.filterRows(state.list.index, this.query, this.filterCollapsed, this.showDotfilesNow(), this.showIgnored, this.showIgnored ? null : state.marks.ignored);
    }
    return visibleRows({
      entries: state.entries, expanded: state.expanded, git: state.marks, icons: this.icons,
      showDotfiles: this.showDotfilesNow(), showIgnored: this.showIgnored, errors: state.errors,
    });
  }

  // The file of the shown tab, highlighted in the tree as Orca does.
  activeFile() {
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    const docs = table(shared(DOCS_KEY));
    return tab && Object.hasOwn(docs, tab.id) ? docs[tab.id]?.file ?? null : null;
  }

  iconButton(t, id, label, icon, enabled, action) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .tooltip(label).accessibility_label(label)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { action(cx); cx.notify(); }))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(icon);
  }

  header(t) {
    const refresh = svg(ui("refresh")).size(14);
    return h_flex().h(42).flex_none().pl(14).pr(8).gap(2).items_center()
      .child(div().id("explorer-title").flex_1().min_w(0).truncate().font_semibold()
        .when(Boolean(this.state), (el) => el.tooltip(this.state.root))
        .child(this.state?.repo ?? this.where?.name ?? ""))
      .child(this.iconButton(t, "explorer-collapse", TEXT.collapseAll, svg(ui("collapse-all")).size(14), this.canCollapse(), () => this.collapseAll()))
      .child(this.iconButton(t, "explorer-refresh", TEXT.refresh, this.spinning ? refresh.spin(900) : refresh, this.canRefresh(), (cx) => this.refresh(cx)))
      .child(this.iconButton(t, "explorer-more", TEXT.more, svg(ui("more")).size(14), Boolean(this.state), () => this.toggleMenu()));
  }

  segments(t) {
    const segment = (view, label) => {
      const on = this.view === view;
      return div().id(`explorer-${view}`).flex_1().h(28).flex().items_center().justify_center().rounded(6).font_medium().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.setView(view, cx); cx.notify(); })
        .child(label);
    };
    return h_flex().flex_none().mx(10).mb(8).p(2).gap(2).rounded(8).bg(t.canvas)
      .child(segment("names", TEXT.names))
      .child(segment("contents", TEXT.contents));
  }

  message(t, text) {
    return div().p(12).text_center().text_color(t.dim).child(text);
  }

  filterBar(t) {
    const loading = this.filtering() && !this.query.tooLarge && !this.state.list?.loaded;
    return h_flex().h(32).flex_none().mx(10).mb(8).px(8).gap(8).items_center().rounded(7).border_1().border_color(this.filterFocused ? t.accent : t.input)
      .text_color(t.muted)
      .child(svg(ui("filter")).size(14).flex_none())
      .child(Input.new(this.filterInput).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
      .when(loading, (el) => el.child(div().id("explorer-filter-loading").flex_none().child(svg(chrome("spinner")).size(12).spin(900))))
      .when(Boolean(this.filter), (el) => el.child(div().id("explorer-clear-filter").size(20).flex_none().flex().items_center().justify_center().cursor_pointer()
        .tooltip(TEXT.clearFilter).accessibility_label(TEXT.clearFilter)
        .on_click((_e, cx) => { this.typeFilter("", cx); cx.notify(); })
        .child(svg(chrome("x")).size(12))));
  }

  // Called from the list's layout, on later frames too: it reads only what it's given.
  row(t, row, root, activeFile) {
    const color = row.status ? GIT_COLORS[row.status] : row.ignored || (row.dir && !row.enterable) ? t.dim : t.foreground;
    const selected = !row.dir && `${root}/${row.path}` === activeFile;
    return div().w_full().h(ROW_HEIGHT).flex_none().px(4)
      .child(h_flex().size_full().pl(indentOf(row.depth)).pr(8).gap(6).items_center().rounded(5)
        .when(!row.dir || row.enterable, (r) => r.cursor_pointer())
        .when(selected, (r) => r.bg(t.selected))
        .hover((s) => s.bg(selected ? t.selected : t.hover))
        .child(row.enterable ? svg(chrome(row.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(row.icon).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(color).when(row.ignored, (n) => n.italic()).child(row.name))
        .when(Boolean(row.error), (r) => r.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.ansi1).child(row.error)))
        .when(Boolean(row.status), (r) => r.child(div().flex_none().text_size(11).font_semibold().text_color(color).child(row.status)))
        .when(row.ignored, (r) => r.child(div().flex_none().accessibility_label(TEXT.ignored).child(svg(ui("ignored")).size(12).text_color(t.dim)))));
  }

  names(t) {
    const state = this.state;
    const rows = this.rowsNow;
    const filtering = this.filtering(), list = state?.list;
    const failed = filtering ? list?.error : state?.error;
    const text = filtering
      ? filterMessage({ tooLarge: this.query.tooLarge, loaded: Boolean(list?.loaded), error: failed, rows: rows.length })
      : treeMessage({ hasFolder: Boolean(this.where?.cwd), remote: Boolean(this.where?.machine), loaded: Boolean(state?.loaded), error: failed, rows: rows.length });
    const area = v_flex().id("explorer-tree-area").flex_1().min_h(0)
      .when(Boolean(state), (el) => el.on_mouse_down("right", (_e, cx) => { this.pressArea(); cx.notify(); }));
    if (text) {
      return area.child(this.message(t, text))
        .when(Boolean(failed), (el) => el.child(div().flex().justify_center().child(div().id("explorer-retry").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.refresh(cx); cx.notify(); }).child(TEXT.retry))));
    }
    if (!rows.length) return area.child(div().flex().justify_center().p(12).child(svg(chrome("spinner")).size(14).text_color(t.dim).spin(900)));
    const activeFile = this.activeFile(), root = state.root, git = state.marks, icons = this.icons;
    const id = filtering ? FILTER_LIST : LIST;
    const note = filtering
      ? list.limited && `Searching the first ${LIST_CAP} files`
      : state.limited.size > 0 && `A folder shows its first ${LIST_LIMIT} entries`;
    return area
      .when(Boolean(note), (el) => el.child(div().flex_none().px(14).pb(6).text_size(11).text_color(t.dim).child(note)))
      .child(div().flex_1().min_h(0).relative().pb(8)
        .child(v_virtual_list(id, rows.length, ROW_HEIGHT, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map((row) => this.row(t, filtering ? dressRow(row, git, icons) : row, root, activeFile)))
          .on_item_click((path, cx) => { this.clickRow(path, cx); cx.notify(); })
          .on_item_secondary_click((path, _e, cx) => { this.pressRow(path); cx.notify(); })
          .size_full())
        .child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  // Above the list and not in it: a row's renderer can't hold a handler or take the
  // keyboard's Esc, and the rows scroll under it. Orca's 26 px.
  entryBar(t) {
    const entry = this.entry;
    const icon = entry.kind === "folder" ? folderIcon(this.icons, "", false) : fileIcon(this.icons, entry.kind === "rename" ? baseName(entry.rel) : "");
    return v_flex().flex_none().mx(10).mb(8).gap(3)
      .child(div().px(2).text_size(11).text_color(t.dim).truncate().child(entryTitle(entry)))
      .child(h_flex().id("explorer-entry").h(26).px(6).gap(6).items_center().rounded(5).border_1().border_color(t.accent)
        .on_key_down((event, cx) => this.entryKey(event, cx))
        .child(image(icon).size(16).flex_none())
        .child(Input.new(this.entryInput).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground).accessibility_label(entryTitle(entry)))
        .child(div().id("explorer-entry-cancel").size(18).flex_none().flex().items_center().justify_center().cursor_pointer().text_color(t.muted)
          .tooltip(OPS.cancel).accessibility_label(OPS.cancel)
          .on_click((_e, cx) => { this.cancelEntry(); cx.notify(); })
          .child(svg(chrome("x")).size(12))));
  }

  contents(t) {
    const hasFolder = Boolean(this.where?.cwd), remote = Boolean(this.where?.machine);
    const area = v_flex().flex_1().min_h(0);
    if (remote || !hasFolder) return area.child(this.message(t, contentsMessage({ hasFolder, remote })));
    return area.child(this.searchBar(t)).child(this.searchFilters(t)).child(this.searchResults(t));
  }

  searchToggle(t, id, label, icon, on, action) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .tooltip(label).accessibility_label(label)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(svg(ui(icon)).size(14));
  }

  searchBar(t) {
    const search = this.search;
    return h_flex().id("explorer-search-bar").h(32).flex_none().mx(10).mb(4).pl(8).pr(4).gap(4).items_center().rounded(7).border_1()
      .border_color(this.searchFocus === "search" ? t.accent : t.input).text_color(t.muted)
      .on_key_down((event, cx) => this.searchKeyDown(event, cx))
      .child(svg(ui("search")).size(14).flex_none())
      .child(Input.new(this.searchInput).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground).accessibility_label(SEARCH.label))
      .when(this.found.loading, (el) => el.child(div().id("explorer-search-loading").flex_none().child(svg(chrome("spinner")).size(12).spin(900))))
      .when(Boolean(search.query), (el) => el.child(div().id("explorer-clear-search").size(20).flex_none().flex().items_center().justify_center().cursor_pointer()
        .tooltip(SEARCH.clear).accessibility_label(SEARCH.clear)
        .on_click((_e, cx) => { this.typeSearch("", cx); cx.notify(); })
        .child(svg(chrome("x")).size(12))))
      .child(this.searchToggle(t, "explorer-search-case", SEARCH.matchCase, "case-sensitive", search.caseSensitive, (cx) => this.toggleSearch("caseSensitive", cx)))
      .child(this.searchToggle(t, "explorer-search-word", SEARCH.wholeWord, "whole-word", search.wholeWord, (cx) => this.toggleSearch("wholeWord", cx)))
      .child(this.searchToggle(t, "explorer-search-regex", SEARCH.regex, "regex", search.useRegex, (cx) => this.toggleSearch("useRegex", cx)));
  }

  searchField(t, id, name, label, input) {
    return v_flex().flex_none().gap(3).pb(6)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(h_flex().id(id).h(28).px(8).items_center().rounded(6).border_1().border_color(this.searchFocus === name ? t.accent : t.input)
        .child(Input.new(input).flex_1().min_w(0).h_full().text_size(12.5).text_color(t.foreground)));
  }

  searchFilters(t) {
    const active = activeFilters(this.search);
    return v_flex().flex_none().mx(10)
      .child(h_flex().h(26).gap(4).items_center().justify_end()
        .when(active > 0, (el) => el.child(div().text_size(11).text_color(t.muted).child(`${active} active`)))
        .child(this.iconButton(t, "explorer-search-details", SEARCH.details, svg(ui("more")).size(14), true, () => this.toggleDetails())))
      .when(this.searchDetails, (el) => el
        .child(this.searchField(t, "explorer-search-include", "include", SEARCH.include, this.includeInput))
        .child(this.searchField(t, "explorer-search-exclude", "exclude", SEARCH.exclude, this.excludeInput)));
  }

  // Called from the list's layout, on later frames too: it reads only what it's given.
  resultRow(t, row, icons) {
    const line = h_flex().w_full().h(ROW_HEIGHT).flex_none().items_center().cursor_pointer().hover((s) => s.bg(t.hover));
    if (row.kind === "file") {
      return line.pl(8).pr(10).gap(4)
        .child(svg(chrome(row.collapsed ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.dim))
        .child(image(fileIcon(icons, row.name)).size(14).flex_none())
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
          .child(div().flex_none().text_size(12).child(row.name))
          .when(Boolean(row.dir), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(row.dir))))
        .child(div().flex_none().px(6).rounded(8).bg(t.hover).text_size(10).text_color(t.muted).child(String(row.count)));
    }
    const parts = matchParts(row.match);
    return line.pl(28).pr(8).gap(6)
      .child(div().flex_none().text_size(10).text_color(t.dim).child(String(row.match.line)))
      .child(h_flex().flex_1().min_w(0).items_center().overflow_hidden().text_size(12).text_color(t.muted)
        .when(Boolean(parts.before), (el) => el.child(div().flex_none().child(parts.before)))
        .when(Boolean(parts.match), (el) => el.child(div().flex_none().rounded(2).bg(t.selected).text_color(t.foreground).child(parts.match)))
        .when(Boolean(parts.after), (el) => el.child(div().flex_1().min_w(0).truncate().child(parts.after))));
  }

  searchResults(t) {
    const found = this.found, rows = found.rows, icons = this.icons;
    const summary = found.error ? null : searchSummary(found.results);
    const said = searchMessage({ query: this.search.query, results: found.results, loading: found.loading, error: found.error });
    return v_flex().flex_1().min_h(0)
      .when(Boolean(summary), (el) => el.child(div().flex_none().px(14).pb(4).text_size(11).text_color(t.dim).child(summary)))
      .when(Boolean(said), (el) => el.child(said.failed
        ? div().id("explorer-search-error").p(12).text_size(12).text_color(t.ansi1).child(said.text)
        : this.message(t, said.text)))
      .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().pb(8)
        .child(v_virtual_list(SEARCH_LIST, rows.length, ROW_HEIGHT, (i) => rows[i].key, (range) => rows.slice(range.start, range.end).map((row) => this.resultRow(t, row, icons)))
          .on_item_click((key, cx) => { this.clickResult(key, cx); cx.notify(); })
          .size_full())
        .child(Scrollbar.vertical(SEARCH_LIST).absolute().inset_0())));
  }

  // Drawn in the block, as the design has it; the backdrop keeps a press from reaching
  // what's under it.
  moreMenu(t) {
    const item = (id, label, on, action) => h_flex().id(`explorer-menu-${id}`).h(26).px(8).gap(12).items_center().justify_between().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(div().child(label))
      .when(on, (el) => el.child(svg(chrome("check")).size(14).flex_none().text_color(t.muted)));
    return v_flex().id("explorer-menu").absolute().top(40).right(8).w(228).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.5)
      .on_mouse_down("left", stop)
      .child(item("dotfiles", TEXT.showDotfiles, this.showDotfilesNow(), () => this.toggleDotfiles()))
      // Only for git repos, as in Orca.
      .when(Boolean(this.state?.git), (el) => el.child(item("ignored", TEXT.showIgnored, this.showIgnored, () => this.toggleIgnored())))
      .child(item("reveal", OPS.reveal, false, (cx) => { this.menu = false; this.reveal("", cx); }));
  }

  // Herdr's last call for an overlay's copy. The panel has nothing to end.
  async close(cx) {
    await this.overlayView?.close?.(cx);
  }

  render(cx) {
    if (this.overlayView) return this.overlayView.render(cx);
    this.sync(cx);
    if (this.stale && this.state && isShown(layout())) {
      this.stale = false;
      cx.spawn(async (cx) => { this.request(ALL, cx); cx.notify(); });
    }
    const t = theme();
    this.rowsNow = this.rows();
    const open = this.menu && Boolean(this.state);
    return v_flex().id("code-explorer").relative().size_full().min_h(0).overflow_hidden()
      .bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.segments(t))
      .when(this.view === "names" && Boolean(this.state), (el) => el.child(this.filterBar(t)))
      .when(this.view === "names" && Boolean(this.state) && Boolean(this.entry), (el) => el.child(this.entryBar(t)))
      .child(this.view === "names" ? this.names(t) : this.contents(t))
      .when(open, (el) => el
        .on_mouse_down_out((_e, cx) => { this.menu = false; cx.notify(); })
        .child(div().id("explorer-menu-backdrop").absolute().inset_0()
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu = false; cx.notify(); }))
        .child(this.moreMenu(t)));
  }
}
