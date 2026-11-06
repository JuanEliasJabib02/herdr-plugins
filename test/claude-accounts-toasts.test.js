// claude-accounts T7: what the mod says about a switch, and the two views
// that answer it (S2, S3, D8, D13). All pure, so nothing here touches Herdr
// or the state folder: a reader gets a fixture's text, as a view gets
// herdr's readTextFile.
//   toasts.js         react(): the footer's toasts, the confirm view's
//                     opening and the sign-in link's copy, each once
//   accounts-model.js the accounts view (Manage Accounts…, S2) and the
//                     confirm view (Orca's ClaudeAccountSwitchDialog, D8):
//                     their texts, Orca's word for word, and the CLI
//                     commands their buttons run
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { react, SEEN_KEY } from "../claude-accounts/mods/claude-accounts/toasts.js";
import {
  accountLabel, accountsModel, removePrompt, signInArgv, cliError, signInDone,
  confirmModel, initialTicked, toggleTicked, toggleGroup, confirmCommands,
} from "../claude-accounts/mods/claude-accounts/accounts-model.js";
import { readAccounts, readRestart, readPendingSwitch, readSettings } from "../claude-accounts/mods/claude-accounts/store.js";

// Dates are local, as in Orca and in Herdr's runtime: these tests read them
// in Bogota, the fixtures' zone.
process.env.TZ = "America/Bogota";

// The fixtures' "now": Nov 6 2026, 4:20 PM in Bogota.
const NOW = 1794000000000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const fixture = (name) => readFileSync(new URL(`fixtures/claude-accounts/${name}`, import.meta.url), "utf8");

// The fixture's people: System default (ana@example.com, needs sign-in),
// ana (Orca's, active) and ben (made here).
const ANA = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const BEN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const accounts = () => readAccounts(fixture("accounts.v1.json"));

// pending-switch.json as T4 writes it now: the fixture plus a mode, and any
// sessions given instead of the fixture's.
function pending(mode, sessions, extra = {}) {
  const raw = JSON.parse(fixture("pending-switch.json"));
  return readPendingSwitch(JSON.stringify({ ...raw, ...(mode ? { mode } : {}), ...(sessions ? { sessions } : {}), ...extra }));
}

const session = (terminal, group, reason = null, account = ANA, title = `claude · ${terminal}`) => ({ terminal, title, account, group, reason });

// A switch item in restart.json, ben's target.
function item(id, state, extra = {}) {
  return {
    id, kind: "switch", terminal: "t12", from: ANA, to: BEN, sessionId: "3f1c2b7e-8a4d-4e55-9a51-0c2d6f1b7a10",
    args: [], message: null, state, code: null, detail: null, claimedBy: null, updatedAt: NOW - MIN, ...extra,
  };
}
const queue = (...items) => readRestart(JSON.stringify({ items }));

// react with the fixtures' accounts and now.
const run = (state, seen) => react({ accounts: accounts(), now: NOW, ...state }, seen);

// ── react: pending-switch.json (D8) ────────────────────────────────────────

test("react: an Ask (the fixture, no mode) with sessions on the outgoing account opens the confirm view once", () => {
  const first = run({ pendingSwitch: readPendingSwitch(fixture("pending-switch.json")) }, {});
  assert.equal(first.openConfirm, true);
  assert.deepEqual(first.notify, []);
  assert.ok(first.seen, "the seen map changed");
  const again = run({ pendingSwitch: readPendingSwitch(fixture("pending-switch.json")) }, first.seen);
  assert.equal(again.openConfirm, false);
  assert.deepEqual(again.notify, []);
  assert.equal(again.seen, null, "nothing new: the footer has nothing to store");
});

test("react: Always restart is Orca's 'Restarting N Claude sessions on {account}', with the others not moved and Review", () => {
  const r = run({ pendingSwitch: pending("restart") }, {});
  assert.equal(r.openConfirm, false);
  assert.deepEqual(r.notify, [{
    title: "Restarting 2 Claude sessions on ben@example.org",
    body: "2 other sessions weren't moved. Click to review.",
    level: "success",
    action: { name: "claude-accounts.open-confirm" },
  }]);
  assert.deepEqual(run({ pendingSwitch: pending("restart") }, r.seen).notify, [], "shown once");
});

