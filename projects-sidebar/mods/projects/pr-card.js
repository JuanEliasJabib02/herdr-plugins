// The PR card (S5, S6): the newest GitHub PR of the branch the right panel's
// Changes shows, drawn right above it, as Orca draws the PR atop Source
// Control. Its block, `pr-card`, is the fixed-height top of the stack child
// `changes` in layouts/projects.json (D3, D4): "PR #161 · Open" in the
// sidebar icon's color with +/−, the title, head → base with ↑↓, the checks,
// the reviews, then [Abrir en GitHub] and [Mergear ▾] (D6: the methods
// popup and the confirm dialog of merge-pr.js; drawn off, with the reason as
// its hover, when GitHub wouldn't take it). A branch without a PR says so,
// with [Crear PR] (D4, D7: the dialog of create-pr.js). The model is
// pr-card-model.js (readCard, cardState, mergeRequest, createRequest); this
// file picks the workspace, asks, and draws.
//
// Which workspace (D5): the folder Changes shows (Herdr's changes/main.js
// `location`: the focused pane's live folder, then focused()'s, then the
// space's), placed in a checkout by lib.js checkoutAt, matchSpaces' rule, so
// the card and the diff below it are about the same repo.
// When: keyed on that checkout's path and branch. A read starts when the key
// changes, and again every EVERY while the same one shows in the window in
// front, one at a time; also at once when the tree stores another PR for
// that workspace (D8: after a merge or a create, the dialog asks the tree
// for a round, so the purple or the new PR shows here too; also a PR merged
// in the browser) and when [Mergear ▾] or [Crear PR] is clicked. An
// answer whose key moved on is never drawn: it is kept for its own
// workspace, so switching back draws at once. Nothing is asked while the
// panel is closed or on the Explorer (a hidden copy's timers keep running,
// AGENTS.md): it asks again once Changes shows.
// Hidden (D9) when it has nothing to say: another machine, a folder outside
// every project, a project's main checkout (the sidebar doesn't color it
// either), or an origin that isn't GitHub. The card hides its own block
// (layout.hide), and Changes takes the whole panel until a workspace with
// something to say shows again.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces, panes, focused, layout, home, run, exec, notify, window } from "herdr";
import { icon } from "./config.js";
import { checkoutAt } from "./lib.js";
import * as store from "./store.js";
import { readPrCard } from "./git.js";
import { prMemo } from "./pr-model.js";
import { cardState, mergeRequest, createRequest } from "./pr-card-model.js";
import { openMergeMenu } from "./merge-pr.js";
import { openCreatePr } from "./create-pr.js";

// The card's block in layouts/projects.json.
const BLOCK = "pr-card";
// The shown workspace's PR is read again this often (D5).
const EVERY = 30000;
// How often the card looks at where Changes is: while its block is hidden
// nothing renders it, so this is how it notices a workspace with something
// to say. Reads nothing but Herdr's state.
const LOOK = 1000;
// Answers kept for switching back, one per workspace, the oldest dropped.
const KEPT = 50;

// The tree's word on a workspace's PR: what it stored for that path in
// projects.prs.v1 (the sidebar's color), as text to compare. The tree is
// its only writer (D8); the card only reads it.
const toldOf = (path) => JSON.stringify(store.prs()[path] ?? null);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Herdr's changes/main.js `location`, as it is: the folder Changes, drawn
// right below, shows. `on`: the machine it is on, null for this one.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// The workspace the card is about, { key, project, path, branch }, or null
// when it has nothing to say there (D9): another machine, a folder outside
// every project, or a project's main checkout.
function target() {
  const { cwd, on } = location();
  if (on) return null;
  const c = checkoutAt(store.cache(), cwd, home());
  if (!c || c.main) return null;
  return { key: JSON.stringify([c.path, c.branch]), project: c.project, path: c.path, branch: c.branch };
}

// Whether Changes shows: the panel open on it (code-explorer's isShown, for
// the stack's other child). A layout without the panel shows it as placed.
function changesShown(l) {
  if (find(l, "panel")?.hidden) return false;
  const body = find(l, "panel-body");
  return !body?.active || body.active === "changes";
}

