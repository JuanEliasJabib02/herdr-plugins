// The loop of agent-sleep: when to stop a Claude, how, and how it comes
// back. Port of Orca Pro Max's hibernation coordinator
// (src/renderer/src/lib/agent-hibernation-coordinator.ts) onto Herdr's Core.
// No herdr import: main.js injects everything this touches, so `node --test`
// drives it with a fake Core, files and clock.
//
//   deps = {
//     hc(args)                  herdr's hc(): { code, stdout, stderr }
//     exec(cmd, args, options)  herdr's exec()
//     files: { read(path), write(path, text, expected), mkdirp?(dir) }
//                               readTextFile / writeTextFile (compare-and-swap)
//     now()                     ms since the epoch
//     live: { terminals(), spaces(), panes(), focused() }   herdr's live data
//     notify(n), shared(key), setShared(key, value)
//     home, appHome             herdr's home() / appHome()
//     log(line)                 optional
//   }
//
// One copy runs it (D11): the one with no props().view and no
// props().overlay. main.js calls pulse() every PULSE_MS and observeNow()
// on every render. A pulse is cheap unless there is work:
//   - a settings change made in the block is saved first;
//   - every TICK_MS a tick (D2): settings and records read again, Core's
//     terminals gathered, records reconciled (D4), live records kept (D13),
//     the plan made, confirmed against the last tick, and at most one stop;
//   - while a stop is young (SETTLE_MS), its terminal is checked each pulse,
//     so a Claude that exits in 12 s is asleep a second later (D4);
//   - "Sleep now" / "Wake all" requests (D9);
//   - every visible terminal with an `asleep` record is resumed (D8: level,
//     not edge, so a reveal during a stop resumes once the shell is back).
// Pulses never overlap: everything that types into a terminal runs one at a
// time, in the order above (Risk item 4).

import {
  TICK_MS, planSleep, needsScreen, confirm, stillCandidate, hashScreen, idleWindowMs, observe, visibleTerminals,
} from "./rules.js";
import {
  paths, parseSettings, DEFAULT_SETTINGS, loadRecords, saveRecords, reconcile, withRecord, withoutRecord, claim,
  foregroundIsShell, ENV_PATTERN,
} from "./store.js";
import { BADGE_KEY, badgeValue, sameValue, workspaceOf, parseWorktreeList } from "./badges.js";
import { loadSession, isClaudeName, parseExitScreen, exitSessionId, sessionFilePath } from "./claude-session.js";
import { readPrompt, classifyProbe, promptRestored, PROBE_KEY, ERASE_KEY } from "./prompt.js";
import { resumeFlags, resumeCommand, canResumeIn, hintDifference, REPLAYABLE_ENV } from "./resume.js";

// This mod's folder under mods/: asset paths go through it, never a literal
// (Herdr's mod.clone rewrites it in a copy).
export const MOD = "agent-sleep";
export const PULSE_MS = 1000;
// After /exit, the stopping terminal is checked on every pulse for this
// long; later, ticks reconcile it (D4: asleep whenever the shell is back).
export const SETTLE_MS = 30_000;
// A reveal that found a typed shell line looks again after this.
export const RETRY_MS = 2000;
// D5's probe: reads of the screen after `x`, until it changed.
const PROBE_READS = 5;
const PROBE_WAIT_MS = 150;
const MINUTE = 60_000;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isAddress = (a) => typeof a === "string" && a !== "" && a !== "__proto__";
const list = (v) => (Array.isArray(v) ? v : []);
const own = (map, key) => (isObject(map) && Object.hasOwn(map, key) ? map[key] : undefined);
const isLocal = (t) => isObject(t) && isAddress(t.address) && !t.address.includes("/");
const statusWord = (s) => {
  const word = typeof s === "string" ? s : isObject(s) ? s.state : null;
  return typeof word === "string" && word !== "" ? word : null;
};
const basename = (p) => (typeof p === "string" ? p.replace(/\/+$/, "").split("/").pop() || p : "");

// The workspace a record or a due terminal is named after in the block and
// the toast: its worktree's folder name ("checkout-flow").
const labelOf = (r) => basename(r?.workspacePath || r?.cwd) || null;

// D13, T7: a live record's terminal lost its program in a Core restart when
// its shell is in front again with a root pid other than the record's (T0:
// `reason` doesn't survive, the new root pid does). Without both pids there
// is no evidence, so no resume.
export const lostTerminal = (t, r) =>
  isObject(r) && r.state === "live" &&
  Number.isInteger(r.rootPid) && Number.isInteger(t?.pid) && t.pid !== r.rootPid &&
  foregroundIsShell(t);

// D5: a candidate's signature without its screen hash (address, status,
// status_ms, turn, session): what only Claude itself changes. A probe that
// didn't find a suggestion is refused under it, since the probe's own `x`
// changes the screen and would make the terminal a candidate again.
const claudeSignature = (c) => [c.address, c.state, c.statusMs, c.turn, c.sessionId].map(String).join("|");

// The block's line for a Claude kept asleep because its exit hint asked for
// an env assignment the resume can't replay (Log L10).
const envHold = (label, env) => `${label} stays asleep: Claude asked for ${env}`;

