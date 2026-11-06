// What the accounts view and the confirm view say, and what their buttons
// run (S2, D3, D8, D13). Pure: no herdr or gpui-kit import, so `node --test`
// loads it; accounts.js and confirm.js only draw it. Owner: T7.
//
// The copy is Orca's, word for word, from its sources
// (~/Desktop/Software/Sideprojects/orca/src/renderer/src/components/):
//   settings/accounts/claude/accounts-pane-claude-section.tsx    the pane
//   settings/accounts/claude/claude-running-session-switch-setting.tsx
//   settings/accounts/claude/claude-sign-in-link-menu.tsx
//   settings/accounts/accounts-pane-removal-dialogs.tsx           Remove?
//   ClaudeAccountSwitchDialog.tsx, ClaudeAccountSwitchSessionTree.tsx
// with "Orca" said as "Herdr" where Orca names itself as the app, and
// "Settings → AI Provider Accounts" as "Manage Accounts…". Where Herdr does
// something Orca doesn't (Remove keeps an Orca folder; a terminal whose
// program is Claude itself), the words are this plugin's own.
//
//   accountLabel(accounts, id)        Orca's getClaudeAccountLabel
//   accountsModel({accounts, settings, dismissed, signingIn})
//                                     the accounts view
//   startSignIn(accounts, target, link), signInDone(signingIn, accounts)
//                                     the "closing the tab cancels" note's life
//   removePrompt(account)             Remove's question
//   signInArgv(cli, target, link)     the tab's command: `login <id|new|default> [--link]`
//   cliError(result, command)         what a failed CLI run says, or null
//   confirmModel(pending, accounts, ticked, live), initialTicked(pending),
//   toggleTicked(…), toggleGroup(…), confirmCommands(choice, {…})
//                                     the confirm view
//   statusTerminals(pending), statusArgv(t), withStatus(live, t, result)
//                                     the Working or Idle it reads while open
//   REASONS                           why a session can't move, Orca's labels
//
// Accounts are store.js's readAccounts() (or its `accounts` list); a
// pending switch is its readPendingSwitch(); settings its readSettings().

import { formatDate } from "./format.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

// ── Accounts ───────────────────────────────────────────────────────────────

// readAccounts()'s document or its list → the list.
export function accountsList(accounts) {
  if (Array.isArray(accounts)) return accounts.filter(isObject);
  return isObject(accounts) && Array.isArray(accounts.accounts) ? accounts.accounts.filter(isObject) : [];
}

const SYSTEM_DEFAULT = "System default";
const UNNAMED = "Claude account";

// Orca's getClaudeAccountLabel (lib/claude-account-label.ts): System default
// for "default" (or none), else the account's email, else "Claude account".
export function accountLabel(accounts, id) {
  if (id === null || id === undefined || id === "default") return SYSTEM_DEFAULT;
  return str(accountsList(accounts).find((a) => a.id === id)?.email) ?? UNNAMED;
}

// The host's label (getHostRuntimeLabel) and its sentence form
// (getRuntimeSentenceLabel): every account here is this device's.
const THIS_DEVICE = "This device";
const THIS_DEVICE_SENTENCE = "this device";

const SWITCH_OPTIONS = Object.freeze([
  { value: "ask", label: "Ask" },
  { value: "restart", label: "Always restart" },
  { value: "keep", label: "Never restart" },
]);

// A folder `login new` made (D3: <profiles>/<uuid>/home): Remove deletes
// it. Any other folder (Orca's) stays: the CLI's ownFolder rule.
const HERDR_FOLDER = /\/claude-accounts-profiles\/[0-9a-f-]{36}\/home$/i;
const isHerdrFolder = (configDir) => typeof configDir === "string" && HERDR_FOLDER.test(configDir);

