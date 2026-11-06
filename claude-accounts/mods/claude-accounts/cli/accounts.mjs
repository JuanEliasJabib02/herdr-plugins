// The accounts (D3): the registry, System default, the Orca import, sign-in
// and the switch. Owner: T2.
//
// Commands (args = what follows the command's name; each parses its own
// flags with node:util parseArgs, strict, and takes --json):
//   list                            the accounts and the active one: --json
//                                   prints accounts.v1.json, rebuilt (D9)
//   use <id|default>                writes `active`, then restart.afterUse
//   remove <id>                     the registry entry; the folder only for source "herdr"
//   login <id|new|default> [--link] claude auth login in this tab (D3, D13)
//   import-orca                     Orca's profiles, again (D3)
//   settings [set switchMode <v>]   ask | restart | keep
//
// The registry (accounts.json) is created on first use: every command that
// reads it, knownAccounts included, imports Orca's accounts first when the
// file doesn't exist, and seeds `active` and settings.json from Orca.
//
// knownAccounts(home): { active: "<id>" | "default", activeConfigDir,
// accounts: [...] }, System default first, then the registry in its order.
// T3 and T4 read the accounts through it. Each account: { id, email, org,
// orgUuid (a saved account's as saved, System default's its login's),
// configDir (null for System default, else the exact string),
// lastAuthenticatedAt, source: "orca" | "herdr" | "system", isDefault,
// signedIn (its folder's .claude.json names a login), login (that login:
// { email, org, orgUuid }, or null), signedInAs (a saved account whose folder
// holds another login than the saved one: that login's email, else null,
// D17), duplicateOf (System default only: the saved account saved with the
// same email, else null) }.
//
// readSettings(home): { switchMode }, "ask" when unset (Orca's default).

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { FILES, claudeStateFile, defaultConfigDir, orcaRoots, profilesHome, stateHome } from "./paths.mjs";
import { failure, readJson, rebuildContract, render, withLock, writeAtomic } from "./files.mjs";
import { afterUse } from "./restart.mjs";
import { forgetUsage } from "./usage.mjs";

const execFileP = promisify(execFile);

export const SWITCH_MODES = Object.freeze(["ask", "restart", "keep"]);

// Orca's copy, word for word (main/claude-accounts/claude-account-selection.ts,
// claude-account-registration.ts, shared/claude-sign-in-link.ts), with
// "Orca" swapped for this CLI's name where Orca names itself.
const NEEDS_SIGN_IN = "Sign in to this Claude account again before selecting it.";
const ALREADY_ADDED = "This Claude account is already added.";
const SIGN_IN_FAILED = "Claude sign-in failed. Please try again.";
const NO_EMAIL = "Claude login completed, but claude-accounts could not resolve the account email.";
const FOLDER_IN_USE =
  "claude-accounts couldn't delete this Claude account's folder. Quit any Claude running in this account, then remove it again.";

// ~/.claude entries a new account shares through a symlink, when they exist
// (D3, as Orca's profiles on this Mac have them).
const SHARED_ENTRIES = Object.freeze([
  "transcripts", "tasks", "settings.json", "plans", "scoped-rules", "plugins", "projects",
  "output-styles", "session-env", "agents", "paste-cache", "mcp", "odd", "hooks", "odd-trial.md",
  "shell-snapshots", "commands", "skills", "todos", "history.jsonl", "file-history",
]);

// A new account's CLAUDE.md imports the personal one (Orca's
// CLAUDE_PROFILE_MEMORY_IMPORT).
const MEMORY_IMPORT = "@~/.claude/CLAUDE.md\n";

