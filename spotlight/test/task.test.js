// T4: the task a terminal tests (M/task.js, D12): from the terminal's folder,
// the repo root, the task key by projects-sidebar's rule (copied, not
// imported: S7), the task's members in the requesting repo's group filtered
// by `enabled` (D7), the one workspace each member repo puts on its root,
// and the queue lane. git, shared.json's values, terminal facts and the
// `enabled` lookup are passed in, so nothing here reads the real ~/.config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findTicket, taskKeyOf, taskOf, laneOf, resolveTask, SPACELESS } from "../mods/spotlight/task.js";

// ── A fake world: repos, their worktrees, a git that answers from them ─────

const W = "/Users/demo/orca/workspaces";
const main = (root, branch = "main") => ({ path: root, branch, main: true });
const wt = (repo, folder, branch) => ({ path: `${W}/${repo}/${folder}`, branch, main: false });

const BACKEND = "/code/backend-action-experience";
const FRONT = "/code/action-experience";
const ADMIN = "/code/admin-action";
const SHOP = "/code/shop";
const LOOSE = "/code/scratch";

const B_TASK = wt("backend-action", "ax-3447", "juan/AX-3447-auth");
const B_LOGIN = wt("backend-action", "login", "feat/login");
const F_TASK = wt("action-experience", "AX-3447", "ax-3447");
const F_STYLES = wt("action-experience", "AX-3447-styles", "feat/AX-3447-styles");
const A_OTHER = wt("admin-action", "ax-12", "AX-12");
const S_TASK = wt("shop", "ax-3447", "ax-3447");
const L_TASK = wt("scratch", "ax-3447", "AX-3447");

// What `git worktree list` says now, per repo root.
const REPOS = {
  [BACKEND]: [main(BACKEND, "develop"), B_TASK, B_LOGIN],
  [FRONT]: [main(FRONT), F_TASK],
  [ADMIN]: [main(ADMIN), A_OTHER],
  [SHOP]: [main(SHOP), S_TASK],
  [LOOSE]: [main(LOOSE), L_TASK],
};

// Two groups (two companies) and one repo registered nowhere (LOOSE).
const REGISTRY = {
  version: 1,
  groups: [
    { id: "g1", name: "Action Experience", projects: [{ path: BACKEND, name: "backend-action" }, { path: FRONT, name: "action-experience" }, { path: ADMIN, name: "admin-action" }] },
    { id: "g2", name: "AG", projects: [{ path: SHOP, name: "shop" }] },
  ],
  activeGroup: "g1",
};

const cacheOf = (repos) => Object.fromEntries(Object.entries(repos).filter(([root]) => root !== LOOSE));
const SHARED = { "projects.v1": REGISTRY, "projects.cache.v1": cacheOf(REPOS) };

const ok = (out) => ({ ok: true, out, err: "" });
const fail = { ok: false, out: "", err: "fatal: not a git repository" };
const porcelain = (list) => list.map((c) => `worktree ${c.path}\nHEAD ${"a".repeat(40)}\n${c.branch ? `branch refs/heads/${c.branch}` : "detached"}`).join("\n\n");