// The accounts view, from top to bottom.
//   accounts   readAccounts()'s document
//   settings   readSettings()'s { switchMode }
//   dismissed  the email whose duplicate notice was dismissed (Orca's
//              claudeCopiedSystemDefaultNoticeDismissed, per email here)
//   signingIn  startSignIn()'s value while a sign-in tab runs, else null
export function accountsModel({ accounts, settings, dismissed = null, signingIn = null } = {}) {
  const list = accountsList(accounts);
  const active = str(isObject(accounts) ? accounts.active : null) ?? "default";
  const def = list.find((a) => a.isDefault === true || a.id === "default") ?? null;
  const defEmail = str(def?.email);
  const defActive = active === "default";
  const saved = list.filter((a) => a !== def);
  const mode = SWITCH_OPTIONS.some((o) => o.value === settings?.switchMode) ? settings.switchMode : "ask";

  const dupEmail = def && str(def.duplicateOf) && defEmail ? defEmail : null;
  const isDismissed = dupEmail && typeof dismissed === "string" && dismissed.trim().toLowerCase() === dupEmail.toLowerCase();

  // System default is the Mac's own login, not one of Herdr's accounts: it,
  // its duplicate notice and the intro that offers it show only while it's
  // the active one (S10).
  return {
    heading: "Claude",
    intro: !defActive ? null : "Optional. Herdr can use your normal Claude login; add accounts only if you want quick switching without moving chat sessions.",
    title: "Claude Accounts",
    help: "Switching applies to the next Claude you start in any tab.",
    listTitle: "Accounts",
    listHelp: `Showing accounts for ${THIS_DEVICE_SENTENCE}. New accounts are added there.`,
    add: "Add Account",
    copyLink: "Copy sign-in link instead",
    signInAgain: "Sign in again",
    remove: "Remove",
    activeBadge: "Active",
    systemDefault: !defActive ? null : {
      id: "default",
      title: defEmail ? `System default: ${defEmail}` : SYSTEM_DEFAULT,
      subtitle: `Use your current ${THIS_DEVICE_SENTENCE} Claude login.`,
      active: defActive,
      canSelect: !defActive,
      // Better than Orca, which only tells you to run claude /login: its
      // login runs here too (`login default`, CLAUDE_CONFIG_DIR unset), when
      // it lapsed or there's none.
      canSignIn: def?.needsSignIn === true || !defEmail,
    },
    duplicate: defActive && dupEmail && !isDismissed
      ? {
        email: dupEmail,
        text: `System default is signed in as ${dupEmail}, which is also a saved account. An earlier Orca version may have copied that login there. If it is not your own login, select System default and run claude /login.`,
        dismiss: "Dismiss",
      }
      : null,
    rows: saved.map((a) => {
      const isActive = a.id === active;
      const needsSignIn = a.needsSignIn === true;
      const date = formatDate(a.lastAuthenticatedAt);
      // Its folder holds someone else's login (D17): the row is still this
      // account's, so it keeps its org and date, and says who's there.
      const signedInAs = needsSignIn ? str(a.signedInAs) : null;
      return {
        id: a.id,
        email: str(a.email) ?? str(a.label) ?? UNNAMED,
        badges: isActive ? [THIS_DEVICE, "Active"] : [THIS_DEVICE],
        subtitle: needsSignIn && !signedInAs ? "Sign in again to use this account" : [str(a.org), date].filter(Boolean).join(" · "),
        hint: signedInAs ? `Now signed in as ${signedInAs}` : null,
        active: isActive,
        needsSignIn,
        // Orca disables picking an account that needs sign-in (the CLI's
        // `use` refuses one with no login, exit 5).
        canSelect: !isActive && !needsSignIn,
      };
    }),
    empty: saved.length === 0 ? "No other accounts" : null,
    setting: {
      title: "When you switch accounts while Claude is running in terminals",
      description: "Restarting continues each terminal conversation on the new account.",
      value: mode,
      valueLabel: SWITCH_OPTIONS.find((o) => o.value === mode).label,
      options: SWITCH_OPTIONS.map((o) => ({ ...o, selected: o.value === mode })),
    },
    signInNote: signingIn ? signInNote(signingIn, list) : null,
  };
}

