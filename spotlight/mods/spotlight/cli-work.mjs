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
import {
  activate, sync, deactivate, assertDeactivatable, readRefs, readOrcaHolds, toSpotlightError, ORCA_HOLDS_MESSAGE,
} from "./sync.js";
import { emptyRepo, addNote, reconcileRepo, rememberVariant } from "./store.js";
import { pidAlive, LockError } from "./locks.js";
import { repoSettings, normRoot } from "./settings.js";
import {
  planServer, lockfileInstalls, missingInstalls, installsFor, chainInstall, detectServerScripts, commandTemplate, expectedPort,
} from "./server-plan.js";
import { inspectServer, readServerState, startServer, restartServer, stopServer } from "./server.js";
import { logPathFor, appendLogHeader, rotateLog, readStartFailure } from "./server-log.js";
import { portUrl, foreignListener, stopProcessTree } from "./ports.js";
import { release, pause, regrant, snapshot } from "./queue.js";
import {
  decideTurnEnd, activityUpdate, lightingMarker, lightAlive, needsLight, memberLit, classifyStep,
} from "./cli-turns.mjs";
import { branchOf, hcGet, hcReadText, registeredRoots } from "./cli-env.mjs";

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// D17: the server badge's command id of a workspace's row.
export const serverId = (workspace) => sha1(normRoot(workspace)).slice(0, 12);

// Errors whose toast opens the server popup (Forzar sync, Apagar igual, D22;
// Liberar puerto y arrancar, D24; Ver log and Reintentar, D25).
const POPUP_CODES = new Set(["root-diverged", "untracked-collision", "port-busy", "server-exited"]);
// Errors about the server, not the root: a sync that goes through leaves
// them; a start that goes through clears them (D24), and so does the server
// coming up to listen after them (D25).
const SERVER_ERRORS = new Set(["port-busy", "server-exited"]);

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
  "port-busy": "puerto ocupado",
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
  if (r.reason === "still-running") return "el server sigue corriendo: no paró con Ctrl-C y no se reinició";
  return `el server no arrancó (${r.reason}${r.message ? `: ${r.message}` : ""})`;
}

// The env a repo's server should run (J-002): the one picked in the server
// popup (`spotlight env --env`, the record's envOverride, kept until `toggle`
// off), else the settings' env, the repo's default. The record's serverEnv
// only says what runs now.
export const effectiveEnv = (cx, root, record) => record?.envOverride ?? repoSettings(cx.settings, root).env;

const RUNNING = new Set(["starting", "listening"]);
// What the server terminal holds (server.js inspectServer) when a start or
// restart would type into it: a free prompt, none yet, Spotlight's server.
const TYPES_INTO = new Set(["shell", "gone", "spotlight"]);

// Spotlight's server runs in another env than the effective one, and that
// env starts something: it restarts, as on a command change (D10, J-002).
// An env with no command leaves the server alone, so nobody retries it.
export async function envDrift(cx, root, record) {
  if (!record?.holder || !record.serverCommand || !RUNNING.has(record.serverState)) return false;
  const env = effectiveEnv(cx, root, record);
  if (record.serverEnv === env) return false;
  const { detected } = await detectServerScripts(root, cx.io);
  return commandTemplate({ settings: repoSettings(cx.settings, root), detected, env }) !== null;
}

