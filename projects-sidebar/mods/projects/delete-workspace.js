// The Delete dialog (S20–S21, D22), opened from a workspace's right-click
// menu with props { project, path }. On open it asks git what the deletion
// would take (removalCheck, D24): Delete stays off until git answers, a
// locked worktree has no Delete, and changes or submodules turn it into
// "Delete anyway". Delete runs removeWorkspace in D23's order (check again,
// close the spaces, git worktree remove, git branch -d) in a task no view
// owns: Herdr's Esc may close even a modal dialog, and a closed dialog's own
// tasks are cancelled after 250 ms, which would cut the sequence between
// closing the spaces and removing the folder. Its outcome goes to the dialog
// while it is open, else to a toast. What it says and what an outcome does
// live in tree-model.js (deletePrompt, deleteOutcome).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, spaces, panes, home, notify } from "herdr";
import { MOD } from "./config.js";
import { normPath, matchSpaces } from "./lib.js";
import * as store from "./store.js";
import { removalCheck, removeWorkspace } from "./git.js";
import { spacesToClose } from "./remove-workspace-model.js";
import { deletePrompt, deleteOutcome, terminalsStaying } from "./tree-model.js";

// After space.close, git removes the folder only once spaces() no longer
// lists the closed spaces: looked at this often, for at most this long (a
// bounded wait, like tree.js's SETTLE after a watch wakes).
const CLOSE_STEP = 100;
const CLOSE_WAIT = 3000;

// The only place that opens the dialog. modal: a click beside it doesn't
// close it.
export function openDeleteWorkspace(project, path) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 380, height: 320, props: { view: "delete-workspace", project, path } });
}

// The spaces that show the workspace at `path` now (D7's matching): they
// close with it.
const closingSpaces = (path) => spacesToClose(matchSpaces(store.cache(), spaces(), panes(), home()), path);

// D23 step 2: closes the workspace's spaces (asked at this moment, so one
// opened since the dialog did closes too), then waits until spaces() no
// longer lists them, bounded. A space.close that throws rejects, before
// anything was removed (removeWorkspace reports it); the wait itself never
// rejects: a sleep that throws (a reloaded build) only ends the wait.
async function closeSpaces(path, cx) {
  const ids = closingSpaces(path);
  for (const id of ids) run("space.close", { id, confirmed: true });
  for (let waited = 0; waited < CLOSE_WAIT; waited += CLOSE_STEP) {
    if (!spaces().some((s) => ids.includes(s.id))) return;
    try {
      await cx.sleep(CLOSE_STEP);
    } catch {
      return;
    }
  }
}

export default class DeleteWorkspace {
  init(p, cx) {
    this.project = p?.project ? normPath(p.project) : null;
    this.path = p?.path ? normPath(p.path) : null;
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the delete's task may outlive this copy's props
    this.check = null; // removalCheck's answer; null while git is asked
    this.busy = false; // a delete runs: Esc, Cancel and Delete do nothing
    this.error = ""; // an outcome that stays in the dialog
    this.gone = false; // the dialog closed: a running delete reports with a toast
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    if (!this.project || !this.path) return;
    cx.spawn(async (cx) => {
      this.check = await removalCheck({ project: this.project, path: this.path });
      cx.notify();
    });
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a
  // delete still running reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  // The checkout as git listed it on open, else as the tree has it.
  row() {
    const fresh = this.check?.list?.find((c) => c.path === this.path);
    if (fresh) return fresh;
    return (store.cache()[this.project] ?? []).find((c) => normPath(c.path) === this.path) ?? null;
  }

  prompt() {
    const ids = closingSpaces(this.path);
    return deletePrompt({
      path: this.path,
      row: this.row(),
      check: this.check,
      spaces: ids.length,
      terminals: terminalsStaying(this.path, ids, spaces(), panes(), home()),
      home: home(),
    });
  }

  submit(cx) {
    const shown = this.prompt();
    if (this.busy || !shown.ready) return;
    const { project, path } = this;
    const seen = this.check; // what the person confirmed: "Delete anyway" forces once
    this.busy = true;
    this.error = "";
    cx.notify();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    cx.spawn(async (bg) => {
      let r;
      try {
        r = await removeWorkspace({ project, path, seen }, { closeSpaces: () => closeSpaces(path, bg) });
      } catch (e) {
        r = { status: "failed", err: String(e?.message ?? e), branch: null, branchErr: null, list: null, check: null };
      }
      // D23 step 5: the row goes at once (the .git watch only wakes later).
      if (r.list) store.saveWorktrees(project, r.list);
      this.busy = false;
      const out = deleteOutcome(r, { label: shown.label, open: !this.gone });
      if (out.check) this.check = out.check;
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
    if (e.key !== "escape") return;
    cx.stop_propagation();
    this.dismiss();
  }

  render() {
    const t = theme();
    const root = v_flex().id("delete-workspace").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);
    const button = (id, text, danger, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(danger ? t.blocked : t.input).bg(danger ? `${t.blocked}1f` : t.raised)
      .text_color(danger ? t.blocked : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    const header = (title) => h_flex().px(18).pt(16).pb(4).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));

    if (!this.project || !this.path) {
      return root.child(header("Delete workspace"))
        .child(div().px(18).pt(10).text_color(t.dim).child("No workspace."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(button("dw-close", "Close", false, true, () => this.dismiss())));
    }

    const p = this.prompt();
    const line = (text, color) => div().pt(8).text_color(color).child(text);
    const body = v_flex().id("dw-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(div().text_size(12).text_color(t.dim).truncate().child(p.path))
      .when(Boolean(p.branch), (el) => el.child(line(p.branch, t.muted)))
      .children(p.notes.map((n) => line(n, t.foreground)))
      .children(p.warnings.map((w) => line(w, t.blocked)))
      .when(Boolean(p.reason), (el) => el.child(line(p.reason, t.blocked)))
      .when(p.checking, (el) => el.child(line("Checking with git…", t.dim)))
      .when(Boolean(this.error), (el) => el.child(line(this.error, t.blocked)));
    const footer = h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .child(button("dw-cancel", "Cancel", false, !this.busy, () => this.dismiss()))
      .when(Boolean(p.button), (el) => el.child(button("dw-delete", this.busy ? "Deleting…" : p.button, true, p.ready && !this.busy, (cx) => this.submit(cx))));
    return root.child(header(p.title)).child(body).child(footer);
  }
}
