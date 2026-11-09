// The PR card's model (M/pr-card-model.js): the newest PR of the shown
// space's branch with everything S5's card shows (D5), read through the same
// account path as the sidebar's PR colors (D1, pr-model.js askGitHub), and
// the card's state: header, "head → base", +/−, ↑↓, the checks and reviews
// lines, whether Mergear is enabled and why not (D6), the merge methods the
// repo allows, and the "Esta rama no tiene PR" / "El origin no es GitHub"
// states; Mergear (D6) and Crear PR (D7: the dialog's defaults, the push
// when needed, the create with the account that read the card). gh and git
// are fakes passed through io: no test reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cardQueryArgs, parseCardAnswer, readCard, cardState,
  mergeArgs, mergeRequest, mergeMenuItems, seenOf, mergePrompt, mergePr, mergeOutcome, mergeReport,
  createRequest, createSeenOf, createBaseOf, createBaseChoices, createArgs, pushPlan, readPushState, readCreateFacts,
  createPrompt, createBlocker, createPr, createOutcome, createReport, CREATE_GIT, PUSH_TIMEOUT,
} from "../projects-sidebar/mods/projects/pr-card-model.js";
import { prMemo, projectPrs } from "../projects-sidebar/mods/projects/pr-model.js";

const SHA = "b60a9e0cb1af36bd6669e6cff2b2fbea75d09a84";
const URL161 = "https://github.com/Arctic-Grey/Target-Sports-USA/pull/161";
const NOT_FOUND = JSON.stringify({
  data: { repository: null },
  errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'Arctic-Grey/Target-Sports-USA'." }],
});

// A check run (finished with `conclusion`, or still at `status`) and a
// commit status, as statusCheckRollup's contexts list them.
const run = (conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", status, conclusion: status === "COMPLETED" ? conclusion : null });
const commitStatus = (state) => ({ __typename: "StatusContext", state });

// GitHub's PullRequest node as the card's query asks for it: S5's PR #161.
// isCrossRepository: its head is a fork's branch of the same name (J-002).
function prNode({
  number = 161, state = "OPEN", isDraft = false, mergeable = "MERGEABLE", mergeStateStatus = "CLEAN",
  reviewDecision = null, reviews = [], checks = [], additions = 2305, deletions = 942, headRefOid = SHA, isCrossRepository = false,
} = {}) {
  return {
    number, title: "Fix checkout totals", state, isDraft, isCrossRepository,
    url: `https://github.com/Arctic-Grey/Target-Sports-USA/pull/${number}`,
    baseRefName: "main", headRefName: "juan/fix-totals", headRefOid, additions, deletions,
    mergeable, mergeStateStatus, reviewDecision,
    latestReviews: { nodes: reviews.map((s) => ({ state: s })) },
    commits: { nodes: [{ commit: { statusCheckRollup: checks.length ? { contexts: { nodes: checks } } : null } }] },
  };
}

// The query's answer: the repo's default branch and merge methods, and the
// branch's newest PRs (one node, a list newest first, or none).
const cardAnswer = (pr, repo = {}) => JSON.stringify({
  data: {
    repository: {
      defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false,
      pullRequests: { nodes: Array.isArray(pr) ? pr : pr ? [pr] : [] },
      ...repo,
    },
  },
});

const REPO = { owner: "Arctic-Grey", repo: "Target-Sports-USA" };

// The card for one PR node, read from GitHub's answer, ↑↓ unknown.
function cardOf(node, repo) {
  const r = parseCardAnswer(cardAnswer(node, repo));
  assert.equal(r.ok, true);
  return cardState({ status: "pr", repo: { ...REPO, ...r.repo }, pr: r.pr, sync: null });
}

// ── The query ──────────────────────────────────────────────────────────────

test("query: one gh api graphql call for the branch's newest PR, the repo's merge methods and default branch; every name a -f variable", () => {
  const args = cardQueryArgs(REPO, 'evil"){x}');
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  const fields = [];
  for (let i = 2; i < args.length; i += 2) {
    assert.equal(args[i], "-f", "every value is a raw field: -F would read @file");
    fields.push(args[i + 1]);
  }
  const query = fields[0];
  assert.match(query, /^query=query\(\$o:String!,\$r:String!,\$b:String!\)\{repository\(owner:\$o,name:\$r\)\{/);
  assert.match(query, /defaultBranchRef\{name\} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed /);
  assert.match(query, /pullRequests\(headRefName:\$b,first:5,orderBy:\{field:CREATED_AT,direction:DESC\}\)/, "a few, newest first: a fork's PR may come first (J-002)");
  for (const f of ["number", "title", "state", "isDraft", "url", "baseRefName", "headRefName", "headRefOid", "additions", "deletions", "mergeable", "mergeStateStatus", "reviewDecision", "isCrossRepository"]) {
    assert.match(query, new RegExp(`[{ ]${f}[ }]`), `asks for ${f}`);
  }
  assert.match(query, /latestReviews\(first:100\)\{nodes\{state\}\}/);
  assert.match(query, /commits\(last:1\)\{nodes\{commit\{statusCheckRollup\{contexts\(first:100\)\{nodes\{__typename \.\.\.on CheckRun\{status conclusion\} \.\.\.on StatusContext\{state\}\}\}\}\}\}\}/);
  assert.ok(!query.includes("evil"), "no branch in the query text");
  assert.deepEqual(fields.slice(1), ["o=Arctic-Grey", "r=Target-Sports-USA", 'b=evil"){x}']);
});

// ── Reading GitHub's answer ────────────────────────────────────────────────

test("answer: the repo's default branch, its allowed methods squash first, and the PR; no node is no PR", () => {
  const r = parseCardAnswer(cardAnswer(prNode(), { rebaseMergeAllowed: true }));
  assert.equal(r.ok, true);
  assert.equal(r.notFound, false);
  assert.deepEqual(r.repo, { defaultBranch: "main", methods: ["squash", "merge", "rebase"] });
  assert.equal(r.pr.number, 161);
  assert.equal(r.pr.headOid, SHA);
  const none = parseCardAnswer(cardAnswer(null, { squashMergeAllowed: false }));
  assert.deepEqual(none, { ok: true, notFound: false, repo: { defaultBranch: "main", methods: ["merge"] }, pr: null });
});

test("answer: a repo the account can't see reads as notFound; anything else unreadable as a failure", () => {
  assert.deepEqual(parseCardAnswer(NOT_FOUND), { ok: false, notFound: true });
  assert.deepEqual(parseCardAnswer(""), { ok: false, notFound: false });
  assert.deepEqual(parseCardAnswer("gh: Bad credentials (HTTP 401)"), { ok: false, notFound: false });
  assert.deepEqual(parseCardAnswer(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] })), { ok: false, notFound: false });
});

test("answer: a fork's PR from a branch of the same name is never the branch's: the newest PR whose head is in the repo is; only forks' PRs is no PR (J-002)", () => {
  const fork = prNode({ number: 170, isCrossRepository: true });
  assert.equal(parseCardAnswer(cardAnswer([fork, prNode()])).pr.number, 161);
  assert.equal(parseCardAnswer(cardAnswer([fork, prNode({ number: 171, isCrossRepository: true })])).pr, null);
  const { isCrossRepository: _unsaid, ...unsaid } = prNode();
  assert.equal(parseCardAnswer(cardAnswer([unsaid])).pr, null, "a node that doesn't say where its head is counts as a fork's");
});

test("answer: a node that isn't a PR (no number, an unknown state, a URL off GitHub) reads as no PR", () => {
  for (const bad of [{ number: "1" }, { state: "WEIRD" }, { url: "javascript:alert(1)" }]) {
    const node = { ...prNode(), ...bad };
    assert.equal(parseCardAnswer(cardAnswer(node)).pr, null, JSON.stringify(bad));
  }
});

// ── The card: S5's PR ──────────────────────────────────────────────────────

// A project at /p whose origin is `url`, with the workspace /w/a. gh answers
// by account: `sees` is the account that can see the repo (null: the plain
// call, the project's own folder). `sync`: what rev-list prints in the
// workspace (null: git fails). Every gh call is recorded as [account|null,
// args], every git call as [cwd, args].
function fakeIo({
  url = "git@github.com:Arctic-Grey/Target-Sports-USA.git", sees = null, out = cardAnswer(prNode()),
  accounts = ["juanjabibarcticgrey", "JuanEliasJabib02"], fails = false, sync = "9\t4", loggedOut = [],
} = {}) {
  const calls = [];
  const gits = [];
  const reply = (who, args) => {
    calls.push([who, args]);
    if (fails) return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
    // A login gh is no longer logged into: git.js AS_ACCOUNT exits 4.
    if (who !== null && loggedOut.includes(who)) return { ok: false, code: 4, out: "", err: "" };
    if (who !== sees) return { ok: false, code: 1, out: NOT_FOUND, err: "gh: Could not resolve to a Repository" };
    // A query of the sidebar's (pr-model.js): its branches, none with a PR.
    const names = args.filter((a) => /^b\d+=/.test(a));
    if (names.length) return { ok: true, code: 0, out: JSON.stringify({ data: { repository: Object.fromEntries(names.map((_, i) => [`b${i}`, { nodes: [] }])) } }), err: "" };
    return { ok: true, code: 0, out, err: "" };
  };
  const io = {
    git: async (cwd, args) => {
      gits.push([cwd, args]);
      const line = args.join(" ");
      if (line === "remote get-url origin") return { ok: true, out: url, err: "" };
      if (line.startsWith("rev-list ")) return sync === null ? { ok: false, out: "", err: "fatal: bad revision" } : { ok: true, out: sync, err: "" };
      return { ok: false, out: "", err: "unexpected" };
    },
    gh: async (cwd, args) => {
      assert.equal(cwd, "/p", "gh runs in the project's folder, where a wrapper picks its account");
      return reply(null, args);
    },
    ghAs: async (login, cwd, args) => reply(login, args),
    accounts: async () => accounts,
    hostname: async (host) => (host === "github-arcticgrey" ? "github.com" : null),
  };
  return { io, calls, gits };
}

