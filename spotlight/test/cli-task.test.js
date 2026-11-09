// T21 (D31): the whole-task Spotlight button, its CLI side. M/task.js
// resolveGroupTask finds a task's members in one group with no cwd (the
// lane header has none), by resolveTask's rules; M/cli-task.mjs toggleTask
// runs the batch: the lit rule, the switch-away, each member lit or turned
// off quietly through cli-work.mjs (lightTask, deactivateRepo), the batch
// marker, and one summary note. Real git repos and worktrees, an in-memory
// store (as T/reconcile-orca.test.js), server.js's stop stubbed. HOME is
// this file's scratch folder, so no server log lands in the real one.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

import { resolveGroupTask, taskKeyFrom, taskLit } from "../mods/spotlight/task.js";
import { toggleTask, summaryOf } from "../mods/spotlight/cli-task.mjs";
import { taskGit, planGit } from "../mods/spotlight/cli-env.mjs";
import { gitContext, readRefs } from "../mods/spotlight/sync.js";
import { emptyRepo } from "../mods/spotlight/store.js";
import { readSettings } from "../mods/spotlight/board-model.js";
import { nodeIo } from "../mods/spotlight/server-plan.js";

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "t21-")));
process.env.HOME = join(SCRATCH, "home");
writeFileSync(join(SCRATCH, "gitconfig"), "[user]\n\tname = Test\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const run = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

let base, state;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(SCRATCH, "t21-")));
  state = { version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [], variants: {} };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// A repo `name` with one worktree per branch, each with an uncommitted file
