// `spotlight`: Spotlight's engine for agents, the harness hook and the mod
// (D1). Node-only; the mod never imports it (it execs bin/spotlight).
//
//   on [--terminal t] [--timeout-ms N]   take the task's test turn (exit 0
//                                        holding, 1 still waiting, 2 usage)
//   off [--terminal t]                   give the turn back, nothing else
//   toggle --workspace p [--force]       a human's on/off, outside the queue
//   toggle --task KEY --group id         the whole task's, from its lane (D31)
//   status [--json]                      read-only, no lock, no reap
//   sync --repo r [--force] [--detach]   restart --repo r [--free-port]
//   logs [--repo r] [--lines N] [--path] peek --workspace p | --repo r
//   env --workspace p [--env e] [--variant v]   reap
//   env --task KEY --group id --env e    the task's env in every space, from its lane's pill (D32, D46)
//   continue [--terminal t] [--account id]  Continuar on a paused or idle agent (T11)
//   teardown --workspace p | --repo r    Spotlight off before projects-sidebar
//                                        deletes a workspace or removes a
//                                        project (its remove hooks, D43)
//   watch --ensure                       start the background watcher unless
//                                        it runs (D44: the footer copy's
//                                        start; `on` and every light call it
//                                        too)
//   internal: light --task k [--force], classify --terminal t,
//             watch (the watcher itself: auto-sync, the server and queue
//             checks every 3 s, the full reap every 30 s; watch.mjs),
//             continue --inline [--auto], env --task k --group id --inline,
//             sync --repo r --auto (auto-sync's and the reap's: an
//             automatic sync, which leaves an env that couldn't run, N4),
//             toggle --workspace p --note (projects-sidebar's click, the
//             badges' and the menu's: a refusal it answers at once is an
//             error toast and exit 0, D41)
//
// `restart --free-port` is the server popup's "Liberar puerto y arrancar"
// (D24): it stops the process the recorded port-busy error names, then
// starts the server. Only that click ever stops a process Spotlight didn't
// start, so USAGE and the agents' skill leave it out.
//
// The terminal is --terminal or $HC_TERMINAL_ID. Long work never runs in a
// caller Herdr can kill (D18): toggle, reap, `sync --detach`, `continue` and
// every grant hand off to a detached copy of this CLI and return at once.

import fs from "node:fs";
import path from "node:path";
import { resolveTask, taskKeyFrom, hasGroup } from "./task.js";
import { request, release, positionOf } from "./queue.js";
import { readRefs, assertDeactivatable, toSpotlightError } from "./sync.js";
import { envKeyOf, taskEnvKey, sameEnvKey, storedEnv } from "./task-env.js";
import { pidAlive, LockError } from "./locks.js";
import { normRoot } from "./settings.js";
import { isSafeVariant, isServerEnv, SERVER_ENVS } from "./server-plan.js";
import { serverTerminalName, serverLogs, showServer } from "./server.js";
import { logPathFor, logDir, repoSlug, formatClock } from "./server-log.js";
import {
  CLI_PATH, makeContext, terminalFacts, hcGet, repoRootOf, checkoutOf, branchOf, taskKeyOfWorkspace, registeredRoots,
  folderTask,
} from "./cli-env.mjs";
import { lightingMarker, needsLight, requestFgPid } from "./cli-turns.mjs";
import {
  formatOn, formatWaiting, formatOff, formatStatus, buildStatus, slotOnlyNote, labelOf, namedBlockers,
} from "./cli-format.mjs";
import {
  markGranted, spawnLights, dropStaleMarkers, lightTask, syncRepo, deactivateRepo, ensureServer, waitForTurnServers,
  recordServers, reap, rescuedNotes, errorNote, survivorsPhrase, writeEnv, applyEnv, rememberTaskVariant, teardownWorkspace, teardownRepo,
} from "./cli-work.mjs";
import { setRootError } from "./server-errors.js";
import { settleResumes, autoResume, continueTask, classifyTerminal } from "./cli-resume.mjs";
import { toggleTask } from "./cli-task.mjs";
import { ensureWatch, watchMain } from "./watch.mjs";

// Orca's: under an agent shell's 2-minute command cap; `on` is rerun to keep waiting.
export const DEFAULT_ON_TIMEOUT_MS = 100_000;
const MAX_ON_TIMEOUT_MS = 10 * 60_000;
// `logs` shows this many of the repo's notes before the server's tail.
const NOTES_SHOWN = 10;

export const USAGE = `spotlight: Spotlight and the test queue for Herdr.

Agents
  spotlight on [--terminal t] [--timeout-ms N]   take your task's test turn; waits in line
                                                 (exit 1 while still waiting: run it again)
  spotlight off [--terminal t]                   give the turn back (the servers keep running)
  spotlight status [--json]                      who tests, waits or is paused; each root's server and log
  spotlight logs [--repo r] [--lines N] [--path] the server's log as plain text (--path: the file)
  spotlight restart [--repo r]                   restart the repo's server

People and the mod
  spotlight toggle --workspace p [--force]       turn a workspace's Spotlight on or off, outside the queue
  spotlight toggle --task KEY --group id         turn a whole task's Spotlight on or off in that space
  spotlight sync --repo r [--force] [--detach]   bring the root in step with its holder
  spotlight peek --workspace p | --repo r        show the server's Spotlight tab (or peek at its terminal)
  spotlight env --workspace p [--env local|dev|prod] [--variant v]
  spotlight env --task KEY --group id --env local|dev|prod
                                                 the env of a whole task, in every space (kept after the turn-off)
  spotlight reap                                 turn ends, gone servers, idle times, grants
  spotlight continue [--terminal t] [--account id]
                                                 Continuar: resume a paused agent on the account with
                                                 limit left, or nudge an idle holder (Esc + message)
  spotlight teardown --workspace p | --repo r    turn Spotlight off before the workspace is deleted or the
                                                 project leaves the list (always exit 0)

The terminal is --terminal or $HC_TERMINAL_ID. A repo is a path or its name.`;