// What a new account's .claude.json leaves out of ~/.claude.json: Claude's
// logout keys (Orca's CLAUDE_LOGOUT_STATE_KEYS) plus the rest of Orca's
// account-bound state (claude-profile-provisioning.ts isAccountBoundState),
// so a copied Console key or user id never stands in for the new login.
const LOGOUT_STATE_KEYS = [
  "oauthAccount", "additionalModelOptionsCache", "additionalModelOptionsAnsweredAt",
  "additionalModelCostsCache", "modelAccessCache", "orgModelDefaultCache", "cachedArtifactRoster",
  "artifactRosterDenied", "lastSeenOrgDefaultUpdatedAt", "clientDataCache", "clientDataCacheSlots",
  "autoCompactWindowsCache", "cachedUsageUtilization", "metricsStatusCache",
  "metricsStatusCacheByPrincipal", "githubWebConnectionStatusCache", "startupPrefetchedAt",
  "subscriptionNoticeCount", "hasAvailableSubscription",
];
const ACCOUNT_BOUND_KEYS = new Set([
  ...LOGOUT_STATE_KEYS,
  "userID", "machineID", "firstStartTime", "firstStartVersion", "primaryApiKey", "claudeCodeFirstTokenDate",
]);
const isAccountBound = (key) =>
  ACCOUNT_BOUND_KEYS.has(key) || key.includes("Cache") || key.startsWith("cached") || key.startsWith("passes");

// D13: the BROWSER helper Claude hands its one-click link to (Orca's
// claude-sign-in-browser.ts), polled every 250 ms for up to 60 s.
const BROWSER_HELPER = `#!/bin/sh\nprintf '%s' "$1" > "$0.tmp" && mv "$0.tmp" "$0.link"\n`;
const LINK_POLL_MS = 250;
const LINK_WAIT_MS = 60_000;

// ── Small helpers ───────────────────────────────────────────────────────────

const usageError = (text) => failure(`usage: claude-accounts ${text}`, 64);
const unknownAccount = (id) => failure(`unknown account "${id}"`, 7);
const say = (text) => process.stderr.write(`${text}\n`);

function print(json, value, human) {
  process.stdout.write(json ? render(value) : `${human}\n`);
}

// A trimmed non-empty string, else null (Orca's `text` schema).
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
export const sameEmail = (a, b) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
// Orca's isSameClaudeLogin: missing organization ids permit an email-only match.
export const sameLogin = (a, b) =>
  sameEmail(a?.email, b?.email) && (!a.orgUuid || !b.orgUuid || a.orgUuid === b.orgUuid);

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// The login a config dir's .claude.json names (System default's for null):
// { email, org, orgUuid }, or null when there's none or it can't be read.
export function folderLogin(configDir, env = process.env) {
  let state;
  try {
    state = JSON.parse(readFileSync(claudeStateFile(configDir, env), "utf8"));
  } catch {
    return null;
  }
  const account = state?.oauthAccount;
  const email = text(account?.emailAddress);
  return email ? { email, org: text(account.organizationName), orgUuid: text(account.organizationUuid) } : null;
}

// ── The state folder's files ────────────────────────────────────────────────

const pathOf = (home, name) => join(home, name);

async function readRegistry(home) {
  const path = pathOf(home, FILES.accounts);
  const list = await readJson(path);
  if (list === null) return null;
  if (!Array.isArray(list) || !list.every((a) => a && typeof a === "object" && typeof a.id === "string")) {
    throw failure(`${path} is not a list of accounts ([{id, email, ...}]). Fix it or move it away: claude-accounts never overwrites it.`);
  }
  return list;
}

// `active`: the exact config dir, "" for System default. A trailing newline
// (a hand edit) is not part of it, as the launcher reads it (D6).
async function readActive(home) {
  const raw = await readFile(pathOf(home, FILES.active), "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw failure(`${pathOf(home, FILES.active)} can't be read (${e.code ?? e.message})`);
  });
  return raw.replace(/\r?\n$/, "");
}

export async function readSettings(home = stateHome()) {
  const path = pathOf(home, FILES.settings);
  const value = (await readJson(path)) ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw failure(`${path} is not an object ({"switchMode": ...}). Fix it or move it away: claude-accounts never overwrites it.`);
  }
  return { switchMode: SWITCH_MODES.includes(value.switchMode) ? value.switchMode : "ask" };
}

// ── Orca (D3) ───────────────────────────────────────────────────────────────

