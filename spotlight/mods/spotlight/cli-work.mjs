// The CLI's work on repos and the queue (D7, D8, D10–D13, D18, D19):
// lighting a task's repos, syncing a holder, turning a root off, the server
// (start, restart on a lockfile or command change), waiting for the servers
// to listen (port of Orca's waitForTurnServers), and the reap. Node-only.
//
// Every git step runs under the repo's lock and reads the holder inside it,
// so the last one to take the lock sees the latest holder (a sync racing a
// takeover syncs the new holder). state.json is written only through
// updateState, under the state lock, never across git (D7).

import path from "node:path";
import crypto from "node:crypto";
import { activate, sync, deactivate, assertDeactivatable, readRefs, toSpotlightError } from "./sync.js";
import { emptyRepo, addNote, reconcileRepo, rememberVariant } from "./store.js";
import { pidAlive, LockError } from "./locks.js";
import { repoSettings, normRoot } from "./settings.js";
import { planServer, lockfileInstalls, missingInstalls, installsFor, chainInstall } from "./server-plan.js";
import { inspectServer, readServerState, startServer, restartServer, stopServer } from "./server.js";
import { logPathFor, appendLogHeader, rotateLog } from "./server-log.js";
import { portUrl } from "./ports.js";
import { release, pause, regrant, snapshot } from "./queue.js";
import { decideTurnEnd, activityUpdate, lightingMarker, lightAlive, needsLight, memberLit } from "./cli-turns.mjs";
import { branchOf, hcGet, hcReadText, registeredRoots } from "./cli-env.mjs";

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// D17: the server badge's command id of a workspace's row.
export const serverId = (workspace) => sha1(normRoot(workspace)).slice(0, 12);

// Errors whose toast opens the server popup (Forzar sync, Apagar igual, D22).
const POPUP_CODES = new Set(["root-diverged", "untracked-collision"]);

const qctxOf = (cx) => ({ now: cx.now(), ...cx.settings.queue });

function errorNote(s, { root, name, workspace, error, now }) {
  const action = POPUP_CODES.has(error.code) && workspace ? { action: { name: `spotlight.server.${serverId(workspace)}` } } : {};
  addNote(s, { repo: root, text: `${name}: ${error.message}`, toast: true, ...action }, now);
}

// ── Lighting hand-off (D12, D18) ───────────────────────────────────────────

// Marks every granted turn that has repos to light; returns their keys,
// for spawnLights once the state is written.
export function markGranted(s, turns, now) {
  const keys = [];
  for (const turn of turns) {
    if (keys.includes(turn.taskKey) || turn.slotOnly || (turn.members ?? []).length === 0) continue;
    s.queue.lighting[turn.taskKey] = lightingMarker(turn, { now, taskKey: turn.taskKey });
    keys.push(turn.taskKey);
  }
  return keys;
}

// Spawns the detached `light` of each marked key and records its pid (the
// light records it too when it claims the marker, whichever comes first).
export async function spawnLights(cx, keys) {
  for (const key of keys) {
    const pid = cx.spawn(["light", "--task", key]);
    await cx.store.updateState((s) => {
      const m = s.queue.lighting[key];
      if (m && m.phase === "pending" && m.pid == null) m.pid = pid;
    });
  }
}

// Markers of queue turns that no longer hold, whose light isn't running.
// A human's toggle (`direct/…`) and the queue-off markers stay: they say
// how the last lighting went.
export function dropStaleMarkers(s, now) {
  const holding = new Set(s.queue.requests.filter((r) => r.state === "holding").map((r) => r.taskKey));
  for (const [key, m] of Object.entries(s.queue.lighting)) {
    if (key.startsWith("direct/") || m.grantId === "off" || holding.has(key)) continue;
    if (!lightAlive(m, { now, pidAlive })) delete s.queue.lighting[key];
  }
}

// ── light ──────────────────────────────────────────────────────────────────

