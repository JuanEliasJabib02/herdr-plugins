// The OAuth token of an account, read-only (D3, D4). Owner: T3. T1 stubs the
// final exports; each throws until T3 fills it. Tokens are never refreshed,
// logged or written anywhere: Claude Code owns them.
//
// - keychainService(configDir): the Keychain item's service name.
//   `Claude Code-credentials` for System default (configDir null), else
//   `Claude Code-credentials-` plus the first 8 hex of sha256(configDir),
//   hashed from the exact string (D2's invariant).
// - readCredentials(configDir): `security find-generic-password -s <item>
//   -a <user> -w` with a 3 s timeout, then <configDir>/.credentials.json when
//   the item is absent (exit 44). Resolves to { accessToken,
//   refreshTokenExpiresAt } or { needsSignIn: true } or { error: "keychain" }.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T3)`), { exitCode: 64 });

export function keychainService(_configDir) {
  throw notYet("keychain.keychainService");
}

export async function readCredentials(_configDir) {
  throw notYet("keychain.readCredentials");
}