// Orca's settings document, read-only, or null when the DB is missing or
// unreadable. The URI escapes only what SQLite's URI parser would eat.
async function readOrcaSettings(db) {
  if (!existsSync(db)) return null;
  const uri = `file:${db.replace(/[%?#]/g, (c) => encodeURIComponent(c))}?mode=ro`;
  try {
    const { stdout } = await execFileP(
      "/usr/bin/sqlite3",
      ["-cmd", ".timeout 2000", uri, "select payload from profile_state_documents where domain='settings'"],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
    );
    const value = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// What Orca has: { accounts: [registry entries, source "orca"], active:
// "<config dir>" | "", switchMode }. Nothing is moved or written.
//   - Folders: <root>/claude-profiles/<id>/home, for Orca Dev then Orca.
//   - With a readable DB, its claudeManagedAccounts rows (Orca's order) whose
//     folder exists; a folder Orca doesn't list isn't an account.
//   - Without one, every folder whose .claude.json names a login, no date.
//   - active: the DB's activeClaudeManagedAccountId when it names an
//     imported account, else claude-profiles/selected-host when it does,
//     else System default. switchMode: claudeAccountSwitchRunningSessions,
//     else Orca's default, ask.
async function readOrca(env) {
  const accounts = [];
  let active;
  let switchMode;
  for (const root of orcaRoots(env)) {
    const profiles = join(root, "claude-profiles");
    let entries;
    try {
      entries = await readdir(profiles, { withFileTypes: true });
    } catch {
      continue;
    }
    const folders = new Map(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => [e.name, join(profiles, e.name, "home")])
        .filter(([, dir]) => isDir(dir)),
    );
    const settings = await readOrcaSettings(join(root, "profiles", "local-default", "profile-state.db"));
    const rows = Array.isArray(settings?.claudeManagedAccounts) ? settings.claudeManagedAccounts : null;
    const found = [];
    if (rows) {
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || !folders.has(row.id)) continue;
        if (row.managedAuthRuntime && row.managedAuthRuntime !== "host") continue;
        const configDir = folders.get(row.id);
        const login = text(row.email) ? null : folderLogin(configDir, env);
        const email = text(row.email) ?? login?.email;
        if (!email) continue;
        found.push({
          id: row.id,
          email,
          org: text(row.organizationName) ?? login?.org ?? null,
          orgUuid: text(row.organizationUuid) ?? login?.orgUuid ?? null,
          configDir,
          lastAuthenticatedAt: Number.isFinite(row.lastAuthenticatedAt) ? row.lastAuthenticatedAt : null,
          source: "orca",
        });
      }
    } else {
      for (const [id, configDir] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
        const login = folderLogin(configDir, env);
        if (!login) continue;
        found.push({ id, email: login.email, org: login.org, orgUuid: login.orgUuid, configDir, lastAuthenticatedAt: null, source: "orca" });
      }
    }
    for (const account of found) if (!accounts.some((a) => a.id === account.id)) accounts.push(account);
    if (active === undefined) {
      const wanted = settings?.activeClaudeManagedAccountId;
      const pointer = await readFile(join(profiles, "selected-host"), "utf8").then((t) => t.replace(/\r?\n$/, ""), () => "");
      const pick =
        (typeof wanted === "string" ? found.find((a) => a.id === wanted) : undefined) ??
        (pointer ? found.find((a) => a.configDir === pointer || a.id === pointer) : undefined);
      if (pick) active = pick.configDir;
    }
    const mode = settings?.claudeAccountSwitchRunningSessions;
    if (switchMode === undefined && SWITCH_MODES.includes(mode)) switchMode = mode;
  }
  return { accounts, active: active ?? "", switchMode: switchMode ?? "ask" };
}

// The first run (D3): when accounts.json doesn't exist, Orca's accounts
// become the registry, and its selection and switch setting seed `active`
// and settings.json. accounts.json is written last: it marks the run done.
// Returns what was imported, or null when the registry already existed.
async function ensureRegistry(home, env = process.env) {
  const registry = pathOf(home, FILES.accounts);
  if (existsSync(registry)) return null;
  const orca = await readOrca(env);
  return withLock(home, async () => {
    if (existsSync(registry)) return null;
    await writeAtomic(pathOf(home, FILES.active), orca.active);
    await writeAtomic(pathOf(home, FILES.settings), render({ switchMode: orca.switchMode }));
    await writeAtomic(registry, render(orca.accounts));
    return orca;
  });
}

