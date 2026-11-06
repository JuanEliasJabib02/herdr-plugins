// The test queue as the footer flask and the "Cola de pruebas" popup draw it
// (T8, S1, S9, S13), ported from Orca's test-queue-board.ts and
// TestQueuePopover.tsx (O/src/renderer/src/components/sidebar/test-queue/),
// with the words of Orca's Spanish locale (tester case 14). Plus the footer
// copy's three bookkeepers: the toasts' high-water mark (D18), the state
// watch's batch filter (D18) and the reaper's debounce (D13).
// Pure: no herdr or gpui-kit import, so `node --test` loads it; footer.js,
// board.js and reaper.js read the files and the live data and hand them in.
//
// The rows come from the CLI's own `status --json` model (cli-format.mjs
// buildStatus, pure), fed with state.json and settings.json as the mod reads
// them, so the board always says what `spotlight status` says.
//
//   readState(text)          state.json's text as a v1 state (anything else: empty)
//   readSettings(text)       settings.json's text as settings (settings.js)
//   boardView({ state, settings, registry, now })
//                            the popup: header, sections and rows
//   footerView(board)        the flask: { count, quiet, tooltip }
//   toastMark(startedAt), takeToasts(notes, mark)
//                            notes with `toast: true` newer than the mark
//   isStateBatch(dir, paths) whether a watchFolder batch touched state.json
//   reapTargets(state), reapFingerprint(terminals, targets),
//   reapClock(), reapTick(clock, { now, print }), reapDone(clock)
//                            when the footer copy runs `spotlight reap`

import { buildStatus } from "./cli-format.mjs";
import { IDLE_MS } from "./cli-turns.mjs";
import { parseSettings, normRoot } from "./settings.js";

// This mod's folder name under mods/, for openOverlay.
export const MOD = "spotlight";

const MINUTE_MS = 60_000;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";

// The state folder (state.json, settings.json, locks/): store.js's default,
// `<appHome>/spotlight`. Pass herdr's appHome().
export const stateDirOf = (appHome) => `${normRoot(appHome)}/spotlight`;

// The installed CLI, inside this mod's folder (D2). Pass herdr's appHome().
export const cliPathOf = (appHome) => `${normRoot(appHome)}/mods/${MOD}/bin/spotlight`;

// Orca's Spanish words (es.json, auto.components.sidebar.TestQueue), and the
// two this port adds: the queue switch (S9) and the sign-in pause (D13).
const WORDS = {
  title: "Cola de pruebas",
  nobody: "Nadie está probando",
  queueOff: "Cola de pruebas apagada",
  queueOffNote: "La cola está apagada: cada agente prueba sin esperar turno.",
  limit: (n) => `Límite: ${n} a la vez`,
  testing: "Probando",
  waiting: "En cola",
  paused: "Pausados",
  idleFor: (n) => `sin actividad hace ${n} min`,
  waitingFor: (n) => `esperando ${n} min`,
  outOfLimit: "se quedó sin límite",
  needsSignIn: "necesita iniciar sesión",
  stoppedOnError: "se detuvo por un error",
};

// ── Reading ────────────────────────────────────────────────────────────────

const emptyState = () => ({ version: 1, repos: {}, queue: { requests: [], lighting: {} }, notes: [] });

