// T5: the New workspace dialog's model (M/new-workspace-model.js): names
// (slug, smart input, pickName), the base to create from (D13), the project
// and agent choices, the creation plan (D14), the agent's argv (D15), and the
// whole creation against real git in throwaway repos (D12–D16).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyRegistry, addProject, addGroup, selectGroup, findProject } from "../projects-sidebar/mods/projects/lib.js";
import {
  NAME_MAX, CLAUDE_SETTINGS, claudeSettingsPath,
  slug, parseInput, pickName, freeName, worktreePath, findBranch,
  pickDefaultBase, baseChoices, baseFor, rememberBase, baseMenuRows,
  agentChoices, defaultAgent, agentArgv,
  projectChoices, companionChoices, initialProject,
  creationPlan, pathClashes, clashError, gitOps, nameTaken, createWorkspace,
} from "../projects-sidebar/mods/projects/new-workspace-model.js";
import { resumeFlags } from "../agent-sleep/mods/agent-sleep/resume.js";

// ── Names (D12) ────────────────────────────────────────────────────────────

test("slug: keeps the case typed, other characters become one dash, trimmed of dashes, at most 48", () => {
  assert.equal(slug("AX-3735"), "AX-3735", "a ticket keeps its case, like Orca");
  assert.equal(slug("Fix Login Bug!"), "Fix-Login-Bug");
  assert.equal(slug("  --Hello__World--  "), "Hello__World");
  assert.equal(slug("feat/new  UI (v2)"), "feat-new-UI-v2");
  assert.equal(slug("release-1.2.0"), "release-1.2.0");
  assert.equal(slug("a".repeat(60)), "a".repeat(NAME_MAX));
  assert.equal(slug(`${"b".repeat(47)}-tail`), "b".repeat(47), "no dash left at the cut");
  assert.equal(NAME_MAX, 48);
  assert.equal(slug(""), "");
  assert.equal(slug("!!!"), "");
  assert.equal(slug(null), "");
});

test("slug: never starts with a dash, and is always a name git takes as a branch", () => {
  assert.equal(slug("-rf"), "rf");
  assert.equal(slug("--force"), "force");
  assert.equal(slug("..hidden"), "hidden");
  assert.equal(slug("a..b"), "a.b");
  assert.equal(slug("ends."), "ends");
  assert.equal(slug("x.lock"), "x");
  assert.equal(slug("Añadir café"), "Anadir-cafe", "accents dropped, not turned into dashes");
  for (const s of ["-rf", "..hidden", "a..b", "x.lock", "Añadir café", "  --Hello__World--  "]) {
    assert.ok(!slug(s).startsWith("-"));
  }
});

test("slug: never HEAD, and no .lock ending in any case (on a Mac's disk x.LOCK is x's lock file)", () => {
  assert.equal(slug("HEAD"), "", "git refuses it: the dialog asks for a name");
  assert.equal(slug("  HEAD  "), "");
  assert.equal(slug("HEAD.lock"), "", "HEAD once .lock is gone");
  assert.equal(slug("x.LOCK"), "x");
  assert.equal(slug("x.Lock.lock"), "x", "every .lock ending, whatever its case");
  assert.equal(slug("x.LOCK."), "x");
  assert.equal(slug("head"), "", "nor head: on a Mac's disk origin/head is origin/HEAD");
  assert.equal(slug("Head"), "");
  assert.equal(slug("HEAD-2"), "HEAD-2", "only HEAD itself, in any case");
  assert.equal(slug("locksmith"), "locksmith");
});

test("findBranch: the branch a name is on a Mac's disk, compared ignoring case; null when none", () => {
  assert.equal(findBranch(["main", "ax-3735"], "AX-3735"), "ax-3735", "a case variant is that branch");
  assert.equal(findBranch(["main", "AX-3735"], "AX-3735"), "AX-3735");
  assert.equal(findBranch(["main", "user/Feat"], "USER/feat"), "user/Feat");
  assert.equal(findBranch(["main", "ax-3735-2"], "AX-3735"), null, "whole names only");
  assert.equal(findBranch([], "x"), null);
  assert.equal(findBranch(null, "x"), null);
});

test("pickName: a name taken in one companion moves every repo to -2", () => {
  assert.equal(pickName("fix", { "/code/app": [], "/code/api": [] }), "fix");
  assert.equal(pickName("fix", { "/code/app": [], "/code/api": ["fix"], "/code/web": [] }), "fix-2");
  assert.equal(pickName("fix", [new Set(), new Set(["fix"])]), "fix-2", "an array of sets works too");
  assert.equal(pickName("", { "/code/app": [] }), "");
});

