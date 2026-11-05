// T7: Delete's model (M/remove-workspace-model.js, D22–D24): removalCheck
// (on a fresh list: changes, submodules by git's own refusal test, the lock,
// the branch), removeWorkspace's order (check again → close the spaces →
// remove → the branch → the fresh list), and spacesToClose. The git cases run
// against a real git in throwaway repos; outcomes come from git's state, never
// from its words, so one case runs under LANG=es_ES.UTF-8 too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  GIT, lockOf, removalCheck, removeWorkspace, spacesToClose,
} from "../projects-sidebar/mods/projects/remove-workspace-model.js";

// ── Real git (throwaway repos, no global config or hooks) ──────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), "projects-sidebar-rm-")));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SPANISH = { LANG: "es_ES.UTF-8", LC_ALL: "es_ES.UTF-8", LANGUAGE: "es" };
const sh = (cwd, args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, stdio: "pipe" }).toString().trim();
// The same shape as M/git.js's git(cwd, args), in the given locale.
const gitIn = (extra = {}) => (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...env, ...extra } }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || stdout).trim() });
  });
});
const realGit = gitIn();
const exists = async (p) => existsSync(p);

// An io whose git and closeSpaces write what they did to `calls`, in order:
// "closeSpaces", or git's argv joined by spaces.
function recording(git = realGit, closeSpaces = async () => {}) {
  const calls = [];
  return {
    calls,
    io: {
      git: async (cwd, args) => {
        calls.push(args.join(" "));
        return git(cwd, args);
      },
      exists,
      closeSpaces: async () => {
        calls.push("closeSpaces");
        await closeSpaces();
      },
    },
  };
}
const ran = (calls, prefix) => calls.filter((c) => c.startsWith(prefix));

// A repo with one commit on main and a tracked file.
function makeRepo(name) {
  const path = join(root, "code", name);
  mkdirSync(path, { recursive: true });
  sh(path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(path, "readme.md"), "hello\n");
  sh(path, ["add", "readme.md"]);
  sh(path, ["commit", "-q", "-m", "first"]);
  return path;
}

// A linked worktree of `repo` at <root>/ws/<repo>/<name>: on a new branch
// <name> from main by default, else `args` (between `add` and the path).
function addWorktree(repo, name, args = null, start = ["main"]) {
  const path = join(root, "ws", basename(repo), name);
  sh(repo, ["worktree", "add", "-q", ...(args ?? ["-b", name]), path, ...start]);
  return path;
}

