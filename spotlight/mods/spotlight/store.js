// Spotlight's state store for the CLI (D7, D12). Node-only; the mod never
// imports it (the mod reads state.json itself, and settings through the pure
// settings.js).
//
// `<stateDir>` is `$HERDR_APP_HOME/spotlight`, else `~/.config/herdr-app/spotlight`:
//   state.json      written only by the CLI, through updateState: under the
//                   state lock, tmp + rename, and only when the text changes
//                   (a write that changes nothing leaves the file alone).
//   settings.json   written only by the mod; read here (readSettings).
//   locks/state     around a state.json read-modify-write, never across git.
//   locks/repo-<sha1(root)>
//                   from reading a repo's refs and holder, through the git
//                   work, to the state write. Order: repo lock, then state
//                   lock; the reverse throws "lock-order".
// `status` takes neither lock: readState never waits and never writes.
//
// state.json, schema v1:
//   { version: 1,
//     repos: { <root>: emptyRepo() fields, plus envKey? (D32: the holder's
//              key in `envs`, written by the light: the env in force is
//              envs[envKey], else settings' env; task-env.js recordEnv),
//              envOverride? (retired by D32: the server popup's env before
//              T22, still read on a record with no envKey until `toggle`
//              off drops it, never written again),
//              envFailed? and envFailedAt? (the env a start or restart
//              couldn't run, and when: the reap doesn't try it again until
//              settings.json is saved after that, nor a sync, J-009,
//              J-011, M1; a started server clears both), restartStuck?
//              { reason, at } (the last restart left the old server running:
//              it ignored the Ctrl-C, or never got it; a sync repeating that
//              reason doesn't toast again, M1; a start, or one that failed,
//              drops it) and busy? { op, since, pid, workspace }
//              (D33: a light, turn-off, Forzar sync or restart works on
//              the repo right now; set and cleared under its repo lock by
//              the process `pid` since `since` (ms), `workspace` the
//              target, absolute or null; markBusy, clearBusy) },
//     queue: { requests: [{ terminal, taskKey, lane, members, skipped, requestedAt, requestTurn,
//                           fgPid, state, slotOnly, grantedAt, pausedAt, pauseReason, pauseMsg,
//                           resumingUntil, handledTurn, autoResumes, lastActivityAt, outputHash }],
//              lighting: { <lane>/<taskKey>: { grantId, phase, pid, startedAt, error } },
//              taskBatch?: { <groupId>/<KEY>: { op, since, pid } } (D31: a
//                          whole-task toggle running; setTaskBatch,
//                          clearTaskBatch; absent when none runs) },
//     notes: [≤ 200 { at, repo, text, toast, action? }],
//     variants: { <lane>/<taskKey>::<root>: <variant> },   ≤ 500, oldest dropped first
//     envs?: { <groupId>/<KEY> | ws:<path>: local|dev|prod } }
//                  D32: every env pick, surviving the turn-off; ≤ 500, the
//                  oldest dropped first (rememberEnv); absent until the first
//                  pick, so a state from before it reads and writes as it was
// A task is keyed `<lane>/<taskKey>` in the queue and lighting (D12).
// Reading is tolerant: a file that isn't JSON or isn't v1 reads as the empty
// state and is copied to state.json.corrupt-<ms> before the first write over
// it. Unknown keys are kept.
//
// Every path and outside fact is injected (createStore), so tests run in
// temp dirs: the state dir, the settings path, the app home (shared.json),
// the ~/.claude path, the projects.v1 reader and T5a's server-command check.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { withLock, heldLocks, LockError } from "./locks.js";
import { parseSettings, repoSettings, repoEnabledFrom, normRoot } from "./settings.js";
import { isEnv } from "./task-env.js";

export const STATE_VERSION = 1;
export const NOTES_MAX = 200;
export const VARIANTS_MAX = 500;
export const ENVS_MAX = 500;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// Herdr's home: $HERDR_APP_HOME, else ~/.config/herdr-app (as the installer).
export function appHomeDir(env = process.env, home = os.homedir()) {
  return env.HERDR_APP_HOME || path.join(home, ".config", "herdr-app");
}

