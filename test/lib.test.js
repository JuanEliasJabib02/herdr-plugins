// T2: the model behind the sidebar (M/lib.js): the registry of groups and
// projects, the persisted keys and their validation, repo resolution, the
// worktree list, space <-> workspace matching and the groups' attention dot.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEYS, COMMON_DIR, WORKTREE_LIST,
  normPath, placeOf, changed,
  emptyRegistry, parseRegistry, needsBackup, registryWrites, activeGroup, findProject,
  addProject, removeProject, moveProject, addGroup, renameGroup, deleteGroup, selectGroup,
  parseUi, withCollapsed, parseCache, parseAgents,
  resolveProject, parseWorktrees, listCheckouts,
  matchSpaces, attentionByGroup,
} from "../projects-sidebar/mods/projects/lib.js";

// A registry with two groups, built only through the public operations.
function twoGroups() {
  let r = emptyRegistry();
  r = addProject(r, { path: "/code/app" });
  r = addProject(r, { path: "/code/api", name: "API" });
  r = addGroup(r, "Clients");
  return r;
}

const groupNames = (r) => r.groups.map((g) => g.name);
const pathsOf = (r, i) => r.groups[i].projects.map((p) => p.path);

// ── Persisted keys ─────────────────────────────────────────────────────────

test("persisted keys: the four versioned names of D3, plus the registry's backup", () => {
  assert.deepEqual(KEYS, {
    registry: "projects.v1",
    registryBackup: "projects.v1.backup",
    ui: "projects.ui.v1",
    cache: "projects.cache.v1",
    agents: "projects.agents.v1",
  });
});

test("changed: only a different value is a change (writes only on change)", () => {
  assert.equal(changed({ a: [1, 2] }, { a: [1, 2] }), false);
  assert.equal(changed(undefined, null), false);
  assert.equal(changed({ a: [1, 2] }, { a: [2, 1] }), true);
  assert.equal(changed(undefined, { collapsed: [] }), true);
});

// ── Registry: validation ───────────────────────────────────────────────────

test("empty registry: one group named Projects, active", () => {
  const r = emptyRegistry();
  assert.equal(r.version, 1);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].name, "Projects");
  assert.deepEqual(r.groups[0].projects, []);
  assert.equal(r.activeGroup, r.groups[0].id);
});

test("foreign values, unknown versions and registries with no valid group become the empty registry, never throwing", () => {
  const valid = twoGroups();
  const bad = [
    undefined, null, "", "projects", 42, true, [], [valid],
    {},
    { version: 2, groups: valid.groups, activeGroup: valid.activeGroup },
    { groups: valid.groups, activeGroup: valid.activeGroup },
    { version: 1, groups: [], activeGroup: "g1" },
    { version: 1, groups: "nope", activeGroup: "g1" },
    { version: 1, groups: [{ name: "No id", projects: [] }], activeGroup: "g1" },
    { version: 1, groups: [{ id: "g1", name: 7, projects: [] }], activeGroup: "g1" },
    { version: 1, groups: [{ id: "g1", name: "A", projects: {} }], activeGroup: "g1" },
    { version: 1, groups: [null, "g2", []], activeGroup: "g1" },
    { theme: "dark", sidebar: { width: 332 } },
  ];
  for (const value of bad) {
    assert.deepEqual(parseRegistry(value), emptyRegistry(), `for ${JSON.stringify(value)}`);
  }
});

