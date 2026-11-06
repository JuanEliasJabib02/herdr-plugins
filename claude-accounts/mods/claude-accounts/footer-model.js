// What the footer, the popover and the Claude panel draw (S1, S6), from
// accounts.v1.json as store.readAccounts reads it. Pure: no herdr or
// gpui-kit import, so `node --test` loads it. Owner: T6.
//
// The views are Orca's (~/Desktop/Software/Sideprojects/orca/src/renderer/
// src/components/status-bar/), with Orca's copy word for word:
//   footer   StatusBarSurface.tsx's usage button and refresh, with
//            ProviderSegment (StatusBarProviderSegment.tsx), the "Used" unit
//            label (usage-unit-label.tsx) and the signed-out action
//            (InlineProviderUsage.tsx InlineUsageSignInAction)
//   popover  UsageRosterPanel.tsx: Usage, all agents, refresh, Detailed |
//            Compact, the Claude row (UsageRow), Usage details & history,
//            Manage Accounts…
//   panel    ClaudeSwitcherForOwner.tsx: ProviderIdentityCard (Claude,
//            Updated Xm ago, the account's card from tooltip.tsx
//            ProviderPanel and provider-extra-usage-section.tsx), then the
//            Claude Account list (AccountSwitchRowItem with InlineUsageBars)
// D5's colors are theme token names ("muted", "working", "blocked"; a
// percentage's text under 60 is "foreground", as Orca's usageTextColorClass).
//
//   UI_KEY, SEEN_KEY, MODES             the shared keys, and Detailed | Compact
//   usageMode(ui), withUsageMode(ui, m) the footer's mode (D12)
//   activeAccount(doc)                  the active account, else System default
//   windowSections(account)             its windows, in Orca's order
//   tightestSection(account)            the most used one
//   footerModel({ doc, mode, width, now })   the footer at its density level
//   popupModel({ doc, mode, now })           the popover
//   panelModel({ doc, now, busy })           the Claude panel
//   POPUP, PANEL, popupHeight(m), panelHeight(m)   their sizes
//   zoomOf(settings), footerBounds(viewport, size), anchorFrom(bounds, zoom),
//   rememberAnchor(a), lastAnchor()     where the footer is, in window px
//   overlayAt(anchor, size, zoom)       where an overlay opens over the footer
//   popupSpec({…}), panelSpec({…})      openOverlay's argument for each
//   withClosedAt(ui, now), closedJustNow(ui, now)   a press that closes an
//                                       overlay doesn't open it again
//   reactState({…})                     what a re-read hands toasts.react
//   applyReact(react, state, seen)      toasts.react, as the footer applies it
//   signInTab(cli, id), useFailure(result), pickNotify(n), formatMoney(n),
//   lastLine(text), and the CLI's argv

import { formatPercent, formatDuration, formatResetsIn, formatUpdated, colorToken, errorCopy, densityLevel } from "./format.js";
import { MOD, readRestart, readPendingSwitch, readLoginLink } from "./store.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const sum = (list) => list.reduce((a, b) => a + b, 0);

// ── Shared keys and the mode ───────────────────────────────────────────────

// { usageMode: "verbose" | "compact" }: Orca's statusBarUsageMode, shared
// because localStorage is per mod copy (D12).
export const UI_KEY = "claude-accounts.ui";
// What toasts.react already showed (D1), kept on the mod's side.
export const SEEN_KEY = "claude-accounts.seen";

// Orca's segmented control (UsageRosterPanel.tsx), its labels and tooltips.
export const MODES = Object.freeze([
  Object.freeze({ value: "verbose", label: "Detailed", tooltip: "Full usage with bars, labels, and percentages" }),
  Object.freeze({ value: "compact", label: "Compact", tooltip: "Condensed usage: one summary per provider" }),
]);

// Detailed unless the shared value says Compact; Juan's Orca value is
// Detailed (D12).
export function usageMode(ui) {
  return isObject(ui) && ui.usageMode === "compact" ? "compact" : "verbose";
}

export function withUsageMode(ui, mode) {
  return { ...(isObject(ui) ? ui : {}), usageMode: mode === "compact" ? "compact" : "verbose" };
}

// ── The CLI ────────────────────────────────────────────────────────────────

