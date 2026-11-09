// The projects tree, in the layout's Spaces block: the active group's
// projects, each with its workspaces (git worktrees) and the agents in their
// spaces (S10, S11). Spaces outside every project show nowhere (S14, S15).
// Click a workspace to go to its space or open one (D8); "+" in the header
// adds a project (D10), "+" on a project opens New workspace; right-click a
// project for its menu. A group organized by Task (D29–D32) shows task lanes
// instead of projects, each row naming its project, and the header gets a
// New workspace "+"; a lane shows its task's note on hover and has a
// right-click menu (D34, D35). A workspace row also shows what other
// plugins publish for it ("badges", D38), and so does a task lane's header
// (Spotlight's D29), drawn as Orca's sidebar buttons (Spotlight's D39). The
// header's filter button opens Hide sleeping's popup, which leaves asleep
// workspaces out of the rows (workspace-sleep D8). Below 160 px of sidebar it
// is a rail of initials.
//
// This copy is also the worktree engine (D6): it lists every group's
// projects into projects.cache.v1 at start, re-lists one when its
// .git/worktrees (or .git) changes, and every minute while the window is in
// front. The model is tree-model.js; this file draws it and wires herdr in.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, notify, run, exec, spaces, panes, agents, focused, layout, home, window, pickFolder, watchFolder,
} from "herdr";
import { icon } from "./config.js";
import { findProject, activeGroup, matchSpaces, noteKeyOf, noteOf, baseName, normPath } from "./lib.js";
import * as store from "./store.js";
import { repoOf, listWorktrees, workspacePrs } from "./git.js";
import { PR_COLORS, prLabel, prMemo, mergePrs } from "./pr-model.js";
import {
  buildTree, openAction, railAction, isNarrow, projectPaths, pruneCache, watchDirs, eachLimit, liveFolder, addProjectAt, reorderProject,
} from "./tree-model.js";
import { buildTaskTree } from "./task-model.js";
import {
  badgeTooltip, badgeRun, laneBadgeKey, execFailure, startFailure,
  badgeLayout, badgeHover, pillStyle, dotStyle, hasReveal, BADGE_MOTION, BADGE_BOX,
} from "./badges-model.js";
import { openNewWorkspace } from "./new-workspace.js";
import { openProjectMenu } from "./project-menu.js";
import { openWorkspaceMenu } from "./workspace-menu.js";
import { openTaskMenu } from "./task-menu.js";
import { openFilterMenu } from "./filter-menu.js";
import { showPrCard, cardTarget } from "./pr-card.js";

// git listings at once (Juan has ~30 projects).
const LISTERS = 4;
// Changes made outside a watch's reach: looked for this often, while the
// window is in front (mods/spaces/main.js FALLBACK).
const FALLBACK = 60000;
// After a watch wakes: a worktree add writes several files; list once after.
const SETTLE = 500;
// The PRs of the active group's workspaces are asked of GitHub this often
// while the window is in front, and again on coming back to it (a PR merged
// in the browser) or switching groups, at most every PR_AGAIN.
const PR_EVERY = 60000;
const PR_AGAIN = 10000;
// At most this many shows of the PR card's block per layout load (J-010):
// enough for a show Herdr ignored on a slow cold start to be run again, and
// a bound on the flashes when the card hides itself right after one (an
// origin that isn't GitHub, read fast).
const CARD_ASKS = 5;
// The PR card's block seen shown this many ticks in a row with no show run
// (J-014): it was shown at load, so the card's copy runs and decides from
// then on. Without this the tree kept watching such a load, and on an origin
// that isn't GitHub it re-showed the card the card had just hidden.
const CARD_SEEN = 2;

// Herdr's shipped chrome icons (chevrons): there in every install.
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;

// D33 (S28): the project row being dragged, { from, y, moving, over, after },
// built from mouse events (gpui-kit has no element drag): a press on a
// project row starts it, 4 px of travel makes it a drag, the rows under the
// pointer mark where it lands, the list's mouse up moves the project. A
// press anywhere else, the row's "+", or leaving the list cancels it.
let drag = null;
// A drag just ended: the row's click that comes with the mouse up mustn't
// also fold it.
let dragged = false;
const DRAG_START = 4;

// D38: the badges whose exec is still running, badgeRun's id (the row, the
// badge's key and index): a click on one of them is ignored until its
// program ends.
const running = new Set();

// A badge's icon that asks to turn (`spin`, Spotlight's D29) makes a turn
// every this many ms, as Herdr's own spinners.
const BADGE_SPIN = 900;
// A badge's icon, in px; a pill's is smaller (Orca's `size-2.5`).
const BADGE_ICON = 12;
const PILL_ICON = 10;

// Spotlight's D39: the row the pointer is on, by its element id (`w:<path>`,
// `t:<lane>`), when that row holds a badge that waits for its hover
// (`reveal`); else null. on_hover sets it, only on such rows. A click that
// moves rows (a fold, a drop) sets it to the clicked row or none: the rows
// under a still pointer change and no hover-out comes (as projects-agents'
// pin). One for every copy, as `drag`.
let hovered = null;
// Spotlight's D39: each "grow" badge's own width as last drawn
// (on_size_change), by its element id: what its clip opens to on hover.
const grown = new Map();
// Spotlight's D39: the badge (element id) last pressed while it showed, so
// its click runs even if its row's hover is lost before the release; null
// after a press on a badge that didn't show.
let pressed = null;