test("pickName: -3 when -2 is taken in another repo; the suffix keeps 48 characters", () => {
  assert.equal(pickName("fix", { "/code/app": ["fix"], "/code/api": ["fix-2"] }), "fix-3");
  const long = "a".repeat(NAME_MAX);
  const next = pickName(long, { "/code/app": [long] });
  assert.equal(next, `${"a".repeat(NAME_MAX - 2)}-2`);
  assert.equal(next.length, NAME_MAX);
});

test("smart input: #12 and 12 are issue-12, with no first message", () => {
  assert.deepEqual(parseInput("#12"), { name: "issue-12", task: null });
  assert.deepEqual(parseInput(" 12 "), { name: "issue-12", task: null });
});

test("smart input: GitHub pull and issue URLs; the URL becomes the agent's first message", () => {
  const pull = "https://github.com/acme/shop/pull/34";
  assert.deepEqual(parseInput(pull), { name: "pr-34", task: `Complete ${pull}` });
  const files = "https://github.com/acme/shop/pull/34/files?w=1";
  assert.deepEqual(parseInput(files), { name: "pr-34", task: `Complete ${files}` });
  const issue = "https://github.com/acme/shop/issues/7#issuecomment-1";
  assert.deepEqual(parseInput(issue), { name: "issue-7", task: `Complete ${issue}` });
});

test("smart input: a Jira link is its key; plain text is its slug", () => {
  const jira = "https://acme.atlassian.net/browse/PROJ-123";
  assert.deepEqual(parseInput(jira), { name: "PROJ-123", task: `Complete ${jira}` });
  const self = "https://jira.acme.dev/browse/AB_C-9?focusedCommentId=1";
  assert.deepEqual(parseInput(self), { name: "AB_C-9", task: `Complete ${self}` });
  assert.deepEqual(parseInput("Fix the login bug"), { name: "Fix-the-login-bug", task: null });
  assert.deepEqual(parseInput("issue 12 follow-up"), { name: "issue-12-follow-up", task: null });
  assert.deepEqual(parseInput(""), { name: "", task: null });
});

test("worktree path: <root>/<repo name>/<name>, ~ expanded", () => {
  assert.equal(worktreePath("~/orca/workspaces", "shop", "fix", "/Users/ana"), "/Users/ana/orca/workspaces/shop/fix");
  assert.equal(worktreePath("/w/", "shop", "fix", "/Users/ana"), "/w/shop/fix");
});

// ── Bases (D13) ────────────────────────────────────────────────────────────

test("default base from a fake ref list: origin/HEAD's target, else origin/main, origin/master, main, master", () => {
  const all = ["origin/develop", "origin/main", "origin/master", "main", "master"];
  assert.equal(pickDefaultBase("origin/develop", all), "origin/develop");
  assert.equal(pickDefaultBase(null, all), "origin/main");
  assert.equal(pickDefaultBase("origin/gone", ["origin/master", "main"]), "origin/master", "a dangling origin/HEAD is skipped");
  assert.equal(pickDefaultBase(null, ["main", "master"]), "main");
  assert.equal(pickDefaultBase(null, ["master"]), "master");
  assert.equal(pickDefaultBase(null, []), "HEAD", "nothing known: where the repo is");
});

test("base choices: the default first, then the recent remote branches, no origin/HEAD, no repeats", () => {
  assert.deepEqual(baseChoices("origin/main", ["origin/feat-a", "origin/HEAD", "origin/main", "origin/feat-b"]), [
    "origin/main", "origin/feat-a", "origin/feat-b",
  ]);
  assert.deepEqual(baseChoices("main", []), ["main"]);
  const many = Array.from({ length: 40 }, (_, i) => `origin/b${i}`);
  assert.equal(baseChoices("origin/main", many).length, 31, "the default plus 30");
});

// ── A project's saved base (D37, S33) ──────────────────────────────────────

test("baseFor: the saved base when git has it; else origin's default, naming the gone one; no saved base is origin's default (D37)", () => {
  const app = { path: "/code/app", name: "app", base: "origin/develop" };
  assert.deepEqual(baseFor(app, "origin/main", true), { def: "origin/develop", gone: null });
  assert.deepEqual(baseFor(app, "origin/main", false), { def: "origin/main", gone: "origin/develop" });
  assert.deepEqual(baseFor({ path: "/code/app", name: "app" }, "origin/main", false), { def: "origin/main", gone: null });
  assert.deepEqual(baseFor({ path: "/code/app", name: "app" }, "origin/main", true), { def: "origin/main", gone: null }, "nothing saved: the lookup means nothing");
  assert.deepEqual(baseFor(app, null, false), { def: null, gone: null }, "not a git repository");
  assert.deepEqual(baseFor(null, "origin/main", false), { def: "origin/main", gone: null });
});