// What the timer and a merge batch run: due reads only (D4's cadence).
export const MERGE_ARGS = Object.freeze(["usage", "--json"]);
// Every refresh button and the refresh command.
export const REFRESH_ARGS = Object.freeze(["usage", "--refresh", "--json"]);
export const useArgs = (id) => ["use", id, "--json"];
// A Herdr tab runs it: claude auth login in that tab (D3). The tab's name is
// the accounts view's.
export const signInArgs = (id) => ["login", id];
export const signInTab = (cli, id) => ({ name: "Claude sign-in", argv: [cli, ...signInArgs(id)] });

// The last non-empty line of a command's stderr: what the CLI says on failure.
export function lastLine(text) {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
}

// A `use` that failed, in one line, or null when it worked: Orca's refusal
// comes back on stderr (exit 5, the account needs a sign-in). `result` is
// exec's { code, stdout, stderr }, or the error exec rejected with.
export function useFailure(result) {
  if (result instanceof Error) return result.message || String(result);
  if (result?.code === 0) return null;
  return lastLine(result?.stderr) || `claude-accounts use exited ${result?.code}`;
}

// ── Accounts and windows ───────────────────────────────────────────────────

// Orca's getWindowSections order (tooltip.tsx), with the panel's titles and
// the popover's short labels (formatWindowLabel: 300 min "5h", 10080 "wk",
// 43200 "30d"; Fable by name).
const WINDOWS = Object.freeze([
  Object.freeze({ key: "session", title: "Session", short: "5h" }),
  Object.freeze({ key: "weekly", title: "Weekly", short: "wk" }),
  Object.freeze({ key: "fable", title: "Fable", short: "Fable" }),
  Object.freeze({ key: "monthly", title: "Monthly", short: "30d" }),
]);

const LOADING = "Loading usage…";
const NO_DATA = "No usage data";
const SYSTEM_DEFAULT = "System default";

export function activeAccount(doc) {
  const accounts = Array.isArray(doc?.accounts) ? doc.accounts : [];
  return accounts.find((a) => a.id === doc.active) ?? accounts.find((a) => a.isDefault) ?? null;
}

// The account's windows that are there: { key, title, short, percent,
// resetsAt }.
export function windowSections(account) {
  const usage = isObject(account?.usage) ? account.usage : {};
  return WINDOWS.filter((w) => isObject(usage[w.key]) && isNumber(usage[w.key].percent)).map((w) => ({
    ...w,
    percent: usage[w.key].percent,
    resetsAt: isNumber(usage[w.key].resetsAt) ? usage[w.key].resetsAt : null,
  }));
}

// The most used window; a tie keeps the first (Orca's getTightestUsageSection).
export function tightestSection(account) {
  const list = windowSections(account);
  return list.length ? list.reduce((cur, s) => (s.percent > cur.percent ? s : cur)) : null;
}

// Orca's formatRateLimitWindowChipLabel: the time to the reset, else the
// window's length; Fable by name (shortLabel).
function chipLabel(s, now) {
  if (s.key === "fable") return s.short;
  return s.resetsAt === null ? s.short : formatDuration(s.resetsAt - now);
}

// The footer's and the account rows' windows: monthly only when there's no
// session and no weekly (status-bar-usage-sections.ts, InlineUsageBars).
function inlineSections(list) {
  const hasPlan = list.some((s) => s.key === "session" || s.key === "weekly");
  return list.filter((s) => s.key !== "monthly" || !hasPlan);
}

// A percentage's text: Orca's usageTextColorClass, neutral under 60.
function textColor(p) {
  const token = colorToken(p);
  return token === "muted" ? "foreground" : token;
}

function accountLabel(a) {
  return a.isDefault ? SYSTEM_DEFAULT : (a.email ?? a.label ?? a.id);
}

// ── The footer ─────────────────────────────────────────────────────────────
// footerModel → { kind, level, unit, bar, sections, label, warning, signIn,
//   refresh, tooltip, needs }
//   kind     "usage", "signIn" (no numbers, the login lapsed), "error" (no
//            numbers, the last read failed), "loading", "empty"
//   level    format.densityLevel for `width` and the widths this content
//            needs (`needs`, { full, compact }): "full" (bars and labels),
//            "compact" (one number per window), "icon" (the icon alone)
//   unit     "Used", or null; bar { fill, color }: the tightest window
//            (Detailed, full only); sections [{ key, text, color }]
//   label    { text, color }: "···", an error's label, "Sign in to see usage"
//   warning  Orca's ⚠: the numbers are stale, or the error isn't the calm one
//   signIn   { id, text: "Sign in" }: the account to sign in
//   tooltip  what the level hides, and why numbers are stale

