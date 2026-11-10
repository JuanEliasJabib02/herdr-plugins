// What the Usage details & history window draws (S7, D11, D24), from
// details.json (store.readDetails) and the range picked. Pure: no herdr or
// gpui-kit import, so `node --test` loads it. Owners: T10, T20b.
//
// The window is Orca's Claude usage pane (renderer/src/components/stats/
// ClaudeUsagePane.tsx and ClaudeUsageDetails.tsx, under
// ~/code/orca/src), with Orca's copy where Orca has
// it, fed by claude-usage --json (one result per range). Orca's "Orca
// worktrees only" scope and its share card aren't ported (D11).
//
// Orca's eight cards come first, in Orca's order: Input tokens, Output
// tokens, Cache read, Cache write, Cache reuse rate, Zero-cache-read turns,
// Sessions / Turns and Est. API-equivalent cost. Its figures map onto
// claude-usage's, which has one group of figures per cache version:
// - input, output, cache read, cache write and the reuse rate come from v4+
//   cache lines: cacheSince and totals.cacheCoverage;
// - zero-cache-read turns (v5 zero-cache responses over v5 responses) and
//   the cost (priced by claude-usage, formatted with Orca's formatCost) come
//   from v5 lines: turnFiguresSince and totals.turnFiguresCoverage;
// - sessions and turns (responses) count every line.
// A group whose data starts after the range does is labeled "since <date>"
// on each of its cards, and one that covers part of the range's tokens gets
// a note with the share. A key an older claude-usage doesn't print reads
// "n/a". By model and By project keep claude-usage's tokens (input + cache
// write + output, every line; Orca's are input + output) with Orca's
// "N sessions • N turns", and a session's model is the one with the most
// tokens (Orca's is the last turn's): D24. Recent sessions has Orca's seven
// columns. Beyond Orca: the tokens and active time cards, usage by account,
// the time to each limit, a session's account and length on hover, and
// charts for 30, 90 days and all time (weekly bars past a month; Orca draws
// the last 10 days only).
//
//   RANGES, DEFAULT_RANGE, RANGE_LABELS   the picker: Orca's 7d, 30d, 90d, all
//   pickRange(value)                      a known range, else the default
//   formatTokens(n)                       Orca's "18.5M", "1.5k", "999", plus "4.8B"
//   formatCount(n)                        "2,310"
//   formatCost(usd)                       Orca's "$0.0042", "$12.34", "n/a"
//   formatActiveTime(seconds)             "45m", "3h 5m", "42h"
//   chartBars(daily)                      the daily chart's bars
//   detailsModel({ details, range, now, execError })   the whole window

import { formatCoverage, formatDate, formatDuration, formatSince, formatUpdated } from "./format.js";

