// Manage Accounts… (S2, Image #3): one row per account with its email, `This
// device`, `org · date`, `Sign in again ▾` and `Remove`; `Add account ▾`; the
// setting `When you switch accounts while Claude is running in terminals`
// (Ask / Always restart / Never restart). Every action runs the CLI. Owner:
// T7. T1 draws a placeholder.
//   props: { view: "accounts" }

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, openOverlay } from "herdr";
import { MOD } from "./store.js";

// The only place that opens it: the popup's Manage Accounts… and the
// open-accounts command.
export function openAccounts() {
  return openOverlay({ mod: MOD, kind: "dialog", width: 560, height: 560, props: { view: "accounts" } });
}

export default class Accounts {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return v_flex()
      .id("ca-accounts")
      .size_full()
      .min_h(0)
      .p(14)
      .gap(6)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child("Claude accounts"))
      .child(div().text_size(12).text_color(t.dim).child("Sign in, add and remove accounts here (placeholder)."));
  }
}