test("rememberBase: origin's default clears, another base saves, the saved one returns the same registry (D37, S33)", () => {
  const r = addProject(emptyRegistry(), { path: "/code/app" });
  const saved = rememberBase(r, "/code/app", "origin/develop", "origin/main");
  assert.equal(findProject(saved, "/code/app").project.base, "origin/develop", "a create from another base saves it");
  assert.equal(rememberBase(saved, "/code/app", "origin/develop", "origin/main"), saved, "the saved one ran: the same registry");
  const other = rememberBase(saved, "/code/app", "origin/release", "origin/main");
  assert.equal(findProject(other, "/code/app").project.base, "origin/release", "a different one replaces it");
  const cleared = rememberBase(other, "/code/app", "origin/main", "origin/main");
  assert.ok(!("base" in findProject(cleared, "/code/app").project), "origin's default ran: the saved base goes");
  assert.deepEqual(cleared, r);
  assert.equal(rememberBase(r, "/code/app", "origin/main", "origin/main"), r, "nothing saved, origin's default ran");
  assert.equal(rememberBase(r, "/code/app", "main", "HEAD"), r, "a local base is never saved");
  assert.equal(rememberBase(r, "/code/none", "origin/develop", "origin/main"), r, "an unknown project");
});

test("base menu rows: origin's default first (it clears), the saved base pinned after it when the recent lack it, then the recent; the saved one checked (D37)", () => {
  const recent = ["origin/feat", "origin/master", "origin/develop"];
  assert.deepEqual(baseMenuRows("origin/master", recent, null), [
    { base: null, label: "origin's default (origin/master)", checked: true },
    { base: "origin/feat", label: "origin/feat", checked: false },
    { base: "origin/develop", label: "origin/develop", checked: false },
  ], "origin's default is listed once, as the first row");
  assert.deepEqual(baseMenuRows("origin/master", recent, "origin/develop").map((r) => [r.base, r.checked]), [
    [null, false], ["origin/feat", false], ["origin/develop", true],
  ], "a saved base among the recent: checked where it is");
  assert.deepEqual(baseMenuRows("origin/master", recent, "origin/old").map((r) => [r.base, r.checked]), [
    [null, false], ["origin/old", true], ["origin/feat", false], ["origin/develop", false],
  ], "a saved base the recent lack: pinned right after origin's default");
  assert.deepEqual(baseMenuRows("main", [], null), [], "no remote branch and nothing saved: no rows");
  assert.deepEqual(baseMenuRows("main", [], "origin/develop").map((r) => [r.base, r.checked]), [[null, false], ["origin/develop", true]], "a saved base can still be cleared");
  assert.deepEqual(baseMenuRows(null, recent, null), [], "not a git repository");
});

// ── Projects and agents (D15, D16) ─────────────────────────────────────────

function registryWithGroups() {
  let r = emptyRegistry(); // g1 "Projects"
  r = addProject(r, { path: "/code/notes" });
  r = addGroup(r, "AG"); // g2
  r = selectGroup(r, "g2");
  r = addProject(r, { path: "/code/shop" });
  r = addProject(r, { path: "/code/api" });
  r = addProject(r, { path: "/code/web" });
  return r;
}

test("project choices: only the active group's projects (the space you're in); chips are the rest of the primary's group", () => {
  const r = registryWithGroups();
  assert.deepEqual(projectChoices(r).map((p) => [p.name, p.group]), [
    ["shop", "AG"], ["api", "AG"], ["web", "AG"],
  ]);
  assert.deepEqual(projectChoices(selectGroup(r, "g1")).map((p) => p.name), ["notes"]);
  assert.deepEqual(projectChoices(selectGroup(addGroup(r, "Empty"), "g3")), [], "an empty group offers none");
  const chips = companionChoices(r, "/code/api");
  assert.equal(chips.group.name, "AG");
  assert.deepEqual(chips.projects.map((p) => p.name), ["shop", "web"]);
  assert.deepEqual(companionChoices(r, "/code/notes").projects, [], "alone in its group: no chips");
  assert.deepEqual(companionChoices(r, "/elsewhere"), { group: null, projects: [] });
});

