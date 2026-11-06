// The Rename dialog's model (D25–D26, D28), with no herdr or gpui-kit imports
// so `node --test` can load it: the name a rename gives, the checks that
// refuse it, and the rename itself: for a pushed branch origin first (GitHub
// renames it through gh, or a copy is pushed), then the branch, then the
// folder when the dialog says it may move. git, gh, `ssh -G`, the file check
// and the sleep are passed in (M/git.js binds them to Herdr's exec; tests
// pass a real git, a local bare origin and fakes of gh and ssh), like
// new-workspace-model.js. Every outcome is read from git's state (refs,
// config, the worktree list, what origin lists), never from its words: they
// are translated under es_ES and change across versions.

import { normPath, baseName, listCheckouts } from "./lib.js";
import { slug, sameBranch, findBranch } from "./new-workspace-model.js";

// ── Names (D25) ────────────────────────────────────────────────────────────

// What typed text becomes as a branch: each `/` segment slugged like D12,
// empty ones dropped (a HEAD segment too), so a namespace (user/feat)
// survives and every segment is a name git takes. "" when nothing is left.
export function branchName(text) {
  if (typeof text !== "string") return "";
  return text.split("/").map(slug).filter(Boolean).join("/");
}

// The rename the typed text asks of a branch: { name, unchanged, caseOnly? }.
// Text equal to the old branch (spaces around it aside) is unchanged before
// any slugging, so an untouched prefill is never slugged into a rename; a
// text that slugs to the old branch is unchanged too, and so is one that
// differs from it only in case, with caseOnly: true: on macOS git finds
// ax-1 already there when asked for AX-1.
export function renameTarget(text, oldBranch) {
  const typed = typeof text === "string" ? text.trim() : "";
  if (oldBranch && typed === oldBranch) return { name: oldBranch, unchanged: true };
  const name = branchName(typed);
  if (!name || !oldBranch || !sameBranch(name, oldBranch)) return { name, unchanged: false };
  return name === oldBranch ? { name, unchanged: true } : { name, unchanged: true, caseOnly: true };
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

// Whether branch `b` is in the way of a new branch `name`: git can't have a
// branch that is another's folder (with feat, no feat/x; with feat/x, no
// feat), and `branch -m` would only find it after origin got the new name.
// Compared ignoring case, as a Mac's disk does (feat is Feat's folder). The
// branch being renamed moves out of its own path in any case (Feat/x →
// feat), but into it only in its own case: git takes feat → feat/x and, on
// a Mac's disk, refuses feat → Feat/x while feat is a loose ref ("'refs/
// heads/Feat' exists"). A packed feat would pass; refusing both is safe.
const inTheWay = (b, name, old) => {
  const [low, to] = [b.toLowerCase(), name.toLowerCase()];
  const into = to.startsWith(`${low}/`);
  if (!into && !low.startsWith(`${to}/`)) return false;
  if (b !== old) return true;
  return into && !name.startsWith(`${b}/`);
};

// ── git and gh ─────────────────────────────────────────────────────────────

// The git each step runs, in the project's main checkout; the worktree list
// is lib.js's WORKTREE_LIST (listCheckouts). Typed text only reaches git as
// one argv entry (Herdr's exec runs no shell), slugged so it never starts
// with a dash, and `--` ends the options before names and paths.
export const GIT = {
  branch: (b) => ["show-ref", "--verify", "--quiet", `refs/heads/${b}`],
  // Every remote's copy of the branch (origin/b, github/b…), all of them:
  // with two, the first by name needn't be origin's. `*` stops at a slash,
  // so origin/x/b doesn't count.
  remoteRefs: (b) => ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${b}`],
  // Every local branch and every remote's copy as the last fetch saw it,
  // loose or packed: the check compares the new name with them ignoring
  // case (sameBranch, inTheWay), as a Mac's disk does, which git's patterns
  // can't.
  refs: ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"],
  merge: (b) => ["config", "--get-all", `branch.${b}.merge`],
  remote: (b) => ["config", "--get", `branch.${b}.remote`],
  rename: (from, to) => ["branch", "-m", "--", from, to],
  unsetUpstream: (b) => ["branch", "--unset-upstream", "--", b],
  move: (from, to) => ["worktree", "move", "--", from, to],
  // D28. What origin has now, in one call that names each ref in full: a
  // pattern (`--heads <name>`) would also match someone/<name>.
  lsRemote: (old, name) => ["ls-remote", "origin", `refs/heads/${old}`, ...(name ? [`refs/heads/${name}`] : [])],
  // The check's look, one call. With a new name, every branch of origin:
  // <new> and what would be in the way of it are compared ignoring case
  // (ls-remote's patterns are exact-case), and <old> read by its exact
  // refname. With none yet, only <old>.
  lsRemoteNear: (old, name) => (name ? ["ls-remote", "--heads", "origin"] : GIT.lsRemote(old, null)),
  // The URL git really contacts, insteadOf applied.
  url: ["remote", "get-url", "origin"],
  // One ref, never the whole remote (D13: a big fetch can pass exec's 30 s).
  fetchRef: (b) => ["fetch", "--no-tags", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`],
  commit: (ref) => ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
  // The copy: origin's own <old> (just fetched) pushed as <new>, so nothing
  // unpushed is published and no objects go up. The lease with no value
  // refuses when <new> appeared meanwhile, where a plain push would
  // fast-forward someone's branch onto this one. The person's hooks run: no
  // --no-verify.
  copy: (old, name) => ["push", `--force-with-lease=refs/heads/${name}:`, "origin", `refs/remotes/origin/${old}:refs/heads/${name}`],
  // The upstream as config: it works before origin/<new> is fetched, where
  // --set-upstream-to fails.
  setRemote: (b) => ["config", "--replace-all", `branch.${b}.remote`, "origin"],
  setMerge: (b) => ["config", "--replace-all", `branch.${b}.merge`, `refs/heads/${b}`],
  // The local tracking ref of a branch origin no longer has, as a prune
  // would drop it. Local only: the plugin never deletes a remote branch.
  dropTracking: (b) => ["update-ref", "-d", `refs/remotes/origin/${b}`],
};