// git over `repos`: the checkout holding a folder (the deepest), its repo's
// common dir and worktree list, and commit times from `times` (by path).
function fakeGit(repos, times = {}) {
  const checkouts = Object.entries(repos).flatMap(([root, list]) => list.map((c) => ({ root, ...c })));
  const at = (cwd) => checkouts
    .filter((c) => cwd === c.path || cwd.startsWith(`${c.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return async (cwd, args) => {
    const c = at(cwd);
    const argv = args.join(" ");
    if (!c) return fail;
    if (argv === "rev-parse --show-toplevel") return ok(c.path);
    if (argv === "rev-parse --path-format=absolute --git-common-dir") return ok(`${c.root}/.git`);
    if (argv.endsWith("worktree list --porcelain")) return ok(porcelain(repos[c.root]));
    if (argv === "log -1 --format=%ct") return c.path in times ? ok(String(times[c.path])) : fail;
    return fail;
  };
}

// resolveTask over the fake world. `disabled`: repo roots `enabled` says no
// to. `shared` given as undefined stays undefined (no shared.json value).
function resolve(cwd, opts = {}) {
  const { repos = REPOS, times = {}, disabled = [], terminals = [], asked } = opts;
  const shared = Object.hasOwn(opts, "shared") ? opts.shared : SHARED;
  const enabled = (root) => {
    asked?.push(root);
    return !disabled.includes(root);
  };
  return resolveTask({ cwd, shared, git: fakeGit(repos, times), enabled, terminals });
}

const member = (root, name, workspace, workspaces = [workspace]) => ({ root, name, workspace, workspaces });
// Members as "<repo name> <lit worktree's folder>".
const brief = (r) => r.members.map((m) => `${m.name} ${m.workspace.split("/").pop()}`);

// ── Task keys: projects-sidebar's rule, copied (S7) ────────────────────────

const key = (branch, folder = "scratch") => taskKeyOf({ path: `${W}/app/${folder}`, branch, main: false });
const ticket = (k) => ({ kind: "ticket", key: k });
const named = (k) => ({ kind: "name", key: k });

test("key rule, as projects-sidebar's: a ticket from the branch, the last `/` segment first", () => {
  for (const branch of ["Ax 3356", "ax_3356", "ax3356", "AX-3356", "feat/ax-3356-foo", "team-1/ax-3356", "refs/heads/feat/ax-3356"]) {
    assert.deepEqual(key(branch), ticket("AX-3356"), branch);
  }
  assert.deepEqual(key("ax-1-and-ax-2"), ticket("AX-1"));
  assert.equal(findTicket("team-1"), "TEAM-1");
  for (const branch of ["vue3", "md5", "release-2024", "a-123"]) assert.deepEqual(key(branch), named(branch), branch);
  assert.equal(findTicket("releaseax-3356"), null);
  assert.equal(findTicket("ax-3356b"), null);
});

test("key rule: the folder's ticket when the branch has none; unusable names fall back to the folder, then to no task", () => {
  assert.deepEqual(key("fix-login", "ax_77-login"), ticket("AX-77"));
  assert.deepEqual(key("feat/ax-5", "bc-9"), ticket("AX-5"), "the branch's ticket wins");
  assert.deepEqual(taskKeyOf({ path: `${W}/app/spike`, branch: null, main: false }), named("spike"), "detached");
  for (const branch of ["none", "feat/NONE", "__proto__", "constructor", "x".repeat(201), "feat/"]) {
    assert.deepEqual(key(branch, "spike"), named("spike"), branch.slice(0, 12));
  }
  assert.deepEqual(key("  login  "), named("login"));
  assert.equal(key("none", "none"), null);
  assert.equal(taskKeyOf(main("/code/AX-12", "AX-12")), null, "a main checkout never has a task");
});

test("taskOf keys a task as projects-sidebar's lane does: tickets as they are, names lowercased", () => {
  assert.deepEqual(taskOf(B_TASK), { key: "AX-3447", label: "AX-3447" });
  assert.deepEqual(taskOf(wt("app", "x", "feat/Login")), { key: "login", label: "Login" });
  assert.equal(taskOf(main(BACKEND)), null);
});

test("task.js imports nothing: no projects-sidebar code (S7), no node: or herdr module, so the mod and the CLI share it", () => {
  const src = readFileSync(new URL("../mods/spotlight/task.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bimport\(|\brequire\(/);
});

// ── The task, its members and its lane (D12) ───────────────────────────────

test("AX-3447 across two enabled repos of one group is one task, one member per repo in the group's order", async () => {
  const r = await resolve(`${B_TASK.path}/src/api`);
  assert.deepEqual(r, {
    ok: true,
    root: BACKEND,
    workspace: B_TASK.path,
    branch: "juan/AX-3447-auth",
    taskKey: "AX-3447",
    label: "AX-3447",
    lane: "g1",
    members: [member(BACKEND, "backend-action", B_TASK.path), member(FRONT, "action-experience", F_TASK.path)],
    skipped: [],
    slotOnly: false,
  });
});

test("a same-named worktree in another group is left out; from there, that group is the lane", async () => {
  const fromBackend = await resolve(B_TASK.path);
  assert.ok(!fromBackend.members.some((m) => m.root === SHOP), "shop is AG's, not Action Experience's");
  const fromShop = await resolve(S_TASK.path);
  assert.equal(fromShop.lane, "g2");
  assert.deepEqual(fromShop.members, [member(SHOP, "shop", S_TASK.path)]);
});

test("a disabled repo is listed as not included; `enabled` is asked only about the task's repos", async () => {
  const asked = [];
  const r = await resolve(B_TASK.path, { disabled: [FRONT], asked });
  assert.deepEqual(r.members, [member(BACKEND, "backend-action", B_TASK.path)]);
  assert.deepEqual(r.skipped, ["action-experience"]);
  assert.equal(r.slotOnly, false);
  assert.deepEqual(asked, [BACKEND, FRONT], "admin-action and shop have no AX-3447 worktree here");
});

test("a task whose only repo is disabled is slot-only: no member, its repo not included", async () => {
  const r = await resolve(B_LOGIN.path, { disabled: [BACKEND] });
  assert.equal(r.ok, true);
  assert.equal(r.taskKey, "login");
  assert.deepEqual(r.members, []);
  assert.deepEqual(r.skipped, ["backend-action"]);
  assert.equal(r.slotOnly, true);
});

const TWO_FRONT = { ...REPOS, [FRONT]: [main(FRONT), F_TASK, F_STYLES] };
const TWO_SHARED = { "projects.v1": REGISTRY, "projects.cache.v1": cacheOf(TWO_FRONT) };

test("two task worktrees in the caller's repo: the caller's own wins, even against a busier, newer one", async () => {
  const r = await resolve(`${F_TASK.path}/web`, {
    shared: TWO_SHARED,
    repos: TWO_FRONT,
    terminals: [{ cwd: F_STYLES.path, status_ms: 9000 }],
    times: { [F_TASK.path]: 100, [F_STYLES.path]: 900 },
  });
  assert.deepEqual(r.members.find((m) => m.root === FRONT), member(FRONT, "action-experience", F_TASK.path, [F_TASK.path, F_STYLES.path]));
});

test("two in another repo: the one whose agent terminal changed status last wins, over a newer commit", async () => {
  const r = await resolve(B_TASK.path, {
    shared: TWO_SHARED,
    repos: TWO_FRONT,
    terminals: [
      { cwd: `${F_TASK.path}`, status_ms: 1000 },
      { cwd: `${F_STYLES.path}/packages/ui`, status_ms: 2000 },
      { cwd: F_TASK.path, status_ms: null }, // a shell: no agent status, never counts
    ],
    times: { [F_TASK.path]: 900, [F_STYLES.path]: 100 },
  });
  assert.deepEqual(r.members.find((m) => m.root === FRONT), member(FRONT, "action-experience", F_STYLES.path, [F_TASK.path, F_STYLES.path]));
});

test("two in another repo: with no agent status to tell them apart, the newest commit wins", async () => {
  const opts = { shared: TWO_SHARED, repos: TWO_FRONT, times: { [F_TASK.path]: 100, [F_STYLES.path]: 900 } };
  for (const terminals of [[], [{ cwd: F_TASK.path, status_ms: null }], [{ cwd: F_TASK.path, status_ms: 5 }, { cwd: F_STYLES.path, status_ms: 5 }]]) {
    assert.deepEqual(brief(await resolve(B_TASK.path, { ...opts, terminals })), ["backend-action ax-3447", "action-experience AX-3447-styles"], JSON.stringify(terminals));
  }
  const unborn = await resolve(B_TASK.path, { ...opts, times: { [F_STYLES.path]: 1 } });
  assert.deepEqual(brief(unborn), ["backend-action ax-3447", "action-experience AX-3447-styles"], "a worktree git can't date loses to one it can");
});

test("two in another repo: with neither status nor commit to tell them apart, projects.cache.v1's order wins", async () => {
  const same = { [F_TASK.path]: 500, [F_STYLES.path]: 500 };
  const first = await resolve(B_TASK.path, { shared: TWO_SHARED, repos: TWO_FRONT, times: same });
  assert.deepEqual(brief(first), ["backend-action ax-3447", "action-experience AX-3447"]);
  const flipped = { "projects.v1": REGISTRY, "projects.cache.v1": { ...cacheOf(TWO_FRONT), [FRONT]: [main(FRONT), F_STYLES, F_TASK] } };
  const second = await resolve(B_TASK.path, { shared: flipped, repos: TWO_FRONT, times: same });
  assert.deepEqual(brief(second), ["backend-action ax-3447", "action-experience AX-3447-styles"], "the cache's order, not git's");
});

test("a main checkout has no task, nor does a worktree whose branch and folder can't name one", async () => {
  const expected = { ok: false, code: "no-task", message: "This workspace is not part of a task (main checkouts never are)." };
  assert.deepEqual(await resolve(`${BACKEND}/src`), expected);
  const none = wt("backend-action", "none", "none");
  assert.deepEqual(await resolve(none.path, { repos: { ...REPOS, [BACKEND]: [...REPOS[BACKEND], none] } }), expected);
});

test("a folder outside git is not a repo", async () => {
  for (const cwd of ["/somewhere/else", "", null, undefined]) {
    const r = await resolve(cwd);
    assert.equal(r.ok, false, String(cwd));
    assert.equal(r.code, "not-a-repo", String(cwd));
  }
});

test("a repo outside every group is in lane spaceless, its members from its own git worktrees", async () => {
  const r = await resolve(`${L_TASK.path}/lib`);
  assert.equal(r.lane, SPACELESS);
  assert.equal(SPACELESS, "spaceless");
  assert.equal(r.root, LOOSE);
  assert.deepEqual(r.members, [member(LOOSE, "scratch", L_TASK.path)]);
});

test("missing or malformed shared values read as no group: lane spaceless, members from the caller's git worktrees", async () => {
  const lone = [member(BACKEND, "backend-action-experience", B_TASK.path)];
  for (const shared of [undefined, null, {}, "garbage", { "projects.v1": "x", "projects.cache.v1": [1, 2] }, { "projects.v1": { ...REGISTRY, version: 2 } }, { "projects.v1": { version: 1, groups: [{ id: 7 }] } }]) {
    const r = await resolve(B_TASK.path, { shared });
    assert.equal(r.lane, SPACELESS, JSON.stringify(shared));
    assert.deepEqual(r.members, lone, JSON.stringify(shared));
  }
});

test("a project with no usable cache entry is listed with git; the caller's repo is always listed live", async () => {
  const shared = { "projects.v1": REGISTRY, "projects.cache.v1": { [FRONT]: [{ path: 3 }] } };
  const r = await resolve(B_TASK.path, { shared });
  assert.deepEqual(brief(r), ["backend-action ax-3447", "action-experience AX-3447"]);
  const fresh = wt("backend-action", "ax-3447-b", "AX-3447-b");
  const live = await resolve(fresh.path, { repos: { ...REPOS, [BACKEND]: [...REPOS[BACKEND], fresh] } });
  assert.equal(live.members[0].workspace, fresh.path, "a worktree the cache hasn't seen yet is still the caller's");
});

test("a repo registered twice counts in its first group, as projects-sidebar reads it", () => {
  const twice = { ...REGISTRY, groups: [REGISTRY.groups[1], { ...REGISTRY.groups[0], projects: [...REGISTRY.groups[0].projects, { path: SHOP, name: "shop" }] }] };
  assert.equal(laneOf(twice, SHOP), "g2");
  assert.equal(laneOf(twice, `${BACKEND}/`), "g1");
  assert.equal(laneOf(twice, LOOSE), SPACELESS);
});

test("names merge case-insensitively: Login and login are one task keyed login, labelled with the smallest casing", async () => {
  const front = wt("action-experience", "Login", "Login");
  const repos = { ...REPOS, [FRONT]: [main(FRONT), front] };
  const r = await resolve(B_LOGIN.path, { repos, shared: { "projects.v1": REGISTRY, "projects.cache.v1": cacheOf(repos) } });
  assert.deepEqual([r.taskKey, r.label], ["login", "Login"]);
  assert.deepEqual(brief(r), ["backend-action login", "action-experience Login"]);
});

// ── Against a real git ─────────────────────────────────────────────────────

const run = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function realGit(cwd, args) {
  try {
    const { stdout } = await run("git", args, { cwd, env: ENV });
    return { ok: true, out: stdout.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? "").trim() };
  }
}

function gitAt(cwd, date, ...args) {
  const env = { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, stdio: "ignore" });
}

test("against a real git: the root, the caller's worktree and branch from a subfolder; the other repo's newest commit wins", async (t) => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), "spotlight-task-")));
  t.after(() => rmSync(T, { recursive: true, force: true }));
  for (const repo of ["app", "api"]) {
    mkdirSync(join(T, "repos", repo), { recursive: true });
    gitAt(join(T, "repos", repo), "2000-01-01T00:00:00Z", "init", "-q", "-b", "main");
    gitAt(join(T, "repos", repo), "2000-01-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "init");
  }
  const app = join(T, "repos", "app");
  const api = join(T, "repos", "api");
  const caller = join(T, "ws", "app", "ax-1");
  const first = join(T, "ws", "api", "ax-1-first");
  const second = join(T, "ws", "api", "ax-1-second");
  gitAt(app, "2000-01-01T00:00:00Z", "worktree", "add", "-q", "-b", "AX-1", caller);
  gitAt(api, "2000-01-01T00:00:00Z", "worktree", "add", "-q", "-b", "AX-1-first", first);
  gitAt(api, "2000-01-01T00:00:00Z", "worktree", "add", "-q", "-b", "feat/ax-1-second", second);
  gitAt(first, "2001-01-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "older");
  gitAt(second, "2020-01-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "newer");
  mkdirSync(join(caller, "src"));

  const registry = { version: 1, groups: [{ id: "g1", name: "Work", projects: [{ path: app, name: "app" }, { path: api, name: "api" }] }], activeGroup: "g1" };
  const r = await resolveTask({ cwd: join(caller, "src"), shared: { "projects.v1": registry }, git: realGit, enabled: async () => true, terminals: [] });
  assert.deepEqual(r, {
    ok: true,
    root: app,
    workspace: caller,
    branch: "AX-1",
    taskKey: "AX-1",
    label: "AX-1",
    lane: "g1",
    members: [member(app, "app", caller), member(api, "api", second, [first, second])],
    skipped: [],
    slotOnly: false,
  });
  assert.deepEqual(await resolveTask({ cwd: join(app, "."), shared: {}, git: realGit, enabled: () => true }), {
    ok: false, code: "no-task", message: "This workspace is not part of a task (main checkouts never are).",
  });
});
