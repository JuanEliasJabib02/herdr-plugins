// Manage Accounts… (S2, Image #3; D3, D13): Orca's Claude accounts pane
// (settings/accounts/claude/accounts-pane-claude-section.tsx). System
// default ("System default: {email}", "Use your current this device Claude
// login.") and Orca's notice when it's also a saved account; one row per
// saved account with its email, `This device`, `org · date`, `Sign in again
// ▾` (its menu: "Copy sign-in link instead") and `Remove`; `Add Account ▾`;
// "No other accounts" when there are none; and the setting `When you switch
// accounts while Claude is running in terminals` (Ask / Always restart /
// Never restart). What it says is accounts-model.js's; this file draws it
// and runs the CLI. Owner: T7.
//   props: { view: "accounts" }
//
// - A click on an account (or System default) makes it the active one:
//   `use <id>`. The switch's question or notice comes from the footer
//   (toasts.react), as in Orca.
// - Sign in again / Add Account open a Herdr tab running `login <id|new|
//   default> [--link]`, which runs the real `claude auth login` there. The
//   view says closing the tab cancels it, until the account's sign-in
//   lands. With "Copy sign-in link instead" the footer copies the link the
//   CLI captures (login-link) and says so.
// - Remove asks first (Orca's "Remove Claude Account?"), then `remove <id>`.
// - The setting runs `settings set switchMode <v>`.
// - One action at a time, as Orca's pane does; a failed one says the CLI's
//   own line under the list.
// Data: `list --json` on open (it creates accounts.v1.json the first time),
// then a watch on the state folder re-reads accounts.v1.json and
// settings.json. A copy without an overlay (herdr-app check) only draws
// what's on disk: it runs nothing and watches nothing.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, exec, readTextFile, watchFolder, home, appHome, shared, setShared } from "herdr";
import { MOD, FILES, stateDir, cliPath, readAccounts, readSettings } from "./store.js";
import { accountsList, accountsModel, startSignIn, signInDone, removePrompt, signInArgv, cliError } from "./accounts-model.js";

// The view's own shared key: { duplicateDismissed: <email> } (Orca's
// claudeCopiedSystemDefaultNoticeDismissed).
const UI_KEY = "claude-accounts.accounts";
// A watch wake waits this long, so one write's events come as one batch.
const SETTLE = 150;
// Without a state folder to watch, it looks again this often.
const RETRY = 2000;
// The busy spinner, drawn natively (frames()).
const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const CHEVRON = "mods/workspace-chrome/chevron-down.svg";
const PLUS = "mods/workspace-chrome/plus.svg";
const CLAUDE_ICON = "icons/claude.svg";
// The sign-in tab's name.
const SIGN_IN_TAB = "Claude sign-in";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// The only place that opens it: the popup's and the panel's Manage
// Accounts… and the open-accounts command.
export function openAccounts() {
  return openOverlay({ mod: MOD, kind: "dialog", width: 600, height: 620, props: { view: "accounts" } });
}

export default class Accounts {
  init(p, cx) {
    this.overlay = props()?.overlay ?? p?.overlay ?? null;
    this.dir = stateDir(home());
    this.texts = { contract: undefined, settings: undefined };
    this.doc = readAccounts(null);
    this.settings = readSettings(null);
    this.menu = null; // the open ▾ menu: "add", "signin:<id>", "mode"
    this.removing = null; // the account Remove asks about
    this.busy = null; // the action running: "select:<id>", "remove:<id>", "mode"
    this.error = null; // the last action's failure, the CLI's own line
    this.signingIn = null; // startSignIn()'s value while a sign-in tab runs
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    if (!this.overlay) {
      cx.spawn(async (cx) => {
        if (await this.reload()) cx.notify();
      });
      return;
    }
    cx.spawn(async (cx) => {
      // `list` rebuilds accounts.v1.json (and imports Orca's accounts the
      // first time), so the view starts from what the CLI knows now.
      try {
        const r = await exec(cliPath(appHome()), ["list", "--json"]);
        if (r.code === 0) this.doc = readAccounts(r.stdout);
        else this.error = cliError(r, "list");
      } catch (e) {
        this.error = cliError(e, "list");
      }
      await this.reload();
      cx.notify();
    });
    this.watch(cx);
  }