const SPACE = { project: "/p", path: "/w/a", branch: "juan/fix-totals" };

test("card: S5's PR, the header and its color, title, head → base, +/−, ↑↓, checks, reviews, Mergear and the allowed methods", async () => {
  const node = prNode({ checks: [run("SUCCESS"), run("SUCCESS"), run("SUCCESS"), run("SUCCESS"), commitStatus("SUCCESS")], reviews: ["APPROVED"] });
  const { io, calls, gits } = fakeIo({ out: cardAnswer(node) });
  const data = await readCard(SPACE, io, prMemo());
  assert.equal(calls.length, 1, "one query");
  assert.deepEqual(calls[0][1].at(-1), "b=juan/fix-totals", "asks for the space's branch");
  assert.deepEqual(gits.at(-1), ["/w/a", ["rev-list", "--left-right", "--count", "origin/main...HEAD", "--"]], "↑↓ from git in the workspace, against origin/<base>");
  assert.deepEqual(cardState(data), {
    kind: "pr",
    header: "PR #161 · Open",
    color: "ansi2",
    title: "Fix checkout totals",
    url: URL161,
    branches: "juan/fix-totals → main",
    added: "+2,305",
    removed: "−942",
    sync: "↑4 ↓9",
    checks: { text: "✓ 5 de 5 pasan", color: "ansi2" },
    reviews: { text: "1 aprobado", color: "ansi2" },
    merge: { enabled: true, reason: null },
    methods: ["squash", "merge"],
    number: 161,
    head: "juan/fix-totals",
    base: "main",
    headOid: SHA,
    repo: REPO,
    who: null,
  });
});

test("card: the header takes the PR's state and the sidebar's color for it: open green, draft gray, merged purple, closed red", () => {
  const pick = (c) => [c.header, c.color];
  assert.deepEqual(pick(cardOf(prNode())), ["PR #161 · Open", "ansi2"]);
  assert.deepEqual(pick(cardOf(prNode({ isDraft: true, mergeStateStatus: "DRAFT" }))), ["PR #161 · Draft", "dim"]);
  assert.deepEqual(pick(cardOf(prNode({ state: "MERGED" }))), ["PR #161 · Merged", "ansi5"]);
  assert.deepEqual(pick(cardOf(prNode({ state: "CLOSED" }))), ["PR #161 · Closed", "ansi1"]);
});

test("card: thousands get a comma, as Orca shows them; deletions take the minus sign Herdr's Changes uses", () => {
  const c = cardOf(prNode({ additions: 16586, deletions: 1234567 }));
  assert.equal(c.added, "+16,586");
  assert.equal(c.removed, "−1,234,567");
  const zero = cardOf(prNode({ additions: 0, deletions: 0 }));
  assert.deepEqual([zero.added, zero.removed], ["+0", "−0"]);
});

test("card: ↑↓ git can't tell (origin/<base> not fetched) shows nothing, never a guess", async () => {
  const { io } = fakeIo({ sync: null });
  assert.equal(cardState(await readCard(SPACE, io, prMemo())).sync, null);
  const garbage = fakeIo({ sync: "warning: something" });
  assert.equal(cardState(await readCard(SPACE, garbage.io, prMemo())).sync, null);
});

// ── The checks line ────────────────────────────────────────────────────────

test("checks: all passing → ✓ N de N pasan, green; skipped and neutral runs pass too", () => {
  assert.deepEqual(cardOf(prNode({ checks: [run("SUCCESS"), run("SKIPPED"), run("NEUTRAL"), commitStatus("SUCCESS"), run("SUCCESS")] })).checks, { text: "✓ 5 de 5 pasan", color: "ansi2" });
  assert.deepEqual(cardOf(prNode({ checks: [run("SUCCESS")] })).checks, { text: "✓ 1 de 1 pasa", color: "ansi2" });
});

test("checks: any failing → ✗ N falla(n), red, even while others still run", () => {
  assert.deepEqual(cardOf(prNode({ checks: [run("SUCCESS"), run("FAILURE"), run(null, "IN_PROGRESS")] })).checks, { text: "✗ 1 falla", color: "ansi1" });
  assert.deepEqual(cardOf(prNode({ checks: [run("TIMED_OUT"), run("CANCELLED"), commitStatus("ERROR"), commitStatus("FAILURE"), run("ACTION_REQUIRED")] })).checks, { text: "✗ 5 fallan", color: "ansi1" });
});

test("checks: none failing and some not finished → … N corriendo, yellow", () => {
  assert.deepEqual(cardOf(prNode({ checks: [run("SUCCESS"), run(null, "QUEUED"), commitStatus("PENDING")] })).checks, { text: "… 2 corriendo", color: "ansi3" });
  assert.deepEqual(cardOf(prNode({ checks: [run(null, "IN_PROGRESS"), commitStatus("EXPECTED")] })).checks, { text: "… 2 corriendo", color: "ansi3" });
});

test("checks: a head commit with no checks → Sin checks, gray", () => {
  assert.deepEqual(cardOf(prNode({ checks: [] })).checks, { text: "Sin checks", color: "dim" });
  const noCommit = { ...prNode(), commits: { nodes: [] } };
  assert.deepEqual(cardOf(noCommit).checks, { text: "Sin checks", color: "dim" });
});

// ── The reviews line ───────────────────────────────────────────────────────

test("reviews: approvals → N aprobado(s), green", () => {
  assert.deepEqual(cardOf(prNode({ reviews: ["APPROVED"], reviewDecision: "APPROVED" })).reviews, { text: "1 aprobado", color: "ansi2" });
  assert.deepEqual(cardOf(prNode({ reviews: ["APPROVED", "COMMENTED", "APPROVED"] })).reviews, { text: "2 aprobados", color: "ansi2" });
});

test("reviews: changes requested → Cambios pedidos, red, over any approval", () => {
  assert.deepEqual(cardOf(prNode({ reviews: ["APPROVED", "CHANGES_REQUESTED"] })).reviews, { text: "Cambios pedidos", color: "ansi1" });
  assert.deepEqual(cardOf(prNode({ reviews: ["APPROVED"], reviewDecision: "CHANGES_REQUESTED" })).reviews, { text: "Cambios pedidos", color: "ansi1" });
});

test("reviews: no approval and no change asked → Sin reviews, gray", () => {
  assert.deepEqual(cardOf(prNode({ reviews: [] })).reviews, { text: "Sin reviews", color: "dim" });
  assert.deepEqual(cardOf(prNode({ reviews: ["COMMENTED"], reviewDecision: "REVIEW_REQUIRED" })).reviews, { text: "Sin reviews", color: "dim" });
});

// ── Whether Mergear is enabled (D6) ────────────────────────────────────────

test("mergeable: an open PR GitHub can merge enables Mergear", () => {
  assert.deepEqual(cardOf(prNode()).merge, { enabled: true, reason: null });
});

test("mergeable: GitHub still computing, behind or unstable stays enabled: D6 disables only draft, conflicts, blocked and not open", () => {
  for (const [mergeable, mergeStateStatus] of [["UNKNOWN", "UNKNOWN"], ["MERGEABLE", "BEHIND"], ["MERGEABLE", "UNSTABLE"], ["MERGEABLE", "HAS_HOOKS"]]) {
    assert.deepEqual(cardOf(prNode({ mergeable, mergeStateStatus })).merge, { enabled: true, reason: null }, mergeStateStatus);
  }
});

test("mergeable: a draft can't be merged", () => {
  assert.deepEqual(cardOf(prNode({ isDraft: true, mergeStateStatus: "DRAFT" })).merge, { enabled: false, reason: "Es un draft" });
});

