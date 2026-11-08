// Crear PR (S4, S5, D4, D7): on a branch without a PR, the PR card's [Crear
// PR] opens this modal dialog, S5's form in the New workspace dialog's
// pattern (the card is a fixed height, so the form can't sit in it, D4):
// Base (the project's saved base when git has it, else the repo's default
// branch, then origin's recent branches), Título (the branch's last commit's
// subject), Descripción, Draft, and the account that creates it (S2): the
// one that read the card. One view of the mod:
//   create-pr  props { project, path, seen }, seen = { owner, repo, branch,
//              defaultBranch, who } (pr-card-model.js createRequest): what
//              the card read, and `who`, the account that read it. Copies
//              never reach into each other, so it travels in the props.
//
// When it opens it asks git (git.js createPrFacts) for the title and whether
// the branch must be published first: origin doesn't have it, or lacks
// commits. Then the button says "Publicar y crear PR". A branch that split
// from origin's is never pushed (D7: never forced); the dialog says what to
// do instead.
//
// The button runs git.js createPullRequest (pr-card-model.js createPr):
// origin and the branch checked again, the push when the button said so
// (`git push -u origin <branch>`), then GitHub's REST create with the same
// account, never gh's own create command. It runs in a task no view owns,
// like Mergear's: Herdr's Esc may close even a modal dialog, and a closed
// dialog's own tasks are cancelled after 250 ms, while the push or the
// create may already be on its way. Its outcome goes to the dialog while it
// is open, else to a toast (pr-card-model.js createReport). Then the tree is
// asked for a PR round (D8, `projects.refresh-prs`): it stays the only
// writer of the sidebar's colors, and the card reads again when they
// change, so both show the new PR.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, notify } from "herdr";
import { MOD, icon } from "./config.js";
import { findProject } from "./lib.js";
import * as store from "./store.js";
import * as G from "./git.js";
import { LIST_ROWS } from "./new-workspace.js";
import { createSeenOf, createBaseOf, createBaseChoices, createPrompt, createBlocker, createReport } from "./pr-card-model.js";

// Herdr's own glyphs (shipped with every install), as the New workspace
// dialog's.
const CHEVRON = "mods/workspace-chrome/chevron-down.svg";
const CHECK = "mods/workspace-chrome/check.svg";

// The only place that opens the dialog: the card's [Crear PR] with
// createRequest's answer. modal: a click beside it doesn't close it.
export function openCreatePr({ project, path, seen }) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 480, height: 540, props: { view: "create-pr", project, path, seen } });
}

const text = (v) => (typeof v === "string" && v ? v : null);

