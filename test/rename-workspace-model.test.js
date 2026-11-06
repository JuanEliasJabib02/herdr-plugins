// T9a and T9c: the Rename model (M/rename-workspace-model.js), D25–D26 and
// D28. The name a rename gives (each `/` segment slugged like D12, text
// equal to the old branch unchanged), and the rename itself against real git
// in throwaway repos: the checks that refuse it, the branch, the folder, and
// outcomes that read git's state, never its words (same under es_ES). A
// pushed branch (D28) is renamed on GitHub through `gh`, or copied with a
// push, decided by what origin has: origin is always a local bare repo, `gh`
// and `ssh -G` are fakes passed through io, and the one git call that would
// show a GitHub URL (`remote get-url origin`) is answered by the test, so no
// test ever reaches the network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, existsSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT, GH, POLL, branchName, renameTarget, folderFor, renameCheck, renameWorkspace,
  parseRemoteUrl, githubRepoOf, sshHostnameOf, remoteHeads, remoteOutcome,
} from "../projects-sidebar/mods/projects/rename-workspace-model.js";

// ── Names (D25) ────────────────────────────────────────────────────────────

test("name: each / segment is slugged like D12, so a namespace survives; text equal to the old branch is unchanged", () => {
  assert.equal(branchName("Fix Login!"), "fix-login");
  assert.equal(branchName("user/Feat X"), "user/feat-x", "the namespace survives");
  assert.equal(branchName("Feature/ABC-123"), "feature/abc-123");
  assert.equal(branchName("/a//b/"), "a/b", "empty segments dropped");
  assert.equal(branchName("-rf/..x"), "rf/x", "no segment starts with a dash or a dot");
  assert.equal(branchName("  "), "");
  assert.equal(branchName(null), "");
  assert.deepEqual(renameTarget("Feature/ABC-1", "Feature/ABC-1"), { name: "Feature/ABC-1", unchanged: true }, "an untouched prefill is never slugged into a rename");
  assert.deepEqual(renameTarget(" user/feat ", "user/feat"), { name: "user/feat", unchanged: true });
  assert.deepEqual(renameTarget("FIX-LOGIN", "fix-login"), { name: "fix-login", unchanged: true }, "slugs to the same branch");
  assert.deepEqual(renameTarget("user/new", "user/old"), { name: "user/new", unchanged: false });
  assert.deepEqual(renameTarget("!!!", "old"), { name: "", unchanged: false });
  assert.equal(folderFor("/w/shop/old", "user/new"), "/w/shop/new", "a sibling named after the last segment");
  assert.equal(folderFor("/w/shop/old/", "fix"), "/w/shop/fix");
});

// ── Real git (throwaway repos, no global config or hooks) ──────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), "projects-sidebar-rn-")));
after(() => rmSync(root, { recursive: true, force: true }));
const C = { LANG: "C", LC_ALL: "C" };
const ES = { LANG: "es_ES.UTF-8", LC_ALL: "es_ES.UTF-8", LANGUAGE: "es" };
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...C };
const sh = (cwd, args, extra = {}) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra }, stdio: "pipe" }).toString().trim();
// The same shape as M/git.js's git(cwd, args), on a given git binary and
// locale.
const makeGit = (bin = "git", extra = {}) => (cwd, args) => new Promise((resolve, reject) => {
  execFile(bin, ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra } }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || stdout).trim() });
  });
});
const exists = async (p) => existsSync(p);
const io = { git: makeGit(), exists };

// A project cloned from a bare origin of its own, on `main`; its workspaces
// go under `ws`. Every call makes a new one.
let made = 0;
function makeProject(prefix) {
  const name = `${prefix}-${++made}`;
  const seed = join(root, "seeds", name);
  mkdirSync(seed, { recursive: true });
  sh(seed, ["init", "-q", "-b", "main"]);
  sh(seed, ["commit", "-q", "--allow-empty", "-m", "first"]);
  const origin = join(root, "origins", `${name}.git`);
  sh(root, ["clone", "-q", "--bare", seed, origin]);
  const path = join(root, "code", name);
  sh(root, ["clone", "-q", origin, path]);
  return { path, name, origin, ws: join(root, "ws", name) };
}

// A workspace on a new branch from origin/main, in <ws>/<folder>. `track`:
// git's default upstream (origin/main) instead of D14's --no-track.
function addWorkspace(p, branch, { folder = branch.split("/").pop(), track = false } = {}) {
  const path = join(p.ws, folder);
  sh(p.path, ["worktree", "add", "-q", ...(track ? [] : ["--no-track"]), "-b", branch, path, "origin/main"]);
  return path;
}