// state.json's text (null when absent) as the v1 state buildStatus reads.
// Tolerant like store.js's normalizeState: text that isn't a v1 state is the
// empty state; a repo record, request, lighting marker or note that isn't an
// object is dropped, a request without a terminal or task key too, and a
// request's members are always an array of objects.
export function readState(text) {
  let value = null;
  try {
    value = text == null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  if (!isObject(value) || value.version !== 1) return emptyState();
  const repos = {};
  for (const [root, record] of Object.entries(isObject(value.repos) ? value.repos : {})) {
    const key = normRoot(root);
    if (key.startsWith("/") && isObject(record) && !(key in repos)) repos[key] = record;
  }
  const q = isObject(value.queue) ? value.queue : {};
  const requests = (Array.isArray(q.requests) ? q.requests : [])
    .filter((r) => isObject(r) && isText(r.terminal) && isText(r.taskKey))
    .map((r) => ({ ...r, members: (Array.isArray(r.members) ? r.members : []).filter(isObject) }));
  const lighting = Object.fromEntries(Object.entries(isObject(q.lighting) ? q.lighting : {}).filter(([, m]) => isObject(m)));
  const notes = (Array.isArray(value.notes) ? value.notes : []).filter(isObject);
  return { ...value, version: 1, repos, queue: { ...q, requests, lighting }, notes };
}

// settings.json's text (null when absent) as settings; never throws.
export const readSettings = (text) => parseSettings(text).settings;

// projects-sidebar's projects.v1 groups, read-only and tolerant (as task.js).
function groupsOf(registry) {
  if (!isObject(registry) || !Array.isArray(registry.groups)) return [];
  return registry.groups.filter((g) => isObject(g) && isText(g.id) && typeof g.name === "string");
}

// How a repo is named (its projects.v1 name, else its folder, as the CLI's
// repoNamer) and a lane's space (its group's name; null for "spaceless" or
// an unknown group, so the row skips it, as Orca).
function namers(registry) {
  const repos = new Map();
  const spaces = new Map();
  for (const g of groupsOf(registry)) {
    if (!spaces.has(g.id)) spaces.set(g.id, g.name || null);
    for (const p of Array.isArray(g.projects) ? g.projects : []) {
      const root = normRoot(p?.path);
      if (root.startsWith("/") && isText(p.name) && !repos.has(root)) repos.set(root, p.name);
    }
  }
  return {
    repo: (root) => repos.get(normRoot(root)) ?? (normRoot(root).split("/").filter(Boolean).pop() || root),
    space: (lane) => spaces.get(lane) ?? null,
  };
}

// ── The board ──────────────────────────────────────────────────────────────

// `orca · Arrecife · esperando 9 min`: repos, space and status, skipping
// what is unknown. A task named after its only repo shows the name once.
function rowMeta(name, repoNames, spaceName, status) {
  const repos = repoNames.join(", ");
  const showRepos = repos !== "" && repos.toLowerCase() !== String(name).toLowerCase();
  return [showRepos ? repos : null, spaceName, status].filter(Boolean).join(" · ");
}

// Minutes since a turn's newest activity, once it went IDLE_MS quiet (D19);
// null while active. Idle counts from the grant at the earliest: an agent
// waiting in `spotlight on` reports nothing, so its last activity predates
// the turn (Orca's idleMinutesOf).
function idleMinutesOf(turn, now) {
  const times = [turn.grantedAt, turn.lastActivityAt].filter(Number.isFinite);
  if (times.length === 0) return null;
  const quiet = now - Math.max(...times);
  return quiet >= IDLE_MS ? Math.floor(quiet / MINUTE_MS) : null;
}

function waitingLabel(since, now) {
  if (!Number.isFinite(since)) return null;
  const minutes = Math.floor((now - since) / MINUTE_MS);
  // Under a minute the section title already says it waits.
  return minutes < 1 ? null : WORDS.waitingFor(minutes);
}

function pauseLabel(reason) {
  if (reason === "limit") return WORDS.outOfLimit;
  if (reason === "signin") return WORDS.needsSignIn;
  return WORDS.stoppedOnError;
}

// The server popup a row opens (D22's props): the row's first repo, with the
// workspace its task lights there (the holder when it is one of them).
// Null for a row with no repo (a slot-only turn).
function serverTarget(state, requests, preferHolder) {
  for (const r of requests) {
    for (const m of r.members) {
      const repo = normRoot(m.root);
      if (!repo.startsWith("/")) continue;
      const workspaces = requests
        .flatMap((x) => x.members)
        .filter((x) => normRoot(x.root) === repo)
        .flatMap((x) => (Array.isArray(x.workspaces) ? x.workspaces : [x.workspace]))
        .filter(isText);
      const holder = state.repos[repo]?.holder ?? null;
      const workspace = preferHolder && workspaces.includes(holder) ? holder : (workspaces[0] ?? null);
      return workspace ? { view: "server", repo, workspace } : null;
    }
  }
  return null;
}

/**
 * The popup's model. `state`: readState's; `settings`: readSettings';
 * `registry`: shared("projects.v1"); `now`: ms. Rows:
 *   testing  one per task holding a turn: { key, name, meta, idleMinutes,
 *            resuming, release, terminals, server }. `release`: Soltar turno
 *            shows (Orca shows it, with Continuar, once the turn is idle or
 *            resuming); `terminals`: every agent of the turn, each given back.
 *   waiting  one per task in line: { key, name, meta, server }.
 *   paused   one per paused agent: { key, terminal, name, meta, reason,
 *            resuming, server }.
 * `server`: the server popup's props, or null. `count` (testing + waiting)
 * never counts the paused.
 */
export function boardView({ state, settings, registry = null, now }) {
  const names = namers(registry);
  const status = buildStatus({ state, settings, now, nameOf: names.repo });
  const requests = state.queue.requests;
  const ofTask = (key, holding) => requests.filter((r) => r.taskKey === key && (r.state === "holding") === holding);

  const testing = status.turns.map((turn) => {
    const idleMinutes = idleMinutesOf(turn, now);
    const status = idleMinutes === null ? null : WORDS.idleFor(idleMinutes);
    return {
      key: `turn:${turn.key}`,
      name: turn.taskKey,
      meta: rowMeta(turn.taskKey, turn.repos, names.space(turn.lane), status),
      idleMinutes,
      resuming: turn.resuming === true,
      release: idleMinutes !== null || turn.resuming === true,
      terminals: turn.terminals,
      server: turn.slotOnly ? null : serverTarget(state, ofTask(turn.key, true), true),
    };
  });

  const waiting = status.waiting.map((row) => ({
    key: `waiting:${row.key}`,
    name: row.taskKey,
    meta: rowMeta(row.taskKey, row.repos, names.space(row.lane), waitingLabel(row.since, now)),
    server: serverTarget(state, ofTask(row.key, false).filter((r) => r.state !== "paused"), false),
  }));

  const paused = status.paused.map((row) => ({
    key: `paused:${row.terminal}`,
    terminal: row.terminal,
    name: row.taskKey,
    meta: rowMeta(row.taskKey, row.repos, names.space(row.lane), pauseLabel(row.reason)),
    reason: row.reason,
    resuming: row.resuming === true,
    server: serverTarget(state, requests.filter((r) => r.terminal === row.terminal), false),
  }));

  const sections = [
    { kind: "testing", title: WORDS.testing, rows: testing },
    { kind: "waiting", title: WORDS.waiting, rows: waiting },
    { kind: "paused", title: WORDS.paused, rows: paused },
  ].filter((s) => s.rows.length > 0);

  return {
    title: WORDS.title,
    limit: WORDS.limit(status.cap),
    queue: status.queue,
    offNote: status.queue === "off" ? WORDS.queueOffNote : null,
    count: testing.length + waiting.length,
    testing,
    waiting,
    paused,
    sections,
    empty: sections.length === 0,
    emptyText: WORDS.nobody,
  };
}

/**
 * The flask in the status row: how many tasks test or wait (Orca's
 * TestQueueButton). Dimmed (`quiet`) only when nothing is in line: paused
 * agents never count, but they keep it lit, since they wait for a Continuar.
 */
export function footerView(board) {
  const tooltip = board.queue === "off" ? WORDS.queueOff : board.count === 0 ? WORDS.nobody : WORDS.title;
  return { count: board.count, quiet: board.count === 0 && board.paused.length === 0, tooltip };
}

// ── Toasts (D18) ───────────────────────────────────────────────────────────

// The high-water mark: the newest note time shown, and which notes of that
// very millisecond were shown (two writes can share one). It starts at the
// footer copy's start time, so a restarted copy never replays old notes.
export const toastMark = (startedAt) => ({ at: startedAt, seen: [] });

const noteKey = (n) => `${n.at}\n${n.repo ?? ""}\n${n.text}`;

// A note's action as herdr's notify takes it: a command name and its args.
function actionOf(action) {
  if (!isObject(action) || !isText(action.name)) return null;
  return isObject(action.args) ? { name: action.name, args: action.args } : { name: action.name };
}

// notify()'s argument for one note. A note with an action is a refusal the
// server popup can force (root diverged, untracked collision): a warning.
function toastOf(note) {
  const action = actionOf(note.action);
  return action
    ? { title: "Spotlight", body: note.text, level: "warning", action }
    : { title: "Spotlight", body: note.text, level: "info" };
}

/**
 * The notes to post as toasts: `toast: true`, newer than the mark, oldest
 * first. → { toasts: [notify argument], mark: the mark after them }.
 */
export function takeToasts(notes, mark) {
  const fresh = (Array.isArray(notes) ? notes : [])
    .filter((n) => isObject(n) && n.toast === true && isText(n.text) && Number.isFinite(n.at))
    .filter((n) => n.at > mark.at || (n.at === mark.at && !mark.seen.includes(noteKey(n))))
    .sort((a, b) => a.at - b.at);
  if (fresh.length === 0) return { toasts: [], mark };
  const at = fresh[fresh.length - 1].at;
  const seen = [...(at === mark.at ? mark.seen : []), ...fresh.filter((n) => n.at === at).map(noteKey)];
  return { toasts: fresh.map(toastOf), mark: { at, seen } };
}

// ── The state watch (D18) ──────────────────────────────────────────────────

/**
 * Whether a watchFolder batch on the state folder asks for a re-read: it
 * holds state.json, or the folder itself (herdr: "a batch containing the
 * root means refresh everything"). Lock dirs, the CLI's tmp files and
 * settings.json alone are ignored.
 */
export function isStateBatch(dir, paths) {
  const root = normRoot(dir);
  const file = `${root}/state.json`;
  return (Array.isArray(paths) ? paths : []).some((p) => {
    const path = normRoot(p);
    return path === file || path === root;
  });
}

// ── The reaper (D13) ───────────────────────────────────────────────────────

// A burst of terminals() changes is reaped once, this long after the last.
export const REAP_DEBOUNCE_MS = 1_000;
// With nothing changing, a reap this often (idle times, gone servers, grants).
export const REAP_EVERY_MS = 30_000;

// The terminals whose changes can end a turn or a server: every agent in
// line and every repo's server terminal.
export function reapTargets(state) {
  const ids = [
    ...state.queue.requests.map((r) => r.terminal),
    ...Object.values(state.repos).map((r) => r.serverTerminal),
  ].filter(isText);
  return [...new Set(ids)];
}

// What of terminals() a reap cares about: the targets' state, status word and
// turn count (hc ls --json), so a title or an unrelated agent never wakes it.
// A target that went away changes it too.
export function reapFingerprint(terminals, targets) {
  const want = new Set(targets);
  return (Array.isArray(terminals) ? terminals : [])
    .filter((t) => isObject(t) && (want.has(t.address) || want.has(t.name)))
    .map((t) => `${t.address}|${t.state ?? ""}|${t.status ?? ""}|${t.turn ?? ""}`)
    .sort()
    .join("\n");
}

// The reaper's clock: the last fingerprint, when it last changed, the last
// reap, and whether one runs now. The first look reaps (the copy just
// started) and takes the fingerprint as its baseline.
export const reapClock = () => ({ looked: false, print: null, changedAt: null, lastReapAt: null, running: false });

/**
 * One look at terminals(): → { clock, reap }. `reap` is true when the
 * fingerprint has been still for REAP_DEBOUNCE_MS after a change (a trailing
 * debounce), or REAP_EVERY_MS passed since the last reap; never while one
 * runs (a change seen meanwhile is reaped once it ends). Call reapDone when
 * the reap ends.
 */
export function reapTick(clock, { now, print }) {
  const c = { ...clock };
  if (!c.looked) Object.assign(c, { looked: true, print });
  else if (print !== c.print) Object.assign(c, { print, changedAt: now });
  if (c.running) return { clock: c, reap: false };
  const settled = c.changedAt !== null && now - c.changedAt >= REAP_DEBOUNCE_MS;
  const periodic = c.lastReapAt === null || now - c.lastReapAt >= REAP_EVERY_MS;
  if (!settled && !periodic) return { clock: c, reap: false };
  return { clock: { ...c, changedAt: null, lastReapAt: now, running: true }, reap: true };
}

export const reapDone = (clock) => ({ ...clock, running: false });
