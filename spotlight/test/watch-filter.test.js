// T10, T37: auto-sync's filter (D9, D44). The watcher (`spotlight watch`,
// watch.mjs) watches each holder's folder and drops every event Orca's own
// watcher would never see: a path under one of Orca's nine ignored folders
// at any depth (WATCHER_IGNORE_DIRS,
// O/src/main/ipc/filesystem/watchers/filesystem-watcher-ignore.ts), a
// directory event, or a path outside the holder (Orca's
// shouldRefreshGitStatusForFileChange). Herdr's extra test-output folders
// went with T37 (L31). The rest is debounced 300 ms per repo, then
// `spotlight sync --repo <root> --auto` runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IGNORED_DIRS, SYNC_DEBOUNCE_MS, shouldSync, watchTargets, debouncer,
} from "../mods/spotlight/watch-filter.js";

const H = "/Users/u/orca/workspaces/back/ax-3447";
const ROOT = "/Users/u/code/back";

test("Orca's nine folders, verbatim, and nothing else: test output syncs now (L31)", () => {
  assert.deepEqual([...IGNORED_DIRS], [".git", "node_modules", "dist", "build", ".next", ".cache", "target", ".venv", "__pycache__"]);
  for (const dir of ["test-results", "playwright-report", "blob-report", "coverage"]) {
    assert.equal(shouldSync([`${H}/${dir}/x.json`], H), true, dir);
  }
});

test("a batch of only .git/ paths triggers no sync", () => {
  assert.equal(shouldSync([`${H}/.git`, `${H}/.git/index.lock`, `${H}/apps/web/.git/HEAD`], H), false);
});

test("Orca's folders are ignored at any depth", () => {
  for (const dir of IGNORED_DIRS) assert.equal(shouldSync([`${H}/packages/ui/${dir}/x.js`], H), false, dir);
});

test("a source change syncs, even mixed with ignored paths", () => {
  assert.equal(shouldSync([`${H}/src/app.ts`], H), true);
  assert.equal(shouldSync([`${H}/.git/index`, `${H}/node_modules/x/y.js`, `${H}/package.json`], H), true);
  // Names that only start like an ignored dir are source.
  assert.equal(shouldSync([`${H}/src/.github/workflows/ci.yml`, `${H}/distance.ts`], H), true);
  assert.equal(shouldSync([`${H}/src/builder/index.ts`], H), true);
});

test("a directory event never syncs (Orca drops them); a file event does; isDirectory is asked only for a path the folders keep", () => {
  assert.equal(shouldSync([{ path: `${H}/src/components`, isDirectory: true }], H), false);
  assert.equal(shouldSync([{ path: `${H}/src/app.ts`, isDirectory: false }], H), true);
  assert.equal(shouldSync([{ path: `${H}/src/new-dir`, isDirectory: true }, { path: `${H}/src/new-dir/a.ts`, isDirectory: false }], H), true);
  const asked = [];
  const lazy = (p, dir) => ({ path: p, isDirectory: () => (asked.push(p), dir) });
  assert.equal(shouldSync([lazy(`${H}/node_modules/x`, true), lazy(`${H}/src`, true)], H), false);
  assert.deepEqual(asked, [`${H}/src`], "an ignored path is never stat'ed");
  assert.equal(shouldSync([lazy(`${H}/src/a.ts`, false)], H), true);
  // A plain string is a file's path, as before.
  assert.equal(shouldSync([`${H}/src/a.ts`], H), true);
});

test("paths outside the holder never sync; the holder itself (an overflowed batch) does", () => {
  assert.equal(shouldSync([`${H}-other/src/a.ts`, "/Users/u/code/back/src/a.ts"], H), false);
  assert.equal(shouldSync([H], H), true);
  assert.equal(shouldSync([{ path: H, isDirectory: true }], H), true, "the holder itself is the overflow, never a directory event");
  assert.equal(shouldSync([`${H}/`], `${H}/`), true);
  assert.equal(shouldSync([], H), false);
  assert.equal(shouldSync(undefined, H), false);
  assert.equal(shouldSync([`${H}/a.ts`], null), false);
  assert.equal(shouldSync([null, { path: 3 }], H), false);
});

test("watch targets: one holder per lit repo; the sync the watcher spawns is an automatic one", async () => {
  const { syncArgs } = await import("../mods/spotlight/watch-filter.js");
  const state = {
    repos: {
      [ROOT]: { holder: H },
      "/Users/u/code/front": { holder: null },
      "/Users/u/code/x": { holder: "/Users/u/orca/workspaces/x/y" },
    },
  };
  assert.deepEqual(watchTargets(state), [
    { root: ROOT, holder: H },
    { root: "/Users/u/code/x", holder: "/Users/u/orca/workspaces/x/y" },
  ]);
  assert.deepEqual(watchTargets(null), []);
  // `--auto`: an automatic sync, which doesn't retry an env that couldn't run
  // (N4). No `--detach`: the watcher spawns it detached itself.
  assert.deepEqual(syncArgs(ROOT), ["sync", "--repo", ROOT, "--auto"]);
});

test("debounce: a burst of changes runs one sync per repo, 300 ms after the last one", () => {
  assert.equal(SYNC_DEBOUNCE_MS, 300);
  const timers = [];
  const after = (ms, fn) => {
    const t = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
    timers.push(t);
    return t;
  };
  const ran = [];
  const bounce = debouncer(after, SYNC_DEBOUNCE_MS);
  for (let i = 0; i < 10; i += 1) bounce(ROOT, () => ran.push(ROOT));
  bounce("/other", () => ran.push("/other"));
  const live = timers.filter((t) => !t.cancelled);
  assert.equal(live.length, 2);
  assert.ok(live.every((t) => t.ms === 300));
  live.forEach((t) => t.fn());
  assert.deepEqual(ran, [ROOT, "/other"]);
  // After it fired, the next change schedules again.
  bounce(ROOT, () => ran.push(ROOT));
  assert.equal(timers.filter((t) => !t.cancelled).length, 3);
});

test("debounce: cancelAll drops every pending run (the watcher exiting)", () => {
  const timers = [];
  const after = (ms, fn) => {
    const t = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
    timers.push(t);
    return t;
  };
  const ran = [];
  const bounce = debouncer(after, SYNC_DEBOUNCE_MS);
  bounce(ROOT, () => ran.push(ROOT));
  bounce("/other", () => ran.push("/other"));
  bounce.cancelAll();
  assert.ok(timers.every((t) => t.cancelled));
  // A new change after it schedules again.
  bounce(ROOT, () => ran.push(ROOT));
  timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
  assert.deepEqual(ran, [ROOT]);
});
