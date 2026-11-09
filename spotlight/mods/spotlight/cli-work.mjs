// The CLI's work on repos and the queue (D7, D8, D10–D13, D18, D19, D32,
// D33, D34): lighting a task's repos, syncing a holder, turning a root off,
// the server (start, restart on a lockfile or command change, its end by
// hand), the env per task (its picks and the restarts they ask for),
// waiting for the servers to listen (port of Orca's waitForTurnServers), and
// the reap. Node-only.
//
// Every git step runs under the repo's lock and reads the holder inside it,
// so the last one to take the lock sees the latest holder (a sync racing a
// takeover syncs the new holder). state.json is written only through
// updateState, under the state lock, never across git (D7). A light, a
// turn-off, a Forzar sync and a server restart mark the repo busy while they
// hold its lock (withBusy, D33).

import path from "node:path";
import crypto from "node:crypto";
import {
  activate, sync, deactivate, assertDeactivatable, readRefs, readOrcaHolds, toSpotlightError, ORCA_HOLDS_MESSAGE,
} from "./sync.js";
import {
  emptyRepo, addNote, reconcileRepo, rememberVariant, rememberEnv, markBusy, clearBusy, setTaskBatch, clearTaskBatch,
} from "./store.js";
import { pidAlive, isStale, LockError } from "./locks.js";
import { repoSettings, normRoot } from "./settings.js";
import {
  planServer, lockfileInstalls, missingInstalls, installsFor, chainInstall, detectServerScripts, commandTemplate, expectedPort,
} from "./server-plan.js";
import {
  inspectServer, readServerState, startServer, restartServer, stopServer, ensureServerTerminal, serverTerminalHidden, showServerTerminal,
  NOTED_STOP_FAILURES,
} from "./server.js";
import { logPathFor, appendLogHeader, rotateLog, readStartFailure, causeWords } from "./server-log.js";
import { portUrl, foreignListener, stopProcessTree, goneIdentities, identityKey, isIdentity } from "./ports.js";
import { release, pause, regrant, snapshot } from "./queue.js";
import {
  decideTurnEnd, activityUpdate, lightingMarker, lightAlive, needsLight, memberLit, classifyStep,
} from "./cli-turns.mjs";
import { branchOf, hcGet, hcReadText, registeredRoots, taskKeyOfWorkspace } from "./cli-env.mjs";
import { recordEnv, envKeyOf } from "./task-env.js";
import {
  SERVER_ERRORS, PORT_BUSY, SERVER_EXITED, SERVER_START_FAILED, SERVER_SURVIVED, SERVER_NOT_STOPPED, isServerError, serverErrorOf,
  setRootError, setServerError, clearRootError, clearServerError, serverDown,
} from "./server-errors.js";
import { oneLine } from "./text.js";

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// D17: the server badge's command id of a workspace's row.
export const serverId = (workspace) => sha1(normRoot(workspace)).slice(0, 12);

// server.js's look at the server (readServerState: its ports and processes),
// its stop, whose answers the reap, `on` and the turn-off act on, and the
// reap's showing of a hidden server terminal (D38). A test's cx stands in
// for them (cx.server) with the shapes they answer.
const serverOf = (cx) => ({ readServerState, stopServer, serverTerminalHidden, showServerTerminal, ...(cx.server ?? {}) });

// Errors whose toast opens the server popup (Forzar sync, Apagar igual, D22;
// Liberar puerto y arrancar, D24; Ver log and Reintentar, D25: the server
// errors a record holds, server-errors.js SERVER_ERRORS; a turn-off's
// TURN_OFF_ERRORS toast with no action, deactivateRepo). A record's
// lastError holds a root error and a server error, each written and cleared
// on its own (server-errors.js): a sync that goes through leaves a server
// error and ends a root error; a start that goes through ends a server error
// (D24), and so does the server coming up to listen after it (D25), a
// takeover whose server needs no start (ensureServer's `takeover`, H3, K2)
// and a plan with no command once no server of Spotlight's may run there
// (K1, L5); a start that fails writes its own (K3).
const POPUP_CODES = new Set(["root-diverged", "untracked-collision", ...SERVER_ERRORS]);

const qctxOf = (cx) => ({ now: cx.now(), ...cx.settings.queue });

// The server popup's button for a root error it can force (D22, D35, as
// server-view-model.js names them), by what was refused (`op`): Orca's
// "Activate anyway", "Force sync" and "Turn off anyway". A server error
// under a root error is the server's (no op): the holder's tree over the
// root, Forzar sync, is what resolves it.
const FORCE_BUTTONS = { light: "Proyectar igual", sync: "Forzar sync", off: "Apagar igual" };

// The popup's button a toast for `shown` leads to (D35): a root error's
// force (FORCE_BUTTONS), a busy port's Liberar puerto y arrancar (D24), a
// dead or failed start's Reintentar, or Reiniciar while the server is up
// (the popup's own labels, server-errors.js serverDown). `record`: the
// repo's, as its caller wrote it.
function popupButton(shown, record, op) {
  if (shown.code === PORT_BUSY) return "Liberar puerto y arrancar";
  if (isServerError(shown)) return serverDown(record) ? "Reintentar" : "Reiniciar";
  return FORCE_BUTTONS[op] ?? FORCE_BUTTONS.sync;
}

// D41: the title of a toast Herdr has and Orca doesn't (a busy port, a dead
// or failed start, a stuck restart, a server ended by hand, an inferred
// variant, rescued files): its words stay the body, under the repo's name.
export const herdrTitle = (name) => `Spotlight · ${name}`;

// D41: a toast note of Herdr's own words on a repo: `text` "<repo>: <words>"
// as before (the log's line), the toast herdrTitle over `body`, the words
// (the repo is in the title now).
const herdrNote = (root, name, words, body = words) => ({ repo: root, text: `${name}: ${words}`, toast: true, title: herdrTitle(name), body });

// D41: an error toast's title by what was refused (Orca's
// spotlightActivateFailedTitle, "Spotlight sync failed",
// spotlightDeactivateFailedTitle), in Spanish.
const ERROR_TITLES = {
  light: (name) => `No se pudo prender Spotlight en ${name}`,
  sync: () => "Falló el sync de Spotlight",
  off: (name) => `No se pudo apagar Spotlight en ${name}`,
};

// D41: Orca's description of an error code (spotlightErrorDescription), in
// Spanish; any other code's toast says its own message.
const ORCA_DESCRIPTIONS = {
  "operation-in-progress": "Termina o aborta primero el merge/rebase en curso.",
  "root-diverged": "El root del proyecto tiene cambios hechos fuera del workspace de Spotlight. Haz commit o descártalos ahí primero.",
  "restore-conflict": "Restaurar los cambios originales del root dio conflicto. Resuélvelo en el root del proyecto y vuelve a intentar.",
  "untracked-collision": "Archivos sin seguimiento en el root se sobrescribirían. Muévelos o bórralos, o fuerza el sync.",
  "not-enabled": "Spotlight no está activado para este proyecto.",
};

// A toast for `error` on `root`, opening the server popup when the popup can
// act on the error it shows: `top`, the record's lastError once written (a
// server error under orca-holds opens nothing, F7), else `error` itself
// (POPUP_CODES); orca-holds and orca-active toast with no action. A server
// error that went under a root error (`top`) can't be acted on before that
// root error is resolved, and the popup shows the root error: its toast says
// so, "<server error> Antes resuelve el root: <root error>" (G10), the root
// error on one line whatever lines git gave it (H6). Every one is an error
// note (D35: it toasts for 60 s); one that opens the popup carries the
// button waiting there (popupButton), which its toast's body names, by
// `op`: what was refused, "light", "sync" or "off" (a server error's
// callers pass none).
// D41: refused (`op`), its title says what was (ERROR_TITLES) and its body
// is Orca's description of the code, else the message; `also`, why the
// server didn't stop either, follows a description (a message says it
// already, alsoNotStopped). A server error (no `op`) is Herdr's own:
// herdrTitle over its words. The note's `text` stays "<repo>: <message>",
// the log's line.
export function errorNote(s, { root, name, workspace, error, now, top = null, op = null, also = null }) {
  const shown = top ?? error;
  const opens = POPUP_CODES.has(shown.code) && workspace;
  const popup = opens
    ? { action: { name: `spotlight.server.${serverId(workspace)}` }, button: popupButton(shown, s.repos?.[root], op) }
    : {};
  const under = top && isServerError(error) && !isServerError(top) ? ` Antes resuelve el root: ${oneLine(top.message)}` : "";
  const titled = ERROR_TITLES[op];
  const said = ORCA_DESCRIPTIONS[error.code];
  let body = `${error.message}${under}`;
  if (titled && said) body = also ? `${said} Además, el server no paró: ${also}.` : said;
  addNote(s, {
    repo: root, text: `${name}: ${error.message}${under}`, toast: true, level: "error", ...popup,
    title: titled ? titled(name) : herdrTitle(name), body,
  }, now);
}

// Whether the server error in force on `record` is `error` already: one
// toast per new server error, wherever it sits (F7).
const shownAlready = (record, error) => {
  const shown = serverErrorOf(record?.lastError);
  return shown?.code === error.code && shown?.message === error.message;
};

// ── Busy (D33) and the task batch (D31) ────────────────────────────────────

// Runs `fn` with `root`'s record marked busy, `{ op, since, pid, workspace }`
// (the badges' spinning ring in place of its flashlight; the workspace
// menu's toggle and Forzar sync disabled), cleared in `finally` whatever fn
// does. Call it under the repo's lock: the mark is the lock holder's
// (store.js markBusy, which leaves a nested call's to the outer one, and
// makes a record for the mark only with `create`: a fresh light, whose
// target's row spins before it holds). `workspace` is the target, or a
// function of the record as the mark is written (a turn-off's or a Forzar
// sync's holder). A clear that can't be written, or a process that dies
// first, leaves a mark the reap clears once its process is gone (staleMarks).
async function withBusy(cx, root, { op, workspace = null, create = false }, fn) {
  const since = cx.now();
  const set = await cx.store.updateState((s) => {
    const target = typeof workspace === "function" ? workspace(s.repos[root] ?? null) : workspace;
    const mark = { op, since, pid: process.pid, workspace: target ?? null };
    return markBusy(s, root, mark, { create }) ? mark : null;
  });
  const mark = set.result;
  if (!mark) return fn();
  try {
    return await fn();
  } finally {
    try {
      await cx.store.updateState((s) => {
        clearBusy(s, root, mark);
      });
    } catch {
      // Left for the reap: the work's own outcome is what the caller needs.
    }
  }
}

