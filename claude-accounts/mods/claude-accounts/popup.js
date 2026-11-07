// The popover above the footer (S1, Image #1): `Usage` · `all agents` with
// refresh and Detailed | Compact, the Claude row with `Resets in` and its bars
// (it opens the panel), `Usage details & history` (it opens details) and
// `Manage Accounts…`. Orca's UsageRosterPanel.tsx; what it says is
// footer-model.js's, this file draws it. Owner: T6.
//   props: { view: "popup", anchor, text, height } (popupSpec)
//
// Detailed | Compact sets the footer's mode, the shared UI value (D12). A copy
// without an overlay (herdr-app check) only draws what its props give.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, shared, setShared, settings } from "herdr";
import { UsageView, readContract, claudeIcon, refreshButton, refreshIcon, usageBar, signInAccount } from "./footer.js";
import { openDetails } from "./details.js";
import { openAccounts } from "./accounts.js";
import { UI_KEY, POPUP, usageMode, withUsageMode, popupModel, popupHeight, popupSpec, panelSpec, zoomOf, lastAnchor } from "./footer-model.js";

const CHEVRON = "mods/workspace-chrome/chevron-right.svg";
// The Claude row's left column, where its metrics line up (Orca's pl-[30px]).
const ROW_INDENT = 30;
// What each link at its bottom opens.
const LINKS = { details: () => openDetails(), accounts: () => openAccounts() };

// The other opener is the footer's click, which already has the file. It
// opens at the footer: its anchor from there, else the last one it drew at.
export async function openPopup(anchor = lastAnchor()) {
  const { text, doc } = await readContract();
  return openOverlay(popupSpec({ doc, text, mode: usageMode(shared(UI_KEY)), anchor, zoom: zoomOf(settings()), now: Date.now() }));
}

export default class Popup extends UsageView {
  init(p, cx) {
    this.setup(p);
    if (this.overlay) this.follow(cx);
  }

  spec() {
    return popupSpec({ doc: this.doc, text: this.text, mode: usageMode(shared(UI_KEY)), anchor: this.anchor, zoom: zoomOf(settings()), now: Date.now() });
  }

  // Does what its row says, then closes: what a closed copy starts may not
  // run. So nothing here waits: the panel opens from what's on screen.
  leave(action) {
    action();
    closeOverlay(this.overlay);
  }

  openPanel() {
    openOverlay(panelSpec({ doc: this.doc, text: this.text, anchor: this.anchor, zoom: zoomOf(settings()), now: Date.now() }));
  }

  setMode(value, cx) {
    setShared(UI_KEY, withUsageMode(shared(UI_KEY), value));
    cx.notify();
  }

  render() {
    const t = theme();
    const m = popupModel({ doc: this.doc, mode: usageMode(shared(UI_KEY)), now: Date.now() });
    return v_flex()
      .id("ca-popup")
      .size_full()
      .min_h(0)
      .overflow_hidden()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .child(this.header(m, t))
      .child(this.modes(m, t))
      .child(line(t))
      .child(this.row(m.row, popupHeight(m), t))
      .child(line(t))
      .children(m.links.map((l) => this.link(l, t)));
  }

  // `Usage` · `all agents` · refresh.
  header(m, t) {
    return h_flex().h(POPUP.header).flex_none().px(14).pt(4).items_center().justify_between()
      .child(div().text_size(13).font_semibold().child(m.title))
      .child(h_flex().gap(8).items_center().text_color(t.muted)
        .child(div().text_size(11).child(m.scope))
        .child(refreshButton("ca-popup-refresh", t, this.refreshing, (cx) => this.refresh(cx))));
  }

  // Detailed | Compact, each half the width, with Orca's tooltips.
  modes(m, t) {
    return v_flex().h(POPUP.toggle).flex_none().px(14).pb(10)
      .child(h_flex().flex_1().min_h(0).gap(2).p(2).rounded(7).bg(t.raised)
        .children(m.modes.map((o) => h_flex().id(`ca-popup-mode-${o.value}`).flex_1().min_w(0).h_full().items_center().justify_center().rounded(5).cursor_pointer()
          .text_size(12)
          .text_color(o.selected ? t.foreground : t.dim)
          .when(o.selected, (el) => el.bg(t.selected).font_medium())
          .when(!o.selected, (el) => el.hover((s) => s.text_color(t.foreground)))
          .tooltip(o.tooltip)
          .on_click((_e, cx) => this.setMode(o.value, cx))
          .child(o.label))));
  }

  // The Claude row (UsageRow): its height is what's left of popupHeight, so it
  // holds in both modes.
  row(r, total, t) {
    const height = total - POPUP.header - POPUP.toggle - 2 - 2 * POPUP.link - POPUP.frame;
    return v_flex().id("ca-popup-row").h(height).flex_none().px(14).gap(4).justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.leave(() => {
        if (r.signIn) signInAccount(r.signIn);
        else this.openPanel();
      }))
      .child(h_flex().h(20).flex_none().gap(10).items_center()
        .child(h_flex().size(20).flex_none().items_center().justify_center().rounded(6).border_1().border_color(t.border).bg(t.raised).child(claudeIcon(13)))
        .child(div().flex_none().text_size(13).font_medium().child(r.name))
        .when(Boolean(r.status), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(r.status)))
        .when(Boolean(r.reset), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(r.reset)))
        .child(div().flex_1().min_w(0))
        .when(Boolean(r.headline), (el) => el.child(h_flex().flex_none().gap(6).items_center()
          .child(div().text_size(10).text_color(t.muted).child(r.headline.label))
          .child(div().text_size(11).text_color(t[r.headline.color] ?? t.foreground).child(r.headline.text))))
        .child(r.signIn ? signInChip(t) : svg(CHEVRON).size(14).flex_none().text_color(t.muted)))
      .when(r.metrics.length > 0, (el) => el.child(h_flex().pl(ROW_INDENT).flex_wrap().gap_x(10).gap_y(2)
        .children(r.metrics.map((x) => h_flex().h(18).flex_none().gap(6).items_center()
          .child(div().text_size(10).text_color(t.muted).child(x.label))
          .child(usageBar(t, x.fill, x.bar, 5).w(28).flex_none())
          .child(div().text_size(11).text_color(t[x.color] ?? t.foreground).child(x.text))))));
  }

  link(l, t) {
    return h_flex().id(`ca-popup-${l.id}`).h(POPUP.link).flex_none().px(14).items_center().justify_between().cursor_pointer()
      .text_size(13)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.leave(LINKS[l.id]))
      .child(l.label)
      .child(svg(CHEVRON).size(14).flex_none().text_color(t.muted));
  }
}

const line = (t) => div().h(1).flex_none().bg(t.border);

// The row signs in when clicked; this only says so (Orca's span in UsageRow).
function signInChip(t) {
  return h_flex().flex_none().px(8).py(1).gap(4).items_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
    .child(refreshIcon(t.muted))
    .child("Sign in");
}