test("salvage: one bad project among valid ones is dropped alone, the others are kept", () => {
  const stored = {
    version: 1,
    groups: [
      { id: "g1", name: "Projects", projects: [
        { path: "/code/app", name: "app" },
        { path: "relative/dir", name: "dir" },
        { path: "~/code/home", name: "home" },
        null,
        { path: "/code/nameless" },
        { path: "/code/api", name: "API" },
      ] },
      { id: "g2", name: "Clients", projects: [{ path: "/code/shop", name: "shop" }] },
    ],
    activeGroup: "g2",
  };
  assert.deepEqual(parseRegistry(stored), {
    version: 1,
    groups: [
      { id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }, { path: "/code/api", name: "API" }] },
      { id: "g2", name: "Clients", projects: [{ path: "/code/shop", name: "shop" }] },
    ],
    activeGroup: "g2",
  });
  const onlyBad = { version: 1, groups: [{ id: "g1", name: "A", projects: [{ path: "relative/dir", name: "dir" }] }], activeGroup: "g1" };
  assert.deepEqual(parseRegistry(onlyBad), { version: 1, groups: [{ id: "g1", name: "A", projects: [] }], activeGroup: "g1" }, "the group stays, empty");
});

test("salvage: a bad group is dropped with its projects, the other groups are kept; the active one falls back", () => {
  const stored = {
    version: 1,
    groups: [
      { id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }] },
      { id: "g2", name: 7, projects: [{ path: "/code/lost", name: "lost" }] },
      null,
      { id: "g3", name: "Side", projects: {} },
      { id: "g1", name: "Twin", projects: [{ path: "/code/twin", name: "twin" }] },
      { id: "g4", name: "Clients", projects: [{ path: "/code/shop", name: "shop" }, { path: "/code/app/", name: "again" }] },
    ],
    activeGroup: "g2",
  };
  assert.deepEqual(parseRegistry(stored), {
    version: 1,
    groups: [
      { id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }] },
      { id: "g4", name: "Clients", projects: [{ path: "/code/shop", name: "shop" }] },
    ],
    activeGroup: "g1",
  });
});

test("needsBackup: true only for a stored value that doesn't read back as itself", () => {
  const valid = JSON.parse(JSON.stringify(twoGroups()));
  assert.equal(needsBackup(valid, parseRegistry(valid)), false, "a valid registry");
  assert.equal(needsBackup(null, parseRegistry(null)), false, "nothing stored");
  assert.equal(needsBackup(undefined, parseRegistry(undefined)), false, "nothing stored");
  const lossy = { ...valid, groups: [...valid.groups, { id: "g9", name: 7, projects: [] }] };
  assert.equal(needsBackup(lossy, parseRegistry(lossy)), true, "a dropped group");
  const badProject = { ...valid, groups: [{ ...valid.groups[0], projects: [...valid.groups[0].projects, null] }, valid.groups[1]] };
  assert.equal(needsBackup(badProject, parseRegistry(badProject)), true, "a dropped project");
  for (const foreign of [{ version: 2, groups: valid.groups }, "projects", 42]) {
    assert.equal(needsBackup(foreign, parseRegistry(foreign)), true, `for ${JSON.stringify(foreign)}`);
  }
});

test("registryWrites: the backup goes first, only over an empty backup, and nothing is written when the value is the same", () => {
  const valid = JSON.parse(JSON.stringify(twoGroups()));
  const next = selectGroup(valid, valid.groups[1].id);
  const lossy = { ...valid, groups: [...valid.groups, { id: "g9", name: 7, projects: [] }] };
  const old = { version: 1, groups: [{ id: "g0", name: "Old", projects: [] }], activeGroup: "g0" };
  assert.deepEqual(registryWrites(valid, null, JSON.parse(JSON.stringify(valid))), [], "unchanged valid");
  assert.deepEqual(registryWrites(valid, null, next), [[KEYS.registry, next]], "changed valid");
  for (const empty of [null, undefined]) {
    assert.deepEqual(registryWrites(lossy, empty, next), [[KEYS.registryBackup, lossy], [KEYS.registry, next]], `lossy raw, backup ${empty}`);
  }
  assert.deepEqual(registryWrites(lossy, old, next), [[KEYS.registry, next]], "lossy raw, a backup already there");
  assert.deepEqual(registryWrites(null, null, next), [[KEYS.registry, next]], "nothing stored");
});

