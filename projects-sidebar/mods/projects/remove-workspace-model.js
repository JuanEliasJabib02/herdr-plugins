// Delete's model (S20–S21, D22–D24), with no herdr or gpui-kit imports so
// `node --test` can load it: what a workspace's deletion would take
// (removalCheck), the deletion itself in a fixed order (removeWorkspace),
// which spaces close with it (spacesToClose), and a task's workspaces deleted
// one after another (removeTask, S30, D36). git and the file check are
// passed in (M/git.js binds them to Herdr's exec; tests pass a real git), like
// createWorkspace. Every outcome is read from git's state (the worktree list,
// the refs, the exit code), never from its words: they are translated under
// another locale and reworded across versions. Other plugins' remove hooks
// (Spotlight's D43) run before the spaces close and before a project leaves
// the list (parseRemoveHooks, runHooks, removeProjectWith); M/git.js runs
// them through exec.

import { normPath, baseName, isAbsolute, parseWorktrees, WORKTREE_LIST } from "./lib.js";
import { actionOf } from "./badges-model.js";

// ── The git it runs ────────────────────────────────────────────────────────
// Paths and branches only ever reach git as one argv entry each (Herdr's exec
// runs no shell), after `--`.

export const GIT = {
  // Never the cache: what git knows now (lib.js: no optional locks, no
  // fsmonitor, so a listing never wakes the .git watch).
  list: WORKTREE_LIST,
  // In the worktree. Untracked files count whatever status.showUntrackedFiles
  // says, and so do submodule edits whatever ignore-submodules says: git
  // worktree remove refuses on both.
  status: ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"],
  // In the worktree: its own git dir's modules folder (absolute in a linked
  // worktree, relative to it in a main checkout).
  modules: ["rev-parse", "--git-path", "modules"],
  // In the worktree: the index, NUL-separated, to find gitlinks (mode 160000).
  index: ["ls-files", "--stage", "-z"],
  // In the main checkout. --force once at most: it overrides changes and
  // submodules, never a lock (that takes it twice).
  remove: (path, force) => ["worktree", "remove", ...(force ? ["--force"] : []), "--", path],
  // In the main checkout. -d keeps a branch with unmerged commits; -D would
  // lose them (Orca deletes with -d too).
  deleteBranch: (branch) => ["branch", "-d", "--", branch],
  branch: (branch) => ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
};

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

const message = (e) => firstLine(e?.message ?? e) || "git didn't answer";

// git's first line without a clause that tells the person to force it
// ("…, use --force to delete it"): Delete never advises forcing, because a
// force wipes what git was protecting. The flag isn't translated, so this
// holds in every locale.
const withoutForceAdvice = (line) => line.replace(/[,;]?[^,;]*--force.*$/, "").trim();

// ── The lock ───────────────────────────────────────────────────────────────

// Why `git worktree list --porcelain` output (`out`) says the worktree at
// `path` is locked: its reason, "" when locked without one, null when it
// isn't locked or isn't listed. parseWorktrees drops the `locked` line, and
// lib.js stays frozen, so this reads it.
export function lockOf(out, path) {
  const want = normPath(path);
  for (const block of String(out ?? "").replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const at = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!at || normPath(at) !== want) continue;
    const lock = lines.find((l) => l === "locked" || l.startsWith("locked "));
    return lock === undefined ? null : lock.slice(7);
  }
  return null;
}

// ── The check ──────────────────────────────────────────────────────────────

// The project's worktrees as git lists them now: { ok, out, list, err }.
// Never rejects.
async function listNow(project, git) {
  try {
    const r = await git(project, GIT.list);
    return r.ok ? { ok: true, out: r.out, list: parseWorktrees(r.out), err: "" } : { ok: false, out: "", list: null, err: firstLine(r.err) };
  } catch (e) {
    return { ok: false, out: "", list: null, err: message(e) };
  }
}

// A git step of the check that must answer; throws with git's first line.
async function ask(git, cwd, args) {
  const r = await git(cwd, args);
  if (!r.ok) throw new Error(firstLine(r.err) || `git ${args.join(" ")} failed`);
  return r.out;
}

// git's own refusal test for removing a worktree with submodules (ported
// from Orca's containsSubmoduleCheckout): its git dir has a modules folder,
// or a gitlink of its index is checked out with its own .git. Reading
// .gitmodules would miss a modules folder a failed `submodule update` left,
// and a gitlink committed without .gitmodules.
async function hasSubmoduleCheckout(dir, git, exists) {
  const modules = await ask(git, dir, GIT.modules);
  if (await exists(isAbsolute(modules) ? normPath(modules) : normPath(`${dir}/${modules}`))) return true;
  const index = await ask(git, dir, GIT.index);
  for (const entry of index.split("\0")) {
    const tab = entry.indexOf("\t");
    if (!entry.startsWith("160000 ") || tab < 0) continue;
    if (await exists(`${dir}/${entry.slice(tab + 1)}/.git`)) return true;
  }
  return false;
}

