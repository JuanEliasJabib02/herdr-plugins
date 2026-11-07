// Continuar, auto-resume and the stale-usage classification (T11, S10, S13;
// D13, D15, D18): the CLI side of resume.js, which holds the rules.
// Node-only, like cli.mjs; the mod never imports it.
//
//   continueTask   `spotlight continue --terminal t [--auto] [--account id]`:
//                  opens the resume window under the state lock, then (in a
//                  detached `--inline` copy, D18) an idle holder gets Esc and
//                  the message; a paused agent is moved by the claude-accounts
//                  plugin's `resume` job to the account with the most limit
//                  left; without the plugin the message is typed in
//   settleResumes  polls each live job (`resume --status`) before any turn
//                  end is decided (reap, on, off), caching its final state
//   autoResume     the reap's auto-resume: a detached `continue --auto` per
//                  due `limit` pause
//   classifyTerminal  `spotlight classify --terminal t`: a turn end whose
//                  usage was stale, decided with a fresh read
//
// The plugin is reached only through its contract (CONTRACT.md): its
// accounts.v1.json and `claude-accounts <cmd> --json`. Never `use`: it changes
// the global active account.

import fs from "node:fs";
import { request, release } from "./queue.js";
import { addNote } from "./store.js";
import { decideTurnEnd, inResumeWindow } from "./cli-turns.mjs";
import { labelOf } from "./cli-format.mjs";
import { exec, hcGet, accountsBin, accountsFileOf } from "./cli-env.mjs";
import { markGranted, spawnLights, dropStaleMarkers, applyTurnEnd } from "./cli-work.mjs";
import {
  CONTINUE_MESSAGE, RESUME_WINDOW_MS, ESC_PASTE_GAP_MS, ESC_SETTLE_MS, parseAccounts, pickAccount, accountLabel, formatReturn,
  refusalText, jobLive, jobAnswer, settleFinal, resumedFields, windowFields, continuePlan, autoResumeDue, autoRetryAt,
} from "./resume.js";

// The plugin answers `usage --refresh` within 15 s, `resume` in under a
// second; `--status` is a file read.
const USAGE_TIMEOUT_MS = 20_000;
const RESUME_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;
// `hc send` waits for a person to stop typing first.
const SEND_TIMEOUT_MS = 20_000;
// How often the Esc's effect is looked at.
const ESC_POLL_MS = 250;
// classify asks hc this many times, this far apart, before it gives up.
const CLASSIFY_HC_TRIES = 3;
const CLASSIFY_HC_RETRY_MS = 500;
// `resume`'s immediate refusals, each with its own text (resume.js).
const IMMEDIATE = new Set([2, 3, 5, 7, 8, 64]);
const PERSON_KINDS = new Set(["permission", "question"]);

const find = (s, terminal) => s.queue.requests.find((r) => r.terminal === terminal) ?? null;
const qctxOf = (cx, now) => ({ now, ...cx.settings.queue });

function parseJson(text) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch {
    return null;
  }
}