test("react: the restart toast's singulars, and no Review when every session moved", () => {
  const one = run({ pendingSwitch: pending("restart", [session("t12", "onAccount"), session("t21", "elsewhere", null, "default")]) }, {});
  assert.deepEqual(one.notify, [{
    title: "Restarting 1 Claude session on ben@example.org",
    body: "1 other session wasn't moved. Click to review.",
    level: "success",
    action: { name: "claude-accounts.open-confirm" },
  }]);
  const alone = run({ pendingSwitch: pending("restart", [session("t12", "onAccount"), session("t13", "onAccount")]) }, {});
  assert.deepEqual(alone.notify, [{ title: "Restarting 2 Claude sessions on ben@example.org", level: "success" }]);
});

test("react: unreadable terminals are Orca's 'Couldn't check N terminals for Claude', in Ask and in Always restart, and never count as not moved", () => {
  const sessions = [session("t12", "onAccount"), session("t40", "cantMove", "unreadable", null), session("t41", "cantMove", "unreadable", null)];
  const ask = run({ pendingSwitch: pending("ask", sessions) }, {});
  assert.equal(ask.openConfirm, true);
  assert.deepEqual(ask.notify, [{
    title: "Couldn't check 2 terminals for Claude.",
    body: "Any Claude running there stays on ana@example.com until restarted.",
    level: "warning",
  }]);
  const restart = run({ pendingSwitch: pending("restart", sessions.slice(0, 2)) }, {});
  assert.deepEqual(restart.notify, [
    {
      title: "Couldn't check 1 terminal for Claude.",
      body: "If Claude is running there, it stays on ana@example.com until restarted.",
      level: "warning",
    },
    { title: "Restarting 1 Claude session on ben@example.org", level: "success" },
  ]);
});

test("react: with nothing to move, a session another terminal also holds gets Orca's shared warning, and no dialog", () => {
  const r = run({ pendingSwitch: pending("ask", [session("t12", "cantMove", "shared-session"), session("t13", "cantMove", "shared-session")]) }, {});
  assert.equal(r.openConfirm, false);
  assert.deepEqual(r.notify, [{
    title: "2 Claude sessions stay on ana@example.com because another pane has the same conversation open.",
    body: "Restarting could reopen the other pane's conversation.",
    level: "warning",
  }]);
  const one = run({ pendingSwitch: pending("restart", [session("t12", "cantMove", "shared-session"), session("t9", "cantMove", "shared-session", "default")]) }, {});
  assert.deepEqual(one.notify.map((n) => n.title), ["1 Claude session stays on ana@example.com because another pane has the same conversation open."],
    "only the outgoing account's count, as Orca's");
});

test("react: an old question (past the fresh window) and Never restart say nothing, and the old one is still marked seen", () => {
  const old = run({ pendingSwitch: pending("ask", null, { at: NOW - 11 * MIN }) }, {});
  assert.equal(old.openConfirm, false);
  assert.deepEqual(old.notify, []);
  assert.ok(old.seen && Object.keys(old.seen).length > 0);
  const keep = run({ pendingSwitch: pending("keep") }, {});
  assert.equal(keep.openConfirm, false);
  assert.deepEqual(keep.notify, []);
});

test("react: a new switch (a new `at`) asks again", () => {
  const first = run({ pendingSwitch: pending("ask") }, {});
  const next = run({ pendingSwitch: pending("ask", null, { at: NOW + 5000 }) }, first.seen);
  assert.equal(next.openConfirm, true);
});

// ── react: restart.json (D8) ───────────────────────────────────────────────

test("react: a switch item waiting for idle is said once, with where it goes and a way to the terminal", () => {
  const r = run({ restart: queue(item("sw-1", "waitingIdle")), pendingSwitch: pending("restart", [session("t12", "onAccount", null, ANA, "claude · herdr-plugins")]) }, {});
  assert.deepEqual(r.notify.at(-1), {
    title: "Claude in claude · herdr-plugins is busy",
    body: "It restarts on ben@example.org once it's idle.",
    level: "info",
    action: { name: "pane.focus", args: { terminal: "t12" } },
  });
  assert.deepEqual(run({ restart: queue(item("sw-1", "waitingIdle")) }, r.seen).notify, []);
});

