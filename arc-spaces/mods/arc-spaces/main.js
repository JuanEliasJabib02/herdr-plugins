// Orca's Settings → Browser → Open Links in Arc Spaces, as a dialog: a switch,
// off by default, and one Arc space name per group. Each change is saved as it
// is typed; bin/open reads it at the next click. Esc or Done closes.
//   herdr-app do mod.open '{"name":"arc-spaces"}'

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, shared, setShared, closeOverlay, exec, appHome } from "herdr";
import { KEY, GROUPS_KEY, LINK, parseConfig, withEnabled, withName, groupsOf, isLinked } from "./model.js";

const config = () => parseConfig(shared(KEY));

// `change` gets the stored config and returns the next one; withEnabled and
// withName return the same object when nothing changes, so nothing is written.
function save(change) {
  const current = config();
  const next = change(current);
  if (next !== current) setShared(KEY, next);
}

export default class ArcSpaces extends View {
  init(_props, cx) {
    // Group id → its field. Herdr refuses InputState.new during render, so they
    // are made here, and a group created while this is open shows the next time.
    this.inputs = new Map(groupsOf(shared(GROUPS_KEY)).map(({ id }) => [id, this.newInput(id)]));
    this.focusedGroup = null;
    this.linked = true; // until asked, so the warning doesn't flash
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Without the link the switch would do nothing, with no sign of why.
    cx.spawn(async (cx) => {
      const link = await exec("readlink", [LINK]).catch(() => null);
      this.linked = isLinked(link?.code === 0 ? link.stdout : "", appHome());
      cx.notify();
    });
  }

  newInput(groupId) {
    const state = InputState.new({ value: config().names[groupId] ?? "", placeholder: "Arc space name" });
    state.on("change", () => save((current) => withName(current, groupId, state.value())));
    state.on("focus", (_e, cx) => {
      this.focusedGroup = groupId;
      cx.notify();
    });
    state.on("blur", (_e, cx) => {
      if (this.focusedGroup === groupId) this.focusedGroup = null;
      cx.notify();
    });
    return state;
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const { enabled } = config();
    const groups = groupsOf(shared(GROUPS_KEY)).filter(({ id }) => this.inputs.has(id));
    const note = (text, color = t.dim) => div().text_size(11.5).text_color(color).child(text);

    // A switch drawn by hand (gpui-base's Switch has no styling), as agent-sleep's.
    const toggle = h_flex().id("arc-spaces-toggle").flex_none().w(28).h(16).p(2).rounded(8).cursor_pointer()
      .bg(enabled ? t.accent : t.input)
      .when(enabled, (el) => el.justify_end())
      .on_click(() => save((current) => withEnabled(current, !current.enabled)))
      .child(div().size(12).rounded(6).bg(enabled ? t.accent_foreground : t.background));

    const row = (group) => h_flex().items_center().gap(10)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(group.name))
      .child(Input.new(this.inputs.get(group.id)).w(200).h(30).px(9).rounded(8).border_1()
        .border_color(this.focusedGroup === group.id ? t.accent : t.input)
        .bg(t.background).text_size(12.5).text_color(t.foreground));

    return v_flex()
      .id("arc-spaces")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        this.close();
        cx.stop_propagation();
      })
      .w_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().text_size(15).font_semibold().child("Open links in Arc spaces"))
        .child(toggle))
      .child(note("Links you click in a terminal go to the Arc space you pick for the workspace's group. A group without a name opens links as usual."))
      .when(enabled && groups.length === 0, (el) => el.child(note("Create a group in the projects sidebar to pick its Arc space.")))
      .when(enabled, (el) => el.children(groups.map(row)))
      .when(enabled && !this.linked, (el) => el.child(note(`Links won't reach Arc spaces yet: ${LINK} isn't linked. The plugin's RECIPE.md has the line to run.`, t.blocked)))
      .child(h_flex().pt(6).justify_end()
        .child(h_flex().id("arc-spaces-done").h(32).px(14).items_center().rounded(8).cursor_pointer()
          .border_1().border_color(t.solid).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12.5).font_medium().hover((s) => s.opacity(0.88))
          .on_click(() => this.close())
          .child("Done")));
  }
}
