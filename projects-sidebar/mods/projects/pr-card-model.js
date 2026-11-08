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
// Mergear (D6, at the end): what the card hands the methods popup
// (mergeRequest, mergeMenuItems), what the confirm dialog says (seenOf,
// mergePrompt), the merge itself (mergePr: check again, then GitHub's REST
// merge pinned to the head commit, mergeArgs) with the account that read the
// PR, and what came of it (mergeOutcome, mergeReport). merge-pr.js draws the
// popup and the dialog; git.js binds mergePr to exec.

import { githubOf } from "./rename-workspace-model.js";
import { PR_COLORS, prLabel, prFromNode, repositoryAnswer, askGitHub, askAs, ghBy } from "./pr-model.js";

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
//     reason }, methods: ["squash", …], number, head, base, headOid, repo:
//     { owner, repo }, who }   (number, head, base, headOid, repo, who:
//     what Mergear checks and sends, and with which account: mergeRequest)
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
        head: pr.head,
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

// ── Mergear (D6) ───────────────────────────────────────────────────────────

// GitHub's methods in METHODS' order (squash first), and what the popup and
// the dialog call each.
const METHOD_NAMES = METHODS.map(([m]) => m);
const METHOD_LABELS = { squash: "Squash y mergear", merge: "Crear un merge commit", rebase: "Rebase y mergear" };

// An owner or a repo as a segment of a REST path (githubRepoOf's names), a
// PR number, and a GitHub login as ghAs hands it to `gh auth token --user`
// (never a flag).
const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (v) => typeof v === "string" && NAME.test(v) && !/^\.+$/.test(v);
const isNumber = (n) => Number.isInteger(n) && n >= 1;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

// Said after every refusal that sent nothing.
const NOTHING = ": no se mergeó nada.";

// The gh argv of GitHub's REST merge (D6): PUT
// repos/<o>/<r>/pulls/<n>/merge with the method and the head commit the card
// showed, so GitHub refuses (409) a head that moved since. Never `gh pr
// merge` (from a worktree it fails checking out the base) and never a branch
// delete (Delete workspace does that). null, nothing to send, without a
// 40-hex sha, with a method the repo doesn't allow (`methods`, from GitHub's
// answer) or that isn't GitHub's, or with a repo or a number that isn't one.
export function mergeArgs({ owner, repo, methods }, number, method, sha) {
  if (!isName(owner) || !isName(repo) || !isNumber(number)) return null;
  if (!METHOD_NAMES.includes(method) || !Array.isArray(methods) || !methods.includes(method)) return null;
  if (typeof sha !== "string" || !SHA.test(sha)) return null;
  return ["api", "-X", "PUT", `repos/${owner}/${repo}/pulls/${number}/merge`, "-f", `merge_method=${method}`, "-f", `sha=${sha}`];
}

// The popup's rows: the methods the repo allows, squash first, as
// [{ method, label }].
export const mergeMenuItems = (methods) =>
  METHOD_NAMES.filter((m) => Array.isArray(methods) && methods.includes(m)).map((method) => ({ method, label: METHOD_LABELS[method] }));

// What the card hands the popup when Mergear is enabled, null when it isn't:
// { project (where gh runs), seen: { owner, repo, number, head, headOid,
// base, who } (what it read, and the account that read it: S2), title,
// methods }. The popup adds the method picked; the dialog checks it all
// again before sending anything (mergePr).
export function mergeRequest(s, project) {
  if (s?.kind !== "pr" || !s.merge?.enabled || !s.repo || typeof project !== "string" || !project) return null;
  return {
    project,
    seen: { owner: s.repo.owner, repo: s.repo.repo, number: s.number, head: s.head, headOid: s.headOid, base: s.base, who: s.who ?? null },
    title: s.title,
    methods: [...s.methods],
  };
}