test("react: several items waiting at once are one toast; the fixture's waiting item, by terminal id without a title", () => {
  const two = run({ restart: queue(item("sw-1", "waitingIdle"), item("sw-2", "waitingIdle", { terminal: "t14" })) }, {});
  assert.deepEqual(two.notify, [{ title: "2 Claude sessions are busy", body: "Each one restarts on ben@example.org once it's idle.", level: "info" }]);
  const fix = run({ restart: readRestart(fixture("restart.json")) }, {});
  assert.deepEqual(fix.notify, [{
    title: "Claude in t12 is busy",
    body: "It restarts on ben@example.org once it's idle.",
    level: "info",
    action: { name: "pane.focus", args: { terminal: "t12" } },
  }], "the fixture's resume jobs (done, failed, timeout) belong to their caller: no toast");
});

test("react: a failed switch item gives the manual `claude --resume <sid>` and why; a timeout too", () => {
  const line = "CLAUDE_ACCOUNTS_DIR='/Users/ana/.config/herdr-app/claude-accounts-profiles/x/home' claude --model opus --resume 3f1c2b7e-8a4d-4e55-9a51-0c2d6f1b7a10";
  const failed = item("sw-3", "failed", { code: 9, detail: `couldn't type the resume line (hc send timed out): ${line}` });
  const timeout = item("sw-4", "timeout", { code: 4, terminal: "t14", detail: `the shell didn't come back within 30 s: ${line}` });
  const r = run({ restart: queue(failed, timeout) }, {});
  assert.deepEqual(r.notify, [
    {
      title: "Couldn't restart Claude in t12",
      body: "Run claude --resume 3f1c2b7e-8a4d-4e55-9a51-0c2d6f1b7a10 there. Couldn't type the resume line (hc send timed out).",
      level: "error",
      action: { name: "pane.focus", args: { terminal: "t12" } },
    },
    {
      title: "Claude in t14 didn't restart in time",
      body: "Run claude --resume 3f1c2b7e-8a4d-4e55-9a51-0c2d6f1b7a10 there. The shell didn't come back within 30 s.",
      level: "error",
      action: { name: "pane.focus", args: { terminal: "t14" } },
    },
  ]);
  assert.deepEqual(run({ restart: queue(failed, timeout) }, r.seen).notify, [], "each once");
});

test("react: a failure with no line to type says only why; landed elsewhere is a warning; done and cancelled say nothing", () => {
  const r = run({
    restart: queue(
      item("sw-5", "failed", { detail: "there's no conversation to resume yet in terminal t12: Claude hasn't saved session 3f1c (it has no messages)" }),
      item("sw-6", "landedElsewhere", { terminal: "t14", detail: "the new Claude runs on default (/Users/ana/.claude)" }),
      item("sw-7", "done", { code: 0 }),
      item("sw-8", "cancelled", { code: 10 }),
    ),
  }, {});
  assert.deepEqual(r.notify, [
    {
      title: "Couldn't restart Claude in t12",
      body: "There's no conversation to resume yet in terminal t12: Claude hasn't saved session 3f1c (it has no messages).",
      level: "error",
      action: { name: "pane.focus", args: { terminal: "t12" } },
    },
    {
      title: "Claude in t14 restarted on another account",
      body: "The new Claude runs on default (/Users/ana/.claude).",
      level: "warning",
      action: { name: "pane.focus", args: { terminal: "t14" } },
    },
  ]);
});

test("react: items older than the fresh window are marked seen, never shown", () => {
  const r = run({ restart: queue(item("sw-9", "failed", { updatedAt: NOW - 30 * MIN, detail: "runner gone: claude --resume abc" })) }, {});
  assert.deepEqual(r.notify, []);
  assert.ok(r.seen && Object.keys(r.seen).some((k) => k.includes("sw-9")));
});

// ── react: login-link (D13) ────────────────────────────────────────────────

test("react: a captured sign-in link is copied once, with Orca's toast", () => {
  const link = fixture("login-link");
  const r = run({ loginLink: link }, {});
  assert.equal(r.copyLink, link);
  assert.deepEqual(r.notify, [{
    title: "Sign-in link copied.",
    body: "Open it in a private window to sign in with a different account.",
    level: "success",
  }]);
  const again = run({ loginLink: link }, r.seen);
  assert.equal(again.copyLink, null);
  assert.deepEqual(again.notify, []);
  assert.equal(run({ loginLink: "https://evil.example/?redirect_uri=http://localhost/" }, {}).copyLink, null, "only Orca's kind of link");
});

// ── react: shape, the seen map, raw texts ──────────────────────────────────