test("a valid stored registry is kept, unknown fields dropped, paths normalized", () => {
  const stored = {
    version: 1,
    extra: "dropped",
    groups: [
      { id: "g1", name: "Projects", color: "red", projects: [{ path: "/code/app/", name: "app", pinned: true }] },
      { id: "g7", name: "Clients", projects: [] },
    ],
    activeGroup: "g7",
  };
  assert.deepEqual(parseRegistry(stored), {
    version: 1,
    groups: [
      { id: "g1", name: "Projects", projects: [{ path: "/code/app", name: "app" }] },
      { id: "g7", name: "Clients", projects: [] },
    ],
    activeGroup: "g7",
  });
});

test("active group fallback: a missing or unknown active group is the first group", () => {
  const groups = [
    { id: "g1", name: "Projects", projects: [] },
    { id: "g2", name: "Clients", projects: [] },
  ];
  assert.equal(parseRegistry({ version: 1, groups, activeGroup: "gone" }).activeGroup, "g1");
  assert.equal(parseRegistry({ version: 1, groups }).activeGroup, "g1");
  assert.equal(activeGroup({ version: 1, groups, activeGroup: "gone" }).id, "g1");
  assert.equal(activeGroup({ version: 1, groups, activeGroup: "g2" }).id, "g2");
});

// ── Registry: projects ─────────────────────────────────────────────────────

test("add project: joins the active group, path normalized, named by its folder", () => {
  let r = emptyRegistry();
  r = addGroup(r, "Clients");
  r = selectGroup(r, r.groups[1].id);
  r = addProject(r, { path: "/code/shop/" });
  r = addProject(r, { path: "/code/api", name: "API" });
  assert.deepEqual(r.groups[0].projects, []);
  assert.deepEqual(r.groups[1].projects, [{ path: "/code/shop", name: "shop" }, { path: "/code/api", name: "API" }]);
  assert.deepEqual(addProject(r, { path: "relative" }), r, "a relative path is not a project");
});

test("add project: an already registered path isn't added twice, its group becomes active", () => {
  const r = twoGroups(); // app and api in Projects; Clients empty
  const onClients = selectGroup(r, r.groups[1].id);
  const again = addProject(onClients, { path: "/code/app/" });
  assert.equal(again.activeGroup, r.groups[0].id);
  assert.deepEqual(pathsOf(again, 0), ["/code/app", "/code/api"]);
  assert.deepEqual(pathsOf(again, 1), []);
  assert.deepEqual(findProject(again, "/code/app/"), { group: again.groups[0], project: { path: "/code/app", name: "app" } });
  assert.equal(findProject(again, "/code/none"), null);
});

test("remove project: leaves the list, nothing else changes", () => {
  const r = twoGroups();
  const removed = removeProject(r, "/code/app/");
  assert.deepEqual(pathsOf(removed, 0), ["/code/api"]);
  assert.deepEqual(groupNames(removed), groupNames(r));
  assert.equal(removed.activeGroup, r.activeGroup);
  assert.deepEqual(removeProject(r, "/code/none"), r);
  assert.deepEqual(pathsOf(r, 0), ["/code/app", "/code/api"], "the input is never mutated");
});

test("move project: goes to the end of the target group; unknown target or project changes nothing", () => {
  let r = twoGroups();
  r = addProject(selectGroup(r, r.groups[1].id), { path: "/code/site" });
  const moved = moveProject(r, "/code/app", r.groups[1].id);
  assert.deepEqual(pathsOf(moved, 0), ["/code/api"]);
  assert.deepEqual(pathsOf(moved, 1), ["/code/site", "/code/app"]);
  assert.equal(moved.activeGroup, r.activeGroup);
  assert.deepEqual(moveProject(r, "/code/app", "nope"), r);
  assert.deepEqual(moveProject(r, "/code/none", r.groups[1].id), r);
  assert.deepEqual(moveProject(r, "/code/app", r.groups[0].id), r, "already there");
});

// ── Registry: groups ───────────────────────────────────────────────────────

