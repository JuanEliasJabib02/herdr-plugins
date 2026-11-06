// The Claude panel (S1, Image #2): `Claude  Updated 3m ago` (or "Not yet
// updated"), the active account's card (Session, Weekly, Fable, Monthly and
// credits when present, and the refresh-failed marker on cached data), then
// the `Other accounts` list: System default and each saved account but the
// active one, with their `wk` and `Fable` bars, "No other accounts" when
// there are none. An active account that needs signing in keeps its row, with
// its ✓. Orca's ClaudeSwitcherForOwner.tsx, without its row for the active
// account (S9); what it says is footer-model.js's, this file draws it. Owner: T6.
//   props: { view: "panel", anchor, text, height } (panelSpec)
//
// A click on an account runs `use`, and the panel stays open on the new one, as
// Orca's does; the switch's question or notice comes from the footer
// (toasts.react). Orca's refusal (stderr, exit 5) shows under the heading. An
// account whose login lapsed signs in instead, in a Herdr tab. Opening it asks
// for the usage that's due (`usage --json`), as Orca's does for the inactive
// accounts. A copy without an overlay (herdr-app check) only draws what its
// props give: it runs nothing.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, openOverlay, closeOverlay, settings, appHome } from "herdr";
import { cliPath } from "./store.js";
import { UsageView, readContract, claudeIcon, refreshButton, refreshIcon, usageBar, signInAccount } from "./footer.js";
import { openAccounts } from "./accounts.js";
import { PANEL, MERGE_ARGS, panelModel, panelSpec, rowHeight, useArgs, useFailure, zoomOf, lastAnchor } from "./footer-model.js";

const CHECK = "mods/workspace-chrome/check.svg";

// The open-panel command. The popup's Claude row opens it from what it has
// (panelSpec). It opens at the footer: its anchor, else the last it drew at.
export async function openPanel(anchor = lastAnchor()) {
  const { text, doc } = await readContract();
  return openOverlay(panelSpec({ doc, text, anchor, zoom: zoomOf(settings()), now: Date.now() }));
}

export default class Panel extends UsageView {
  init(p, cx) {
    this.setup(p);
    this.busy = false; // a switch is running
    this.error = null; // why the last one failed
    if (!this.overlay) return;
    this.follow(cx);
    cx.spawn(async () => {
      try {
        await exec(cliPath(appHome()), [...MERGE_ARGS]);
      } catch (e) {
        console.log(`claude-accounts: usage failed: ${e}`);
      }
    });
  }

  spec() {
    return panelSpec({ doc: this.doc, text: this.text, anchor: this.anchor, zoom: zoomOf(settings()), now: Date.now() });
  }

  // A switch rewrites the file while it runs: the size follows when it's done.
  fit() {
    return this.busy ? false : super.fit();
  }