// ── Schema ─────────────────────────────────────────────────────────────────

export function emptyState() {
  return { version: STATE_VERSION, repos: {}, queue: { requests: [], lighting: {} }, notes: [], variants: {} };
}

// One repo's record, every field at its "nothing yet" value. serverState:
// starting | listening | stopped | gone. lastError: { code, message, at } | null.
export function emptyRepo() {
  return {
    holder: null,
    lastSnapshotSha: null,
    lastSyncAt: null,
    lastError: null,
    serverTerminal: null,
    serverPid: null,
    serverStartedAt: null,
    serverCommand: null,
    serverEnv: null,
    serverVariant: null,
    serverState: "stopped",
    pendingInstalls: [],
    ports: [],
    logPath: null,
  };
}

// A batch marker (D31: queue.taskBatch's entries): who runs it, since when.
const isBatchMark = (m) =>
  isObject(m) && typeof m.op === "string" && m.op !== "" && Number.isFinite(m.since) && Number.isInteger(m.pid) && m.pid > 0;

// A repo's busy mark (D33): a batch marker's fields plus the target
// workspace, an absolute path or null.
const isBusyMark = (m) => isBatchMark(m) && (m.workspace === null || (typeof m.workspace === "string" && m.workspace.startsWith("/")));

// A record's env key (D32): a non-empty string.
const isEnvKey = (k) => typeof k === "string" && k !== "";

// A stored value as a v1 state, or null when it isn't one. Shapes are
// enforced (repos and lighting entries are objects, requests and notes
// arrays of objects, at most NOTES_MAX notes, the newest kept; variants a
// map of non-empty strings, at most VARIANTS_MAX, the last inserted kept;
// a missing field reads as empty); repo records get emptyRepo()'s missing
// fields, and lose a busy mark or an envKey that isn't one; repo keys are
// normalized (normRoot), a relative one dropped, a root listed twice kept
// the first time. queue.taskBatch keeps its well-formed entries, and stays
// absent when the state has none; so does envs (D32), a map of envs, at
// most ENVS_MAX, the last inserted kept.
export function normalizeState(value) {
  if (!isObject(value) || value.version !== STATE_VERSION) return null;
  const repos = {};
  for (const [root, record] of Object.entries(isObject(value.repos) ? value.repos : {})) {
    const key = normRoot(root);
    if (!key.startsWith("/") || !isObject(record) || key in repos) continue;
    repos[key] = { ...emptyRepo(), ...record };
    if ("busy" in record && !isBusyMark(record.busy)) delete repos[key].busy;
    if ("envKey" in record && !isEnvKey(record.envKey)) delete repos[key].envKey;
  }
  const q = isObject(value.queue) ? value.queue : {};
  const lighting = {};
  for (const [key, entry] of Object.entries(isObject(q.lighting) ? q.lighting : {})) {
    if (isObject(entry)) lighting[key] = entry;
  }
  const queue = { ...q, requests: Array.isArray(q.requests) ? q.requests.filter(isObject) : [], lighting };
  if ("taskBatch" in q) {
    if (isObject(q.taskBatch)) queue.taskBatch = Object.fromEntries(Object.entries(q.taskBatch).filter(([, m]) => isBatchMark(m)));
    else delete queue.taskBatch;
  }
  const notes = (Array.isArray(value.notes) ? value.notes.filter(isObject) : []).slice(-NOTES_MAX);
  const kept = Object.entries(isObject(value.variants) ? value.variants : {}).filter(([, v]) => typeof v === "string" && v !== "");
  const variants = Object.fromEntries(kept.slice(-VARIANTS_MAX));
  const state = { ...value, version: STATE_VERSION, repos, queue, notes, variants };
  if ("envs" in value) {
    if (isObject(value.envs)) state.envs = Object.fromEntries(Object.entries(value.envs).filter(([, e]) => isEnv(e)).slice(-ENVS_MAX));
    else delete state.envs;
  }
  return state;
}