  // Reads accounts.v1.json and settings.json; true when either changed.
  async reload() {
    const read = async (name) => {
      try {
        return await readTextFile(`${this.dir}/${name}`);
      } catch {
        return null;
      }
    };
    const [contract, settings] = await Promise.all([read(FILES.contract), read(FILES.settings)]);
    let changed = false;
    if (contract !== this.texts.contract) {
      this.texts.contract = contract;
      if (contract !== null) this.doc = readAccounts(contract);
      changed = true;
    }
    if (settings !== this.texts.settings) {
      this.texts.settings = settings;
      this.settings = readSettings(settings);
      changed = true;
    }
    if (this.signingIn && signInDone(this.signingIn, this.doc)) {
      this.signingIn = null;
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
          if (await this.reload()) cx.notify();
        }
      } catch {
        // The dialog closed, or this build was reloaded: its cx is gone.
      }
    });
  }

  // Runs one CLI command for an action; one at a time.
  act(cx, key, argv) {
    if (this.busy || !this.overlay) return;
    this.busy = key;
    this.error = null;
    this.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await exec(cliPath(appHome()), argv);
      } catch (e) {
        r = e;
      }
      this.error = cliError(r, argv[0]);
      this.busy = null;
      await this.reload();
      cx.notify();
    });
  }

  select(cx, id) {
    this.act(cx, `select:${id}`, ["use", id, "--json"]);
  }

  setMode(cx, mode) {
    if (mode === this.settings.switchMode) {
      this.menu = null;
      cx.notify();
      return;
    }
    this.act(cx, "mode", ["settings", "set", "switchMode", mode, "--json"]);
  }

  confirmRemove(cx) {
    const id = this.removing;
    this.removing = null;
    if (id) this.act(cx, `remove:${id}`, ["remove", id, "--json"]);
    else cx.notify();
  }

  // A Herdr tab runs the CLI's login, which runs `claude auth login` there
  // (D3). With link, Claude's one-click link is captured instead of opening
  // the browser, and the footer copies it (D13).
  signIn(cx, target, link) {
    this.menu = null;
    if (!this.overlay) return;
    try {
      run("tab.new", { name: SIGN_IN_TAB, argv: signInArgv(cliPath(appHome()), target, link) });
      this.signingIn = startSignIn(this.doc, target, link);
      this.error = null;
    } catch (e) {
      this.error = `Couldn't open the sign-in tab: ${e?.message ?? e}`;
    }
    cx.notify();
  }

  dismissDuplicate(cx, email) {
    const ui = shared(UI_KEY);
    setShared(UI_KEY, { ...(isObject(ui) ? ui : {}), duplicateDismissed: email });
    cx.notify();
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    if (this.menu) this.menu = null;
    else if (this.removing) this.removing = null;
    else closeOverlay(this.overlay ?? props()?.overlay);
    cx.notify();
  }

  render() {
    const t = theme();
    const ui = shared(UI_KEY);
    const m = accountsModel({
      accounts: this.doc,
      settings: this.settings,
      dismissed: isObject(ui) ? ui.duplicateDismissed ?? null : null,
      signingIn: this.signingIn,
    });
    const root = v_flex().id("ca-accounts").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5);
    const header = h_flex().flex_none().px(18).pt(16).pb(6).gap(8).items_center()
      .child(image(CLAUDE_ICON).size(16).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(m.heading))
      .child(div().text_size(11).text_color(t.dim).child("Esc"));

    if (this.removing) return root.child(header).child(this.removal(t));

    const body = v_flex().id("ca-accounts-body").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(18).pb(16).gap(14)
        .child(div().text_size(12).text_color(t.muted).child(m.intro))
        .child(v_flex().gap(10)
          .child(v_flex().gap(2)
            .child(div().text_size(13).font_semibold().child(m.title))
            .child(div().text_size(11.5).text_color(t.dim).child(m.help)))
          .child(h_flex().gap(12).items_center()
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().font_medium().child(m.listTitle))
              .child(div().text_size(11.5).text_color(t.dim).child(m.listHelp)))
            .child(this.splitButton(t, "add", m.add, m.copyLink, "outline", !this.busy, (cx) => this.signIn(cx, "new", false), (cx) => this.signIn(cx, "new", true), PLUS)))
          .when(Boolean(m.signInNote), (el) => el.child(h_flex().id("ca-accounts-signin-note").px(10).py(7).gap(8).items_center().rounded(7)
            .bg(t.raised).text_size(11.5).text_color(t.muted)
            .child(div().w(10).flex_none().text_color(t.dim).frames(SPINNER, 90).child(SPINNER[0]))
            .child(div().flex_1().min_w(0).child(m.signInNote ?? ""))
            .child(div().id("ca-accounts-signin-hide").flex_none().px(4).rounded(4).cursor_pointer().text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.signingIn = null;
                cx.notify();
              })
              .child("Hide"))))
          .child(v_flex().gap(8)
            .child(this.systemDefaultRow(t, m))
            .when(Boolean(m.duplicate), (el) => el.child(h_flex().gap(8).items_start()
              .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.muted).child(m.duplicate?.text ?? ""))
              .child(this.button(t, "ca-accounts-dismiss", m.duplicate?.dismiss ?? "", "ghost", true, (cx) => this.dismissDuplicate(cx, m.duplicate?.email)))))
            .when(Boolean(m.empty), (el) => el.child(div().px(12).py(14).rounded(7).border_1().border_dashed().border_color(t.border)
              .text_size(11.5).text_color(t.dim).child(m.empty ?? "")))
            .children(m.rows.map((row) => this.accountRow(t, m, row)))))
        .child(div().h(1).bg(t.border))
        .child(this.settingRow(t, m.setting))
        .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error ?? ""))));
    return root.child(header).child(body);
  }

  // ── Rows ──────────────────────────────────────────────────────────────────

  // A card: Orca's row, the active one raised.
  card(t, id, active) {
    return h_flex().id(id).w_full().px(12).py(9).gap(10).items_center().rounded(7).border_1()
      .border_color(active ? t.input : t.border)
      .when(active, (el) => el.bg(t.selected));
  }

  badge(t, text) {
    return div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(text);
  }

  // The left part of a row: a click picks it, unless it can't be picked.
  pick(t, id, enabled, title, badges, subtitle, hint = null) {
    const running = this.busy === `select:${id}`;
    return v_flex().id(`ca-accounts-pick-${id}`).flex_1().min_w(0).gap(2)
      .when(enabled && !this.busy, (el) => el.cursor_pointer().on_click((_e, cx) => this.select(cx, id)))
      .child(h_flex().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().font_medium().child(title))
        .children(badges.map((b) => this.badge(t, b)))
        .when(running, (el) => el.child(div().w(10).flex_none().text_color(t.muted).frames(SPINNER, 90).child(SPINNER[0]))))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(subtitle))
      .when(Boolean(hint), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(hint ?? "")));
  }

  systemDefaultRow(t, m) {
    const d = m.systemDefault;
    return this.card(t, "ca-accounts-default", d.active)
      .when(d.canSelect && !this.busy, (el) => el.hover((s) => s.bg(t.hover)))
      .child(this.pick(t, d.id, d.canSelect, d.title, d.active ? [m.activeBadge] : [], d.subtitle))
      .when(d.canSignIn, (el) => el.child(this.splitButton(t, `signin:${d.id}`, m.signInAgain, m.copyLink, "ghost", !this.busy,
        (cx) => this.signIn(cx, "default", false), (cx) => this.signIn(cx, "default", true))));
  }

  accountRow(t, m, row) {
    return this.card(t, `ca-accounts-row-${row.id}`, row.active)
      .when(row.canSelect && !this.busy, (el) => el.hover((s) => s.bg(t.hover)))
      .child(this.pick(t, row.id, row.canSelect, row.email, row.badges, row.subtitle, row.hint))
      .child(h_flex().flex_none().gap(4).items_center()
        .child(this.splitButton(t, `signin:${row.id}`, m.signInAgain, m.copyLink, "ghost", !this.busy,
          (cx) => this.signIn(cx, row.id, false), (cx) => this.signIn(cx, row.id, true)))
        .child(this.button(t, `ca-accounts-remove-${row.id}`, this.busy === `remove:${row.id}` ? "Removing…" : m.remove, "ghost", !this.busy, (cx) => {
          this.removing = row.id;
          this.menu = null;
          cx.notify();
        })));
  }

  // S2's setting: its title and Orca's help text, and a ▾ menu of the three.
  settingRow(t, s) {
    const open = this.menu === "mode";
    const trigger = h_flex().id("ca-accounts-mode").w(150).h(28).px(10).gap(6).items_center().rounded(7).border_1()
      .border_color(t.input).bg(t.raised).cursor_pointer().hover((st) => st.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().child(this.busy === "mode" ? "Saving…" : s.valueLabel))
      .child(svg(CHEVRON).size(12).flex_none().text_color(t.dim));
    const content = this.menuList(t, s.options.map((o) => ({
      id: `ca-accounts-mode-${o.value}`,
      label: o.label,
      checked: o.selected,
      run: (cx) => this.setMode(cx, o.value),
    })), 150);
    return h_flex().gap(16).items_center()
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_medium().child(s.title))
        .child(div().text_size(11.5).text_color(t.dim).child(s.description)))
      .child(this.popover("ca-accounts-mode-menu", "mode", open, !this.busy, trigger, content));
  }

  // Remove's question, in place of the list (Orca's dialog over its pane).
  removal(t) {
    const account = accountsList(this.doc).find((a) => a.id === this.removing) ?? { id: this.removing };
    const q = removePrompt(account);
    return v_flex().flex_1().min_h(0).px(18).pt(10).pb(14).gap(10)
      .child(div().text_size(14).font_semibold().child(q.title))
      .child(div().text_color(t.muted).child(q.body))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(this.button(t, "ca-accounts-remove-cancel", q.cancel, "outline", true, (cx) => {
          this.removing = null;
          cx.notify();
        }))
        .child(this.button(t, "ca-accounts-remove-confirm", q.confirm, "danger", true, (cx) => this.confirmRemove(cx))));
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  // variant: "outline" (a bordered button), "ghost" (text until hovered),
  // "danger" or "primary".
  button(t, id, label, variant, enabled, action) {
    const danger = variant === "danger";
    const primary = variant === "primary";
    return h_flex().id(id).flex_none().h(26).px(9).gap(5).items_center().rounded(6).text_size(12)
      .when(variant === "outline", (el) => el.border_1().border_color(t.input).bg(t.raised))
      .when(danger, (el) => el.border_1().border_color(t.blocked).bg(`${t.blocked}1f`).text_color(t.blocked))
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(variant === "ghost", (el) => el.text_color(t.muted))
      .when(enabled, (el) => el.cursor_pointer()
        .hover((s) => (variant === "ghost" ? s.bg(t.hover).text_color(t.foreground) : s.opacity(0.88)))
        .on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(label);
  }

  // Orca's ButtonGroup: the action, then ▾ with its one item.
  splitButton(t, key, label, itemLabel, variant, enabled, action, itemAction, icon = null) {
    const id = `ca-accounts-${key.replace(/[^a-z0-9-]/gi, "-")}`;
    const main = this.button(t, `${id}-main`, label, variant, enabled, action)
      .when(Boolean(icon), (el) => el.child(svg(icon ?? PLUS).size(12).flex_none()));
    const trigger = this.button(t, `${id}-more`, "", variant, enabled, () => {})
      .px(5)
      .child(svg(CHEVRON).size(12).flex_none());
    const content = this.menuList(t, [{ id: `${id}-link`, label: itemLabel, checked: false, run: itemAction }], 220);
    return h_flex().flex_none().gap(1).items_center()
      .child(main)
      .child(this.popover(`${id}-menu`, key, this.menu === key, enabled, trigger, content));
  }

  // A ▾ menu: the trigger opens it, a press outside or Esc closes it.
  popover(id, key, open, enabled, trigger, content) {
    if (!enabled) return trigger;
    return Popover.new(id)
      .anchor("top_right")
      .open(open)
      .on_open_change((next, cx) => {
        this.menu = next ? key : null;
        cx.notify();
      })
      .trigger(trigger)
      .content(content);
  }

  menuList(t, items, width) {
    return v_flex().w(width).p(4).mt(4).rounded(8).border_1().border_color(t.border).bg(t.popover).text_size(12.5)
      .children(items.map((it) => h_flex().id(it.id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.menu = null;
          it.run(cx);
          cx.notify();
        })
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(it.checked, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.foreground)))));
  }
}
