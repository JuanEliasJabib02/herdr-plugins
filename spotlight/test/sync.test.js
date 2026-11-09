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
  REFS, RESCUED_PENDING, ORCA_REFS_PREFIX, ERROR_CODES, SpotlightError, toSpotlightError,
  gitContext, runGit, detectConflictOperation,
  activate, sync, assertDeactivatable, deactivate, purgeRefs,
  inspectRefs, readRefs, createCheckpointCommit, orcaHoldsRoot, readOrcaHolds,
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

// What another Spotlight leaves in a root it projects onto: HEAD detached on
// a commit of its own, authored by `author` ("Orca Spotlight" for Orca Pro
// Max's), holding the root's files plus `files`. The way Orca gets there:
// checkout --detach, then reset --hard. No refs/orca/spotlight/* here, so
// only the HEAD tells.
function detachOnCommitBy(root, author, files = { "a.txt": "orca-version\n" }) {
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  run(root, "add", "-A");
  const tree = run(root, "write-tree");
  const sha = run(
    root, "-c", `user.name=${author}`, "-c", "user.email=spotlight@elsewhere.local",
    "commit-tree", tree, "-p", "HEAD", "-m", `${author} snapshot`,
  );
  run(root, "checkout", "-q", "--detach");
  run(root, "reset", "-q", "--hard", sha);
  return sha;
}

// Everything a refusal must leave as it was: HEAD, files, index, every ref.
const fingerprint = (root) => ({
  head: run(root, "rev-parse", "HEAD"),
  detached: isDetached(root),
  status: run(root, "status", "--porcelain", "-uall"),
  refs: run(root, "for-each-ref", "--format=%(refname) %(objectname)"),
  a: read(root, "a.txt"),
});

