// Spotlight's sync engine (D8): projects a workspace's files onto its repo's
// root checkout, keeps the root in step with it, and restores the root after.
// A port of Orca Pro Max's spotlight-sync-core.ts, spotlight-sync-primitives.ts
// and spotlight-git-exec.ts.
//
// - Every git call is argv-only (no shell) through `ctx.git`, an injected
//   executor (`gitContext()` gives the real one), so tests can fail any step.
// - The workspace's state is captured with a temp index (tracked + untracked,
//   gitignored files left out) without touching its HEAD, index or files.
// - The root's own state is backed up with `stash create` and anchored in refs
//   under refs/herdr-spotlight/* BEFORE anything destructive runs: a crash at
//   any point leaves the root recoverable with plain git.
// - Who holds the root lives in state.json (D7), not in these refs.
//
// Node-only: the CLI imports it, the mod never does.
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isGeneratedFile } from "./sync-generated.js";

export const REFS = Object.freeze({
  snapshot: "refs/herdr-spotlight/snapshot",
  backup: "refs/herdr-spotlight/backup",
  originalHead: "refs/herdr-spotlight/original-head",
  originalBranch: "refs/herdr-spotlight/original-branch",
});

/** Orca Pro Max's own Spotlight refs: a root holding any is Orca's, not ours. */
export const ORCA_REFS_PREFIX = "refs/orca/spotlight/";

/** Orca's SpotlightErrorCode (O/src/shared/spotlight.ts:7-31) minus
 *  `unsupported-host` (no remote hosts here), plus `orca-active`. */
export const ERROR_CODES = Object.freeze([
  /** A merge, rebase or cherry-pick is in progress in the root or the holder. */
  "operation-in-progress",
  /** The root's HEAD moved off the snapshot, or it has tracked edits of its own. */
  "root-diverged",
  /** Untracked root files would be overwritten by newly tracked snapshot paths. */
  "untracked-collision",
  /** The repo hasn't opted into Spotlight (thrown by the CLI's `toggle`, T6). */
  "not-enabled",
  /** Restoring the root's uncommitted changes conflicted on turn-off. */
  "restore-conflict",
  /** The root's original branch is gone or checked out elsewhere: a turn-off
   *  warning (`deactivate().warning`), never thrown. */
  "branch-missing",
  "unborn-head",
  "bare-root",
  /** The root can't hold its own Spotlight: it is the sync target. */
  "root-is-holder",
  /** A fresh activation needs the root on a branch, to re-attach it on turn-off. */
  "not-on-primary-branch",
  "repo-not-found",
  "worktree-not-found",
  "not-active",
  "git-failed",
  /** Orca's Spotlight is still on in this root (refs/orca/spotlight/*). */
  "orca-active",
]);

export class SpotlightError extends Error {
  /** `extra` carries a code's details, e.g. `paths` for untracked-collision. */
  constructor(code, message, extra = {}) {
    if (!ERROR_CODES.includes(code)) throw new TypeError(`Unknown Spotlight error code: ${code}`);
    super(message);
    this.name = "SpotlightError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** `{code, message}` for state.json's lastError: anything that isn't a
 *  SpotlightError is a git failure. */
export function toSpotlightError(error) {
  if (error instanceof SpotlightError) return { code: error.code, message: error.message };
  return { code: "git-failed", message: error instanceof Error ? error.message : String(error) };
}

// ── Executor ───────────────────────────────────────────────────────────────

// Variables that point git at another repository or index. Why dropped: a CLI
// run from inside a git hook inherits GIT_DIR, and every command below would
// then act on that repository instead of the path it was given.
const LOCAL_GIT_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX", "GIT_NAMESPACE",
];

/** The real executor: `git <args>` in `cwd`, `opts.env` merged over the
 *  environment. Resolves `{stdout, stderr}`; rejects with them attached. */
export function runGit(args, cwd, opts = {}) {
  const env = { ...process.env };
  for (const k of LOCAL_GIT_ENV) delete env[k];
  Object.assign(env, opts.env);
  return new Promise((done, fail) => {
    // maxBuffer: `status -uall` of a big root easily passes Node's 1 MB default.
    execFile("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(Object.assign(error, { stdout, stderr }));
      else done({ stdout, stderr });
    });
  });
}