// `spotlight light --task <k> [--force]` (internal, detached): lights every
// member of lighting[k], each under its repo lock. Claims the marker first,
// so two lights never work one grant; a light whose marker was re-marked
// meanwhile (its repos grew) leaves the result to the newer one.
export async function lightTask(cx, key, { force = false } = {}) {
  const me = process.pid;
  const claimed = await cx.store.updateState((s) => {
    const m = s.queue.lighting[key];
    if (!m) return null;
    if (!force) {
      if (m.phase === "done" || m.phase === "error") return null;
      if (m.phase === "running" && Number.isInteger(m.pid) && m.pid !== me && pidAlive(m.pid)) return null;
    }
    Object.assign(m, { phase: "running", pid: me, startedAt: cx.now(), error: null, errors: {} });
    return structuredClone(m);
  });
  const marker = claimed.result;
  if (!marker) return { ran: false, errors: {} };
  const errors = {};
  for (const member of marker.members) {
    try {
      const r = await lightMember(cx, member, { force: force || marker.force, taskKey: marker.taskKey });
      if (!r.ok) errors[member.root] = r.message;
    } catch (e) {
      errors[member.root] = toSpotlightError(e).message;
    }
  }
  const failed = Object.keys(errors).length;
  await cx.store.updateState((s) => {
    const m = s.queue.lighting[key];
    if (!m || m.pid !== me || m.startedAt !== marker.startedAt) return;
    m.phase = failed > 0 && failed === marker.members.length ? "error" : "done";
    m.errors = errors;
    m.error = failed > 0 ? Object.values(errors)[0] : null;
    m.finishedAt = cx.now();
  });
  return { ran: true, errors };
}

const SERVER_WORDS = {
  started: "server arrancando",
  running: "server corriendo",
  "needs-variant": "elige una variante",
  none: "sin server",
  pending: "server sin tocar",
  failed: "el server no arrancó",
};

// One repo of a lighting: activate (fresh or takeover), or sync when the
// workspace already holds it; then the server.
async function lightMember(cx, member, { force, taskKey }) {
  const { root, workspace } = member;
  const name = member.name ?? cx.nameOf(root);
  return cx.store.withRepoLock(root, async () => {
    const before = cx.store.readState().repos[root] ?? null;
    const refs = await readRefs(root);
    const same = before?.holder === workspace && refs.active;
    let result;
    try {
      result = same ? await sync(cx.gitCtx, root, workspace, { force }) : await activate(cx.gitCtx, root, workspace, { force });
    } catch (e) {
      const error = toSpotlightError(e);
      const now = cx.now();
      await cx.store.updateState((s) => {
        s.repos[root] = { ...emptyRepo(), ...(s.repos[root] ?? {}), lastError: { ...error, at: now } };
        errorNote(s, { root, name, workspace, error, now });
      });
      return { ok: false, message: error.message };
    }
    const now = cx.now();
    const switched = before?.holder !== workspace;
    const logPath = before?.logPath ?? logPathFor(root);
    const fromSha = before?.lastSnapshotSha ?? result.originalHeadSha ?? null;
    const changed = result.skipped ? [] : await lockfileInstalls({ git: cx.planGit, root, fromSha, toSha: result.snapshotSha });
    const missing = await missingInstalls(root, cx.io);
    const branch = await branchOf(workspace);
    // D11: a header line on every holder switch.
    if (switched) appendLogHeader(logPath, { workspace: path.basename(workspace), branch, at: now });
    await cx.store.updateState((s) => {
      const r = { ...emptyRepo(), ...(s.repos[root] ?? {}) };
      r.holder = workspace;
      r.lastError = null;
      r.logPath = logPath;
      if (!result.skipped || !r.lastSnapshotSha) {
        r.lastSnapshotSha = result.snapshotSha;
        r.lastSyncAt = now;
      }
      r.pendingInstalls = installsFor(r.pendingInstalls, changed, missing);
      s.repos[root] = r;
    });
    const server = await ensureServer(cx, root, { workspace, branch, taskKey, keepVariant: !switched && !taskKey });
    if (switched) {
      const text = `Spotlight on · ${name} ← ${path.basename(workspace)} · ${SERVER_WORDS[server.state] ?? server.state}`;
      await cx.store.updateState((s) => addNote(s, { repo: root, text, toast: true }, cx.now()));
    }
    return { ok: true, server };
  });
}

// ── The server (D10) ───────────────────────────────────────────────────────

function serverFailure(r) {
  if (r.reason === "busy") return "la terminal del server corre algo que Spotlight no arrancó: no se tocó";
  return `el server no arrancó (${r.reason}${r.message ? `: ${r.message}` : ""})`;
}