export const RANGES = Object.freeze(["7", "30", "90", "all"]);
export const DEFAULT_RANGE = "7";
// Orca's labels (ClaudeUsagePane.tsx RANGE_LABELS).
export const RANGE_LABELS = Object.freeze({ 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", all: "All time" });

// Rows a breakdown shows before "Show all" (Orca's rows.slice(0, 5)).
export const SECTION_ROWS = 5;

// A running entry older than this has lost its runner (cli/details.mjs's
// RUN_TIMEOUT_MS plus its margin): it isn't drawn as running.
const RUN_STALE_MS = 150_000;
// The chart: one bar per day up to a month, else weekly bars (two-week ones
// past a year), and at most this many day labels under the bars.
const DAILY_BARS = 31;
const MAX_WEEKS = 52;
const MAX_LABELS = 8;
// Values over the bars only while they fit (Orca shows them on its 10).
const MAX_VALUES = 14;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const text = (v) => (typeof v === "string" && v !== "" ? v : null);

export function pickRange(value) {
  return typeof value === "string" && RANGES.includes(value) ? value : DEFAULT_RANGE;
}

// Orca's formatTokens (stats/usage-formatters.ts): one decimal past a
// thousand and past a million, else the count. Rounded half up on the
// decimal value (Orca's toFixed reads 1,450,000 as "1.4M", a binary-float
// artifact), and 999,950 reads "1.0M", not "1000.0k". Past a billion it
// reads "4.8B" where Orca would print "4808.5M". Not a number: "n/a".
export function formatTokens(n) {
  if (!isNumber(n)) return "n/a";
  if (Math.abs(n) >= 999_950_000) return `${(Math.round(n / 100_000_000) / 10).toFixed(1)}B`;
  if (Math.abs(n) >= 999_950) return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  return formatCount(n);
}

// A whole count with thousands separators, as Orca's toLocaleString in
// English: "2,310". Not a number: "n/a".
export function formatCount(n) {
  if (!isNumber(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Orca's formatCost (stats/usage-formatters.ts): "$0.0042" under a cent,
// else "$12.34"; "n/a" for no figure (claude-usage's null: nothing priced).
export function formatCost(value) {
  if (!isNumber(value)) return "n/a";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

// claude-usage's active seconds: "45m" under an hour, "3h 5m" under ten,
// then whole hours ("42h": active time reads better in hours than in days).
export function formatActiveTime(seconds) {
  if (!isNumber(seconds) || seconds < 0) return "n/a";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 10) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.round(seconds / 3600)}h`;
}

// "1 turn", "2,310 turns", or "n/a turns" for a count claude-usage didn't print.
const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${formatCount(n)} ${many}`);
// Orca's usageRowCounts (UsageBreakdownSection.tsx): "14 sessions • 1,240 turns".
const counts = (sessions, turns) => `${plural(sessions, "session", "sessions")} • ${plural(turns, "turn", "turns")}`;
const share = (part, whole) => (isNumber(part) && isNumber(whole) && whole > 0 ? Math.max(0, Math.min(1, part / whole)) : 0);
// Orca's reuse rate: Math.round(rate * 100)%, or n/a.
const reuse = (rate) => (isNumber(rate) ? `${Math.round(rate * 100)}%` : "n/a");

// A session's length: "<1m", else format.js's "3h 17m".
function formatSpan(ms) {
  if (!isNumber(ms) || ms < 0) return "—";
  return ms < 60_000 ? "<1m" : formatDuration(ms);
}

// ── The chart ────────────────────────────────────────────────────────────────

// claude-usage's daily [{date, tokens}] (one per day of the range) as bars:
// { title, description, bars: [{ key, from, to, tokens, value, share,
// label, tooltip }], showValues }. One bar per day up to a month; past it,
// one bar per week (per two weeks past a year), counted back from the last
// day, so the oldest bar may hold fewer days. share is the bar's height,
// 0–1 of the tallest. label is Orca's MM-DD of the bar's first day, on at
// most MAX_LABELS bars counted back from the last (always labeled).
export function chartBars(daily) {
  const days = list(daily).filter((d) => text(d.date));
  const step = days.length <= DAILY_BARS ? 1 : 7 * Math.ceil(days.length / (7 * MAX_WEEKS));
  const buckets = [];
  for (let end = days.length; end > 0; end -= step) buckets.unshift(days.slice(Math.max(0, end - step), end));
  const sums = buckets.map((b) => b.reduce((sum, d) => sum + (isNumber(d.tokens) ? d.tokens : 0), 0));
  let top = 1;
  for (const s of sums) top = Math.max(top, s);
  const every = Math.max(1, Math.ceil(buckets.length / MAX_LABELS));
  const bars = buckets.map((b, i) => {
    const from = b[0].date;
    const to = b[b.length - 1].date;
    const tokens = sums[i];
    const when = step === 1 ? from : `${from} – ${to}`;
    return {
      key: from,
      from,
      to,
      tokens,
      value: formatTokens(tokens),
      share: tokens / top,
      label: (buckets.length - 1 - i) % every === 0 ? from.slice(5) : null,
      tooltip: `${when}: ${formatCount(tokens)} tokens`,
    };
  });
  const per = step === 1 ? "by day" : step === 7 ? "by week" : `per ${step / 7} weeks`;
  return {
    title: step === 1 ? "Daily usage" : step === 7 ? "Weekly usage" : `Usage per ${step / 7} weeks`,
    description: `Input, output and cache write tokens ${per}.`,
    bars,
    showValues: bars.length <= MAX_VALUES,
  };
}

// ── Sections ─────────────────────────────────────────────────────────────────

// Orca's UsageBreakdownSection: a title, "Top <thing>: <first row>" (or
// n/a), and rows most tokens first (claude-usage's order), each with its
// tokens, a line of counts, and its share of the range's tokens.
function breakdown(title, topLabel, rows) {
  return { title, top: `${topLabel} ${rows[0]?.label ?? "n/a"}`, rows };
}

// A session counts under the model with the most of its tokens (D24).
function byModel(result, total) {
  return breakdown("By model", "Top model:", list(result.byModel).map((r) => ({
    key: `m:${r.model}`,
    label: text(r.model) ?? "Unknown",
    value: formatTokens(r.tokens),
    sub: counts(r.sessions, r.responses),
    share: share(r.tokens, total),
    hint: null,
    gone: false,
  })));
}

// A project whose transcripts are all gone has only frozen cache lines: no
// path, and Claude's folder slug for a name. It still counts in the tokens.
const GONE_HINT = "Its transcripts are gone from disk; Claude's folder name stands in for the project.";

function byProject(result, total) {
  return breakdown("By project", "Top project:", list(result.byProject).map((r) => {
    const path = text(r.path);
    const sub = counts(r.sessions, r.responses);
    return {
      key: `p:${path ?? r.project}`,
      label: text(r.project) ?? "Unknown",
      value: formatTokens(r.tokens),
      sub: path ? sub : `${sub} • no longer on disk`,
      share: share(r.tokens, total),
      hint: path ?? GONE_HINT,
      gone: !path,
    };
  }));
}

function byAccount(result, total) {
  return breakdown("By account", "Top account:", list(result.byAccount).map((r) => ({
    key: `a:${r.account}`,
    label: text(r.account) ?? "Unknown",
    value: formatTokens(r.tokens),
    sub: isNumber(r.responses) ? plural(r.responses, "turn", "turns") : "",
    share: share(r.tokens, total),
    hint: null,
    gone: false,
  })));
}

// claude-usage's limits [{account, window, hits, avgSecondsToLimit}]: one
// row per account (in its order), a cell per window.
const LIMIT_WINDOWS = Object.freeze([
  { window: "5h", label: "5-hour limit" },
  { window: "weekly", label: "Weekly limit" },
]);

function limitText(entry) {
  const hits = isNumber(entry?.hits) ? entry.hits : 0;
  if (hits <= 0) return "Not hit";
  const avg = isNumber(entry.avgSecondsToLimit) ? formatDuration(entry.avgSecondsToLimit * 1000) : null;
  return `${plural(hits, "hit", "hits")}${avg ? ` · avg ${avg}` : ""}`;
}

function limits(result) {
  const byAccount = new Map();
  for (const l of list(result.limits)) {
    const account = text(l.account) ?? "Unknown";
    if (!byAccount.has(account)) byAccount.set(account, {});
    byAccount.get(account)[l.window] = l;
  }
  const rows = [...byAccount].map(([account, windows]) => ({
    key: account,
    account,
    cells: LIMIT_WINDOWS.map((w) => ({ window: w.window, label: w.label, text: limitText(windows[w.window]) })),
  }));
  return {
    title: "Time to limit",
    description: "How often each account hit its 5-hour and weekly limits, and how long it took to get there on average.",
    rows,
    empty: rows.length ? null : "No limits recorded in this range.",
  };
}

// Orca's UsageRecentSessionsTable with its seven columns: Last active,
// Project, Model, Turns, Input, Output, and Cache (read + write). A session
// from a line without cache figures (pre-v4) has null for those four: n/a.
// Its account and how long it ran, which Orca doesn't have, are the row's
// hint.
const RECENT_HEADINGS = Object.freeze(["Last active", "Project", "Model", "Turns", "Input", "Output", "Cache"]);

function recent(result, reuseText, since) {
  const rows = list(result.recentSessions).map((s) => ({
    key: text(s.id) ?? `${s.startedAt}`,
    cells: [
      formatDate(s.endedAt) ?? "—",
      text(s.project) ?? "Unknown",
      text(s.model) ?? "Unknown",
      formatCount(s.responses),
      formatTokens(s.input),
      formatTokens(s.output),
      isNumber(s.cacheRead) && isNumber(s.cacheWrite) ? formatTokens(s.cacheRead + s.cacheWrite) : "n/a",
    ],
    hint: `${text(s.account) ?? "Unknown"} · ${formatSpan(isNumber(s.endedAt) && isNumber(s.startedAt) ? s.endedAt - s.startedAt : null)}`,
  }));
  return {
    title: "Recent sessions",
    // Orca's "Cache reuse rate:" line, with the cache figures' "since".
    description: `Cache reuse rate: ${reuseText}${since ? ` (${since})` : ""}`,
    headings: [...RECENT_HEADINGS],
    rows,
    empty: rows.length ? null : "No sessions in this range.",
  };
}

// ── The cards ────────────────────────────────────────────────────────────────

const EXPLANATION = "Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens).";
const COST_LABEL = "Est. API-equivalent cost";

// "since Nov 3" when a group's first day (cacheSince, turnFiguresSince)
// comes after the range's, else null.
function sinceLabel(day, from, now) {
  const first = text(day);
  return first && from && first > from ? formatSince(first, now) : null;
}

// Orca's Zero-cache-read turns: zero-cache turns over turns, rounded, or n/a
// with none. Both counts are claude-usage's v5 ones (zeroCacheReadResponses
// over turnResponses), so the hint says the base.
function zeroCacheRead(totals) {
  const zero = totals.zeroCacheReadResponses;
  const turns = totals.turnResponses;
  if (!isNumber(zero) || !isNumber(turns) || turns <= 0) return { value: "n/a", hint: null };
  return {
    value: `${Math.round((zero / turns) * 100)}%`,
    hint: `${formatCount(zero)} of ${plural(turns, "turn", "turns")} read nothing from the cache.`,
  };
}

// Orca's cost card: formatCost, and unpricedCostLabel's suffix
// (stats/unpriced-cost-label.ts). "Excludes" promises a remainder, so only a
// total that exists gets it. The hint names the models left out.
function cost(totals) {
  const unpriced = (Array.isArray(totals.unpricedModels) ? totals.unpricedModels : []).map(text).filter(Boolean);
  const value = totals.estimatedCostUsd;
  return {
    label: unpriced.length && isNumber(value) ? `${COST_LABEL} • excludes unpriced models` : COST_LABEL,
    value: formatCost(value),
    hint: unpriced.length ? `Not priced: ${unpriced.join(", ")}.` : null,
  };
}

// ── The window ───────────────────────────────────────────────────────────────

function report(result, now) {
  const totals = isObject(result.totals) ? result.totals : {};
  const total = totals.tokens;
  const from = text(result.range?.from);
  const cacheSince = sinceLabel(result.cacheSince, from, now);
  const turnSince = sinceLabel(result.turnFiguresSince, from, now);
  const reuseText = reuse(totals.reuseRate);
  const zero = zeroCacheRead(totals);
  const price = cost(totals);
  return {
    // Orca's eight, in Orca's order (ClaudeUsagePane.tsx:168-237).
    cards: [
      { key: "input", label: "Input tokens", value: formatTokens(totals.input), hint: "Input tokens not read from the cache.", since: cacheSince },
      { key: "output", label: "Output tokens", value: formatTokens(totals.output), hint: null, since: cacheSince },
      { key: "cacheRead", label: "Cache read", value: formatTokens(totals.cacheRead), hint: null, since: cacheSince },
      { key: "cacheWrite", label: "Cache write", value: formatTokens(totals.cacheWrite), hint: null, since: cacheSince },
      { key: "reuse", label: "Cache reuse rate", value: reuseText, hint: null, since: cacheSince },
      { key: "zeroCacheRead", label: "Zero-cache-read turns", value: zero.value, hint: zero.hint, since: turnSince },
      { key: "sessions", label: "Sessions / Turns", value: `${formatCount(totals.sessions)} / ${formatCount(totals.responses)}`, hint: null, since: null },
      { key: "cost", label: price.label, value: price.value, hint: price.hint, since: turnSince },
    ],
    // Herdr's own: every line's tokens, as By model and By project count
    // them, and the active time.
    extras: [
      { key: "tokens", label: "Tokens", value: formatTokens(total), hint: "Input, output and cache write tokens. Cache reads aren't counted.", since: null },
      { key: "active", label: "Active time", value: formatActiveTime(totals.seconds), hint: "Time active in your own sessions; claude -p runs aren't counted.", since: null },
    ],
    coverage: [
      formatCoverage("Input, output and cache figures", totals.cacheCoverage),
      formatCoverage("Zero-cache-read turns and cost", totals.turnFiguresCoverage),
    ].filter(Boolean),
    explanation: EXPLANATION,
    daily: chartBars(result.daily),
    byModel: byModel(result, total),
    byProject: byProject(result, total),
    byAccount: byAccount(result, total),
    limits: limits(result),
    recent: recent(result, reuseText, cacheSince),
  };
}

// The whole window for one range:
//   { range, ranges: [{ key, label, selected }], running, status, error,
//     notice, report }
// - running   a runner owns the range now (the refresh spinner).
// - status    "Updated Xm ago" from the result's own generatedAt (else the
//             run's end), so a result kept while a run goes, or after one
//             fails, says how old it is; "Not yet updated" with none.
// - error     Orca's "Last scan error: …" for the last run's failure, or for
//             execError (the CLI couldn't start a run), else null.
// - notice    the body's one line instead of a report: "Loading usage…"
//             while the first run goes, "No usage read for this range yet."
//             when none has, or Orca's empty message for a range with no
//             tokens; null when there's a report.
// - report    { cards, extras, coverage, explanation, daily, byModel,
//             byProject, byAccount, limits, recent }, or null. cards are
//             Orca's eight and extras Herdr's two, each { key, label,
//             value, hint, since }; coverage holds the notes of the groups
//             that cover part of the range.
export function detailsModel({ details, range, now = Date.now(), execError = null } = {}) {
  const key = pickRange(range);
  const entry = isObject(details?.ranges?.[key]) ? details.ranges[key] : {};
  const result = isObject(entry.result) ? entry.result : null;
  const running = entry.running === true && isNumber(entry.startedAt) && now - entry.startedAt < RUN_STALE_MS;
  const at = result ? (isNumber(result.generatedAt) ? result.generatedAt : entry.finishedAt) : null;
  const failure = text(execError) ?? text(entry.error);
  const hasData = Boolean(result) && isNumber(result.totals?.tokens) && result.totals.tokens > 0;
  let notice = null;
  if (!result) notice = running ? "Loading usage…" : "No usage read for this range yet.";
  else if (!hasData) notice = "No local Claude usage found yet for this range.";
  return {
    range: key,
    ranges: RANGES.map((r) => ({ key: r, label: RANGE_LABELS[r], selected: r === key })),
    running,
    status: formatUpdated(at, now),
    error: failure ? `Last scan error: ${failure}` : null,
    notice,
    report: hasData ? report(result, now) : null,
  };
}