const FLAGS = {
  terminal: "string",
  "timeout-ms": "int",
  workspace: "string",
  force: "bool",
  json: "bool",
  repo: "string",
  detach: "bool",
  lines: "int",
  path: "bool",
  env: "string",
  variant: "string",
  task: "string",
  group: "string",
  account: "string",
  inline: "bool",
  note: "bool",
  auto: "bool",
  "free-port": "bool",
  ensure: "bool",
  help: "bool",
};

// argv → { verb, opts } or { error }. Options are --name value or --name=value.
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--")) return { verb, error: `unexpected argument "${a}"` };
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const type = FLAGS[name];
    if (!type) return { verb, error: `unknown option --${name}` };
    if (type === "bool") {
      if (eq !== -1) return { verb, error: `--${name} takes no value` };
      opts[name] = true;
      continue;
    }
    const value = eq !== -1 ? a.slice(eq + 1) : rest[(i += 1)];
    if (value === undefined) return { verb, error: `--${name} needs a value` };
    if (type === "int") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return { verb, error: `--${name} must be a positive whole number` };
      opts[name] = n;
    } else {
      opts[name] = value;
    }
  }
  return { verb, opts };
}

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);
const usage = (text) => {
  err(text);
  return 2;
};

const terminalOf = (opts) => (opts.terminal || process.env.HC_TERMINAL_ID || "").trim() || null;

// A repo given as a path (a root or any checkout of it) or as its name
// (projects.v1's, or the folder's, among the repos Spotlight knows: state,
// projects.v1 and settings, so a repo turned off and not in a space still
// answers, D28).
async function resolveRepo(cx, value) {
  if (!value) return null;
  if (value.includes("/")) return repoRootOf(path.resolve(value));
  const configured = Object.keys(cx.store.readSettings({ keepBackup: false }).settings.repos ?? {});
  const known = [...new Set([...Object.keys(cx.store.readState().repos), ...registeredRoots(cx.shared), ...configured])];
  return known.find((root) => cx.nameOf(root) === value) ?? known.find((root) => path.basename(root) === value) ?? null;
}

// D28: a name Spotlight no longer knows still finds its server's log, when
// exactly one log file carries that folder name (<slug>-<6 hex>.log; the
// slug of "/<name>" gives the same folder part repoSlug builds). Null when
// none or several match.
function logFileByName(value) {
  if (!value || value.includes("/")) return null;
  const base = repoSlug(`/${value}`).slice(0, -7);
  let names;
  try {
    names = fs.readdirSync(logDir());
  } catch {
    return null;
  }
  const matches = names.filter((n) => n.startsWith(`${base}-`) && /^-[0-9a-f]{6}\.log$/.test(n.slice(base.length)));
  return matches.length === 1 ? path.join(logDir(), matches[0]) : null;
}

// The repo root of --repo, else of the folder the CLI runs in.
const repoOrCwd = async (cx, opts) => (opts.repo ? resolveRepo(cx, opts.repo) : repoRootOf(process.cwd()));

// D15: Continuar's jobs settle before any turn end is decided (reap, on, off).
async function reapQueue(cx, opts) {
  await settleResumes(cx);
  return reap(cx, opts);
}

// ── on ─────────────────────────────────────────────────────────────────────

// Marks and spawns a `light` when the turn needs one (D12).
async function ensureLighting(cx, key, turn, { checkLit }) {
  const r = await cx.store.updateState((s) => {
    if (!needsLight(s.queue.lighting[key], turn, { now: cx.now(), pidAlive, repos: s.repos, checkLit })) return false;
    s.queue.lighting[key] = lightingMarker(turn, { now: cx.now(), taskKey: key });
    return true;
  });
  if (r.result) await spawnLights(cx, [key]);
}