// ── Which copy runs the loop (D11) ─────────────────────────────────────────

export function isLoopCopy(props) {
  return !(isObject(props) && (props.view || props.overlay));
}

// Starts the pulse timer in the loop copy only. `timer` is cx.timer;
// `onPulse(cx)` gets each call's own cx. True when it started.
export function startLoop(props, timer, onPulse) {
  if (!isLoopCopy(props)) return false;
  timer.every(PULSE_MS, onPulse);
  return true;
}

// ── Core's terminals: terminals() or `hc get` ──────────────────────────────

// herdr.d.ts says terminals() is "as `hc ls --json` describes it", and that
// is a summary (address, agent, cwd, state, status word, turn, where): no
// pid, foreground or status_ms. A terminal with all three is used as is;
// any other one the plan needs is completed with `hc get <t> --json`.
const hasCoreFields = (t) =>
  Number.isInteger(t.pid) && Object.hasOwn(t, "foreground") && Object.hasOwn(t, "status_ms");

const appOf = (v) => (isObject(v) && typeof v.app === "string" ? v.app : null);

// Claude Code by what any shape says: hc ls's `agent`, Core's
// `status.app`, terminals()' `report` / `program`, or the foreground name.
export function isClaudeCodeTerminal(t) {
  if (!isObject(t)) return false;
  return (
    t.agent === "claude-code" ||
    appOf(t.status) === "claude-code" ||
    appOf(t.report) === "claude-code" ||
    (isObject(t.program) && t.program.key === "claude") ||
    (isObject(t.foreground) && isClaudeName(t.foreground.name))
  );
}

// ── The block (S6) ─────────────────────────────────────────────────────────

// The settings view's −/+ on "After N min": the next step down or up, a
// value written by hand snapping to the nearest one; 1 min to 24 h (D2).
const MINUTE_STEPS = [1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 480, 720, 1440];

export function stepMinutes(minutes, direction) {
  if (direction > 0) return MINUTE_STEPS.find((m) => m > minutes) ?? MINUTE_STEPS[MINUTE_STEPS.length - 1];
  return [...MINUTE_STEPS].reverse().find((m) => m < minutes) ?? MINUTE_STEPS[0];
}

// The settings view's "After 30 min" (S6); whole hours as hours ("After 24 h").
export function windowLabel(minutes) {
  return minutes >= 60 && minutes % 60 === 0 ? `After ${minutes / 60} h` : `After ${minutes} min`;
}

// What the block shows, from the coordinator's state:
//   headline  "Agent sleep · 2 asleep · ~620 MB freed" ("nothing asleep")
//   next      "Next: <workspace> in N min", "Automatic sleep is off", or null
//   last      the last thing it did ("Woke checkout-flow"), or null
//   holds     why an asleep Claude isn't resumed, one line each
//   debug     which path gave Core's fields ("fields: terminals()" or
//             "fields: hc get ×N (…)"), or null before the first tick
//   asleep    how many are asleep (Wake all has nothing to do at 0)
export function blockModel({ now, records, settings, due, labels, lastEvent, holds, fields }) {
  const asleep = Object.values(isObject(records) ? records : {}).filter((r) => isObject(r) && r.state === "asleep");
  const kb = asleep.reduce((sum, r) => sum + (Number.isFinite(r.rssKb) && r.rssKb > 0 ? r.rssKb : 0), 0);
  const mb = Math.round(kb / 1024);
  const parts = ["Agent sleep"];
  if (asleep.length === 0) parts.push("nothing asleep");
  else {
    parts.push(`${asleep.length} asleep`);
    if (mb > 0) parts.push(`~${mb} MB freed`);
  }
  let next = null;
  if (isObject(settings) && settings.enabled === false) next = "Automatic sleep is off";
  else {
    let first = null;
    for (const [address, at] of Object.entries(isObject(due) ? due : {})) {
      if (!Number.isFinite(at)) continue;
      if (first === null || at < first.at || (at === first.at && address < first.address)) first = { address, at };
    }
    if (first) {
      const minutes = Math.max(1, Math.ceil((first.at - now) / MINUTE));
      next = `Next: ${own(labels, first.address) ?? first.address} in ${minutes} min`;
    }
  }
  return {
    headline: parts.join(" · "),
    next,
    last: typeof lastEvent === "string" ? lastEvent : null,
    holds: Object.values(isObject(holds) ? holds : {}).filter((h) => typeof h === "string").sort(),
    debug: typeof fields === "string" ? `fields: ${fields}` : null,
    asleep: asleep.length,
  };
}

// ── The coordinator ────────────────────────────────────────────────────────