// Plans the repo's server for `workspace` (T5a) and starts it, restarts it
// (its command or env changed, installs are pending, or `restart`), or
// leaves it. Call under the repo's lock. Options:
//   taskKey      `<lane>/<taskKey>` whose remembered variant applies
//   envName      the env to run (else effectiveEnv's)
//   chosenVariant  a variant picked now (`spotlight env --variant`)
//   keepVariant  reuse the running server's variant (a restart, a sync)
//   restart      restart even when nothing changed (`spotlight restart`)
//   ifRunning    touch only a server Spotlight runs now (a sync's installs)
//   freePort     Liberar puerto y arrancar: stop the process the recorded
//                port-busy error names when it still holds the port (D24)
// Nothing is typed while a process outside the server terminal's tree holds
// the port the start takes (D23, D24): lastError port-busy, a toast that
// opens the popup, and { state: "port-busy", error }.
// → { state: started | running | needs-variant | none | pending | failed | port-busy, … }
export async function ensureServer(cx, root, opts = {}) {
  const { workspace, branch = null, taskKey = null, envName, restart = false, ifRunning = false } = opts;
  const state = cx.store.readState();
  const record = state.repos[root];
  if (!record) return { state: "none" };
  const repoSet = repoSettings(cx.settings, root);
  const env = envName ?? effectiveEnv(cx, root, record);
  const chosenVariant = opts.chosenVariant ?? (opts.keepVariant ? record.serverVariant ?? undefined : undefined);
  const plan = await planServer({
    root, workspace, settings: repoSet, env, taskKey, remembered: state.variants, chosenVariant, io: cx.io, git: cx.planGit,
  });
  const now = cx.now();
  if (plan.kind === "ask-variant") {
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      Object.assign(r, { serverState: "needs-variant", variantCandidates: plan.candidates });
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
  let freed = null;
  const same = record.serverCommand === plan.command && record.serverEnv === plan.env;
  if (seen.kind === "spotlight" && !restart && same && pending.length === 0) {
    r = { ok: true, started: false, reason: "already-running", terminal: seen.terminal, pid: seen.pid };
  } else {
    // Checked only where a line would be typed. A terminal hc can't read, or
    // one running something Spotlight didn't start, refuses the start on its
    // own; and without the terminal's pid, Spotlight's own server would read
    // as a stranger holding the port.
    if (TYPES_INTO.has(seen.kind)) {
      const port = await checkPort(cx, root, {
        command: plan.command, settings: repoSet, rootPid: seen.rootPid ?? null, freePort: opts.freePort, shown: record.lastError,
      });
      freed = port.freed;
      if (port.busy) return refusePort(cx, root, { busy: port.busy, freed, plan, seen, logPath, workspace, branch, now });
    }
    r = seen.kind === "spotlight" ? await restartServer(args, cx.serverDeps) : await startServer(args, cx.serverDeps);
  }
  await cx.store.updateState((s) => {
    const rec = s.repos[root];
    if (!rec) return;
    rec.logPath = logPath;
    if (freed?.ok) addNote(s, { repo: root, text: `${cx.nameOf(root)}: ${freedText(freed)}` }, now);
    if (r.terminal) rec.serverTerminal = r.terminal;
    if (r.ok && r.started) {
      // serverEnv says what runs now (J-002, J-008): written only when it starts.
      Object.assign(rec, {
        serverCommand: plan.command, serverEnv: plan.env, serverVariant: plan.variant, serverPid: r.pid ?? null, serverStartedAt: now,
        serverState: "starting", pendingInstalls: [], variantCandidates: [],
      });
      delete rec.envFailed;
      delete rec.envFailedAt;
      if (SERVER_ERRORS.has(rec.lastError?.code)) rec.lastError = null;
      if (taskKey && plan.variant && (plan.source === "inferred" || plan.source === "chosen")) {
        rememberVariant(s, `${taskKey}::${normRoot(root)}`, plan.variant);
      }
      if (plan.note) addNote(s, { repo: root, text: plan.note, toast: true }, now);
    } else if (r.ok && r.reason === "already-running") {
      if (rec.serverState !== "listening") rec.serverState = "starting";
      if (r.pid) rec.serverPid = r.pid;
      rec.variantCandidates = [];
    } else {
      // A server that ignored Ctrl-C keeps the state it had: it's still up.
      if (r.reason !== "still-running") rec.serverState = r.reason === "terminal-gone" ? "gone" : "stopped";
      if (rec.serverEnv !== plan.env) Object.assign(rec, { envFailed: plan.env, envFailedAt: now });
      addNote(s, { repo: root, text: `${cx.nameOf(root)}: ${serverFailure(r)}`, toast: true }, now);
    }
  });
  const word = r.ok && r.started ? "started" : r.ok && r.reason === "already-running" ? "running" : "failed";
  return { state: word, result: r, plan, freed };
}

// ── A busy port (D23, D24) ─────────────────────────────────────────────────

// The port-busy error of a holder found by checkPort; with no pid, a port a
// server found taken when it started (D25) and nobody listens on any more.
export function portBusyError({ port, pid = null, command = null, cwd = null }) {
  if (!Number.isInteger(pid)) {
    const which = Number.isInteger(port) ? `El puerto ${port}` : "El puerto del server";
    return { code: "port-busy", port: port ?? null, pid: null, command: null, cwd: null, message: `${which} estaba ocupado al arrancar el server.` };
  }
  const where = cwd ? `pid ${pid}, en ${cwd}` : `pid ${pid}`;
  return { code: "port-busy", port, pid, command, cwd, message: `El puerto ${port} lo tiene ${command ?? "otro proceso"} (${where}).` };
}

// Who holds the port this start takes, from outside the server terminal's
// tree (rootPid; none when there's no terminal yet). The port is the one
// the command will take (D23), else the one a recorded port-busy names (a
// server that died on it, D25, whose command doesn't say). With `freePort`,
// the process the recorded port-busy error (`shown`) names is stopped first
// — SIGTERM to it and its descendants, SIGKILL 5 s later — and only while it
// is still the one holding that port: whatever took it since is shown, not
// stopped. → { busy: { port, pid, command, cwd } | null, freed }.
async function checkPort(cx, root, { command, settings, rootPid, freePort, shown }) {
  const recorded = shown?.code === "port-busy" && Number.isInteger(shown.port) ? shown.port : null;
  const port = (await expectedPort({ root, command, settings, io: cx.io })) ?? recorded;
  if (port === null) return { busy: null, freed: null };
  const holder = async () => {
    const found = await foreignListener(port, rootPid, cx.serverDeps);
    return found ? { port, ...found } : null;
  };
  let busy = await holder();
  if (!busy || !freePort || shown?.code !== "port-busy" || shown.port !== port || shown.pid !== busy.pid) return { busy, freed: null };
  const stopped = await stopProcessTree(
    busy.pid,
    { ...cx.serverDeps, kill: (pid, signal) => process.kill(pid, signal) },
    { protect: [process.pid, rootPid].filter(Number.isInteger) },
  );
  const freed = { ...busy, ...stopped };
  if (stopped.ok) busy = await holder();
  return { busy, freed };
}

// What a stopped holder leaves in the notes.
function freedText({ port, pid, command, killed }) {
  const forced = killed?.length > 0 ? `; ${killed.length} no paró con SIGTERM y se mató con SIGKILL` : "";
  return `Puerto ${port} liberado: se paró ${command ?? "el proceso"} (pid ${pid})${forced}.`;
}

// The start refused: lastError port-busy, one toast per new holder (it
// opens the popup), a line in the server's log, nothing typed.
async function refusePort(cx, root, { busy, freed, plan, seen, logPath, workspace, branch, now }) {
  const error = portBusyError(busy);
  const name = cx.nameOf(root);
  await cx.store.updateState((s) => {
    const rec = s.repos[root];
    if (!rec) return;
    const known = rec.lastError?.code === error.code && rec.lastError?.message === error.message;
    rec.lastError = { ...error, at: now };
    // A server Spotlight runs keeps its state: the restart didn't touch it.
    if (seen.kind !== "spotlight") rec.serverState = "stopped";
    if (freed?.ok) addNote(s, { repo: root, text: `${name}: ${freedText(freed)}` }, now);
    if (!known) errorNote(s, { root, name, workspace, error, now });
  });
  appendLogHeader(logPath, {
    workspace: workspace ? path.basename(workspace) : null, branch, at: now,
    event: `Server not started — port ${busy.port} is held by ${busy.command ?? "another process"} (pid ${busy.pid})`,
  });
  return { state: "port-busy", error, plan, freed };
}

// ── A server that died at start (D25) ──────────────────────────────────────

// How long the reap and `on` wait for a repo's lock before deciding a dead
// start. A start or restart in flight holds that lock, and the free prompt
// it leaves between a Ctrl-C and the line it types next is no death.
const DEAD_START_LOCK_MS = 300;

// Spotlight started the server (`starting`) and the terminal's shell leads
// again with no port open (server.js readServerState: stopped, no owner).
const diedAtStart = (record, live) =>
  record?.serverState === "starting" && live?.state === "stopped" && live.owner === null;

function serverExitedError(line) {
  return { code: "server-exited", message: line ? `El server se cayó al arrancar: ${line}` : "El server se cayó al arrancar." };
}

// Why a dead start died, from its log since the last start marker: a port
// already taken is port-busy, T13's shape, naming the process that still
// listens there if one does (the port from the log, else the command's,
// D23); anything else is server-exited with its first error line.
async function deadStartError(cx, root, record) {
  const failure = readStartFailure(record.logPath ?? logPathFor(root));
  if (failure.kind !== "addr-in-use") return serverExitedError(failure.line);
  const port =
    failure.port ??
    (await expectedPort({ root, command: record.serverCommand ?? null, settings: repoSettings(cx.settings, root), io: cx.io }));
  // The server's tree has no port left: whoever listens there is someone else.
  const holder = Number.isInteger(port) ? await foreignListener(port, null, cx.serverDeps) : null;
  return portBusyError({ port, ...(holder ?? {}) });
}

// Records a dead start under the repo's lock, where the record and the
// terminal are read again, so a start or restart in flight is never taken
// for one: lastError, serverState stopped, and a toast that opens the popup
// (one per error). A lock held past DEAD_START_LOCK_MS leaves it `starting`
// for the next reap. → the error recorded, or null.
async function settleDeadStart(cx, root) {
  try {
    return await cx.store.withRepoLock(
      root,
      async () => {
        const record = cx.store.readState().repos[root];
        if (!record?.serverTerminal || record.serverState !== "starting") return null;
        const live = await readServerState(
          { root, terminal: record.serverTerminal, logPath: record.logPath, serverPid: record.serverPid, port: repoSettings(cx.settings, root).port },
          cx.serverDeps,
        );
        if (!diedAtStart(record, live)) return null;
        const error = await deadStartError(cx, root, record);
        const now = cx.now();
        const wrote = await cx.store.updateState((s) => {
          const rec = s.repos[root];
          if (!rec || rec.serverState !== "starting" || rec.serverStartedAt !== record.serverStartedAt) return false;
          const known = rec.lastError?.code === error.code && rec.lastError?.message === error.message;
          Object.assign(rec, { serverState: "stopped", ports: [], lastError: { ...error, at: now } });
          if (!known) errorNote(s, { root, name: cx.nameOf(root), workspace: rec.holder, error, now });
          return true;
        });
        return wrote.result ? error : null;
      },
      { timeoutMs: DEAD_START_LOCK_MS },
    );
  } catch (e) {
    if (e instanceof LockError && e.code === "lock-timeout") return null;
    throw e;
  }
}

// A server error goes once the server listens after it (D25): only on the
// way into `listening`, so a refused restart over a server that kept
// listening keeps its port-busy (D24).
function clearOnListen(record, liveState) {
  if (liveState === "listening" && record.serverState !== "listening" && SERVER_ERRORS.has(record.lastError?.code)) {
    record.lastError = null;
  }
}

// ── sync ───────────────────────────────────────────────────────────────────

// Why the restart a sync asked for didn't happen, for `spotlight sync`'s line.
const restartFailure = (server) =>
  server?.state === "failed" ? server.result.reason : server?.state === "port-busy" ? "port-busy" : null;

// Brings the root in step with its holder (`spotlight sync`, auto-sync, and
// `on` for each lit member). Under the repo lock; the holder is read inside
// it. `onlyIf(record)`: sync only when it says so (`on`: the task's own
// holder). A sync that changes nothing writes nothing (D7). A changed
// pnpm-lock.yaml / uv.lock restarts Spotlight's running server with the
// install chained (D10), and so does a server running another env than the
// effective one (J-002: a settings change, picked up by the next `on`,
// auto-sync, or the reap's detached sync). `lockTimeoutMs`: how long to wait
// for the repo lock (`on`'s time left, J-001); past it, LockError
// "lock-timeout".
export async function syncRepo(cx, root, { force = false, onlyIf, lockTimeoutMs } = {}) {
  const wait = lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs };
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
    // Spotlight's running server only, with its variant (D10).
    const refreshServer = async () =>
      ensureServer(cx, root, { workspace: holder, branch: await branchOf(holder), keepVariant: true, ifRunning: true });
    if (result.skipped) {
      if (record.lastError && !SERVER_ERRORS.has(record.lastError.code)) {
        await cx.store.updateState((s) => {
          if (s.repos[root] && !SERVER_ERRORS.has(s.repos[root].lastError?.code)) s.repos[root].lastError = null;
        });
      }
      const server = (await envDrift(cx, root, record)) ? await refreshServer() : null;
      return { ok: true, skipped: true, holder, restarted: server?.state === "started", restartFailed: restartFailure(server) };
    }
    const installs = await lockfileInstalls({ git: cx.planGit, root, fromSha: record.lastSnapshotSha, toSha: result.snapshotSha });
    const now = cx.now();
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      Object.assign(r, { lastSnapshotSha: result.snapshotSha, lastSyncAt: now });
      if (!SERVER_ERRORS.has(r.lastError?.code)) r.lastError = null;
      r.pendingInstalls = installsFor(r.pendingInstalls, installs);
    });
    let server = null;
    if (installs.length > 0 || (await envDrift(cx, root, record))) server = await refreshServer();
    return { ok: true, skipped: false, holder, installs, restarted: server?.state === "started", restartFailed: restartFailure(server) };
  }, wait);
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
        // The ports the server was last seen on (D26): a child that left the
        // server's tree before the turn-off still dies when it holds one.
        ports: Array.isArray(record?.ports) ? record.ports : [],
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
      for (const text of rescuedNotes(res.rescued, res.discardedRepos)) addNote(s, { repo: root, text: `${name}: ${text}`, toast: true }, now);
    });
    return { ok: true, warning: res.warning, stopped, rescued: res.rescued, discardedRepos: res.discardedRepos };
  });
}