// The dialog's `seen` as its props carry it, checked: { owner, repo, number,
// head, headOid, base, method, who } or null when any of it isn't what the
// card hands over (who: null for gh in the project's folder, else a login).
export function seenOf(raw) {
  if (!isObject(raw)) return null;
  const { owner, repo, number, head, headOid, base, method, who } = raw;
  if (!isName(owner) || !isName(repo) || !isNumber(number)) return null;
  if (typeof head !== "string" || !head || typeof base !== "string" || !base) return null;
  if (typeof headOid !== "string" || !SHA.test(headOid) || !METHOD_NAMES.includes(method)) return null;
  if (who !== null && !(typeof who === "string" && LOGIN.test(who))) return null;
  return { owner, repo, number, head, headOid, base, method, who };
}

// What the confirm dialog says for a checked `seen`: the PR, where it goes,
// the method, and which account merges (S2).
export function mergePrompt(seen, title) {
  return {
    header: `Mergear PR #${seen.number}`,
    title: str(title),
    branches: `${seen.head} → ${seen.base}`,
    method: METHOD_LABELS[seen.method] ?? seen.method,
    account: seen.who === null ? "Con la cuenta de gh de este repo" : `Con la cuenta ${seen.who}`,
    note: "No se puede deshacer. La rama queda: Delete workspace la borra.",
  };
}

// gh's PUT as `who` (ghBy), never rejecting: { ok, rejected, out, err }.
// rejected: gh couldn't start, or exec gave up on it (its 30 s limit), so
// GitHub may still have taken it (rename-workspace-model.js ghRun).
async function send(io, project, who, args) {
  try {
    const r = await ghBy(io, project, who, args);
    return { ok: r.ok ?? r.code === 0, rejected: false, out: str(r.out).trim(), err: str(r.err).trim() };
  } catch (e) {
    return { ok: false, rejected: true, out: "", err: String(e?.message ?? e) };
  }
}

// The PR read again against what the card showed: null when it is still the
// one confirmed (the branch's newest, open, same base and head), else the
// result. One merged meanwhile is merged: the dialog says so.
function changedFrom(pr, seen) {
  const n = seen.number;
  const changed = (err) => ({ status: "changed", err, note: "" });
  if (!pr || pr.number !== n) return changed(`${seen.head} ya no tiene el PR #${n}${NOTHING}`);
  if (pr.state === "merged") return { status: "merged", err: "", note: "Ya estaba mergeado en GitHub." };
  if (pr.state === "closed") return changed(`El PR #${n} está cerrado${NOTHING}`);
  if (pr.state === "draft") return changed(`El PR #${n} volvió a draft${NOTHING}`);
  if (pr.base !== seen.base) return changed(`El PR #${n} ahora va a ${pr.base}, no a ${seen.base}${NOTHING}`);
  if (pr.headOid !== seen.headOid) return changed(`El PR #${n} tiene commits nuevos${NOTHING}`);
  return null;
}

// Mergear (D6), in this order, never rejecting:
//   1. origin is still the repo the card read (git, githubOf);
//   2. the PR read again with the account that read it (`seen.who`, and no
//      other: askAs, not askGitHub's loop), refused as "changed" when its
//      state, draft, base, head or number differ from `seen`;
//   3. GitHub's REST merge with that account (mergeArgs: the head pinned,
//      a method the repo allows now);
//   4. with no answer to trust (exec's limit, a 5xx), the PR read again.
//   req = { project: where gh runs, seen: the dialog's props (seenOf) }
//   io = { git, gh, ghAs, hostname } as readCard's
// Resolves { status, err, note }:
//   "merged"   GitHub merged it (note: it already was)
//   "changed"  the PR isn't the one confirmed; nothing sent
//   "refused"  GitHub refused (a 4xx), or the account or the method can't
//              any more; nothing merged
//   "failed"   nothing could be checked; nothing sent
//   "unsure"   sent, no answer: it may still merge
export async function mergePr({ project, seen: raw }, io) {
  const result = (status, err = "", note = "") => ({ status, err, note });
  const seen = seenOf(raw);
  if (!seen || typeof project !== "string" || !project) return result("failed", `Faltan datos del PR${NOTHING}`);
  const named = `${seen.owner}/${seen.repo}`;
  let origin;
  try {
    origin = await githubOf(project, io, io.git);
  } catch {
    return result("failed", `git no respondió${NOTHING}`);
  }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!origin || !same(origin.owner, seen.owner) || !same(origin.repo, seen.repo)) return result("changed", `El origin ya no es ${named}${NOTHING}`);
  const read = () => askAs(io, project, seen.who, cardQueryArgs(seen, seen.head), parseCardAnswer);
  const now = await read();
  if (!now.ok) {
    if (!now.notFound) return result("failed", `GitHub no respondió${NOTHING}`);
    return result("refused", `${seen.who === null ? "La cuenta de gh de este repo" : seen.who} ya no ve ${named}${NOTHING}`);
  }
  const changed = changedFrom(now.pr, seen);
  if (changed) return changed;
  const args = mergeArgs({ owner: seen.owner, repo: seen.repo, methods: now.repo.methods }, seen.number, seen.method, seen.headOid);
  if (!args) return result("refused", `El repo ya no permite "${METHOD_LABELS[seen.method]}"${NOTHING}`);
  const call = await send(io, project, seen.who, args);
  const after = call.ok || refusalOf(call) ? null : await read();
  return mergeOutcome({ call, after, seen });
}