test("react: nothing at all says nothing; the seen map is pruned after two days and returned only when it changed", () => {
  assert.deepEqual(react({}, undefined), { notify: [], openConfirm: false, copyLink: null, seen: null });
  assert.deepEqual(react(undefined, null), { notify: [], openConfirm: false, copyLink: null, seen: null });
  const old = { "item:gone:failed": NOW - 3 * DAY, "item:kept:failed": NOW - DAY, junk: true };
  assert.deepEqual(react({ now: NOW }, old).seen, { "item:kept:failed": NOW - DAY });
  assert.equal(SEEN_KEY, "claude-accounts.seen");
});

test("react: takes the files' raw texts as well as store.js's readings, and labels an account it doesn't know as Orca does", () => {
  const raw = react({ pendingSwitch: JSON.stringify({ ...JSON.parse(fixture("pending-switch.json")), mode: "restart" }), now: NOW }, {});
  assert.equal(raw.notify[0].title, "Restarting 2 Claude sessions on Claude account");
  const toDefault = react({ pendingSwitch: JSON.stringify({ ...JSON.parse(fixture("pending-switch.json")), to: "default", mode: "restart" }), now: NOW }, {});
  assert.equal(toDefault.notify[0].title, "Restarting 2 Claude sessions on System default");
});

// ── accountLabel ───────────────────────────────────────────────────────────

test("accountLabel: Orca's getClaudeAccountLabel: System default, the email, else 'Claude account'", () => {
  assert.equal(accountLabel(accounts(), "default"), "System default");
  assert.equal(accountLabel(accounts(), null), "System default");
  assert.equal(accountLabel(accounts(), BEN), "ben@example.org");
  assert.equal(accountLabel(accounts().accounts, ANA), "ana@example.com");
  assert.equal(accountLabel(accounts(), "nope"), "Claude account");
  assert.equal(accountLabel(null, "nope"), "Claude account");
});

// ── The confirm view (Orca's ClaudeAccountSwitchDialog) ────────────────────

test("confirm: an Ask with four sessions lists them in Orca's groups, the outgoing ones ticked", () => {
  const p = readPendingSwitch(fixture("pending-switch.json"));
  const ticked = initialTicked(p);
  assert.deepEqual(ticked, ["t12", "t14"]);
  const m = confirmModel(p, accounts(), ticked);
  assert.equal(m.review, false);
  assert.equal(m.title, "Switched to ben@example.org");
  assert.equal(m.body, "2 Claude sessions are still running on ana@example.com. Restarting continues each conversation on ben@example.org. Busy sessions wait for idle before restarting.");
  assert.equal(m.showList, true);
  assert.deepEqual(m.groups.map((g) => [g.title, g.count, g.fixed, g.state]), [
    ["Running on ana@example.com", 2, false, "all"],
    ["Not on ana@example.com", 1, false, "none"],
    ["Can't move", 1, true, "none"],
  ]);
  assert.deepEqual(m.groups[1].sessions[0], { terminal: "t21", title: "claude · notes", sub: "t21", reason: "System default", checked: false, fixed: false });
  assert.deepEqual(m.groups[2].sessions[0], { terminal: "t30", title: "claude", sub: "t30", reason: "No shell to come back to", checked: false, fixed: true });
  assert.deepEqual(m.dontAsk, { label: "Don't ask again (restart automatically)", hint: "You can turn this off in Manage Accounts…" });
  assert.equal(m.keep, "Keep as is");
  assert.deepEqual(m.restart, { label: "Restart 2 sessions", enabled: true, terminals: ["t12", "t14"] });
});

test("confirm: one session alone shows no list and the singular body and 'Restart session'", () => {
  const p = pending("ask", [session("t12", "onAccount")]);
  const m = confirmModel(p, accounts(), initialTicked(p));
  assert.equal(m.showList, false);
  assert.equal(m.body, "1 Claude session is still running on ana@example.com. Restarting continues the conversation on ben@example.org. Busy sessions wait for idle before restarting.");
  assert.deepEqual(m.restart, { label: "Restart session", enabled: true, terminals: ["t12"] });
});