test("initial project: the one asked for when it is in the active group, else the active group's first, else none", () => {
  const r = registryWithGroups();
  assert.equal(initialProject(r, "/code/web/").path, "/code/web");
  assert.equal(initialProject(r, "/code/notes").path, "/code/shop", "another group's project isn't offered: the active group's first");
  assert.equal(initialProject(r, "/not/registered").path, "/code/shop");
  assert.equal(initialProject(r, null).path, "/code/shop");
  assert.equal(initialProject(selectGroup(addGroup(r, "Empty"), "g3"), "/code/shop"), null, "an empty active group: none, never another group's");
  assert.equal(initialProject(emptyRegistry(), null), null);
});

const claude = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"], installed: true };
const codex = { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, run: ["codex"], installed: true };
const pi = { key: "pi", name: "Pi", icon: "icons/pi.svg", tint: true, run: ["pi", "--fast"], installed: true };

test("agent choices: the installed agents plus Blank terminal; Claude by default", () => {
  const choices = agentChoices([codex, { ...pi, installed: false }, claude]);
  assert.deepEqual(choices.map((a) => a.key), ["codex", "claude", ""]);
  assert.equal(choices.at(-1).name, "Blank terminal");
  assert.equal(defaultAgent(choices).key, "claude");
  assert.equal(defaultAgent(agentChoices([codex])).key, "codex", "no claude: the first installed");
  assert.equal(defaultAgent(agentChoices([])).name, "Blank terminal");
});

// Where install.sh puts the mod's claude-settings.json, for appHome
// /Users/me/.config/herdr-app.
const SETTINGS = "/Users/me/.config/herdr-app/mods/projects/claude-settings.json";

test("agent argv: claude gets --settings with the settings file and one --add-dir per companion", () => {
  const argv = agentArgv(claude, ["/w/api/fix", "/w/web/fix"], true, SETTINGS);
  assert.deepEqual(argv, ["claude", "--add-dir", "/w/api/fix", "--add-dir", "/w/web/fix", "--settings", SETTINGS]);
  assert.equal(argv.filter((a) => a === "--add-dir").length, 2);
});

test("claude settings: the mod ships CLAUDE_SETTINGS as claude-settings.json, at <appHome>/mods/projects", () => {
  const shipped = readFileSync(new URL("../projects-sidebar/mods/projects/claude-settings.json", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(shipped), JSON.parse(CLAUDE_SETTINGS));
  assert.deepEqual(JSON.parse(CLAUDE_SETTINGS), { env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } });
  assert.equal(claudeSettingsPath("/Users/me/.config/herdr-app"), SETTINGS);
  assert.equal(claudeSettingsPath("/Users/me/.config/herdr-app/"), SETTINGS, "no double slash");
});

test("agent argv: a Claude launched with companions is one agent-sleep can resume (all its flags kept)", () => {
  const argv = agentArgv(claude, ["/w/api/fix", "/w/web/fix"], true, SETTINGS);
  assert.deepEqual(resumeFlags(argv), { ok: true, flags: argv.slice(1) });
  // The JSON itself as the value was what kept it awake ("1 terminal didn't stop").
  assert.deepEqual(resumeFlags(["claude", "--settings", CLAUDE_SETTINGS]), { ok: false, reason: "bad-value", token: "--settings" });
});

test("agent argv: no companions, or access off, leaves the agent's run as it is", () => {
  assert.deepEqual(agentArgv(claude, [], true), ["claude"]);
  assert.deepEqual(agentArgv(claude, ["/w/api/fix"], false), ["claude"]);
  assert.deepEqual(agentArgv(codex, ["/w/api/fix"], false), ["codex"]);
});

test("agent argv: codex gets only --add-dirs, another agent is unchanged, never an env prefix", () => {
  assert.deepEqual(agentArgv(codex, ["/w/api/fix", "/w/web/fix"], true), ["codex", "--add-dir", "/w/api/fix", "--add-dir", "/w/web/fix"]);
  assert.deepEqual(agentArgv(pi, ["/w/api/fix"], true), ["pi", "--fast"]);
  for (const agent of [claude, codex, pi]) {
    const argv = agentArgv(agent, ["/w/api/fix"], true);
    assert.equal(argv[0], agent.run[0], "starts with the agent itself");
    assert.ok(!argv.includes("env") && !argv.some((a) => /^[A-Z_]+=/.test(a)), `no env prefix for ${agent.key}`);
  }
  const run = ["claude"];
  agentArgv({ ...claude, run }, ["/w/api/fix"], true);
  assert.deepEqual(run, ["claude"], "the agent's run is never mutated");
});