// Orca's calm state ("Updates when Claude runs") stays calm while the kept
// numbers are this recent (StatusBarProviderSegment.tsx).
const CALM_STALE_MAX_AGE = 30 * 60_000;
const SIGN_IN_REASON = "Sign in to see usage";
const SIGN_IN = "Sign in";
const ELLIPSIS = "···";

// The footer's sizes in px, for the width each level needs (text_size 11.8).
export const FOOTER = Object.freeze({ pad: 10, gap: 6, sectionGap: 5, char: 6.4, icon: 13, bar: 48, warning: 12, refresh: 19, button: 26 });

// The note over stale numbers, or for numbers that can't come: the panel's
// card says the same (Orca's ErrorMessage, stale when numbers are shown).
function notice(account, hasData) {
  if (account.needsSignIn) return errorCopy("needsSignIn");
  if (account.error) {
    if (!hasData || account.error === "expired") return errorCopy(account.error, account.errorDetail);
    return { label: errorCopy("refreshFailed", null, { stale: true }).label, message: errorCopy(account.error, account.errorDetail).message };
  }
  if (hasData) return null;
  return { label: null, message: account.usageUpdatedAt === null ? LOADING : NO_DATA };
}

const noteText = (n) => (n ? [n.label, n.message].filter(Boolean).join(": ") : null);

// What the footer says, whatever its width.
function footerContent(account, mode, now) {
  if (!account) return { kind: "loading" };
  const list = windowSections(account);
  if (list.length === 0) {
    if (account.needsSignIn) return { kind: "signIn", id: account.id };
    if (account.error) return { kind: "error", copy: errorCopy(account.error, account.errorDetail), calm: account.error === "expired" };
    return { kind: account.usageUpdatedAt === null ? "loading" : "empty" };
  }
  const tight = tightestSection(account);
  const shown = mode === "compact" ? [tight] : inlineSections(list);
  const updated = account.usageUpdatedAt;
  const calm = account.error === "expired" && !account.needsSignIn && isNumber(updated) && now - updated <= CALM_STALE_MAX_AGE;
  return {
    kind: "usage",
    bar: mode === "compact" ? null : { fill: tight.percent, color: colorToken(tight.percent) },
    sections: shown.map((s) => ({ key: s.key, percent: formatPercent(s.percent), label: chipLabel(s, now), color: colorToken(s.percent) })),
    warning: Boolean(account.error || account.needsSignIn) && !calm,
    note: noteText(notice(account, true)),
  };
}

// The content at one density level.
function footerShape(c, level) {
  const full = level === "full";
  const icon = level === "icon";
  const s = { kind: c.kind, level, unit: null, bar: null, sections: [], label: null, warning: false, signIn: null, refresh: !icon && c.kind !== "signIn", tooltip: null };
  if (c.kind === "usage") {
    const fullText = c.sections.map((x) => `${x.percent} ${x.label}`).join(" · ");
    s.unit = icon ? null : "Used";
    s.bar = full ? c.bar : null;
    s.sections = icon ? [] : c.sections.map((x) => ({ key: x.key, text: full ? `${x.percent} ${x.label}` : x.percent, color: x.color }));
    s.warning = !icon && c.warning;
    s.tooltip = [full ? null : fullText, c.note].filter(Boolean).join("\n") || null;
  } else if (c.kind === "signIn") {
    s.label = full ? { text: SIGN_IN_REASON, color: "muted" } : null;
    s.signIn = icon ? null : { id: c.id, text: SIGN_IN };
    s.tooltip = full ? null : SIGN_IN_REASON;
  } else if (c.kind === "error") {
    s.label = full ? { text: c.copy.label, color: "muted" } : null;
    s.warning = !icon && !c.calm;
    s.tooltip = c.copy.message;
  } else if (c.kind === "loading") {
    s.label = icon ? null : { text: ELLIPSIS, color: "muted" };
    s.tooltip = LOADING;
  } else {
    s.tooltip = NO_DATA;
  }
  return s;
}

