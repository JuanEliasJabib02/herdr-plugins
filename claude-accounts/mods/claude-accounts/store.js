// The CLI's files, as the mod reads them (D1, D2). Pure: no herdr or gpui-kit
// import, so `node --test` loads it. The views read a file's text with
// herdr's readTextFile (null when it's absent) and hand it to a reader here.
// The mod never writes these files: it calls the CLI.
//
// Final and frozen (T11): a later task puts its own helpers in its own
// *-model.js (D1).
//
// Readers, written against D2's pinned shapes and test/fixtures/, each
// tolerant of a missing (null), corrupt or partial file. Each always returns
// the same shape: a field that's missing or of the wrong type gets its empty
// value (null, false, [] or the default), so the views never check types.
// Fields a reader doesn't know are kept as written, so a field the CLI adds
// later (D9: adding fields keeps version 1) still reaches the views.
//   readAccounts(text)       accounts.v1.json (D9)
//   readSettings(text)       settings.json     { switchMode }
//   readRestart(text)        restart.json      { items: [...] }
//   readPendingSwitch(text)  pending-switch.json, or null
//   readDetails(text)        details.json      { ranges: {...} }
//   readLoginLink(text)      login-link, a URL or null
// classifyWatchPaths(root, paths): what a watchFolder batch on the state
// folder asks for. "merge" when it holds the root itself (herdr.d.ts: a
// batch holding the root means refresh everything) or any path under live/;
// else "reread".

// This mod's folder name under mods/, for openOverlay.
export const MOD = "claude-accounts";

// The state folder's entries the mod reads (cli/paths.mjs FILES).
export const FILES = Object.freeze({
  contract: "accounts.v1.json",
  settings: "settings.json",
  restart: "restart.json",
  pendingSwitch: "pending-switch.json",
  details: "details.json",
  loginLink: "login-link",
  live: "live",
});

// The state folder: the CLI's default, ~/.config/herdr-app/claude-accounts
// (the mod can't see CLAUDE_ACCOUNTS_HOME). Pass herdr's home().
export function stateDir(homeDir) {
  return `${homeDir}/.config/herdr-app/claude-accounts`;
}

// The installed CLI, inside this mod's folder. Pass herdr's appHome().
export function cliPath(appHomeDir) {
  return `${appHomeDir}/mods/${MOD}/bin/claude-accounts`;
}

// ── Values ─────────────────────────────────────────────────────────────────

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const num = (v) => (isNumber(v) ? v : null);
const oneOf = (values, v) => (values.includes(v) ? v : null);

