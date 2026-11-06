// Moving running Claude terminals to another account (D8, D9). Owner: T4.
//
// Commands (each parses its own flags, strict, and takes --json):
//   restart --detach                     the detached runner (below)
//   restart --cancel <t>                 cancels terminal t's item that
//                                        hasn't stopped Claude yet (any kind)
//   restart --answer keep|restart [--terminal <t>]...
//                                        the confirm view's answer to
//                                        pending-switch.json: keep drops it;
//                                        restart queues the listed sessions
//                                        (onAccount and elsewhere) that were
//                                        ticked, every listed one when no
//                                        --terminal is given (Orca's
//                                        answerClaudeAccountSwitchPrompt).
//                                        "Don't ask again" is
//                                        `settings set switchMode restart`.
//   resume --terminal <t> --account <id|default> [--message <text>] [--wait <s>]
//   resume --status <job> [--wait <s>]
//   resume --cancel <job>
//     asynchronous (D9, CONTRACT.md): validates (exit 2, 3, 5, 7, 8, 64;
//     2 also when the conversation has no transcript yet, so there's nothing
//     to resume, unless the terminal is already on the account and only
//     gets the message),
//     queues a job in restart.json, spawns its own runner and exits 0 with
//     {"job": "<id>"} at once. --status prints {job, terminal, account,
//     state, code, detail, updatedAt} and exits with the job's code once
//     it's final (0 while it runs). --wait <s> (at most 25) waits for the
//     final state, else exits 75.
//
// afterUse(from, to): called by accounts.use once `active` is written, with
// the previous and the new account ids. Orca's
// handleRunningClaudeSessionsAfterSwitch:
//   1. Any earlier pending-switch.json is dropped (a new switch replaces the
//      question).
//   2. Queue rules: a switch item that hasn't stopped Claude yet is dropped
//      when its terminal is now on `to`; the others follow `to` (an accepted
//      restart relaunches on whatever is selected when it runs).
//   3. switchMode keep: nothing else.
//   4. The Claude terminals (D7) split into onAccount (on `from`), elsewhere
//      (on another account) and cantMove: reason "own-program" (Claude is
//      the terminal's program), "no-session" (no session file, or a session
//      with no transcript yet: nothing to resume, Orca's rule), "shared-session" (another
//      terminal holds the same session id), "unknown-account" (its session
//      lives in a folder no account has) or "unreadable" (hc couldn't read
//      it: Orca's "Couldn't check N terminals"). Terminals already on `to`
//      aren't listed.
//   5. restart: each onAccount terminal is queued as a switch item, and a
//      runner is spawned.
//   6. pending-switch.json gets {from, to, at, mode, sessions} when there's
//      something to say: an onAccount session, or an unreadable or shared
//      one. `mode` is "ask" or "restart", so the mod (T7's toasts.react)
//      tells them apart: mode "ask" with an onAccount session opens the
//      confirm view; mode "restart" is the restart toast, and its Review
//      opens the confirm view on the sessions that aren't onAccount (they're
//      already restarting). The confirm view answers with --answer.
//
// The runner (`restart --detach`, spawned detached with stdio ignored, so
// exec's 30 s cap never cuts it): under the D2 lock it claims every item
// that's neither final nor claimed, then runs one async loop per claimed
// item, so a busy terminal never holds up another. It refreshes its claims'
// `at` every heartbeat and exits when its loops end. Per item (D8):
//   1. Waits, with no cap, until the terminal's Claude is idle (state
//      waitingIdle, written once), while the terminal lives and its account
//      still differs from the item's `to`. Right before acting it re-reads
//      the terminal (D7): a switch item already on its target is dropped
//      (Orca's consumePendingPaneAccountRestart); a resume job already on it
//      only sends its message. A switch item whose terminal closed, or whose
//      Claude quit, is dropped too; a resume job in that case fails. A
//      session with no transcript (a `/clear` nobody has written to yet)
//      fails, and Claude is never stopped.
//   2. stopping: SIGTERM to the foreground pid (probe b4). From here on the
//      item can't be cancelled.
//   3. Waits up to 30 s for the shell to be the foreground again, else
//      timeout.
//   4. starting: types `CLAUDE_ACCOUNTS_DIR=<target dir> claude <kept args>
//      --resume <sid>`, each part shell-quoted, with `hc send`. A failed
//      send is failed with the line to run by hand.
//   5. Waits up to 120 s for the new Claude to report idle, else timeout.
//      Its session file must lie in the target's dir, else landedElsewhere.
//      When the shell is back in the foreground for 5 s with no new Claude
//      (Claude refused the resume, "No conversation found…", and exited),
//      it fails at once: detail is the error Claude left on the screen
//      (`hc read`), then the line to run by hand.
//   6. A resume job with a message: sending, `hc send` as the user (no
//      HC_TERMINAL_ID). Then done.
// A failed, timed-out or orphaned item's detail is `<why>: <the line to run
// by hand>`. A non-final item whose runner died (its claim void: a dead pid,
// or an `at` older than the stale window) reads failed "runner gone"
// whenever restart.json is read under the lock, and stays failed: it's never
// run again. Final items are pruned 24 h after they ended.
//
// keptArgs(argv): D8's allowlist over Claude's foreground argv.
// shellQuote(s), resumeLine(dir, args, sessionId): the typed line.
// screenReason(screen, line): what the typed line left on the screen.
//
// Test seam: CLAUDE_ACCOUNTS_RESTART_TIMING, a JSON object of milliseconds
// overriding TIMING below ({"poll":25,"shell":800,…}).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { FILES, cliPath, stateHome } from "./paths.mjs";
import { failure, isAlive, readJson, render, withLock, writeAtomic } from "./files.mjs";
import { knownAccounts, readSettings, sameLogin } from "./accounts.mjs";
import { contractUsage } from "./usage.mjs";
import { HC_SEND_TIMEOUT_MS, getTerminal, hasTranscript, hc, inspectTerminal, isIdle, listClaudeTerminals } from "./terminals.mjs";

