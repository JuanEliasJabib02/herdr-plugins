// claude-accounts T6: the footer, the popover and the Claude panel (S1, S6).
//   footer-model.js   what each view draws, from accounts.v1.json
//                     (store.readAccounts): the footer's segments per density
//                     level, Detailed or Compact, and state (usage, stale,
//                     signed out, error, loading, empty); the popover's Usage
//                     header, mode toggle and Claude row; the panel's card and
//                     its Claude Account list. Plus where an overlay opens
//                     over the footer, and how the footer applies
//                     toasts.react.
//
//   footer.js, popup.js, panel.js   the views, loaded in a fake Herdr (bottom
//                     of this file): what they draw, the footer's timer, watch
//                     and toasts, the clicks and what each one runs. Layout and
//                     paint stay with herdr-app check and the live shots.
//
// Nothing here reaches the person's ~/.config/herdr-app: the model is pure,
// the fixture state folder is read as text, and the views' files, exec,
// clipboard and overlays are the fake's, in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { readAccounts } from "../claude-accounts/mods/claude-accounts/store.js";
import {
  UI_KEY, SEEN_KEY, MODES, usageMode, withUsageMode, activeAccount, windowSections, tightestSection,
  footerModel, popupModel, panelModel, popupHeight, panelHeight, overlayAt, applyReact, pickNotify, formatMoney,
  POPUP, PANEL, MERGE_ARGS, REFRESH_ARGS, REFRESH_TIP, useArgs, zoomOf, footerBounds, anchorFrom, rememberAnchor, lastAnchor,
  popupSpec, panelSpec, signInTab, useFailure, reactState, withClosedAt, closedJustNow,
} from "../claude-accounts/mods/claude-accounts/footer-model.js";
import { react } from "../claude-accounts/mods/claude-accounts/toasts.js";

// The fixtures' "now": Nov 6 2026, 4:20 PM in Bogota.
const NOW = 1794000000000;
const MIN = 60_000;
const DOC = readAccounts(readFileSync(new URL("fixtures/claude-accounts/accounts.v1.json", import.meta.url), "utf8"));
const ANA = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const BEN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// A document whose active account is `active`, with every account's fields
// over the fixture's (by id).
function docWith(active, patches = {}) {
  const raw = JSON.parse(readFileSync(new URL("fixtures/claude-accounts/accounts.v1.json", import.meta.url), "utf8"));
  raw.active = active;
  raw.accounts = raw.accounts.map((a) => ({ ...a, ...(patches[a.id] ?? {}) }));
  return readAccounts(raw);
}

const w = (percent, resetsAt = null) => ({ percent, resetsAt });
const NO_USAGE = { session: null, weekly: null, fable: null, monthly: null };
const texts = (m) => m.sections.map((s) => s.text);

// ── Shared reads ─────────────────────────────────────────────────────────────

test("activeAccount: the doc's active account, else System default", () => {
  assert.equal(activeAccount(DOC).email, "ana@example.com");
  assert.equal(activeAccount(docWith("default")).id, "default");
  assert.equal(activeAccount(docWith("no-such-id")).id, "default");
  assert.equal(activeAccount(readAccounts(null)), null);
});

test("windowSections: Orca's order, Session, Weekly, Fable, Monthly, only the windows there", () => {
  const ben = DOC.accounts.find((a) => a.id === BEN);
  assert.deepEqual(windowSections(ben).map((s) => [s.key, s.title, s.short, s.percent]), [
    ["weekly", "Weekly", "wk", 94],
    ["fable", "Fable", "Fable", 42],
    ["monthly", "Monthly", "30d", 12],
  ]);
  assert.equal(tightestSection(ben).key, "weekly");
  // A tie keeps the first, as Orca's reduce does.
  const tie = readAccounts({ accounts: [{ id: "x", usage: { session: w(50), weekly: w(50) } }] }).accounts[0];
  assert.equal(tightestSection(tie).key, "session");
  assert.equal(tightestSection(readAccounts({ accounts: [{ id: "y" }] }).accounts[0]), null);
});

test("usageMode: Detailed (verbose) unless the shared UI key says compact (D12)", () => {
  assert.equal(UI_KEY, "claude-accounts.ui");
  assert.equal(SEEN_KEY, "claude-accounts.seen");
  assert.equal(usageMode(undefined), "verbose");
  assert.equal(usageMode({ usageMode: "nope" }), "verbose");
  assert.equal(usageMode({ usageMode: "compact" }), "compact");
  assert.deepEqual(withUsageMode({ other: 1 }, "compact"), { other: 1, usageMode: "compact" });
  assert.deepEqual(withUsageMode(null, "verbose"), { usageMode: "verbose" });
  // Orca's labels and tooltips (UsageRosterPanel.tsx).
  assert.deepEqual(MODES.map((m) => [m.value, m.label, m.tooltip]), [
    ["verbose", "Detailed", "Full usage with bars, labels, and percentages"],
    ["compact", "Compact", "Condensed usage: one summary per provider"],
  ]);
});

// ── The footer (S1, Image #1) ────────────────────────────────────────────────

test("footer, Detailed at full width: Used [icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable [refresh]", () => {
  const m = footerModel({ doc: DOC, mode: "verbose", width: 900, now: NOW });
  assert.equal(m.kind, "usage");
  assert.equal(m.level, "full");
  assert.equal(m.unit, "Used");
  assert.deepEqual(texts(m), ["41% 3h 2m", "65% 4d 6h", "22% Fable"]);
  // The bar is the tightest window's, in D5's color; each section too.
  assert.deepEqual(m.bar, { fill: 65, color: "working" });
  assert.deepEqual(m.sections.map((s) => s.color), ["muted", "working", "muted"]);
  assert.equal(m.warning, false);
  assert.equal(m.refresh, true);
  assert.equal(m.signIn, null);
});

test("footer, D5's colors on the live numbers: 61% amber, 84% and 96% red", () => {
  const doc = docWith(ANA, { [ANA]: { usage: { session: w(96, NOW + 2 * 3600_000), weekly: w(84, NOW + 3 * 86400_000), fable: w(61, NOW + 3 * 86400_000) } } });
  const m = footerModel({ doc, mode: "verbose", width: 900, now: NOW });
  assert.deepEqual(m.sections.map((s) => [s.text, s.color]), [["96% 2h", "blocked"], ["84% 3d", "blocked"], ["61% Fable", "working"]]);
  assert.deepEqual(m.bar, { fill: 96, color: "blocked" });
});

test("footer labels: a window without a reset says its length; monthly shows only without session and weekly", () => {
  const doc = docWith(ANA, { [ANA]: { usage: { session: w(10), weekly: w(20), fable: null, monthly: w(5) } } });
  assert.deepEqual(texts(footerModel({ doc, mode: "verbose", width: 900, now: NOW })), ["10% 5h", "20% wk"]);
  const monthlyOnly = docWith(ANA, { [ANA]: { usage: { ...NO_USAGE, monthly: w(12) } } });
  assert.deepEqual(texts(footerModel({ doc: monthlyOnly, mode: "verbose", width: 900, now: NOW })), ["12% 30d"]);
  // A reset that has passed reads "now", as Orca's formatResetDuration does.
  const passed = docWith(ANA, { [ANA]: { usage: { ...NO_USAGE, session: w(30, NOW - MIN) } } });
  assert.deepEqual(texts(footerModel({ doc: passed, mode: "verbose", width: 900, now: NOW })), ["30% now"]);
});

test("footer, Compact: the tightest window only, no bar (Orca's headline)", () => {
  const m = footerModel({ doc: DOC, mode: "compact", width: 900, now: NOW });
  assert.equal(m.level, "full");
  assert.equal(m.bar, null);
  assert.deepEqual(texts(m), ["65% 4d 6h"]);
  const fable = docWith(ANA, { [ANA]: { usage: { ...NO_USAGE, session: w(10, NOW + MIN * 90), fable: w(70, NOW + 86400_000) } } });
  assert.deepEqual(texts(footerModel({ doc: fable, mode: "compact", width: 900, now: NOW })), ["70% Fable"]);
});

