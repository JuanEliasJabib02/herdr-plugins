// The rules of agent-sleep: which Claudes may be stopped now, and why every
// other terminal may not. Pure, so `node --test` can load it: no herdr
// import, no I/O and no clock of its own (the snapshot carries `now`). The
// coordinator gathers one snapshot per render or tick and acts on what comes
// back. A port of Orca Pro Max's planner, eligibility and confirmation
// (src/renderer/src/lib/agent-hibernation-planner.ts, -pane-eligibility.ts,
// -confirmation.ts, foreground-terminal-tabs.ts) onto Herdr's Core terminals.
//
// The snapshot; every map is keyed by Core address (`t7`, `machine/t7`):
//   now              ms since the epoch, from the injected clock
//   manual           true for "Sleep now": skips only the idle window (and
//                    `settings.enabled`, which switches automatic sleep)
//   settings         { enabled, idleMinutes } (store.js)
//   terminals        Core terminals as `hc get --json` or herdr terminals()
//                    give them: address, argv, state, parent, foreground
//                    { name, pid }, status ({ state } or a plain word),
//                    status_ms, turn
//   spaces, panes, focused   herdr spaces(), panes(), focused()
//   previousVisible  the `visible` list the last render or tick returned
//   lastSeen, firstSeen      { [address]: ms }, as the last observe() left them
//   sessions         { [address]: { sessionId, transcript } } for the Claudes
//                    whose session file passed D3 (claude-session.js);
//                    `transcript` is true once its .jsonl was found
//   screens          { [address]: hashScreen(`hc read`) }, read only for the
//                    terminals a first pass put on `no-screen`
//   records          sleeping.json's records ({ [address]: { state, ... } })
//   failedUntil      { [address]: ms }, set after a stop that failed (D4)
//
// A tick, in the coordinator: planSleep → read the screens of needsScreen()
// → planSleep again with them → confirm() against the last tick's state →
// for one confirmed candidate, planSleep again right before the stop and
// stop only if stillCandidate().

export const TICK_MS = 60_000;
export const DEFAULT_IDLE_MINUTES = 30;
export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 24 * 60;
const MINUTE = 60_000;

// Why a terminal isn't a candidate: one code per terminal, the first check
// it fails, in this order.
export const REASONS = Object.freeze([
  "disabled", // automatic sleep is off (settings.enabled); never in manual mode
  "remote", // on another machine (`machine/t7`): its pids aren't ours
  "not-live", // Core says it finished
  "asleep", // its record says it's asleep already
  "stopping", // its record says a stop is under way (D4 reconciles it)
  "bad-record", // its record has a state this mod doesn't know
  "sub-agent", // another terminal started it (`parent`)
  "root-not-shell", // its own program isn't a shell: /exit would end the terminal
  "not-claude", // what runs in it now isn't Claude
  "no-status", // Claude never reported a status
  "working",
  "blocked",
  "error",
  "unknown-status", // a status word other than done/idle/working/blocked/error
  "idle-turn-0", // idle and never asked anything: nothing to resume
  "has-child", // a live terminal it started
  "no-pane", // no pane in any tab, so it could never be revealed
  "visible", // on screen now (D6)
  "failed-until", // a failed stop parks it for one idle window (D4)
  "invalid-session", // no session file passed D3's checks
  "no-transcript", // its session's transcript wasn't found
  "idle-window", // idle for less than the window; `due` says until when
  "no-screen", // eligible, waiting for its screen hash (read it, plan again)
]);

const SHELLS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "oksh", "pdksh", "yash", "ash",
  "csh", "tcsh", "nu", "elvish", "xonsh", "pwsh", "powershell",
]);
// Core's foreground.name as the OS has it (`hc get t1p --json`: "claude.exe").
const CLAUDE_NAMES = new Set(["claude", "claude.exe"]);
const STOPPED_BY = new Set(["working", "blocked", "error"]);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
// Core addresses are short ids; `__proto__` would write a map's prototype.
const isAddress = (a) => typeof a === "string" && a !== "" && a !== "__proto__";
const own = (map, key) => (isObject(map) && Object.hasOwn(map, key) ? map[key] : undefined);
const list = (v) => (Array.isArray(v) ? v : []);

function needClock(now, fn) {
  if (!finite(now)) throw new TypeError(`${fn}: now must be a finite number of ms`);
}

// The idle window in ms: `idleMinutes` from 1 min to 24 h, anything else
// (missing, 0, 99999, a string) the 30 min default (D2, Orca's
// getEffectiveAgentHibernationIdleMs).
export function idleWindowMs(settings) {
  const minutes = own(settings, "idleMinutes");
  return finite(minutes) && minutes >= MIN_IDLE_MINUTES && minutes <= MAX_IDLE_MINUTES
    ? minutes * MINUTE
    : DEFAULT_IDLE_MINUTES * MINUTE;
}

