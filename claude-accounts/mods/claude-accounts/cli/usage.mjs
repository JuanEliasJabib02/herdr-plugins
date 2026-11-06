// Claude usage per account (D4, D16), Orca's main/rate-limits/ ported to a
// command that runs and exits. Owner: T3.
//
//   usage [--refresh] [--account <id>] [--json]
//     Merges the statusline's live/ drops (every run), reads the accounts
//     that are due (each with its own token, from keychain.mjs), and prints
//     accounts.v1.json, rebuilt. --account reads only that one (an unknown
//     id exits 7); the output still lists every account. It answers within
//     15 s: a read cut by then keeps its last data, and the exit is 4.
//
// contractUsage(home, account) → { usage, credits, error, errorDetail,
// needsSignIn, usageUpdatedAt }: one account's part of accounts.v1.json (D9),
// read from usage-state.json. files.rebuildContract calls it for each
// account. usage {session, weekly, fable, monthly} each {percent, resetsAt}
// or null; a window past its reset is dropped, and so is the whole last data
// once it outlives D4's expiry. errorDetail is the raw text format.js's
// errorCopy shows where Orca does (missing-scope's message), or null.
//
// parseUsageResponse(data) → { usage, credits }: the endpoint's JSON in
// Orca's order (claude-oauth-usage-request.ts, claude-usage-window.ts,
// claude-usage-credits.ts), plus D4's limits[] fallback for session and
// weekly. Exported for its tests.
//
// usage-state.json is this module's own: { version: 1, accounts: { <id>:
// entry } }, an entry being { usage, credits, source: "fetch"|"live"|null,
// usageUpdatedAt, error, errorDetail, needsSignIn, checkedAt, failureStreak,
// retryAt, liveAt, claim: {pid, at}|null } (epoch ms throughout).
//   - usageUpdatedAt: when the data shown was read (a good fetch, or the
//     drop it came from); checkedAt: when the last fetch ended, good or not.
//   - claim: the fetch claim (D2). It's taken under the lock, the Keychain
//     and the network run with the lock released, and the merge locks again.
//     A claim whose pid is dead, or older than 15 s, is void.
//   - liveAt: the newest drop merged, so a drop is merged once.
// Tokens are never written, printed or logged: an error text that quotes the
// token (a server echoing it) has it replaced before it's kept.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { FILES, stateHome, usageUrl } from "./paths.mjs";
import { failure, isAlive, readJson, rebuildContract, render, withLock, writeAtomic } from "./files.mjs";
import { knownAccounts } from "./accounts.mjs";
import { readCredentials } from "./keychain.mjs";

// ── Orca's numbers (service/service-types.ts, claude-oauth-usage-request.ts) ─

const MIN_REFETCH_MS = 5 * 60_000;
const REFRESH_FLOOR_MS = 30_000;
const INACTIVE_DEBOUNCE_MS = 60_000;
const FAILURE_REFETCH_MS = 30_000;
const MAX_FAILURE_REFETCH_MS = 15 * 60_000;
const MAX_FAILURE_STREAK = 8;
const STALE_MS = 30 * 60_000;
const LONG_STALE_MS = 24 * 60 * 60_000;
const LIVE_DEDUPE_MS = 30_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const SAME_WINDOW_TOLERANCE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

// D2: a fetch claim older than this is void. D9: `usage` answers within 15 s,
// so reads stop a second earlier, leaving room for the merge and the print.
const CLAIM_VOID_MS = 15_000;
const READ_DEADLINE_MS = 14_000;
const CLAIM_POLL_MS = 100;

const WINDOWS = ["session", "weekly", "fable", "monthly"];
const RATE_LIMITED = "Claude usage is rate limited right now.";

// ── Values ─────────────────────────────────────────────────────────────────

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v) => Math.min(100, Math.max(0, v));
const emptyUsage = () => Object.fromEntries(WINDOWS.map((w) => [w, null]));