// What deleting the workspace at `path` of `project` (its main checkout)
// would take, from a fresh list (never the cache). io = { git, exists }.
// Never rejects. Resolves
//   { deletable, reason, failed, locked, lockReason, changes, submodules,
//     branch, mainBranch, list }
// deletable: a non-main checkout of the project that isn't locked and whose
//   state git answered for; changes or submodules don't forbid it, they ask
//   for "Delete anyway" (a --force).
// reason: why it isn't deletable, "" when it is.
// failed: git couldn't be asked (the list, the status or the submodule test
//   failed or hit exec's limit): nothing is known, so nothing may run.
// lockReason: the lock's reason ("" without one), null when not locked.
// branch: the workspace's branch, null when detached. mainBranch: the main
//   checkout's, for "It isn't merged into <mainBranch>".
// list: the fresh [{ path, branch, main }], null when it couldn't be read.
export async function removalCheck({ project, path }, { git, exists }) {
  const repo = normPath(project);
  const dir = normPath(path);
  const name = baseName(repo);
  const none = {
    deletable: false, reason: "", failed: false, locked: false, lockReason: null,
    changes: false, submodules: false, branch: null, mainBranch: null, list: null,
  };
  const now = await listNow(repo, git);
  if (!now.ok) return { ...none, failed: true, reason: `Couldn't list the workspaces of ${name}: ${now.err || "git didn't answer"}.` };
  const known = { ...none, mainBranch: now.list.find((c) => c.main)?.branch ?? null, list: now.list };
  const entry = now.list.find((c) => c.path === dir);
  if (!entry) return { ...known, reason: `${dir} isn't one of ${name}'s workspaces.` };
  if (entry.main) return { ...known, branch: entry.branch, reason: `${dir} is the main checkout of ${name}: it is never deleted.` };
  let changes;
  let submodules;
  try {
    changes = (await ask(git, dir, GIT.status)) !== "";
    submodules = await hasSubmoduleCheckout(dir, git, exists);
  } catch (e) {
    return { ...known, branch: entry.branch, failed: true, reason: `Couldn't check ${dir}: ${message(e)}.` };
  }
  const lockReason = lockOf(now.out, dir);
  const locked = lockReason !== null;
  const unlock = `Unlock it with \`git worktree unlock ${dir}\`.`;
  return {
    ...known,
    deletable: !locked,
    reason: locked ? `Locked by git${lockReason ? `: ${lockReason}` : ""}. ${unlock}` : "",
    locked,
    lockReason,
    changes,
    submodules,
    branch: entry.branch,
  };
}

// ── Spaces ─────────────────────────────────────────────────────────────────

// The spaces that show the workspace at `path` and close with it: the ids
// matchSpaces (lib.js) matched to that path, and to no other.
export function spacesToClose(matches, path) {
  const dir = normPath(path);
  return Object.entries(matches ?? {}).filter(([, m]) => normPath(m?.path) === dir).map(([id]) => id);
}

// ── The deletion ───────────────────────────────────────────────────────────