const has = (p, branch) => {
  try { sh(p.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); return true; } catch { return false; }
};
const upstream = (p, branch) => {
  try { return sh(p.path, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]); } catch { return null; }
};
const merge = (p, branch) => {
  try { return sh(p.path, ["config", "--get-all", `branch.${branch}.merge`]); } catch { return null; }
};
const heads = (p) => sh(p.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").sort();
const rename = (p, path, name, moveFolder = true, with_ = io, seen) => renameWorkspace({ project: p.path, path, name, moveFolder, seen }, with_);
// What origin (the bare repo) has: { [branch]: commit }.
const onOrigin = (p) => Object.fromEntries(sh(p.origin, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"])
  .split("\n").filter(Boolean).map((l) => l.split(" ")));
const config = (p, key) => {
  try { return sh(p.path, ["config", "--get", key]); } catch { return null; }
};
// A workspace on `branch`, pushed with -u to origin.
const pushed = (p, branch, opts) => {
  const path = addWorkspace(p, branch, opts);
  sh(path, ["push", "-q", "-u", "origin", branch]);
  return path;
};
const isLsRemote = (args) => args[0] === "ls-remote";
const isPush = (args) => args[0] === "push";

// The io of a project whose origin "is" GitHub: `remote get-url origin`
// answers `url` (the only call that would name GitHub), while every other git
// call runs the real git on the local bare origin. `gh` is a fake that does
// to the bare repo what GitHub would:
//   push: what `gh api repos/<o>/<r> --jq .permissions.push` prints ("true",
//     "false"), or "missing" (gh can't start), "logged-out" (exit 4);
//   prs: the open PR numbers from <old>; pulls: "fails" → the list exits 1;
//   rename: "now" (renames the ref), "late" (renames once origin has been
//     looked at once more), "both" (<new> appears, <old> stays: GitHub still
//     finishing), "rejects" (renames, then exec gives up), "cut" (exec gives
//     up, nothing renamed), "refuses" (exit 1, nothing renamed).
//   wrap: wraps the git (to make a step fail).
// Returns { io, git: the git calls, gh: the gh calls, sleeps, fake }.
function githubIo(p, { url = "git@github.com:acme/shop.git", push = "true", prs = [], pulls = "ok", rename = "now", wrap = (g) => g } = {}) {
  const real = makeGit();
  const gitCalls = [];
  const ghCalls = [];
  const sleeps = [];
  const fake = { prs, pending: null, cwds: new Set() };
  const inner = async (cwd, args) => {
    gitCalls.push(args.join(" "));
    if (args[0] === "remote" && args[1] === "get-url") return { ok: true, out: url, err: "" };
    const r = await real(cwd, args);
    if (isLsRemote(args) && fake.pending) {
      sh(p.origin, ["branch", "-m", ...fake.pending]);
      fake.pending = null;
    }
    return r;
  };
  const ok = (out = "") => ({ ok: true, code: 0, out, err: "" });
  const gh = async (cwd, args) => {
    ghCalls.push(args.join(" "));
    fake.cwds.add(cwd);
    const endpoint = args.find((a) => a.startsWith("repos/"));
    if (args.includes("POST")) {
      const old = endpoint.match(/\/branches\/(.+)\/rename$/)[1].split("/").map(decodeURIComponent).join("/");
      const name = args[args.indexOf("-f") + 1].slice("new_name=".length);
      if (rename === "now") sh(p.origin, ["branch", "-m", old, name]);
      if (rename === "late") fake.pending = [old, name];
      if (rename === "both") sh(p.origin, ["branch", name, old]);
      if (rename === "rejects") {
        sh(p.origin, ["branch", "-m", old, name]);
        throw new Error("timed out after 30s");
      }
      if (rename === "cut") throw new Error("timed out after 30s");
      if (rename === "refuses") return { ok: false, code: 1, out: "", err: "gh: Validation Failed (HTTP 422)" };
      return ok("{}");
    }
    if (endpoint.includes("/pulls?")) {
      if (pulls === "fails") return { ok: false, code: 1, out: "", err: "gh: Server Error (HTTP 502)" };
      return ok(fake.prs.map((n) => `${n} https://github.example/acme/shop/pull/${n}`).join("\n"));
    }
    if (push === "missing") throw new Error("spawn gh ENOENT");
    if (push === "logged-out") return { ok: false, code: 4, out: "", err: "To get started with GitHub CLI, please run:  gh auth login" };
    return ok(push);
  };
  const hostname = async (host) => ({ "gh-work": "github.com" })[host] ?? host;
  const io = { git: wrap(inner), exists, gh, hostname, sleep: async (ms) => { sleeps.push(ms); } };
  return { io, git: gitCalls, gh: ghCalls, sleeps, fake };
}
const renamedOnGitHub = (calls) => calls.filter((c) => c.includes("POST"));
const pushes = (calls) => calls.filter((c) => c.startsWith("push "));

test("rename: an unpushed branch with moveFolder → branch renamed, folder moved, the list has the new path, HEAD on the new branch", async () => {
  const p = makeProject("move");
  const path = addWorkspace(p, "old-name");
  const r = await rename(p, path, "new-name");
  const moved = join(p.ws, "new-name");
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.branch, "new-name");
  assert.equal(r.folder, "moved");
  assert.equal(r.err, "");
  assert.ok(r.list.some((w) => w.path === moved && w.branch === "new-name" && !w.main), "the list has the new path on the new branch");
  assert.ok(!r.list.some((w) => w.path === path), "the old path is gone from the list");
  assert.ok(existsSync(moved));
  assert.ok(!existsSync(path));
  assert.equal(sh(moved, ["branch", "--show-current"]), "new-name", "the worktree's HEAD is on the new branch");
  assert.equal(has(p, "old-name"), false);
});

test("rename: moveFolder false → branch renamed, folder stays", async () => {
  const p = makeProject("stays");
  const path = addWorkspace(p, "here");
  const r = await rename(p, path, "renamed-here", false);
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.branch, "renamed-here");
  assert.equal(r.folder, "stays");
  assert.ok(r.list.some((w) => w.path === path && w.branch === "renamed-here"), "same folder, new branch");
  assert.ok(existsSync(path));
  assert.ok(!existsSync(join(p.ws, "renamed-here")));
  assert.equal(sh(path, ["branch", "--show-current"]), "renamed-here");
  assert.equal(has(p, "here"), false);
});

test("rename (T9c 11): a [gone] branch, whose upstream of its own name origin no longer has → renamed here only, with the upstream unset", async () => {
  const p = makeProject("gone");
  const path = pushed(p, "shipped");
  sh(path, ["push", "-q", "origin", "--delete", "shipped"]);
  assert.equal(sh(p.path, ["for-each-ref", "refs/remotes/origin/shipped"]), "", "no origin/shipped left");
  assert.equal(merge(p, "shipped"), "refs/heads/shipped", "the upstream is still set ([gone])");
  const c = await renameCheck({ project: p.path, path, name: "other" }, io);
  assert.equal(c.status, "ok", c.err);
  assert.deepEqual([c.origin.published, c.origin.route, c.origin.gone], [true, "local", true]);
  const r = await rename(p, path, "other", true, io, { route: "local", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "none", "nothing on origin");
  assert.equal(r.branch, "other");
  assert.equal(r.err, "");
  assert.equal(upstream(p, "other"), null, "a push never lands in the old name");
  assert.equal(merge(p, "other"), null);
  assert.deepEqual(onOrigin(p), { main: onOrigin(p).main }, "origin gets nothing back");
});

test("rename (T9c 12): pushed to another remote only, or to origin and another → refused, nothing renamed", async () => {
  const p = makeProject("elsewhere");
  const mirror = join(root, "origins", `${p.name}-mirror.git`);
  sh(root, ["init", "-q", "--bare", mirror]);
  sh(p.path, ["remote", "add", "github", mirror]);
  const only = addWorkspace(p, "only-there");
  sh(only, ["push", "-q", "github", "only-there"]);
  const g = await rename(p, only, "moved-on");
  assert.equal(g.status, "refused");
  assert.equal(g.reason, "pushed-elsewhere");
  assert.equal(g.err, "Also pushed as github/only-there: renaming would split it.");
  const both = pushed(p, "both-places");
  sh(both, ["push", "-q", "github", "both-places"]);
  const b = await rename(p, both, "split", true, githubIo(p).io, { route: "github", prs: [] });
  assert.equal(b.status, "refused", "github sorts before origin: every remote ref counts, not the first");
  assert.equal(b.reason, "pushed-elsewhere");
  assert.equal(b.err, "Also pushed as github/both-places: renaming would split it.");
  const up = addWorkspace(p, "upstream-there");
  sh(up, ["push", "-q", "-u", "github", "upstream-there"]);
  sh(p.path, ["update-ref", "-d", "refs/remotes/github/upstream-there"]);
  const u = await rename(p, up, "away");
  assert.equal(u.reason, "pushed-elsewhere", "an upstream of its own name on another remote counts too");
  assert.equal(u.err, "Also pushed as github/upstream-there: renaming would split it.");
  assert.deepEqual(heads(p), ["both-places", "main", "only-there", "upstream-there"]);
  assert.ok(!("split" in onOrigin(p)));
});

test("rename: an upstream with another name (origin/main) is not published → renamed, and the upstream is unset", async () => {
  const p = makeProject("tracking");
  const path = addWorkspace(p, "tracks", { track: true });
  assert.equal(upstream(p, "tracks"), "origin/main", "git's default upstream for -b from origin/main");
  const r = await rename(p, path, "isolated");
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.folder, "moved");
  assert.equal(upstream(p, "isolated"), null, "a push never lands in main");
  assert.equal(merge(p, "isolated"), null);
});

test("rename: the new branch exists → refused, nothing renamed", async () => {
  const p = makeProject("branch-taken");
  const path = addWorkspace(p, "mine");
  sh(p.path, ["branch", "taken"]);
  const r = await rename(p, path, "taken");
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "branch-exists");
  assert.equal(r.err, "Branch taken already exists.");
  assert.equal(r.branch, "mine");
  assert.deepEqual(heads(p), ["main", "mine", "taken"]);
  assert.ok(existsSync(path));
});