test("mergeable: conflicts with the base can't be merged", () => {
  assert.deepEqual(cardOf(prNode({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).merge, { enabled: false, reason: "Tiene conflictos con main" });
  assert.deepEqual(cardOf(prNode({ mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" })).merge, { enabled: false, reason: "Tiene conflictos con main" });
});

test("mergeable: blocked by the base's rules (required reviews or checks) can't be merged", () => {
  assert.deepEqual(cardOf(prNode({ mergeStateStatus: "BLOCKED" })).merge, { enabled: false, reason: "Bloqueado por las reglas de main" });
});

test("mergeable: a PR that isn't open can't be merged", () => {
  assert.deepEqual(cardOf(prNode({ state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).merge, { enabled: false, reason: "Ya está mergeado" });
  assert.deepEqual(cardOf(prNode({ state: "CLOSED" })).merge, { enabled: false, reason: "Está cerrado" });
});

test("mergeable: without the head commit GitHub showed, nothing could pin the merge to it (D6 sha), so Mergear is off", () => {
  assert.deepEqual(cardOf(prNode({ headRefOid: null })).merge, { enabled: false, reason: "GitHub no dio el commit del PR" });
  assert.deepEqual(cardOf(prNode({ headRefOid: "main" })).merge, { enabled: false, reason: "GitHub no dio el commit del PR" });
});

test("methods: only the ones the repo allows, squash first; none allowed turns Mergear off", () => {
  assert.deepEqual(cardOf(prNode(), { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }).methods, ["squash", "merge", "rebase"]);
  assert.deepEqual(cardOf(prNode(), { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }).methods, ["rebase"]);
  const none = cardOf(prNode(), { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false });
  assert.deepEqual(none.methods, []);
  assert.deepEqual(none.merge, { enabled: false, reason: "El repo no permite mergear" });
});

// ── No PR, no GitHub, no branch, no answer ─────────────────────────────────

test("no PR: Esta rama no tiene PR, with the branch, the repo and its default branch for Crear PR", async () => {
  const { io, gits } = fakeIo({ out: cardAnswer(null) });
  assert.deepEqual(cardState(await readCard(SPACE, io, prMemo())), {
    kind: "none",
    text: "Esta rama no tiene PR",
    color: "dim",
    branch: "juan/fix-totals",
    defaultBranch: "main",
    repo: REPO,
    who: null,
  });
  assert.ok(!gits.some(([, args]) => args[0] === "rev-list"), "no ↑↓ without a PR");
});

test("not GitHub: El origin no es GitHub, and GitHub is never asked", async () => {
  const { io, calls } = fakeIo({ url: "git@bitbucket.org:iot4a-repos/x.git" });
  assert.deepEqual(cardState(await readCard(SPACE, io, prMemo())), { kind: "not-github", text: "El origin no es GitHub", color: "dim" });
  assert.equal(calls.length, 0);
  const none = fakeIo({ url: "" });
  assert.equal(cardState(await readCard(SPACE, none.io, prMemo())).kind, "not-github", "no origin at all");
});

test("an ssh alias of github.com (github-arcticgrey) is GitHub", async () => {
  const { io, calls } = fakeIo({ url: "git@github-arcticgrey:Arctic-Grey/Target-Sports-USA.git" });
  assert.equal(cardState(await readCard(SPACE, io, prMemo())).header, "PR #161 · Open");
  assert.equal(calls.length, 1);
});

test("no branch (a detached HEAD): nothing is asked, the card says so", async () => {
  const { io, calls, gits } = fakeIo();
  assert.deepEqual(cardState(await readCard({ ...SPACE, branch: null }, io, prMemo())), { kind: "no-branch", text: "Este workspace no está en una rama", color: "dim" });
  assert.equal(calls.length + gits.length, 0);
});

// ── The account path (D1, shared with the sidebar's colors) ────────────────

// `who`: the account that answered, next to the PR (null: gh in the
// project's folder, else the login asked through ghAs). Mergear (T4) sends
// the merge with exactly that account.

test("account: the project's own folder sees the repo: one call, through gh in the project, who null", async () => {
  const memo = prMemo();
  const { io, calls } = fakeIo();
  const data = await readCard(SPACE, io, memo);
  assert.deepEqual(calls.map(([who]) => who), [null]);
  assert.equal(memo.owners.size, 0);
  assert.equal(data.who, null);
  assert.equal(cardState(data).who, null);
  const none = await readCard(SPACE, fakeIo({ out: cardAnswer(null) }).io, prMemo());
  assert.equal(none.who, null, "no PR: who still says which account Crear PR would use");
});

test("account: when the folder can't see the repo each other account is tried, and the one that sees it is remembered for that owner", async () => {
  const memo = prMemo();
  const { io, calls } = fakeIo({ sees: "JuanEliasJabib02" });
  const data = await readCard(SPACE, io, memo);
  const first = cardState(data);
  assert.deepEqual(calls.map(([who]) => who), [null, "juanjabibarcticgrey", "JuanEliasJabib02"]);
  assert.equal(first.header, "PR #161 · Open");
  assert.equal(data.who, "JuanEliasJabib02", "the fallback login that answered");
  assert.equal(first.who, "JuanEliasJabib02");
  assert.equal(memo.owners.get("arctic-grey"), "JuanEliasJabib02");
  calls.length = 0;
  const again = await readCard(SPACE, io, memo);
  assert.deepEqual(cardState(again), first);
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02"], "straight to the account that saw it");
  assert.equal(again.who, "JuanEliasJabib02", "the remembered login");
});

test("account: the memo is pr-model.js's (prMemo): given the sidebar's, the account its PR colors found is the one the card asks first", async () => {
  const memo = prMemo();
  const { io, calls } = fakeIo({ sees: "JuanEliasJabib02" });
  await projectPrs("/p", [{ path: "/w/a", branch: "juan/fix-totals", main: false }], io, memo);
  calls.length = 0;
  const data = await readCard(SPACE, io, memo);
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02"]);
  assert.equal(data.who, "JuanEliasJabib02", "the login the sidebar remembered");
});

test("account: a remembered account that stops seeing the repo falls back to the folder", async () => {
  const memo = prMemo();
  memo.owners.set("arctic-grey", "JuanEliasJabib02");
  const { io, calls } = fakeIo({ sees: null });
  const data = await readCard(SPACE, io, memo);
  assert.equal(cardState(data).kind, "pr");
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02", null]);
  assert.equal(memo.owners.has("arctic-grey"), false);
  assert.equal(data.who, null, "the folder answered, not the login that stopped seeing it");
});

test("account: a remembered login gh logged out of is forgotten, and the card is read through the folder's account (J-003)", async () => {
  const memo = prMemo();
  memo.owners.set("arctic-grey", "JuanEliasJabib02");
  const { io, calls } = fakeIo({ sees: null, loggedOut: ["JuanEliasJabib02"] });
  const data = await readCard(SPACE, io, memo);
  assert.equal(cardState(data).header, "PR #161 · Open");
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02", null]);
  assert.equal(data.who, null, "Mergear and Crear PR act with the account that answered");
  assert.equal(memo.owners.has("arctic-grey"), false);
});

test("account: the remembered login, the only one that sees the repo, failing for a while (a 502) with the others answering NOT_FOUND: the card says GitHub didn't answer, not that no account sees it (J-009)", async () => {
  const memo = prMemo();
  memo.owners.set("arctic-grey", "JuanEliasJabib02");
  const { io, calls } = fakeIo({ sees: "JuanEliasJabib02" });
  const ghAs = io.ghAs;
  io.ghAs = async (login, cwd, args) => {
    if (login !== "JuanEliasJabib02") return ghAs(login, cwd, args);
    calls.push([login, args]);
    return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
  };
  const data = await readCard(SPACE, io, memo);
  assert.equal(data.unseen, false);
  assert.deepEqual(cardState(data), { kind: "failed", text: "GitHub no respondió", color: "dim" });
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02", null, "juanjabibarcticgrey"]);
  assert.equal(memo.owners.has("arctic-grey"), false, "forgotten: the next read asks the folder, then the others, and finds it again");
  io.ghAs = ghAs;
  calls.length = 0;
  assert.equal(cardState(await readCard(SPACE, io, memo)).header, "PR #161 · Open");
  assert.deepEqual(calls.map(([who]) => who), [null, "juanjabibarcticgrey", "JuanEliasJabib02"]);
  assert.equal(memo.owners.get("arctic-grey"), "JuanEliasJabib02");
});

test("account: no account sees the repo: the card names it", async () => {
  const { io, calls } = fakeIo({ sees: "nobody" });
  assert.deepEqual(cardState(await readCard(SPACE, io, prMemo())), { kind: "failed", text: "Ninguna cuenta de gh ve Arctic-Grey/Target-Sports-USA", color: "dim" });
  assert.equal(calls.length, 3, "the folder and both accounts, once each");
});

test("account: GitHub failing (down, rate limit) tries no other account; gh that can't start never throws", async () => {
  const down = fakeIo({ fails: true });
  assert.deepEqual(cardState(await readCard(SPACE, down.io, prMemo())), { kind: "failed", text: "GitHub no respondió", color: "dim" });
  assert.equal(down.calls.length, 1);
  const { io } = fakeIo();
  io.gh = async () => {
    throw new Error("spawn gh ENOENT");
  };
  io.accounts = async () => [];
  assert.deepEqual(cardState(await readCard(SPACE, io, prMemo())), { kind: "failed", text: "GitHub no respondió", color: "dim" });
});

test("account: the card's module shares pr-model.js's account path instead of copying it", () => {
  const src = readFileSync(new URL("../projects-sidebar/mods/projects/pr-card-model.js", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\baskGitHub\b[^}]*\} from "\.\/pr-model\.js";/);
  assert.ok(!/io\.ghAs|io\.accounts|memo\.owners/.test(src), "no account logic of its own");
});

// ── Mergear (D6, S4, S5): the popup, the confirm dialog, the merge ─────────

// What the card read and the confirm dialog carries (D6 `seen`), with the
// method picked in the popup.
const SEEN = Object.freeze({ owner: "Arctic-Grey", repo: "Target-Sports-USA", number: 161, head: "juan/fix-totals", headOid: SHA, base: "main", method: "squash", who: null });
const MERGED = JSON.stringify({ sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" });
// gh api's answer when GitHub refuses: the body on stdout, a line on stderr, exit 1.
const refusal = (status, message) => ({
  code: 1,
  out: JSON.stringify({ message, documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request", status: String(status) }),
  err: `gh: ${message} (HTTP ${status})`,
});

// The project /p of SPACE: its origin is `url`; `sees` is the account that
// sees the repo (null: gh in the project's folder). Each GraphQL read takes
// the next of `reads` (the last one repeats); the PUT answers `put`, or
// rejects as exec does at its 30 s limit when put is "reject". Every gh call
// is recorded as [account|null, args]. A merge never lists accounts.
function mergeIo({ url = "git@github.com:Arctic-Grey/Target-Sports-USA.git", sees = null, reads = [cardAnswer(prNode())], put = { code: 0, out: MERGED, err: "" }, readFails = false } = {}) {
  const calls = [];
  const reply = (who, cwd, args) => {
    calls.push([who, args]);
    assert.equal(cwd, "/p", "gh runs in the project's folder");
    if (args.includes("PUT")) {
      if (put === "reject") throw new Error("exec: gh timed out after 30000 ms");
      return { ok: put.code === 0, ...put };
    }
    if (readFails) return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
    if (who !== sees) return { ok: false, code: 1, out: NOT_FOUND, err: "gh: Could not resolve to a Repository" };
    return { ok: true, code: 0, out: reads.length > 1 ? reads.shift() : reads[0], err: "" };
  };
  const io = {
    git: async (_cwd, args) => (args.join(" ") === "remote get-url origin" ? { ok: true, out: url, err: "" } : { ok: false, out: "", err: "unexpected" }),
    gh: async (cwd, args) => reply(null, cwd, args),
    ghAs: async (login, cwd, args) => reply(login, cwd, args),
    accounts: async () => {
      throw new Error("a merge never goes through the accounts");
    },
    hostname: async () => null,
  };
  return { io, calls };
}

const PUT_161 = ["api", "-X", "PUT", "repos/Arctic-Grey/Target-Sports-USA/pulls/161/merge", "-f", "merge_method=squash", "-f", `sha=${SHA}`];
const isPut = ([, args]) => args.includes("PUT");

test("S4 merge argv: GitHub's REST merge of the PR, pinned to the head commit the card showed, byte for byte (D6)", () => {
  const repo = { ...REPO, methods: ["squash", "merge"] };
  assert.deepEqual(mergeArgs(repo, 161, "squash", SHA), PUT_161);
  assert.deepEqual(mergeArgs(repo, 7, "merge", SHA), ["api", "-X", "PUT", "repos/Arctic-Grey/Target-Sports-USA/pulls/7/merge", "-f", "merge_method=merge", "-f", `sha=${SHA}`]);
  assert.ok(!PUT_161.some((a) => /delete|branch/i.test(a)), "the branch is never deleted (Delete workspace does that)");
});

test("S4 merge argv: never built without a 40-hex sha, with a method the repo doesn't allow, or with a PR or repo that isn't one", () => {
  const repo = { ...REPO, methods: ["squash", "merge"] };
  for (const sha of [null, undefined, "", "main", SHA.slice(0, 39), `${SHA}0`, SHA.toUpperCase(), `-${SHA.slice(1)}`]) {
    assert.equal(mergeArgs(repo, 161, "squash", sha), null, `sha ${sha}`);
  }
  assert.equal(mergeArgs(repo, 161, "rebase", SHA), null, "a method the repo doesn't allow");
  assert.equal(mergeArgs({ ...REPO, methods: [] }, 161, "squash", SHA), null, "a repo that allows none");
  assert.equal(mergeArgs({ ...REPO }, 161, "squash", SHA), null, "no methods known");
  assert.equal(mergeArgs({ ...repo, methods: ["squash", "fast-forward"] }, 161, "fast-forward", SHA), null, "only GitHub's three methods");
  for (const n of [0, -1, 1.5, "161", null]) assert.equal(mergeArgs(repo, n, "squash", SHA), null, `number ${n}`);
  for (const bad of [{ owner: "../x" }, { repo: "a/b" }, { owner: "" }, { repo: undefined }]) {
    assert.equal(mergeArgs({ ...repo, ...bad }, 161, "squash", SHA), null, JSON.stringify(bad));
  }
});

test("S5 Mergear ▾: the popup lists only the methods the repo allows, squash first, each with its label", () => {
  assert.deepEqual(mergeMenuItems(["squash", "merge", "rebase"]), [
    { method: "squash", label: "Squash y mergear" },
    { method: "merge", label: "Crear un merge commit" },
    { method: "rebase", label: "Rebase y mergear" },
  ]);
  assert.deepEqual(mergeMenuItems(["rebase", "squash"]), [{ method: "squash", label: "Squash y mergear" }, { method: "rebase", label: "Rebase y mergear" }], "squash first, whatever order it came in");
  assert.deepEqual(mergeMenuItems(["merge", "fast-forward"]), [{ method: "merge", label: "Crear un merge commit" }]);
  assert.deepEqual(mergeMenuItems(null), []);
});

test("S2 Mergear: the card hands the popup the PR it read, its head commit, and the account that read it; nothing while Mergear is off", () => {
  const card = cardOf(prNode());
  assert.deepEqual(mergeRequest(card, "/p"), {
    project: "/p",
    seen: { owner: "Arctic-Grey", repo: "Target-Sports-USA", number: 161, head: "juan/fix-totals", headOid: SHA, base: "main", who: null },
    title: "Fix checkout totals",
    methods: ["squash", "merge"],
  });
  assert.equal(mergeRequest({ ...card, who: "JuanEliasJabib02" }, "/p").seen.who, "JuanEliasJabib02", "the fallback login that read it");
  assert.equal(mergeRequest(cardOf(prNode({ isDraft: true })), "/p"), null, "a draft: Mergear is off");
  assert.equal(mergeRequest(cardOf(prNode({ state: "MERGED" })), "/p"), null);
  assert.equal(mergeRequest(cardState({ status: "none", repo: { ...REPO, defaultBranch: "main", methods: [] }, branch: "x", who: null }), "/p"), null, "no PR");
  assert.equal(mergeRequest(card, ""), null, "no project to run gh in");
});

test("S5 confirm dialog: the props are checked before anything is shown or sent (seen)", () => {
  assert.deepEqual(seenOf({ ...SEEN }), SEEN);
  assert.deepEqual(seenOf({ ...SEEN, who: "JuanEliasJabib02", extra: 1 }), { ...SEEN, who: "JuanEliasJabib02" });
  assert.deepEqual(seenOf({ ...SEEN, who: "juan_arcticgrey" }), { ...SEEN, who: "juan_arcticgrey" }, "an Enterprise Managed User's login has a _ (J-004)");
  for (const bad of [
    { headOid: "main" }, { number: "161" }, { number: 0 }, { method: "fast-forward" }, { method: undefined }, { who: "-x" }, { who: "_x" }, { who: "" },
    { who: undefined }, { owner: "a/b" }, { repo: "" }, { head: "" }, { base: null },
  ]) {
    assert.equal(seenOf({ ...SEEN, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(seenOf(null), null);
  assert.equal(seenOf("x"), null);
});

test("S5 confirm dialog: it names the PR, its base and the method, and which account merges (S2)", () => {
  assert.deepEqual(mergePrompt(SEEN, "Fix checkout totals"), {
    header: "Mergear PR #161",
    title: "Fix checkout totals",
    branches: "juan/fix-totals → main",
    method: "Squash y mergear",
    account: "Con la cuenta de gh de este repo",
    note: "No se puede deshacer. La rama queda: Delete workspace la borra.",
  });
  assert.equal(mergePrompt({ ...SEEN, who: "JuanEliasJabib02", method: "rebase" }, "").account, "Con la cuenta JuanEliasJabib02");
  assert.equal(mergePrompt({ ...SEEN, method: "rebase" }, "").method, "Rebase y mergear");
  assert.equal(mergePrompt(SEEN, undefined).title, "");
});

test("S4 merge: checks the PR again with the account that read it, then merges it pinned to the head the card showed", async () => {
  const { io, calls } = mergeIo();
  const r = await mergePr({ project: "/p", seen: SEEN }, io);
  assert.deepEqual(r, { status: "merged", err: "", note: "" });
  assert.deepEqual(calls.map(([who]) => who), [null, null], "the read again, then the PUT, both through gh in the project");
  assert.deepEqual(calls[0][1], cardQueryArgs(REPO, "juan/fix-totals"), "the card's own query");
  assert.deepEqual(calls[1][1], PUT_161);
});

test("S2 merge: a PR read through another account is merged with that account's credentials, and no other account is tried", async () => {
  const { io, calls } = mergeIo({ sees: "JuanEliasJabib02" });
  const r = await mergePr({ project: "/p", seen: { ...SEEN, who: "JuanEliasJabib02" } }, io);
  assert.equal(r.status, "merged");
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02", "JuanEliasJabib02"]);
  assert.deepEqual(calls[1][1], PUT_161);
});

test("S2 merge: when the account that read the PR no longer sees the repo, nothing is sent and no other account is tried", async () => {
  const { io, calls } = mergeIo({ sees: "juanjabibarcticgrey" });
  const r = await mergePr({ project: "/p", seen: { ...SEEN, who: "JuanEliasJabib02" } }, io);
  assert.deepEqual(r, { status: "refused", err: "JuanEliasJabib02 ya no ve Arctic-Grey/Target-Sports-USA: no se mergeó nada.", note: "" });
  assert.deepEqual(calls.map(([who]) => who), ["JuanEliasJabib02"]);
  const folder = mergeIo({ sees: "JuanEliasJabib02" });
  const r2 = await mergePr({ project: "/p", seen: SEEN }, folder.io);
  assert.equal(r2.err, "La cuenta de gh de este repo ya no ve Arctic-Grey/Target-Sports-USA: no se mergeó nada.");
  assert.deepEqual(folder.calls.map(([who]) => who), [null]);
});

test("S4 merge: a PR that changed since the card read it (state, draft, base, head, another PR) is never merged", async () => {
  const cases = [
    [prNode({ headRefOid: "d".repeat(40) }), "El PR #161 tiene commits nuevos: no se mergeó nada."],
    [{ ...prNode(), baseRefName: "release" }, "El PR #161 ahora va a release, no a main: no se mergeó nada."],
    [prNode({ isDraft: true }), "El PR #161 volvió a draft: no se mergeó nada."],
    [prNode({ state: "CLOSED" }), "El PR #161 está cerrado: no se mergeó nada."],
    [prNode({ number: 162 }), "juan/fix-totals ya no tiene el PR #161: no se mergeó nada."],
    [null, "juan/fix-totals ya no tiene el PR #161: no se mergeó nada."],
  ];
  for (const [node, err] of cases) {
    const { io, calls } = mergeIo({ reads: [cardAnswer(node)] });
    assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, io), { status: "changed", err, note: "" }, err);
    assert.ok(!calls.some(isPut), `no PUT: ${err}`);
  }
});

test("S4 merge: the check again passes over a fork's newer PR from a branch of the same name; with only forks' PRs the card's PR is gone and nothing is sent (J-002)", async () => {
  const fork = prNode({ number: 170, isCrossRepository: true });
  const own = mergeIo({ reads: [cardAnswer([fork, prNode()])] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, own.io), { status: "merged", err: "", note: "" });
  assert.deepEqual(own.calls.filter(isPut).map(([, args]) => args), [PUT_161]);
  const forks = mergeIo({ reads: [cardAnswer([fork])] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, forks.io), { status: "changed", err: "juan/fix-totals ya no tiene el PR #161: no se mergeó nada.", note: "" });
  assert.ok(!forks.calls.some(isPut));
});

test("S4 merge: a PR someone merged meanwhile is merged: nothing is sent, and it says so", async () => {
  const { io, calls } = mergeIo({ reads: [cardAnswer(prNode({ state: "MERGED" }))] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, io), { status: "merged", err: "", note: "Ya estaba mergeado en GitHub." });
  assert.ok(!calls.some(isPut));
});

test("S4 merge: a method the repo no longer allows, or an origin that is another repo now, sends nothing", async () => {
  const off = mergeIo({ reads: [cardAnswer(prNode(), { squashMergeAllowed: false })] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, off.io), { status: "refused", err: "El repo ya no permite \"Squash y mergear\": no se mergeó nada.", note: "" });
  assert.ok(!off.calls.some(isPut));
  const moved = mergeIo({ url: "git@github.com:Arctic-Grey/Other.git" });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, moved.io), { status: "changed", err: "El origin ya no es Arctic-Grey/Target-Sports-USA: no se mergeó nada.", note: "" });
  assert.equal(moved.calls.length, 0);
  const caseOnly = mergeIo({ url: "git@github.com:arctic-grey/target-sports-usa.git" });
  assert.equal((await mergePr({ project: "/p", seen: SEEN }, caseOnly.io)).status, "merged", "GitHub's names ignore case");
});

test("S4 merge: GitHub not answering the check, or props that aren't a PR, send nothing; it never rejects", async () => {
  const down = mergeIo({ readFails: true });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, down.io), { status: "failed", err: "GitHub no respondió: no se mergeó nada.", note: "" });
  assert.ok(!down.calls.some(isPut));
  const bad = mergeIo();
  assert.deepEqual(await mergePr({ project: "/p", seen: { ...SEEN, headOid: "main" } }, bad.io), { status: "failed", err: "Faltan datos del PR: no se mergeó nada.", note: "" });
  assert.deepEqual(await mergePr({ project: "", seen: SEEN }, bad.io), { status: "failed", err: "Faltan datos del PR: no se mergeó nada.", note: "" });
  assert.equal(bad.calls.length, 0);
  const broken = mergeIo();
  broken.io.gh = async () => {
    throw new Error("spawn gh ENOENT");
  };
  assert.equal((await mergePr({ project: "/p", seen: SEEN }, broken.io)).status, "failed");
  broken.io.git = async () => {
    throw new Error("spawn git ENOENT");
  };
  assert.equal((await mergePr({ project: "/p", seen: SEEN }, broken.io)).status, "failed");
});

test("S4 merge outcome: GitHub refusing (405, 409, 403, 404) merged nothing, says GitHub's message, and isn't read again", async () => {
  for (const [status, message] of [
    [405, "Pull Request is not mergeable"],
    [409, "Head branch was modified. Review and try the merge again."],
    [403, "Resource not accessible by integration"],
    [404, "Not Found"],
  ]) {
    const { io, calls } = mergeIo({ put: refusal(status, message) });
    assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, io), { status: "refused", err: `GitHub no lo mergeó: ${message}`, note: "" }, String(status));
    assert.equal(calls.length, 2, "the check and the PUT, nothing after");
  }
  assert.deepEqual(mergeOutcome({ call: { ok: false, rejected: false, out: "", err: "gh: Validation Failed (HTTP 422)" }, after: null, seen: SEEN }), { status: "refused", err: "GitHub no lo mergeó: Validation Failed", note: "" }, "stderr alone");
});

test("S4 merge outcome: no answer in time (exec's 30 s limit) may still merge: the PR is read again and the card says what GitHub shows", async () => {
  const done = mergeIo({ put: "reject", reads: [cardAnswer(prNode()), cardAnswer(prNode({ state: "MERGED" }))] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, done.io), { status: "merged", err: "", note: "" });
  assert.deepEqual(done.calls.map(([who, args]) => [who, args.includes("PUT") ? "put" : "read"]), [[null, "read"], [null, "put"], [null, "read"]], "read again with the same account");
  const open = mergeIo({ put: "reject" });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, open.io), {
    status: "unsure",
    err: "GitHub no confirmó el merge y el PR sigue abierto: puede que aún se mergee. Revísalo en GitHub antes de volver a intentar.",
    note: "",
  });
  const closed = mergeIo({ put: "reject", reads: [cardAnswer(prNode()), cardAnswer(prNode({ state: "CLOSED" }))] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, closed.io), { status: "refused", err: "El PR #161 se cerró sin mergear.", note: "" });
  const server = mergeIo({ put: { code: 1, out: "", err: "gh: Server Error (HTTP 502)" }, reads: [cardAnswer(prNode()), "garbage"] });
  assert.deepEqual(await mergePr({ project: "/p", seen: SEEN }, server.io), {
    status: "unsure",
    err: "GitHub no confirmó el merge: puede que aún se mergee. Revísalo en GitHub antes de volver a intentar.",
    note: "",
  }, "a 5xx is no answer either; an unreadable read says only that");
  assert.equal(server.calls.length, 3);
});

test("S4 merge report: merged closes the dialog with a toast; anything else stays in the dialog, or is a toast once it closed", () => {
  assert.deepEqual(mergeReport({ status: "merged", err: "", note: "" }, { seen: SEEN, open: true }), {
    close: true, error: "", toast: { title: "PR #161 mergeado", body: "juan/fix-totals → main (squash)", level: "success" },
  });
  assert.deepEqual(mergeReport({ status: "merged", err: "", note: "Ya estaba mergeado en GitHub." }, { seen: SEEN, open: false }), {
    close: false, error: "", toast: { title: "PR #161 mergeado", body: "Ya estaba mergeado en GitHub.", level: "success" },
  });
  const err = "El PR #161 tiene commits nuevos: no se mergeó nada.";
  assert.deepEqual(mergeReport({ status: "changed", err, note: "" }, { seen: SEEN, open: true }), { close: false, error: err, toast: null });
  assert.deepEqual(mergeReport({ status: "changed", err, note: "" }, { seen: SEEN, open: false }), { close: false, error: "", toast: { title: "PR #161 sin mergear", body: err, level: "warning" } });
  assert.deepEqual(mergeReport({ status: "failed", err: "x", note: "" }, { seen: SEEN, open: false }).toast.level, "error");
  assert.deepEqual(mergeReport({ status: "unsure", err: "y", note: "" }, { seen: SEEN, open: false }).toast, { title: "PR #161 sin confirmar", body: "y", level: "warning" });
});

// ── Crear PR (D7, S4, S5): the dialog's defaults, the push, the create ─────

// The branch's commit here, and origin's copy of it when they differ.
const HEAD = "1".repeat(40);
const ORIGIN = "2".repeat(40);
const URL162 = "https://github.com/Arctic-Grey/Target-Sports-USA/pull/162";
// GitHub's 201: the PR it made.
const CREATED = JSON.stringify({ number: 162, html_url: URL162, state: "open", draft: true });
// What the card hands the dialog (createRequest's seen), and the dialog's
// request as Crear PR sends it: S5's form, Draft on.
const CREATE_SEEN = Object.freeze({ owner: "Arctic-Grey", repo: "Target-Sports-USA", branch: "juan/fix-totals", defaultBranch: "main", who: null });
const CREATE = Object.freeze({ project: "/p", path: "/w/a", seen: CREATE_SEEN, base: "main", title: "Fix checkout totals", body: "Arregla los totales.", draft: true, push: false });
const POST_162 = [
  "api", "-X", "POST", "repos/Arctic-Grey/Target-Sports-USA/pulls",
  "-f", "title=Fix checkout totals", "-f", "head=juan/fix-totals", "-f", "base=main", "-f", "body=Arregla los totales.", "-F", "draft=true",
];
const PUSH = ["push", "-u", "origin", "refs/heads/juan/fix-totals:refs/heads/juan/fix-totals"];

// The workspace /w/a of project /p, its branch juan/fix-totals at `local`
// (null: git doesn't find it); origin's copy at `remote` (null: origin
// doesn't have the branch; "fail": ls-remote fails); `counts`: what rev-list
// prints comparing the two, one per call, the last repeating (null: git
// can't, origin's commit isn't here); `fetchOk`: the one-branch fetch;
// `push`: git push's answer ("reject": exec's limit); `subject`: the last
// commit's subject. gh: `sees` is the account that sees the repo; the POST
// answers `post` ("reject": exec's limit); each GraphQL read takes the next
// of `reads`. Every call goes to `log` in order: ["git", cwd, args, opts]
// or ["gh", who, args]. Crear PR never lists accounts.
function createIo({
  url = "git@github.com:Arctic-Grey/Target-Sports-USA.git", sees = null, local = HEAD, remote = null, counts = [null], fetchOk = true,
  push = { ok: true, out: "", err: "To github.com:Arctic-Grey/Target-Sports-USA.git\n * [new branch]      juan/fix-totals -> juan/fix-totals" },
  post = { code: 0, out: CREATED, err: "" }, reads = [cardAnswer(null)], subject = "Fix checkout totals",
} = {}) {
  const log = [];
  const ok = (out = "") => ({ ok: true, out, err: "" });
  const fail = (err) => ({ ok: false, out: "", err });
  const gh = (who, cwd, args) => {
    log.push(["gh", who, args]);
    assert.equal(cwd, "/p", "gh runs in the project's folder, where a wrapper picks its account");
    if (args.includes("POST")) {
      if (post === "reject") throw new Error("exec: gh timed out after 30000 ms");
      return { ok: post.code === 0, ...post };
    }
    if (who !== sees) return { ok: false, code: 1, out: NOT_FOUND, err: "gh: Could not resolve to a Repository" };
    return { ok: true, code: 0, out: reads.length > 1 ? reads.shift() : reads[0], err: "" };
  };
  const io = {
    git: async (cwd, args, opts) => {
      log.push(["git", cwd, args, opts]);
      const line = args.join(" ");
      if (line === "remote get-url origin") return ok(url);
      if (args[0] === "log") return subject === null ? fail("fatal: bad revision") : ok(subject);
      if (args[0] === "rev-parse") return local ? ok(local) : fail("");
      if (args[0] === "ls-remote") return remote === "fail" ? fail("fatal: Could not read from remote repository.") : ok(remote ? `${remote}\trefs/heads/juan/fix-totals` : "");
      if (args[0] === "rev-list") {
        const c = counts.length > 1 ? counts.shift() : counts[0];
        return c === null ? fail(`fatal: bad revision '${ORIGIN}...${HEAD}'`) : ok(c);
      }
      if (args[0] === "fetch") return fetchOk ? ok() : fail("fatal: unable to access origin");
      if (args[0] === "push") {
        if (push === "reject") throw new Error("exec: git timed out after 120000 ms");
        return push;
      }
      return fail("unexpected");
    },
    gh: async (cwd, args) => gh(null, cwd, args),
    ghAs: async (login, cwd, args) => gh(login, cwd, args),
    accounts: async () => {
      throw new Error("Crear PR never goes through the accounts");
    },
    hostname: async () => null,
  };
  return { io, log };
}

const gitCalls = (log, verb) => log.filter(([kind, , args]) => kind === "git" && args[0] === verb);
const posts = (log) => log.filter(([kind, , args]) => kind === "gh" && args.includes("POST"));

test("S5 Crear PR: the card hands the dialog the branch, its repo, the repo's default branch and the account that read it; nothing while the branch has a PR", () => {
  const none = cardState({ status: "none", repo: { ...REPO, defaultBranch: "main", methods: ["squash"] }, branch: "juan/fix-totals", who: null });
  const ws = { project: "/p", path: "/w/a" };
  assert.deepEqual(createRequest(none, ws), { project: "/p", path: "/w/a", seen: CREATE_SEEN });
  assert.equal(createRequest({ ...none, who: "JuanEliasJabib02" }, ws).seen.who, "JuanEliasJabib02", "the fallback login that read it (S2)");
  assert.equal(createRequest(cardOf(prNode()), ws), null, "a branch with a PR: Mergear, not Crear PR");
  assert.equal(createRequest(cardState({ status: "failed", unseen: false, repo: null }), ws), null);
  assert.equal(createRequest(cardState({ status: "no-branch" }), ws), null);
  assert.equal(createRequest(none, { project: "", path: "/w/a" }), null, "no project to run gh in");
  assert.equal(createRequest(none, { project: "/p", path: null }), null, "no workspace to push from");
  assert.equal(createRequest(none, null), null);
});

test("S5 create dialog: the props are checked before anything is shown or sent", () => {
  assert.deepEqual(createSeenOf({ ...CREATE_SEEN }), CREATE_SEEN);
  assert.deepEqual(createSeenOf({ ...CREATE_SEEN, who: "JuanEliasJabib02", extra: 1 }), { ...CREATE_SEEN, who: "JuanEliasJabib02" });
  assert.deepEqual(createSeenOf({ ...CREATE_SEEN, defaultBranch: "" }), { ...CREATE_SEEN, defaultBranch: "" }, "a repo GitHub gave no default branch: the base is picked");
  assert.deepEqual(createSeenOf({ ...CREATE_SEEN, who: "juan_arcticgrey" }), { ...CREATE_SEEN, who: "juan_arcticgrey" }, "an Enterprise Managed User's login has a _ (J-004)");
  for (const bad of [
    { owner: "a/b" }, { repo: "" }, { branch: "" }, { branch: "-x" }, { branch: "a b" }, { branch: null }, { defaultBranch: null },
    { defaultBranch: "-main" }, { who: "-x" }, { who: "_x" }, { who: "" }, { who: undefined },
  ]) {
    assert.equal(createSeenOf({ ...CREATE_SEEN, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(createSeenOf(null), null);
  assert.equal(createSeenOf("x"), null);
});

test("S5 Base: the project's saved base when git has it, else the repo's default branch; the list is that, then origin's recent branches, never the PR's own branch", () => {
  assert.equal(createBaseOf("origin/develop", "main", true), "develop", "the saved base (D37), as a branch of origin");
  assert.equal(createBaseOf("origin/develop", "main", false), "main", "a saved base git no longer has");
  assert.equal(createBaseOf(null, "main", false), "main");
  assert.equal(createBaseOf(null, "", false), "", "nothing to start from: the base is picked");
  const recent = ["origin/HEAD", "origin/juan/fix-totals", "origin/develop", "origin/main", "origin/release/1", "main"];
  assert.deepEqual(createBaseChoices("main", recent, "juan/fix-totals"), ["main", "develop", "release/1"]);
  assert.deepEqual(createBaseChoices("develop", recent, "juan/fix-totals"), ["develop", "main", "release/1"], "the default first");
  assert.deepEqual(createBaseChoices("", ["origin/develop"], "x"), ["develop"]);
  assert.deepEqual(createBaseChoices("main", null, "x"), ["main"]);
});

test("S4 create argv: GitHub's REST create, POST repos/<o>/<r>/pulls with the title, head, base, description and draft, byte for byte (D7)", () => {
  const form = { title: "  Fix checkout totals ", head: "juan/fix-totals", base: "main", body: "Arregla los totales.", draft: true };
  assert.deepEqual(createArgs(REPO, form), POST_162);
  assert.deepEqual(createArgs(REPO, { ...form, draft: false, body: "" }).slice(-6), ["-f", "base=main", "-f", "body=", "-F", "draft=false"]);
  const odd = createArgs(REPO, { ...form, title: "@/etc/passwd", body: "@notes.md\nline 2" });
  assert.equal(odd[odd.indexOf("title=@/etc/passwd") - 1], "-f", "typed text is a raw field: -F would read @file");
  assert.equal(odd[odd.indexOf("body=@notes.md\nline 2") - 1], "-f");
  assert.ok(!POST_162.some((a) => /delete|merge/i.test(a)));
  for (const bad of [
    { title: "" }, { title: "   " }, { title: null }, { base: "juan/fix-totals" }, { head: "-x" }, { base: "" }, { base: "a b" },
    { draft: "yes" }, { draft: undefined }, { body: 5 },
  ]) {
    assert.equal(createArgs(REPO, { ...form, ...bad }), null, JSON.stringify(bad));
  }
  for (const bad of [{ owner: "../x" }, { repo: "a/b" }, { owner: "" }]) assert.equal(createArgs({ ...REPO, ...bad }, form), null, JSON.stringify(bad));
});

test("S4 push: a branch origin doesn't have, or with unpushed commits, is published first; nothing unpushed isn't; a branch that split from origin's is never forced", () => {
  const b = "juan/fix-totals";
  assert.deepEqual(pushPlan({ branch: b, local: HEAD, remote: null, counts: null }), { push: true, why: "missing", ahead: 0, blocked: "" });
  assert.deepEqual(pushPlan({ branch: b, local: HEAD, remote: HEAD, counts: null }), { push: false, why: null, ahead: 0, blocked: "" });
  assert.deepEqual(pushPlan({ branch: b, local: HEAD, remote: ORIGIN, counts: { behind: 0, ahead: 3 } }), { push: true, why: "ahead", ahead: 3, blocked: "" });
  assert.deepEqual(pushPlan({ branch: b, local: HEAD, remote: ORIGIN, counts: { behind: 2, ahead: 0 } }), { push: false, why: null, ahead: 0, blocked: "" }, "origin has more: nothing to publish");
  assert.deepEqual(pushPlan({ branch: b, local: HEAD, remote: ORIGIN, counts: { behind: 1, ahead: 1 } }), {
    push: false, why: null, ahead: 1, blocked: "juan/fix-totals y origin/juan/fix-totals se separaron. Trae los commits de origin (git pull) antes de crear el PR.",
  });
  assert.equal(pushPlan({ branch: b, local: HEAD, remote: ORIGIN, counts: null }).blocked, "git no pudo comparar juan/fix-totals con origin/juan/fix-totals.");
});

test("S5 create dialog: the button says Publicar y crear PR when it publishes first, why, and which account creates it (S2)", () => {
  const plan = (p) => ({ ok: true, push: false, why: null, ahead: 0, blocked: "", ...p });
  assert.deepEqual(createPrompt({ seen: CREATE_SEEN, base: "main", plan: plan() }), {
    header: "Crear PR", branches: "juan/fix-totals → main", account: "Con la cuenta de gh de este repo", note: "", warning: "", label: "Crear PR",
  });
  const missing = createPrompt({ seen: { ...CREATE_SEEN, who: "JuanEliasJabib02" }, base: "develop", plan: plan({ push: true, why: "missing" }) });
  assert.deepEqual(missing, {
    header: "Crear PR", branches: "juan/fix-totals → develop", account: "Con la cuenta JuanEliasJabib02",
    note: "origin no tiene juan/fix-totals: se publica primero.", warning: "", label: "Publicar y crear PR",
  });
  assert.equal(createPrompt({ seen: CREATE_SEEN, base: "main", plan: plan({ push: true, why: "ahead", ahead: 1 }) }).note, "1 commit sin publicar: se publica primero.");
  assert.equal(createPrompt({ seen: CREATE_SEEN, base: "main", plan: plan({ push: true, why: "ahead", ahead: 3 }) }).note, "3 commits sin publicar: se publican primero.");
  const asking = createPrompt({ seen: CREATE_SEEN, base: "", plan: undefined });
  assert.equal(asking.note, "Comprobando la rama en origin…");
  assert.equal(asking.label, "Crear PR");
  assert.equal(asking.branches, "juan/fix-totals → …");
  assert.equal(asking.warning, "");
  // What git says against a PR now is a warning, not a lock: the click
  // checks again (createPr), so the dialog never stays stuck on a moment
  // origin couldn't be read, or on a split fixed with a pull meanwhile.
  const split = createPrompt({ seen: CREATE_SEEN, base: "main", plan: plan({ ahead: 1, blocked: "juan/fix-totals y origin/juan/fix-totals se separaron. Trae los commits de origin (git pull) antes de crear el PR." }) });
  assert.equal(split.warning, "juan/fix-totals y origin/juan/fix-totals se separaron. Trae los commits de origin (git pull) antes de crear el PR.");
  assert.equal(split.label, "Crear PR");
  const offline = createPrompt({ seen: CREATE_SEEN, base: "main", plan: { ok: false, err: "git no pudo leer origin (fatal: x)" } });
  assert.equal(offline.warning, "git no pudo leer origin (fatal: x). Crear PR lo vuelve a comprobar.");
  assert.equal(offline.label, "Crear PR", "never Publicar on a guess: the click finds out, and publishes only once the button says so");
});

test("S5 create dialog: Crear PR is off, saying why, while the base is missing or is the branch itself, or the title is empty", () => {
  const ready = { seen: CREATE_SEEN, base: "main", title: "Fix" };
  assert.equal(createBlocker(ready), "");
  assert.equal(createBlocker({ ...ready, base: "" }), "Elige una base.");
  assert.equal(createBlocker({ ...ready, base: "juan/fix-totals" }), "La base no puede ser juan/fix-totals.");
  assert.equal(createBlocker({ ...ready, title: "  " }), "Escribe un título.");
  assert.equal(createBlocker({ ...ready, seen: null }), "No hay una rama para el PR.");
});

test("S4 push state: read from git in the workspace, origin asked with ls-remote; origin's commit fetched once when it isn't here", async () => {
  const missing = createIo({ remote: null });
  assert.deepEqual(await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, missing.io.git), { ok: true, local: HEAD, remote: null, push: true, why: "missing", ahead: 0, blocked: "" });
  assert.deepEqual(missing.log.map(([, cwd, args]) => [cwd, args]), [
    ["/w/a", CREATE_GIT.head("juan/fix-totals")],
    ["/w/a", ["ls-remote", "origin", "refs/heads/juan/fix-totals"]],
  ]);
  assert.deepEqual(CREATE_GIT.head("juan/fix-totals"), ["rev-parse", "--verify", "--quiet", "refs/heads/juan/fix-totals^{commit}"]);
  const same = createIo({ remote: HEAD });
  assert.equal((await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, same.io.git)).push, false);
  assert.equal(gitCalls(same.log, "rev-list").length, 0, "the same commit: nothing to count");
  const ahead = createIo({ remote: ORIGIN, counts: ["0\t3"] });
  assert.deepEqual(await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, ahead.io.git), { ok: true, local: HEAD, remote: ORIGIN, push: true, why: "ahead", ahead: 3, blocked: "" });
  assert.deepEqual(gitCalls(ahead.log, "rev-list")[0][2], ["rev-list", "--left-right", "--count", `${ORIGIN}...${HEAD}`, "--"]);
  assert.equal(gitCalls(ahead.log, "fetch").length, 0);
  const unknown = createIo({ remote: ORIGIN, counts: [null, "0\t2"] });
  assert.equal((await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, unknown.io.git)).ahead, 2);
  assert.deepEqual(gitCalls(unknown.log, "fetch").map(([, , args]) => args), [["fetch", "--no-tags", "origin", "+refs/heads/juan/fix-totals:refs/remotes/origin/juan/fix-totals"]], "that one branch, once");
  const split = createIo({ remote: ORIGIN, counts: ["1\t1"] });
  assert.match((await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, split.io.git)).blocked, /se separaron/);
  const lost = createIo({ remote: ORIGIN, counts: [null], fetchOk: false });
  assert.equal((await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, lost.io.git)).blocked, "git no pudo comparar juan/fix-totals con origin/juan/fix-totals.");
  const gone = createIo({ local: null });
  assert.deepEqual(await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, gone.io.git), { ok: false, err: "git no encuentra la rama juan/fix-totals" });
  const offline = createIo({ remote: "fail" });
  assert.deepEqual(await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, offline.io.git), { ok: false, err: "git no pudo leer origin (fatal: Could not read from remote repository.)" });
  const broken = async () => {
    throw new Error("spawn git ENOENT");
  };
  assert.equal((await readPushState({ path: "/w/a", branch: "juan/fix-totals" }, broken)).ok, false, "never rejects");
});

test("S5 create dialog: the title starts as the last commit's subject, read with the push state", async () => {
  const { io, log } = createIo({ remote: null, subject: "Fix checkout totals" });
  assert.deepEqual(await readCreateFacts({ path: "/w/a", branch: "juan/fix-totals" }, io), {
    title: "Fix checkout totals",
    push: { ok: true, local: HEAD, remote: null, push: true, why: "missing", ahead: 0, blocked: "" },
  });
  assert.deepEqual(gitCalls(log, "log")[0].slice(1, 3), ["/w/a", ["log", "-1", "--format=%s", "refs/heads/juan/fix-totals", "--"]]);
  const none = createIo({ subject: null });
  assert.equal((await readCreateFacts({ path: "/w/a", branch: "juan/fix-totals" }, none.io)).title, "", "git can't say: the title is typed");
  assert.equal(posts(log).length + gitCalls(log, "push").length, 0, "opening the dialog publishes and creates nothing");
});

test("S4 create: a branch origin doesn't have is published first (git push -u, never forced), then GitHub creates the PR with the account that read the card", async () => {
  const { io, log } = createIo({ remote: null });
  const r = await createPr({ ...CREATE, push: true }, io);
  assert.deepEqual(r.status, "created");
  assert.deepEqual(r.pr, { number: 162, url: URL162, draft: true });
  assert.equal(r.err, "");
  assert.equal(r.plan.push, false, "published: the button goes back to Crear PR");
  const pushes = gitCalls(log, "push");
  assert.deepEqual(pushes.map(([, cwd, args, opts]) => [cwd, args, opts]), [["/w/a", PUSH, { timeout: PUSH_TIMEOUT }]]);
  assert.ok(PUSH_TIMEOUT > 30000, "the person's pre-push hooks run: more than exec's 30 s");
  assert.ok(!PUSH.some((a) => /force|^\+/.test(a)), "never forced");
  assert.deepEqual(posts(log).map(([, who, args]) => [who, args]), [[null, POST_162]], "through gh in the project's folder (who null)");
  assert.ok(log.indexOf(pushes[0]) < log.indexOf(posts(log)[0]), "published before the PR is asked for");
  assert.deepEqual(CREATE_GIT.push("juan/fix-totals"), PUSH);
});

test("S2 create: a card read through another account creates the PR with that account's credentials, and no other account is tried", async () => {
  const { io, log } = createIo({ remote: HEAD, sees: "JuanEliasJabib02" });
  const r = await createPr({ ...CREATE, seen: { ...CREATE_SEEN, who: "JuanEliasJabib02" } }, io);
  assert.equal(r.status, "created");
  assert.deepEqual(log.filter(([kind]) => kind === "gh").map(([, who, args]) => [who, args]), [["JuanEliasJabib02", POST_162]]);
});

test("S4 create: with nothing to publish no push runs, even when the button still said Publicar (someone pushed meanwhile)", async () => {
  for (const push of [false, true]) {
    const { io, log } = createIo({ remote: ORIGIN, counts: ["4\t0"] });
    const r = await createPr({ ...CREATE, push }, io);
    assert.equal(r.status, "created", `button push ${push}`);
    assert.equal(gitCalls(log, "push").length, 0);
    assert.deepEqual(posts(log).map(([, , args]) => args), [POST_162]);
  }
});

test("S4 create: commits that need publishing, when the button said Crear PR, are never published unseen: nothing is pushed or created, and the button learns it", async () => {
  const { io, log } = createIo({ remote: ORIGIN, counts: ["0\t2"] });
  const r = await createPr({ ...CREATE, push: false }, io);
  assert.deepEqual(r, {
    status: "changed",
    err: "Hay commits de juan/fix-totals sin publicar: ahora el botón los publica antes de crear el PR.",
    pr: null,
    plan: { ok: true, local: HEAD, remote: ORIGIN, push: true, why: "ahead", ahead: 2, blocked: "" },
  });
  assert.equal(gitCalls(log, "push").length + posts(log).length, 0);
});

test("S4 create: a push git refuses, or that doesn't finish in time, creates nothing", async () => {
  const hook = createIo({ remote: null, push: { ok: false, out: "", err: "To github.com:Arctic-Grey/Target-Sports-USA.git\n ! [remote rejected] juan/fix-totals -> juan/fix-totals (pre-receive hook declined)\nerror: failed to push some refs to 'https://x:secret@github.com/Arctic-Grey/Target-Sports-USA.git'" } });
  const r = await createPr({ ...CREATE, push: true }, hook.io);
  assert.equal(r.status, "refused");
  assert.equal(r.err, "git no publicó juan/fix-totals (! [remote rejected] juan/fix-totals -> juan/fix-totals (pre-receive hook declined)): no se creó el PR.");
  assert.equal(posts(hook.log).length, 0);
  const slow = createIo({ remote: null, push: "reject" });
  assert.deepEqual(await createPr({ ...CREATE, push: true }, slow.io), {
    status: "failed", err: "git push no terminó a tiempo: puede que aún publique juan/fix-totals. No se creó el PR.", pr: null, plan: null,
  });
  assert.equal(posts(slow.log).length, 0);
});

test("S4 create: an origin that is another repo now, a branch split from origin's, git that can't read origin, or props that aren't a branch publish and create nothing; it never rejects", async () => {
  const moved = createIo({ url: "git@github.com:Arctic-Grey/Other.git", remote: null });
  assert.deepEqual(await createPr({ ...CREATE, push: true }, moved.io), { status: "changed", err: "El origin ya no es Arctic-Grey/Target-Sports-USA: no se creó el PR.", pr: null, plan: null });
  const split = createIo({ remote: ORIGIN, counts: ["1\t1"] });
  const s = await createPr({ ...CREATE, push: true }, split.io);
  assert.equal(s.status, "refused");
  assert.match(s.err, /^juan\/fix-totals y origin\/juan\/fix-totals se separaron/);
  const offline = createIo({ remote: "fail" });
  const o = await createPr({ ...CREATE, push: true }, offline.io);
  assert.equal(o.status, "failed");
  assert.equal(o.err, "git no pudo leer origin (fatal: Could not read from remote repository.): no se creó el PR.");
  const bad = createIo({ remote: null });
  for (const req of [{ ...CREATE, seen: { ...CREATE_SEEN, branch: "-x" } }, { ...CREATE, title: " " }, { ...CREATE, base: "juan/fix-totals" }, { ...CREATE, project: "" }, { ...CREATE, path: null }]) {
    assert.deepEqual(await createPr(req, bad.io), { status: "failed", err: "Faltan datos del PR: no se creó el PR.", pr: null, plan: null });
  }
  assert.equal(bad.log.length, 0);
  for (const { log } of [moved, split, offline]) assert.equal(gitCalls(log, "push").length + posts(log).length, 0);
  const broken = createIo();
  broken.io.git = async () => {
    throw new Error("spawn git ENOENT");
  };
  assert.equal((await createPr(CREATE, broken.io)).status, "failed");
});

test("S4 create outcome: GitHub refusing (422 a PR already there, 403, 404) created nothing, says GitHub's message, and isn't read again", async () => {
  const exists = {
    code: 1,
    out: JSON.stringify({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for Arctic-Grey:juan/fix-totals." }], documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request", status: "422" }),
    err: "gh: Validation Failed (HTTP 422)",
  };
  const dup = createIo({ remote: HEAD, post: exists });
  assert.deepEqual(await createPr(CREATE, dup.io), { status: "refused", err: "GitHub no creó el PR: Validation Failed: A pull request already exists for Arctic-Grey:juan/fix-totals.", pr: null, plan: { ok: true, local: HEAD, remote: HEAD, push: false, why: null, ahead: 0, blocked: "" } });
  assert.equal(dup.log.filter(([kind]) => kind === "gh").length, 1, "the POST, nothing after");
  const noCode = { code: 1, out: JSON.stringify({ message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }], status: "422" }), err: "gh: Validation Failed (HTTP 422)" };
  assert.equal((await createPr(CREATE, createIo({ remote: HEAD, post: noCode }).io)).err, "GitHub no creó el PR: Validation Failed: base invalid");
  for (const [status, message] of [[403, "Resource not accessible by integration"], [404, "Not Found"]]) {
    const { io } = createIo({ remote: HEAD, post: refusal(status, message) });
    assert.equal((await createPr(CREATE, io)).err, `GitHub no creó el PR: ${message}`, String(status));
  }
  const pushed = createIo({ remote: null, post: exists });
  assert.equal((await createPr({ ...CREATE, push: true }, pushed.io)).err, "GitHub no creó el PR: Validation Failed: A pull request already exists for Arctic-Grey:juan/fix-totals. juan/fix-totals ya quedó publicada en origin.", "what was published stays said");
});

