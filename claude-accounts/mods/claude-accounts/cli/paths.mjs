// Where things are (D2, D4, D11). Every path the CLI reads or writes comes
// from here, so the test seams (CLAUDE_ACCOUNTS_HOME, CLAUDE_ACCOUNTS_USAGE_URL,
// CLAUDE_ACCOUNTS_USAGE_BIN) hold everywhere. Each function takes the env, so
// a test can pass its own; the default is the process's.
//
// Config dirs are never built or normalized here: an account's configDir is
// the exact string its Keychain item was hashed from (D2's invariant).
//
// Owner: T2 (final): T1 wrote the first set, T2 added claudeStateFile and
// orcaRoots.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The state folder's entries (D2's table).
export const FILES = Object.freeze({
  accounts: "accounts.json",
  active: "active",
  settings: "settings.json",
  contract: "accounts.v1.json",
  usageState: "usage-state.json",
  restart: "restart.json",
  pendingSwitch: "pending-switch.json",
  live: "live",
  details: "details.json",
  loginLink: "login-link",
  lock: "lock",
});

const userHome = (env) => env.HOME || homedir();

// The state folder: $CLAUDE_ACCOUNTS_HOME, else ~/.config/herdr-app/claude-accounts.
export function stateHome(env = process.env) {
  return env.CLAUDE_ACCOUNTS_HOME || join(userHome(env), ".config", "herdr-app", "claude-accounts");
}

// Where new accounts' config dirs go (<this>/<uuid>/home): beside the state
// folder, outside the folder the mod watches, because Claude writes
// sessions/ there all the time. Beside a test's CLAUDE_ACCOUNTS_HOME too, so
// a test never creates a real profile.
export function profilesHome(env = process.env) {
  return join(dirname(stateHome(env)), "claude-accounts-profiles");
}

// One entry of the state folder: statePath(FILES.restart).
export function statePath(name, env = process.env) {
  return join(stateHome(env), name);
}

// System default's config dir (~/.claude). Its Claude runs with
// CLAUDE_CONFIG_DIR unset, and its sessions/ are here.
export function defaultConfigDir(env = process.env) {
  return join(userHome(env), ".claude");
}

// Claude's state file for a config dir: <configDir>/.claude.json, or
// ~/.claude.json for System default (configDir null). Its oauthAccount names
// the folder's login.
export function claudeStateFile(configDir, env = process.env) {
  return configDir ? join(configDir, ".claude.json") : join(userHome(env), ".claude.json");
}

// Orca's data folders, Orca Dev first (D3). Each may be missing. A root
// holds claude-profiles/<id>/home (the accounts' config dirs, imported in
// place), claude-profiles/selected-host (the selected config dir, empty for
// System default) and profiles/local-default/profile-state.db (its settings).
export function orcaRoots(env = process.env) {
  const support = join(userHome(env), "Library", "Application Support");
  return [join(support, "Orca Dev"), join(support, "Orca")];
}

// The usage endpoint (D4); tests point it at a local server.
export function usageUrl(env = process.env) {
  return env.CLAUDE_ACCOUNTS_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
}

// claude-usage, by absolute path (D11); tests point it at a fake.
export function usageBin(env = process.env) {
  return env.CLAUDE_ACCOUNTS_USAGE_BIN || join(userHome(env), ".local", "bin", "claude-usage");
}

// This CLI's own bin, for the detached runners it spawns (D8, D11):
// spawn(process.execPath, [cliPath(), "restart", "--detach"], …).
export function cliPath() {
  return fileURLToPath(new URL("../bin/claude-accounts", import.meta.url));
}
