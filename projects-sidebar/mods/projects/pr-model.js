// The GitHub PR of each workspace's branch, for the branch icon on its row
// (Orca's PR status): green while open, purple once merged, red when closed
// without merging, gray as a draft; no PR leaves the icon as it was. No herdr
// or gpui-kit imports, so `node --test` can load it; git.js binds it to exec.
//
// GitHub is asked once per project: one `gh api graphql` call with every
// branch but the main checkout's as a variable, each answered by its newest
// PR (in calls of at most CHUNK branches).
//
// Two GitHub accounts: gh runs in the project's own folder first, where a
// gh wrapper that picks the account by repo picks the right one, and gh
// alone uses its active account. When GitHub answers that it can't see the
// repo (it belongs to the other account), each other account gh is logged
// into is tried, through GH_TOKEN set inside a shell (git.js ghAs: the token
// never comes into the mod), and the one that sees it is remembered for that
// owner until it stops answering. The PR card in the right panel
// (pr-card-model.js) asks through the same path (askGitHub).

import { githubOf } from "./rename-workspace-model.js";

// The theme color of each state (S-PR): the terminal palette's green,
// magenta and red, as the Explorer's git colors are, so a theme recolors them.
export const PR_COLORS = Object.freeze({ open: "ansi2", merged: "ansi5", closed: "ansi1", draft: "dim" });

const STATES = Object.keys(PR_COLORS);
const WORDS = { open: "Open", merged: "Merged", closed: "Closed", draft: "Draft" };

// Branches asked in one call.
export const CHUNK = 25;

// PRs asked per branch, newest first. A fork's PR from a branch of the same
// name is listed under it too, maybe newer (J-002), so a few are asked and
// ownNode picks the branch's own.
export const PRS_ASKED = 5;

// The hover of a colored icon: "PR #161 · Open".
export const prLabel = (pr) => `PR #${pr.number} · ${WORDS[pr.state] ?? pr.state}`;

// What one session remembers: { owners: Map(lowercased owner → login that
// sees its repos), accounts: the logins, listed once, null until needed }.
export const prMemo = () => ({ owners: new Map(), accounts: null });

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// A PR as stored and drawn, { number, state, url }, or null when the value
// isn't one (a URL off GitHub could be anything once clicked).
function prOf(v) {
  if (!isObject(v) || !Number.isInteger(v.number) || v.number < 1) return null;
  if (!STATES.includes(v.state) || typeof v.url !== "string" || !v.url.startsWith("https://github.com/")) return null;
  return { number: v.number, state: v.state, url: v.url };
}

// GitHub's PR node → { number, state, url }: OPEN as draft when it is one;
// null when it isn't a PR (prOf). The PR card reads its nodes with it too.
export function prFromNode(n) {
  if (!isObject(n)) return null;
  const state = n.state === "OPEN" ? (n.isDraft === true ? "draft" : "open") : n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : null;
  return prOf({ number: n.number, state, url: n.url });
}

// The branch's own PR among GitHub's nodes, newest first: the first whose
// head is a branch of the repo itself (isCrossRepository false), undefined
// when none is. A fork's PR from a branch of the same name is never it
// (J-002): the card would show someone else's PR, and Mergear merge it. The
// sidebar's colors and every read of the card (Mergear's check again, Crear
// PR's read after) pick through here.
export const ownNode = (nodes) => (Array.isArray(nodes) ? nodes.find((n) => isObject(n) && n.isCrossRepository === false) : undefined);