// Each `/` segment of a branch encoded on its own, so `#`, `%` or `+` can't
// cut or change a GitHub URL, while user/feat keeps its slash.
const encodeBranch = (b) => String(b).split("/").map(encodeURIComponent).join("/");

// The gh each step runs, in the project (a gh wrapper that picks the account
// from the repo it runs in then picks this repo's). `repos/<o>/<r>` is always named, never
// left to gh's choice of remote. Read-only, but for `rename`.
export const GH = {
  canPush: ({ owner, repo }) => ["api", `repos/${owner}/${repo}`, "--jq", ".permissions.push"],
  pulls: ({ owner, repo }, b) => ["api", `repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeBranch(b)}`, "--jq", '.[] | "\\(.number) \\(.html_url)"'],
  rename: ({ owner, repo }, old, name) => ["api", "-X", "POST", `repos/${owner}/${repo}/branches/${encodeBranch(old)}/rename`, "-f", `new_name=${name}`],
};

// GitHub renames in the background after its 201: origin is looked at up to
// this many times, this far apart, until it shows <new>.
export const POLL = { tries: 10, step: 1000 };

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const message = (e) => firstLine(e?.message ?? e) || "git didn't answer.";
const lines = (out) => String(out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// A message never shows a URL's userinfo (it can hold a token).
const redact = (s) => String(s ?? "").replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/g, "$1");

// The line of a push's stderr that says what happened: `To <url>` and hints
// come first and say nothing.
const pushLine = (s) => redact(lines(s).find((l) => !/^To\s|^hint:/.test(l)) ?? "");