// Terminals on screen now (D6): every pane in the active tab of the shown
// space (and in focused().tab, the window's context), plus focused()'s
// terminal (a layout terminal block), shown (terminal.show) and agent (an
// agent block), which no pane lists.
export function visibleTerminals({ spaces, panes, focused } = {}) {
  const tabs = new Set();
  for (const space of list(spaces)) {
    if (!isObject(space) || space.active !== true) continue;
    for (const tab of list(space.tabs)) {
      if (isObject(tab) && tab.active === true && typeof tab.id === "string") tabs.add(tab.id);
    }
  }
  const focus = isObject(focused) ? focused : {};
  if (typeof focus.tab === "string" && focus.tab !== "") tabs.add(focus.tab);
  const visible = new Set();
  for (const pane of list(panes)) {
    if (isObject(pane) && isAddress(pane.terminal) && tabs.has(pane.tab)) visible.add(pane.terminal);
  }
  for (const key of ["terminal", "shown", "agent"]) {
    if (isAddress(focus[key])) visible.add(focus[key]);
  }
  return visible;
}

// What this mod has seen, for every render and tick (D6). `lastSeen = now`
// for the terminals visible now and for those that just left the visible
// set, so the idle clock starts at the end of a visit, not at its start
// (Orca foreground-terminal-tabs.ts:39-40, :69-79). `firstSeen` is when this
// mod first saw a terminal, so a reload never trusts an old status time.
// Terminals Core no longer has are forgotten; without a terminal list,
// nothing is forgotten or first seen. Returns new maps; the inputs stay.
export function observe({ now, terminals, spaces, panes, focused, previousVisible, lastSeen, firstSeen } = {}) {
  needClock(now, "observe");
  const visible = visibleTerminals({ spaces, panes, focused });
  const last = isObject(lastSeen) ? { ...lastSeen } : {};
  const first = isObject(firstSeen) ? { ...firstSeen } : {};
  for (const address of visible) last[address] = now;
  for (const address of list(previousVisible)) {
    if (isAddress(address) && !visible.has(address)) last[address] = now;
  }
  if (Array.isArray(terminals)) {
    const alive = new Set(terminals.filter((t) => isObject(t) && isAddress(t.address)).map((t) => t.address));
    for (const address of alive) {
      if (!finite(own(first, address))) first[address] = now;
    }
    for (const map of [last, first]) {
      for (const address of Object.keys(map)) {
        if (!alive.has(address)) delete map[address];
      }
    }
  }
  return { visible: [...visible].sort(), lastSeen: last, firstSeen: first };
}

// A short hash of a screen (`hc read` text) for the signature: cyrb53, 53
// bits as hex. Null for anything that isn't text (a read that failed), which
// planSleep treats as no screen at all.
export function hashScreen(text) {
  if (typeof text !== "string") return null;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

// D2's signature: address | status | status_ms | turn | sessionId | screen
// hash. Two ticks with the same one mean nothing moved in between.
export function signatureOf({ address, state, statusMs, turn, sessionId, screenHash }) {
  return [address, state, statusMs, turn, sessionId, screenHash].map(String).join("|");
}

// Core gives the status as { app, state }; herdr terminals() as a plain word.
function statusWord(status) {
  const word = typeof status === "string" ? status : isObject(status) ? status.state : null;
  return typeof word === "string" && word !== "" ? word : null;
}

// The terminal's own program (argv[0]) is a shell: `/bin/zsh`, `-zsh` (a
// login shell), `fish`, `pwsh.exe`...
function isShellRoot(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== "string") return false;
  const name = argv[0].slice(argv[0].lastIndexOf("/") + 1).replace(/^-/, "").replace(/\.exe$/i, "");
  return SHELLS.has(name);
}

// Idle start = max(status_ms, lastSeen, firstSeen) (D6). Without a status
// time or a first sighting there's no evidence of idleness: it starts now.
function idleStartOf(terminal, seen, now) {
  const first = own(seen.firstSeen, terminal.address);
  if (!finite(terminal.status_ms) || !finite(first)) return now;
  const last = own(seen.lastSeen, terminal.address);
  return Math.max(terminal.status_ms, first, finite(last) ? last : 0);
}

