// The Delete task dialog (S30, D36), opened from a task lane's menu with
// props { lane, label }: it deletes every workspace of the lane in the
// active group (Orca: the lane's worktrees, main checkouts excluded), one at
// a time. Opened from an agent's Delete… in the Agents list (workspace-
// menu.js), props carry `group` too: the lane in the workspace's own group,
// which may not be the active one.
//   - On open it takes the lane's workspaces once (task-model.js
//     laneTargets), so one created after it opened is never deleted, and
//     asks git about each (removalCheck, a few at once).
//   - Each row says what its delete would take, as the Delete dialog does
//     (tree-model.js deletePrompt, through deleteTaskPrompt): changes that
//     would be lost, or why it can't run (locked, couldn't check, not a
//     workspace). Only the ready rows run. A row with changes makes the
//     button "Delete anyway", which forces that row only.
//   - The run (remove-workspace-model.js removeTask: D23's whole sequence
//     per workspace, other plugins' remove hooks included, run with each
//     workspace's path) lives in a task no view owns, like the Delete
//     dialog's (D22): Herdr's Esc may close even a modal dialog, and a closed
//     dialog's tasks are cancelled. It outlives the dialog; a reload stops
//     it between workspaces. Every row stores its fresh list as it goes, so
//     the tree drops it at once.
//   - Every workspace that ran removed: the dialog closes, a toast says so,
//     and the task's note goes once nothing was skipped and no other
//     workspace, in any group, has the task (taskStillUsed). Otherwise each
//     row keeps its outcome and the dialog waits for Close; closed by then,
//     one toast says how many went and the first failure.
//   props: { view: "delete-task", lane: "task:AX-3653", label: "AX-3653", group?: "g2" }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, spaces, panes, home, notify } from "herdr";
import { MOD } from "./config.js";
import { normPath, noteKeyOf } from "./lib.js";
import * as store from "./store.js";
import { removalCheck, removeTask } from "./git.js";
import { closeSpaces, closingSpaces } from "./delete-workspace.js";
import { terminalsStaying, eachLimit } from "./tree-model.js";
import { laneTargets, deleteTaskPrompt, deleteTaskOutcome, taskRowOutcome, taskStillUsed } from "./task-model.js";

// removalChecks at once while the dialog opens, as many as the tree's
// listings (tree.js LISTERS).
const CHECKS = 4;

// The only place that opens the dialog. modal: a click beside it doesn't
// close it. `group`: the group whose lane it deletes; null, the active one.
export function openDeleteTask(lane, label, group = null) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 400, height: 380, props: { view: "delete-task", lane, label, ...(group ? { group } : {}) } });
}