test("add group: a new id and the trimmed name, not selected; a blank name adds nothing", () => {
  const r = addGroup(emptyRegistry(), "  Clients  ");
  assert.deepEqual(groupNames(r), ["Projects", "Clients"]);
  assert.notEqual(r.groups[1].id, r.groups[0].id);
  assert.equal(r.activeGroup, r.groups[0].id);
  assert.deepEqual(r.groups[1].projects, []);
  assert.deepEqual(addGroup(r, "   "), r);
  const three = addGroup(r, "Side");
  assert.equal(new Set(three.groups.map((g) => g.id)).size, 3, "ids stay unique");
});

test("rename group: trimmed name; blank name or unknown id changes nothing", () => {
  const r = twoGroups();
  const renamed = renameGroup(r, r.groups[1].id, " AG ");
  assert.deepEqual(groupNames(renamed), ["Projects", "AG"]);
  assert.equal(renamed.groups[1].id, r.groups[1].id);
  assert.deepEqual(renameGroup(r, r.groups[1].id, "  "), r);
  assert.deepEqual(renameGroup(r, "nope", "X"), r);
});

test("delete group: only when empty and not the last one; the active one falls back to the first", () => {
  const r = twoGroups();
  assert.deepEqual(deleteGroup(r, r.groups[0].id), r, "has projects");
  const onClients = selectGroup(r, r.groups[1].id);
  const deleted = deleteGroup(onClients, r.groups[1].id);
  assert.deepEqual(groupNames(deleted), ["Projects"]);
  assert.equal(deleted.activeGroup, r.groups[0].id);
  const lone = emptyRegistry();
  assert.deepEqual(deleteGroup(lone, lone.groups[0].id), lone, "the last group stays");
  assert.deepEqual(deleteGroup(r, "nope"), r);
});

test("select group: an existing group becomes active; an unknown id changes nothing", () => {
  const r = twoGroups();
  assert.equal(selectGroup(r, r.groups[1].id).activeGroup, r.groups[1].id);
  assert.deepEqual(selectGroup(r, "nope"), r);
  assert.deepEqual(selectGroup(r, undefined), r);
});

test("creation order: groups and projects stay in the order they were made", () => {
  let r = emptyRegistry();
  for (const name of ["AG", "Arrecife", "Action"]) r = addGroup(r, name);
  r = renameGroup(r, r.groups[0].id, "Zeta");
  for (const p of ["/z", "/a", "/m"]) r = addProject(r, { path: p });
  assert.deepEqual(groupNames(r), ["Zeta", "AG", "Arrecife", "Action"]);
  assert.deepEqual(pathsOf(r, 0), ["/z", "/a", "/m"]);
  assert.deepEqual(groupNames(parseRegistry(JSON.parse(JSON.stringify(r)))), groupNames(r), "survives a store round trip");
});

// ── Other persisted keys ───────────────────────────────────────────────────

test("ui state: collapsed projects, invalid values reset, toggled without duplicates", () => {
  for (const bad of [undefined, null, 3, "x", [], { collapsed: "x" }]) assert.deepEqual(parseUi(bad), { collapsed: [] });
  assert.deepEqual(parseUi({ collapsed: ["/a/", "/a", 4, "rel", "/b"] }), { collapsed: ["/a", "/b"] });
  const ui = withCollapsed({ collapsed: ["/a"] }, "/b/", true);
  assert.deepEqual(ui, { collapsed: ["/a", "/b"] });
  assert.deepEqual(withCollapsed(ui, "/b", true), ui);
  assert.deepEqual(withCollapsed(ui, "/a", false), { collapsed: ["/b"] });
});

test("worktree cache: keeps valid lists per project, drops anything malformed", () => {
  for (const bad of [undefined, null, 3, "x", []]) assert.deepEqual(parseCache(bad), {});
  const good = [{ path: "/r", branch: "main", main: true }, { path: "/w/r/x", branch: null, main: false }];
  assert.deepEqual(parseCache({
    "/r/": good,
    "rel": good,
    "/s": "nope",
    "/t": [{ path: "/t", branch: 3, main: true }],
    "/u": [{ path: "/u", branch: "main", main: true, extra: 1 }],
  }), {
    "/r": good,
    "/u": [{ path: "/u", branch: "main", main: true }],
  });
});