// The repo's lock, held with the repo marked busy while `fn` runs.
// `wait`: withRepoLock's options.
const withBusyRepo = (cx, root, busy, fn, wait = {}) => cx.store.withRepoLock(root, () => withBusy(cx, root, busy, fn), wait);

// `spotlight toggle --task` (T21): runs the whole-task batch `fn` with
// queue.taskBatch[key] (`<groupId>/<KEY>`) set to `{ op, since, pid }`, so
// the task lane's flashlight spins and takes no click (D31), cleared in
// `finally` only while it is still this batch's. It takes no repo lock: the
// batch takes each member's in turn (lightTask, deactivateRepo). A process
// that dies first leaves a marker the reap clears (staleMarks).
export async function withTaskBatch(cx, key, op, fn) {
  const mark = { op, since: cx.now(), pid: process.pid };
  await cx.store.updateState((s) => {
    setTaskBatch(s, key, mark);
  });
  try {
    return await fn();
  } finally {
    try {
      await cx.store.updateState((s) => {
        clearTaskBatch(s, key, mark);
      });
    } catch {
      // Left for the reap, as withBusy's.
    }
  }
}

// The busy marks and task batches of `state` whose process is gone: dead, or
// its pid now another process that started after the mark (locks.js
// isStale, which runs `ps`; a test's cx stands in for it as cx.isStale).
// Read before the state lock, so `ps` never runs under it (D7); the reap's
// write clears each only while it is still the mark read here (store.js
// clearBusy, clearTaskBatch), so one a new light set meanwhile stays.
// → { repos: [[root, mark]], batches: [[key, mark]] }.
function staleMarks(cx, state) {
  const gone = (m) => (cx.isStale ?? isStale)({ pid: m.pid, startedAt: m.since });
  return {
    repos: Object.entries(state.repos).filter(([, r]) => r.busy && gone(r.busy)).map(([root, r]) => [root, r.busy]),
    batches: Object.entries(state.queue.taskBatch ?? {}).filter(([, m]) => gone(m)),
  };
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
// meanwhile (its repos grew) leaves the result to the newer one. `quiet`
// (the whole-task toggle, D31, whose summary says it once): no "Spotlight on
// · …" note per repo; errors still toast. A call option like `force`, never
// stored on the marker, so a later `light --force` of it speaks again.
export async function lightTask(cx, key, { force = false, quiet = false } = {}) {
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
      const r = await lightMember(cx, member, { force: force || marker.force, taskKey: marker.taskKey, quiet });
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
  // The old server never let go of the prompt and still runs (M3).
  "still-running": "server sin reiniciar",
  "port-busy": "puerto ocupado",
  // Its terminal runs something else: left alone (D40).
  "terminal-busy": "terminal ocupada",
};

// D41: a single light's toast body by what its server did, Orca's
// describeStart (spotlight-activated-toast.ts): a start, or a restart only
// when ensureServer replaced a server that ran (restartServer's
// `restarted`, in its result); every other state (none, needs-variant,
// pending, failed, still-running, port-busy, terminal-busy, running) says
// where the logs stay.
function startedBody(server, logPath) {
  if (server?.state !== "started") return `Los logs del server quedan para los agentes en ${logPath}`;
  const command = server.plan?.command;
  return server.result?.restarted ? `Reiniciando con ${command} — logs en ${logPath}` : `Arrancando ${command} — logs en ${logPath}`;
}

// A single light that went through (a fresh one or a takeover, D41): a
// success with Orca's title, the body by what its server did (startedBody,
// the record's log); `text` stays the log's line, which names the repo,
// the holder and the server's state word (SERVER_WORDS), for `spotlight
// logs`. `server`: ensureServer's answer.
export function lightNote({ root, name, workspace, server, logPath }) {
  return {
    repo: root,
    text: `Spotlight on · ${name} ← ${path.basename(workspace)} · ${SERVER_WORDS[server.state] ?? server.state}`,
    toast: true,
    level: "success",
    title: "Spotlight on — el root del proyecto ahora refleja este workspace",
    body: startedBody(server, logPath),
  };
}

// One repo of a lighting: activate (fresh or takeover), or sync when the
// workspace already holds it; then the server. The repo is busy all along,
// its target `workspace` (D33); a fresh light's record is made for the mark,
// and reads as no record until the light writes one. The record keeps the
// holder's env key (D32: `taskKey`, the marker's `<lane>/<KEY>`, else
// ws:<path>), so the server below runs the env picked for it.
async function lightMember(cx, member, { force, taskKey, quiet = false }) {
  const { root, workspace } = member;
  const envKey = envKeyOf(taskKey, workspace);
  const name = member.name ?? cx.nameOf(root);
  return withBusyRepo(cx, root, { op: "light", workspace, create: true }, async () => {
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
        s.repos[root] = setRootError({ ...emptyRepo(), ...(s.repos[root] ?? {}) }, { ...error, at: now });
        errorNote(s, { root, name, workspace, error, now, op: "light" });
      });
      return { ok: false, message: error.message };
    }
    const now = cx.now();
    // A fresh activation (`!same`: another workspace, or the one the record
    // names whose refs were gone, K2) is a holder switch all through the
    // light (L6): its header, its toast, and its server's takeover below.
    const switched = !same;
    const logPath = before?.logPath ?? logPathFor(root);
    // The lockfiles are compared from what the root had, as the refs read
    // under this lock say (L6, M7): the snapshot they projected there when
    // they were active (a sync, a takeover; orphan refs with no record, and
    // a record whose lastSnapshotSha is stale, too), or the root's own HEAD
    // when it had moved off that snapshot (a diverged root under a forced
    // takeover or sync, N7); else the root's own HEAD (a fresh activation:
    // sync.js activate's originalHeadSha).
    const fromSha = refs.active ? refs.rootHeadSha ?? refs.snapshotSha : result.originalHeadSha ?? null;
    const changed = result.skipped ? [] : await lockfileInstalls({ git: cx.planGit, root, fromSha, toSha: result.snapshotSha });
    const missing = await missingInstalls(root, cx.io);
    const branch = await branchOf(workspace);
    // D11: a header line on every holder switch.
    if (switched) appendLogHeader(logPath, { workspace: path.basename(workspace), branch, at: now });
    await cx.store.updateState((s) => {
      const r = { ...emptyRepo(), ...(s.repos[root] ?? {}) };
      r.holder = workspace;
      // The root is lit: a root error ends. A server error stays for
      // ensureServer below, which decides it (its checkPort reads the port a
      // recorded port-busy names, and its toast is one per new error).
      clearRootError(r);
      r.logPath = logPath;
      if (!result.skipped || !r.lastSnapshotSha) {
        r.lastSnapshotSha = result.snapshotSha;
        r.lastSyncAt = now;
      }
      r.pendingInstalls = installsFor(r.pendingInstalls, changed, missing);
      // D32: a record lit before T22 (an envOverride, no envKey) keeps
      // reading its envOverride while the same workspace holds it, so
      // installing T22 restarts no server; any other light keys it.
      if (switched || r.envKey || r.envOverride == null) {
        r.envKey = envKey;
        delete r.envOverride;
      }
      s.repos[root] = r;
    });
    // The server error is ensureServer's to decide (H3). On a takeover (a
    // fresh activation: another workspace, or the one the record already
    // names whose refs were gone, K2) the last holder's dead start or busy
    // port says nothing of the new one (G1); the holder lit again on its own
    // live refs (a sync) keeps it unless a start ends it, as a sync does
    // (H1, D24). The variant follows the holder, so it is kept only when the
    // record names this workspace already, refs or not.
    const sameHolder = before?.holder === workspace;
    const server = await ensureServer(cx, root, { workspace, branch, taskKey, keepVariant: sameHolder && !taskKey, takeover: switched });
    if (switched && !quiet) {
      await cx.store.updateState((s) => {
        addNote(s, lightNote({ root, name, workspace, server, logPath }), cx.now());
      });
    }
    return { ok: true, server };
  });
}

// ── The server (D10) ───────────────────────────────────────────────────────

// Why a start didn't go through, in Spanish, by startServer's or
// restartServer's reason (K3): the words after "El server no arrancó: ". A
// terminal that runs something else (terminal-busy) is no failed start: it
// is left alone, as Orca (D40, planAndStart).
const START_FAILURES = {
  "invalid-command": "su comando no es una sola línea que se pueda escribir",
  "name-taken": "otra terminal viva tiene el nombre de la suya",
  "terminal-failed": "hc no pudo crear su terminal",
  unreadable: "hc no pudo leer su terminal",
  "terminal-gone": "su terminal se cerró",
  "send-failed": "hc no pudo escribir en su terminal",
};

// The server error of a start that didn't go through (K3): its own, which
// replaces whatever server error the record had, so it never blames another
// start's pid or port. In Spanish only, by its reason, as a turn-off's (G5):
// hc's own words go to the server log, in startServer's and restartServer's
// own note (server.js notStarted, L2), never here; so a record's error, its
// toast and the one-per-error key (shownAlready) hold none of them. A reason
// this doesn't know yet is named as it came. "El server no arrancó: hc no
// pudo leer su terminal".
export function startFailedError(r) {
  const why = START_FAILURES[r?.reason] ?? r?.reason ?? "sin respuesta";
  return { code: SERVER_START_FAILED, message: `El server no arrancó: ${why}` };
}

// A restart whose old server never let go of the prompt (restartServer's
// oldServerRuns: it ignored the Ctrl-C, or hc couldn't send it): that server
// still runs, so no start failed (K3, L1, M3) and no server error is
// written; its toast says so each time someone asked for that restart, and
// once per cause for an automatic sync (the record's restartStuck, M1: the
// same reason, env and planned command, N1).
const stillRunningText = (r) =>
  `el server sigue corriendo: ${r.reason === "interrupt-failed" ? "hc no pudo mandarle Ctrl-C" : "no paró con Ctrl-C"} y no se reinició`;

