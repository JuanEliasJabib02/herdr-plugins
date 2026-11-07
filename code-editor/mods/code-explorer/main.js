// The Explorer, in the projects layout's right panel, built from how Orca does it
// (S1, S3): the repo's name and its three buttons, Names and Contents, and a lazy
// tree with Material icons and git marks. A file opens in a tab of its own (S6).
//
// tree-model.js, git-model.js and icon-model.js decide; this file draws and runs
// programs. Every click goes through a method a `code-explorer.<command>` can also
// call (D2), since real clicks can't be posted to Herdr: see command().
//
// T6's filter plugs in at names() and rows(); T7's search at contents(); T8's
// row menu on the list, with on_item_secondary_click, and its items in moreMenu().
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, shared, setShared, run, notify, nextCommand, layout, appHome, home,
} from "herdr";
import { ICON_THEME, parseIconTheme } from "./icon-model.js";
import { GIT_COLORS, IGNORED_ARGS, ROOT_ARGS, STATUS_ARGS, buildFolderStatus, parseIgnored, parseRepo, parseStatus } from "./git-model.js";
import {
  ALL, DOCS_KEY, LIST_LIMIT, LIST_SCRIPT, ROW_HEIGHT, TEXT, batchPlan, contentsMessage, indentOf, isDoubleClick, isShown, listingLimited, locate,
  mergePlans, newDoc, openFile, parseCommand, parseListing, pruneExpanded, table, toggleExpanded, treeMessage, visibleRows,
} from "./tree-model.js";

// Changes a watch can't see (a commit in a worktree writes outside it), and every
// change when the watch is refused. As Herdr's files panel.
const FALLBACK = 10000;
// After a watch wakes: a burst of writes reloads once.
const SETTLE = 100;
// Orca shows the refresh spinner only for a refresh this slow.
const SPINNER_DELAY = 200;

const LIST = "explorer-tree";
const NO_GIT = { marks: new Map(), folders: new Map(), ignored: new Set() };

// Herdr's shipped chrome icons, there in every install; the rest are this mod's.
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;
const ui = (name) => `mods/code-explorer/ui/${name}.svg`;
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