async function verbOn(cx, opts) {
  const terminal = terminalOf(opts);
  if (!terminal) return usage("spotlight on: no terminal. Run it in a Herdr terminal ($HC_TERMINAL_ID) or pass --terminal <t>.");
  const deadline = cx.now() + Math.min(opts["timeout-ms"] ?? DEFAULT_ON_TIMEOUT_MS, MAX_ON_TIMEOUT_MS);
  const terminals = await terminalFacts();
  let task = await resolveTask({
    cwd: process.cwd(), shared: cx.shared, git: cx.taskGit, enabled: (root) => cx.store.repoEnabled(root, cx.settings), terminals,
  });
  // J-003: a terminal outside every task (a main checkout, a folder outside
  // git) still gets a test turn, slot-only, keyed by its folder.
  if (!task.ok) task = await folderTask(process.cwd(), cx.shared);
  const key = `${task.lane}/${task.taskKey}`;
  const me = (await hcGet(terminal)).terminal ?? null;
  // D13: every `on` re-baselines the turn count and ends Continuar's window.
  // J-004: typed in a plain shell, the foreground is this CLI: the shell's pid is recorded.
  const ask = {
    terminal, taskKey: key, label: task.label, lane: task.lane, members: task.members, skipped: task.skipped,
    slotOnly: task.slotOnly, root: task.root, workspace: task.workspace,
    requestTurn: Number.isInteger(me?.turn) ? me.turn : null,
    fgPid: requestFgPid(me, { pid: process.pid, ppid: process.ppid, cliPath: CLI_PATH }),
    statusMs: me?.status_ms ?? null, resumingUntil: null, lastActivityAt: cx.now(),
  };
  const askQueue = async () => {
    const settings = cx.reloadSettings();
    const r = await cx.store.updateState((s) => {
      const o = request(s.queue, ask, { now: cx.now(), ...settings.queue });
      s.queue = o.queue;
      return { position: o.position, skipped: o.skipped.map((m) => m.name ?? cx.nameOf(m.root)), keys: markGranted(s, o.granted, cx.now()) };
    });
    await spawnLights(cx, r.result.keys);
    return r.result;
  };

  // D13: turn ends are checked by `on` too, so a finished holder never blocks the line.
  await reapQueue(cx, { full: false, skip: terminal });
  let asked = await askQueue();
  // D44: the watcher reaps this request's turn end and syncs its lit repos
  // in any layout, the footer shown or not.
  await ensureWatcher(cx);
  const skipped = [...task.skipped, ...asked.skipped];
  let turn = null;
  for (;;) {
    if (asked.position.kind === "off") {
      turn = { taskKey: key, grantedAt: "off", members: task.members, slotOnly: task.slotOnly };
      break;
    }
    const settings = cx.reloadSettings();
    const state = cx.store.readState();
    const pos = positionOf(state.queue, terminal, { now: cx.now(), ...settings.queue });
    if (pos?.kind === "holding") {
      turn = pos.turn;
      break;
    }
    // Our place is gone (a turn end released it) or the queue was switched off: ask again.
    if (!pos || !settings.queue.enabled) {
      asked = await askQueue();
      continue;
    }
    if (cx.now() >= deadline) {
      out(formatWaiting({ label: task.label, position: pos.position, blockers: namedBlockers(pos.blockers, state.queue.requests, cx.nameOf) }));
      return 1;
    }
    await cx.sleep(Math.min(cx.pollMs, deadline - cx.now()));
    await reapQueue(cx, { full: false, skip: terminal });
  }

  if (turn.slotOnly || turn.members.length === 0) {
    out(formatOn({ label: task.label, skipped, ready: true, note: slotOnlyNote(task.label) }));
    return 0;
  }

  // Orca lights on every call; the engine's no-op path makes it cheap.
  await ensureLighting(cx, key, turn, { checkLit: true });
  for (;;) {
    const m = cx.store.readState().queue.lighting[key];
    if (m && (m.phase === "done" || m.phase === "error")) break;
    if (cx.now() >= deadline) break;
    await cx.sleep(Math.min(cx.pollMs, Math.max(0, deadline - cx.now())));
    // A light killed mid-way: light again.
    await ensureLighting(cx, key, turn, { checkLit: false });
  }

  // D1: the root is the caller's tree when `on` returns, auto-sync or not.
  // J-001: never past the deadline: the repo lock is waited on for the time
  // left (one try once it passed); a root whose lock a light still holds is
  // skipped, and the next `on` syncs it.
  const syncErrors = {};
  const stillLit = new Set();
  for (const m of turn.members) {
    try {
      const r = await syncRepo(cx, m.root, {
        onlyIf: (rec) => (m.workspaces ?? [m.workspace]).includes(rec.holder),
        lockTimeoutMs: Math.max(0, deadline - cx.now()),
      });
      if (!r.ok && r.code !== "not-active") syncErrors[m.root] = r.message;
    } catch (e) {
      if (e instanceof LockError && e.code === "lock-timeout") stillLit.add(m.root);
      else syncErrors[m.root] = toSpotlightError(e).message;
    }
  }
  const waited = await waitForTurnServers(cx, { members: turn.members, key, deadline, syncErrors });
  const servers = waited.servers.map((s) => (stillLit.has(s.root) ? { ...s, stillLit: true } : s));
  await recordServers(cx, servers);
  out(formatOn({ label: task.label, servers, skipped, ready: waited.ready }));
  return 0;
}

// ── off ────────────────────────────────────────────────────────────────────

async function verbOff(cx, opts) {
  const terminal = terminalOf(opts);
  if (!terminal) return usage("spotlight off: no terminal. Run it in a Herdr terminal ($HC_TERMINAL_ID) or pass --terminal <t>.");
  const settings = cx.settings;
  const r = await cx.store.updateState((s) => {
    const mine = s.queue.requests.find((x) => x.terminal === terminal);
    const label = mine ? labelOf(s.queue.requests, mine.taskKey) : null;
    const o = release(s.queue, terminal, { now: cx.now(), ...settings.queue });
    s.queue = o.queue;
    const keys = markGranted(s, o.granted, cx.now());
    dropStaleMarkers(s, cx.now());
    return {
      released: o.releasedTaskKey ? label : null,
      wasWaiting: o.wasWaiting,
      next: o.granted.map((t) => labelOf(s.queue.requests, t.taskKey)),
      keys,
    };
  });
  await spawnLights(cx, r.result.keys);
  // D13: `off` checks the others' turn ends too.
  await reapQueue(cx, { full: false, skip: terminal });
  out(formatOff(r.result));
  return 0;
}