// What a turn-off did with untracked root files in its way (sync.js
// deactivate's `rescued`), one line each, in Spanish like the other toasts.
export function rescuedNotes(rescued, discardedRepos = []) {
  const names = (ps) => ps.slice(0, 3).join(", ") + (ps.length > 3 ? ` (+${ps.length - 3} más)` : "");
  const lines = [];
  if (discardedRepos.length > 0) {
    lines.push(
      discardedRepos.length === 1
        ? `Había un repo de git en ${names(discardedRepos)}, en una ruta que Apagar igual escribió: no se guardó.`
        : `Había repos de git en ${names(discardedRepos)}, en rutas que Apagar igual escribió: no se guardaron.`,
    );
  }
  if (!rescued) return lines;
  if (rescued.restored.length > 0) {
    const verb = rescued.restored.length === 1 ? "quedó" : "quedaron";
    lines.push(`${names(rescued.restored)} ${verb} como cambio sin commit (tu versión). Copia en ${rescued.ref}.`);
  }
  if (rescued.kept.length > 0) {
    // `git show`, not `git checkout <ref> -- <archivo>`: that would overwrite
    // what came back, and nothing else keeps that version once the refs go.
    const verb = rescued.kept.length === 1 ? "devolvió" : "devolvieron";
    lines.push(
      `${names(rescued.kept)} no se ${verb}: en esa ruta quedó lo que el root tenía antes de Spotlight. Tu versión está en ${rescued.ref} (git show ${rescued.ref}:<archivo>).`,
    );
  }
  return lines;
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
  // D25: a start that died says why, read from its log now (recordServers
  // records it). D24, D25: a start a busy port refused, or one that died
  // before; nothing will open a port, and the agent reads why.
  const deadStart = diedAtStart(record, live);
  const died = deadStart ? await deadStartError(cx, member.root, record) : null;
  const why = died ?? (SERVER_ERRORS.has(record.lastError?.code) && live.state !== "listening" ? record.lastError : null);
  const down = why ? { serverError: true, error: why.message } : {};
  return {
    ...base,
    listening: live.state === "listening",
    server: running ? "running" : live.state === null ? "unknown" : "stopped",
    serverState: live.state,
    ports: live.ports,
    port: live.port ?? configured,
    url: live.url ?? portUrl(configured),
    syncError,
    deadStart,
    ...down,
  };
}