export class Coordinator {
  constructor(deps) {
    this.d = deps;
    this.p = paths(deps.appHome);
    this.log = typeof deps.log === "function" ? deps.log : () => {};
    this.sleep = async () => {};
    this.settings = { ...DEFAULT_SETTINGS };
    this.settingsText = null;
    this.records = {};
    this.recordsText = null;
    this.started = false;
    this.running = false;
    this.lastTickAt = null;
    this.seen = { previousVisible: [], lastSeen: {}, firstSeen: {} };
    this.confirmState = null;
    this.failedUntil = {};
    // address → what D5 turned down: the signature (a line read as a draft,
    // a dialog), or claudeSignature after a probe: not tried again until it changes
    this.refused = {};
    this.holds = {}; // address → why that asleep Claude stays asleep
    this.retryAt = {}; // address → when a waiting reveal looks again
    this.due = {};
    this.dueLabels = {};
    this.lastEvent = null;
    this.fields = null;
    this.sleepNowRequested = false;
    this.queue = null;
    this.wakeAllRequested = false;
    this.pendingSettings = null; // the block's settings changes, saved by the next pulse
    this.lastView = null; // what the last pulse left on the block (pulse's return)
    this.badge = undefined;
    this.worktrees = new Map(); // cwd → workspace path (or null)
    this.transcripts = new Map(); // find argv → its result, found transcripts only
  }

  // ── Entry points ──

  // One pulse. `sleep(ms)` is the caller's (cx.sleep), for D5's probe.
  // True when what the block shows differs from what the last pulse left
  // (a minute rolling over between pulses included): main.js redraws only
  // then, since every redraw redraws the whole window.
  async pulse({ sleep } = {}) {
    if (this.running) return false;
    this.running = true;
    if (typeof sleep === "function") this.sleep = sleep;
    try {
      if (!this.started) await this.start();
      if (this.pendingSettings) await this.applySettings();
      this.observeNow();
      const now = this.d.now();
      if (this.lastTickAt === null || now - this.lastTickAt >= TICK_MS || now < this.lastTickAt) {
        this.lastTickAt = now;
        await this.tick();
      } else if (this.youngStop(now)) {
        await this.settle();
      }
      if (this.sleepNowRequested || this.queue) await this.manualStep();
      if (this.wakeAllRequested) await this.wakeAllStep();
      await this.revealStep();
      this.publishBadges();
    } catch (e) {
      this.log(`pulse failed: ${e?.stack ?? e}`);
    } finally {
      this.running = false;
    }
    const view = JSON.stringify(this.view());
    const changed = view !== this.lastView;
    this.lastView = view;
    return changed;
  }

  // D6 on every render: lastSeen for what is shown now and what just left.
  observeNow() {
    const seen = observe({
      now: this.d.now(),
      terminals: this.safe(() => this.d.live.terminals(), []),
      ...this.layout(),
      ...this.seenInput(),
    });
    this.adoptSeen(seen);
  }

  requestSleepNow() {
    this.sleepNowRequested = true;
  }

  requestWakeAll() {
    this.wakeAllRequested = true;
  }

  // The block's settings rows: a change is shown at once and saved by the
  // next pulse, so it never races a tick's read of settings.json.
  requestSettings(change) {
    if (isObject(change)) this.pendingSettings = { ...(this.pendingSettings ?? {}), ...change };
  }

  // The settings as the block shows them: the saved ones with any pending
  // change, clamped as they will be saved.
  shownSettings() {
    return parseSettings(JSON.stringify({ ...this.settings, ...(this.pendingSettings ?? {}) })).settings;
  }

  model() {
    return blockModel({
      now: this.d.now(),
      records: this.records,
      settings: this.settings,
      due: this.due,
      labels: this.dueLabels,
      lastEvent: this.lastEvent,
      holds: { ...this.envHolds(), ...this.holds },
      fields: this.fields,
    });
  }

  // Everything the block draws: its lines and the settings rows.
  view() {
    return { ...this.model(), settings: this.shownSettings() };
  }

  // Asleep Claudes whose stored env the resume can't replay: said by the
  // block from their record, so a reload keeps saying it.
  envHolds() {
    const out = {};
    for (const [address, r] of Object.entries(this.records)) {
      if (r?.state === "asleep" && typeof r.env === "string" && !REPLAYABLE_ENV.includes(r.env)) {
        out[address] = envHold(labelOf(r) ?? address, r.env);
      }
    }
    return out;
  }

  // Settings view: merges `change` in, clamps it (store.js), saves it with a
  // compare-and-swap. False (and the file's settings reloaded) when the file
  // changed since it was read.
  async saveSettings(change) {
    const next = parseSettings(JSON.stringify({ ...this.settings, ...change })).settings;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    try {
      if (typeof this.d.files.mkdirp === "function") await this.d.files.mkdirp(this.p.dir);
      await this.d.files.write(this.p.settings, text, this.settingsText);
      // "Next: … in N min" follows the new window before the next tick:
      // each due time is idle start + the window.
      const shift = idleWindowMs(next) - idleWindowMs(this.settings);
      if (shift !== 0) for (const address of Object.keys(this.due)) this.due[address] += shift;
      this.settings = next;
      this.settingsText = text;
      return true;
    } catch (e) {
      this.log(`settings.json changed under it, reloaded: ${e}`);
      await this.loadSettings();
      return false;
    }
  }

  // ── The pulse's steps ──

  // The block's pending settings change; tried once more on a file that
  // changed under it (the change applies to what the file says now).
  async applySettings() {
    const change = this.pendingSettings;
    this.pendingSettings = null;
    if (!(await this.saveSettings(change))) await this.saveSettings(change);
  }

  async start() {
    this.started = true;
    await this.loadSettings();
    await this.loadRecords();
    this.badge = this.safe(() => this.d.shared(BADGE_KEY), undefined);
  }