// ── toggle ─────────────────────────────────────────────────────────────────

async function verbToggle(cx, opts) {
  if (opts.task !== undefined || opts.group !== undefined) return verbToggleTask(cx, opts);
  if (!opts.workspace) return usage("spotlight toggle: --workspace <path> is required.");
  const dir = path.resolve(opts.workspace);
  const workspace = await checkoutOf(dir);
  const root = workspace ? await repoRootOf(workspace) : null;
  if (!root) return usage(`spotlight toggle: ${dir} is not in a git repository.`);
  const name = cx.nameOf(root);
  const force = Boolean(opts.force);
  const record = cx.store.readState().repos[root] ?? null;
  const refs = await readRefs(root);
  const lit = refs.active || Boolean(refs.originalHeadSha);
  // Off from the holder's row, the root's own row, or refs nobody holds (orphan-refs).
  const turnOff = lit && (workspace === root || !record?.holder || record.holder === workspace);

  if (turnOff) {
    if (opts.inline) {
      const r = await deactivateRepo(cx, root, { force });
      if (!r.ok) {
        // A refusal (the root untouched), or server-survived /
        // server-not-stopped (the root was restored, and what the turn-off
        // did with files in its way still applies).
        err(`${r.code}: ${r.message}`);
        for (const line of rescuedNotes(r.rescued, r.discardedRepos)) out(line);
        return 1;
      }
      out(`Spotlight off in ${name}: root restored.${r.warning ? ` ${r.warning.message}` : ""}`);
      for (const line of rescuedNotes(r.rescued, r.discardedRepos)) out(line);
      return 0;
    }
    try {
      // Read-only, so a refusal answers here instead of landing in a detached run.
      await assertDeactivatable(cx.gitCtx, root, { force });
    } catch (e) {
      const error = toSpotlightError(e);
      const forceable = !force && (error.code === "root-diverged" || error.code === "untracked-collision");
      const hint = forceable
        ? ` Para apagarlo igual: \`spotlight toggle --workspace ${workspace} --force\` (Apagar igual).`
        : "";
      // The popup offers Apagar igual from the record's error; orca-holds is
      // recorded too, so the popup says why at once instead of after a reap
      // (D27), over a server error the record has, which still applies (R8,
      // F6). A refused click on orca-holds also answers with a toast (T1),
      // with no popup action: no force path takes a root from Orca, as with
      // orca-active. D41: a click (`--note`: projects-sidebar's badge or
      // menu, whose own exec-failure toast would say it again) answers every
      // refusal with a turn-off's error toast, opening the popup where it
      // can act (Apagar igual), and exits 0; the popup's Apagar, the
      // settings' --inline and agents keep exit 1 and stderr.
      const recorded = forceable || error.code === "orca-holds";
      const noted = opts.note || error.code === "orca-holds";
      if (recorded || noted) {
        const now = cx.now();
        await cx.store.updateState((s) => {
          if (recorded && s.repos[root]) setRootError(s.repos[root], { ...error, at: now });
          if (noted) errorNote(s, { root, name, workspace, error, now, op: "off" });
        });
      }
      err(`${error.code}: ${error.message}${hint}`);
      return opts.note ? 0 : 1;
    }
    cx.spawn(["toggle", "--workspace", workspace, "--inline", ...(force ? ["--force"] : [])]);
    out(`Turning Spotlight off in ${name}: the root goes back to how it was and its server stops.`);
    return 0;
  }

  if (workspace === root) return usage("root-is-holder: the repository root cannot hold the Spotlight: it is the sync target.");
  if (!(await cx.store.repoEnabled(root, cx.settings))) {
    const error = { code: "not-enabled", message: `Spotlight is off for ${name}. Turn it on in Spotlight's settings first.` };
    // D41: a click (`--note`) answers with a light's error toast and exit 0;
    // anyone else keeps exit 2 (a usage error) and stderr.
    if (opts.note) {
      const now = cx.now();
      await cx.store.updateState((s) => errorNote(s, { root, name, workspace, error, now, op: "light" }));
    }
    err(`${error.code}: ${error.message}`);
    return opts.note ? 0 : 2;
  }
  const key = `direct/${root}`;
  const taskKey = await taskKeyOfWorkspace(workspace, root, cx.shared);
  const now = cx.now();
  const members = [{ root, name, workspace, workspaces: [workspace] }];
  await cx.store.updateState((s) => {
    s.queue.lighting[key] = lightingMarker({ grantedAt: now, members }, { now, taskKey, force });
  });
  if (opts.inline) {
    const r = await lightTask(cx, key, { force });
    const failed = r.errors[root];
    if (failed) err(failed);
    else out(`Spotlight on: ${path.basename(workspace)} onto ${name}.`);
    // D44: a lit root is watched, whoever lit it.
    if (!failed) await ensureWatcher(cx);
    return failed ? 1 : 0;
  }
  await spawnLights(cx, [key]);
  out(`Turning Spotlight on: ${path.basename(workspace)} onto ${name}. \`spotlight status\` shows when it is lit.`);
  return 0;
}

