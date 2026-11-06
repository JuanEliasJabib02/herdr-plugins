// Claude usage per account (D4, D16). Owner: T3. T1 stubs the final exports.
//
//   usage [--refresh] [--account <id>] [--json]
//     Reads each account's token (keychain.mjs), fetches the usage endpoint
//     with the lock released, merges the live/ drops, and rebuilds
//     accounts.v1.json. 15 s timeout. Exits 64 until T3 fills it.
//
// contractUsage(home, account) → { usage, credits, error, needsSignIn,
// usageUpdatedAt }: one account's part of accounts.v1.json (D9), read from
// usage.mjs's own usage-state.json. files.rebuildContract calls it for each
// account and awaits it. The stub has no data yet: all nulls.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T3)`), { exitCode: 64 });

export async function usage(_args) {
  throw notYet();
}

export async function contractUsage(_home, _account) {
  return { usage: null, credits: null, error: null, needsSignIn: null, usageUpdatedAt: null };
}