// Milliseconds. poll: how often a loop re-reads its terminal; shell and
// claude: D8's step 3 and step 5 caps; shellBack: how long the shell may be
// back in the foreground after the typed line, with no new Claude, before
// the item fails; heartbeat: how often a runner refreshes its claims; stale:
// a claim (or an unclaimed queued item) older than this is void; waitPoll:
// how often --wait reads the job.
const TIMING = Object.freeze({
  poll: 1000,
  shell: 30_000,
  claude: 120_000,
  shellBack: 5_000,
  heartbeat: 15_000,
  stale: 60_000,
  waitPoll: 250,
});
const MAX_WAIT_S = 25;
const KEEP_FINAL_MS = 24 * 60 * 60 * 1000;

const FINAL_CODES = Object.freeze({ done: 0, timeout: 4, landedElsewhere: 6, failed: 9, cancelled: 10 });
const isFinal = (item) => Object.hasOwn(FINAL_CODES, item.state);
// Claude isn't stopped yet: these can still be cancelled or dropped.
const NOT_STARTED = new Set(["queued", "waitingIdle"]);
const isLive = (item) => !isFinal(item);

const EX_TEMPFAIL = 75;
const RESUME_USAGE =
  "resume --terminal <t> --account <id|default> [--message <text>] [--wait <s>] | --status <job> [--wait <s>] | --cancel <job>";
const RESTART_USAGE = "restart --detach | --cancel <t> | --answer keep|restart [--terminal <t>]...";

const usageError = (text) => failure(`usage: claude-accounts ${text}`, 64);
const say = (text) => process.stderr.write(`${text}\n`);

function timing(env = process.env) {
  let custom = {};
  try {
    custom = JSON.parse(env.CLAUDE_ACCOUNTS_RESTART_TIMING || "{}") ?? {};
  } catch {
    // A broken seam is ignored: production timings.
  }
  const out = { ...TIMING };
  for (const key of Object.keys(TIMING)) if (Number.isFinite(custom[key]) && custom[key] > 0) out[key] = custom[key];
  return out;
}

// ── The typed line (D8 step 4) ──────────────────────────────────────────────

// Bare when it can't mean anything else to a shell (zsh included: no glob,
// no `~`, no leading `=`), else single-quoted.
export function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// dir: the target's exact config dir, "" for System default (the launcher's
// rule 1: set, even empty, wins over `active`; empty means CLAUDE_CONFIG_DIR
// unset).
export function resumeLine(dir, args, sessionId) {
  return [`CLAUDE_ACCOUNTS_DIR=${shellQuote(dir)}`, "claude", ...args.map(shellQuote), "--resume", shellQuote(sessionId)].join(" ");
}

// D8's kept args: Orca rebuilds `claude [--effort] --resume <id>`; this keeps
// a few more safe flags, in the `--x v` and `--x=v` forms. Every positional
// (a first prompt) and every other flag is dropped, so a resumed agent never
// gets its first task again; so are the launcher's own injections: its
// leading --mcp-config=… and the --add-dir=… right after them.
const KEEP_FLAGS = new Set(["--dangerously-skip-permissions"]);
const KEEP_OPTIONS = new Set(["--model", "--permission-mode", "--effort", "--settings", "--add-dir"]);

export function keptArgs(argv) {
  let rest = argv.slice(1);
  // node or bun running Claude's bin: [node, …/bin/claude, …].
  if (/(^|\/)(node|bun)$/.test(argv[0] ?? "") && rest.length > 0) rest = rest.slice(1);
  let skip = 0;
  while (skip < rest.length && rest[skip].startsWith("--mcp-config=")) skip += 1;
  if (skip > 0 && skip < rest.length && rest[skip].startsWith("--add-dir=")) skip += 1;
  rest = rest.slice(skip);
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") break;
    if (KEEP_FLAGS.has(arg)) {
      kept.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0 && KEEP_OPTIONS.has(arg.slice(0, eq))) {
      kept.push(arg);
      continue;
    }
    if (KEEP_OPTIONS.has(arg)) {
      const value = rest[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        i += 1;
      }
    }
  }
  return kept;
}