const hasBranch = (repo, branch) => {
  try {
    sh(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};
const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// ── 1. A clean workspace ───────────────────────────────────────────────────

test("1. clean → removed, its merged branch deleted, the fresh list without it", async () => {
  const repo = makeRepo("clean");
  const wt = addWorktree(repo, "feat");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.deletable, true);
  assert.equal(check.failed, false);
  assert.equal(check.reason, "");
  assert.deepEqual([check.changes, check.submodules, check.locked, check.lockReason], [false, false, false, null]);
  assert.equal(check.branch, "feat");
  assert.equal(check.mainBranch, "main");
  assert.deepEqual(check.list.map((c) => [c.path, c.branch, c.main]), [[repo, "main", true], [wt, "feat", false]]);

  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  assert.equal(r.err, null);
  assert.equal(r.branch, "deleted");
  assert.equal(r.branchErr, null);
  assert.deepEqual(r.list, [{ path: repo, branch: "main", main: true }], "the fresh list, without the workspace");
  assert.ok(!existsSync(wt), "the folder is gone");
  assert.equal(hasBranch(repo, "feat"), false, "the merged branch is gone");
  assert.deepEqual(ran(calls, "closeSpaces").length, 1);
  assert.deepEqual(ran(calls, "worktree remove"), [`worktree remove -- ${wt}`], "no --force on a clean workspace");
  assert.deepEqual(ran(calls, "branch "), ["branch -d -- feat"], "the safe -d, never -D");
});

// ── 2. An unmerged branch ──────────────────────────────────────────────────

for (const [locale, extra] of [["the default locale", {}], ["LANG=es_ES.UTF-8", SPANISH]]) {
  test(`2. unmerged branch → removed, branch kept with git's first line (${locale})`, async () => {
    const repo = makeRepo(`unmerged-${extra.LANG ? "es" : "en"}`);
    const wt = addWorktree(repo, "work");
    writeFileSync(join(wt, "work.txt"), "work\n");
    sh(wt, ["add", "work.txt"]);
    sh(wt, ["commit", "-q", "-m", "work"]);
    const git = gitIn(extra);
    const check = await removalCheck({ project: repo, path: wt }, { git, exists });
    assert.equal(check.deletable, true);
    assert.equal(check.changes, false, "committed work is no change");
    const r = await removeWorkspace({ project: repo, path: wt, seen: check }, { git, exists, closeSpaces: async () => {} });
    assert.equal(r.status, "removed");
    assert.ok(!existsSync(wt));
    assert.equal(r.branch, "kept");
    assert.equal(hasBranch(repo, "work"), true, "branch -d keeps a branch with unmerged commits");
    assert.equal(typeof r.branchErr, "string");
    assert.ok(r.branchErr.length > 0, "git's first line says why");
    assert.deepEqual(r.list.map((c) => c.path), [repo]);
  });
}

// ── 3. Changes the person saw and confirmed ────────────────────────────────

test("3. changes seen and confirmed → removed with one --force", async () => {
  const repo = makeRepo("dirty");
  const wt = addWorktree(repo, "dirty-work");
  writeFileSync(join(wt, "readme.md"), "edited\n");
  writeFileSync(join(wt, "new.txt"), "untracked\n");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.changes, true);
  assert.equal(check.deletable, true, "changes ask for Delete anyway, they don't forbid it");
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  assert.ok(!existsSync(wt));
  const removes = ran(calls, "worktree remove");
  assert.deepEqual(removes, [`worktree remove --force -- ${wt}`]);
  assert.equal(removes[0].split(" ").filter((a) => a === "--force" || a === "-f").length, 1, "forced once, never twice (a lock stays a lock)");
  assert.equal(r.branch, "deleted", "no commits: the branch is merged");
});

// ── 4. Changes that appeared after the check ───────────────────────────────

test("4. changes or submodules that appeared after the check → changed; closeSpaces never runs, the folder stays", async () => {
  const repo = makeRepo("appeared");
  const wt = addWorktree(repo, "late");
  const seen = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(seen.changes, false);
  writeFileSync(join(wt, "late.txt"), "written after the dialog opened\n");
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen }, io);
  assert.equal(r.status, "changed");
  assert.equal(r.check.changes, true, "the new check, for the dialog to show");
  assert.equal(r.branch, null);
  assert.deepEqual(ran(calls, "closeSpaces"), [], "no space closed");
  assert.deepEqual(ran(calls, "worktree remove"), []);
  assert.deepEqual(ran(calls, "branch "), []);
  assert.ok(existsSync(join(wt, "late.txt")), "the folder is intact");
  assert.equal(hasBranch(repo, "late"), true);

  // Changes confirmed, then a submodule folder shows up: still "changed".
  const confirmed = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(confirmed.changes, true);
  mkdirSync(sh(wt, ["rev-parse", "--git-path", "modules"]), { recursive: true });
  const again = recording();
  const r2 = await removeWorkspace({ project: repo, path: wt, seen: confirmed }, again.io);
  assert.equal(r2.status, "changed");
  assert.equal(r2.check.submodules, true);
  assert.deepEqual(ran(again.calls, "closeSpaces"), []);
  assert.ok(existsSync(wt));
});

// ── 5. Untracked files a config hides ──────────────────────────────────────