const textWidth = (text) => Math.ceil(String(text).length * FOOTER.char);

// The width a shape takes: its parts, the gaps between them, the padding.
function shapeWidth(s) {
  const parts = [];
  if (s.unit) parts.push(textWidth(s.unit));
  parts.push(FOOTER.icon);
  if (s.bar) parts.push(FOOTER.bar);
  if (s.sections.length) {
    parts.push(sum(s.sections.map((x) => textWidth(x.text))) + (s.sections.length - 1) * (textWidth("·") + 2 * FOOTER.sectionGap));
  }
  if (s.label) parts.push(textWidth(s.label.text));
  if (s.warning) parts.push(FOOTER.warning);
  if (s.signIn) parts.push(textWidth(s.signIn.text) + FOOTER.button);
  if (s.refresh) parts.push(FOOTER.refresh);
  return 2 * FOOTER.pad + sum(parts) + FOOTER.gap * (parts.length - 1);
}

export function footerModel({ doc, mode = "verbose", width, now = Date.now() } = {}) {
  const content = footerContent(activeAccount(doc), mode === "compact" ? "compact" : "verbose", now);
  const needs = { full: shapeWidth(footerShape(content, "full")), compact: shapeWidth(footerShape(content, "compact")) };
  return { ...footerShape(content, densityLevel(width, needs)), needs };
}

// ── The popover ────────────────────────────────────────────────────────────
// popupModel → { title, scope, refreshTip, modes, row, links }
//   modes  [{ value, label, tooltip, selected }]
//   row    the Claude row (UsageRow): { name, kind, status, signIn, reset,
//          headline, metrics, lines }. With numbers: Detailed has "Resets in
//          …" (the soonest) and a metric per window { key, label, text, fill,
//          bar, color }; Compact has the tightest window as its headline
//          { label, text, color }. Without: kind and status are Orca's row
//          state (usage-roster-row-state.ts), signIn the account to sign in.
//          lines: how many lines the Detailed metrics take (four windows
//          wrap at this width), in both modes, for the height.

export const REFRESH_TIP = "Refresh rate limits";
const LINKS = Object.freeze([
  Object.freeze({ id: "details", label: "Usage details & history" }),
  Object.freeze({ id: "accounts", label: "Manage Accounts…" }),
]);

function rowState(account) {
  if (!account) return { kind: "loading", status: LOADING, signIn: null };
  if (account.needsSignIn) return { kind: "signIn", status: "not signed in", signIn: account.id };
  if (account.error) return { kind: "error", status: errorCopy(account.error, account.errorDetail).label, signIn: null };
  if (account.usageUpdatedAt === null) return { kind: "loading", status: LOADING, signIn: null };
  return { kind: "empty", status: NO_DATA, signIn: null };
}

function soonestReset(list, now) {
  const resets = list.map((s) => s.resetsAt).filter(isNumber);
  return resets.length ? formatResetsIn(Math.min(...resets), now) : null;
}

function usageRow(account, mode, now) {
  const list = account ? windowSections(account) : [];
  const row = { name: "Claude", kind: "usage", status: null, signIn: null, reset: null, headline: null, metrics: [], lines: list.length > 3 ? 2 : 1 };
  if (list.length === 0) return { ...row, ...rowState(account) };
  if (mode === "compact") {
    const t = tightestSection(account);
    return { ...row, headline: { label: chipLabel(t, now), text: formatPercent(t.percent), color: textColor(t.percent) } };
  }
  return {
    ...row,
    reset: soonestReset(list, now),
    metrics: list.map((s) => ({ key: s.key, label: s.short, text: formatPercent(s.percent), fill: s.percent, bar: colorToken(s.percent), color: textColor(s.percent) })),
  };
}

export function popupModel({ doc, mode = "verbose", now = Date.now() } = {}) {
  const m = mode === "compact" ? "compact" : "verbose";
  return {
    title: "Usage",
    scope: "all agents",
    refreshTip: REFRESH_TIP,
    modes: MODES.map((x) => ({ ...x, selected: x.value === m })),
    row: usageRow(activeAccount(doc), m, now),
    links: LINKS,
  };
}