// of its own, so lighting it moves the root. { root, ws: { branch: path } }.
function makeRepo(name, branches) {
  const root = join(base, "repos", name);
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  write(root, "README.md", `${name}\n`);
  run(root, "add", "-A");
  run(root, "commit", "-qm", "init");
  const ws = {};
  for (const branch of branches) {
    const dir = join(base, "ws", name, branch.toLowerCase().replace(/\//g, "-"));
    run(root, "worktree", "add", "-q", "-b", branch, dir);
    write(dir, `${basename(dir)}.txt`, `${branch}\n`);
    ws[branch] = dir;
  }
  return { root, ws, name };
}

// shared.json's projects.v1: one group per entry, [{ id, repos, organize? }].
const sharedOf = (groups) => ({
  "projects.v1": {
    version: 1,
    groups: groups.map((g) => ({ id: g.id, name: g.id, projects: g.repos.map((r) => ({ path: r.root, name: r.name })), ...(g.organize ? { organize: g.organize } : {}) })),
  },
});

const STOPPED = { ok: true, stopped: true, terminal: "t1", forced: 0 };

// The cx the batch needs: the in-memory store, real git, a stubbed stop.
// `disabled`: the roots whose Spotlight is off. Every write is traced as the
// state reads after it (holders and the batch marker), for the order checks.
function makeCx({ shared, disabled = [] } = {}) {
  const trace = [];
  const store = {
    readState: () => structuredClone(state),
    withRepoLock: async (_root, fn) => fn(),
    updateState: async (fn) => {
      const result = fn(state);
      trace.push({
        holders: Object.fromEntries(Object.entries(state.repos).map(([r, rec]) => [r, rec.holder])),
        batch: state.queue.taskBatch ? structuredClone(state.queue.taskBatch) : null,
      });
      return { result };
    },
    settingsSavedAt: () => 0,
    repoEnabled: async (root) => !disabled.includes(root),
  };
  let now = 1000;
  const cx = {
    store, reapStore: store, shared, now: () => now++, gitCtx: gitContext(), planGit, taskGit, nameOf: (root) => basename(root),
    settings: readSettings(JSON.stringify({ version: 1 })), io: nodeIo(fsp),
    server: { stopServer: async () => STOPPED },
    serverDeps: { exec: async (file) => ({ code: 1, stdout: "", stderr: `no fake ${file}` }) },
  };
  return { cx, trace };
}

// Lights `workspace` onto `root` as a human's toggle would leave it (a record
// whose log is under the test folder).
async function lightDirect(cx, root, workspace) {
  const { lightTask } = await import("../mods/spotlight/cli-work.mjs");
  const key = `direct/${root}`;
  state.repos[root] = { ...emptyRepo(), logPath: join(base, `${basename(root)}.log`), ...(state.repos[root] ?? {}) };
  state.queue.lighting[key] = {
    grantId: 1, phase: "pending", pid: null, startedAt: 1, error: null, errors: {}, taskKey: null, force: false,
    members: [{ root, name: basename(root), workspace, workspaces: [workspace] }],
  };
  assert.deepEqual((await lightTask(cx, key)).errors, {});
  assert.equal(state.repos[root].holder, workspace);
}

// Each root's record gets a log path under the test folder before any light.
const seedLogs = (...roots) => {
  for (const root of roots) state.repos[root] = { ...emptyRepo(), logPath: join(base, `${basename(root)}.log`) };
};

const toasts = () => state.notes.filter((n) => n.toast).map((n) => n.text);

// ── The task's members in one group (task.js) ───────────────────────────────

test("taskKeyFrom: a lane's KEY as taskOf keys it: a ticket in any spelling, else the name lowercased; null for what can't name a task", () => {
  assert.equal(taskKeyFrom("AX-50"), "AX-50");
  assert.equal(taskKeyFrom("ax_50"), "AX-50");
  assert.equal(taskKeyFrom("Login"), "login");
  for (const bad of ["", "  ", "none", "NONE", "__proto__", "x".repeat(201), null, 7]) assert.equal(taskKeyFrom(bad), null, String(bad));
});

test("resolveGroupTask: per enabled repo of the group, the task's workspace (the holder's when it holds, else the most recently active); repos whose Spotlight is off are skipped by name; other groups never count", async () => {
  const front = makeRepo("front", ["AX-50", "feat/AX-50-styles", "AX-51"]);
  const back = makeRepo("back", ["juan/AX-50"]);
  const docs = makeRepo("docs", ["ax-50"]);
  const elsewhere = makeRepo("shop", ["AX-50"]);
  const shared = sharedOf([{ id: "g1", repos: [front, back, docs] }, { id: "g2", repos: [elsewhere] }]);
  const enabled = (root) => root !== docs.root;
  // An agent in front's styles worktree changed status last: it is front's pick.
  const terminals = [{ cwd: front.ws["feat/AX-50-styles"], status_ms: 900 }, { cwd: front.ws["AX-50"], status_ms: 100 }];

  const r = await resolveGroupTask({ group: "g1", task: "ax-50", shared, git: taskGit, enabled, terminals });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.taskKey, "AX-50");
  assert.deepEqual(r.members, [
    { root: front.root, name: "front", workspace: front.ws["feat/AX-50-styles"], workspaces: [front.ws["AX-50"], front.ws["feat/AX-50-styles"]] },
    { root: back.root, name: "back", workspace: back.ws["juan/AX-50"], workspaces: [back.ws["juan/AX-50"]] },
  ]);
  assert.deepEqual(r.skipped, ["docs"]);
  assert.deepEqual(r.projects.map((p) => p.name), ["front", "back", "docs"]);

  // The workspace holding the root wins its repo, whatever the agents did.
  const held = await resolveGroupTask({ group: "g1", task: "AX-50", shared, git: taskGit, enabled, terminals, holders: { [front.root]: front.ws["AX-50"] } });
  assert.equal(held.members[0].workspace, front.ws["AX-50"]);
  // A holder of another task is no pick: the task's own rule applies.
  const other = await resolveGroupTask({ group: "g1", task: "AX-50", shared, git: taskGit, enabled, terminals, holders: { [front.root]: front.ws["AX-51"] } });
  assert.equal(other.members[0].workspace, front.ws["feat/AX-50-styles"]);

  // projects.cache.v1's lists are used when they're there (no git asked).
  const cached = {
    ...shared,
    "projects.cache.v1": { [back.root]: [{ path: back.root, branch: "main", main: true }, { path: `${base}/ws/back/listed-only`, branch: "AX-50-x", main: false }] },
  };
  const fromCache = await resolveGroupTask({ group: "g1", task: "AX-50", shared: cached, git: taskGit, enabled, terminals });
  assert.deepEqual(fromCache.members[1].workspaces, [`${base}/ws/back/listed-only`]);

  // A name task: lowercased key, the smallest casing the group shows as its label.
  const names = makeRepo("names", ["feat/Login", "login"]);
  const named = await resolveGroupTask({ group: "g3", task: "LOGIN", shared: sharedOf([{ id: "g3", repos: [names] }]), git: taskGit, enabled: () => true });
  assert.equal(named.taskKey, "login");
  assert.equal(named.label, "Login");
  assert.equal(named.members[0].workspaces.length, 2);

  assert.deepEqual(
    await resolveGroupTask({ group: "nope", task: "AX-50", shared, git: taskGit, enabled }),
    { ok: false, code: "no-group", message: 'No group "nope" in projects-sidebar\'s spaces.' },
  );
  assert.equal((await resolveGroupTask({ group: "g1", task: "none", shared, git: taskGit, enabled })).code, "no-task");
  // A task with no workspace with Spotlight on: no members, the skipped named.
  const off = await resolveGroupTask({ group: "g1", task: "AX-50", shared, git: taskGit, enabled: () => false });
  assert.deepEqual([off.members, off.skipped], [[], ["front", "back", "docs"]]);
});

test("taskLit: members non-empty and every member's root held by one of the task's workspaces there", () => {
  const m1 = { root: "/r/a", workspaces: ["/w/a1", "/w/a2"] };
  const m2 = { root: "/r/b", workspaces: ["/w/b1"] };
  const repo = (holder) => ({ ...emptyRepo(), holder });
  assert.equal(taskLit([], {}), false);
  assert.equal(taskLit([m1, m2], { "/r/a": repo("/w/a2"), "/r/b": repo("/w/b1") }), true);
  assert.equal(taskLit([m1, m2], { "/r/a": repo("/w/a2/"), "/r/b": repo("/w/b1") }), true, "a holder with a trailing slash");
  assert.equal(taskLit([m1, m2], { "/r/a": repo("/w/a2") }), false, "one member not lit");
  assert.equal(taskLit([m1, m2], { "/r/a": repo("/w/other"), "/r/b": repo("/w/b1") }), false, "held by another task");
});

test("summaryOf: all ok names the task; some say how many of how many; none says nothing", () => {
  assert.equal(summaryOf("on", "AX-3653", 2, 2), "Spotlight on · AX-3653");
  assert.equal(summaryOf("off", "AX-3653", 2, 2), "Spotlight off · AX-3653");
  assert.equal(summaryOf("on", "AX-3653", 1, 2), "Spotlight on en 1 de 2 proyectos");
  assert.equal(summaryOf("off", "AX-3653", 1, 2), "Spotlight off en 1 de 2 proyectos");
  assert.equal(summaryOf("on", "AX-3653", 0, 2), null);
});

// ── The batch (cli-task.mjs) ────────────────────────────────────────────────

test("two enabled repos with AX-50 workspaces, none lit: both lit, one 'Spotlight on · AX-50' and no per-repo note; again: both off, 'Spotlight off · AX-50'", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const back = makeRepo("back", ["AX-50"]);
  const { cx, trace } = makeCx({ shared: sharedOf([{ id: "g1", repos: [front, back], organize: "task" }]) });
  seedLogs(front.root, back.root);

  const on = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.deepEqual({ ok: on.ok, op: on.op, summary: on.summary }, { ok: true, op: "on", summary: "Spotlight on · AX-50" }, JSON.stringify(on));
  assert.equal(state.repos[front.root].holder, front.ws["AX-50"]);
  assert.equal(state.repos[back.root].holder, back.ws["AX-50"]);
  assert.equal((await readRefs(front.root)).active, true);
  assert.equal((await readRefs(back.root)).active, true);
  assert.deepEqual(toasts(), ["Spotlight on · AX-50"]);
  // Each member through a direct/<root> marker, as a human's toggle; quiet never on it.
  for (const root of [front.root, back.root]) {
    const m = state.queue.lighting[`direct/${root}`];
    assert.equal(m.phase, "done");
    assert.equal(m.taskKey, "g1/AX-50");
    assert.equal("quiet" in m, false);
  }
  // The batch marker lived while it ran, keyed <groupId>/<KEY>, and is gone.
  const marks = trace.map((t) => t.batch?.["g1/AX-50"]).filter(Boolean);
  assert.ok(marks.length > 0, "the batch marker was set");
  assert.deepEqual({ ...marks[0], since: typeof marks[0].since }, { op: "on", since: "number", pid: process.pid });
  assert.equal(state.queue.taskBatch, undefined);

  state.notes = [];
  const off = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.deepEqual({ ok: off.ok, op: off.op, summary: off.summary }, { ok: true, op: "off", summary: "Spotlight off · AX-50" });
  assert.deepEqual(Object.keys(state.repos), []);
  assert.equal((await readRefs(front.root)).active, false);
  assert.equal((await readRefs(back.root)).active, false);
  assert.deepEqual(toasts(), ["Spotlight off · AX-50"]);
  assert.equal(state.queue.taskBatch, undefined);
});