// ── The accounts ────────────────────────────────────────────────────────────

export async function knownAccounts(home = stateHome(), env = process.env) {
  await ensureRegistry(home, env);
  const registry = (await readRegistry(home)) ?? [];
  const activeConfigDir = await readActive(home);
  const saved = registry.map((a) => {
    const configDir = typeof a.configDir === "string" && a.configDir ? a.configDir : null;
    const login = configDir ? folderLogin(configDir, env) : null;
    const email = text(a.email);
    const orgUuid = text(a.orgUuid);
    return {
      id: a.id,
      email,
      org: text(a.org),
      orgUuid,
      configDir,
      lastAuthenticatedAt: Number.isFinite(a.lastAuthenticatedAt) ? a.lastAuthenticatedAt : null,
      // Anything but "herdr" keeps its folder on remove.
      source: a.source === "herdr" ? "herdr" : "orca",
      isDefault: false,
      signedIn: Boolean(login),
      login,
      // A /login in a Claude running on the folder changes who it's signed in
      // as without telling anyone. The account keeps its name, this says who's
      // there now, and it needs a sign-in (D17).
      signedInAs: login && email && !sameLogin(login, { email, orgUuid }) ? login.email : null,
      duplicateOf: null,
    };
  });
  const system = folderLogin(null, env);
  // Orca's notice (accounts-pane-claude-section.tsx): System default is
  // signed in as an email a saved account also has.
  const duplicate = system ? saved.find((a) => sameEmail(a.email, system.email)) : undefined;
  const systemDefault = {
    id: "default",
    email: system?.email ?? null,
    org: system?.org ?? null,
    orgUuid: system?.orgUuid ?? null,
    configDir: null,
    lastAuthenticatedAt: null,
    source: "system",
    isDefault: true,
    signedIn: Boolean(system),
    login: system,
    signedInAs: null,
    duplicateOf: duplicate?.id ?? null,
  };
  // A config dir no saved account has reads as System default.
  const active = activeConfigDir ? (saved.find((a) => a.configDir === activeConfigDir)?.id ?? "default") : "default";
  return { active, activeConfigDir, accounts: [systemDefault, ...saved] };
}

// ── list ────────────────────────────────────────────────────────────────────

export async function list(args) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const doc = await rebuildContract(stateHome());
  const lines = doc.accounts.map((a) => {
    const mark = a.id === doc.active ? "*" : " ";
    const about = [a.isDefault ? a.email : a.org, a.needsSignIn ? "needs sign-in" : null].filter(Boolean).join(", ");
    return `${mark} ${a.label}${about ? `  (${about})` : ""}${a.isDefault ? "" : `  ${a.id}`}`;
  });
  const systemDefault = doc.accounts.find((a) => a.isDefault);
  if (systemDefault?.duplicateOf) {
    lines.push(`System default is signed in as ${systemDefault.email}, which is also a saved account.`);
  }
  print(values.json, doc, lines.join("\n"));
  return 0;
}

// ── use ─────────────────────────────────────────────────────────────────────

// Writes `active` under the lock (the exact configDir string, empty for
// System default) and rebuilds accounts.v1.json. Returns { from, to }, the
// previous and the new account ids.
async function writeActive(target) {
  const home = stateHome();
  return withLock(home, async () => {
    const known = await knownAccounts(home);
    const account = known.accounts.find((a) => a.id === target);
    if (!account) throw unknownAccount(target);
    // Orca refuses a saved account whose folder holds no login; here one that
    // holds someone else's too (D17).
    if (!account.isDefault && (!account.signedIn || account.signedInAs)) throw failure(NEEDS_SIGN_IN, 5);
    const next = account.configDir ?? "";
    if (next !== known.activeConfigDir) {
      await writeAtomic(pathOf(home, FILES.active), next);
      await rebuildContract(home);
    }
    return { from: known.active, to: account.id };
  });
}