// ── The Claude panel ───────────────────────────────────────────────────────
// panelModel → { title, updated, refreshTip, card, heading, rows, empty, error, manage }
//   card   the active account's: { label, windows, credits, notice }, null
//          with no accounts. windows [{ key, title, used, resets, fill,
//          color }]; credits { title, text } or null; notice { label,
//          message } or null: the refresh-failed marker over kept numbers,
//          or why there are none.
//   rows   System default, then each account, in the file's order: { id,
//          label, active, hint, signIn, bars, status, disabled }. An account
//          whose login lapsed has Orca's hint and signs in when picked; one
//          whose folder holds someone else's login (signedInAs, D17) does too,
//          and its hint names that login. An inactive one has its bars
//          [{ key, text, fill, color }] or its error's label. busy (a switch
//          running) disables every row.
//   empty  "No other accounts" when there's no saved account.
//   error  why the last switch failed (useFailure), or null. Its line scrolls
//          with the list, so it adds no height.

const SIGN_IN_HINT = "Sign in again to use this account";
const nowSignedInAs = (login) => `Now signed in as ${login}`;

// USD as Orca's formatCurrencyAmount writes it in en-US ("$1,234.50"),
// without Intl, as format.js does.
export function formatMoney(n) {
  if (!isNumber(n)) return null;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}

// Orca's "Usage credits" section, uncapped (the contract has no spend): the
// balance, else the limit. A zero limit with no balance is extra usage
// turned off, so it says nothing.
function creditsLine(c) {
  if (!isObject(c)) return null;
  if (isNumber(c.balance)) return { title: "Usage credits", text: `${formatMoney(c.balance)} available` };
  if (isNumber(c.limit) && c.limit > 0) return { title: "Usage credits", text: `Limit ${formatMoney(c.limit)}` };
  return null;
}

function card(account, now) {
  const list = windowSections(account);
  return {
    label: accountLabel(account),
    windows: list.map((s) => ({
      key: s.key,
      title: s.title,
      used: `${formatPercent(s.percent)} used`,
      resets: formatResetsIn(s.resetsAt, now),
      fill: s.percent,
      color: colorToken(s.percent),
    })),
    credits: creditsLine(account.credits),
    notice: notice(account, list.length > 0),
  };
}

// Orca's InlineUsageBars: the session counts down, weekly is "wk".
function inlineBars(account, now) {
  return inlineSections(windowSections(account)).map((s) => {
    const label = s.key === "session" || s.key === "monthly" ? chipLabel(s, now) : s.short;
    return { key: s.key, text: `${formatPercent(s.percent)} used ${label}`, fill: s.percent, color: colorToken(s.percent) };
  });
}

function accountRow(a, active, now, busy) {
  const signIn = a.needsSignIn ? a.id : null;
  const bars = active || signIn ? [] : inlineBars(a, now);
  return {
    id: a.id,
    label: accountLabel(a),
    active,
    hint: signIn ? (a.signedInAs ? nowSignedInAs(a.signedInAs) : SIGN_IN_HINT) : null,
    signIn,
    bars,
    status: !active && !signIn && bars.length === 0 && a.error ? errorCopy(a.error, a.errorDetail).label : null,
    disabled: busy || (!signIn && active),
  };
}

export function panelModel({ doc, now = Date.now(), busy = false, error = null } = {}) {
  const active = activeAccount(doc);
  const accounts = Array.isArray(doc?.accounts) ? doc.accounts : [];
  return {
    title: "Claude",
    updated: formatUpdated(active?.usageUpdatedAt ?? null, now),
    refreshTip: REFRESH_TIP,
    card: active ? card(active, now) : null,
    heading: "Other accounts",
    // The card has the active account (S9). Its row stays only to sign it in,
    // since nothing else in the panel does.
    rows: accounts
      .filter((a) => a.id !== active?.id || a.needsSignIn)
      .map((a) => accountRow(a, a.id === active?.id, now, busy === true)),
    empty: accounts.some((a) => a.id !== active?.id) ? null : "No other accounts",
    error,
    manage: "Manage Accounts…",
  };
}

// ── Sizes ──────────────────────────────────────────────────────────────────
// Each part of the popover and the panel has a fixed height, so the overlay
// can be opened exactly that tall, its bottom just above the footer. Widths
// are Orca's (w-[360px], the account panel's w-[400px]).