const CANCEL_NOTE = "Closing the tab cancels the sign-in.";

function signInNote(signingIn, list) {
  const what = signingIn.target === "new"
    ? "Adding an account in a new tab."
    : `Signing in to ${accountLabel(list, signingIn.target)} in a new tab.`;
  const link = signingIn.link ? " Its sign-in link is copied as soon as Claude hands it over." : "";
  return `${what} ${CANCEL_NOTE}${link}`;
}

// What a sign-in started from the view looks for to be done: the account
// as it was when the tab opened.
export function startSignIn(accounts, target, link) {
  const list = accountsList(accounts);
  const a = list.find((x) => (target === "default" ? x.isDefault === true || x.id === "default" : x.id === target));
  return {
    target,
    link: link === true,
    before: {
      lastAuthenticatedAt: a?.lastAuthenticatedAt ?? null,
      needsSignIn: a?.needsSignIn === true,
      email: a?.email ?? null,
      ids: list.map((x) => x.id),
    },
  };
}

// True once the accounts show the sign-in landed (or the account went):
// a new id for `new`, a new sign-in date for a saved account, a changed
// login for System default.
export function signInDone(signingIn, accounts) {
  if (!signingIn) return true;
  const list = accountsList(accounts);
  const before = signingIn.before ?? {};
  if (signingIn.target === "new") return list.some((a) => !(before.ids ?? []).includes(a.id));
  if (signingIn.target === "default") {
    const def = list.find((a) => a.isDefault === true || a.id === "default");
    return Boolean(def) && (def.needsSignIn !== before.needsSignIn || (def.email ?? null) !== (before.email ?? null));
  }
  const a = list.find((x) => x.id === signingIn.target);
  if (!a) return true;
  return (a.lastAuthenticatedAt ?? null) !== (before.lastAuthenticatedAt ?? null);
}

// Remove's question (Orca's "Remove Claude Account?" dialog). Orca deletes
// the folder and its sign-in; the CLI deletes only a folder made here and
// never touches the Keychain (D3), so the body says what happens here.
export function removePrompt(account) {
  const who = str(account?.email) ?? str(account?.label) ?? "this account";
  const fallback = "If it is selected, the next Claude you start uses System default.";
  return {
    title: "Remove Claude Account?",
    body: isHerdrFolder(account?.configDir)
      ? `This deletes ${who}'s Claude folder from this computer. Chat history shared with System default stays. ${fallback}`
      : `This forgets ${who} here. Its Claude folder stays, because Orca uses it too. ${fallback}`,
    cancel: "Cancel",
    confirm: "Remove Account",
  };
}

// The sign-in tab's argv (D3, D13): the CLI's login, which runs the real
// `claude auth login` in that tab.
export function signInArgv(cli, target, link) {
  return [cli, "login", target, ...(link ? ["--link"] : [])];
}