// Orca's parseClaudeUsageResetTimestamp: seconds, ms (above 1e10), a numeric
// string of either, or a date string; epoch ms or null.
function resetTimestamp(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

const toWindow = (percent, resetsAt) => ({ percent: Math.round(clamp(percent)), resetsAt: resetTimestamp(resetsAt) });

// The endpoint's window shape: utilization first (mapClaudeUsageWindow).
function oauthWindow(raw) {
  if (!isObject(raw)) return null;
  const used = finite(raw.utilization) ? raw.utilization : finite(raw.used_percentage) ? raw.used_percentage : null;
  return used === null ? null : toWindow(used, raw.resets_at);
}

// The statusline's window shape: used_percentage first, utilization when it
// drifts (shared/claude-statusline-rate-limits.ts).
function liveWindow(raw) {
  if (!isObject(raw)) return null;
  const used = finite(raw.used_percentage) ? raw.used_percentage : finite(raw.utilization) ? raw.utilization : null;
  return used === null ? null : toWindow(used, raw.resets_at);
}

function limitWindow(limits, match) {
  const limit = Array.isArray(limits) ? limits.find((l) => isObject(l) && finite(l.percent) && match(l)) : undefined;
  return limit ? toWindow(limit.percent, limit.resets_at) : null;
}

const isFableLimit = (l) => {
  const name = l.scope?.model?.display_name;
  return l.kind === "weekly_scoped" && typeof name === "string" && name.trim().toLowerCase() === "fable";
};

// Money in major units: a number, or { amount_minor, exponent (default 2) }.
function moneyToMajor(money) {
  if (typeof money === "number") return Number.isFinite(money) ? money : null;
  if (!isObject(money) || !finite(money.amount_minor)) return null;
  const exponent = typeof money.exponent === "number" ? money.exponent : 2;
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) return null;
  return money.amount_minor / 10 ** exponent;
}

// { balance, limit, percent } from `spend`, or null (mapSpend).
function fromSpend(spend) {
  if (!isObject(spend)) return null;
  const spent = moneyToMajor(spend.used);
  const limit = moneyToMajor(spend.limit) ?? moneyToMajor(isObject(spend.cap) ? spend.cap.money : null);
  const balance = moneyToMajor(spend.balance);
  if (limit === null && balance === null) return null;
  const percent = finite(spend.percent)
    ? clamp(spend.percent)
    : limit !== null && limit > 0 && spent !== null
      ? clamp((spent / limit) * 100)
      : null;
  return { balance, limit, percent };
}

// The older `extra_usage` shape (mapLegacyExtraUsage): amounts before
// utilization, which has been seen as a 0–1 fraction too.
function fromExtraUsage(extra) {
  if (!isObject(extra)) return null;
  const limit = moneyToMajor({ amount_minor: extra.monthly_limit ?? undefined, exponent: extra.decimal_places });
  if (limit === null) return null;
  const spent = moneyToMajor({ amount_minor: extra.used_credits ?? undefined, exponent: extra.decimal_places });
  const percent =
    limit > 0 && spent !== null ? clamp((spent / limit) * 100) : finite(extra.utilization) ? clamp(extra.utilization) : null;
  return { balance: null, limit, percent };
}

const spendWindow = (x) => (x && x.percent !== null && x.limit !== null && x.limit > 0 ? { percent: Math.round(x.percent), resetsAt: null } : null);

export function parseUsageResponse(data) {
  const d = isObject(data) ? data : {};
  const session = oauthWindow(d.five_hour) ?? limitWindow(d.limits, (l) => l.kind === "session");
  const weekly = oauthWindow(d.seven_day) ?? limitWindow(d.limits, (l) => l.kind === "weekly_all");
  const fable =
    limitWindow(d.limits, isFableLimit) ??
    oauthWindow(d.fable_weekly) ??
    oauthWindow(d.fable_seven_day) ??
    oauthWindow(d.seven_day_fable);
  const spend = fromSpend(d.spend);
  const legacy = fromExtraUsage(d.extra_usage);
  const extra = spend ?? legacy;
  // With plan windows, spend is overage after a cap, not the account's limit.
  const monthly = session || weekly ? null : (spendWindow(spend) ?? spendWindow(legacy));
  return {
    usage: { session, weekly, fable, monthly },
    credits: extra ? { balance: extra.balance, limit: extra.limit } : null,
  };
}

