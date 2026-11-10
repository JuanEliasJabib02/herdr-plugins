// What the footer tells the person when the CLI's files change (D1, D8, D13).
// Pure: no herdr or gpui-kit import, so `node --test` loads it. Owner: T7.
//
// react({ restart, pendingSwitch, loginLink, accounts, now }, seen)
//   → { notify, openConfirm, copyLink, seen }
//   restart, pendingSwitch, loginLink: store.js's readings of restart.json,
//     pending-switch.json and login-link (a file's raw text works too).
//   accounts: store.js's readAccounts() (accounts.v1.json), for the account
//     names the toasts say; without it they read "Claude account", as
//     Orca's label does for an account it doesn't know.
//   now: epoch ms, Date.now() by default.
//   seen: shared(SEEN_KEY), what was already shown: { "<key>": <epoch ms
//     it was first seen> }, keyed by item id and state (or the switch, or
//     the link), so each toast shows once.
//   notify: the toasts to post now, in order, each herdr's notify argument
//     ({ title, body?, level, action? }).
//   openConfirm: true when the confirm view should open (an Ask).
//   copyLink: the sign-in URL to put on the clipboard, or null.
//   seen: the new value to store with setShared(SEEN_KEY, …), or null when
//     it's unchanged (nothing to store, so no re-render of every mod).
// The footer applies the result. The mod never writes restart.json.
//
// What it says (Orca's toasts, renderer/src/lib/claude-account-switch-sessions.ts,
// and its sign-in link toast, settings/accounts/claude/claude-sign-in-link-menu.tsx):
//   pending-switch.json (T4: written in Ask and in Always restart)
//     - unreadable terminals: Orca's "Couldn't check N terminals for
//       Claude…" warning, in both modes;
//     - mode "ask" with a session on the outgoing account: openConfirm;
//     - mode "restart" with one: Orca's "Restarting N Claude sessions on
//       {account}", and when others stayed (elsewhere, or can't move),
//       "N other sessions weren't moved." with Review (the toast's action
//       opens the confirm view, which shows them);
//     - no session to move, but some on the outgoing account another
//       terminal also holds: Orca's shared-conversation warning.
//   restart.json, switch items only (a resume job belongs to its caller,
//   which reads `resume --status`):
//     - waitingIdle: "Claude in … is busy", one toast for all that start
//       waiting together;
//     - failed and timeout: the manual `claude --resume <sid>` (D8) when
//       the CLI's detail carries a line to type, and why;
//     - landedElsewhere: a warning with the CLI's detail.
//   The one exception, for switch items and resume jobs alike: a starting
//   item whose new Claude stopped at a startup dialog (the CLI writes its
//   `question`, resume-gaps D4) is "Claude in … is asking a question", once
//   per question. Only the person can answer it, and `resume --status`
//   doesn't carry it, so a caller such as Spotlight couldn't say it. Not in
//   Orca, which says nothing about a dialog after it restarts a pane.
//   login-link: copied, with Orca's "Sign-in link copied…" toast.
// Herdr's toast draws a title and one line of body, and runs its action
// when clicked, so Orca's long one-sentence toasts are split at their
// sentence break, and Review reads "Click to review." Things older than
// FRESH_MS (a Herdr restart, a layout shown later) are marked seen without
// a word; seen entries older than KEEP_SEEN_MS go.

import { readAccounts, readLoginLink, readPendingSwitch, readRestart } from "./store.js";
import { accountLabel } from "./accounts-model.js";

// The shared key the footer keeps `seen` in (D1).
export const SEEN_KEY = "claude-accounts.seen";

const MINUTE = 60_000;
const FRESH_MS = 10 * MINUTE;
const KEEP_SEEN_MS = 2 * 24 * 60 * MINUTE;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

const REVIEW = { name: "claude-accounts.open-confirm" };
const focus = (terminal) => ({ name: "pane.focus", args: { terminal } });
const FAILED = new Set(["failed", "timeout", "landedElsewhere"]);

// A notify argument without its empty fields.
function toast(title, body, level, action) {
  const n = { title };
  if (body) n.body = body;
  n.level = level;
  if (action) n.action = action;
  return n;
}

// The CLI's `<why>: <line to run by hand>` (D8), or a bare line or why.
const LINE_START = /(^|: )(CLAUDE_ACCOUNTS_DIR=|claude )/g;
function splitDetail(detail) {
  if (typeof detail !== "string" || detail.trim() === "") return { why: null, line: null };
  let at = -1;
  let sep = 0;
  for (const m of detail.matchAll(LINE_START)) {
    at = m.index;
    sep = m[1].length;
  }
  if (at < 0) return { why: detail.trim(), line: null };
  return { why: detail.slice(0, at).trim() || null, line: detail.slice(at + sep).trim() };
}

// The session id the line resumes: its last `--resume <sid>`, quoted or not.
function resumeId(line) {
  const m = /--resume\s+'?([^'\s]+)'?\s*$/.exec(line ?? "");
  return m ? m[1] : null;
}

