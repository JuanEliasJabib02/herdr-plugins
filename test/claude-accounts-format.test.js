// claude-accounts T11: the mod's shared pure modules, final and frozen (D1).
//   format.js  how the views say things: percent, durations, dates, D5's
//              colors, D4's error copy (Orca's, word for word), D10's
//              density levels, and D11's "since <date>" and coverage note.
//   store.js   the CLI's files as the mod reads them: one reader per file,
//              against D2's pinned shapes and test/fixtures/claude-accounts/,
//              each tolerant of a missing (null), corrupt or partial file;
//              and what a watchFolder batch on the state folder asks for.
// Nothing here writes or reads outside the repo: a reader gets a fixture's
// text, as a view gets herdr's readTextFile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatPercent, formatDuration, formatResetsIn, formatDate, formatUpdated,
  colorToken, errorCopy, densityLevel, formatSince, formatCoverage,
} from "../claude-accounts/mods/claude-accounts/format.js";
import {
  MOD, FILES, stateDir, cliPath,
  readAccounts, readSettings, readRestart, readPendingSwitch, readDetails, readLoginLink,
  classifyWatchPaths,
} from "../claude-accounts/mods/claude-accounts/store.js";

// Dates are local, as in Orca and in Herdr's runtime: these tests read them
// in Bogota, the fixtures' zone. Every Date is made inside a test, after this.
process.env.TZ = "America/Bogota";

// The fixtures' "now": Nov 6 2026, 4:20 PM in Bogota.
const NOW = 1794000000000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const fixture = (name) => readFileSync(new URL(`fixtures/claude-accounts/${name}`, import.meta.url), "utf8");

// ── format.js ──────────────────────────────────────────────────────────────

test("formatPercent: Orca's bare percentage, clamped to 0–100 and rounded; anything but a number reads 0%", () => {
  assert.equal(formatPercent(41), "41%");
  assert.equal(formatPercent(41.5), "42%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(100), "100%");
  assert.equal(formatPercent(120), "100%");
  assert.equal(formatPercent(-3), "0%");
  for (const bad of [null, undefined, NaN, Infinity, "41"]) assert.equal(formatPercent(bad), "0%", String(bad));
});

test("formatDuration: Orca's floored two largest units (S1's 3h 2m and 4d 6h), 'now' at or past zero, null for no number", () => {
  assert.equal(formatDuration(47 * MIN + 59_000), "47m");
  assert.equal(formatDuration(3 * HOUR + 2 * MIN + 59_000), "3h 2m");
  assert.equal(formatDuration(3 * HOUR), "3h");
  assert.equal(formatDuration(4 * DAY + 6 * HOUR + 59 * MIN), "4d 6h");
  assert.equal(formatDuration(6 * DAY + 30 * MIN), "6d");
  assert.equal(formatDuration(59_999), "0m");
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(-5 * MIN), "now");
  for (const bad of [null, undefined, NaN, "3h"]) assert.equal(formatDuration(bad), null, String(bad));
});

test("formatResetsIn: 'Resets in …' to a window's reset (the fixture's 3h 2m and 4d 6h), 'Resets now' once past, null without a reset time", () => {
  const ana = JSON.parse(fixture("accounts.v1.json")).accounts[1];
  assert.equal(formatResetsIn(ana.usage.session.resetsAt, NOW), "Resets in 3h 2m");
  assert.equal(formatResetsIn(ana.usage.weekly.resetsAt, NOW), "Resets in 4d 6h");
  assert.equal(formatResetsIn(NOW + 12 * HOUR + 41 * MIN, NOW), "Resets in 12h 41m");
  assert.equal(formatResetsIn(NOW, NOW), "Resets now");
  assert.equal(formatResetsIn(NOW - HOUR, NOW), "Resets now");
  assert.equal(formatResetsIn(null, NOW), null);
  assert.equal(formatResetsIn(undefined, NOW), null);
});

