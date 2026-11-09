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
// - A turn-off never destroys an untracked root file (ignored ones included)
//   in the way of a path it writes: the file is saved in a commit under
//   refs/herdr-spotlight/rescued/* first (kept after the turn-off) and written
//   back on top when the original commit has a file at that exact path and
//   nothing else claims it. A turn-off that fails after the save leaves
//   refs/herdr-spotlight/rescued-pending, so the next one writes it back; a
//   fresh activation drops it. A nested git repo in the way refuses the
//   turn-off unless forced, which discards it.
// - A root Orca Pro Max's Spotlight holds (its refs, or its HEAD detached on
//   an "Orca Spotlight" commit) is never touched, not even forced: turning on,
//   syncing and turning off refuse (orca-active, orca-holds; D27).
//
// Node-only: the CLI imports it, the mod never does.
import { execFile } from "node:child_process";
import { access, lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isGeneratedFile } from "./sync-generated.js";

export const REFS = Object.freeze({
  snapshot: "refs/herdr-spotlight/snapshot",
  backup: "refs/herdr-spotlight/backup",
  originalHead: "refs/herdr-spotlight/original-head",
  originalBranch: "refs/herdr-spotlight/original-branch",
});

/** Where a turn-off saves untracked root files in its way, one ref per turn-off. */
export const RESCUED_PREFIX = "refs/herdr-spotlight/rescued/";

/** The rescue of a turn-off that hasn't finished: the next turn-off folds it
 *  into its own and writes its files back. Deleted once a write-back lands.
 *  Outside RESCUED_PREFIX: it points at a rescue, it isn't one. */
export const RESCUED_PENDING = "refs/herdr-spotlight/rescued-pending";

/** Orca Pro Max's own Spotlight refs: a root holding any is Orca's, not ours. */
export const ORCA_REFS_PREFIX = "refs/orca/spotlight/";

/** The author of the snapshot commits Orca Pro Max's Spotlight projects onto
 *  a root ("Orca Spotlight snapshot"); ours are "Herdr Spotlight". */
export const ORCA_SNAPSHOT_AUTHOR = "Orca Spotlight";

/** orca-holds' message (D27), also what the reap's reconcile records. */
export const ORCA_HOLDS_MESSAGE = "Este root lo tiene el Spotlight de Orca: apágalo allá primero.";

/** Orca's SpotlightErrorCode (O/src/shared/spotlight.ts:7-31) minus
 *  `unsupported-host` (no remote hosts here), plus `orca-active` and
 *  `orca-holds`. */
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
  /** Orca's Spotlight has this root now: its HEAD is detached on an "Orca
   *  Spotlight" commit (D27). Refused even when forced. */
  "orca-holds",
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
const RESCUE_INDEX = "herdr-spotlight-rescue-index";
const RESCUE_MESSAGE = "Herdr Spotlight: untracked root files a turn-off would have overwritten";
// Paths taken as they are: a Next.js route like app/[id]/page.tsx is no glob.
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };
// Paths per git argv, well under any command-line limit.
const PATHS_PER_CALL = 100;

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

/** Whether Orca Pro Max's Spotlight has the root now (D27): its HEAD is
 *  detached on a commit authored ORCA_SNAPSHOT_AUTHOR. Never throws: a root
 *  that can't be read, on a branch, or on anyone else's commit (our own
 *  "Herdr Spotlight" snapshots included) is not Orca's. The author comes from
 *  the raw commit (plumbing: no log config, signature or mailmap in the way). */
export async function orcaHoldsRoot(ctx, rootPath) {
  const [branch, commit] = await Promise.all([
    gitTry(ctx, rootPath, ["symbolic-ref", "-q", "HEAD"]),
    gitTry(ctx, rootPath, ["cat-file", "commit", "HEAD"]),
  ]);
  if (branch || !commit) return false;
  const header = commit.split("\n\n")[0];
  const author = /^author (.*) <[^>]*> -?\d+ [+-]\d{4}$/m.exec(header)?.[1] ?? null;
  return author === ORCA_SNAPSHOT_AUTHOR;
}