test("one repo lit by another task of the group is switched off first; a member held by a workspace outside the task is taken over", async () => {
  const front = makeRepo("front", ["AX-50", "scratch"]);
  const back = makeRepo("back", ["AX-50"]);
  const docs = makeRepo("docs", ["AX-51"]);
  const { cx, trace } = makeCx({ shared: sharedOf([{ id: "g1", repos: [front, back, docs] }]) });
  seedLogs(back.root);
  await lightDirect(cx, docs.root, docs.ws["AX-51"]);
  await lightDirect(cx, front.root, front.ws.scratch);
  state.notes = [];
  trace.length = 0;

  const r = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(r.summary, "Spotlight on · AX-50", JSON.stringify(r));
  assert.equal(state.repos[docs.root], undefined, "docs turned off");
  assert.equal((await readRefs(docs.root)).active, false);
  assert.equal(state.repos[front.root].holder, front.ws["AX-50"], "taken over from a workspace outside the task");
  assert.equal(state.repos[back.root].holder, back.ws["AX-50"]);
  // First: docs went before any member was lit.
  const docsGone = trace.findIndex((t) => !(docs.root in t.holders));
  const firstLit = trace.findIndex((t) => t.holders[back.root] === back.ws["AX-50"] || t.holders[front.root] === front.ws["AX-50"]);
  assert.ok(docsGone >= 0 && docsGone < firstLit, `docs off at write ${docsGone}, first member lit at ${firstLit}`);
  // The switch-away is quiet too: only the summary toasts.
  assert.deepEqual(toasts(), ["Spotlight on · AX-50"]);
});