  // D2: one tick. The first one, right after start, also reconciles a stop
  // a reload interrupted (D4).
  async tick() {
    const now = this.d.now();
    await this.loadSettings();
    await this.loadRecords();
    const terminals = await this.gather();
    if (terminals.length === 0) {
      // No terminal at all is no evidence (Core not connected yet): a
      // reconcile would drop every record. Fail closed (D2).
      this.due = {};
      this.dueLabels = {};
      return;
    }
    await this.reconcileWith(terminals, now);
    const sessions = await this.sessionsOf(terminals);
    await this.keepLive(terminals, sessions, now);
    const plan = await this.plan({ now, terminals, sessions, manual: false });
    this.due = plan.due;
    this.dueLabels = plan.labels;
    const { confirmed, state } = confirm({ previous: this.confirmState, candidates: plan.candidates, now });
    this.confirmState = state;
    if (this.stoppingAddress() !== null) return; // one stop at a time
    for (const candidate of confirmed) {
      if (await this.stop(candidate, { manual: false })) return;
    }
  }

  youngStop(now) {
    return Object.values(this.records).some((r) => r.state === "stopping" && now - r.at < SETTLE_MS);
  }

  // Between ticks, only the stopping terminals are asked about.
  async settle() {
    const stopping = new Set(Object.keys(this.records).filter((a) => this.records[a].state === "stopping"));
    const terminals = await this.gather({ only: stopping });
    if (terminals.length === 0) return; // no evidence (see tick)
    await this.reconcileWith(terminals, this.d.now());
  }

  // D9 "Sleep now": every eligible Claude, the idle window and the two-tick
  // confirmation skipped, D4 and D5 still guarding each; one at a time, the
  // next once the last one is asleep.
  async manualStep() {
    if (this.stoppingAddress() !== null) return;
    if (this.sleepNowRequested) {
      this.sleepNowRequested = false;
      const terminals = await this.gather();
      const sessions = await this.sessionsOf(terminals);
      const plan = await this.plan({ now: this.d.now(), terminals, sessions, manual: true });
      this.queue = plan.candidates.map((c) => c.address);
      if (this.queue.length === 0) this.lastEvent = "Nothing to put to sleep";
    }
    while (this.queue && this.queue.length > 0) {
      const address = this.queue.shift();
      const terminals = await this.gather();
      const sessions = await this.sessionsOf(terminals);
      const plan = await this.plan({ now: this.d.now(), terminals, sessions, manual: true });
      const candidate = plan.candidates.find((c) => c.address === address);
      if (candidate && (await this.stop(candidate, { manual: true }))) break;
    }
    if (this.queue && this.queue.length === 0) this.queue = null;
  }

  // D9 "Wake all": every asleep Claude, shown or not, through the reveal's
  // own checks.
  async wakeAllStep() {
    this.wakeAllRequested = false;
    for (const address of Object.keys(this.records).sort()) {
      if (this.records[address]?.state === "asleep") await this.resume(address, "wake");
    }
  }

  // D8, level-triggered: every shown terminal with an asleep record.
  async revealStep() {
    const now = this.d.now();
    const visible = visibleTerminals(this.layout());
    for (const address of [...visible].sort()) {
      if (own(this.records, address)?.state !== "asleep") continue;
      if ((this.retryAt[address] ?? 0) > now) continue;
      await this.resume(address, "reveal");
    }
  }

  // The moon (D11), published only when it changes: setShared re-renders
  // every mod. No moon before and none now writes nothing.
  publishBadges() {
    const value = badgeValue({ records: this.records, modFolder: MOD });
    const empty = (v) => !isObject(v) || Object.keys(v).length === 0;
    if (empty(value) && empty(this.badge)) return false;
    if (sameValue(value, this.badge)) return false;
    this.d.setShared(BADGE_KEY, value);
    this.badge = value;
    return true;
  }

  // ── Planning ──

  // planSleep twice (D2): once to learn which screens to read, again with
  // them. A Claude that couldn't come back (resumability, T2) is never read
  // nor offered; one D5 turned down stays out while its signature holds
  // (after a probe, Claude's own: see claudeSignature).
  async plan({ now, terminals, sessions, manual }) {
    const base = {
      now, manual, settings: this.settings, terminals, ...this.layout(), ...this.seenInput(),
      sessions, records: this.records, failedUntil: this.failedUntil,
    };
    const first = planSleep({ ...base, screens: {} });
    const byAddress = new Map(terminals.map((t) => [t.address, t]));
    const screens = {};
    const unresumable = new Set();
    for (const address of needsScreen(first)) {
      if (!this.resumable(byAddress.get(address), sessions[address]).ok) {
        unresumable.add(address);
        continue;
      }
      const hash = hashScreen(await this.read(address));
      if (hash) screens[address] = hash;
    }
    // The layout and what renders saw while the screens were read (D6).
    const result = planSleep({ ...base, ...this.layout(), ...this.seenInput(), screens });
    this.adoptSeen(result.seen);
    const reasons = { ...result.reasons };
    for (const address of unresumable) reasons[address] = "unresumable";
    const candidates = result.candidates.filter((c) => {
      const refused = this.refused[c.address];
      if (refused !== c.signature && refused !== claudeSignature(c)) return true;
      reasons[c.address] = "refused";
      return false;
    });
    const due = {};
    const labels = {};
    for (const [address, at] of Object.entries(result.due)) {
      if (!this.resumable(byAddress.get(address), sessions[address]).ok) continue;
      due[address] = at;
      labels[address] = labelOf(own(this.records, address)) ?? (basename(sessions[address]?.cwd) || address);
    }
    return { candidates, reasons, due, labels };
  }