test("rename: the new folder exists → refused, nothing renamed", async () => {
  const p = makeProject("folder-taken");
  const path = addWorkspace(p, "free-me");
  const busy = join(p.ws, "busy");
  mkdirSync(busy, { recursive: true });
  const r = await rename(p, path, "busy");
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "folder-exists");
  assert.equal(r.err, `${busy} already exists.`);
  assert.deepEqual(heads(p), ["free-me", "main"]);
  assert.ok(existsSync(path));
});

test("rename: a detached checkout, the main checkout, or a path outside the list → refused, nothing renamed", async () => {
  const p = makeProject("refusals");
  const detached = join(p.ws, "loose-head");
  sh(p.path, ["worktree", "add", "-q", "--detach", detached, "origin/main"]);
  const kept = addWorkspace(p, "keep");
  const before = heads(p);
  const d = await rename(p, detached, "anything");
  assert.equal(d.status, "refused");
  assert.equal(d.reason, "detached");
  assert.equal(d.err, "loose-head is detached or in the middle of a rebase.");
  assert.equal(d.branch, null);
  const m = await rename(p, p.path, "anything");
  assert.equal(m.status, "refused");
  assert.equal(m.reason, "main");
  assert.equal(m.branch, "main");
  const outside = await rename(p, join(root, "not-a-workspace"), "anything");
  assert.equal(outside.status, "refused");
  assert.equal(outside.reason, "missing");
  assert.ok(outside.list.length >= 3, "the fresh list comes back with a refusal");
  assert.deepEqual(heads(p), before);
  assert.ok(existsSync(detached));
  assert.ok(existsSync(kept));
  assert.ok(!existsSync(join(p.ws, "anything")));
});

test("rename: locked → branch renamed, folder kept with git's first line", async () => {
  const p = makeProject("locked");
  const path = addWorkspace(p, "pinned");
  sh(p.path, ["worktree", "lock", "--reason", "on a usb disk", path]);
  const r = await rename(p, path, "unpinned");
  assert.equal(r.status, "renamed");
  assert.equal(r.branch, "unpinned");
  assert.equal(r.folder, "kept");
  assert.match(r.err, /locked/);
  assert.equal(r.err.split("\n").length, 1, "git's first line only");
  assert.doesNotMatch(r.err, /-f/, "no advice to force");
  assert.ok(r.list.some((w) => w.path === path && w.branch === "unpinned"));
  assert.ok(existsSync(path));
  assert.ok(!existsSync(join(p.ws, "unpinned")));
});

test("rename: the name is slugged per segment (Fix Login! → fix-login, user/old → user/new); an unchanged name → refused", async () => {
  const p = makeProject("names");
  const plain = addWorkspace(p, "start");
  const r = await rename(p, plain, "Fix Login!");
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.branch, "fix-login");
  assert.ok(existsSync(join(p.ws, "fix-login")));
  const ns = addWorkspace(p, "user/old");
  const n = await rename(p, ns, "user/new");
  assert.equal(n.status, "renamed", n.err);
  assert.equal(n.branch, "user/new", "the prefix stays");
  assert.equal(has(p, "user/new"), true);
  const nsPath = join(p.ws, "new");
  assert.ok(n.list.some((w) => w.path === nsPath && w.branch === "user/new"), "the folder is the last segment, a sibling");
  const untouched = await rename(p, nsPath, "user/new");
  assert.equal(untouched.status, "refused");
  assert.equal(untouched.reason, "unchanged");
  const team = await rename(p, nsPath, "team/new");
  assert.equal(team.status, "renamed", team.err);
  assert.equal(team.folder, "stays", "same last segment: the folder already has the name");
  assert.ok(team.list.some((w) => w.path === nsPath && w.branch === "team/new"));
  const caps = addWorkspace(p, "Feature/ABC-1", { folder: "abc-1" });
  const prefill = await rename(p, caps, "Feature/ABC-1");
  assert.equal(prefill.status, "refused", "the untouched prefill is never slugged into a rename");
  assert.equal(prefill.reason, "unchanged");
  assert.equal(has(p, "Feature/ABC-1"), true);
  const empty = await rename(p, caps, "  !!  ");
  assert.equal(empty.status, "refused");
  assert.equal(empty.reason, "empty");
});

// A git built without gettext (Apple's) answers in English in any locale,
// which would make the es_ES test prove nothing: it runs on the first git on
// PATH whose messages change under es_ES, else on the default one.
function translatingGit() {
  const seen = new Set();
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const bin = join(dir, "git");
    let real;
    try {
      accessSync(bin, constants.X_OK);
      real = realpathSync(bin);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const say = (extra) => spawnSync(bin, ["rev-parse", "--git-dir"], { cwd: root, env: { ...env, ...extra } }).stderr?.toString() ?? "";
    if (say(ES) !== say(C)) return bin;
  }
  return null;
}

