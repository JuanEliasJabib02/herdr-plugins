// The confirm a workspace's sleep opens when it asks first (workspace-sleep
// D5, T7), a dialog in the middle of the window, as Orca's:
//
//   Sleep checkout-flow
//   2 agents are working or may have unsent text. Sleep anyway?
//   ─────────────────────────────────────────────────────
//                                         [Cancel] [Sleep]
//
// The loop copy opens it when a sleep finds an agent working or with text it
// may not have sent, whether a popup was open or not. Sleep goes on with that
// sleep; Cancel, Esc, a click beside it, or the dialog closing any other way
// changes nothing. The look follows claude-accounts' confirm, the other dialog
// of the status row.
//
// Draws only: main.js hands it confirmModel() and the two answers. No herdr
// import (main.js is the only file with one).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// A dialog button: the primary one solid; a disabled one dimmed, taking no click.
function button(t, id, text, primary, enabled, action) {
  return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
    .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
    .when(!enabled, (el) => el.opacity(0.5))
    .child(text);
}

// { t: theme(), model: confirmModel(), onCancel, onSleep: click handlers }
export function renderConfirm({ t, model, onCancel, onSleep }) {
  return v_flex().id("agent-sleep-confirm").w_full().bg(t.popover).text_color(t.foreground).text_size(12.5)
    .child(div().id("agent-sleep-confirm-title").flex_none().px(18).pt(16).pb(4).w_full().truncate()
      .text_size(15).font_semibold().child(model.title))
    .child(div().id("agent-sleep-confirm-body").px(18).pt(4).pb(14).text_color(t.muted).child(model.body))
    .child(h_flex().flex_none().px(18).py(14).gap(8).items_center().justify_end().border_t_1().border_color(t.border)
      .child(button(t, "agent-sleep-confirm-cancel", model.cancel, false, true, onCancel))
      .child(button(t, "agent-sleep-confirm-sleep", model.sleep, true, model.enabled, onSleep)));
}