test("footer density: full, then one number per window, then the icon only (D10)", () => {
  const full = footerModel({ doc: DOC, mode: "verbose", width: undefined, now: NOW });
  assert.equal(full.level, "full", "unmeasured is full, as Orca starts");
  const { needs } = full;
  assert.ok(needs.full > needs.compact && needs.compact > 0, JSON.stringify(needs));
  assert.equal(footerModel({ doc: DOC, mode: "verbose", width: needs.full, now: NOW }).level, "full");

  const compact = footerModel({ doc: DOC, mode: "verbose", width: needs.full - 2, now: NOW });
  assert.equal(compact.level, "compact");
  assert.equal(compact.bar, null);
  assert.equal(compact.unit, "Used");
  assert.deepEqual(texts(compact), ["41%", "65%", "22%"]);
  assert.deepEqual(compact.sections.map((s) => s.color), ["muted", "working", "muted"]);
  assert.equal(compact.refresh, true);
  // What the level hides is in the tooltip.
  assert.match(compact.tooltip, /41% 3h 2m · 65% 4d 6h · 22% Fable/);

  const icon = footerModel({ doc: DOC, mode: "verbose", width: needs.compact - 2, now: NOW });
  assert.equal(icon.level, "icon");
  assert.equal(icon.unit, null);
  assert.deepEqual(icon.sections, []);
  assert.equal(icon.bar, null);
  assert.equal(icon.refresh, false);
  assert.match(icon.tooltip, /41% 3h 2m/);

  // Compact mode at the compact level: the tightest number alone.
  const c = footerModel({ doc: DOC, mode: "compact", width: 0, now: NOW }).needs;
  assert.deepEqual(texts(footerModel({ doc: DOC, mode: "compact", width: c.full - 2, now: NOW })), ["65%"]);
});

test("footer, stale data: ⚠ after a failed read, but not while the login waits for Claude (recent)", () => {
  const net = docWith(ANA, { [ANA]: { error: "network" } });
  const m = footerModel({ doc: net, mode: "verbose", width: 900, now: NOW });
  assert.deepEqual(texts(m), ["41% 3h 2m", "65% 4d 6h", "22% Fable"]);
  assert.equal(m.warning, true);
  assert.match(m.tooltip, /Refresh failed — showing cached data/);
  // Orca's calm "Updates when Claude runs": no warning while the numbers
  // are under 30 minutes old; older ones still deserve it.
  const calm = docWith(ANA, { [ANA]: { error: "expired", usageUpdatedAt: NOW - 10 * MIN } });
  assert.equal(footerModel({ doc: calm, mode: "verbose", width: 900, now: NOW }).warning, false);
  const old = docWith(ANA, { [ANA]: { error: "expired", usageUpdatedAt: NOW - 31 * MIN } });
  assert.equal(footerModel({ doc: old, mode: "verbose", width: 900, now: NOW }).warning, true);
});

test("footer, signed out: Sign in to see usage, with a Sign in action for that account (D10)", () => {
  const doc = docWith("default");
  const m = footerModel({ doc, mode: "verbose", width: 900, now: NOW });
  assert.equal(m.kind, "signIn");
  assert.equal(m.label.text, "Sign in to see usage");
  assert.deepEqual(m.signIn, { id: "default", text: "Sign in" });
  assert.equal(m.refresh, false);
  assert.deepEqual(m.sections, []);
  // Narrower, the action stays and the sentence goes.
  const narrow = footerModel({ doc, mode: "verbose", width: m.needs.full - 2, now: NOW });
  assert.equal(narrow.label, null);
  assert.deepEqual(narrow.signIn, { id: "default", text: "Sign in" });
});

test("footer, an error without numbers: [icon] ⚠ label, calm for expired, the label gone when narrow", () => {
  const keychain = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: "keychain" } });
  const m = footerModel({ doc: keychain, mode: "verbose", width: 900, now: NOW });
  assert.equal(m.kind, "error");
  assert.equal(m.label.text, "Sign-in unavailable");
  assert.equal(m.warning, true);
  assert.equal(m.tooltip, "Claude sign-in credentials could not be read.");
  assert.equal(m.unit, null);
  const narrow = footerModel({ doc: keychain, mode: "verbose", width: m.needs.full - 2, now: NOW });
  assert.equal(narrow.level, "compact");
  assert.equal(narrow.label, null);
  assert.equal(narrow.warning, true);

  const expired = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: "expired" } });
  const e = footerModel({ doc: expired, mode: "verbose", width: 900, now: NOW });
  assert.equal(e.label.text, "Updates when Claude runs");
  assert.equal(e.warning, false);
  // An unknown error reads "unavailable" (D9).
  const unknown = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: "brand-new" } });
  assert.equal(footerModel({ doc: unknown, mode: "verbose", width: 900, now: NOW }).label.text, "Usage unavailable");
});

test("footer, loading and empty: ··· before the first read, the icon alone with no data", () => {
  const none = footerModel({ doc: readAccounts(null), mode: "verbose", width: 900, now: NOW });
  assert.equal(none.kind, "loading");
  assert.equal(none.label.text, "···");
  assert.equal(none.tooltip, "Loading usage…");
  const fresh = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: null, usageUpdatedAt: null } });
  assert.equal(footerModel({ doc: fresh, mode: "verbose", width: 900, now: NOW }).kind, "loading");
  const empty = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: null } });
  const m = footerModel({ doc: empty, mode: "verbose", width: 900, now: NOW });
  assert.equal(m.kind, "empty");
  assert.equal(m.label, null);
  assert.equal(m.tooltip, "No usage data");
});

// ── The popover (S1, Image #1) ───────────────────────────────────────────────

test("popover, Detailed: Usage · all agents · Detailed | Compact · Claude Resets in 3h 2m with 5h, wk and Fable bars", () => {
  const m = popupModel({ doc: DOC, mode: "verbose", now: NOW });
  assert.equal(m.title, "Usage");
  assert.equal(m.scope, "all agents");
  assert.deepEqual(m.modes.map((x) => [x.label, x.selected]), [["Detailed", true], ["Compact", false]]);
  assert.equal(m.row.name, "Claude");
  assert.equal(m.row.kind, "usage");
  assert.equal(m.row.reset, "Resets in 3h 2m");
  assert.deepEqual(m.row.metrics.map((x) => [x.label, x.text, x.fill, x.bar, x.color]), [
    ["5h", "41%", 41, "muted", "foreground"],
    ["wk", "65%", 65, "working", "working"],
    ["Fable", "22%", 22, "muted", "foreground"],
  ]);
  assert.equal(m.row.headline, null);
  assert.deepEqual(m.links.map((l) => [l.id, l.label]), [["details", "Usage details & history"], ["accounts", "Manage Accounts…"]]);
});

test("popover, Compact: the row's tightest window on its right, no bars", () => {
  const m = popupModel({ doc: DOC, mode: "compact", now: NOW });
  assert.deepEqual(m.modes.map((x) => x.selected), [false, true]);
  assert.deepEqual(m.row.metrics, []);
  assert.equal(m.row.reset, null);
  assert.deepEqual(m.row.headline, { label: "4d 6h", text: "65%", color: "working" });
  // The monthly window is a row metric too (Orca lists every window).
  const ben = popupModel({ doc: docWith(BEN), mode: "verbose", now: NOW });
  assert.deepEqual(ben.row.metrics.map((x) => [x.label, x.text, x.color]), [["wk", "94%", "blocked"], ["Fable", "42%", "foreground"], ["30d", "12%", "foreground"]]);
  assert.equal(ben.row.reset, "Resets in 2d 3h");
});

test("popover row without numbers: loading, not signed in (with Sign in), an error's label, no usage data", () => {
  assert.deepEqual(pick(popupModel({ doc: readAccounts(null), mode: "verbose", now: NOW }).row), ["loading", "Loading usage…", null]);
  assert.deepEqual(pick(popupModel({ doc: docWith("default"), mode: "verbose", now: NOW }).row), ["signIn", "not signed in", "default"]);
  const net = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: "network" } });
  assert.deepEqual(pick(popupModel({ doc: net, mode: "verbose", now: NOW }).row), ["error", "Network issue", null]);
  const empty = docWith(BEN, { [BEN]: { usage: NO_USAGE, error: null } });
  assert.deepEqual(pick(popupModel({ doc: empty, mode: "compact", now: NOW }).row), ["empty", "No usage data", null]);
  function pick(row) {
    assert.deepEqual(row.metrics, []);
    return [row.kind, row.status, row.signIn];
  }
});

// ── The Claude panel (S1, Image #2) ──────────────────────────────────────────