/** `orcaHoldsRoot` with the real git, for the reap's reconcile (D27). */
export function readOrcaHolds(rootPath) {
  return orcaHoldsRoot(gitContext(), rootPath);
}

/** Orca's Spotlight projected its own workspace onto the root (D27): turning
 *  on, syncing or turning off here, forced or not, would undo that, and Orca
 *  would undo ours. Refused before anything is written. */
async function assertRootNotHeldByOrca(ctx, rootPath) {
  if (await orcaHoldsRoot(ctx, rootPath)) {
    throw new SpotlightError("orca-holds", ORCA_HOLDS_MESSAGE);
  }
}

/** Orca Pro Max's Spotlight on the same root would fight this one over it:
 *  its HEAD on Orca's commit (orca-holds) is checked first, then Orca's refs
 *  (orca-active). */
async function assertNoOrcaSpotlight(ctx, rootPath) {
  await assertRootNotHeldByOrca(ctx, rootPath);
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
 *  Spotlight refs (backs the root up, detaches it, drops a pending rescue left
 *  without its anchors); a takeover when it has (keeps the first backup and
 *  any pending rescue). Options:
 *  - force: skip the root guards (root-diverged, untracked-collision), as
 *    Orca's "Activate anyway"; never orca-holds nor orca-active;
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

  // A pending rescue is a failed turn-off's, valid only while its anchors
  // last; with none, it would write stale files over this activation's
  // turn-off. Its commit stays reachable through its rescued/* ref.
  await gitTry(ctx, rootPath, ["update-ref", "-d", RESCUED_PENDING]);
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
 *  (as activate). A root Orca's Spotlight has now refuses, forced or not
 *  (orca-holds); one still on our snapshot can't be Orca's, so the no-op
 *  path doesn't look. Returns {snapshotSha, checkpointHeadSha, skipped}. */
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
 *  its server: an operation in progress, refs already gone, a root Orca's
 *  Spotlight has now (orca-holds, forced or not: D27), and (unless forced) a
 *  diverged root or a nested git repo in the way. Returns the refs. */
export async function assertDeactivatable(ctx, rootPath, opts = {}) {
  return (await checkTurnOff(ctx, rootPath, opts)).refs;
}

/** assertDeactivatable, returning also what it read for the turn-off: the
 *  original commit's files, core.ignorecase, the items in the way, the
 *  untracked entries under them and the nested repos it would go through. */
async function checkTurnOff(ctx, rootPath, opts) {
  await assertRoot(ctx, rootPath);
  await assertNoConflictOperation(ctx, rootPath);
  const refs = await inspectRefs(ctx, rootPath);
  if (!refs.originalHeadSha) throw new SpotlightError("not-active", "Spotlight is not active for this repository.");
  // After not-active: with no refs of ours there is nothing to restore, and
  // the turn-off only drops the record. With them, the reset would put our
  // original back over Orca's projection: Apagar igual included.
  await assertRootNotHeldByOrca(ctx, rootPath);
  const original = await treeFiles(ctx, rootPath, refs.originalHeadSha);
  const ignoreCase = (await gitTry(ctx, rootPath, ["config", "--bool", "core.ignorecase"])) === "true";
  const inTheWay = await itemsInTheWay(ctx, rootPath, refs, original, ignoreCase);
  const untracked = await untrackedUnder(ctx, rootPath, inTheWay);
  const nestedRepos = await nestedReposInTheWay(ctx, rootPath, refs, inTheWay, untracked, ignoreCase);
  if (!opts.force) {
    // The reset --hard of a turn-off would silently destroy work committed or
    // edited in the root after activation: the backup predates it.
    if (refs.snapshotSha) assertRootOnSnapshotNaming(nestedRepos, refs, await readRootStatus(ctx, rootPath));
    assertNoNestedRepos(nestedRepos);
  }
  return { refs, original, ignoreCase, inTheWay, untracked, nestedRepos };
}

/** Restores the root: its original commit, its branch, and its uncommitted
 *  changes (staged and unstaged), then deletes the refs. `force` discards a
 *  diverged root (Orca's "Turn off anyway") and a nested git repo in the
 *  way, which is never saved: a gitlink would keep none of its commits or
 *  files; never a root Orca's Spotlight has now (orca-holds). Returns {originalBranch, branchMissing, branchInUse, warning,
 *  rescued, discardedRepos}: when the branch can't be re-attached (deleted, or checked out in
 *  another worktree) the root is left detached at its original commit and
 *  `warning` is a `branch-missing` {code, message}. `rescued` is null, or {ref, restored, kept} when untracked
 *  root files were in the way (or a turn-off that failed half-way had saved
 *  some): all saved in `ref`, `restored` written back on top, `kept` only in
 *  `ref` (the original commit has no file at that exact path, or the root's
 *  own changes brought it). `discardedRepos` lists the nested repos a forced
 *  turn-off went through. Any failure after that save names `ref`. */
export async function deactivate(ctx, rootPath, opts = {}) {
  const { refs, original, ignoreCase, inTheWay, untracked, nestedRepos } = await checkTurnOff(ctx, rootPath, opts);
  // Saved before anything is written. Nothing is removed before the reset:
  // until it lands, a failure leaves every file where it was.
  const rescue = await rescueItems(ctx, rootPath, untracked, refs.originalHeadSha);
  try {
    // Also deletes the untracked items in the way of the original's paths:
    // their content is in the rescue.
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
      // A backup bringing a path that's there untracked can't apply.
      await clearOutOfTheWay(rootPath, inTheWay, original, ignoreCase);
      try {
        // --index also restores what was staged vs unstaged.
        await git(ctx, rootPath, ["stash", "apply", "--index", refs.backupSha]);
      } catch (error) {
        // The refs stay: the backup is still reachable, to retry or apply by
        // hand (`git stash apply --index refs/herdr-spotlight/backup`).
        throw new SpotlightError(
          "restore-conflict",
          `Restoring the root's original uncommitted changes conflicted: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }

    const rescued = rescue ? await writeBack(ctx, rootPath, refs, rescue, original) : null;

    // The pending ref goes first: left behind with the anchors gone, the next
    // turn-off would write its files back over a root that moved on.
    if (rescue) await git(ctx, rootPath, ["update-ref", "-d", RESCUED_PENDING]);
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
    return { originalBranch: refs.originalBranch, branchMissing, branchInUse, warning, rescued, discardedRepos: nestedRepos };
  } catch (error) {
    if (!rescue) throw error;
    // RESCUED_PENDING stays: the next turn-off writes these files back.
    const { code, message } = toSpotlightError(error);
    const stop = /[.!?]$/.test(message) ? "" : ".";
    throw new SpotlightError(
      code,
      `${message}${stop} Tus archivos sin seguimiento que estorbaban están a salvo en ${rescue.ref}.`,
    );
  }
}

const chunksOf = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += PATHS_PER_CALL) out.push(list.slice(i, i + PATHS_PER_CALL));
  return out;
};

const splitZ = (raw) => raw.split("\0").filter(Boolean);

// Case-folded and NFC-normalized, as a case-insensitive APFS compares names.
const foldName = (name) => name.normalize("NFC").toLowerCase();

/** Every file path of a commit's tree. */
async function treeFiles(ctx, rootPath, sha) {
  return splitZ(await gitRaw(ctx, rootPath, ["ls-tree", "-r", "-z", "--name-only", sha]));
}

/** lstat and readdir under the root, memoized: the walk below asks the same
 *  parent folders once per path under them. */
function diskOf(rootPath, ignoreCase) {
  const kinds = new Map();
  const listings = new Map();
  /** "dir", "other" (a file or symlink), or null when nothing is there. */
  const kind = (rel) => {
    if (!kinds.has(rel)) {
      kinds.set(rel, lstat(join(rootPath, rel)).then((st) => (st.isDirectory() ? "dir" : "other"), () => null));
    }
    return kinds.get(rel);
  };
  const list = (rel) => {
    if (!listings.has(rel)) listings.set(rel, readdir(join(rootPath, rel)).catch(() => []));
    return listings.get(rel);
  };
  /** `rel` as named on disk, component by component: the exact name, else
   *  (core.ignorecase) the entry equal folded, else the name asked for. */
  const actualPath = async (rel) => {
    const out = [];
    for (const part of rel.split("/")) {
      const entries = await list(out.join("/"));
      let name = entries.includes(part) ? part : null;
      if (name === null && ignoreCase) name = entries.find((e) => foldName(e) === foldName(part)) ?? null;
      out.push(name ?? part);
    }
    return out.join("/");
  };
  return { kind, actualPath };
}

/** Root items in the way of a path a turn-off writes (the original commit's
 *  files and the backup's) that the index doesn't track, beyond generated
 *  files: the reset would overwrite or delete them, the backup refuses to
 *  apply over them, and their content was never in any git object. Read from
 *  disk, not `status`, so ignored files count too, and without walking
 *  ignored trees like node_modules: per path, its first parent that is a file
 *  or symlink, else the path itself (a file, symlink or folder) by its
 *  on-disk name, which under core.ignorecase may differ in case. Sorted. */
async function itemsInTheWay(ctx, rootPath, refs, original, ignoreCase) {
  const wanted = new Set(original);
  if (refs.backupSha && refs.backupSha !== refs.originalHeadSha) {
    for (const p of await treeFiles(ctx, rootPath, refs.backupSha)) wanted.add(p);
  }
  const index = new Set(splitZ(await gitRaw(ctx, rootPath, ["ls-files", "-z"])));
  const disk = diskOf(rootPath, ignoreCase);
  const items = new Set();
  for (const w of wanted) {
    if (index.has(w)) continue;
    const parts = w.split("/");
    let hit = null;
    let clear = false;
    for (let i = 1; i < parts.length && hit === null && !clear; i += 1) {
      const prefix = parts.slice(0, i).join("/");
      // A tracked parent is the reset's to replace; a missing one leaves room.
      if (index.has(prefix)) clear = true;
      else {
        const kind = await disk.kind(prefix);
        if (kind === null) clear = true;
        else if (kind !== "dir") hit = prefix;
      }
    }
    if (clear) continue;
    if (hit === null && (await disk.kind(w)) === null) continue;
    const actual = await disk.actualPath(hit ?? w);
    if (index.has(actual) || isGeneratedFile(actual)) continue;
    items.add(actual);
  }
  return [...items].sort();
}

/** The untracked entries under `items` (ignored files included; the
 *  workspace's tracked files inside a folder item stay out, the reset handles
 *  those), beyond generated files. A nested git repo (or a submodule's
 *  worktree) is one entry ending in "/", git's own marker. */
async function untrackedUnder(ctx, rootPath, items) {
  const out = [];
  for (const chunk of chunksOf(items)) {
    // No --exclude-standard: ignored files are listed too.
    const raw = await gitRaw(ctx, rootPath, ["ls-files", "-z", "--others", "--", ...chunk], { env: LITERAL });
    for (const p of splitZ(raw)) if (!isGeneratedFile(p)) out.push(p);
  }
  return out;
}

const isNestedRepoEntry = (p) => p.endsWith("/");

/** The nested git repos a turn-off would go through. One in the way could be
 *  saved only as a gitlink, a pointer to commits the rescue doesn't hold (none
 *  at all in an unborn one, which `git add` refuses), and the turn-off would
 *  then delete it with its .git; one above an item isn't listed by git at all,
 *  and the reset writes over its files. Found by git's marker, or a .git entry
 *  in an item or any folder above it. A submodule of the original commit
 *  doesn't count: the reset leaves a populated one alone and it's that
 *  commit's own, so nothing removes it. One only in the backup does: its
 *  folder is removed to apply the backup. Sorted. */
async function nestedReposInTheWay(ctx, rootPath, refs, items, untracked, ignoreCase) {
  const found = new Set(untracked.filter(isNestedRepoEntry).map((p) => p.slice(0, -1)));
  const seen = new Set();
  for (const item of items) {
    const parts = item.split("/");
    for (let i = parts.length; i >= 1; i -= 1) {
      const dir = parts.slice(0, i).join("/");
      if (seen.has(dir)) break; // so were the folders above it
      seen.add(dir);
      if (await lstat(join(rootPath, dir, ".git")).then(() => true, () => false)) found.add(dir);
    }
  }
  if (found.size === 0) return [];
  const key = ignoreCase ? foldName : (p) => p;
  const raw = await gitRaw(ctx, rootPath, ["ls-tree", "-r", "-z", refs.originalHeadSha]);
  const gitlinks = new Set(
    splitZ(raw).filter((e) => e.startsWith("160000 ")).map((e) => key(e.slice(e.indexOf("\t") + 1))),
  );
  return [...found].filter((p) => !gitlinks.has(key(p))).sort();
}

const shownPaths = (paths) =>
  paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` (+${paths.length - 5} más)` : "");

function assertNoNestedRepos(paths) {
  if (paths.length === 0) return;
  throw new SpotlightError(
    "untracked-collision",
    paths.length === 1
      ? `Hay un repo de git dentro de ${shownPaths(paths)}, en una ruta que apagar Spotlight escribiría. Muévelo y vuelve a apagar, o usa Apagar igual para descartarlo.`
      : `Hay repos de git dentro de ${shownPaths(paths)}, en rutas que apagar Spotlight escribiría. Muévelos y vuelve a apagar, o usa Apagar igual para descartarlos.`,
    { paths },
  );
}

/** A diverged root's refusal, naming also the nested repos: Apagar igual, the
 *  way out it offers, discards both. */
function assertRootOnSnapshotNaming(paths, refs, rootStatus) {
  try {
    assertRootOnSnapshot(refs, rootStatus, true);
  } catch (error) {
    if (paths.length === 0) throw error;
    const also = paths.length === 1
      ? `También hay un repo de git dentro de ${shownPaths(paths)}, en una ruta que apagar Spotlight escribiría: Apagar igual también lo descarta.`
      : `También hay repos de git dentro de ${shownPaths(paths)}, en rutas que apagar Spotlight escribiría: Apagar igual también los descarta.`;
    throw new SpotlightError(error.code, `${error.message} ${also}`, { paths });
  }
}

/** `files` minus each regular file whose content is the original commit's
 *  blob at that exact path: that content is git's own (a reset that failed
 *  part-way wrote it, or it never changed), the reset writes it back
 *  identically, and saved on top of a pending rescue it would bury the user's
 *  version there. Hashed with the default filters, as `git add` would.
 *  Symlinks are always kept. */
async function withoutOriginalContent(ctx, rootPath, files, originalHeadSha) {
  const regular = [];
  for (const p of files) {
    if (await lstat(join(rootPath, p)).then((st) => st.isFile(), () => false)) regular.push(p);
  }
  const blobs = new Map();
  for (const chunk of chunksOf(regular)) {
    const raw = await gitRaw(ctx, rootPath, ["ls-tree", "-z", originalHeadSha, "--", ...chunk], { env: LITERAL });
    for (const entry of splitZ(raw)) {
      const tab = entry.indexOf("\t");
      const [mode, type, sha] = entry.slice(0, tab).split(" ");
      if (type === "blob" && mode.startsWith("100")) blobs.set(entry.slice(tab + 1), sha);
    }
  }
  const same = new Set();
  for (const chunk of chunksOf(regular.filter((p) => blobs.has(p)))) {
    const hashes = (await git(ctx, rootPath, ["hash-object", "--", ...chunk], { env: LITERAL })).split("\n");
    chunk.forEach((p, i) => {
      if (hashes[i] === blobs.get(p)) same.add(p);
    });
  }
  return files.filter((p) => !same.has(p));
}

/** Saves the `untracked` entries under the items in the way in one commit
 *  through a temp index, seeded with the pending rescue of a turn-off that
 *  failed half-way, so one commit holds both. Left out: a nested repo's entry
 *  (only Apagar igual gets here with one) and a file already holding the
 *  original commit's content. Reuses the pending commit when nothing new
 *  turned up. The commit gets a ref under RESCUED_PREFIX (no parent, on no
 *  branch) and RESCUED_PENDING points at it. Returns {ref, sha}, or null when
 *  there is nothing to save. */
async function rescueItems(ctx, rootPath, untracked, originalHeadSha) {
  const pending = await gitTry(ctx, rootPath, ["rev-parse", "--verify", "-q", `${RESCUED_PENDING}^{commit}`]);
  const files = await withoutOriginalContent(
    ctx, rootPath, untracked.filter((p) => !isNestedRepoEntry(p)), originalHeadSha,
  );
  if (files.length === 0 && !pending) return null;

  let sha = pending;
  if (files.length > 0) {
    const indexPath = resolve(rootPath, await git(ctx, rootPath, ["rev-parse", "--git-path", RESCUE_INDEX]));
    const env = { GIT_INDEX_FILE: indexPath, ...LITERAL };
    await rm(indexPath, { force: true });
    try {
      if (pending) await git(ctx, rootPath, ["read-tree", pending], { env });
      for (const chunk of chunksOf(files)) await git(ctx, rootPath, ["add", "-f", "--", ...chunk], { env });
      const treeSha = await git(ctx, rootPath, ["write-tree"], { env });
      const pendingTree = pending ? await git(ctx, rootPath, ["rev-parse", `${pending}^{tree}`]) : null;
      if (treeSha !== pendingTree) {
        sha = await git(ctx, rootPath, [...IDENTITY_ARGS, "commit-tree", treeSha, "-m", RESCUE_MESSAGE]);
      }
    } finally {
      await rm(indexPath, { force: true });
    }
  }

  let ref = sha === pending
    ? await gitTry(ctx, rootPath, ["for-each-ref", "--count=1", "--points-at", sha, "--format=%(refname)", RESCUED_PREFIX])
    : null;
  if (!ref) {
    ref = `${RESCUED_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}-${sha.slice(0, 7)}`;
    await git(ctx, rootPath, ["update-ref", ref, sha]);
  }
  await git(ctx, rootPath, ["update-ref", RESCUED_PENDING, sha]);
  return { ref, sha };
}

/** Right before the backup applies: removes the items in the way still on
 *  disk that aren't the original commit's own (one of its files, a folder
 *  holding some, or under core.ignorecase the same path folded). Those would
 *  block the apply, and their content is in the rescue. */
async function clearOutOfTheWay(rootPath, items, original, ignoreCase) {
  if (items.length === 0) return;
  const key = ignoreCase ? foldName : (p) => p;
  const own = new Set();
  for (const p of original) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i += 1) own.add(key(parts.slice(0, i).join("/")));
  }
  for (const item of items) {
    if (!own.has(key(item))) await rm(join(rootPath, item), { recursive: true, force: true });
  }
}

/** Puts back on top of the restored root, unstaged, each file of the rescue
 *  whose exact path is a file of the original commit, unless the root's own
 *  uncommitted changes brought a version of their own (those win). The rest
 *  (a path the root's changes brought, a file under a folder that was in the
 *  way, one where the original has a folder, a case-only name) stays only in
 *  the ref. */
async function writeBack(ctx, rootPath, refs, rescue, original) {
  const files = (await treeFiles(ctx, rootPath, rescue.sha)).sort();
  const originalFiles = new Set(original);
  let claimed = new Set();
  if (refs.backupSha && refs.backupSha !== refs.originalHeadSha) {
    claimed = new Set(splitZ(await gitRaw(ctx, rootPath, [
      "diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", refs.originalHeadSha, refs.backupSha,
    ])));
  }
  const restored = files.filter((p) => originalFiles.has(p) && !claimed.has(p));
  const back = new Set(restored);
  const kept = files.filter((p) => !back.has(p));
  for (const chunk of chunksOf(restored)) {
    await git(ctx, rootPath, ["restore", `--source=${rescue.ref}`, "--worktree", "--", ...chunk], { env: LITERAL });
  }
  return { ref: rescue.ref, restored, kept };
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