// Deletes the workspace at `path` of `project`, in this order (D23):
//   1. removalCheck again. Not a non-main checkout → "refused"; locked →
//      "locked"; changes or submodules that `seen` (the check the person
//      confirmed) didn't have → "changed"; git unanswered → "failed". In all
//      of them nothing runs, beforeRemove and closeSpaces included.
//   2. await io.beforeRemove(path), other plugins' workspace hooks with the
//      normalized path (Spotlight's D43: M/git.js binds it to runHooks), a
//      throw or a rejection ignored: a hook never stops a delete. Then
//      await io.closeSpaces() (it waits until the spaces are gone).
//   3. git worktree remove, with one --force only when `seen` had changes or
//      submodules. A re-list decides: still listed → "failed", with the
//      didn't-finish text when git rejected (exec's 30 s limit), else git's
//      first line, never advice to force.
//   4. The branch: detached → "none"; another checkout of the fresh list is
//      on it → "in-use" (no branch -d); else git branch -d, then "kept" while
//      refs/heads/<b> is still there (branchErr: git's first line), else
//      "deleted".
//   5. The fresh list goes back for the dialog to store.
// req = { project, path, seen }; io = { git, exists, closeSpaces,
// beforeRemove? }. Never rejects. Resolves
//   { status: "removed" | "refused" | "locked" | "changed" | "failed",
//     err, branch: "deleted" | "kept" | "in-use" | "none" | null, branchErr,
//     list, check }
// err: why it isn't "removed" (null when it is). list: the freshest
// [{ path, branch, main }], null when it couldn't be read. check: step 1's
// removalCheck ("changed" shows it; the branch's name for "kept").
export async function removeWorkspace({ project, path, seen }, io) {
  const repo = normPath(project);
  const dir = normPath(path);
  const label = baseName(dir);
  const check = await removalCheck({ project: repo, path: dir }, io);
  const result = (status, more = {}) => ({ status, err: null, branch: null, branchErr: null, list: check.list, check, ...more });

  // 1. Check again.
  if (check.failed) return result("failed", { err: check.reason });
  if (check.locked) return result("locked", { err: check.reason });
  if (!check.deletable) return result("refused", { err: check.reason });
  const confirmed = { changes: Boolean(seen?.changes), submodules: Boolean(seen?.submodules) };
  if (check.changes && !confirmed.changes) return result("changed", { err: `${label} now has changes that aren't committed.` });
  if (check.submodules && !confirmed.submodules) return result("changed", { err: `${label} now has submodules.` });

  // 2. Other plugins' hooks, then close the spaces.
  try {
    await io.beforeRemove?.(dir);
  } catch {
    // runHooks never rejects; a binding that does still lets the delete go on
  }
  try {
    await io.closeSpaces?.();
  } catch (e) {
    return result("failed", { err: `Couldn't close the spaces of ${label}: ${message(e)}.` });
  }

  // 3. Remove the worktree.
  let removal = null;
  let rejected = false;
  try {
    removal = await io.git(repo, GIT.remove(dir, confirmed.changes || confirmed.submodules));
  } catch {
    rejected = true;
  }
  const after = await listNow(repo, io.git);
  const didntFinish = `git didn't finish; the folder may be partly deleted. Check \`git worktree list\` in ${repo}.`;
  const refusal = () => withoutForceAdvice(firstLine(removal?.err)) || `git couldn't remove ${label}.`;
  if (!after.ok) {
    const err = rejected ? didntFinish : removal?.ok ? `Couldn't list the workspaces of ${baseName(repo)} again: ${after.err || "git didn't answer"}.` : refusal();
    return result("failed", { err, list: null });
  }
  if (after.list.some((c) => c.path === dir)) return result("failed", { err: rejected ? didntFinish : refusal(), list: after.list });

  // 4. The branch.
  const removed = (branch, branchErr = null) => result("removed", { branch, branchErr, list: after.list });
  const b = check.branch;
  if (!b) return removed("none");
  if (after.list.some((c) => c.branch === b)) return removed("in-use");
  let deletion;
  try {
    deletion = await io.git(repo, GIT.deleteBranch(b));
  } catch (e) {
    deletion = { ok: false, err: message(e) };
  }
  let still;
  try {
    still = (await io.git(repo, GIT.branch(b))).ok;
  } catch {
    still = true; // unknown: never report a deletion that wasn't seen
  }
  return still ? removed("kept", firstLine(deletion?.err) || `git kept ${b}.`) : removed("deleted");
}

// ── A task's deletion ──────────────────────────────────────────────────────

const STOPPED = "Stopped: the plugin was reloaded.";

// Whether the run may go on to the next target: io.alive() (the dialog binds
// it to its task's bg.sleep(0)), awaited. Only false, a throw or a rejection
// stop it: bg.sleep(0)'s undefined goes on. No alive: it always goes on.
async function goesOn(io) {
  if (typeof io?.alive !== "function") return true;
  try {
    return (await io.alive()) !== false;
  } catch {
    return false;
  }
}

// Deletes a task's workspaces (S30, D36's Run). targets = [{ project, path,
// seen }], each `seen` its own row's removalCheck as the dialog showed it, so
// "Delete anyway" forces only the rows that had changes or submodules.
//   - One target at a time, never together: targets share repos, and git
//     locks .git/worktrees. Each runs removeWorkspace's whole D23 sequence
//     (check again, other plugins' hooks, close its spaces, remove, branch
//     -d only if merged), with closeSpaces bound to it:
//     io.closeSpaces(target); io.beforeRemove reaches it as it is, called
//     with that target's path. A missing closeSpaces fails that target
//     before anything is removed.
//   - A failure doesn't stop the others.
//   - io.each(result, i) is awaited after every target that ran, with its
//     entry of the result and its index; a throw or a rejection is ignored.
//   - Before every target after the first, io.alive() is asked (goesOn).
//     Once it says no, it isn't asked again: that target and the rest don't
//     run, read "skipped" with "Stopped: the plugin was reloaded.", and get
//     no each.
// io = { git, exists, closeSpaces(target), each?(result, i), alive?(),
// beforeRemove?(path) }. Never rejects. Resolves, in the targets' order,
//   [{ project, path, ...removeWorkspace's { status, err, branch, branchErr,
//      list, check } }]
// with status "skipped" too (branch, branchErr, list and check null), and
// project and path as the target gave them.
export async function removeTask(req, io) {
  const targets = Array.isArray(req?.targets) ? req.targets : [];
  const results = [];
  let stopped = false;
  for (const [i, target] of targets.entries()) {
    const { project, path, seen } = target ?? {};
    if (i > 0 && !stopped) stopped = !(await goesOn(io));
    if (stopped) {
      results.push({ project, path, status: "skipped", err: STOPPED, branch: null, branchErr: null, list: null, check: null });
      continue;
    }
    let result;
    try {
      result = await removeWorkspace({ project, path, seen }, { ...io, closeSpaces: () => io.closeSpaces(target) });
    } catch (e) {
      // removeWorkspace never rejects; this keeps removeTask's promise anyway.
      result = { status: "failed", err: message(e), branch: null, branchErr: null, list: null, check: null };
    }
    const entry = { project, path, ...result };
    results.push(entry);
    try {
      await io?.each?.(entry, i);
    } catch {
      // the dialog that stores it may be gone; the run goes on
    }
  }
  return results;
}

