// git on this machine, through Herdr's exec (the person's real environment:
// PATH, HOME, auth). Projects are local, so nothing here takes a machine.
// The parsing and the decisions live in lib.js and new-workspace-model.js,
// which tests run against a real git.

import { exec } from "herdr";
import { resolveProject, listCheckouts } from "./lib.js";
import { fetchOrigin, defaultBaseOf, recentBasesOf, branchExistsIn, addWorktreeIn } from "./new-workspace-model.js";

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