test("agent argv: blank terminal has no argv", () => {
  const blank = agentChoices([]).at(-1);
  assert.equal(agentArgv(blank, ["/w/api/fix"], true), null);
  assert.equal(agentArgv(null, [], true), null);
});

// ── Creation plan (D14) ────────────────────────────────────────────────────

test("creation plan: companions first, each from its own default base, then the primary from the chosen base", () => {
  const plan = creationPlan({
    primary: { path: "/code/shop", name: "shop" },
    companions: [{ path: "/code/api", name: "api" }, { path: "/code/web", name: "web" }],
    name: "fix",
    base: "origin/release",
    defaults: { "/code/shop": "origin/main", "/code/api": "origin/main", "/code/web": "origin/master" },
    root: "~/orca/workspaces",
    home: "/Users/ana",
  });
  assert.deepEqual(plan, [
    { repo: "/code/api", project: "api", name: "fix", path: "/Users/ana/orca/workspaces/api/fix", base: "origin/main", primary: false },
    { repo: "/code/web", project: "web", name: "fix", path: "/Users/ana/orca/workspaces/web/fix", base: "origin/master", primary: false },
    { repo: "/code/shop", project: "shop", name: "fix", path: "/Users/ana/orca/workspaces/shop/fix", base: "origin/release", primary: true },
  ]);
  const plain = creationPlan({ primary: { path: "/code/shop", name: "shop" }, companions: [], name: "fix", base: null, defaults: { "/code/shop": "main" }, root: "/w", home: "/h" });
  assert.deepEqual(plain.map((s) => [s.repo, s.base, s.primary]), [["/code/shop", "main", true]], "no base chosen: the primary's default");
});

test("path clashes: chosen projects with one folder name would share a worktree path; different names don't", () => {
  const a = { path: "/a/web", name: "web" };
  const b = { path: "/b/web", name: "web" };
  const api = { path: "/code/api", name: "api" };
  assert.deepEqual(pathClashes([a, api, b]), [[a, b]]);
  assert.equal(
    clashError([a, api, b]),
    "/a/web and /b/web share the folder name web, so their workspaces would land on the same path: pick only one of them.",
  );
  assert.match(clashError([a, b], (path) => path.replace("/a", "~")), /^~\/web and \/b\/web /, "paths written the caller's way");
  assert.deepEqual(pathClashes([{ path: "/x/web" }, { path: "/y/web/" }]).length, 1, "the folder name comes from the path when there is no name");
  assert.equal(pathClashes([{ path: "/a/Web", name: "Web" }, b]).length, 1, "case ignored, as macOS folders do");
  assert.deepEqual(pathClashes([api, { path: "/code/shop", name: "shop" }, { path: "/code/web", name: "web" }]), [], "different names: no clash");
  assert.equal(clashError([api, { path: "/code/shop", name: "shop" }]), "");
  assert.deepEqual(pathClashes([]), []);
});

// ── Real git (throwaway repos, no global config or hooks) ──────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), "projects-sidebar-nw-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd, args, extra = {}) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra }, stdio: "pipe" }).toString().trim();
// The same shape as M/git.js's git(cwd, args).
const realGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || stdout).trim() });
  });
});
const io = { ...gitOps(realGit), exists: async (p) => existsSync(p) };
const at = (n) => ({ GIT_AUTHOR_DATE: `2026-01-0${n}T00:00:00Z`, GIT_COMMITTER_DATE: `2026-01-0${n}T00:00:00Z` });

// A project cloned from a bare origin of its own: origin/HEAD points at
// `head`; every name in `branches` is a remote branch, committed in order
// (the last one the most recent).
function makeProject(name, { head = "main", branches = [] } = {}) {
  const seed = join(root, "seeds", name);
  mkdirSync(seed, { recursive: true });
  sh(seed, ["init", "-q", "-b", head]);
  sh(seed, ["commit", "-q", "--allow-empty", "-m", "first"], at(1));
  branches.forEach((b, i) => {
    sh(seed, ["checkout", "-q", "-b", b, head]);
    sh(seed, ["commit", "-q", "--allow-empty", "-m", b], at(i + 2));
  });
  sh(seed, ["checkout", "-q", head]);
  const origin = join(root, "origins", `${name}.git`);
  sh(root, ["clone", "-q", "--bare", seed, origin]);
  const path = join(root, "code", name);
  sh(root, ["clone", "-q", origin, path]);
  return { path, name, seed, origin };
}

const head = (dir, ref = "HEAD") => sh(dir, ["rev-parse", ref]);
const upstream = (dir, branch) => {
  try { return sh(dir, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]); } catch { return null; }
};

