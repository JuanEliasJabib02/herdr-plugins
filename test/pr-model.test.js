// The PR of each workspace's branch (M/pr-model.js): what a workspace row's
// branch icon says (green open, purple merged, red closed, gray draft), the
// one GraphQL query per project that asks GitHub, and the account it asks
// with: the project's own folder first (a gh wrapper picks the account by
// repo there), then each other account gh is logged into when GitHub says
// it can't see the repo. gh and git are fakes passed through io: no test
// reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PR_COLORS, prQueryArgs, parsePrAnswer, accountsOf, projectPrs, mergePrs, parsePrs, prLabel, prMemo, askGitHub,
} from "../projects-sidebar/mods/projects/pr-model.js";

const REPO = { owner: "Acme-Co", repo: "Web-Store" };
// A PR node as the query asks for it; isCrossRepository: its head is a
// fork's branch (J-002).
const node = (number, state, isDraft = false, isCrossRepository = false) => ({ number, state, isDraft, url: `https://github.com/Acme-Co/Web-Store/pull/${number}`, isCrossRepository });
// GitHub's answer: each field's nodes, newest first (one node, a list, or none).
const answer = (fields) => JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(fields).map(([k, n]) => [k, { nodes: Array.isArray(n) ? n : n ? [n] : [] }])) } });
const NOT_FOUND = JSON.stringify({
  data: { repository: null },
  errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'Acme-Co/Web-Store'." }],
});

// ── What the icon says ─────────────────────────────────────────────────────

test("colors: open green, merged purple, closed red, draft the dim gray, all from the theme", () => {
  assert.deepEqual({ ...PR_COLORS }, { open: "ansi2", merged: "ansi5", closed: "ansi1", draft: "dim" });
});

test("label: the PR's number and its state, for the icon's hover", () => {
  assert.equal(prLabel({ number: 161, state: "open" }), "PR #161 · Open");
  assert.equal(prLabel({ number: 8, state: "merged" }), "PR #8 · Merged");
  assert.equal(prLabel({ number: 3, state: "closed" }), "PR #3 · Closed");
  assert.equal(prLabel({ number: 4, state: "draft" }), "PR #4 · Draft");
});

// ── The query ──────────────────────────────────────────────────────────────