// `toggle --task <KEY> --group <id>` (D31): the lane's flashlight. Detached
// unless --inline (D18): a batch lights or turns off a repo after another,
// and a click's exec dies at 30 s. The detached call checks only what needs
// no git (the key, the group), so it answers at once.
async function verbToggleTask(cx, opts) {
  if (!opts.task || !opts.group) return usage("spotlight toggle: --task <KEY> and --group <id> go together (the lane and its space).");
  if (opts.workspace || opts.force) return usage("spotlight toggle: --task takes no --workspace or --force.");
  const task = taskKeyFrom(opts.task);
  if (!task) return usage(`spotlight toggle: "${opts.task}" can't name a task.`);
  if (!hasGroup(cx.shared["projects.v1"], opts.group)) return usage(`spotlight toggle: no group "${opts.group}" in projects-sidebar's spaces.`);
  if (!opts.inline) {
    cx.spawn(["toggle", "--task", task, "--group", opts.group, "--inline"]);
    out(`Toggling Spotlight for ${task} in ${opts.group}. \`spotlight status\` shows when it is done.`);
    return 0;
  }
  const r = await toggleTask(cx, { group: opts.group, task, terminals: await terminalFacts() });
  // D44: the task's lit roots are watched.
  if (r.op === "on" && r.ok) await ensureWatcher(cx);
  if (r.code === "no-group" || r.code === "no-task") return usage(`spotlight toggle: ${r.message}`);
  if (r.code) {
    err(`${r.code}: ${r.message}`);
    return 1;
  }
  for (const [root, message] of Object.entries(r.errors)) err(`${cx.nameOf(root)}: ${message}`);
  if (r.skipped.length > 0) out(`Not included: ${r.skipped.join(", ")}.`);
  if (r.summary) out(r.summary);
  return r.ok ? 0 : 1;
}

// ── status ─────────────────────────────────────────────────────────────────

// Read-only and lock-free (the hook kills it at 10 s): no reap, no grant,
// no settings backup.
async function verbStatus(cx, opts) {
  const { settings } = cx.store.readSettings({ keepBackup: false });
  const state = cx.store.readState();
  const result = buildStatus({ state, settings, terminal: terminalOf(opts), now: cx.now(), nameOf: cx.nameOf });
  out(opts.json ? JSON.stringify({ ok: true, result }, null, 2) : formatStatus(result, cx.now()));
  return 0;
}

// ── sync, restart, logs, peek, env ─────────────────────────────────────────

// `spotlight sync`. Typed by hand, or Forzar sync, it is a new ask: it
// tries an env that couldn't run again, as Reiniciar (N4); `--auto` marks
// auto-sync's (watch-filter.js syncArgv, carried to its detached copy) and
// the reap's, which leave it until settings are saved (M1).
async function verbSync(cx, opts) {
  const root = await resolveRepo(cx, opts.repo);
  if (!root) return usage(`spotlight sync: --repo <path or name> is required${opts.repo ? ` (no repo "${opts.repo}")` : ""}.`);
  if (opts.detach) {
    cx.spawn(["sync", "--repo", root, ...(opts.force ? ["--force"] : []), ...(opts.auto ? ["--auto"] : [])]);
    out(`Syncing ${cx.nameOf(root)}.`);
    return 0;
  }
  const r = await syncRepo(cx, root, { force: Boolean(opts.force), asked: !opts.auto });
  if (!r.ok) {
    err(`${r.code}: ${r.message}`);
    return 1;
  }
  const holder = path.basename(r.holder);
  const why = r.installs?.length > 0 ? " A lockfile changed: the server restarted with the install first." : " The server restarted in its new env.";
  const restarted = r.restarted ? why : r.restartFailed ? ` The server did not restart (${r.restartFailed}).` : "";
  if (r.skipped) out(`Nothing to sync: ${cx.nameOf(root)}'s root already has ${holder}'s files.${restarted}`);
  else out(`Synced ${holder} onto ${cx.nameOf(root)}.${restarted}`);
  return 0;
}

async function verbRestart(cx, opts) {
  const root = await repoOrCwd(cx, opts);
  if (!root) return usage("spotlight restart: --repo <path or name>, or run it inside the repo.");
  const r = await cx.store.withRepoLock(root, async () => {
    const record = cx.store.readState().repos[root];
    if (!record?.holder) return null;
    return ensureServer(cx, root, {
      workspace: record.holder, branch: await branchOf(record.holder), keepVariant: true, restart: true, freePort: Boolean(opts["free-port"]),
    });
  });
  if (!r) {
    err(`not-active: Spotlight is not on in ${cx.nameOf(root)}.`);
    return 1;
  }
  if (r.state === "port-busy") {
    err(portBusyLine(r));
    return 1;
  }
  if (r.state === "started") out(`Restarted ${cx.nameOf(root)}'s server: ${r.plan.command}`);
  else if (r.state === "still-running") {
    // The old server ignored the Ctrl-C, or never got it: no start failed (M3).
    err(`${cx.nameOf(root)}: the server did not restart: the old one still runs (${r.result?.reason}).`);
    return 1;
  } else if (r.state === "needs-variant") out(`${cx.nameOf(root)}: needs a variant: pick it in the server popup (spotlight env --variant <v>).`);
  else if (r.state === "none") out(`${cx.nameOf(root)} has no server command for this env.`);
  else {
    err(`${cx.nameOf(root)}: the server did not restart (${r.result?.reason ?? r.state}).`);
    return 1;
  }
  return 0;
}