test("5. untracked files under status.showUntrackedFiles=no still count as changes", async () => {
  const repo = makeRepo("hidden-untracked");
  sh(repo, ["config", "status.showUntrackedFiles", "no"]);
  const wt = addWorktree(repo, "quiet");
  writeFileSync(join(wt, "notes.txt"), "not committed\n");
  assert.equal(sh(wt, ["status", "--porcelain"]), "", "the person's config hides it from a plain status");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.changes, true);
});

// ── 6. Submodules, by git's own refusal test ───────────────────────────────

test("6a. an initialized submodule → submodules true (git refuses a plain remove), removed once confirmed", async () => {
  const lib = makeRepo("sub-lib");
  const repo = makeRepo("with-sub");
  sh(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"]);
  sh(repo, ["commit", "-q", "-m", "add lib"]);
  const wt = addWorktree(repo, "feat-sub");
  sh(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.submodules, true);
  assert.equal(check.changes, false);
  assert.equal(check.deletable, true);
  assert.throws(() => sh(repo, ["worktree", "remove", "--", wt]), "git itself refuses it without --force");
  assert.ok(existsSync(wt));
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  assert.deepEqual(ran(calls, "worktree remove"), [`worktree remove --force -- ${wt}`]);
  assert.ok(!existsSync(wt));
});

test("6b. a leftover modules folder in the worktree's git dir, with no .gitmodules → submodules true", async () => {
  const repo = makeRepo("leftover-modules");
  const wt = addWorktree(repo, "failed-init");
  const modules = sh(wt, ["rev-parse", "--git-path", "modules"]);
  assert.ok(modules.includes("/worktrees/"), `the worktree's own git dir: ${modules}`);
  mkdirSync(modules, { recursive: true });
  assert.ok(!existsSync(join(wt, ".gitmodules")));
  assert.equal(sh(wt, ["status", "--porcelain", "--ignore-submodules=none"]), "", "status sees nothing");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.submodules, true);
  assert.equal(check.changes, false);
  assert.throws(() => sh(repo, ["worktree", "remove", "--", wt]), "git refuses it too");
  assert.ok(existsSync(wt));
});

test("6c. a committed gitlink with no .gitmodules, cloned inside the worktree → submodules true", async () => {
  const inner = makeRepo("inner-src");
  const repo = makeRepo("gitlink");
  sh(repo, ["clone", "-q", inner, "vendored"]);
  sh(repo, ["-c", "advice.addEmbeddedRepo=false", "add", "vendored"]);
  sh(repo, ["commit", "-q", "-m", "vendor"]);
  assert.match(sh(repo, ["ls-files", "--stage", "vendored"]), /^160000 /, "a gitlink");
  const wt = addWorktree(repo, "feat-gitlink");
  assert.ok(!existsSync(join(wt, ".gitmodules")));
  const empty = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(empty.submodules, false, "not checked out: git doesn't refuse it either");
  sh(wt, ["clone", "-q", inner, "vendored"]);
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.submodules, true);
  assert.throws(() => sh(repo, ["worktree", "remove", "--", wt]), "git refuses it");
  assert.ok(existsSync(join(wt, "vendored", ".git")), "the inner repo survives");
});

// ── 7. A locked worktree ───────────────────────────────────────────────────

test("lockOf reads the locked line that parseWorktrees drops", () => {
  const out = [
    "worktree /code/app", "HEAD 1", "branch refs/heads/main", "",
    "worktree /w/app/busy", "HEAD 1", "branch refs/heads/busy", "locked agent busy", "",
    "worktree /w/app/plain-lock", "HEAD 1", "detached", "locked", "",
    "worktree /w/app/free", "HEAD 1", "branch refs/heads/free",
  ].join("\n");
  assert.equal(lockOf(out, "/w/app/busy"), "agent busy");
  assert.equal(lockOf(out, "/w/app/busy/"), "agent busy", "paths compared normalized");
  assert.equal(lockOf(out, "/w/app/plain-lock"), "", "locked with no reason");
  assert.equal(lockOf(out, "/w/app/free"), null);
  assert.equal(lockOf(out, "/w/app/elsewhere"), null);
  assert.equal(lockOf("", "/w/app/busy"), null);
});