test("git: default base and recent bases from a real clone; null and none outside git", async () => {
  const p = makeProject("bases", { branches: ["feat-a", "feat-b"] });
  assert.equal(await io.defaultBase(p.path), "origin/main");
  assert.deepEqual(await io.recentBases(p.path), ["origin/feat-b", "origin/feat-a", "origin/main"]);
  sh(p.path, ["remote", "set-head", "origin", "feat-a"]);
  assert.equal(await io.defaultBase(p.path), "origin/feat-a", "origin/HEAD's target wins");
  const local = join(root, "local-only");
  mkdirSync(local);
  sh(local, ["init", "-q", "-b", "master"]);
  sh(local, ["commit", "-q", "--allow-empty", "-m", "x"]);
  assert.equal(await io.defaultBase(local), "master");
  const plain = join(root, "plain-folder");
  mkdirSync(plain);
  assert.equal(await io.defaultBase(plain), null, "not a git repository");
  assert.deepEqual(await io.recentBases(plain), []);
});

test("git: fetch from origin brings new commits; a broken origin fails without throwing", async () => {
  const p = makeProject("fetchy");
  sh(p.seed, ["commit", "-q", "--allow-empty", "-m", "second"], at(5));
  sh(p.seed, ["push", "-q", p.origin, "main"]);
  assert.notEqual(head(p.path, "origin/main"), head(p.seed));
  assert.equal((await io.fetch(p.path)).ok, true);
  assert.equal(head(p.path, "origin/main"), head(p.seed));
  sh(p.path, ["remote", "set-url", "origin", join(root, "no-such-origin.git")]);
  const r = await io.fetch(p.path);
  assert.equal(r.ok, false);
  assert.ok(r.err.length > 0);
});

test("git: a name is taken by a branch in any repo or by an existing folder in the workspaces root", async () => {
  const a = makeProject("taken-a");
  const b = makeProject("taken-b");
  const ws = join(root, "ws-taken");
  sh(b.path, ["branch", "fix"]);
  const taken = nameTaken(io, ws, "/nowhere");
  assert.equal(await taken(a, "fix"), false);
  assert.equal(await taken(b, "fix"), true, "a branch");
  mkdirSync(join(ws, "taken-a", "fix-2"), { recursive: true });
  assert.equal(await taken(a, "fix-2"), true, "a folder");
  assert.equal(await freeName("fix", [a, b], taken), "fix-3", "fix is taken in b, fix-2 in a: fix-3 for both");
});

