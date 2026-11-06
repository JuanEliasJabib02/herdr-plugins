// The Rename dialog (S22, D25), opened from a workspace's right-click menu
// with props { project, path }. Its name input starts as the branch, and the
// untouched prefill never renames; each `/` segment of what is typed is
// slugged like D12, so a namespace survives. On open it asks git, with T7's
// removalCheck, whether the folder can move (a locked worktree or one with
// submodules can't), and it checks the typed name with renameCheck at once
// and again once typing stops, so a name origin or the repo already has
// shows before Enter. For a pushed branch that check also reads what origin
// has (D28), so the dialog says before Rename whether GitHub renames it too,
// a copy is pushed, or it is renamed here only, and which open PR GitHub
// would close ("Rename anyway"). The folder moves only when no space and no
// terminal is in it; otherwise it stays and the row shows the new branch
// (D27). Enter runs renameWorkspace (D26, D28) with what the dialog showed
// (`seen`), in a task no view owns, like the Delete dialog: Herdr's Esc may
// close even a modal dialog, and a closed dialog's own tasks are cancelled
// after 250 ms, while GitHub may take a few seconds. Its outcome goes to the
// dialog while it is open, else to a toast. What it says and what an
// outcome does live in tree-model.js (renamePrompt, renameOutcome).

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, spaces, panes, home, notify } from "herdr";
import { MOD } from "./config.js";
import { normPath, matchSpaces } from "./lib.js";
import * as store from "./store.js";
import { removalCheck, renameCheck, renameWorkspace } from "./git.js";
import { spacesToClose } from "./remove-workspace-model.js";
import { renamePrompt, renameOutcome, terminalsStaying } from "./tree-model.js";

// The typed name is checked with git this long after typing stops.
const RECHECK = 250;

// The only place that opens the dialog. modal: a click beside it doesn't
// close it.
export function openRenameWorkspace(project, path) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 380, height: 320, props: { view: "rename-workspace", project, path } });
}

export default class RenameWorkspace {
  init(p, cx) {
    this.project = p?.project ? normPath(p.project) : null;
    this.path = p?.path ? normPath(p.path) : null;
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the rename's task may outlive this copy's props
    this.check = null; // removalCheck's answer; null while git is asked
    this.live = null; // the last renameCheck answer, with the text it checked
    this.seq = 0; // the latest name check; older ones are dropped
    this.busy = false; // a rename runs: Esc, Cancel and Rename do nothing
    this.error = ""; // a failure that stays in the dialog
    this.gone = false; // the dialog closed: a running rename reports with a toast
    this.handle = cx.focus_handle();
    this.prefill = this.row()?.branch ?? "";
    this.text = this.prefill;
    this.input = InputState.new({ value: this.prefill, placeholder: "Branch name" });
    this.selectAll();
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      this.error = "";
      this.recheck(cx, RECHECK);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.focus());
    if (!this.project || !this.path) return;
    cx.spawn(async (cx) => {
      this.check = await removalCheck({ project: this.project, path: this.path });
      this.refill(cx);
      cx.notify();
    });
    // Asked at once with the prefill: a detached checkout or the main
    // checkout is refused whatever the name, before anything is typed.
    this.recheck(cx, 0);
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a
  // rename still running reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  // The keyboard on the input, or on the dialog when there is no input (a
  // workspace that can't be renamed), so Esc still reaches it.
  focus() {
    if (this.project && this.path && this.prompt().editable) this.input.focus();
    else this.handle.focus();
  }

  selectAll() {
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
  }

  // The checkout as git listed it on open, else as the tree has it.
  row() {
    const fresh = this.check?.list?.find((c) => c.path === this.path);
    if (fresh) return fresh;
    return (store.cache()[this.project] ?? []).find((c) => normPath(c.path) === this.path) ?? null;
  }

  // The branch git lists now, when the input still holds an untouched
  // prefill of another one (the tree's list was behind): the untouched
  // prefill must be the branch itself, or Enter would rename it to the stale
  // name.
  refill(cx) {
    const fresh = this.row()?.branch;
    if (!fresh || fresh === this.prefill || this.text !== this.prefill) return;
    this.prefill = fresh;
    this.text = fresh;
    this.input.set_value(fresh);
    this.selectAll();
    this.recheck(cx, 0);
  }