test("agents cache: keeps knownAgents() entries with a key and a run argv", () => {
  for (const bad of [undefined, null, "x", {}]) assert.deepEqual(parseAgents(bad), []);
  const claude = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: null, shell: false, agent: true, run: ["claude"], installed: true };
  assert.deepEqual(parseAgents([claude, { key: "x" }, { key: "y", run: [1] }, null, { ...claude, key: "codex", run: ["codex"], extra: 1 }]), [
    claude,
    { ...claude, key: "codex", run: ["codex"] },
  ]);
});

// ── Repo resolution (D10) and the worktree list (D6) ───────────────────────

// Throwaway repos for the real-git tests, with no global config or hooks.
const root = realpathSync(mkdtempSync(join(tmpdir(), "projects-sidebar-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, stdio: "pipe" });
// The same shape as M/git.js's git(cwd, args).
const realGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, env }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || stdout).trim() });
  });
});

function makeRepo(name) {
  const main = join(root, name);
  mkdirSync(join(main, "src"), { recursive: true });
  sh(main, "init", "-q", "-b", "main");
  sh(main, "commit", "-q", "--allow-empty", "-m", "first");
  return main;
}

test("resolve: the main checkout (or a folder inside it) is its own project", async () => {
  const main = makeRepo("shop");
  assert.deepEqual(await resolveProject(main, realGit), { path: main, name: "shop" });
  assert.deepEqual(await resolveProject(`${main}/src/`, realGit), { path: main, name: "shop" });
});

test("resolve: a linked worktree resolves to its repo's main checkout", async () => {
  const main = makeRepo("store");
  const linked = join(root, "workspaces", "store", "feature-x");
  sh(main, "worktree", "add", "-q", "-b", "feature-x", linked);
  mkdirSync(join(linked, "deep"));
  assert.deepEqual(await resolveProject(linked, realGit), { path: main, name: "store" });
  assert.deepEqual(await resolveProject(join(linked, "deep"), realGit), { path: main, name: "store" });
});

test("resolve: a folder outside git is a project of its own", async () => {
  const plain = join(root, "notes");
  mkdirSync(plain);
  assert.deepEqual(await resolveProject(`${plain}/`, realGit), { path: plain, name: "notes" });
});

test("resolve: common-dir mapping, as git answers it", async () => {
  const fake = (out, ok = true) => async (_cwd, args) => {
    assert.deepEqual(args, COMMON_DIR);
    return { ok, out, err: ok ? "" : out };
  };
  assert.deepEqual(await resolveProject("/w/repo/feat", fake("/code/repo/.git")), { path: "/code/repo", name: "repo" });
  assert.deepEqual(await resolveProject("/srv/site.git", fake("/srv/site.git")), { path: "/srv/site.git", name: "site" }, "a bare repo");
  assert.deepEqual(await resolveProject("/tmp/x", fake("fatal: not a git repository", false)), { path: "/tmp/x", name: "x" });
});