// Polls until every lit repo listens, or has no server (15 s after the wait
// began), or the deadline passes (O/src/main/spotlight/spotlight-agent-servers.ts:96-132).
// A repo waiting for a variant, whose start a busy port refused (D24), or
// whose server died starting (D25), has nothing to wait for. → { servers, ready }.
export async function waitForTurnServers(cx, { members, key, deadline, syncErrors }) {
  const litAt = cx.now();
  for (;;) {
    const state = cx.store.readState();
    const servers = await Promise.all(members.map((m) => describeServer(cx, state, m, key, syncErrors)));
    const lit = servers.filter((s) => s.lit);
    const ready = lit.length > 0 && lit.every((s) => s.listening);
    const settled = lit.every(
      (s) => s.listening || s.needsVariant || s.serverError || (s.server !== "running" && cx.now() - litAt >= cx.graceMs),
    );
    if (ready || settled || cx.now() >= deadline) return { servers, ready };
    await cx.sleep(Math.min(cx.portPollMs, Math.max(0, deadline - cx.now())));
  }
}

// What `on` saw of each lit server goes back to state.json (badges, status).
// A start that died is recorded as the reap records it (D25); one whose
// repo lock was busy stays `starting`, so the next reap still sees it.
export async function recordServers(cx, servers) {
  for (const sv of servers) if (sv.lit && sv.deadStart) await settleDeadStart(cx, sv.root);
  await cx.store.updateState((s) => {
    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (!sv.lit || !sv.serverState || !r || r.serverState === "needs-variant") continue;
      if (sv.deadStart && r.serverState === "starting") continue;
      clearOnListen(r, sv.serverState);
      r.serverState = sv.serverState;
      r.ports = sv.ports;
    }
  });
}