export default class PrCard {
  init(_props, cx) {
    this.memo = prMemo(); // which account sees each owner: the card's own (a copy can't share the tree's)
    this.key = undefined; // the shown workspace's key; null: none, nothing to say
    this.target = null; // target() for that key
    this.state = null; // cardState of its last answer; null while the first is read
    this.at = 0; // when that answer came
    this.busy = false; // a read is running
    this.answers = new Map(); // workspace path → { key, state, at }: its last answer
    this.told = null; // toldOf(the shown workspace) when its last read started
    cx.timer.every(LOOK, (cx) => this.tick(cx));
  }

  // Another workspace shows: its last answer at once, when it is for the
  // same branch; else nothing until it is read.
  retarget(now) {
    this.key = now?.key ?? null;
    this.target = now;
    const kept = now ? this.answers.get(now.path) : null;
    const same = Boolean(kept) && kept.key === this.key;
    this.state = same ? kept.state : null;
    this.at = same ? kept.at : 0;
    this.told = now ? toldOf(now.path) : null;
  }

  // Follows Changes to its workspace, shows or hides the block, and reads
  // when one is due and Changes shows.
  tick(cx) {
    const now = target();
    if ((now?.key ?? null) !== this.key) {
      this.retarget(now);
      cx.notify();
    }
    this.place();
    if (!this.target || !changesShown(layout())) return;
    // A shown answer is read again every EVERY only from the window in front,
    // as the sidebar's colors (D1): Juan keeps several windows open. A new
    // workspace is read in any window; coming back to the front reads at once.
    // The tree storing another PR for it (D8) reads it at once, in any window.
    const told = toldOf(this.target.path);
    if (this.state && told === this.told && (Date.now() - this.at < EVERY || !window().active)) return;
    this.read(cx);
  }

  // [Mergear ▾] (D6): the methods popup, handed what the card read and the
  // account that read it (mergeRequest), and a read now, so the card is
  // fresh again by the time the dialog is done.
  merge(cx) {
    const req = mergeRequest(this.state, this.target?.project);
    if (!req) return;
    openMergeMenu(req);
    this.read(cx);
  }

  // [Crear PR] (D4, D7): the create dialog, handed the branch, its repo and
  // the account that read it (createRequest), and a read now, as Mergear's.
  create(cx) {
    const req = createRequest(this.state, this.target);
    if (!req) return;
    openCreatePr(req);
    this.read(cx);
  }

  // One read of the shown workspace. Its answer is kept for that workspace,
  // and drawn only if it is still the one shown; then the tick reads the one
  // shown now, if Changes moved on meanwhile.
  read(cx) {
    if (this.busy) return;
    const { key, target: ws } = this;
    this.busy = true;
    this.told = toldOf(ws.path);
    cx.spawn(async (cx) => {
      let data;
      try {
        data = await readPrCard(ws, this.memo);
      } catch {
        // readCard never rejects. Should it, the card says GitHub didn't
        // answer and asks again in EVERY, not on every tick.
        data = { status: "failed", unseen: false, repo: null };
      } finally {
        this.busy = false;
      }
      const answer = { key, state: cardState(data), at: Date.now() };
      this.answers.delete(ws.path);
      this.answers.set(ws.path, answer);
      if (this.answers.size > KEPT) this.answers.delete(this.answers.keys().next().value);
      if (this.key === key) {
        this.state = answer.state;
        this.at = answer.at;
      }
      this.tick(cx);
      cx.notify();
    });
  }

  // D9: the block shows while the card has something to say and hides when
  // it hasn't; while a workspace's first answer is read it stays as it is.
  // Only a change is run: each one is a layout click Herdr saves.
  place() {
    const say = !this.target ? false : this.state ? this.state.kind !== "not-github" : null;
    if (say === null) return;
    const node = find(layout(), BLOCK);
    if (!node) return;
    try {
      if (say && node.hidden) run("layout.show", { id: BLOCK });
      else if (!say && !node.hidden) run("layout.hide", { id: BLOCK });
    } catch {
      // The layout isn't there to change (another machine's, unavailable).
    }
  }