// The gh argv that asks for `branches`' newest PRs in `repo` (PRS_ASKED of
// each, for ownNode). The owner, the repo and every branch are raw fields
// (-f: never read as @file), so no name is ever part of the query's text.
export function prQueryArgs({ owner, repo }, branches) {
  const vars = branches.map((_, i) => `,$b${i}:String!`).join("");
  const fields = branches
    .map((_, i) => `b${i}:pullRequests(headRefName:$b${i},first:${PRS_ASKED},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state isDraft url isCrossRepository}}`)
    .join(" ");
  const query = `query($o:String!,$r:String!${vars}){repository(owner:$o,name:$r){${fields}}}`;
  return ["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${repo}`, ...branches.flatMap((b, i) => ["-f", `b${i}=${b}`])];
}

// The `repository` of a `gh api graphql` answer about one repo (gh prints
// it even when it exits 1): { ok: true, repository } or { ok: false,
// notFound }. notFound: the account can't see the repo, so another account
// may (askGitHub); anything else that isn't an answer is a failure.
export function repositoryAnswer(out) {
  let json;
  try {
    json = JSON.parse(String(out ?? ""));
  } catch {
    return { ok: false, notFound: false };
  }
  const repository = isObject(json) && isObject(json.data) ? json.data.repository : undefined;
  if (isObject(repository)) return { ok: true, repository };
  const errors = isObject(json) && Array.isArray(json.errors) ? json.errors : [];
  return { ok: false, notFound: repository === null && errors.some((e) => e?.type === "NOT_FOUND") };
}

// GitHub's answer to prQueryArgs: { ok, notFound, prs: { [branch]: pr |
// null } } (repositoryAnswer): each branch's own newest PR (ownNode).
export function parsePrAnswer(out, branches) {
  const a = repositoryAnswer(out);
  if (!a.ok) return { ok: false, notFound: a.notFound, prs: {} };
  const repository = a.repository;
  const prs = {};
  branches.forEach((b, i) => {
    prs[b] = prFromNode(ownNode(repository[`b${i}`]?.nodes));
  });
  return { ok: true, notFound: false, prs };
}

// The github.com logins `gh auth status --json hosts` says are signed in.
export function accountsOf(out) {
  try {
    const list = JSON.parse(String(out ?? "")).hosts?.["github.com"];
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a?.state === "success" && typeof a.login === "string" && a.login).map((a) => a.login);
  } catch {
    return [];
  }
}

// gh as one account: who null is the project's folder (io.gh), else that
// login (io.ghAs). Resolves gh's { ok, code, out, err }; rejects when gh
// can't start. Every call here goes through it, and so does Mergear's merge
// (pr-card-model.js mergePr), sent with the account that read the PR.
export const ghBy = (io, project, who, args) => (who === null ? io.gh(project, args) : io.ghAs(who, project, args));

// One call as `who` (ghBy), never rejecting: parse(out), or a failure when
// gh can't start. Mergear's check reads the PR again through it, with the
// account that read it and no other.
export async function askAs(io, project, who, args, parse) {
  try {
    const r = await ghBy(io, project, who, args);
    return parse(r.out);
  } catch {
    return { ok: false, notFound: false };
  }
}

async function accounts(io, memo) {
  if (memo.accounts === null) {
    try {
      memo.accounts = io.accounts ? await io.accounts() : [];
    } catch {
      memo.accounts = [];
    }
  }
  return memo.accounts;
}

// One `gh api graphql` call about `repo`, through whoever sees it: the
// account remembered for its owner, then the project's folder, then each
// other account. Stops at the first answer, or at a failure that isn't
// "can't see it" (GitHub down, rate limit: another account wouldn't help),
// but for the remembered login's: any failure of it (gh logged out of it, a
// revoked token's 401) forgets it and goes on to the others (J-003). Reads
// only: a write goes through the one account that read (ghBy), never here.
// The sidebar's colors (projectPrs) and the PR card (pr-card-model.js) both
// ask through here, each with the memo (prMemo) its caller keeps.
//   args: the gh argv   parse(out) → { ok, notFound, … } (repositoryAnswer)
// Resolves what parse returned, with `who` on an answer: the account that
// gave it (null: gh in the project's folder, else the login asked through
// io.ghAs), so a later write goes through the same one. { ok: false,
// notFound: true } when no account sees the repo; never rejects. When none
// answers and one failed otherwise (the remembered login's 5xx, rate limit
// or exec's limit, the others then saying NOT_FOUND), that failure (J-009):
// the only account that sees the repo failing for a while isn't "no account
// sees it".
export async function askGitHub(io, project, repo, args, parse, memo) {
  const owner = repo.owner.toLowerCase();
  // A login, or undefined: the folder is asked first.
  const remembered = memo.owners.get(owner);
  const tried = new Set();
  // The first failure that wasn't "can't see it": the result when no
  // account answers (J-009).
  let failed = null;
  // The answer, a failure to stop at, or null to try the next one.
  const attempt = async (who) => {
    if (tried.has(who)) return null;
    tried.add(who);
    const r = await askAs(io, project, who, args, parse);
    if (r.ok) {
      if (who === null) memo.owners.delete(owner);
      else memo.owners.set(owner, who);
      return { ...r, who };
    }
    if (!r.notFound) failed ??= r;
    // Kept, a login that no longer answers would stop every read here
    // until the mod reloads: it is forgotten, and the others are asked.
    if (remembered !== undefined && who === remembered) {
      if (memo.owners.get(owner) === who) memo.owners.delete(owner);
      return null;
    }
    return r.notFound ? null : r;
  };
  const first = remembered === undefined ? [null] : [remembered, null];
  for (const who of first) {
    const r = await attempt(who);
    if (r) return r;
  }
  for (const who of await accounts(io, memo)) {
    const r = await attempt(who);
    if (r) return r;
  }
  return failed ?? { ok: false, notFound: true };
}

