// `spotlight`: Spotlight's engine for agents, the harness hook and the mod
// (D1). Node-only; the mod never imports it (it execs bin/spotlight).
//
//   on [--terminal t] [--timeout-ms N]   take the task's test turn (exit 0
//                                        holding, 1 still waiting, 2 usage)
//   off [--terminal t]                   give the turn back, nothing else
//   toggle --workspace p [--force]       a human's on/off, outside the queue
//   status [--json]                      read-only, no lock, no reap
//   sync --repo r [--force] [--detach]   restart --repo r
//   logs [--repo r] [--lines N] [--path] peek --workspace p | --repo r
//   env --workspace p [--env e] [--variant v]   reap
//   continue [--terminal t] [--account id]  Continuar on a paused or idle agent (T11)
//   internal: light --task k [--force], classify --terminal t,
//             continue --inline [--auto]
//
// The terminal is --terminal or $HC_TERMINAL_ID. Long work never runs in a
// caller Herdr can kill (D18): toggle, reap, `sync --detach`, `continue` and
// every grant hand off to a detached copy of this CLI and return at once.

import fs from "node:fs";
import path from "node:path";
import { resolveTask } from "./task.js";
import { request, release, positionOf } from "./queue.js";
import { readRefs, assertDeactivatable, toSpotlightError } from "./sync.js";
import { emptyRepo, rememberVariant } from "./store.js";
import { pidAlive, LockError } from "./locks.js";
import { normRoot } from "./settings.js";
import { isSafeVariant, isServerEnv, SERVER_ENVS } from "./server-plan.js";
import { serverTerminalName, serverLogs, peekServer } from "./server.js";
import { logPathFor, formatClock } from "./server-log.js";
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
  recordServers, reap,
} from "./cli-work.mjs";
import { settleResumes, autoResume, continueTask, classifyTerminal } from "./cli-resume.mjs";

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
  spotlight sync --repo r [--force] [--detach]   bring the root in step with its holder
  spotlight peek --workspace p | --repo r        look at the server's terminal
  spotlight env --workspace p [--env local|dev|prod] [--variant v]
  spotlight reap                                 turn ends, gone servers, idle times, grants
  spotlight continue [--terminal t] [--account id]
                                                 Continuar: resume a paused agent on the account with
                                                 limit left, or nudge an idle holder (Esc + message)

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
  account: "string",
  inline: "bool",
  auto: "bool",
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
// (projects.v1's, or the folder's, among the repos Spotlight knows).
async function resolveRepo(cx, value) {
  if (!value) return null;
  if (value.includes("/")) return repoRootOf(path.resolve(value));
  const known = [...new Set([...Object.keys(cx.store.readState().repos), ...registeredRoots(cx.shared)])];
  return known.find((root) => cx.nameOf(root) === value) ?? known.find((root) => path.basename(root) === value) ?? null;
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
        err(`${r.code}: ${r.message}`);
        return 1;
      }
      out(`Spotlight off in ${name}: root restored.${r.warning ? ` ${r.warning.message}` : ""}`);
      return 0;
    }
    try {
      // Read-only, so a refusal answers here instead of landing in a detached run.
      await assertDeactivatable(cx.gitCtx, root, { force });
    } catch (e) {
      const error = toSpotlightError(e);
      const hint = !force && (error.code === "root-diverged" || error.code === "untracked-collision")
        ? ` Para apagarlo igual: \`spotlight toggle --workspace ${workspace} --force\` (Apagar igual).`
        : "";
      err(`${error.code}: ${error.message}${hint}`);
      return 1;
    }
    cx.spawn(["toggle", "--workspace", workspace, "--inline", ...(force ? ["--force"] : [])]);
    out(`Turning Spotlight off in ${name}: the root goes back to how it was and its server stops.`);
    return 0;
  }

  if (workspace === root) return usage("root-is-holder: the repository root cannot hold the Spotlight: it is the sync target.");
  if (!(await cx.store.repoEnabled(root, cx.settings))) {
    err(`not-enabled: Spotlight is off for ${name}. Turn it on in Spotlight's settings first.`);
    return 2;
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
    return failed ? 1 : 0;
  }
  await spawnLights(cx, [key]);
  out(`Turning Spotlight on: ${path.basename(workspace)} onto ${name}. \`spotlight status\` shows when it is lit.`);
  return 0;
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