export default class Tree {
  init(_props, cx) {
    this.known = new Map(); // project path -> the token of its watch loop
    this.token = 0;
    this.failed = new Set(); // projects git couldn't list last time (folder gone)
    // PR status: which account sees each owner's repos, whether a round is
    // running, whether one more was asked for meanwhile (projects.refresh-prs),
    // when the last one started, the last ask seen in the store (one stored
    // before this copy started isn't run again), and what the window and the
    // active group were at the last tick.
    this.prMemo = prMemo();
    this.prBusy = false;
    this.prAgain = false;
    this.prAt = 0;
    this.prAsked = store.prsAsked();
    this.wasActive = false;
    this.prGroup = null;
    // The PR card's block, if Herdr kept it hidden in this layout: shown, so
    // the card starts and decides itself whether it has something to say
    // (cardTick, J-001, J-010). This copy starts on every layout load; the
    // show waits for the ticks, since on a cold start Herdr ignores it from
    // init (seen live after a restart). How many shows were run, how many
    // ticks in a row the block was seen shown, and whether the card's copy
    // is known to run.
    this.cardAsks = 0;
    this.cardSeen = 0;
    this.cardDone = false;
    this.sync(cx);
    // The PR card's block until its copy runs; new or removed projects (Add
    // project here, the project menu in its popup), and whether the PRs are
    // due.
    cx.timer.every(1000, (cx) => {
      if (!this.cardDone) this.cardTick();
      this.sync(cx);
      this.prTick(cx);
    });
    cx.timer.every(FALLBACK, (cx) => {
      if (window().active) this.listAll(cx);
    });
    // The agents' "time since" moves on its own.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // ── The PR card's block (J-001, J-010) ───────────────────────────────────

  // Each tick until the card's copy is known to run: the card's block shown
  // when Herdr kept it hidden and the card has something to say for the
  // shown space (pr-card.js cardTarget, the card's own rule: never on a main
  // checkout, so it doesn't flash there). A start on a main checkout keeps
  // watching, so the first workspace with something to say shows it however
  // late (seen live: a 5-tick limit left it hidden). No block yet (the layout
  // not applied) or a block still hidden: the next tick looks again. One
  // that shows before any show ran may still get its saved hidden flag, so
  // it counts as running only after CARD_SEEN ticks in a row (J-014). Shown
  // after a show: the card's copy has started and decides from then on, so
  // this is done; so it is after CARD_ASKS shows.
  cardTick() {
    const step = showPrCard(cardTarget() !== null);
    if (step === "asked") {
      this.cardSeen = 0;
      this.cardAsks++;
      if (this.cardAsks >= CARD_ASKS) this.cardDone = true;
    } else if (step === "shown") {
      this.cardSeen++;
      if (this.cardAsks > 0 || this.cardSeen >= CARD_SEEN) this.cardDone = true;
    } else this.cardSeen = 0;
  }

  // ── Worktree engine (D6) ─────────────────────────────────────────────────

  // Starts listing and watching projects that joined, forgets those that left
  // (their loops end at their next wake) and drops their cached lists.
  sync(cx) {
    const paths = projectPaths(store.registry());
    const want = new Set(paths);
    for (const p of [...this.known.keys()]) if (!want.has(p)) this.known.delete(p);
    const all = store.cache();
    const kept = pruneCache(all, paths);
    if (kept !== all) store.saveCache(kept);
    const fresh = paths.filter((p) => !this.known.has(p)).map((p) => [p, ++this.token]);
    if (!fresh.length) return;
    for (const [p, token] of fresh) this.known.set(p, token);
    cx.spawn(async (cx) => {
      await eachLimit(fresh, LISTERS, ([p]) => this.list(p));
      try {
        for (const [p, token] of fresh) this.watch(p, token, cx);
        cx.notify();
      } catch {
        // This build was reloaded meanwhile: the new one watches.
      }
    });
  }

  // One project's worktrees into the cache (written only when they changed,
  // and only while the project is still registered). A folder git can't run
  // in (gone) keeps what it showed, or, never listed, shows as missing.
  async list(path) {
    let list;
    try {
      list = await listWorktrees(path);
    } catch {
      this.failed.add(path);
      return;
    }
    this.failed.delete(path);
    if (findProject(store.registry(), path)) store.saveWorktrees(path, list);
  }

  listAll(cx) {
    const paths = [...this.known.keys()];
    cx.spawn(async (cx) => {
      await eachLimit(paths, LISTERS, (p) => this.list(p));
      try {
        cx.notify();
      } catch {
        // Reloaded meanwhile.
      }
    });
  }

  // Re-lists a project when its worktrees change. Ends when the project leaves
  // (or comes back: a new loop takes over), when there is nothing to watch
  // (not a repo, folder gone: the fallback timer still lists it), or when
  // this build is reloaded (its cx throws).
  watch(path, token, cx) {
    const mine = () => this.known.get(path) === token;
    cx.spawn(async (cx) => {
      try {
        while (mine()) {
          let woke = false;
          for (const dir of watchDirs(path, store.cache()[path])) {
            try {
              await watchFolder(dir);
              woke = true;
              break;
            } catch {
              // Not there: the next one.
            }
          }
          if (!woke) return;
          await cx.sleep(SETTLE);
          if (!mine()) return;
          await this.list(path);
          cx.notify();
        }
      } catch {
        // Reloaded: the new build has its own loops.
      }
    });
  }

  // ── PR status ────────────────────────────────────────────────────────────

  // Only the window in front asks (every copy draws what it stored): every
  // PR_EVERY, or PR_AGAIN after coming back to the window or to another group,
  // or at once when `projects.refresh-prs` left an ask in the store since the
  // last tick (store.js askPrs).
  prTick(cx) {
    const active = Boolean(window().active);
    const group = activeGroup(store.registry())?.id ?? null;
    const back = active && (!this.wasActive || group !== this.prGroup);
    const asked = store.prsAsked();
    const wanted = asked > this.prAsked;
    this.prAsked = asked;
    this.wasActive = active;
    this.prGroup = group;
    if (!active) return;
    if (wanted) {
      this.askPrs(cx);
      return;
    }
    if (Date.now() - this.prAt >= (back ? PR_AGAIN : PR_EVERY)) this.refreshPrs(cx);
  }

  // A round now, asked by Mergear and Crear PR after each attempt
  // (projects.refresh-prs, D8, through the store: prTick).
  // While one runs, one more is recorded and runs after it: a round that
  // started before the merge read GitHub before it, so it is never the last
  // word on the sidebar's colors.
  askPrs(cx) {
    if (this.prBusy) {
      this.prAgain = true;
      return;
    }
    this.refreshPrs(cx);
  }

  // One round: each project of the active group asked once (pr-model.js
  // projectPrs), LISTERS at a time, then stored together (mergePrs: a project
  // that failed keeps what it showed). Stored only when a PR changed, which
  // re-renders every copy. This copy is the only writer of projects.prs.v1
  // (store.js); the card and Mergear only read it, and ask for a round.
  refreshPrs(cx) {
    if (this.prBusy) return;
    this.prBusy = true;
    this.prAgain = false;
    this.prAt = Date.now();
    const projects = (activeGroup(store.registry())?.projects ?? []).map((p) => normPath(p.path));
    const lists = store.cache();
    cx.spawn(async (cx) => {
      try {
        const results = await eachLimit(projects, LISTERS, (p) => workspacePrs(p, lists[p] ?? [], this.prMemo));
        const rounds = projects.map((project, i) => ({ project, ...(results[i].ok ? results[i].value : { ok: false, prs: {} }) }));
        store.savePrs(mergePrs(store.prs(), rounds, store.cache()));
      } finally {
        this.prBusy = false;
        // Asked for while this one ran: one more, now.
        if (this.prAgain) {
          try {
            this.refreshPrs(cx);
          } catch {
            // Reloaded meanwhile: the new build asks on its own.
          }
        }
      }
    });
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  render() {
    const t = theme();
    const narrow = isNarrow(layout());
    const registry = store.registry();
    const ui = store.ui();
    const byTask = activeGroup(registry)?.organize === "task";
    const args = {
      registry,
      cache: store.cache(),
      spaces: spaces(),
      panes: panes(),
      agents: agents(),
      collapsed: ui.collapsed,
      home: home(),
      now: Date.now(),
      failed: this.failed,
      // Hide sleeping (workspace-sleep D8): the rows only, never the rail.
      hideSleeping: ui.hideSleeping,
      exceptMain: ui.exceptMain,
    };
    const model = byTask ? buildTaskTree({ ...args, tasks: ui.tasks ?? [] }) : buildTree(args);
    const notes = byTask ? store.notes() : {};
    // Other plugins' badges (D38), workspace rows' and task lanes', read
    // once; the rail draws none.
    const badges = narrow ? {} : store.badges();
    // The PR of each workspace's branch, read once; the rail shows none.
    const prs = narrow ? {} : store.prs();
    const body = model.empty
      ? narrow ? [] : [emptyState(t)]
      : narrow ? model.projects.map((p) => railRow(p, t)) : model.rows.map((r) => row(r, t, notes, badges, prs, model.group.id));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(header(model.group, narrow, byTask, ui.hideSleeping === true, t))
      .child(v_flex().id("projects-list").flex_1().min_h(0).px(narrow ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => drop(cx))
        // Leaving the list (or the window) cancels a drag, and no row is
        // hovered any more (D39).
        .on_hover((on, cx) => {
          if (!on) hoverRow(hovered, false, cx);
          if (on || !drag) return;
          drag = null;
          cx.notify();
        })
        .children(body));
  }
}

// In Task mode no project row carries New workspace's "+", so the header
// does: for the focused space's project (D32, S13). Left of Add project, the
// filter button (workspace-sleep D8); the rail has no rows to filter, so not
// there. `hiding`: Hide sleeping is on.
function header(group, narrow, byTask, hiding, t) {
  return h_flex().h(31).flex_none().items_center().gap(6).text_size(11.5).text_color(t.dim)
    .when(narrow, (el) => el.justify_center())
    .when(!narrow, (el) => el.pl(16).pr(10).child(div().flex_1().min_w(0).truncate().child(group.name === "Projects" ? "Projects" : `Projects · ${group.name}`)))
    .when(byTask && !narrow, (el) => el.child(div().id("projects-new-workspace").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New workspace")
      .on_click(() => openNewWorkspace(focusedProject()))
      .child(svg(icon("branch")).size(14))))
    .when(!narrow, (el) => el.child(filterButton(hiding, t)))
    .child(div().id("projects-add").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Add project")
      .on_click((_e, cx) => cx.spawn(async () => addFromPicker()))
      .child(svg(icon("plus")).size(14)));
}

// Whether the pointer is on the filter button: its glyph is drawn, not an
// icon, so it can't take the hover's text color as the other buttons do.
let filterHover = false;

// Orca's filter button (SidebarFilter.tsx): its ListFilter glyph, three
// bars, drawn here since neither this mod nor Herdr's chrome ships one, and
// its popup (filter-menu.js) on click. While Hide sleeping is on, Orca's
// badge at its top right counts the filters on, so a row that went missing
// has its why in sight, and its tooltip says "Edit filters", as Orca's does.
function filterButton(hiding, t) {
  const color = filterHover ? t.foreground : t.dim;
  const bar = (w) => div().w(w).h(1.5).rounded(1).bg(color);
  return div().id("projects-filter").relative().size(26).flex_none().flex().items_center().justify_center().rounded(6)
    .hover((s) => s.bg(t.hover))
    .on_hover((hovered, cx) => {
      if (filterHover === hovered) return;
      filterHover = hovered;
      cx.notify();
    })
    .tooltip(hiding ? "Edit filters" : "Filter workspaces")
    .on_click(() => openFilterMenu())
    .child(v_flex().items_center().gap(2).child(bar(11.5)).child(bar(7)).child(bar(3.5)))
    .when(hiding, (el) => el.child(div().absolute().top(-2).right(-2).min_w(12).h(12).px(2).rounded(6).bg(t.accent)
      .flex().items_center().justify_center().text_size(9).font_medium().text_color(t.accent_foreground).child("1")));
}

function emptyState(t) {
  return v_flex().px(8).pt(6).gap(10).items_start()
    .child(div().text_size(12).text_color(t.dim).child("No projects in this group yet."))
    .child(h_flex().id("projects-empty-add").h(28).px(10).gap(7).items_center().rounded(7).border(1).border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => cx.spawn(async () => addFromPicker()))
      .child(svg(icon("plus")).size(12))
      .child("Add project"));
}

// The project of the focused space (D7), or null: New workspace then starts
// on the group's first project.
function focusedProject() {
  const all = spaces();
  const active = all.find((s) => s.active);
  if (!active) return null;
  return matchSpaces(store.cache(), all, panes(), home())[active.id]?.project ?? null;
}

// `notes`: projects.notes.v1, read once per render (Task mode only).
// `badges`: other plugins' badges by workspace path and by lane key
// (store.js badges). `prs`: the PR of each workspace's branch by path
// (store.js prs). `group`: the active group's id: a lane header draws only
// the badges published for this group's lane (Spotlight's D29).
function row(r, t, notes, badges, prs, group) {
  if (r.kind === "task") return taskRow(r, t, notes, group, badges[laneBadgeKey(group, r.lane)] ?? []);
  if (r.kind === "project") return projectRow(r, t);
  if (r.kind === "workspace") return workspaceRow(r, t, badges[r.path] ?? [], prs[r.path] ?? null);
  if (r.kind === "agent") return agentRow(r, t);
  const what = r.kind === "missing" ? "Can't read this folder." : "Loading…";
  const text = r.projectName ? `${r.projectName} · ${what}` : what;
  return div().id(`${r.kind}:${r.project}`).h(28).flex_none().pl(48).flex().items_center().text_size(12).text_color(t.dim).child(text);
}

// A task lane (Task mode): fold on click; its count and, folded, its most
// urgent status. Its task's note, if any, on hover: the note only, no icon
// (Orca). A ticket or name lane opens the task menu on right-click; No task
// and Servers have no note key, so neither (D34, D35). Other plugins'
// badges for this group's lane (Spotlight's D29: Orca's task header
// buttons, which come after its status) sit before the count, sharing the
// row's badge room like a workspace row's; No task and Servers never have
// any (badges-model.js takes no lane key for them). A header holding a
// badge that waits for its hover (`reveal`, Spotlight's D39: Orca's env
// pill) tracks its hover; its fold moves the rows below it, not itself.
// `group`: the active group's id; `badges`: the ones published for
// `<group>/<lane>`.
function taskRow(l, t, notes, group, badges) {
  const key = noteKeyOf(l.lane);
  const note = noteOf(notes, key);
  const id = `t:${l.lane}`;
  const layout = badgeLayout(badges, { hovered: hovered === id, measured: badges.map((b) => grown.get(laneBadgeId(l, b)) ?? null) });
  return h_flex().id(id).h(28).flex_none().px(8).gap(7).items_center().rounded(8)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .when(hasReveal(badges), (el) => el.on_hover((on, cx) => hoverRow(id, on, cx)))
    .on_click(() => {
      rowsMoved(hasReveal(badges) ? id : null);
      store.toggleTaskCollapsed(l.lane);
    })
    .when(Boolean(note), (el) => el.tooltip(note))
    .when(key !== null, (el) => el.on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation(); // or on_click runs too (ClickEvent carries no button)
      openTaskMenu(l.lane, l.label);
    }))
    .child(svg(chrome(l.collapsed ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
    .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(l.label))
    .when(l.collapsed && Boolean(l.status) && l.status !== "idle", (el) => el.child(statusMark(l.status, t)))
    .when(badges.length > 0, (el) => el.child(badgeStrip(badges, layout, (b) => laneBadgeId(l, b), (b, slot) => laneBadge(group, l, b, slot, t))))
    .when(l.count > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(String(l.count))));
}