export default class DeleteTask {
  init(p, cx) {
    this.lane = p?.lane ?? null;
    this.label = p?.label || noteKeyOf(this.lane) || "";
    this.group = typeof p?.group === "string" && p.group ? p.group : null; // null: the active group
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the run may outlive this copy's props
    // Taken once: a workspace created after the dialog opened is never deleted.
    this.targets = this.lane ? laneTargets(store.registry(), store.cache(), this.lane, this.group) : [];
    this.checks = this.targets.map(() => null); // removalCheck per target; null while git is asked
    this.outcomes = this.targets.map(() => null); // taskRowOutcome per target, once it ran
    this.running = new Set(); // targets handed to the run that haven't finished
    this.busy = false; // the run is on: Esc, Cancel and Delete do nothing
    this.done = false; // the run ended and the dialog stayed: only Close
    this.error = ""; // how many went, when not all did
    this.gone = false; // the dialog closed: the run reports with a toast
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    if (this.targets.length === 0) return;
    cx.spawn(async (cx) => {
      await eachLimit(this.targets, CHECKS, async (t, i) => {
        this.checks[i] = await removalCheck({ project: t.project, path: t.path });
        cx.notify();
      });
    });
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a run
  // still going reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  // A target's checkout as git listed it on open, else as the tree has it.
  row(target, i) {
    const fresh = this.checks[i]?.list?.find((c) => c.path === target.path);
    if (fresh) return fresh;
    return (store.cache()[target.project] ?? []).find((c) => normPath(c.path) === target.path) ?? null;
  }

  // deleteTaskPrompt over the targets, with what closes and stays now: each
  // target's spaces (asked at this moment, like the Delete dialog), and the
  // terminals in its folder outside every space that closes.
  prompt() {
    const all = spaces();
    const pn = panes();
    const h = home();
    const ids = this.targets.map((t) => closingSpaces(t.path));
    const closing = ids.flat();
    return deleteTaskPrompt({
      label: this.label,
      home: h,
      rows: this.targets.map((t, i) => ({
        path: t.path,
        row: this.row(t, i),
        check: this.checks[i],
        projectName: t.projectName,
        spaces: ids[i].length,
        terminals: terminalsStaying(t.path, closing, all, pn, h),
      })),
    });
  }

  submit(cx) {
    const shown = this.prompt();
    if (this.busy || this.done || !shown.ready) return;
    // The ready rows run, each with the check it showed: "Delete anyway"
    // forces only the rows that had changes or submodules.
    const run = [];
    const skipped = [];
    shown.rows.forEach((r, i) => (r.ready ? run.push(i) : skipped.push(r)));
    const targets = run.map((i) => ({ project: this.targets[i].project, path: this.targets[i].path, seen: this.checks[i] }));
    const label = this.label;
    const key = noteKeyOf(this.lane);
    // Other plugins' workspace hooks (Spotlight's D43), run for each target
    // after its check and before its spaces close.
    const hooks = store.removeHooks().workspace;
    this.busy = true;
    this.error = "";
    for (const i of run) this.running.add(i);
    cx.notify();

    // The run's own cx belongs to no view, so its notify doesn't redraw the
    // dialog: this task, which goes with the dialog, does, after every
    // target and once at the end. `count` keeps a wake that came early.
    const pulse = { count: 0, wake: null };
    const redraw = () => {
      pulse.count += 1;
      pulse.wake?.();
    };
    cx.spawn(async (cx) => {
      let seen = 0;
      for (;;) {
        if (pulse.count === seen) await new Promise((resolve) => { pulse.wake = resolve; });
        seen = pulse.count;
        try {
          cx.notify();
        } catch {
          return; // closed meanwhile
        }
        if (!this.busy) return;
      }
    });

    cx.spawn(async (bg) => {
      let results;
      try {
        results = await removeTask({ targets }, {
          hooks,
          closeSpaces: (target) => closeSpaces(target.path, bg),
          // D23 step 5, per target: its row goes from the tree at once.
          each: (r, i) => {
            if (r.list) store.saveWorktrees(r.project, r.list);
            this.running.delete(run[i]);
            this.outcomes[run[i]] = taskRowOutcome(r);
            redraw();
          },
          // A reload ends this task: bg.sleep then throws, and the rest stop.
          alive: () => bg.sleep(0),
        });
      } catch (e) {
        // removeTask never rejects; this keeps the dialog's state whole anyway.
        results = targets.map((t) => ({ project: t.project, path: t.path, status: "failed", err: String(e?.message ?? e), branch: null, branchErr: null, list: null, check: null }));
      }
      const named = results.map((r, i) => ({ ...r, label: this.targets[run[i]].label, projectName: this.targets[run[i]].projectName }));
      const out = deleteTaskOutcome(named, { label, skipped, open: !this.gone });
      // The note goes with the task (Orca's task-note-delete-cleanup): only
      // when every workspace went, none was skipped, and no other
      // workspace, in any group, has the task.
      if (out.done && key && !taskStillUsed(store.cache(), key)) store.setNote(key, "");
      out.rows.forEach((o, i) => { this.outcomes[run[i]] = o; });
      this.running.clear();
      this.error = out.error;
      this.busy = false;
      this.done = !out.close;
      if (out.close) closeOverlay(this.overlay);
      if (out.toast) notify(out.toast);
      redraw();
    }, { owner: null });
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    this.dismiss();
  }

  render() {
    const t = theme();
    const root = v_flex().id("delete-task").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);
    const button = (id, text, danger, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(danger ? t.blocked : t.input).bg(danger ? `${t.blocked}1f` : t.raised)
      .text_color(danger ? t.blocked : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    const header = (title) => h_flex().px(18).pt(16).pb(2).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));
    const closeOnly = (text) => root.child(header("Delete task"))
      .child(div().px(18).pt(10).text_color(t.dim).child(text))
      .child(div().flex_1())
      .child(h_flex().px(18).py(14).justify_end().child(button("dt-close", "Close", false, true, () => this.dismiss())));

    if (!this.lane) return closeOnly("No task.");
    if (this.targets.length === 0) return closeOnly(`${this.label} has no workspaces.`);

    const p = this.prompt();
    const first = this.running.size ? Math.min(...this.running) : -1; // the one deleting now: they go in order
    const line = (text, color) => div().pt(3).text_size(12).text_color(color).child(text);
    const row = (r, i) => {
      const o = this.outcomes[i];
      const status = o ? o.text : this.running.has(i) ? (i === first ? "Deleting…" : "Waiting…") : r.checking ? "Checking with git…" : "";
      const failed = Boolean(o) && o.status !== "removed";
      return v_flex().id(`dt-row-${i}`).pt(10)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().child(r.label))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.projectName)))
        .when(!o, (el) => el.children(r.warnings.map((w) => line(w, t.blocked))))
        .when(!o && Boolean(r.reason), (el) => el.child(line(r.reason, t.blocked)))
        .when(Boolean(status), (el) => el.child(line(status, failed ? t.blocked : t.dim)));
    };
    const body = v_flex().id("dt-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(div().text_size(12).text_color(t.dim).truncate().child(this.label))
      .when(!this.done, (el) => el.child(div().pt(8).child(p.body)).children(p.notes.map((n) => div().pt(6).child(n))))
      .children(p.rows.map(row))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_color(t.blocked).child(this.error)));
    const footer = h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .when(this.done, (el) => el.child(button("dt-close", "Close", false, true, () => this.dismiss())))
      .when(!this.done, (el) => el
        .child(button("dt-cancel", "Cancel", false, !this.busy, () => this.dismiss()))
        .when(Boolean(p.button), (f) => f.child(button("dt-delete", this.busy ? "Deleting…" : p.button, true, p.ready && !this.busy, (cx) => this.submit(cx)))));
    return root.child(header(p.title)).child(body).child(footer);
  }
}