test("query: one gh api graphql call names the repo and every branch as variables, never inside the query text", () => {
  const args = prQueryArgs(REPO, ["alex/feat-x", 'evil"){x}']);
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  const fields = [];
  for (let i = 2; i < args.length; i += 2) {
    assert.equal(args[i], "-f", "every value is a raw field: -F would read @file");
    fields.push(args[i + 1]);
  }
  const query = fields[0];
  assert.match(query, /^query=query\(\$o:String!,\$r:String!,\$b0:String!,\$b1:String!\)\{repository\(owner:\$o,name:\$r\)\{/);
  assert.match(query, /b0:pullRequests\(headRefName:\$b0,first:5,orderBy:\{field:CREATED_AT,direction:DESC\}\)\{nodes\{number state isDraft url isCrossRepository\}\}/, "a few, newest first, each saying whether its head is a fork's (J-002)");
  assert.ok(!query.includes("evil") && !query.includes("feat-x"), "no branch in the query text");
  assert.deepEqual(fields.slice(1), ["o=Acme-Co", "r=Web-Store", "b0=alex/feat-x", 'b1=evil"){x}']);
});

// ── Reading GitHub's answer ────────────────────────────────────────────────

test("answer: each branch's newest PR as open, draft, merged or closed; none as null", () => {
  const out = answer({ b0: node(161, "OPEN"), b1: node(9, "OPEN", true), b2: node(8, "MERGED"), b3: node(7, "CLOSED"), b4: null });
  const r = parsePrAnswer(out, ["a", "b", "c", "d", "e"]);
  assert.equal(r.ok, true);
  assert.equal(r.notFound, false);
  assert.deepEqual(r.prs, {
    a: { number: 161, state: "open", url: "https://github.com/Acme-Co/Web-Store/pull/161" },
    b: { number: 9, state: "draft", url: "https://github.com/Acme-Co/Web-Store/pull/9" },
    c: { number: 8, state: "merged", url: "https://github.com/Acme-Co/Web-Store/pull/8" },
    d: { number: 7, state: "closed", url: "https://github.com/Acme-Co/Web-Store/pull/7" },
    e: null,
  });
});

test("answer: a repo the account can't see reads as notFound; anything else unreadable as a failure", () => {
  assert.deepEqual(parsePrAnswer(NOT_FOUND, ["a"]), { ok: false, notFound: true, prs: {} });
  assert.deepEqual(parsePrAnswer("", ["a"]), { ok: false, notFound: false, prs: {} });
  assert.deepEqual(parsePrAnswer("gh: Bad credentials (HTTP 401)", ["a"]), { ok: false, notFound: false, prs: {} });
  const rateLimited = JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
  assert.deepEqual(parsePrAnswer(rateLimited, ["a"]), { ok: false, notFound: false, prs: {} });
});

test("answer: a node that isn't a PR (no number, an unknown state, a URL off GitHub) reads as no PR", () => {
  const own = { isCrossRepository: false };
  const out = answer({ b0: { ...own, number: "1", state: "OPEN", url: "https://github.com/x/y/pull/1" }, b1: { ...own, number: 2, state: "WEIRD", url: "https://github.com/x/y/pull/2" }, b2: { ...own, number: 3, state: "OPEN", url: "javascript:alert(1)" } });
  assert.deepEqual(parsePrAnswer(out, ["a", "b", "c"]).prs, { a: null, b: null, c: null });
});

test("answer: a fork's PR from a branch of the same name is never the branch's: the newest PR whose head is in the repo is; only forks' PRs is no PR (J-002)", () => {
  const out = answer({
    b0: [node(170, "OPEN", false, true), node(161, "OPEN")],
    b1: [node(172, "OPEN", false, true), node(171, "MERGED", false, true)],
    b2: [{ number: 9, state: "OPEN", isDraft: false, url: "https://github.com/Acme-Co/Web-Store/pull/9" }],
  });
  assert.deepEqual(parsePrAnswer(out, ["alex/a", "alex/b", "alex/c"]).prs, {
    "alex/a": { number: 161, state: "open", url: "https://github.com/Acme-Co/Web-Store/pull/161" },
    "alex/b": null,
    "alex/c": null,
  }, "a node that doesn't say where its head is counts as a fork's");
});

test("accounts: the github.com logins gh is signed into, from gh auth status --json hosts", () => {
  const out = JSON.stringify({ hosts: { "github.com": [
    { state: "success", active: true, login: "work-dev" },
    { state: "success", active: false, login: "alexPersonal" },
    { state: "error", active: false, login: "expired-one" },
  ], "ghe.example.com": [{ state: "success", login: "elsewhere" }] } });
  assert.deepEqual(accountsOf(out), ["work-dev", "alexPersonal"]);
  assert.deepEqual(accountsOf("not json"), []);
  assert.deepEqual(accountsOf(""), []);
});

// ── Asking for a project ───────────────────────────────────────────────────

// ghAs as a login gh is no longer logged into: `gh auth token --user` gives
// nothing, so its shell exits 4 before gh runs (git.js AS_ACCOUNT).
const LOGGED_OUT = { ok: false, code: 4, out: "", err: "" };
// A token GitHub no longer takes (revoked): a 401.
const BAD_CREDENTIALS = {
  ok: false, code: 1, out: JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/graphql", status: "401" }), err: "gh: Bad credentials (HTTP 401)",
};

// A project at /p whose origin is `url`; gh answers by account: `sees` is
// the account that can see the repo (null: the plain call, the project's
// own folder, sees it); `broken`: { login: what ghAs answers as it }. Every
// call is recorded as [account|null, args].
function fakeIo({ url = "git@github.com:Acme-Co/Web-Store.git", sees = null, prs = {}, accounts = ["work-dev", "alexPersonal"], fails = false, broken = {} } = {}) {
  const calls = [];
  const reply = (who, args) => {
    calls.push([who, args]);
    if (fails) return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
    if (who !== null && broken[who]) return broken[who];
    if (who !== sees) return { ok: false, code: 1, out: NOT_FOUND, err: "gh: Could not resolve to a Repository" };
    const names = args.filter((a) => /^b\d+=/.test(a)).map((a) => a.slice(a.indexOf("=") + 1));
    return { ok: true, code: 0, out: answer(Object.fromEntries(names.map((b, i) => [`b${i}`, prs[b] ?? null]))), err: "" };
  };
  const io = {
    git: async (cwd, args) => (args.join(" ") === "remote get-url origin" ? { ok: true, out: url, err: "" } : { ok: false, out: "", err: "unexpected" }),
    gh: async (cwd, args) => {
      assert.equal(cwd, "/p", "gh runs in the project's folder, where a wrapper picks its account");
      return reply(null, args);
    },
    ghAs: async (login, cwd, args) => reply(login, args),
    accounts: async () => accounts,
    hostname: async (host) => (host === "github-acme" ? "github.com" : null),
  };
  return { io, calls };
}

const CHECKOUTS = [
  { path: "/p", branch: "main", main: true },
  { path: "/w/a", branch: "alex/a", main: false },
  { path: "/w/b", branch: "alex/b", main: false },
  { path: "/w/detached", branch: null, main: false },
];

test("project: one call for every branch but the main checkout's, each PR under its workspace's path", async () => {
  const { io, calls } = fakeIo({ prs: { "alex/a": node(161, "OPEN"), "alex/b": node(8, "MERGED") } });
  const r = await projectPrs("/p", CHECKOUTS, io, prMemo());
  assert.equal(calls.length, 1);
  assert.deepEqual(r, {
    ok: true,
    prs: {
      "/w/a": { number: 161, state: "open", url: "https://github.com/Acme-Co/Web-Store/pull/161" },
      "/w/b": { number: 8, state: "merged", url: "https://github.com/Acme-Co/Web-Store/pull/8" },
    },
  });
});

test("project: only the main checkout, or an origin that isn't GitHub, asks nothing", async () => {
  const main = fakeIo();
  assert.deepEqual(await projectPrs("/p", [CHECKOUTS[0]], main.io, prMemo()), { ok: true, prs: {} });
  assert.equal(main.calls.length, 0);
  const bitbucket = fakeIo({ url: "git@bitbucket.org:team-repos/x.git" });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, bitbucket.io, prMemo()), { ok: true, prs: {} });
  assert.equal(bitbucket.calls.length, 0);
});

