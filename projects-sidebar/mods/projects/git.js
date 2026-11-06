// git on this machine, through Herdr's exec (the person's real environment:
// PATH, HOME, auth). Projects are local, so nothing here takes a machine.
// The parsing and the decisions live in lib.js, new-workspace-model.js,
// remove-workspace-model.js and rename-workspace-model.js, which tests run
// against a real git.

import { exec } from "herdr";
import { resolveProject, listCheckouts } from "./lib.js";
import { fetchOrigin, defaultBaseOf, recentBasesOf, branchExistsIn, addWorktreeIn } from "./new-workspace-model.js";
import { removalCheck as checkRemoval, removeWorkspace as removeWith } from "./remove-workspace-model.js";
import { renameCheck as checkRename, renameWorkspace as renameWith } from "./rename-workspace-model.js";

// { ok, out, err } (mods/worktree/main.js `git`). Rejects when git can't
// start there: not installed, or the folder is gone.
export async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The project a folder belongs to: { path, name } of its repo's main
// checkout, or of the folder itself outside git.
export const repoOf = (folder) => resolveProject(folder, git);

// A project's workspaces, [{ path, branch, main }], the main checkout first.
export const listWorktrees = (project) => listCheckouts(project, git);

// Whether a path exists (`test -e`); false when it can't be checked.
export async function pathExists(path) {
  try {
    return (await exec("test", ["-e", path])).code === 0;
  } catch {
    return false;
  }
}

// ── New workspace (D12–D14) ────────────────────────────────────────────────

// `git fetch origin` in a repo; never rejects ({ ok: false, err } when it
// fails or hits exec's 30 s limit).
export const fetch = (repo) => fetchOrigin(repo, git);

// The base a new workspace starts from (origin/HEAD's target, else
// origin/main, origin/master, main, master, else HEAD); null outside git.
export const defaultBase = (repo) => defaultBaseOf(repo, git);

// The 30 most recently committed origin/… branches, newest first.
export const recentBases = (repo) => recentBasesOf(repo, git);

// refs/heads/<name> exists in the repo.
export const branchExists = (repo, name) => branchExistsIn(repo, name, git);

// `git worktree add --no-track -b <name> -- <path> <base>`: { ok, out, err }.
export const addWorktree = (repo, { name, path, base }) => addWorktreeIn(repo, { name, path, base }, git);

// ── Delete (D22–D24) ───────────────────────────────────────────────────────

// What deleting a workspace would take, from a fresh list: { deletable,
// reason, failed, locked, lockReason, changes, submodules, branch,
// mainBranch, list }. Never rejects.
export const removalCheck = ({ project, path }) => checkRemoval({ project, path }, { git, exists: pathExists });

// Deletes a workspace in D23's order: check again, closeSpaces() (awaited;
// it closes the workspace's spaces and waits until they are gone), git
// worktree remove, git branch -d. `seen`: the removalCheck the person
// confirmed. Resolves { status, err, branch, branchErr, list, check }; never
// rejects.
export const removeWorkspace = ({ project, path, seen }, { closeSpaces }) =>
  removeWith({ project, path, seen }, { git, exists: pathExists, closeSpaces });

// ── Rename (D25–D26) ───────────────────────────────────────────────────────

// Whether renaming the workspace at `path` to the typed `name` may run, from
// a fresh list; changes nothing. Resolves { status: "ok" | "refused" |
// "failed", reason, err, branch, list, … }; never rejects.
export const renameCheck = ({ project, path, name }) => checkRename({ project, path, name }, { git, exists: pathExists });

// Renames a workspace in D26's order: check again, `git branch -m`, then,
// with moveFolder (no space and no terminal in the folder: the dialog
// decides), `git worktree move`. Resolves { status: "renamed" | "refused" |
// "failed", reason, branch, folder: "moved" | "kept" | "stays" | null, err,
// list }; never rejects.
export const renameWorkspace = ({ project, path, name, moveFolder }) =>
  renameWith({ project, path, name, moveFolder }, { git, exists: pathExists });
