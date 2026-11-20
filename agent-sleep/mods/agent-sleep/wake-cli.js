// `wake-agent` (awake-agent D5): from a shell, what agent-sleep put to sleep,
// and one worktree's Claudes woken by its path, so a Claude can wake another
// worktree's before it messages it (S1).
//
//   wake-agent           what sleeps: one line per worktree, its path, the
//                        terminals of its Claudes asleep and how it slept
//                        (idle, or workspace: put to sleep as a whole)
//   wake-agent <path>    sends the mod's `wake.<hex>` (D1) with `herdr-app
//                        do` and waits until each Claude there is up
//
// Up is a Claude in front of its terminal (`hc get`'s foreground, through
// programName: the native installer's process is named after its version)
// whose session file checks out (claude-session.js loadSession), the check
// claude-accounts makes after its resumes. Never Herdr's status: a Claude
// that misses Herdr's 2 s startup check never reports one. Herdr's `blocked`,
// when there, only adds that it waits for an answer in its tab.
//
// The targets are the mod's own (coordinator.js wakeTargets): the Claudes
// whose record is asleep or being stopped, at the path (its worktree, or
// Claude's own folder) or in the tabs of the path's workspace entry, and only
// in tabs still open (`hc ls`). A sleeping entry counts as something to wake
// before any of its Claudes is asleep: the wake calls its stops off.
//
// Exit codes: 0 up (or the list); 1 Herdr refused the wake (its error, at
// once), or not up after WAKE_TIMEOUT_MS (the terminals still down, then the
// lines the mod gave up with in log.txt); 2 nothing asleep at the path, or a
// usage error, as spotlight's CLI.
//
// Pure, as the mod's files are: files, programs and the clock come injected,
// and bin/wake-agent.mjs wires node's. It only reads the files the loop copy
// writes, through the mod's own parsers: the mod stays their one writer
// (agent-sleep D11), and a wake happens only in the loop copy, at its next
// pulse, which needs a Herdr window (D4).

import { MOD, WAKE_DEADLINE_MS } from "./coordinator.js";
import { paths, parseRecords } from "./store.js";
import { workspacesPaths, parseWorkspaces } from "./workspaces-store.js";
import { wakeCommand, sleptTerminals } from "./workspace-sleep.js";
import { loadSession, loadConfigDirs, isClaudeForeground, programName } from "./claude-session.js";
import { logPaths } from "./log.js";

// How long a wake is waited on: past the mod's own deadline (D3), so the
// lines it gives up with are in log.txt by then. And how often each terminal
// still down is looked at meanwhile.
export const WAKE_TIMEOUT_MS = WAKE_DEADLINE_MS + 30_000;
export const POLL_MS = 2_000;

export const USAGE = `wake-agent: wakes a worktree's Claudes that agent-sleep put to sleep.

  wake-agent           what sleeps: path, terminals, idle or workspace
  wake-agent <path>    wake what sleeps at that worktree, in its own tabs (none is
                       shown), and wait until each of its Claudes is up

Exit codes: 0 up (or the list); 1 Herdr refused the wake, or not up after
${WAKE_TIMEOUT_MS / 1000} s (with agent-sleep's reasons); 2 nothing asleep at that path, or a
usage error. A relative path is taken from the shell's folder.`;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const own = (map, key) => (isObject(map) && Object.hasOwn(map, key) ? map[key] : undefined);
// Herdr's status: a word in `hc ls`, { app, state } in `hc get`.
const statusWord = (s) => (isObject(s) ? s.state : s) ?? null;
const names = (addresses) => addresses.join(", ");

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── The path ────────────────────────────────────────────────────────────────

// `arg` made absolute against `cwd`, `.` and `..` resolved, no trailing slash
// (the mod's decoder rejects a relative path and drops the slash). Symlinks
// are left as they are: the mod compares paths as strings.
export function resolvePath(arg, cwd) {
  const raw = String(arg).startsWith("/") ? String(arg) : `${cwd}/${arg}`;
  const parts = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

// ── Reading the world ──────────────────────────────────────────────────────

// One program's run: { ok: true, value } with the JSON it printed (null for
// none), or { ok: false, message }: its `{ "error" }` (herdr-app's a string,
// hc's { kind, message }), else what it said, or why it couldn't start. As
// spotlight's herdrApp (server.js).
async function call(cx, file, args) {
  let r;
  try {
    r = await cx.exec(file, args);
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e) };
  }
  const json = parseJson(r?.stdout) ?? parseJson(r?.stderr);
  const error = isObject(json) && "error" in json ? json.error : undefined;
  if (r?.code === 0 && error === undefined) return { ok: true, value: parseJson(r?.stdout) };
  const said = isObject(error) ? error.message : error;
  return { ok: false, message: String(said ?? (r?.stderr || r?.stdout || `${file} exited ${r?.code}`)).trim() };
}