// git(cwd, args) that never rejects: a rejection (exec's 30 s limit, git
// gone) reads as { ok: false, err }.
const safe = (git) => async (cwd, args) => {
  try {
    return await git(cwd, args);
  } catch (e) {
    return { ok: false, out: "", err: message(e) };
  }
};

// gh(cwd, args) that never rejects: { ok, rejected, out, err }. rejected: gh
// couldn't start, or exec gave up on it (its 30 s limit); io without gh is
// a gh that can't start.
async function ghRun(io, cwd, args) {
  if (!io.gh) return { ok: false, rejected: true, out: "", err: "gh isn't available." };
  try {
    const r = await io.gh(cwd, args);
    return { ok: r.ok ?? r.code === 0, rejected: false, out: String(r.out ?? "").trim(), err: firstLine(r.err) };
  } catch (e) {
    return { ok: false, rejected: true, out: "", err: message(e) };
  }
}

// ── Origin (D28) ───────────────────────────────────────────────────────────

// What origin has of <old> and <new>, from `git ls-remote` output:
// { from, to }, each its commit or null. A line counts only when its refname
// is the full ref; `name` null: there is no new name to look for.
export function remoteHeads(out, old, name) {
  const refs = new Map();
  for (const line of lines(out)) {
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return { from: refs.get(`refs/heads/${old}`) ?? null, to: name ? refs.get(`refs/heads/${name}`) ?? null : null };
}

// The `hostname` line of `ssh -G <host>` output: the host an ssh alias
// really is. null when there is none.
export function sshHostnameOf(out) {
  const line = lines(out).find((l) => /^hostname\s/i.test(l));
  return line ? line.split(/\s+/)[1] ?? null : null;
}

// The schemes git reaches a remote with on its own, and whether it is ssh
// (whose host may be an alias of ~/.ssh/config). file:// and helpers aren't.
const SCHEMES = new Map([["ssh", true], ["git+ssh", true], ["ssh+git", true], ["https", false], ["http", false], ["git", false]]);

// A remote URL's parts: { ssh, host, path }, or null for a local path,
// file:// or a scheme git hands to a helper. Takes `[user@]host:path` (git's
// scp form: no slash before the colon) and `scheme://[userinfo@]host[:port]/
// path`. A host that would read as a flag is no host.
export function parseRemoteUrl(url) {
  const u = String(url ?? "").trim();
  const scheme = u.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  let ssh;
  let host;
  let path;
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (!SCHEMES.has(name)) return null;
    const rest = u.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    if (slash < 1) return null;
    const authority = rest.slice(0, slash);
    ssh = SCHEMES.get(name);
    host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
    path = rest.slice(slash + 1);
  } else {
    const colon = u.indexOf(":");
    const slash = u.indexOf("/");
    if (colon < 1 || (slash >= 0 && slash < colon)) return null;
    const authority = u.slice(0, colon);
    ssh = true;
    host = authority.slice(authority.lastIndexOf("@") + 1);
    path = u.slice(colon + 1);
  }
  if (!host || host.startsWith("-") || /\s/.test(host)) return null;
  return { ssh, host, path };
}

const GITHUB = ["github.com", "ssh.github.com"];
const isGitHub = (host) => GITHUB.includes(String(host ?? "").toLowerCase());

// Owner and repo names GitHub can have: nothing that changes a URL path.
const NAME = /^[A-Za-z0-9_.-]+$/;

// The GitHub repo an origin URL points at, { owner, repo }, or null when it
// isn't GitHub. `hostname`: what `ssh -G` says the URL's host is (only read
// for the scp and ssh forms, where the host may be an alias). The URL's
// userinfo never leaves this function.
export function githubRepoOf(url, hostname) {
  const u = parseRemoteUrl(url);
  if (!u || !(isGitHub(u.host) || (u.ssh && isGitHub(hostname)))) return null;
  const parts = u.path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!NAME.test(owner) || !NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return { owner, repo };
}

