// The accounts (D3): the registry, System default, the Orca import, sign-in
// and the switch. Owner: T2. T1 stubs the final exports: every command exits
// 64 until T2 fills it.
//
// Commands (args = what follows the command's name; each parses its own
// flags with node:util parseArgs, strict, and takes --json):
//   list                            the accounts and the active one
//   use <id|default>                writes `active`, then restart.afterUse
//   remove <id>                     the registry entry; the folder only for source "herdr"
//   login <id|new|default> [--link] claude auth login in this tab (D3, D13)
//   import-orca                     Orca's profiles, again (D3)
//   settings [set switchMode <v>]   ask | restart | keep
//
// knownAccounts(home): { active: "<id>" | "default", accounts: [...] }, the
// registry plus System default ({ id: "default", configDir: null, ... }).
// T3 and T4 read the accounts through it.

import { afterUse } from "./restart.mjs";

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T2)`), { exitCode: 64 });

export async function list(_args) {
  throw notYet();
}

// T2: validates <id|default>, writes `active` under the lock (the exact
// configDir string, empty for System default) and rebuilds accounts.v1.json.
// Returns { from, to }, the previous and the new account ids.
async function writeActive(_args) {
  throw notYet();
}

export async function use(args) {
  const { from, to } = await writeActive(args);
  // The terminals still on `from` follow settings.switchMode (D8, T4).
  await afterUse(from, to);
  return 0;
}

export async function remove(_args) {
  throw notYet();
}

export async function login(_args) {
  throw notYet();
}

export async function importOrca(_args) {
  throw notYet();
}

export async function settings(_args) {
  throw notYet();
}

export async function knownAccounts(_home) {
  throw notYet("accounts.knownAccounts");
}
