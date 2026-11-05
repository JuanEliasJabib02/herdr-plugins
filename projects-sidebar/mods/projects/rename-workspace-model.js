// The Rename dialog's model (D25–D26), with no herdr or gpui-kit imports so
// `node --test` can load it: the name a rename gives, the checks that refuse
// it, and the rename itself, the branch first and then the folder when the
// dialog says it may move. git and the file check are passed in (M/git.js
// binds them to Herdr's exec; tests pass a real git), like
// new-workspace-model.js. Every outcome is read from git's state (refs,
// config, the worktree list), never from its words: they are translated
// under es_ES and change across versions.

import { normPath, baseName, listCheckouts } from "./lib.js";
import { slug } from "./new-workspace-model.js";

// ── Names (D25) ────────────────────────────────────────────────────────────

// What typed text becomes as a branch: each `/` segment slugged like D12,
// empty ones dropped, so a namespace (user/feat) survives and every segment
// is a name git takes. "" when nothing is left.
export function branchName(text) {
  if (typeof text !== "string") return "";
  return text.split("/").map(slug).filter(Boolean).join("/");
}

// The rename the typed text asks of a branch: { name, unchanged }. Text
// equal to the old branch (spaces around it aside) is unchanged before any
// slugging, so an untouched prefill of `Feature/ABC-1` never becomes
// `feature/abc-1`; a text that slugs to the old branch is unchanged too.
export function renameTarget(text, oldBranch) {
  const typed = typeof text === "string" ? text.trim() : "";
  if (oldBranch && typed === oldBranch) return { name: oldBranch, unchanged: true };
  const name = branchName(typed);
  return { name, unchanged: Boolean(name) && name === oldBranch };
}

// Where a renamed workspace's folder goes: a sibling of the one it is in,
// named after the branch's last segment (D27's label; D12 names folders
// after the branch).
export function folderFor(path, name) {
  const p = normPath(path);
  const parent = p.slice(0, p.lastIndexOf("/"));
  return normPath(`${parent}/${String(name).split("/").pop()}`);
}

// Folders that macOS treats as one: a move from Feat-x to feat-x would find
// its target "already there".
const sameFolder = (a, b) => a.toLowerCase() === b.toLowerCase();

// ── git ────────────────────────────────────────────────────────────────────

// The git each step runs, in the project's main checkout; the worktree list
// is lib.js's WORKTREE_LIST (listCheckouts). Typed text only reaches git as
// one argv entry (Herdr's exec runs no shell), slugged so it never starts
// with a dash, and `--` ends the options before names and paths.
export const GIT = {
  branch: (b) => ["show-ref", "--verify", "--quiet", `refs/heads/${b}`],
  // Any remote's copy of the branch (origin/b, github/b…): `*` stops at a
  // slash, so origin/x/b doesn't count.
  remoteRef: (b) => ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${b}`],
  merge: (b) => ["config", "--get-all", `branch.${b}.merge`],
  remote: (b) => ["config", "--get", `branch.${b}.remote`],
  rename: (from, to) => ["branch", "-m", "--", from, to],
  unsetUpstream: (b) => ["branch", "--unset-upstream", "--", b],
  move: (from, to) => ["worktree", "move", "--", from, to],
};

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const message = (e) => firstLine(e?.message ?? e) || "git didn't answer.";
const lines = (out) => String(out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// git(cwd, args) that never rejects: a rejection (exec's 30 s limit, git
// gone) reads as { ok: false, err }.
const safe = (git) => async (cwd, args) => {
  try {
    return await git(cwd, args);
  } catch (e) {
    return { ok: false, out: "", err: message(e) };
  }
};

// ── Check (D26 step 1) ─────────────────────────────────────────────────────

const refused = (reason, err, branch, list) => ({ status: "refused", reason, err, branch, list });

// Whether a rename of `path`'s branch to the typed `name` may run, read on a
// fresh worktree list. Changes nothing.
//   req = { project, path, name }   io = { git, exists }
// Resolves
//   { status: "ok", branch, name, newPath, sameFolder, tracking, list }
//     branch: the branch now; name: the new one; newPath: where the folder
//     would go (sameFolder: it already is there); tracking: it has an
//     upstream with another name, unset after the rename
//   { status: "refused", reason, err, branch, list }  reason: "missing" |
//     "main" | "detached" | "empty" | "unchanged" | "published" |
//     "branch-exists" | "folder-exists"; err: what the dialog shows
//   { status: "failed", reason: null, err, branch: null, list: null }  the
//     list couldn't be read
export async function renameCheck({ project, path, name }, io) {
  let list;
  try {
    list = await listCheckouts(project, io.git);
  } catch (e) {
    return { status: "failed", reason: null, err: message(e), branch: null, list: null };
  }
  const git = safe(io.git);
  const here = normPath(path);
  const entry = list.find((w) => w.path === here);
  if (!entry) return refused("missing", `${here} isn't a workspace of ${baseName(project)}.`, null, list);
  if (entry.main) return refused("main", "The main checkout isn't renamed: rename one of its workspaces.", entry.branch, list);
  const old = entry.branch;
  if (!old) return refused("detached", `${baseName(here)} is detached or in the middle of a rebase.`, null, list);
  const target = renameTarget(name, old);
  if (!target.name) return refused("empty", "Type a name for the branch.", old, list);
  if (target.unchanged) return refused("unchanged", `The branch is already ${old}.`, old, list);
  const pushed = await publishedAs(project, old, git);
  if (pushed) return refused("published", `Already pushed as ${pushed}: renaming would split it from GitHub.`, old, list);
  if ((await git(project, GIT.branch(target.name))).ok) return refused("branch-exists", `Branch ${target.name} already exists.`, old, list);
  const newPath = folderFor(here, target.name);
  const same = sameFolder(newPath, here);
  if (!same && (await io.exists(newPath))) return refused("folder-exists", `${newPath} already exists.`, old, list);
  const merges = lines((await git(project, GIT.merge(old))).out);
  return { status: "ok", reason: null, err: "", branch: old, name: target.name, newPath, sameFolder: same, tracking: merges.length > 0, list };
}