test("formatDate: Orca's account timestamp in local time, S2's 'Nov 2, 5:25 PM'; midnight and noon read 12", () => {
  assert.equal(formatDate(1793658301633), "Nov 2, 5:25 PM");
  assert.equal(formatDate(1793595900000), "Nov 2, 12:05 AM");
  assert.equal(formatDate(1793638800000), "Nov 2, 12:00 PM");
  assert.equal(formatDate(NOW), "Nov 6, 4:20 PM");
  for (const bad of [null, undefined, NaN, "1793658301633"]) assert.equal(formatDate(bad), null, String(bad));
});

test("formatUpdated: S1's 'Updated 3m ago', 'just now' under a minute, whole hours past one, 'Not yet updated' without a time", () => {
  const ana = JSON.parse(fixture("accounts.v1.json")).accounts[1];
  assert.equal(formatUpdated(ana.usageUpdatedAt, NOW), "Updated 3m ago");
  assert.equal(formatUpdated(NOW - 30_000, NOW), "Updated just now");
  assert.equal(formatUpdated(NOW + 5 * MIN, NOW), "Updated just now");
  assert.equal(formatUpdated(NOW - 59 * MIN - 59_000, NOW), "Updated 59m ago");
  assert.equal(formatUpdated(NOW - 26 * HOUR - 30 * MIN, NOW), "Updated 26h ago");
  assert.equal(formatUpdated(null, NOW), "Not yet updated");
  assert.equal(formatUpdated(undefined, NOW), "Not yet updated");
  assert.equal(formatUpdated(0, NOW), "Not yet updated");
});

test("colorToken: D5's theme tokens on Orca's cutoffs, under 60 muted, 60–79 working, 80 or more blocked (S1's 65% amber, 94% red)", () => {
  for (const p of [0, 22, 41, 59, 59.4]) assert.equal(colorToken(p), "muted", String(p));
  for (const p of [59.5, 60, 65, 79]) assert.equal(colorToken(p), "working", String(p));
  for (const p of [79.5, 80, 94, 100, 140]) assert.equal(colorToken(p), "blocked", String(p));
  for (const bad of [null, undefined, NaN]) assert.equal(colorToken(bad), "muted", String(bad));
});

// D4's table: one case per pair.

test("errorCopy expired: 'Updates when Claude runs' / 'Claude usage updates the next time Claude runs.'", () => {
  assert.deepEqual(errorCopy("expired"), {
    label: "Updates when Claude runs",
    message: "Claude usage updates the next time Claude runs.",
  });
});

test("errorCopy rateLimited: 'Limited' / 'Claude usage is rate limited right now.'", () => {
  assert.deepEqual(errorCopy("rateLimited", "HTTP 429"), {
    label: "Limited",
    message: "Claude usage is rate limited right now.",
  });
});

test("errorCopy keychain: 'Sign-in unavailable' / 'Claude sign-in credentials could not be read.'", () => {
  assert.deepEqual(errorCopy("keychain"), {
    label: "Sign-in unavailable",
    message: "Claude sign-in credentials could not be read.",
  });
});

test("errorCopy network: 'Network issue' / 'Claude usage could not be refreshed because the network request failed.'", () => {
  assert.deepEqual(errorCopy("network", "ECONNRESET"), {
    label: "Network issue",
    message: "Claude usage could not be refreshed because the network request failed.",
  });
});

test("errorCopy refreshFailed: the raw error, Orca's softened copy when it reads as an auth error, 'Unable to fetch usage' with none", () => {
  assert.deepEqual(errorCopy("refreshFailed", "Unexpected token < in JSON"), {
    label: "Refresh failed",
    message: "Unexpected token < in JSON",
  });
  for (const auth of ["The access token is expired", "401 Unauthorized", "Please log in again", "Invalid credentials"]) {
    assert.deepEqual(errorCopy("refreshFailed", auth), {
      label: "Refresh failed",
      message: "Claude usage could not be refreshed. Agent sessions may still be signed in.",
    }, auth);
  }
  assert.deepEqual(errorCopy("refreshFailed"), { label: "Refresh failed", message: "Unable to fetch usage" });
  assert.deepEqual(errorCopy("refreshFailed", "   "), { label: "Refresh failed", message: "Unable to fetch usage" });
});