// ── reap ───────────────────────────────────────────────────────────────────

// D27: reconcileRepo for a root Orca's Spotlight may have (`orcaHolds`, its
// HEAD detached on an "Orca Spotlight" commit). While Orca has it, our record
// (or our orphan refs) says orca-holds, never reconcileRepo's root-diverged:
// that one offers Forzar sync and Apagar igual in the popup, which would undo
// Orca's projection, and flipping a sync's orca-holds back to it on every
// reap would toast it again on the next sync. Once Orca lets go, the record
// is decided again without that error: by reconcileRepo, a record with no
// holder (our orphan refs) from scratch. → reconcileRepo's { action,
// record? }, plus "orca-holds" and "cleared" (the error gone, nothing else).
export function reconcileWithOrca(before, refs, orcaHolds, at) {
  if (!refs?.rootHeadSha) return reconcileRepo(before, refs, at);
  const flagged = before?.lastError?.code === "orca-holds";
  if (orcaHolds && refs.active) {
    if (flagged) return { action: "keep" };
    const record = before ?? { ...emptyRepo(), lastSnapshotSha: refs.snapshotSha };
    return { action: "orca-holds", record: { ...record, lastError: { code: "orca-holds", message: ORCA_HOLDS_MESSAGE, at } } };
  }
  if (!flagged) return reconcileRepo(before, refs, at);
  const cleared = before.holder ? { ...before, lastError: null } : null;
  const out = reconcileRepo(cleared, refs, at);
  if (out.action !== "keep") return out;
  return cleared ? { action: "cleared", record: cleared } : { action: "keep" };
}

