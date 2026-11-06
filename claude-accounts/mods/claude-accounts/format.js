// How the views say things (D4, D5, D10, D11). Pure: no herdr or gpui-kit
// import, so `node --test` loads it. Final and frozen (T11): a later task
// puts its own helpers in its own *-model.js (D1).
//
// The copy is Orca's, word for word, from its sources
// (~/Desktop/Software/Sideprojects/orca/src, cited per function). Times are
// epoch ms; `now` defaults to Date.now(). No Intl: dates are built from the
// Date's local fields, so they read the same in Node and in Herdr's runtime.
//
//   formatPercent(p)                 "41%"
//   formatDuration(ms)               "47m", "3h 2m", "4d 6h", "now"
//   formatResetsIn(resetsAt, now)    "Resets in 3h 2m", "Resets now"
//   formatDate(ms)                   "Nov 2, 5:25 PM"
//   formatUpdated(at, now)           "Updated 3m ago", or "Not yet updated"
//   colorToken(percent)              the theme token (D5): under 60 "muted",
//                                    60–79 "working", 80 or more "blocked"
//   errorCopy(kind, detail, opts)    { label, message } for each of D9's
//                                    error values and for "needsSignIn"
//                                    (D4's table)
//   densityLevel(width, needs)       the footer's level for its width (D10):
//                                    "full", "compact" or "icon"
//   formatSince(date, now)           "since Nov 3", for cache figures that
//                                    start after the range does (D11)
//   formatCoverage(coverage)         the note for cache figures that cover
//                                    only part of the range's tokens (D11)