test("errorCopy noSubscription: 'No subscription' / the server's text, 'Unable to fetch usage' with none", () => {
  assert.deepEqual(errorCopy("noSubscription", "This account has no Claude subscription."), {
    label: "No subscription",
    message: "This account has no Claude subscription.",
  });
  assert.deepEqual(errorCopy("noSubscription"), { label: "No subscription", message: "Unable to fetch usage" });
});

test("errorCopy unavailable: 'Usage unavailable' / 'Claude usage is unavailable right now.', or Orca's raw missing-scope message", () => {
  assert.deepEqual(errorCopy("unavailable"), {
    label: "Usage unavailable",
    message: "Claude usage is unavailable right now.",
  });
  const scope = "OAuth token does not meet scope requirement user:profile";
  assert.deepEqual(errorCopy("unavailable", scope), { label: "Usage unavailable", message: scope });
});

test("errorCopy needsSignIn: 'Sign in again' / Orca's message, with Manage Accounts… for Settings > AI Provider Accounts", () => {
  assert.deepEqual(errorCopy("needsSignIn"), {
    label: "Sign in again",
    message: "The selected Claude account needs you to sign in again. Open Manage Accounts…, or choose System default.",
  });
});

test("errorCopy: no error is null; an unknown value reads as unavailable (D9), its text unused", () => {
  for (const none of [null, undefined, ""]) assert.equal(errorCopy(none), null, String(none));
  for (const unknown of ["quotaExploded", 42, {}, "toString", "__proto__"]) {
    assert.deepEqual(errorCopy(unknown, "raw text"), {
      label: "Usage unavailable",
      message: "Claude usage is unavailable right now.",
    }, String(unknown));
  }
});

test("errorCopy stale: over cached numbers 'Refresh failed' reads Orca's 'Refresh failed — showing cached data'; other labels keep theirs", () => {
  assert.deepEqual(errorCopy("refreshFailed", "boom", { stale: true }), {
    label: "Refresh failed — showing cached data",
    message: "boom",
  });
  assert.equal(errorCopy("refreshFailed", "boom", { stale: false }).label, "Refresh failed");
  assert.equal(errorCopy("rateLimited", null, { stale: true }).label, "Limited");
  assert.equal(errorCopy("network", null, { stale: true }).label, "Network issue");
});

// D10: one case per level.

test("densityLevel full: bars and labels when the footer is wide enough (within Orca's 1px), and before it is measured", () => {
  assert.equal(densityLevel(400), "full");
  assert.equal(densityLevel(330), "full");
  assert.equal(densityLevel(329), "full");
  for (const unmeasured of [undefined, null, NaN]) assert.equal(densityLevel(unmeasured), "full", String(unmeasured));
  assert.equal(densityLevel(250, { full: 240, compact: 100 }), "full");
});

test("densityLevel compact: one number per window when the bars don't fit", () => {
  assert.equal(densityLevel(328), "compact");
  assert.equal(densityLevel(200), "compact");
  assert.equal(densityLevel(139), "compact");
  assert.equal(densityLevel(238, { full: 240, compact: 100 }), "compact");
});

test("densityLevel icon: the icon only when not even one number per window fits", () => {
  assert.equal(densityLevel(138), "icon");
  assert.equal(densityLevel(40), "icon");
  assert.equal(densityLevel(0), "icon");
  assert.equal(densityLevel(98, { full: 240, compact: 100 }), "icon");
  // A bad needs value falls back to the default for that level.
  assert.equal(densityLevel(200, { full: "wide", compact: null }), "compact");
});

test("formatSince: 'since <date>' from claude-usage's cacheSince day, the year added when it isn't now's; null for no day", () => {
  assert.equal(formatSince("2026-11-03", NOW), "since Nov 3");
  assert.equal(formatSince("2026-01-30", NOW), "since Jan 30");
  assert.equal(formatSince("2025-12-28", NOW), "since Dec 28, 2025");
  for (const bad of [null, undefined, "", "2026-13-01", "2026-11-00", "Nov 3", "2026-11-03T00:00:00Z", 20261103]) {
    assert.equal(formatSince(bad, NOW), null, String(bad));
  }
});