// The env a repo's server should run (J-002, D32): the pick stored for its
// holder's key (`envs`: state.json's; the record's envKey, task-env.js
// recordEnv), else the settings' env, the repo's default; a record lit
// before T22 reads its envOverride instead. The record's serverEnv only says
// what runs now.
export const effectiveEnv = (cx, root, record, envs) => recordEnv(record, envs, repoSettings(cx.settings, root).env);

const RUNNING = new Set(["starting", "listening"]);
// What the server terminal holds (server.js inspectServer) when a start or
// restart would type into it: a free prompt, none yet, Spotlight's server.
const TYPES_INTO = new Set(["shell", "gone", "spotlight"]);
// A failed start's reasons that show Spotlight's old server no longer leads
// its terminal (N3): the terminal closed, or its prompt was free to type
// into (another program leading it is terminal-busy, no failure). Any other
// failure over a terminal that showed that server, or that hc couldn't
// read, may have left it running.
const LEFT_THE_FRONT = new Set(["terminal-gone", "send-failed"]);

// Spotlight's server runs in another env than the effective one, and that
// env starts something: it restarts, as on a command change (D10, J-002).
// An env with no command leaves the server alone, so nobody retries it.
// `envs`: state.json's (D32).
export async function envDrift(cx, root, record, envs) {
  if (!record?.holder || !record.serverCommand || !RUNNING.has(record.serverState)) return false;
  const env = effectiveEnv(cx, root, record, envs);
  if (record.serverEnv === env) return false;
  const { detected } = await detectServerScripts(root, cx.io);
  return commandTemplate({ settings: repoSettings(cx.settings, root), detected, env }) !== null;
}

// The effective env is one a start or restart couldn't run (the record's
// envFailed: a failed start, or an old server that never let go of the
// prompt), and settings.json wasn't saved after that (`savedAt`, the store's
// settingsSavedAt, J-011). Neither the reap (J-009) nor an automatic sync
// (auto-sync, `on`, the reap's own, M1) tries it again until then, so a
// server that ignores Ctrl-C isn't sent another one after every save; nor
// does such a sync's lockfile install, which restarts the env that runs now
// (N2). Reiniciar, a picked env, a light, Forzar sync and a hand-typed
// `spotlight sync` always do: each is a new ask (N4). `envs`: state.json's (D32).
const envGaveUp = (cx, root, record, savedAt, envs) =>
  record?.envFailed === effectiveEnv(cx, root, record, envs) && !(savedAt > (record.envFailedAt ?? 0));

// Which busy mark a server call makes (D33): a restart (`spotlight
// restart`, Liberar puerto y arrancar), an env or a variant picked now
// (`spotlight env`). The server work of a light or a sync makes none: it
// runs inside the light's mark, and a sync's (auto-sync's, `on`'s) would
// flash on every save.
function serverBusyOp({ restart = false, envName, chosenVariant }) {
  if (restart) return "restart";
  if (envName != null) return "env";
  if (chosenVariant != null) return "variant";
  return null;
}

// Plans the repo's server for `workspace` (T5a) and starts it, restarts it
// (its command or env changed, installs are pending, or `restart`), or
// leaves it. Call under the repo's lock. Given `restart`, `envName` or
// `chosenVariant`, the repo is busy while it works (serverBusyOp, D33), its
// target `workspace`; a repo with no record is never marked. Options:
//   taskKey      `<lane>/<taskKey>` whose remembered variant applies
//   envName      the env to run (else effectiveEnv's): an env picked now
//                (`spotlight env`, D32), which restarts Spotlight's server
//                only when its command changes (Orca's restartIfDifferent):
//                one already running that command now runs that env
//   chosenVariant  a variant picked now (`spotlight env --variant`)
//   keepVariant  reuse the running server's variant (a restart, a sync)
//   keepEnv      plan the env the server runs now (the record's
//                serverEnv) instead of the effective one: an automatic
//                sync's lockfile install while the effective env is given
//                up (envGaveUp, N2); that env stays envFailed
//   restart      restart even when nothing changed (`spotlight restart`)
//   ifRunning    touch only a server Spotlight runs now (a sync's installs)
//   syncing      an automatic sync's server work (auto-sync, `on`, the
//                reap's detached sync; never Forzar sync or a hand-typed
//                `spotlight sync`, N4): a failed start it repeats doesn't
//                toast again (L3), nor an old server still running for the
//                same cause, env and planned command (M1, N1), nor a
//                variant the repo already waits for (D36)
//   freePort     Liberar puerto y arrancar: stop the process the recorded
//                port-busy error names when it still holds the port (D24)
//   takeover     a fresh activation (lightMember: another workspace, or the
//                one the record names whose refs were gone, K2; Proyectar
//                igual)
// Nothing is typed while a process outside the server terminal's tree holds
// the port the start takes (D23, D24): lastError port-busy, a toast that
// opens the popup, and { state: "port-busy", error }.
// The server error in force is decided here, never by the caller (H3): a
// start that goes through ends it, a busy port writes it again, and a start
// that fails writes its own, server-start-failed, over it (K3: no new server
// runs, and the record says why, H2). That failure toasts every time someone
// asked for this start (a light, Reiniciar, Reintentar, Liberar puerto, env,
// variant), the same failure too; a sync toasts it once per new error (L3).
// A failed start that may have left Spotlight's old server in front (it was
// there, or hc couldn't say, and nothing after showed it gone, as a
// restart's Ctrl-C that freed its front does, P3: oldMayRun) keeps the
// record's state and restartStuck (N3).
// An old server that never let go of the prompt is no failed start: its own
// state, still-running (M3), toasted as a failure is (the record's
// restartStuck says the cause a sync already told, M1).
// A server terminal that runs something Spotlight didn't start (the root's
// own, Juan's program in it) is left alone, as Orca (D40): nothing typed, no
// Ctrl-C, its port never checked, no failed start and no toast of it; the
// record's server is stopped with the reason terminal-busy (serverReason),
// which the popup says, and server.js's start leaves its line in the log.
// Its state word: terminal-busy.
// A plan that asks for a variant starts nothing: the record waits in
// needs-variant, and every start asked for toasts "Elige una variante para
// <repo>", opening the popup's chips (D36).
// A plan with no command ends it on a takeover, and for the same holder once
// no server of Spotlight's may run there any more (oursMayRun): with none,
// there is no server to be wrong about (K1), but one of before still running
// keeps its busy port and Liberar puerto (L5). The rest (a variant to pick,
// the same server already running, an old server that never let go of the
// prompt and still runs, L1) starts nothing new and records nothing new:
// that ends the last holder's on a takeover only (G1); otherwise it stays
// (H1: a port-busy a refused restart left over a server that kept
// listening, D24).
// → { state: started | running | still-running | terminal-busy | needs-variant | none | pending | failed | port-busy, … }
export async function ensureServer(cx, root, opts = {}) {
  const op = serverBusyOp(opts);
  if (!op) return planAndStart(cx, root, opts);
  return withBusy(cx, root, { op, workspace: opts.workspace ?? null }, () => planAndStart(cx, root, opts));
}

// Whether a server of Spotlight's may still run for `record` (L5): its
// server terminal shows Spotlight's own server in front, or hc can't say
// (doubt is never death). With no terminal on the record, hc is asked by the
// terminal's name (sl-<slug>), as inspectServer and every start look for it
// (M5); none by that name runs none.
async function oursMayRun(cx, root, record) {
  const seen = await inspectServer(
    { root, terminal: record.serverTerminal ?? null, logPath: record.logPath ?? logPathFor(root), serverPid: record.serverPid },
    cx.serverDeps,
  );
  return seen.kind === "spotlight" || seen.kind === "unknown";
}

// D36: the toast of a start that waits for a variant (Orca's "Pick a variant
// for <project>", an info): its click opens the server popup of the
// workspace it is for, whose chips pick it. D41: Orca's title and body,
// for 60 s like an error (Orca's never closes by itself); `text` as before.
const VARIANT_ASK_MS = 60_000;
function variantAsk(root, name, workspace) {
  const action = workspace ? { action: { name: `spotlight.server.${serverId(workspace)}` } } : {};
  return {
    repo: root, text: `Elige una variante para ${name}`, toast: true, level: "info", ...action,
    title: `Elige una variante para ${name}`, body: "Su server arranca con la que elijas, y esta tarea la recuerda.", timeout: VARIANT_ASK_MS,
  };
}

