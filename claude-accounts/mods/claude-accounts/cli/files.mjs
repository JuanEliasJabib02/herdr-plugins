// The state folder's writes and its lock (D2). Owner: T2. T1 stubs the final
// exports; each throws until T2 fills it.
//
// - withLock(home, fn): runs fn under `mkdir <home>/lock` plus a `pid` file
//   in it, and returns fn's result. A lock whose pid is dead, or older than
//   60 s, is removed. Held only to claim and to merge: never across the
//   Keychain, the network or a terminal's wait.
// - writeAtomic(path, text): a tmp file in the same folder, then a rename.
// - readJson(path): the parsed file, or null when it doesn't exist. A file
//   that doesn't parse throws a clear error and is never overwritten.
// - rebuildContract(home): rebuilds accounts.v1.json (D9) from accounts.json
//   and `active`, plus usage.contractUsage(home, account) for each account.
//   It skips the rename when the result is byte-equal to the file, so a merge
//   that changes nothing fires no watch event. It never parses
//   usage-state.json itself.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T2)`), { exitCode: 64 });

export async function withLock(_home, _fn) {
  throw notYet("files.withLock");
}

export async function writeAtomic(_path, _text) {
  throw notYet("files.writeAtomic");
}

export async function readJson(_path) {
  throw notYet("files.readJson");
}

export async function rebuildContract(_home) {
  throw notYet("files.rebuildContract");
}