// Where the branch is published, as "<remote>/<branch>", or null. Published
// means a remote has a copy of it (refs/remotes/<any remote>/<b>), or its
// upstream is a branch with its own name (branch.<b>.merge = refs/heads/<b>),
// which holds after the remote copy is deleted and pruned. An upstream with
// another name (origin/main, a local main) is where it started, not where it
// went: git's default for `worktree add -b x … origin/main`.
async function publishedAs(project, branch, git) {
  const ref = lines((await git(project, GIT.remoteRef(branch))).out)[0];
  if (ref) return ref.replace(/^refs\/remotes\//, "");
  const merges = lines((await git(project, GIT.merge(branch))).out);
  if (!merges.includes(`refs/heads/${branch}`)) return null;
  const remote = firstLine((await git(project, GIT.remote(branch))).out) || "origin";
  return `${remote}/${branch}`;
}

// ── Rename (D26) ───────────────────────────────────────────────────────────

// Renames a workspace's branch and, when `moveFolder` (no space and no pane
// in the folder: the dialog decides), moves its folder to folderFor(path,
// name).
//   req = { project, path, name, moveFolder }   io = { git, exists }
// 1. renameCheck; a refusal or a failure there runs nothing.
// 2. `git branch -m <old> <new>` in the main checkout. It counts only when
//    refs/heads/<new> exists and refs/heads/<old> doesn't (else "failed").
//    An upstream with another name is then unset, so a push never lands in
//    it.
// 3. `git worktree move -- <path> <newPath>`; the re-list decides: newPath
//    listed → "moved", else "kept" with git's first line (git refuses a
//    locked worktree or one with submodules). moveFolder false, or the folder
//    already has the name → "stays".
// Resolves { status: "renamed" | "refused" | "failed", reason, branch,
//   folder: "moved" | "kept" | "stays" | null, err, list }: branch is its
//   name afterwards, folder null when nothing ran, list the fresh worktree
//   list for store.saveWorktrees (null when it couldn't be read).
export async function renameWorkspace(req, io) {
  const check = await renameCheck(req, io);
  if (check.status !== "ok") {
    const { status, reason, err, branch, list } = check;
    return { status, reason, branch, folder: null, err, list };
  }
  const { project } = req;
  const { branch: old, name, newPath, list: before } = check;
  const path = normPath(req.path);
  const git = safe(io.git);
  const relist = async () => {
    try {
      return await listCheckouts(project, io.git);
    } catch {
      return null;
    }
  };

  const r = await git(project, GIT.rename(old, name));
  const renamed = (await git(project, GIT.branch(name))).ok && !(await git(project, GIT.branch(old))).ok;
  if (!renamed) {
    return { status: "failed", reason: null, branch: old, folder: null, err: firstLine(r.err) || `git didn't rename ${old}.`, list: (await relist()) ?? before };
  }
  const errs = [];
  if (check.tracking) {
    const u = await git(project, GIT.unsetUpstream(name));
    if (!u.ok) errs.push(`Couldn't unset the upstream of ${name}: ${firstLine(u.err)}`);
  }

  let folder = "stays";
  if (req.moveFolder && !check.sameFolder) {
    const m = await git(project, GIT.move(path, newPath));
    const after = await relist();
    const moved = after ? after.some((w) => w.path === newPath) : (await io.exists(newPath)) && !(await io.exists(path));
    folder = moved ? "moved" : "kept";
    if (!moved) errs.push(firstLine(m.err) || `git didn't move ${path}.`);
    return { status: "renamed", reason: null, branch: name, folder, err: errs.join(" "), list: after };
  }
  return { status: "renamed", reason: null, branch: name, folder, err: errs.join(" "), list: await relist() };
}