// ── Windows over time (claude-usage-window.ts, service-result-policy.ts) ───

const sameReset = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS);
const sameWindow = (a, b) => (a && b ? a.percent === b.percent && sameReset(a.resetsAt, b.resetsAt) : a === b);

// Within one window usage only grows: a lower value, or an older reset, is an
// idle session's stale snapshot (isStaleClaudeUsageWindow).
function isStaleWindow(previous, incoming, now) {
  if (!previous || previous.resetsAt === null || incoming.resetsAt === null) return false;
  if (previous.resetsAt <= now) return false;
  if (incoming.resetsAt < previous.resetsAt - SAME_WINDOW_TOLERANCE_MS) return true;
  return sameReset(incoming.resetsAt, previous.resetsAt) && incoming.percent < previous.percent;
}

// A window past its reset no longer describes the account (withoutResetWindows).
const withoutResetWindows = (usage, now) =>
  Object.fromEntries(WINDOWS.map((w) => [w, usage[w] && (usage[w].resetsAt === null || usage[w].resetsAt > now) ? usage[w] : null]));

// After a failure the last data is kept 30 min, or 24 h after a 429 or a
// lapsed token (applyStalePolicy).
function isExpired(entry, now) {
  if (!(entry.error || entry.needsSignIn) || entry.usageUpdatedAt === null) return false;
  const keep = entry.error === "rateLimited" || entry.error === "expired" ? LONG_STALE_MS : STALE_MS;
  return now - entry.usageUpdatedAt > keep;
}

// What an entry shows now: its data, minus past-reset windows, or nothing
// once it's expired.
function visible(entry, now) {
  if (isExpired(entry, now)) return { usage: emptyUsage(), credits: null, usageUpdatedAt: null };
  return { usage: withoutResetWindows(entry.usage, now), credits: entry.credits, usageUpdatedAt: entry.usageUpdatedAt };
}

// ── usage-state.json ───────────────────────────────────────────────────────

const ERRORS = ["expired", "rateLimited", "keychain", "network", "refreshFailed", "noSubscription", "unavailable"];

const blankEntry = () => ({
  usage: emptyUsage(),
  credits: null,
  source: null,
  usageUpdatedAt: null,
  error: null,
  errorDetail: null,
  needsSignIn: false,
  checkedAt: null,
  failureStreak: 0,
  retryAt: null,
  liveAt: null,
  claim: null,
});

const time = (v) => (finite(v) ? v : null);
const readWindow = (w) => (isObject(w) && finite(w.percent) ? { percent: Math.round(clamp(w.percent)), resetsAt: time(w.resetsAt) } : null);

// An entry as written, every field checked: a wrong type is its empty value.
function readEntry(raw) {
  const e = isObject(raw) ? raw : {};
  const usage = isObject(e.usage) ? e.usage : {};
  const credits = isObject(e.credits) ? { balance: time(e.credits.balance), limit: time(e.credits.limit) } : null;
  const claim = isObject(e.claim) && Number.isInteger(e.claim.pid) && finite(e.claim.at) ? { pid: e.claim.pid, at: e.claim.at } : null;
  return {
    usage: Object.fromEntries(WINDOWS.map((w) => [w, readWindow(usage[w])])),
    credits: credits && (credits.balance !== null || credits.limit !== null) ? credits : null,
    source: e.source === "fetch" || e.source === "live" ? e.source : null,
    usageUpdatedAt: time(e.usageUpdatedAt),
    error: ERRORS.includes(e.error) ? e.error : null,
    errorDetail: typeof e.errorDetail === "string" ? e.errorDetail : null,
    needsSignIn: e.needsSignIn === true,
    checkedAt: time(e.checkedAt),
    failureStreak: Number.isInteger(e.failureStreak) ? Math.min(Math.max(e.failureStreak, 0), MAX_FAILURE_STREAK) : 0,
    retryAt: time(e.retryAt),
    liveAt: time(e.liveAt),
    claim,
  };
}