test("porcelain: main first, then the linked worktrees with their branches", () => {
  const out = [
    "worktree /code/repo", "HEAD 1111", "branch refs/heads/main", "",
    "worktree /w/repo/feature-x", "HEAD 2222", "branch refs/heads/feature/x", "",
    "worktree /w/repo/locked", "HEAD 3333", "branch refs/heads/locked", "locked busy", "",
  ].join("\n");
  assert.deepEqual(parseWorktrees(out), [
    { path: "/code/repo", branch: "main", main: true },
    { path: "/w/repo/feature-x", branch: "feature/x", main: false },
    { path: "/w/repo/locked", branch: "locked", main: false },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
});

test("porcelain: a detached worktree has no branch", () => {
  const out = "worktree /code/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /w/repo/review\nHEAD 2\ndetached\n";
  assert.deepEqual(parseWorktrees(out)[1], { path: "/w/repo/review", branch: null, main: false });
});

test("porcelain: bare and prunable entries are skipped", () => {
  const out = [
    "worktree /srv/site.git", "bare", "",
    "worktree /w/site/a", "HEAD 1", "branch refs/heads/a", "",
    "worktree /w/site/gone", "HEAD 2", "branch refs/heads/gone", "prunable gitdir file points to non-existent location", "",
  ].join("\r\n");
  assert.deepEqual(parseWorktrees(out), [{ path: "/w/site/a", branch: "a", main: false }]);
});

test("worktree list from git: main first, linked and detached kept, prunable skipped; no repo → the folder", async () => {
  const main = makeRepo("app");
  const ws = join(root, "workspaces", "app");
  sh(main, "worktree", "add", "-q", "-b", "one", join(ws, "one"));
  sh(main, "worktree", "add", "-q", "--detach", join(ws, "review"));
  sh(main, "worktree", "add", "-q", "-b", "gone", join(ws, "gone"));
  rmSync(join(ws, "gone"), { recursive: true, force: true });
  const seen = [];
  const spy = (cwd, args) => { seen.push(args); return realGit(cwd, args); };
  const list = await listCheckouts(`${main}/`, spy);
  assert.deepEqual(seen, [WORKTREE_LIST]);
  assert.ok(WORKTREE_LIST.includes("--no-optional-locks"), "a listing never wakes its own watch");
  assert.deepEqual(list.map((c) => [c.path, c.branch, c.main]).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])), [
    [main, "main", true],
    [join(ws, "one"), "one", false],
    [join(ws, "review"), null, false],
  ]);
  assert.equal(list[0].main, true);
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.deepEqual(await listCheckouts(plain, realGit), [{ path: plain, branch: null, main: true }]);
});

// ── Space <-> workspace matching (D7) ──────────────────────────────────────

const HOME = "/Users/me";
const cache = {
  "/Users/me/code/app": [
    { path: "/Users/me/code/app", branch: "main", main: true },
    { path: "/Users/me/code/app/.worktrees/fix", branch: "fix", main: false },
    { path: "/Users/me/orca/workspaces/app/feat", branch: "feat", main: false },
  ],
  "/Users/me/code/api": [{ path: "/Users/me/code/api", branch: "main", main: true }],
};
const space = (id, folder, extra = {}) => ({ id, folder, machine: null, status: null, tabs: [{ id: `${id}-t1` }], ...extra });
const pane = (spaceId, cwd, extra = {}) => ({ pane: `${spaceId}-p`, tab: `${spaceId}-t1`, terminal: "t", cwd, ...extra });

test("match: a space at ~/… matches the workspace at that absolute path", () => {
  const m = matchSpaces(cache, [space("s1", "~/code/api")], [], HOME);
  assert.deepEqual(m, { s1: { project: "/Users/me/code/api", path: "/Users/me/code/api" } });
});

test("match: a trailing slash on either side still matches", () => {
  const withSlash = { "/Users/me/code/api/": [{ path: "/Users/me/code/api/", branch: "main", main: true }] };
  assert.deepEqual(matchSpaces(cache, [space("s1", "/Users/me/code/api/")], [], HOME).s1, { project: "/Users/me/code/api", path: "/Users/me/code/api" });
  assert.deepEqual(matchSpaces(withSlash, [space("s1", "/Users/me/code/api")], [], `${HOME}/`).s1, { project: "/Users/me/code/api", path: "/Users/me/code/api" });
});