test("confirm: nothing ticked is disabled 'Restart session'; one of two ticked is 'Restart session' too", () => {
  const p = readPendingSwitch(fixture("pending-switch.json"));
  assert.deepEqual(confirmModel(p, accounts(), []).restart, { label: "Restart session", enabled: false, terminals: [] });
  assert.deepEqual(confirmModel(p, accounts(), ["t14"]).restart, { label: "Restart session", enabled: true, terminals: ["t14"] });
  assert.deepEqual(confirmModel(p, accounts(), ["t14", "t21", "t30"]).restart.terminals, ["t14", "t21"], "a can't-move session is never chosen");
  assert.equal(confirmModel(p, accounts(), ["t12"]).groups[0].state, "some");
});

test("confirm: Review (Always restart) hides the sessions already restarting and Don't ask again, always lists, and starts unticked", () => {
  const p = pending("restart", [session("t12", "onAccount"), session("t21", "elsewhere", null, "default"), session("t40", "cantMove", "unreadable", null)]);
  const ticked = initialTicked(p);
  assert.deepEqual(ticked, []);
  const m = confirmModel(p, accounts(), ticked);
  assert.equal(m.review, true);
  assert.equal(m.body, "1 other Claude session wasn't moved to ben@example.org.");
  assert.equal(m.showList, true);
  assert.deepEqual(m.groups.map((g) => g.title), ["Not on ana@example.com"], "the unreadable terminal isn't listed");
  assert.equal(m.dontAsk, null);
  assert.deepEqual(m.restart, { label: "Restart session", enabled: false, terminals: [] });
  const fix = confirmModel(pending("restart"), accounts(), []);
  assert.equal(fix.body, "2 other Claude sessions weren't moved to ben@example.org.");
});

test("confirm: Orca's reason labels for the sessions that can't move", () => {
  const p = pending("ask", [
    session("t12", "onAccount"),
    session("t1", "cantMove", "own-program"),
    session("t2", "cantMove", "no-session"),
    session("t3", "cantMove", "shared-session"),
    session("t4", "cantMove", "unknown-account", null),
    session("t5", "cantMove", "something-new"),
  ]);
  const m = confirmModel(p, accounts(), initialTicked(p));
  assert.deepEqual(m.groups.at(-1).sessions.map((s) => s.reason), [
    "No shell to come back to", "Can't resume", "Also open in another pane", "Account unknown", "Can't move",
  ]);
});

test("confirm: with no question waiting, the model says so", () => {
  const m = confirmModel(null, accounts(), []);
  assert.equal(m.empty, true);
  assert.equal(m.title, "No switch is waiting");
  assert.deepEqual(m.groups, []);
  assert.equal(m.restart.enabled, false);
});

test("confirm: ticking a session and Orca's group checkbox (all ticked unticks them all, else ticks them all)", () => {
  assert.deepEqual(toggleTicked(["t12"], "t14", true), ["t12", "t14"]);
  assert.deepEqual(toggleTicked(["t12", "t14"], "t12", false), ["t14"]);
  assert.deepEqual(toggleTicked(["t12"], "t12", true), ["t12"]);
  assert.deepEqual(toggleGroup(["t12", "t14"], ["t12", "t14"]), []);
  assert.deepEqual(toggleGroup(["t12"], ["t12", "t14"]), ["t12", "t14"]);
  assert.deepEqual(toggleGroup(["t21"], ["t12", "t14"]), ["t21", "t12", "t14"]);
});

test("confirm: the answers are T4's `restart --answer`, plus `settings set switchMode restart` for Don't ask again", () => {
  assert.deepEqual(confirmCommands("keep", { chosen: ["t12"], dontAskAgain: false }), [["restart", "--answer", "keep", "--json"]]);
  assert.deepEqual(confirmCommands("restart", { chosen: ["t12", "t21"], dontAskAgain: true }), [
    ["restart", "--answer", "restart", "--terminal", "t12", "--terminal", "t21", "--json"],
    ["settings", "set", "switchMode", "restart", "--json"],
  ]);
  assert.deepEqual(confirmCommands("keep", { chosen: [], dontAskAgain: true }), [
    ["restart", "--answer", "keep", "--json"],
    ["settings", "set", "switchMode", "restart", "--json"],
  ], "closing answers keep, with the box as it is, as Orca's onOpenChange does");
  assert.deepEqual(confirmCommands("restart", { chosen: [], dontAskAgain: false }), [["restart", "--answer", "keep", "--json"]],
    "a restart with nothing chosen never reaches the CLI, which would restart every listed one");
  assert.deepEqual(confirmCommands("restart", { chosen: ["t21"], dontAskAgain: true, review: true }), [
    ["restart", "--answer", "restart", "--terminal", "t21", "--json"],
  ], "Review has no Don't ask again");
});