test("project: an ssh alias of github.com (github-acme) is GitHub", async () => {
  const { io, calls } = fakeIo({ url: "git@github-acme:Acme-Co/Web-Store.git", prs: { "alex/a": node(161, "OPEN") } });
  const r = await projectPrs("/p", CHECKOUTS, io, prMemo());
  assert.equal(calls.length, 1);
  assert.equal(r.prs["/w/a"].number, 161);
});

test("two accounts: when the project's own folder can't see the repo, each other account is tried, and the one that sees it is remembered for that owner", async () => {
  const memo = prMemo();
  const { io, calls } = fakeIo({ sees: "alexPersonal", prs: { "alex/a": node(5, "OPEN") } });
  const first = await projectPrs("/p", CHECKOUTS, io, memo);
  assert.deepEqual(calls.map(([who]) => who), [null, "work-dev", "alexPersonal"]);
  assert.equal(first.prs["/w/a"].number, 5);
  calls.length = 0;
  const again = await projectPrs("/p", CHECKOUTS, io, memo);
  assert.deepEqual(calls.map(([who]) => who), ["alexPersonal"], "straight to the account that saw it");
  assert.deepEqual(again, first);
});

test("two accounts: a remembered account that stops seeing the repo falls back to the folder, then the others", async () => {
  const memo = prMemo();
  memo.owners.set("acme-co", "alexPersonal");
  const { io, calls } = fakeIo({ sees: null, prs: { "alex/a": node(161, "OPEN") } });
  const r = await projectPrs("/p", CHECKOUTS, io, memo);
  assert.deepEqual(calls.map(([who]) => who), ["alexPersonal", null]);
  assert.equal(r.prs["/w/a"].number, 161);
  assert.equal(memo.owners.has("acme-co"), false, "the folder's own account sees it now");
});