// { state, text }: the parsed state and the file's text as rendered, so a
// save that changes nothing writes nothing (no watch event for the footer).
// A file that isn't JSON stops the command, as every state file does
// (files.readJson): it's never overwritten.
async function loadState(home) {
  const raw = await readJson(join(home, FILES.usageState));
  const accounts = {};
  if (isObject(raw?.accounts)) {
    for (const [id, entry] of Object.entries(raw.accounts)) accounts[id] = readEntry(entry);
  }
  const state = { version: 1, accounts };
  return { state, text: raw === null ? null : render(state) };
}

async function saveState(home, state, text) {
  const next = render(state);
  if (next !== text) await writeAtomic(join(home, FILES.usageState), next);
}

// ── Live drops (D16) ───────────────────────────────────────────────────────

// The statusline's drops: { configDir (null for System default), at,
// session, weekly }. Read only: live/'s one writer is the statusline. A file
// that isn't a drop (its tmp files, a half-written or foreign one) is skipped.
async function readDrops(home) {
  const dir = join(home, FILES.live);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const drops = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    let raw;
    try {
      raw = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isObject(raw) || !finite(raw.at) || !isObject(raw.rate_limits)) continue;
    const session = liveWindow(raw.rate_limits.five_hour);
    const weekly = liveWindow(raw.rate_limits.seven_day);
    if (!session && !weekly) continue;
    const configDir = typeof raw.configDir === "string" && raw.configDir !== "" ? raw.configDir : null;
    drops.push({ configDir, at: raw.at, session, weekly });
  }
  return drops.sort((a, b) => a.at - b.at);
}

// Which account a drop is from: the exact configDir, null for System default.
const dropAccount = (accounts, drop) =>
  accounts.find((a) => (a.isDefault ? drop.configDir === null : a.configDir !== null && a.configDir === drop.configDir));

// One drop into its account's entry (ingestLiveClaudeRateLimits): each
// window unless it's stale, Fable and credits kept from the last fetch. A
// drop newer than the last fetch also clears that fetch's error: Claude just
// ran a turn on this login.
function mergeDrop(entry, drop, now) {
  if (entry.liveAt !== null && drop.at <= entry.liveAt) return;
  entry.liveAt = drop.at;
  const current = visible(entry, now);
  const keepIfNewer = (incoming, previous) => {
    if (!incoming || isStaleWindow(previous, incoming, now)) return null;
    return sameWindow(previous, incoming) ? previous : incoming;
  };
  const freshSession = keepIfNewer(drop.session, current.usage.session);
  const freshWeekly = keepIfNewer(drop.weekly, current.usage.weekly);
  if (!freshSession && !freshWeekly) return;
  const session = freshSession ?? current.usage.session;
  const weekly = freshWeekly ?? current.usage.weekly;
  const unchanged = sameWindow(current.usage.session, session) && sameWindow(current.usage.weekly, weekly);
  const droppedStale = (drop.session && !freshSession) || (drop.weekly && !freshWeekly);
  if (unchanged && droppedStale) return;
  const recentLive = entry.source === "live" && !entry.error && current.usageUpdatedAt !== null && drop.at - current.usageUpdatedAt < LIVE_DEDUPE_MS;
  if (unchanged && recentLive) return;
  if (entry.checkedAt === null || drop.at > entry.checkedAt) {
    Object.assign(entry, { error: null, errorDetail: null, needsSignIn: false, failureStreak: 0 });
  }
  Object.assign(entry, {
    usage: { ...current.usage, session, weekly },
    credits: current.credits,
    source: "live",
    usageUpdatedAt: Math.max(current.usageUpdatedAt ?? 0, drop.at),
  });
}