// state.json's text read as { state, valid }: no file (null) is the empty
// state and valid; text that isn't a v1 state is the empty state, not valid.
export function parseState(text) {
  if (text == null) return { state: emptyState(), valid: true };
  try {
    const state = normalizeState(JSON.parse(text));
    if (state) return { state, valid: true };
  } catch {
    // falls through: not JSON
  }
  return { state: emptyState(), valid: false };
}

export const serializeState = (state) => `${JSON.stringify(state, null, 2)}\n`;

// Appends a note (D18: progress and errors the footer turns into toasts),
// keeping the newest NOTES_MAX. Mutates and returns `state`.
export function addNote(state, { repo = null, text, toast = false, action } = {}, at = Date.now()) {
  state.notes.push({ at, repo, text, toast: Boolean(toast), ...(action ? { action } : {}) });
  if (state.notes.length > NOTES_MAX) state.notes.splice(0, state.notes.length - NOTES_MAX);
  return state;
}

// The key of a task's remembered variant in one repo (T5a):
// `<lane>/<taskKey>::<root>`, the root normalized.
export const variantKey = (lane, taskKey, root) => `${lane}/${taskKey}::${normRoot(root)}`;

// Remembers a variant under `key` as the newest entry (an existing key moves
// to the end), dropping the oldest past VARIANTS_MAX. Mutates and returns `state`.
export function rememberVariant(state, key, variant) {
  state.variants ??= {};
  delete state.variants[key];
  state.variants[key] = variant;
  const keys = Object.keys(state.variants);
  for (const k of keys.slice(0, Math.max(0, keys.length - VARIANTS_MAX))) delete state.variants[k];
  return state;
}

// Stores an env pick (D32) under `key` (`<groupId>/<KEY>` or ws:<path>,
// task-env.js) as the newest entry, Local included: an existing key moves
// to the end, and the oldest past ENVS_MAX are dropped. Mutates and returns
// `state`.
export function rememberEnv(state, key, env) {
  state.envs ??= {};
  delete state.envs[key];
  state.envs[key] = env;
  const keys = Object.keys(state.envs);
  for (const k of keys.slice(0, Math.max(0, keys.length - ENVS_MAX))) delete state.envs[k];
  return state;
}

// ── Busy marks (D33) and task batches (D31) ────────────────────────────────

// The same mark: one process's, from one moment (a reused pid starts later).
const sameMark = (a, b) => isObject(a) && isObject(b) && a.pid === b.pid && a.since === b.since;

// A record that holds nothing but emptyRepo()'s values.
function isBlankRepo(record) {
  const blank = emptyRepo();
  return Object.keys(record).every((k) => k in blank && JSON.stringify(record[k]) === JSON.stringify(blank[k]));
}

// Marks `root`'s record busy with `mark` ({ op, since, pid, workspace }).
// Called by whoever holds the repo's lock, so a mark already there from
// another process is a dead one's, and replaced; one of the same process
// is an outer call's (a restart inside a light), and left to it. No record:
// with `create` (a fresh light, whose target's row spins before it holds)
// one is made for the mark, else nothing is marked. Mutates `state`; → true
// when `mark` was set.
export function markBusy(state, root, mark, { create = false } = {}) {
  const record = state.repos[root];
  if (!record && !create) return false;
  if (record?.busy?.pid === mark.pid) return false;
  state.repos[root] = { ...(record ?? emptyRepo()), busy: { ...mark } };
  return true;
}

// Clears `root`'s busy mark when it is still `mark` (same pid and since): a
// mark a later process set stays. A record left with nothing of its own
// (one made only for the mark, by a light that wrote nothing) goes with it.
// Mutates `state`; → true when `mark` was cleared.
export function clearBusy(state, root, mark) {
  const record = state.repos[root];
  if (!record || !sameMark(record.busy, mark)) return false;
  delete record.busy;
  if (isBlankRepo(record)) delete state.repos[root];
  return true;
}

// Marks the whole-task toggle `key` (`<groupId>/<KEY>`) running with `mark`
// ({ op, since, pid }). Mutates `state`.
export function setTaskBatch(state, key, mark) {
  state.queue.taskBatch ??= {};
  state.queue.taskBatch[key] = { ...mark };
  return state;
}