// One terminal: { reason, dueAt? } or { candidate }.
function judge(terminal, ctx) {
  const address = terminal.address;
  if (!ctx.manual && !ctx.enabled) return { reason: "disabled" };
  if (address.includes("/")) return { reason: "remote" };
  if (terminal.state !== "live") return { reason: "not-live" };
  const record = own(ctx.records, address);
  if (record !== undefined && record !== null) {
    const state = isObject(record) ? record.state : undefined;
    if (state === "asleep" || state === "stopping") return { reason: state };
    // A live record (D13) is bookkeeping for a running Claude: no block.
    if (state !== "live") return { reason: "bad-record" };
  }
  // Core's default for parent is null: only a set one makes a sub-agent.
  if (terminal.parent !== null && terminal.parent !== undefined) return { reason: "sub-agent" };
  if (!isShellRoot(terminal.argv)) return { reason: "root-not-shell" };
  if (!isObject(terminal.foreground) || !CLAUDE_NAMES.has(terminal.foreground.name)) return { reason: "not-claude" };
  const state = statusWord(terminal.status);
  if (state === null) return { reason: "no-status" };
  if (STOPPED_BY.has(state)) return { reason: state };
  if (state !== "done" && state !== "idle") return { reason: "unknown-status" };
  // Core's default for turn is 0.
  const turn = finite(terminal.turn) ? terminal.turn : 0;
  if (state === "idle" && turn < 1) return { reason: "idle-turn-0" };
  if (ctx.parents.has(address)) return { reason: "has-child" };
  if (!ctx.paned.has(address)) return { reason: "no-pane" };
  if (ctx.visible.has(address)) return { reason: "visible" };
  const until = own(ctx.failedUntil, address);
  if (finite(until) && ctx.now < until) return { reason: "failed-until" };
  const session = own(ctx.sessions, address);
  if (!isObject(session) || typeof session.sessionId !== "string" || session.sessionId === "") {
    return { reason: "invalid-session" };
  }
  if (session.transcript !== true) return { reason: "no-transcript" };
  const idleStart = idleStartOf(terminal, ctx.seen, ctx.now);
  if (!ctx.manual && ctx.now - idleStart < ctx.idleMs) {
    return { reason: "idle-window", dueAt: idleStart + ctx.idleMs };
  }
  const screenHash = own(ctx.screens, address);
  if (typeof screenHash !== "string" || screenHash === "") return { reason: "no-screen" };
  const statusMs = finite(terminal.status_ms) ? terminal.status_ms : null;
  const sessionId = session.sessionId;
  return {
    candidate: {
      address,
      sessionId,
      state,
      statusMs,
      turn,
      idleStart,
      signature: signatureOf({ address, state, statusMs, turn, sessionId, screenHash }),
    },
  };
}

// One snapshot in; out: the candidates (oldest idle first), one reason for
// every other terminal, `due` (when each `idle-window` terminal becomes
// eligible, for "Next: <ws> in N min") and `seen` (observe()'s result, for
// the coordinator to keep as the next previousVisible/lastSeen/firstSeen).
export function planSleep(snapshot = {}) {
  needClock(snapshot.now, "planSleep");
  const seen = observe(snapshot);
  const terminals = list(snapshot.terminals).filter((t) => isObject(t) && isAddress(t.address));
  const ctx = {
    now: snapshot.now,
    manual: snapshot.manual === true,
    enabled: isObject(snapshot.settings) && snapshot.settings.enabled === true,
    idleMs: idleWindowMs(snapshot.settings),
    seen,
    visible: new Set(seen.visible),
    paned: new Set(list(snapshot.panes).filter((p) => isObject(p) && isAddress(p.terminal)).map((p) => p.terminal)),
    parents: new Set(terminals.filter((t) => t.state === "live" && isAddress(t.parent)).map((t) => t.parent)),
    sessions: snapshot.sessions,
    screens: snapshot.screens,
    records: snapshot.records,
    failedUntil: snapshot.failedUntil,
  };
  const candidates = [];
  const reasons = {};
  const due = {};
  const done = new Set();
  for (const terminal of terminals) {
    if (done.has(terminal.address)) continue;
    done.add(terminal.address);
    const verdict = judge(terminal, ctx);
    if (verdict.candidate) {
      candidates.push(verdict.candidate);
    } else {
      reasons[terminal.address] = verdict.reason;
      if (verdict.dueAt !== undefined) due[terminal.address] = verdict.dueAt;
    }
  }
  candidates.sort((a, b) => a.idleStart - b.idleStart || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { candidates, reasons, due, seen };
}

// The terminals whose screen to read before planning again.
export function needsScreen(result) {
  const reasons = isObject(result) && isObject(result.reasons) ? result.reasons : {};
  return Object.keys(reasons).filter((address) => reasons[address] === "no-screen").sort();
}

// Two-tick confirmation (D2, Orca agent-hibernation-confirmation.ts): a
// candidate is confirmed when the previous tick had it with the same
// signature. Ticks more than 2x the interval apart (the laptop slept), or a
// tick at or before the previous one, restart it: nothing is confirmed and
// this tick's signatures become the state the next tick compares with.
export function confirm({ previous, candidates, now, intervalMs = TICK_MS } = {}) {
  needClock(now, "confirm");
  const interval = finite(intervalMs) && intervalMs > 0 ? intervalMs : TICK_MS;
  const at = isObject(previous) ? previous.at : undefined;
  const consecutive = finite(at) && now > at && now - at <= 2 * interval;
  const before = consecutive && isObject(previous.signatures) ? previous.signatures : {};
  const signatures = {};
  const confirmed = [];
  for (const candidate of list(candidates)) {
    if (!isObject(candidate) || !isAddress(candidate.address) || typeof candidate.signature !== "string") continue;
    signatures[candidate.address] = candidate.signature;
    if (own(before, candidate.address) === candidate.signature) confirmed.push(candidate);
  }
  return { confirmed, state: { at: now, signatures } };
}

// The re-plan right before a stop (Orca coordinator.ts hibernatePaneIfStillEligible):
// the confirmed candidate is still one, with the same signature.
export function stillCandidate(result, candidate) {
  if (!isObject(candidate) || !isObject(result)) return false;
  return list(result.candidates).some((c) => c.address === candidate.address && c.signature === candidate.signature);
}