test("panel: Claude · Updated 3m ago, the active account's card with Session, Weekly and Fable", () => {
  const m = panelModel({ doc: DOC, now: NOW });
  assert.equal(m.title, "Claude");
  assert.equal(m.updated, "Updated 3m ago");
  assert.equal(m.card.label, "ana@example.com");
  assert.deepEqual(m.card.windows.map((x) => [x.title, x.used, x.resets, x.fill, x.color]), [
    ["Session", "41% used", "Resets in 3h 2m", 41, "muted"],
    ["Weekly", "65% used", "Resets in 4d 6h", 65, "working"],
    ["Fable", "22% used", "Resets in 4d 6h", 22, "muted"],
  ]);
  assert.equal(m.card.credits, null);
  assert.equal(m.card.notice, null);
  assert.equal(m.manage, "Manage Accounts…");
});

test("panel: the Claude Account list, System default first, ✓ on the active one, wk and Fable bars on the others", () => {
  const m = panelModel({ doc: DOC, now: NOW });
  assert.equal(m.heading, "Claude Account");
  assert.deepEqual(m.rows.map((r) => [r.id, r.label, r.active]), [
    ["default", "System default", false],
    [ANA, "ana@example.com", true],
    [BEN, "ben@example.org", false],
  ]);
  const [def, ana, ben] = m.rows;
  // System default's login lapsed: Orca's hint, and the row signs it in.
  assert.equal(def.hint, "Sign in again to use this account");
  assert.equal(def.signIn, "default");
  assert.deepEqual(def.bars, []);
  assert.equal(def.disabled, false);
  // The active row has no bars and can't be picked again.
  assert.deepEqual(ana.bars, []);
  assert.equal(ana.disabled, true);
  // S1: `[red bar] 94% used wk` and `[bar] 42% used Fable`; monthly stays out
  // while there's a weekly window (InlineUsageBars).
  assert.deepEqual(ben.bars.map((b) => [b.text, b.fill, b.color]), [["94% used wk", 94, "blocked"], ["42% used Fable", 42, "muted"]]);
  assert.equal(ben.signIn, null);
  assert.equal(ben.disabled, false);
  assert.equal(m.empty, null);
});

test("panel rows: a session bar counts down, monthly alone shows, an error without numbers says its label; busy disables all", () => {
  const doc = docWith(ANA, {
    [BEN]: { usage: { session: w(30, NOW + 47 * MIN), weekly: w(10), fable: null, monthly: null } },
    default: { needsSignIn: false, usage: { ...NO_USAGE, monthly: w(12) } },
  });
  const m = panelModel({ doc, now: NOW });
  assert.deepEqual(m.rows[2].bars.map((b) => b.text), ["30% used 47m", "10% used wk"]);
  assert.deepEqual(m.rows[0].bars.map((b) => b.text), ["12% used 30d"]);
  assert.equal(m.rows[0].signIn, null);
  const failed = docWith(ANA, { [BEN]: { usage: NO_USAGE, error: "network" } });
  assert.equal(panelModel({ doc: failed, now: NOW }).rows[2].status, "Network issue");
  assert.ok(panelModel({ doc: DOC, now: NOW, busy: true }).rows.every((r) => r.disabled));
});

test("panel card: monthly and credits when present, the refresh-failed marker on cached data", () => {
  const m = panelModel({ doc: docWith(BEN), now: NOW });
  assert.equal(m.card.label, "ben@example.org");
  assert.deepEqual(m.card.windows.map((x) => [x.title, x.used, x.resets]), [
    ["Weekly", "94% used", "Resets in 2d 3h"],
    ["Fable", "42% used", "Resets in 2d 3h"],
    ["Monthly", "12% used", "Resets in 20d"],
  ]);
  assert.deepEqual(m.card.credits, { title: "Usage credits", text: "$12.50 available" });
  // ben's last read was rate limited: Orca's marker over the kept numbers.
  assert.deepEqual(m.card.notice, { label: "Refresh failed — showing cached data", message: "Claude usage is rate limited right now." });
  assert.equal(m.updated, "Updated 40m ago");

  const limitOnly = panelModel({ doc: docWith(BEN, { [BEN]: { credits: { balance: null, limit: 50 } } }), now: NOW });
  assert.deepEqual(limitOnly.card.credits, { title: "Usage credits", text: "Limit $50.00" });
  // A zero limit and no balance is extra usage turned off: nothing to say.
  const off = panelModel({ doc: docWith(BEN, { [BEN]: { credits: { balance: null, limit: 0 } } }), now: NOW });
  assert.equal(off.card.credits, null);
  // The calm expired state keeps its own words.
  const calm = panelModel({ doc: docWith(ANA, { [ANA]: { error: "expired" } }), now: NOW });
  assert.deepEqual(calm.card.notice, { label: "Updates when Claude runs", message: "Claude usage updates the next time Claude runs." });
});

test("panel card without numbers: Sign in again, an error, loading; Not yet updated; No other accounts", () => {
  const def = panelModel({ doc: docWith("default"), now: NOW });
  assert.equal(def.card.label, "System default");
  assert.deepEqual(def.card.windows, []);
  assert.deepEqual(def.card.notice, {
    label: "Sign in again",
    message: "The selected Claude account needs you to sign in again. Open Manage Accounts…, or choose System default.",
  });
  assert.equal(def.updated, "Not yet updated");
  const failed = panelModel({ doc: docWith(BEN, { [BEN]: { usage: NO_USAGE, error: "refreshFailed", errorDetail: "socket hang up" } }), now: NOW });
  assert.deepEqual(failed.card.notice, { label: "Refresh failed", message: "socket hang up" });
  const fresh = panelModel({ doc: docWith(BEN, { [BEN]: { usage: NO_USAGE, usageUpdatedAt: null, error: null } }), now: NOW });
  assert.deepEqual(fresh.card.notice, { label: null, message: "Loading usage…" });

  const alone = readAccounts({ active: "default", accounts: [{ id: "default", isDefault: true, usage: { session: w(5) }, usageUpdatedAt: NOW }] });
  const m = panelModel({ doc: alone, now: NOW });
  assert.deepEqual(m.rows.map((r) => [r.label, r.active]), [["System default", true]]);
  assert.equal(m.empty, "No other accounts");
  const nothing = panelModel({ doc: readAccounts(null), now: NOW });
  assert.equal(nothing.card, null);
  assert.equal(nothing.updated, "Not yet updated");
});

test("formatMoney: USD as en-US writes it", () => {
  assert.equal(formatMoney(12.5), "$12.50");
  assert.equal(formatMoney(1234567.891), "$1,234,567.89");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(-3), "-$3.00");
  assert.equal(formatMoney(null), null);
});

// ── Where the overlays open ──────────────────────────────────────────────────

test("heights: the popover and the panel are as tall as what they draw", () => {
  const verbose = popupHeight(popupModel({ doc: DOC, mode: "verbose", now: NOW }));
  const compact = popupHeight(popupModel({ doc: DOC, mode: "compact", now: NOW }));
  const loading = popupHeight(popupModel({ doc: readAccounts(null), mode: "verbose", now: NOW }));
  // Detailed | Compact switches inside the open popover: its height holds.
  assert.equal(verbose, compact);
  assert.ok(verbose > loading && loading > 100, `${verbose} ${loading}`);
  const one = panelHeight(panelModel({ doc: readAccounts({ active: "default", accounts: [{ id: "default", isDefault: true }] }), now: NOW }));
  const three = panelHeight(panelModel({ doc: DOC, now: NOW }));
  const ben = panelHeight(panelModel({ doc: docWith(BEN), now: NOW }));
  assert.ok(three > one && one > 100, `${one} ${three}`);
  assert.ok(ben > three, "a monthly window, credits and a notice add height");
});

test("overlayAt: above the footer, its left edge on the trigger, kept inside the footer's right edge", () => {
  const anchor = { x: 700, y: 900, limit: 1440 };
  // Window px are layout px times the app's zoom.
  assert.deepEqual(overlayAt(anchor, { width: 360, height: 200 }, 1), { x: 700, y: 692 });
  assert.deepEqual(overlayAt(anchor, { width: 360, height: 200 }, 1.2), { x: 700, y: 650.4 });
  assert.deepEqual(overlayAt({ ...anchor, x: 1300 }, { width: 360, height: 200 }, 1), { x: 1072, y: 692 });
  assert.deepEqual(overlayAt({ x: 4, y: 100, limit: 300 }, { width: 360, height: 200 }, 1), { x: 8, y: 0 });
  assert.equal(overlayAt(null, { width: 360, height: 200 }, 1), null);
  assert.equal(overlayAt({ x: "a", y: 1, limit: 2 }, { width: 360, height: 200 }, 1), null);
});