test("a repo with Spotlight off is skipped and left alone; a task none of whose repos is on lights nothing", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const docs = makeRepo("docs", ["AX-50"]);
  const shared = sharedOf([{ id: "g1", repos: [front, docs] }]);
  seedLogs(front.root);
  const { cx } = makeCx({ shared, disabled: [docs.root] });
  const r = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(r.summary, "Spotlight on · AX-50");
  assert.deepEqual(r.skipped, ["docs"]);
  assert.equal(state.repos[front.root].holder, front.ws["AX-50"]);
  assert.equal(state.repos[docs.root], undefined);
  assert.equal((await readRefs(docs.root)).active, false);

  state.repos = {};
  state.notes = [];
  const none = await toggleTask(makeCx({ shared, disabled: [front.root, docs.root] }).cx, { group: "g1", task: "AX-50" });
  assert.deepEqual({ ok: none.ok, code: none.code }, { ok: false, code: "no-members" });
  assert.match(none.message, /docs/);
  assert.deepEqual(state.repos, {});
  assert.deepEqual(state.notes, []);
  assert.equal(state.queue.taskBatch, undefined);
});

test("one member failing: the other is still lit and 'Spotlight on en 1 de 2 proyectos'; the failure toasts itself; none ok: no summary", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const back = makeRepo("back", ["AX-50"]);
  const shared = sharedOf([{ id: "g1", repos: [back, front] }]);
  seedLogs(front.root, back.root);
  // back's root isn't on its primary branch: its activation refuses.
  run(back.root, "checkout", "-q", "--detach");
  const { cx } = makeCx({ shared });
  const r = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(r.ok, true);
  assert.equal(r.summary, "Spotlight on en 1 de 2 proyectos");
  assert.ok(r.errors[back.root], JSON.stringify(r));
  assert.equal(state.repos[front.root].holder, front.ws["AX-50"]);
  assert.equal(state.repos[back.root].holder, null);
  assert.equal(state.repos[back.root].lastError.code, "not-on-primary-branch");
  const shown = toasts();
  assert.equal(shown.at(-1), "Spotlight on en 1 de 2 proyectos");
  assert.equal(shown.length, 2, shown.join("\n"));
  assert.match(shown[0], /^back: /);

  // Both refuse (two other repos, both roots detached): each toasts itself,
  // no summary, not ok.
  const web = makeRepo("web", ["AX-60"]);
  const api = makeRepo("api", ["AX-60"]);
  for (const r of [web, api]) run(r.root, "checkout", "-q", "--detach");
  state.notes = [];
  seedLogs(web.root, api.root);
  const none = await toggleTask(makeCx({ shared: sharedOf([{ id: "g2", repos: [web, api] }]) }).cx, { group: "g2", task: "AX-60" });
  assert.deepEqual({ ok: none.ok, summary: none.summary }, { ok: false, summary: null });
  assert.equal(toasts().length, 2);
  assert.ok(toasts().every((t) => !t.startsWith("Spotlight on")));
});