test("two accounts: a remembered login that stops answering (gh logged out of it, a revoked token's 401) is forgotten, and the folder's account answers (J-003)", async () => {
  for (const [name, reply] of [["logged out", LOGGED_OUT], ["401", BAD_CREDENTIALS]]) {
    const memo = prMemo();
    memo.owners.set("acme-co", "alexPersonal");
    const { io, calls } = fakeIo({ sees: null, broken: { alexPersonal: reply }, prs: { "alex/a": node(161, "OPEN") } });
    const r = await projectPrs("/p", CHECKOUTS, io, memo);
    assert.deepEqual(calls.map(([who]) => who), ["alexPersonal", null], name);
    assert.equal(r.ok, true, name);
    assert.equal(r.prs["/w/a"].number, 161, name);
    assert.equal(memo.owners.has("acme-co"), false, `${name}: the folder is asked first from now on`);
  }
});

test("two accounts: a remembered login gh logged out of, with a folder that can't see the repo: the other accounts are asked, and the one that answers is remembered (J-003)", async () => {
  const memo = prMemo();
  memo.owners.set("acme-co", "alexPersonal");
  const { io, calls } = fakeIo({ sees: "work-dev", broken: { alexPersonal: LOGGED_OUT }, prs: { "alex/a": node(161, "OPEN") } });
  const r = await projectPrs("/p", CHECKOUTS, io, memo);
  assert.deepEqual(calls.map(([who]) => who), ["alexPersonal", null, "work-dev"], "the logged-out login isn't asked twice");
  assert.equal(r.prs["/w/a"].number, 161);
  assert.equal(memo.owners.get("acme-co"), "work-dev");
  calls.length = 0;
  await projectPrs("/p", CHECKOUTS, io, memo);
  assert.deepEqual(calls.map(([who]) => who), ["work-dev"], "straight to it next time");
});

test("two accounts: a remembered login failing, then every other one: the project reads as failed, and the login is forgotten (J-003)", async () => {
  const memo = prMemo();
  memo.owners.set("acme-co", "alexPersonal");
  const down = fakeIo({ fails: true });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, down.io, memo), { ok: false, prs: {} });
  assert.deepEqual(down.calls.map(([who]) => who), ["alexPersonal", null], "the folder's failure isn't 'can't see it': no other account");
  assert.equal(memo.owners.has("acme-co"), false);
  const unseen = prMemo();
  unseen.owners.set("acme-co", "alexPersonal");
  const none = fakeIo({ sees: "nobody", broken: { alexPersonal: LOGGED_OUT } });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, none.io, unseen), { ok: false, prs: {} });
  assert.deepEqual(none.calls.map(([who]) => who), ["alexPersonal", null, "work-dev"]);
  assert.equal(unseen.owners.has("acme-co"), false);
});