  pick(cx, r) {
    if (r.disabled) return;
    if (r.signIn) {
      this.leave(() => signInAccount(r.signIn));
      return;
    }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let error;
      try {
        error = useFailure(await exec(cliPath(appHome()), useArgs(r.id)));
      } catch (e) {
        error = useFailure(e instanceof Error ? e : new Error(String(e)));
      }
      this.busy = false;
      this.error = error;
      await this.reload();
      if (!this.fit()) cx.notify();
    });
  }

  // Does it, then closes: what a closed copy starts may not run.
  leave(action) {
    action();
    closeOverlay(this.overlay);
  }

  render() {
    const t = theme();
    const m = panelModel({ doc: this.doc, now: Date.now(), busy: this.busy, error: this.error });
    return v_flex()
      .id("ca-panel")
      .size_full()
      // A popup takes its content's height, and the body below scrolls in
      // what's left: without a height of its own that's nothing.
      .when(this.height !== null, (el) => el.h(this.height - PANEL.frame))
      .min_h(0)
      .overflow_hidden()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .child(v_flex().id("ca-panel-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().flex_none().px(PANEL.pad).pt(PANEL.pad)
          .child(this.header(m, t))
          .when(Boolean(m.card), (el) => el.child(card(m.card, t)))
          .child(divider(t))
          .child(h_flex().h(PANEL.heading).flex_none().px(4).items_center().text_size(11).font_medium().text_color(t.muted).child(m.heading))
          .when(Boolean(m.error), (el) => el.child(div().px(4).pb(6).text_size(11.5).text_color(t.blocked).child(m.error)))
          .children(m.rows.map((r) => this.row(r, t)))
          .when(Boolean(m.empty), (el) => el.child(h_flex().h(PANEL.heading).flex_none().px(8).items_center().text_size(11).text_color(t.muted).child(m.empty)))))
      .child(v_flex().flex_none().px(PANEL.pad).pb(PANEL.pad)
        .child(divider(t))
        .child(h_flex().id("ca-panel-manage").h(PANEL.manage).flex_none().px(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.leave(() => openAccounts()))
          .child(m.manage)));
  }

  // `Claude` · `Updated 3m ago` · refresh.
  header(m, t) {
    return h_flex().h(PANEL.header).flex_none().gap(6).items_center()
      .child(claudeIcon(14))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().child(m.title))
      .child(div().flex_none().text_color(t.muted).child(m.updated))
      .child(refreshButton("ca-panel-refresh", t, this.refreshing, (cx) => this.refresh(cx)));
  }

  // AccountSwitchRowItem: its check, its label, its bars beside it; an account
  // to sign in has Orca's hint and Sign in under it, and the row signs it in.
  row(r, t) {
    const line = rowHeight(r) - (r.signIn ? PANEL.action : 0);
    return v_flex().id(`ca-panel-row-${r.id}`).flex_none().px(4).rounded(6)
      .tooltip(r.label)
      .when(!r.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(cx, r)))
      .child(h_flex().h(line).flex_none().gap(4).items_center()
        .child(h_flex().w(16).flex_none().justify_center()
          .when(r.active, (el) => el.child(svg(CHECK).size(14).text_color(t.foreground))))
        .child(div().flex_1().min_w(0).truncate().text_color(r.disabled && !r.active ? t.muted : t.foreground).child(r.label))
        .when(r.bars.length > 0 || Boolean(r.status), (el) => el.child(v_flex().w(PANEL.bars).flex_none()
          .children(r.bars.map((b) => h_flex().h(PANEL.bar).flex_none().gap(6).items_center()
            .child(usageBar(t, b.fill, b.color, 4).flex_1().min_w(0))
            .child(div().flex_none().text_size(10.5).text_color(t.muted).child(b.text))))
          .when(Boolean(r.status), (col) => col.child(h_flex().h(PANEL.bar).flex_none().items_center().justify_end().text_size(10.5).text_color(t.muted).child(r.status))))))
      .when(Boolean(r.signIn), (el) => el.child(h_flex().h(PANEL.action).flex_none().pl(20).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(r.hint))
        .child(h_flex().flex_none().h(24).px(8).gap(4).items_center().text_color(t.muted)
          .child(refreshIcon(t.muted))
          .child("Sign in"))));
  }
}

const divider = (t) => h_flex().h(PANEL.divider).flex_none().items_center().child(div().w_full().h(1).bg(t.border));

// ProviderIdentityCard: the account's label, its windows (ProviderRateLimit-
// WindowSection), its credits and the note over its numbers. Each part has the
// height panelHeight counts.
function card(c, t) {
  return v_flex().flex_none().mt(PANEL.gap).p(PANEL.cardPad).gap(PANEL.item).rounded(8).border_1().border_color(t.border).bg(t.background)
    .child(h_flex().h(PANEL.label).flex_none().items_center().child(div().min_w(0).truncate().text_size(13).font_medium().child(c.label)))
    .children(c.windows.map((w) => v_flex().id(`ca-panel-window-${w.key}`).h(PANEL.window).flex_none().justify_between()
      .child(h_flex().h(16).flex_none().items_center().font_medium().child(w.title))
      .child(usageBar(t, w.fill, w.color).w_full().flex_none())
      .child(h_flex().h(16).flex_none().items_center().justify_between().text_color(t.muted)
        .child(w.used)
        .when(Boolean(w.resets), (el) => el.child(w.resets)))))
    .when(Boolean(c.credits), (el) => el.child(v_flex().h(PANEL.credits).flex_none().justify_center()
      .child(h_flex().h(16).flex_none().items_center().font_medium().child(c.credits.title))
      .child(h_flex().h(16).flex_none().items_center().text_color(t.muted).child(c.credits.text))))
    .when(Boolean(c.notice), (el) => el.child(v_flex().flex_none()
      .when(Boolean(c.notice.label), (col) => col.child(h_flex().h(PANEL.noticeLabel).flex_none().items_center().text_size(11).font_medium().child(c.notice.label)))
      .child(div().line_height(PANEL.line).text_color(t.muted).child(c.notice.message))));
}