// Plans the repo's server for `workspace` (T5a) and starts it, restarts it
// (its command changed, installs are pending, or `restart`), or leaves it.
// Call under the repo's lock. Options:
//   taskKey      `<lane>/<taskKey>` whose remembered variant applies
//   envName      the env to run (else the record's, else the settings')
//   chosenVariant  a variant picked now (`spotlight env --variant`)
//   keepVariant  reuse the running server's variant (a restart, a sync)
//   restart      restart even when nothing changed (`spotlight restart`)
//   ifRunning    touch only a server Spotlight runs now (a sync's installs)
// → { state: started | running | needs-variant | none | pending | failed, … }
export async function ensureServer(cx, root, opts = {}) {
  const { workspace, branch = null, taskKey = null, envName, restart = false, ifRunning = false } = opts;
  const state = cx.store.readState();
  const record = state.repos[root];
  if (!record) return { state: "none" };
  const repoSet = repoSettings(cx.settings, root);
  const env = envName ?? record.serverEnv ?? repoSet.env;
  const chosenVariant = opts.chosenVariant ?? (opts.keepVariant ? record.serverVariant ?? undefined : undefined);
  const plan = await planServer({
    root, workspace, settings: repoSet, env, taskKey, remembered: state.variants, chosenVariant, io: cx.io, git: cx.planGit,
  });
  const now = cx.now();
  if (plan.kind === "ask-variant") {
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      Object.assign(r, { serverState: "needs-variant", variantCandidates: plan.candidates, serverEnv: env });
    });
    return { state: "needs-variant", candidates: plan.candidates };
  }
  if (plan.kind !== "command") return { state: "none" };

  const pending = installsFor(record.pendingInstalls);
  const logPath = record.logPath ?? logPathFor(root);
  const args = {
    root, terminal: record.serverTerminal, line: chainInstall(plan.command, pending), logPath, serverPid: record.serverPid,
    workspace: workspace ? path.basename(workspace) : null, branch,
  };
  const seen = await inspectServer(args, cx.serverDeps);
  if (ifRunning && seen.kind !== "spotlight") return { state: "pending" };
  let r;
  if (seen.kind === "spotlight" && !restart && record.serverCommand === plan.command && pending.length === 0) {
    r = { ok: true, started: false, reason: "already-running", terminal: seen.terminal, pid: seen.pid };
  } else if (seen.kind === "spotlight") {
    r = await restartServer(args, cx.serverDeps);
  } else {
    r = await startServer(args, cx.serverDeps);
  }
  await cx.store.updateState((s) => {
    const rec = s.repos[root];
    if (!rec) return;
    rec.serverEnv = plan.env;
    rec.logPath = logPath;
    if (r.terminal) rec.serverTerminal = r.terminal;
    if (r.ok && r.started) {
      Object.assign(rec, {
        serverCommand: plan.command, serverVariant: plan.variant, serverPid: r.pid ?? null, serverStartedAt: now,
        serverState: "starting", pendingInstalls: [], variantCandidates: [],
      });
      if (taskKey && plan.variant && (plan.source === "inferred" || plan.source === "chosen")) {
        rememberVariant(s, `${taskKey}::${normRoot(root)}`, plan.variant);
      }
      if (plan.note) addNote(s, { repo: root, text: plan.note, toast: true }, now);
    } else if (r.ok && r.reason === "already-running") {
      if (rec.serverState !== "listening") rec.serverState = "starting";
      if (r.pid) rec.serverPid = r.pid;
      rec.variantCandidates = [];
    } else {
      rec.serverState = r.reason === "terminal-gone" ? "gone" : "stopped";
      addNote(s, { repo: root, text: `${cx.nameOf(root)}: ${serverFailure(r)}`, toast: true }, now);
    }
  });
  const word = r.ok && r.started ? "started" : r.ok && r.reason === "already-running" ? "running" : "failed";
  return { state: word, result: r, plan };
}

// ── sync ───────────────────────────────────────────────────────────────────

