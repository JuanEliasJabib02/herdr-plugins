// The state folder's writes and its lock (D2). Owner: T2.
//
// - withLock(home, fn): runs fn under `mkdir <home>/lock` plus a `pid` file
//   in it, and returns fn's result. A lock whose pid is dead, or older than
//   60 s, is removed. Held only to claim and to merge: never across the
//   Keychain, the network or a terminal's wait. It's reentrant within one
//   async flow (a rebuildContract inside a held lock doesn't wait on itself),
//   and two flows of one process still take turns.
// - writeAtomic(path, text, { mode }): a tmp file in the same folder, then a
//   rename, so a reader never sees half a file.
// - readJson(path): the parsed file, or null when it doesn't exist. A file
//   that doesn't parse throws a clear error (exit 1) and is never
//   overwritten: nothing is written after a failed read.
// - rebuildContract(home): rebuilds accounts.v1.json (D9) from accounts.json
//   and `active` (through accounts.knownAccounts), plus
//   usage.contractUsage(home, account) for each account, and returns it. It
//   skips the rename when the result is byte-equal to the file (its
//   updatedAt aside), so a merge that changes nothing fires no watch event;
//   updatedAt moves only when something else does. It never parses
//   usage-state.json itself.
// - failure(message, exitCode = 1): an Error main.mjs prints as one line and
//   exits with.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FILES } from "./paths.mjs";
import { contractUsage } from "./usage.mjs";
import { knownAccounts } from "./accounts.mjs";

// D2: a lock older than this is removed, whoever holds it.
const LOCK_STALE_MS = 60_000;

// An error main.mjs reports as `claude-accounts <command>: <message>` and
// exits with: no stack, the code D9's table gives (1 for any other failure).
export function failure(message, exitCode = 1) {
  return Object.assign(new Error(message), { exitCode });
}

// The locks the current async flow holds, so a nested withLock re-enters.
const held = new AsyncLocalStorage();

export async function withLock(home, fn) {
  const lock = join(home, FILES.lock);
  if (held.getStore()?.has(lock)) return fn();
  await mkdir(home, { recursive: true });
  const token = await acquire(lock);
  try {
    return await held.run(new Set([...(held.getStore() ?? []), lock]), fn);
  } finally {
    await release(lock, token);
  }
}

// The pid file holds the pid, then a token of this hold: readers take the
// pid with parseInt, and release() removes only its own lock.
async function acquire(lock) {
  const token = `${process.pid}\n${randomUUID()}\n`;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "pid"), token);
      return token;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const owner = await lockOwner(lock);
    if (owner && isStale(owner)) await breakLock(lock, owner);
    else await sleep(10 + Math.random() * 30);
  }
}

async function release(lock, token) {
  const mine = await readFile(join(lock, "pid"), "utf8").catch(() => null);
  if (mine === token) await rm(lock, { recursive: true, force: true });
}

// Who holds a lock: its pid file's text and the folder's age. Null when the
// lock is gone. A pid file not written yet reads as "" (a fresh lock).
async function lockOwner(lock) {
  const [text, st] = await Promise.all([
    readFile(join(lock, "pid"), "utf8").catch(() => ""),
    stat(lock).catch(() => null),
  ]);
  return st ? { text, pid: Number.parseInt(text, 10), at: st.mtimeMs } : null;
}

function isStale(owner) {
  if (Date.now() - owner.at > LOCK_STALE_MS) return true;
  return Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Moves the stale lock aside (one rename, so only one breaker wins it), then
// checks it's the one judged stale: a lock taken in between is put back.
async function breakLock(lock, owner) {
  const aside = `${lock}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(lock, aside);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const moved = await lockOwner(aside);
  if (moved && moved.text !== owner.text) {
    try {
      await rename(aside, lock);
      return;
    } catch {
      // The name was taken again meanwhile; the moved lock's holder will
      // find its pid file gone and release nothing.
    }
  }
  await rm(aside, { recursive: true, force: true });
}

export async function writeAtomic(path, text, { mode } = {}) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, text, mode === undefined ? {} : { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw failure(`${path} can't be read (${e.code ?? e.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw failure(`${path} is not valid JSON (${e.message}). Fix it or move it away: claude-accounts never overwrites it.`);
  }
}

// The way every JSON state file is written: two-space indent, a newline.
export const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

const WINDOWS = ["session", "weekly", "fable", "monthly"];

// One account of accounts.v1.json, in CONTRACT.md's field order.
function contractAccount(account, usage) {
  const u = usage ?? {};
  return {
    id: account.id,
    label: account.isDefault ? "System default" : (account.email ?? account.id),
    email: account.email ?? null,
    org: account.org ?? null,
    configDir: account.isDefault ? null : (account.configDir ?? null),
    isDefault: account.isDefault === true,
    // A folder with no login needs one whatever usage says (Orca's rule).
    needsSignIn: account.signedIn !== true || u.needsSignIn === true,
    error: u.error ?? null,
    errorDetail: u.errorDetail ?? null,
    usage: Object.fromEntries(WINDOWS.map((w) => [w, u.usage?.[w] ?? null])),
    credits: u.credits ?? null,
    usageUpdatedAt: u.usageUpdatedAt ?? null,
    lastAuthenticatedAt: account.lastAuthenticatedAt ?? null,
    duplicateOf: account.duplicateOf ?? null,
  };
}

export async function rebuildContract(home) {
  return withLock(home, async () => {
    const known = await knownAccounts(home);
    const accounts = await Promise.all(
      known.accounts.map(async (account) => contractAccount(account, await contractUsage(home, account))),
    );
    const doc = (updatedAt) => ({ version: 1, updatedAt, active: known.active, accounts });
    const path = join(home, FILES.contract);
    const old = await readFile(path, "utf8").catch(() => null);
    let oldAt = null;
    try {
      oldAt = JSON.parse(old)?.updatedAt ?? null;
    } catch {
      // A missing or broken file is rebuilt whole: it's ours, from the inputs.
    }
    if (Number.isInteger(oldAt) && render(doc(oldAt)) === old) return doc(oldAt);
    const fresh = doc(Date.now());
    await writeAtomic(path, render(fresh));
    return fresh;
  });
}