// ── The accounts view (Manage Accounts…, S2) ───────────────────────────────

test("accounts: one row per saved account: email, This device, org · date, Active; no System default while it isn't active (S10)", () => {
  const m = accountsModel({ accounts: accounts(), settings: readSettings(fixture("settings.json")) });
  assert.equal(m.title, "Claude Accounts");
  assert.equal(m.help, "Switching applies to the next Claude you start in any tab.");
  assert.equal(m.add, "Add Account");
  assert.equal(m.copyLink, "Copy sign-in link instead");
  // S10: the Mac's own login isn't one of Herdr's accounts, so neither it, its
  // duplicate notice nor the intro that offers it show.
  assert.equal(m.systemDefault, null);
  assert.equal(m.duplicate, null);
  assert.equal(m.intro, null);
  assert.deepEqual(m.rows, [
    { id: ANA, email: "ana@example.com", badges: ["This device", "Active"], subtitle: "Example Org · Oct 29, 1:53 PM", hint: null, active: true, needsSignIn: false, canSelect: false },
    { id: BEN, email: "ben@example.org", badges: ["This device"], subtitle: "Acme · Nov 2, 5:25 PM", hint: null, active: false, needsSignIn: false, canSelect: true },
  ]);
  assert.equal(m.empty, null);
});

test("accounts: S2's setting, with Orca's title, help text and three choices", () => {
  const m = accountsModel({ accounts: accounts(), settings: readSettings(fixture("settings.json")) });
  assert.deepEqual(m.setting, {
    title: "When you switch accounts while Claude is running in terminals",
    description: "Restarting continues each terminal conversation on the new account.",
    value: "restart",
    valueLabel: "Always restart",
    options: [
      { value: "ask", label: "Ask", selected: false },
      { value: "restart", label: "Always restart", selected: true },
      { value: "keep", label: "Never restart", selected: false },
    ],
  });
  assert.equal(accountsModel({ accounts: accounts(), settings: readSettings(null) }).setting.valueLabel, "Ask", "Orca's default");
});

test("accounts: Orca's duplicate notice for an active System default, until dismissed for that email", () => {
  const active = () => ({ ...accounts(), active: "default" });
  const m = accountsModel({ accounts: active(), settings: readSettings(null) });
  assert.deepEqual(m.systemDefault, {
    id: "default",
    title: "System default: ana@example.com",
    subtitle: "Use your current this device Claude login.",
    active: true,
    canSelect: false,
    canSignIn: true,
  });
  assert.ok(m.intro);
  assert.deepEqual(m.duplicate, {
    email: "ana@example.com",
    text: "System default is signed in as ana@example.com, which is also a saved account. An earlier Orca version may have copied that login there. If it is not your own login, select System default and run claude /login.",
    dismiss: "Dismiss",
  });
  assert.equal(accountsModel({ accounts: active(), dismissed: "ANA@example.com" }).duplicate, null);
  assert.ok(accountsModel({ accounts: active(), dismissed: "someone@else.com" }).duplicate);
});

test("accounts: a row that needs sign-in says Orca's line and can't be picked; System default is active when `active` is default", () => {
  const doc = accounts();
  doc.active = "default";
  doc.accounts[2] = { ...doc.accounts[2], needsSignIn: true };
  doc.accounts[0] = { ...doc.accounts[0], needsSignIn: false, email: null, duplicateOf: null };
  const m = accountsModel({ accounts: doc });
  assert.equal(m.systemDefault.title, "System default");
  assert.equal(m.systemDefault.active, true);
  assert.equal(m.systemDefault.canSelect, false);
  assert.equal(m.systemDefault.canSignIn, true, "no login at all: Sign in again");
  assert.equal(m.duplicate, null);
  assert.deepEqual(m.rows[1], { id: BEN, email: "ben@example.org", badges: ["This device"], subtitle: "Sign in again to use this account", hint: null, active: false, needsSignIn: true, canSelect: false });
  assert.equal(m.rows[0].subtitle, "Example Org · Oct 29, 1:53 PM");
});