// Refs win (D7): T1's readRefs into T2's reconcileRepo for each repo in
// state.json plus every registered one (to find orphan refs). A repo whose
// lock is busy is skipped: someone is working on it, and reap returns in
// under a second (D18). A record with no holder and no refs (a fresh
// activation that failed) is kept: it carries the error for the badge.
// A root Orca's Spotlight has reads orca-holds (reconcileWithOrca, D27).
export async function reconcileFree(cx) {
  const store = cx.reapStore;
  const roots = [...new Set([...Object.keys(store.readState().repos), ...registeredRoots(cx.shared)])];
  const changes = [];
  await Promise.all(
    roots.map(async (root) => {
      try {
        await store.withRepoLock(root, async () => {
          const refs = await readRefs(root);
          // Only a root off our snapshot can be Orca's; read here, under the
          // repo lock and outside the state lock (never across git, D7).
          const orcaHolds = Boolean(refs.active && refs.rootHeadSha && refs.rootHeadSha !== refs.snapshotSha) &&
            (await readOrcaHolds(root));
          await store.updateState((s) => {
            const before = s.repos[root] ?? null;
            if (before && !before.holder && !refs.active) return;
            const out = reconcileWithOrca(before, refs, orcaHolds, cx.now());
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

// One turn-end decision (cli-turns.mjs decideTurnEnd) applied to `cur`, a
// request of `queue` (D13): release, pause (its turn end spent), or a first
// baseline. Shared by reap and `classify`. → { queue, granted, released,
// paused }.
export function applyTurnEnd(queue, cur, d, qctx) {
  if (d.action === "release") {
    const o = release(queue, cur.terminal, qctx);
    return { queue: o.queue, granted: o.granted, released: 1, paused: 0 };
  }
  if (d.action === "pause") {
    const o = pause(queue, cur.terminal, { reason: d.reason, msg: d.msg }, qctx);
    const paused = o.queue.requests.find((r) => r.terminal === cur.terminal);
    if (paused) paused.handledTurn = d.turn;
    return { queue: o.queue, granted: o.granted, released: 0, paused: 1 };
  }
  if (d.action === "baseline") cur.requestTurn = d.turn;
  return { queue, granted: [], released: 0, paused: 0 };
}

// `spotlight reap` (the footer, every 30 s and on terminal changes; D12,
// D13, D19, D10): refs win; each requesting terminal's turn end (release,
// pause, or a detached `classify` when the usage is stale, spawned again
// when it died: J-005); holders' activity; gone servers, servers that died
// starting (D25) and server errors a listen ends, log rotation and a
// detached sync for a server running another env than the effective one
// (J-002); a regrant (a raised cap); and lights for turns whose marker is
// missing or whose light died.
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
    let usage;
    if (d.action === "need-usage") {
      usage = await cx.accountUsage(req.terminal);
      d = decideTurnEnd(req, term, now, usage);
    }
    let activity = null;
    if (full && req.state === "holding" && term?.state === "live") {
      const statusMs = term.status_ms ?? null;
      activity = activityUpdate(req, { statusMs }, now);
      if (!activity) {
        const text = await hcReadText(req.terminal, 40);
        activity = activityUpdate(req, { statusMs, outputHash: text == null ? undefined : sha1(text) }, now);
      }
    }
    decisions.push({ req, d, activity, term, usage });
  }

  const servers = [];
  const envSyncs = [];
  // J-011: a settings save after a failed env is a new ask for it.
  const savedAt = full ? cx.store.settingsSavedAt() : 0;
  for (const [root, rec] of full ? Object.entries(state.repos) : []) {
    if (rec.logPath) rotateLog(rec.logPath);
    if (!rec.serverTerminal || rec.serverState === "needs-variant") continue;
    const live = await readServerState(
      { root, terminal: rec.serverTerminal, logPath: rec.logPath, serverPid: rec.serverPid, port: repoSettings(cx.settings, root).port },
      cx.serverDeps,
    );
    // D25: a start that died is decided under the repo lock, which writes
    // its state; until then it stays `starting`.
    if (diedAtStart(rec, live)) {
      await settleDeadStart(cx, root);
      continue;
    }
    if (live.state) servers.push({ root, state: live.state, ports: live.ports });
    // J-002: a server in another env than the effective one restarts through
    // a detached sync (D18: a restart outlasts the reap's second). Only
    // Spotlight's own server, never a foreign process holding a port. A root
    // with an error waits for it to clear: its sync would fail first. An env
    // that couldn't run isn't tried again from here (J-009) until settings
    // are saved after that (J-011); `on`, a sync or Reiniciar always do.
    const gaveUp = rec.envFailed === effectiveEnv(cx, root, rec) && !(savedAt > (rec.envFailedAt ?? 0));
    if (
      live.owner === "spotlight" && !rec.lastError && !gaveUp &&
      (await envDrift(cx, root, { ...rec, serverState: live.state }))
    ) envSyncs.push(root);
  }

  const out = await cx.store.updateState((s) => {
    let queue = s.queue;
    const granted = [];
    const classify = [];
    const counts = { released: 0, paused: 0, classify: 0, reconciled: reconciled.length };
    const find = (t) => queue.requests.find((r) => r.terminal === t);
    for (const { req, d, activity, term, usage } of decisions) {
      const cur = find(req.terminal);
      // Asked again (or left) since the facts were read: its new request rules.
      if (!cur || cur.state !== req.state || cur.taskKey !== req.taskKey || cur.requestTurn !== req.requestTurn) continue;
      if (activity) Object.assign(cur, activity);
      let decision = d;
      if (d.action === "classify") {
        // J-005: one classify per turn end, spawned again when it died or
        // got stuck before deciding, at most CLASSIFY_RESPAWNS times.
        const step = classifyStep(cur, d.turn, { now, pidAlive });
        if (step.action === "spawn") {
          Object.assign(cur, { classifyTurn: d.turn, classifyAt: now, classifyPid: null, classifySpawns: step.spawns });
          classify.push(req.terminal);
          counts.classify += 1;
        }
        if (step.action !== "fallback") continue;
        // Every respawn spent: decided with the usage read here, stale as it
        // is, as a classify whose refresh fails decides with the last data.
        decision = decideTurnEnd(cur, term, now, { ...usage, fresh: true });
      }
      const o = applyTurnEnd(queue, cur, decision, qctxOf(cx));
      queue = o.queue;
      granted.push(...o.granted);
      counts.released += o.released;
      counts.paused += o.paused;
    }
    const o = regrant(queue, qctxOf(cx));
    queue = o.queue;
    granted.push(...o.granted);
    s.queue = queue;

    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (!r) continue;
      clearOnListen(r, sv.state);
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
  for (const root of envSyncs) cx.spawn(["sync", "--repo", root]);
  return { ...out.result.counts, lights: out.result.keys.length };
}