// One chunk of branches (askGitHub).
const askChunk = (io, project, repo, branches, memo) =>
  askGitHub(io, project, repo, prQueryArgs(repo, branches), (out) => parsePrAnswer(out, branches), memo);

// The PRs of a project's workspaces: { ok, prs: { [workspacePath]: pr } }
// with only the branches that have one. ok false: GitHub didn't answer for
// every branch, so the rows keep what they showed (mergePrs). A project with
// no branch to ask, or whose origin isn't GitHub, asks nothing.
//   checkouts: its cached list, [{ path, branch, main }]
//   io = { git, gh, ghAs, accounts, hostname }: gh(cwd, args) and
//     ghAs(login, cwd, args) → { out }; accounts() → [login]; hostname(host)
//     → what `ssh -G` says it is
export async function projectPrs(project, checkouts, io, memo) {
  const rows = (checkouts ?? []).filter((c) => !c.main && typeof c.branch === "string" && c.branch);
  if (!rows.length) return { ok: true, prs: {} };
  let repo;
  try {
    repo = await githubOf(project, io, io.git);
  } catch {
    return { ok: false, prs: {} };
  }
  if (!repo) return { ok: true, prs: {} };
  const branches = [...new Set(rows.map((c) => c.branch))];
  const found = {};
  for (let i = 0; i < branches.length; i += CHUNK) {
    const chunk = branches.slice(i, i + CHUNK);
    const r = await askChunk(io, project, repo, chunk, memo);
    if (!r.ok) return { ok: false, prs: {} };
    Object.assign(found, r.prs);
  }
  const prs = {};
  for (const c of rows) if (found[c.branch]) prs[c.path] = found[c.branch];
  return { ok: true, prs };
}

// The stored value after a round: each answered project's workspaces get
// what GitHub said (no PR: no entry); a project that failed keeps its
// entries; a workspace no cached list has any more is dropped. Keys sorted,
// so the same PRs make the same JSON and are never written again.
//   results: [{ project, ok, prs }]   cache: projects.cache.v1
export function mergePrs(prev, results, cache) {
  const next = { ...parsePrs(prev) };
  for (const r of results) {
    if (!r.ok) continue;
    for (const c of cache?.[r.project] ?? []) delete next[c.path];
    Object.assign(next, r.prs);
  }
  const live = new Set(Object.values(cache ?? {}).flat().map((c) => c?.path));
  return Object.fromEntries(Object.keys(next).filter((p) => live.has(p)).sort().map((p) => [p, next[p]]));
}

// projects.prs.v1 as stored: { [workspacePath]: { number, state, url } };
// an entry that isn't one is dropped, anything but an object reads as {}.
export function parsePrs(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [path, v] of Object.entries(raw)) {
    const pr = path.startsWith("/") ? prOf(v) : null;
    if (pr) out[path] = pr;
  }
  return out;
}