export const POPUP = Object.freeze({ width: 360, header: 40, toggle: 36, row: 46, rowUsage: 64, rowLine: 20, link: 36, frame: 4 });

export const PANEL = Object.freeze({
  width: 400, max: 640, min: 160, frame: 4, pad: 10,
  header: 24, gap: 8, cardPad: 10, label: 20, item: 10,
  window: 46, credits: 36, noticeLabel: 18, line: 16, lineChars: 54,
  divider: 9, heading: 26, row: 30, rowPad: 8, action: 28, bar: 16, bars: 164, manage: 32,
});

// The Claude row with numbers keeps one height in both modes: Detailed |
// Compact is toggled inside the open popover, which can't change its size.
export function popupHeight(m) {
  const row = m?.row?.kind === "usage" ? POPUP.rowUsage + (m.row.lines - 1) * POPUP.rowLine : POPUP.row;
  return POPUP.header + POPUP.toggle + 1 + row + 1 + 2 * POPUP.link + POPUP.frame;
}

// A notice's message, in lines of the card's width.
export const noticeLines = (message) => Math.max(1, Math.ceil(String(message ?? "").length / PANEL.lineChars));

// An account row: its label, with its bars (or its status) in a column
// beside it, as Orca's wrapping row lays them out at this width; a row to
// sign in has Orca's hint and Sign in on a line under it.
export function rowHeight(r) {
  const lines = r.bars.length + (r.status ? 1 : 0);
  return Math.max(PANEL.row, lines * PANEL.bar + PANEL.rowPad) + (r.signIn ? PANEL.action : 0);
}

export function cardHeight(c) {
  if (!c) return 0;
  const items = [
    ...c.windows.map(() => PANEL.window),
    ...(c.credits ? [PANEL.credits] : []),
    ...(c.notice ? [(c.notice.label ? PANEL.noticeLabel : 0) + noticeLines(c.notice.message) * PANEL.line] : []),
  ];
  return 2 + 2 * PANEL.cardPad + PANEL.label + sum(items) + PANEL.item * items.length;
}

export function panelHeight(m) {
  const rows = sum((m?.rows ?? []).map(rowHeight)) + (m?.empty ? PANEL.heading : 0);
  const total = 2 * PANEL.pad + PANEL.header + PANEL.gap + cardHeight(m?.card) + PANEL.divider + PANEL.heading + rows + PANEL.divider + PANEL.manage + PANEL.frame;
  return Math.min(PANEL.max, total);
}

// ── Where an overlay opens ─────────────────────────────────────────────────
// Above the footer, as Orca's popover (side top, align start, 8px off):
// anchor { x, y, limit } in window px, from the footer's mouse events: x the
// trigger's left edge, y the footer's top, limit the footer's right edge.
// size { width, height } in layout px, which are window px over the app's
// zoom (settings().zoom), as the win98 mod's menus open. Kept 8px inside the
// footer's right edge and the window's left; null without an anchor (the
// overlay opens at the pointer).

const GAP = 8;
const MARGIN = 8;
const round1 = (v) => Math.round(v * 10) / 10;