export default class CreatePr {
  init(p, cx) {
    this.project = text(p?.project); // where gh runs (a wrapper picks the account there)
    this.path = text(p?.path); // the workspace: where git counts and pushes
    this.seen = createSeenOf(p?.seen); // null: the props aren't a branch the card read
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the create's task may outlive this copy's props
    this.busy = false; // a create runs: Esc, Cancelar and the button do nothing
    this.error = ""; // an outcome that stays in the dialog
    this.gone = false; // the dialog closed: a running create reports with a toast
    this.def = undefined; // the default base (createBaseOf); undefined while git is asked
    this.recent = []; // origin's recent branches, "origin/…"
    this.base = null; // the base picked; null: the default
    this.plan = undefined; // the branch against origin (readPushState); undefined while asked
    this.draft = false;
    this.open = false; // the Base list is open
    this.titleText = "";
    this.title = InputState.new({ placeholder: "Título del PR" });
    this.title.on("change", (_e, cx) => {
      this.titleText = this.title.value();
      this.error = "";
      cx.notify();
    });
    // ⌘↵ creates, as New workspace's; a plain Enter doesn't.
    this.title.on("submit", (e, cx) => {
      if (e?.secondary) this.submit(cx);
    });
    this.titleFocused = true;
    this.title.on("focus", (_e, cx) => { this.titleFocused = true; cx.notify(); });
    this.title.on("blur", (_e, cx) => { this.titleFocused = false; cx.notify(); });
    this.body = TextareaState.new({ placeholder: "Descripción (opcional)" });
    this.body.on("submit", (e, cx) => {
      if (e?.secondary) this.submit(cx);
    });
    this.bodyFocused = false;
    this.body.on("focus", (_e, cx) => { this.bodyFocused = true; cx.notify(); });
    this.body.on("blur", (_e, cx) => { this.bodyFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.title.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.title.focus());
    if (this.seen && this.project && this.path) this.load(cx);
  }

  // The base, the title and the push state, asked once in a spawned task.
  // The saved base (D37) counts only when git has it, by the same exact
  // lookup New workspace runs. A title typed meanwhile is kept.
  load(cx) {
    const { project, path, seen } = this;
    const saved = findProject(store.registry(), project)?.project.base ?? null;
    cx.spawn(async (cx) => {
      let has = false;
      let recent = [];
      let facts = { title: "", push: { ok: false, err: "git no respondió" } };
      try {
        [has, recent, facts] = await Promise.all([saved ? G.baseExists(project, saved) : false, G.recentBases(project), G.createPrFacts({ path, branch: seen.branch })]);
      } catch {}
      this.def = createBaseOf(saved, seen.defaultBranch, has);
      this.recent = recent ?? [];
      this.plan = facts.push;
      if (!this.titleText && facts.title) {
        this.title.set_value(facts.title);
        this.title.set_selected_range({ start: facts.title.length, end: facts.title.length });
        this.titleText = facts.title;
      }
      cx.notify();
    });
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a
  // create still running reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  ready() {
    return this.def !== undefined && this.plan !== undefined;
  }

  baseNow() {
    return this.base ?? this.def ?? "";
  }

  // Why the button is off, "" when it can run; "…" while git is asked.
  // What git says against a PR (createPrompt's warning) never turns it off:
  // the click checks again.
  blocker() {
    if (!this.seen || !this.project || !this.path) return "No hay una rama para el PR.";
    if (!this.ready()) return "…";
    return createBlocker({ seen: this.seen, base: this.baseNow(), title: this.titleText });
  }

  submit(cx) {
    if (this.busy || this.blocker()) return;
    const req = {
      project: this.project, path: this.path, seen: this.seen, base: this.baseNow(), title: this.titleText,
      body: this.body.value(), draft: this.draft, push: this.plan?.push === true,
    };
    this.busy = true;
    this.error = "";
    this.open = false;
    cx.notify();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    cx.spawn(async () => {
      let r;
      try {
        r = await G.createPullRequest(req);
      } catch (e) {
        r = { status: "failed", err: String(e?.message ?? e), pr: null, plan: null };
      }
      // D8: the tree asks GitHub for the sidebar's colors now (or once more
      // after a round already running), and the card reads again when they
      // change. Asked after every attempt: a push or an unconfirmed create
      // can change what the card shows.
      try {
        run("projects.refresh-prs");
      } catch {
        // Not delivered (the mod reloading): the next round sees it.
      }
      this.busy = false;
      if (r.plan) this.plan = r.plan; // the button says what a retry would do
      const out = createReport(r, { seen: req.seen, base: req.base, open: !this.gone });
      this.error = out.error;
      if (out.close) closeOverlay(this.overlay);
      if (out.toast) notify(out.toast);
      settle();
    }, { owner: null });
    // Redraws the dialog once the outcome is in; goes with the dialog.
    cx.spawn(async (cx) => {
      await settled;
      try {
        cx.notify();
      } catch {
        // Closed meanwhile.
      }
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.open) {
        this.open = false;
        cx.notify();
      } else this.dismiss();
      cx.stop_propagation();
    } else if (e.key === "enter" && e.modifiers?.platform) {
      this.submit(cx);
      cx.stop_propagation();
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  // Base: a trigger, and under it its list while open (New workspace's
  // select): the default first, marked, then origin's recent branches.
  baseSelect(t, base) {
    const still = (label, color) => h_flex().h(32).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(div().flex_1().min_w(0).truncate().text_color(color ?? t.dim).child(label));
    if (this.def === undefined) return still("…");
    const options = createBaseChoices(this.def, this.recent, this.seen.branch);
    if (!options.length) return still("origin no tiene otras ramas", t.blocked);
    const hint = (b) => (b && b === this.def ? "por defecto" : "");
    const open = this.open;
    return v_flex().id("cp-base").w_full()
      .when(open, (el) => el.on_mouse_down_out((_e, cx) => {
        if (!this.open) return;
        this.open = false;
        cx.notify();
      }))
      .child(h_flex().id("cp-base-trigger").h(32).px(10).gap(8).items_center().rounded(7).border_1()
        .border_color(open ? t.accent : t.input).bg(t.background).cursor_pointer()
        .on_click((_e, cx) => { if (!this.busy) this.open = !open; cx.notify(); })
        .child(svg(icon("branch")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(base ? t.foreground : t.dim).child(base || "Elige una base"))
        .when(Boolean(hint(base)), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(hint(base))))
        .child(svg(CHEVRON).size(14).flex_none().text_color(t.dim)))
      // Whole rows only (LIST_ROWS of them, 28 px each, plus the padding and
      // the border), as New workspace's; with more, the scrollbar shows.
      .when(open, (el) => el.child(v_flex().id("cp-base-list").mt(4).max_h(LIST_ROWS * 28 + 10).p(4).rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_y_scrollbar()
        .when(options.length > LIST_ROWS, (l) => l.mode("always"))
        .children(options.map((b, i) => h_flex().id(`cp-base-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(b === base, (r) => r.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.open = false;
            this.base = b === this.def ? null : b;
            this.error = "";
            this.title.focus();
            cx.notify();
          })
          .child(div().flex_1().min_w(0).truncate().child(b))
          .when(Boolean(hint(b)), (r) => r.child(div().flex_none().text_size(11).text_color(t.dim).child(hint(b))))))));
  }

  // Draft: a checkbox drawn as New workspace's (gpui-base's is unstyled).
  draftBox(t) {
    const on = this.draft;
    return h_flex().id("cp-draft").gap(8).items_center().cursor_pointer()
      .on_click((_e, cx) => { if (!this.busy) this.draft = !this.draft; cx.notify(); })
      .child(h_flex().size(16).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).items_center().justify_center()
        .when(on, (el) => el.child(svg(CHECK).size(12).text_color(t.accent_foreground))))
      .child(div().text_size(12.5).child("Draft"))
      .child(div().text_size(11).text_color(t.dim).child("GitHub lo abre como borrador"));
  }

  render() {
    const t = theme();
    const button = (id, label, primary, enabled, action, hint = "") => h_flex().id(id).h(32).px(14).gap(8).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(label)
      .when(Boolean(hint), (el) => el.child(div().text_size(11).opacity(0.7).child(hint)));
    const header = (title) => h_flex().px(18).pt(16).pb(2).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));
    const root = v_flex().id("create-pr").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);

    if (!this.seen || !this.project || !this.path) {
      return root.child(header("Crear PR"))
        .child(div().px(18).pt(14).text_color(t.dim).child("No hay una rama para el PR."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(button("cp-close", "Cerrar", false, true, () => this.dismiss())));
    }

    const base = this.baseNow();
    const p = createPrompt({ seen: this.seen, base, plan: this.plan });
    const blocker = this.blocker();
    const label = (s) => div().pt(12).pb(6).text_size(11.5).text_color(t.dim).child(s);
    const line = (s, color) => div().pt(6).text_size(11.5).text_color(color).child(s);
    const body = v_flex().id("cp-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(div().pt(4).truncate().text_color(t.muted).child(p.branches))
      .child(label("Base"))
      .child(this.baseSelect(t, base))
      .child(label("Título"))
      .child(Input.new(this.title).h(34).px(10).rounded(8).border_1().border_color(this.titleFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(label("Descripción"))
      .child(Textarea.new(this.body).h(96).px(10).py(6).rounded(8).border_1().border_color(this.bodyFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(12).child(this.draftBox(t)))
      .child(div().pt(12).text_size(11.5).text_color(t.dim).child(p.account))
      .when(Boolean(p.note), (el) => el.child(line(p.note, t.dim)))
      .when(this.busy, (el) => el.child(line(this.plan?.push ? "Publicando la rama y creando el PR…" : "Creando el PR en GitHub…", t.dim)))
      // git's warning (origin unreadable, a split branch), unless the last
      // outcome, which says the same or newer, is showing.
      .when(!this.busy && Boolean(p.warning) && !this.error, (el) => el.child(line(p.warning, t.blocked)))
      // What is left to fill (a base, a title).
      .when(!this.busy && Boolean(blocker) && blocker !== "…", (el) => el.child(line(blocker, t.dim)))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)));
    const footer = h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .child(button("cp-cancel", "Cancelar", false, !this.busy, () => this.dismiss()))
      .child(button("cp-create", this.busy ? "Creando…" : p.label, true, !this.busy && !blocker, (cx) => this.submit(cx), "⌘↵"));
    return root.child(header(p.header)).child(body).child(footer);
  }
}
