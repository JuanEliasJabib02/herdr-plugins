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
//
// Crear PR (D7, last): what the card hands the dialog on a branch without a
// PR (createRequest, createSeenOf), the dialog's defaults (createBaseOf,
// createBaseChoices, readCreateFacts: the last commit's subject, and
// whether the branch must be published first, pushPlan), what it says
// (createPrompt, createBlocker), the create itself (createPr: the push when
// needed, then GitHub's REST create, createArgs) with the account that read
// the card, and what came of it (createOutcome, createReport). create-pr.js
// draws the dialog; git.js binds readCreateFacts and createPr to exec.

import { githubOf } from "./rename-workspace-model.js";
import { PR_COLORS, PRS_ASKED, prLabel, prFromNode, ownNode, repositoryAnswer, askGitHub, askAs, ghBy } from "./pr-model.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// The merge methods GitHub's REST merge takes (merge_method), squash first
// (D6), each with the repository field that allows it.
const METHODS = [["squash", "squashMergeAllowed"], ["merge", "mergeCommitAllowed"], ["rebase", "rebaseMergeAllowed"]];

// A head commit's id: what Mergear pins the merge to (D6 `sha`).
const SHA = /^[0-9a-f]{40}$/;

// The gh argv that asks for `branch`'s newest PRs in `repo` (PRS_ASKED, for
// pr-model.js ownNode: a fork's PR from a branch of the same name may be
// newer, J-002), with the repo's default branch and allowed merge methods.
// The owner, the repo and the branch are raw fields (-f: never read as
// @file), never part of the query's text.
export function cardQueryArgs({ owner, repo }, branch) {
  const checks = "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{status conclusion} ...on StatusContext{state}}}}}}}";
  const pr = "number title state isDraft url isCrossRepository baseRefName headRefName headRefOid additions deletions mergeable mergeStateStatus reviewDecision"
    + ` latestReviews(first:100){nodes{state}} ${checks}`;
  const query = "query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){"
    + "defaultBranchRef{name} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed "
    + `pullRequests(headRefName:$b,first:${PRS_ASKED},orderBy:{field:CREATED_AT,direction:DESC}){nodes{${pr}}}}}`;
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
// account try). pr: the branch's own newest PR (ownNode), never a fork's.
export function parseCardAnswer(out) {
  const a = repositoryAnswer(out);
  if (!a.ok) return { ok: false, notFound: a.notFound };
  const r = a.repository;
  return {
    ok: true,
    notFound: false,
    repo: { defaultBranch: str(r.defaultBranchRef?.name), methods: METHODS.filter(([, field]) => r[field] === true).map(([m]) => m) },
    pr: detailOf(ownNode(r.pullRequests?.nodes)),
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
// (never a flag; an Enterprise Managed User's has a "_", J-004).
const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (v) => typeof v === "string" && NAME.test(v) && !/^\.+$/.test(v);
const isNumber = (n) => Number.isInteger(n) && n >= 1;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

// Which account acts (S2), as Mergear's and Crear PR's dialogs say it: `who`
// null is gh in the project's folder, else that login.
const accountOf = (who) => (who === null ? "Con la cuenta de gh de este repo" : `Con la cuenta ${who}`);

// What the confirm dialog says for a checked `seen`: the PR, where it goes,
// the method, and which account merges (S2).
export function mergePrompt(seen, title) {
  return {
    header: `Mergear PR #${seen.number}`,
    title: str(title),
    branches: `${seen.head} → ${seen.base}`,
    method: METHOD_LABELS[seen.method] ?? seen.method,
    account: accountOf(seen.who),
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

// GitHub's refusal of a write (Mergear's PUT, Crear PR's POST), { status,
// message, details }, when gh got a 4xx (the request was refused: nothing
// merged or created); null otherwise. gh api prints GitHub's body ({
// message, errors, status }) on stdout and "gh: <message> (HTTP <status>)"
// on stderr. details: what a 422's errors say ("A pull request already
// exists for …", or "base invalid"), "" without them.
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
  const errors = isObject(body) && Array.isArray(body.errors) ? body.errors : [];
  const details = errors
    .map((e) => (isObject(e) ? str(e.message).trim() || [str(e.field), str(e.code)].filter(Boolean).join(" ") : str(e).trim()))
    .filter(Boolean)
    .join("; ");
  return { status, message: said || line.replace(/^gh:\s*/, "").replace(/\s*\(HTTP \d{3}\)\s*$/, ""), details };
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

// ── Crear PR (D7) ──────────────────────────────────────────────────────────

// Said after every refusal that created nothing.
const NOT_CREATED = ": no se creó el PR.";

// How long a push may take: the person's pre-push hooks run (no
// --no-verify), and exec's own limit is 30 s.
export const PUSH_TIMEOUT = 120000;

// A branch name as an argv entry and a GitHub field: never a flag, and
// nothing git's ref names refuse at a glance (a space, a control character,
// ~ ^ : ? * [ \, "..", "@{").
const isBranch = (b) => typeof b === "string" && b !== "" && !b.startsWith("-") && !/[\s\x00-\x1f\x7f~^:?*[\\]|\.\.|@\{/.test(b);

// A commit id as git prints it (SHA-1, or SHA-256).
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// A message never shows a URL's userinfo (it can hold a token), as Rename's
// (rename-workspace-model.js redact).
const redact = (s) => String(s ?? "").replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/g, "$1");

// The line of git push's stderr that says what happened: `To <url>` and
// hints come first and say nothing (rename-workspace-model.js pushLine).
const pushLine = (s) => redact(String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean).find((l) => !/^To\s|^hint:/.test(l)) ?? "");

// The git Crear PR runs in the workspace, for branch `b` (isBranch). Refs
// are named in full, so a name is never read as an option or as another
// ref; `--` ends the options where git takes paths.
export const CREATE_GIT = {
  // The dialog's title: the branch's last commit's subject.
  subject: (b) => ["log", "-1", "--format=%s", `refs/heads/${b}`, "--"],
  // The branch's commit here.
  head: (b) => ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`],
  // origin's copy of the branch, asked of origin now (network): a line
  // "<sha>\trefs/heads/<b>", or nothing when origin doesn't have it.
  remote: (b) => ["ls-remote", "origin", `refs/heads/${b}`],
  // "<behind>\t<ahead>" of the branch against origin's copy.
  count: (remote, local) => ["rev-list", "--left-right", "--count", `${remote}...${local}`, "--"],
  // origin's copy fetched, when its commit isn't here to count against. One
  // ref, never the whole remote (exec's 30 s limit).
  fetch: (b) => ["fetch", "--no-tags", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`],
  // D7: `git push -u origin <branch>`, the refspec in full. Never forced: no
  // --force, no lease, no "+"; git refuses what isn't a fast-forward.
  push: (b) => ["push", "-u", "origin", `refs/heads/${b}:refs/heads/${b}`],
};

// What the card hands the dialog when the branch has no PR, null otherwise:
// { project (where gh runs), path (the workspace: where git counts and
// pushes), seen: { owner, repo, branch, defaultBranch, who } } (the repo,
// the branch, GitHub's default branch, and the account that read it: S2).
//   s: cardState's "none"   target: the card's workspace, { project, path }
export function createRequest(s, target) {
  if (s?.kind !== "none" || !s.repo || !isBranch(s.branch)) return null;
  const project = target?.project;
  const path = target?.path;
  if (typeof project !== "string" || !project || typeof path !== "string" || !path) return null;
  return { project, path, seen: { owner: s.repo.owner, repo: s.repo.repo, branch: s.branch, defaultBranch: str(s.defaultBranch), who: s.who ?? null } };
}

// The dialog's `seen` as its props carry it, checked: { owner, repo,
// branch, defaultBranch, who } or null when any of it isn't what the card
// hands over (defaultBranch "" when GitHub gave none).
export function createSeenOf(raw) {
  if (!isObject(raw)) return null;
  const { owner, repo, branch, defaultBranch, who } = raw;
  if (!isName(owner) || !isName(repo) || !isBranch(branch)) return null;
  if (typeof defaultBranch !== "string" || (defaultBranch !== "" && !isBranch(defaultBranch))) return null;
  if (who !== null && !(typeof who === "string" && LOGIN.test(who))) return null;
  return { owner, repo, branch, defaultBranch, who };
}

// The base a new PR starts on (D7), as a branch of origin ("develop"): the
// project's saved base (D37, "origin/develop") when git has it (`has`:
// baseExistsIn's answer), else the repo's default branch, "" when there is
// neither (the base is then picked).
export function createBaseOf(saved, defaultBranch, has) {
  if (has && typeof saved === "string" && saved.startsWith("origin/") && saved.length > 7) return saved.slice(7);
  return str(defaultBranch);
}

// The Base list: the default first, then origin's recent branches
// (recentBasesOf, "origin/…"), never the PR's own branch, origin/HEAD or a
// repeat.
export function createBaseChoices(def, recent, head) {
  const names = (Array.isArray(recent) ? recent : [])
    .filter((b) => typeof b === "string" && b.startsWith("origin/") && b !== "origin/HEAD")
    .map((b) => b.slice(7));
  return [...new Set([def, ...names])].filter((b) => isBranch(b) && b !== head);
}

// The gh argv of GitHub's REST create (D7): POST repos/<o>/<r>/pulls with
// the title (trimmed), the head branch (this repo's), the base, the
// description and draft. Typed text goes as raw fields (-f: never read as
// @file); only draft is typed (-F), as true or false. Never `gh pr create`.
// null, nothing to send, with an empty title, a head or base that isn't a
// branch, a base that is the head, or a repo that isn't one.
export function createArgs({ owner, repo }, { title, head, base, body, draft }) {
  if (!isName(owner) || !isName(repo) || !isBranch(head) || !isBranch(base) || head === base) return null;
  const t = typeof title === "string" ? title.trim() : "";
  if (!t || typeof draft !== "boolean" || (body != null && typeof body !== "string")) return null;
  return [
    "api", "-X", "POST", `repos/${owner}/${repo}/pulls`,
    "-f", `title=${t}`, "-f", `head=${head}`, "-f", `base=${base}`, "-f", `body=${body ?? ""}`, "-F", `draft=${draft}`,
  ];
}

// Whether the branch must be published before its PR (D7), from git's
// answers: local, its commit here; remote, origin's (null: origin doesn't
// have the branch); counts, { behind, ahead } of local against remote (null:
// git couldn't compare them). → { push, why, ahead, blocked }:
//   push: publish first ("Publicar y crear PR"); why: "missing" (origin
//   doesn't have it) or "ahead" (`ahead` commits it lacks); blocked: why no
//   PR can be made from here now, "" when one can. A branch that split from
//   origin's would need a forced push: never (D7), so it says what to do.
export function pushPlan({ branch, local, remote, counts }) {
  const plan = (push, why = null, ahead = 0, blocked = "") => ({ push, why, ahead, blocked });
  if (!remote) return plan(true, "missing");
  if (remote === local) return plan(false);
  if (!counts) return plan(false, null, 0, `git no pudo comparar ${branch} con origin/${branch}.`);
  if (counts.ahead === 0) return plan(false);
  if (counts.behind === 0) return plan(true, "ahead", counts.ahead);
  return plan(false, null, counts.ahead, `${branch} y origin/${branch} se separaron. Trae los commits de origin (git pull) antes de crear el PR.`);
}

// git(cwd, args) that never rejects: a rejection (exec's limit, git gone)
// reads as a failure.
async function tryGit(git, cwd, args, opts) {
  try {
    return opts ? await git(cwd, args, opts) : await git(cwd, args);
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

// "<behind>\t<ahead>" → { behind, ahead }, null when git didn't count.
function countsOf(r) {
  const m = r.ok ? /^(\d+)\s+(\d+)$/.exec(String(r.out).trim()) : null;
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

// The branch against origin, read now in the workspace `path`: { ok: true,
// local, remote, ...pushPlan } or { ok: false, err } when git can't tell
// (the branch isn't here, origin can't be read). When origin's commit isn't
// here to count against, that one branch is fetched once. Never rejects.
export async function readPushState({ path, branch }, git) {
  if (!isBranch(branch)) return { ok: false, err: "No hay una rama para el PR" };
  const h = await tryGit(git, path, CREATE_GIT.head(branch));
  const local = h.ok ? firstLine(h.out) : "";
  if (!OID.test(local)) return { ok: false, err: `git no encuentra la rama ${branch}` };
  const ls = await tryGit(git, path, CREATE_GIT.remote(branch));
  if (!ls.ok) {
    const why = redact(firstLine(ls.err));
    return { ok: false, err: `git no pudo leer origin${why ? ` (${why})` : ""}` };
  }
  const ref = `refs/heads/${branch}`;
  const remote = String(ls.out ?? "").split("\n").map((l) => l.trim().split(/\s+/)).find(([sha, name]) => name === ref && OID.test(sha))?.[0] ?? null;
  let counts = null;
  if (remote && remote !== local) {
    counts = countsOf(await tryGit(git, path, CREATE_GIT.count(remote, local)));
    if (!counts && (await tryGit(git, path, CREATE_GIT.fetch(branch))).ok) counts = countsOf(await tryGit(git, path, CREATE_GIT.count(remote, local)));
  }
  return { ok: true, local, remote, ...pushPlan({ branch, local, remote, counts }) };
}

// What the dialog starts from, read when it opens: { title: the branch's
// last commit's subject ("" when git can't say), push: readPushState }.
// Publishes and creates nothing. Never rejects.
//   io = { git } as readCard's
export async function readCreateFacts({ path, branch }, io) {
  const subject = async () => {
    if (!isBranch(branch)) return "";
    const r = await tryGit(io.git, path, CREATE_GIT.subject(branch));
    return r.ok ? firstLine(r.out) : "";
  };
  const [title, push] = await Promise.all([subject(), readPushState({ path, branch }, io.git)]);
  return { title, push };
}

// What the dialog says: { header, branches: "head → base", account (S2),
// note: why it publishes first, or that git is being asked, warning: what
// git says against a PR now (origin unreadable, a branch split from
// origin's), label: the button, "Publicar y crear PR" when it publishes
// first, else "Crear PR" }. A warning doesn't turn the button off: its click
// checks again (createPr), which refuses while it still holds, and never
// publishes what the button didn't say.
//   plan: readPushState's answer, undefined while it is asked
export function createPrompt({ seen, base, plan }) {
  const b = seen.branch;
  let note = "";
  if (plan === undefined || plan === null) note = "Comprobando la rama en origin…";
  else if (plan.ok && plan.push && plan.why === "missing") note = `origin no tiene ${b}: se publica primero.`;
  else if (plan.ok && plan.push) note = plan.ahead === 1 ? "1 commit sin publicar: se publica primero." : `${plan.ahead} commits sin publicar: se publican primero.`;
  let warning = "";
  if (plan && !plan.ok) warning = `${plan.err || "git no respondió"}. Crear PR lo vuelve a comprobar.`;
  else if (plan?.blocked) warning = plan.blocked;
  return {
    header: "Crear PR",
    branches: `${b} → ${base || "…"}`,
    account: accountOf(seen.who),
    note,
    warning,
    label: plan?.ok && plan.push ? "Publicar y crear PR" : "Crear PR",
  };
}

// Why Crear PR can't run now, "" when it can: what is left to fill in the
// form. git's state never turns it off (createPrompt's warning).
export function createBlocker({ seen, base, title }) {
  if (!seen) return "No hay una rama para el PR.";
  if (!base) return "Elige una base.";
  if (base === seen.branch) return `La base no puede ser ${base}.`;
  if (typeof title !== "string" || !title.trim()) return "Escribe un título.";
  return "";
}

// GitHub's 201 → { number, url, draft }, null when it isn't a PR on GitHub.
function createdOf(out) {
  let json;
  try {
    json = JSON.parse(String(out ?? ""));
  } catch {
    return null;
  }
  if (!isObject(json) || !isNumber(json.number) || typeof json.html_url !== "string" || !json.html_url.startsWith("https://github.com/")) return null;
  return { number: json.number, url: json.html_url, draft: json.draft === true };
}

// Crear PR (D7), in this order, never rejecting:
//   1. origin is still the repo the card read (git, githubOf);
//   2. the branch against origin, read again (readPushState): nothing is
//      made from a branch git can't place or that split from origin's, and
//      commits the button didn't say it publishes (`push` false) are never
//      published unseen: "changed", with the plan the button now shows;
//   3. when the plan says so, `git push -u origin <branch>`, never forced;
//   4. GitHub's REST create (createArgs) with the account that read the card
//      (`seen.who`, ghBy: never another);
//   5. with no answer to trust (exec's limit, a 5xx, a 2xx that isn't a
//      PR), the branch's newest PR read again with that account.
//   req = { project: where gh runs, path: the workspace, seen: the dialog's
//     props (createSeenOf), base, title, body, draft, push: what the
//     button said (true: "Publicar y crear PR") }
//   io = { git, gh, ghAs, hostname } as readCard's
// Resolves { status, err, pr, plan }:
//   "created"  GitHub made it: pr = { number, url, draft }
//   "changed"  origin is another repo, or there is something to publish the
//              button didn't say; nothing published or created
//   "refused"  git or GitHub refused (a 4xx), or the branch split from
//              origin's; no PR made
//   "failed"   nothing could be checked, or the push didn't finish in time
//   "unsure"   sent, no answer, and no PR shows yet: a retry is safe (GitHub
//              never opens a second PR from a branch to the same base)
//   plan: the branch against origin now (after a push, nothing left to
//   publish), for the button; null when unknown. A push that went through
//   before a failure is said in err: the branch stays published.
export async function createPr({ project, path, seen: raw, base, title, body, draft, push }, io) {
  const result = (status, err = "", pr = null, plan = null) => ({ status, err, pr, plan });
  const seen = createSeenOf(raw);
  const args = seen ? createArgs(seen, { title, head: seen.branch, base, body, draft }) : null;
  if (!args || typeof project !== "string" || !project || typeof path !== "string" || !path) return result("failed", `Faltan datos del PR${NOT_CREATED}`);
  const named = `${seen.owner}/${seen.repo}`;
  const b = seen.branch;
  let origin;
  try {
    origin = await githubOf(project, io, io.git);
  } catch {
    return result("failed", `git no respondió${NOT_CREATED}`);
  }
  const same = (x, y) => x.toLowerCase() === y.toLowerCase();
  if (!origin || !same(origin.owner, seen.owner) || !same(origin.repo, seen.repo)) return result("changed", `El origin ya no es ${named}${NOT_CREATED}`);
  let plan = await readPushState({ path, branch: b }, io.git);
  if (!plan.ok) return result("failed", `${plan.err}${NOT_CREATED}`, null, plan);
  if (plan.blocked) return result("refused", plan.blocked, null, plan);
  if (plan.push && push !== true) return result("changed", `Hay commits de ${b} sin publicar: ahora el botón los publica antes de crear el PR.`, null, plan);
  let pushed = false;
  if (plan.push) {
    let p;
    try {
      p = await io.git(path, CREATE_GIT.push(b), { timeout: PUSH_TIMEOUT });
    } catch {
      return result("failed", `git push no terminó a tiempo: puede que aún publique ${b}. No se creó el PR.`);
    }
    if (!p.ok) {
      const line = pushLine(p.err);
      return result("refused", `git no publicó ${b}${line ? ` (${line})` : ""}${NOT_CREATED}`, null, plan);
    }
    pushed = true;
    plan = { ...plan, push: false, why: null, ahead: 0 };
  }
  const call = await send(io, project, seen.who, args);
  const answered = (call.ok && createdOf(call.out)) || refusalOf(call);
  const after = answered ? null : await askAs(io, project, seen.who, cardQueryArgs(seen, b), parseCardAnswer);
  const out = createOutcome({ call, after, seen, base });
  const kept = pushed && out.status !== "created" ? ` ${b} ya quedó publicada en origin.` : "";
  return { ...out, err: out.err + kept, plan };
}

// What the create's call came to, from GitHub's answer and, when there was
// none to trust, from the branch's newest PR read again (mergeOutcome's
// model: never from the call alone).
//   call: { ok, rejected, out, err } (send)   after: parseCardAnswer of the
//   read after it, or null   seen, base: what was asked for
// → { status: "created" | "refused" | "unsure", err, pr }: a 2xx with the
// PR made it; a 4xx refused it, with GitHub's message (and a 422's
// details); otherwise an open PR from the branch into that base, read
// again, is the one made; none yet may be retried.
export function createOutcome({ call, after, seen, base }) {
  const result = (status, err = "", pr = null) => ({ status, err, pr });
  const made = call?.ok ? createdOf(call.out) : null;
  if (made) return result("created", "", made);
  const refused = refusalOf(call);
  if (refused) {
    const said = refused.message || `HTTP ${refused.status}`;
    return result("refused", `GitHub no creó el PR: ${refused.details ? `${said}: ${refused.details}` : said}`);
  }
  const pr = after?.ok ? after.pr : null;
  if (pr && (pr.state === "open" || pr.state === "draft") && pr.head === seen.branch && pr.base === base) {
    return result("created", "", { number: pr.number, url: pr.url, draft: pr.state === "draft" });
  }
  return result("unsure", `GitHub no confirmó el PR y aún no aparece en ${seen.branch}. Puedes volver a intentar: GitHub no abre dos PR de ${seen.branch} a ${base}.`);
}

// What createPr's result does to the dialog (mergeReport's model): {
// close, error, toast }. Created closes it with a toast; anything else stays
// in the dialog as `error` while it is open (open), else is a toast.
export function createReport(r, { seen, base, open }) {
  if (r?.status === "created" && r.pr) {
    const body = `${seen.branch} → ${base}${r.pr.draft ? " · draft" : ""}`;
    return { close: Boolean(open), error: "", toast: { title: `PR #${r.pr.number} creado`, body, level: "success" } };
  }
  const err = r?.err || "GitHub no creó el PR.";
  if (open) return { close: false, error: err, toast: null };
  const title = r?.status === "unsure" ? "PR sin confirmar" : "PR sin crear";
  return { close: false, error: "", toast: { title, body: err, level: r?.status === "failed" ? "error" : "warning" } };
}