// A start refused over a busy port (D24), and why a --free-port didn't free
// it: the holder's tree holds Herdr or the server's shell (ports.js
// stopProcessTree "protected"), or some of it lived through SIGKILL
// ("survived": stuck in the kernel, or not ours to signal).
export function portBusyLine(r) {
  let kept = "";
  if (r.freed?.ok === false && r.freed.reason === "survived") {
    const who = survivorsPhrase(r.freed.survivors);
    kept = ` ${who[0].toUpperCase()}${who.slice(1)} después de SIGKILL: Spotlight no pudo liberar el puerto.`;
  } else if (r.freed?.ok === false) {
    kept = " Spotlight no lo paró: de ese proceso dependen Herdr o el server.";
  }
  return `${r.error.code}: ${r.error.message}${kept}`;
}

async function verbLogs(cx, opts) {
  const root = await repoOrCwd(cx, opts);
  const state = cx.store.readState();
  const record = root ? (state.repos[root] ?? null) : null;
  const logPath = root ? (record?.logPath ?? logPathFor(root)) : logFileByName(opts.repo);
  if (!logPath) return usage("spotlight logs: --repo <path or name>, or run it inside the repo.");
  if (opts.path) {
    out(logPath);
    return 0;
  }
  // D11: the CLI's notes first, then the server's own output.
  const notes = root ? state.notes.filter((n) => n.repo === root).slice(-NOTES_SHOWN) : [];
  if (notes.length > 0) {
    out("Spotlight notes:");
    for (const n of notes) out(`  ${formatClock(n.at)}  ${n.text}`);
    out("");
  }
  const r = await serverLogs({ logPath, terminal: record?.serverTerminal ?? null, lines: opts.lines }, cx.serverDeps);
  if (r.source === null) out(`No server log yet for ${root ? cx.nameOf(root) : opts.repo} (${logPath}).`);
  else process.stdout.write(r.text);
  return 0;
}

async function workspaceRoot(opts) {
  const workspace = await checkoutOf(path.resolve(opts.workspace));
  return workspace ? { workspace, root: await repoRootOf(workspace) } : { workspace: null, root: null };
}

// "Ver server" (D38): shows the server's Spotlight tab (its space, then the
// tab); Herdr's peek for a server terminal in no tab.
async function verbPeek(cx, opts) {
  const root = opts.workspace ? (await workspaceRoot(opts)).root : await repoOrCwd(cx, opts);
  if (!root) return usage("spotlight peek: --workspace <path> or --repo <path or name>.");
  const terminal = cx.store.readState().repos[root]?.serverTerminal ?? serverTerminalName(root);
  const r = await showServer(terminal, cx.serverDeps);
  if (!r.ok) {
    err(`spotlight peek: ${r.message}`);
    return 1;
  }
  return 0;
}

// `env --workspace p` (the server popup, D32): the pick is stored under the
// workspace's key (its task's task:<KEY>, the same in every space, D46; else
// ws:<path>), for every repo of that task, and survives the turn-off. It
// reaches a running server
// only when this repo's holder has that key (record.envKey: the workspace
// holds it, or another workspace of its task does); a workspace that doesn't
// hold the root just stores it. A variant is remembered for the workspace's
// task in this repo (task:<KEY>::<root>, D46) and applies to it only while
// it holds the root: picked for a
// workspace another one took the root from (a popup or prompt answered
// late), it starts nothing and exits 1, "ya no tiene el root" (D36, Orca's
// chooseSpotlightVariant). On a root nobody holds it is only remembered.
async function verbEnv(cx, opts) {
  if (opts.task !== undefined || opts.group !== undefined) return verbEnvTask(cx, opts);
  if (opts.inline) return usage("spotlight env: --inline goes with --task and --group.");
  if (opts.variant !== undefined && !isSafeVariant(opts.variant)) {
    return usage(`spotlight env: invalid variant "${opts.variant}": only letters, digits, "_" and "-" (at most 64).`);
  }
  if (opts.env !== undefined && !isServerEnv(opts.env)) return usage(`spotlight env: --env is one of ${SERVER_ENVS.join(", ")}.`);
  if (!opts.workspace || (opts.env === undefined && opts.variant === undefined)) {
    return usage("spotlight env: --workspace <path> and --env <env> and/or --variant <v>.");
  }
  const { workspace, root } = await workspaceRoot(opts);
  if (!root) return usage(`spotlight env: ${opts.workspace} is not in a git repository.`);
  const taskKey = await taskKeyOfWorkspace(workspace, root, cx.shared);
  const key = envKeyOf(taskKey, workspace);
  const r = await cx.store.withRepoLock(root, async () => {
    if (opts.variant && taskKey) {
      await cx.store.updateState((s) => {
        rememberTaskVariant(s, taskKey, root, opts.variant);
      });
    }
    if (opts.env) await writeEnv(cx, key, opts.env);
    const record = cx.store.readState().repos[root];
    if (!record?.holder) return { state: "stored" };
    if (opts.variant !== undefined && record.holder !== workspace) return { state: "lost-root", holder: record.holder };
    // The pick is this holder's only when it holds W's key (D32), one
    // written before D46 for the same task too.
    const envHere = opts.env !== undefined && sameEnvKey(record.envKey, key);
    if (!envHere && opts.variant === undefined) return { state: "stored" };
    // An env restarts only a server whose command changes; a variant, one
    // whose command or env changes (D22).
    return ensureServer(cx, root, {
      workspace: record.holder,
      branch: await branchOf(record.holder),
      taskKey: record.holder === workspace ? taskKey : await taskKeyOfWorkspace(record.holder, root, cx.shared),
      envName: envHere ? opts.env : undefined,
      chosenVariant: opts.variant,
      keepVariant: opts.variant === undefined,
    });
  });
  if (r.state === "lost-root") {
    const env = opts.env ? ` (el env ${opts.env} sí quedó guardado)` : "";
    err(
      `spotlight env: ${path.basename(workspace)} ya no tiene el root de ${cx.nameOf(root)} (lo tiene ${path.basename(r.holder)}): ` +
        `la variante ${opts.variant} no arrancó nada${env}.`,
    );
    return 1;
  }
  const what = [opts.env && `env ${opts.env}`, opts.variant && `variant ${opts.variant}`].filter(Boolean).join(", ");
  return reportEnv(cx, root, what, r);
}

