// git on this machine, through Herdr's exec (the person's real environment:
// PATH, HOME, auth). Projects are local, so nothing here takes a machine.
// The parsing and the decisions live in lib.js, which tests run against a
// real git.

import { exec } from "herdr";
import { resolveProject, listCheckouts } from "./lib.js";

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