test("7. locked → locked with its reason; nothing ran", async () => {
  const repo = makeRepo("locked");
  const wt = addWorktree(repo, "busy");
  sh(repo, ["worktree", "lock", "--reason", "agent busy", wt]);
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.locked, true);
  assert.equal(check.lockReason, "agent busy");
  assert.equal(check.deletable, false);
  assert.equal(check.reason, `Locked by git: agent busy. Unlock it with \`git worktree unlock ${wt}\`.`);
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "locked");
  assert.match(r.err, /agent busy/);
  assert.deepEqual(ran(calls, "closeSpaces"), []);
  assert.deepEqual(ran(calls, "worktree remove"), []);
  assert.deepEqual(ran(calls, "branch "), []);
  assert.ok(existsSync(wt));
  assert.equal(hasBranch(repo, "busy"), true);

  const quiet = addWorktree(repo, "quiet-lock");
  sh(repo, ["worktree", "lock", quiet]);
  const plain = await removalCheck({ project: repo, path: quiet }, { git: realGit, exists });
  assert.equal(plain.locked, true);
  assert.equal(plain.lockReason, "");
  assert.equal(plain.reason, `Locked by git. Unlock it with \`git worktree unlock ${quiet}\`.`);
});

// ── 8. Not a workspace this dialog may delete ──────────────────────────────

test("8. the main checkout, or a path outside the list → refused; nothing ran", async () => {
  const repo = makeRepo("refuse");
  const other = makeRepo("refuse-other");
  const foreign = addWorktree(other, "theirs");
  const inside = join(repo, "docs");
  mkdirSync(inside);
  for (const path of [repo, `${repo}/`, inside, join(root, "nowhere"), foreign]) {
    const check = await removalCheck({ project: repo, path }, { git: realGit, exists });
    assert.equal(check.deletable, false, path);
    assert.equal(check.failed, false, path);
    assert.ok(check.reason.length > 0, path);
    const { calls, io } = recording();
    const r = await removeWorkspace({ project: repo, path, seen: check }, io);
    assert.equal(r.status, "refused", path);
    assert.equal(r.err, check.reason);
    assert.deepEqual(ran(calls, "closeSpaces"), [], path);
    assert.deepEqual(ran(calls, "worktree remove"), [], path);
    assert.deepEqual(ran(calls, "branch "), [], path);
  }
  assert.ok(existsSync(join(repo, "readme.md")) && existsSync(foreign));
  assert.match((await removalCheck({ project: repo, path: repo }, { git: realGit, exists })).reason, /main checkout/);
});

// ── 9. A branch another checkout is on ─────────────────────────────────────

test("9. a branch also checked out elsewhere (worktree add -f) → in-use; branch -d never runs", async () => {
  const repo = makeRepo("shared-branch");
  const wt = addWorktree(repo, "shared");
  const twin = addWorktree(repo, "shared-twin", ["-f"], ["shared"]);
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  assert.equal(r.branch, "in-use");
  assert.deepEqual(ran(calls, "branch "), []);
  assert.equal(hasBranch(repo, "shared"), true);
  assert.ok(existsSync(twin));
  assert.deepEqual(r.list.map((c) => [c.path, c.branch]), [[repo, "main"], [twin, "shared"]]);
});

// ── 10. Detached HEAD ──────────────────────────────────────────────────────

test("10. detached HEAD → removed, branch none", async () => {
  const repo = makeRepo("detached");
  const wt = addWorktree(repo, "loose", ["--detach"]);
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  assert.equal(check.branch, null);
  assert.equal(check.deletable, true);
  const { calls, io } = recording();
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  assert.equal(r.branch, "none");
  assert.deepEqual(ran(calls, "branch "), []);
  assert.ok(!existsSync(wt));
});