async function readText(cx, path) {
  try {
    const text = await cx.readText(path);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

// sleeping.json's records and workspaces.json's entries, as the mod reads
// them (a missing or broken file is none).
async function readFiles(cx) {
  return {
    records: parseRecords(await readText(cx, paths(cx.appHome).sleeping)).records,
    entries: parseWorkspaces(await readText(cx, workspacesPaths(cx.appHome).file)).entries,
  };
}

// `hc ls --json`'s live terminals: { ok: true, live: Map address → terminal }
// or { ok: false, message }.
async function liveTerminals(cx) {
  const r = await call(cx, "hc", ["ls", "--json"]);
  if (!r.ok) return r;
  const all = Array.isArray(r.value) ? r.value : r.value?.terminals;
  if (!Array.isArray(all)) return { ok: false, message: "it listed no terminals" };
  const live = all.filter((t) => isObject(t) && t.state === "live" && typeof t.address === "string");
  return { ok: true, live: new Map(live.map((t) => [t.address, t])) };
}

// Each entry's terminals, every tab of its spaces (sleptTerminals: what its
// sleep holds), from `herdr-app ls`: Map path → Set. Empty without entries,
// or when Herdr can't say (the records' own paths still count).
async function sleptBy(cx, entries) {
  const out = new Map();
  if (Object.keys(entries).length === 0) return out;
  const r = await call(cx, "herdr-app", ["ls"]);
  const spaces = r.ok ? list(r.value?.spaces) : [];
  const panes = spaces.flatMap((s) =>
    list(s?.tabs).flatMap((tab) => list(tab?.terminals).map((t) => ({ tab: tab?.id, terminal: t?.terminal }))),
  );
  for (const path of Object.keys(entries).sort()) out.set(path, sleptTerminals({ [path]: entries[path] }, spaces, panes));
  return out;
}

// ── What sleeps ─────────────────────────────────────────────────────────────

// One line per worktree something sleeps in: `<path>  <terminals>  <kind>`,
// sorted by path. A Claude asleep in a tab of a workspace put to sleep is
// listed under that workspace, which is what wakes it; one whose tab is gone
// (`live` without it) isn't listed; `live` null lists every one.
export function asleepLines({ records, entries, live, slept }) {
  const holder = (address) => {
    for (const [path, terminals] of slept) if (terminals.has(address)) return path;
    return null;
  };
  const groups = new Map();
  const group = (path) => {
    if (!groups.has(path)) groups.set(path, []);
    return groups.get(path);
  };
  for (const address of Object.keys(records).sort()) {
    const r = records[address];
    if (r.state !== "asleep" || (live && !live.has(address))) continue;
    group(holder(address) ?? r.workspacePath ?? r.cwd).push(address);
  }
  for (const path of Object.keys(entries)) group(path);
  return [...groups.keys()].sort().map((path) => {
    const e = own(entries, path);
    const kind = !e ? "idle" : e.state === "sleeping" ? "workspace (going to sleep)" : "workspace";
    return `${path}  ${names(groups.get(path)) || "-"}  ${kind}`;
  });
}

async function listAsleep(cx) {
  const { records, entries } = await readFiles(cx);
  const anything = Object.values(records).some((r) => r.state === "asleep") || Object.keys(entries).length > 0;
  let live = null;
  if (anything) {
    const hc = await liveTerminals(cx);
    if (hc.ok) live = hc.live;
    else cx.err(`wake-agent: can't tell which tabs are still open (hc ls --json: ${hc.message}); every record is listed.`);
  }
  const lines = anything ? asleepLines({ records, entries, live, slept: await sleptBy(cx, entries) }) : [];
  if (lines.length === 0) cx.out("wake-agent: nothing asleep.");
  for (const line of lines) cx.out(line);
  return 0;
}

// ── Up or not ──────────────────────────────────────────────────────────────

// `hc get <t> --json`'s terminal → { up: true, blocked } when a Claude is in
// front with its session file (in any of `configDirs`, loadConfigDirs'
// list), else { up: false, why }.
export async function claudeUp(t, { home, configDirs, readText: read, exec }) {
  const fg = isObject(t) ? t.foreground : null;
  if (!isClaudeForeground(fg)) {
    return { up: false, why: isObject(fg) ? `${programName(fg) ?? "a program"} in front` : "nothing in front" };
  }
  const session = await loadSession({ home, pid: fg.pid, foregroundName: programName(fg), configDirs }, { readText: read, exec });
  if (!session.ok) return { up: false, why: `Claude in front, no session file (${session.reason})` };
  return { up: true, blocked: statusWord(t.status) === "blocked" };
}

// One target, looked at: a record still `stopping` is down whatever is in
// front (its /exit is on its way); otherwise claudeUp, "still asleep" while
// its record is.
async function lookAt(cx, address, record) {
  if (record?.state === "stopping") return { up: false, why: "being put to sleep" };
  const got = await call(cx, "hc", ["get", address, "--json"]);
  if (!got.ok) return { up: false, why: `hc get: ${got.message}` };
  const seen = await claudeUp(got.value, {
    home: cx.home,
    configDirs: await cx.configDirs(),
    readText: (path) => readText(cx, path),
    exec: cx.exec,
  });
  if (!seen.up && record?.state === "asleep") return { up: false, why: `still asleep (${seen.why})` };
  return seen;
}

// The live terminals under `path` (its folder or below) with a Claude up.
async function upUnder(cx, path, live) {
  const prefix = path === "/" ? "/" : `${path}/`;
  const up = [];
  for (const [address, t] of [...live].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const cwd = typeof t.cwd === "string" ? t.cwd.replace(/\/+$/, "") || "/" : null;
    if (cwd === null || (cwd !== path && !cwd.startsWith(prefix))) continue;
    if ((await lookAt(cx, address, null)).up) up.push(address);
  }
  return up;
}

// ── Waking one path ────────────────────────────────────────────────────────

// The terminals a wake at `path` is for, as the mod's wakeTargets: a record
// asleep or being stopped, at the path or in its workspace's tabs.
function targetsAt(path, records, terminals) {
  return Object.keys(records).sort().filter((address) => {
    const r = records[address];
    if (r.state !== "asleep" && r.state !== "stopping") return false;
    return r.workspacePath === path || r.cwd === path || terminals.has(address);
  });
}

const closedNote = (gone) =>
  gone.length === 0 ? "" : ` ${names(gone)} slept there, but ${gone.length === 1 ? "its tab was" : "their tabs were"} closed.`;

// Exit 2: nothing to wake, and whether a Claude is up there already.
async function nothingThere(cx, path, gone, hc) {
  let up = "";
  if (!hc.ok) up = ` Whether a Claude is up there can't be told: hc ls --json: ${hc.message}.`;
  else {
    const found = await upUnder(cx, path, hc.live);
    up = found.length > 0 ? ` A Claude is already up there: ${names(found)}.` : " No Claude is up there either.";
  }
  cx.out(`wake-agent: nothing asleep at ${path}.${up}${closedNote(gone)}`);
  return 2;
}

// The entry still to be acted on by the mod: asleep, or going to sleep and
// not yet told to wake instead (wakeAfter). Null once it is gone or told.
function pendingEntry(entries, path) {
  const e = own(entries, path);
  if (!e || (e.state === "sleeping" && e.wakeAfter === true)) return null;
  return e;
}

const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (.*)$/;

// log.txt's lines (log.js logLine: `YYYY-MM-DD HH:MM:SS <text>`, local time)
// where the mod gave up a wake at `path` for one of `subjects` (a terminal,
// or the path for its workspace), stamped in the second of `since` or later:
// coordinator.js endWake's `<t>: not woken (wake <path>): <why>`.
export function wakeLogLines(text, { path, subjects, since }) {
  const from = Math.floor(since / 1000) * 1000;
  const heads = subjects.map((s) => `${s}: not woken (wake ${path}): `);
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (at >= from && heads.some((h) => m[7].startsWith(h))) out.push(line);
  }
  return out;
}

async function wake(cx, path) {
  // Null only for a path that isn't valid UTF-16 (a lone surrogate): the
  // argument is absolute by now.
  const command = wakeCommand(path);
  if (command === null) {
    cx.err(`wake-agent: ${path} isn't a path agent-sleep can be told\n\n${USAGE}`);
    return 2;
  }
  const first = await readFiles(cx);
  const atPath = targetsAt(path, first.records, new Set());
  const hc = await liveTerminals(cx);
  if (!own(first.entries, path) && atPath.length === 0) return nothingThere(cx, path, [], hc);
  if (!hc.ok) {
    cx.err(`wake-agent: can't list Herdr's terminals (hc ls --json): ${hc.message}`);
    return 1;
  }
  const entry = own(first.entries, path);
  const terminals = entry ? (await sleptBy(cx, { [path]: entry })).get(path) : new Set();
  const all = targetsAt(path, first.records, terminals);
  const closed = all.filter((a) => !hc.live.has(a));
  const targets = all.filter((a) => hc.live.has(a));
  if (!entry && targets.length === 0) return nothingThere(cx, path, closed, hc);

  const sent = await call(cx, "herdr-app", ["do", `${MOD}.${command}`]);
  if (!sent.ok) {
    cx.err(`wake-agent: Herdr refused the wake of ${path}: ${sent.message}`);
    return 1;
  }
  const since = cx.now();
  const what = targets.length > 0 ? names(targets) : "its workspace";
  cx.out(`wake-agent: waking ${path}: ${what} (up to ${cx.timeoutMs / 1000} s).${closedNote(closed)}`);

  const known = new Set(targets);
  const up = new Map(); // address → { blocked }
  const gone = new Set();
  const why = new Map();
  for (;;) {
    const files = await readFiles(cx);
    const seen = await liveTerminals(cx);
    if (seen.ok) for (const a of targetsAt(path, files.records, terminals)) if (seen.live.has(a)) known.add(a);
    for (const address of [...known].sort()) {
      if (up.has(address) || gone.has(address)) continue;
      if (seen.ok && !seen.live.has(address)) {
        gone.add(address);
        continue;
      }
      const look = await lookAt(cx, address, own(files.records, address));
      if (look.up) up.set(address, look);
      else why.set(address, look.why);
    }
    const entryLeft = pendingEntry(files.entries, path);
    const down = [...known].sort().filter((a) => !up.has(a) && !gone.has(a));
    if (down.length === 0 && !entryLeft) return wokeUp(cx, path, { known, up, gone });
    if (cx.now() - since >= cx.timeoutMs) return gaveUp(cx, path, { down, why, entryLeft, since });
    await cx.sleep(Math.min(cx.pollMs, since + cx.timeoutMs - cx.now()));
  }
}

function wokeUp(cx, path, { known, up, gone }) {
  const goneLines = [...gone].sort().map((a) => `${a}: gone (its tab was closed)`);
  if (up.size === 0 && gone.size > 0) {
    cx.err(`wake-agent: nothing left to wake at ${path}.`);
    for (const line of goneLines) cx.err(line);
    return 1;
  }
  if (known.size === 0) {
    cx.out(`wake-agent: ${path} is awake: none of its Claudes was asleep.`);
    return 0;
  }
  cx.out(`wake-agent: ${path} is up.`);
  for (const [address, look] of [...up].sort(([a], [b]) => (a < b ? -1 : 1))) {
    cx.out(look.blocked ? `${address}: up, blocked: it waits for an answer in its tab` : `${address}: up`);
  }
  for (const line of goneLines) cx.out(line);
  return 0;
}

async function gaveUp(cx, path, { down, why, entryLeft, since }) {
  cx.err(`wake-agent: ${path} isn't up after ${cx.timeoutMs / 1000} s:`);
  for (const address of down) cx.err(`${address}: ${why.get(address) ?? "not looked at"}`);
  if (entryLeft) cx.err(`its workspace: ${entryLeft.state === "asleep" ? "still asleep" : "still going to sleep"}`);
  const log = logPaths(paths(cx.appHome).dir);
  const text = `${(await readText(cx, log.rotated)) ?? ""}\n${(await readText(cx, log.file)) ?? ""}`;
  const lines = wakeLogLines(text, { path, subjects: entryLeft ? [...down, path] : down, since });
  if (lines.length === 0) {
    cx.err(
      "agent-sleep logged nothing about them since the wake was sent: Herdr's window may be closed (agent-sleep acts only while one is open, in a layout with its moon).",
    );
  } else {
    cx.err("agent-sleep's log:");
    for (const line of lines) cx.err(line);
  }
  return 1;
}

// ── The command line ───────────────────────────────────────────────────────

// argv (after node and the script) and the world:
//   exec(file, args)  → { code, stdout, stderr }, rejecting only when the
//                       program can't start
//   readText(path)    → the file's text, or null
//   now(), sleep(ms)  the clock
//   home, appHome     $HOME, and Herdr's home (HERDR_APP_HOME or
//                     ~/.config/herdr-app, as the plugin's)
//   cwd               the shell's folder, for a relative path
//   out(text), err(text)
//   pollMs, timeoutMs optional, POLL_MS and WAKE_TIMEOUT_MS by default
// → the exit code.
export async function main(argv, deps) {
  let dirs = null;
  const cx = {
    pollMs: POLL_MS,
    timeoutMs: WAKE_TIMEOUT_MS,
    ...deps,
    // The folders a session file can be in, listed once per run (find over
    // three roots), as the coordinator caches them.
    configDirs: () =>
      (dirs ??= loadConfigDirs({ home: deps.home, appHome: deps.appHome }, { readText: (p) => readText(cx, p), exec: deps.exec })),
  };
  const args = list(argv).map(String);
  if (args.length === 0) return listAsleep(cx);
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    cx.out(USAGE);
    return 0;
  }
  if (args.length > 1 || args[0] === "" || args[0].startsWith("-")) {
    cx.err(`wake-agent: ${args.length > 1 ? "one path at a time" : args[0] === "" ? "an empty path" : `unknown option ${args[0]}`}\n\n${USAGE}`);
    return 2;
  }
  return wake(cx, resolvePath(args[0], cx.cwd));
}
