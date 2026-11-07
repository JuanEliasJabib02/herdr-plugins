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
// owner until it stops seeing it.

import { githubOf } from "./rename-workspace-model.js";

// The theme color of each state (S-PR): the terminal palette's green,
// magenta and red, as the Explorer's git colors are, so a theme recolors them.
export const PR_COLORS = Object.freeze({ open: "ansi2", merged: "ansi5", closed: "ansi1", draft: "dim" });

const STATES = Object.keys(PR_COLORS);
const WORDS = { open: "Open", merged: "Merged", closed: "Closed", draft: "Draft" };

// Branches asked in one call.
export const CHUNK = 25;

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

// GitHub's PR node → { number, state, url }: OPEN as draft when it is one.
function fromNode(n) {
  if (!isObject(n)) return null;
  const state = n.state === "OPEN" ? (n.isDraft === true ? "draft" : "open") : n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : null;
  return prOf({ number: n.number, state, url: n.url });
}

// The gh argv that asks for `branches`' newest PRs in `repo`. The owner, the
// repo and every branch are raw fields (-f: never read as @file), so no name
// is ever part of the query's text.
export function prQueryArgs({ owner, repo }, branches) {
  const vars = branches.map((_, i) => `,$b${i}:String!`).join("");
  const fields = branches
    .map((_, i) => `b${i}:pullRequests(headRefName:$b${i},first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state isDraft url}}`)
    .join(" ");
  const query = `query($o:String!,$r:String!${vars}){repository(owner:$o,name:$r){${fields}}}`;
  return ["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${repo}`, ...branches.flatMap((b, i) => ["-f", `b${i}=${b}`])];
}

// GitHub's answer to prQueryArgs (gh prints it even when it exits 1):
// { ok, notFound, prs: { [branch]: pr | null } }. notFound: the account
// can't see the repo; anything else that isn't an answer is a failure.
export function parsePrAnswer(out, branches) {
  let json;
  try {
    json = JSON.parse(String(out ?? ""));
  } catch {
    return { ok: false, notFound: false, prs: {} };
  }
  const repository = isObject(json) && isObject(json.data) ? json.data.repository : undefined;
  if (!isObject(repository)) {
    const errors = isObject(json) && Array.isArray(json.errors) ? json.errors : [];
    return { ok: false, notFound: repository === null && errors.some((e) => e?.type === "NOT_FOUND"), prs: {} };
  }
  const prs = {};
  branches.forEach((b, i) => {
    const nodes = repository[`b${i}`]?.nodes;
    prs[b] = Array.isArray(nodes) ? fromNode(nodes[0]) : null;
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

// One call, never rejecting: who null is the project's folder (io.gh), else
// that login (io.ghAs). A gh that can't start reads as a failure.
async function ask(io, project, who, args, branches) {
  try {
    const r = who === null ? await io.gh(project, args) : await io.ghAs(who, project, args);
    return parsePrAnswer(r.out, branches);
  } catch {
    return { ok: false, notFound: false, prs: {} };
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

// One chunk of branches, through whoever sees the repo: the account
// remembered for its owner, then the project's folder, then each other
// account. Stops at the first answer, or at a failure that isn't "can't see
// it" (GitHub down, rate limit: another account wouldn't help).
async function askChunk(io, project, repo, branches, memo) {
  const owner = repo.owner.toLowerCase();
  const args = prQueryArgs(repo, branches);
  const tried = new Set();
  // The answer, a failure to stop at, or null to try the next one.
  const attempt = async (who) => {
    if (tried.has(who)) return null;
    tried.add(who);
    const r = await ask(io, project, who, args, branches);
    if (r.ok) {
      if (who === null) memo.owners.delete(owner);
      else memo.owners.set(owner, who);
    }
    return r.notFound ? null : r;
  };
  const first = memo.owners.has(owner) ? [memo.owners.get(owner), null] : [null];
  for (const who of first) {
    const r = await attempt(who);
    if (r) return r;
  }
  for (const who of await accounts(io, memo)) {
    const r = await attempt(who);
    if (r) return r;
  }
  return { ok: false, notFound: true, prs: {} };
}

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
