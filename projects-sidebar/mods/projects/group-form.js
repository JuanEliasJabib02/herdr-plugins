// New group / Rename group: a dialog with one name field. Enter (or Create /
// Save) applies it and closes: a new group is added at the end and becomes
// the shown one; a rename keeps its place. A blank name does nothing. Esc or
// Cancel closes without a change.
//   props: { view: "group-form", group: <id to rename> | null }

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { MOD } from "./config.js";
import { addGroup, renameGroup, selectGroup } from "./lib.js";
import { registry, updateRegistry } from "./store.js";

// The only place that opens the form. groupId: the group to rename, or null
// for a new group.
export function openGroupForm(groupId) {
  return openOverlay({ mod: MOD, kind: "dialog", width: 380, height: 214, props: { view: "group-form", group: groupId ?? null } });
}

// A new group, selected; the registry unchanged for a blank name.
function addAndSelect(r, name) {
  const next = addGroup(r, name);
  return next === r ? r : selectGroup(next, next.groups.at(-1).id);
}

export default class GroupForm {
  init(p, cx) {
    this.group = p?.group ?? null;
    this.text = (this.group && registry().groups.find((g) => g.id === this.group)?.name) || "";
    this.input = InputState.new({ value: this.text, placeholder: "Group name" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      cx.notify();
    });
    this.input.on("submit", () => this.submit());
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

  submit() {
    const name = this.text.trim();
    if (!name) return;
    if (this.group) updateRegistry((r) => renameGroup(r, this.group, name));
    else updateRegistry((r) => addAndSelect(r, name));
    this.close();
  }

  render() {
    const t = theme();
    const ready = this.text.trim() !== "";
    const label = (text) => div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(text);
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
    return v_flex()
      .id("group-form")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        this.close();
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(this.group ? "Rename group" : "New group"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(!this.group, (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim).child("F1–F3 show the first three groups.")))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("group-form-cancel", "Cancel", false, true, () => this.close()))
        .child(button("group-form-save", this.group ? "Save" : "Create", true, ready, () => this.submit())));
  }
}