test("a Detailed row with four windows takes a second line of metrics, in both modes", () => {
  const four = docWith(ANA, { [ANA]: { usage: { session: w(1), weekly: w(2), fable: w(3), monthly: w(4) } } });
  const verbose = popupModel({ doc: four, mode: "verbose", now: NOW });
  const compact = popupModel({ doc: four, mode: "compact", now: NOW });
  assert.equal(verbose.row.lines, 2);
  assert.equal(compact.row.lines, 2);
  assert.equal(popupHeight(verbose), popupHeight(compact));
  assert.equal(popupHeight(verbose), popupHeight(popupModel({ doc: DOC, mode: "verbose", now: NOW })) + POPUP.rowLine);
  assert.equal(popupModel({ doc: DOC, mode: "verbose", now: NOW }).row.lines, 1);
  assert.equal(popupModel({ doc: readAccounts(null), mode: "verbose", now: NOW }).row.lines, 1);
});

test("zoomOf: settings().zoom, and 1 when there's none", () => {
  assert.equal(zoomOf({ zoom: 1.2 }), 1.2);
  assert.equal(zoomOf({}), 1);
  assert.equal(zoomOf(null), 1);
  assert.equal(zoomOf({ zoom: 0 }), 1);
});

test("anchorFrom: a press's bounds give the usage's left edge, the footer's top and its right edge", () => {
  const bounds = { x: 1400, y: 1020, width: 1100, height: 34 };
  assert.deepEqual(anchorFrom(bounds, 1), { x: 1410, y: 1020, limit: 2500 });
  assert.deepEqual(anchorFrom(bounds, 1.2), { x: 1412, y: 1020, limit: 2500 });
  assert.equal(anchorFrom(undefined, 1), null);
  assert.equal(anchorFrom({ x: 1 }, 1), null);
});

test("footerBounds: before any press, the footer's place from the window's size (it sits at the bottom right)", () => {
  assert.deepEqual(footerBounds({ width: 2560, height: 1055 }, { width: 1100, height: 34 }), { x: 1460, y: 1021, width: 1100, height: 34 });
  assert.equal(footerBounds({ width: 2560, height: 1055 }, undefined), null);
  assert.equal(footerBounds(undefined, { width: 1, height: 1 }), null);
  // What the key command opens at: the last place the footer drew.
  rememberAnchor({ x: 1, y: 2, limit: 3 });
  assert.deepEqual(lastAnchor(), { x: 1, y: 2, limit: 3 });
  rememberAnchor(null);
  assert.equal(lastAnchor(), null);
});

test("popupSpec: a popup of the model's height, its bottom above the footer, with what the new copy starts from", () => {
  const text = JSON.stringify({ accounts: [] });
  const anchor = { x: 700, y: 900, limit: 1440 };
  const spec = popupSpec({ doc: DOC, text, mode: "verbose", anchor, zoom: 1, now: NOW });
  const height = popupHeight(popupModel({ doc: DOC, mode: "verbose", now: NOW }));
  assert.equal(spec.mod, "claude-accounts");
  assert.equal(spec.kind, "popup");
  assert.equal(spec.width, POPUP.width);
  assert.equal(spec.height, height);
  assert.deepEqual(spec.at, overlayAt(anchor, { width: POPUP.width, height }, 1));
  assert.deepEqual(spec.props, { view: "popup", anchor, text, height });
  // Without an anchor it opens at the pointer.
  const free = popupSpec({ doc: DOC, text: null, mode: "compact", anchor: null, zoom: 1, now: NOW });
  assert.equal("at" in free, false);
  assert.equal(free.props.anchor, null);
});

test("panelSpec: as tall as it draws, and never past the room above the footer", () => {
  const anchor = { x: 700, y: 900, limit: 1440 };
  const spec = panelSpec({ doc: DOC, text: "t", anchor, zoom: 1, now: NOW });
  const height = panelHeight(panelModel({ doc: DOC, now: NOW }));
  assert.equal(spec.kind, "popup");
  assert.equal(spec.width, PANEL.width);
  assert.equal(spec.height, height);
  assert.deepEqual(spec.at, overlayAt(anchor, { width: PANEL.width, height }, 1));
  assert.deepEqual(spec.props, { view: "panel", anchor, text: "t", height });
  // The window is short: the panel fits above the footer, and its body scrolls.
  const low = panelSpec({ doc: DOC, text: "t", anchor: { ...anchor, y: 240 }, zoom: 1.2, now: NOW });
  assert.equal(low.height, 184);
  assert.equal(low.at.y, 9.6);
  // Never smaller than something usable.
  assert.equal(panelSpec({ doc: DOC, text: "t", anchor: { ...anchor, y: 60 }, zoom: 1, now: NOW }).height, PANEL.min);
  assert.equal("at" in panelSpec({ doc: DOC, text: "t", anchor: null, zoom: 1, now: NOW }), false);
});

test("the CLI's argv: the timer and a merge batch fetch only what's due, every refresh button asks for fresh numbers", () => {
  assert.deepEqual([...MERGE_ARGS], ["usage", "--json"]);
  assert.deepEqual([...REFRESH_ARGS], ["usage", "--refresh", "--json"]);
  assert.deepEqual(useArgs(BEN), ["use", BEN, "--json"]);
  assert.equal(REFRESH_TIP, "Refresh rate limits");
  assert.deepEqual(signInTab("/cli", "default"), { name: "Claude sign-in", argv: ["/cli", "login", "default"] });
});

test("useFailure: nothing when it worked, Orca's refusal as the CLI says it, else that it exited", () => {
  assert.equal(useFailure({ code: 0, stdout: "{}", stderr: "" }), null);
  const refusal = "juan@iot4a.com needs you to sign in again.";
  assert.equal(useFailure({ code: 5, stdout: "", stderr: `note\n${refusal}\n` }), refusal);
  assert.equal(useFailure({ code: 7, stdout: "", stderr: "" }), "claude-accounts use exited 7");
  assert.equal(useFailure(new Error("no such file")), "no such file");
});

test("panelModel: a failed switch's text is in the model, and its height holds", () => {
  const m = panelModel({ doc: DOC, now: NOW, error: "juan@iot4a.com needs you to sign in again." });
  assert.equal(m.error, "juan@iot4a.com needs you to sign in again.");
  assert.equal(panelModel({ doc: DOC, now: NOW }).error, null);
  assert.equal(panelHeight(m), panelHeight(panelModel({ doc: DOC, now: NOW })));
});

test("closing an overlay is remembered for a moment: the press that closed it doesn't open it again", () => {
  const ui = withClosedAt({ usageMode: "compact" }, NOW);
  assert.deepEqual(ui, { usageMode: "compact", overlayClosedAt: NOW });
  assert.equal(usageMode(ui), "compact", "the mode stays");
  assert.equal(closedJustNow(ui, NOW + 100), true);
  assert.equal(closedJustNow(ui, NOW + 5000), false);
  assert.equal(closedJustNow(undefined, NOW), false);
  assert.equal(closedJustNow({ usageMode: "compact" }, NOW), false);
  assert.deepEqual(withClosedAt(null, NOW), { overlayClosedAt: NOW });
  // Setting the mode keeps it.
  assert.equal(withUsageMode(ui, "verbose").overlayClosedAt, NOW);
});

// ── toasts.react, applied (D1) ───────────────────────────────────────────────

const fixtureText = (name) => readFileSync(new URL(`fixtures/claude-accounts/${name}`, import.meta.url), "utf8");