test("accounts (S8): a folder signed in as someone else keeps its saved email, and says so under its org and date; it can't be picked", () => {
  const doc = accounts();
  doc.accounts[2] = { ...doc.accounts[2], needsSignIn: true, signedInAs: "dee@example.com" };
  const m = accountsModel({ accounts: doc });
  assert.deepEqual(m.rows[1], {
    id: BEN,
    email: "ben@example.org",
    badges: ["This device"],
    subtitle: "Acme · Nov 2, 5:25 PM",
    hint: "Now signed in as dee@example.com",
    active: false,
    needsSignIn: true,
    canSelect: false,
  });
  assert.equal(m.rows[0].hint, null, "an account with its own login has no hint");
  assert.equal(accountLabel(doc, BEN), "ben@example.org", "the switch dialog and the toasts name it the same");
});

test("accounts: no saved account is 'No other accounts'; no date shows the org alone", () => {
  const doc = accounts();
  assert.equal(accountsModel({ accounts: { ...doc, accounts: [doc.accounts[0]] } }).empty, "No other accounts");
  const bare = { ...doc, accounts: [doc.accounts[0], { ...doc.accounts[1], lastAuthenticatedAt: null }] };
  assert.equal(accountsModel({ accounts: bare }).rows[0].subtitle, "Example Org");
  assert.equal(accountsModel({ accounts: readAccounts(null) }).systemDefault.title, "System default");
});

test("accounts: the sign-in note says closing the tab cancels, until the account's sign-in lands", () => {
  const doc = accounts();
  const signingIn = { target: BEN, link: false, before: { lastAuthenticatedAt: 1793658301633, ids: doc.accounts.map((a) => a.id) } };
  assert.equal(accountsModel({ accounts: doc, signingIn }).signInNote,
    "Signing in to ben@example.org in a new tab. Closing the tab cancels the sign-in.");
  assert.equal(accountsModel({ accounts: doc, signingIn: { ...signingIn, target: "new", link: true } }).signInNote,
    "Adding an account in a new tab. Closing the tab cancels the sign-in. Its sign-in link is copied as soon as Claude hands it over.");
  assert.equal(signInDone(signingIn, doc), false);
  const signed = { ...doc, accounts: doc.accounts.map((a) => (a.id === BEN ? { ...a, lastAuthenticatedAt: NOW } : a)) };
  assert.equal(signInDone(signingIn, signed), true);
  const added = { ...doc, accounts: [...doc.accounts, { ...doc.accounts[2], id: "new-one" }] };
  assert.equal(signInDone({ ...signingIn, target: "new" }, added), true);
  assert.equal(signInDone({ ...signingIn, target: "new" }, doc), false);
  const fixedDefault = { ...doc, accounts: doc.accounts.map((a) => (a.isDefault ? { ...a, needsSignIn: false } : a)) };
  assert.equal(signInDone({ target: "default", link: false, before: { needsSignIn: true, email: "ana@example.com", ids: [] } }, fixedDefault), true);
});

test("accounts: Remove asks first, in Orca's words, saying what goes for a folder made here and for Orca's", () => {
  const doc = accounts();
  assert.deepEqual(removePrompt(doc.accounts[2]), {
    title: "Remove Claude Account?",
    body: "This deletes ben@example.org's Claude folder from this computer. Chat history shared with System default stays. If it is selected, the next Claude you start uses System default.",
    cancel: "Cancel",
    confirm: "Remove Account",
  });
  assert.equal(removePrompt(doc.accounts[1]).body,
    "This forgets ana@example.com here. Its Claude folder stays, because Orca uses it too. If it is selected, the next Claude you start uses System default.");
});

test("accounts: sign in runs the CLI's login in a tab, with --link for the copied link; a failed command says its last stderr line", () => {
  assert.deepEqual(signInArgv("/x/bin/claude-accounts", BEN, false), ["/x/bin/claude-accounts", "login", BEN]);
  assert.deepEqual(signInArgv("/x/bin/claude-accounts", "new", true), ["/x/bin/claude-accounts", "login", "new", "--link"]);
  assert.equal(cliError({ code: 5, stdout: "", stderr: "Sign in to this Claude account again before selecting it.\n" }, "use"),
    "Sign in to this Claude account again before selecting it.");
  assert.equal(cliError({ code: 1, stdout: "", stderr: "" }, "remove"), "claude-accounts remove exited 1.");
  assert.equal(cliError({ code: 0, stdout: "{}", stderr: "" }, "use"), null);
  assert.equal(cliError(new Error("spawn failed"), "use"), "spawn failed");
});