  // Checks the typed name with git after `delay` ms; a newer text drops it.
  recheck(cx, delay) {
    if (!this.project || !this.path) return;
    const seq = ++this.seq;
    const text = this.text;
    cx.spawn(async (cx) => {
      if (delay) await cx.sleep(delay);
      if (seq !== this.seq) return;
      // moveFolder false: a taken folder comes back as folderTaken, and the
      // prompt refuses it only while the folder would move (D25).
      const r = await renameCheck({ project: this.project, path: this.path, name: text, moveFolder: false });
      if (seq !== this.seq) return;
      const { status, reason, err, origin, folderTaken, newPath } = r;
      this.live = { status, reason, err, origin, folderTaken, newPath, text };
      if (!this.prompt().editable) this.handle.focus();
      cx.notify();
    });
  }

  prompt() {
    const ids = spacesToClose(matchSpaces(store.cache(), spaces(), panes(), home()), this.path);
    return renamePrompt({
      path: this.path,
      row: this.row(),
      text: this.text,
      check: this.check,
      live: this.live,
      spaces: ids.length,
      terminals: terminalsStaying(this.path, [], spaces(), panes(), home()),
      home: home(),
    });
  }

  // Enter may run: the prompt says so, and git has answered once, so the
  // request can carry what the dialog showed.
  canSubmit(shown) {
    return !this.busy && shown.ready && Boolean(this.live);
  }

  submit(cx) {
    const shown = this.prompt();
    if (!this.canSubmit(shown)) return;
    const { project, path, text } = this;
    // D26 step 3: decided now, from the spaces and terminals open now.
    const moveFolder = shown.moveFolder;
    // D28: what origin's path and PRs looked like to the person; the model
    // runs nothing remote when the fresh check differs.
    const origin = this.live.origin;
    const seen = { route: origin?.route ?? "local", prs: (origin?.prs ?? []).map((pr) => pr.number) };
    this.busy = true;
    this.error = "";
    cx.notify();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    cx.spawn(async (bg) => {
      let r;
      try {
        // bg: this task's cx, whose sleep spaces the looks at origin.
        r = await renameWorkspace({ project, path, name: text, moveFolder, seen }, bg);
      } catch (e) {
        r = { status: "failed", reason: null, branch: null, name: null, folder: null, err: String(e?.message ?? e), list: null, remote: null, prs: [], check: null };
      }
      // D26 step 4 (D23 step 5): the row changes at once.
      if (r.list) store.saveWorktrees(project, r.list);
      this.busy = false;
      const out = renameOutcome(r, { label: shown.label, path, open: !this.gone });
      // A refusal keeps the path the dialog last read from origin; "changed"
      // brings the fresh one.
      if (out.live) this.live = { origin: this.live?.origin, ...out.live, text };
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
    const root = v_flex().id("rename-workspace").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
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

    if (!this.project || !this.path) {
      return root.child(header("Rename workspace"))
        .child(div().px(18).pt(10).text_color(t.dim).child("No workspace."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(button("rw-close", "Close", false, true, () => this.dismiss())));
    }

    const p = this.prompt();
    const line = (text, color) => div().pt(8).text_color(color).child(text);
    const body = v_flex().id("rw-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(div().text_size(12).text_color(t.dim).truncate().child(p.path))
      .when(p.editable, (el) => el
        .child(div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child("Branch"))
        .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background).text_size(12.8).text_color(t.foreground))
        .when(Boolean(p.line), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim).child(p.line))))
      .when(Boolean(p.remote), (el) => el.child(div().pt(4).text_size(11.5).text_color(t.muted).child(p.remote)))
      .children(p.warnings.map((w) => line(w, t.blocked)))
      .when(Boolean(p.reason), (el) => el.child(line(p.reason, t.blocked)))
      .when(p.checking, (el) => el.child(line("Checking with git…", t.dim)))
      .when(Boolean(this.error), (el) => el.child(line(this.error, t.blocked)));
    const footer = h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .child(button("rw-cancel", "Cancel", false, !this.busy, () => this.dismiss()))
      .when(Boolean(p.button), (el) => el.child(button("rw-rename", this.busy ? "Renaming…" : p.button, true, this.canSubmit(p), (cx) => this.submit(cx))));
    return root.child(header(p.title)).child(body).child(footer);
  }
}
