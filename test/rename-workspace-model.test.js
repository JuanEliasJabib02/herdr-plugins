// T9a: the Rename model (M/rename-workspace-model.js), D25–D26. The name a
// rename gives (each `/` segment slugged like D12, text equal to the old
// branch unchanged), and the rename itself against real git in throwaway
// repos: the checks that refuse it, the branch, the folder, and outcomes
// that read git's state, never its words (same under es_ES).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, existsSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT, branchName, renameTarget, folderFor, renameCheck, renameWorkspace,
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
const rename = (p, path, name, moveFolder = true, with_ = io) => renameWorkspace({ project: p.path, path, name, moveFolder }, with_);

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

test("rename: published by an upstream with its own name → refused, nothing renamed, also once gone from the remote", async () => {
  const p = makeProject("upstream");
  const path = addWorkspace(p, "shipped");
  sh(path, ["push", "-q", "-u", "origin", "shipped"]);
  assert.equal(upstream(p, "shipped"), "origin/shipped");
  const r = await rename(p, path, "other");
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "published");
  assert.equal(r.err, "Already pushed as origin/shipped: renaming would split it from GitHub.");
  assert.equal(r.folder, null);
  sh(path, ["push", "-q", "origin", "--delete", "shipped"]);
  assert.equal(sh(p.path, ["for-each-ref", "refs/remotes/origin/shipped"]), "", "no origin/shipped left");
  assert.equal(merge(p, "shipped"), "refs/heads/shipped", "the upstream is still set ([gone])");
  const gone = await rename(p, path, "other");
  assert.equal(gone.status, "refused");
  assert.equal(gone.reason, "published");
  assert.equal(gone.err, "Already pushed as origin/shipped: renaming would split it from GitHub.");
  assert.equal(has(p, "shipped"), true);
  assert.equal(has(p, "other"), false);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(join(p.ws, "other")));
});

test("rename: published by <remote>/<b> without an upstream → refused, on origin or on any other remote", async () => {
  const p = makeProject("pushed");
  const path = addWorkspace(p, "loose");
  sh(path, ["push", "-q", "origin", "loose"]);
  assert.equal(upstream(p, "loose"), null, "pushed without -u");
  const r = await rename(p, path, "tight");
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "published");
  assert.equal(r.err, "Already pushed as origin/loose: renaming would split it from GitHub.");
  const mirror = join(root, "origins", `${p.name}-mirror.git`);
  sh(root, ["init", "-q", "--bare", mirror]);
  sh(p.path, ["remote", "add", "github", mirror]);
  const elsewhere = addWorkspace(p, "elsewhere");
  sh(elsewhere, ["push", "-q", "github", "elsewhere"]);
  const g = await rename(p, elsewhere, "moved-on");
  assert.equal(g.status, "refused");
  assert.equal(g.reason, "published");
  assert.equal(g.err, "Already pushed as github/elsewhere: renaming would split it from GitHub.");
  assert.equal(has(p, "loose"), true);
  assert.equal(has(p, "elsewhere"), true);
  assert.equal(has(p, "tight"), false);
  assert.equal(has(p, "moved-on"), false);
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

test("rename: the outcomes are the same under LANG=es_ES.UTF-8", async (t) => {
  const bin = translatingGit();
  if (!bin) t.diagnostic("no git on PATH translates its messages: the es_ES run uses the default git");
  const outcomes = async (extra) => {
    const local = { git: makeGit(bin ?? "git", extra), exists };
    const p = makeProject("locale");
    const free = addWorkspace(p, "free");
    const pushed = addWorkspace(p, "pushed");
    sh(pushed, ["push", "-q", "-u", "origin", "pushed"]);
    const locked = addWorkspace(p, "locked");
    sh(p.path, ["worktree", "lock", "--reason", "usb", locked]);
    const clash = addWorkspace(p, "clash");
    sh(p.path, ["branch", "taken"]);
    const detached = join(p.ws, "detached");
    sh(p.path, ["worktree", "add", "-q", "--detach", detached, "origin/main"]);
    const tracks = addWorkspace(p, "tracks", { track: true });
    const pick = ({ status, reason, branch, folder }) => ({ status, reason, branch, folder });
    const lockedResult = await rename(p, locked, "unlocked", true, local);
    return {
      outcomes: {
        free: pick(await rename(p, free, "freed", true, local)),
        pushed: pick(await rename(p, pushed, "unpushed", true, local)),
        locked: pick(lockedResult),
        clash: pick(await rename(p, clash, "taken", true, local)),
        detached: pick(await rename(p, detached, "attached", true, local)),
        tracks: { ...pick(await rename(p, tracks, "untracked", true, local)), upstream: upstream(p, "untracked") },
      },
      lockedErr: lockedResult.err,
    };
  };
  const english = await outcomes(C);
  const spanish = await outcomes(ES);
  assert.deepEqual(spanish.outcomes, english.outcomes);
  assert.deepEqual(english.outcomes.free, { status: "renamed", reason: null, branch: "freed", folder: "moved" });
  assert.deepEqual(english.outcomes.locked, { status: "renamed", reason: null, branch: "unlocked", folder: "kept" });
  assert.equal(english.outcomes.pushed.reason, "published");
  assert.equal(english.outcomes.tracks.upstream, null);
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