// ── Cadence and claims (D2, D4) ────────────────────────────────────────────

const claimLive = (claim, now) => Boolean(claim) && now - claim.at <= CLAIM_VOID_MS && isAlive(claim.pid);

// Orca's polling plan, per account: 5 min after a good read; after a failure
// 30 s doubling per failure up to 15 min; --refresh at most every 30 s;
// inactive accounts at most every 60 s; a 429's Retry-After holds all but
// --refresh.
function isDue(entry, now, { refresh, active }) {
  if (!entry || entry.checkedAt === null) return true;
  if (!refresh && entry.retryAt !== null && entry.retryAt > now) return false;
  const since = now - entry.checkedAt;
  if (!active && since < INACTIVE_DEBOUNCE_MS) return false;
  if (refresh) return since >= REFRESH_FLOOR_MS;
  const wait =
    entry.failureStreak > 0
      ? Math.min(FAILURE_REFETCH_MS * 2 ** (entry.failureStreak - 1), MAX_FAILURE_REFETCH_MS)
      : MIN_REFETCH_MS;
  return since >= wait;
}

// Under the lock: merges the drops (when `all` is given, the full account
// list, which also prunes entries of removed accounts), then claims each due
// target. Returns { mine: [{account, at}], busy: [account] }, busy being the
// targets another live claim holds.
async function claim(run, targets, all) {
  return withLock(run.home, async () => {
    const now = Date.now();
    const { state, text } = await loadState(run.home);
    if (all) {
      for (const id of Object.keys(state.accounts)) if (!all.some((a) => a.id === id)) delete state.accounts[id];
      for (const drop of await readDrops(run.home)) {
        const account = dropAccount(all, drop);
        if (account) mergeDrop((state.accounts[account.id] ??= blankEntry()), drop, now);
      }
    }
    const mine = [];
    const busy = [];
    for (const account of targets) {
      const entry = state.accounts[account.id];
      if (entry && claimLive(entry.claim, now)) {
        busy.push(account);
        continue;
      }
      if (!isDue(entry, now, { refresh: run.refresh, active: account.id === run.active })) continue;
      (state.accounts[account.id] ??= blankEntry()).claim = { pid: process.pid, at: now };
      mine.push({ account, at: now });
    }
    await saveState(run.home, state, text);
    return { mine, busy };
  });
}

// ── Reading one account (claude-active-usage-fetch.ts) ─────────────────────

const ABORTED = Object.freeze({ aborted: true });

const mentionsRateLimit = (text) =>
  typeof text === "string" && !/\bauthentication required\b/i.test(text) && /\brate[- ]?limits?\b|\brate[- ]?limited\b/i.test(text);

// The token, wherever an error text quotes it, is replaced.
const redact = (text, token) => (typeof text === "string" && token ? text.split(token).join("[redacted]") : text);

// Orca's describeOAuthUsageError: its own text for a 429, else the body's
// error.message, else the status. The body is always read, so its socket is
// let go.
async function describeError(response) {
  const text = await response.text().catch(() => "");
  if (response.status === 429) return RATE_LIMITED;
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // A body that isn't JSON says nothing more than its status.
  }
  return `OAuth API returned ${response.status}`;
}