export async function use(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true, allowPositionals: true });
  if (positionals.length !== 1) throw usageError("use <id|default>");
  const { from, to } = await writeActive(positionals[0]);
  // The terminals still on `from` follow settings.switchMode (D8, T4).
  if (from !== to) await afterUse(from, to);
  const { switchMode } = await readSettings(stateHome());
  print(values.json, { from, to, switchMode }, from === to ? `Already on ${to}.` : `Switched from ${from} to ${to}.`);
  return 0;
}

// ── remove ──────────────────────────────────────────────────────────────────

// The folder `login new` made for an account: <profiles>/<uuid>, when its
// config dir is <profiles>/<uuid>/home. Anything else is never deleted.
function ownFolder(configDir, env) {
  if (!configDir || basename(configDir) !== "home") return null;
  const folder = dirname(configDir);
  return dirname(folder) === profilesHome(env) && /^[0-9a-f-]{36}$/i.test(basename(folder)) ? folder : null;
}

// As Orca does: deselect first, so no new Claude starts there; then delete
// the folder (a source "herdr" one only), keeping the entry when that fails
// so the remove can be retried; then drop the entry.
export async function remove(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true, allowPositionals: true });
  if (positionals.length !== 1) throw usageError("remove <id>");
  const [id] = positionals;
  if (id === "default") throw usageError("remove <id>: System default can't be removed");
  const home = stateHome();
  const account = await withLock(home, async () => {
    const known = await knownAccounts(home);
    const found = known.accounts.find((a) => a.id === id && !a.isDefault);
    if (!found) throw unknownAccount(id);
    if (known.active === id) {
      await writeAtomic(pathOf(home, FILES.active), "");
      await rebuildContract(home);
    }
    return found;
  });
  const folder = account.source === "herdr" ? ownFolder(account.configDir, process.env) : null;
  if (folder) {
    try {
      await rm(folder, { recursive: true, force: true });
    } catch {
      throw failure(FOLDER_IN_USE);
    }
  }
  const doc = await withLock(home, async () => {
    const registry = (await readRegistry(home)) ?? [];
    await writeAtomic(pathOf(home, FILES.accounts), render(registry.filter((a) => a.id !== id)));
    return rebuildContract(home);
  });
  print(values.json, { removed: id, active: doc.active, folderDeleted: Boolean(folder) }, `Removed ${account.email ?? id}.`);
  return 0;
}

// ── settings ────────────────────────────────────────────────────────────────

export async function settings(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true, allowPositionals: true });
  const home = stateHome();
  if (positionals.length === 0) {
    await ensureRegistry(home);
    const current = await readSettings(home);
    print(values.json, current, `switchMode: ${current.switchMode}`);
    return 0;
  }
  const [verb, key, mode] = positionals;
  if (positionals.length !== 3 || verb !== "set" || key !== "switchMode" || !SWITCH_MODES.includes(mode)) {
    throw usageError(`settings [set switchMode ${SWITCH_MODES.join("|")}]`);
  }
  // The first run seeds settings.json from Orca, so it comes before the set.
  await ensureRegistry(home);
  await withLock(home, async () => {
    const path = pathOf(home, FILES.settings);
    const current = (await readJson(path)) ?? {};
    if (typeof current !== "object" || Array.isArray(current)) {
      throw failure(`${path} is not an object ({"switchMode": ...}). Fix it or move it away: claude-accounts never overwrites it.`);
    }
    await writeAtomic(path, render({ ...current, switchMode: mode }));
  });
  print(values.json, { switchMode: mode }, `switchMode: ${mode}`);
  return 0;
}

// ── import-orca ─────────────────────────────────────────────────────────────

