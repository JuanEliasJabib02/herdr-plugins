// The PR card's model (S4–S5, D5): the newest GitHub PR of the shown
// space's branch, with everything the card in the right panel shows above
// Changes, and the card's state drawn from it. No herdr or gpui-kit imports,
// so `node --test` can load it; the view binds it to exec.
//
//   readCard({ project, path, branch }, io, memo) → data: one `gh api
//     graphql` call for the branch's newest PR and the repo's merge methods
//     and default branch, asked through the sidebar's account path
//     (pr-model.js askGitHub, D1), plus ↑↓ from git in the workspace.
//     Never rejects.
//   cardState(data) → what the card draws: { kind: "pr" | "none" |
//     "not-github" | "no-branch" | "failed", … } (see cardState).
//
// Read-only: merging (D6) and creating (D7) are their own modules.

import { githubOf } from "./rename-workspace-model.js";
import { PR_COLORS, prLabel, prFromNode, repositoryAnswer, askGitHub } from "./pr-model.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// The merge methods GitHub's REST merge takes (merge_method), squash first
// (D6), each with the repository field that allows it.
const METHODS = [["squash", "squashMergeAllowed"], ["merge", "mergeCommitAllowed"], ["rebase", "rebaseMergeAllowed"]];

// A head commit's id: what Mergear pins the merge to (D6 `sha`).
const SHA = /^[0-9a-f]{40}$/;