async function verbSync(cx, opts) {
  const root = await resolveRepo(cx, opts.repo);
  if (!root) return usage(`spotlight sync: --repo <path or name> is required${opts.repo ? ` (no repo "${opts.repo}")` : ""}.`);
  if (opts.detach) {
    cx.spawn(["sync", "--repo", root, ...(opts.force ? ["--force"] : [])]);
    out(`Syncing ${cx.nameOf(root)}.`);
    return 0;
  }
  const r = await syncRepo(cx, root, { force: Boolean(opts.force) });
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
    return ensureServer(cx, root, { workspace: record.holder, branch: await branchOf(record.holder), keepVariant: true, restart: true });
  });
  if (!r) {
    err(`not-active: Spotlight is not on in ${cx.nameOf(root)}.`);
    return 1;
  }
  if (r.state === "started") out(`Restarted ${cx.nameOf(root)}'s server: ${r.plan.command}`);
  else if (r.state === "needs-variant") out(`${cx.nameOf(root)}: needs a variant: pick it in the server popup (spotlight env --variant <v>).`);
  else if (r.state === "none") out(`${cx.nameOf(root)} has no server command for this env.`);
  else {
    err(`${cx.nameOf(root)}: the server did not restart (${r.result?.reason ?? r.state}).`);
    return 1;
  }
  return 0;
}

async function verbLogs(cx, opts) {
  const root = await repoOrCwd(cx, opts);
  if (!root) return usage("spotlight logs: --repo <path or name>, or run it inside the repo.");
  const state = cx.store.readState();
  const record = state.repos[root] ?? null;
  const logPath = record?.logPath ?? logPathFor(root);
  if (opts.path) {
    out(logPath);
    return 0;
  }
  // D11: the CLI's notes first, then the server's own output.
  const notes = state.notes.filter((n) => n.repo === root).slice(-NOTES_SHOWN);
  if (notes.length > 0) {
    out("Spotlight notes:");
    for (const n of notes) out(`  ${formatClock(n.at)}  ${n.text}`);
    out("");
  }
  const r = await serverLogs({ logPath, terminal: record?.serverTerminal ?? null, lines: opts.lines }, cx.serverDeps);
  if (r.source === null) out(`No server log yet for ${cx.nameOf(root)} (${logPath}).`);
  else process.stdout.write(r.text);
  return 0;
}

async function workspaceRoot(opts) {
  const workspace = await checkoutOf(path.resolve(opts.workspace));
  return workspace ? { workspace, root: await repoRootOf(workspace) } : { workspace: null, root: null };
}

async function verbPeek(cx, opts) {
  const root = opts.workspace ? (await workspaceRoot(opts)).root : await repoOrCwd(cx, opts);
  if (!root) return usage("spotlight peek: --workspace <path> or --repo <path or name>.");
  const terminal = cx.store.readState().repos[root]?.serverTerminal ?? serverTerminalName(root);
  const r = await peekServer(terminal, cx.serverDeps);
  if (!r.ok) {
    err(`spotlight peek: ${r.message}`);
    return 1;
  }
  return 0;
}

async function verbEnv(cx, opts) {
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
  const r = await cx.store.withRepoLock(root, async () => {
    await cx.store.updateState((s) => {
      if (opts.variant && taskKey) rememberVariant(s, `${taskKey}::${normRoot(root)}`, opts.variant);
      // J-002: the popup's pick overrides settings' env until `toggle` off
      // drops the record; serverEnv stays what runs.
      if (opts.env) s.repos[root] = { ...emptyRepo(), ...(s.repos[root] ?? {}), envOverride: opts.env };
    });
    const record = cx.store.readState().repos[root];
    if (!record?.holder) return { state: "stored" };
    // Changing env or variant restarts only a server whose command or env changes (D22).
    return ensureServer(cx, root, {
      workspace: record.holder,
      branch: await branchOf(record.holder),
      taskKey: record.holder === workspace ? taskKey : await taskKeyOfWorkspace(record.holder, root, cx.shared),
      envName: opts.env,
      chosenVariant: opts.variant,
      keepVariant: opts.variant === undefined,
    });
  });
  const what = [opts.env && `env ${opts.env}`, opts.variant && `variant ${opts.variant}`].filter(Boolean).join(", ");
  if (r.state === "started") out(`${cx.nameOf(root)}: ${what}; the server restarted: ${r.plan.command}`);
  else if (r.state === "failed") {
    err(`${cx.nameOf(root)}: ${what} saved; the server did not start (${r.result?.reason}).`);
    return 1;
  } else out(`${cx.nameOf(root)}: ${what} saved.`);
  return 0;
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