// GitHub's refusal of the PUT, { status, message }, when gh got a 4xx (the
// request was refused: nothing merged); null otherwise. gh api prints
// GitHub's body ({ message, status }) on stdout and "gh: <message> (HTTP
// <status>)" on stderr.
function refusalOf(call) {
  if (!call || call.ok || call.rejected) return null;
  let body = null;
  try {
    body = JSON.parse(call.out);
  } catch {
    body = null;
  }
  const line = str(call.err).split("\n").map((l) => l.trim()).find((l) => /\(HTTP \d{3}\)/.test(l)) ?? "";
  const status = Number(isObject(body) && /^\d{3}$/.test(String(body.status)) ? body.status : /\(HTTP (\d{3})\)/.exec(line)?.[1]);
  if (!(status >= 400 && status < 500)) return null;
  const said = isObject(body) && typeof body.message === "string" ? body.message.trim() : "";
  return { status, message: said || line.replace(/^gh:\s*/, "").replace(/\s*\(HTTP \d{3}\)\s*$/, "") };
}

// What the merge's call came to, from GitHub's answer and, when there was
// none to trust, from the PR read again (rename-workspace-model.js
// remoteOutcome's model: never from the call alone).
//   call: { ok, rejected, out, err } (send)   after: parseCardAnswer of the
//   read after it, or null   seen: what was confirmed
// → { status: "merged" | "refused" | "unsure", err, note }: a 2xx merged
// it; a 4xx refused it, with GitHub's message; otherwise the fresh read
// says: merged, closed without merging, or it may still merge.
export function mergeOutcome({ call, after, seen }) {
  const result = (status, err = "", note = "") => ({ status, err, note });
  if (call?.ok) return result("merged");
  const refused = refusalOf(call);
  if (refused) return result("refused", `GitHub no lo mergeó: ${refused.message || `HTTP ${refused.status}`}`);
  const pr = after?.ok && after.pr?.number === seen.number ? after.pr : null;
  if (pr?.state === "merged") return result("merged");
  if (pr?.state === "closed") return result("refused", `El PR #${seen.number} se cerró sin mergear.`);
  const retry = "puede que aún se mergee. Revísalo en GitHub antes de volver a intentar.";
  return result("unsure", pr ? `GitHub no confirmó el merge y el PR sigue abierto: ${retry}` : `GitHub no confirmó el merge: ${retry}`);
}

// What mergePr's result does to the dialog (delete-workspace.js's model):
// { close, error, toast }. Merged closes it with a toast; anything else stays
// in the dialog as `error` while it is open (open), else is a toast.
export function mergeReport(r, { seen, open }) {
  const label = `PR #${seen.number}`;
  if (r?.status === "merged") {
    return { close: Boolean(open), error: "", toast: { title: `${label} mergeado`, body: r.note || `${seen.head} → ${seen.base} (${seen.method})`, level: "success" } };
  }
  const err = r?.err || `GitHub no lo mergeó${NOTHING}`;
  if (open) return { close: false, error: err, toast: null };
  const title = r?.status === "unsure" ? `${label} sin confirmar` : `${label} sin mergear`;
  return { close: false, error: "", toast: { title, body: err, level: r?.status === "failed" ? "error" : "warning" } };
}