test("two accounts: the remembered login, the only one that sees the repo, failing for a while (5xx, rate limit, exec's limit) is forgotten, the others are asked, and the read is that failure, never notFound (J-009)", async () => {
  const RATE_LIMITED = { ok: false, code: 1, out: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] }), err: "gh: API rate limit exceeded for user ID 1." };
  const SERVER_ERROR = { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
  const branches = ["alex/a"];
  for (const [name, reply] of [["502", SERVER_ERROR], ["rate limit", RATE_LIMITED], ["exec's limit", null]]) {
    const memo = prMemo();
    memo.owners.set("acme-co", "alexPersonal");
    const { io, calls } = fakeIo({ sees: "alexPersonal", broken: reply ? { alexPersonal: reply } : {}, prs: { "alex/a": node(161, "OPEN") } });
    if (!reply) {
      const ghAs = io.ghAs;
      io.ghAs = async (login, cwd, args) => {
        if (login === "alexPersonal") {
          calls.push([login, args]);
          throw new Error("exec timed out after 30000 ms");
        }
        return ghAs(login, cwd, args);
      };
    }
    const r = await askGitHub(io, "/p", REPO, prQueryArgs(REPO, branches), (out) => parsePrAnswer(out, branches), memo);
    assert.equal(r.ok, false, name);
    assert.equal(r.notFound, false, `${name}: GitHub didn't answer; it isn't that no account sees the repo`);
    assert.deepEqual(calls.map(([who]) => who), ["alexPersonal", null, "work-dev"], `${name}: the others are still asked, the failed login once`);
    assert.equal(memo.owners.has("acme-co"), false, `${name}: forgotten, as any failure of the remembered login`);
  }
});

test("project: a fork's newer PR from a branch of the same name leaves the row's color to the branch's own PR; only forks' PRs leave it as it was (J-002)", async () => {
  const { io } = fakeIo({ prs: { "alex/a": [node(170, "OPEN", false, true), node(161, "MERGED")], "alex/b": [node(171, "OPEN", false, true)] } });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, io, prMemo()), {
    ok: true,
    prs: { "/w/a": { number: 161, state: "merged", url: "https://github.com/Acme-Co/Web-Store/pull/161" } },
  });
});

test("two accounts: no account sees the repo, or gh fails: the project reads as failed, so its rows keep what they showed", async () => {
  const none = fakeIo({ sees: "nobody" });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, none.io, prMemo()), { ok: false, prs: {} });
  assert.equal(none.calls.length, 3, "the folder and both accounts, once each");
  const down = fakeIo({ fails: true });
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, down.io, prMemo()), { ok: false, prs: {} });
  assert.equal(down.calls.length, 1, "a failure that isn't 'can't see it' tries no other account");
});

test("project: gh that can't start (not installed) reads as failed, never throws", async () => {
  const { io } = fakeIo();
  io.gh = async () => {
    throw new Error("spawn gh ENOENT");
  };
  assert.deepEqual(await projectPrs("/p", CHECKOUTS, io, prMemo()), { ok: false, prs: {} });
});

test("project: the accounts are listed once per memo, and only when a repo isn't seen", async () => {
  const memo = prMemo();
  let listed = 0;
  const { io } = fakeIo({ sees: "alexPersonal" });
  const accounts = io.accounts;
  io.accounts = async () => {
    listed++;
    return accounts();
  };
  await projectPrs("/p", CHECKOUTS, io, memo);
  memo.owners.clear();
  await projectPrs("/p", CHECKOUTS, io, memo);
  assert.equal(listed, 1);
  const seen = fakeIo({ prs: {} });
  seen.io.accounts = async () => assert.fail("not needed when the folder sees the repo");
  await projectPrs("/p", CHECKOUTS, seen.io, prMemo());
});

test("project: many branches go in calls of at most 25", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `/w/${i}`, branch: `b-${i}`, main: false }));
  const { io, calls } = fakeIo({ prs: { "b-29": node(29, "OPEN") } });
  const r = await projectPrs("/p", many, io, prMemo());
  assert.deepEqual(calls.map(([, args]) => args.filter((a) => /^b\d+=/.test(a)).length), [25, 5]);
  assert.equal(r.prs["/w/29"].number, 29);
});

// ── What is stored ─────────────────────────────────────────────────────────

const PR = (number, state) => ({ number, state, url: `https://github.com/o/r/pull/${number}` });