// Again, on demand: Orca's accounts the registry lacks are added, and the
// ones it has get Orca's email, org and date. `active`, settings.json and
// every config dir stay as they are; nothing is removed.
export async function importOrca(args) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const home = stateHome();
  const seeded = await ensureRegistry(home);
  let result;
  if (seeded) {
    result = { added: seeded.accounts.map((a) => a.id), updated: [] };
  } else {
    const orca = await readOrca(process.env);
    result = await withLock(home, async () => {
      const registry = (await readRegistry(home)) ?? [];
      const added = [];
      const updated = [];
      for (const account of orca.accounts) {
        const i = registry.findIndex((a) => a.id === account.id);
        if (i < 0) {
          registry.push(account);
          added.push(account.id);
          continue;
        }
        const next = {
          ...registry[i],
          email: account.email,
          org: account.org,
          orgUuid: account.orgUuid,
          lastAuthenticatedAt: account.lastAuthenticatedAt ?? registry[i].lastAuthenticatedAt ?? null,
        };
        if (JSON.stringify(next) !== JSON.stringify(registry[i])) {
          registry[i] = next;
          updated.push(account.id);
        }
      }
      if (added.length || updated.length) await writeAtomic(pathOf(home, FILES.accounts), render(registry));
      return { added, updated };
    });
  }
  await rebuildContract(home);
  print(values.json, result, `Imported from Orca: ${result.added.length} added, ${result.updated.length} updated.`);
  return 0;
}

// ── login (D3, D13) ─────────────────────────────────────────────────────────

// A new account's folder, set up as Orca's claude-profile-provisioning.ts
// does: links to the shared ~/.claude entries that exist, CLAUDE.md
// importing the personal one, and ~/.claude.json minus account-bound state.
// sessions/ and the login stay the account's own.
async function provision(configDir, env) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const personal = defaultConfigDir(env);
  for (const name of SHARED_ENTRIES) {
    const source = join(personal, name);
    if (existsSync(source)) await symlink(source, join(configDir, name));
  }
  if (existsSync(join(personal, "CLAUDE.md"))) await writeFile(join(configDir, "CLAUDE.md"), MEMORY_IMPORT);
  let state = null;
  try {
    state = JSON.parse(readFileSync(claudeStateFile(null, env), "utf8"));
  } catch {
    // No personal state (or an unreadable one): Claude starts this one fresh.
  }
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const shared = Object.fromEntries(Object.entries(state).filter(([key]) => !isAccountBound(key)));
    await writeFile(join(configDir, ".claude.json"), render(shared), { mode: 0o600 });
  }
}

// Orca's isClaudeLocalSignInLink: https on claude.com or claude.ai, with a
// redirect_uri on http://localhost or 127.0.0.1 (the one-click flow).
export function isClaudeLocalSignInLink(link) {
  try {
    const url = new URL(link);
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      url.protocol === "https:" &&
      ["claude.com", "claude.ai"].includes(url.hostname) &&
      redirect.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(redirect.hostname)
    );
  } catch {
    return false;
  }
}

async function prepareBrowser() {
  const dir = await mkdtemp(join(tmpdir(), "claude-accounts-link-"));
  const path = join(dir, "browser");
  await writeFile(path, BROWSER_HELPER, { mode: 0o700 });
  return { dir, path, linkPath: `${path}.link` };
}

// Waits for the link Claude hands BROWSER, while Claude runs, up to 60 s. A
// valid one goes to the state folder's login-link (the footer copies it);
// any other is dropped.
async function captureLink(browser, home, running) {
  const deadline = Date.now() + LINK_WAIT_MS;
  while (running() && Date.now() < deadline) {
    const link = await readFile(browser.linkPath, "utf8").then((t) => t.trim(), () => null);
    if (link !== null) {
      if (isClaudeLocalSignInLink(link)) {
        await writeAtomic(pathOf(home, FILES.loginLink), link, { mode: 0o600 });
        return;
      }
      say("claude-accounts: Claude handed BROWSER an unexpected sign-in link; it wasn't kept.");
      return;
    }
    await sleep(LINK_POLL_MS);
  }
}