// Clears batch `key` when it is still `mark`; the last one cleared drops
// queue.taskBatch. Mutates `state`; → true when `mark` was cleared.
export function clearTaskBatch(state, key, mark) {
  const batches = state.queue.taskBatch;
  if (!isObject(batches) || !sameMark(batches[key], mark)) return false;
  delete batches[key];
  if (Object.keys(batches).length === 0) delete state.queue.taskBatch;
  return true;
}

// ── Reconcile ──────────────────────────────────────────────────────────────

const ROOT_DIVERGED = "El root se movió del snapshot de Spotlight.";
const ORPHAN_REFS =
  "Hay refs de Spotlight en este repo sin registro de quién las tiene; apagar Spotlight restaura el root desde ellas.";

// Refs win (port of Orca's reconcile, spotlight-service.ts:239-280), for one
// repo. `record`: its state record or null. `refs`: T1's readRefs(root)
// (sync.js) { snapshotSha, backupSha, originalHeadSha, originalBranch,
// rootHeadSha, active }: `active` only when the snapshot, backup and
// original-head refs all exist, as T1's own activate reads them; a null
// rootHeadSha means the read failed. Returns { action } with:
//   keep       nothing to write, and always when the read failed (the record
//              is left untouched, never cleared on a failed read);
//   clear      the refs are gone, or partial (not active): the record is stale;
//   diverged   the root's HEAD isn't the snapshot: record with root-diverged;
//   orphan     refs with no record: a red record with orphan-refs, so
//              `toggle` off can restore the root from them;
// plus the new `record` for diverged and orphan. A record already flagged
// root-diverged or orphan-refs is kept as it is.
export function reconcileRepo(record, refs, at) {
  if (!isObject(refs) || !refs.rootHeadSha) return { action: "keep" };
  const active = refs.active === true;
  if (!record) {
    if (!active) return { action: "keep" };
    return {
      action: "orphan",
      record: { ...emptyRepo(), lastSnapshotSha: refs.snapshotSha, lastError: { code: "orphan-refs", message: ORPHAN_REFS, at } },
    };
  }
  if (!active) return { action: "clear" };
  const code = record.lastError?.code;
  if (refs.rootHeadSha !== refs.snapshotSha && code !== "root-diverged" && code !== "orphan-refs") {
    return { action: "diverged", record: { ...record, lastError: { code: "root-diverged", message: ROOT_DIVERGED, at } } };
  }
  return { action: "keep" };
}

// ── Files ──────────────────────────────────────────────────────────────────

// A file's text, or null when it doesn't exist.
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Replaces a file in one step: readers see the old text or the new, never part.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

// One key of Herdr's shared.json (never written from here, AGENTS.md:88-90);
// null when the file or the key is missing or unreadable.
function readSharedKey(sharedPath, key) {
  try {
    return JSON.parse(fs.readFileSync(sharedPath, "utf8"))?.[key] ?? null;
  } catch {
    return null;
  }
}

// projects-sidebar's reading of a group and a project (lib.js isGroup,
// isProject), so a group the sidebar drops registers nothing here either.
const isGroup = (g) => isObject(g) && typeof g.id === "string" && g.id !== "" && typeof g.name === "string" && Array.isArray(g.projects);
const isProject = (p) => isObject(p) && typeof p.path === "string" && p.path.startsWith("/") && typeof p.name === "string";

// ── The store ──────────────────────────────────────────────────────────────