// ── 11. When git rejects or refuses ────────────────────────────────────────

const isRemove = (args) => args[0] === "worktree" && args[1] === "remove";

test("11a. a git that rejects on remove after finishing → the re-list says it's gone, and it goes on", async () => {
  const repo = makeRepo("reject-gone");
  const wt = addWorktree(repo, "slow");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  const git = async (cwd, args) => {
    if (!isRemove(args)) return realGit(cwd, args);
    await realGit(cwd, args);
    throw new Error("exec: timed out after 30 s");
  };
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, { git, exists, closeSpaces: async () => {} });
  assert.equal(r.status, "removed");
  assert.equal(r.err, null);
  assert.equal(r.branch, "deleted");
  assert.ok(!existsSync(wt));
});

test("11b. a git that rejects on remove with the worktree still listed → failed with the didn't-finish text", async () => {
  const repo = makeRepo("reject-there");
  const wt = addWorktree(repo, "stuck");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  const { calls, io } = recording(async (cwd, args) => {
    if (isRemove(args)) throw new Error("exec: timed out after 30 s");
    return realGit(cwd, args);
  });
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "failed");
  assert.equal(r.err, `git didn't finish; the folder may be partly deleted. Check \`git worktree list\` in ${repo}.`);
  assert.equal(r.branch, null);
  assert.deepEqual(ran(calls, "branch "), []);
  assert.ok(existsSync(wt));
  assert.equal(hasBranch(repo, "stuck"), true);
  assert.deepEqual(r.list.map((c) => c.path), [repo, wt], "the fresh list still has it");
});

test("11c. a git that refuses (an agent wrote a file as its space closed) → failed with git's first line, no force advice", async () => {
  const repo = makeRepo("refused");
  const wt = addWorktree(repo, "racy");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  let said = null;
  const git = async (cwd, args) => {
    const res = await realGit(cwd, args);
    if (isRemove(args)) said = res;
    return res;
  };
  const closeSpaces = async () => writeFileSync(join(wt, "exit-log.txt"), "written while exiting\n");
  const { calls, io } = recording(git, closeSpaces);
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(said.ok, false, "git refused");
  assert.equal(r.status, "failed");
  assert.ok(r.err.length > 0);
  assert.ok(firstLine(said.err).startsWith(r.err), `git's own first line: ${r.err}`);
  assert.doesNotMatch(r.err, /--force|-f -f|partly deleted/);
  assert.equal(r.branch, null);
  assert.deepEqual(ran(calls, "branch "), []);
  assert.ok(existsSync(join(wt, "exit-log.txt")), "the folder is intact");
  assert.equal(hasBranch(repo, "racy"), true);

  // Any refusal: git's first line as it is, never our advice to force.
  const wt2 = addWorktree(repo, "racy-2");
  const check2 = await removalCheck({ project: repo, path: wt2 }, { git: realGit, exists });
  const refusing = async (cwd, args) => (isRemove(args) ? { ok: false, out: "", err: "error: boom\nhint: more" } : realGit(cwd, args));
  const r2 = await removeWorkspace({ project: repo, path: wt2, seen: check2 }, { git: refusing, exists, closeSpaces: async () => {} });
  assert.equal(r2.status, "failed");
  assert.equal(r2.err, "error: boom");
  assert.ok(existsSync(wt2));
});