// The open PRs `GH.pulls` printed: [{ number, url }].
function parsePulls(out) {
  return lines(out).map((l) => l.match(/^(\d+)\s+(\S+)/)).filter(Boolean).map((m) => ({ number: Number(m[1]), url: m[2] }));
}

// What a remote step did, read from origin's state after it (D28 step 2),
// never from the call alone: GitHub renames in the background, and exec may
// give up on a call that went through.
//   route: "github" | "copy"
//   call: { ok, rejected, err }: ok: it exited 0 (GitHub's 201, the push
//     went); rejected: exec rejected (its 30 s limit, or it couldn't start);
//     err: its first line
//   sha: origin's <old> commit as the click's check read it (on the copy
//     path, the fetched refs/remotes/origin/<old>)
//   after: { ok, from, to, err }: origin's <old> and <new> after the call
//     (remoteHeads); ok false when ls-remote failed
//   bound: no more looks (the GitHub path looks again while this is false)
//   old, name: the branch and its new name, for the texts
// Resolves { done, remote: "renamed" | "copied" | null, err, note }: done
// false: look again; remote null: failed, err says why; note: said with a
// success.
export function remoteOutcome({ route, call, sha, after, old, name, bound }) {
  const from = after?.ok ? after.from : null;
  const to = after?.ok ? after.to : null;
  const retry = `If \`git ls-remote origin refs/heads/${name}\` lists it, run \`git branch -m ${old} ${name}\`; otherwise try again.`;
  const failed = (err) => ({ done: true, remote: null, err, note: "" });
  const done = (remote, note = "") => ({ done: true, remote, err: "", note });
  if (to && to !== sha) return failed(`origin's ${name} is on another commit: it is someone else's branch. Nothing changed here.`);
  if (route === "copy") {
    if (to) return done("copied");
    if (call.rejected) return failed(`git didn't answer in time; the push may still finish. Nothing changed here. ${retry}`);
    if (call.ok) return failed(`Couldn't see ${name} on origin after the push${after?.ok ? "" : `: ${after?.err || "git didn't answer"}`}. Nothing changed here. ${retry}`);
    return failed(call.err || `git didn't push ${name}.`);
  }
  const refused = !call.ok && !call.rejected;
  if (to && !from) return done("renamed");
  if (refused && !to) return failed(call.err || "GitHub refused the rename.");
  if (!bound && !refused) return { done: false, remote: null, err: "", note: "" };
  if (to) return done("renamed", "GitHub is still finishing the rename.");
  return failed(`GitHub didn't answer in time; it may still finish. Nothing changed here. ${retry}`);
}

// Where the branch is published, or null: { remotes, upstream }. remotes:
// every remote with a copy of it (refs/remotes/<remote>/<b>); upstream: the
// remote of an upstream with its own name (branch.<b>.merge =
// refs/heads/<b>), which holds after the copy was deleted and pruned. An
// upstream with another name (origin/main, a local main) is where it
// started, not where it went: git's default for `worktree add -b x …
// origin/main`.
async function publishedAs(project, branch, git) {
  const remotes = lines((await git(project, GIT.remoteRefs(branch))).out)
    .map((ref) => ref.slice("refs/remotes/".length, -(branch.length + 1))).filter(Boolean);
  const merges = lines((await git(project, GIT.merge(branch))).out);
  let upstream = null;
  if (merges.includes(`refs/heads/${branch}`)) {
    const remote = firstLine((await git(project, GIT.remote(branch))).out) || "origin";
    upstream = remote === "." ? null : remote;
  }
  return remotes.length || upstream ? { remotes, upstream } : null;
}

