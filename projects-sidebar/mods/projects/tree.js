// The projects tree, in the layout's Spaces block: the active group's
// projects, each with its workspaces (git worktrees) and the agents in their
// spaces (S10, S11). Spaces outside every project show nowhere (S14, S15).
// Click a workspace to go to its space or open one (D8); "+" in the header
// adds a project (D10), "+" on a project opens New workspace; right-click a
// project for its menu. Below 160 px of sidebar it is a rail of initials.
//
// This copy is also the worktree engine (D6): it lists every group's
// projects into projects.cache.v1 at start, re-lists one when its
// .git/worktrees (or .git) changes, and every minute while the window is in
// front. The model is tree-model.js; this file draws it and wires herdr in.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, notify, run, spaces, panes, agents, focused, layout, home, window, pickFolder, watchFolder,
} from "herdr";
import { icon } from "./config.js";
import { findProject } from "./lib.js";
import * as store from "./store.js";
import { repoOf, listWorktrees } from "./git.js";
import {
  buildTree, openAction, railAction, isNarrow, projectPaths, pruneCache, watchDirs, eachLimit, liveFolder, addProjectAt,
} from "./tree-model.js";
import { openNewWorkspace } from "./new-workspace.js";
import { openProjectMenu } from "./project-menu.js";

// git listings at once (Juan has ~30 projects).
const LISTERS = 4;
// Changes made outside a watch's reach: looked for this often, while the
// window is in front (mods/spaces/main.js FALLBACK).
const FALLBACK = 60000;
// After a watch wakes: a worktree add writes several files; list once after.
const SETTLE = 500;

// Herdr's shipped chrome icons (chevrons, the spinner): there in every install.
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;

export default class Tree {
  init(_props, cx) {
    this.known = new Map(); // project path -> the token of its watch loop
    this.token = 0;
    this.failed = new Set(); // projects git couldn't list last time (folder gone)
    this.sync(cx);
    // New or removed projects (Add project here, the project menu in its popup).
    cx.timer.every(1000, (cx) => this.sync(cx));
    cx.timer.every(FALLBACK, (cx) => {
      if (window().active) this.listAll(cx);
    });
    // The agents' "time since" moves on its own.
    cx.timer.every(30000, (cx) => cx.notify());
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

  // ── Drawing ──────────────────────────────────────────────────────────────

  render() {
    const t = theme();
    const narrow = isNarrow(layout());
    const model = buildTree({
      registry: store.registry(),
      cache: store.cache(),
      spaces: spaces(),
      panes: panes(),
      agents: agents(),
      collapsed: store.ui().collapsed,
      home: home(),
      now: Date.now(),
      failed: this.failed,
    });
    const body = model.empty
      ? narrow ? [] : [emptyState(t)]
      : narrow ? model.projects.map((p) => railRow(p, t)) : model.rows.map((r) => row(r, t));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(header(model.group, narrow, t))
      .child(v_flex().id("projects-list").flex_1().min_h(0).px(narrow ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").children(body));
  }
}

function header(group, narrow, t) {
  return h_flex().h(31).flex_none().items_center().gap(6).text_size(11.5).text_color(t.dim)
    .when(narrow, (el) => el.justify_center())
    .when(!narrow, (el) => el.pl(16).pr(10).child(div().flex_1().min_w(0).truncate().child(group.name === "Projects" ? "Projects" : `Projects · ${group.name}`)))
    .child(div().id("projects-add").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Add project")
      .on_click((_e, cx) => cx.spawn(async () => addFromPicker()))
      .child(svg(icon("plus")).size(14)));
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

function row(r, t) {
  if (r.kind === "project") return projectRow(r, t);
  if (r.kind === "workspace") return workspaceRow(r, t);
  if (r.kind === "agent") return agentRow(r, t);
  const text = r.kind === "missing" ? "Can't read this folder." : "Loading…";
  return div().id(`${r.kind}:${r.project}`).h(28).flex_none().pl(48).flex().items_center().text_size(12).text_color(t.dim).child(text);
}

// A project: collapse on click, its menu on right-click, "+" for a new workspace.
function projectRow(p, t) {
  return h_flex().id(`p:${p.path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(8)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => store.toggleCollapsed(p.path))
    .on_mouse_down("right", () => openProjectMenu(p.path))
    .child(svg(chrome(p.collapsed ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
    .child(svg(icon("folder")).size(14).flex_none().text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(p.name))
    .when(p.collapsed && Boolean(p.status) && p.status !== "idle", (el) => el.child(statusMark(p.status, t)))
    .child(div().id(`p+:${p.path}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New workspace")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openNewWorkspace(p.path);
      })
      .child(svg(icon("plus")).size(12)));
}

// A workspace: home (main checkout) or branch icon, or its agent's status in
// that place; the open dot when it has a space; highlighted when shown.
function workspaceRow(w, t) {
  const busy = Boolean(w.status) && w.status !== "idle";
  const lead = busy ? statusMark(w.status, t) : svg(icon(w.main ? "home" : "branch")).size(13).flex_none().text_color(t.dim);
  return h_flex().id(`w:${w.path}`).h(28).flex_none().pl(26).pr(8).gap(8).items_center().rounded(8)
    .cursor_pointer()
    .when(w.selected, (el) => el.bg(t.selected))
    .when(!w.selected, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click(() => go(openAction(w)))
    .child(h_flex().w(14).flex_none().items_center().justify_center().child(lead))
    .child(div().flex_1().min_w(0).truncate().text_color(w.open ? t.foreground : t.muted).child(w.label))
    .when(w.open, (el) => el.child(div().size(6).flex_none().rounded(3).bg(w.selected ? t.accent : t.muted)));
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
    .on_mouse_down("right", () => openProjectMenu(p.path))
    .child(div().text_size(12).font_semibold().text_color(p.selected ? t.foreground : t.muted).child(p.initials))
    .child(div().text_color(t[p.status] ?? t.dim).child(loud ? "●" : "·"));
}

// mods/agents/main.js `status`: a spinner working, "!" blocked, a dot done, a ring idle.
function statusMark(status, t) {
  if (status === "working") return svg(chrome("spinner")).size(12).flex_none().text_color(t.working).spin(900);
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
// open space (S6).
async function addFromPicker() {
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
