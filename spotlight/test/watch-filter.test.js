// T10: auto-sync's filter (D9). The footer copy watches each holder's
// folder (watchFolder), drops batches whose every path is Git's internals or
// build and test output (Orca's watcher ignore list,
// O/src/main/ipc/filesystem/watchers/filesystem-watcher-ignore.ts, plus test
// output) or lies outside the holder (Orca's
// shouldRefreshGitStatusForFileChange), debounces 300 ms per repo, then
// execs `spotlight sync --repo <root> --detach`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IGNORED_DIRS, SYNC_DEBOUNCE_MS, shouldSync, watchTargets, syncArgv, debouncer,
} from "../mods/spotlight/watch-filter.js";

const H = "/Users/u/orca/workspaces/back/ax-3447";
const ROOT = "/Users/u/code/back";

test("a batch of only .git/ and test-results/ paths triggers no sync", () => {
  assert.equal(
    shouldSync([
      `${H}/.git`,
      `${H}/.git/index.lock`,
      `${H}/test-results/login-chromium/trace.zip`,
      `${H}/test-results`,
      `${H}/apps/web/test-results/.last-run.json`,
    ], H),
    false,
  );
});

test("build output, caches and dependencies at any depth are ignored too", () => {
  for (const dir of IGNORED_DIRS) assert.equal(shouldSync([`${H}/packages/ui/${dir}/x.js`], H), false, dir);
  for (const dir of [".git", "node_modules", "dist", "build", ".next", ".cache", "target", ".venv", "__pycache__", "test-results", "playwright-report"]) {
    assert.ok(IGNORED_DIRS.includes(dir), dir);
  }
});

test("a source change syncs, even mixed with ignored paths", () => {
  assert.equal(shouldSync([`${H}/src/app.ts`], H), true);
  assert.equal(shouldSync([`${H}/.git/index`, `${H}/node_modules/x/y.js`, `${H}/package.json`], H), true);
  // Names that only start like an ignored dir are source.
  assert.equal(shouldSync([`${H}/src/.github/workflows/ci.yml`, `${H}/distance.ts`], H), true);
  assert.equal(shouldSync([`${H}/src/builder/index.ts`], H), true);
});

test("paths outside the holder never sync; the holder itself (an overflowed batch) does", () => {
  assert.equal(shouldSync([`${H}-other/src/a.ts`, "/Users/u/code/back/src/a.ts"], H), false);
  assert.equal(shouldSync([H], H), true);
  assert.equal(shouldSync([`${H}/`], `${H}/`), true);
  assert.equal(shouldSync([], H), false);
  assert.equal(shouldSync(undefined, H), false);
  assert.equal(shouldSync([`${H}/a.ts`], null), false);
});

test("watch targets: one holder per lit repo; the argv of the sync", () => {
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
  assert.deepEqual(syncArgv("/app/mods/spotlight/bin/spotlight", ROOT), ["/app/mods/spotlight/bin/spotlight", "sync", "--repo", ROOT, "--detach"]);
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