// Retry-After in seconds or as an HTTP date, capped at 24 h; epoch ms or null.
function retryAt(header, now) {
  if (typeof header !== "string" || !header.trim()) return null;
  const value = header.trim();
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? now + Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

// Claude Code renews a lapsed access token by itself while its refresh token
// lives and wasn't revoked (canClaudeRenewLogin); otherwise it's a sign-in.
const canRenew = (creds, message, now) =>
  creds.hasRefreshToken && (creds.refreshTokenExpiresAt === null || creds.refreshTokenExpiresAt > now) && !/revoked/i.test(message);

// D4's mapping of a non-OK answer (claude-usage-error-classification.ts).
function classify(response, message, creds) {
  const status = response.status;
  if (status === 429) return { error: "rateLimited", retryAt: retryAt(response.headers.get("retry-after"), Date.now()) };
  if (status === 401 || (status === 403 && !message.includes("user:profile"))) {
    return canRenew(creds, message, Date.now()) ? { error: "expired" } : { needsSignIn: true };
  }
  if (status === 403) return { error: "unavailable", detail: message };
  if (status >= 500) return { error: "unavailable" };
  // Orca labels any other failure that names a rate limit "Limited".
  if (mentionsRateLimit(message)) return { error: "rateLimited" };
  return { error: "unavailable" };
}

// One account's read, the lock released: { ok: true, usage, credits } |
// { ok: false, error?, detail?, needsSignIn?, retryAt? } | ABORTED.
async function readAccount(account, signal, env) {
  const creds = await readCredentials(account.configDir, { signal, env });
  if (signal.aborted) return ABORTED;
  if (creds.error) return { ok: false, error: "keychain" };
  if (!creds.accessToken) return { ok: false, needsSignIn: true };
  if (creds.refreshTokenExpiresAt !== null && creds.refreshTokenExpiresAt <= Date.now()) return { ok: false, needsSignIn: true };
  const token = creds.accessToken;
  try {
    let response;
    try {
      response = await fetch(usageUrl(env), {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch {
      return signal.aborted ? ABORTED : { ok: false, error: "network" };
    }
    if (!response.ok) {
      const message = redact(await describeError(response), token);
      if (signal.aborted) return ABORTED;
      const failed = classify(response, message, creds);
      return { ok: false, ...failed, detail: redact(failed.detail, token) ?? null };
    }
    let data;
    try {
      data = await response.json();
    } catch (e) {
      if (signal.aborted) return ABORTED;
      // Malformed JSON is Orca's `parse`: "Claude usage is unavailable right now."
      return { ok: false, error: e instanceof SyntaxError ? "unavailable" : "network" };
    }
    return { ok: true, ...parseUsageResponse(data) };
  } catch (e) {
    // Anything else is Orca's `unknown`: its text, minus the token.
    const message = redact(String(e?.message ?? e), token);
    return { ok: false, error: mentionsRateLimit(message) ? "rateLimited" : "refreshFailed", detail: message };
  }
}

// A read's result into its entry (applyStalePolicy, resolveClaudeFetchApply).
function applyRead(entry, result, now) {
  entry.checkedAt = now;
  if (result.ok) {
    Object.assign(entry, {
      usage: result.usage,
      credits: result.credits,
      source: "fetch",
      usageUpdatedAt: now,
      error: null,
      errorDetail: null,
      needsSignIn: false,
      failureStreak: 0,
      retryAt: null,
    });
    return;
  }
  entry.failureStreak = Math.min(entry.failureStreak + 1, MAX_FAILURE_STREAK);
  if (result.retryAt) entry.retryAt = result.retryAt;
  // A drop newer than 5 min outranks a failed read: the numbers stay, with
  // no error, while the backoff and Retry-After still count.
  const liveFresh =
    entry.source === "live" && !entry.error && !entry.needsSignIn && entry.usageUpdatedAt !== null && now - entry.usageUpdatedAt < MIN_REFETCH_MS;
  if (liveFresh) return;
  Object.assign(entry, { error: result.error ?? null, errorDetail: result.detail ?? null, needsSignIn: result.needsSignIn === true });
  if (isExpired(entry, now)) Object.assign(entry, { usage: emptyUsage(), credits: null, usageUpdatedAt: null, source: null });
}

// Reads a claimed account and merges it under the lock. Resolves to false
// when the deadline cut it: nothing is merged and the claim is let go.
async function readAndMerge(run, { account, at }, signal) {
  const result = await readAccount(account, signal, run.env);
  await withLock(run.home, async () => {
    const { state, text } = await loadState(run.home);
    const entry = (state.accounts[account.id] ??= blankEntry());
    if (!result.aborted) applyRead(entry, result, Date.now());
    if (entry.claim?.pid === process.pid && entry.claim.at === at) entry.claim = null;
    await saveState(run.home, state, text);
  });
  return !result.aborted;
}

// --refresh on an account another run is reading: waits for that claim's
// merge. A claim that goes void (its run died) is taken over when the
// account is still due. False when the deadline comes first.
async function awaitClaim(run, account, signal) {
  try {
    for (;;) {
      await sleep(CLAIM_POLL_MS, undefined, { signal });
      const entry = (await loadState(run.home)).state.accounts[account.id];
      if (!entry?.claim) return true;
      if (claimLive(entry.claim, Date.now())) continue;
      const { mine, busy } = await claim(run, [account], null);
      if (mine.length) return readAndMerge(run, mine[0], signal);
      if (!busy.length) return true;
    }
  } catch (e) {
    if (signal.aborted) return false;
    throw e;
  }
}

// ── The command ────────────────────────────────────────────────────────────

const LABELS = { session: "session", weekly: "weekly", fable: "Fable", monthly: "monthly" };

function describeAccount(a, active) {
  const parts = WINDOWS.filter((w) => a.usage[w]).map((w) => `${LABELS[w]} ${a.usage[w].percent}%`);
  const notes = [a.needsSignIn ? "needs sign-in" : null, a.error, parts.length || a.error || a.needsSignIn ? null : "no usage yet"].filter(Boolean);
  const mark = a.id === active ? "*" : " ";
  return `${mark} ${a.label}  ${[parts.join(" · "), notes.length ? `(${notes.join(", ")})` : ""].filter(Boolean).join("  ")}`;
}

export async function usage(args) {
  const { values } = parseArgs({
    args,
    options: { refresh: { type: "boolean" }, account: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  // Counted from the process's start, so a slow start doesn't push the
  // answer past 15 s.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, READ_DEADLINE_MS - process.uptime() * 1000));
  let finished = true;
  try {
    const home = stateHome();
    const known = await knownAccounts(home);
    const only = values.account;
    if (only !== undefined && !known.accounts.some((a) => a.id === only)) throw failure(`unknown account "${only}"`, 7);
    const targets = known.accounts.filter((a) => only === undefined || a.id === only);
    const run = { home, env: process.env, refresh: values.refresh === true, active: known.active };
    const { mine, busy } = await claim(run, targets, known.accounts);
    const done = await Promise.all([
      ...mine.map((claimed) => readAndMerge(run, claimed, deadline.signal)),
      ...(run.refresh ? busy.map((account) => awaitClaim(run, account, deadline.signal)) : []),
    ]);
    finished = done.every(Boolean);
  } finally {
    clearTimeout(timer);
  }
  const doc = await rebuildContract(stateHome());
  process.stdout.write(values.json ? render(doc) : `${doc.accounts.map((a) => describeAccount(a, doc.active)).join("\n")}\n`);
  if (finished) return 0;
  process.stderr.write("claude-accounts usage: a read didn't finish within 15 s; its account keeps its last data\n");
  return 4;
}

export async function contractUsage(home, account) {
  const { state } = await loadState(home);
  const entry = state.accounts[account.id];
  if (!entry) return { usage: null, credits: null, error: null, errorDetail: null, needsSignIn: null, usageUpdatedAt: null };
  const shown = visible(entry, Date.now());
  return {
    usage: shown.usage,
    credits: shown.credits,
    error: entry.error,
    errorDetail: entry.errorDetail,
    needsSignIn: entry.needsSignIn,
    usageUpdatedAt: shown.usageUpdatedAt,
  };
}