test("11d. a git that rejects during the check → failed before anything runs", async () => {
  const repo = makeRepo("reject-check");
  const wt = addWorktree(repo, "unread");
  const { calls, io } = recording(async (cwd, args) => {
    if (args.includes("status")) throw new Error("exec: timed out after 30 s");
    return realGit(cwd, args);
  });
  const check = await removalCheck({ project: repo, path: wt }, io);
  assert.equal(check.failed, true);
  assert.equal(check.deletable, false);
  assert.match(check.reason, /timed out/);
  const r = await removeWorkspace({ project: repo, path: wt, seen: { changes: false, submodules: false } }, io);
  assert.equal(r.status, "failed");
  assert.deepEqual(ran(calls, "closeSpaces"), []);
  assert.deepEqual(ran(calls, "worktree remove"), []);
  assert.ok(existsSync(wt));
});

// ── 12. The spaces close first ─────────────────────────────────────────────

test("12. closeSpaces is awaited before the remove, and runs after the check", async () => {
  const repo = makeRepo("order");
  const wt = addWorktree(repo, "ordered");
  const check = await removalCheck({ project: repo, path: wt }, { git: realGit, exists });
  const { calls, io } = recording(realGit, async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    calls.push("closeSpaces:done");
  });
  const r = await removeWorkspace({ project: repo, path: wt, seen: check }, io);
  assert.equal(r.status, "removed");
  const at = (prefix) => calls.findIndex((c) => c.startsWith(prefix));
  assert.ok(at("closeSpaces") > at(GIT.status.join(" ")), "after the check's status");
  assert.ok(at("closeSpaces:done") > at("closeSpaces"));
  assert.ok(at("worktree remove") > at("closeSpaces:done"), `the remove waits for the spaces: ${calls.join(" | ")}`);
  assert.ok(at("branch -d") > at("worktree remove"));
});

// ── 13. Which spaces close ─────────────────────────────────────────────────

test("13. spacesToClose returns only the ids matched to that path", () => {
  const matches = {
    s1: { project: "/code/app", path: "/w/app/feat" },
    s2: { project: "/code/app", path: "/w/app/feat-2" },
    s3: { project: "/code/app", path: "/w/app/feat" },
    s4: { project: "/code/app", path: "/code/app" },
  };
  assert.deepEqual(spacesToClose(matches, "/w/app/feat"), ["s1", "s3"]);
  assert.deepEqual(spacesToClose(matches, "/w/app/feat/"), ["s1", "s3"], "paths compared normalized");
  assert.deepEqual(spacesToClose(matches, "/w/app/other"), []);
  assert.deepEqual(spacesToClose({}, "/w/app/feat"), []);
  assert.deepEqual(spacesToClose(null, "/w/app/feat"), []);
});

// ── The git it runs, and what other files import ───────────────────────────

test("GIT: status counts untracked files and submodules; remove forces at most once; the branch goes with -d, never -D", () => {
  assert.deepEqual(GIT.status, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
  assert.deepEqual(GIT.modules, ["rev-parse", "--git-path", "modules"]);
  assert.deepEqual(GIT.index, ["ls-files", "--stage", "-z"]);
  assert.deepEqual(GIT.remove("/w/a", false), ["worktree", "remove", "--", "/w/a"]);
  assert.deepEqual(GIT.remove("/w/a", true), ["worktree", "remove", "--force", "--", "/w/a"]);
  assert.deepEqual(GIT.deleteBranch("feat"), ["branch", "-d", "--", "feat"]);
  assert.ok(!JSON.stringify(GIT.deleteBranch("x")).includes("-D"));
});

test("pins: git.js binds removalCheck and removeWorkspace, and keeps its earlier exports", () => {
  const git = readFileSync(new URL("../projects-sidebar/mods/projects/git.js", import.meta.url), "utf8");
  for (const name of ["git", "repoOf", "listWorktrees", "fetch", "defaultBase", "recentBases", "branchExists", "addWorktree", "pathExists", "removalCheck", "removeWorkspace"]) {
    assert.match(git, new RegExp(`export (async function|const|function) ${name}\\b`), `git.js exports ${name}`);
  }
  assert.match(git, /from "\.\/remove-workspace-model\.js"/);
});