// ── restart.json (D2's pinned shape) ────────────────────────────────────────

const queuePath = (home) => join(home, FILES.restart);
const pendingPath = (home) => join(home, FILES.pendingSwitch);

async function readQueue(home) {
  const path = queuePath(home);
  const doc = await readJson(path);
  if (doc === null) return { items: [] };
  if (typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.items)) {
    throw failure(`${path} is not {"items": [...]}. Fix it or move it away: claude-accounts never overwrites it.`);
  }
  doc.items = doc.items.filter((item) => item && typeof item === "object" && typeof item.id === "string");
  return doc;
}

const writeQueue = (home, doc) => writeAtomic(queuePath(home), render(doc));

function newItem(kind, fields, items, now) {
  let id;
  do id = `${kind === "resume" ? "rs" : "sw"}-${randomUUID().slice(0, 8)}`;
  while (items.some((item) => item.id === id));
  return {
    id,
    kind,
    terminal: fields.terminal,
    from: fields.from ?? null,
    to: fields.to,
    sessionId: fields.sessionId ?? null,
    args: fields.args ?? [],
    message: fields.message ?? null,
    state: "queued",
    code: null,
    detail: null,
    claimedBy: null,
    updatedAt: now,
  };
}

// The target's config dir for the typed line: the exact string, "" for
// System default, null when the account is gone.
function targetDir(known, id) {
  const account = known.accounts.find((a) => a.id === id);
  if (!account) return null;
  return account.isDefault ? "" : (account.configDir ?? null);
}

// What to run by hand to finish an item: the line the runner types.
function manualLine(item, known) {
  if (!item.sessionId) return null;
  const dir = targetDir(known, item.to);
  return dir === null ? `claude --resume ${shellQuote(item.sessionId)}` : resumeLine(dir, item.args ?? [], item.sessionId);
}

const withLine = (why, line) => (line ? `${why}: ${line}` : why);

const noConversation = (terminalId, sessionId) =>
  `there's no conversation to resume yet in terminal ${terminalId}: Claude hasn't saved session ${sessionId} (it has no messages)`;

// What the typed line left on the screen: the last non-empty line the
// command printed, under the echoed line and above the new prompt. A prompt
// can span lines (starship draws an info line, then `❯`), so the new prompt
// is dropped from the end: its last line (it ends with the symbol the typed
// line was echoed after), then the lines above it that start like the lines
// the previous prompt drew above the echoed line. Without an echoed line,
// the screen's last non-empty line. null when there's nothing left.
export function screenReason(screen, line) {
  const lines = String(screen ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const lastText = (list) => [...list].reverse().find((l) => l.trim() !== "") ?? null;
  const marker = "CLAUDE_ACCOUNTS_DIR=";
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(marker)) {
      start = i;
      break;
    }
  }
  if (start < 0) return lastText(lines)?.trim() ?? null;
  // The echoed line may wrap over several screen lines.
  let end = start;
  while (end + 1 < lines.length && !lines.slice(start, end + 1).join("").includes(line)) end += 1;
  if (!lines.slice(start, end + 1).join("").includes(line)) end = start;
  const after = lines.slice(end + 1);
  const trimEnd = () => {
    while (after.length && after[after.length - 1].trim() === "") after.pop();
  };
  trimEnd();
  const symbol = lines[start].slice(0, lines[start].indexOf(marker)).trim().split(/\s+/).pop() ?? "";
  if (symbol && after.length && after[after.length - 1].trim().endsWith(symbol)) after.pop();
  trimEnd();
  const firstWord = (l) => l.trim().split(/\s+/)[0];
  for (let above = start - 1; above >= 0 && lines[above].trim() !== "" && after.length; above -= 1) {
    if (firstWord(after[after.length - 1]) !== firstWord(lines[above])) break;
    after.pop();
  }
  trimEnd();
  return lastText(after)?.trim() ?? null;
}

function finalize(item, state, detail, now) {
  Object.assign(item, { state, code: FINAL_CODES[state], detail: detail ?? null, claimedBy: null, updatedAt: now });
}

// A non-final item whose runner is gone: its claim's pid is dead or its `at`
// is older than the stale window, or nobody claimed it within that window.
function runnerGone(item, now, t) {
  const claim = item.claimedBy;
  if (claim && Number.isInteger(claim.pid)) return !isAlive(claim.pid) || now - (claim.at ?? 0) > t.stale;
  return now - (item.updatedAt ?? 0) > t.stale;
}

// Orphaned items fail ("runner gone"), and final items older than 24 h go.
// Returns whether anything changed. Called under the lock only.
function settle(doc, known, now, t) {
  let changed = false;
  doc.items = doc.items.filter((item) => {
    if (isFinal(item)) {
      const keep = now - (item.updatedAt ?? 0) <= KEEP_FINAL_MS;
      if (!keep) changed = true;
      return keep;
    }
    if (runnerGone(item, now, t)) {
      finalize(item, "failed", withLine("runner gone", manualLine(item, known)), now);
      changed = true;
    }
    return true;
  });
  return changed;
}