// The GitHub repo origin is, or null: `git remote get-url origin`, and for
// an ssh host that isn't github.com, the host `ssh -G` says it is.
async function githubOf(project, io, git) {
  const r = await git(project, GIT.url);
  const url = r.ok ? firstLine(r.out) : "";
  const u = parseRemoteUrl(url);
  if (!u) return null;
  let hostname = null;
  if (u.ssh && !isGitHub(u.host) && io.hostname) {
    try {
      hostname = await io.hostname(u.host);
    } catch {
      hostname = null;
    }
  }
  return githubRepoOf(url, hostname);
}

// What origin has of a published branch, read once: { origin } or
// { refusal: { reason, err } }. `name`: the new name, null when none is
// typed yet (only <old> is asked then).
//   origin = { published, route, gone, repo, prs, sha }: route "github"
//   (gh can push and listed the open PRs), "copy" (no gh, an origin that
//   isn't GitHub, or a PR list that failed) or "local" (origin no longer has
//   it: gone); sha: origin's <old> commit.
async function readOrigin(project, old, name, pub, io, git) {
  const refusal = (reason, err) => ({ refusal: { reason, err } });
  const ls = await git(project, GIT.lsRemoteNear(old, name));
  if (!ls.ok) return refusal("unreachable", `Couldn't reach origin: ${redact(firstLine(ls.err)) || "git didn't answer"}.`);
  const { from } = remoteHeads(ls.out, old, name);
  // origin's branches, each compared with <new> ignoring case: a fetch
  // would make ax-1 and AX-1 one file here.
  const heads = lines(ls.out).map((l) => l.split(/\s+/)[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ref.slice("refs/heads/".length));
  const twin = name && findBranch(heads, name);
  if (twin) return refusal("remote-exists", `origin already has ${twin}.`);
  const near = name && heads.find((b) => inTheWay(b, name, old));
  if (near) return refusal("remote-exists", `origin already has ${near}: git can't also have ${name}.`);
  const elsewhere = [...pub.remotes, pub.upstream].find((r) => r && r !== "origin");
  if (elsewhere) return refusal("pushed-elsewhere", `Also pushed as ${elsewhere}/${old}: renaming would split it.`);
  const origin = { published: true, route: "local", gone: !from, repo: null, prs: [], sha: from };
  if (!from) return { origin };
  const copy = { origin: { ...origin, route: "copy" } };
  const repo = await githubOf(project, io, git);
  if (!repo) return copy;
  const can = await ghRun(io, project, GH.canPush(repo));
  if (can.ok && can.out === "false") return refusal("no-push", `You can't push to ${repo.owner}/${repo.repo}.`);
  if (!can.ok || can.out !== "true") return copy;
  const pulls = await ghRun(io, project, GH.pulls(repo, old));
  if (!pulls.ok) return copy;
  return { origin: { ...origin, route: "github", repo, prs: parsePulls(pulls.out) } };
}

// A branch no remote has: renamed here only, offline.
const UNPUBLISHED = Object.freeze({ published: false, route: "local", gone: false, repo: null, prs: Object.freeze([]), sha: null });

// ── Check (D26 step 1, D28) ────────────────────────────────────────────────

const refused = (reason, err, branch, list, origin) => ({ status: "refused", reason, err, branch, list, ...(origin ? { origin } : {}) });

// Whether a rename of `path`'s branch to the typed `name` may run, read on a
// fresh worktree list and, for a published branch, on what origin has now.
// Changes nothing.
//   req = { project, path, name, moveFolder }   io = { git, exists, gh?,
//     hostname? }: gh(cwd, args) → { ok, code, out, err }; hostname(host) →
//     what `ssh -G` says it is. moveFolder false: the folder stays, so a
//     taken new folder doesn't refuse (it is only reported: folderTaken).
// Resolves
//   { status: "ok", branch, name, newPath, sameFolder, folderTaken,
//     tracking, unset, origin, list }
//     branch: the branch now; name: the new one; newPath: where the folder
//     would go (sameFolder: it already is there; folderTaken: another
//     folder is); tracking: it has an upstream with another name; unset:
//     the upstream goes after the rename (renamed here only); origin: see
//     readOrigin (UNPUBLISHED for a branch no remote has)
//   { status: "refused", reason, err, branch, list, origin? }  reason:
//     "missing" | "main" | "detached" | "unreachable" | "remote-exists" |
//     "pushed-elsewhere" | "no-push" | "empty" | "unchanged" |
//     "branch-exists" | "folder-exists"; err: what the dialog shows; origin:
//     there when it was read, so the dialog states the path before a name is
//     typed
//   { status: "failed", reason: null, err, branch: null, list: null }  the
//     list couldn't be read
export async function renameCheck({ project, path, name, moveFolder }, io) {
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
  const named = Boolean(target.name) && !target.unchanged;
  // The local branches, read once with the remote copies below; the new
  // name is compared with each ignoring case (sameBranch, inTheWay).
  let locals = [];
  if (named) {
    const refs = lines((await git(project, GIT.refs)).out);
    locals = refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
    const copies = refs.filter((r) => r.startsWith("refs/remotes/"))
      .map((r) => r.split("/")).map(([, , remote, ...rest]) => ({ remote, b: rest.join("/") })).filter(({ b }) => b);
    // A remote copy of the new name as the last fetch saw it: a cheap first
    // filter, offline.
    const same = copies.find(({ b }) => sameBranch(b, target.name));
    if (same) return refused("remote-exists", `${same.remote} already has ${same.b}.`, old, list);
    // A remote branch in the way of the new name, the same way.
    const copy = copies.find(({ b }) => inTheWay(b, target.name, old));
    if (copy) return refused("remote-exists", `${copy.remote} already has ${copy.b}: git can't also have ${target.name}.`, old, list);
    // A local branch in the way: decided here, before origin is asked, so
    // nothing remote runs for a name `branch -m` would refuse.
    const blocker = locals.find((b) => inTheWay(b, target.name, old));
    if (blocker) return refused("branch-exists", `Branch ${blocker} already exists: git can't also have ${target.name}.`, old, list);
  }
  const pub = await publishedAs(project, old, git);
  const read = pub ? await readOrigin(project, old, named ? target.name : null, pub, io, git) : { origin: UNPUBLISHED };
  if (read.refusal) return refused(read.refusal.reason, read.refusal.err, old, list);
  const { origin } = read;
  if (!target.name) return refused("empty", "Type a name for the branch.", old, list, origin);
  if (target.unchanged) return refused("unchanged", `The branch is already ${old}.`, old, list, origin);
  // The new branch in any case, loose or packed: git's own lookup misses a
  // packed ax-1 when asked for AX-1, and `branch -m` would make a twin.
  const taken = findBranch(locals, target.name);
  if (taken) return refused("branch-exists", `Branch ${taken} already exists.`, old, list, origin);
  const newPath = folderFor(here, target.name);
  const same = sameFolder(newPath, here);
  const folderTaken = !same && (await io.exists(newPath));
  if (folderTaken && moveFolder !== false) return refused("folder-exists", `${newPath} already exists.`, old, list, origin);
  const merges = lines((await git(project, GIT.merge(old))).out);
  return {
    status: "ok", reason: null, err: "", branch: old, name: target.name, newPath, sameFolder: same, folderTaken,
    tracking: merges.some((m) => m !== `refs/heads/${old}`),
    unset: origin.route === "local" && merges.length > 0,
    origin, list,
  };
}

// ── Rename (D26, D28) ──────────────────────────────────────────────────────

// Origin's <old> and <new> now: { ok, from, to, err }.
async function lookAtOrigin(project, old, name, git) {
  const r = await git(project, GIT.lsRemote(old, name));
  return r.ok
    ? { ok: true, ...remoteHeads(r.out, old, name), err: "" }
    : { ok: false, from: null, to: null, err: redact(firstLine(r.err)) || "git didn't answer" };
}

// The GitHub path: gh renames the branch, then origin is looked at until it
// shows <new> or the bound runs out (io.sleep between looks; a sleep that
// throws ends the wait, not the sequence). Never a copy afterwards.
async function renameOnGitHub({ project, old, name, origin }, io, git) {
  const call = await ghRun(io, project, GH.rename(origin.repo, old, name));
  let stop = false;
  for (let looks = 1; ; looks++) {
    const after = await lookAtOrigin(project, old, name, git);
    const out = remoteOutcome({ route: "github", call, sha: origin.sha, after, old, name, bound: stop || looks >= POLL.tries });
    if (out.done) return { ...out, after };
    try {
      await io.sleep?.(POLL.step);
    } catch {
      stop = true;
    }
  }
}

// The copy path: fetch origin's <old>, push that commit as <new>, then look.
async function pushCopy({ project, old, name }, io, git) {
  const failed = (err) => ({ done: true, remote: null, err, note: "", after: null });
  const f = await git(project, GIT.fetchRef(old));
  if (!f.ok) return failed(`Couldn't fetch ${old} from origin: ${redact(firstLine(f.err)) || "git didn't answer"}. Nothing changed here.`);
  const c = await git(project, GIT.commit(`refs/remotes/origin/${old}`));
  const sha = firstLine(c.out);
  if (!c.ok || !sha) return failed(`origin/${old} isn't here after the fetch. Nothing changed here.`);
  let call;
  try {
    const p = await io.git(project, GIT.copy(old, name));
    call = { ok: p.ok, rejected: false, err: pushLine(p.err) };
  } catch (e) {
    call = { ok: false, rejected: true, err: message(e) };
  }
  const after = await lookAtOrigin(project, old, name, git);
  return { ...remoteOutcome({ route: "copy", call, sha, after, old, name, bound: true }), after };
}

// Renames a workspace's branch, on origin first when it is published there,
// and, when `moveFolder` (no space and no pane in the folder: the dialog
// decides), moves its folder to folderFor(path, name).
//   req = { project, path, name, moveFolder, seen }   io = { git, exists,
//     gh?, hostname?, sleep? }: sleep(ms), the spawned task's cx.sleep.
//   seen = { route, prs: [number] }: what the dialog showed (missing: an
//     unpublished branch, { route: "local", prs: [] }).
// 1. renameCheck again; a refusal or a failure there runs nothing. A route
//    other than `seen`'s, or an open PR `seen` didn't have → "changed", with
//    the fresh check, and nothing runs (Delete's gate).
// 2. The remote, decided by origin's state (remoteOutcome): on GitHub, gh
//    renames it; on the copy path, origin's <old> is pushed as <new>. Not
//    done → "failed", nothing changed here.
// 3. `git branch -m <old> <new>`: counts only when refs/heads/<new> exists
//    and refs/heads/<old> doesn't. Failing after the remote is done →
//    "renamed" with that remote, branch <old>, and the fix in err.
// 4. The upstream: origin/<new> as config after a remote step; else an
//    upstream that `unset` names goes, so a push never lands in it.
// 5. After a remote step, only origin's <new> is fetched (a failure changes
//    nothing); the tracking ref of an <old> GitHub renamed away is dropped.
// 6. `git worktree move -- <path> <newPath>`; the re-list decides: newPath
//    listed → "moved", else "kept" with git's first line (git refuses a
//    locked worktree or one with submodules). moveFolder false, or the folder
//    already has the name → "stays".
// Resolves { status: "renamed" | "refused" | "changed" | "failed", reason,
//   branch, name, folder: "moved" | "kept" | "stays" | null, err, list,
//   remote: "renamed" | "copied" | "none" | null, prs, check }: branch is its
//   name afterwards; name the one asked (null when the check refused);
//   folder null when nothing ran; list the fresh worktree list for
//   store.saveWorktrees (null when it couldn't be read); remote what origin
//   got ("none": nothing, null: not reached); prs the open PRs from <old>;
//   check step 1's renameCheck ("changed" shows it).
export async function renameWorkspace(req, io) {
  const check = await renameCheck(req, io);
  const prs = check.origin?.prs ?? [];
  if (check.status !== "ok") {
    const { status, reason, err, branch, list } = check;
    return { status, reason, branch, name: null, folder: null, err, list, remote: null, prs, check };
  }
  const { project } = req;
  const { branch: old, name, newPath, origin, list: before } = check;
  const path = normPath(req.path);
  const git = safe(io.git);
  const relist = async () => {
    try {
      return await listCheckouts(project, io.git);
    } catch {
      return null;
    }
  };
  const result = (status, more) => ({ status, reason: null, branch: old, name, folder: null, err: "", list: before, remote: null, prs, check, ...more });

  // 1. What the dialog showed must still hold.
  const seenPrs = Array.isArray(req.seen?.prs) ? req.seen.prs : [];
  if (origin.route !== (req.seen?.route ?? "local")) {
    return result("changed", { reason: "route", err: "origin changed since the dialog checked it; check what Rename does now." });
  }
  const opened = prs.find((pr) => !seenPrs.includes(pr.number));
  if (opened) return result("changed", { reason: "prs", err: `PR #${opened.number} was opened from ${old} since the dialog checked it.` });

  // 2. The remote.
  let remote = "none";
  let goneThere = false;
  const errs = [];
  if (origin.route !== "local") {
    const out = origin.route === "github" ? await renameOnGitHub({ project, old, name, origin }, io, git) : await pushCopy({ project, old, name }, io, git);
    if (!out.remote) return result("failed", { err: out.err, list: (await relist()) ?? before });
    remote = out.remote;
    goneThere = out.remote === "renamed" && !out.after?.from;
    if (out.note) errs.push(out.note);
  }

  // 3. The local branch.
  const r = await git(project, GIT.rename(old, name));
  const renamed = (await git(project, GIT.branch(name))).ok && !(await git(project, GIT.branch(old))).ok;
  if (!renamed) {
    const list = (await relist()) ?? before;
    if (remote === "none") return result("failed", { err: firstLine(r.err) || `git didn't rename ${old}.`, list });
    const there = remote === "renamed" ? `Renamed on GitHub to ${name}` : `Pushed a copy as ${name}`;
    const fix = `${there}, but the local branch is still ${old}: run \`git branch -m ${old} ${name}\`.`;
    return result("renamed", { remote, folder: "stays", err: [fix, ...errs].join(" "), list });
  }

  // 4–5. The upstream, then origin's <new>.
  if (remote !== "none") {
    const set = [await git(project, GIT.setRemote(name)), await git(project, GIT.setMerge(name))].find((x) => !x.ok);
    if (set) errs.push(`Couldn't set the upstream of ${name} to origin/${name}: ${firstLine(set.err)}`);
    await git(project, GIT.fetchRef(name));
    if (goneThere) await git(project, GIT.dropTracking(old));
  } else if (check.unset) {
    const u = await git(project, GIT.unsetUpstream(name));
    if (!u.ok) errs.push(`Couldn't unset the upstream of ${name}: ${firstLine(u.err)}`);
  }

  // 6. The folder.
  const renamedTo = { branch: name, remote };
  if (req.moveFolder && !check.sameFolder) {
    const m = await git(project, GIT.move(path, newPath));
    const after = await relist();
    const moved = after ? after.some((w) => w.path === newPath) : (await io.exists(newPath)) && !(await io.exists(path));
    if (!moved) errs.push(firstLine(m.err) || `git didn't move ${path}.`);
    return result("renamed", { ...renamedTo, folder: moved ? "moved" : "kept", err: errs.join(" "), list: after });
  }
  return result("renamed", { ...renamedTo, folder: "stays", err: errs.join(" "), list: await relist() });
}