// Brings the root in step with its holder (`spotlight sync`, auto-sync, and
// `on` for each lit member). Under the repo lock; the holder is read inside
// it. `onlyIf(record)`: sync only when it says so (`on`: the task's own
// holder). A sync that changes nothing writes nothing (D7). A changed
// pnpm-lock.yaml / uv.lock restarts Spotlight's running server with the
// install chained (D10).
export async function syncRepo(cx, root, { force = false, onlyIf } = {}) {
  return cx.store.withRepoLock(root, async () => {
    const record = cx.store.readState().repos[root] ?? null;
    if (!record?.holder) return { ok: false, code: "not-active", message: `Spotlight is not on in ${cx.nameOf(root)}.` };
    if (onlyIf && !onlyIf(record)) return { ok: true, skipped: true, notLit: true, holder: record.holder };
    const holder = record.holder;
    let result;
    try {
      result = await sync(cx.gitCtx, root, holder, { force });
    } catch (e) {
      const error = toSpotlightError(e);
      const now = cx.now();
      await cx.store.updateState((s) => {
        const r = s.repos[root];
        // Auto-sync retries every few seconds: one note per new error, not per try.
        if (!r || (r.lastError?.code === error.code && r.lastError?.message === error.message)) return;
        r.lastError = { ...error, at: now };
        errorNote(s, { root, name: cx.nameOf(root), workspace: holder, error, now });
      });
      return { ok: false, holder, ...error };
    }
    if (result.skipped) {
      if (record.lastError) {
        await cx.store.updateState((s) => {
          if (s.repos[root]) s.repos[root].lastError = null;
        });
      }
      return { ok: true, skipped: true, holder };
    }
    const installs = await lockfileInstalls({ git: cx.planGit, root, fromSha: record.lastSnapshotSha, toSha: result.snapshotSha });
    const now = cx.now();
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      Object.assign(r, { lastSnapshotSha: result.snapshotSha, lastSyncAt: now, lastError: null });
      r.pendingInstalls = installsFor(r.pendingInstalls, installs);
    });
    let server = null;
    if (installs.length > 0) {
      server = await ensureServer(cx, root, { workspace: holder, branch: await branchOf(holder), keepVariant: true, ifRunning: true });
    }
    return { ok: true, skipped: false, holder, installs, restarted: server?.state === "started" };
  });
}

// ── Turning a root off (toggle) ────────────────────────────────────────────

// Restores the root (its commit, branch and uncommitted changes) and stops
// Spotlight's server; `force` discards a diverged root (Orca's "Turn off
// anyway"). Refs with no record (orphan-refs) restore the same way.
export async function deactivateRepo(cx, root, { force = false } = {}) {
  const name = cx.nameOf(root);
  const fail = async (e, workspace) => {
    const error = toSpotlightError(e);
    const now = cx.now();
    await cx.store.updateState((s) => {
      s.repos[root] = { ...emptyRepo(), ...(s.repos[root] ?? {}), lastError: { ...error, at: now } };
      errorNote(s, { root, name, workspace, error, now });
    });
    return { ok: false, ...error };
  };
  return cx.store.withRepoLock(root, async () => {
    const record = cx.store.readState().repos[root] ?? null;
    const holder = record?.holder ?? null;
    try {
      await assertDeactivatable(cx.gitCtx, root, { force });
    } catch (e) {
      if (e?.code !== "not-active") return fail(e, holder);
      await cx.store.updateState((s) => {
        delete s.repos[root];
      });
      return { ok: true, warning: null, notActive: true };
    }
    const logPath = record?.logPath ?? logPathFor(root);
    const stopped = await stopServer(
      {
        root, terminal: record?.serverTerminal ?? null, logPath, serverPid: record?.serverPid ?? null,
        workspace: holder ? path.basename(holder) : null, branch: holder ? await branchOf(holder) : null,
      },
      cx.serverDeps,
    );
    let res;
    try {
      res = await deactivate(cx.gitCtx, root, { force });
    } catch (e) {
      return fail(e, holder);
    }
    const now = cx.now();
    await cx.store.updateState((s) => {
      delete s.repos[root];
      delete s.queue.lighting[`direct/${root}`];
      addNote(s, { repo: root, text: "Spotlight off — root restaurado", toast: true }, now);
      if (res.warning) addNote(s, { repo: root, text: `${name}: ${res.warning.message}`, toast: true }, now);
    });
    return { ok: true, warning: res.warning, stopped };
  });
}

// ── Waiting for the servers (port of waitForTurnServers) ───────────────────