test("match: the first terminal's live folder wins over the space's folder, the deepest checkout wins", () => {
  const spaces = [space("s1", "/Users/me/code/app"), space("s2", "/Users/me/code/api"), space("s3", "/Users/me/code/app")];
  const panes = [
    pane("s1", "/Users/me/code/app/.worktrees/fix/src"),
    pane("s2", null, { terminal: null, mod: "files" }),
    { ...pane("s2", "/Users/me/orca/workspaces/app/feat/lib/"), pane: "s2-p2" },
    pane("s3", "/Users/me/code/app/src"),
  ];
  assert.deepEqual(matchSpaces(cache, spaces, panes, HOME), {
    s1: { project: "/Users/me/code/app", path: "/Users/me/code/app/.worktrees/fix" },
    s2: { project: "/Users/me/code/app", path: "/Users/me/orca/workspaces/app/feat" },
    s3: { project: "/Users/me/code/app", path: "/Users/me/code/app" },
  });
  assert.equal(placeOf(spaces[1], panes), "/Users/me/orca/workspaces/app/feat/lib/");
});

test("match: a space on another machine, or outside every project, matches nothing", () => {
  const spaces = [
    space("remote", "/Users/me/code/api", { machine: "vps" }),
    space("other", "/Users/me/Downloads"),
    space("prefix", "/Users/me/code/api-old"),
    space("empty", ""),
  ];
  assert.deepEqual(matchSpaces(cache, spaces, [], HOME), {});
  assert.deepEqual(matchSpaces(undefined, spaces, undefined, HOME), {});
});

// ── Attention dot per group (D9) ───────────────────────────────────────────

function attentionSetup(status, extraSpaces = []) {
  let r = emptyRegistry();
  r = addProject(r, { path: "/Users/me/code/api" });
  r = addGroup(r, "Clients");
  r = addProject(selectGroup(r, r.groups[1].id), { path: "/Users/me/code/app" });
  r = selectGroup(r, r.groups[0].id); // Projects active, Clients not
  const spaces = [space("s1", "/Users/me/orca/workspaces/app/feat", { status }), ...extraSpaces];
  return { r, spaces, matches: matchSpaces(cache, spaces, [], HOME) };
}

test("attention: an inactive group with a done or blocked space gets the dot", () => {
  for (const status of ["done", "blocked"]) {
    const { r, spaces, matches } = attentionSetup(status);
    assert.deepEqual(attentionByGroup(r, matches, spaces), { [r.groups[0].id]: false, [r.groups[1].id]: true }, status);
  }
  for (const status of ["working", "idle", null]) {
    const { r, spaces, matches } = attentionSetup(status);
    assert.equal(attentionByGroup(r, matches, spaces)[r.groups[1].id], false, String(status));
  }
});

test("attention: the active group never gets the dot", () => {
  const { r, spaces, matches } = attentionSetup("done");
  const onClients = selectGroup(r, r.groups[1].id);
  assert.deepEqual(attentionByGroup(onClients, matches, spaces), { [r.groups[0].id]: false, [r.groups[1].id]: false });
});

test("attention: a space outside every project gives no dot", () => {
  const { r } = attentionSetup(null);
  const spaces = [space("x", "/Users/me/Downloads", { status: "done" }), space("y", "/Users/me/code/api", { status: "blocked", machine: "vps" })];
  const matches = matchSpaces(cache, spaces, [], HOME);
  assert.deepEqual(attentionByGroup(r, matches, spaces), { [r.groups[0].id]: false, [r.groups[1].id]: false });
});

test("attention: a terminal in a subfolder of an inactive group's worktree gives the dot (same matching as the tree)", () => {
  const { r } = attentionSetup(null);
  const spaces = [space("s9", "/Users/me/code/api", { status: "done" })];
  const panes = [pane("s9", "/Users/me/code/app/.worktrees/fix/deep/dir")];
  const matches = matchSpaces(cache, spaces, panes, HOME);
  assert.equal(matches.s9.project, "/Users/me/code/app");
  assert.equal(attentionByGroup(r, matches, spaces)[r.groups[1].id], true);
});

test("normPath: ~ expanded, backslashes and trailing slashes gone, root kept", () => {
  assert.equal(normPath("~", HOME), HOME);
  assert.equal(normPath("~/code/", HOME), "/Users/me/code");
  assert.equal(normPath("C:\\Users\\me\\code\\"), "C:/Users/me/code");
  assert.equal(normPath("/"), "/");
  assert.equal(normPath(null), "");
});