// The element ids of a badge on a lane header and on a workspace row: its
// key and index, then its row.
const laneBadgeId = (l, b) => `lb:${b.key}:${b.index}:${l.lane}`;
const badgeId = (w, b) => `b:${b.key}:${b.index}:${w.path}`;

// Another plugin's badge on a task lane's header (Spotlight's D29), drawn
// like a workspace row's (badgeButton). A click never folds the lane: with
// an action it runs it, with the home folder as its cwd, while the badge
// shows (`slot.clickable`, D39); otherwise it does nothing. A right-click
// opens the task menu, as on the header, and never runs the action.
function laneBadge(group, l, b, slot, t) {
  const tip = badgeTooltip(b);
  const id = laneBadgeId(l, b);
  return badgeButton(id, b, slot, t)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation(); // or on_click runs the action (ClickEvent carries no button)
      openTaskMenu(l.lane, l.label);
    })
    .on_mouse_down("left", () => armBadge(id, slot))
    .on_click((_e, cx) => {
      cx.stop_propagation(); // the header's click would fold the lane
      if (b.action && clickRuns(id, slot)) runBadge({ group, lane: l.lane }, b, cx);
    });
}

// A project: collapse on click, its menu on right-click, "+" for a new workspace.
// The list's mouse up: a drag onto another project row moves the project
// there (D33); one that ended on its own row only stops the fold.
function drop(cx) {
  const d = drag;
  drag = null;
  if (!d?.moving) return;
  dragged = true;
  rowsMoved(null);
  if (d.over && d.over !== d.from) store.updateRegistry((r) => reorderProject(r, d.from, d.over, d.after));
  cx.notify();
}