test("a turn-off that fails in one repo still turns off the other: 'Spotlight off en 1 de 2 proyectos'", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const back = makeRepo("back", ["AX-50"]);
  const { cx } = makeCx({ shared: sharedOf([{ id: "g1", repos: [front, back] }]) });
  seedLogs(front.root, back.root);
  assert.equal((await toggleTask(cx, { group: "g1", task: "AX-50" })).summary, "Spotlight on · AX-50");
  // A tracked edit in front's root: its turn-off refuses root-diverged.
  write(front.root, "README.md", "edited in the root\n");
  state.notes = [];
  const r = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(r.op, "off");
  assert.equal(r.summary, "Spotlight off en 1 de 2 proyectos");
  assert.equal(state.repos[front.root].lastError.code, "root-diverged");
  assert.equal(state.repos[back.root], undefined);
  assert.equal(toasts().at(-1), "Spotlight off en 1 de 2 proyectos");
});

// ── D41: toasts as Orca's ───────────────────────────────────────────────────

const ROOT_DIVERGED_ES = "El root del proyecto tiene cambios hechos fuera del workspace de Spotlight. Haz commit o descártalos ahí primero.";
// A note's toast fields, as the footer reads them.
const toastFields = (n) => ({ level: n.level, title: n.title, body: n.body, ...(n.timeout ? { timeout: n.timeout } : {}) });

