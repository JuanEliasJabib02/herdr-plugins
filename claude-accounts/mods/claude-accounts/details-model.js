// What the Usage details & history window draws (S7, D11), from details.json
// (store.readDetails) and the range picked. Pure: no herdr or gpui-kit
// import, so `node --test` loads it. Owner: T10.
//
// The window is Orca's Claude usage pane (renderer/src/components/stats/
// ClaudeUsagePane.tsx and ClaudeUsageDetails.tsx, under
// ~/Desktop/Software/Sideprojects/orca/src), with Orca's copy where Orca has
// it, fed by claude-usage --json (one result per range). Orca's "Orca
// worktrees only" scope and its share card aren't ported (D11). Its figures
// map onto claude-usage's: tokens are input + cache write + output (cache
// reads aren't counted), turns are responses, and the cache figures (input,
// cache read, cache write, the reuse rate) cover only the v4 cache lines:
// labeled "since <date>" when they start after the range does, with a note
// of the share of the range's tokens they cover (format.js). Beyond Orca:
// usage by account, the time to each limit, active time, the session's
// account and duration, and charts for 30, 90 days and all time (weekly bars
// past a month; Orca draws the last 10 days only).
//
//   RANGES, DEFAULT_RANGE, RANGE_LABELS   the picker: Orca's 7d, 30d, 90d, all
//   pickRange(value)                      a known range, else the default
//   formatTokens(n)                       Orca's "18.5M", "1.5k", "999", plus "4.8B"
//   formatCount(n)                        "2,310"
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

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${formatCount(n)} ${many}`);
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

function byModel(result, total) {
  return breakdown("By model", "Top model:", list(result.byModel).map((r) => ({
    key: `m:${r.model}`,
    label: text(r.model) ?? "Unknown",
    value: formatTokens(r.tokens),
    sub: isNumber(r.responses) ? plural(r.responses, "turn", "turns") : "",
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
    const sessions = isNumber(r.sessions) ? plural(r.sessions, "session", "sessions") : "";
    return {
      key: `p:${path ?? r.project}`,
      label: text(r.project) ?? "Unknown",
      value: formatTokens(r.tokens),
      sub: path ? sessions : [sessions, "no longer on disk"].filter(Boolean).join(" • "),
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

// Orca's UsageRecentSessionsTable, with claude-usage's columns: no turns,
// input or output per session, but its account and how long it ran.
function recent(result, reuseText, since) {
  const rows = list(result.recentSessions).map((s) => ({
    key: text(s.id) ?? `${s.startedAt}`,
    cells: [
      formatDate(s.endedAt) ?? "—",
      text(s.project) ?? "Unknown",
      text(s.model) ?? "Unknown",
      text(s.account) ?? "Unknown",
      formatSpan(isNumber(s.endedAt) && isNumber(s.startedAt) ? s.endedAt - s.startedAt : null),
      formatTokens(s.tokens),
    ],
  }));
  return {
    title: "Recent sessions",
    // Orca's "Cache reuse rate:" line, with the cache figures' "since".
    description: `Cache reuse rate: ${reuseText}${since ? ` (${since})` : ""}`,
    headings: ["Last active", "Project", "Model", "Account", "Duration", "Tokens"],
    rows,
    empty: rows.length ? null : "No sessions in this range.",
  };
}

// ── The window ───────────────────────────────────────────────────────────────

const EXPLANATION = "Cache reuse rate is calculated as cache read tokens / (input tokens + cache read tokens).";

function report(result, now) {
  const totals = isObject(result.totals) ? result.totals : {};
  const total = totals.tokens;
  let sessions = 0;
  for (const p of list(result.byProject)) if (isNumber(p.sessions)) sessions += p.sessions;
  const from = text(result.range?.from);
  const cacheSince = text(result.cacheSince);
  const since = cacheSince && from && cacheSince > from ? formatSince(cacheSince, now) : null;
  const reuseText = reuse(totals.reuseRate);
  return {
    cards: [
      { key: "tokens", label: "Tokens", value: formatTokens(total), hint: "Input, output and cache write tokens. Cache reads aren't counted." },
      { key: "sessions", label: "Sessions / Turns", value: `${formatCount(sessions)} / ${formatCount(totals.responses)}`, hint: null },
      { key: "active", label: "Active time", value: formatActiveTime(totals.seconds), hint: "Time active in your own sessions; claude -p runs aren't counted." },
    ],
    cache: {
      title: "Cache",
      since,
      coverage: formatCoverage(totals.cacheCoverage),
      explanation: EXPLANATION,
      cards: [
        { key: "input", label: "Input tokens", value: formatTokens(totals.input), hint: "Input tokens not read from the cache." },
        { key: "cacheRead", label: "Cache read", value: formatTokens(totals.cacheRead), hint: null },
        { key: "cacheWrite", label: "Cache write", value: formatTokens(totals.cacheWrite), hint: null },
        { key: "reuse", label: "Cache reuse rate", value: reuseText, hint: null },
      ],
    },
    daily: chartBars(result.daily),
    byModel: byModel(result, total),
    byProject: byProject(result, total),
    byAccount: byAccount(result, total),
    limits: limits(result),
    recent: recent(result, reuseText, since),
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
// - report    { cards, cache, daily, byModel, byProject, byAccount, limits,
//             recent }, or null.
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