  // T2: a Claude is stopped only if it can come back. → { ok, flags, cwd }
  // or { ok: false, reason }.
  resumable(t, session) {
    if (!isObject(t) || !isObject(session)) return { ok: false, reason: "no session" };
    const flags = resumeFlags(t.foreground?.argv);
    if (!flags.ok) return { ok: false, reason: `flags: ${flags.reason}${flags.token ? ` ${flags.token}` : ""}` };
    const shell = Array.isArray(t.argv) ? t.argv[0] : null;
    if (!canResumeIn(shell)) return { ok: false, reason: "unsupported shell" };
    if (typeof session.cwd !== "string" || session.cwd === "") return { ok: false, reason: "no cwd" };
    const dry = resumeCommand({ flags: flags.flags, sessionId: session.sessionId, cwd: session.cwd, shellCwd: null, shell });
    if (!dry.ok) return { ok: false, reason: dry.reason };
    return { ok: true, flags: flags.flags, cwd: session.cwd };
  }

  // ── The stop (D2, D4, D5) ──

  async stop(candidate, { manual }) {
    const address = candidate.address;
    const now = this.d.now();
    // D2: planned again on fresh evidence right before the stop, children
    // included (a summary terminals() doesn't say who started whom).
    const terminals = await this.withParents(await this.gather());
    if (terminals === null) return false;
    const t = terminals.find((x) => x.address === address);
    if (!t) return false;
    const sessions = await this.sessionsOf([t]);
    const screen = await this.read(address);
    if (screen === null) return false;
    const plan = planSleep({
      now, manual, settings: this.settings, terminals, ...this.layout(), ...this.seenInput(),
      sessions, screens: { [address]: hashScreen(screen) }, records: this.records, failedUntil: this.failedUntil,
    });
    this.adoptSeen(plan.seen);
    if (!stillCandidate(plan, candidate)) return false;
    const session = sessions[address];
    const res = this.resumable(t, session);
    if (!res.ok) return false;

    // D5: Claude's prompt is empty, or held only a suggestion.
    const prompt = readPrompt(screen, t.foreground.name);
    if (prompt.program !== "claude") return false;
    if (prompt.state === "text") {
      const verdict = await this.probe(address, screen);
      if (verdict === "visible") return false;
      if (verdict !== "suggestion") {
        // The probe typed into Claude's screen: refused until Claude itself
        // changes, never on the screen it left behind.
        this.refused[address] = claudeSignature(candidate);
        return false;
      }
    } else if (prompt.state !== "empty") {
      this.refused[address] = candidate.signature;
      return false;
    }

    // D4: the record first, as stopping.
    const previous = own(this.records, address);
    const record = {
      state: "stopping",
      sessionId: session.sessionId,
      cwd: res.cwd,
      flags: res.flags,
      workspacePath: await this.workspaceOf(res.cwd, { fresh: true }),
      rssKb: await this.rssKb(t.foreground.pid),
      rootPid: Number.isInteger(t.pid) ? t.pid : null,
      holder: await this.holder(),
      at: now,
      by: manual ? "manual" : "auto",
    };
    if (!(await this.save(withRecord(this.records, address, record)))) return false;
    const undo = async () => {
      await this.save(previous ? withRecord(this.records, address, previous) : withoutRecord(this.records, address));
    };

    // D4: Core and the session file still say idle/done, nobody looks.
    const fresh = await this.getTerminal(address);
    const core = statusWord(fresh?.status);
    const file = await this.fileStatus(t.foreground.pid, session.sessionId);
    const same = isObject(fresh?.foreground) && fresh.foreground.pid === t.foreground.pid;
    if (!same || (core !== "done" && core !== "idle") || (file !== "idle" && file !== "done") || this.isVisible(address)) {
      await undo();
      return false;
    }
    const sent = await this.call(core === "idle" ? ["send", "--if", "idle", address, "/exit"] : ["send", address, "/exit"]);
    if (sent.code !== 0) {
      this.log(`${address}: /exit not sent: ${(sent.stderr || sent.stdout || "").trim()}`);
      this.failedUntil[address] = now + idleWindowMs(this.settings);
      await undo();
      return false;
    }
    this.log(`${address}: /exit sent (${record.by})`);
    this.lastEvent = `Putting ${labelOf(record) ?? address} to sleep`;
    return true;
  }

  // D5's one-character probe: `x`, read, backspace only when the `x` is on
  // screen. → "suggestion" | "draft" | "unknown" | "visible". "suggestion"
  // only when the backspace went through and Claude's prompt line reads as
  // before the `x`; an erase it can't confirm is "unknown" (no /exit: Claude
  // would get `x/exit`).
  async probe(address, before) {
    if (this.isVisible(address)) return "visible";
    await this.call(["keys", address, PROBE_KEY]);
    let after = await this.read(address);
    for (let i = 1; i < PROBE_READS && after === before; i++) {
      await this.sleep(PROBE_WAIT_MS);
      after = await this.read(address);
    }
    const { verdict, typed } = classifyProbe(before, after);
    if (typed && !(await this.erase(address, before))) return "unknown";
    if (this.isVisible(address)) return "visible";
    return verdict;
  }