// Where one repo of a turn stands, as `on` prints it.
export async function describeServer(cx, state, member, key, syncErrors = {}) {
  const record = state.repos[member.root] ?? null;
  const configured = repoSettings(cx.settings, member.root).port;
  const logPath = record?.logPath ?? logPathFor(member.root);
  const lit = memberLit(member, state.repos);
  const marker = state.queue.lighting[key];
  const base = {
    root: member.root, name: member.name ?? cx.nameOf(member.root), lit, logPath, port: configured, url: portUrl(configured),
    listening: false, server: "unknown", serverState: null, ports: [],
  };
  if (!lit) return { ...base, error: marker?.errors?.[member.root] ?? record?.lastError?.message ?? marker?.error ?? undefined };
  const syncError = syncErrors[member.root];
  if (record.serverState === "needs-variant") return { ...base, needsVariant: true, server: "stopped", syncError };
  const live = await readServerState(
    { root: member.root, terminal: record.serverTerminal, logPath, serverPid: record.serverPid, port: configured },
    cx.serverDeps,
  );
  const running = live.state === "listening" || live.state === "starting";
  return {
    ...base,
    listening: live.state === "listening",
    server: running ? "running" : live.state === null ? "unknown" : "stopped",
    serverState: live.state,
    ports: live.ports,
    port: live.port ?? configured,
    url: live.url ?? portUrl(configured),
    syncError,
  };
}

// Polls until every lit repo listens, or has no server (15 s after the wait
// began), or the deadline passes (O/src/main/spotlight/spotlight-agent-servers.ts:96-132).
// A repo waiting for a variant has nothing to wait for. → { servers, ready }.
export async function waitForTurnServers(cx, { members, key, deadline, syncErrors }) {
  const litAt = cx.now();
  for (;;) {
    const state = cx.store.readState();
    const servers = await Promise.all(members.map((m) => describeServer(cx, state, m, key, syncErrors)));
    const lit = servers.filter((s) => s.lit);
    const ready = lit.length > 0 && lit.every((s) => s.listening);
    const settled = lit.every(
      (s) => s.listening || s.needsVariant || (s.server !== "running" && cx.now() - litAt >= cx.graceMs),
    );
    if (ready || settled || cx.now() >= deadline) return { servers, ready };
    await cx.sleep(Math.min(cx.portPollMs, Math.max(0, deadline - cx.now())));
  }
}

// What `on` saw of each lit server goes back to state.json (badges, status).
export async function recordServers(cx, servers) {
  await cx.store.updateState((s) => {
    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (!sv.lit || !sv.serverState || !r || r.serverState === "needs-variant") continue;
      r.serverState = sv.serverState;
      r.ports = sv.ports;
    }
  });
}

// ── reap ───────────────────────────────────────────────────────────────────

// Refs win (D7): T1's readRefs into T2's reconcileRepo for each repo in
// state.json plus every registered one (to find orphan refs). A repo whose
// lock is busy is skipped: someone is working on it, and reap returns in
// under a second (D18). A record with no holder and no refs (a fresh
// activation that failed) is kept: it carries the error for the badge.
export async function reconcileFree(cx) {
  const store = cx.reapStore;
  const roots = [...new Set([...Object.keys(store.readState().repos), ...registeredRoots(cx.shared)])];
  const changes = [];
  await Promise.all(
    roots.map(async (root) => {
      try {
        await store.withRepoLock(root, async () => {
          const refs = await readRefs(root);
          await store.updateState((s) => {
            const before = s.repos[root] ?? null;
            if (before && !before.holder && !refs.active) return;
            const out = reconcileRepo(before, refs, cx.now());
            if (out.action === "keep") return;
            if (out.action === "clear") delete s.repos[root];
            else s.repos[root] = out.record;
            changes.push({ root, action: out.action });
          });
        });
      } catch (e) {
        if (!(e instanceof LockError && e.code === "lock-timeout")) throw e;
      }
    }),
  );
  return changes;
}