test("D41: a single light toasts success with Orca's title and, with no server command, 'Los logs del server quedan para los agentes en <log>'; its text names repo and holder as before; a light inside a batch writes none, and the batch's summary is Orca's: 'Spotlight on para AX-50' / 'Spotlight off para AX-50'", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const back = makeRepo("back", ["AX-50"]);
  const { cx } = makeCx({ shared: sharedOf([{ id: "g1", repos: [front, back] }]) });
  seedLogs(front.root, back.root);
  await lightDirect(cx, front.root, front.ws["AX-50"]);
  const lit = state.notes.filter((n) => n.toast);
  assert.equal(lit.length, 1, JSON.stringify(state.notes));
  assert.equal(lit[0].text, "Spotlight on · front ← ax-50 · sin server");
  assert.deepEqual(toastFields(lit[0]), {
    level: "success",
    title: "Spotlight on — el root del proyecto ahora refleja este workspace",
    body: `Los logs del server quedan para los agentes en ${join(base, "front.log")}`,
  });

  // The batch: front is lit by the task already, back gets lit quietly.
  state.notes = [];
  const on = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(on.summary, "Spotlight on · AX-50");
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => ({ text: n.text, ...toastFields(n) })), [
    { text: "Spotlight on · AX-50", level: "success", title: "Spotlight on para AX-50", body: "" },
  ]);
  state.notes = [];
  const off = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(off.summary, "Spotlight off · AX-50");
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => ({ text: n.text, ...toastFields(n) })), [
    { text: "Spotlight off · AX-50", level: "success", title: "Spotlight off para AX-50", body: "" },
  ]);
});

test("D41: a batch some of whose members fail: a warning 'Spotlight on en 1 de 2 proyectos' / 'Spotlight off en 1 de 2 proyectos'; each failure toasts its own error with Orca's title for a light or a turn-off and Orca's description", async () => {
  const front = makeRepo("front", ["AX-50"]);
  const back = makeRepo("back", ["AX-50"]);
  const shared = sharedOf([{ id: "g1", repos: [back, front] }]);
  seedLogs(front.root, back.root);
  run(back.root, "checkout", "-q", "--detach");
  const { cx } = makeCx({ shared });
  await toggleTask(cx, { group: "g1", task: "AX-50" });
  const [failed, summary] = state.notes.filter((n) => n.toast);
  assert.equal(failed.title, "No se pudo prender Spotlight en back", JSON.stringify(state.notes));
  assert.equal(failed.level, "error");
  // not-on-primary-branch has no description of Orca's: its own message.
  assert.equal(failed.body, state.repos[back.root].lastError.message);
  assert.deepEqual({ text: summary.text, ...toastFields(summary) }, {
    text: "Spotlight on en 1 de 2 proyectos", level: "warning", title: "Spotlight on en 1 de 2 proyectos", body: "",
  });

  // back can be lit now; then front's root diverges and its turn-off refuses.
  run(back.root, "checkout", "-q", "main");
  await toggleTask(cx, { group: "g1", task: "AX-50" });
  write(front.root, "README.md", "edited in the root\n");
  state.notes = [];
  const r = await toggleTask(cx, { group: "g1", task: "AX-50" });
  assert.equal(r.summary, "Spotlight off en 1 de 2 proyectos", JSON.stringify(r));
  const [refused, offSummary] = state.notes.filter((n) => n.toast);
  assert.deepEqual(toastFields(refused), { level: "error", title: "No se pudo apagar Spotlight en front", body: ROOT_DIVERGED_ES });
  assert.equal(refused.button, "Apagar igual");
  assert.equal(refused.text, `front: ${state.repos[front.root].lastError.message}`, "the log's line stays the error's");
  assert.deepEqual({ text: offSummary.text, ...toastFields(offSummary) }, {
    text: "Spotlight off en 1 de 2 proyectos", level: "warning", title: "Spotlight off en 1 de 2 proyectos", body: "",
  });
});