  render(cx) {
    const now = target();
    if ((now?.key ?? null) !== this.key) {
      this.retarget(now);
      cx.spawn(async (cx) => this.tick(cx));
    }
    const t = theme();
    const s = this.target ? this.state : null;
    // About to hide: nothing to draw.
    if (!this.target || s?.kind === "not-github") return div().size_full();
    const box = v_flex().id("pr-card").size_full().min_h(0).overflow_hidden().rounded(10).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(12.5);
    if (!s) return box.items_center().justify_center().child(div().text_color(t.dim).child("Leyendo el PR…"));
    if (s.kind !== "pr") return box.child(note(s, t, s.kind === "none" ? (cx) => this.create(cx) : null));
    return box.p(12).justify_between().children(prRows(s, t, (cx) => this.merge(cx)));
  }
}

// A branch without a PR, or a card that can't show one: one line, centered,
// and the branch under it when there is one. create(cx): [Crear PR]'s
// click, given only on a branch without a PR (D4: the form is a dialog).
function note(s, t, create) {
  return v_flex().size_full().px(16).gap(6).items_center().justify_center()
    .child(h_flex().max_w(320).gap(7).items_center()
      .child(svg(icon("branch")).size(13).flex_none().text_color(t.dim))
      .child(div().min_w(0).truncate().text_color(t[s.color] ?? t.muted).child(s.text)))
    .when(Boolean(s.branch), (el) => el.child(div().max_w(320).truncate().text_size(11.5).text_color(t.dim).child(s.branch)))
    .when(Boolean(create), (el) => el.child(div().id("pr-create").mt(6).h(26).px(10).flex().items_center().rounded(6).text_size(12)
      .bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
      .hover((st) => st.opacity(0.88))
      .on_click((_e, cx) => create(cx))
      .child("Crear PR")));
}

// S5's rows: the header in the PR's color with +/−, the title, head → base
// with ↑↓, Checks, Reviews, then the buttons. merge(cx): [Mergear ▾]'s click.
function prRows(s, t, merge) {
  const color = t[s.color] ?? t.dim;
  return [
    h_flex().h(20).flex_none().gap(7).items_center()
      .child(svg(icon("branch")).size(13).flex_none().text_color(color))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(color).child(s.header))
      .child(div().flex_none().text_size(11).text_color(t.ansi2).child(s.added))
      .child(div().flex_none().text_size(11).text_color(t.ansi1).child(s.removed)),
    div().h(20).flex_none().truncate().text_size(13).child(s.title),
    h_flex().h(18).flex_none().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.branches))
      .when(Boolean(s.sync), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(s.sync))),
    line("Checks", s.checks, t),
    line("Reviews", s.reviews, t),
    h_flex().h(26).flex_none().gap(8).items_center()
      .child(div().id("pr-open").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border)
        .text_size(12).cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => openPr(s.url, cx))
        .child("Abrir en GitHub"))
      // Mergear (D6): the methods popup while GitHub would take it; else
      // drawn off, its hover saying why not.
      .child(div().id("pr-merge").h(26).px(10).flex().items_center().rounded(6).text_size(12)
        .when(Boolean(s.merge?.enabled), (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .hover((st) => st.opacity(0.88))
          .on_click((_e, cx) => merge(cx)))
        .when(!s.merge?.enabled, (el) => el.bg(t.raised).text_color(t.dim))
        .when(Boolean(s.merge?.reason), (el) => el.tooltip(s.merge.reason))
        .child("Mergear ▾")),
  ];
}

// "Checks  ✓ 5 de 5 pasan": the label, then the model's line in its color.
function line(label, { text, color }, t) {
  return h_flex().h(18).flex_none().gap(8).items_center()
    .child(div().w(56).flex_none().text_color(t.dim).child(label))
    .child(div().flex_1().min_w(0).truncate().text_color(t[color] ?? t.dim).child(text));
}

// [Abrir en GitHub] (D10): `open <url>`, not cx.open_url, so arc-spaces'
// wrapper can send it to the Arc space of the workspace's group, where that
// group's GitHub account is signed in (S2). Only a GitHub URL reaches it
// (cardState's url passed prOf's check; this keeps anything else, a "-…"
// flag included, from ever being handed to open). A failure is a toast.
function openPr(url, cx) {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) return;
  cx.spawn(async () => {
    let failure = null;
    try {
      const r = await exec("open", [url]);
      if (r.code !== 0) failure = (r.stderr || r.stdout || "").trim() || `open exited ${r.code}`;
    } catch (e) {
      failure = String(e?.message ?? e);
    }
    if (failure) notify({ title: "Abrir en GitHub", body: failure, level: "warning" });
  });
}
