// Spotlight: Orca Pro Max's Spotlight and test queue for Herdr. One mod in
// views; the layout and the overlays give each copy props { view }:
//   footer (default)  the flask in the status row. The only copy that runs
//                     the badges loop (badges, workspace menu items and
//                     remove hooks), posts the CLI's toasts and reads key
//                     commands, badge commands included. At its start it
//                     ensures `spotlight watch` (D44), the background
//                     process that auto-syncs and reaps in any layout.
//   board             the "Cola de pruebas" popup
//   settings          the settings dialog
//   server            a repo's server popup (env, variant, URLs, actions)
//   env               a task lane's env popup (D32: its env pill)
// Every view and loop lives in its own file, so tasks never share this one.
// The engine is the `spotlight` CLI (cli.mjs, never imported here): copies
// read its state.json and act by exec-ing it.

import { View, div } from "gpui-kit";
import { props, nextCommand, setShared, exec, appHome } from "herdr";
import Footer from "./footer.js";
import Board from "./board.js";
import SettingsView from "./settings-view.js";
import ServerView from "./server-view.js";
import EnvView from "./env-view.js";
import { startBadges, handleCommand, MENU_KEY, REMOVE_HOOKS_KEY } from "./badges.js";
import { cliPathOf } from "./board-model.js";

const VIEWS = {
  footer: Footer,
  board: Board,
  settings: SettingsView,
  server: ServerView,
  env: EnvView,
};

// D44: `spotlight watch --ensure`, once per footer copy: it starts the
// watcher unless one of this build runs, and replaces one of an earlier
// build (a reinstall reloads this copy). The watcher syncs the holders and
// reaps (turn ends, servers, idle times) while nothing of Spotlight's is
// shown; it exits by itself once nothing is lit and the queue is empty, and
// `spotlight on` or the next light starts it again.
function ensureWatcher(cx) {
  cx.spawn(async () => {
    try {
      const r = await exec(cliPathOf(appHome()), ["watch", "--ensure"]);
      if (r.code !== 0) console.log(`spotlight: watch --ensure: ${r.stderr.trim() || `exit ${r.code}`}`);
    } catch (e) {
      console.log(`spotlight: watch --ensure: ${e}`);
    }
  });
}

export default class Spotlight extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = pr.view ?? "footer";
    const V = VIEWS[this.name];
    this.view = V ? new V() : null;
    this.view?.init?.(pr, cx);
    if (this.name === "footer") {
      ensureWatcher(cx);
      startBadges(cx);
      this.listen(cx);
    }
  }

  // Key and badge commands ("spotlight.<name>") reach every shown copy; only
  // the footer's answers, so each runs once.
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (!(await handleCommand(c, { cx }))) console.log(`spotlight: no command "${c}"`);
        } catch (e) {
          console.log(`spotlight: ${c} failed: ${e}`);
        }
        cx.notify();
      }
    });
  }

  // The footer copy is the one that publishes badges.spotlight,
  // menus.spotlight and removeHooks.spotlight (badges.js). Once it goes (a
  // layout switch, a reload) nothing keeps them current, so they go with it,
  // each contract's clear (projects-sidebar RECIPE.md, "Lifetime"); a footer
  // copy shown again publishes them anew.
  async close(cx) {
    await this.view?.close?.(cx);
    if (this.name === "footer") {
      setShared("badges.spotlight", null);
      setShared(MENU_KEY, null);
      setShared(REMOVE_HOOKS_KEY, null);
    }
  }

  render(cx) {
    if (!this.view) return div().child(`spotlight: no view "${this.name}"`);
    return this.view.render(cx);
  }
}