  // The probe's backspace, checked: the call succeeded and the screen, read
  // again (a few times while Claude redraws), shows the prompt line as it
  // was before the probe. False otherwise, with a log line: the `x` may
  // still be on Claude's prompt line.
  async erase(address, before) {
    const sent = await this.call(["keys", address, ERASE_KEY]);
    if (sent.code !== 0) {
      this.log(`${address}: the probe's backspace failed (${(sent.stderr || sent.stdout || "").trim()}); its x may be on Claude's prompt line`);
      return false;
    }
    let screen = await this.read(address);
    for (let i = 1; i < PROBE_READS && !promptRestored(before, screen); i++) {
      await this.sleep(PROBE_WAIT_MS);
      screen = await this.read(address);
    }
    if (promptRestored(before, screen)) return true;
    this.log(`${address}: Claude's prompt line isn't back after the probe's backspace; its x may still be there`);
    return false;
  }

  // ── Reconcile and live records (D4, D13) ──

  async reconcileWith(terminals, now) {
    const before = this.records;
    const idleMs = idleWindowMs(this.settings);
    const result = reconcile({ records: before, terminals, now, idleMs });
    for (const address of result.failed) {
      this.failedUntil[address] = now + idleMs;
      this.log(`${address}: Claude never exited; parked for one window`);
    }
    let next = result.records;
    for (const [address, r] of Object.entries(next)) {
      if (r.state === "asleep" && own(before, address)?.state === "stopping") {
        next = withRecord(next, address, await this.afterExit(address, r));
      }
    }
    if (next !== before) await this.save(next);
  }

  // The shell is back after /exit (D3): the id Claude printed wins (it
  // follows /clear), its env assignment is stored in the record (Log L10:
  // replayed when resume.js can, otherwise the record holds that Claude
  // asleep, past the hint leaving the screen and a reload), and any
  // difference from the command this mod will type is logged.
  async afterExit(address, r) {
    const parsed = parseExitScreen(await this.read(address));
    const pick = exitSessionId(r.sessionId, parsed);
    if (pick.log) this.log(`${address}: ${pick.log}`);
    let out = { ...r, sessionId: pick.sessionId ?? r.sessionId };
    if (parsed.shape === "resume" && parsed.env) {
      if (ENV_PATTERN.test(parsed.env)) out = { ...out, env: parsed.env };
      else this.holds[address] = envHold(labelOf(out) ?? address, parsed.env); // not even storable: held while the mod runs
    }
    const diff = hintDifference(parsed, out.flags, out.env ?? null);
    if (diff) this.log(`${address}: ${diff}`);
    this.lastEvent = `Slept ${labelOf(out)}`;
    return out;
  }

  // D13: a `live` record for every running Claude that passes D3 and could
  // come back, rewritten only when what it says changes. A Claude you ended
  // yourself (a known program other than Claude in front, its shell or what
  // you ran next, same root pid) drops it; a new root pid is a lost
  // terminal, left for restart recovery. No foreground (Core's in-between
  // state right after a server stop, maybe still with the old pid) decides
  // nothing.
  async keepLive(terminals, sessions, now) {
    let next = this.records;
    let holder;
    for (const t of terminals) {
      if (!isLocal(t) || t.state !== "live") continue;
      const r = own(next, t.address);
      if (r && r.state !== "live") continue;
      if (!isObject(t.foreground) || !isClaudeName(t.foreground.name)) {
        if (r && isObject(t.foreground) && Number.isInteger(t.pid) && t.pid === r.rootPid) {
          next = withoutRecord(next, t.address);
        } else if (r && lostTerminal(t, r)) {
          // T7: the shell is back with a new root pid, so Core lost the
          // program (crash, reboot, logout, `server stop`): asleep, resumed
          // like any other when its tab is shown.
          if (holder === undefined) holder = await this.holder();
          const witness = r.holder && holder ? (r.holder === holder ? "same holder" : "new holder") : "holder unknown";
          next = withRecord(next, t.address, { ...r, state: "asleep", by: "restart", at: now });
          this.log(`${t.address}: lost in a restart (root pid ${r.rootPid} → ${t.pid}, ${witness}); resumes when shown`);
          this.lastEvent = `${labelOf(r) ?? t.address} lost in a restart · resumes when shown`;
        }
        continue;
      }
      const session = sessions[t.address];
      if (!session || session.transcript !== true) continue;
      const res = this.resumable(t, session);
      if (!res.ok) continue;
      const want = {
        sessionId: session.sessionId,
        cwd: res.cwd,
        flags: res.flags,
        workspacePath: await this.workspaceOf(res.cwd),
        rootPid: Number.isInteger(t.pid) ? t.pid : null,
      };
      if (r && Object.keys(want).every((k) => JSON.stringify(r[k] ?? null) === JSON.stringify(want[k]))) continue;
      if (holder === undefined) holder = await this.holder();
      next = withRecord(next, t.address, { state: "live", ...want, rssKb: null, holder, at: r?.at ?? now, by: "auto" });
    }
    if (next !== this.records) await this.save(next);
  }