test("rename (T9c 18): the outcomes are the same under LANG=es_ES.UTF-8, pushed branches included", async (t) => {
  const bin = translatingGit();
  if (!bin) t.diagnostic("no git on PATH translates its messages: the es_ES run uses the default git");
  const outcomes = async (extra) => {
    const local = { git: makeGit(bin ?? "git", extra), exists };
    const p = makeProject("locale");
    const free = addWorkspace(p, "free");
    const copied = pushed(p, "pushed");
    const gone = pushed(p, "gone");
    sh(gone, ["push", "-q", "origin", "--delete", "gone"]);
    const onGitHub = pushed(p, "on-github");
    const locked = addWorkspace(p, "locked");
    sh(p.path, ["worktree", "lock", "--reason", "usb", locked]);
    const clash = addWorkspace(p, "clash");
    sh(p.path, ["branch", "taken"]);
    const detached = join(p.ws, "detached");
    sh(p.path, ["worktree", "add", "-q", "--detach", detached, "origin/main"]);
    const tracks = addWorkspace(p, "tracks", { track: true });
    const hub = githubIo(p, { wrap: () => (cwd, args) => args[0] === "remote" && args[1] === "get-url"
      ? Promise.resolve({ ok: true, out: "git@github.com:acme/shop.git", err: "" }) : local.git(cwd, args) });
    const pick = ({ status, reason, branch, folder, remote }) => ({ status, reason, branch, folder, remote });
    const lockedResult = await rename(p, locked, "unlocked", true, local);
    const unreachable = await (async () => {
      sh(p.path, ["remote", "set-url", "origin", join(root, "nowhere.git")]);
      try {
        return await rename(p, copied, "never", true, local, { route: "copy", prs: [] });
      } finally {
        sh(p.path, ["remote", "set-url", "origin", p.origin]);
      }
    })();
    return {
      outcomes: {
        free: pick(await rename(p, free, "freed", true, local)),
        unreachable: pick(unreachable),
        copied: pick(await rename(p, copied, "copied", true, local, { route: "copy", prs: [] })),
        gone: { ...pick(await rename(p, gone, "here-only", true, local, { route: "local", prs: [] })), upstream: upstream(p, "here-only") },
        github: { ...pick(await rename(p, onGitHub, "renamed-there", true, hub.io, { route: "github", prs: [] })), upstream: upstream(p, "renamed-there") },
        locked: pick(lockedResult),
        clash: pick(await rename(p, clash, "taken", true, local)),
        detached: pick(await rename(p, detached, "attached", true, local)),
        tracks: { ...pick(await rename(p, tracks, "untracked", true, local)), upstream: upstream(p, "untracked") },
      },
      lockedErr: lockedResult.err,
      unreachableErr: unreachable.err,
    };
  };
  const english = await outcomes(C);
  const spanish = await outcomes(ES);
  assert.deepEqual(spanish.outcomes, english.outcomes);
  assert.deepEqual(english.outcomes.free, { status: "renamed", reason: null, branch: "freed", folder: "moved", remote: "none" });
  assert.deepEqual(english.outcomes.locked, { status: "renamed", reason: null, branch: "unlocked", folder: "kept", remote: "none" });
  assert.deepEqual(english.outcomes.copied, { status: "renamed", reason: null, branch: "copied", folder: "moved", remote: "copied" });
  assert.deepEqual(english.outcomes.gone, { status: "renamed", reason: null, branch: "here-only", folder: "moved", remote: "none", upstream: null });
  assert.deepEqual(english.outcomes.github, { status: "renamed", reason: null, branch: "renamed-there", folder: "moved", remote: "renamed", upstream: "origin/renamed-there" });
  assert.equal(english.outcomes.unreachable.reason, "unreachable");
  assert.equal(english.outcomes.tracks.upstream, null);
  assert.match(spanish.unreachableErr, /^Couldn't reach origin: /);
  if (bin) assert.notEqual(spanish.lockedErr, english.lockedErr, "git really answered in Spanish");
});

test("rename: a git that rejects (exec's 30 s limit) → the refs and the re-list decide, not the rejection", async () => {
  const p = makeProject("rejects");
  const real = makeGit();
  const isMove = (args) => args[0] === "worktree" && args[1] === "move";
  const isRename = (args) => args[0] === "branch" && args[1] === "-m";
  // git ran to the end, then exec gave up on it: the folder did move.
  const late = { git: async (cwd, args) => {
    const r = await real(cwd, args);
    if (isMove(args)) throw new Error("timed out after 30s");
    return r;
  }, exists };
  const a = addWorkspace(p, "late");
  const ra = await rename(p, a, "late-done", true, late);
  assert.equal(ra.status, "renamed");
  assert.equal(ra.folder, "moved");
  assert.ok(existsSync(join(p.ws, "late-done")));
  // exec gave up before git did anything.
  const never = (match) => ({ git: async (cwd, args) => {
    if (match(args)) throw new Error("timed out after 30s");
    return real(cwd, args);
  }, exists });
  const b = addWorkspace(p, "stuck");
  const rb = await rename(p, b, "stuck-done", true, never(isMove));
  assert.equal(rb.status, "renamed");
  assert.equal(rb.folder, "kept");
  assert.equal(rb.err, "timed out after 30s");
  assert.ok(existsSync(b));
  const c = addWorkspace(p, "frozen");
  const rc = await rename(p, c, "thawed", true, never(isRename));
  assert.equal(rc.status, "failed");
  assert.equal(rc.branch, "frozen");
  assert.equal(rc.folder, null);
  assert.equal(rc.err, "timed out after 30s");
  assert.equal(has(p, "frozen"), true);
  assert.equal(has(p, "thawed"), false);
  assert.ok(existsSync(c));
});

test("check: renameCheck answers before anything runs; GIT holds the argv, with -- before paths and names", async () => {
  const p = makeProject("check");
  const path = addWorkspace(p, "user/look", { track: true });
  const calls = [];
  const watched = { git: (cwd, args) => {
    calls.push(args.join(" "));
    return io.git(cwd, args);
  }, exists };
  const c = await renameCheck({ project: p.path, path, name: "user/Seen" }, watched);
  assert.equal(c.status, "ok");
  assert.equal(c.branch, "user/look");
  assert.equal(c.name, "user/seen");
  assert.equal(c.newPath, join(p.ws, "seen"));
  assert.equal(c.tracking, true, "an upstream with another name, to unset after");
  assert.ok(!calls.some((a) => /^(branch -m|branch --unset-upstream|worktree move)/.test(a)), "the check changes nothing");
  assert.equal(has(p, "user/look"), true);
  assert.deepEqual(GIT.rename("a", "b"), ["branch", "-m", "--", "a", "b"]);
  assert.deepEqual(GIT.move("/x/a", "/x/b"), ["worktree", "move", "--", "/x/a", "/x/b"]);
  assert.deepEqual(GIT.unsetUpstream("b"), ["branch", "--unset-upstream", "--", "b"]);
});

// ── Pushed branches (T9c, D28) ─────────────────────────────────────────────

test("rename (T9c 1): githubRepoOf reads every origin URL form; an alias counts through ssh -G; a local path or file:// is not GitHub", () => {
  // A fake `ssh -G`: the alias gh-work is github.com, any other host itself.
  const sshG = (host) => ({ "gh-work": "github.com" })[host] ?? host;
  const repo = (url) => {
    const u = parseRemoteUrl(url);
    return githubRepoOf(url, u?.ssh ? sshG(u.host) : null);
  };
  const shop = { owner: "acme", repo: "shop" };
  const table = [
    ["git@github.com:acme/shop.git", shop],
    ["github.com:acme/shop", shop],
    ["git@gh-work:acme/shop.git", shop],
    ["ssh://git@github.com/acme/shop.git", shop],
    ["ssh://git@ssh.github.com:443/acme/shop.git", shop],
    ["ssh://gh-work/acme/shop", shop],
    ["https://github.com/acme/shop.git", shop],
    ["https://github.com/acme/shop/", shop],
    ["https://x-access:s3cret@github.com:443/acme/shop.git", shop],
    ["git://github.com/acme/shop", shop],
    ["https://GitHub.com/Acme/Shop.git", { owner: "Acme", repo: "Shop" }],
    ["git@gitlab.example:acme/shop.git", null],
    ["https://gitlab.example/acme/shop.git", null],
    ["https://gh-work/acme/shop.git", null, "an alias is an ssh thing: https goes to that host"],
    ["https://github.com/acme/shop/extra", null],
    ["https://github.com/acme", null],
    ["/srv/git/shop.git", null],
    ["./shop", null],
    ["../origins/shop.git", null],
    ["file:///srv/git/shop.git", null],
    ["git@github.com:acme/sh#op.git", null, "a name GitHub can't have never reaches a URL path"],
    ["-oProxyCommand=x:acme/shop", null, "a host that would read as an ssh flag"],
    ["", null],
  ];
  for (const [url, want, why] of table) assert.deepEqual(repo(url), want, why ?? url);
  assert.equal(githubRepoOf("git@gh-work:acme/shop.git", null), null, "an alias ssh -G can't resolve isn't GitHub");
  assert.deepEqual(parseRemoteUrl("ssh://git@gh-work:2222/acme/shop.git"), { ssh: true, host: "gh-work", path: "acme/shop.git" });
  assert.equal(sshHostnameOf("user git\nhostname github.com\nport 22\n"), "github.com");
  assert.equal(sshHostnameOf("port 22\n"), null);
});

test("rename (T9c 2): on GitHub → gh renames it there, the branch here, and the upstream is origin/<new>", async () => {
  const p = makeProject("github");
  const path = pushed(p, "feat-a");
  const sha = onOrigin(p)["feat-a"];
  const t = githubIo(p);
  const c = await renameCheck({ project: p.path, path, name: "feat-b" }, t.io);
  assert.equal(c.status, "ok", c.err);
  assert.deepEqual(c.origin, { published: true, route: "github", gone: false, repo: { owner: "acme", repo: "shop" }, prs: [], sha });
  assert.ok(t.git.includes("ls-remote origin refs/heads/feat-a refs/heads/feat-b refs/heads/feat-b/*"), "one ls-remote, exact refnames, and what would be in the way of feat-b");
  const r = await rename(p, path, "feat-b", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "renamed");
  assert.deepEqual(r.prs, []);
  assert.equal(r.branch, "feat-b");
  assert.equal(r.folder, "moved");
  assert.equal(r.err, "");
  assert.deepEqual(renamedOnGitHub(t.gh), ["api -X POST repos/acme/shop/branches/feat-a/rename -f new_name=feat-b"]);
  assert.deepEqual([...t.fake.cwds], [p.path], "gh runs in the project, so a gh wrapper picks the same account");
  assert.deepEqual(onOrigin(p), { "feat-b": sha, main: onOrigin(p).main }, "GitHub has it as feat-b, on the same commit");
  assert.deepEqual(heads(p), ["feat-b", "main"]);
  assert.equal(config(p, "branch.feat-b.remote"), "origin");
  assert.equal(merge(p, "feat-b"), "refs/heads/feat-b");
  assert.equal(upstream(p, "feat-b"), "origin/feat-b", "fetched, so the upstream resolves");
  assert.equal(sh(p.path, ["for-each-ref", "refs/remotes/origin/feat-a"]), "", "the stale origin/feat-a is gone, as a prune would");
  assert.deepEqual(pushes(t.git), [], "no copy");
});

test("rename (T9c 3): GitHub renames late → renamed after polling, no copy; both still there after the bound → renamed, 'still finishing'", async () => {
  const p = makeProject("late");
  const path = pushed(p, "slow");
  const t = githubIo(p, { url: "git@gh-work:acme/shop.git", rename: "late" });
  const r = await rename(p, path, "slower", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "renamed");
  assert.equal(r.err, "");
  assert.deepEqual(t.sleeps, [POLL.step], "one more look after a sleep");
  assert.deepEqual(pushes(t.git), []);
  assert.ok(!("slow" in onOrigin(p)) && "slower" in onOrigin(p));

  const q = makeProject("finishing");
  const qpath = pushed(q, "half");
  const u = githubIo(q, { rename: "both" });
  const s = await rename(q, qpath, "halfway", true, u.io, { route: "github", prs: [] });
  assert.equal(s.status, "renamed", s.err);
  assert.equal(s.remote, "renamed");
  assert.equal(s.err, "GitHub is still finishing the rename.");
  assert.equal(s.branch, "halfway");
  assert.equal(u.sleeps.length, POLL.tries - 1, "polled up to the bound");
  assert.deepEqual(pushes(u.git), [], "never a copy once GitHub was called");
  assert.equal(upstream(q, "halfway"), "origin/halfway");
});

test("rename (T9c 4): a gh that rejects but did rename → renamed, no copy", async () => {
  const p = makeProject("rejects");
  const path = pushed(p, "gone-quiet");
  const t = githubIo(p, { rename: "rejects" });
  const r = await rename(p, path, "came-back", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "renamed");
  assert.equal(r.branch, "came-back");
  assert.deepEqual(pushes(t.git), []);
  assert.equal(upstream(p, "came-back"), "origin/came-back");
});

test("rename (T9c 5): no gh → a copy is pushed from origin's own commit; origin keeps <old>, even with the local branch one commit ahead", async () => {
  const p = makeProject("copy");
  const path = pushed(p, "keep-me");
  const theirs = onOrigin(p)["keep-me"];
  sh(path, ["commit", "-q", "--allow-empty", "-m", "not pushed"]);
  const mine = sh(path, ["rev-parse", "HEAD"]);
  const t = githubIo(p, { push: "missing" });
  const c = await renameCheck({ project: p.path, path, name: "copy-me" }, t.io);
  assert.equal(c.origin.route, "copy", "gh can't start");
  assert.equal(c.origin.repo, null);
  const r = await rename(p, path, "copy-me", true, t.io, { route: "copy", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "copied");
  assert.equal(r.branch, "copy-me");
  assert.deepEqual(renamedOnGitHub(t.gh), []);
  assert.deepEqual(pushes(t.git), ["push --force-with-lease=refs/heads/copy-me: origin refs/remotes/origin/keep-me:refs/heads/copy-me"]);
  const after = onOrigin(p);
  assert.equal(after["keep-me"], theirs, "origin keeps the old branch");
  assert.equal(after["copy-me"], theirs, "the copy is origin's commit, not the unpushed one");
  assert.notEqual(after["copy-me"], mine);
  assert.equal(sh(p.path, ["rev-parse", "copy-me"]), mine, "the local branch keeps its commit");
  assert.equal(upstream(p, "copy-me"), "origin/copy-me");
  const loggedOut = githubIo(p, { push: "logged-out" });
  const other = pushed(p, "other");
  assert.equal((await renameCheck({ project: p.path, path: other, name: "x" }, loggedOut.io)).origin.route, "copy", "gh exits 4: not logged in");
});

test("rename (T9c 6): an origin that isn't GitHub → the copy path; gh is never asked", async () => {
  const p = makeProject("not-github");
  const path = pushed(p, "plain");
  const local = githubIo(p, { url: p.origin });
  const c = await renameCheck({ project: p.path, path, name: "plainer" }, { ...local.io, git: io.git });
  assert.equal(c.origin.route, "copy", "a local path");
  const lab = githubIo(p, { url: "git@gitlab.example:acme/shop.git" });
  const r = await rename(p, path, "plainer", true, lab.io, { route: "copy", prs: [] });
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "copied");
  assert.deepEqual(local.gh, []);
  assert.deepEqual(lab.gh, [], "not GitHub: no gh at all");
  assert.ok("plain" in onOrigin(p) && "plainer" in onOrigin(p));
});

test("rename (T9c 7): permissions.push false → refused, nothing runs", async () => {
  const p = makeProject("no-push");
  const path = pushed(p, "theirs");
  const t = githubIo(p, { push: "false" });
  const r = await rename(p, path, "mine", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "no-push");
  assert.equal(r.err, "You can't push to acme/shop.");
  assert.deepEqual(renamedOnGitHub(t.gh), []);
  assert.deepEqual(pushes(t.git), []);
  assert.deepEqual(heads(p), ["main", "theirs"]);
});

test("rename (T9c 8): a push that rejects → failed, with the old branch and its upstream unchanged", async () => {
  const p = makeProject("push-rejects");
  const path = pushed(p, "stay");
  const t = githubIo(p, { push: "missing", wrap: (g) => async (cwd, args) => {
    if (isPush(args)) throw new Error("timed out after 30s");
    return g(cwd, args);
  } });
  const r = await rename(p, path, "go", true, t.io, { route: "copy", prs: [] });
  assert.equal(r.status, "failed");
  assert.equal(r.remote, null);
  assert.equal(r.branch, "stay");
  assert.equal(r.folder, null);
  assert.equal(r.err, "git didn't answer in time; the push may still finish. Nothing changed here. If `git ls-remote origin refs/heads/go` lists it, run `git branch -m stay go`; otherwise try again.");
  assert.equal(has(p, "stay"), true);
  assert.equal(has(p, "go"), false);
  assert.equal(upstream(p, "stay"), "origin/stay");
  assert.ok(existsSync(path));
  assert.ok(!("go" in onOrigin(p)));
});

test("rename (T9c 9): branch -m fails after the remote is done → renamed there, branch <old> here, and the fix", async () => {
  const p = makeProject("split");
  const path = pushed(p, "half-done");
  const t = githubIo(p, { wrap: (g) => async (cwd, args) => {
    if (args[0] === "branch" && args[1] === "-m") throw new Error("timed out after 30s");
    return g(cwd, args);
  } });
  const r = await rename(p, path, "all-done", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "renamed");
  assert.equal(r.remote, "renamed");
  assert.equal(r.branch, "half-done");
  assert.equal(r.name, "all-done");
  assert.equal(r.folder, "stays", "the folder isn't named after a branch it doesn't have");
  assert.equal(r.err, "Renamed on GitHub to all-done, but the local branch is still half-done: run `git branch -m half-done all-done`.");
  assert.ok(existsSync(path));
  assert.ok("all-done" in onOrigin(p));

  const q = makeProject("split-copy");
  const qpath = pushed(q, "half");
  const u = githubIo(q, { push: "missing", wrap: (g) => async (cwd, args) => {
    if (args[0] === "branch" && args[1] === "-m") return { ok: false, out: "", err: "fatal: no" };
    return g(cwd, args);
  } });
  const s = await rename(q, qpath, "whole", true, u.io, { route: "copy", prs: [] });
  assert.deepEqual([s.status, s.remote, s.branch], ["renamed", "copied", "half"]);
  assert.equal(s.err, "Pushed a copy as whole, but the local branch is still half: run `git branch -m half whole`.");
});

test("rename (T9c 10): origin already has <new> → refused; origin with only someone/<new> doesn't count", async () => {
  const p = makeProject("taken-there");
  const path = pushed(p, "mine");
  sh(p.origin, ["branch", "theirs", "main"]);
  const t = githubIo(p);
  const r = await rename(p, path, "theirs", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "remote-exists");
  assert.equal(r.err, "origin already has theirs.");
  assert.deepEqual(renamedOnGitHub(t.gh), []);
  sh(p.origin, ["branch", "someone/fresh", "main"]);
  const f = await rename(p, path, "fresh", true, t.io, { route: "github", prs: [] });
  assert.equal(f.status, "renamed", f.err);
  assert.equal(f.remote, "renamed");
  assert.ok("someone/fresh" in onOrigin(p) && "fresh" in onOrigin(p));
  sh(p.path, ["fetch", "-q", "origin"]);
  const local = addWorkspace(p, "local-only");
  const l = await rename(p, local, "theirs");
  assert.equal(l.reason, "remote-exists", "a remote copy as the last fetch saw it: the cheap first filter, offline");
  assert.equal(l.err, "origin already has theirs.");
});

test("rename (T9c 13): the open PRs come with the check; a PR list that fails → only the copy path", async () => {
  const p = makeProject("prs");
  const path = pushed(p, "reviewed");
  const t = githubIo(p, { prs: [12] });
  const c = await renameCheck({ project: p.path, path, name: "reviewed-2" }, t.io);
  assert.equal(c.origin.route, "github");
  assert.deepEqual(c.origin.prs, [{ number: 12, url: "https://github.example/acme/shop/pull/12" }]);
  assert.ok(t.gh.some((g) => g.startsWith("api repos/acme/shop/pulls?state=open&head=acme:reviewed ")), t.gh.join("\n"));
  const r = await rename(p, path, "reviewed-2", true, t.io, { route: "github", prs: [12] });
  assert.equal(r.status, "renamed", "Rename anyway: the PR was shown");
  assert.deepEqual(r.prs, [{ number: 12, url: "https://github.example/acme/shop/pull/12" }]);
  const q = makeProject("prs-fail");
  const qpath = pushed(q, "unknown");
  const u = githubIo(q, { pulls: "fails" });
  const f = await renameCheck({ project: q.path, path: qpath, name: "known" }, u.io);
  assert.equal(f.origin.route, "copy", "a PR list that fails: GitHub isn't offered");
  assert.deepEqual(f.origin.prs, []);
});

test("rename (T9c 14): an ls-remote that fails or is cut off → refused, 'Couldn't reach origin', nothing runs", async () => {
  const p = makeProject("offline");
  const path = pushed(p, "far");
  sh(p.path, ["remote", "set-url", "origin", join(root, "nowhere.git")]);
  const r = await rename(p, path, "away", true, io, { route: "copy", prs: [] });
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "unreachable");
  assert.match(r.err, /^Couldn't reach origin: .+\.$/);
  assert.equal(r.err.split("\n").length, 1);
  sh(p.path, ["remote", "set-url", "origin", p.origin]);
  const cut = { git: async (cwd, args) => {
    if (isLsRemote(args)) throw new Error("timed out after 30s");
    return io.git(cwd, args);
  }, exists };
  const c = await rename(p, path, "away", true, cut, { route: "copy", prs: [] });
  assert.equal(c.reason, "unreachable");
  assert.equal(c.err, "Couldn't reach origin: timed out after 30s.");
  const leaky = { git: async (cwd, args) => isLsRemote(args)
    ? { ok: false, out: "", err: "fatal: unable to access 'https://x-access:s3cret@github.example/acme/shop.git/': timeout" }
    : io.git(cwd, args), exists };
  const l = await rename(p, path, "away", true, leaky, { route: "copy", prs: [] });
  assert.equal(l.err, "Couldn't reach origin: fatal: unable to access 'https://github.example/acme/shop.git/': timeout.", "a URL's userinfo never shows");
  assert.deepEqual(heads(p), ["far", "main"]);
  assert.ok(!("away" in onOrigin(p)));
});

test("rename (T9c 16): a taken folder name refuses only when the folder would move; otherwise only the branch is renamed", async () => {
  const p = makeProject("folder-stays");
  const path = addWorkspace(p, "here");
  const busy = join(p.ws, "busy");
  mkdirSync(busy, { recursive: true });
  const c = await renameCheck({ project: p.path, path, name: "busy", moveFolder: false }, io);
  assert.equal(c.status, "ok", c.err);
  assert.equal(c.folderTaken, true, "the dialog says it when the folder would move");
  const r = await rename(p, path, "busy", false);
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.branch, "busy");
  assert.equal(r.folder, "stays");
  assert.ok(existsSync(path));
  const moving = await rename(p, path, "here-again", true);
  assert.equal(moving.status, "renamed", "a free folder still moves");
  const blocked = await renameCheck({ project: p.path, path: join(p.ws, "here-again"), name: "busy-2" }, io);
  assert.equal(blocked.folderTaken, false);
});

