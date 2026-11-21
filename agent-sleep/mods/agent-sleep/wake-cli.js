// `wake-agent` (awake-agent D5): the CLI a Claude runs to wake another
// worktree's sleeping Claudes before it messages them (S1). USAGE says what
// it does and its exit codes; this says how.
//
// Up is a Claude in front of its terminal (`hc get`'s foreground, through
// programName: the native installer's process is named after its version)
// whose session file checks out (claude-session.js loadSession), the check
// claude-accounts makes after its resumes. Never Herdr's status: a Claude
// that misses Herdr's 2 s startup check never reports one. Herdr's `blocked`,
// when there, only adds that it waits for an answer in its tab.
//
// The targets are the mod's own (workspace-sleep.js wakeTargets), only in
// tabs still open (`hc ls`). A sleeping entry counts as something to wake
// before any of its Claudes is asleep: the wake calls its stops off.
//
// Pure, as the mod's files are: files, programs, the clock and path.resolve
// come injected, and bin/wake-agent.mjs wires node's. It only reads the files
// the loop copy writes, through the mod's own parsers: the mod stays their
// one writer (agent-sleep D11), and a wake happens only in the loop copy, at
// its next pulse, which needs a Herdr window (D4).

import { MOD, WAKE_DEADLINE_MS } from "./constants.js";
import { paths, parseRecords } from "./store.js";
import { workspacesPaths, parseWorkspaces } from "./workspaces-store.js";
import { wakeCommand, sleptTerminals, sleptBy, wakeTargets, entryWake } from "./workspace-sleep.js";
import { loadSession, loadConfigDirs, isClaudeForeground, programName } from "./claude-session.js";
import { logPaths, parseLogLine } from "./log.js";
import { statusWord } from "./rules.js";
import { workspaceOf, recordPath } from "./badges.js";

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
const names = (addresses) => addresses.join(", ");

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  const out = parseJson(r?.stdout);
  const json = out ?? parseJson(r?.stderr);
  const error = isObject(json) && "error" in json ? json.error : undefined;
  if (r?.code === 0 && error === undefined) return { ok: true, value: out };
  const said = isObject(error) ? error.message : error;
  return { ok: false, message: String(said ?? (r?.stderr || r?.stdout || `${file} exited ${r?.code}`)).trim() };
}