// ensureServer's work, under the busy mark its caller asked for, if any.
async function planAndStart(cx, root, opts) {
  const {
    workspace, branch = null, taskKey = null, envName, restart = false, ifRunning = false, syncing = false, takeover = false, keepEnv = false,
  } = opts;
  const state = cx.store.readState();
  const record = state.repos[root];
  if (!record) return { state: "none" };
  const repoSet = repoSettings(cx.settings, root);
  const kept = keepEnv ? record.serverEnv ?? null : null;
  const env = envName ?? kept ?? effectiveEnv(cx, root, record, state.envs);
  const chosenVariant = opts.chosenVariant ?? (opts.keepVariant ? record.serverVariant ?? undefined : undefined);
  const plan = await planServer({
    root, workspace, settings: repoSet, env, taskKey, remembered: state.variants, chosenVariant, io: cx.io, git: cx.planGit,
  });
  const now = cx.now();
  if (plan.kind === "ask-variant") {
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      // D36: one toast per start (Orca's variant prompt), opening the
      // popup's chips; an automatic sync that finds the repo still waiting
      // asks nothing again.
      const repeat = syncing && r.serverState === "needs-variant";
      Object.assign(r, { serverState: "needs-variant", variantCandidates: plan.candidates });
      if (takeover) clearServerError(r);
      if (!repeat) addNote(s, variantAsk(root, cx.nameOf(root), workspace ?? r.holder), now);
    });
    return { state: "needs-variant", candidates: plan.candidates };
  }
  if (plan.kind !== "command") {
    // No command: on a takeover the last holder's error says nothing of the
    // new one (G1); for the same holder it goes once no server of
    // Spotlight's may run there (K1, L5).
    if (serverErrorOf(record.lastError) && (takeover || !(await oursMayRun(cx, root, record)))) {
      await cx.store.updateState((s) => {
        if (s.repos[root]) clearServerError(s.repos[root]);
      });
    }
    return { state: "none" };
  }

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
  // An env picked now changes nothing that runs when its command is the
  // one running (D32); otherwise another env is a restart (J-002).
  const same = record.serverCommand === plan.command && (record.serverEnv === plan.env || envName != null);
  if (seen.kind === "spotlight" && !restart && same && pending.length === 0) {
    r = { ok: true, started: false, reason: "already-running", terminal: seen.terminal, pid: seen.pid };
  } else {
    // Checked only where a line would be typed. A terminal hc can't read, or
    // one running something Spotlight didn't start, refuses the start on its
    // own; and without the terminal's pid, Spotlight's own server would read
    // as a stranger holding the port.
    let ensured;
    if (TYPES_INTO.has(seen.kind)) {
      // D38, D40: the terminal comes first, so the port is checked from the
      // one the line goes to: the root's own terminal, chosen now, or one
      // made. One chosen now that runs something Spotlight didn't start
      // (Juan's server, maybe on this very port) is left alone without a
      // check: the start answers terminal-busy. The check runs whatever the
      // terminal's answer, as before T29: a busy port is said before a
      // terminal that couldn't be made.
      ensured = await ensureServerTerminal({ root, terminal: record.serverTerminal }, cx.serverDeps);
      const chosen = ensured.ok && ensured.terminal !== seen.terminal
        ? await inspectServer({ terminal: ensured.terminal, logPath, serverPid: record.serverPid }, cx.serverDeps)
        : seen;
      if (chosen.kind !== "foreign") {
        const port = await checkPort(cx, root, {
          command: plan.command, settings: repoSet, rootPid: chosen.rootPid ?? null, freePort: opts.freePort,
          shown: serverErrorOf(record.lastError),
        });
        freed = port.freed;
        if (port.busy) {
          const terminal = ensured.ok ? ensured.terminal : null;
          return refusePort(cx, root, { busy: port.busy, freed, plan, seen, logPath, workspace, branch, now, terminal });
        }
      }
    }
    // A terminal that couldn't be ensured goes through the start too, which
    // answers it as its own and logs hc's words (server.js notStarted, L2).
    const start = { ...args, ensured };
    r = seen.kind === "spotlight" ? await restartServer(start, cx.serverDeps) : await startServer(start, cx.serverDeps);
  }
  const ran = r.ok && (r.started || r.reason === "already-running");
  // Its terminal runs something else: left alone, no failed start (D40).
  const leftAlone = r.ok && !r.started && r.reason === "terminal-busy";
  // An old server that never let go of the prompt still runs: no start
  // failed (restartServer's oldServerRuns, L1).
  const failure = ran || leftAlone || r.oldServerRuns ? null : startFailedError(r);
  // A failed start over a terminal that showed Spotlight's server, or that
  // hc couldn't read, which nothing after showed gone from its front (N3):
  // not a restart that saw the old server leave it (restartServer's
  // `interrupted`, P3), whatever the read after that said.
  const oldMayRun = failure !== null && !r.interrupted && (seen.kind === "spotlight" || seen.kind === "unknown") && !LEFT_THE_FRONT.has(r.reason);
  await cx.store.updateState((s) => {
    const rec = s.repos[root];
    if (!rec) return;
    rec.logPath = logPath;
    if (freed?.ok) addNote(s, { repo: root, text: `${cx.nameOf(root)}: ${freedText(freed)}` }, now);
    if (r.terminal) rec.serverTerminal = r.terminal;
    // Why the server was left stopped is this start's to say, or nobody's.
    delete rec.serverReason;
    if (leftAlone) {
      // D40: the terminal runs something Spotlight didn't start, left as it
      // is (Orca's): nothing of Spotlight's runs there, so its server is
      // stopped with that reason, which the popup says; no server error
      // and no toast (an old one says nothing of this start), and the
      // cause of a stuck restart is no more. The log has server.js's line.
      Object.assign(rec, { serverState: "stopped", serverReason: "terminal-busy" });
      delete rec.restartStuck;
      clearServerError(rec);
    } else if (r.ok && r.started) {
      // serverEnv says what runs now (J-002, J-008): written only when it
      // starts. serverProcs is kept (F1): a child of the last run that escaped
      // holding a port must still die at the turn-off; a dead identity never
      // matches again (a reused pid has another start time) and the list is capped.
      Object.assign(rec, {
        serverCommand: plan.command, serverEnv: plan.env, serverVariant: plan.variant, serverPid: r.pid ?? null, serverStartedAt: now,
        serverState: "starting", pendingInstalls: [], variantCandidates: [],
      });
      // The env that couldn't run stays so while a start kept the one that
      // ran instead (keepEnv, N2).
      if (kept === null || rec.envFailed === plan.env) {
        delete rec.envFailed;
        delete rec.envFailedAt;
      }
      delete rec.restartStuck;
      clearServerError(rec);
      if (taskKey && plan.variant && (plan.source === "inferred" || plan.source === "chosen")) {
        rememberVariant(s, `${taskKey}::${normRoot(root)}`, plan.variant);
      }
      // Herdr's own toast (D41): its words, byte for byte (server-view-model.js reads them), under a title.
      if (plan.note) addNote(s, { repo: root, text: plan.note, toast: true, title: herdrTitle(cx.nameOf(root)) }, now);
    } else if (r.ok && r.reason === "already-running") {
      if (rec.serverState !== "listening") rec.serverState = "starting";
      if (r.pid) rec.serverPid = r.pid;
      rec.variantCandidates = [];
      if (takeover) clearServerError(rec);
      // D32: an env picked over the same command: that env runs now.
      if (rec.serverEnv !== plan.env) {
        rec.serverEnv = plan.env;
        if (rec.envFailed === plan.env) {
          delete rec.envFailed;
          delete rec.envFailedAt;
        }
      }
    } else if (!failure) {
      // The old server ignored the Ctrl-C, or never got it, and still runs,
      // in the state it had: no start failed (K3, L1). As over a server
      // already running, a takeover ends the last holder's server error (G1)
      // and the same holder keeps it (H1). The env it couldn't run is
      // envFailed, which neither an automatic sync nor the reap tries again
      // until settings are saved (envGaveUp, M1, N4). Its toast says so every time it
      // was asked for; an automatic sync repeating the cause in force
      // doesn't: restartStuck, the reason the last restart left that old
      // server running for, with the env and command it planned. Another
      // env or command (a new env, a settings save that changes the
      // command) is a new ask and toasts again (N1).
      if (rec.serverEnv !== plan.env) Object.assign(rec, { envFailed: plan.env, envFailedAt: now });
      if (takeover) clearServerError(rec);
      const stuck = { reason: r.reason, env: plan.env, command: plan.command };
      const was = rec.restartStuck;
      const repeat = syncing && was?.reason === stuck.reason && was.env === stuck.env && was.command === stuck.command;
      rec.restartStuck = stuck;
      if (!repeat) {
        // The words open the toast's body: "El server sigue corriendo: …".
        const words = stillRunningText(r);
        addNote(s, herdrNote(root, cx.nameOf(root), words, `${words[0].toUpperCase()}${words.slice(1)}`), now);
      }
    } else {
      // The start didn't go through: its own server error over whatever was
      // there (K3, H2; under a root error the record has, F7), opening the
      // popup (Ver log, Reintentar). Toasted every time it was asked for; a
      // sync's repeat of the error in force isn't (L3). When Spotlight's old
      // server may still lead its terminal (oldMayRun: hc couldn't read it,
      // the line was never typed), the record keeps its state and the cause
      // of a stuck restart (N3): doubt is never death.
      if (!oldMayRun) {
        rec.serverState = r.reason === "terminal-gone" ? "gone" : "stopped";
        // No old server runs now: the cause of a stuck restart is no more.
        delete rec.restartStuck;
      }
      if (rec.serverEnv !== plan.env) Object.assign(rec, { envFailed: plan.env, envFailedAt: now });
      const repeat = syncing && shownAlready(rec, failure);
      setServerError(rec, { ...failure, at: now });
      if (!repeat) errorNote(s, { root, name: cx.nameOf(root), workspace: workspace ?? rec.holder, error: failure, now, top: rec.lastError });
    }
  });
  // An old server still running is its own state, never a failed start (M3);
  // so is a terminal left alone (D40).
  const word = ran ? (r.started ? "started" : "running") : leftAlone ? "terminal-busy" : failure ? "failed" : "still-running";
  return { state: word, result: r, plan, freed, ...(failure ? { error: failure } : {}) };
}

// ── The env per task (D32) ─────────────────────────────────────────────────

// Stores an env pick (`spotlight env`: the lane's pill, the server popup)
// under `key` (task-env.js: `<groupId>/<KEY>` or ws:<path>) in state.json's
// `envs`, which keeps the newest ENVS_MAX and survives the turn-off. In the
// same write it adopts each lit record with no envKey (lit before T22) whose
// holder's key this is: the record takes the key and drops its envOverride,
// so the pick governs it from now on (applyEnv restarts it, the reap's drift
// keeps it). The holders' keys are read before the write: git never runs
// under the state lock (D7). → { adopted: [root] }
export async function writeEnv(cx, key, env) {
  const unkeyed = Object.entries(cx.store.readState().repos).filter(([, r]) => r?.holder && !r.envKey);
  const keys = [];
  for (const [root, r] of unkeyed) {
    keys.push({ root, holder: r.holder, key: envKeyOf(await taskKeyOfWorkspace(r.holder, root, cx.shared), r.holder) });
  }
  const adopted = [];
  await cx.store.updateState((s) => {
    rememberEnv(s, key, env);
    for (const k of keys) {
      const r = s.repos[k.root];
      if (k.key !== key || !r || r.holder !== k.holder || r.envKey) continue;
      r.envKey = key;
      delete r.envOverride;
      adopted.push(k.root);
    }
  });
  return { adopted };
}