test("rename (T9c 17): a pushed branch's path is known on open, before a name is typed", async () => {
  const p = makeProject("on-open");
  const path = pushed(p, "user/ready");
  const t = githubIo(p);
  const open = await renameCheck({ project: p.path, path, name: "user/ready" }, t.io);
  assert.equal(open.status, "refused");
  assert.equal(open.reason, "unchanged");
  assert.equal(open.origin.route, "github", "the dialog states the path with the prefill");
  assert.deepEqual(open.origin.repo, { owner: "acme", repo: "shop" });
  assert.ok(t.git.includes("ls-remote origin refs/heads/user/ready"), "only <old>: there is no new name yet");
  const copy = await renameCheck({ project: p.path, path, name: "" }, { ...io, gh: undefined });
  assert.equal(copy.reason, "empty");
  assert.equal(copy.origin.route, "copy");
  const plain = await renameCheck({ project: p.path, path: addWorkspace(p, "never-pushed"), name: "never-pushed" }, io);
  assert.deepEqual([plain.reason, plain.origin.published, plain.origin.route], ["unchanged", false, "local"]);
});

test("rename (T9c 19): a gh that refuses (exit 1) → failed with gh's first line; no poll, no push", async () => {
  const p = makeProject("gh-refuses");
  const path = pushed(p, "protected");
  const t = githubIo(p, { rename: "refuses" });
  const r = await rename(p, path, "unprotected", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "failed");
  assert.equal(r.err, "gh: Validation Failed (HTTP 422)");
  assert.equal(r.remote, null);
  assert.deepEqual(t.sleeps, []);
  assert.deepEqual(pushes(t.git), []);
  assert.deepEqual(heads(p), ["main", "protected"]);
  assert.equal(upstream(p, "protected"), "origin/protected");
});

