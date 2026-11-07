// The Delete dialog, modal, with props { view }: first "Delete", and once the Trash said
// no, "Delete Permanently" with its own button. It draws and asks: the panel's copy runs
// the deletion, so closing this doesn't cut it, and publishes how it's going in
// code-editor.op, written only there. Its buttons are the panel's commands, the same a
// test sends (D2). Only Esc is a key: D23 gives neither button Enter.
//
// `herdr` as a namespace, as in file-menu.js.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as herdr from "herdr";
import { MOD, OPS, OP_KEY, trashOffer } from "./ops-model.js";
import { table } from "./tree-model.js";

// The dialog may take the keyboard a moment after it opens (mods/prompt).
const REFOCUS = 600;

// The only place that opens the dialog. modal: a click beside it doesn't close it.
export function openFileDialog() {
  return herdr.openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 400, height: 230, props: { view: "file-dialog" } });
}

export default class FileDialog {
  init(p, cx) {
    this.overlay = p?.overlay ?? null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(REFOCUS, () => this.handle.focus());
  }

  // Herdr's last call when the overlay goes, by Esc too: a run still going reports with
  // a toast from here on. It says which dialog: the next one may be open by now.
  close() {
    try { herdr.run(this.overlay ? `${MOD}.delete-closed:${this.overlay}` : `${MOD}.delete-closed`); }
    catch (e) { console.log(`code-explorer: telling the panel the dialog closed failed: ${e}`); }
  }

  op() {
    return table(herdr.shared(OP_KEY));
  }

  // Closing itself rather than asking: with the panel hidden a command wouldn't arrive.
  dismiss() {
    if (!this.op().busy) herdr.closeOverlay(this.overlay);
  }

  key(event, cx) {
    if (event.key !== "escape") return;
    cx.stop_propagation();
    this.dismiss();
  }

  render() {
    const t = herdr.theme(), op = this.op(), offer = op.step === "offer", busy = Boolean(op.busy);
    const button = (id, text, danger, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(danger ? t.blocked : t.input).bg(danger ? `${t.blocked}1f` : t.raised)
      .text_color(danger ? t.blocked : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    const root = v_flex().id("file-dialog").track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);
    const title = (text) => h_flex().px(18).pt(16).pb(4).gap(8).items_start()
      .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(text))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(busy ? "" : "Esc"));
    const line = (text, color) => div().pt(8).text_color(color).child(text);
    const cancel = button("file-dialog-cancel", OPS.cancel, false, !busy, () => this.dismiss());
    if (!op.rel) {
      return root.child(title(OPS.delete)).child(div().px(18).pt(10).text_color(t.dim).child("Nothing to delete."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(cancel));
    }
    const note = offer ? OPS.cannotUndo : op.folder ? "It moves to the Trash with everything in it." : "It moves to the Trash.";
    const action = offer
      ? button("file-dialog-permanent", busy ? OPS.deleting : OPS.deletePermanently, true, !busy, () => herdr.run(`${MOD}.delete-permanent`))
      : button("file-dialog-delete", busy ? OPS.deleting : OPS.delete, true, !busy, () => herdr.run(`${MOD}.delete-confirm`));
    return root.child(title(offer ? trashOffer(op.name) : `${OPS.delete} '${op.name}'?`))
      .child(v_flex().id("file-dialog-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
        .child(div().text_size(12).text_color(t.dim).truncate().child(op.rel))
        .child(line(note, t.foreground))
        .when(Boolean(op.error), (el) => el.child(line(op.error, t.blocked))))
      .child(h_flex().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
        .child(cancel)
        .child(action));
  }
}