// Options, all optional:
//   appHome           Herdr's home (default appHomeDir()): shared.json's folder
//   stateDir          default <appHome>/spotlight
//   settingsPath      default <stateDir>/settings.json
//   claudeDir         the live harness, always off (default ~/.claude)
//   readProjects()    projects.v1's value (default: read from <appHome>/shared.json)
//   hasServerCommand(root, repoSettings)
//                     T5a's check, sync or async; asked only for a registered
//                     git repo with no `enabled` value. Not injected: repoEnabled
//                     throws when it needs it.
//   isGitRepo(root)   default: <root>/.git exists
//   now()             ms clock (default Date.now)
//   locks             { state: {...}, repo: {...} } options for locks.js acquire
//                     (timeoutMs: 10 s for state, 150 s for a repo, which can be
//                     held across a whole lighting; pollMs; isAlive; startedAtOf)
export function createStore(opts = {}) {
  const appHome = opts.appHome ?? appHomeDir();
  const stateDir = opts.stateDir ?? path.join(appHome, "spotlight");
  const paths = {
    appHome,
    stateDir,
    statePath: path.join(stateDir, "state.json"),
    settingsPath: opts.settingsPath ?? path.join(stateDir, "settings.json"),
    sharedPath: path.join(appHome, "shared.json"),
    locksDir: path.join(stateDir, "locks"),
    claudeDir: opts.claudeDir ?? path.join(os.homedir(), ".claude"),
  };
  const now = opts.now ?? Date.now;
  const readProjects = opts.readProjects ?? (() => readSharedKey(paths.sharedPath, "projects.v1"));
  const hasServerCommand =
    opts.hasServerCommand ??
    (() => {
      throw new Error("spotlight store: hasServerCommand was not injected (T5a's server-command check)");
    });
  const isGitRepo = opts.isGitRepo ?? ((root) => fs.existsSync(path.join(root, ".git")));
  const stateLock = { timeoutMs: 10_000, pollMs: 10, ...opts.locks?.state };
  const repoLock = { timeoutMs: 150_000, pollMs: 50, ...opts.locks?.repo };
  const stateLockDir = path.join(paths.locksDir, "state");

  const repoLockDir = (root) => path.join(paths.locksDir, `repo-${sha1(normRoot(root))}`);

  // The current state; never waits, never writes.
  const readState = () => parseState(readText(paths.statePath)).state;

  // Read-modify-write of state.json under the state lock. `fn(draft)`
  // mutates a copy of the state and runs synchronously (an async one throws
  // TypeError and writes nothing): the state lock never spans git or any
  // other wait. Resolves { state, changed, result }: result is fn's return
  // value; changed is false when the new text is the old one (no write).
  function updateState(fn) {
    return withLock(
      stateLockDir,
      () => {
        const text = readText(paths.statePath);
        const { state, valid } = parseState(text);
        const draft = structuredClone(state);
        const result = fn(draft);
        if (result && typeof result.then === "function") {
          result.then(
            () => {},
            () => {},
          );
          throw new TypeError("updateState: the mutator must be synchronous (the state lock never spans async work)");
        }
        const next = normalizeState(draft);
        if (!next) throw new TypeError("updateState: the mutator left something that isn't a v1 state");
        const out = serializeState(next);
        if (out === text) return { state: next, changed: false, result };
        fs.mkdirSync(stateDir, { recursive: true });
        if (!valid && text != null) fs.writeFileSync(`${paths.statePath}.corrupt-${now()}`, text);
        writeAtomic(paths.statePath, out);
        return { state: next, changed: true, result };
      },
      stateLock,
    );
  }

  // Runs fn holding a repo's lock (async work allowed: git, the server).
  // Refused inside the state lock ("lock-order") and inside the same repo's
  // lock ("lock-reentry"); updateState inside it is the intended order.
  // `opts.timeoutMs` bounds this call's wait (0: one try), for a caller with
  // a deadline of its own (`on`, J-001); a lock still held then throws
  // LockError "lock-timeout".
  async function withRepoLock(root, fn, opts = {}) {
    if (heldLocks().has(stateLockDir)) {
      throw new LockError("lock-order", "A repo lock can't be taken while holding the state lock (order: repo, then state)");
    }
    const wait = Number.isFinite(opts.timeoutMs) ? { timeoutMs: Math.max(0, opts.timeoutMs) } : {};
    return withLock(repoLockDir(root), fn, { ...repoLock, ...wait });
  }

  // Refs win (D7): every repo with a record, plus `roots` (e.g. the enabled
  // repos, to find orphan refs), each under its repo lock. `readRefs(root)`
  // is T1's reader (sync.js readRefs; decided by its `active`, see
  // reconcileRepo). It never throws; a reader that does, or a failed read
  // (rootHeadSha null), leaves its repo as it is. Resolves the
  // changes made, [{ root, action, record }]: for "clear" the record removed
  // (so the caller can stop its server), else the record written.
  async function reconcile({ readRefs, roots = [] } = {}) {
    if (typeof readRefs !== "function") throw new TypeError("reconcile: readRefs(root) is required");
    const extra = roots.map(normRoot).filter((r) => r.startsWith("/"));
    const all = [...new Set([...Object.keys(readState().repos), ...extra])];
    const report = [];
    for (const root of all) {
      await withRepoLock(root, async () => {
        let refs;
        try {
          refs = await readRefs(root);
        } catch {
          return;
        }
        await updateState((s) => {
          const before = s.repos[root] ?? null;
          const out = reconcileRepo(before, refs, now());
          if (out.action === "keep") return;
          if (out.action === "clear") delete s.repos[root];
          else s.repos[root] = out.record;
          report.push({ root, action: out.action, record: out.action === "clear" ? before : out.record });
        });
      });
    }
    return report;
  }

  // settings.json as { settings, valid, backupPath }. Missing: the defaults.
  // Invalid (not JSON, not v1, unreadable): the defaults, and its text is
  // kept as settings.json.invalid-<sha1 prefix> next to it, once per distinct
  // content, before the mod saves over it (keepBackup: false skips that).
  // settings.json itself is never written here.
  function readSettings({ keepBackup = true } = {}) {
    let text;
    try {
      text = readText(paths.settingsPath);
    } catch {
      return { settings: parseSettings(null).settings, valid: false, backupPath: null };
    }
    const { settings, valid } = parseSettings(text);
    let backupPath = null;
    if (!valid && text != null) {
      const file = `${paths.settingsPath}.invalid-${sha1(text).slice(0, 12)}`;
      if (keepBackup) {
        try {
          fs.writeFileSync(file, text, { flag: "wx" });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      if (fs.existsSync(file)) backupPath = file;
    }
    return { settings, valid, backupPath };
  }

  // Whether `root` is the live harness (~/.claude), by realpath.
  function isHarnessRoot(root) {
    const r = realOr(root) ?? normRoot(root);
    const c = realOr(paths.claudeDir) ?? normRoot(paths.claudeDir);
    return r === c;
  }

  // Whether `root` is a project in a projects.v1 group (by path, else by
  // realpath). A missing or malformed value registers nothing.
  function isRegistered(root) {
    let registry;
    try {
      registry = readProjects();
    } catch {
      return false;
    }
    if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.groups)) return false;
    const want = normRoot(root);
    let wantReal;
    for (const g of registry.groups) {
      if (!isGroup(g)) continue;
      for (const p of g.projects) {
        if (!isProject(p)) continue;
        const have = normRoot(p.path);
        if (have === want) return true;
        if (wantReal === undefined) wantReal = realOr(want) ?? want;
        if ((realOr(have) ?? have) === wantReal) return true;
      }
    }
    return false;
  }

  // Whether Spotlight is on for a repo (D7; settings.js repoEnabledFrom):
  // never for ~/.claude; else its `enabled` setting; unset, on only for a
  // registered git repo with a server command. Facts are gathered lazily, so
  // an explicit setting never runs the server-command check. `settings`:
  // already-read settings, else settings.json is read.
  async function repoEnabled(root, settings = readSettings().settings) {
    const key = normRoot(root);
    const repo = repoSettings(settings, key);
    const facts = { harness: isHarnessRoot(key), registered: false, gitRepo: false, hasServerCommand: false };
    if (!facts.harness && typeof repo.enabled !== "boolean") {
      facts.registered = isRegistered(key);
      facts.gitRepo = facts.registered && isGitRepo(key);
      facts.hasServerCommand = facts.gitRepo && Boolean(await hasServerCommand(key, repo));
    }
    return repoEnabledFrom(repo, facts);
  }

  // When the mod last saved settings.json (ms), or 0 when it never did.
  function settingsSavedAt() {
    try {
      return fs.statSync(paths.settingsPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  return {
    paths,
    repoLockDir,
    readState,
    updateState,
    withRepoLock,
    reconcile,
    readSettings,
    settingsSavedAt,
    isHarnessRoot,
    isRegistered,
    repoEnabled,
  };
}