// One call to the accounts plugin's CLI: { code, json, stderr }, or
// { error } when it isn't installed or can't start.
async function accounts(cx, args, timeoutMs) {
  const bin = accountsBin(cx.appHome);
  if (!bin) return { error: "not-installed" };
  try {
    const r = await exec(bin, args, { timeoutMs });
    return { code: r.code, json: parseJson(r.stdout), stderr: String(r.stderr ?? "").trim().split("\n").pop() ?? "" };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// `hc <args>` that answers only with its exit: { ok, message }.
async function hcDo(args, timeoutMs = 10_000) {
  try {
    const r = await exec("hc", args, { timeoutMs });
    if (r.code === 0) return { ok: true, message: null };
    const json = parseJson(r.stderr) ?? parseJson(r.stdout);
    return { ok: false, message: String(json?.error?.message ?? r.stderr ?? `hc exited ${r.code}`).trim() };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

// Types the message and presses Enter. A paused agent stopped on its limit
// can show as blocked with no person waiting: hc types into it only with
// --force, which is never used on a permission or question dialog (Enter
// would answer it).
function sendContinue(terminal, term) {
  const blocked = term?.status?.state === "blocked" && !PERSON_KINDS.has(term.status.kind ?? null);
  return hcDo(["send", terminal, CONTINUE_MESSAGE, ...(blocked ? ["--force"] : [])], SEND_TIMEOUT_MS);
}

// ── Settling the plugin's jobs (D15) ───────────────────────────────────────

// The message reached the agent: its fields, a toast for an automatic
// resume ("Reanudado con <cuenta>", `autoAccount`), and a paused agent asks
// for its place back (D15's "done → holding"): at the front of the line,
// granted at once when its repos are free, and never past the queue's
// rules. → the turns granted.
function resumeRequest(s, cur, fields, qctx, now, { autoAccount = null } = {}) {
  Object.assign(cur, fields);
  if (autoAccount) {
    const repo = cur.members?.[0]?.root ?? cur.root ?? null;
    addNote(s, { repo, text: `Reanudado con ${autoAccount}: ${labelOf(s.queue.requests, cur.taskKey)}`, toast: true }, now);
  }
  if (cur.state !== "paused") return [];
  const o = request(s.queue, { ...cur }, qctx);
  s.queue = o.queue;
  return o.granted;
}

/**
 * Polls `resume --status` for every request whose job still runs, and acts
 * on the answers under the state lock (D15): a live job extends the window
 * (and notes a terminal that left inside it); a final state is cached on the
 * request, never polled again, and then done resumes the agent, a failure
 * leaves it paused with its text, and a gone terminal is released. A job the
 * plugin no longer knows (exit 7) reads as `unknown`; one it can't answer
 * about past the window, as `lost`. → { settled }.
 */
export async function settleResumes(cx) {
  const live = cx.store.readState().queue.requests.filter((r) => jobLive(r.resumeJob));
  if (live.length === 0) return { settled: 0 };
  const reads = await Promise.all(
    live.map(async (r) => ({
      terminal: r.terminal,
      job: r.resumeJob.id,
      answer: jobAnswer(await accounts(cx, ["resume", "--status", r.resumeJob.id, "--json"], STATUS_TIMEOUT_MS)),
      term: await hcGet(r.terminal),
    })),
  );
  const now = cx.now();
  const qctx = qctxOf(cx, now);
  const out = await cx.store.updateState((s) => {
    const granted = [];
    let settled = 0;
    for (const read of reads) {
      const { terminal, job, term } = read;
      let { answer } = read;
      const cur = find(s, terminal);
      // Asked again, released or settled meanwhile: nothing of this read applies.
      if (!cur || cur.resumeJob?.id !== job || !jobLive(cur.resumeJob)) continue;
      if (answer.kind === "live") {
        Object.assign(cur.resumeJob, { state: answer.state, updatedAt: answer.updatedAt ?? cur.resumeJob.updatedAt ?? null });
        cur.resumingUntil = Math.max(Number.isFinite(cur.resumingUntil) ? cur.resumingUntil : 0, now + RESUME_WINDOW_MS);
        if (term.missing) cur.goneInWindow = true;
        continue;
      }
      if (answer.kind === "doubt") {
        // No answer: the window runs out on its own, then the job is given up.
        if (inResumeWindow(cur, now)) continue;
        answer = { kind: "final", state: "lost", code: "lost", detail: null, updatedAt: null };
      }
      const r = settleFinal(cur, answer, term, now);
      const autoAccount = cur.resumeJob.auto === true && r.resumed ? cur.resumeJob.label ?? cur.resumeJob.account : null;
      cur.resumeJob = {
        ...cur.resumeJob, state: answer.state, code: answer.code, detail: answer.detail, updatedAt: answer.updatedAt ?? now, final: true,
      };
      settled += 1;
      if (r.release) {
        const o = release(s.queue, terminal, qctx);
        s.queue = o.queue;
        granted.push(...o.granted);
      } else if (r.resumed) {
        granted.push(...resumeRequest(s, cur, r.fields, qctx, now, { autoAccount }));
      } else {
        Object.assign(cur, r.fields);
      }
    }
    const keys = markGranted(s, granted, now);
    dropStaleMarkers(s, now);
    return { keys, settled };
  });
  await spawnLights(cx, out.result.keys);
  return { settled: out.result.settled };
}

/**
 * The reap's auto-resume (D15, setting off by default): every `limit` pause
 * it may take (resume.js autoResumeDue) is marked tried and handed to a
 * detached `continue --auto`. Needs the accounts plugin (it picks an
 * account). → how many were started.
 */
export async function autoResume(cx) {
  if (!cx.settings.queue.autoResume || !accountsBin(cx.appHome)) return 0;
  const now = cx.now();
  const r = await cx.store.updateState((s) => {
    const due = s.queue.requests.filter((q) => autoResumeDue(q, { now, enabled: true }));
    for (const q of due) Object.assign(q, { autoTriedPause: q.pausedAt, autoRetryAt: null });
    return due.map((q) => q.terminal);
  });
  for (const terminal of r.result) cx.spawn(["continue", "--terminal", terminal, "--inline", "--auto"]);
  return r.result.length;
}

// ── Continuar ──────────────────────────────────────────────────────────────

const PLAN_REFUSALS = {
  "no-place": (label, t) => `${t} has no place in the test queue: nothing to continue.`,
  "not-paused": (label) => `${label} is waiting in line, not paused: nothing to continue.`,
  signin: (label) => `${label}: ${refusalText("signin").en}.`,
  "auto-holder": (label) => `${label}: auto-resume never interrupts a holder.`,
  "auto-spent": (label) => `${label}: auto-resume takes only usage-limit pauses, at most 3 in a row.`,
  "no-plugin": (label) => `${label}: auto-resume needs the claude-accounts plugin.`,
};

// Continuar didn't land: the window closes, the agent keeps its place with
// the text (`es`, for the board), the CLI says why (`en`). `extra`: more
// fields to write (auto-resume's retry time).
async function fail(cx, terminal, code, { detail = null, text = null, extra = {} } = {}) {
  const t = text ?? refusalText(code, detail);
  const now = cx.now();
  await cx.store.updateState((s) => {
    const cur = find(s, terminal);
    if (cur) Object.assign(cur, { resumingUntil: null, resumeError: { code, text: t.es, at: now } }, extra);
  });
  return { code: 1, error: `spotlight continue: ${t.en}.` };
}

// The message reached the agent without a job (typed in): the same
// bookkeeping as a job's `done` (resume.js resumedFields).
async function delivered(cx, terminal, doneAt) {
  const term = (await hcGet(terminal)).terminal ?? null;
  const now = cx.now();
  const r = await cx.store.updateState((s) => {
    const cur = find(s, terminal);
    if (!cur) return [];
    const granted = resumeRequest(s, cur, resumedFields(cur, term, { doneAt, now }), qctxOf(cx, now), now);
    return markGranted(s, granted, now);
  });
  await spawnLights(cx, r.result);
}

// An idle holder (D15, Orca's nudgeIdleHolder): Esc stops what it runs, then
// the message, in the same account; it keeps its turn. The Esc's own turn
// end is spent, so the message's is the next one decided.
async function nudgeHolder(cx, terminal, label) {
  const esc = await hcDo(["keys", terminal, "esc"]);
  if (!esc.ok) return fail(cx, terminal, "send-failed", { detail: esc.message });
  // The gap: an Esc glued to the message reads as one key to the agent.
  await cx.sleep(ESC_PASTE_GAP_MS);
  let term = (await hcGet(terminal)).terminal ?? null;
  const until = cx.now() + ESC_SETTLE_MS;
  while (term?.status?.state === "working" && cx.now() < until) {
    await cx.sleep(ESC_POLL_MS);
    term = (await hcGet(terminal)).terminal ?? null;
  }
  const spent = Number.isInteger(term?.turn) ? term.turn : null;
  const sent = await sendContinue(terminal, term);
  const handled = (cur) => {
    const turns = [cur.handledTurn, spent].filter(Number.isInteger);
    return turns.length > 0 ? Math.max(...turns) : null;
  };
  if (!sent.ok) {
    const failed = await fail(cx, terminal, "send-failed", { detail: sent.message });
    await cx.store.updateState((s) => {
      const cur = find(s, terminal);
      if (cur) cur.handledTurn = handled(cur);
    });
    return failed;
  }
  const now = cx.now();
  await cx.store.updateState((s) => {
    const cur = find(s, terminal);
    if (cur) Object.assign(cur, { resumingUntil: null, resumeError: null, lastActivityAt: now, handledTurn: handled(cur) });
  });
  return { code: 0, text: `Interrupted ${label}'s agent and told it "${CONTINUE_MESSAGE}" (same account; the turn stays).` };
}

// A paused agent without the accounts plugin (D15): the message, typed into
// the same agent.
async function typeContinue(cx, terminal, label, term) {
  const sentAt = cx.now();
  const sent = await sendContinue(terminal, term);
  if (!sent.ok) return fail(cx, terminal, "send-failed", { detail: sent.message });
  await delivered(cx, terminal, sentAt);
  return { code: 0, text: `Told ${label}'s agent "${CONTINUE_MESSAGE}" (no claude-accounts plugin: same account). It asked for its place back.` };
}

// accounts.v1.json, fresh: the document `usage --refresh` prints, else the
// file as it is.
async function freshAccounts(cx) {
  const r = await accounts(cx, ["usage", "--refresh", "--json"], USAGE_TIMEOUT_MS);
  const printed = parseAccounts(r.json ?? null);
  if (printed.ok || printed.reason === "version") return printed;
  let text = null;
  try {
    text = fs.readFileSync(accountsFileOf(cx.appHome), "utf8");
  } catch {
    // No file either: unreadable.
  }
  return parseAccounts(text);
}

// A paused agent with the accounts plugin (D15, Orca's resumePausedPane):
// a fresh usage read, the pick, and the plugin's `resume` job, settled by
// the reap.
async function resumeOnAccount(cx, terminal, label, { auto, account }) {
  const parsed = await freshAccounts(cx);
  if (!parsed.ok) return fail(cx, terminal, parsed.reason === "version" ? "accounts-version" : "accounts-unreadable");
  let pick;
  if (account) {
    const known = parsed.doc.accounts.find((a) => a.id === account);
    pick = { kind: "account", id: account, label: known ? accountLabel(known) : account };
  } else {
    pick = pickAccount(parsed.doc);
  }
  if (pick.kind === "none") {
    const base = refusalText("no-account");
    const back = Number.isFinite(pick.returnsAt) ? formatReturn(pick.returnsAt) : null;
    const text = back
      ? { es: `${base.es}. ${back}`, en: `${base.en} (${back.replace("Vuelve a las", "the first is back at")})` }
      : base;
    return fail(cx, terminal, "no-account", { text, extra: auto ? { autoRetryAt: autoRetryAt(pick.returnsAt, cx.now()) } : {} });
  }
  const r = await accounts(
    cx,
    ["resume", "--terminal", terminal, "--account", pick.id, "--message", CONTINUE_MESSAGE, "--json"],
    RESUME_TIMEOUT_MS,
  );
  const job = r.code === 0 && typeof r.json?.job === "string" && r.json.job !== "" ? r.json.job : null;
  if (!job) {
    const code = r.error ? "unavailable" : r.code === 0 ? 1 : r.code;
    return fail(cx, terminal, code, { detail: IMMEDIATE.has(code) ? null : r.error ?? (r.stderr || null) });
  }
  const now = cx.now();
  await cx.store.updateState((s) => {
    const cur = find(s, terminal);
    if (!cur) return;
    cur.resumeJob = {
      id: job, account: pick.id, label: pick.label, auto, startedAt: now, state: "queued", code: null, detail: null, updatedAt: now, final: false,
    };
    cur.resumingUntil = Math.max(Number.isFinite(cur.resumingUntil) ? cur.resumingUntil : 0, now + RESUME_WINDOW_MS);
    cur.resumeError = null;
  });
  return {
    code: 0,
    text: `Continuing ${label} on ${pick.label}: its Claude restarts on that account and is told "${CONTINUE_MESSAGE}" (job ${job}).`,
  };
}

/**
 * `spotlight continue` (D15, D18). `inline`: do the work here (the detached
 * copy, or a test); otherwise open the window, hand the work to a detached
 * `continue --inline` and return at once. `auto`: auto-resume asks.
 * `account`: resume on this account instead of the pick. → { code, text?,
 * error? }: 0 when it started, was already running, or delivered; 1 when
 * there was nothing to continue or it didn't land (the reason is on the
 * request too, for the board).
 */
export async function continueTask(cx, { terminal, inline = false, auto = false, account = null }) {
  const plugin = Boolean(accountsBin(cx.appHome));
  const term = (await hcGet(terminal)).terminal ?? null;
  const now = cx.now();
  // D13: the window opens before Continuar acts, under the state lock, so a
  // second Continuar sees it (the detached copy it was opened for doesn't
  // count it as busy).
  const opened = await cx.store.updateState((s) => {
    const req = find(s, terminal);
    const plan = continuePlan(req, { auto, plugin, now, busy: !inline });
    if (plan.kind === "esc" || plan.kind === "account" || plan.kind === "send") Object.assign(req, windowFields(req, term, now));
    return { plan, label: req ? labelOf(s.queue.requests, req.taskKey) : terminal };
  });
  const { plan, label } = opened.result;
  if (plan.kind === "refuse") return { code: 1, error: `spotlight continue: ${PLAN_REFUSALS[plan.code](label, terminal)}` };
  if (plan.kind === "reuse") return { code: 0, text: `Already resuming ${label}: job ${plan.job} is running.` };
  if (plan.kind === "busy") return { code: 0, text: `Continuar is already running for ${label}.` };
  if (!inline) {
    cx.spawn(["continue", "--terminal", terminal, "--inline", ...(auto ? ["--auto"] : []), ...(account ? ["--account", account] : [])]);
    return { code: 0, text: `Continuing ${label}: \`spotlight status\` shows how it goes.` };
  }
  if (plan.kind === "esc") return nudgeHolder(cx, terminal, label);
  if (plan.kind === "send") return typeContinue(cx, terminal, label, term);
  return resumeOnAccount(cx, terminal, label, { auto, account });
}

// ── classify (D13) ─────────────────────────────────────────────────────────

/**
 * `spotlight classify --terminal t` (internal, detached by the reap): a turn
 * end that needs the account's usage, whose usage was stale. Refreshes it
 * (`usage --refresh`, 15 s), then decides as the reap would with a fresh
 * read: release, or pause `limit` / `signin` / `error`. A request that asked
 * again or moved meanwhile is left alone; hc not answering (three tries)
 * clears the mark so the next reap asks again. → { action, reason? }.
 */
export async function classifyTerminal(cx, terminal) {
  const before = find(cx.store.readState(), terminal);
  if (!before || !Number.isInteger(before.classifyTurn)) return { action: "none" };
  await accounts(cx, ["usage", "--refresh", "--json"], USAGE_TIMEOUT_MS);
  let got = await hcGet(terminal);
  // A busy hc gets two more chances before the next reap has to ask again.
  for (let i = 0; i < CLASSIFY_HC_TRIES - 1 && got.error; i += 1) {
    await cx.sleep(CLASSIFY_HC_RETRY_MS);
    got = await hcGet(terminal);
  }
  const same = (cur) =>
    cur && cur.classifyTurn === before.classifyTurn && cur.state === before.state && cur.requestTurn === before.requestTurn && cur.taskKey === before.taskKey;
  if (got.error) {
    await cx.store.updateState((s) => {
      const cur = find(s, terminal);
      if (same(cur)) Object.assign(cur, { classifyTurn: null, classifyPid: null });
    });
    return { action: "doubt" };
  }
  const read = await cx.accountUsage(terminal);
  // Just refreshed: as fresh as it gets (a refresh that timed out keeps the last data).
  const usage = read ? { ...read, fresh: true } : null;
  const term = got.missing ? null : got.terminal;
  const now = cx.now();
  const r = await cx.store.updateState((s) => {
    const cur = find(s, terminal);
    if (!same(cur)) return { d: { action: "moved" }, keys: [] };
    cur.classifyPid = null;
    const d = decideTurnEnd(cur, term, now, usage);
    const o = applyTurnEnd(s.queue, cur, d, qctxOf(cx, now));
    s.queue = o.queue;
    const keys = markGranted(s, o.granted, now);
    dropStaleMarkers(s, now);
    return { d, keys };
  });
  await spawnLights(cx, r.result.keys);
  return r.result.d;
}