test("S4 create outcome: no answer in time, or a server error, reads the branch again with the same account: a PR there is the one made, else it may be retried", async () => {
  const made = createIo({ remote: HEAD, post: "reject", reads: [cardAnswer(prNode({ number: 162, isDraft: true }))] });
  assert.deepEqual(await createPr(CREATE, made.io), {
    status: "created", err: "", pr: { number: 162, url: URL162, draft: true }, plan: { ok: true, local: HEAD, remote: HEAD, push: false, why: null, ahead: 0, blocked: "" },
  });
  assert.deepEqual(made.log.filter(([kind]) => kind === "gh").map(([, who, args]) => [who, args.includes("POST") ? "post" : "read"]), [[null, "post"], [null, "read"]]);
  assert.deepEqual(made.log.at(-1)[2], cardQueryArgs(REPO, "juan/fix-totals"), "the card's own query, by branch");
  const none = createIo({ remote: HEAD, post: { code: 1, out: "", err: "gh: Server Error (HTTP 502)" } });
  const r = await createPr(CREATE, none.io);
  assert.equal(r.status, "unsure");
  assert.equal(r.err, "GitHub no confirmó el PR y aún no aparece en juan/fix-totals. Puedes volver a intentar: GitHub no abre dos PR de juan/fix-totals a main.");
  const old = { ...prNode({ number: 99, state: "MERGED" }) };
  assert.equal((await createPr(CREATE, createIo({ remote: HEAD, post: "reject", reads: [cardAnswer(old)] }).io)).status, "unsure", "an old merged PR of the branch isn't the one asked for");
  const other = { ...prNode({ number: 163 }), baseRefName: "release" };
  assert.equal((await createPr(CREATE, createIo({ remote: HEAD, post: "reject", reads: [cardAnswer(other)] }).io)).status, "unsure", "one into another base isn't either");
  assert.deepEqual(createOutcome({ call: { ok: true, rejected: false, out: "garbage", err: "" }, after: null, seen: CREATE_SEEN, base: "main" }).status, "unsure", "an answer that isn't a PR proves nothing");
});

