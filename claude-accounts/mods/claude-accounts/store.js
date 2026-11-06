// The CLI's files, as the mod reads them (D1, D2). Pure: no herdr or gpui-kit
// import, so `node --test` loads it. The views read a file's text with
// herdr's readTextFile (null when it's absent) and hand it to a reader here.
// The mod never writes these files: it calls the CLI.
//
// Owner: T11, which makes it final and tested, then frozen. T1 writes the
// constants and the path helpers final and stubs the readers.
//
// Readers (T11), written against D2's pinned shapes and test/fixtures/, each
// tolerant of a missing (null) or partial file:
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

const notYet = (what) => new Error(`store.${what}: not implemented yet (T11)`);

export function readAccounts(_text) {
  throw notYet("readAccounts");
}

export function readSettings(_text) {
  throw notYet("readSettings");
}

export function readRestart(_text) {
  throw notYet("readRestart");
}

export function readPendingSwitch(_text) {
  throw notYet("readPendingSwitch");
}

export function readDetails(_text) {
  throw notYet("readDetails");
}

export function readLoginLink(_text) {
  throw notYet("readLoginLink");
}

export function classifyWatchPaths(_root, _paths) {
  throw notYet("classifyWatchPaths");
}
