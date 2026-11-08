// The PR card's model (M/pr-card-model.js): the newest PR of the shown
// space's branch with everything S5's card shows (D5), read through the same
// account path as the sidebar's PR colors (D1, pr-model.js askGitHub), and
// the card's state: header, "head → base", +/−, ↑↓, the checks and reviews
// lines, whether Mergear is enabled and why not (D6), the merge methods the
// repo allows, and the "Esta rama no tiene PR" / "El origin no es GitHub"
// states. gh and git are fakes passed through io: no test reaches the
// network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardQueryArgs, parseCardAnswer, readCard, cardState } from "../projects-sidebar/mods/projects/pr-card-model.js";
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
function prNode({
  number = 161, state = "OPEN", isDraft = false, mergeable = "MERGEABLE", mergeStateStatus = "CLEAN",
  reviewDecision = null, reviews = [], checks = [], additions = 2305, deletions = 942, headRefOid = SHA,
} = {}) {
  return {
    number, title: "Fix checkout totals", state, isDraft,
    url: `https://github.com/Arctic-Grey/Target-Sports-USA/pull/${number}`,
    baseRefName: "main", headRefName: "juan/fix-totals", headRefOid, additions, deletions,
    mergeable, mergeStateStatus, reviewDecision,
    latestReviews: { nodes: reviews.map((s) => ({ state: s })) },
    commits: { nodes: [{ commit: { statusCheckRollup: checks.length ? { contexts: { nodes: checks } } : null } }] },
  };
}

// The query's answer: the repo's default branch and merge methods, and the
// branch's newest PR (none: no node).
const cardAnswer = (pr, repo = {}) => JSON.stringify({
  data: {
    repository: {
      defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false,
      pullRequests: { nodes: pr ? [pr] : [] },
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
  assert.match(query, /pullRequests\(headRefName:\$b,first:1,orderBy:\{field:CREATED_AT,direction:DESC\}\)/);
  for (const f of ["number", "title", "state", "isDraft", "url", "baseRefName", "headRefName", "headRefOid", "additions", "deletions", "mergeable", "mergeStateStatus", "reviewDecision"]) {
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
  accounts = ["juanjabibarcticgrey", "JuanEliasJabib02"], fails = false, sync = "9\t4",
} = {}) {
  const calls = [];
  const gits = [];
  const reply = (who, args) => {
    calls.push([who, args]);
    if (fails) return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
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