const MINUTE = 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// Orca's clampUsedPercent (shared/usage-percentage-display.ts): clamped to
// 0–100 and rounded; anything but a finite number is 0.
function clampPercent(p) {
  if (!isNumber(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

// "41%": Orca's bare percentage (status-bar/usage-percentage-label.ts,
// formatBareUsagePercentage, "used" display). The panel's "41% used" adds
// its own word. A missing window is the caller's to skip: null reads 0%.
export function formatPercent(p) {
  return `${clampPercent(p)}%`;
}

// Orca's formatResetDuration (shared/rate-limit-reset-format.ts): floored to
// whole units, the two largest: "47m", "3h 54m", "3h", "6d 7h", "6d"; "now"
// at or past zero. null for anything but a finite number.
export function formatDuration(ms) {
  if (!isNumber(ms)) return null;
  if (ms <= 0) return "now";
  const totalMins = Math.floor(ms / MINUTE);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Orca's formatResetCountdown (shared/rate-limit-reset-format.ts): "Resets in
// 3h 54m", or "Resets now" once it has passed. null when the window has no
// reset time (Orca shows no "Resets in" then).
export function formatResetsIn(resetsAt, now = Date.now()) {
  if (!isNumber(resetsAt)) return null;
  const duration = formatDuration(resetsAt - now);
  return duration === "now" ? "Resets now" : `Resets in ${duration}`;
}

// Orca's formatAccountTimestamp (settings/accounts/scope/accounts-pane-runtime.ts):
// toLocaleString(en, {month: "short", day: "numeric", hour: "numeric",
// minute: "2-digit"}) in local time, "Nov 2, 5:25 PM", with a plain space
// before AM/PM as S2's screenshot reads. null for anything but a finite number.
export function formatDate(ms) {
  if (!isNumber(ms)) return null;
  const d = new Date(ms);
  const hours = d.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hour12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

// Orca's "Updated {{time}}" with formatTimeAgo, or "Not yet updated"
// (status-bar/tooltip.tsx:37-51,311-315): "just now" under a minute (a time
// ahead of now too), then whole minutes, then whole hours ("Updated 26h ago":
// Orca has no days here). No time, or 0, is "Not yet updated", as Orca's
// falsy check reads it.
export function formatUpdated(at, now = Date.now()) {
  if (!isNumber(at) || at === 0) return "Not yet updated";
  const diff = now - at;
  if (diff < MINUTE) return "Updated just now";
  const mins = Math.floor(diff / MINUTE);
  if (mins < 60) return `Updated ${mins}m ago`;
  return `Updated ${Math.floor(mins / 60)}h ago`;
}

// D5: the theme token for a used percentage, on Orca's cutoffs
// (status-bar/provider-extra-usage-section.tsx:9-19, barColor): under 60
// "muted", 60–79 "working" (amber), 80 or more "blocked" (red). The percent
// is clamped and rounded first, so the color matches the number shown.
export function colorToken(percent) {
  const p = clampPercent(percent);
  if (p < 60) return "muted";
  if (p < 80) return "working";
  return "blocked";
}

// ── Errors (D4) ────────────────────────────────────────────────────────────
// Orca's labels and messages for Claude (status-bar/usage-error-copy.ts,
// line numbers in D4's table), with "Settings > AI Provider Accounts" said
// as "Manage Accounts…". A null message means the raw error (`detail`).

const REFRESH_FAILED = "Refresh failed";
const ERRORS = Object.freeze({
  expired: { label: "Updates when Claude runs", message: "Claude usage updates the next time Claude runs." },
  // main/rate-limits/claude-oauth-usage-error.ts:36-37, shown as p.error.
  rateLimited: { label: "Limited", message: "Claude usage is rate limited right now." },
  keychain: { label: "Sign-in unavailable", message: "Claude sign-in credentials could not be read." },
  network: { label: "Network issue", message: "Claude usage could not be refreshed because the network request failed." },
  refreshFailed: { label: REFRESH_FAILED, message: null },
  noSubscription: { label: "No subscription", message: null },
  unavailable: { label: "Usage unavailable", message: "Claude usage is unavailable right now." },
  needsSignIn: {
    label: "Sign in again",
    message: "The selected Claude account needs you to sign in again. Open Manage Accounts…, or choose another account.",
  },
});

// Orca's message when there's no error text at all (usage-error-copy.ts:168-174).
const NO_DETAIL = "Unable to fetch usage";
// usage-error-copy.ts:270-277, with {{value0}} = "Claude".
const AUTH_SOFTENED = "Claude usage could not be refreshed. Agent sessions may still be signed in.";
// The label over cached data after a failed refresh (status-bar/tooltip.tsx:126-133).
const STALE_REFRESH_FAILED = "Refresh failed — showing cached data";

// Orca's USAGE_AUTH_ERROR_PATTERNS (usage-error-copy.ts:53-71): an error that
// reads as a lapsed sign-in gets the softened message instead of its text.
const USAGE_AUTH_ERROR_PATTERNS = [
  /\binvalid (?:authentication )?credentials?\b/i,
  /\b(?:no|missing|invalid|expired|stale|unavailable) (?:oauth )?(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) (?:is |are |was |were |could not be |cannot be |can't be )?(?:missing|unavailable|invalid|expired|stale|used|refreshed|loaded|found)\b/i,
  /\bcredentials?[ -]file (?:is |was )?(?:missing|unavailable|invalid|expired|stale)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) not (?:found|available)\b/i,
  /\b(?:token data|tokens?) (?:is |are )?not available\b/i,
  /\bauth (?:is missing|tokens are missing|does not expose)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\bauthentication required\b/i,
  /\bplease reauthenticate\b/i,
  /\bsign in\b/i,
  /\blogged in to another account\b/i,
  /\bnot logged in\b/i,
  /\blog[ -]?in\b/i,
  /\blog(?:ged)? out\b/i,
];

const isUsageAuthError = (message) => USAGE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));

// { label, message } for one account's error (D9's `error`), or for
// "needsSignIn" (its needsSignIn flag); null when there's no error.
//   kind    one of D9's values, or "needsSignIn". Any other value reads as
//           "unavailable", as D9 tells readers to.
//   detail  the raw error text, used only where Orca shows it: refreshFailed
//           (softened when it reads as an auth error), noSubscription (the
//           server's text) and unavailable (Orca's missing-scope message).
//           Without it, those say Orca's "Unable to fetch usage", except
//           unavailable, which keeps its own message.
//   opts.stale  true when cached numbers are still shown: "Refresh failed"
//           becomes Orca's "Refresh failed — showing cached data".
export function errorCopy(kind, detail, opts = {}) {
  if (kind === null || kind === undefined || kind === "") return null;
  const known = typeof kind === "string" && Object.hasOwn(ERRORS, kind);
  const key = known ? kind : "unavailable";
  const text = known && typeof detail === "string" && detail.trim() ? detail.trim() : null;
  let { label, message } = ERRORS[key];
  if (key === "refreshFailed") message = text ? (isUsageAuthError(text) ? AUTH_SOFTENED : text) : NO_DETAIL;
  else if (key === "noSubscription") message = text ?? NO_DETAIL;
  else if (key === "unavailable" && text) message = text;
  if (opts?.stale === true && label === REFRESH_FAILED) label = STALE_REFRESH_FAILED;
  return { label, message };
}

// ── Footer density (D10) ───────────────────────────────────────────────────
// Orca's status bar picks the roomiest density level that fits, within 1px
// (status-bar/status-bar-density.ts, pickStatusBarDensityLevel), and starts
// at the roomiest until it is measured. The footer follows three of its
// steps: "full" (bars and labels), "compact" (one number per window: no bars,
// no secondary labels), "icon" (the icon only).
//   width  the footer's width in logical px (on_size_change); unmeasured
//          (not a number) is "full", as Orca starts.
//   needs  the width each level needs, { full, compact }; the defaults fit
//          S1's footer at text size 12. A caller that knows its own text can
//          pass its own.

const WIDTH_TOLERANCE_PX = 1;
const DENSITY_NEEDS = Object.freeze({ full: 330, compact: 140 });

export function densityLevel(width, needs = DENSITY_NEEDS) {
  if (!isNumber(width)) return "full";
  const full = isNumber(needs?.full) ? needs.full : DENSITY_NEEDS.full;
  const compact = isNumber(needs?.compact) ? needs.compact : DENSITY_NEEDS.compact;
  if (full <= width + WIDTH_TOLERANCE_PX) return "full";
  if (compact <= width + WIDTH_TOLERANCE_PX) return "compact";
  return "icon";
}

// ── Cache figures (D11) ────────────────────────────────────────────────────

// "since Nov 3": the label of cache figures whose data starts after the
// range does (claude-usage's cacheSince, a Bogota YYYY-MM-DD day). The year
// is added when it isn't now's: "since Dec 28, 2025". null for anything but
// a real day.
export function formatSince(date, now = Date.now()) {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const sameYear = isNumber(now) && new Date(now).getFullYear() === year;
  return `since ${MONTHS[month - 1]} ${day}${sameYear ? "" : `, ${year}`}`;
}

// The note under cache figures that cover only part of the range's tokens
// (claude-usage's totals.cacheCoverage, 0–1): those figures come from
// sessions still on disk, as Orca's do, and the note says what share of the
// range that is. null when they cover it all (1), or the range has no
// tokens (null). The share never reads 100% while below 1, nor 0% above 0.
export function formatCoverage(coverage) {
  if (!isNumber(coverage) || coverage >= 1) return null;
  const c = Math.max(0, coverage);
  const pct = Math.round(c * 100);
  const share = c > 0 && pct === 0 ? "<1" : String(Math.min(99, pct));
  return `Cache figures cover only sessions still on disk: ${share}% of this range's tokens.`;
}