test("S4 create outcome: a fork's open PR from a branch of the same name, read after no answer, isn't the one made (J-002)", async () => {
  const fork = prNode({ number: 170, isCrossRepository: true });
  const r = await createPr(CREATE, createIo({ remote: HEAD, post: "reject", reads: [cardAnswer(fork)] }).io);
  assert.equal(r.status, "unsure");
  const both = await createPr(CREATE, createIo({ remote: HEAD, post: "reject", reads: [cardAnswer([fork, prNode({ number: 162, isDraft: true })])] }).io);
  assert.deepEqual(both.pr, { number: 162, url: URL162, draft: true }, "the branch's own PR behind it is");
});

test("S4 create report: created closes the dialog with a toast; anything else stays in the dialog, or is a toast once it closed", () => {
  const created = { status: "created", err: "", pr: { number: 162, url: URL162, draft: true }, plan: null };
  assert.deepEqual(createReport(created, { seen: CREATE_SEEN, base: "main", open: true }), {
    close: true, error: "", toast: { title: "PR #162 creado", body: "juan/fix-totals → main · draft", level: "success" },
  });
  assert.equal(createReport({ ...created, pr: { ...created.pr, draft: false } }, { seen: CREATE_SEEN, base: "main", open: false }).toast.body, "juan/fix-totals → main");
  assert.equal(createReport(created, { seen: CREATE_SEEN, base: "main", open: false }).close, false);
  const err = "GitHub no creó el PR: Not Found";
  assert.deepEqual(createReport({ status: "refused", err, pr: null, plan: null }, { seen: CREATE_SEEN, base: "main", open: true }), { close: false, error: err, toast: null });
  assert.deepEqual(createReport({ status: "refused", err, pr: null, plan: null }, { seen: CREATE_SEEN, base: "main", open: false }), {
    close: false, error: "", toast: { title: "PR sin crear", body: err, level: "warning" },
  });
  assert.equal(createReport({ status: "failed", err: "x", pr: null, plan: null }, { seen: CREATE_SEEN, base: "main", open: false }).toast.level, "error");
  assert.deepEqual(createReport({ status: "unsure", err: "y", pr: null, plan: null }, { seen: CREATE_SEEN, base: "main", open: false }).toast, { title: "PR sin confirmar", body: "y", level: "warning" });
});