test("formatCoverage: below 1, the cache figures cover only sessions still on disk, with the share; null when they cover it all or there are no tokens", () => {
  const note = (share) => `Cache figures cover only sessions still on disk: ${share}% of this range's tokens.`;
  assert.equal(formatCoverage(0.7182), note("72"));
  assert.equal(formatCoverage(0.631), note("63"));
  assert.equal(formatCoverage(0.9996), note("99"));
  assert.equal(formatCoverage(0.004), note("<1"));
  assert.equal(formatCoverage(0), note("0"));
  for (const none of [1, 1.2, null, undefined, NaN, "0.5"]) assert.equal(formatCoverage(none), null, String(none));
});

// ── store.js ───────────────────────────────────────────────────────────────

test("store: the mod's folder name, the state folder's file names, and its paths", () => {
  assert.equal(MOD, "claude-accounts");
  assert.deepEqual({ ...FILES }, {
    contract: "accounts.v1.json",
    settings: "settings.json",
    restart: "restart.json",
    pendingSwitch: "pending-switch.json",
    details: "details.json",
    loginLink: "login-link",
    live: "live",
  });
  assert.equal(stateDir("/Users/ana"), "/Users/ana/.config/herdr-app/claude-accounts");
  assert.equal(cliPath("/Users/ana/.config/herdr-app"), "/Users/ana/.config/herdr-app/mods/claude-accounts/bin/claude-accounts");
});

// readAccounts: accounts.v1.json (D9).

const EMPTY_ACCOUNTS = { version: 1, updatedAt: null, active: "default", accounts: [] };

test("readAccounts missing: no file, or one that isn't JSON or an object, reads as no accounts with System default active", () => {
  for (const text of [null, undefined, "", "{not json", "[]", "42", "null"]) {
    assert.deepEqual(readAccounts(text), EMPTY_ACCOUNTS, String(text));
  }
  // A later version renames or removes fields (D9): this reader can't trust it.
  assert.deepEqual(readAccounts(JSON.stringify({ version: 2, active: "x", accounts: [{ id: "x" }] })), EMPTY_ACCOUNTS);
});

test("readAccounts partial: missing fields get their empty value, entries without an id are dropped, percents clamped, unknown errors read unavailable", () => {
  const got = readAccounts(JSON.stringify({
    accounts: [
      { id: "a1", email: "ana@example.com", error: "quotaExploded", usage: { weekly: { percent: 94.6, resetsAt: "soon" }, fable: { percent: "22" } } },
      { id: "default", needsSignIn: "yes" },
      { id: "b2", label: "", errorDetail: "kept for a later reader", usage: null, credits: { balance: 12.5 } },
      { email: "no-id@example.com" },
      "junk",
      null,
    ],
  }));
  assert.equal(got.version, 1);
  assert.equal(got.updatedAt, null);
  assert.equal(got.active, "default");
  assert.deepEqual(got.accounts.map((a) => a.id), ["a1", "default", "b2"]);
  const [a1, def, b2] = got.accounts;
  assert.equal(a1.label, "ana@example.com");
  assert.equal(a1.error, "unavailable");
  assert.equal(a1.isDefault, false);
  assert.equal(a1.configDir, null);
  assert.deepEqual(a1.usage, { session: null, weekly: { percent: 95, resetsAt: null }, fable: null, monthly: null });
  assert.equal(def.label, "System default");
  assert.equal(def.isDefault, true);
  assert.equal(def.needsSignIn, false);
  assert.equal(def.error, null);
  assert.equal(b2.label, "b2");
  assert.equal(b2.errorDetail, "kept for a later reader");
  assert.deepEqual(b2.usage, { session: null, weekly: null, fable: null, monthly: null });
  assert.deepEqual(b2.credits, { balance: 12.5, limit: null });
  for (const a of got.accounts) {
    for (const key of ["email", "org", "configDir", "usageUpdatedAt", "lastAuthenticatedAt"]) {
      assert.ok(key in a, `${a.id} has ${key}`);
    }
  }
});