  // ── The resume (D8, S6) ──

  // `via`: "reveal" (its tab is shown) or "wake" (Wake all).
  async resume(address, via) {
    const r = own(this.records, address);
    if (!r || r.state !== "asleep") return false;
    const now = this.d.now();
    const label = labelOf(r) ?? address;
    const t = await this.getTerminal(address);
    if (!t || t.state !== "live") return false; // gone: the next tick drops it
    if (!foregroundIsShell(t)) {
      // You took over (D8): your own program is in front of its shell.
      if (via === "reveal") {
        if (await this.save(withoutRecord(this.records, address))) this.lastEvent = `${label}: taken over, not resumed`;
      }
      return false;
    }
    const screen = await this.read(address);
    const prompt = readPrompt(screen, t.foreground.name);
    if (prompt.program !== "shell" || prompt.state !== "bare") {
      this.retryAt[address] = now + RETRY_MS; // a typed line: wait for it
      return false;
    }
    // Claude's own hint, still on screen, has the last word on the env.
    const env = r.env ?? null;
    const hint = parseExitScreen(screen);
    if (hint.shape === "resume" && hint.sessionId === r.sessionId && (hint.env ?? null) !== env) {
      this.hold(address, envHold(label, hint.env ?? "no env"), now);
      return false;
    }
    const cmd = resumeCommand({
      flags: r.flags, sessionId: r.sessionId, cwd: r.cwd, shellCwd: t.foreground.cwd ?? null, shell: t.foreground.name, env,
    });
    if (!cmd.ok) {
      this.hold(address, cmd.reason === "unsupported-env" ? envHold(label, env) : `${label} stays asleep: ${cmd.reason}`, now);
      return false;
    }
    // Claimed and saved before anything is typed: resumed exactly once.
    const { records: next, claimed } = claim(this.records, address);
    if (!claimed || !(await this.save(next))) return false;
    delete this.retryAt[address];
    const sent = await this.call(["send", address, cmd.command]);
    if (sent.code !== 0) {
      this.lastEvent = `Couldn't resume ${label}`;
      this.log(`${address}: resume not sent (${(sent.stderr || sent.stdout || "").trim()}); type it yourself: ${cmd.command}`);
      return false;
    }
    const afterRestart = r.by === "restart" ? " after a restart" : "";
    this.d.notify({ title: `Resuming ${label}${afterRestart}`, body: `Session ${r.sessionId.slice(0, 8)} · same flags as before` });
    this.lastEvent = `Woke ${label}${afterRestart}`;
    return true;
  }

  hold(address, why, now) {
    this.holds[address] = why;
    this.retryAt[address] = now + TICK_MS;
  }

  // ── Evidence ──

  // Core's terminals. `only`: complete just these addresses (a settle);
  // otherwise every local Claude Code terminal and every one with a record.
  async gather({ only } = {}) {
    const raw = this.safe(() => list(this.d.live.terminals()), []).filter((t) => isObject(t) && isAddress(t.address));
    const lacking = raw.filter((t) => !hasCoreFields(t)).length;
    let fetched = 0;
    const out = [];
    for (const t of raw) {
      const wanted = only
        ? only.has(t.address)
        : isLocal(t) && (isClaudeCodeTerminal(t) || Object.hasOwn(this.records, t.address));
      if (!wanted || hasCoreFields(t)) {
        out.push(t);
        continue;
      }
      const full = await this.getTerminal(t.address);
      if (full) fetched += 1;
      out.push(full ? { ...t, ...full } : t);
    }
    if (!only && raw.length > 0) {
      this.fields = lacking === 0
        ? "terminals()"
        : `hc get ×${fetched} (terminals() lacks pid/foreground/status_ms on ${lacking})`;
    }
    return out;
  }

  // Every local live terminal with its `parent` known, asking Core for the
  // ones that don't say; null when one can't be asked (no stop then).
  async withParents(terminals) {
    const out = [];
    for (const t of terminals) {
      if (!isLocal(t) || t.state !== "live" || Object.hasOwn(t, "parent")) {
        out.push(t);
        continue;
      }
      const full = await this.getTerminal(t.address);
      if (!full) return null;
      out.push({ ...t, ...full });
    }
    return out;
  }

  // D3 for every local Claude in front of its terminal.
  async sessionsOf(terminals) {
    const sessions = {};
    for (const t of terminals) {
      if (!isLocal(t) || t.state !== "live" || !isObject(t.foreground) || !isClaudeName(t.foreground.name)) continue;
      const s = await loadSession(
        { home: this.d.home, pid: t.foreground.pid, foregroundName: t.foreground.name },
        { readText: (path) => this.d.files.read(path), exec: (cmd, args) => this.execFind(cmd, args) },
      );
      if (s.ok) sessions[t.address] = { sessionId: s.sessionId, transcript: s.transcript !== null, cwd: s.cwd, status: s.status };
    }
    return sessions;
  }