// Runs the env stored for `key` on every lit repo whose holder has that key
// (record.envKey), one after another, each under its repo lock and busy
// while it works (D33, op "env"). An explicit request, as Reiniciar: a
// failed start or an old server still running toasts. Spotlight's server
// restarts only when its command changes (ensureServer's envName); an env
// with no command leaves it as it was. The env is read under the lock, so
// two picks in a row end in the last one. → { [root]: { env, server } |
// { error } }, without the repos that stopped holding that key meanwhile.
export async function applyEnv(cx, key) {
  const roots = Object.entries(cx.store.readState().repos).filter(([, r]) => r?.holder && r.envKey === key).map(([root]) => root);
  const results = {};
  for (const root of roots) {
    try {
      const r = await cx.store.withRepoLock(root, async () => {
        const state = cx.store.readState();
        const record = state.repos[root];
        if (!record?.holder || record.envKey !== key) return null;
        const env = effectiveEnv(cx, root, record, state.envs);
        const server = await ensureServer(cx, root, {
          workspace: record.holder,
          branch: await branchOf(record.holder),
          // A task's key names its remembered variants; ws:<path> names none.
          taskKey: key.startsWith("ws:") ? null : key,
          envName: env,
          keepVariant: true,
        });
        return { env, server };
      });
      if (r) results[root] = r;
    } catch (e) {
      results[root] = { error: toSpotlightError(e) };
    }
  }
  return results;
}

// ── A busy port (D23, D24) ─────────────────────────────────────────────────

// The port-busy error of a holder found by checkPort; with no pid, a port a
// server found taken when it started (D25) and nobody listens on any more.
export function portBusyError({ port, pid = null, command = null, cwd = null }) {
  if (!Number.isInteger(pid)) {
    const which = Number.isInteger(port) ? `El puerto ${port}` : "El puerto del server";
    return { code: PORT_BUSY, port: port ?? null, pid: null, command: null, cwd: null, message: `${which} estaba ocupado al arrancar el server.` };
  }
  const where = cwd ? `pid ${pid}, en ${cwd}` : `pid ${pid}`;
  return { code: PORT_BUSY, port, pid, command, cwd, message: `El puerto ${port} lo tiene ${command ?? "otro proceso"} (${where}).` };
}

// Who holds the port this start takes, from outside the server terminal's
// tree (rootPid; none when there's no terminal yet). The port is the one
// the command will take (D23), else the one a recorded port-busy names (a
// server that died on it, D25, whose command doesn't say). With `freePort`,
// the process the recorded port-busy error (`shown`, the record's server
// error in force, on top or under a root error) names is stopped first
// — SIGTERM to it and its descendants, SIGKILL 5 s later — and only while it
// is still the one holding that port: whatever took it since is shown, not
// stopped. → { busy: { port, pid, command, cwd } | null, freed }.
async function checkPort(cx, root, { command, settings, rootPid, freePort, shown }) {
  const recorded = shown?.code === PORT_BUSY && Number.isInteger(shown.port) ? shown.port : null;
  const port = (await expectedPort({ root, command, settings, io: cx.io })) ?? recorded;
  if (port === null) return { busy: null, freed: null };
  const holder = async () => {
    const found = await foreignListener(port, rootPid, cx.serverDeps);
    return found ? { port, ...found } : null;
  };
  let busy = await holder();
  if (!busy || !freePort || shown?.code !== PORT_BUSY || shown.port !== port || shown.pid !== busy.pid) return { busy, freed: null };
  // Signals go through cx.serverDeps.kill only (R5).
  const stopped = await stopProcessTree(busy.pid, cx.serverDeps, { protect: [process.pid, rootPid].filter(Number.isInteger) });
  const freed = { ...busy, ...stopped };
  if (stopped.ok) busy = await holder();
  return { busy, freed };
}

// What a stopped holder leaves in the notes.
function freedText({ port, pid, command, killed }) {
  const forced = killed?.length > 0 ? `; ${killed.length} no paró con SIGTERM y se mató con SIGKILL` : "";
  return `Puerto ${port} liberado: se paró ${command ?? "el proceso"} (pid ${pid})${forced}.`;
}