// Reads restart.json under the lock with settle() applied (and written, when
// it changed anything), then runs fn(doc, now). fn returns
// { result, write } to write the queue back.
async function underLock(home, known, t, fn) {
  return withLock(home, async () => {
    const doc = await readQueue(home);
    const now = Date.now();
    const settled = settle(doc, known, now, t);
    const { result, write } = (await fn(doc, now)) ?? {};
    if (settled || write) await writeQueue(home, doc);
    return result;
  });
}

function spawnRunner() {
  const child = spawn(process.execPath, [cliPath(), "restart", "--detach"], { detached: true, stdio: "ignore", cwd: "/" });
  child.on("error", () => {});
  child.unref();
}

// ── afterUse (D8) ───────────────────────────────────────────────────────────

// The Claude terminals and what each runs: [{ terminal, where, found }].
async function scanTerminals(known) {
  const listed = await listClaudeTerminals();
  return Promise.all(
    listed.map(async (l) => {
      const found = await inspectTerminal(l.terminal, known);
      const resumable = found.kind === "claude" && (await hasTranscript(found.configDir, found.sessionId));
      return { ...l, found: { ...found, resumable } };
    }),
  );
}

// D8's three groups, in pending-switch.json's shape plus what a switch item
// needs: [{ terminal, title, account, group, reason, sessionId, args }].
function classify(scan, from, to, known) {
  // A session on another folder with the outgoing account's login spends the
  // same limits, so it moves with it (System default and a saved account can
  // hold one login).
  const accountById = new Map(known.accounts.map((a) => [a.id, a]));
  const leaving = (account) => account === from || sameLogin(accountById.get(account), accountById.get(from));
  const holders = new Map();
  for (const { found } of scan) {
    if (found.kind === "claude") holders.set(found.sessionId, (holders.get(found.sessionId) ?? 0) + 1);
  }
  const out = [];
  for (const { terminal, where, found } of scan) {
    const row = { terminal, title: found.title ?? where ?? terminal, account: found.account ?? null };
    const cantMove = (reason) => out.push({ ...row, group: "cantMove", reason });
    if (found.kind === "notClaude") continue;
    if (found.kind === "missing" || found.kind === "unreadable") cantMove("unreadable");
    else if (found.kind === "noSession") cantMove("no-session");
    else if (found.account === to) continue;
    else if (found.ownProgram) cantMove("own-program");
    else if (found.account === null) cantMove("unknown-account");
    else if (!found.resumable) cantMove("no-session");
    else if (holders.get(found.sessionId) > 1) cantMove("shared-session");
    else {
      out.push({
        ...row,
        group: leaving(found.account) ? "onAccount" : "elsewhere",
        reason: null,
        sessionId: found.sessionId,
        args: keptArgs(found.argv),
      });
    }
  }
  return out;
}

const publicSession = ({ terminal, title, account, group, reason }) => ({ terminal, title, account, group, reason });

export async function afterUse(from, to) {
  if (from === to) return;
  const home = stateHome();
  const t = timing();
  const known = await knownAccounts(home);
  const { switchMode } = await readSettings(home);
  const waiting = (await readQueue(home)).items.some((item) => item.kind === "switch" && NOT_STARTED.has(item.state));
  let scan = [];
  if (switchMode !== "keep" || waiting) {
    try {
      scan = await scanTerminals(known);
    } catch (e) {
      say(`claude-accounts: couldn't list Herdr's terminals (${e.message}); Claude terminals stay where they are.`);
    }
  }
  const sessions = switchMode === "keep" ? [] : classify(scan, from, to, known);
  const onAccount = sessions.filter((s) => s.group === "onAccount");
  const accountOf = new Map(scan.filter((s) => s.found.kind === "claude").map((s) => [s.terminal, s.found.account]));

  const queued = await underLock(home, known, t, async (doc, now) => {
    await rm(pendingPath(home), { force: true });
    let write = false;
    doc.items = doc.items.filter((item) => {
      if (item.kind !== "switch" || !NOT_STARTED.has(item.state)) return true;
      write = true;
      if (accountOf.get(item.terminal) === to) return false;
      Object.assign(item, { to, updatedAt: now });
      return true;
    });
    if (switchMode === "keep") return { result: [], write };
    const ids = [];
    if (switchMode === "restart") {
      for (const s of onAccount) {
        if (doc.items.some((item) => item.terminal === s.terminal && isLive(item))) continue;
        const item = newItem("switch", { terminal: s.terminal, from: s.account, to, sessionId: s.sessionId, args: s.args }, doc.items, now);
        doc.items.push(item);
        ids.push(item.id);
      }
    }
    const tell = onAccount.length > 0 || sessions.some((s) => s.reason === "unreadable" || s.reason === "shared-session");
    if (tell) {
      await writeAtomic(pendingPath(home), render({ from, to, at: now, mode: switchMode, sessions: sessions.map(publicSession) }));
    }
    return { result: ids, write: write || ids.length > 0 };
  });
  if (queued.length > 0) spawnRunner();
}