  // A transcript found once stays found: `find` over ~/.claude/projects
  // runs once per session id, not once per Claude per tick.
  async execFind(cmd, args) {
    const key = cmd === "find" ? args.join("\0") : null;
    if (key !== null && this.transcripts.has(key)) return this.transcripts.get(key);
    const result = await this.d.exec(cmd, args);
    if (key !== null && isObject(result) && typeof result.stdout === "string" && result.stdout.trim() !== "") {
      if (this.transcripts.size >= 500) this.transcripts.clear();
      this.transcripts.set(key, result);
    }
    return result;
  }

  // D4's re-read of the session file: its status, if it still names this session.
  async fileStatus(pid, sessionId) {
    const path = sessionFilePath(this.d.home, pid);
    if (path === null) return null;
    try {
      const data = JSON.parse(await this.d.files.read(path));
      return isObject(data) && data.sessionId === sessionId && typeof data.status === "string" ? data.status : null;
    } catch {
      return null;
    }
  }

  async getTerminal(address) {
    const r = await this.call(["get", address, "--json"]);
    if (r.code !== 0) return null;
    try {
      const t = JSON.parse(r.stdout);
      return isObject(t) && t.address === address ? t : null;
    } catch {
      return null;
    }
  }

  async read(address) {
    const r = await this.call(["read", address]);
    return r.code === 0 ? r.stdout : null;
  }

  // The holder Core starts terminals in now (D11's `holder`, D13's second witness).
  async holder() {
    const r = await this.call(["server", "status", "--json"]);
    if (r.code !== 0) return null;
    try {
      const instance = JSON.parse(r.stdout)?.holder?.instance;
      return typeof instance === "string" && instance !== "" ? instance : null;
    } catch {
      return null;
    }
  }

  // "~MB freed" (D11): Claude's resident size at the stop.
  async rssKb(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const r = await this.run("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : NaN;
    return Number.isFinite(kb) && kb >= 0 ? kb : null;
  }

  // The worktree a folder is in, as `git worktree list` prints it (D1).
  async workspaceOf(cwd, { fresh = false } = {}) {
    if (!fresh && this.worktrees.has(cwd)) return this.worktrees.get(cwd);
    const r = await this.run("git", ["worktree", "list", "--porcelain"], { cwd });
    const path = r.code === 0 ? workspaceOf(cwd, parseWorktreeList(r.stdout)) : null;
    if (this.worktrees.size >= 500) this.worktrees.clear();
    this.worktrees.set(cwd, path);
    return path;
  }

  // ── Plumbing ──

  layout() {
    return {
      spaces: this.safe(() => list(this.d.live.spaces()), []),
      panes: this.safe(() => list(this.d.live.panes()), []),
      focused: this.safe(() => this.d.live.focused() ?? null, null),
    };
  }

  seenInput() {
    return {
      previousVisible: this.seen.previousVisible,
      lastSeen: this.seen.lastSeen,
      firstSeen: this.seen.firstSeen,
    };
  }

  adoptSeen(seen) {
    this.seen = { previousVisible: seen.visible, lastSeen: seen.lastSeen, firstSeen: seen.firstSeen };
  }

  isVisible(address) {
    return visibleTerminals(this.layout()).has(address);
  }

  stoppingAddress() {
    return Object.keys(this.records).find((a) => this.records[a].state === "stopping") ?? null;
  }

  async call(args) {
    try {
      const r = await this.d.hc(args);
      return isObject(r) && typeof r.code === "number" ? { stdout: "", stderr: "", ...r } : { code: -1, stdout: "", stderr: "no result" };
    } catch (e) {
      return { code: -1, stdout: "", stderr: String(e) };
    }
  }

  async run(cmd, args, options) {
    try {
      const r = await this.d.exec(cmd, args, options);
      return isObject(r) && typeof r.code === "number" ? { stdout: "", stderr: "", ...r } : { code: -1, stdout: "", stderr: "no result" };
    } catch (e) {
      return { code: -1, stdout: "", stderr: String(e) };
    }
  }

  safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  io() {
    return { read: this.d.files.read, write: this.d.files.write, mkdirp: this.d.files.mkdirp };
  }

  async loadSettings() {
    try {
      const text = await this.d.files.read(this.p.settings);
      this.settings = parseSettings(text).settings;
      this.settingsText = text ?? null;
    } catch (e) {
      this.log(`settings.json unreadable: ${e}`);
    }
  }

  async loadRecords() {
    try {
      const { records, text } = await loadRecords(this.io(), this.p);
      this.records = records;
      this.recordsText = text ?? null;
    } catch (e) {
      this.log(`sleeping.json unreadable: ${e}`);
    }
  }

  // Compare-and-swap save (D11). On a stale snapshot the file is read again
  // and the caller's step is dropped (false): it runs again on fresh data.
  async save(next) {
    if (next === this.records) return true;
    try {
      this.recordsText = await saveRecords(this.io(), this.p, next, this.recordsText);
      this.records = next;
      for (const address of Object.keys(this.holds)) {
        if (own(next, address)?.state !== "asleep") delete this.holds[address];
      }
      return true;
    } catch (e) {
      this.log(`sleeping.json changed under it, reloaded: ${e}`);
      await this.loadRecords();
      return false;
    }
  }
}