export function overlayAt(anchor, size, zoom = 1) {
  if (!isObject(anchor) || ![anchor.x, anchor.y, anchor.limit].every(isNumber)) return null;
  const z = isNumber(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.max(MARGIN * z, Math.min(anchor.x, anchor.limit - (size.width + MARGIN) * z));
  const y = Math.max(0, anchor.y - (size.height + GAP) * z);
  return { x: round1(x), y: round1(y) };
}

// The app's zoom, 1 when it says nothing.
export function zoomOf(settings) {
  const z = Number(settings?.zoom);
  return z > 0 ? z : 1;
}

// The footer's place before any press gave it, from the window's size and its
// own (on_size_change), both in window px: it sits at the window's bottom
// right. Null until both are known.
export function footerBounds(viewport, size) {
  if (![viewport?.width, viewport?.height, size?.width, size?.height].every(isNumber)) return null;
  return { x: viewport.width - size.width, y: viewport.height - size.height, width: size.width, height: size.height };
}

// The footer's bounds → the anchor: the usage starts past its padding.
export function anchorFrom(bounds, zoom = 1) {
  if (![bounds?.x, bounds?.y, bounds?.width].every(isNumber)) return null;
  return { x: bounds.x + FOOTER.pad * zoom, y: bounds.y, limit: bounds.x + bounds.width };
}

// The anchor the footer's copy last drew at: main.js's commands open their
// overlay with no arguments, in that same copy.
let remembered = null;
export function rememberAnchor(anchor) {
  remembered = anchor ?? null;
}
export const lastAnchor = () => remembered;

// openOverlay's argument, with what the new copy starts from: the anchor (the
// next overlay opens at the same place), the file's text (its first frame has
// the numbers), the height it opened at (a copy can't resize itself, so it
// compares). No anchor: it opens at the pointer.
function overlaySpec(view, size, { text, anchor, zoom }) {
  const at = overlayAt(anchor, size, zoom);
  return {
    mod: MOD,
    kind: "popup",
    width: size.width,
    height: size.height,
    ...(at ? { at } : {}),
    props: { view, anchor: anchor ?? null, text: text ?? null, height: size.height },
  };
}

export function popupSpec({ doc, text, mode, anchor, zoom = 1, now = Date.now() } = {}) {
  return overlaySpec("popup", { width: POPUP.width, height: popupHeight(popupModel({ doc, mode, now })) }, { text, anchor, zoom });
}

// The panel never passes the room above the footer: its body scrolls.
export function panelSpec({ doc, text, anchor, zoom = 1, now = Date.now() } = {}) {
  const height = panelHeight(panelModel({ doc, now }));
  const z = isNumber(zoom) && zoom > 0 ? zoom : 1;
  const room = isNumber(anchor?.y) ? Math.floor(anchor.y / z) - GAP - MARGIN : height;
  return overlaySpec("panel", { width: PANEL.width, height: Math.min(height, Math.max(PANEL.min, room)) }, { text, anchor, zoom });
}

// A press beside a popup closes it, and may reach the footer too: the overlay
// marks when it closed, in the shared UI value, and the footer's click right
// after that press doesn't open it again (Orca's trigger toggles).
const CLOSE_GUARD = 400;
export const withClosedAt = (ui, now) => ({ ...(isObject(ui) ? ui : {}), overlayClosedAt: now });
export function closedJustNow(ui, now) {
  return isObject(ui) && isNumber(ui.overlayClosedAt) && now - ui.overlayClosedAt < CLOSE_GUARD;
}

// ── Toasts (D1) ────────────────────────────────────────────────────────────
// reactState: toasts.react's first argument, from the text of restart.json,
// pending-switch.json and login-link (null when absent) and the accounts.
// applyReact(react, state, seen) → { notify, openConfirm, copyLink, seen }:
// runs toasts.react on a copy of shared("claude-accounts.seen") and says
// what the footer does: the toasts to post (herdr's notify fields only), the
// confirm view to open, the link to copy, and the new seen value to share
// (react's `seen` when it returns one, else the copy as react left it), or
// null when it didn't change. A react that throws does nothing.

export function reactState({ doc, restart, pending, link, now = Date.now() } = {}) {
  return { restart: readRestart(restart), pendingSwitch: readPendingSwitch(pending), loginLink: readLoginLink(link), accounts: doc, now };
}

const NOTIFY_FIELDS = Object.freeze(["title", "body", "level", "timeout", "icon", "action"]);

export function pickNotify(n) {
  if (!isObject(n) || typeof n.title !== "string" || n.title === "") return null;
  const out = {};
  for (const k of NOTIFY_FIELDS) if (n[k] !== undefined && n[k] !== null) out[k] = n[k];
  return out;
}

const NOTHING = Object.freeze({ notify: [], openConfirm: false, copyLink: null, seen: null });

export function applyReact(react, state, seen) {
  const before = isObject(seen) ? seen : {};
  const copy = JSON.parse(JSON.stringify(before));
  let r;
  try {
    r = react(state, copy);
  } catch {
    return { ...NOTHING, notify: [] };
  }
  const out = isObject(r) ? r : {};
  const next = isObject(out.seen) ? out.seen : copy;
  return {
    notify: (Array.isArray(out.notify) ? out.notify : []).map(pickNotify).filter(Boolean),
    openConfirm: out.openConfirm === true,
    copyLink: typeof out.copyLink === "string" && out.copyLink !== "" ? out.copyLink : null,
    seen: JSON.stringify(next) === JSON.stringify(before) ? null : next,
  };
}