// ── restart ─────────────────────────────────────────────────────────────────

export async function restart(args) {
  const { values } = parseArgs({
    args,
    options: {
      detach: { type: "boolean" },
      cancel: { type: "string" },
      answer: { type: "string" },
      terminal: { type: "string", multiple: true },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const modes = [values.detach, values.cancel !== undefined, values.answer !== undefined].filter(Boolean).length;
  if (modes !== 1 || (values.terminal && values.answer === undefined)) throw usageError(RESTART_USAGE);
  if (values.detach) return runner();
  if (values.cancel !== undefined) return cancelTerminal(values.cancel, values.json);
  if (!["keep", "restart"].includes(values.answer)) throw usageError(RESTART_USAGE);
  return answer(values.answer, values.terminal, values.json);
}

async function cancelTerminal(terminalId, json) {
  const home = stateHome();
  const known = await knownAccounts(home);
  const cancelled = await underLock(home, known, timing(), async (doc, now) => {
    const ids = [];
    for (const item of doc.items) {
      if (item.terminal !== terminalId || !NOT_STARTED.has(item.state)) continue;
      finalize(item, "cancelled", null, now);
      ids.push(item.id);
    }
    return { result: ids, write: ids.length > 0 };
  });
  process.stdout.write(
    json ? render({ cancelled }) : `${cancelled.length ? `Cancelled ${cancelled.join(", ")}.` : `Nothing to cancel on ${terminalId}.`}\n`,
  );
  return 0;
}

// The question lists addresses; `--terminal` takes a name too, as every other
// command does.
async function addressOf(t) {
  try {
    return (await getTerminal(t))?.address ?? t;
  } catch {
    return t;
  }
}

// The confirm view's answer (Orca's answerClaudeAccountSwitchPrompt): only
// sessions the question listed may restart, re-read now (D7).
async function answer(choice, ticked, json) {
  const home = stateHome();
  const t = timing();
  const known = await knownAccounts(home);
  const pending = await readJson(pendingPath(home));
  const queued = [];
  if (pending && typeof pending === "object" && Array.isArray(pending.sessions) && typeof pending.to === "string") {
    const listed = pending.sessions.filter((s) => s && (s.group === "onAccount" || s.group === "elsewhere"));
    const addresses = ticked && (await Promise.all(ticked.map(addressOf)));
    const picked = choice === "keep" ? [] : listed.filter((s) => !addresses || addresses.includes(s.terminal));
    const found = await Promise.all(picked.map((s) => inspectTerminal(s.terminal, known)));
    const ids = await underLock(home, known, t, async (doc, now) => {
      const current = await readJson(pendingPath(home)).catch(() => null);
      // A newer switch replaced the question while it was answered.
      if (current?.at !== pending.at) return { result: [] };
      await rm(pendingPath(home), { force: true });
      const added = [];
      for (const f of found) {
        if (f.kind !== "claude" || f.ownProgram || f.account === pending.to) continue;
        if (doc.items.some((item) => item.terminal === f.terminal && isLive(item))) continue;
        const item = newItem(
          "switch",
          { terminal: f.terminal, from: f.account, to: pending.to, sessionId: f.sessionId, args: keptArgs(f.argv) },
          doc.items,
          now,
        );
        doc.items.push(item);
        added.push(item.id);
      }
      return { result: added, write: added.length > 0 };
    });
    queued.push(...ids);
  }
  if (queued.length > 0) spawnRunner();
  process.stdout.write(json ? render({ queued }) : `${queued.length ? `Restarting ${queued.length}.` : "Nothing to restart."}\n`);
  return 0;
}

// ── The runner ──────────────────────────────────────────────────────────────

async function runner() {
  const home = stateHome();
  const t = timing();
  const known = await knownAccounts(home);
  const mine = await underLock(home, known, t, async (doc, now) => {
    const ids = [];
    for (const item of doc.items) {
      if (isFinal(item) || item.claimedBy) continue;
      item.claimedBy = { pid: process.pid, at: now };
      ids.push(item.id);
    }
    return { result: ids, write: ids.length > 0 };
  });
  if (mine.length === 0) return 0;
  const beat = setInterval(() => heartbeat(home).catch(() => {}), t.heartbeat);
  try {
    await Promise.all(mine.map((id) => runItem(home, id, t).catch((e) => crashed(home, id, e))));
  } finally {
    clearInterval(beat);
  }
  return 0;
}

async function heartbeat(home) {
  await withLock(home, async () => {
    const doc = await readQueue(home);
    const now = Date.now();
    let changed = false;
    for (const item of doc.items) {
      if (isLive(item) && item.claimedBy?.pid === process.pid) {
        item.claimedBy = { pid: process.pid, at: now };
        changed = true;
      }
    }
    if (changed) await writeQueue(home, doc);
  });
}

// The item, read without the lock (writes are atomic renames): null once it's
// gone, final, or claimed by another runner. A loop ends there.
async function ownItem(home, id) {
  const doc = await readQueue(home);
  const item = doc.items.find((i) => i.id === id);
  return item && isLive(item) && item.claimedBy?.pid === process.pid ? { item, doc } : null;
}

// Changes this runner's item under the lock: fn(item, now) edits it, returns
// "drop" to remove it, or "skip" to leave it as it is. Resolves to the item;
// to "skip" (the loop reads the item again); or to null when it's no longer
// this runner's to change (cancelled, finalized as runner gone, or dropped):
// the loop then stops without acting.
async function mutate(home, id, fn) {
  return withLock(home, async () => {
    const doc = await readQueue(home);
    const at = doc.items.findIndex((i) => i.id === id);
    const item = doc.items[at];
    if (!item || isFinal(item) || item.claimedBy?.pid !== process.pid) return null;
    const now = Date.now();
    const verdict = fn(item, now);
    if (verdict === "skip") return "skip";
    if (verdict === "drop") {
      doc.items.splice(at, 1);
      await writeQueue(home, doc);
      return null;
    }
    item.updatedAt = now;
    if (isLive(item)) item.claimedBy = { pid: process.pid, at: now };
    await writeQueue(home, doc);
    return { ...item };
  });
}

const setState = (home, id, state, extra = {}) =>
  mutate(home, id, (item) => {
    Object.assign(item, extra, { state });
  });
const finish = (home, id, state, detail = null) => mutate(home, id, (item, now) => finalize(item, state, detail, now));
// A later switch may have moved a waiting switch item to another target
// (afterUse) after the loop read it: what was decided on the old target
// doesn't happen, and the loop reads the item again.
const sameTarget = (current, seen) => current.to === seen.to;
const drop = (home, id, seen) => mutate(home, id, (current) => (sameTarget(current, seen) ? "drop" : "skip"));

async function crashed(home, id, error) {
  const known = await knownAccounts(home).catch(() => ({ accounts: [] }));
  const item = (await ownItem(home, id).catch(() => null))?.item;
  await finish(home, id, "failed", withLine(`the runner failed (${error?.message ?? error})`, item && manualLine(item, known))).catch(() => {});
}

// Another item is acting on this terminal (a resume job queued behind a
// switch item that already stopped Claude): wait for it.
const blockedBy = (doc, item) =>
  doc.items.some((other) => other.id !== item.id && other.terminal === item.terminal && isLive(other) && !NOT_STARTED.has(other.state));

async function runItem(home, id, t) {
  // 1. Wait for idle, with no cap.
  let known;
  let found;
  let item;
  let line;
  for (;;) {
    const own = await ownItem(home, id);
    if (!own) return;
    item = own.item;
    if (blockedBy(own.doc, item)) {
      await sleep(t.poll);
      continue;
    }
    known = await knownAccounts(home);
    if (targetDir(known, item.to) === null) {
      await finish(home, id, "failed", withLine(`account "${item.to}" is gone`, manualLine(item, known)));
      return;
    }
    found = await inspectTerminal(item.terminal, known);
    if (found.kind === "missing" || found.kind === "notClaude") {
      if (item.kind === "switch") {
        if ((await drop(home, id, item)) === "skip") continue;
      } else {
        const why = found.kind === "missing" ? `terminal ${item.terminal} is gone` : `Claude is no longer running in ${item.terminal}`;
        await finish(home, id, "failed", withLine(why, manualLine(item, known)));
      }
      return;
    }
    if (found.kind === "claude" && found.account === item.to) {
      if (item.kind !== "switch") await deliver(home, id, item);
      else if ((await drop(home, id, item)) === "skip") continue;
      return;
    }
    if (found.ownProgram) {
      await finish(home, id, "failed", `Claude is terminal ${item.terminal}'s own program: there's no shell to restart it in`);
      return;
    }
    if (found.kind === "claude" && isIdle(found)) {
      // Nothing to resume (a /clear nobody has written to yet): Claude stays.
      if (!(await hasTranscript(found.configDir, found.sessionId))) {
        await finish(home, id, "failed", noConversation(item.terminal, found.sessionId));
        return;
      }
      // Idle: the item moves to stopping, but only on the target its line
      // is built for. From here on it can't be cancelled.
      const args = keptArgs(found.argv);
      line = resumeLine(targetDir(known, item.to), args, found.sessionId);
      const seen = item;
      const stopping = await mutate(home, id, (current) => {
        if (!sameTarget(current, seen)) return "skip";
        Object.assign(current, { from: found.account, sessionId: found.sessionId, args, state: "stopping" });
        return null;
      });
      if (stopping === null) return;
      if (stopping !== "skip") {
        item = stopping;
        break;
      }
      continue;
    }
    if (item.state !== "waitingIdle" && !(await setState(home, id, "waitingIdle"))) return;
    await sleep(t.poll);
  }

  // 2. Stop Claude: SIGTERM to the foreground (probe b4).
  const pid = found.foregroundPid;
  if (Number.isInteger(pid) && pid > 1 && pid !== found.pid && pid !== process.pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") {
        await finish(home, id, "failed", withLine(`couldn't stop Claude (${e.code})`, line));
        return;
      }
    }
  }

  // 3. Wait for the shell.
  const shellBy = Date.now() + t.shell;
  for (;;) {
    let info;
    try {
      info = await getTerminal(item.terminal);
    } catch {
      info = undefined;
    }
    if (info === null || info?.state === "finished") {
      await finish(home, id, "failed", withLine(`terminal ${item.terminal} is gone`, line));
      return;
    }
    if (info && Number.isInteger(info.foreground?.pid) && info.foreground.pid === info.pid) break;
    if (Date.now() >= shellBy) {
      await finish(home, id, "timeout", withLine(`the shell didn't come back within ${Math.round(t.shell / 1000)} s`, line));
      return;
    }
    await sleep(t.poll);
  }

  // 4. Type the line.
  item = await setState(home, id, "starting");
  if (!item) return;
  try {
    await hc(["send", "--", item.terminal, line], { timeout: HC_SEND_TIMEOUT_MS });
  } catch (e) {
    await finish(home, id, "failed", withLine(`couldn't type the resume line (${e.message})`, line));
    return;
  }

  // 5. Wait for the new Claude, idle and on the target. The shell back in
  // the foreground for shellBack with no new Claude means Claude refused
  // the line and exited: fail now, with what it printed.
  const claudeBy = Date.now() + t.claude;
  let shellSince = null;
  for (;;) {
    const fresh = await inspectTerminal(item.terminal, known);
    if (fresh.kind === "missing") {
      await finish(home, id, "failed", withLine(`terminal ${item.terminal} is gone`, line));
      return;
    }
    const shellUp = Number.isInteger(fresh.foregroundPid) && fresh.foregroundPid === fresh.pid && !fresh.ownProgram;
    if (!shellUp) shellSince = null;
    else if (shellSince === null) shellSince = Date.now();
    else if (Date.now() - shellSince >= t.shellBack) {
      const said = await hc(["read", "--", item.terminal]).then((screen) => screenReason(screen, line), () => null);
      await finish(home, id, "failed", withLine(said ?? "no new Claude came up after the resume line", line));
      return;
    }
    if (fresh.kind === "claude" && fresh.foregroundPid !== pid) {
      if (fresh.account !== item.to) {
        await finish(home, id, "landedElsewhere", `the new Claude runs on ${fresh.account ?? "a folder no account has"} (${fresh.configDir})`);
        return;
      }
      if (isIdle(fresh)) break;
    }
    if (Date.now() >= claudeBy) {
      await finish(home, id, "timeout", withLine(`the new Claude didn't report idle within ${Math.round(t.claude / 1000)} s`, line));
      return;
    }
    await sleep(t.poll);
  }

  // 6. The message, then done.
  await deliver(home, id, item);
}

// A resume job's message, typed as the user's; then done.
async function deliver(home, id, item) {
  if (item.message) {
    if (!(await setState(home, id, "sending"))) return;
    try {
      await hc(["send", "--", item.terminal, item.message], { timeout: HC_SEND_TIMEOUT_MS });
    } catch (e) {
      await finish(home, id, "failed", `Claude resumed, but the message couldn't be sent (${e.message})`);
      return;
    }
  }
  await finish(home, id, "done");
}

// ── resume (D9) ─────────────────────────────────────────────────────────────

const statusOf = (item) => ({
  job: item.id,
  terminal: item.terminal,
  account: item.to,
  state: item.state,
  code: isFinal(item) ? FINAL_CODES[item.state] : null,
  detail: item.detail ?? null,
  updatedAt: item.updatedAt ?? null,
});

function printStatus(item, json) {
  const s = statusOf(item);
  process.stdout.write(
    json ? render(s) : `${s.job} ${s.terminal} → ${s.account}: ${s.state}${s.detail ? ` (${s.detail})` : ""}\n`,
  );
}

// A job's item after settle(), or null when there's no such job.
async function readJob(home, known, t, id) {
  return underLock(home, known, t, async (doc) => ({ result: doc.items.find((item) => item.id === id) ?? null }));
}

// Polls a job until it's final or `seconds` pass.
async function waitJob(home, known, t, id, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const item = await readJob(home, known, t, id);
    if (!item || isFinal(item) || Date.now() >= deadline) return item;
    await sleep(Math.max(1, Math.min(t.waitPoll, deadline - Date.now())));
  }
}