// The start refused: the server error port-busy (under a root error the
// record has, F7), one toast per new holder (it opens the popup), a line in
// the server's log, nothing typed. `terminal`: the server terminal ensured
// before the check (D38, D40: the root's own, chosen now, or a new one),
// kept on the record. The busy port is why now, not a busy terminal.
async function refusePort(cx, root, { busy, freed, plan, seen, logPath, workspace, branch, now, terminal = null }) {
  const error = portBusyError(busy);
  const name = cx.nameOf(root);
  await cx.store.updateState((s) => {
    const rec = s.repos[root];
    if (!rec) return;
    if (terminal) rec.serverTerminal = terminal;
    delete rec.serverReason;
    const known = shownAlready(rec, error);
    setServerError(rec, { ...error, at: now });
    // A server Spotlight runs keeps its state: the restart didn't touch it.
    if (seen.kind !== "spotlight") rec.serverState = "stopped";
    if (freed?.ok) addNote(s, { repo: root, text: `${name}: ${freedText(freed)}` }, now);
    if (!known) errorNote(s, { root, name, workspace, error, now, top: rec.lastError });
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

// D40: a look (readServerState's) at a terminal Spotlight left alone
// (serverReason terminal-busy) that still runs what Spotlight didn't start
// reads no server of Spotlight's: stopped, with no ports, whatever that
// program listens on (Juan's own server in the root's terminal), so the
// reap and `on` keep the record stopped as the start left it. Any other look
// as it came.
const leftAloneLook = (record, live) =>
  record?.serverReason === "terminal-busy" && live?.owner === "foreign"
    ? { ...live, state: "stopped", ports: [], procs: [], port: null, url: null, label: "" }
    : live;

function serverExitedError(line) {
  return { code: SERVER_EXITED, message: line ? `El server se cayó al arrancar: ${line}` : "El server se cayó al arrancar." };
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
// for one: the server error (under a root error the record has, which stays
// on top: F7), serverState stopped, and a toast that opens the popup when
// the popup can act on the error on top (one per error). Its error is
// computed here only, once (R10): the reap and
// `on` (describeServer) both settle through this, and `on` prints what it
// returns, which is what was recorded and toasted. A lock held past
// DEAD_START_LOCK_MS leaves it `starting` for the next look. → the error
// recorded, or null (not dead, settled by someone else, or the lock busy).
async function settleDeadStart(cx, root) {
  try {
    return await cx.store.withRepoLock(
      root,
      async () => {
        const record = cx.store.readState().repos[root];
        if (!record?.serverTerminal || record.serverState !== "starting") return null;
        const live = await serverOf(cx).readServerState(
          { root, terminal: record.serverTerminal, logPath: record.logPath, serverPid: record.serverPid, port: repoSettings(cx.settings, root).port },
          cx.serverDeps,
        );
        if (!diedAtStart(record, live)) return null;
        const error = await deadStartError(cx, root, record);
        const now = cx.now();
        const wrote = await cx.store.updateState((s) => {
          const rec = s.repos[root];
          if (!rec || rec.serverState !== "starting" || rec.serverStartedAt !== record.serverStartedAt) return false;
          const known = shownAlready(rec, error);
          Object.assign(rec, { serverState: "stopped", ports: [] });
          setServerError(rec, { ...error, at: now });
          if (!known) errorNote(s, { root, name: cx.nameOf(root), workspace: rec.holder, error, now, top: rec.lastError });
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

// ── A server that ended by hand (D34) ──────────────────────────────────────

// What a lit repo's server that was listening ended in, by the state a look
// read (server.js readServerState): its terminal gone (D38: its "Spotlight"
// tab, or its space, closed; or `exit` typed there), or stopped (its shell
// back at the prompt: a Ctrl-C typed there, or the server crashed). The
// toast's words, by the repo's name.
const SERVER_ENDS = {
  gone: (name) => `Cerraste la terminal del server de ${name}: Spotlight sigue prendido.`,
  stopped: (name) => `El server de ${name} se detuvo: Spotlight sigue prendido.`,
};

// Spotlight is on (a holder) and the record says its server listens, but the
// look read it gone or stopped. `starting` → `stopped` is a dead start
// (diedAtStart, D25), never this.
const serverEnded = (record, liveState) =>
  Boolean(record?.holder) && record.serverState === "listening" && Object.hasOwn(SERVER_ENDS, liveState ?? "");

// Records a server that ended by hand under the repo's lock, where the
// record and the terminal are read again, as settleDeadStart does: every
// restart holds that lock (a light, a sync's installs, Reiniciar, an env or
// a variant) and leaves the prompt free between its Ctrl-C and the line it
// types, which is no stop; once it lets go, the record says `starting`. Only
// while the record still says `listening` (and the same start), one write:
// the state read now, no ports, and one toast that opens the server popup
// (Reiniciar makes the tab again by ensureServerTerminal's rule; Apagar turns
// the root off). The record keeps its serverProcs, for that turn-off (F1).
// Every later look reads the record gone or stopped, so it toasts once until
// the server listens again. A lock held past DEAD_START_LOCK_MS leaves it
// `listening` for the next look. The reap and `on` (recordServers) both
// settle through this. → the state written ("gone" | "stopped"), or null.
async function settleServerEnd(cx, root) {
  try {
    return await cx.store.withRepoLock(
      root,
      async () => {
        const record = cx.store.readState().repos[root];
        if (!record?.serverTerminal || record.serverState !== "listening") return null;
        const live = await serverOf(cx).readServerState(
          { root, terminal: record.serverTerminal, logPath: record.logPath, serverPid: record.serverPid, port: repoSettings(cx.settings, root).port },
          cx.serverDeps,
        );
        if (!serverEnded(record, live.state)) return null;
        const now = cx.now();
        const wrote = await cx.store.updateState((s) => {
          const rec = s.repos[root];
          if (!serverEnded(rec, live.state) || rec.serverStartedAt !== record.serverStartedAt) return false;
          Object.assign(rec, { serverState: live.state, ports: [] });
          const action = { name: `spotlight.server.${serverId(rec.holder)}` };
          // Herdr's own toast (D41): its words, under a title.
          const name = cx.nameOf(root);
          addNote(s, { repo: root, text: SERVER_ENDS[live.state](name), toast: true, action, title: herdrTitle(name) }, now);
          return true;
        });
        return wrote.result ? live.state : null;
      },
      { timeoutMs: DEAD_START_LOCK_MS },
    );
  } catch (e) {
    if (e instanceof LockError && e.code === "lock-timeout") return null;
    throw e;
  }
}

// D38: a server lit before T29 runs in a terminal Herdr shows nowhere. The
// reap makes it the root's "Spotlight" tab as it runs (server.js
// showServerTerminal: no restart, no other terminal touched), under the
// repo's lock, since two looks at once could each make a space for it; a
// lock held past DEAD_START_LOCK_MS leaves it for the next reap. The cheap
// look (one hc get) runs first, without the lock.
async function showHiddenServer(cx, root, terminal) {
  const server = serverOf(cx);
  if (!terminal || !(await server.serverTerminalHidden({ root, terminal }, cx.serverDeps))) return null;
  try {
    return await cx.store.withRepoLock(root, () => server.showServerTerminal({ root, terminal }, cx.serverDeps), { timeoutMs: DEAD_START_LOCK_MS });
  } catch (e) {
    if (e instanceof LockError && e.code === "lock-timeout") return null;
    throw e;
  }
}

// A server error goes once the server listens after it (D25): only on the
// way into `listening`, so a refused restart over a server that kept
// listening keeps its port-busy (D24). Wherever it is: one under a root
// error goes too (R8, F7), it no longer applies once the root error ends.
function clearOnListen(record, liveState) {
  if (liveState === "listening" && record.serverState !== "listening") clearServerError(record);
}

// ── The server's processes, for the turn-off (F1) ──────────────────────────

// How many server processes a record remembers: the newest seen.
export const SERVER_PROCS_MAX = 32;

// The record's serverProcs `known` with `seen` added (a look's
// readServerState procs: the listeners in the server terminal's tree, each
// { pid, start, port }): one per pid and start time (ports.js identityKey; a
// reused pid is another process), one seen again moved to the newest, the
// newest SERVER_PROCS_MAX kept, anything that isn't an identity skipped
// (ports.js isIdentity: a start is a non-empty string, as the turn-off reads
// it, G8). `gone` (ports.js goneIdentities, read before the state write):
// the known ones that no longer run as that process, dropped first, so a
// watch server that respawns its listener on every save never pushes a live
// escaped one out of the cap (G3).
export function rememberProcs(known, seen, gone = new Set()) {
  const fresh = new Map();
  for (const p of Array.isArray(seen) ? seen : []) {
    if (!isIdentity(p)) continue;
    fresh.delete(identityKey(p));
    fresh.set(identityKey(p), { pid: p.pid, start: p.start, port: Number.isInteger(p.port) ? p.port : null });
  }
  const kept = (Array.isArray(known) ? known : []).filter(
    (p) => isIdentity(p) && !fresh.has(identityKey(p)) && !gone.has(identityKey(p)),
  );
  return [...kept, ...fresh.values()].slice(-SERVER_PROCS_MAX);
}

// What one look at the server saw (the reap, `on`) goes into its record:
// its state, the ports it listens on now (`ports`, for the badges, the URLs
// and `status`), and every process it was seen with while this repo was lit,
// across restarts, that still runs (serverProcs; `gone`: rememberProcs'). A
// child that left the server's tree holding a port, or a server pushed to
// another port by an old child, is no longer in the live tree by the
// turn-off; stopServer kills such an escaped listener only when its pid and
// start time are one of these (D26). A server seen anything but stopped
// drops why it was left stopped (serverReason, D40): that stands no more.
function noteLive(record, { state, ports, procs }, gone) {
  clearOnListen(record, state);
  if (state !== "stopped") delete record.serverReason;
  record.serverState = state;
  record.ports = ports;
  record.serverProcs = rememberProcs(record.serverProcs, procs, gone);
}

// Which of the identities the records of `roots` remember no longer run
// (ports.js goneIdentities: one ps for all of them). Read before the state
// write that merges a look's procs: updateState's mutator stays synchronous.
const goneOf = (cx, repos, roots) =>
  goneIdentities(roots.flatMap((root) => repos[root]?.serverProcs ?? []), cx.serverDeps);

// ── sync ───────────────────────────────────────────────────────────────────

// Why the restart a sync asked for didn't happen, for `spotlight sync`'s line:
// a failed start's reason, the old server's (still-running's: it ignored the
// Ctrl-C, or never got it), port-busy, or terminal-busy (its terminal runs
// something else, left alone, D40).
const restartFailure = (server) => {
  if (server?.state === "failed" || server?.state === "still-running") return server.result.reason;
  return server?.state === "port-busy" || server?.state === "terminal-busy" ? server.state : null;
};

// D35: the toast of a Forzar sync that went through (Orca's "Spotlight
// re-synced — the root mirrors the workspace again", a success). D41:
// Orca's words as its title alone; `text` as before.
const RESYNCED = (root) => ({
  repo: root, text: "Spotlight re-sincronizado: el root refleja el workspace otra vez.", toast: true, level: "success",
  title: "Spotlight re-sincronizado — el root refleja el workspace otra vez", body: "",
});

// Brings the root in step with its holder (`spotlight sync`, auto-sync, and
// `on` for each lit member). Under the repo lock; the holder is read inside
// it. `onlyIf(record)`: sync only when it says so (`on`: the task's own
// holder). A sync that changes nothing writes nothing (D7). A changed
// pnpm-lock.yaml / uv.lock restarts Spotlight's running server with the
// install chained (D10), and so does a server running another env than the
// effective one (J-002: a settings change, picked up by the next `on`,
// auto-sync, or the reap's detached sync). An automatic sync (auto-sync,
// `on`, the reap's) doesn't when that env already couldn't run and settings
// weren't saved since (envGaveUp, M1), and its install restart keeps the
// env that runs now (N2). One someone asked for is a new ask, as Reiniciar
// (N4): Forzar sync (`force`) and a hand-typed `spotlight sync` (`asked`)
// try that env again and toast how it went every time. `lockTimeoutMs`: how long to wait
// for the repo lock (`on`'s time left, J-001); past it, LockError
// "lock-timeout". Forced (Forzar sync), the repo is busy while it works, its
// holder the target (D33); a sync that isn't forced (auto-sync, `on`) never
// marks it: it would flash on every save. A forced one that goes through
// toasts so (D35, Orca's forceSyncSpotlight), RESYNCED, in the write that
// ends the root error.
export async function syncRepo(cx, root, { force = false, asked = false, onlyIf, lockTimeoutMs } = {}) {
  const ask = force || asked;
  const wait = lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs };
  const locked = force
    ? (fn) => withBusyRepo(cx, root, { op: "sync", workspace: (r) => r?.holder ?? null }, fn, wait)
    : (fn) => cx.store.withRepoLock(root, fn, wait);
  return locked(async () => {
    const record = cx.store.readState().repos[root] ?? null;
    if (!record?.holder) return { ok: false, code: "not-active", message: `Spotlight is not on in ${cx.nameOf(root)}.` };
    if (onlyIf && !onlyIf(record)) return { ok: true, skipped: true, notLit: true, holder: record.holder };
    const holder = record.holder;
    // What the root has before the sync writes over it: only a forced sync
    // goes past a root that moved off the snapshot (an unforced one finds it
    // there or refuses), so only a forced one reads it (P1).
    const rootHad = force ? (await readRefs(root)).rootHeadSha : null;
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
        // Over the server error in force (F6): it comes back once a sync goes through.
        setRootError(r, { ...error, at: now });
        errorNote(s, { root, name: cx.nameOf(root), workspace: holder, error, now, op: "sync" });
      });
      return { ok: false, holder, ...error };
    }
    // An automatic sync leaves an env that already couldn't run, until
    // settings are saved after that (M1): every save would send another
    // Ctrl-C. One asked for tries it again (N4).
    const envs = cx.store.readState().envs;
    const gaveUp = !ask && envGaveUp(cx, root, record, cx.store.settingsSavedAt?.() ?? 0, envs);
    // Spotlight's running server only, with its variant (D10), and the env
    // it runs while the effective one is given up (N2); an automatic sync's
    // failed start it repeats doesn't toast again (L3), nor an old server
    // still running for the same cause (M1, N1).
    const refreshServer = async () =>
      ensureServer(cx, root, {
        workspace: holder, branch: await branchOf(holder), keepVariant: true, keepEnv: gaveUp, ifRunning: true, syncing: !ask,
      });
    // An env to restart into, unless it is given up.
    const drifted = async () => !gaveUp && (await envDrift(cx, root, record, envs));
    if (result.skipped) {
      if (force || (record.lastError && !isServerError(record.lastError))) {
        await cx.store.updateState((s) => {
          if (!s.repos[root]) return;
          clearRootError(s.repos[root]);
          if (force) addNote(s, RESYNCED(root), cx.now());
        });
      }
      const server = (await drifted()) ? await refreshServer() : null;
      return { ok: true, skipped: true, holder, restarted: server?.state === "started", restartFailed: restartFailure(server) };
    }
    // The lockfiles are compared from what the root had (as a light's, N7):
    // the snapshot last projected there, or the root's own HEAD when Forzar
    // sync goes past a root that checked out another commit, whose
    // node_modules or .venv are that commit's (P1).
    const fromSha = rootHad ?? record.lastSnapshotSha;
    const installs = await lockfileInstalls({ git: cx.planGit, root, fromSha, toSha: result.snapshotSha });
    const now = cx.now();
    await cx.store.updateState((s) => {
      const r = s.repos[root];
      if (!r) return;
      Object.assign(r, { lastSnapshotSha: result.snapshotSha, lastSyncAt: now });
      clearRootError(r);
      r.pendingInstalls = installsFor(r.pendingInstalls, installs);
      if (force) addNote(s, RESYNCED(root), now);
    });
    let server = null;
    if (installs.length > 0 || (await drifted())) server = await refreshServer();
    return { ok: true, skipped: false, holder, installs, restarted: server?.state === "started", restartFailed: restartFailure(server) };
  });
}

// ── Turning a root off (toggle) ────────────────────────────────────────────

// Restores the root (its commit, branch and uncommitted changes) and stops
// Spotlight's server; `force` discards a diverged root (Orca's "Turn off
// anyway"). Refs with no record (orphan-refs) restore the same way. → { ok:
// true, … }, or { ok: false, code, message }: refused (the root untouched;
// when the server's stop had failed before the restore refused, its message
// says that too, G4), or server-survived / server-not-stopped (the root
// restored, the server not stopped: turnOffError). The stop's cause, in its
// own words, is in the server log either way: stopServer's own note says it
// (server.js, K4/K5); the turn-off adds a line only for an answer stopServer
// wrote none for (stopFallbackNote, L7). The repo is busy all along, its
// holder the target (D33). `quiet` (the whole-task toggle, D31, whose
// summary says it once): no "Spotlight off — root restaurado" note; a
// refusal, a server that didn't stop, a warning or rescued files still
// toast. A root left detached toasts Orca's warning instead of the success
// (D41, detachedToast), quiet or not.
export async function deactivateRepo(cx, root, { force = false, quiet = false } = {}) {
  const name = cx.nameOf(root);
  // A refusal: the git error goes on the record (a root error, over the
  // server error in force, F6) and toasts. `stopped`, stopServer's answer
  // when the server was stopped before the restore refused: one that
  // couldn't say the server stopped joins the same toast and message (G4),
  // never the record (TURN_OFF_ERRORS, G9).
  const fail = async (e, workspace, stopped = null) => {
    const error = toSpotlightError(e);
    const notStopped = stopped && stopped.ok !== true;
    const told = notStopped ? { ...error, message: alsoNotStopped(error.message, stopped) } : error;
    const now = cx.now();
    await cx.store.updateState((s) => {
      s.repos[root] = setRootError({ ...emptyRepo(), ...(s.repos[root] ?? {}) }, { ...error, at: now });
      errorNote(s, { root, name, workspace, error: told, now, op: "off", also: notStopped ? stopFailure(stopped) : null });
    });
    return { ok: false, ...told, ...(stopped ? { stopped } : {}) };
  };
  return withBusyRepo(cx, root, { op: "off", workspace: (r) => r?.holder ?? null }, async () => {
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
    // Every process the server was seen with while the repo was lit (F1,
    // noteLive), and the ports the live server held (D26): a child that left
    // the server's tree before the turn-off still dies when it holds one of
    // those ports, or one of the identities' own (ports.js serverSnapshot
    // adds them, G7), and is one of those processes.
    const procs = Array.isArray(record?.serverProcs) ? record.serverProcs : [];
    const ports = Array.isArray(record?.ports) ? record.ports : [];
    const head = { workspace: holder ? path.basename(holder) : null, branch: holder ? await branchOf(holder) : null };
    const stopped = await serverOf(cx).stopServer(
      { root, terminal: record?.serverTerminal ?? null, logPath, serverPid: record?.serverPid ?? null, ...head, ports, procs },
      cx.serverDeps,
    );
    // H5: the toast and the error say why in Spanish only (G5); stopServer's
    // own note, written before the restore, carries its cause in its own
    // words (hc's or ps's), where `spotlight logs` reads it (K4/K5). An
    // answer it wrote none for gets the turn-off's own line (L7).
    const fallback = stopFallbackNote(stopped);
    if (fallback) appendLogHeader(logPath, { ...head, at: cx.now(), event: fallback });
    let res;
    try {
      res = await deactivate(cx.gitCtx, root, { force });
    } catch (e) {
      return fail(e, holder, stopped);
    }
    // stopServer couldn't say the server stopped (any ok: false: some of it
    // lived through SIGKILL, hc couldn't reach or read its terminal, it kept
    // running). The root is restored all the same (no git step waits on that
    // process, and a turn-off never gets stuck on it), but the turn-off is an
    // error that says why, never "root restaurado" (D26, F3): an error
    // toast (D35).
    const failed = stopped?.ok === true ? null : turnOffError(stopped);
    const now = cx.now();
    await cx.store.updateState((s) => {
      delete s.repos[root];
      delete s.queue.lighting[`direct/${root}`];
      // D41: a turn-off's error (Orca's title), Orca's success, or, left
      // detached, Orca's warning alone in its place, quiet or not.
      if (failed) {
        addNote(s, { repo: root, text: `${name}: ${failed.message}`, toast: true, level: "error", title: ERROR_TITLES.off(name), body: failed.message }, now);
      } else if (!quiet && !res.warning) {
        addNote(s, { repo: root, text: "Spotlight off — root restaurado", toast: true, level: "success", title: "Spotlight off — root del proyecto restaurado", body: "" }, now);
      }
      if (res.warning) addNote(s, { repo: root, text: `${name}: ${res.warning.message}`, ...detachedToast(res) }, now);
      for (const text of rescuedNotes(res.rescued, res.discardedRepos)) addNote(s, herdrNote(root, name, text), now);
    });
    const done = { warning: res.warning, stopped, rescued: res.rescued, discardedRepos: res.discardedRepos };
    return failed ? { ok: false, ...failed, ...done } : { ok: true, ...done };
  });
}

// D41: the toast of a turn-off that restored the root but couldn't put it
// back on its branch (sync.js deactivate's branch-missing warning): Orca's
// warning, for 60 s, its body by why: the branch checked out in another
// worktree (`branchInUse`), or gone.
const DETACHED_TOAST_MS = 60_000;
function detachedToast({ originalBranch, branchInUse }) {
  const body = branchInUse
    ? `Su rama "${originalBranch}" está abierta en otro workspace, así que el root no pudo volver a ella. Libera esa rama (o cambia el root a cualquier rama) para volver a engancharlo.`
    : "La rama original del root ya no existe, así que quedó detached en su commit original.";
  return { toast: true, level: "warning", title: "Spotlight off — el root del proyecto quedó detached", body, timeout: DETACHED_TOAST_MS };
}

// Some pids, for a sentence: "el proceso 900 <one>", "los procesos 900,
// 901 <many>".
function pidsPhrase(pids, one, many) {
  const list = Array.isArray(pids) ? pids : [];
  return list.length === 1 ? `el proceso ${list[0]} ${one}` : `los procesos ${list.join(", ")} ${many}`;
}

// Who lived through SIGKILL, for a sentence: "el proceso 900 siguió vivo",
// "los procesos 900, 901 siguieron vivos" (a turn-off's error, and
// Liberar puerto y arrancar's line in cli.mjs).
export const survivorsPhrase = (pids) => pidsPhrase(pids, "siguió vivo", "siguieron vivos");

// Who of a server lived through its stop, for a sentence: "el proceso 900
// siguió vivo después de SIGKILL", with "y el proceso 901 no se pudo
// señalar" for the leftovers stopServer `refused` to signal (their tree
// holds the CLI or the terminal's shell), which it counts among its
// `survivors` but which never got a SIGKILL.
function survivedDetail(survivors, refused = []) {
  const never = Array.isArray(refused) ? refused : [];
  const killed = (Array.isArray(survivors) ? survivors : []).filter((pid) => !never.includes(pid));
  const parts = [];
  if (killed.length > 0 || never.length === 0) parts.push(`${survivorsPhrase(killed)} después de SIGKILL`);
  if (never.length > 0) parts.push(pidsPhrase(never, "no se pudo señalar", "no se pudieron señalar"));
  return parts.join(" y ");
}

// A turn-off whose server didn't die: its error, naming the pids.
export function survivedError(survivors, refused = []) {
  return {
    code: SERVER_SURVIVED,
    message: `El server no paró al apagar Spotlight: ${survivedDetail(survivors, refused)} (el root sí se restauró).`,
  };
}

// Why stopServer's ok: false, in Spanish only, by its reason (G5): its own
// message is English and says again that the server may still be running,
// which the error already says. The pid where stopServer names one.
const STOP_FAILURES = {
  // No Ctrl-C, and hc couldn't read the terminal after it either.
  "interrupt-failed": () => "hc no pudo mandarle Ctrl-C ni leer su terminal",
  // Its processes were killed, but its `script` still leads the terminal.
  "still-running": (stopped) =>
    Number.isInteger(stopped.pid) ? `el proceso ${stopped.pid} siguió corriendo en su terminal` : "siguió corriendo en su terminal",
  unreadable: () => "hc no pudo leer su terminal",
};

// Why a server didn't stop, in Spanish (stopServer's answer without ok:
// true): who lived through SIGKILL or was never signalled, or the reason's
// words. A reason this doesn't know yet is named as stopServer gave it.
function stopFailure(stopped) {
  if (stopped?.reason === "survived") return survivedDetail(stopped.survivors, stopped.refused);
  const said = STOP_FAILURES[stopped?.reason];
  return said ? said(stopped) : `Spotlight no pudo confirmar que paró (${stopped?.reason ?? "sin respuesta"})`;
}

// The error of a turn-off whose server didn't stop (stopServer's answer
// without ok: true): server-survived when some of it lived through SIGKILL
// or was never signalled (survivedError), else server-not-stopped saying
// why (stopFailure). A reason this doesn't know yet still fails the
// turn-off. Both codes are TURN_OFF_ERRORS (server-errors.js, which defines
// them, H9): never stored.
export function turnOffError(stopped) {
  if (stopped?.reason === "survived") return survivedError(stopped.survivors, stopped.refused);
  return { code: SERVER_NOT_STOPPED, message: `El server no paró al apagar Spotlight: ${stopFailure(stopped)} (el root sí se restauró).` };
}

// The turn-off's own line in the server log for a stop that couldn't say
// the server stopped and whose answer stopServer wrote no note for (L7): no
// answer at all, or a reason it never gives (every ok: false it does give
// writes its own, server.js NOTED_STOP_FAILURES). The reason, else "no
// answer", and the answer's own words when it has some; null when
// stopServer's note says it already, or the stop went through.
function stopFallbackNote(stopped) {
  if (stopped?.ok === true || NOTED_STOP_FAILURES.has(stopped?.reason)) return null;
  const said = causeWords(stopped?.message);
  return `Spotlight off — server NOT stopped (${stopped?.reason ?? "no answer"})${said ? `: ${said}` : ""}`;
}

// A refused restore's message when the server's stop had failed before it
// (G4): one message, so one toast and one line, says both.
function alsoNotStopped(message, stopped) {
  const said = oneLine(message);
  const end = /[.!?]$/.test(said) ? "" : ".";
  return `${said}${end} Además, el server no paró: ${stopFailure(stopped)}.`;
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
  const live = leftAloneLook(record, await serverOf(cx).readServerState(
    { root: member.root, terminal: record.serverTerminal, logPath, serverPid: record.serverPid, port: configured },
    cx.serverDeps,
  ));
  const running = live.state === "listening" || live.state === "starting";
  // D25: a start that looks dead is settled under the repo lock first (R6):
  // a start or restart in flight holds that lock and leaves the shell in
  // front for a moment, which is no death, so `on` keeps waiting. Settled,
  // the agent reads the error recorded and toasted (R10). D24, D25: a start
  // a busy port refused, or one that died before; nothing will open a port,
  // and the agent reads why: the server error in force, also under a root
  // error (F7).
  const suspect = diedAtStart(record, live);
  const died = suspect ? await settleDeadStart(cx, member.root) : null;
  const shown = serverErrorOf(record.lastError);
  const why = died ?? (shown && live.state !== "listening" ? shown : null);
  const down = why ? { serverError: true, error: why.message } : {};
  return {
    ...base,
    listening: live.state === "listening",
    server: running ? "running" : live.state === null ? "unknown" : "stopped",
    serverState: live.state,
    ports: live.ports,
    // F1: the processes seen, for recordServers' serverProcs.
    procs: live.procs ?? [],
    // The start this look is of (L4): recordServers merges it only into a
    // record still on that start.
    serverStartedAt: record.serverStartedAt ?? null,
    port: live.port ?? configured,
    url: live.url ?? portUrl(configured),
    syncError,
    // Looked dead, not settled (its lock was busy): recordServers leaves it
    // `starting` for the next look.
    deadStart: suspect && !died,
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

// Whether a look at a server (`sv`: describeServer's, the reap's) was of
// the start record `r` is on now: one restarted since (Reiniciar, a
// lockfile, an env: `starting` again with a new serverStartedAt) is another
// server, and the look's stale state, ports and processes would hide its
// death at start (L4), as settleDeadStart checks too.
const sameStart = (sv, r) => (sv.serverStartedAt ?? null) === (r.serverStartedAt ?? null);

// Whether a look at a server (`on`'s describeServer, the reap's) goes into
// its record `r` as written: not one waiting for a variant (a plan asked for
// one since the look, M6), nor a start that looked dead and wasn't settled
// (its lock was busy), which stays `starting`, nor a record restarted since
// the look (sameStart). The reap's write and `on`'s both judge by it (M6).
const mergesInto = (sv, r) =>
  Boolean(r) && r.serverState !== "needs-variant" && !(sv.deadStart && r.serverState === "starting") && sameStart(sv, r);

// Whether `on`'s look at a lit server (describeServer's `sv`) goes into its
// record `r`: one it saw lit and in a state, by mergesInto's rule.
const merges = (sv, r) => Boolean(sv.lit && sv.serverState) && mergesInto(sv, r);

// What `on` saw of each lit server goes back to state.json (badges, status,
// and the processes the turn-off may have to kill: noteLive). A start that
// died was recorded already, as the reap records it, when describeServer
// settled it (D25, R10); one whose repo lock was busy stays `starting`, so
// the next look still sees it. Only the records it writes get goneOf's ps
// (H8): the same rule (merges) picks them before the read and in the write,
// and the write merges only a root the read picked (K6): a record that turned
// mergeable between the two (a variant picked, a dead start settled) has no
// ps behind it, so it waits for the next round. A record restarted since
// describeServer looked is never merged (merges' sameStart, L4). A lit
// server `on` saw end by hand (its record `listening`, the look gone or
// stopped) is settled under its repo lock instead (settleServerEnd, D34),
// never merged here: one toast, whoever sees it first, `on` or the reap.
export async function recordServers(cx, servers) {
  const repos = cx.store.readState().repos;
  const ended = servers.filter((sv) => sv.lit && serverEnded(repos[sv.root], sv.serverState)).map((sv) => sv.root);
  for (const root of new Set(ended)) await settleServerEnd(cx, root);
  const looked = new Set(servers.filter((sv) => !ended.includes(sv.root) && merges(sv, repos[sv.root])).map((sv) => sv.root));
  const gone = await goneOf(cx, repos, [...looked]);
  await cx.store.updateState((s) => {
    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (looked.has(sv.root) && merges(sv, r)) noteLive(r, { state: sv.serverState, ports: sv.ports, procs: sv.procs }, gone);
    }
  });
}

// ── reap ───────────────────────────────────────────────────────────────────

// D27: reconcileRepo for a root Orca's Spotlight may have (`orcaHolds`, its
// HEAD detached on an "Orca Spotlight" commit). While Orca has it, our record
// (or our orphan refs) says orca-holds, never reconcileRepo's root-diverged:
// that one offers Forzar sync and Apagar igual in the popup, which would undo
// Orca's projection, and flipping a sync's orca-holds back to it on every
// reap would toast it again on the next sync. A server error the record had
// (port-busy, server-exited) still applies under Orca's hold: it goes under
// orca-holds (setRootError, R8), and under reconcileRepo's root-diverged too
// (F6). Once Orca lets go, the record is decided again without orca-holds,
// with that server error back unless the server came up meanwhile
// (clearOnListen): by reconcileRepo, a record with no holder (our orphan
// refs) from scratch. → reconcileRepo's { action, record? }, plus
// "orca-holds" and "cleared" (orca-holds gone, nothing else).
export function reconcileWithOrca(before, refs, orcaHolds, at) {
  if (!refs?.rootHeadSha) return reconcileRepo(before, refs, at);
  const flagged = before?.lastError?.code === "orca-holds";
  if (orcaHolds && refs.active) {
    if (flagged) return { action: "keep" };
    const record = { ...(before ?? { ...emptyRepo(), lastSnapshotSha: refs.snapshotSha }) };
    return { action: "orca-holds", record: setRootError(record, { code: "orca-holds", message: ORCA_HOLDS_MESSAGE, at }) };
  }
  if (!flagged) return underRootError(before, reconcileRepo(before, refs, at));
  const cleared = before.holder ? clearRootError({ ...before }) : null;
  const out = underRootError(cleared, reconcileRepo(cleared, refs, at));
  if (out.action !== "keep") return out;
  return cleared ? { action: "cleared", record: cleared } : { action: "keep" };
}

// reconcileRepo (store.js) writes its root error (root-diverged) in place of
// the record's lastError: the server error in force goes under it (F6).
function underRootError(before, out) {
  if (!out.record?.lastError || !before?.lastError) return out;
  return { ...out, record: setRootError({ ...out.record, lastError: before.lastError }, out.record.lastError) };
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
// starting (D25), listening servers that ended by hand (their tab closed, a
// Ctrl-C: settleServerEnd's one toast, D34), server errors a listen ends
// and the processes each server
// is seen with (noteLive, F1; the remembered ones that died dropped, G3),
// log rotation and a
// detached sync for a server running another env than the effective one
// (J-002); a regrant (a raised cap); lights for turns whose marker is
// missing or whose light died; and busy marks and task batches whose
// process is gone (staleMarks, D33, D31).
// `on` and `off` run the queue part only (`full: false`: turn ends, the
// regrant, the lights; D13 "checked by on, off and reap"), so the line moves
// while the footer isn't running; `skip` is the caller's own terminal, whose
// request it is rewriting itself.
export async function reap(cx, { full = true, skip = null } = {}) {
  const now = cx.now();
  const reconciled = full ? await reconcileFree(cx) : [];
  const state = cx.store.readState();
  const requests = state.queue.requests;
  // Read before the state lock: its `ps` never runs under it (D7).
  const stale = full ? staleMarks(cx, state) : { repos: [], batches: [] };

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
    const live = leftAloneLook(rec, await serverOf(cx).readServerState(
      { root, terminal: rec.serverTerminal, logPath: rec.logPath, serverPid: rec.serverPid, port: repoSettings(cx.settings, root).port },
      cx.serverDeps,
    ));
    // D25: a start that died is decided under the repo lock, which writes
    // its state; until then it stays `starting`.
    if (diedAtStart(rec, live)) {
      await settleDeadStart(cx, root);
      continue;
    }
    // D34: a listening server that ended (its tab closed, a Ctrl-C) is
    // decided under the repo lock too, which writes its state and its one
    // toast; until then it stays `listening`.
    if (serverEnded(rec, live.state)) {
      await settleServerEnd(cx, root);
      continue;
    }
    if (live.state && live.state !== "gone") await showHiddenServer(cx, root, live.terminal ?? rec.serverTerminal);
    // With the start it is a look at, for the write (sameStart, L4).
    if (live.state) servers.push({ root, state: live.state, ports: live.ports, procs: live.procs, serverStartedAt: rec.serverStartedAt ?? null });
    // J-002: a server in another env than the effective one restarts through
    // a detached sync (D18: a restart outlasts the reap's second). Only
    // Spotlight's own server, never a foreign process holding a port. A root
    // with an error waits for it to clear: its sync would fail first. An env
    // that couldn't run isn't tried again from here (J-009) nor by a sync
    // (M1) until settings are saved after that (J-011); Reiniciar, a picked
    // env, a light, Forzar sync and a hand-typed `spotlight sync` always do.
    // Its sync is an automatic one (`--auto`, N4).
    const gaveUp = envGaveUp(cx, root, rec, savedAt, state.envs);
    if (
      live.owner === "spotlight" && !rec.lastError && !gaveUp &&
      (await envDrift(cx, root, { ...rec, serverState: live.state }, state.envs))
    ) envSyncs.push(root);
  }
  // G3: the remembered identities that died, read before the synchronous write.
  const gone = await goneOf(cx, state.repos, servers.map((sv) => sv.root));

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

    // Only into a record still on the start the look was of (L4), and not
    // one that turned to wait for a variant since: `on`'s whole rule (M6).
    for (const sv of servers) {
      const r = s.repos[sv.root];
      if (mergesInto(sv, r)) noteLive(r, sv, gone);
    }
    // Only while each is still the mark read (a new light's stays).
    for (const [root, mark] of stale.repos) clearBusy(s, root, mark);
    for (const [key, mark] of stale.batches) clearTaskBatch(s, key, mark);

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
  for (const root of envSyncs) cx.spawn(["sync", "--repo", root, "--auto"]);
  return { ...out.result.counts, lights: out.result.keys.length };
}