// The branches of a repo as git has them, exact case, loose and packed.
const branchRefs = (dir) => sh(dir, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").filter(Boolean).sort();

test("create: a branch taken in another case, packed or loose, moves the name to -2; no twin is made (S35, L31)", async () => {
  for (const packed of [true, false]) {
    const p = makeProject(packed ? "case-packed" : "case-loose");
    const ws = join(root, packed ? "ws-case-packed" : "ws-case-loose");
    sh(p.path, ["branch", "ax-3735"]);
    const before = head(p.path, "refs/heads/ax-3735");
    if (packed) {
      sh(p.path, ["pack-refs", "--all", "--prune"]);
      assert.ok(!existsSync(join(p.path, ".git", "refs", "heads", "ax-3735")), "only in packed-refs: show-ref misses it in another case");
    }
    assert.equal(await io.branchExists(p.path, "AX-3735"), true, "ax-3735 is AX-3735 on a Mac's disk");
    const r = await createWorkspace({ primary: p, companions: [], text: "AX-3735", base: null, agent: claude, access: false, root: ws, home: "/nowhere" }, io);
    assert.equal(r.error, undefined);
    assert.equal(r.name, "AX-3735-2", packed ? "packed" : "loose");
    assert.deepEqual(branchRefs(p.path), ["refs/heads/AX-3735-2", "refs/heads/ax-3735", "refs/heads/main"], "no AX-3735 next to ax-3735");
    assert.equal(head(p.path, "refs/heads/ax-3735"), before, "the old branch is untouched");
    assert.equal(r.launch.folder, join(ws, "case-" + (packed ? "packed" : "loose"), "AX-3735-2"));
  }
});

test("create: companions then the primary, each from its base, and one space for the primary with the companions added", async () => {
  const shop = makeProject("shop", { branches: ["release"] });
  const api = makeProject("api");
  const web = makeProject("web", { head: "master" });
  const ws = join(root, "ws-create");
  sh(web.path, ["branch", "Fix-Login"]); // taken in one companion: -2 for all
  const r = await createWorkspace({
    primary: shop, companions: [api, web], text: "Fix Login", base: "origin/release",
    agent: claude, access: true, root: ws, home: "/nowhere", settings: SETTINGS,
  }, io);
  assert.equal(r.error, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.name, "Fix-Login-2");
  const paths = { api: join(ws, "api", "Fix-Login-2"), web: join(ws, "web", "Fix-Login-2"), shop: join(ws, "shop", "Fix-Login-2") };
  assert.deepEqual(r.created.map((s) => [s.project, s.path, s.base]), [
    ["api", paths.api, "origin/main"],
    ["web", paths.web, "origin/master"],
    ["shop", paths.shop, "origin/release"],
  ]);
  assert.equal(head(paths.api), head(api.path, "origin/main"));
  assert.equal(head(paths.web), head(web.path, "origin/master"));
  assert.equal(head(paths.shop), head(shop.path, "origin/release"));
  for (const [dir, repo] of [[paths.api, api], [paths.web, web], [paths.shop, shop]]) {
    assert.equal(sh(dir, ["branch", "--show-current"]), "Fix-Login-2");
    assert.equal(upstream(repo.path, "Fix-Login-2"), null, "--no-track: no upstream");
  }
  assert.deepEqual(r.launch, {
    folder: paths.shop,
    name: "Fix-Login-2",
    argv: ["claude", "--add-dir", paths.api, "--add-dir", paths.web, "--settings", SETTINGS],
  });
  assert.deepEqual(r.warnings, []);
});

test("create: a URL becomes the agent's first message; a blank terminal gets no argv and no task", async () => {
  const p = makeProject("smart");
  const ws = join(root, "ws-smart");
  const url = "https://github.com/acme/smart/pull/34";
  const withAgent = await createWorkspace({ primary: p, companions: [], text: url, base: null, agent: claude, access: true, root: ws, home: "/nowhere" }, io);
  assert.deepEqual(withAgent.launch, { folder: join(ws, "smart", "pr-34"), name: "pr-34", argv: ["claude"], task: `Complete ${url}` });
  const blank = agentChoices([]).at(-1);
  const plain = await createWorkspace({ primary: p, companions: [], text: url, base: null, agent: blank, access: true, root: ws, home: "/nowhere" }, io);
  assert.deepEqual(plain.launch, { folder: join(ws, "smart", "pr-34-2"), name: "pr-34-2" });
});

test("create: a failure stops, names the repo that failed and lists what was already created", async () => {
  const shop = makeProject("broken-shop");
  const api = makeProject("broken-api");
  const ws = join(root, "ws-broken");
  const r = await createWorkspace({
    primary: shop, companions: [api], text: "oops", base: "origin/no-such-branch",
    agent: claude, access: true, root: ws, home: "/nowhere",
  }, io);
  assert.equal(r.ok, false);
  assert.match(r.error, /broken-shop/);
  assert.deepEqual(r.created.map((s) => s.project), ["broken-api"], "the companion stays (no rollback)");
  assert.ok(existsSync(join(ws, "broken-api", "oops")));
  assert.ok(!existsSync(join(ws, "broken-shop", "oops")));
  assert.equal(r.launch, undefined, "no space");
  const empty = await createWorkspace({ primary: shop, companions: [], text: "  ", base: null, agent: claude, access: true, root: ws, home: "/nowhere" }, io);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /name/i);
  const plain = join(root, "not-a-repo");
  mkdirSync(plain);
  const notRepo = await createWorkspace({ primary: { path: plain, name: "not-a-repo" }, companions: [], text: "x", base: null, agent: claude, access: true, root: ws, home: "/nowhere" }, io);
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.error, /not-a-repo is not a git repository/);
});

test("create: two chosen projects with one folder name are refused before any git runs; nothing is left behind", async () => {
  const seed = makeProject("clash-seed");
  const a = { path: join(root, "clash-a", "web"), name: "web" };
  const b = { path: join(root, "clash-b", "web"), name: "web" };
  for (const p of [a, b]) sh(root, ["clone", "-q", seed.origin, p.path]);
  const ws = join(root, "ws-clash");
  const calls = [];
  const watched = Object.fromEntries(Object.entries(io).map(([k, f]) => [k, (...args) => {
    calls.push(k);
    return f(...args);
  }]));
  const r = await createWorkspace({
    primary: a, companions: [b], text: "fix", base: null,
    agent: claude, access: true, root: ws, home: "/nowhere",
  }, watched);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(`${b.path} and ${a.path}`), `the error names both projects: ${r.error}`);
  assert.deepEqual(calls, [], "no git command and no file check ran");
  assert.deepEqual(r.created, []);
  assert.equal(r.launch, undefined, "no space");
  assert.ok(!existsSync(join(ws, "web", "fix")), "no companion worktree left behind");
  for (const p of [a, b]) assert.equal(sh(p.path, ["branch", "--list", "fix"]), "", `no fix branch in ${p.path}`);
});

