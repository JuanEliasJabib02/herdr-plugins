// T1: the sync engine (M/sync.js, M/sync-generated.js), a port of Orca Pro
// Max's spotlight-sync-core.test.ts. Every test runs real git in realpath'd
// temp dirs (macOS /var is a symlink to /private/var, and git prints the
// physical path); faults are injected through the executor. One test per
// error code and per behavior of the task.
import { describe, test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  REFS, ORCA_REFS_PREFIX, ERROR_CODES, SpotlightError, toSpotlightError,
  gitContext, runGit, detectConflictOperation,
  activate, sync, assertDeactivatable, deactivate, purgeRefs,
  inspectRefs, readRefs, createCheckpointCommit,
} from "../mods/spotlight/sync.js";
import { GENERATED_FILE_NAMES, isGeneratedFile } from "../mods/spotlight/sync-generated.js";

// Git must never read the user's config (signing, hooks, default branch) nor
// a GIT_DIR inherited from a hook that runs these tests.
const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), "spotlight-gitcfg-")));
writeFileSync(
  join(CONFIG_DIR, "gitconfig"),
  "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n" +
    "[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n",
);
process.env.GIT_CONFIG_GLOBAL = join(CONFIG_DIR, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete process.env[k];
after(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

function run(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

function write(dir, rel, content) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const branchOf = (dir) => run(dir, "symbolic-ref", "--short", "HEAD");
const isDetached = (dir) => {
  try {
    run(dir, "symbolic-ref", "-q", "HEAD");
    return false;
  } catch {
    return true;
  }
};

// The git subcommand of an argv, past any leading `-c key=value` pairs.
function sub(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

// A real-git context that records every argv and fails the ones `fail` picks.
function spying(calls, fail = () => false) {
  return gitContext({
    git: async (args, cwd, opts) => {
      calls.push(args);
      if (fail(args, cwd)) throw Object.assign(new Error("simulated failure"), { stderr: "simulated failure" });
      return runGit(args, cwd, opts);
    },
  });
}

async function rejectsCode(promise, code, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof SpotlightError, `not a SpotlightError: ${e}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

// Neither branch, refs nor root files moved: the refusal touched nothing.
async function assertRootUntouched(root, ctx) {
  assert.equal(branchOf(root), "main");
  const refs = await inspectRefs(ctx, root);
  assert.equal(refs.snapshotSha, null);
  assert.equal(refs.backupSha, null);
  assert.equal(refs.originalHeadSha, null);
  assert.equal(refs.active, false);
}

describe("sync engine (D8)", () => {
  let base;
  let root;
  let wt;
  const ctx = gitContext();

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "spotlight-sync-")));
    root = join(base, "root");
    wt = join(base, "wt");
    mkdirSync(root);
    run(root, "init", "-q", "-b", "main");
    write(root, ".gitignore", "node_modules/\n");
    write(root, "a.txt", "a-original\n");
    write(root, "dir/b.txt", "b-original\n");
    write(root, "to-delete.txt", "delete-me\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "initial");
    run(root, "worktree", "add", "-q", wt, "-b", "feature");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // ── Contract ─────────────────────────────────────────────────────────────

  test("codes: Orca's SpotlightErrorCode list without unsupported-host, plus orca-active", () => {
    assert.deepEqual([...ERROR_CODES].sort(), [
      "bare-root", "branch-missing", "git-failed", "not-active", "not-enabled", "not-on-primary-branch",
      "operation-in-progress", "orca-active", "repo-not-found", "restore-conflict", "root-diverged",
      "root-is-holder", "unborn-head", "untracked-collision", "worktree-not-found",
    ]);
    assert.throws(() => new SpotlightError("unsupported-host", "x"), TypeError);
    const e = new SpotlightError("not-active", "off");
    assert.deepEqual(toSpotlightError(e), { code: "not-active", message: "off" });
    assert.deepEqual(toSpotlightError(new Error("boom")), { code: "git-failed", message: "boom" });
  });

  test("refs live under refs/herdr-spotlight/*, apart from Orca's refs/orca/spotlight/*", () => {
    assert.deepEqual(REFS, {
      snapshot: "refs/herdr-spotlight/snapshot",
      backup: "refs/herdr-spotlight/backup",
      originalHead: "refs/herdr-spotlight/original-head",
      originalBranch: "refs/herdr-spotlight/original-branch",
    });
    assert.equal(ORCA_REFS_PREFIX, "refs/orca/spotlight/");
  });

  // ── Activate, sync, deactivate ───────────────────────────────────────────

  test("activate (fresh) mirrors adds, edits, deletes and untracked files onto the root", async () => {
    write(wt, "a.txt", "a-changed\n");
    write(wt, "brand-new.txt", "new-file\n"); // untracked, never staged
    rmSync(join(wt, "to-delete.txt"));
    write(wt, "node_modules/dep.js", "ignored\n");
    write(root, "node_modules/root-dep.js", "root-install\n");
    write(root, "stray.log", "untracked-root-file\n");

    const out = await activate(ctx, root, wt);

    assert.equal(read(root, "a.txt"), "a-changed\n");
    assert.equal(read(root, "brand-new.txt"), "new-file\n");
    assert.equal(existsSync(join(root, "to-delete.txt")), false);
    // Ignored files never sync; untracked files already in the root survive.
    assert.equal(existsSync(join(root, "node_modules/dep.js")), false);
    assert.equal(read(root, "node_modules/root-dep.js"), "root-install\n");
    assert.equal(read(root, "stray.log"), "untracked-root-file\n");
    // Root detached at the snapshot; the original branch pointer is safe.
    assert.equal(run(root, "rev-parse", "HEAD"), out.snapshotSha);
    assert.equal(isDetached(root), true);
    assert.equal(out.alreadyActive, false);
    assert.equal(out.originalBranch, "main");
    assert.equal(run(root, "rev-parse", REFS.snapshot), out.snapshotSha);
    assert.equal(run(root, "symbolic-ref", REFS.originalBranch), "refs/heads/main");
  });

  test("activate never disturbs the holder's branch, index or files", async () => {
    write(wt, "a.txt", "a-changed\n");
    write(wt, "staged.txt", "staged\n");
    run(wt, "add", "staged.txt");
    write(wt, "unstaged-new.txt", "unstaged\n");
    const statusBefore = run(wt, "status", "--porcelain");
    const headBefore = run(wt, "rev-parse", "HEAD");

    await activate(ctx, root, wt);

    assert.equal(run(wt, "status", "--porcelain"), statusBefore);
    assert.equal(run(wt, "rev-parse", "HEAD"), headBefore);
    assert.equal(branchOf(wt), "feature");
  });

  test("sync applies incremental changes, renames included", async () => {
    write(wt, "a.txt", "v1\n");
    await activate(ctx, root, wt);

    write(wt, "a.txt", "v2\n");
    write(wt, "dir/c.txt", "c-new\n");
    run(wt, "mv", "dir/b.txt", "dir/renamed.txt");
    const synced = await sync(ctx, root, wt);
    assert.equal(synced.skipped, false);
    assert.equal(read(root, "a.txt"), "v2\n");
    assert.equal(read(root, "dir/c.txt"), "c-new\n");
    assert.equal(existsSync(join(root, "dir/b.txt")), false);
    assert.equal(read(root, "dir/renamed.txt"), "b-original\n");
  });

  test("re-sync with nothing new is skipped and writes nothing (no ref, reset or commit)", async () => {
    write(wt, "a.txt", "v1\n");
    const on = await activate(ctx, root, wt);
    const calls = [];
    const noop = await sync(spying(calls), root, wt);
    assert.equal(noop.skipped, true);
    assert.equal(noop.snapshotSha, on.snapshotSha);
    const writes = calls.filter((a) => ["update-ref", "reset", "checkout", "stash", "commit-tree"].includes(sub(a)));
    assert.deepEqual(writes, []);
    assert.equal(run(root, "rev-parse", REFS.snapshot), on.snapshotSha);
    assert.equal(run(root, "rev-parse", "HEAD"), on.snapshotSha);
  });

  test("the temp index is reused across syncs without corrupting the tree", async () => {
    write(wt, "a.txt", "v1\n");
    const on = await activate(ctx, root, wt);
    write(wt, "a.txt", "v2\n");
    write(wt, "new.txt", "brand-new\n");
    const synced = await sync(ctx, root, wt, { reuseIndexForHead: on.checkpointHeadSha });
    assert.equal(synced.skipped, false);
    assert.equal(read(root, "a.txt"), "v2\n");
    assert.equal(read(root, "new.txt"), "brand-new\n");
  });

  test("a clean holder's checkpoint is its HEAD", async () => {
    const head = run(wt, "rev-parse", "HEAD");
    const cp = await createCheckpointCommit(ctx, wt);
    assert.equal(cp.sha, head);
    assert.equal(cp.headSha, head);
  });

  test("deactivate re-attaches the branch and brings back the root's staged and unstaged changes", async () => {
    write(root, "a.txt", "staged-a\n");
    run(root, "add", "a.txt");
    write(root, "a.txt", "unstaged-a\n"); // staged and unstaged differ (MM)
    write(root, "root-staged.txt", "root-staged\n");
    run(root, "add", "root-staged.txt");
    write(root, "dir/b.txt", "b-unstaged\n");
    const statusBefore = run(root, "status", "--porcelain");
    const stagedBefore = run(root, "diff", "--cached");
    const unstagedBefore = run(root, "diff");

    write(wt, "a.txt", "wt-version\n");
    await activate(ctx, root, wt);
    assert.equal(read(root, "a.txt"), "wt-version\n");
    assert.equal(existsSync(join(root, "root-staged.txt")), false);

    const out = await deactivate(ctx, root);

    assert.equal(out.branchMissing, false);
    assert.equal(out.warning, null);
    assert.equal(branchOf(root), "main");
    assert.equal(run(root, "status", "--porcelain"), statusBefore);
    assert.equal(run(root, "diff", "--cached"), stagedBefore);
    assert.equal(run(root, "diff"), unstagedBefore);
    assert.equal(read(root, "a.txt"), "unstaged-a\n");
    assert.equal(run(root, "show", ":a.txt"), "staged-a");
    const refs = await inspectRefs(ctx, root);
    assert.deepEqual(
      [refs.snapshotSha, refs.backupSha, refs.originalHeadSha, refs.originalBranch, refs.active],
      [null, null, null, null, false],
    );
  });

  test("takeover by another workspace keeps the root's original backup", async () => {
    const wt2 = join(base, "wt2");
    run(root, "worktree", "add", "-q", wt2, "-b", "feature-2");
    write(root, "a.txt", "root-uncommitted\n");

    write(wt, "a.txt", "wt1-version\n");
    const first = await activate(ctx, root, wt);
    write(wt2, "a.txt", "wt2-version\n");
    const takeover = await activate(ctx, root, wt2);
    assert.equal(takeover.alreadyActive, true);
    assert.equal(takeover.backupSha, first.backupSha);
    assert.equal(read(root, "a.txt"), "wt2-version\n");

    await deactivate(ctx, root);
    assert.equal(read(root, "a.txt"), "root-uncommitted\n");
    assert.equal(branchOf(root), "main");
  });

  test("readRefs(root) reads the refs with the real git, never throws, and says when they are active", async () => {
    const head = run(root, "rev-parse", "HEAD");
    const off = await readRefs(root);
    assert.deepEqual(off, {
      snapshotSha: null, backupSha: null, originalHeadSha: null, originalBranch: null, rootHeadSha: head, active: false,
    });
    write(wt, "a.txt", "on\n");
    const out = await activate(ctx, root, wt);
    const on = await readRefs(root);
    assert.equal(on.active, true);
    assert.equal(on.snapshotSha, out.snapshotSha);
    assert.equal(on.rootHeadSha, out.snapshotSha);
    assert.equal(on.originalHeadSha, head);
    assert.equal(on.backupSha, head); // clean root: the backup is its HEAD
    assert.equal(on.originalBranch, "main");
    // Not a repo: every field null (rootHeadSha null = the read failed), no throw.
    const nowhere = await readRefs(join(base, "nowhere"));
    assert.equal(nowhere.rootHeadSha, null);
    assert.equal(nowhere.active, false);
  });

  test("partial refs read as not active: sync says not-active and the next activation is fresh", async () => {
    write(wt, "a.txt", "a-changed\n");
    await activate(ctx, root, wt);
    // A deactivate interrupted after restoring the root, before deleting every
    // ref (the snapshot goes first): backup + original-head orphaned.
    const originalHead = (await inspectRefs(ctx, root)).originalHeadSha;
    run(root, "reset", "-q", "--hard", originalHead);
    run(root, "checkout", "-q", "main", "--");
    run(root, "update-ref", "-d", REFS.snapshot);

    const partial = await readRefs(root);
    assert.equal(partial.active, false);
    assert.ok(partial.backupSha && partial.originalHeadSha);
    await rejectsCode(sync(ctx, root, wt), "not-active");

    const again = await activate(ctx, root, wt);
    assert.equal(again.alreadyActive, false);
    assert.equal(read(root, "a.txt"), "a-changed\n");
  });

  test("teardown (purgeRefs) drops the anchor refs but keeps the backup", async () => {
    write(root, "a.txt", "a-dirty-in-root\n");
    await activate(ctx, root, wt);
    const before = await inspectRefs(ctx, root);
    assert.ok(before.snapshotSha && before.originalHeadSha && before.backupSha);
    assert.notEqual(before.backupSha, before.originalHeadSha);

    await purgeRefs(ctx, root);

    const afterPurge = await inspectRefs(ctx, root);
    assert.equal(afterPurge.snapshotSha, null);
    assert.equal(afterPurge.originalHeadSha, null);
    assert.equal(afterPurge.originalBranch, null);
    assert.equal(afterPurge.active, false);
    assert.equal(afterPurge.backupSha, before.backupSha);
    assert.equal(run(root, "show", `${afterPurge.backupSha}:a.txt`), "a-dirty-in-root");
  });

  test("generated files (next-env.d.ts) never count as divergence nor as a collision", async () => {
    assert.ok(GENERATED_FILE_NAMES.has("next-env.d.ts"));
    assert.equal(isGeneratedFile("next-env.d.ts"), true);
    assert.equal(isGeneratedFile("apps/web/next-env.d.ts"), true);
    assert.equal(isGeneratedFile("next-env.d.ts.bak"), false);
    assert.equal(isGeneratedFile("src/next-env.ts"), false);

    write(wt, "apps/web/next-env.d.ts", "// v1\n");
    run(wt, "add", "apps/web/next-env.d.ts");
    run(wt, "commit", "-qm", "next app");
    write(wt, "next-env.d.ts", "// workspace\n"); // untracked in the holder
    write(root, "next-env.d.ts", "// written by a server at the root\n"); // untracked at the root

    await activate(ctx, root, wt); // no untracked-collision
    assert.equal(read(root, "next-env.d.ts"), "// workspace\n");

    // `next dev` at the root rewrites the tracked file on every start.
    write(root, "apps/web/next-env.d.ts", "// rewritten by next dev\n");
    write(wt, "a.txt", "after-server-start\n");
    const synced = await sync(ctx, root, wt); // no root-diverged
    assert.equal(synced.skipped, false);
    assert.equal(read(root, "a.txt"), "after-server-start\n");

    write(root, "apps/web/next-env.d.ts", "// rewritten again\n");
    await deactivate(ctx, root); // no root-diverged either
    assert.equal(branchOf(root), "main");
  });

  // ── Force ────────────────────────────────────────────────────────────────

  test("root-diverged: a tracked edit in the root blocks sync and turn-off, force overrides both", async () => {
    await activate(ctx, root, wt);
    write(root, "a.txt", "edited-directly-in-root\n");
    write(wt, "a.txt", "wt-change\n");

    await rejectsCode(sync(ctx, root, wt), "root-diverged", /cambios hechos fuera del workspace/);
    await rejectsCode(deactivate(ctx, root), "root-diverged");
    assert.equal(read(root, "a.txt"), "edited-directly-in-root\n");

    const forced = await sync(ctx, root, wt, { force: true });
    assert.equal(forced.skipped, false);
    assert.equal(read(root, "a.txt"), "wt-change\n");

    write(root, "a.txt", "edited-again\n");
    await deactivate(ctx, root, { force: true });
    assert.equal((await inspectRefs(ctx, root)).active, false);
    assert.equal(read(root, "a.txt"), "a-original\n");
  });

  test("root-diverged: a commit made at the root (HEAD moved off the snapshot) blocks sync", async () => {
    await activate(ctx, root, wt);
    write(root, "root-commit.txt", "x\n");
    run(root, "add", "root-commit.txt");
    run(root, "commit", "-qm", "committed in the root");
    write(wt, "a.txt", "wt-change\n");
    await rejectsCode(sync(ctx, root, wt), "root-diverged", /se movió del snapshot de Spotlight/);
  });

  test("root-diverged: turn-off's refusals are checked without touching the root", async () => {
    await rejectsCode(assertDeactivatable(ctx, root), "not-active");
    await activate(ctx, root, wt);
    const snapshotHead = run(root, "rev-parse", "HEAD");
    write(root, "a.txt", "edited-directly-in-root\n");

    await rejectsCode(assertDeactivatable(ctx, root), "root-diverged");
    const merging = gitContext({ detectConflict: async () => "merge" });
    await rejectsCode(assertDeactivatable(merging, root, { force: true }), "operation-in-progress");
    const refs = await assertDeactivatable(ctx, root, { force: true });
    assert.equal(refs.snapshotSha, snapshotHead);
    assert.equal(read(root, "a.txt"), "edited-directly-in-root\n");
    assert.equal(run(root, "rev-parse", "HEAD"), snapshotHead);
  });

  test("root-diverged: a takeover refuses a diverged root, force overwrites it", async () => {
    const wt2 = join(base, "wt2");
    run(root, "worktree", "add", "-q", wt2, "-b", "feature-2");
    await activate(ctx, root, wt);
    write(root, "a.txt", "edited-directly-in-root\n");
    write(wt2, "a.txt", "wt2-version\n");

    await rejectsCode(activate(ctx, root, wt2), "root-diverged");
    assert.equal(read(root, "a.txt"), "edited-directly-in-root\n");

    const forced = await activate(ctx, root, wt2, { force: true });
    assert.equal(forced.alreadyActive, true);
    assert.equal(read(root, "a.txt"), "wt2-version\n");
  });

  test("untracked-collision: lists the root's untracked paths a snapshot would overwrite, force overwrites", async () => {
    const names = ["s1.txt", "s2.txt", "s3.txt", "s4.txt", "s5.txt", "s6.txt", "s7.txt"];
    for (const n of names) {
      write(root, n, "precious-untracked\n");
      write(wt, n, "workspace-version\n");
    }
    run(wt, "add", ...names);

    await assert.rejects(activate(ctx, root, wt), (e) => {
      assert.equal(e.code, "untracked-collision");
      assert.deepEqual([...e.paths].sort(), names);
      assert.match(e.message, /s1\.txt, s2\.txt, s3\.txt, s4\.txt, s5\.txt \(\+2 más\)/);
      return true;
    });
    assert.equal(read(root, "s1.txt"), "precious-untracked\n");
    await assertRootUntouched(root, ctx);

    const forced = await activate(ctx, root, wt, { force: true });
    assert.equal(forced.alreadyActive, false);
    assert.equal(read(root, "s1.txt"), "workspace-version\n");
  });

  test("untracked-collision: a sync refuses too, and force overwrites", async () => {
    await activate(ctx, root, wt);
    write(root, "scratch.txt", "precious-untracked\n");
    write(wt, "scratch.txt", "workspace-version\n");
    await rejectsCode(sync(ctx, root, wt), "untracked-collision", /scratch\.txt/);
    assert.equal(read(root, "scratch.txt"), "precious-untracked\n");
    await sync(ctx, root, wt, { force: true });
    assert.equal(read(root, "scratch.txt"), "workspace-version\n");
  });

  // ── Error codes ──────────────────────────────────────────────────────────

  test("operation-in-progress: detectConflict finds MERGE_HEAD, rebase-merge, rebase-apply and CHERRY_PICK_HEAD under --git-dir", async () => {
    const rootGitDir = join(root, ".git");
    const wtGitDir = join(root, ".git", "worktrees", "wt");
    assert.equal(await detectConflictOperation(ctx, root), null);
    assert.equal(await detectConflictOperation(ctx, wt), null);

    writeFileSync(join(rootGitDir, "MERGE_HEAD"), "x\n");
    assert.equal(await detectConflictOperation(ctx, root), "merge");
    assert.equal(await detectConflictOperation(ctx, wt), null); // the holder has its own git dir
    rmSync(join(rootGitDir, "MERGE_HEAD"));

    mkdirSync(join(wtGitDir, "rebase-merge"));
    assert.equal(await detectConflictOperation(ctx, wt), "rebase");
    rmSync(join(wtGitDir, "rebase-merge"), { recursive: true });

    mkdirSync(join(rootGitDir, "rebase-apply"));
    assert.equal(await detectConflictOperation(ctx, root), "rebase");
    rmSync(join(rootGitDir, "rebase-apply"), { recursive: true });

    writeFileSync(join(wtGitDir, "CHERRY_PICK_HEAD"), "x\n");
    assert.equal(await detectConflictOperation(ctx, wt), "cherry-pick");

    assert.equal(await detectConflictOperation(ctx, join(base, "nowhere")), null);
  });

  test("operation-in-progress: a real merge conflict in the holder blocks activation and touches nothing", async () => {
    write(wt, "a.txt", "feature\n");
    run(wt, "commit", "-qam", "feature edit");
    run(wt, "checkout", "-q", "-b", "side", "HEAD~1");
    write(wt, "a.txt", "side\n");
    run(wt, "commit", "-qam", "side edit");
    assert.throws(() => run(wt, "merge", "feature")); // conflicts: MERGE_HEAD stays

    await rejectsCode(activate(ctx, root, wt), "operation-in-progress", /merge is in progress/);
    await assertRootUntouched(root, ctx);
  });

  test("operation-in-progress: a rebase or cherry-pick in the root blocks activate, sync and turn-off", async () => {
    mkdirSync(join(root, ".git", "rebase-apply"));
    write(wt, "a.txt", "wt\n");
    await rejectsCode(activate(ctx, root, wt), "operation-in-progress", /rebase/);
    await assertRootUntouched(root, ctx);
    rmSync(join(root, ".git", "rebase-apply"), { recursive: true });

    const on = await activate(ctx, root, wt);
    mkdirSync(join(root, ".git", "rebase-merge"));
    write(wt, "a.txt", "wt-2\n");
    await rejectsCode(sync(ctx, root, wt), "operation-in-progress", /rebase/);
    assert.equal(run(root, "rev-parse", "HEAD"), on.snapshotSha);
    rmSync(join(root, ".git", "rebase-merge"), { recursive: true });

    writeFileSync(join(root, ".git", "CHERRY_PICK_HEAD"), "x\n");
    await rejectsCode(deactivate(ctx, root), "operation-in-progress", /cherry-pick/);
    assert.equal((await inspectRefs(ctx, root)).active, true);
  });

  test("restore-conflict: a backup that can't be applied keeps the refs, so the root's changes stay reachable", async () => {
    write(root, "new.txt", "staged in root\n");
    run(root, "add", "new.txt");
    await activate(ctx, root, wt);
    // While the root holds the snapshot, something creates new.txt there
    // untracked: the backup's staged new.txt can't land on it.
    write(root, "new.txt", "created while active\n");

    await rejectsCode(deactivate(ctx, root), "restore-conflict", /Restoring the root's original uncommitted changes conflicted/);

    const refs = await inspectRefs(ctx, root);
    assert.ok(refs.backupSha && refs.originalHeadSha && refs.snapshotSha);
    assert.equal(run(root, "show", `${refs.backupSha}:new.txt`), "staged in root");
    assert.equal(read(root, "new.txt"), "created while active\n");
  });

  test("branch-missing: a deleted original branch leaves the root detached at its original commit, with a warning", async () => {
    await activate(ctx, root, wt);
    const originalHead = (await inspectRefs(ctx, root)).originalHeadSha;
    run(root, "branch", "-D", "main");

    const out = await deactivate(ctx, root);
    assert.equal(out.branchMissing, true);
    assert.equal(out.branchInUse, false);
    assert.equal(out.originalBranch, "main");
    assert.equal(out.warning.code, "branch-missing");
    assert.match(out.warning.message, /"main" no longer exists/);
    assert.equal(run(root, "rev-parse", "HEAD"), originalHead);
    assert.equal(isDetached(root), true);
    assert.equal((await inspectRefs(ctx, root)).originalHeadSha, null);
  });

  test("branch-missing: an original branch checked out elsewhere is reported as in use", async () => {
    await activate(ctx, root, wt);
    const originalHead = (await inspectRefs(ctx, root)).originalHeadSha;
    run(root, "worktree", "add", "-q", join(base, "other"), "main");

    const out = await deactivate(ctx, root);
    assert.equal(out.branchMissing, true);
    assert.equal(out.branchInUse, true);
    assert.equal(out.warning.code, "branch-missing");
    assert.match(out.warning.message, /"main" is checked out in another worktree/);
    assert.equal(run(root, "rev-parse", "HEAD"), originalHead);
    assert.equal(isDetached(root), true);
    assert.equal((await inspectRefs(ctx, root)).active, false);
  });

  test("unborn-head: a holder with no commit fails before the root is touched", async () => {
    const orphan = join(base, "orphan");
    run(root, "worktree", "add", "-q", "--detach", orphan);
    run(orphan, "checkout", "-q", "--orphan", "orphan-branch");
    run(orphan, "rm", "-rfq", ".");
    await rejectsCode(activate(ctx, root, orphan), "unborn-head", /has no commits yet/);
    await assertRootUntouched(root, ctx);
  });

  test("bare-root: a bare repository can't be the root", async () => {
    const bare = join(base, "bare.git");
    run(base, "clone", "-q", "--bare", root, bare);
    const bwt = join(base, "bwt");
    run(bare, "worktree", "add", "-q", bwt, "-b", "bfeat");
    await rejectsCode(activate(ctx, bare, bwt), "bare-root");
    await rejectsCode(deactivate(ctx, bare), "bare-root");
    assert.equal(run(bare, "for-each-ref", "refs/herdr-spotlight/"), "");
  });

  test("root-is-holder: the root (or a folder inside it) can't hold its own Spotlight", async () => {
    await rejectsCode(activate(ctx, root, root), "root-is-holder");
    await rejectsCode(activate(ctx, root, join(root, "dir")), "root-is-holder");
    const alias = join(base, "root-link");
    symlinkSync(root, alias);
    await rejectsCode(activate(ctx, alias, root), "root-is-holder");
    await assertRootUntouched(root, ctx);

    await activate(ctx, root, wt);
    await rejectsCode(sync(ctx, root, root), "root-is-holder");
  });

  test("not-on-primary-branch: a fresh activation needs the root on a branch; takeover is exempt", async () => {
    write(wt, "a.txt", "a-changed\n");
    run(root, "checkout", "-q", "--detach");
    await rejectsCode(activate(ctx, root, wt), "not-on-primary-branch");
    assert.equal((await inspectRefs(ctx, root)).snapshotSha, null);

    // Any branch will do (develop, not only main).
    run(root, "checkout", "-q", "-b", "develop");
    const on = await activate(ctx, root, wt);
    assert.equal(on.originalBranch, "develop");
    // The root is now detached by Spotlight; a takeover must not trip the check.
    write(wt, "a.txt", "again\n");
    const again = await activate(ctx, root, wt);
    assert.equal(again.alreadyActive, true);
  });

  test("repo-not-found: a root that is missing, not a repository, or not the top of its checkout", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    await rejectsCode(activate(ctx, plain, wt), "repo-not-found");
    await rejectsCode(activate(ctx, join(base, "missing"), wt), "repo-not-found");
    await rejectsCode(activate(ctx, join(root, "dir"), wt), "repo-not-found", /not the top/);
    await rejectsCode(sync(ctx, plain, wt), "repo-not-found");
    await rejectsCode(deactivate(ctx, plain), "repo-not-found");
    await assertRootUntouched(root, ctx);
  });

  test("worktree-not-found: a holder from another repository, or one that doesn't exist", async () => {
    const other = join(base, "other-repo");
    mkdirSync(other);
    run(other, "init", "-q", "-b", "main");
    write(other, "x.txt", "x\n");
    run(other, "add", "-A");
    run(other, "commit", "-qm", "other");

    await rejectsCode(activate(ctx, root, other), "worktree-not-found", /not a worktree of this repository/);
    await rejectsCode(activate(ctx, root, join(base, "missing")), "worktree-not-found");
    await assertRootUntouched(root, ctx);

    await activate(ctx, root, wt);
    await rejectsCode(sync(ctx, root, other), "worktree-not-found");
  });

  test("not-active: sync, turn-off and its check without Spotlight refs", async () => {
    await rejectsCode(sync(ctx, root, wt), "not-active");
    await rejectsCode(deactivate(ctx, root), "not-active");
    await rejectsCode(assertDeactivatable(ctx, root), "not-active");
  });

  test("git-failed: a failing git command surfaces its subcommand and stderr, and the root is untouched", async () => {
    write(wt, "a.txt", "a-changed\n");
    const failingAdd = spying([], (args) => sub(args) === "add");
    await rejectsCode(activate(failingAdd, root, wt), "git-failed", /^git add failed: simulated failure$/);
    await assertRootUntouched(root, ctx);

    const failingStash = spying([], (args) => sub(args) === "stash");
    await rejectsCode(activate(failingStash, root, wt), "git-failed", /^git stash failed/);
    await assertRootUntouched(root, ctx);
  });

  test("orca-active: a root still holding refs/orca/spotlight/* (Orca's Spotlight on) is refused", async () => {
    run(root, "update-ref", "refs/orca/spotlight/snapshot", "HEAD");
    write(wt, "a.txt", "a-changed\n");
    await rejectsCode(activate(ctx, root, wt), "orca-active", /Orca/);
    await assertRootUntouched(root, ctx);
    assert.equal(read(root, "a.txt"), "a-original\n");

    run(root, "update-ref", "-d", "refs/orca/spotlight/snapshot");
    const on = await activate(ctx, root, wt);
    run(root, "update-ref", "refs/orca/spotlight/original-head", "HEAD");
    write(wt, "a.txt", "a-changed-again\n");
    await rejectsCode(sync(ctx, root, wt), "orca-active");
    assert.equal(run(root, "rev-parse", "HEAD"), on.snapshotSha);
  });

  // ── Crash safety and rollback ────────────────────────────────────────────

  test("the refs land before anything destructive: a failed detach leaves them and the root as it was", async () => {
    write(root, "a.txt", "root-dirty\n");
    write(wt, "a.txt", "a-changed\n");
    const failingDetach = spying([], (args) => sub(args) === "checkout");
    await rejectsCode(activate(failingDetach, root, wt), "git-failed");

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "a.txt"), "root-dirty\n");
    const refs = await inspectRefs(ctx, root);
    assert.equal(refs.active, false);
    assert.ok(refs.backupSha && refs.originalHeadSha);
    assert.equal(run(root, "show", `${refs.backupSha}:a.txt`), "root-dirty");

    await activate(ctx, root, wt);
    await deactivate(ctx, root);
    assert.equal(read(root, "a.txt"), "root-dirty\n");
  });

  test("rollback: a fresh activation whose reset fails puts the root back and drops the refs", async () => {
    write(root, "a.txt", "root-dirty\n");
    write(wt, "a.txt", "a-changed\n");
    const originalHead = run(root, "rev-parse", "HEAD");
    const calls = [];
    // Resets to the snapshot fail (both tries); the rollback's reset to the
    // original HEAD works.
    const failing = spying(calls, (args) => sub(args) === "reset" && args.at(-1) !== originalHead);
    await rejectsCode(activate(failing, root, wt), "git-failed", /^git reset failed/);

    assert.equal(calls.filter((a) => sub(a) === "reset" && a.at(-1) !== originalHead).length, 2);
    assert.equal(branchOf(root), "main");
    assert.equal(run(root, "rev-parse", "HEAD"), originalHead);
    assert.equal(read(root, "a.txt"), "root-dirty\n");
    const refs = await inspectRefs(ctx, root);
    assert.deepEqual([refs.snapshotSha, refs.backupSha, refs.originalHeadSha, refs.originalBranch], [null, null, null, null]);
  });

  test("rollback: when even the restore fails, the refs stay so the backup is still reachable", async () => {
    write(root, "a.txt", "root-dirty\n");
    write(wt, "a.txt", "a-changed\n");
    const failingResets = spying([], (args) => sub(args) === "reset" && args[1] === "--hard");
    await assert.rejects(activate(failingResets, root, wt), SpotlightError);

    const refs = await inspectRefs(ctx, root);
    assert.ok(refs.backupSha);
    assert.notEqual(refs.backupSha, refs.originalHeadSha);
    assert.ok(refs.originalHeadSha);
    assert.equal(run(root, "show", `${refs.backupSha}:a.txt`), "root-dirty");
  });

  test("reset retry: one transient reset failure is retried and the activation lands", async () => {
    write(wt, "a.txt", "a-changed\n");
    const calls = [];
    let failures = 0;
    const flaky = spying(calls, (args) => sub(args) === "reset" && failures++ === 0);
    const on = await activate(flaky, root, wt);
    assert.equal(calls.filter((a) => sub(a) === "reset").length, 2);
    assert.equal(read(root, "a.txt"), "a-changed\n");
    assert.equal(run(root, "rev-parse", "HEAD"), on.snapshotSha);
  });

  test("snapshot ref rollback: a sync whose reset never lands puts the ref back, so the next sync isn't root-diverged", async () => {
    write(wt, "a.txt", "v1\n");
    const on = await activate(ctx, root, wt);
    write(wt, "a.txt", "v2\n");
    const failingResets = spying([], (args) => sub(args) === "reset");
    await rejectsCode(sync(failingResets, root, wt), "git-failed");

    assert.equal(run(root, "rev-parse", REFS.snapshot), on.snapshotSha);
    assert.equal(run(root, "rev-parse", "HEAD"), on.snapshotSha);
    assert.equal(read(root, "a.txt"), "v1\n");

    const synced = await sync(ctx, root, wt);
    assert.equal(synced.skipped, false);
    assert.equal(read(root, "a.txt"), "v2\n");
  });
});
