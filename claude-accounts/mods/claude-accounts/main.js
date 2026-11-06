// Claude accounts: Orca's Claude usage and accounts for Herdr. One mod in
// views; the layout and the overlays give each copy props { view }:
//   (none), footer  the usage in the sidebar's status row (S1). The copy that
//                   always lives: the only one that reads key commands, and
//                   the one that keeps the timer and the watch (T6).
//   popup           the popover above the footer
//   panel           the Claude panel: the active account's card, the list
//   accounts        Manage Accounts…: sign in, add, remove, switch mode (S2)
//   confirm         Orca's "Switched to {account}" dialog (D8)
//   details         Usage details & history, a window (S7)
// This file is final (T1): each later task replaces only its own view file.
// The logic is in the CLI (bin/claude-accounts): the views read its files
// through store.js and run it with exec. Copies never reach into each other.

import { View, div } from "gpui-kit";
import { props, nextCommand } from "herdr";
import Footer, { refreshUsage } from "./footer.js";
import Popup, { openPopup } from "./popup.js";
import Panel, { openPanel } from "./panel.js";
import Accounts, { openAccounts } from "./accounts.js";
import Confirm, { openConfirm } from "./confirm.js";
import Details, { openDetails } from "./details.js";

// A copy without a view is the footer. scripts/check-views.sh rewrites this
// line in a tmp copy, because herdr-app check draws only the default view.
const DEFAULT_VIEW = "footer";

const VIEWS = {
  footer: Footer,
  popup: Popup,
  panel: Panel,
  accounts: Accounts,
  confirm: Confirm,
  details: Details,
};

// Every key command of the mod ("claude-accounts.<name>" in keys.json, or
// `herdr-app do claude-accounts.<name>`), by name. Each one only opens an
// overlay, or asks the CLI for fresh usage; the overlay does the rest. A
// handler gets { cx, copy }.
const COMMANDS = {
  "open-popup": () => openPopup(),
  "open-panel": () => openPanel(),
  "open-accounts": () => openAccounts(),
  "open-confirm": () => openConfirm(),
  "open-details": () => openDetails(),
  refresh: () => refreshUsage(),
};

export default class ClaudeAccounts extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = pr.view ?? DEFAULT_VIEW;
    const V = VIEWS[this.name];
    this.view = V ? new V() : null;
    this.view?.init?.(pr, cx);
    if (this.name === "footer") this.listen(cx);
  }

  listen(cx) {
    const copy = Math.random().toString(36).slice(2, 7);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const handler = Object.hasOwn(COMMANDS, c) ? COMMANDS[c] : null;
        try {
          if (handler) await handler({ cx, copy });
          else console.log(`claude-accounts: no command "${c}"`);
        } catch (e) {
          console.log(`claude-accounts: ${c} failed: ${e}`);
        }
        cx.notify();
      }
    });
  }

  async close(cx) {
    await this.view?.close?.(cx);
  }

  render(cx) {
    if (!this.view) return div().child(`claude-accounts: no view "${this.name}"`);
    return this.view.render(cx);
  }
}