// An env or variant pick's line for one repo (ensureServer's answer, or
// { state: "stored" }): 0, or 1 when its server didn't start.
function reportEnv(cx, root, what, r) {
  if (r.state === "started") out(`${cx.nameOf(root)}: ${what}; the server restarted: ${r.plan.command}`);
  else if (r.state === "port-busy") {
    err(`${cx.nameOf(root)}: ${what} saved; the server did not start. ${portBusyLine(r)}`);
    return 1;
  } else if (r.state === "still-running") {
    // The old server ignored the Ctrl-C, or never got it, and still runs in
    // the env of before: no start failed (M3).
    err(`${cx.nameOf(root)}: ${what} saved; the server did not restart: the old one still runs (${r.result?.reason}).`);
    return 1;
  } else if (r.state === "failed") {
    err(`${cx.nameOf(root)}: ${what} saved; the server did not start (${r.result?.reason}).`);
    return 1;
  } else out(`${cx.nameOf(root)}: ${what} saved.`);
  return 0;
}

// `env --task <KEY> --group <id> --env <e>` (D32): the lane's env pill. The
// pick is stored under task:<KEY> before it answers (writeEnv): D46, the
// task in every space, as Orca's; `--group` names the lane it was picked on.
// The lit repos the task holds, in any space, run it after, in a detached
// `--inline` copy (D18), which restarts only the servers whose command
// changes (applyEnv).
// That copy gets no --env: it runs what is stored when it gets there, so
// two picks in a row end in the last one. The detached call checks only
// what needs no git, so it answers at once.
async function verbEnvTask(cx, opts) {
  if (!opts.task || !opts.group) return usage("spotlight env: --task <KEY> and --group <id> go together (the lane and its space).");
  if (opts.workspace !== undefined || opts.variant !== undefined) return usage("spotlight env: --task takes no --workspace or --variant.");
  if (opts.env !== undefined && !isServerEnv(opts.env)) return usage(`spotlight env: --env is one of ${SERVER_ENVS.join(", ")}.`);
  if (opts.env === undefined && !opts.inline) return usage("spotlight env: --task needs --env <env>.");
  const task = taskKeyFrom(opts.task);
  if (!task) return usage(`spotlight env: "${opts.task}" can't name a task.`);
  if (!hasGroup(cx.shared["projects.v1"], opts.group)) return usage(`spotlight env: no group "${opts.group}" in projects-sidebar's spaces.`);
  const key = taskEnvKey(task);
  if (opts.env !== undefined) await writeEnv(cx, key, opts.env);
  if (!opts.inline) {
    cx.spawn(["env", "--task", task, "--group", opts.group, "--inline"]);
    out(`Env ${opts.env} saved for ${task} in every space; its lit repos switch in the background. \`spotlight status\` shows when it is done.`);
    return 0;
  }
  const results = await applyEnv(cx, key);
  if (Object.keys(results).length === 0) {
    out(`${task}: env ${storedEnv(cx.store.readState().envs, key) ?? "of each repo's settings"} saved; none of its repos is lit.`);
    return 0;
  }
  let code = 0;
  for (const [root, r] of Object.entries(results)) {
    if (r.error) {
      err(`${cx.nameOf(root)}: ${r.error.code}: ${r.error.message}`);
      code = 1;
    } else if (reportEnv(cx, root, `env ${r.env}`, r.server) !== 0) code = 1;
  }
  return code;
}

// ── teardown ───────────────────────────────────────────────────────────────

// `spotlight teardown --workspace <W> | --repo <root>` (D43): projects-sidebar
// runs it before it deletes a workspace or removes a project (Spotlight's
// remove hooks, menus-model.js removeHooksOf), as Orca turns Spotlight off
// before it removes a worktree or a repo. It prints what it did and always
// exits 0, even refused, given up waiting or failing: a delete is never
// blocked by Spotlight. A usage error alone exits 2. The work is
// cli-work.mjs teardownWorkspace and teardownRepo.
async function verbTeardown(cx, opts) {
  if (Boolean(opts.workspace) === Boolean(opts.repo)) {
    return usage("spotlight teardown: --workspace <path> or --repo <path>, one of them.");
  }
  try {
    const lines = opts.workspace
      ? await teardownWorkspace(cx, pathForms(opts.workspace))
      : await teardownRepo(cx, await projectRoot(opts.repo));
    for (const line of lines) out(line);
  } catch (e) {
    out(`spotlight teardown: ${e?.message ?? e}`);
  }
  return 0;
}