test("merge: an answered project replaces its workspaces' PRs; a failed one keeps them; workspaces no list has any more go", () => {
  const cache = {
    "/p": [{ path: "/p", branch: "main", main: true }, { path: "/w/a", branch: "a", main: false }, { path: "/w/b", branch: "b", main: false }],
    "/q": [{ path: "/q", branch: "main", main: true }, { path: "/w/q", branch: "q", main: false }],
  };
  const prev = { "/w/a": PR(1, "open"), "/w/b": PR(2, "open"), "/w/q": PR(3, "open"), "/w/gone": PR(4, "merged") };
  const next = mergePrs(prev, [
    { project: "/p", ok: true, prs: { "/w/a": PR(1, "merged") } },
    { project: "/q", ok: false, prs: {} },
  ], cache);
  assert.deepEqual(next, { "/w/a": PR(1, "merged"), "/w/q": PR(3, "open") });
  assert.deepEqual(Object.keys(next), ["/w/a", "/w/q"], "keys sorted, so an unchanged value is never rewritten");
});

test("stored value: valid entries read back as themselves, the rest is dropped, a foreign value reads as {}", () => {
  const good = { "/w/a": PR(1, "open"), "/w/b": PR(2, "draft") };
  assert.deepEqual(parsePrs(good), good);
  assert.deepEqual(parsePrs({ ...good, "/w/c": { number: 3, state: "lost", url: "https://github.com/o/r/pull/3" }, "/w/d": "x", relative: PR(5, "open") }), good);
  assert.deepEqual(parsePrs(null), {});
  assert.deepEqual(parsePrs([1, 2]), {});
  assert.deepEqual(parsePrs("x"), {});
});

// ── Wiring (tree.js, store.js and git.js load herdr, so their source is read) ─

const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");

test("tree.js: render reads the PRs once; the branch icon takes its PR's color and hover, never on the main checkout, under an agent's mark or on an asleep row's moon (workspace-sleep D3)", () => {
  const tree = src("tree.js");
  assert.equal(tree.split("store.prs()").length - 1, 2, "read in render, and once more to merge a round");
  const row = tree.slice(tree.indexOf("function workspaceRow("), tree.indexOf("\n}\n", tree.indexOf("function workspaceRow(")));
  assert.match(row, /const shown = !busy && !moon && !w\.main && pr \? pr : null;/);
  assert.match(row, /t\[PR_COLORS\[shown\.state\]\] \?\? t\.dim/);
  assert.match(row, /\.tooltip\(prLabel\(shown\)\)/);
});

test("tree.js: only the window in front asks, every minute, and again on coming back to it or to another group", () => {
  const tree = src("tree.js");
  assert.match(tree, /const PR_EVERY = 60000;/);
  assert.match(tree, /const PR_AGAIN = 10000;/);
  const tick = tree.slice(tree.indexOf("  prTick(cx) {"), tree.indexOf("\n  }\n", tree.indexOf("  prTick(cx) {")));
  assert.match(tick, /if \(!active\) return;/);
  assert.match(tick, /back \? PR_AGAIN : PR_EVERY/);
  const round = tree.slice(tree.indexOf("  refreshPrs(cx) {"), tree.indexOf("\n  }\n", tree.indexOf("  refreshPrs(cx) {")));
  assert.match(round, /if \(this\.prBusy\) return;/, "one round at a time");
  assert.match(round, /store\.savePrs\(mergePrs\(store\.prs\(\), rounds, store\.cache\(\)\)\)/);
});

test("git.js: another account's gh gets its token inside the shell, never back in the mod", () => {
  const git = src("git.js");
  assert.match(git, /GH_TOKEN="\$\(gh auth token --user "\$1" 2>\/dev\/null\)"/);
  assert.match(git, /exec\("sh", \["-c", AS_ACCOUNT, "sh", login, \.\.\.args\], \{ cwd \}\)/);
  assert.match(git, /exec\("gh", \["auth", "status", "--json", "hosts"\]\)/);
  assert.ok(!/auth", "token/.test(git), "the mod never runs gh auth token itself");
});