const ORCA_HOLDS = /^Este root lo tiene el Spotlight de Orca: apágalo allá primero\.$/;

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

  test("codes: Orca's SpotlightErrorCode list without unsupported-host, plus orca-active and orca-holds", () => {
    assert.deepEqual([...ERROR_CODES].sort(), [
      "bare-root", "branch-missing", "git-failed", "not-active", "not-enabled", "not-on-primary-branch",
      "operation-in-progress", "orca-active", "orca-holds", "repo-not-found", "restore-conflict", "root-diverged",
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

  test("D43: purgeRefs reads the refs before it drops them and returns what the teardown note names; rescued/* and rescued-pending stay; `applies` only when the backup differs from the original head", async () => {
    // A clean root: its backup is the original commit itself, nothing to apply.
    await activate(ctx, root, wt);
    const clean = await inspectRefs(ctx, root);
    assert.equal(clean.backupSha, clean.originalHeadSha);
    const rescued = "refs/herdr-spotlight/rescued/2026-11-09T00-00-00-000Z-abc1234";
    run(root, "update-ref", rescued, clean.originalHeadSha);
    run(root, "update-ref", RESCUED_PENDING, clean.originalHeadSha);

    const first = await purgeRefs(ctx, root);
    assert.deepEqual(first, {
      originalBranch: "main", originalHeadSha: clean.originalHeadSha, backupSha: clean.backupSha, applies: false, rescued: [rescued],
    });
    const gone = await inspectRefs(ctx, root);
    assert.equal(gone.snapshotSha, null);
    assert.equal(gone.originalHeadSha, null);
    assert.equal(gone.originalBranch, null);
    assert.equal(gone.backupSha, clean.backupSha, "the backup stays");
    assert.equal(run(root, "rev-parse", rescued), clean.originalHeadSha, "rescued/* stays");
    assert.equal(run(root, "rev-parse", RESCUED_PENDING), clean.originalHeadSha, "rescued-pending stays");

    // A root with uncommitted changes: the backup is a stash commit to apply.
    run(root, "checkout", "-q", "-f", "main");
    write(root, "a.txt", "a-dirty-in-root\n");
    await activate(ctx, root, wt);
    const dirty = await inspectRefs(ctx, root);
    assert.notEqual(dirty.backupSha, dirty.originalHeadSha);
    const second = await purgeRefs(ctx, root);
    assert.equal(second.applies, true);
    assert.equal(second.backupSha, dirty.backupSha);
    assert.equal(second.originalHeadSha, dirty.originalHeadSha);
    assert.deepEqual(second.rescued, [rescued]);

    // Nothing of ours left: nulls, nothing to apply, nothing rescued but what stays.
    run(root, "update-ref", "-d", REFS.backup);
    const none = await purgeRefs(ctx, root);
    assert.deepEqual(none, { originalBranch: null, originalHeadSha: null, backupSha: null, applies: false, rescued: [rescued] });
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
    // An untracked file in the way, so the failure also names where it went.
    run(wt, "rm", "-q", "to-delete.txt");
    run(wt, "commit", "-qm", "drop to-delete");
    await sync(ctx, root, wt);
    write(root, "to-delete.txt", "mine\n");
    const failing = spying([], (args) => sub(args) === "stash" && args.includes("apply"));

    await rejectsCode(
      deactivate(failing, root),
      "restore-conflict",
      /^Restoring the root's original uncommitted changes conflicted: .*\. Tus archivos sin seguimiento que estorbaban están a salvo en refs\/herdr-spotlight\/rescued\/\S+\.$/s,
    );

    const refs = await inspectRefs(ctx, root);
    assert.ok(refs.backupSha && refs.originalHeadSha && refs.snapshotSha);
    assert.equal(run(root, "show", `${refs.backupSha}:new.txt`), "staged in root");
    const [rescued] = run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/rescued/").split("\n");
    assert.equal(run(root, "show", `${rescued}:to-delete.txt`), "mine");
    // The failed attempt's reset overwrote the file; the pending ref remembers it.
    assert.equal(read(root, "to-delete.txt"), "delete-me\n");
    assert.equal(run(root, "rev-parse", RESCUED_PENDING), run(root, "rev-parse", rescued));

    // The root sits on its original commit now, off the snapshot: Apagar igual.
    const out = await deactivate(ctx, root, { force: true });
    assert.equal(branchOf(root), "main");
    assert.equal(run(root, "show", ":new.txt"), "staged in root");
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.equal(out.rescued.ref, rescued);
    assert.deepEqual(out.rescued.restored, ["to-delete.txt"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.deepEqual(run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/").split("\n"), [rescued]);
  });

  // ── Untracked root files in the turn-off's way ──────────────────────────

  test("turn-off never overwrites an untracked root file at a path the original commit has: saved in a rescued ref, written back as an uncommitted change", async () => {
    // A Next.js-style name: as a pathspec glob, [id] would match app/i.txt too.
    write(root, "app/[id].txt", "id-original\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "route");
    const originalHead = run(root, "rev-parse", "HEAD");
    run(wt, "rm", "-q", "to-delete.txt");
    run(wt, "commit", "-qm", "drop to-delete");
    await activate(ctx, root, wt);
    assert.equal(existsSync(join(root, "to-delete.txt")), false);
    assert.equal(existsSync(join(root, "app/[id].txt")), false);

    // Made by hand in the root while Spotlight holds it.
    write(root, "to-delete.txt", "mine\n");
    write(root, "app/[id].txt", "my route\n");
    write(root, "app/i.txt", "unrelated\n");
    write(root, "notes.txt", "unrelated too\n");

    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(run(root, "rev-parse", "HEAD"), originalHead);
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.equal(read(root, "app/[id].txt"), "my route\n");
    assert.equal(read(root, "app/i.txt"), "unrelated\n");
    assert.equal(read(root, "notes.txt"), "unrelated too\n");
    // Edits of the original files (unstaged: nothing in the index), the others still untracked.
    assert.deepEqual(run(root, "status", "--porcelain", "-uall").split("\n").map((l) => l.trim()).sort(), [
      "M app/[id].txt", "M to-delete.txt", "?? app/i.txt", "?? notes.txt",
    ].sort());
    assert.equal(run(root, "diff", "--cached"), "");

    assert.deepEqual(out.rescued.restored, ["app/[id].txt", "to-delete.txt"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.match(out.rescued.ref, /^refs\/herdr-spotlight\/rescued\/\S+$/);
    assert.equal(run(root, "show", `${out.rescued.ref}:to-delete.txt`), "mine");
    assert.equal(run(root, "show", `${out.rescued.ref}:app/[id].txt`), "my route");
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n").sort(), ["app/[id].txt", "to-delete.txt"]);

    // The anchor refs go; the rescued one stays.
    const refs = await inspectRefs(ctx, root);
    assert.deepEqual([refs.snapshotSha, refs.backupSha, refs.originalHeadSha], [null, null, null]);
    assert.deepEqual(run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/").split("\n"), [out.rescued.ref]);
  });

  test("turn-off with an untracked root file where the root's own uncommitted changes bring a version: theirs comes back, the untracked one stays in the rescued ref", async () => {
    write(root, "new.txt", "staged in root\n");
    run(root, "add", "new.txt");
    write(root, "a.txt", "root-uncommitted\n");
    await activate(ctx, root, wt);
    // While the root holds the snapshot, something creates new.txt there
    // untracked: before, the backup's staged new.txt couldn't land on it.
    write(root, "new.txt", "created while active\n");

    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "new.txt"), "staged in root\n");
    assert.equal(run(root, "show", ":new.txt"), "staged in root");
    assert.equal(read(root, "a.txt"), "root-uncommitted\n");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["new.txt"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:new.txt`), "created while active");
    assert.equal((await inspectRefs(ctx, root)).backupSha, null);
  });

  test("turn-off with no untracked file in the way rescues nothing and leaves no rescued ref", async () => {
    await activate(ctx, root, wt);
    write(root, "scratch.txt", "untracked, nowhere near the original\n");
    const out = await deactivate(ctx, root);
    assert.equal(out.rescued, null);
    assert.equal(read(root, "scratch.txt"), "untracked, nowhere near the original\n");
    assert.equal(run(root, "for-each-ref", "refs/herdr-spotlight/"), "");
  });

  test("a turn-off that fails after the rescue names the rescued ref and leaves the file; the next one saves it with any new file in one commit, writes both back and announces them", async () => {
    run(wt, "rm", "-q", "to-delete.txt", "a.txt");
    run(wt, "commit", "-qm", "drop two");
    await activate(ctx, root, wt);
    write(root, "to-delete.txt", "mine\n");
    const failing = spying([], (args) => sub(args) === "reset");

    let first;
    await assert.rejects(deactivate(failing, root), (e) => {
      assert.ok(e instanceof SpotlightError, `not a SpotlightError: ${e}`);
      assert.equal(e.code, "git-failed", e.message);
      const m = e.message.match(
        /^git reset failed: simulated failure\. Tus archivos sin seguimiento que estorbaban están a salvo en (refs\/herdr-spotlight\/rescued\/\S+)\.$/,
      );
      assert.ok(m, e.message);
      first = m[1];
      return true;
    });
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.equal(run(root, "rev-parse", RESCUED_PENDING), run(root, "rev-parse", first));
    assert.equal((await inspectRefs(ctx, root)).active, true);

    write(root, "a.txt", "mine too\n");
    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.equal(read(root, "a.txt"), "mine too\n");
    assert.deepEqual(out.rescued.restored, ["a.txt", "to-delete.txt"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n"), ["a.txt", "to-delete.txt"]);
    const refs = await inspectRefs(ctx, root);
    assert.deepEqual([refs.snapshotSha, refs.backupSha, refs.originalHeadSha, refs.originalBranch], [null, null, null, null]);
    // The pending ref goes; both rescued refs stay.
    assert.deepEqual(run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/").split("\n").sort(), [first, out.rescued.ref].sort());
  });

  const hasRef = (ref) => {
    try {
      run(root, "rev-parse", "--verify", "-q", ref);
      return true;
    } catch {
      return false;
    }
  };

  test("a fresh activation drops a pending rescue whose anchors are gone: its rescued ref stays, and the next turn-off doesn't write the old file back", async () => {
    run(wt, "rm", "-q", "to-delete.txt");
    run(wt, "commit", "-qm", "drop to-delete");
    await activate(ctx, root, wt);
    write(root, "to-delete.txt", "mine\n");
    await rejectsCode(deactivate(spying([], (args) => sub(args) === "reset"), root), "git-failed");
    const pending = run(root, "rev-parse", RESCUED_PENDING);
    const [rescued] = run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/rescued/").split("\n");
    // By hand: the anchors removed, the file moved away, the root back on main.
    for (const ref of [REFS.snapshot, REFS.backup, REFS.originalHead]) run(root, "update-ref", "-d", ref);
    run(root, "symbolic-ref", "--delete", REFS.originalBranch);
    rmSync(join(root, "to-delete.txt"));
    run(root, "checkout", "-q", "main", "--");
    assert.equal(read(root, "to-delete.txt"), "delete-me\n");

    const on = await activate(ctx, root, wt);

    assert.equal(on.alreadyActive, false);
    assert.equal(hasRef(RESCUED_PENDING), false);
    assert.equal(run(root, "rev-parse", rescued), pending);

    const out = await deactivate(ctx, root);

    assert.equal(out.rescued, null);
    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "to-delete.txt"), "delete-me\n");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "");
    assert.deepEqual(run(root, "for-each-ref", "--format=%(refname)", "refs/herdr-spotlight/").split("\n"), [rescued]);
  });

  test("a takeover after a failed turn-off keeps the pending rescue: the next turn-off still writes it back", async () => {
    run(wt, "rm", "-q", "to-delete.txt");
    run(wt, "commit", "-qm", "drop to-delete");
    const wt2 = join(base, "wt2");
    run(root, "worktree", "add", "-q", wt2, "-b", "feature-2", "feature");
    await activate(ctx, root, wt);
    write(root, "to-delete.txt", "mine\n");
    await rejectsCode(deactivate(spying([], (args) => sub(args) === "reset"), root), "git-failed");
    const pending = run(root, "rev-parse", RESCUED_PENDING);

    write(wt2, "a.txt", "wt2-version\n");
    const takeover = await activate(ctx, root, wt2);

    assert.equal(takeover.alreadyActive, true);
    assert.equal(run(root, "rev-parse", RESCUED_PENDING), pending);
    const out = await deactivate(ctx, root);
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.deepEqual(out.rescued.restored, ["to-delete.txt"]);
    assert.equal(run(root, "rev-parse", out.rescued.ref), pending);
    assert.equal(hasRef(RESCUED_PENDING), false);
  });

  test("a retry after a reset that failed part-way keeps the user's version: a file git already put back to the original's content isn't rescued over the pending one", async () => {
    run(wt, "rm", "-q", "to-delete.txt");
    run(wt, "commit", "-qm", "drop to-delete");
    await activate(ctx, root, wt);
    write(root, "to-delete.txt", "mine\n");
    // The reset writes the original commit's file, then fails.
    const partWay = spying([], (args) => {
      if (sub(args) !== "reset") return false;
      write(root, "to-delete.txt", "delete-me\n");
      return true;
    });
    await rejectsCode(deactivate(partWay, root), "git-failed");
    assert.equal(read(root, "to-delete.txt"), "delete-me\n");
    const pending = run(root, "rev-parse", RESCUED_PENDING);

    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "to-delete.txt"), "mine\n");
    assert.deepEqual(out.rescued.restored, ["to-delete.txt"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.equal(run(root, "show", `${out.rescued.ref}:to-delete.txt`), "mine");
    assert.equal(run(root, "rev-parse", out.rescued.ref), pending);
  });

  test("turn-off with an untracked file whose content is already the original commit's at that path: not rescued, not reported, nothing lost", async () => {
    run(wt, "rm", "-q", "to-delete.txt", "a.txt");
    run(wt, "commit", "-qm", "drop two");
    await activate(ctx, root, wt);
    write(root, "to-delete.txt", "delete-me\n"); // the original's content
    write(root, "a.txt", "mine\n");

    const out = await deactivate(ctx, root);

    assert.equal(read(root, "to-delete.txt"), "delete-me\n");
    assert.equal(read(root, "a.txt"), "mine\n");
    assert.deepEqual(out.rescued.restored, ["a.txt"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n"), ["a.txt"]);
    assert.equal(run(root, "status", "--porcelain", "-uall"), "M a.txt");
  });

  // Commits `files` on the root's main and fast-forwards the workspace to it.
  function commitOnBoth(files) {
    for (const [rel, content] of Object.entries(files)) write(root, rel, content);
    run(root, "add", "-A");
    run(root, "commit", "-qm", "more");
    run(wt, "merge", "-q", "--ff-only", "main");
  }

  test("turn-off rescues an ignored root file at a path the original commit tracks and writes it back; a big ignored folder stays out of the rescue", async () => {
    commitOnBoth({ "local.conf": "original conf\n" });
    // The workspace stops tracking it and ignores it.
    run(wt, "rm", "-q", "local.conf");
    write(wt, ".gitignore", "node_modules/\nlocal.conf\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-qm", "ignore local.conf");
    await activate(ctx, root, wt);
    assert.equal(existsSync(join(root, "local.conf")), false);
    write(root, "local.conf", "my conf\n");
    write(root, "node_modules/x/index.js", "dep\n");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "");

    const out = await deactivate(ctx, root);

    assert.equal(read(root, "local.conf"), "my conf\n");
    assert.equal(read(root, "node_modules/x/index.js"), "dep\n");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "M local.conf");
    assert.deepEqual(out.rescued.restored, ["local.conf"]);
    assert.deepEqual(out.rescued.kept, []);
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n"), ["local.conf"]);
  });

  test("turn-off with an untracked file in a folder where the original commit has a file: saved and announced, not written back, and the original file comes back", async () => {
    commitOnBoth({ docs: "original docs\n" });
    run(wt, "rm", "-q", "docs");
    write(wt, "docs/a.md", "workspace doc\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-qm", "docs folder");
    await activate(ctx, root, wt);
    write(root, "docs/notes.md", "my notes\n");

    const out = await deactivate(ctx, root);

    assert.equal(read(root, "docs"), "original docs\n");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["docs/notes.md"]);
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n"), ["docs/notes.md"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:docs/notes.md`), "my notes");
  });

  test("turn-off with an untracked file where the original commit has a folder: saved and announced, not written back, and the folder comes back", async () => {
    commitOnBoth({ "lib/x.js": "original x\n" });
    run(wt, "rm", "-q", "-r", "lib");
    run(wt, "commit", "-qm", "drop lib");
    await activate(ctx, root, wt);
    assert.equal(existsSync(join(root, "lib")), false);
    write(root, "lib", "my lib file\n");

    const out = await deactivate(ctx, root);

    assert.equal(read(root, "lib/x.js"), "original x\n");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["lib"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:lib`), "my lib file");
  });

  test("turn-off on a case-insensitive checkout with an untracked file whose name differs only in case: saved and announced, and the original file comes back", async (t) => {
    commitOnBoth({ "README.md": "original readme\n" });
    let ignoreCase = "false";
    try {
      ignoreCase = run(root, "config", "--bool", "core.ignorecase");
    } catch {
      // Unset: git treats it as false.
    }
    if (ignoreCase !== "true") {
      t.skip("core.ignorecase is false in this checkout");
      return;
    }
    run(wt, "rm", "-q", "README.md");
    run(wt, "commit", "-qm", "drop readme");
    await activate(ctx, root, wt);
    write(root, "Readme.md", "my readme\n");

    const out = await deactivate(ctx, root);

    assert.equal(read(root, "README.md"), "original readme\n");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["Readme.md"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:Readme.md`), "my readme");
  });

  test("turn-off with an untracked folder where the root's own uncommitted changes bring a file: the folder is saved and announced, and the staged file comes back", async () => {
    write(root, "cfg", "staged cfg\n");
    run(root, "add", "cfg");
    await activate(ctx, root, wt);
    write(root, "cfg/x.txt", "my x\n");

    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "cfg"), "staged cfg\n");
    assert.equal(run(root, "show", ":cfg"), "staged cfg");
    assert.equal(run(root, "status", "--porcelain", "-uall"), "A  cfg");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["cfg/x.txt"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:cfg/x.txt`), "my x");
  });

  test("turn-off on a case-insensitive checkout with root changes saved at turn-on and an untracked file whose name differs only in case: the original file isn't deleted before they apply", async (t) => {
    commitOnBoth({ "README.md": "original readme\n" });
    let ignoreCase = "false";
    try {
      ignoreCase = run(root, "config", "--bool", "core.ignorecase");
    } catch {
      // Unset: git treats it as false.
    }
    if (ignoreCase !== "true") {
      t.skip("core.ignorecase is false in this checkout");
      return;
    }
    run(wt, "rm", "-q", "README.md");
    run(wt, "commit", "-qm", "drop readme");
    write(root, "a.txt", "root-uncommitted\n");
    await activate(ctx, root, wt);
    write(root, "Readme.md", "my readme\n");

    const out = await deactivate(ctx, root);

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "README.md"), "original readme\n");
    assert.equal(read(root, "a.txt"), "root-uncommitted\n");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["Readme.md"]);
    assert.equal(run(root, "show", `${out.rescued.ref}:Readme.md`), "my readme");
  });

  // Nothing written: no rescue commit, no rescued or pending ref, root on the snapshot.
  async function assertTurnOffUntouched(snapshot) {
    assert.equal(run(root, "rev-parse", "HEAD"), snapshot);
    assert.equal((await inspectRefs(ctx, root)).active, true);
    assert.equal(run(root, "for-each-ref", "refs/herdr-spotlight/rescued/"), "");
    assert.equal(hasRef(RESCUED_PENDING), false);
  }

  test("untracked-collision: a nested git repo inside a folder in the turn-off's way refuses it before anything is written; Apagar igual discards it and saves the rest without a gitlink", async () => {
    commitOnBoth({ docs: "original docs\n" });
    run(wt, "rm", "-q", "docs");
    write(wt, "docs/a.md", "workspace doc\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-qm", "docs folder");
    const on = await activate(ctx, root, wt);
    run(root, "init", "-q", "-b", "main", "docs/nested");
    write(root, "docs/nested/f.txt", "nested\n");
    run(join(root, "docs/nested"), "add", "-A");
    run(join(root, "docs/nested"), "commit", "-qm", "nested");
    write(root, "docs/notes.md", "my notes\n");

    const refusal =
      /^Hay un repo de git dentro de docs\/nested, en una ruta que apagar Spotlight escribiría\. Muévelo y vuelve a apagar, o usa Apagar igual para descartarlo\.$/;
    await rejectsCode(deactivate(ctx, root), "untracked-collision", refusal);
    await rejectsCode(assertDeactivatable(ctx, root), "untracked-collision", refusal);
    await assertTurnOffUntouched(on.snapshotSha);
    assert.equal(read(root, "docs/notes.md"), "my notes\n");
    assert.equal(read(root, "docs/nested/f.txt"), "nested\n");

    const out = await deactivate(ctx, root, { force: true });

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "docs"), "original docs\n");
    assert.deepEqual(out.rescued.restored, []);
    assert.deepEqual(out.rescued.kept, ["docs/notes.md"]);
    assert.deepEqual(run(root, "ls-tree", "-r", "--name-only", out.rescued.ref).split("\n"), ["docs/notes.md"]);
    assert.doesNotMatch(run(root, "ls-tree", "-r", out.rescued.ref), /^160000 /m);
  });

  test("untracked-collision: an unborn nested git repo in the turn-off's way refuses it; Apagar igual discards it", async () => {
    commitOnBoth({ tool: "original tool\n" });
    run(wt, "rm", "-q", "tool");
    run(wt, "commit", "-qm", "drop tool");
    const on = await activate(ctx, root, wt);
    run(root, "init", "-q", "-b", "main", "tool"); // no commit yet
    write(root, "tool/x.txt", "x\n");

    await rejectsCode(deactivate(ctx, root), "untracked-collision", /^Hay un repo de git dentro de tool, /);
    await assertTurnOffUntouched(on.snapshotSha);
    assert.equal(read(root, "tool/x.txt"), "x\n");

    const out = await deactivate(ctx, root, { force: true });

    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "tool"), "original tool\n");
    assert.equal(out.rescued, null);
    assert.equal(run(root, "for-each-ref", "refs/herdr-spotlight/"), "");
  });

  test("untracked-collision: a nested git repo above a file in the turn-off's way refuses it; Apagar igual writes over the file, keeps the repo and names it", async () => {
    commitOnBoth({ "vendor/lib/x.js": "original\n" });
    run(wt, "rm", "-q", "-r", "vendor");
    run(wt, "commit", "-qm", "drop vendor");
    const on = await activate(ctx, root, wt);
    run(root, "init", "-q", "-b", "main", "vendor");
    write(root, "vendor/lib/x.js", "mine\n");
    run(join(root, "vendor"), "add", "-A");
    run(join(root, "vendor"), "commit", "-qm", "nested");
    write(root, "vendor/lib/x.js", "mine, uncommitted\n");

    const refusal = /^Hay un repo de git dentro de vendor, en una ruta que apagar Spotlight escribiría\./;
    await rejectsCode(deactivate(ctx, root), "untracked-collision", refusal);
    await rejectsCode(assertDeactivatable(ctx, root), "untracked-collision", refusal);
    await assertTurnOffUntouched(on.snapshotSha);
    assert.equal(read(root, "vendor/lib/x.js"), "mine, uncommitted\n");

    const out = await deactivate(ctx, root, { force: true });

    assert.deepEqual(out.discardedRepos, ["vendor"]);
    assert.equal(out.rescued, null);
    assert.equal(read(root, "vendor/lib/x.js"), "original\n");
    assert.equal(existsSync(join(root, "vendor/.git")), true);
  });

  test("untracked-collision: a nested git repo above a folder where the original commit has a file refuses it", async () => {
    commitOnBoth({ "vendor/lib": "original\n" });
    run(wt, "rm", "-q", "-r", "vendor");
    run(wt, "commit", "-qm", "drop vendor");
    const on = await activate(ctx, root, wt);
    run(root, "init", "-q", "-b", "main", "vendor");
    write(root, "vendor/lib/y.txt", "mine\n");

    await rejectsCode(deactivate(ctx, root), "untracked-collision", /^Hay un repo de git dentro de vendor, /);
    await assertTurnOffUntouched(on.snapshotSha);
    assert.equal(read(root, "vendor/lib/y.txt"), "mine\n");
  });

  test("root-diverged with a nested git repo in the way names both; Apagar igual discards them and says which repo went", async () => {
    commitOnBoth({ docs: "original docs\n" });
    run(wt, "rm", "-q", "docs");
    run(wt, "commit", "-qm", "drop docs");
    await activate(ctx, root, wt);
    run(root, "init", "-q", "-b", "main", "docs/n");
    write(root, "docs/n/keep.txt", "nested\n");
    run(join(root, "docs/n"), "add", "-A");
    run(join(root, "docs/n"), "commit", "-qm", "nested");
    write(root, "a.txt", "edited at the root\n");

    const refusal =
      /^El root tiene cambios hechos fuera del workspace de Spotlight\. Apagar Spotlight los descartaría\. También hay un repo de git dentro de docs\/n, en una ruta que apagar Spotlight escribiría: Apagar igual también lo descarta\.$/;
    await rejectsCode(deactivate(ctx, root), "root-diverged", refusal);
    await rejectsCode(assertDeactivatable(ctx, root), "root-diverged", refusal);
    assert.equal(read(root, "docs/n/keep.txt"), "nested\n");
    assert.equal(read(root, "a.txt"), "edited at the root\n");

    const out = await deactivate(ctx, root, { force: true });

    assert.deepEqual(out.discardedRepos, ["docs/n"]);
    assert.equal(read(root, "docs"), "original docs\n");
    assert.equal(read(root, "a.txt"), "a-original\n");
  });

  test("a submodule of the original commit that the workspace removed, populated in the root, doesn't refuse the turn-off and stays as it was", async () => {
    run(root, "init", "-q", "-b", "main", "sub");
    write(root, "sub/s.txt", "sub file\n");
    run(join(root, "sub"), "add", "-A");
    run(join(root, "sub"), "commit", "-qm", "sub");
    commitOnBoth({ "b.txt": "b\n" }); // add -A records sub as a gitlink
    assert.match(run(root, "ls-tree", "HEAD", "sub"), /^160000 /);
    run(wt, "rm", "-q", "sub");
    run(wt, "commit", "-qm", "drop the submodule");
    await activate(ctx, root, wt);
    assert.equal(read(root, "sub/s.txt"), "sub file\n");

    await assertDeactivatable(ctx, root);
    const out = await deactivate(ctx, root);

    assert.equal(out.rescued, null);
    assert.deepEqual(out.discardedRepos, []);
    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "sub/s.txt"), "sub file\n");
    assert.equal(existsSync(join(root, "sub/.git")), true);
    assert.equal(run(root, "status", "--porcelain"), "");
  });

  test("a submodule only in the root's saved changes still refuses the turn-off: applying them would delete it", async () => {
    run(root, "init", "-q", "-b", "main", "newsub");
    write(root, "newsub/s.txt", "sub file\n");
    run(join(root, "newsub"), "add", "-A");
    run(join(root, "newsub"), "commit", "-qm", "sub");
    write(root, "a.txt", "staged\n"); // alone, a staged gitlink makes no backup
    run(root, "add", "newsub", "a.txt");
    await activate(ctx, root, wt);
    const { backupSha } = await inspectRefs(ctx, root);
    assert.match(run(root, "ls-tree", backupSha, "newsub"), /^160000 /);

    await rejectsCode(deactivate(ctx, root), "untracked-collision", /^Hay un repo de git dentro de newsub, /);
    assert.equal(read(root, "newsub/s.txt"), "sub file\n");
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

  test("orca-holds: a root whose HEAD Orca's Spotlight detached on its own commit refuses turn-on, sync and turn-off, and stays as Orca left it", async () => {
    const wt2 = join(base, "wt2");
    run(root, "worktree", "add", "-q", wt2, "-b", "feature-2");
    write(wt, "a.txt", "herdr-version\n");
    write(wt2, "a.txt", "herdr-version-2\n");

    // Turn-on of a root Orca took first (no Herdr refs): orca-holds, not
    // not-on-primary-branch, even with Orca's refs there too.
    detachOnCommitBy(root, "Orca Spotlight");
    assert.equal(await readOrcaHolds(root), true);
    assert.equal(await orcaHoldsRoot(ctx, root), true);
    let before = fingerprint(root);
    await rejectsCode(activate(ctx, root, wt), "orca-holds", ORCA_HOLDS);
    run(root, "update-ref", "refs/orca/spotlight/snapshot", "HEAD");
    await rejectsCode(activate(ctx, root, wt), "orca-holds", ORCA_HOLDS);
    run(root, "update-ref", "-d", "refs/orca/spotlight/snapshot");
    assert.deepEqual(fingerprint(root), before);
    assert.equal((await inspectRefs(ctx, root)).active, false);

    // Orca took the root while Herdr held it (the 2026-11-08 incident).
    run(root, "checkout", "-q", "main");
    const on = await activate(ctx, root, wt);
    const orcaSha = detachOnCommitBy(root, "Orca Spotlight");
    write(wt, "a.txt", "herdr-version-again\n");
    before = fingerprint(root);
    await rejectsCode(sync(ctx, root, wt), "orca-holds", ORCA_HOLDS);
    await rejectsCode(activate(ctx, root, wt2), "orca-holds", ORCA_HOLDS);
    await rejectsCode(assertDeactivatable(ctx, root), "orca-holds", ORCA_HOLDS);
    await rejectsCode(deactivate(ctx, root), "orca-holds", ORCA_HOLDS);
    assert.deepEqual(fingerprint(root), before);
    assert.equal(run(root, "rev-parse", "HEAD"), orcaSha);
    assert.equal(read(root, "a.txt"), "orca-version\n");
    const refs = await inspectRefs(ctx, root);
    assert.equal(refs.active, true);
    assert.equal(refs.snapshotSha, on.snapshotSha);
  });

  test("orca-holds: forcing changes nothing: Forzar sync, Proyectar igual and Apagar igual refuse too", async () => {
    const wt2 = join(base, "wt2");
    run(root, "worktree", "add", "-q", wt2, "-b", "feature-2");
    write(wt, "a.txt", "herdr-version\n");

    detachOnCommitBy(root, "Orca Spotlight");
    let before = fingerprint(root);
    await rejectsCode(activate(ctx, root, wt, { force: true }), "orca-holds", ORCA_HOLDS);
    await rejectsCode(activate(ctx, root, wt, { force: true, requireOnBranch: false }), "orca-holds", ORCA_HOLDS);
    assert.deepEqual(fingerprint(root), before);

    run(root, "checkout", "-q", "main");
    await activate(ctx, root, wt);
    detachOnCommitBy(root, "Orca Spotlight");
    write(root, "a.txt", "edited-in-orcas-root\n");
    before = fingerprint(root);
    await rejectsCode(sync(ctx, root, wt, { force: true }), "orca-holds", ORCA_HOLDS);
    await rejectsCode(activate(ctx, root, wt2, { force: true }), "orca-holds", ORCA_HOLDS);
    await rejectsCode(assertDeactivatable(ctx, root, { force: true }), "orca-holds", ORCA_HOLDS);
    await rejectsCode(deactivate(ctx, root, { force: true }), "orca-holds", ORCA_HOLDS);
    assert.deepEqual(fingerprint(root), before);
    assert.equal(read(root, "a.txt"), "edited-in-orcas-root\n");
  });

  test("orca-holds is only Orca's: a detached HEAD authored \"Herdr Spotlight\" or anyone else, or an \"Orca Spotlight\" commit on a branch, keeps today's behavior", async () => {
    // Fresh turn-on of a detached root: not-on-primary-branch, as before.
    for (const author of ["Herdr Spotlight", "Someone Else"]) {
      detachOnCommitBy(root, author, { "a.txt": `${author}\n` });
      assert.equal(await readOrcaHolds(root), false, author);
      await rejectsCode(activate(ctx, root, wt), "not-on-primary-branch");
      run(root, "checkout", "-q", "main");
    }

    // A commit authored "Orca Spotlight" on a branch is just a commit.
    write(root, "a.txt", "on-a-branch\n");
    run(root, "add", "-A");
    run(root, "-c", "user.name=Orca Spotlight", "commit", "-qm", "named like Orca");
    assert.equal(await readOrcaHolds(root), false);
    write(wt, "a.txt", "herdr-version\n");
    await activate(ctx, root, wt);
    assert.equal(read(root, "a.txt"), "herdr-version\n");

    // Herdr's own snapshot is authored "Herdr Spotlight": sync and turn-off go on.
    assert.equal(run(root, "log", "-1", "--format=%an", "HEAD"), "Herdr Spotlight");
    assert.equal(await readOrcaHolds(root), false);
    write(wt, "a.txt", "herdr-version-2\n");
    assert.equal((await sync(ctx, root, wt)).skipped, false);
    assert.equal(read(root, "a.txt"), "herdr-version-2\n");

    // Someone else's detached commit at the root: root-diverged, and force overrides.
    detachOnCommitBy(root, "Someone Else", { "a.txt": "someone-else\n" });
    write(wt, "a.txt", "herdr-version-3\n");
    await rejectsCode(sync(ctx, root, wt), "root-diverged");
    await rejectsCode(deactivate(ctx, root), "root-diverged");
    await deactivate(ctx, root, { force: true });
    assert.equal(branchOf(root), "main");
    assert.equal(read(root, "a.txt"), "on-a-branch\n");
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