const stop = (_e, cx) => cx.stop_propagation();

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
  init(_props, cx) {
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
    this.dotfiles = table(this.stored("dotfiles", {}));
    this.showIgnored = this.stored("ignored", true);
    this.filter = "";
    this.filterFocused = false;
    this.filterInput = InputState.new({ placeholder: TEXT.findFiles });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); cx.notify(); });
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
        try { this.command(raw, cx); }
        catch (e) { console.log(`code-explorer: ${raw} failed: ${e}`); }
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
      names: () => this.setView("names"),
      contents: () => this.setView("contents"),
    };
    if (Object.hasOwn(commands, name)) commands[name]();
    else console.log(`code-explorer: no command "${raw}"`);
  }

  // The state the `tree` command prints, to test what a click would have done.
  snapshot() {
    const state = this.state;
    return {
      where: this.where, root: state?.root ?? null, repo: state?.repo ?? null, git: state?.git ?? null, view: this.view, menu: this.menu,
      showDotfiles: this.showDotfilesNow(), showIgnored: this.showIgnored, filter: this.filter, error: state?.error ?? null,
      expanded: state ? [...state.expanded] : [], rows: this.rows(), docs: table(shared(DOCS_KEY)),
    };
  }

  // ── Which root ───────────────────────────────────────────────────────────

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
    if (!where?.cwd || where.machine) { this.state = null; return; }
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
        marks: NO_GIT, loaded: false, error: null, watching: false,
      };
      this.roots.set(found.root, state);
    }
    if (this.state === state) return;
    this.state = state;
    this.plan = null;
    // sync runs in render: the tree swaps now, and timers start from a task.
    cx.spawn(async (cx) => {
      this.request(ALL, cx);
      this.watch(state, cx);
    });
  }

  // ── Keeping up with the disk ─────────────────────────────────────────────

  watch(state, cx) {
    // AGENTS.md: watch what you show, not a whole home folder. The timer covers it.
    if (state.watching || state.root === home()) return;
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
    state.expanded = toggleExpanded(state.expanded, path);
    if (!state.expanded.has(path)) return;
    // Lazy: read when opened. What's cached shows at once, and this brings it up to date.
    this.plan = mergePlans(this.plan, { all: false, folders: [path], git: false });
    this.drain(cx);
  }

  // One at a time, in click order: a double click's second click must find the tab
  // its first one made.
  open(path, pin, cx) {
    const state = this.state, space = this.where?.space;
    if (!state || !space || !path || this.rows().find((r) => r.path === path)?.dir) return;
    const file = `${state.root}/${path}`;
    cx.spawn(async (cx) => {
      const turn = this.opening;
      let done;
      this.opening = new Promise((resolve) => { done = resolve; });
      await turn;
      try {
        await openFile({ file, pin, space }, {
          spaces, panes, shared, setShared, run, notify, newDoc,
          wait: (ms) => new Promise((resolve) => { cx.timer.after(ms, () => resolve()); }),
        });
      } catch (e) { console.log(`code-explorer: opening ${file} failed: ${e}`); }
      finally { done(); cx.notify(); }
    });
  }

  canCollapse() {
    return this.view === "names" && !this.filter && Boolean(this.state?.expanded.size);
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

  setView(view) {
    this.view = view;
    this.menu = false;
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
  }

  toggleIgnored() {
    this.showIgnored = !this.showIgnored;
    localStorage.setItem("ignored", JSON.stringify(this.showIgnored));
    this.menu = false;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  rows() {
    const state = this.state;
    if (!state) return [];
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
        .on_click((_e, cx) => { this.setView(view); cx.notify(); })
        .child(label);
    };
    return h_flex().flex_none().mx(10).mb(8).p(2).gap(2).rounded(8).bg(t.canvas)
      .child(segment("names", TEXT.names))
      .child(segment("contents", TEXT.contents));
  }

  message(t, text) {
    return div().p(12).text_center().text_color(t.dim).child(text);
  }

  // T6's filter reads this.filter; until then typing filters nothing.
  filterBar(t) {
    return h_flex().h(32).flex_none().mx(10).mb(8).px(8).gap(8).items_center().rounded(7).border_1().border_color(this.filterFocused ? t.accent : t.input)
      .text_color(t.muted)
      .child(svg(ui("filter")).size(14).flex_none())
      .child(Input.new(this.filterInput).flex_1().min_w(0).h_full().text_size(13).text_color(t.foreground))
      .when(Boolean(this.filter), (el) => el.child(div().id("explorer-clear-filter").size(20).flex_none().flex().items_center().justify_center().cursor_pointer()
        .tooltip(TEXT.clearFilter).accessibility_label(TEXT.clearFilter)
        .on_click((_e, cx) => { this.clearFilter(); cx.notify(); })
        .child(svg(chrome("x")).size(12))));
  }

  clearFilter() {
    this.filter = "";
    this.filterInput.set_value("");
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

  // T6 puts its filtered rows here, and "No files match this filter" in treeMessage's place.
  names(t) {
    const state = this.state;
    const rows = this.rowsNow;
    const text = treeMessage({ hasFolder: Boolean(this.where?.cwd), remote: Boolean(this.where?.machine), loaded: Boolean(state?.loaded), error: state?.error, rows: rows.length });
    const area = v_flex().flex_1().min_h(0);
    if (text) {
      return area.child(this.message(t, text))
        .when(Boolean(state?.error), (el) => el.child(div().flex().justify_center().child(div().id("explorer-retry").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.refresh(cx); cx.notify(); }).child(TEXT.retry))));
    }
    if (!rows.length) return area.child(div().flex().justify_center().p(12).child(svg(chrome("spinner")).size(14).text_color(t.dim).spin(900)));
    const activeFile = this.activeFile(), root = state.root;
    return area
      .when(Boolean(state.limited.size), (el) => el.child(div().flex_none().px(14).pb(6).text_size(11).text_color(t.dim).child(`A folder shows its first ${LIST_LIMIT} entries`)))
      .child(div().flex_1().min_h(0).relative().pb(8)
        .child(v_virtual_list(LIST, rows.length, ROW_HEIGHT, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map((row) => this.row(t, row, root, activeFile)))
          .on_item_click((path, cx) => { this.clickRow(path, cx); cx.notify(); })
          .size_full())
        .child(Scrollbar.vertical(LIST).absolute().inset_0()));
  }

  // T7's search goes here.
  contents(t) {
    return v_flex().flex_1().min_h(0).child(this.message(t, contentsMessage({ hasFolder: Boolean(this.where?.cwd), remote: Boolean(this.where?.machine) })));
  }

  // T8 adds Reveal in Finder after these. Drawn in the block, as the design has it;
  // the backdrop keeps a press from reaching what's under it.
  moreMenu(t) {
    const item = (id, label, on, action) => h_flex().id(`explorer-menu-${id}`).h(26).px(8).gap(12).items_center().justify_between().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); cx.notify(); })
      .child(div().child(label))
      .when(on, (el) => el.child(svg(chrome("check")).size(14).flex_none().text_color(t.muted)));
    return v_flex().id("explorer-menu").absolute().top(40).right(8).w(228).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.5)
      .on_mouse_down("left", stop)
      .child(item("dotfiles", TEXT.showDotfiles, this.showDotfilesNow(), () => this.toggleDotfiles()))
      // Only for git repos, as in Orca.
      .when(Boolean(this.state?.git), (el) => el.child(item("ignored", TEXT.showIgnored, this.showIgnored, () => this.toggleIgnored())));
  }

  render(cx) {
    this.sync(cx);
    if (this.stale && this.state && isShown(layout())) {
      this.stale = false;
      cx.spawn(async (cx) => { this.request(ALL, cx); cx.notify(); });
    }
    const t = theme();
    this.rowsNow = this.rows();
    const open = this.menu && Boolean(this.state);
    return v_flex().id("code-explorer").relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.chrome).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.segments(t))
      .when(this.view === "names" && Boolean(this.state), (el) => el.child(this.filterBar(t)))
      .child(this.view === "names" ? this.names(t) : this.contents(t))
      .when(open, (el) => el
        .on_mouse_down_out((_e, cx) => { this.menu = false; cx.notify(); })
        .child(div().id("explorer-menu-backdrop").absolute().inset_0()
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu = false; cx.notify(); }))
        .child(this.moreMenu(t)));
  }
}