test("D41: a turn-off that goes through toasts success 'Spotlight off — root del proyecto restaurado'; one that leaves the root detached writes one warning alone (60 s, Orca's words: the branch in another workspace, or gone), quiet or not", async () => {
  const { deactivateRepo } = await import("../mods/spotlight/cli-work.mjs");
  const app = makeRepo("app", ["AX-1"]);
  const { cx } = makeCx({ shared: sharedOf([{ id: "g1", repos: [app] }]) });
  seedLogs(app.root);
  await lightDirect(cx, app.root, app.ws["AX-1"]);
  state.notes = [];
  assert.equal((await deactivateRepo(cx, app.root)).ok, true);
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => ({ text: n.text, ...toastFields(n) })), [
    { text: "Spotlight off — root restaurado", level: "success", title: "Spotlight off — root del proyecto restaurado", body: "" },
  ]);

  // Its branch checked out in another worktree while the root was lit.
  seedLogs(app.root);
  await lightDirect(cx, app.root, app.ws["AX-1"]);
  run(app.root, "worktree", "add", "-q", join(base, "elsewhere"), "main");
  state.notes = [];
  const inUse = await deactivateRepo(cx, app.root);
  assert.equal(inUse.ok, true);
  const detached = {
    level: "warning", title: "Spotlight off — el root del proyecto quedó detached", timeout: 60_000,
  };
  assert.deepEqual(state.notes.filter((n) => n.toast).map(toastFields), [{
    ...detached,
    body: "Su rama \"main\" está abierta en otro workspace, así que el root no pudo volver a ella. Libera esa rama (o cambia el root a cualquier rama) para volver a engancharlo.",
  }]);
  assert.match(state.notes.at(-1).text, /^app: The root is back on its original commit but left detached/, "the log's line as before");

  // Its branch gone, in a quiet turn-off (a batch's): the warning still shows.
  run(app.root, "worktree", "remove", "--force", join(base, "elsewhere"));
  run(app.root, "checkout", "-q", "main");
  seedLogs(app.root);
  await lightDirect(cx, app.root, app.ws["AX-1"]);
  run(app.root, "update-ref", "-d", "refs/heads/main");
  state.notes = [];
  assert.equal((await deactivateRepo(cx, app.root, { quiet: true })).ok, true);
  assert.deepEqual(state.notes.filter((n) => n.toast).map(toastFields), [{
    ...detached, body: "La rama original del root ya no existe, así que quedó detached en su commit original.",
  }]);
});

test("D41: a refused sync toasts 'Falló el sync de Spotlight' with Orca's description and Forzar sync; a forced re-sync that goes through, success 'Spotlight re-sincronizado — el root refleja el workspace otra vez'", async () => {
  const { syncRepo } = await import("../mods/spotlight/cli-work.mjs");
  const app = makeRepo("app", ["AX-1"]);
  const { cx } = makeCx({ shared: sharedOf([{ id: "g1", repos: [app] }]) });
  seedLogs(app.root);
  await lightDirect(cx, app.root, app.ws["AX-1"]);
  // A commit made in the root: its HEAD moved off the snapshot.
  run(app.root, "commit", "-q", "--allow-empty", "-m", "made in the root");
  state.notes = [];
  assert.equal((await syncRepo(cx, app.root)).ok, false);
  const [refused] = state.notes.filter((n) => n.toast);
  assert.deepEqual(toastFields(refused), { level: "error", title: "Falló el sync de Spotlight", body: ROOT_DIVERGED_ES });
  assert.equal(refused.button, "Forzar sync");

  state.notes = [];
  assert.equal((await syncRepo(cx, app.root, { force: true })).ok, true);
  assert.deepEqual(state.notes.filter((n) => n.toast).map((n) => ({ text: n.text, ...toastFields(n) })), [{
    text: "Spotlight re-sincronizado: el root refleja el workspace otra vez.",
    level: "success", title: "Spotlight re-sincronizado — el root refleja el workspace otra vez", body: "",
  }]);
});
