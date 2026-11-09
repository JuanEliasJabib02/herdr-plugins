// Mergear (S4, S5, D6): the PR card's [Mergear ▾] opens a popup with the
// merge methods the repo allows, squash first; picking one opens a modal
// confirm dialog that names the PR, its base, the method and the account
// that merges (S2). Two views of the mod:
//   merge-menu  the popup, props { project, seen, title, methods }
//   merge-pr    the dialog, props { project, seen, title }, seen with the
//               method picked
// seen = { owner, repo, number, head, headOid, base, method, who }: what the
// card read (pr-card-model.js mergeRequest), and `who`, the account that
// read it. Copies never reach into each other, so it travels in the props.
//
// Mergear in the dialog runs git.js mergePullRequest (pr-card-model.js
// mergePr): the PR read again with that account and refused when it changed
// since the card read it, then GitHub's REST merge with the same account,
// pinned to the head commit the card showed. Never gh's own merge command
// (from a worktree it fails checking out the base), and the branch is never
// deleted (Delete workspace does that). It runs in a task no view owns, like
// the Delete dialog's: Herdr's Esc may close even a modal dialog, and a
// closed dialog's own tasks are cancelled after 250 ms, while the merge
// may already be on its way. Its outcome goes to the dialog while it is
// open, else to a toast (pr-card-model.js mergeReport). Then the tree is
// asked for a PR round (D8, `projects.refresh-prs`): it stays the only
// writer of the sidebar's colors, and the card reads again when they change.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, notify } from "herdr";
import { MOD } from "./config.js";
import { mergePullRequest } from "./git.js";
import { mergeMenuItems, seenOf, mergePrompt, mergeReport } from "./pr-card-model.js";

// A popup row's height, as in workspace-menu.js.
const ROW = 31;

// The only place that opens the popup, at the pointer: the card's [Mergear
// ▾] with mergeRequest's answer. A popup is as tall as its items; height is
// only the most (the title and three methods).
export function openMergeMenu({ project, seen, title, methods }) {
  return openOverlay({ mod: MOD, kind: "popup", width: 240, height: 3 * ROW + 50, props: { view: "merge-menu", project, seen, title, methods } });
}

// The only place that opens the dialog. modal: a click beside it doesn't
// close it.
export function openMergePr({ project, seen, title }) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 400, height: 300, props: { view: "merge-pr", project, seen, title } });
}

// The popup: one row per method (mergeMenuItems). ↑/↓ move, Enter or a
// click picks (it closes and opens the dialog), Esc closes.
export class MergeMenu {
  init(p, cx) {
    this.project = p?.project ?? null;
    this.seen = p?.seen ?? null; // checked by the dialog (seenOf)
    this.title = p?.title ?? "";
    this.items = mergeMenuItems(p?.methods);
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  choose(item) {
    if (!item || !this.seen) return;
    this.close();
    openMergePr({ project: this.project, seen: { ...this.seen, method: item.method }, title: this.title });
  }

  key(e, cx) {
    const n = this.items.length;
    if (e.key === "escape") this.close();
    else if (e.key === "down" && n) this.at = (this.at + 1) % n;
    else if (e.key === "up" && n) this.at = (this.at + n - 1) % n;
    else if (e.key === "enter") this.choose(this.items[this.at]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const s = this.seen;
    const named = Number.isInteger(s?.number) && typeof s?.base === "string" ? `Mergear PR #${s.number} en ${s.base}` : "Mergear";
    const empty = !s ? "Nada que mergear." : "El repo no permite mergear.";
    return v_flex()
      .id("merge-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(named))
      .when(!s || this.items.length === 0, (el) => el.child(div().px(8).pb(6).text_color(t.dim).child(empty)))
      .when(Boolean(s), (el) => el.children(this.items.map((it, i) =>
        h_flex()
          .id(`mm-${it.method}`)
          .h(ROW)
          .px(8)
          .rounded(7)
          .items_center()
          .text_color(t.foreground)
          .when(i === this.at, (r) => r.bg(t.selected))
          .cursor_pointer()
          .hover((st) => st.bg(t.hover))
          .on_click(() => this.choose(it))
          .child(div().flex_1().min_w(0).truncate().child(it.label)))));
  }
}

// The confirm dialog.
export default class MergePr {
  init(p, cx) {
    this.project = typeof p?.project === "string" && p.project ? p.project : null;
    this.seen = seenOf(p?.seen); // null: the props aren't a PR the card read
    this.title = typeof p?.title === "string" ? p.title : "";
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the merge's task may outlive this copy's props
    this.busy = false; // a merge runs: Esc, Cancelar and Mergear do nothing
    this.error = ""; // an outcome that stays in the dialog
    this.changed = false; // the PR changed since the card read it: Mergear is off (the card reads again)
    this.gone = false; // the dialog closed: a running merge reports with a toast
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a
  // merge still running reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  submit(cx) {
    if (this.busy || this.changed || !this.seen || !this.project) return;
    const { project, seen } = this;
    this.busy = true;
    this.error = "";
    cx.notify();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    cx.spawn(async () => {
      let r;
      try {
        r = await mergePullRequest({ project, seen });
      } catch (e) {
        r = { status: "failed", err: String(e?.message ?? e), note: "" };
      }
      // D8: the tree asks GitHub for the sidebar's colors now (or once more
      // after a round already running), and the card reads again when they
      // change. Asked after every attempt: even a refusal can mean the PR
      // isn't what the card shows.
      try {
        run("projects.refresh-prs");
      } catch {
        // Not delivered (the mod reloading): the next round sees it.
      }
      this.busy = false;
      this.changed = r.status === "changed";
      const out = mergeReport(r, { seen, open: !this.gone });
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

  // Esc only, as the Delete dialog: an irreversible action takes a click,
  // never the Enter that picked the method in the popup.
  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    this.dismiss();
  }

  render() {
    const t = theme();
    const root = v_flex().id("merge-pr").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    const header = (title) => h_flex().px(18).pt(16).pb(4).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));

    if (!this.seen || !this.project) {
      return root.child(header("Mergear"))
        .child(div().px(18).pt(10).text_color(t.dim).child("No hay un PR que mergear."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(button("mp-close", "Cerrar", false, true, () => this.dismiss())));
    }

    const p = mergePrompt(this.seen, this.title);
    const line = (text, color) => div().pt(8).text_color(color).child(text);
    const body = v_flex().id("mp-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .when(Boolean(p.title), (el) => el.child(div().pt(4).truncate().child(p.title)))
      // head → base as the card draws it (J-011): the head truncates on its
      // own and "→ base" never shrinks, so a long head never hides the base.
      .child(h_flex().pt(8).min_w(0).gap(4).items_center().text_color(t.muted)
        .child(div().min_w(0).truncate().child(this.seen.head))
        .child(div().flex_none().child(`→ ${this.seen.base}`)))
      .child(line(p.method, t.foreground))
      .child(line(p.account, t.dim))
      .child(line(p.note, t.dim))
      .when(this.busy, (el) => el.child(line("Comprobando el PR con GitHub y mergeando…", t.dim)))
      .when(Boolean(this.error), (el) => el.child(line(this.error, t.blocked)));
    const footer = h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .child(button("mp-cancel", this.changed ? "Cerrar" : "Cancelar", false, !this.busy, () => this.dismiss()))
      .when(!this.changed, (el) => el.child(button("mp-merge", this.busy ? "Mergeando…" : "Mergear", true, !this.busy, (cx) => this.submit(cx))));
    return root.child(header(p.header)).child(body).child(footer);
  }
}