// `spotlight reap` (the footer, every 30 s and on terminal changes; D12,
// D13, D19, D10): refs win; each requesting terminal's turn end (release,
// pause, or a detached `classify` when the usage is stale); holders'
// activity; gone servers and log rotation; a regrant (a raised cap); and
// lights for turns whose marker is missing or whose light died.
// `on` and `off` run the queue part only (`full: false`: turn ends, the
// regrant, the lights; D13 "checked by on, off and reap"), so the line moves
// while the footer isn't running; `skip` is the caller's own terminal, whose
// request it is rewriting itself.
export async function reap(cx, { full = true, skip = null } = {}) {
  const now = cx.now();
  const reconciled = full ? await reconcileFree(cx) : [];
  const state = cx.store.readState();
  const requests = state.queue.requests;

  const asked = requests.filter((r) => r.terminal !== skip);
  const facts = new Map();
  await Promise.all([...new Set(asked.map((r) => r.terminal))].map(async (t) => facts.set(t, await hcGet(t))));
  const decisions = [];
  for (const req of asked) {
    const got = facts.get(req.terminal);
    // hc couldn't say: doubt is never death.
    if (got.error) continue;
    const term = got.missing ? null : got.terminal;
    let d = decideTurnEnd(req, term, now, undefined);
    if (d.action === "need-usage") d = decideTurnEnd(req, term, now, await cx.accountUsage(req.terminal));
    let activity = null;
    if (full && req.state === "holding" && term?.state === "live") {
      const statusMs = term.status_ms ?? null;
      activity = activityUpdate(req, { statusMs }, now);
      if (!activity) {
        const text = await hcReadText(req.terminal, 40);
        activity = activityUpdate(req, { statusMs, outputHash: text == null ? undefined : sha1(text) }, now);
      }
    }
    decisions.push({ req, d, activity });
  }

  const servers = [];
  for (const [root, rec] of full ? Object.entries(state.repos) : []) {
    if (rec.logPath) rotateLog(rec.logPath);
    if (!rec.serverTerminal || rec.serverState === "needs-variant") continue;
    const live = await readServerState(
      { root, terminal: rec.serverTerminal, logPath: rec.logPath, serverPid: rec.serverPid, port: repoSettings(cx.settings, root).port },
      cx.serverDeps,
    );
    if (live.state) servers.push({ root, state: live.state, ports: live.ports });
  }

  const out = await cx.store.updateState((s) => {
    let queue = s.queue;
    const granted = [];
    const classify = [];
    const counts = { released: 0, paused: 0, classify: 0, reconciled: reconciled.length };
    const find = (t) => queue.requests.find((r) => r.terminal === t);
    for (const { req, d, activity } of decisions) {
      const cur = find(req.terminal);
      // Asked again (or left) since the facts were read: its new request rules.
      if (!cur || cur.state !== req.state || cur.taskKey !== req.taskKey || cur.requestTurn !== req.requestTurn) continue;
      if (activity) Object.assign(cur, activity);
      if (d.action === "release") {
        const o = release(queue, req.terminal, qctxOf(cx));
        queue = o.queue;
        granted.push(...o.granted);
        counts.released += 1;
      } else if (d.action === "pause") {
        const o = pause(queue, req.terminal, { reason: d.reason, msg: d.msg }, qctxOf(cx));
        queue = o.queue;
        granted.push(...o.granted);
        const paused = queue.requests.find((r) => r.terminal === req.terminal);
        if (paused) paused.handledTurn = d.turn;
        counts.paused += 1;
      } else if (d.action === "baseline") {
        cur.requestTurn = d.turn;
      } else if (d.action === "classify" && cur.classifyTurn !== d.turn) {
        Object.assign(cur, { classifyTurn: d.turn, classifyAt: now, classifyPid: null });
        classify.push(req.terminal);
        counts.classify += 1;
      }
    }
    const o = regrant(queue, qctxOf(cx));
    queue = o.queue;
    granted.push(...o.granted);
    s.queue = queue;

    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (!r) continue;
      r.serverState = sv.state;
      r.ports = sv.ports;
    }

    const keys = markGranted(s, granted, now);
    for (const turn of snapshot(s.queue).turns) {
      if (keys.includes(turn.taskKey)) continue;
      if (needsLight(s.queue.lighting[turn.taskKey], turn, { now, pidAlive, repos: s.repos })) {
        s.queue.lighting[turn.taskKey] = lightingMarker(turn, { now, taskKey: turn.taskKey });
        keys.push(turn.taskKey);
      }
    }
    dropStaleMarkers(s, now);
    return { keys, classify, counts };
  });

  await spawnLights(cx, out.result.keys);
  for (const t of out.result.classify) {
    const pid = cx.spawn(["classify", "--terminal", t]);
    await cx.store.updateState((s) => {
      const r = s.queue.requests.find((x) => x.terminal === t);
      if (r && r.classifyPid == null) r.classifyPid = pid;
    });
  }
  return { ...out.result.counts, lights: out.result.keys.length };
}