// sleeping.json's records and workspaces.json's entries, as the mod reads
// them (a missing or broken file is none).
async function readFiles(cx) {
  const [records, entries] = await Promise.all([
    cx.readText(paths(cx.appHome).sleeping),
    cx.readText(workspacesPaths(cx.appHome).file),
  ]);
  return { records: parseRecords(records).records, entries: parseWorkspaces(entries).entries };
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

// Herdr's spaces, and their panes as the mod's live panes() gives them
// ({ tab, terminal }), from `herdr-app ls`, for what a workspace's sleep holds
// (sleptBy). None when Herdr can't say: the records' own paths still count.
async function herdrLayout(cx) {
  const r = await call(cx, "herdr-app", ["ls"]);
  const spaces = r.ok ? list(r.value?.spaces) : [];
  const panes = spaces.flatMap((s) =>
    list(s?.tabs).flatMap((tab) => list(tab?.terminals).map((t) => ({ tab: tab?.id, terminal: t?.terminal }))),
  );
  return { spaces, panes };
}

// ── What sleeps ─────────────────────────────────────────────────────────────

// One line per worktree something sleeps in: `<path>  <terminals>  <kind>`,
// sorted by path. A Claude asleep in a tab of a workspace put to sleep
// (`slept`: sleptBy's terminal → path) is listed under that workspace, which
// is what wakes it; one whose tab is gone (`live` without it) isn't listed;
// `live` null lists every one.
export function asleepLines({ records, entries, live, slept }) {
  const groups = new Map();
  const group = (path) => {
    if (!groups.has(path)) groups.set(path, []);
    return groups.get(path);
  };
  for (const address of Object.keys(records).sort()) {
    const r = records[address];
    if (r.state !== "asleep" || (live && !live.has(address))) continue;
    group(slept.get(address) ?? recordPath(r)).push(address);
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
  const anyEntry = Object.keys(entries).length > 0;
  if (!anyEntry && !Object.values(records).some((r) => r.state === "asleep")) {
    cx.out("wake-agent: nothing asleep.");
    return 0;
  }
  const [hc, layout] = await Promise.all([liveTerminals(cx), anyEntry ? herdrLayout(cx) : null]);
  if (!hc.ok) cx.err(`wake-agent: can't tell which tabs are still open (hc ls --json: ${hc.message}); every record is listed.`);
  const slept = layout ? sleptBy(entries, layout.spaces, layout.panes) : new Map();
  const lines = asleepLines({ records, entries, live: hc.ok ? hc.live : null, slept });
  if (lines.length === 0) cx.out("wake-agent: nothing asleep.");
  for (const line of lines) cx.out(line);
  return 0;
}

// ── Up or not ──────────────────────────────────────────────────────────────

// `hc get <t> --json`'s terminal → { up: true, blocked } when a Claude is in
// front with its session file (in any of `configDirs`, loadConfigDirs'
// list; its transcript isn't looked for), else { up: false, why }.
export async function claudeUp(t, { home, configDirs, readText, exec }) {
  const fg = isObject(t) ? t.foreground : null;
  if (!isClaudeForeground(fg)) {
    return { up: false, why: isObject(fg) ? `${programName(fg) ?? "a program"} in front` : "nothing in front" };
  }
  const session = await loadSession({ home, pid: fg.pid, foregroundName: programName(fg), configDirs, transcript: false }, { readText, exec });
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
  const seen = await claudeUp(got.value, { home: cx.home, configDirs: await cx.configDirs(), readText: cx.readText, exec: cx.exec });
  if (!seen.up && record?.state === "asleep") return { up: false, why: `still asleep (${seen.why})` };
  return seen;
}

// The live terminals under `path` (its folder or below) with a Claude up.
async function upUnder(cx, path, live) {
  const under = [...live.keys()].sort().filter((address) => workspaceOf(live.get(address).cwd, [path]) !== null);
  const looks = await Promise.all(under.map((address) => lookAt(cx, address, null)));
  return under.filter((_, i) => looks[i].up);
}

// ── Waking one path ────────────────────────────────────────────────────────

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

// log.txt's lines (log.js parseLogLine) about one of `subjects` (a terminal,
// or the path for its workspace), `<subject>: …`, stamped in the second of
// `since` or later. Every one, not only coordinator.js endWake's `<t>: not
// woken (wake <path>): <why>` (log.js notWokenHead): the mod claims a record
// before it types the resume, so a wake whose resume was typed (`resumed
// (wake <path>)`) or failed to be (`resume not sent (…)`) ends as done and
// gives up on nothing.
export function wakeLogLines(text, { subjects, since }) {
  const from = Math.floor(since / 1000) * 1000;
  const heads = subjects.map((s) => `${s}: `);
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!heads.some((h) => line.includes(h))) continue; // looked for before a line is parsed
    const parsed = parseLogLine(line);
    if (parsed !== null && parsed.at >= from && heads.some((h) => parsed.text.startsWith(h))) out.push(line);
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
  const entry = own(first.entries, path);
  const [hc, layout] = await Promise.all([liveTerminals(cx), entry ? herdrLayout(cx) : null]);
  if (!entry && wakeTargets(first.records, path).length === 0) return nothingThere(cx, path, [], hc);
  if (!hc.ok) {
    cx.err(`wake-agent: can't list Herdr's terminals (hc ls --json): ${hc.message}`);
    return 1;
  }
  // Its workspace's terminals, every tab of its spaces: what its sleep holds.
  const terminals = layout ? sleptTerminals({ [path]: entry }, layout.spaces, layout.panes) : new Set();
  const all = wakeTargets(first.records, path, terminals);
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
    // The mod acts at its next pulse: the first look is one poll after the send.
    await cx.sleep(Math.min(cx.pollMs, since + cx.timeoutMs - cx.now()));
    const [files, seen] = await Promise.all([readFiles(cx), liveTerminals(cx)]);
    if (seen.ok) for (const a of wakeTargets(files.records, path, terminals)) if (seen.live.has(a)) known.add(a);
    const waiting = [...known].sort().filter((a) => !up.has(a) && !gone.has(a));
    if (seen.ok) for (const a of waiting) if (!seen.live.has(a)) gone.add(a);
    const looking = waiting.filter((a) => !gone.has(a));
    const looks = await Promise.all(looking.map((a) => lookAt(cx, a, own(files.records, a))));
    looking.forEach((a, i) => (looks[i].up ? up.set(a, looks[i]) : why.set(a, looks[i].why)));
    // The entry still to be acted on by the mod: asleep, or going to sleep
    // and not yet told to wake instead (wakeAfter).
    const entryLeft = entryWake(own(files.entries, path));
    const down = [...known].sort().filter((a) => !up.has(a) && !gone.has(a));
    if (down.length === 0 && !entryLeft) return wokeUp(cx, path, { known, up, gone });
    if (cx.now() - since >= cx.timeoutMs) return gaveUp(cx, path, { down, why, entryLeft, since });
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
  if (entryLeft) cx.err(`its workspace: ${entryLeft === "now" ? "still asleep" : "still going to sleep"}`);
  const log = logPaths(paths(cx.appHome).dir);
  const [rotated, current] = await Promise.all([cx.readText(log.rotated), cx.readText(log.file)]);
  const lines = wakeLogLines(`${rotated ?? ""}\n${current ?? ""}`, { subjects: entryLeft ? [...down, path] : down, since });
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
//   readText(path)    → the file's text, or null; never throws
//   resolve(cwd, arg) node's path.resolve: `arg` made absolute, `.` and `..`
//                     gone, no trailing slash, as the mod's decoder wants it
//                     (symlinks stay: the mod compares paths as strings)
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
    configDirs: () => (dirs ??= loadConfigDirs({ home: deps.home, appHome: deps.appHome }, { readText: deps.readText, exec: deps.exec })),
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
  return wake(cx, cx.resolve(cx.cwd, args[0]));
}