// "the shell didn't come back" → "The shell didn't come back."
function sentence(text) {
  if (!text) return null;
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// A file's reading through its store.js reader: raw text, a parsed object
// and a reader's own result all come out the same (the readers are
// idempotent); anything else is null.
const readWith = (value, reader) => (typeof value === "string" || isObject(value) ? reader(value) : null);

export function react(state, seen) {
  const s = isObject(state) ? state : {};
  const now = isNumber(s.now) ? s.now : Date.now();
  const accounts = Array.isArray(s.accounts) ? s.accounts : readWith(s.accounts, readAccounts);
  const pending = readWith(s.pendingSwitch, readPendingSwitch);
  const restart = readWith(s.restart, readRestart);
  const link = readLoginLink(s.loginLink ?? null);
  const label = (id) => accountLabel(accounts, id);

  // What was seen, without what's too old to matter.
  let changed = false;
  const next = {};
  if (isObject(seen)) {
    for (const [key, at] of Object.entries(seen)) {
      if (isNumber(at) && now - at <= KEEP_SEEN_MS) next[key] = at;
      else changed = true;
    }
  }
  // True the first time a key is met: it's recorded either way.
  const first = (key) => {
    if (Object.hasOwn(next, key)) return false;
    next[key] = now;
    changed = true;
    return true;
  };
  const fresh = (at) => !isNumber(at) || now - at <= FRESH_MS;

  const notify = [];
  let openConfirm = false;
  let copyLink = null;

  // ── The switch's question or notice ─────────────────────────────────────
  const titles = new Map();
  if (pending && pending.mode !== "keep") {
    const base = `switch:${pending.at ?? ""}:${pending.to}`;
    const ok = fresh(pending.at);
    const sessions = pending.sessions;
    for (const x of sessions) if (x.title) titles.set(x.terminal, x.title);
    const onAccount = sessions.filter((x) => x.group === "onAccount");
    const unreadable = sessions.filter((x) => x.group === "cantMove" && x.reason === "unreadable");
    const others = sessions.filter((x) => x.group === "elsewhere" || (x.group === "cantMove" && x.reason !== "unreadable"));
    const shared = sessions.filter((x) => x.reason === "shared-session" && x.account === pending.from);
    const previous = label(pending.from);
    const target = label(pending.to);

    if (unreadable.length > 0 && first(`${base}:unchecked`) && ok) {
      const n = unreadable.length;
      notify.push(n === 1
        ? toast("Couldn't check 1 terminal for Claude.", `If Claude is running there, it stays on ${previous} until restarted.`, "warning")
        : toast(`Couldn't check ${n} terminals for Claude.`, `Any Claude running there stays on ${previous} until restarted.`, "warning"));
    }
    if (onAccount.length === 0) {
      if (shared.length > 0 && first(`${base}:shared`) && ok) {
        const n = shared.length;
        notify.push(toast(
          n === 1
            ? `1 Claude session stays on ${previous} because another pane has the same conversation open.`
            : `${n} Claude sessions stay on ${previous} because another pane has the same conversation open.`,
          "Restarting could reopen the other pane's conversation.",
          "warning",
        ));
      }
    } else if (pending.mode === "restart") {
      if (first(`${base}:restarting`) && ok) {
        const n = onAccount.length;
        const title = n === 1 ? `Restarting 1 Claude session on ${target}` : `Restarting ${n} Claude sessions on ${target}`;
        const m = others.length;
        notify.push(m === 0
          ? toast(title, null, "success")
          : toast(title, `${m === 1 ? "1 other session wasn't moved." : `${m} other sessions weren't moved.`} Click to review.`, "success", REVIEW));
      }
    } else if (first(`${base}:confirm`) && ok) {
      openConfirm = true;
    }
  }

  // ── The restarts' progress ──────────────────────────────────────────────
  const where = (item) => titles.get(item.terminal) ?? item.terminal ?? "a terminal";
  const waiting = [];
  const questions = [];
  const failures = [];
  for (const item of restart?.items ?? []) {
    if (item.state === "starting" && typeof item.question === "string" && item.question !== "") {
      if (first(`item:${item.id}:question:${item.question}`) && fresh(item.updatedAt)) {
        questions.push(toast(`Claude in ${where(item)} is asking a question`, `${item.question} Answer it there.`, "warning", item.terminal ? focus(item.terminal) : null));
      }
    }
    if (item.kind !== "switch" || !item.state) continue;
    if (item.state !== "waitingIdle" && !FAILED.has(item.state)) continue;
    if (!first(`item:${item.id}:${item.state}`) || !fresh(item.updatedAt)) continue;
    if (item.state === "waitingIdle") waiting.push(item);
    else failures.push(failure(item, where(item), label(item.to)));
  }
  if (waiting.length === 1) {
    const [item] = waiting;
    notify.push(toast(`Claude in ${where(item)} is busy`, `It restarts on ${label(item.to)} once it's idle.`, "info", item.terminal ? focus(item.terminal) : null));
  } else if (waiting.length > 1) {
    notify.push(toast(`${waiting.length} Claude sessions are busy`, `Each one restarts on ${label(waiting[0].to)} once it's idle.`, "info"));
  }
  notify.push(...questions, ...failures);

  // ── The sign-in link ────────────────────────────────────────────────────
  if (link && first(`link:${link}`)) {
    copyLink = link;
    notify.push(toast("Sign-in link copied.", "Open it in a private window to sign in with a different account.", "success"));
  }

  return { notify, openConfirm, copyLink, seen: changed ? next : null };
}

// A failed, timed-out or misplaced restart (D8): what happened, and the
// manual `claude --resume <sid>` when the CLI's detail has a line to type.
function failure(item, where, target) {
  const { why, line } = splitDetail(item.detail);
  const action = item.terminal ? focus(item.terminal) : null;
  if (item.state === "landedElsewhere") {
    return toast(`Claude in ${where} restarted on another account`, sentence(why) ?? `It was meant for ${target}.`, "warning", action);
  }
  const sid = line ? (resumeId(line) ?? item.sessionId) : null;
  const body = [sid ? `Run claude --resume ${sid} there.` : null, sentence(why)].filter(Boolean).join(" ");
  const title = item.state === "timeout" ? `Claude in ${where} didn't restart in time` : `Couldn't restart Claude in ${where}`;
  return toast(title, body || null, "error", action);
}