// Runs the real `claude auth login --claudeai` in this terminal on a config
// dir (null: System default, CLAUDE_CONFIG_DIR unset). Resolves to
// { code, signal, error, cancelled }. Closing the tab or Ctrl+C cancels:
// Claude is stopped and `cleanup` runs right away.
async function runLogin({ configDir, link, home, cleanup }) {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  // Should `claude` resolve to the launcher (D6), its rule 1 keeps this dir.
  env.CLAUDE_ACCOUNTS_DIR = configDir ?? "";
  const browser = link ? await prepareBrowser() : null;
  if (browser) {
    env.BROWSER = browser.path;
    await rm(pathOf(home, FILES.loginLink), { force: true });
  }
  let exited = false;
  let cancelled = false;
  const child = spawn("claude", ["auth", "login", "--claudeai"], { stdio: "inherit", env });
  const onSignal = (signal) => {
    cancelled = true;
    try {
      child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    } catch {
      // Already gone.
    }
    cleanup();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  }).then((r) => {
    exited = true;
    return r;
  });
  const capture = browser ? captureLink(browser, home, () => !exited) : Promise.resolve();
  try {
    const result = await done;
    await capture;
    return { ...result, cancelled };
  } finally {
    for (const s of signals) process.off(s, onSignal);
    if (browser) {
      await rm(browser.dir, { recursive: true, force: true });
      await rm(pathOf(home, FILES.loginLink), { force: true });
    }
  }
}

export async function login(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { link: { type: "boolean" }, json: { type: "boolean" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw usageError("login <id|new|default> [--link]");
  const [target] = positionals;
  const home = stateHome();
  const env = process.env;
  const known = await knownAccounts(home);

  let account;
  let staging = null;
  if (target === "new") {
    const id = randomUUID();
    staging = join(profilesHome(env), id);
    account = { id, configDir: join(staging, "home"), isDefault: false, isNew: true };
  } else {
    account = known.accounts.find((a) => a.id === target);
    if (!account) throw unknownAccount(target);
  }
  let registered = false;
  const dropStaging = () => {
    if (staging && !registered) rmSync(staging, { recursive: true, force: true });
  };

  try {
    if (staging) await provision(account.configDir, env);
    const result = await runLogin({ configDir: account.configDir, link: values.link, home, cleanup: dropStaging });
    if (result.error) {
      throw failure(result.error.code === "ENOENT" ? "claude isn't on the PATH." : `${SIGN_IN_FAILED} (${result.error.message})`);
    }
    if (result.cancelled || result.signal) throw failure("Sign-in cancelled.", 130);
    if (result.code !== 0) throw failure(SIGN_IN_FAILED);
    const signedIn = folderLogin(account.configDir, env);
    if (!signedIn) throw failure(NO_EMAIL);

    await withLock(home, async () => {
      if (account.isDefault) {
        await forgetUsage(home, account.id);
        return rebuildContract(home);
      }
      const registry = (await readRegistry(home)) ?? [];
      const now = Date.now();
      if (account.isNew) {
        // Orca's findDuplicateClaudeAccount: same email and same org.
        const duplicate = registry.find(
          (a) => sameEmail(a.email, signedIn.email) && (text(a.orgUuid) ?? null) === (signedIn.orgUuid ?? null),
        );
        if (duplicate) throw failure(ALREADY_ADDED);
        registry.push({
          id: account.id,
          email: signedIn.email,
          org: signedIn.org,
          orgUuid: signedIn.orgUuid,
          configDir: account.configDir,
          lastAuthenticatedAt: now,
          source: "herdr",
        });
      } else {
        const i = registry.findIndex((a) => a.id === account.id);
        if (i < 0) throw failure(`account "${account.id}" was removed while it signed in`, 7);
        registry[i] = { ...registry[i], email: signedIn.email, org: signedIn.org, orgUuid: signedIn.orgUuid, lastAuthenticatedAt: now };
      }
      await writeAtomic(pathOf(home, FILES.accounts), render(registry));
      registered = true;
      // Whatever was read before this sign-in may be another login's.
      if (!account.isNew) await forgetUsage(home, account.id);
      return rebuildContract(home);
    });
    print(
      values.json,
      { account: account.id, email: signedIn.email, org: signedIn.org },
      `Signed in as ${signedIn.email}${signedIn.org ? ` (${signedIn.org})` : ""}.`,
    );
    return 0;
  } finally {
    dropStaging();
  }
}
