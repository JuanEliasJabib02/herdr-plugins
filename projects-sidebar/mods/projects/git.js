// git on this machine, through Herdr's exec (the person's real environment:
// PATH, HOME, auth), plus gh and `ssh -G` for renaming a pushed branch.
// Projects are local, so nothing here takes a machine. The parsing and the
// decisions live in lib.js, new-workspace-model.js,
// remove-workspace-model.js and rename-workspace-model.js, which tests run
// against a real git (and fakes of gh and ssh).

import { exec, home } from "herdr";
import { resolveProject, listCheckouts } from "./lib.js";
import { fetchOrigin, defaultBaseOf, recentBasesOf, baseExistsIn, branchExistsIn, addWorktreeIn } from "./new-workspace-model.js";
import {
  removalCheck as checkRemoval, removeWorkspace as removeWith, removeTask as removeTaskWith, runHooks, HOOK_TIMEOUT,
} from "./remove-workspace-model.js";
import { renameCheck as checkRename, renameWorkspace as renameWith, sshHostnameOf } from "./rename-workspace-model.js";
import { projectPrs, accountsOf } from "./pr-model.js";
import { readCard, mergePr, readCreateFacts, createPr } from "./pr-card-model.js";

// { ok, out, err } (mods/worktree/main.js `git`). Rejects when git can't
// start there (not installed, or the folder is gone) or at exec's limit: 30
// s, or `timeout` ms when given (Crear PR's push, whose hooks run).
export async function git(cwd, args, { timeout } = {}) {
  const r = await exec("git", args, timeout ? { cwd, timeout } : { cwd });
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

// Whether a project's saved base (origin/<branch>) is there, by one exact
// ref lookup (D37): a gone one makes the default origin's again.
export const baseExists = (repo, base) => baseExistsIn(repo, base, git);

// refs/heads/<name> exists in the repo.
export const branchExists = (repo, name) => branchExistsIn(repo, name, git);

// `git worktree add --no-track -b <name> -- <path> <base>`: { ok, out, err }.
export const addWorktree = (repo, { name, path, base }) => addWorktreeIn(repo, { name, path, base }, git);

// ── Delete (D22–D24) ───────────────────────────────────────────────────────

// What deleting a workspace would take, from a fresh list: { deletable,
// reason, failed, locked, lockReason, changes, submodules, branch,
// mainBranch, list }. Never rejects.
export const removalCheck = ({ project, path }) => checkRemoval({ project, path }, { git, exists: pathExists });

// One of other plugins' remove hooks (Spotlight's D43): its argv through
// exec, never a shell, in the home folder (the workspace's folder is about
// to go), for at most HOOK_TIMEOUT (120 s), past which exec rejects. What it
// answers is ignored.
const runHook = (argv) => exec(argv[0], argv.slice(1), { cwd: home(), timeout: HOOK_TIMEOUT });

// Runs other plugins' remove hooks for `path`: `hooks`, a list of
// store.removeHooks() (`workspace` or `project`), one after another, each
// awaited, every failure ignored (remove-workspace-model.js runHooks). Never
// rejects.
export const runRemoveHooks = (hooks, path) => runHooks(hooks, path, runHook);

// Deletes a workspace in D23's order: check again, other plugins' workspace
// hooks (`hooks`: store.removeHooks().workspace, run with the workspace's
// path, each awaited), closeSpaces() (awaited; it closes the workspace's
// spaces and waits until they are gone), git worktree remove, git branch -d.
// `seen`: the removalCheck the person confirmed. Resolves { status, err,
// branch, branchErr, list, check }; never rejects.
export const removeWorkspace = ({ project, path, seen }, { closeSpaces, hooks }) =>
  removeWith({ project, path, seen }, { git, exists: pathExists, closeSpaces, beforeRemove: (dir) => runRemoveHooks(hooks, dir) });

// Deletes a task's workspaces (D36's Run): targets = [{ project, path, seen
// }], one at a time, each through removeWorkspace with closeSpaces(target)
// (required: without it nothing is removed) and the workspace `hooks` run
// with that target's path. each(result, i): after every target that ran (a
// throw is ignored). alive(): asked before every target after the first;
// false or a throw skips the rest ("Stopped: the plugin was reloaded.").
// Resolves [{ project, path, status, err, branch, branchErr, list, check }]
// in the targets' order; never rejects.
export const removeTask = ({ targets }, { closeSpaces, each, alive, hooks }) =>
  removeTaskWith({ targets }, { git, exists: pathExists, closeSpaces, each, alive, beforeRemove: (dir) => runRemoveHooks(hooks, dir) });

// ── Rename (D25–D26, D28) ──────────────────────────────────────────────────

// gh, through exec like git, with the person's own account: { ok, code, out,
// err }. Rejects when gh can't start (not installed). No token ever comes
// back into the mod: only `gh api` answers.
export async function gh(cwd, args) {
  const r = await exec("gh", args, { cwd });
  return { ok: r.code === 0, code: r.code, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The host an ssh alias of ~/.ssh/config really is (github-work →
// github.com), from `ssh -G`, which reads the config and connects to
// nothing. null when ssh can't tell.
export async function sshHostname(host) {
  if (!host || host.startsWith("-")) return null;
  try {
    const r = await exec("ssh", ["-G", host]);
    return r.code === 0 ? sshHostnameOf(r.stdout) : null;
  } catch {
    return null;
  }
}

// Rename's one binding of the network (D28): git, which reaches origin
// (ls-remote, fetch, push) in the person's own environment (no
// GIT_TERMINAL_PROMPT: exec has no terminal to prompt on; never
// GIT_SSH_COMMAND, which would override their core.sshCommand), gh, ssh -G,
// and the sleep between looks at origin: the spawned task's cx.sleep (D23
// step 2), none when no task is given.
const renameIo = (cx) => ({ git, exists: pathExists, gh, hostname: sshHostname, sleep: cx ? (ms) => cx.sleep(ms) : undefined });

// Whether renaming the workspace at `path` to the typed `name` may run, from
// a fresh list and, for a pushed branch, from what origin has now; changes
// nothing. moveFolder false: a taken new folder is reported (folderTaken),
// not refused. Resolves { status: "ok" | "refused" | "failed", reason, err,
// branch, list, origin, … }; never rejects.
export const renameCheck = ({ project, path, name, moveFolder }) => checkRename({ project, path, name, moveFolder }, renameIo(null));

// Renames a workspace in D26's and D28's order: check again (and "changed"
// when origin's path or its PRs differ from `seen`, what the dialog showed),
// the remote first (gh on GitHub, else a copy pushed), `git branch -m`, the
// upstream, then, with moveFolder (no space and no terminal in the folder:
// the dialog decides), `git worktree move`. `cx`: the spawned task's, for
// the sleeps while GitHub renames. Resolves { status: "renamed" | "refused" |
// "changed" | "failed", reason, branch, name, folder, err, list, remote,
// prs, check }; never rejects.
export const renameWorkspace = ({ project, path, name, moveFolder, seen }, cx) =>
  renameWith({ project, path, name, moveFolder, seen }, renameIo(cx));

// ── PR status ──────────────────────────────────────────────────────────────

// gh as one of the accounts gh is logged into, in `cwd`: GH_TOKEN is set from
// `gh auth token --user <login>` inside the shell, so the token never comes
// into the mod (a gh wrapper leaves an explicit GH_TOKEN alone). Exit 4, like
// gh logged out, when there is no token for that login. { ok, code, out, err }.
const AS_ACCOUNT = 'GH_TOKEN="$(gh auth token --user "$1" 2>/dev/null)"; [ -n "$GH_TOKEN" ] || exit 4; export GH_TOKEN; shift; exec gh "$@"';

export async function ghAs(login, cwd, args) {
  const r = await exec("sh", ["-c", AS_ACCOUNT, "sh", login, ...args], { cwd });
  return { ok: r.code === 0, code: r.code, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The github.com accounts gh is logged into; [] when gh can't say.
export async function ghAccounts() {
  try {
    const r = await exec("gh", ["auth", "status", "--json", "hosts"]);
    return accountsOf(r.stdout);
  } catch {
    return [];
  }
}

const prIo = { git, gh, ghAs, accounts: ghAccounts, hostname: sshHostname };

// The PRs of a project's workspaces (pr-model.js projectPrs): { ok, prs }.
// `memo`: pr-model.js prMemo(), kept by the caller between rounds.
export const workspacePrs = (project, checkouts, memo) => projectPrs(project, checkouts, prIo, memo);

// What the PR card shows for one workspace (pr-card-model.js readCard), asked
// through the same account path: space = { project, path, branch }; `memo`:
// the card's own prMemo(). Never rejects.
export const readPrCard = ({ project, path, branch }, memo) => readCard({ project, path, branch }, prIo, memo);

// Mergear (D6, pr-card-model.js mergePr): checks the PR again, then merges it
// through GitHub's REST API with the account that read it (`seen.who`: gh in
// the project's folder, or that login through ghAs), pinned to the head
// commit the card showed. Resolves { status, err, note }; never rejects.
export const mergePullRequest = ({ project, seen }) => mergePr({ project, seen }, prIo);

// Crear PR (D7, pr-card-model.js readCreateFacts): what the dialog starts
// from, read when it opens: the branch's last commit's subject, and whether
// it must be published first (origin asked with ls-remote). Publishes and
// creates nothing. Resolves { title, push }; never rejects.
export const createPrFacts = ({ path, branch }) => readCreateFacts({ path, branch }, prIo);

// Crear PR (D7, pr-card-model.js createPr): checks origin and the branch
// again, publishes it first when needed (`git push -u origin <branch>`,
// never forced, with PUSH_TIMEOUT), then creates the PR through GitHub's
// REST API with the account that read the card (`seen.who`: gh in the
// project's folder, or that login through ghAs). Resolves { status, err,
// pr, plan }; never rejects.
export const createPullRequest = ({ project, path, seen, base, title, body, draft, push }) =>
  createPr({ project, path, seen, base, title, body, draft, push }, prIo);