// A CLI run's failure in one line (its last stderr line, as the CLI says
// it), or null when it worked. `result` is exec's { code, stdout, stderr },
// or the error exec rejected with.
export function cliError(result, command) {
  if (result instanceof Error) return result.message || String(result);
  if (!isObject(result)) return `claude-accounts ${command} didn't run.`;
  if (result.code === 0) return null;
  const last = String(result.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last ?? `claude-accounts ${command} exited ${result.code}.`;
}

// ── The confirm view (Orca's ClaudeAccountSwitchDialog, D8) ────────────────

// Why a session can't move: Orca's labels (cantMoveReasonLabel), plus the
// one Herdr has and Orca doesn't (Claude is the terminal's own program, so
// there's no shell to come back to). Unreadable terminals are never listed:
// as in Orca, they're only the "Couldn't check" toast.
export const REASONS = Object.freeze({
  "own-program": "No shell to come back to",
  "no-session": "Can't resume",
  "shared-session": "Also open in another pane",
  "unknown-account": "Account unknown",
});
const CANT_MOVE = "Can't move";
const UNREADABLE = "unreadable";
// Orca's SessionRow: a session with neither a prompt nor a title, and the
// state of one on the outgoing account (isClaudePaneMidTurn: busy or not).
const UNTITLED = "Claude session";
const WORKING = "Working";
const IDLE = "Idle";

// The groups as the dialog has them: { onAccount, elsewhere, cantMove }.
// Review (mode "restart": the outgoing sessions are already restarting)
// leaves onAccount out, as Orca's review prompt does.
function sessionGroups(pending) {
  const sessions = Array.isArray(pending?.sessions) ? pending.sessions : [];
  const review = pending?.mode === "restart";
  return {
    review,
    onAccount: review ? [] : sessions.filter((s) => s.group === "onAccount"),
    elsewhere: sessions.filter((s) => s.group === "elsewhere"),
    cantMove: sessions.filter((s) => s.group === "cantMove" && s.reason !== UNREADABLE),
  };
}

// Orca ticks only the sessions on the outgoing account, so Review starts
// with nothing ticked.
export function initialTicked(pending) {
  return sessionGroups(pending).onAccount.map((s) => s.terminal);
}

export function toggleTicked(ticked, terminal, checked) {
  const list = Array.isArray(ticked) ? ticked : [];
  if (checked) return list.includes(terminal) ? list : [...list, terminal];
  return list.filter((t) => t !== terminal);
}

// Orca's group checkbox (toggleResumeSelection): all ticked unticks them
// all, otherwise ticks them all.
export function toggleGroup(ticked, terminals) {
  const list = Array.isArray(ticked) ? ticked : [];
  if (terminals.length > 0 && terminals.every((t) => list.includes(t))) return list.filter((t) => !terminals.includes(t));
  return [...list, ...terminals.filter((t) => !list.includes(t))];
}

const plural = (n, one, other) => (n === 1 ? one : other);

// Everything the dialog shows, for a pending switch (or null: none waiting),
// the terminals ticked now, and live: { [terminal]: "idle"|"busy" }, what
// the dialog read since it opened (withStatus), over the switch's status.
// A row is Orca's SessionRow (ClaudeAccountSwitchSessionTree.tsx, D23):
// { terminal, title, terminalTitle, reason, checked, fixed }. title is the
// last prompt, else the terminal's title, else "Claude session";
// terminalTitle is that title beside a prompt, else null; reason is the
// right side: why it can't move, the account it's on (Not on …), or, on
// the outgoing account, Working (busy) or Idle (anything else).
export function confirmModel(pending, accounts, ticked, live = null) {
  const chosenSet = new Set(Array.isArray(ticked) ? ticked : []);
  const keep = "Keep as is";
  if (!pending) {
    return {
      empty: true,
      review: false,
      title: "No switch is waiting",
      body: "Claude sessions still running on the previous account show here after a switch.",
      showList: false,
      groups: [],
      dontAsk: null,
      keep,
      restart: { label: "Restart session", enabled: false, terminals: [] },
    };
  }
  const { review, onAccount, elsewhere, cantMove } = sessionGroups(pending);
  const previous = accountLabel(accounts, pending.from);
  const next = accountLabel(accounts, pending.to);
  const listedCount = onAccount.length + elsewhere.length + cantMove.length;
  const chosen = [...onAccount, ...elsewhere].map((s) => s.terminal).filter((t) => chosenSet.has(t));

  const stateOf = (s) => ((isObject(live) && Object.hasOwn(live, s.terminal) ? live[s.terminal] : s.status) === "busy" ? WORKING : IDLE);
  const row = (s, reason, fixed) => {
    const prompt = str(s.prompt)?.trim() ?? null;
    const terminalTitle = str(s.title);
    return {
      terminal: s.terminal,
      title: prompt ?? terminalTitle ?? UNTITLED,
      terminalTitle: prompt ? terminalTitle : null,
      reason,
      checked: !fixed && chosenSet.has(s.terminal),
      fixed,
    };
  };
  const group = (key, title, sessions, fixed) => {
    const side = (s) => (fixed ? (REASONS[s.reason] ?? CANT_MOVE) : key === "elsewhere" ? accountLabel(accounts, s.account) : stateOf(s));
    const rows = sessions.map((s) => row(s, side(s), fixed));
    const ticks = rows.filter((r) => r.checked).length;
    return { key, title, count: rows.length, fixed, state: fixed || ticks === 0 ? "none" : ticks === rows.length ? "all" : "some", sessions: rows };
  };
  const groups = [
    group("on-account", `Running on ${previous}`, onAccount, false),
    group("elsewhere", `Not on ${previous}`, elsewhere, false),
    group("cant-move", CANT_MOVE, cantMove, true),
  ].filter((g) => g.count > 0);

  let body;
  if (review) {
    const count = elsewhere.length + cantMove.length;
    body = plural(count, `${count} other Claude session wasn't moved to ${next}.`, `${count} other Claude sessions weren't moved to ${next}.`);
  } else {
    const count = onAccount.length;
    body = plural(
      count,
      `${count} Claude session is still running on ${previous}. Restarting continues the conversation on ${next}. Busy sessions wait for idle before restarting.`,
      `${count} Claude sessions are still running on ${previous}. Restarting continues each conversation on ${next}. Busy sessions wait for idle before restarting.`,
    );
  }

  return {
    empty: false,
    review,
    title: `Switched to ${next}`,
    body,
    // Orca lists the sessions only when more than one is listed, or on Review.
    showList: listedCount > 1 || review,
    groups,
    // Why hidden on Review (Orca): restarting automatically is already the setting.
    dontAsk: review ? null : { label: "Don't ask again (restart automatically)", hint: "You can turn this off in Manage Accounts…" },
    keep,
    restart: {
      label: chosen.length <= 1 ? "Restart session" : `Restart ${chosen.length} sessions`,
      enabled: chosen.length > 0,
      terminals: chosen,
    },
  };
}

// ── The confirm view's live state (D23) ───────────────────────────────────

// The terminals whose row says Working or Idle, which the dialog reads
// every 2 s while it's open: the outgoing sessions of an Ask. Review lists
// none (they're already restarting).
export function statusTerminals(pending) {
  return sessionGroups(pending).onAccount.map((s) => s.terminal);
}

// The CLI run that reads one: `terminal <t> --json` → { status, … }.
export function statusArgv(terminal) {
  return ["terminal", terminal, "--json"];
}

// live after one read of a terminal (exec's result, or what it threw). A
// read that failed (Claude quit, hc failed, a timeout) or that says nothing
// new keeps what's shown: the same object back, so the view needn't redraw.
export function withStatus(live, terminal, result) {
  const map = isObject(live) ? live : {};
  if (!isObject(result) || result instanceof Error || result.code !== 0) return map;
  let status;
  try {
    status = JSON.parse(result.stdout)?.status;
  } catch {
    return map;
  }
  if (status !== "idle" && status !== "busy") return map;
  return map[terminal] === status ? map : { ...map, [terminal]: status };
}

// The CLI runs an answer takes, in order (Orca's
// answerClaudeAccountSwitchPrompt): `restart --answer keep|restart
// [--terminal <t>]...` (T4), then `settings set switchMode restart` when
// "Don't ask again" is ticked (never on Review, which doesn't show it).
// A restart with nothing chosen is a keep: the CLI would read no --terminal
// as every listed session.
export function confirmCommands(choice, { chosen = [], dontAskAgain = false, review = false } = {}) {
  const terminals = Array.isArray(chosen) ? chosen : [];
  const answer = choice === "restart" && terminals.length > 0
    ? ["restart", "--answer", "restart", ...terminals.flatMap((t) => ["--terminal", t]), "--json"]
    : ["restart", "--answer", "keep", "--json"];
  const out = [answer];
  if (dontAskAgain && !review) out.push(["settings", "set", "switchMode", "restart", "--json"]);
  return out;
}
