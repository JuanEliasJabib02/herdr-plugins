// A task's note (D34; S29, S31, S32): a word or two to recall the task by,
// kept only in Herdr and shown when the pointer rests on the task's lane. A
// small modal dialog with one input, prefilled with the note, the caret at
// its end. Enter or Save stores it as one line of up to 30 characters
// (lib.js normalizeNote); saved empty, the note goes. Esc or Cancel closes
// without a change. A new note while 500 are stored is refused, and the
// dialog says so.
//   props: { view: "task-note", lane: "task:AX-3695", label: "AX-3695" }

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { noteKeyOf, noteOf, NOTES_MAX } from "./lib.js";
import * as store from "./store.js";

// The only place that opens the dialog. modal: a click beside it doesn't
// close it.
export function openTaskNote(lane, label) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 320, height: 160, props: { view: "task-note", lane, label } });
}

const HINT = "Shown when you hover the task. Save it empty to remove it.";
const FULL = `${NOTES_MAX} notes is the most; remove one first.`;

export default class TaskNote {
  init(p, cx) {
    this.key = noteKeyOf(p?.lane); // null: not a task lane, nothing to save
    this.label = p?.label || this.key || "";
    this.error = "";
    const text = noteOf(store.notes(), this.key) ?? "";
    this.input = InputState.new({ value: text, placeholder: "e.g. contratos" });
    // The caret at the end: ranges count as JS `.length` does (UTF-16 units;
    // probed on gpui-kit's Textarea with "Acción 🚀" in T13, D34).
    this.input.set_selected_range({ start: text.length, end: text.length });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.input.on("change", (_e, cx) => {
      if (!this.error) return;
      this.error = "";
      cx.notify();
    });
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });
    this.input.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  save(cx) {
    if (!this.key) return;
    if (store.setNote(this.key, this.input.value()) === "full") {
      this.error = FULL;
      cx.notify();
      return;
    }
    this.close();
  }

  render() {
    const t = theme();
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(30).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    return v_flex()
      .id("task-note")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        this.close();
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(14)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(`Note for ${this.label}`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(3).pb(8).text_size(11).text_color(this.error ? t.blocked : t.dim).child(this.error || HINT))
      .child(Input.new(this.input).h(30).px(10).rounded(8).border_1().border_color(this.inputFocused ? t.accent : t.input)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(10).gap(8).justify_end()
        .child(button("task-note-cancel", "Cancel", false, true, () => this.close()))
        .child(button("task-note-save", "Save", true, this.key !== null, (_e, cx) => this.save(cx))));
  }
}