// --status and --wait share their exit: the final code, else 0 for a read
// and 75 when --wait ran out.
async function report(home, known, t, id, { wait, json }) {
  const item = wait === undefined ? await readJob(home, known, t, id) : await waitJob(home, known, t, id, wait);
  if (!item) throw failure(`unknown job "${id}"`, 7);
  printStatus(item, json);
  if (isFinal(item)) return FINAL_CODES[item.state];
  return wait === undefined ? 0 : EX_TEMPFAIL;
}

// An account that can't run Claude until it signs in (the published
// needsSignIn: a folder with no login, or usage's lapsed-login flag).
async function needsSignIn(home, account) {
  if (account.signedIn !== true) return true;
  const usage = await contractUsage(home, account).catch(() => null);
  return usage?.needsSignIn === true;
}

export async function resume(args) {
  const { values } = parseArgs({
    args,
    options: {
      terminal: { type: "string" },
      account: { type: "string" },
      message: { type: "string" },
      wait: { type: "string" },
      status: { type: "string" },
      cancel: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const modes = [values.terminal, values.status, values.cancel].filter((v) => v !== undefined).length;
  if (modes !== 1) throw usageError(RESUME_USAGE);
  let wait;
  if (values.wait !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(values.wait) || values.cancel !== undefined) throw usageError(RESUME_USAGE);
    wait = Math.min(Number(values.wait), MAX_WAIT_S);
  }
  const home = stateHome();
  const t = timing();

  if (values.status !== undefined || values.cancel !== undefined) {
    if (values.account !== undefined || values.message !== undefined) throw usageError(RESUME_USAGE);
    const known = await knownAccounts(home);
    if (values.status !== undefined) return report(home, known, t, values.status, { wait, json: values.json });
    return cancelJob(home, known, t, values.cancel, values.json);
  }

  const terminalId = values.terminal;
  if (!terminalId || !values.account) throw usageError(RESUME_USAGE);
  const known = await knownAccounts(home);
  const live = await underLock(home, known, t, async (doc) => ({
    result: doc.items.find((item) => item.terminal === terminalId && item.kind === "resume" && isLive(item)) ?? null,
  }));
  if (live) return accepted(home, known, t, live.id, { wait, json: values.json });

  const account = known.accounts.find((a) => a.id === values.account);
  if (!account) throw failure(`unknown account "${values.account}"`, 7);
  if (await needsSignIn(home, account)) {
    throw failure(`${account.isDefault ? "System default" : (account.email ?? account.id)} needs you to sign in again before Claude can run on it.`, 5);
  }
  const found = await inspectTerminal(terminalId, known);
  if (found.kind === "unreadable") throw failure(`couldn't read terminal ${terminalId} (${found.error})`);
  if (found.kind === "missing") throw failure(`terminal ${terminalId} is missing`, 3);
  if (found.kind === "notClaude") throw failure(`terminal ${terminalId} isn't running Claude`, 3);
  if (found.ownProgram) throw failure(`Claude is terminal ${terminalId}'s own program: there's no shell to restart it in`, 8);
  if (found.kind === "noSession") throw failure(`Claude in terminal ${terminalId} has no session file yet`, 2);
  // Nothing is resumed on a terminal already on the account: it only gets
  // the message, so it needs no transcript.
  if (found.account !== account.id && !(await hasTranscript(found.configDir, found.sessionId))) {
    throw failure(noConversation(terminalId, found.sessionId), 2);
  }

  const job = await underLock(home, known, t, async (doc, now) => {
    const again = doc.items.find((item) => item.terminal === terminalId && item.kind === "resume" && isLive(item));
    if (again) return { result: { item: again, fresh: false } };
    // A switch item still waiting on this terminal gives way to the job.
    doc.items = doc.items.filter((item) => !(item.terminal === terminalId && item.kind === "switch" && NOT_STARTED.has(item.state)));
    const item = newItem(
      "resume",
      {
        terminal: terminalId,
        from: found.account,
        to: account.id,
        sessionId: found.sessionId,
        args: keptArgs(found.argv),
        message: values.message ?? null,
      },
      doc.items,
      now,
    );
    doc.items.push(item);
    return { result: { item, fresh: true }, write: true };
  });
  if (job.fresh) spawnRunner();
  return accepted(home, known, t, job.item.id, { wait, json: values.json });
}

// A job accepted (new or the terminal's live one): {"job": id}, or with
// --wait the job's status and its exit.
async function accepted(home, known, t, id, { wait, json }) {
  if (wait !== undefined) return report(home, known, t, id, { wait, json });
  process.stdout.write(json ? render({ job: id }) : `${id}\n`);
  return 0;
}

async function cancelJob(home, known, t, id, json) {
  const item = await underLock(home, known, t, async (doc, now) => {
    const found = doc.items.find((i) => i.id === id) ?? null;
    if (!found || !NOT_STARTED.has(found.state)) return { result: found };
    finalize(found, "cancelled", null, now);
    return { result: found, write: true };
  });
  if (!item) throw failure(`unknown job "${id}"`, 7);
  printStatus(item, json);
  if (item.state === "cancelled") return 0;
  say(`claude-accounts resume: job ${id} ${isFinal(item) ? `already ended (${item.state})` : "already stopped Claude"}; it can't be cancelled`);
  return 1;
}