test("reactState: what a re-read hands toasts.react, from the files' text", () => {
  const state = reactState({ doc: DOC, restart: fixtureText("restart.json"), pending: fixtureText("pending-switch.json"), link: fixtureText("login-link"), now: NOW });
  assert.equal(state.accounts, DOC);
  assert.equal(state.now, NOW);
  assert.equal(state.restart.items.length, 6);
  assert.equal(state.pendingSwitch.mode, "ask");
  assert.match(state.loginLink, /^https:\/\/claude\.com\//);
  // Missing files read as nothing.
  const none = reactState({ doc: DOC, restart: null, pending: null, link: null, now: NOW });
  assert.deepEqual(none.restart.items, []);
  assert.equal(none.pendingSwitch, null);
  assert.equal(none.loginLink, null);
});

test("the real toasts.react through applyReact: an Ask opens confirm once, the link is copied once, each toast posts once", () => {
  const state = reactState({ doc: DOC, restart: fixtureText("restart.json"), pending: fixtureText("pending-switch.json"), link: fixtureText("login-link"), now: NOW });
  const first = applyReact(react, state, undefined);
  assert.equal(first.openConfirm, true);
  assert.equal(first.copyLink, state.loginLink);
  assert.ok(first.notify.some((n) => n.title === "Sign-in link copied."), JSON.stringify(first.notify));
  assert.ok(first.seen, "what it showed is kept");
  const again = applyReact(react, state, first.seen);
  assert.deepEqual(again, { notify: [], openConfirm: false, copyLink: null, seen: null });
});

test("applyReact: posts react's toasts, and keeps what it marked seen, returned or written in place", () => {
  const state = { restart: { items: [] }, pendingSwitch: null, loginLink: "https://claude.com/x" };
  const returned = applyReact(
    (s, seen) => ({ notify: [{ title: "Restarting 1 Claude session on ben", level: "info", extra: 1 }, { body: "no title" }], openConfirm: true, copyLink: s.loginLink, seen: { ...seen, a: true } }),
    state,
    { old: true },
  );
  assert.deepEqual(returned.notify, [{ title: "Restarting 1 Claude session on ben", level: "info" }]);
  assert.equal(returned.openConfirm, true);
  assert.equal(returned.copyLink, "https://claude.com/x");
  assert.deepEqual(returned.seen, { old: true, a: true });

  const before = { old: true };
  const inPlace = applyReact((_s, seen) => {
    seen.b = true;
    return { notify: [], openConfirm: false, copyLink: null };
  }, state, before);
  assert.deepEqual(inPlace.seen, { old: true, b: true });
  assert.deepEqual(before, { old: true }, "the shared value itself isn't touched");

  assert.equal(applyReact(() => ({ notify: [], openConfirm: false, copyLink: null }), state, before).seen, null);
  // T1's stub, a react that throws, and one that returns nothing.
  for (const react of [() => ({ notify: [], openConfirm: false, copyLink: null }), () => { throw new Error("x"); }, () => undefined]) {
    assert.deepEqual(applyReact(react, state, undefined), { notify: [], openConfirm: false, copyLink: null, seen: null });
  }
});

test("pickNotify: only herdr's notify fields, and only with a title", () => {
  const action = { name: "claude-accounts.open-confirm", args: {} };
  assert.deepEqual(pickNotify({ title: "t", body: "b", level: "warning", timeout: 5000, icon: "i", action, key: "k" }), { title: "t", body: "b", level: "warning", timeout: 5000, icon: "i", action });
  assert.equal(pickNotify({ body: "b" }), null);
  assert.equal(pickNotify(null), null);
});

// ── The views, in a fake Herdr ───────────────────────────────────────────────
// `herdr`, `gpui-kit` and `gpui-base` resolve to stand-ins: an element records
// its calls, a click is its handler called by hand, cx's sleeps return at once
// and a watch wakes when a test says so.

const HERDR = ["theme", "props", "run", "notify", "openOverlay", "closeOverlay", "exec", "readTextFile", "watchFolder", "shared", "setShared", "settings", "home", "appHome", "window", "nextCommand"];
const FAKES = {
  herdr: HERDR.map((n) => `export const ${n} = (...a) => globalThis.__caFake.${n}(...a);`).join("\n"),
  "gpui-kit": `const k = (n) => (...a) => globalThis.__caFake.el(n, ...a);
    export const div = k("div"), svg = k("svg"), image = k("image");
    export const PathBuilder = { stroke: () => globalThis.__caFake.path(), fill: () => globalThis.__caFake.path() };
    export class View {}`,
  "gpui-base": `const k = (n) => (...a) => globalThis.__caFake.el(n, ...a);
    export const v_flex = k("v_flex"), h_flex = k("h_flex"), Popover = k("Popover");`,
};
registerHooks({
  resolve: (spec, ctx, next) => (Object.hasOwn(FAKES, spec) ? { url: `fake:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("fake:") ? { format: "module", source: FAKES[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});

// An element: every builder call is recorded and returns it.
function el(kind, arg) {
  const rec = { kind, arg, kids: [], calls: {}, handlers: {} };
  const self = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        t.calls[k] = args;
        if (k === "child") t.kids.push(args[0]);
        else if (k === "children") t.kids.push(...args[0]);
        else if (k === "when") return args[0] ? args[1](self) : self;
        else if (k === "hover") args[0](self);
        else if (k === "on_mouse_down") t.handlers.mouse_down = args[1];
        else if (k.startsWith("on_")) t.handlers[k.slice(3)] = args[0];
        return self;
      };
    },
  });
  return self;
}

function path() {
  const b = new Proxy({}, { get: (_t, k) => (k === "build" ? () => ({ path: true }) : () => b) });
  return b;
}

const find = (e, id) => {
  if (typeof e !== "object" || e === null) return null;
  if (e.calls.id?.[0] === id) return e;
  for (const k of e.kids) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
};
const textOf = (e) => (typeof e === "string" ? e : typeof e === "object" && e !== null ? e.kids.map(textOf).filter(Boolean).join(" ") : "");
// The element whose own text child is `text`.
const withText = (e, text) => {
  if (typeof e !== "object" || e === null) return null;
  if (e.kids.includes(text)) return e;
  for (const k of e.kids) {
    const hit = withText(k, text);
    if (hit) return hit;
  }
  return null;
};

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise(setImmediate);
};

const STATE = "/fake/home/.config/herdr-app/claude-accounts";
const CLI = "/fake/app/mods/claude-accounts/bin/claude-accounts";

// One world per test: files, what the views ran, and a cx.
function newWorld({ files = {}, props = null, hasWindow = true } = {}) {
  const w = {
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`${STATE}/${k}`, v])),
    props,
    shared: new Map(),
    log: [],
    execs: [],
    notified: [],
    clipboard: [],
    timers: [],
    sleeps: [],
    notifies: 0,
    watches: [],
    nextId: 0,
    execFn: () => ({ code: 0, stdout: "{}", stderr: "" }),
  };
  w.opened = () => w.log.filter((x) => x.open).map((x) => x.open);
  w.closed = () => w.log.filter((x) => x.close).map((x) => x.close);
  w.tabs = () => w.log.filter((x) => x.run === "tab.new").map((x) => x.args);
  w.batch = async (paths) => {
    w.watches.shift()?.resolve(paths);
    await flush();
  };
  w.write = (name, text) => {
    w.files[`${STATE}/${name}`] = text;
  };
  const cx = {
    notify: () => {
      w.notifies++;
    },
    spawn: (f) => {
      Promise.resolve().then(() => f(cx)).catch(() => {});
    },
    sleep: async (ms) => {
      w.sleeps.push(ms);
    },
    timer: {
      every: (ms, f) => w.timers.push({ ms, fire: () => f(cx) }),
      after: () => {},
    },
    write_to_clipboard: (t) => w.clipboard.push(t),
    focus_handle: () => ({ focus() {} }),
    stop_propagation() {},
  };
  w.cx = cx;
  globalThis.window = { viewport_size: () => ({ width: 1000, height: 800 }), paint_path: () => el("path") };
  globalThis.__caFake = {
    el,
    path,
    theme: () => new Proxy({}, { get: (_t, k) => `#${String(k)}` }),
    props: () => w.props,
    run: (name, args) => w.log.push({ run: name, args }),
    notify: (n) => w.notified.push(n),
    openOverlay: (spec) => {
      w.log.push({ open: spec });
      return `ov${++w.nextId}`;
    },
    closeOverlay: (id) => w.log.push({ close: id }),
    exec: async (cmd, args) => {
      assert.equal(cmd, CLI);
      w.execs.push(args);
      const r = await w.execFn(args);
      if (r instanceof Error) throw r;
      return r;
    },
    readTextFile: async (file) => w.files[file] ?? null,
    watchFolder: (dir) => {
      assert.equal(dir, STATE);
      return new Promise((resolve, reject) => w.watches.push({ resolve, reject }));
    },
    shared: (k) => w.shared.get(k),
    setShared: (k, v) => w.shared.set(k, v),
    settings: () => ({ zoom: 1 }),
    home: () => "/fake/home",
    appHome: () => "/fake/app",
    window: () => (hasWindow ? { platform: "macos" } : null),
    nextCommand: () => new Promise(() => {}),
  };
  return w;
}

const { default: Footer, refreshUsage } = await import("../claude-accounts/mods/claude-accounts/footer.js");
const { default: Popup, openPopup } = await import("../claude-accounts/mods/claude-accounts/popup.js");
const { default: Panel, openPanel } = await import("../claude-accounts/mods/claude-accounts/panel.js");

// Numbers relative to the clock, because the views read Date.now() themselves.
const H3M2 = (3 * 60 + 2) * MIN + 30_000;
const D4H6 = (4 * 24 * 60 + 6 * 60) * MIN + 30_000;
function liveDoc(active = ANA, patches = {}) {
  const now = Date.now();
  const raw = JSON.parse(fixtureText("accounts.v1.json"));
  raw.active = active;
  raw.accounts = raw.accounts.map((a) => ({
    ...a,
    ...(a.id === ANA ? { usage: { session: w(41, now + H3M2), weekly: w(65, now + D4H6), fable: w(22, now + D4H6), monthly: null }, usageUpdatedAt: now - 3 * MIN } : {}),
    ...(a.id === BEN ? { usage: { session: null, weekly: w(94, now + D4H6), fable: w(42, now + D4H6), monthly: null }, error: null, credits: null, usageUpdatedAt: now - 3 * MIN } : {}),
    ...(patches[a.id] ?? {}),
  }));
  return JSON.stringify(raw);
}

async function footer(opts = {}) {
  const world = newWorld({ files: { "accounts.v1.json": liveDoc(), ...opts.files }, hasWindow: opts.hasWindow ?? true });
  if (opts.setup) opts.setup(world);
  const view = new Footer();
  view.init({}, world.cx);
  await flush();
  return { world, view };
}

test("footer view: herdr-app check's copy (no window) only draws: no exec, no watch, no timer, no toast", async () => {
  const world = newWorld({ files: { "accounts.v1.json": liveDoc(), "login-link": fixtureText("login-link") }, hasWindow: false });
  const view = new Footer();
  view.init({}, world.cx);
  await flush();
  assert.deepEqual(world.execs, []);
  assert.equal(world.watches.length, 0);
  assert.equal(world.timers.length, 0);
  assert.deepEqual(world.clipboard, []);
  assert.deepEqual(world.notified, []);
  assert.equal(world.shared.size, 0);
  assert.match(textOf(view.render()), /···/);
});

test("footer view (S1): draws Used [icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable [refresh], in D5's colors", async () => {
  const { view } = await footer();
  const root = view.render();
  assert.equal(textOf(root), "Used 41% 3h 2m · 65% 4d 6h · 22% Fable");
  assert.ok(find(root, "ca-footer-refresh"), "the refresh button");
  assert.equal(withText(root, "65% 4d 6h").calls.text_color[0], "#working");
  assert.equal(withText(root, "41% 3h 2m").calls.text_color[0], "#muted");
  // The bar is the tightest window's: 65% in amber.
  const fills = [];
  const walk = (e) => {
    if (typeof e !== "object" || e === null) return;
    if (e.calls.w?.[0] === "65%") fills.push(e.calls.bg[0]);
    e.kids.forEach(walk);
  };
  walk(root);
  assert.deepEqual(fills, ["#working"]);
});

test("footer view: its density follows its measured width, in layout px", async () => {
  const { view, world } = await footer();
  const root = view.render();
  const needs = footerModel({ doc: readAccounts(liveDoc()), mode: "verbose", now: Date.now() }).needs;
  root.handlers.size_change({ width: needs.full - 20, height: 28 }, world.cx);
  assert.equal(textOf(view.render()), "Used 41% · 65% · 22%");
  root.handlers.size_change({ width: needs.compact - 20, height: 28 }, world.cx);
  assert.equal(textOf(view.render()), "");
  assert.equal(find(view.render(), "ca-footer-refresh"), null);
});

test("footer view: Detailed | Compact comes from the shared UI value", async () => {
  const { view, world } = await footer();
  world.shared.set(UI_KEY, { usageMode: "compact" });
  assert.equal(textOf(view.render()), "Used 65% 4d 6h");
});

test("footer view, signed out (D10): Sign in to see usage, and its Sign in opens the login in a tab", async () => {
  const { view, world } = await footer({ files: { "accounts.v1.json": liveDoc("default") } });
  const root = view.render();
  assert.match(textOf(root), /Sign in to see usage/);
  find(root, "ca-footer-sign-in").handlers.click({}, world.cx);
  assert.deepEqual(world.tabs(), [{ name: "Claude sign-in", argv: [CLI, "login", "default"] }]);
});

// The fixtures' switch and restart, as of now (older ones are marked seen
// without a word).
function freshToastFiles() {
  const now = Date.now();
  const restart = JSON.parse(fixtureText("restart.json"));
  restart.items = restart.items.map((i) => ({ ...i, updatedAt: now }));
  return {
    "restart.json": JSON.stringify(restart),
    "pending-switch.json": JSON.stringify({ ...JSON.parse(fixtureText("pending-switch.json")), at: now }),
    "login-link": fixtureText("login-link"),
  };
}

test("footer view (D1): a re-read applies toasts.react: notify, the confirm view, the link on the clipboard; each once", async () => {
  const { view, world } = await footer({ files: freshToastFiles() });
  assert.ok(world.notified.some((n) => n.title === "Sign-in link copied."), JSON.stringify(world.notified));
  assert.ok(world.notified.some((n) => /is busy$/.test(n.title)), JSON.stringify(world.notified));
  assert.deepEqual(world.opened().map((s) => s.props.view), ["confirm"]);
  assert.deepEqual(world.clipboard, [fixtureText("login-link").trim()]);
  assert.ok(world.shared.get(SEEN_KEY), "what it showed is shared");

  const posted = world.notified.length;
  await view.reread(world.cx);
  await world.batch([`${STATE}/restart.json`]);
  assert.equal(world.notified.length, posted);
  assert.equal(world.opened().length, 1);
  assert.equal(world.clipboard.length, 1);
});

test("footer view (D1): works with T1's stub of toasts.react, whose result is empty", () => {
  const stub = () => ({ notify: [], openConfirm: false, copyLink: null });
  assert.deepEqual(applyReact(stub, reactState({ doc: DOC, restart: null, pending: null, link: null, now: NOW }), {}), { notify: [], openConfirm: false, copyLink: null, seen: null });
});

test("footer view (D1, D4): starts with one merge, and its timers are the 15 minutes and the countdown's minute", async () => {
  const { world } = await footer();
  assert.deepEqual(world.execs, [["usage", "--json"]]);
  assert.deepEqual(world.timers.map((t) => t.ms).sort((a, b) => a - b), [60_000, 15 * 60_000]);
  world.timers.find((t) => t.ms === 15 * 60_000).fire();
  await flush();
  assert.deepEqual(world.execs, [["usage", "--json"], ["usage", "--json"]]);
  const before = world.notifies;
  world.timers.find((t) => t.ms === 60_000).fire();
  assert.equal(world.notifies, before + 1);
});

test("footer view (D1): the watch's filter: root or live/ merges, anything else only re-reads, each after its settle", async () => {
  const { world, view } = await footer();
  world.execs.length = 0;
  world.sleeps.length = 0;

  world.write("accounts.v1.json", liveDoc(BEN));
  await world.batch([`${STATE}/accounts.v1.json`]);
  assert.deepEqual(world.execs, [], "a plain change runs nothing");
  assert.deepEqual(world.sleeps, [150], "it waited its settle");
  assert.match(textOf(view.render()), /94% 2d|94% 4d/, "and it re-read");

  await world.batch([`${STATE}/live/6abbff3c.json`]);
  assert.deepEqual(world.execs, [["usage", "--json"]]);
  await world.batch([STATE]);
  assert.deepEqual(world.execs, [["usage", "--json"], ["usage", "--json"]]);
});

test("footer view: a missing state folder is watched again later, and a failed merge keeps the watch alive", async () => {
  const { world } = await footer();
  world.sleeps.length = 0;
  world.watches.shift().reject(new Error("no such folder"));
  await flush();
  assert.deepEqual(world.sleeps, [2000, 150]);
  assert.equal(world.watches.length, 1, "it watches again");

  world.execFn = () => new Error("cannot start");
  await world.batch([`${STATE}/live/x.json`]);
  assert.equal(world.watches.length, 1, "still watching");
  world.execFn = () => ({ code: 4, stdout: "", stderr: "a read didn't finish" });
  await world.batch([`${STATE}/live/x.json`]);
  assert.equal(world.watches.length, 1, "still watching");
});

test("footer view: merges run one at a time, and what came meanwhile runs once more", async () => {
  const { world } = await footer();
  world.execs.length = 0;
  let release;
  world.execFn = () => new Promise((r) => {
    release = () => r({ code: 0, stdout: "{}", stderr: "" });
  });
  await world.batch([`${STATE}/live/a.json`]);
  await world.batch([`${STATE}/live/b.json`]);
  await world.batch([`${STATE}/live/c.json`]);
  assert.equal(world.execs.length, 1, "one at a time");
  assert.equal(world.watches.length, 1, "the watch isn't held up");
  release();
  await flush();
  assert.equal(world.execs.length, 2, "once more for what came meanwhile");
  release();
  await flush();
  assert.equal(world.execs.length, 2);
});

test("footer view: a click opens the popover above the footer, from the press's bounds; the press that closed it doesn't", async () => {
  const { view, world } = await footer();
  const root = view.render();
  root.handlers.mouse_down({ bounds: { x: 500, y: 700, width: 480, height: 28 } }, world.cx);
  find(root, "ca-footer-usage").handlers.click({}, world.cx);
  const [spec] = world.opened();
  assert.equal(spec.kind, "popup");
  assert.equal(spec.width, POPUP.width);
  assert.deepEqual(spec.at, { x: 510, y: 700 - spec.height - 8 });
  assert.deepEqual(spec.props.anchor, { x: 510, y: 700, limit: 980 });
  assert.equal(spec.props.view, "popup");
  assert.equal(JSON.parse(spec.props.text).active, ANA);

  world.shared.set(UI_KEY, withClosedAt({}, Date.now()));
  find(root, "ca-footer-usage").handlers.click({}, world.cx);
  assert.equal(world.opened().length, 1);
});

test("footer view: before any press the overlays open from the footer's place in the window", async () => {
  const { view, world } = await footer();
  view.render().handlers.size_change({ width: 480, height: 28 }, world.cx);
  view.render();
  // The window's 1000×800; the footer's bottom right.
  assert.deepEqual(lastAnchor(), { x: 530, y: 772, limit: 1000 });
  await openPopup();
  await openPanel();
  const [popup, panel] = world.opened();
  assert.equal(popup.props.view, "popup");
  assert.equal(popup.at.y, 772 - popup.height - 8);
  assert.equal(panel.props.view, "panel");
  assert.equal(panel.at.y, 772 - panel.height - 8);
  assert.equal(JSON.parse(panel.props.text).active, ANA);
});

test("footer view: refresh runs usage --refresh, spins while it runs, and takes what it wrote", async () => {
  const { view, world } = await footer();
  world.execs.length = 0;
  let release;
  world.execFn = () => new Promise((r) => {
    release = () => r({ code: 0, stdout: "{}", stderr: "" });
  });
  const button = () => find(view.render(), "ca-footer-refresh");
  assert.equal(button().kids[0].kind, "path", "the icon");
  button().handlers.click({}, world.cx);
  await flush();
  assert.deepEqual(world.execs, [["usage", "--refresh", "--json"]]);
  assert.ok(button().kids[0].calls.frames, "the spinner");
  button().handlers.click({}, world.cx);
  await flush();
  assert.equal(world.execs.length, 1, "one at a time");
  world.write("accounts.v1.json", liveDoc(BEN));
  release();
  await flush();
  assert.equal(button().kids[0].kind, "path");
  assert.match(textOf(view.render()), /94%/);
  // The refresh command is the same call.
  world.execFn = () => ({ code: 1, stdout: "", stderr: "nope" });
  assert.equal((await refreshUsage()).code, 1);
});

// An overlay's copy, as popupSpec / panelSpec open it.
async function overlay(View, spec, world) {
  world.props = { ...spec.props, overlay: "ov-this" };
  const view = new View();
  view.init(world.props, world.cx);
  await flush();
  return view;
}

const ANCHOR = { x: 500, y: 700, limit: 980 };

async function popup(text = liveDoc(), mode = "verbose") {
  const world = newWorld({ files: { "accounts.v1.json": text } });
  world.shared.set(UI_KEY, { usageMode: mode });
  const spec = popupSpec({ doc: readAccounts(text), text, mode, anchor: ANCHOR, zoom: 1, now: Date.now() });
  return { world, view: await overlay(Popup, spec, world) };
}

test("popover view (S1): Usage · all agents · refresh · Detailed | Compact · Claude Resets in 3h 2m · 5h wk Fable · its two links", async () => {
  const { view } = await popup();
  const root = view.render();
  assert.equal(textOf(root), "Usage all agents Detailed Compact Claude Resets in 3h 2m 5h 41% wk 65% Fable 22% Usage details & history Manage Accounts…");
  assert.ok(find(root, "ca-popup-refresh"));
  assert.equal(find(root, "ca-popup-mode-verbose").calls.tooltip[0], "Full usage with bars, labels, and percentages");
  assert.ok(find(root, "ca-popup-mode-verbose").calls.font_medium, "Detailed is selected");
  assert.equal(find(root, "ca-popup-mode-compact").calls.font_medium, undefined);
  assert.equal(withText(root, "65%").calls.text_color[0], "#working");
  assert.equal(withText(root, "41%").calls.text_color[0], "#foreground");
});

test("popover view: Detailed | Compact sets the footer's mode, and the row draws its headline", async () => {
  const { view, world } = await popup();
  find(view.render(), "ca-popup-mode-compact").handlers.click({}, world.cx);
  assert.deepEqual(world.shared.get(UI_KEY), { usageMode: "compact" });
  const text = textOf(view.render());
  assert.match(text, /Claude 4d 6h 65%/);
  assert.doesNotMatch(text, /Resets in/);
});

test("popover view: the Claude row opens the panel where it was, then it closes; the links open their views", async () => {
  const { view, world } = await popup();
  find(view.render(), "ca-popup-row").handlers.click({}, world.cx);
  assert.deepEqual(world.log.map((x) => (x.open ? `open ${x.open.props.view}` : `close ${x.close}`)), ["open panel", "close ov-this"]);
  assert.deepEqual(world.opened()[0].props.anchor, ANCHOR);

  world.log.length = 0;
  find(view.render(), "ca-popup-details").handlers.click({}, world.cx);
  find(view.render(), "ca-popup-accounts").handlers.click({}, world.cx);
  assert.deepEqual(world.log.map((x) => (x.open ? `open ${x.open.props.view}` : `close ${x.close}`)), ["open details", "close ov-this", "open accounts", "close ov-this"]);
});

test("popover view, signed out: the row says not signed in, and a click opens the login in a tab", async () => {
  const { view, world } = await popup(liveDoc("default"));
  const root = view.render();
  assert.match(textOf(root), /Claude not signed in Sign in/);
  find(root, "ca-popup-row").handlers.click({}, world.cx);
  assert.deepEqual(world.tabs(), [{ name: "Claude sign-in", argv: [CLI, "login", "default"] }]);
  assert.deepEqual(world.opened(), []);
  assert.deepEqual(world.closed(), ["ov-this"]);
});

test("popover view: what it draws follows the file; when it needs another height, a copy of that height takes its place", async () => {
  const { view, world } = await popup(liveDoc("default"));
  const before = world.notifies;
  // Only a number changes: the same height, drawn again.
  world.write("accounts.v1.json", liveDoc("default", { default: { label: "x" } }));
  await world.batch([`${STATE}/accounts.v1.json`]);
  assert.ok(world.notifies > before);
  assert.deepEqual(world.opened(), []);
  // The row has numbers now: taller.
  world.write("accounts.v1.json", liveDoc(ANA));
  await world.batch([`${STATE}/accounts.v1.json`]);
  const [spec] = world.opened();
  assert.equal(spec.props.view, "popup");
  assert.equal(spec.height, popupHeight(popupModel({ doc: readAccounts(liveDoc(ANA)), mode: "verbose", now: Date.now() })));
  assert.deepEqual(world.closed(), ["ov-this"]);
  assert.equal(spec.at.y, ANCHOR.y - spec.height - 8);
  // Closing marks the time, for the press that closed it, and stops the copy.
  await view.close();
  assert.ok(closedJustNow(world.shared.get(UI_KEY), Date.now()));
  assert.equal(usageMode(world.shared.get(UI_KEY)), "verbose");
});

test("popover view: without an overlay (herdr-app check) it only draws", async () => {
  const world = newWorld({ files: { "accounts.v1.json": liveDoc() } });
  const view = new Popup();
  view.init({}, world.cx);
  await flush();
  assert.equal(world.watches.length, 0);
  assert.equal(world.timers.length, 0);
  assert.match(textOf(view.render()), /Loading usage…/);
});

async function panel(text = liveDoc()) {
  const world = newWorld({ files: { "accounts.v1.json": text } });
  const spec = panelSpec({ doc: readAccounts(text), text, anchor: ANCHOR, zoom: 1, now: Date.now() });
  return { world, view: await overlay(Panel, spec, world) };
}

test("panel view: it has the height it opened at, or a popup, which takes its content's, leaves the scrolling body none", async () => {
  const text = liveDoc();
  const spec = panelSpec({ doc: readAccounts(text), text, anchor: ANCHOR, zoom: 1, now: Date.now() });
  const { view } = await panel(text);
  assert.equal(find(view.render(), "ca-panel").calls.h[0], spec.height - PANEL.frame);
});

test("panel view (S1): Claude Updated 3m ago, the card's windows, Claude Account with ✓ and the others' bars, Manage Accounts…", async () => {
  const { view } = await panel();
  const root = view.render();
  const text = textOf(root);
  assert.ok(text.startsWith("Claude Updated 3m ago ana@example.com Session 41% used Resets in 3h 2m Weekly 65% used Resets in 4d 6h Fable 22% used Resets in 4d 6h Claude Account"), text);
  assert.ok(text.endsWith("ben@example.org 94% used wk 42% used Fable Manage Accounts…"), text);
  assert.ok(find(root, "ca-panel-refresh"));
  // ✓ only on the active account; its row can't be picked again.
  const active = find(root, `ca-panel-row-${ANA}`);
  assert.equal(active.handlers.click, undefined);
  const checks = [];
  const walk = (e) => {
    if (typeof e !== "object" || e === null) return;
    if (e.kind === "svg") checks.push(e.arg);
    e.kids.forEach(walk);
  };
  walk(active);
  assert.deepEqual(checks, ["mods/workspace-chrome/check.svg"]);
  checks.length = 0;
  walk(find(root, `ca-panel-row-${BEN}`));
  assert.deepEqual(checks, []);
  assert.equal(withText(root, "94% used wk").calls.text_color[0], "#muted");
});

test("panel view: opening it asks for the usage that's due", async () => {
  const { world } = await panel();
  assert.deepEqual(world.execs, [["usage", "--json"]]);
});

test("panel view: a click runs use, every row waits for it, and the panel stays open on the new account", async () => {
  // Both accounts draw the same two windows, so the height holds.
  const two = () => ({ usage: { session: w(41, Date.now() + H3M2), weekly: w(65, Date.now() + D4H6), fable: null, monthly: null } });
  const { view, world } = await panel(liveDoc(ANA, { [ANA]: two(), [BEN]: two() }));
  world.execs.length = 0;
  let release;
  world.execFn = () => new Promise((r) => {
    release = () => r({ code: 0, stdout: "{}", stderr: "" });
  });
  find(view.render(), `ca-panel-row-${BEN}`).handlers.click({}, world.cx);
  await flush();
  assert.deepEqual(world.execs, [["use", BEN, "--json"]]);
  assert.equal(find(view.render(), `ca-panel-row-${BEN}`).handlers.click, undefined, "busy: no second switch");
  world.write("accounts.v1.json", liveDoc(BEN, { [ANA]: two(), [BEN]: two() }));
  release();
  await flush();
  assert.match(textOf(view.render()), /Updated 3m ago ben@example\.org/);
  assert.deepEqual(world.opened(), []);
  assert.deepEqual(world.closed(), []);
  assert.ok(find(view.render(), `ca-panel-row-${ANA}`).handlers.click, "the old account can be picked back");
});

test("panel view: Orca's refusal (exit 5) shows under the heading, and the next click clears it", async () => {
  const { view, world } = await panel();
  world.execFn = (args) => (args[0] === "use" ? { code: 5, stdout: "", stderr: "ben@example.org needs you to sign in again.\n" } : { code: 0, stdout: "{}", stderr: "" });
  find(view.render(), `ca-panel-row-${BEN}`).handlers.click({}, world.cx);
  await flush();
  const line = withText(view.render(), "ben@example.org needs you to sign in again.");
  assert.equal(line.calls.text_color[0], "#blocked");
  assert.deepEqual(world.closed(), []);
  world.execFn = () => ({ code: 0, stdout: "{}", stderr: "" });
  find(view.render(), `ca-panel-row-${BEN}`).handlers.click({}, world.cx);
  await flush();
  assert.equal(withText(view.render(), "ben@example.org needs you to sign in again."), null);
  // exec that can't start says why, too.
  world.execFn = () => new Error("cannot start");
  find(view.render(), `ca-panel-row-${BEN}`).handlers.click({}, world.cx);
  await flush();
  assert.ok(withText(view.render(), "cannot start"));
});

test("panel view: an account whose login lapsed signs in from its row, in a tab, and the panel closes", async () => {
  const { view, world } = await panel();
  const row = find(view.render(), "ca-panel-row-default");
  assert.match(textOf(row), /System default Sign in again to use this account Sign in/);
  row.handlers.click({}, world.cx);
  assert.deepEqual(world.tabs(), [{ name: "Claude sign-in", argv: [CLI, "login", "default"] }]);
  assert.deepEqual(world.closed(), ["ov-this"]);
  assert.equal(world.execs.filter((a) => a[0] === "use").length, 0);
});

test("panel view: a switch that changes its height reopens it once the switch is done, not while it runs", async () => {
  const { view, world } = await panel();
  let release;
  world.execFn = () => new Promise((r) => {
    release = () => r({ code: 0, stdout: "{}", stderr: "" });
  });
  find(view.render(), `ca-panel-row-${BEN}`).handlers.click({}, world.cx);
  await flush();
  // The file changes while `use` runs, and the new account has fewer windows.
  const next = liveDoc(BEN, { [BEN]: { usage: { session: null, weekly: w(94, Date.now() + D4H6), fable: null, monthly: null } } });
  world.write("accounts.v1.json", next);
  await world.batch([`${STATE}/accounts.v1.json`]);
  assert.deepEqual(world.opened(), []);
  release();
  await flush();
  assert.deepEqual(world.opened().map((s) => s.props.view), ["panel"]);
  assert.deepEqual(world.closed(), ["ov-this"]);
  assert.equal(world.opened()[0].height, panelHeight(panelModel({ doc: readAccounts(next), now: Date.now() })));
});

test("panel view: Manage Accounts… opens the accounts view; No other accounts when there are none", async () => {
  const { view, world } = await panel();
  find(view.render(), "ca-panel-manage").handlers.click({}, world.cx);
  assert.deepEqual(world.opened().map((s) => s.props.view), ["accounts"]);
  assert.deepEqual(world.closed(), ["ov-this"]);

  const alone = JSON.stringify({ version: 1, active: "default", accounts: [{ id: "default", isDefault: true, usage: { session: w(5) }, usageUpdatedAt: Date.now() }] });
  const { view: v2 } = await panel(alone);
  assert.match(textOf(v2.render()), /System default No other accounts Manage Accounts…/);
});

test("panel view: without an overlay (herdr-app check) it runs nothing", async () => {
  const world = newWorld({ files: { "accounts.v1.json": liveDoc() } });
  const view = new Panel();
  view.init({}, world.cx);
  await flush();
  assert.deepEqual(world.execs, []);
  assert.equal(world.watches.length, 0);
  assert.match(textOf(view.render()), /Not yet updated/);
});
