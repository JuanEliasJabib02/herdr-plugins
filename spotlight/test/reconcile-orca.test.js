// T16 (D27), the reap's reconcile (cli-work.mjs reconcileFree): a root
// Orca's Spotlight took reads orca-holds, not root-diverged, and goes back to
// the usual rules once Orca lets go. Real git, an in-memory store.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { reconcileFree } from "../mods/spotlight/cli-work.mjs";
import { activate, gitContext } from "../mods/spotlight/sync.js";
import { emptyRepo } from "../mods/spotlight/store.js";

const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), "t16-gitcfg-")));
writeFileSync(join(CONFIG_DIR, "gitconfig"), "[user]\n\tname = Test\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(CONFIG_DIR, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
after(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function detachOnCommitBy(root, author, text) {
  write(root, "a.txt", text);
  run(root, "add", "-A");
  const tree = run(root, "write-tree");
  const sha = run(root, "-c", `user.name=${author}`, "-c", "user.email=x@y", "commit-tree", tree, "-p", "HEAD", "-m", `${author} snapshot`);
  run(root, "checkout", "-q", "--detach");
  run(root, "reset", "-q", "--hard", sha);
  return sha;
}

const MSG = "Este root lo tiene el Spotlight de Orca: apágalo allá primero.";
let base, root, wt, state, cx, snapshot;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "t16-")));
  root = join(base, "root");
  wt = join(base, "wt");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "orig\n");
  run(root, "add", "-A");
  run(root, "commit", "-qm", "init");
  run(root, "worktree", "add", "-q", wt, "-b", "feature");
  write(wt, "a.txt", "herdr\n");
  snapshot = (await activate(gitContext(), root, wt)).snapshotSha;
  state = { version: 1, repos: { [root]: { ...emptyRepo(), holder: wt, lastSnapshotSha: snapshot } }, queue: { requests: [], lighting: {} }, notes: [] };
  const store = {
    readState: () => structuredClone(state),
    withRepoLock: async (_root, fn) => fn(),
    updateState: async (fn) => ({ result: fn(state) }),
  };
  let now = 1000;
  cx = { reapStore: store, shared: {}, now: () => now++ };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("Orca took the root while we held it: orca-holds, kept on the next reap, not flipped to root-diverged", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  const changes = await reconcileFree(cx);
  assert.deepEqual(changes, [{ root, action: "orca-holds" }]);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
  assert.equal(state.repos[root].lastError.message, MSG);
  assert.equal(state.repos[root].holder, wt);
  const at = state.repos[root].lastError.at;
  assert.deepEqual(await reconcileFree(cx), []);
  assert.equal(state.repos[root].lastError.at, at);
});

test("a record an older reap flagged root-diverged becomes orca-holds", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  state.repos[root].lastError = { code: "root-diverged", message: "El root se movió del snapshot de Spotlight.", at: 1 };
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
});

test("Orca let go back to our snapshot: the error goes, the holder stays", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  run(root, "reset", "-q", "--hard", snapshot);
  assert.deepEqual(await reconcileFree(cx), [{ root, action: "cleared" }]);
  assert.equal(state.repos[root].lastError, null);
  assert.equal(state.repos[root].holder, wt);
  assert.deepEqual(await reconcileFree(cx), []);
});

test("Orca let go somewhere else: root-diverged, as for any moved root", async () => {
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  run(root, "reset", "-q", "--hard", "main");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "root-diverged");
});

test("someone else's detached commit is still root-diverged", async () => {
  detachOnCommitBy(root, "Someone Else", "else\n");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "root-diverged");
});

test("our refs with no record while Orca holds: orca-holds, then orphan-refs once Orca lets go", async () => {
  delete state.repos[root];
  cx.shared = { "projects.v1": { groups: [{ projects: [{ path: root }] }] } };
  detachOnCommitBy(root, "Orca Spotlight", "orca\n");
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orca-holds");
  assert.equal(state.repos[root].holder, null);
  assert.equal(state.repos[root].lastSnapshotSha, snapshot);
  run(root, "reset", "-q", "--hard", snapshot);
  await reconcileFree(cx);
  assert.equal(state.repos[root].lastError.code, "orphan-refs");
});