test("create: a failed fetch warns and goes on with the local refs", async () => {
  const p = makeProject("offline");
  sh(p.path, ["remote", "set-url", "origin", join(root, "gone.git")]);
  const ws = join(root, "ws-offline");
  const r = await createWorkspace({ primary: p, companions: [], text: "work", base: null, agent: claude, access: true, root: ws, home: "/nowhere" }, io);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /offline/);
  assert.equal(head(join(ws, "offline", "work")), head(p.path, "origin/main"));
});

test("create: from the project's saved base, companions too; a gone one falls back to origin/HEAD with a warning; the lookup is exact (D37, S33)", async () => {
  const shop = makeProject("saved-shop", { branches: ["release"] });
  const api = makeProject("saved-api", { branches: ["develop"] });
  const ws = join(root, "ws-saved");
  const primary = { path: shop.path, name: shop.name, base: "origin/release" };
  const companion = { path: api.path, name: api.name, base: "origin/develop" };
  const req = { primary, companions: [companion], base: null, agent: claude, access: true, root: ws, home: "/nowhere" };

  const r = await createWorkspace({ ...req, text: "saved" }, io);
  assert.equal(r.error, undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.created.map((s) => [s.project, s.base]), [["saved-api", "origin/develop"], ["saved-shop", "origin/release"]]);
  assert.equal(head(join(ws, "saved-shop", "saved")), head(shop.path, "origin/release"), "the primary starts at its saved base");
  assert.equal(head(join(ws, "saved-api", "saved")), head(api.path, "origin/develop"), "the companion starts at its own saved base");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.originDefault, "origin/main", "origin's default comes back, for rememberBase");

  // Gone on origin and pruned here: the next create starts at origin/HEAD's target.
  sh(shop.origin, ["branch", "-q", "-D", "release"]);
  sh(shop.path, ["branch", "-q", "-d", "-r", "origin/release"]);
  // origin/release/1 is not origin/release: for-each-ref also matches up to a slash.
  const prefix = makeProject("saved-prefix", { branches: ["release/1"] });
  const gone = await createWorkspace({ ...req, companions: [{ path: prefix.path, name: prefix.name, base: "origin/release" }], text: "after" }, io);
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.created.map((s) => [s.project, s.base]), [["saved-prefix", "origin/main"], ["saved-shop", "origin/main"]]);
  assert.equal(head(join(ws, "saved-shop", "after")), head(shop.path, "origin/main"));
  assert.deepEqual(gone.warnings, [
    "saved-prefix: origin/release is gone: created from origin/main",
    "origin/release is gone: created from origin/main",
  ]);
  assert.equal(gone.originDefault, "origin/main");

  // A base picked in the dialog wins, and says nothing of the saved one.
  const picked = await createWorkspace({ ...req, companions: [], base: "origin/main", text: "picked" }, io);
  assert.deepEqual(picked.created.map((s) => s.base), ["origin/main"]);
  assert.deepEqual(picked.warnings, []);

  // The plan takes the resolved defaults: saved bases for the companions, and for the primary when nothing was picked.
  const plan = creationPlan({
    primary, companions: [companion], name: "fix", base: null,
    defaults: { [shop.path]: "origin/release", [api.path]: "origin/develop" }, root: "/w", home: "/h",
  });
  assert.deepEqual(plan.map((s) => [s.project, s.base, s.primary]), [["saved-api", "origin/develop", false], ["saved-shop", "origin/release", true]]);
});

// ── What other files import (pins) ─────────────────────────────────────────

test("pins: git.js keeps its T2 exports; new-workspace.js keeps what main.js and the tree import", () => {
  const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");
  const git = src("git.js");
  for (const name of ["git", "repoOf", "listWorktrees", "fetch", "defaultBase", "recentBases", "branchExists", "addWorktree"]) {
    assert.match(git, new RegExp(`export (async function|const|function) ${name}\\b`), `git.js exports ${name}`);
  }
  const nw = src("new-workspace.js");
  assert.match(nw, /export default class NewWorkspace\b/);
  assert.match(nw, /export function openNewWorkspace\(projectPath\)/);
  assert.match(nw, /export const commands = \{[\s\S]*"new-workspace":/);
  assert.match(nw, /kind: "dialog", modal: true/);
});