// The gh argv that asks for `branch`'s newest PR in `repo`, with the repo's
// default branch and allowed merge methods. The owner, the repo and the
// branch are raw fields (-f: never read as @file), never part of the query's
// text.
export function cardQueryArgs({ owner, repo }, branch) {
  const checks = "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{status conclusion} ...on StatusContext{state}}}}}}}";
  const pr = "number title state isDraft url baseRefName headRefName headRefOid additions deletions mergeable mergeStateStatus reviewDecision"
    + ` latestReviews(first:100){nodes{state}} ${checks}`;
  const query = "query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){"
    + "defaultBranchRef{name} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed "
    + `pullRequests(headRefName:$b,first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${pr}}}}}`;
  return ["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${repo}`, "-f", `b=${branch}`];
}

// The head commit's checks: { passed, failed, running, total }. A check run
// that hasn't completed is running; a completed one passes when it
// succeeded, was skipped or was neutral (GitHub's own rollup counts those as
// passing), and fails otherwise (failure, timed out, cancelled, action
// required, …). A commit status passes on SUCCESS, runs while PENDING or
// EXPECTED, and fails on ERROR or FAILURE.
const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

function checksOf(pr) {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  const c = { passed: 0, failed: 0, running: 0, total: 0 };
  for (const n of Array.isArray(nodes) ? nodes : []) {
    let outcome;
    if (n?.__typename === "CheckRun") outcome = n.status !== "COMPLETED" ? "running" : PASSING.has(n.conclusion) ? "passed" : "failed";
    else if (n?.__typename === "StatusContext") outcome = n.state === "SUCCESS" ? "passed" : n.state === "PENDING" || n.state === "EXPECTED" ? "running" : "failed";
    else continue;
    c[outcome]++;
    c.total++;
  }
  return c;
}

// GitHub's PR node → the card's PR, or null when it isn't one (prFromNode:
// a number, a known state, a URL on GitHub).
function detailOf(n) {
  const pr = prFromNode(n);
  if (!pr) return null;
  const reviews = Array.isArray(n.latestReviews?.nodes) ? n.latestReviews.nodes.map((r) => r?.state) : [];
  return {
    ...pr,
    title: str(n.title),
    head: str(n.headRefName),
    base: str(n.baseRefName),
    headOid: SHA.test(str(n.headRefOid)) ? n.headRefOid : null,
    additions: count(n.additions),
    deletions: count(n.deletions),
    mergeable: str(n.mergeable),
    mergeStatus: str(n.mergeStateStatus),
    approvals: reviews.filter((s) => s === "APPROVED").length,
    changesRequested: n.reviewDecision === "CHANGES_REQUESTED" || reviews.includes("CHANGES_REQUESTED"),
    checks: checksOf(n),
  };
}

// GitHub's answer to cardQueryArgs: { ok: true, notFound: false, repo: {
// defaultBranch, methods }, pr: the card's PR | null } or, when it isn't
// one, { ok: false, notFound } (repositoryAnswer: notFound lets another
// account try).
export function parseCardAnswer(out) {
  const a = repositoryAnswer(out);
  if (!a.ok) return { ok: false, notFound: a.notFound };
  const r = a.repository;
  const nodes = r.pullRequests?.nodes;
  return {
    ok: true,
    notFound: false,
    repo: { defaultBranch: str(r.defaultBranchRef?.name), methods: METHODS.filter(([, field]) => r[field] === true).map(([m]) => m) },
    pr: Array.isArray(nodes) ? detailOf(nodes[0]) : null,
  };
}

// ↑↓ of the workspace against its PR's base: `git rev-list --left-right
// --count origin/<base>...HEAD` prints "<behind>\t<ahead>". null when git
// can't tell (origin/<base> not fetched here, git failing).
async function syncOf(path, base, git) {
  if (!base) return null;
  try {
    const r = await git(path, ["rev-list", "--left-right", "--count", `origin/${base}...HEAD`, "--"]);
    const m = r.ok ? /^(\d+)\s+(\d+)$/.exec(String(r.out).trim()) : null;
    return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

// What the card shows for one space, read now. Never rejects.
//   space = { project, path, branch }: the workspace's project (its main
//     checkout, where gh runs: a gh wrapper picks the account there), its
//     folder (where git counts ↑↓) and its branch (null when detached)
//   io = { git, gh, ghAs, accounts, hostname } as pr-model.js projectPrs
//   memo: a pr-model.js prMemo(), kept by the caller between reads
// Resolves one of
//   { status: "no-branch" }                       nothing was asked
//   { status: "not-github" }                      origin isn't GitHub
//   { status: "failed", unseen, repo }            GitHub didn't answer;
//     unseen: no account gh is logged into sees repo
//   { status: "none", repo, branch, who }         the branch has no PR
//   { status: "pr", repo, pr, sync, who }         its newest PR; sync: {
//     ahead, behind } | null
//   repo = { owner, repo, defaultBranch, methods }; who: the account that
//   answered (askGitHub: null for gh in the project's folder, else the
//   login asked through ghAs), the one Mergear and Crear PR act with
export async function readCard({ project, path, branch }, io, memo) {
  if (typeof branch !== "string" || !branch) return { status: "no-branch" };
  let repo;
  try {
    repo = await githubOf(project, io, io.git);
  } catch {
    return { status: "failed", unseen: false, repo: null };
  }
  if (!repo) return { status: "not-github" };
  const r = await askGitHub(io, project, repo, cardQueryArgs(repo, branch), parseCardAnswer, memo);
  if (!r.ok) return { status: "failed", unseen: r.notFound === true, repo };
  const where = { owner: repo.owner, repo: repo.repo, ...r.repo };
  if (!r.pr) return { status: "none", repo: where, branch, who: r.who };
  return { status: "pr", repo: where, pr: r.pr, sync: await syncOf(path, r.pr.base, io.git), who: r.who };
}

// ── What the card draws ────────────────────────────────────────────────────

// Colors are theme keys, as the sidebar's (pr-model.js PR_COLORS): green,
// red, yellow from the terminal palette, so a theme recolors them.
const GREEN = "ansi2";
const RED = "ansi1";
const YELLOW = "ansi3";
const GRAY = "dim";

// 2305 → "2,305", as Orca shows a PR's lines.
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// "✓ 5 de 5 pasan" / "✗ 1 falla" / "… 2 corriendo" / "Sin checks": a
// failure says so even while others still run.
function checksLine({ passed, failed, running, total }) {
  if (!total) return { text: "Sin checks", color: GRAY };
  if (failed) return { text: `✗ ${failed} ${failed === 1 ? "falla" : "fallan"}`, color: RED };
  if (running) return { text: `… ${running} corriendo`, color: YELLOW };
  return { text: `✓ ${passed} de ${total} ${total === 1 ? "pasa" : "pasan"}`, color: GREEN };
}

// "1 aprobado" / "Cambios pedidos" / "Sin reviews": changes asked for win
// over any approval (they block the merge).
function reviewsLine({ approvals, changesRequested }) {
  if (changesRequested) return { text: "Cambios pedidos", color: RED };
  if (approvals) return { text: `${approvals} ${approvals === 1 ? "aprobado" : "aprobados"}`, color: GREEN };
  return { text: "Sin reviews", color: GRAY };
}

// Whether Mergear may run (D6): never on a PR that isn't open, a draft, one
// with conflicts or one the base's rules block; GitHub computing, behind or
// unstable stays enabled (the merge itself refuses if GitHub does). Also off
// when the repo allows no method, or GitHub gave no head commit to pin the
// merge to.
function mergeOf(pr, methods) {
  const off = (reason) => ({ enabled: false, reason });
  if (pr.state === "merged") return off("Ya está mergeado");
  if (pr.state === "closed") return off("Está cerrado");
  if (pr.state === "draft") return off("Es un draft");
  if (pr.mergeable === "CONFLICTING" || pr.mergeStatus === "DIRTY") return off(`Tiene conflictos con ${pr.base}`);
  if (pr.mergeStatus === "BLOCKED") return off(`Bloqueado por las reglas de ${pr.base}`);
  if (!methods.length) return off("El repo no permite mergear");
  if (!pr.headOid) return off("GitHub no dio el commit del PR");
  return { enabled: true, reason: null };
}

// What the card draws for readCard's data:
//   { kind: "pr", header: "PR #161 · Open", color, title, url, branches:
//     "head → base", added: "+2,305", removed: "−942", sync: "↑4 ↓9" | null,
//     checks: { text, color }, reviews: { text, color }, merge: { enabled,
//     reason }, methods: ["squash", …], number, base, headOid, repo: {
//     owner, repo }, who }   (number, base, headOid, repo, who: what
//     Mergear sends, and with which account)
//   { kind: "none", text: "Esta rama no tiene PR", color, branch,
//     defaultBranch, repo: { owner, repo }, who }   (what Crear PR starts
//     from)
//   { kind: "not-github" | "no-branch" | "failed", text, color }
// color: a theme key (the header's is the sidebar icon's, PR_COLORS).
export function cardState(data) {
  const note = (kind, text) => ({ kind, text, color: GRAY });
  const repo = data?.repo ? { owner: data.repo.owner, repo: data.repo.repo } : null;
  switch (data?.status) {
    case "no-branch":
      return note("no-branch", "Este workspace no está en una rama");
    case "not-github":
      return note("not-github", "El origin no es GitHub");
    case "none":
      return { ...note("none", "Esta rama no tiene PR"), branch: data.branch, defaultBranch: data.repo.defaultBranch, repo, who: data.who ?? null };
    case "pr": {
      const { pr, sync } = data;
      const methods = [...data.repo.methods];
      return {
        kind: "pr",
        header: prLabel(pr),
        color: PR_COLORS[pr.state] ?? GRAY,
        title: pr.title,
        url: pr.url,
        branches: `${pr.head} → ${pr.base}`,
        added: `+${grouped(pr.additions)}`,
        removed: `−${grouped(pr.deletions)}`,
        sync: sync ? `↑${sync.ahead} ↓${sync.behind}` : null,
        checks: checksLine(pr.checks),
        reviews: reviewsLine(pr),
        merge: mergeOf(pr, methods),
        methods,
        number: pr.number,
        base: pr.base,
        headOid: pr.headOid,
        repo,
        who: data.who ?? null,
      };
    }
    default:
      return note("failed", data?.unseen && repo ? `Ninguna cuenta de gh ve ${repo.owner}/${repo.repo}` : "GitHub no respondió");
  }
}