test("rename (T9c 20): a gh cut off, with nothing on origin after the bound → failed with that text; no push", async () => {
  const p = makeProject("gh-cut");
  const path = pushed(p, "waiting");
  const t = githubIo(p, { rename: "cut" });
  const r = await rename(p, path, "waited", true, t.io, { route: "github", prs: [] });
  assert.equal(r.status, "failed");
  assert.equal(r.err, "GitHub didn't answer in time; it may still finish. Nothing changed here. If `git ls-remote origin refs/heads/waited` lists it, run `git branch -m waiting waited`; otherwise try again.");
  assert.equal(t.sleeps.length, POLL.tries - 1, "bounded");
  assert.ok(t.git.filter((c) => c.startsWith("ls-remote")).length <= POLL.tries + 1);
  assert.deepEqual(pushes(t.git), []);
  assert.deepEqual(heads(p), ["main", "waiting"]);
  const stop = githubIo(p, { rename: "cut" });
  stop.io.sleep = async () => { throw new Error("cx is gone"); };
  const s = await rename(p, path, "waited", true, stop.io, { route: "github", prs: [] });
  assert.equal(s.status, "failed", "a sleep that throws ends the wait, not the sequence");
  assert.match(s.err, /^GitHub didn't answer in time/);
});

test("rename (T9c 21): an empty PR list on open and one PR at the click → changed; gh's rename never runs", async () => {
  const p = makeProject("pr-appears");
  const path = pushed(p, "quiet");
  const t = githubIo(p, { prs: [] });
  const open = await renameCheck({ project: p.path, path, name: "loud" }, t.io);
  const seen = { route: open.origin.route, prs: open.origin.prs.map((pr) => pr.number) };
  assert.deepEqual(seen, { route: "github", prs: [] });
  t.fake.prs = [7];
  const r = await rename(p, path, "loud", true, t.io, seen);
  assert.equal(r.status, "changed");
  assert.equal(r.err, "PR #7 was opened from quiet since the dialog checked it.");
  assert.deepEqual(r.check.origin.prs, [{ number: 7, url: "https://github.example/acme/shop/pull/7" }], "the fresh check, for the dialog to show");
  assert.deepEqual(renamedOnGitHub(t.gh), []);
  assert.deepEqual(heads(p), ["main", "quiet"]);
  const route = await rename(p, path, "loud", true, t.io, { route: "copy", prs: [7] });
  assert.equal(route.status, "changed", "the dialog said copy; it would be GitHub now");
  assert.equal(route.err, "origin changed since the dialog checked it; check what Rename does now.");
  const unseen = await rename(p, path, "loud", true, t.io);
  assert.equal(unseen.status, "changed", "no seen: nothing remote runs");
  assert.deepEqual(renamedOnGitHub(t.gh), []);
});

test("rename (T9c 22): a branch that only tracks origin/main stays offline: an ls-remote that would fail is never asked", async () => {
  const p = makeProject("offline-tracks");
  const path = addWorkspace(p, "starts-at-main", { track: true });
  const t = githubIo(p, { wrap: (g) => async (cwd, args) => {
    if (isLsRemote(args)) throw new Error("no network");
    return g(cwd, args);
  } });
  const r = await rename(p, path, "still-local", true, t.io);
  assert.equal(r.status, "renamed", r.err);
  assert.equal(r.remote, "none");
  assert.equal(upstream(p, "still-local"), null, "the upstream with another name is unset");
  assert.deepEqual(t.gh, []);
});

// git can't have a branch that is another's folder: with feat, no feat/x;
// with feat/x, no feat. Found only at `branch -m`, after origin got the new
// name, it would split the two sides.
const isBranchMove = (c) => c.startsWith("branch -m");

test("rename: a local branch in the way of the new name (feat for feat/x, feat/x for feat) → refused before anything runs", async () => {
  const p = makeProject("in-the-way");
  const path = pushed(p, "other");
  sh(p.path, ["branch", "feat"]);
  const t = githubIo(p, { push: "missing" });
  const under = await rename(p, path, "feat/x", true, t.io, { route: "copy", prs: [] });
  assert.equal(under.status, "refused", under.err);
  assert.equal(under.reason, "branch-exists");
  assert.equal(under.err, "Branch feat already exists: git can't also have feat/x.");
  assert.equal(under.branch, "other");
  const deep = await renameCheck({ project: p.path, path, name: "feat/x/y" }, t.io);
  assert.equal(deep.err, "Branch feat already exists: git can't also have feat/x/y.", "any parent, not only the first");
  assert.deepEqual(heads(p), ["feat", "main", "other"]);

  const q = makeProject("in-the-way-under");
  const qpath = pushed(q, "other");
  sh(q.path, ["branch", "feat/x"]);
  const u = githubIo(q, { push: "missing" });
  const over = await rename(q, qpath, "feat", true, u.io, { route: "copy", prs: [] });
  assert.equal(over.status, "refused", over.err);
  assert.equal(over.reason, "branch-exists");
  assert.equal(over.err, "Branch feat/x already exists: git can't also have feat.");
  assert.deepEqual(heads(q), ["feat/x", "main", "other"]);

  for (const calls of [t.git, u.git]) {
    assert.deepEqual(calls.filter((c) => isLsRemote(c.split(" ")) || c.startsWith("push ") || isBranchMove(c)), [], "no ls-remote, no push, no branch -m");
  }
  assert.deepEqual([...renamedOnGitHub(t.gh), ...renamedOnGitHub(u.gh)], []);
  assert.deepEqual(Object.keys(onOrigin(p)).sort(), ["main", "other"], "origin gets nothing");
  assert.deepEqual(Object.keys(onOrigin(q)).sort(), ["main", "other"]);
});

test("rename: a sibling (feat/y next to feat/x, feat-x next to feat) or the branch's own path (solo → solo/inner → solo) isn't in the way", async () => {
  const p = makeProject("not-in-the-way");
  sh(p.path, ["branch", "feat/x"]);
  sh(p.path, ["branch", "feat-x"]);
  const path = addWorkspace(p, "other");
  const sibling = await renameCheck({ project: p.path, path, name: "feat/y" }, io);
  assert.equal(sibling.status, "ok", sibling.err);
  const near = await renameCheck({ project: p.path, path, name: "feat-x/z" }, io);
  assert.equal(near.status, "refused", "feat-x is a parent of feat-x/z");
  const solo = addWorkspace(p, "solo");
  const inner = await rename(p, solo, "solo/inner");
  assert.equal(inner.status, "renamed", inner.err);
  assert.equal(inner.branch, "solo/inner", "git moves a branch into its own path");
  const back = await rename(p, join(p.ws, "inner"), "solo");
  assert.equal(back.status, "renamed", back.err);
  assert.equal(back.branch, "solo", "and out of it");
  assert.equal(has(p, "solo/inner"), false);
});

test("rename: origin's branch in the way of the new name → refused before anything runs, from origin itself or from the last fetch", async () => {
  const p = makeProject("origin-in-the-way");
  const path = pushed(p, "other");
  sh(p.origin, ["branch", "feat", "main"]);
  sh(p.origin, ["branch", "ui/x", "main"]);
  const t = githubIo(p);
  const under = await rename(p, path, "feat/x", true, t.io, { route: "github", prs: [] });
  assert.equal(under.status, "refused", under.err);
  assert.equal(under.reason, "remote-exists");
  assert.equal(under.err, "origin already has feat: git can't also have feat/x.");
  const over = await rename(p, path, "ui", true, t.io, { route: "github", prs: [] });
  assert.equal(over.status, "refused", over.err);
  assert.equal(over.reason, "remote-exists");
  assert.equal(over.err, "origin already has ui/x: git can't also have ui.");
  assert.ok(t.git.some((c) => isLsRemote(c.split(" "))), "not fetched: origin itself says it");
  assert.deepEqual(t.git.filter((c) => c.startsWith("push ") || isBranchMove(c)), [], "no push, no branch -m");
  assert.deepEqual(t.gh, [], "GitHub is never asked");

  sh(p.path, ["fetch", "-q", "origin"]);
  const local = addWorkspace(p, "local-only");
  const c = githubIo(p);
  const offline = await rename(p, local, "feat/x", true, c.io);
  assert.equal(offline.status, "refused", offline.err);
  assert.equal(offline.reason, "remote-exists");
  assert.equal(offline.err, "origin already has feat: git can't also have feat/x.");
  assert.deepEqual(c.git.filter((x) => isLsRemote(x.split(" ")) || x.startsWith("push ") || isBranchMove(x)), [], "the cheap first filter, offline: no ls-remote");
  assert.deepEqual(heads(p), ["local-only", "main", "other"]);
  assert.deepEqual(Object.keys(onOrigin(p)).sort(), ["feat", "main", "other", "ui/x"], "origin gets nothing");
  assert.deepEqual(GIT.branchesNear("a/b/c"), ["for-each-ref", "--format=%(refname)", "refs/heads/a", "refs/heads/a/b", "refs/heads/a/b/c/"]);
  assert.deepEqual(GIT.remotesNear("a/b"), ["for-each-ref", "--format=%(refname)", "refs/remotes/*/a", "refs/remotes/*/a/b/**"], "`*` is one segment, `**` crosses them");
  assert.deepEqual(GIT.lsRemoteNear("o", "a/b"), ["ls-remote", "origin", "refs/heads/o", "refs/heads/a/b", "refs/heads/a", "refs/heads/a/b/*"]);
  assert.deepEqual(GIT.lsRemoteNear("o", null), GIT.lsRemote("o", null), "no name yet: only <old>");
});

test("rename (T9c): remoteOutcome decides from origin's state after the call, never from the call alone (D28 step 2)", () => {
  const base = { old: "a", name: "b", sha: "s1" };
  const after = (from, to) => ({ ok: true, from, to, err: "" });
  const did = (o) => [o.done, o.remote, o.note || o.err || ""];
  const ok = { ok: true, rejected: false, err: "" };
  const cut = { ok: false, rejected: true, err: "timed out after 30s" };
  const refused = { ok: false, rejected: false, err: "! [rejected] origin/a -> b (stale info)" };
  const retry = "If `git ls-remote origin refs/heads/b` lists it, run `git branch -m a b`; otherwise try again.";
  const table = [
    [{ route: "copy", call: ok, after: after("s1", "s1"), bound: true }, [true, "copied", ""]],
    [{ route: "copy", call: cut, after: after("s1", "s1"), bound: true }, [true, "copied", ""], "the push went before exec gave up"],
    [{ route: "copy", call: refused, after: after("s1", null), bound: true }, [true, null, refused.err]],
    [{ route: "copy", call: cut, after: after("s1", null), bound: true }, [true, null, `git didn't answer in time; the push may still finish. Nothing changed here. ${retry}`]],
    [{ route: "copy", call: ok, after: { ok: false, from: null, to: null, err: "fatal: x" }, bound: true }, [true, null, `Couldn't see b on origin after the push: fatal: x. Nothing changed here. ${retry}`]],
    [{ route: "github", call: refused, after: after("s1", null), bound: false }, [true, null, refused.err], "refused: no poll"],
    [{ route: "github", call: ok, after: after(null, "s1"), bound: false }, [true, "renamed", ""]],
    [{ route: "github", call: cut, after: after(null, "s1"), bound: false }, [true, "renamed", ""]],
    [{ route: "github", call: ok, after: after("s1", "s1"), bound: false }, [false, undefined, ""], "both there: look again"],
    [{ route: "github", call: ok, after: after("s1", null), bound: false }, [false, undefined, ""]],
    [{ route: "github", call: ok, after: after("s1", "s1"), bound: true }, [true, "renamed", "GitHub is still finishing the rename."]],
    [{ route: "github", call: cut, after: after("s1", null), bound: true }, [true, null, `GitHub didn't answer in time; it may still finish. Nothing changed here. ${retry}`]],
    [{ route: "github", call: ok, after: after("s1", "s9"), bound: false }, [true, null, "origin's b is on another commit: it is someone else's branch. Nothing changed here."]],
    [{ route: "copy", call: ok, after: after("s1", "s9"), bound: true }, [true, null, "origin's b is on another commit: it is someone else's branch. Nothing changed here."]],
  ];
  for (const [input, want, why] of table) {
    const got = did(remoteOutcome({ ...base, ...input }));
    if (want[1] === undefined) assert.equal(got[0], false, why);
    else assert.deepEqual(got, want, why ?? JSON.stringify(input));
  }
  assert.deepEqual(remoteHeads("s1\trefs/heads/a\ns2\trefs/heads/someone/b\n", "a", "b"), { from: "s1", to: null }, "exact refnames only");
  assert.deepEqual(remoteHeads("s1\trefs/heads/a\ns2\trefs/heads/b", "a", "b"), { from: "s1", to: "s2" });
  assert.deepEqual(remoteHeads("", "a", null), { from: null, to: null });
});

test("rename (T9c): the argv for origin and GitHub — every remote ref, exact refnames, one ref fetched, a lease on the copy, each / segment encoded", () => {
  assert.deepEqual(GIT.remoteRefs("x/y"), ["for-each-ref", "--format=%(refname)", "refs/remotes/*/x/y"], "no --count=1");
  assert.deepEqual(GIT.lsRemote("a", "b"), ["ls-remote", "origin", "refs/heads/a", "refs/heads/b"]);
  assert.deepEqual(GIT.lsRemote("a", null), ["ls-remote", "origin", "refs/heads/a"]);
  assert.deepEqual(GIT.fetchRef("a"), ["fetch", "--no-tags", "origin", "+refs/heads/a:refs/remotes/origin/a"]);
  assert.deepEqual(GIT.copy("a", "b"), ["push", "--force-with-lease=refs/heads/b:", "origin", "refs/remotes/origin/a:refs/heads/b"]);
  assert.ok(!GIT.copy("a", "b").includes("--no-verify"), "the person's hooks run");
  assert.deepEqual(GIT.setMerge("b"), ["config", "--replace-all", "branch.b.merge", "refs/heads/b"]);
  const repo = { owner: "acme", repo: "shop" };
  assert.deepEqual(GH.canPush(repo), ["api", "repos/acme/shop", "--jq", ".permissions.push"]);
  assert.deepEqual(GH.rename(repo, "user/feat#12", "user/b"), ["api", "-X", "POST", "repos/acme/shop/branches/user/feat%2312/rename", "-f", "new_name=user/b"]);
  assert.deepEqual(GH.pulls(repo, "user/a+b"), ["api", "repos/acme/shop/pulls?state=open&head=acme:user/a%2Bb", "--jq", '.[] | "\\(.number) \\(.html_url)"']);
});