// ── Other plugins' remove hooks (Spotlight's D43) ──────────────────────────
// A plugin that holds on to a workspace or a project (Spotlight: a root lit
// from a workspace, its refs) gets to let go before it goes, without this
// plugin knowing it: it publishes programs under config.js REMOVE_HOOK_KEYS,
// and Delete, Delete task and Remove from list run them first. The contract
// is RECIPE.md "Remove hooks from other plugins"; it only grows.
//
//   each key:  { workspace?: argv, project?: argv }
//   argv:      [program, ...args], a badge's exec (badges-model.js actionOf);
//              an argument that is exactly "{path}" becomes the path

// How long one hook may run (exec's timeout, M/git.js): past it, exec
// rejects and the next hook, or the delete, goes on.
export const HOOK_TIMEOUT = 120_000;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// A hook's argv, or null: a badge's exec rules (argv[0] absolute or a bare
// name, 1 to 20 strings of at most 500 chars, no NUL).
const hookOf = (argv) => actionOf({ exec: argv }, null)?.exec ?? null;

// Every plugin's hooks: { workspace: [argv], project: [argv] }, each list in
// the keys' order. `values`: the keys' shared() values, in that order
// (store.js removeHooks()). A bad argv is dropped alone, the plugin's other
// one kept; any other field is ignored; a value that isn't an object is no
// hooks. Never throws.
export function parseRemoveHooks(values) {
  const hooks = { workspace: [], project: [] };
  if (!Array.isArray(values)) return hooks;
  for (const value of values) {
    if (!isObject(value)) continue;
    for (const kind of ["workspace", "project"]) {
      const argv = hookOf(value[kind]);
      if (argv) hooks[kind].push(argv);
    }
  }
  return hooks;
}

// The argv a hook runs for `path`: every argument after the program that is
// exactly "{path}" becomes the path, one argument as it is, never part of
// another (no quoting to get wrong: exec runs no shell). The program is never
// replaced: it was checked as one (an absolute path or a bare name), and a
// path in its place would run a file the workspace holds. A new list.
export function hookArgv(argv, path) {
  return argv.map((a, i) => (i > 0 && a === "{path}" ? path : a));
}

// Runs `hooks` (parseRemoveHooks' workspace or project list) for `path`, one
// after another, each awaited: `run(argv)` (M/git.js: exec in the home folder
// with HOOK_TIMEOUT) resolving, rejecting or throwing, the next one runs. Its
// outcome is ignored: a hook never stops a delete. An entry that isn't a list
// is skipped; no hooks or no run, nothing runs. Never rejects.
export async function runHooks(hooks, path, run) {
  if (!Array.isArray(hooks) || typeof run !== "function") return;
  for (const argv of hooks) {
    if (!Array.isArray(argv)) continue;
    try {
      await run(hookArgv(argv, path));
    } catch {
      // failed, timed out or couldn't start: the next hook runs anyway
    }
  }
}

// Remove from list (D11) with other plugins' project hooks first:
//   1. await io.beforeRemove(path), the project hooks with its normalized
//      path (project-menu.js binds it to M/git.js runRemoveHooks), a throw
//      or a rejection ignored: a hook never keeps a project in the list.
//   2. await io.remove(path), the registry and cache writes.
// req = { project }; io = { beforeRemove?(path), remove(path) }. Resolves
// once the project is off the list; rejects only when remove does.
export async function removeProjectWith({ project }, io) {
  const path = normPath(project);
  try {
    await io?.beforeRemove?.(path);
  } catch {
    // runHooks never rejects; a binding that does still lets the removal go on
  }
  await io.remove(path);
}
