// Orca's switch dialog (D8; renderer/src/components/ClaudeAccountSwitchDialog.tsx
// and ClaudeAccountSwitchSessionTree.tsx): "Switched to {account}", Orca's
// body, the sessions in Orca's groups ("Running on {previous}", "Not on
// {previous}", "Can't move") with a checkbox each and one per group, "Don't
// ask again (restart automatically)", "Keep as is" and "Restart {{count}}
// sessions" ("Restart session" for one or none, disabled for none). The list
// shows only when more than one session is listed, or on Review. A row is
// Orca's SessionRow (D23): the session's last prompt (else its terminal's
// title, else "Claude session"), the terminal's title beside a prompt, and
// at the right why it can't move, the account it's on, or Working or Idle.
// That state is read again every 2 s while the dialog is open (`terminal
// <t> --json`), for the sessions on the outgoing account. What it says is
// accounts-model.js's confirmModel; this file draws it and answers.
// Owner: T7.
//   props: { view: "confirm" }
//
// It reads pending-switch.json (T4). Mode "ask" is the question, opened by
// the footer when toasts.react says so. Mode "restart" is Review, opened by
// the restart toast: the sessions that weren't moved, nothing ticked, and
// no Don't ask again (restarting automatically is already the setting).
// Answers are T4's `restart --answer keep|restart [--terminal <t>]...`, then
// `settings set switchMode restart` for Don't ask again. As in Orca, closing
// it (Esc) answers Keep as is, with Don't ask again as ticked. An answer is
// only sent while the file still holds the question shown: a newer switch
// replaces it, and the view shows the new one (Orca re-keys its dialog).
// A copy without an overlay (herdr-app check) only draws what's on disk.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, exec, readTextFile, watchFolder, home, appHome, settings } from "herdr";
import { zoomOf } from "./footer-model.js";
import { MOD, FILES, stateDir, cliPath, readAccounts, readPendingSwitch } from "./store.js";
import { confirmModel, initialTicked, toggleTicked, toggleGroup, confirmCommands, cliError, statusTerminals, statusArgv, withStatus } from "./accounts-model.js";

// A watch wake waits this long, so one write's events come as one batch.
const SETTLE = 150;
// Without a state folder to watch, it looks again this often.
const RETRY = 2000;
// How often the outgoing sessions' Working or Idle is read while open (D23).
const STATUS_POLL = 2000;
const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const CHECK = "mods/workspace-chrome/check.svg";
const MINUS = "mods/workspace-chrome/minus.svg";
const BODY_MAX = 460;
// What's around the body: the header, the footer's buttons, and the margin
// Herdr leaves between a dialog and the window's edges. A dialog taller than
// the window would lose its buttons, so the body gives way.
const AROUND_BODY = 158;
const BODY_MIN = 60;

function bodyMax() {
  const room = window.viewport_size().height / zoomOf(settings()) - AROUND_BODY;
  return Math.max(BODY_MIN, Math.min(BODY_MAX, Math.floor(room)));
}

// The only place that opens it: the footer (an Ask, or the restart toast's
// Review) and the open-confirm command. modal: a click beside it doesn't
// close it (Esc does, which answers Keep as is). No height: it's as tall as
// what it says, as Orca's is, up to BODY_MAX of text and sessions.
export function openConfirm() {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 500, props: { view: "confirm" } });
}

export default class Confirm {
  init(p, cx) {
    this.overlay = props()?.overlay ?? p?.overlay ?? null;
    this.dir = stateDir(home());
    this.texts = { pending: undefined, contract: undefined };
    this.pending = null; // readPendingSwitch(): the question shown
    this.accounts = readAccounts(null);
    this.ticked = [];
    this.live = {}; // withStatus(): each outgoing session's state, read since the question showed
    this.polling = false; // a read of those states is on its way
    this.dontAskAgain = false;
    this.busy = false; // an answer is on its way
    this.answered = false; // sent: closing doesn't answer again
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    cx.spawn(async (cx) => {
      if (await this.reload()) cx.notify();
      if (this.overlay) this.poll(cx);
    });
    if (this.overlay) {
      this.watch(cx);
      cx.timer.every(STATUS_POLL, (cx) => this.poll(cx));
    }
  }

  async read(name) {
    try {
      return await readTextFile(`${this.dir}/${name}`);
    } catch {
      return null;
    }
  }