test("readAccounts fixture: System default plus two accounts, S1's numbers, the active one, credits and the rateLimited error", () => {
  const got = readAccounts(fixture("accounts.v1.json"));
  assert.equal(got.version, 1);
  assert.equal(got.updatedAt, NOW);
  assert.equal(got.active, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  assert.deepEqual(got.accounts.map((a) => [a.id, a.label, a.isDefault]), [
    ["default", "System default", true],
    ["1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "ana@example.com", false],
    ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "ben@example.org", false],
  ]);
  const [def, ana, ben] = got.accounts;
  assert.equal(def.needsSignIn, true);
  assert.equal(def.configDir, null);
  assert.equal(def.email, "ana@example.com");
  assert.deepEqual(def.usage, { session: null, weekly: null, fable: null, monthly: null });
  // The exact string, spaces and all (D2's invariant).
  assert.equal(ana.configDir, "/Users/ana/Library/Application Support/Orca Dev/claude-profiles/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/home");
  assert.deepEqual(ana.usage, {
    session: { percent: 41, resetsAt: 1794010920000 },
    weekly: { percent: 65, resetsAt: 1794367200000 },
    fable: { percent: 22, resetsAt: 1794367200000 },
    monthly: null,
  });
  assert.equal(ana.usageUpdatedAt, 1793999820000);
  assert.equal(ana.org, "Example Org");
  assert.equal(ben.error, "rateLimited");
  assert.equal(ben.usage.weekly.percent, 94);
  assert.deepEqual(ben.usage.monthly, { percent: 12, resetsAt: 1795728000000 });
  assert.deepEqual(ben.credits, { balance: 12.5, limit: 50 });
  assert.equal(ben.lastAuthenticatedAt, 1793658301633);
  // S2's subtitle, `org · date`, from what the reader gives.
  assert.equal(`${ben.org} · ${formatDate(ben.lastAuthenticatedAt)}`, "Acme · Nov 2, 5:25 PM");
});

// readSettings: settings.json.

test("readSettings missing: no file, or not JSON, is Orca's default, ask", () => {
  for (const text of [null, undefined, "", "nope", "[]"]) assert.deepEqual(readSettings(text), { switchMode: "ask" }, String(text));
});

test("readSettings partial: a missing or unknown switchMode is ask; other keys are kept", () => {
  assert.deepEqual(readSettings("{}"), { switchMode: "ask" });
  assert.deepEqual(readSettings(JSON.stringify({ switchMode: "always" })), { switchMode: "ask" });
  assert.deepEqual(readSettings(JSON.stringify({ switchMode: "keep", later: true })), { switchMode: "keep", later: true });
});

test("readSettings fixture: restart", () => {
  assert.deepEqual(readSettings(fixture("settings.json")), { switchMode: "restart" });
});

// readRestart: restart.json (D2, D8, D9).

test("readRestart missing: no file, or not JSON, is an empty queue", () => {
  for (const text of [null, undefined, "", "{", "[]", "7"]) assert.deepEqual(readRestart(text), { items: [] }, String(text));
});

test("readRestart partial: items without an id are dropped; each other field gets its empty value; an unknown state or kind reads null", () => {
  const got = readRestart(JSON.stringify({
    items: [
      { id: "sw-1", kind: "switch", terminal: "t5", state: "waitingIdle", args: "--model opus", claimedBy: { pid: "x" } },
      { id: "rs-2", kind: "teleport", state: "exploded", code: 9, args: ["--model", 5, "opus"], claimedBy: { pid: 7, at: NOW } },
      { kind: "resume", state: "queued" },
      "junk",
    ],
  }));
  assert.deepEqual(got.items.map((i) => i.id), ["sw-1", "rs-2"]);
  assert.deepEqual(got.items[0], {
    id: "sw-1", kind: "switch", terminal: "t5", from: null, to: null, sessionId: null, args: [], message: null,
    state: "waitingIdle", code: null, detail: null, claimedBy: null, updatedAt: null,
  });
  assert.equal(got.items[1].kind, null);
  assert.equal(got.items[1].state, null);
  assert.equal(got.items[1].code, 9);
  assert.deepEqual(got.items[1].args, ["--model", "opus"]);
  assert.deepEqual(got.items[1].claimedBy, { pid: 7, at: NOW });
  assert.deepEqual(readRestart(JSON.stringify({ items: "none" })), { items: [] });
});

test("readRestart fixture: switch items and resume jobs in each state worth reading, with their codes, args and claim", () => {
  const got = readRestart(fixture("restart.json"));
  assert.deepEqual(got.items.map((i) => [i.id, i.kind, i.state, i.code]), [
    ["sw-5f2a", "switch", "waitingIdle", null],
    ["sw-5f2b", "switch", "queued", null],
    ["rs-9c01", "resume", "done", 0],
    ["rs-9c02", "resume", "failed", 9],
    ["rs-9c03", "resume", "timeout", 4],
    ["sw-5f20", "switch", "cancelled", 10],
  ]);
  const [waiting, , done, failed] = got.items;
  assert.deepEqual(waiting.claimedBy, { pid: 48213, at: 1793999990000 });
  assert.deepEqual(waiting.args, ["--model", "opus", "--add-dir", "/Users/ana/src/my app"]);
  assert.equal(waiting.terminal, "t12");
  assert.equal(waiting.from, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  assert.equal(done.message, "The limit reset: carry on.");
  assert.equal(failed.detail, "claude --resume 9a0e7c5b-3d1f-4b2a-8e6c-4f2d0b9a7e5c");
  assert.equal(failed.updatedAt, 1793999600000);
});

// readPendingSwitch: pending-switch.json (D2, D8).

test("readPendingSwitch missing: no file, not JSON, or no target account is null (no Ask waiting)", () => {
  for (const text of [null, undefined, "", "{", "[]"]) assert.equal(readPendingSwitch(text), null, String(text));
  assert.equal(readPendingSwitch(JSON.stringify({ from: "a", sessions: [] })), null);
});

test("readPendingSwitch partial: missing fields get their empty value, sessions without a terminal are dropped, an unknown group can't move", () => {
  const got = readPendingSwitch(JSON.stringify({
    to: "default",
    sessions: [
      { terminal: "t1", group: "onAccount" },
      { terminal: "t2", group: "teleported", title: "claude" },
      { title: "no terminal" },
      7,
    ],
  }));
  assert.equal(got.from, null);
  assert.equal(got.to, "default");
  assert.equal(got.at, null);
  assert.deepEqual(got.sessions, [
    { terminal: "t1", title: null, account: null, group: "onAccount", reason: null },
    { terminal: "t2", title: "claude", account: null, group: "cantMove", reason: null },
  ]);
  assert.deepEqual(readPendingSwitch(JSON.stringify({ to: "b", sessions: {} })).sessions, []);
});

test("readPendingSwitch fixture: from, to, at, and two onAccount, one elsewhere and one cantMove session", () => {
  const got = readPendingSwitch(fixture("pending-switch.json"));
  assert.equal(got.from, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  assert.equal(got.to, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
  assert.equal(got.at, NOW);
  assert.deepEqual(got.sessions.map((s) => [s.terminal, s.group, s.reason]), [
    ["t12", "onAccount", null],
    ["t14", "onAccount", null],
    ["t21", "elsewhere", null],
    ["t30", "cantMove", "own-program"],
  ]);
  assert.equal(got.sessions[0].title, "claude · herdr-plugins");
  assert.equal(got.sessions[2].account, "default");
  assert.equal(got.sessions[3].account, null);
});

// readDetails: details.json (D2, D11).

const NEVER_RUN = { result: null, running: false, startedAt: null, finishedAt: null, error: null };

test("readDetails missing: no file, or not JSON, has the four ranges, each never run", () => {
  for (const text of [null, undefined, "", "{", "[]"]) {
    assert.deepEqual(readDetails(text), { ranges: { 7: NEVER_RUN, 30: NEVER_RUN, 90: NEVER_RUN, all: NEVER_RUN } }, String(text));
  }
});

test("readDetails partial: a missing range is never run, an unknown one dropped; a result that isn't an object is null", () => {
  const got = readDetails(JSON.stringify({
    ranges: {
      7: { result: { version: 1, totals: { tokens: 5 } }, running: "yes", startedAt: 1, finishedAt: 2 },
      30: { result: "garbage", running: true, error: 42 },
      365: { result: { version: 1 } },
    },
  }));
  assert.deepEqual(Object.keys(got.ranges), ["7", "30", "90", "all"]);
  assert.deepEqual(got.ranges[7], { result: { version: 1, totals: { tokens: 5 } }, running: false, startedAt: 1, finishedAt: 2, error: null });
  assert.deepEqual(got.ranges[30], { result: null, running: true, startedAt: null, finishedAt: null, error: null });
  assert.deepEqual(got.ranges[90], NEVER_RUN);
  assert.deepEqual(got.ranges.all, NEVER_RUN);
  assert.deepEqual(readDetails(JSON.stringify({ ranges: [] })).ranges.all, NEVER_RUN);
});

test("readDetails fixture: 7 done with claude-usage's JSON as written, 30 running, 90 failed, all never run", () => {
  const text = fixture("details.json");
  const got = readDetails(text);
  assert.deepEqual(got.ranges[7].result, JSON.parse(text).ranges[7].result);
  assert.equal(got.ranges[7].running, false);
  assert.equal(got.ranges[7].finishedAt, 1793999952000);
  assert.deepEqual(got.ranges[30], { result: null, running: true, startedAt: 1793999990000, finishedAt: null, error: null });
  assert.equal(got.ranges[90].error, "claude-usage exited 1: no usage-cache.jsonl");
  assert.equal(got.ranges[90].running, false);
  assert.deepEqual(got.ranges.all, NEVER_RUN);
});

// readLoginLink: login-link (D13).

test("readLoginLink missing: no file, or an empty one, is null", () => {
  for (const text of [null, undefined, "", "  \n"]) assert.equal(readLoginLink(text), null, JSON.stringify(text));
});

test("readLoginLink partial: surrounding whitespace is trimmed; only Orca's local sign-in link is kept", () => {
  const ok = "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A4000%2Fcallback&state=s";
  assert.equal(readLoginLink(`${ok}\n`), ok);
  const bad = [
    "http://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://evil.example/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://claude.com.evil.example/x?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://claude.com@evil.example/x?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
    "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://claude.com/cai/oauth/authorize",
    "not a url",
  ];
  for (const link of bad) assert.equal(readLoginLink(link), null, link);
});

test("readLoginLink fixture: the captured one-click link, as written", () => {
  const text = fixture("login-link");
  assert.equal(readLoginLink(text), text);
  assert.match(readLoginLink(text), /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
});

// classifyWatchPaths: what a watchFolder batch on the state folder asks for (D1).

const ROOT = "/Users/ana/.config/herdr-app/claude-accounts";

test("classifyWatchPaths root: a batch holding the state folder itself means everything (herdr.d.ts), so merge", () => {
  assert.equal(classifyWatchPaths(ROOT, [ROOT]), "merge");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/accounts.v1.json`, `${ROOT}/`]), "merge");
  assert.equal(classifyWatchPaths(`${ROOT}/`, [ROOT]), "merge");
  // A batch it can't read means everything too.
  assert.equal(classifyWatchPaths(ROOT, null), "merge");
});

test("classifyWatchPaths live/: a statusline drop, or the folder itself, means merge", () => {
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/live/5ba6c07f.json`]), "merge");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/accounts.v1.json`, `${ROOT}/live/default.json.tmp`]), "merge");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/live`]), "merge");
});

test("classifyWatchPaths other: the CLI's own files, the lock and look-alikes only re-read", () => {
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/accounts.v1.json`]), "reread");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/restart.json`, `${ROOT}/pending-switch.json`, `${ROOT}/login-link`]), "reread");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/lock/pid`, `${ROOT}/lock`]), "reread");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}/live.tmp`, `${ROOT}/liveliness`]), "reread");
  assert.equal(classifyWatchPaths(ROOT, [`${ROOT}-profiles/x/live/a.json`, "/elsewhere/live/a.json"]), "reread");
  assert.equal(classifyWatchPaths(ROOT, []), "reread");
});