/** The context every operation takes: `git(args, cwd, {env})` and
 *  `detectConflict(path)` → "merge" | "rebase" | "cherry-pick" | null.
 *  Either can be replaced (tests inject failures). */
export function gitContext(overrides = {}) {
  const ctx = { git: overrides.git ?? runGit, detectConflict: null };
  ctx.detectConflict = overrides.detectConflict ?? ((path) => detectConflictOperation(ctx, path));
  return ctx;
}

const IDENTITY_ARGS = ["-c", "user.name=Herdr Spotlight", "-c", "user.email=spotlight@herdr.local"];
const SNAPSHOT_MESSAGE = "Herdr Spotlight snapshot";
const TEMP_INDEX = "herdr-spotlight-index";

// The subcommand an argv runs, past any leading `-c key=value` pairs.
function subcommandOf(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

function stderrOf(error) {
  if (error && typeof error === "object") {
    if (typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
    if (typeof error.message === "string") return error.message;
  }
  return String(error);
}

/** stdout exactly as printed: porcelain status starts with a significant space. */
async function gitRaw(ctx, cwd, args, opts) {
  try {
    return (await ctx.git(args, cwd, opts)).stdout;
  } catch (error) {
    throw new SpotlightError("git-failed", `git ${subcommandOf(args)} failed: ${stderrOf(error)}`);
  }
}

async function git(ctx, cwd, args, opts) {
  return (await gitRaw(ctx, cwd, args, opts)).trim();
}

/** Like `git`, but a failure or an empty output means "absent": null. */
async function gitTry(ctx, cwd, args) {
  try {
    const value = (await ctx.git(args, cwd)).stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function resolveHead(ctx, path) {
  const head = await gitTry(ctx, path, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head) throw new SpotlightError("unborn-head", `${path} has no commits yet.`);
  return head;
}

const stripHeadsPrefix = (ref) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOr(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

// ── Guards ─────────────────────────────────────────────────────────────────

/** The operation git is in the middle of in `path`'s checkout, from the
 *  markers under its own `--git-dir` (a linked worktree has its own); null
 *  when none, or when `path` isn't a checkout. */
export async function detectConflictOperation(ctx, path) {
  const raw = await gitTry(ctx, path, ["rev-parse", "--git-dir"]);
  if (!raw) return null;
  const gitDir = resolve(path, raw);
  const [merge, cherryPick, rebaseMerge, rebaseApply] = await Promise.all(
    ["MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"].map((name) => exists(join(gitDir, name))),
  );
  if (merge) return "merge";
  if (rebaseMerge || rebaseApply) return "rebase";
  if (cherryPick) return "cherry-pick";
  return null;
}

async function assertNoConflictOperation(ctx, path) {
  const operation = await ctx.detectConflict(path);
  if (operation) {
    throw new SpotlightError(
      "operation-in-progress",
      `A ${operation} is in progress in ${path}. Finish or abort it first.`,
    );
  }
}

/** A checkout's top folder and git common dir, both physical paths; null when
 *  `path` isn't inside a checkout (bare repositories included). */
async function describeCheckout(ctx, path) {
  const raw = await gitTry(ctx, path, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  const [top, commonDir] = (raw ?? "").split("\n");
  if (!top || !commonDir) return null;
  return { top: await realpathOr(top), commonDir: await realpathOr(resolve(path, commonDir)) };
}

/** The root must be the top of a non-bare checkout. Why the top: a subfolder
 *  passed as the root would slip past the root-is-holder check below. */
async function assertRoot(ctx, rootPath) {
  const root = await describeCheckout(ctx, rootPath);
  if (!root) {
    const bare = await gitTry(ctx, rootPath, ["rev-parse", "--is-bare-repository"]);
    if (bare === "true") throw new SpotlightError("bare-root", "The repository root is a bare checkout.");
    throw new SpotlightError("repo-not-found", `${rootPath} is not a git repository.`);
  }
  if (root.top !== (await realpathOr(rootPath))) {
    throw new SpotlightError("repo-not-found", `${rootPath} is not the top of a git checkout (that is ${root.top}).`);
  }
  return root;
}

/** The holder must be a linked worktree of THIS repo (shared git common dir)
 *  other than the root. Without it a bad path could make Spotlight checkpoint
 *  an unrelated folder, or reset the root to a foreign tree. */
async function assertHolder(ctx, root, worktreePath) {
  const holder = await describeCheckout(ctx, worktreePath);
  if (!holder) {
    throw new SpotlightError("worktree-not-found", `${worktreePath} is not a worktree of this repository.`);
  }
  if (holder.top === root.top) {
    throw new SpotlightError(
      "root-is-holder",
      "The repository root cannot hold the Spotlight: it is the sync target.",
    );
  }
  if (holder.commonDir !== root.commonDir) {
    throw new SpotlightError(
      "worktree-not-found",
      "The selected workspace is not a worktree of this repository.",
    );
  }
}

async function assertTargets(ctx, rootPath, worktreePath) {
  const root = await assertRoot(ctx, rootPath);
  await assertHolder(ctx, root, worktreePath);
}

/** Orca Pro Max's Spotlight on the same root would fight this one over it. */
async function assertNoOrcaSpotlight(ctx, rootPath) {
  const ref = await gitTry(ctx, rootPath, ["for-each-ref", "--count=1", "--format=%(refname)", ORCA_REFS_PREFIX]);
  if (ref) {
    throw new SpotlightError(
      "orca-active",
      `Orca's Spotlight is still on in this repository (${ref}). Turn it off in Orca first.`,
    );
  }
}

/** One `status --porcelain -z -uall` read for both root guards: tracked edits
 *  (beyond generated files) and the untracked paths a reset could overwrite.
 *  -uall lists untracked files one by one: collapsed to `sub/`, a snapshot
 *  adding tracked `sub/file.txt` would slip past the collision guard. */
async function readRootStatus(ctx, rootPath) {
  const raw = await gitRaw(ctx, rootPath, ["status", "--porcelain", "-z", "-uall"]);
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  let trackedDirty = false;
  const untrackedPaths = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const xy = tokens[i].slice(0, 2);
    const entryPath = tokens[i].slice(3);
    if (xy === "??") {
      if (!isGeneratedFile(entryPath)) untrackedPaths.add(entryPath);
      continue;
    }
    // Rename and copy records carry the "from" path as the next token.
    const fromPath = xy[0] === "R" || xy[0] === "C" ? (tokens[i + 1] ?? "") : null;
    if (fromPath !== null) i += 1;
    const generatedOnly = isGeneratedFile(entryPath) && (fromPath === null || isGeneratedFile(fromPath));
    trackedDirty ||= !generatedOnly;
  }
  return { trackedDirty, untrackedPaths };
}

/** `reset --hard` overwrites untracked files whose paths the snapshot starts
 *  tracking: the one case where "untracked root files survive" is false. That
 *  content was never in any git object, so refuse instead of destroying it. */
async function assertNoUntrackedCollisions(ctx, rootPath, snapshotSha, untrackedPaths) {
  if (untrackedPaths.size === 0) return;
  const raw = await git(ctx, rootPath, ["diff", "--name-only", "--diff-filter=A", "-z", "HEAD", snapshotSha]);
  const paths = raw.split("\0").filter((p) => p.length > 0 && untrackedPaths.has(p));
  if (paths.length === 0) return;
  const shown = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? ` (+${paths.length - 5} más)` : "";
  throw new SpotlightError(
    "untracked-collision",
    `Hay archivos sin seguimiento en el root que el snapshot del workspace sobrescribiría: ${shown}${more}. Muévelos o bórralos, o fuerza el sync para sobrescribirlos.`,
    { paths },
  );
}

function assertRootOnSnapshot(refs, rootStatus, turningOff = false) {
  if (refs.rootHeadSha !== refs.snapshotSha) {
    throw new SpotlightError(
      "root-diverged",
      turningOff
        ? "El root se movió del snapshot de Spotlight (hubo un commit o un checkout ahí). Apagar Spotlight lo descartaría."
        : "El root se movió del snapshot de Spotlight (hubo un commit o un checkout ahí).",
    );
  }
  if (rootStatus.trackedDirty) {
    throw new SpotlightError(
      "root-diverged",
      turningOff
        ? "El root tiene cambios hechos fuera del workspace de Spotlight. Apagar Spotlight los descartaría."
        : "El root tiene cambios hechos fuera del workspace de Spotlight.",
    );
  }
}

// ── Refs ───────────────────────────────────────────────────────────────────

/** What the Spotlight refs in `rootPath` say, the source of truth for
 *  reconcile (D7). Never throws: a failed read gives nulls, and a null
 *  `rootHeadSha` tells a failed read from refs that are gone. `active` needs
 *  all three object refs: an interrupted turn-off can orphan {backup,
 *  original-head} without a snapshot, and treating that as active would wedge
 *  the repo in a permanent root-diverged. */
export async function inspectRefs(ctx, rootPath) {
  // for-each-ref covers the three object refs in one spawn. The branch is read
  // with symbolic-ref: for-each-ref is unreliable on a dangling symref (branch
  // deleted while active), and losing it would break the re-attach.
  const [refsRaw, branchRef, rootHeadSha] = await Promise.all([
    gitTry(ctx, rootPath, [
      "for-each-ref", "--format=%(refname)%00%(objectname)", REFS.snapshot, REFS.backup, REFS.originalHead,
    ]),
    gitTry(ctx, rootPath, ["symbolic-ref", "-q", REFS.originalBranch]),
    gitTry(ctx, rootPath, ["rev-parse", "--verify", "-q", "HEAD"]),
  ]);
  let snapshotSha = null;
  let backupSha = null;
  let originalHeadSha = null;
  for (const line of (refsRaw ?? "").split("\n")) {
    const [refname, objectname] = line.split("\0");
    if (!refname || !objectname) continue;
    if (refname === REFS.snapshot) snapshotSha = objectname;
    else if (refname === REFS.backup) backupSha = objectname;
    else if (refname === REFS.originalHead) originalHeadSha = objectname;
  }
  return {
    snapshotSha,
    backupSha,
    originalHeadSha,
    originalBranch: branchRef ? stripHeadsPrefix(branchRef) : null,
    rootHeadSha,
    active: Boolean(snapshotSha && backupSha && originalHeadSha),
  };
}

/** `inspectRefs` with the real git: the reader T6 hands to reconcile (D7). */
export function readRefs(rootPath) {
  return inspectRefs(gitContext(), rootPath);
}

// ── Checkpoint ─────────────────────────────────────────────────────────────

/** The holder's file state (tracked + untracked, non-ignored) as a tree, via a
 *  temp index rather than `git stash create`, which omits the unstaged new
 *  files agents routinely create. HEAD, index and files stay untouched. */
async function checkpointTree(ctx, worktreePath, opts = {}) {
  const headSha = await resolveHead(ctx, worktreePath);
  // A relative --git-path resolves against the git process's cwd, and every
  // command here runs in worktreePath.
  const indexPath = await git(ctx, worktreePath, ["rev-parse", "--git-path", TEMP_INDEX]);
  const env = { GIT_INDEX_FILE: indexPath };
  // Reusing the seeded temp index skips a full re-hash on each debounced sync.
  // Only valid for the same worktree and HEAD: `add -A` on an absent index
  // drops force-added (tracked but gitignored) files, which the reset would DELETE.
  if (opts.reuseIndexForHead !== headSha) await git(ctx, worktreePath, ["read-tree", "HEAD"], { env });
  await git(ctx, worktreePath, ["add", "-A"], { env });
  const treeSha = await git(ctx, worktreePath, ["write-tree"], { env });
  return { treeSha, headSha };
}

/** The commit for a checkpoint tree: HEAD itself when nothing changed. */
async function commitCheckpoint(ctx, worktreePath, { treeSha, headSha }) {
  const headTree = await git(ctx, worktreePath, ["rev-parse", `${headSha}^{tree}`]);
  if (treeSha === headTree) return headSha;
  return git(ctx, worktreePath, [...IDENTITY_ARGS, "commit-tree", treeSha, "-p", headSha, "-m", SNAPSHOT_MESSAGE]);
}

export async function createCheckpointCommit(ctx, worktreePath, opts = {}) {
  const tree = await checkpointTree(ctx, worktreePath, opts);
  const sha = await commitCheckpoint(ctx, worktreePath, tree);
  return { sha, treeSha: tree.treeSha, headSha: tree.headSha };
}

// ── Root mutations ─────────────────────────────────────────────────────────

/** Backs the root up into the refs, then detaches it. The refs land before
 *  the detach so a crash at any later point stays recoverable with plain git. */
async function backupRootState(ctx, rootPath) {
  const originalHeadSha = await resolveHead(ctx, rootPath);
  const branchRef = await gitTry(ctx, rootPath, ["symbolic-ref", "-q", "HEAD"]);
  // `stash create` captures tracked changes AND the index (parent #2) without
  // moving refs/stash; empty output means a clean root, so HEAD is the backup.
  const stashSha = await git(ctx, rootPath, [...IDENTITY_ARGS, "stash", "create"]);
  const backupSha = stashSha || originalHeadSha;
  await git(ctx, rootPath, ["update-ref", REFS.backup, backupSha]);
  await git(ctx, rootPath, ["update-ref", REFS.originalHead, originalHeadSha]);
  if (branchRef) await git(ctx, rootPath, ["symbolic-ref", REFS.originalBranch, branchRef]);
  // A detached root has no branch to re-attach: drop one an orphaned ref set left.
  else await gitTry(ctx, rootPath, ["symbolic-ref", "--delete", REFS.originalBranch]);
  // Detached, so the snapshot resets never move the original branch.
  await git(ctx, rootPath, ["checkout", "--detach"]);
  return { originalBranch: branchRef ? stripHeadsPrefix(branchRef) : null, originalHeadSha, backupSha };
}

/** Undoes a failed fresh activation (the turn-off sequence). The refs go only
 *  AFTER the restore succeeded: the backup ref is the only handle on the
 *  root's uncommitted state (a stash commit with no reflog). */
async function rollbackFreshActivation(ctx, rootPath, original) {
  await git(ctx, rootPath, ["reset", "--hard", original.originalHeadSha]);
  if (original.originalBranch) {
    const branchSha = await gitTry(ctx, rootPath, ["rev-parse", "--verify", "-q", `refs/heads/${original.originalBranch}`]);
    if (branchSha) await git(ctx, rootPath, ["checkout", original.originalBranch, "--"]);
  }
  if (original.backupSha !== original.originalHeadSha) {
    // A conflict here propagates before the refs below are deleted.
    await git(ctx, rootPath, ["stash", "apply", "--index", original.backupSha]);
  }
  await gitTry(ctx, rootPath, ["update-ref", "-d", REFS.snapshot]);
  await gitTry(ctx, rootPath, ["update-ref", "-d", REFS.backup]);
  await gitTry(ctx, rootPath, ["update-ref", "-d", REFS.originalHead]);
  await gitTry(ctx, rootPath, ["symbolic-ref", "--delete", REFS.originalBranch]);
}

/** Points the snapshot ref at `snapshotSha`, then resets the root to it. */
async function applySnapshotToRoot(ctx, rootPath, snapshotSha) {
  // The ref moves first so the fresh checkpoint commit is safe from gc during
  // the reset. If the reset never lands, the ref goes back to its previous
  // value: left ahead of the unmoved root HEAD, every later sync would throw a
  // spurious, permanent root-diverged.
  const previous = await gitTry(ctx, rootPath, ["rev-parse", "--verify", "-q", REFS.snapshot]);
  await git(ctx, rootPath, ["update-ref", REFS.snapshot, snapshotSha]);
  // `reset --hard` mirrors adds, edits, deletes and renames exactly and, but
  // for the collision case guarded above, never touches untracked or ignored
  // files: root caches and installs survive.
  try {
    try {
      await git(ctx, rootPath, ["reset", "--hard", snapshotSha]);
    } catch {
      // A dev server or watcher holding a file can fail a reset transiently;
      // the command is idempotent, so try once more.
      await git(ctx, rootPath, ["reset", "--hard", snapshotSha]);
    }
  } catch (error) {
    await gitTry(
      ctx,
      rootPath,
      previous ? ["update-ref", REFS.snapshot, previous] : ["update-ref", "-d", REFS.snapshot],
    );
    throw error;
  }
}

// ── Operations ─────────────────────────────────────────────────────────────

/** Projects `worktreePath` onto `rootPath`. Fresh when the root has no
 *  Spotlight refs (backs the root up, detaches it); a takeover when it has
 *  (keeps the first backup). Options:
 *  - force: skip the root guards (root-diverged, untracked-collision), as
 *    Orca's "Activate anyway";
 *  - reuseIndexForHead: the holder HEAD of the previous checkpoint, when it
 *    was this same holder's (skips re-seeding the temp index);
 *  - requireOnBranch (default true): a fresh activation needs the root on a
 *    branch, so turn-off has one to re-attach. A takeover is exempt: the root
 *    is detached by Spotlight then.
 *  Returns {snapshotSha, checkpointHeadSha, originalBranch, originalHeadSha,
 *  backupSha, alreadyActive}. */
export async function activate(ctx, rootPath, worktreePath, opts = {}) {
  await assertTargets(ctx, rootPath, worktreePath);
  await assertNoConflictOperation(ctx, rootPath);
  await assertNoConflictOperation(ctx, worktreePath);
  await assertNoOrcaSpotlight(ctx, rootPath);

  const refs = await inspectRefs(ctx, rootPath);
  const alreadyActive = refs.active;
  if (!alreadyActive && opts.requireOnBranch !== false) {
    // Any branch: a repo's "primary" per origin/HEAD is unreliable (the remote
    // default may be master while the team works on develop).
    const head = await gitTry(ctx, rootPath, ["symbolic-ref", "-q", "HEAD"]);
    if (!head) {
      throw new SpotlightError(
        "not-on-primary-branch",
        "Spotlight needs the project root checked out on a branch; it's currently detached. Check out your project's main branch in the root, then try again.",
      );
    }
  }

  const rootStatus = await readRootStatus(ctx, rootPath);
  // A takeover honors the same guards as a sync: the existing backup holds
  // nothing committed or edited at the root after activation, so overwriting
  // it here would lose it silently.
  if (alreadyActive && !opts.force) assertRootOnSnapshot(refs, rootStatus);

  // Checkpoint BEFORE any root mutation: a bad holder (unborn HEAD, locked
  // index, a git failure) must never leave the root detached.
  const checkpoint = await createCheckpointCommit(ctx, worktreePath, opts);
  if (!opts.force) await assertNoUntrackedCollisions(ctx, rootPath, checkpoint.sha, rootStatus.untrackedPaths);

  if (alreadyActive) {
    await applySnapshotToRoot(ctx, rootPath, checkpoint.sha);
    return {
      snapshotSha: checkpoint.sha,
      checkpointHeadSha: checkpoint.headSha,
      originalBranch: refs.originalBranch,
      originalHeadSha: refs.originalHeadSha,
      backupSha: refs.backupSha,
      alreadyActive: true,
    };
  }

  const original = await backupRootState(ctx, rootPath);
  try {
    await applySnapshotToRoot(ctx, rootPath, checkpoint.sha);
  } catch (error) {
    try {
      await rollbackFreshActivation(ctx, rootPath, original);
    } catch {
      // The restore failed too; the rollback kept the refs so the backup
      // stays reachable. The activation's own error says why it aborted.
    }
    throw error;
  }
  return { snapshotSha: checkpoint.sha, checkpointHeadSha: checkpoint.headSha, ...original, alreadyActive: false };
}

/** Brings the root in step with the holder's current files. A no-op (same
 *  tree, root still on the snapshot) returns `skipped: true` having written
 *  nothing: no commit, no ref, no reset. Options: force, reuseIndexForHead
 *  (as activate). Returns {snapshotSha, checkpointHeadSha, skipped}. */
export async function sync(ctx, rootPath, worktreePath, opts = {}) {
  await assertTargets(ctx, rootPath, worktreePath);
  const refs = await inspectRefs(ctx, rootPath);
  if (!refs.active) throw new SpotlightError("not-active", "Spotlight is not active for this repository.");

  const tree = await checkpointTree(ctx, worktreePath, opts);
  const snapshotTree = await git(ctx, rootPath, ["rev-parse", `${refs.snapshotSha}^{tree}`]);
  // The no-op path returns before the conflict checks, the `status -uall` root
  // scan and the commit: auto-sync fires on every debounced file change, and
  // most of those change nothing.
  if (tree.treeSha === snapshotTree && refs.rootHeadSha === refs.snapshotSha && !opts.force) {
    return { snapshotSha: refs.snapshotSha, checkpointHeadSha: tree.headSha, skipped: true };
  }

  await assertNoConflictOperation(ctx, rootPath);
  await assertNoConflictOperation(ctx, worktreePath);
  await assertNoOrcaSpotlight(ctx, rootPath);
  const snapshotSha = await commitCheckpoint(ctx, worktreePath, tree);
  if (!opts.force) {
    const rootStatus = await readRootStatus(ctx, rootPath);
    // Untracked root files are expected and kept; only tracked edits made in
    // the root block the sync, because the reset would destroy them.
    assertRootOnSnapshot(refs, rootStatus);
    await assertNoUntrackedCollisions(ctx, rootPath, snapshotSha, rootStatus.untrackedPaths);
  }
  await applySnapshotToRoot(ctx, rootPath, snapshotSha);
  return { snapshotSha, checkpointHeadSha: tree.headSha, skipped: false };
}

/** Turn-off's refusals, read-only, run before anything touches the root or
 *  its server: an operation in progress, refs already gone, and (unless
 *  forced) a diverged root. Returns the refs. */
export async function assertDeactivatable(ctx, rootPath, opts = {}) {
  await assertRoot(ctx, rootPath);
  await assertNoConflictOperation(ctx, rootPath);
  const refs = await inspectRefs(ctx, rootPath);
  if (!refs.originalHeadSha) throw new SpotlightError("not-active", "Spotlight is not active for this repository.");
  // The reset --hard of a turn-off would silently destroy work committed or
  // edited in the root after activation: the backup predates it.
  if (!opts.force && refs.snapshotSha) assertRootOnSnapshot(refs, await readRootStatus(ctx, rootPath), true);
  return refs;
}

/** Restores the root: its original commit, its branch, and its uncommitted
 *  changes (staged and unstaged), then deletes the refs. `force` discards a
 *  diverged root (Orca's "Turn off anyway"). Returns {originalBranch,
 *  branchMissing, branchInUse, warning}: when the branch can't be re-attached
 *  (deleted, or checked out in another worktree) the root is left detached at
 *  its original commit and `warning` is a `branch-missing` {code, message}. */
export async function deactivate(ctx, rootPath, opts = {}) {
  const refs = await assertDeactivatable(ctx, rootPath, opts);
  await git(ctx, rootPath, ["reset", "--hard", refs.originalHeadSha]);

  let branchMissing = false;
  let branchInUse = false;
  if (refs.originalBranch) {
    const branchSha = await gitTry(ctx, rootPath, ["rev-parse", "--verify", "-q", `refs/heads/${refs.originalBranch}`]);
    if (branchSha) {
      try {
        await git(ctx, rootPath, ["checkout", refs.originalBranch, "--"]);
      } catch {
        // Most often the branch got checked out in ANOTHER worktree while the
        // root was detached. Stay detached at the original commit, so the
        // turn-off still completes instead of wedging half torn down.
        branchMissing = true;
        branchInUse = true;
      }
    } else {
      branchMissing = true;
    }
  }

  if (refs.backupSha && refs.backupSha !== refs.originalHeadSha) {
    try {
      // --index also restores what was staged vs unstaged.
      await git(ctx, rootPath, ["stash", "apply", "--index", refs.backupSha]);
    } catch (error) {
      // The refs stay: the backup is still reachable, to retry or apply by
      // hand (`git stash apply --index refs/herdr-spotlight/backup`).
      throw new SpotlightError(
        "restore-conflict",
        `Restoring the root's original uncommitted changes conflicted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await git(ctx, rootPath, ["update-ref", "-d", REFS.snapshot]);
  await git(ctx, rootPath, ["update-ref", "-d", REFS.backup]);
  await git(ctx, rootPath, ["update-ref", "-d", REFS.originalHead]);
  if (refs.originalBranch) await gitTry(ctx, rootPath, ["symbolic-ref", "--delete", REFS.originalBranch]);

  const warning = branchMissing
    ? {
      code: "branch-missing",
      message: branchInUse
        ? `The root is back on its original commit but left detached: branch "${refs.originalBranch}" is checked out in another worktree.`
        : `The root is back on its original commit but left detached: branch "${refs.originalBranch}" no longer exists.`,
    }
    : null;
  return { originalBranch: refs.originalBranch, branchMissing, branchInUse, warning };
}

/** Teardown when a normal turn-off can't finish (the repo is going away):
 *  best-effort deletion of the anchor refs. Keeps the backup ref: the root's
 *  uncommitted state is reachable only through it (its first parent is the
 *  original HEAD). */
export async function purgeRefs(ctx, rootPath) {
  await gitTry(ctx, rootPath, ["update-ref", "-d", REFS.snapshot]);
  await gitTry(ctx, rootPath, ["update-ref", "-d", REFS.originalHead]);
  await gitTry(ctx, rootPath, ["symbolic-ref", "--delete", REFS.originalBranch]);
}