  // Reads pending-switch.json and accounts.v1.json; true when either
  // changed. A new question (another `at`) starts over, as Orca's re-keyed
  // dialog does: its own ticks, Don't ask again unticked.
  async reload() {
    const [pending, contract] = await Promise.all([this.read(FILES.pendingSwitch), this.read(FILES.contract)]);
    let changed = false;
    if (contract !== this.texts.contract) {
      this.texts.contract = contract;
      this.accounts = readAccounts(contract);
      changed = true;
    }
    if (pending !== this.texts.pending) {
      this.texts.pending = pending;
      const next = readPendingSwitch(pending);
      if (!next || !this.pending || next.at !== this.pending.at || next.to !== this.pending.to) {
        this.ticked = initialTicked(next);
        this.live = {};
        this.dontAskAgain = false;
        this.error = null;
      }
      this.pending = next;
      changed = true;
    }
    return changed;
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          try {
            await watchFolder(this.dir);
          } catch {
            await cx.sleep(RETRY);
          }
          await cx.sleep(SETTLE);
          const asked = this.pending;
          if (await this.reload()) {
            // Answered elsewhere: nothing's left to ask.
            if (asked && !this.pending && !this.answered && !this.busy) closeOverlay(this.overlay);
            else cx.notify();
          }
        }
      } catch {
        // The dialog closed, or this build was reloaded: its cx is gone.
      }
    });
  }

  // Reads the outgoing sessions' state once (D23), one read at a time. A
  // newer question meanwhile starts over with its own.
  poll(cx) {
    const terminals = statusTerminals(this.pending);
    if (this.polling || this.answered || terminals.length === 0) return;
    this.polling = true;
    const asked = this.pending;
    cx.spawn(async (cx) => {
      try {
        const cli = cliPath(appHome());
        const results = await Promise.all(terminals.map((t) => exec(cli, statusArgv(t)).catch((e) => e)));
        if (!this.pending || this.pending.at !== asked.at || this.pending.to !== asked.to) return;
        const live = terminals.reduce((map, t, i) => withStatus(map, t, results[i]), this.live);
        if (live === this.live) return;
        this.live = live;
        cx.notify();
      } catch {
        // The dialog closed meanwhile: its cx is gone.
      } finally {
        this.polling = false;
      }
    });
  }

  // Whether pending-switch.json still holds the question shown.
  async stillAsked() {
    const now = readPendingSwitch(await this.read(FILES.pendingSwitch));
    return Boolean(now && this.pending && now.at === this.pending.at && now.to === this.pending.to);
  }

  // Sends an answer, then closes. It runs in a task no view owns, so a
  // dialog closed meanwhile (Esc) doesn't cut it between the answer and
  // the setting.
  answer(cx, choice, m) {
    if (this.busy || this.answered || !this.overlay || !this.pending) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    const commands = confirmCommands(choice, { chosen: m.restart.terminals, dontAskAgain: this.dontAskAgain, review: m.review });
    let settle;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    cx.spawn(async () => {
      try {
        if (!(await this.stillAsked())) {
          // Answered elsewhere, or replaced: the watch shows what's there now.
          this.busy = false;
          await this.reload();
          if (!this.pending) closeOverlay(this.overlay);
          return;
        }
        for (const argv of commands) {
          let r;
          try {
            r = await exec(cliPath(appHome()), argv);
          } catch (e) {
            r = e;
          }
          const error = cliError(r, argv[0]);
          if (error) {
            this.error = error;
            this.busy = false;
            return;
          }
        }
        this.answered = true;
        this.busy = false;
        closeOverlay(this.overlay);
      } finally {
        settle();
      }
    }, { owner: null });
    // Redraws the dialog once the answer is in; goes with the dialog.
    cx.spawn(async (cx) => {
      await settled;
      try {
        cx.notify();
      } catch {
        // Closed meanwhile.
      }
    });
  }

  // Herdr's last call when the overlay goes. Closed without an answer (Esc),
  // it answers Keep as is, as Orca's onOpenChange does: started here, the
  // CLI runs on after the dialog is gone.
  async close() {
    if (!this.overlay || this.answered || this.busy || !this.pending) return;
    this.answered = true;
    if (!(await this.stillAsked())) return;
    const review = this.pending.mode === "restart";
    const cli = cliPath(appHome());
    await Promise.all(confirmCommands("keep", { dontAskAgain: this.dontAskAgain, review }).map((argv) => exec(cli, argv).catch(() => null)));
  }

  key(e, cx, m) {
    if (e.key === "escape") closeOverlay(this.overlay ?? props()?.overlay);
    else if (e.key === "enter" && m.restart.enabled) this.answer(cx, "restart", m);
    else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    const m = confirmModel(this.pending, this.accounts, this.ticked, this.live);
    const root = v_flex().id("ca-confirm").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx, m))
      .w_full().bg(t.popover).text_color(t.foreground).text_size(12.5);
    const header = h_flex().flex_none().px(18).pt(16).pb(4).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(m.title))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));
    const body = v_flex().id("ca-confirm-body").max_h(bodyMax()).px(18).pt(4).pb(10).gap(12).overflow_y_scrollbar()
      .child(div().text_color(t.muted).child(m.body))
      .when(m.showList, (el) => el.child(this.list(t, m)))
      .when(Boolean(m.dontAsk), (el) => el.child(this.dontAsk(t, m.dontAsk)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error ?? "")));
    const footer = h_flex().flex_none().px(18).py(14).gap(8).items_center().justify_between().border_t_1().border_color(t.border)
      .child(m.empty
        ? this.button(t, "ca-confirm-close", "Close", false, true, () => closeOverlay(this.overlay ?? props()?.overlay))
        : this.button(t, "ca-confirm-keep", m.keep, false, !this.busy, (cx) => this.answer(cx, "keep", m)))
      .when(!m.empty, (el) => el.child(this.button(t, "ca-confirm-restart", m.restart.label, true, m.restart.enabled && !this.busy,
        (cx) => this.answer(cx, "restart", m))
        .when(this.busy, (b) => b.child(div().w(10).flex_none().frames(SPINNER, 90).child(SPINNER[0])))));
    return root.child(header).child(body).child(footer);
  }

  // Orca's session tree: a header per group (its checkbox ticks or unticks
  // the whole group; "Can't move" has none), then its sessions.
  list(t, m) {
    return v_flex().id("ca-confirm-list").p(6).gap(1).rounded(8).bg(t.chrome).border_1().border_color(t.border)
      .children(m.groups.flatMap((g) => [
        h_flex().id(`ca-confirm-group-${g.key}`).h(26).px(6).gap(8).items_center().border_b_1().border_color(t.border)
          .when(!g.fixed && !this.busy, (el) => el.cursor_pointer().on_click((_e, cx) => {
            this.ticked = toggleGroup(this.ticked, g.sessions.map((s) => s.terminal));
            cx.notify();
          }))
          .child(g.fixed ? div().size(14).flex_none() : this.box(t, g.state === "all", g.state === "some"))
          .child(div().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.muted).child(g.title))
          .child(div().flex_none().text_size(11.5).text_color(t.muted).child(`(${g.count})`)),
        ...g.sessions.map((s) => h_flex().id(`ca-confirm-session-${s.terminal}`).h(26).pl(20).pr(6).gap(8).items_center().rounded(5)
          .when(!s.fixed && !this.busy, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => {
            this.ticked = toggleTicked(this.ticked, s.terminal, !s.checked);
            cx.notify();
          }))
          .child(s.fixed ? div().size(14).flex_none() : this.box(t, s.checked, false))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(s.fixed ? t.muted : t.foreground).child(s.title))
          .when(Boolean(s.terminalTitle), (el) => el.child(div().flex_none().max_w(112).truncate().text_size(11).text_color(t.dim).child(s.terminalTitle ?? "")))
          .when(Boolean(s.reason), (el) => el.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.dim).child(s.reason ?? "")))),
      ]));
  }

  dontAsk(t, d) {
    return h_flex().id("ca-confirm-dont-ask").gap(10).items_start()
      .when(!this.busy, (el) => el.cursor_pointer().on_click((_e, cx) => {
        this.dontAskAgain = !this.dontAskAgain;
        cx.notify();
      }))
      .child(div().pt(1).child(this.box(t, this.dontAskAgain, false)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().child(d.label))
        .child(div().text_size(11.5).text_color(t.dim).child(d.hint)));
  }

  // A checkbox: ticked, partly (a group with some ticked), or empty.
  box(t, checked, partial) {
    const on = checked || partial;
    return h_flex().size(14).flex_none().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.solid : t.input).bg(on ? t.solid : t.raised)
      .when(on, (el) => el.child(svg(checked ? CHECK : MINUS).size(11).text_color(t.solid_foreground)));
  }

  button(t, id, label, primary, enabled, action) {
    return h_flex().id(id).h(32).px(14).gap(6).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(label);
  }
}
