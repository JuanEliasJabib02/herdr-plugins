// Cross-process locks for the CLI (D7): a lock is a directory holding
// owner.json `{pid, startedAt}` (startedAt: when the lock was taken, ms).
// Node-only; the mod never imports it.
//
// - Taking one is atomic and never shows an ownerless dir: the owner file is
//   written into a fresh temp dir, which is then renamed onto the lock path
//   (rename fails when the lock dir exists, since it is never empty).
// - Letting one go renames it away first, for the same reason.
// - A lock is stale when its pid is dead, or when that pid now belongs to a
//   process that started after the lock was taken (`ps -o lstart=`, pid
//   reuse). A stale lock is broken under a short-lived `<lock>.break` lock,
//   and only if it still has the same owner, so two waiters never both break
//   it and one never removes the other's fresh lock.
// - Within one process, the locks an async flow holds are tracked
//   (AsyncLocalStorage): taking a lock the flow already holds throws
//   `lock-reentry` instead of waiting on itself forever.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

export const OWNER_FILE = "owner.json";

// An owner file that can't be read (only something outside this module can
// leave one) counts as stale once its dir is this old.
const UNREADABLE_GRACE_MS = 5000;
// The pid-reuse check spawns `ps`: only for an owner that has held its lock
// this long, and then at most this often per owner. A fresh holder can't
// have died and had its pid reused yet.
const REUSE_CHECK_MS = 1000;

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LockError";
    this.code = code;
  }
}

const held = new AsyncLocalStorage();

// The lock dirs the current async flow holds.
export function heldLocks() {
  return held.getStore() ?? new Set();
}

// Whether a pid is a live process (EPERM: alive, someone else's).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// When a live process started (ms, to the second), or null when there is no
// such process or `ps` can't say.
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

const isOwner = (o) =>
  typeof o === "object" && o !== null && Number.isInteger(o.pid) && o.pid > 0 && Number.isFinite(o.startedAt);

const sameOwner = (a, b) => isOwner(a) && isOwner(b) && a.pid === b.pid && a.startedAt === b.startedAt;

// A lock dir's owner: undefined when there is no lock, null when its owner
// file can't be read, else { pid, startedAt }.
export function readOwner(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, OWNER_FILE), "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && !fs.existsSync(dir)) return undefined;
    return null;
  }
  try {
    const o = JSON.parse(text);
    return isOwner(o) ? { pid: o.pid, startedAt: o.startedAt } : null;
  } catch {
    return null;
  }
}

// Whether an owner no longer holds its lock: its pid is dead, or reused by
// a process that started after the lock was taken. `startedAtOf` is only
// asked when `checkReuse` is true (it spawns `ps`).
export function isStale(owner, { isAlive = pidAlive, startedAtOf = processStartedAt, checkReuse = true } = {}) {
  if (!isAlive(owner.pid)) return true;
  if (!checkReuse) return false;
  const started = startedAtOf(owner.pid);
  // `ps` gives whole seconds, so `started` is never later than the truth:
  // a live holder is never read as stale.
  return started != null && started > owner.startedAt;
}

const suffix = () => `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

// Takes the lock at `dir` for `owner` if it is free; false when it is held.
export function tryLock(dir, owner) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const fresh = `${dir}.new-${suffix()}`;
  fs.mkdirSync(fresh);
  try {
    fs.writeFileSync(path.join(fresh, OWNER_FILE), JSON.stringify(owner));
    fs.renameSync(fresh, dir);
    return true;
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    if (e.code === "ENOTEMPTY" || e.code === "EEXIST") return false;
    throw e;
  }
}

// Moves a lock dir away, then deletes it; false when it was already gone.
function removeLockDir(dir) {
  const gone = `${dir}.gone-${suffix()}`;
  try {
    fs.renameSync(dir, gone);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  fs.rmSync(gone, { recursive: true, force: true });
  return true;
}

// Lets the lock go, only if `owner` still holds it.
export function unlock(dir, owner) {
  if (!sameOwner(readOwner(dir), owner)) return false;
  return removeLockDir(dir);
}

const olderThan = (dir, ms) => {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > ms;
  } catch {
    return false;
  }
};

// Breaks the lock at `dir` if `stale` still owns it. True when the lock may
// have changed (retry at once), false when another process is breaking it.
function breakStale(dir, stale, opts) {
  const breaker = `${dir}.break`;
  const me = { pid: process.pid, startedAt: Date.now() };
  if (!tryLock(breaker, me)) {
    // A breaker that died inside its few-millisecond window.
    const b = readOwner(breaker);
    if ((b === null && olderThan(breaker, UNREADABLE_GRACE_MS)) || (b && isStale(b, opts))) removeLockDir(breaker);
    return false;
  }
  try {
    const now = readOwner(dir);
    if (stale === null ? now === null : sameOwner(now, stale)) removeLockDir(dir);
    return true;
  } finally {
    unlock(breaker, me);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the lock at `dir` and takes it; resolves with the owner written.
// Options: timeoutMs (default 10 s; then LockError "lock-timeout"), pollMs
// (default 20, plus up to as much jitter), isAlive and startedAtOf (tests).
export async function acquire(dir, opts = {}) {
  const { timeoutMs = 10_000, pollMs = 20 } = opts;
  const deadline = Date.now() + timeoutMs;
  const reuseCheckedAt = new Map();
  for (;;) {
    const owner = { pid: process.pid, startedAt: Date.now() };
    if (tryLock(dir, owner)) return owner;
    const current = readOwner(dir);
    if (current === undefined) continue; // let go between the two reads
    let stale;
    if (current === null) {
      stale = olderThan(dir, UNREADABLE_GRACE_MS);
    } else {
      const key = `${current.pid}:${current.startedAt}`;
      const now = Date.now();
      const checkReuse = now - current.startedAt >= REUSE_CHECK_MS && now - (reuseCheckedAt.get(key) ?? 0) >= REUSE_CHECK_MS;
      if (checkReuse) reuseCheckedAt.set(key, now);
      stale = isStale(current, { ...opts, checkReuse });
    }
    if (stale && breakStale(dir, current, opts)) continue;
    if (Date.now() >= deadline) {
      const who = current ? `pid ${current.pid}` : "an unknown owner";
      throw new LockError("lock-timeout", `Timed out after ${timeoutMs} ms waiting for ${path.basename(dir)} (held by ${who})`);
    }
    await sleep(pollMs + Math.random() * pollMs);
  }
}

// Runs fn while holding the lock at `dir`, and lets it go after, even when
// fn throws. Taking a lock the current async flow already holds throws
// LockError "lock-reentry".
export async function withLock(dir, fn, opts = {}) {
  const mine = heldLocks();
  if (mine.has(dir)) throw new LockError("lock-reentry", `${path.basename(dir)} is already held by this flow`);
  const owner = await acquire(dir, opts);
  try {
    return await held.run(new Set([...mine, dir]), fn);
  } finally {
    unlock(dir, owner);
  }
}