function projectRow(p, t) {
  const landing = Boolean(drag?.moving) && drag.over === p.path && drag.from !== p.path;
  return h_flex().id(`p:${p.path}`).relative().h(28).flex_none().px(8).gap(7).items_center().rounded(8)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .when(Boolean(drag?.moving) && drag.from === p.path, (el) => el.opacity(0.45))
    .on_click(() => {
      if (drag?.moving || dragged) {
        dragged = false;
        return;
      }
      // The fold moves the rows below; a project row tracks no hover (D39).
      rowsMoved(null);
      store.toggleCollapsed(p.path);
    })
    .on_mouse_down("left", (e) => {
      drag = { from: p.path, y: e.position.y, moving: false, over: null, after: false };
      dragged = false;
    })
    // A new press cancels (D33). MouseMoveEvent doesn't say whether a button
    // is held, so a drag whose mouse up never reached the list would turn
    // into one on the next buttonless move: any press outside a project row
    // ends it. This runs in the capture phase, before the pressed row's
    // on_mouse_down starts a new one.
    .on_mouse_down_out((_e, cx) => {
      if (!drag) return;
      drag = null;
      cx.notify();
    })
    .on_mouse_move((e, cx) => {
      if (!drag) return;
      if (!drag.moving && Math.abs(e.position.y - drag.y) < DRAG_START) return;
      const after = e.local_position.y >= (e.bounds?.height ?? 28) / 2;
      if (drag.moving && drag.over === p.path && drag.after === after) return;
      drag = { ...drag, moving: true, over: p.path, after };
      cx.notify();
    })
    // Where the dragged project lands: a line above or below this row.
    .when(landing, (el) => el.child(div().absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
      .when(drag.after, (d) => d.bottom(-1))
      .when(!drag.after, (d) => d.top(-1))))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation(); // or on_click runs too (ClickEvent carries no button)
      openProjectMenu(p.path);
    })
    .child(svg(chrome(p.collapsed ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
    .child(svg(icon("folder")).size(14).flex_none().text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(p.name))
    .when(p.collapsed && Boolean(p.status) && p.status !== "idle", (el) => el.child(statusMark(p.status, t)))
    .child(div().id(`p+:${p.path}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New workspace")
      .on_click((_e, cx) => {
        // Its press also reached the row's on_mouse_down, and this stops the
        // mouse up before the list's drop(): the drag it started ends here.
        drag = null;
        cx.stop_propagation();
        cx.notify();
        openNewWorkspace(p.path);
      })
      .child(svg(icon("plus")).size(12)));
}

// A workspace: home (main checkout) or branch icon, or its agent's status in
// that place; the branch icon in its PR's color (green open, purple merged,
// red closed, gray draft; pr-model.js PR_COLORS), its hover naming the PR;
// other plugins' badges after the label (D38); the open dot when it has a
// space; highlighted when shown. Asleep (workspace-sleep D3, Orca's moon): a
// moon in that place unless an agent needs attention, the label and icons
// dimmed, no dot, and the main checkout's home after the label. A row holding
// a badge that waits for its hover (`reveal`, Spotlight's D39) tracks its
// hover. When the row runs out of width, the label gives way first, then
// (Task mode) the project name; the badges' strip never shrinks (its text
// badges are already cut to their share, badgeLayout).
function workspaceRow(w, t, badges, pr) {
  const id = `w:${w.path}`;
  const layout = badgeLayout(badges, { hovered: hovered === id, measured: badges.map((b) => grown.get(badgeId(w, b)) ?? null) });
  const busy = Boolean(w.status) && w.status !== "idle";
  const moon = w.asleep && !busy;
  const shown = !busy && !moon && !w.main && pr ? pr : null;
  const tone = shown ? t[PR_COLORS[shown.state]] ?? t.dim : t.dim;
  const lead = busy ? statusMark(w.status, t)
    : moon ? div().id(`m:${w.path}`).flex_none().tooltip("Sleeping").child(svg(icon("moon")).size(13).text_color(t.dim))
    : svg(icon(w.main ? "home" : "branch")).size(13).flex_none().text_color(tone);
  return h_flex().id(id).h(28).flex_none().pl(26).pr(8).gap(8).items_center().rounded(8)
    .cursor_pointer()
    .when(w.selected, (el) => el.bg(t.selected))
    .when(!w.selected, (el) => el.hover((s) => s.bg(t.hover)))
    .when(hasReveal(badges), (el) => el.on_hover((on, cx) => hoverRow(id, on, cx)))
    .on_click(() => go(openAction(w)))
    // Stops here so the right button doesn't also run on_click (ClickEvent
    // carries no button).
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openWorkspaceMenu(w.project, w.path);
    })
    .child(h_flex().id(`lead:${w.path}`).w(14).flex_none().items_center().justify_center()
      .when(Boolean(shown), (el) => el.tooltip(prLabel(shown)))
      .child(lead))
    .child(div().flex_1().min_w(0).truncate().text_color(w.asleep ? t.dim : w.open ? t.foreground : t.muted).child(w.label))
    .when(moon && w.main, (el) => el.child(svg(icon("home")).size(12).flex_none().text_color(t.dim)))
    .when(badges.length > 0, (el) => el.child(badgeStrip(badges, layout, (b) => badgeId(w, b), (b, slot) => badge(w, b, slot, t))))
    // Task mode: no project row above names it (Orca's project label). It
    // gives way after the label (D39).
    .when(Boolean(w.projectName), (el) => el.child(div().flex_shrink(1).min_w(0).max_w(110).truncate().text_size(11.5).text_color(t.dim).child(w.projectName)))
    .when(w.open && !w.asleep, (el) => el.child(div().size(6).flex_none().rounded(3).bg(w.selected ? t.accent : t.muted)));
}

// Another plugin's badge on a workspace row (D38), drawn as Orca's button
// (badgeButton, Spotlight's D39). Its hover names what a click runs. A
// right-click opens the workspace menu, as on the row, and never runs the
// action. With an action, a click runs it while the badge shows
// (`slot.clickable`: a reveal badge at opacity 0 does nothing) and never
// also opens the workspace; without one, a click is the row's.
function badge(w, b, slot, t) {
  const tip = badgeTooltip(b);
  const id = badgeId(w, b);
  return badgeButton(id, b, slot, t)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation(); // or on_click runs the action (ClickEvent carries no button)
      openWorkspaceMenu(w.project, w.path);
    })
    .when(Boolean(b.action), (el) => el.on_mouse_down("left", () => armBadge(id, slot)).on_click((_e, cx) => {
      cx.stop_propagation(); // like the project's "+": the row doesn't open the workspace too
      if (clickRuns(id, slot)) runBadge({ path: w.path }, b, cx);
    }));
}

// A press on a badge (D39): it arms the click when the badge shows. GPUI
// reports a pressed row as left as soon as the pointer moves, which hides a
// reveal badge under it; the click that follows still runs.
function armBadge(id, slot) {
  pressed = slot.clickable ? id : null;
}

// Whether a badge's click runs: it shows now, or its press came while it
// showed (armBadge). A reveal badge at opacity 0 does nothing.
function clickRuns(id, slot) {
  const runs = slot.clickable || pressed === id;
  pressed = null;
  return runs;
}

// A row's badges (D38) where badgeLayout puts them (Spotlight's D39), in a
// strip that never shrinks: each badge's gap is a margin before it, but a
// "grow" badge is drawn in a clip whose width and opacity move at
// BADGE_MOTION, holding the gap it carries, so collapsed it takes no room;
// its button reports its own width (`grown`), which the clip opens to.
// `idOf(b)`: a badge's element id; `draw(b, slot)`: its button.
function badgeStrip(badges, layout, idOf, draw) {
  return h_flex().flex_none().items_center().children(badges.map((b, i) => {
    const slot = layout[i];
    const id = idOf(b);
    const button = draw(b, slot);
    if (b.reveal !== "grow") return slot.ml > 0 ? button.ml(slot.ml) : button;
    return h_flex().id(`grow:${id}`).flex_none().items_center().overflow_hidden()
      .when(slot.width !== null, (el) => el.w(slot.width))
      .opacity(slot.opacity)
      .transition("opacity", BADGE_MOTION)
      .transition("width", BADGE_MOTION)
      .when(slot.ml > 0, (el) => el.ml(slot.ml))
      .when(slot.pl > 0, (el) => el.child(div().w(slot.pl).flex_none()))
      .child(button.on_size_change((size, cx) => measure(id, size.width, cx)))
      .when(slot.pr > 0, (el) => el.child(div().w(slot.pr).flex_none()));
  }));
}

// A grow badge's own width came in: kept, and redrawn when it changed by a
// pixel, so its clip opens to it.
function measure(id, width, cx) {
  const px = Math.ceil(width);
  if (!Number.isFinite(px) || grown.get(id) === px) return;
  grown.set(id, px);
  cx.notify();
}

// A badge as Orca draws its sidebar buttons (Spotlight's D39), what both row
// kinds share: in its tone's color, BADGE_BOX px tall and rounded; an
// icon-only badge a BADGE_BOX square, a text badge cut to its share
// (`slot.maxW`) with "…", a pill never cut. With an action, its hover shows
// the chip and lifts a dim icon (badgeHover; at once: Herdr's transition
// can't move colors), and the pointer shows while it can be clicked. A pill
// gets its border, fill and uppercase 10 px text (pillStyle); the server dot
// sits at the icon's corner or after the text (dotStyle); a "hover" reveal
// fades its opacity at BADGE_MOTION (a "grow" one fades in badgeStrip's
// clip). A badge with no icon draws no icon slot.
function badgeButton(id, b, slot, t) {
  const hover = badgeHover(b, t);
  const pill = pillStyle(b, t);
  const dot = dotStyle(b, t);
  const iconOnly = Boolean(b.icon) && !b.text;
  const color = pill?.color ?? t[b.tone] ?? t.dim;
  const corner = dot?.place === "corner";
  return h_flex().id(id).relative().flex_none().h(BADGE_BOX).items_center().rounded(4).text_color(color)
    .text_size(pill ? pill.size : 11.5)
    .when(slot.maxW !== null, (el) => el.max_w(slot.maxW))
    .when(iconOnly, (el) => el.w(BADGE_BOX).justify_center())
    .when(!iconOnly && !pill, (el) => el.gap(3).when(Boolean(b.action), (e) => e.px(4)))
    .when(Boolean(pill), (el) => el.gap(2).px(pill.px).border(1).border_color(pill.border)
      .when(pill.weight === "medium", (e) => e.font_medium())
      .when(pill.weight === "semibold", (e) => e.font_semibold())
      .when(Boolean(pill.bg), (e) => e.bg(pill.bg)))
    .when(Boolean(hover), (el) => el.hover((s) => s.bg(hover.bg).text_color(hover.color)))
    .when(Boolean(b.action) && slot.clickable, (el) => el.cursor_pointer())
    .when(b.reveal === "hover", (el) => el.opacity(slot.opacity).transition("opacity", BADGE_MOTION))
    .when(Boolean(b.icon), (el) => el.child(corner && !iconOnly
      ? h_flex().relative().flex_none().child(badgeIcon(b, BADGE_ICON)).child(dotMark(dot).absolute().bottom(-1).right(-1))
      : badgeIcon(b, pill ? PILL_ICON : BADGE_ICON)))
    .when(corner && iconOnly, (el) => el.child(dotMark(dot).absolute().bottom(-1).right(-1)))
    .when(Boolean(b.text), (el) => el.child(div().min_w(0).truncate().child(pill ? b.text.toUpperCase() : b.text)))
    .when(dot?.place === "after", (el) => el.child(dotMark(dot).when(Boolean(pill), (d) => d.ml(2))));
}

// The server dot (dotStyle): filled, or a hollow ring; it takes no clicks.
function dotMark(dot) {
  const mark = div().size(dot.size).flex_none().rounded(dot.size / 2);
  return dot.fill ? mark.bg(dot.fill) : mark.border(1).border_color(dot.ring);
}

// A badge's icon, `size` px, in the button's color, which its hover changes
// (D39: it sets no color of its own); turning when the badge asks (`spin:
// true`, Spotlight's D29: a busy mark).
function badgeIcon(b, size) {
  const pic = svg(b.icon).size(size).flex_none();
  return b.spin ? pic.spin(BADGE_SPIN) : pic;
}

// A row with a reveal badge was entered or left (D39): it is the hovered row
// now, or none; redrawn only when that changed.
function hoverRow(id, on, cx) {
  const next = on ? id : hovered === id ? null : hovered;
  if (next === hovered) return;
  hovered = next;
  cx.notify();
}

// A click moves rows (a fold, a drop): the hovered row is the clicked one
// (`id`, a lane header that tracks its hover: it stays under the pointer) or
// none. The click's own write redraws.
function rowsMoved(id) {
  hovered = id;
}

// A badge's action (D38): a mod command (no args, no answer: run returns
// null), or a program run as argv, never through a shell, with Herdr's
// environment (the login shell's PATH, a 30 s limit), in the workspace's
// folder, or the home folder for a lane's badge (badgeRun). A non-zero exit
// or a program that can't start is a warning toast. While its program
// runs, more clicks on that badge are ignored.
// `target`: { path } for a workspace row, { group, lane } for a lane header.
function runBadge(target, b, cx) {
  const { command } = b.action;
  if (command) {
    try {
      run(command);
    } catch (e) {
      notify({ title: command, body: startFailure(e), level: "warning" });
    }
    return;
  }
  const argv = b.action.exec;
  const { id, cwd } = badgeRun({ target, badge: b, home: home() });
  if (running.has(id)) return;
  running.add(id);
  cx.spawn(async () => {
    let failure;
    try {
      failure = execFailure(await exec(argv[0], argv.slice(1), { cwd }));
    } catch (e) {
      failure = startFailure(e);
    } finally {
      running.delete(id);
    }
    if (failure) notify({ title: baseName(argv[0]), body: failure, level: "warning" });
  });
}

// An agent in a workspace's space: its program, title, time since its tab
// changed and its status. Click focuses it.
function agentRow(a, t) {
  const pic = programIcon(a.program, 13, t.muted);
  return h_flex().id(`a:${a.address}`).h(24).flex_none().pl(48).pr(8).gap(7).items_center().rounded(7)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => run("pane.focus", { pane: a.pane }))
    .when(Boolean(pic), (el) => el.child(pic))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(a.title))
    .when(Boolean(a.since), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(a.since)))
    .child(statusMark(a.status, t));
}

// The narrow rail: a project's initials and the most urgent status of its spaces.
function railRow(p, t) {
  const loud = p.status === "blocked" || p.status === "done";
  return h_flex().id(`r:${p.path}`).h(28).flex_none().justify_center().items_center().gap(4)
    .cursor_pointer()
    .when(p.selected, (el) => el.bg(t.raised))
    .hover((s) => s.bg(t.hover))
    .tooltip(p.name)
    .on_click(() => go(railAction(p)))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation(); // or on_click runs too (ClickEvent carries no button)
      openProjectMenu(p.path);
    })
    .child(div().text_size(12).font_semibold().text_color(p.selected ? t.foreground : t.muted).child(p.initials))
    .child(div().text_color(t[p.status] ?? t.dim).child(loud ? "●" : "·"));
}