// A workspace path as given (absolute, no trailing slash), then its realpath
// when that differs: holders are what git printed, the folder may still be
// reached through a link. No git: the folder is about to go.
function pathForms(value) {
  const given = normRoot(path.resolve(value));
  try {
    return [...new Set([given, normRoot(fs.realpathSync(given))])];
  } catch {
    return [given];
  }
}

// A project's root: the main checkout git names for it, or the path as given
// when git can't (a folder gone already).
async function projectRoot(value) {
  const given = normRoot(path.resolve(value));
  return (await repoRootOf(given)) ?? given;
}

// ── reap, light, continue, classify ────────────────────────────────────────

// Settles Continuar's jobs, reaps, then starts auto-resume (D13, D15).
async function verbReap(cx) {
  const { settled } = await settleResumes(cx);
  const r = await reap(cx);
  const resumed = await autoResume(cx);
  out(
    `reaped: ${r.released} released, ${r.paused} paused, ${r.classify} to classify, ${r.lights} to light, ` +
      `${r.reconciled} reconciled, ${settled} resumes settled, ${resumed} auto-resumed`,
  );
  return 0;
}

async function verbLight(cx, opts) {
  if (!opts.task) return usage("spotlight light: --task <key> is required.");
  // D44: before the light, so `on` never returns ahead of it; its marker,
  // at work until the holder is written, keeps a new watcher from leaving.
  await ensureWatcher(cx);
  const r = await lightTask(cx, opts.task, { force: Boolean(opts.force) });
  if (!r.ran) out(`Nothing to light for ${opts.task}.`);
  for (const [root, message] of Object.entries(r.errors)) err(`${cx.nameOf(root)}: ${message}`);
  return 0;
}

// Continuar (D15): returns at once and hands the work to a detached
// `--inline` copy; the board, the reap's auto-resume and agents call it.
async function verbContinue(cx, opts) {
  const terminal = terminalOf(opts);
  if (!terminal) return usage("spotlight continue: no terminal. Run it in a Herdr terminal ($HC_TERMINAL_ID) or pass --terminal <t>.");
  const r = await continueTask(cx, { terminal, inline: Boolean(opts.inline), auto: Boolean(opts.auto), account: opts.account ?? null });
  if (r.text) out(r.text);
  if (r.error) err(r.error);
  return r.code;
}

// A turn end whose usage was stale, decided with a fresh read (D13;
// detached by the reap).
async function verbClassify(cx, opts) {
  const terminal = terminalOf(opts);
  if (!terminal) return usage("spotlight classify: --terminal <t> is required.");
  const d = await classifyTerminal(cx, terminal);
  if (d.action === "none") out(`Nothing to classify for ${terminal}.`);
  else out(`${terminal}: ${d.action}${d.reason ? ` (${d.reason})` : ""}.`);
  return 0;
}

// ── watch ──────────────────────────────────────────────────────────────────

// D44: `--ensure` starts the watcher unless one of this build runs (and
// replaces another build's); bare, it is the watcher (watch.mjs watchMain),
// which hc runs in its hidden terminal.
async function verbWatch(cx, opts) {
  if (!opts.ensure) {
    const r = await watchMain(cx);
    out(r.reason === "another" ? "spotlight watch: another watcher runs." : `spotlight watch: stopped (${r.reason}).`);
    return 0;
  }
  const r = await ensureWatch(cx);
  if (r.action === "failed") {
    err(`spotlight watch: couldn't start the watcher: ${r.message}`);
    return 1;
  }
  const said = {
    running: `running in ${r.terminal}`,
    started: `started in ${r.terminal}`,
    replaced: `replaced ${r.replaced}: started in ${r.terminal}`,
    unknown: `hc can't say whether ${r.terminal} still runs it: left as it is`,
  };
  out(`spotlight watch: ${said[r.action] ?? r.action}.`);
  return 0;
}

// `on`'s and the lights' ensure: never in their way. A failure is said on
// stderr and the verb goes on.
async function ensureWatcher(cx) {
  try {
    const r = await ensureWatch(cx);
    if (r.action === "failed") err(`spotlight: the watcher didn't start: ${r.message}`);
  } catch (e) {
    err(`spotlight: the watcher didn't start: ${e?.message ?? e}`);
  }
}

const VERBS = {
  on: verbOn,
  off: verbOff,
  toggle: verbToggle,
  status: verbStatus,
  sync: verbSync,
  restart: verbRestart,
  logs: verbLogs,
  peek: verbPeek,
  env: verbEnv,
  reap: verbReap,
  light: verbLight,
  continue: verbContinue,
  classify: verbClassify,
  teardown: verbTeardown,
  watch: verbWatch,
};

export async function main(argv) {
  if (argv.length === 0) return usage(USAGE);
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    out(USAGE);
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.error) return usage(`spotlight ${parsed.verb}: ${parsed.error}\n\n${USAGE}`);
  if (parsed.opts.help) {
    out(USAGE);
    return 0;
  }
  const run = VERBS[parsed.verb];
  if (!run) return usage(`spotlight: unknown command "${parsed.verb}"\n\n${USAGE}`);
  return run(makeContext(), parsed.opts);
}

// Run when executed (bin/spotlight execs this file), not when imported.
const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(CLI_PATH);
  } catch {
    return false;
  }
})();
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      err(`spotlight: ${e?.message ?? e}`);
      process.exitCode = 1;
    },
  );
}