// A file's text as an object, or null: no file, not JSON, or not an object.
// An object already parsed is taken as it is.
function parseObject(text) {
  if (isObject(text)) return text;
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

// ── accounts.v1.json (D9) ──────────────────────────────────────────────────
// { version: 1, updatedAt, active: "<id>"|"default", accounts: [account] }
// account: { id, label, email, org, configDir, isDefault, needsSignIn, error,
//   usage: { session, weekly, fable, monthly } each { percent, resetsAt } or
//   null, credits: { balance, limit } or null, usageUpdatedAt,
//   lastAuthenticatedAt, signedInAs }
// A file of a later version (renamed or removed fields, D9) reads as no
// file. An entry without an id is dropped. `error` is D4's enum: any other
// value reads "unavailable", as D9 tells readers to. A percent is clamped to
// 0–100 and rounded; a window without one is null. configDir is the exact
// string, never normalized (D2's invariant).

const ERRORS = ["expired", "rateLimited", "keychain", "network", "refreshFailed", "noSubscription", "unavailable"];
const WINDOWS = ["session", "weekly", "fable", "monthly"];

function readWindow(w) {
  if (!isObject(w) || !isNumber(w.percent)) return null;
  return { ...w, percent: Math.max(0, Math.min(100, Math.round(w.percent))), resetsAt: num(w.resetsAt) };
}

function readCredits(c) {
  if (!isObject(c)) return null;
  const balance = num(c.balance);
  const limit = num(c.limit);
  return balance === null && limit === null ? null : { ...c, balance, limit };
}

function readAccount(a) {
  if (!isObject(a) || !str(a.id)) return null;
  const isDefault = a.isDefault === true || a.id === "default";
  const email = str(a.email);
  const usage = isObject(a.usage) ? a.usage : {};
  return {
    ...a,
    id: a.id,
    label: str(a.label) ?? email ?? (isDefault ? "System default" : a.id),
    email,
    org: str(a.org),
    configDir: str(a.configDir),
    isDefault,
    needsSignIn: a.needsSignIn === true,
    error: a.error === null || a.error === undefined ? null : (oneOf(ERRORS, a.error) ?? "unavailable"),
    usage: Object.fromEntries(WINDOWS.map((k) => [k, readWindow(usage[k])])),
    credits: readCredits(a.credits),
    usageUpdatedAt: num(a.usageUpdatedAt),
    lastAuthenticatedAt: num(a.lastAuthenticatedAt),
    signedInAs: str(a.signedInAs),
  };
}

export function readAccounts(text) {
  const raw = parseObject(text);
  if (!raw || (raw.version !== undefined && raw.version !== 1)) {
    return { version: 1, updatedAt: null, active: "default", accounts: [] };
  }
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map(readAccount).filter(Boolean) : [];
  return { ...raw, version: 1, updatedAt: num(raw.updatedAt), active: str(raw.active) ?? "default", accounts };
}

// ── settings.json ──────────────────────────────────────────────────────────
// { switchMode: "ask"|"restart"|"keep" }: no file, or any other value, is
// Orca's default, "ask" (D3).

const SWITCH_MODES = ["ask", "restart", "keep"];

export function readSettings(text) {
  const raw = parseObject(text) ?? {};
  return { ...raw, switchMode: oneOf(SWITCH_MODES, raw.switchMode) ?? "ask" };
}

// ── restart.json (D2, D8, D9) ──────────────────────────────────────────────
// { items: [{ id, kind: "switch"|"resume", terminal, from, to, sessionId,
//   args, message, state, code, detail, claimedBy: { pid, at }|null,
//   updatedAt }] }. An item without an id is dropped; an unknown kind or
// state (D9's enum) reads null, so the views skip it. args keeps its
// strings only.

const KINDS = ["switch", "resume"];
const STATES = [
  "queued", "waitingIdle", "stopping", "starting", "sending",
  "done", "timeout", "landedElsewhere", "failed", "cancelled",
];

function readClaim(c) {
  return isObject(c) && isNumber(c.pid) && isNumber(c.at) ? { pid: c.pid, at: c.at } : null;
}

function readItem(i) {
  if (!isObject(i) || !str(i.id)) return null;
  return {
    ...i,
    id: i.id,
    kind: oneOf(KINDS, i.kind),
    terminal: str(i.terminal),
    from: str(i.from),
    to: str(i.to),
    sessionId: str(i.sessionId),
    args: Array.isArray(i.args) ? i.args.filter((a) => typeof a === "string") : [],
    message: str(i.message),
    state: oneOf(STATES, i.state),
    code: Number.isInteger(i.code) ? i.code : null,
    detail: str(i.detail),
    claimedBy: readClaim(i.claimedBy),
    updatedAt: num(i.updatedAt),
  };
}

export function readRestart(text) {
  const raw = parseObject(text) ?? {};
  return { ...raw, items: Array.isArray(raw.items) ? raw.items.map(readItem).filter(Boolean) : [] };
}

// ── pending-switch.json (D2, D8) ───────────────────────────────────────────
// { from, to, at, sessions: [{ terminal, title, account, group, reason }] },
// or null when no Ask is waiting: no file, or no target account. A session
// without a terminal is dropped; an unknown group reads "cantMove", so it is
// never ticked nor restarted.

const GROUPS = ["onAccount", "elsewhere", "cantMove"];

function readSession(s) {
  if (!isObject(s) || !str(s.terminal)) return null;
  return {
    ...s,
    terminal: s.terminal,
    title: str(s.title),
    account: str(s.account),
    group: oneOf(GROUPS, s.group) ?? "cantMove",
    reason: str(s.reason),
  };
}

export function readPendingSwitch(text) {
  const raw = parseObject(text);
  if (!raw || !str(raw.to)) return null;
  return {
    ...raw,
    from: str(raw.from),
    to: raw.to,
    at: num(raw.at),
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map(readSession).filter(Boolean) : [],
  };
}

// ── details.json (D2, D11) ─────────────────────────────────────────────────
// { ranges: { "7"|"30"|"90"|"all": { result, running, startedAt, finishedAt,
//   error } } }: always the four ranges, a missing one never run, any other
// dropped. result is claude-usage --json's object as written (its shape is
// claude-usage's, read by the details view), or null.

const RANGES = ["7", "30", "90", "all"];

function readRange(r) {
  const raw = isObject(r) ? r : {};
  return {
    ...raw,
    result: isObject(raw.result) ? raw.result : null,
    running: raw.running === true,
    startedAt: num(raw.startedAt),
    finishedAt: num(raw.finishedAt),
    error: str(raw.error),
  };
}

export function readDetails(text) {
  const raw = parseObject(text) ?? {};
  const ranges = isObject(raw.ranges) ? raw.ranges : {};
  return { ...raw, ranges: Object.fromEntries(RANGES.map((k) => [k, readRange(ranges[k])])) };
}

// ── login-link (D13) ───────────────────────────────────────────────────────
// The captured sign-in URL, or null. Only a link that passes Orca's
// isClaudeLocalSignInLink (main/claude-accounts/claude-sign-in-browser.ts:27-40)
// is kept, the same check the CLI's helper makes: https on claude.com or
// claude.ai, whose redirect_uri is http on localhost or 127.0.0.1.

const AUTHORIZE_HOSTS = ["claude.com", "claude.ai"];
const CALLBACK_HOSTS = ["localhost", "127.0.0.1"];

function isClaudeLocalSignInLink(link) {
  try {
    const url = new URL(link);
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      url.protocol === "https:" &&
      AUTHORIZE_HOSTS.includes(url.hostname) &&
      redirect.protocol === "http:" &&
      CALLBACK_HOSTS.includes(redirect.hostname)
    );
  } catch {
    return false;
  }
}

export function readLoginLink(text) {
  const link = typeof text === "string" ? text.trim() : "";
  return link && isClaudeLocalSignInLink(link) ? link : null;
}

// ── The watch (D1) ─────────────────────────────────────────────────────────
// A watchFolder batch on the state folder (absolute paths) → "merge" when it
// holds the root itself, or live/ or anything under it (a statusline drop,
// D16): the footer runs `usage --json`. Anything else → "reread": the footer
// only reads the files again. A batch that isn't a list is read as the root
// (refresh everything).

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function classifyWatchPaths(root, paths) {
  if (!Array.isArray(paths)) return "merge";
  const base = trimSlash(String(root));
  const live = `${base}/${FILES.live}`;
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const path = trimSlash(p);
    if (path === base || path === live || path.startsWith(`${live}/`)) return "merge";
  }
  return "reread";
}