// Claude Code's working glyphs (S36). They change in place instead of
// turning: Herdr runs spin() at about 30 fps, which shows as a stutter, and
// frames() runs natively without that cap.
const WORKING_FRAMES = Object.freeze(["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]);
// In Claude's orange (S37), the fill of Herdr's icons/claude.svg, not the
// theme's yellow `working`.
const CLAUDE_ORANGE = "#D97757";

// mods/agents/main.js `status`: working glyphs, "!" blocked, a dot done, a ring idle.
function statusMark(status, t) {
  if (status === "working") {
    return div().size(12).flex_none().flex().items_center().justify_center().text_size(12).text_color(CLAUDE_ORANGE)
      .frames(WORKING_FRAMES, 120).child(WORKING_FRAMES[0]);
  }
  if (status === "blocked") {
    return div().size(14).flex_none().rounded(4).bg(`${t.blocked}26`).text_size(10.5).font_bold().text_color(t.blocked)
      .flex().items_center().justify_center().child("!");
  }
  if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
  return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

// The agent's icon from Herdr's program table: a one-color glyph or a picture.
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const go = (action) => run(action.name, action.args);

// ── Add project (D10) ──────────────────────────────────────────────────────

// tree-model's addProjectAt with the herdr side; a failure is a toast.
async function addFolder(folder) {
  try {
    await addProjectAt(folder, {
      resolve: repoOf,
      list: listWorktrees,
      updateRegistry: store.updateRegistry,
      cache: store.cache,
      saveWorktrees: store.saveWorktrees,
      spaces,
      panes,
      home: home(),
      run,
    });
  } catch (e) {
    notify({ title: "Add project", body: `${folder}: ${e?.message ?? e}`, level: "error" });
  }
}

// The header's "+" and `projects.add`: the system's folder picker. Needs no
// open space (S6). Inicio's Add project runs it in its own copy
// (workspace-sleep D6, R1#10).
export async function addFromPicker() {
  const folder = await pickFolder({ prompt: "Add project" });
  if (folder) await addFolder(folder);
}

// Key commands ("projects.<name>" in keys.json, or `herdr-app do projects.<name>`).
export const commands = {
  // Says which copy ran it: proves a mod command reaches the one loop.
  ping: ({ copy }) => {
    notify({ title: "projects: ping", body: `view ${props()?.view ?? "tree"}, copy ${copy}`, level: "info", timeout: 4000 });
  },
  // Add project: pick a folder.
  add: () => addFromPicker(),
  // A PR round now, or one more after the one running (D8): Mergear and
  // Crear PR ask for it after theirs. The keeper's copy runs every command
  // (workspace-sleep D7), so it leaves the ask in the store and the tree in
  // the window in front runs it at its next tick (prTick).
  "refresh-prs": () => store.askPrs(),
  // Hide sleeping on or off (workspace-sleep D8), Orca's "Toggle Sleeping
  // Workspaces", with no default key: keys.json can bind it. It runs in the
  // keeper's copy (D7), so it flips projects.ui.v1, which every tree copy
  // draws.
  "toggle-sleeping": () => store.toggleSleeping(),
  // Add project: the focused space's live folder (S5, scriptable).
  "add-here": async () => {
    const at = liveFolder(focused(), spaces(), panes());
    if (at.error) {
      notify({ title: "Add project", body: at.error, level: "warning" });
      return;
    }
    await addFolder(at.folder);
  },
};
