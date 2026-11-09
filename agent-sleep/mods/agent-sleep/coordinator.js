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
//     herdrRun(name, args)      herdr's run(), for tab.settle / tab.unsettle
//                               (not `run`: Coordinator.run wraps exec)
//     home, appHome             herdr's home() / appHome()
//     log(line)                 optional
//   }
//
// One copy runs it (D11): the moon's (view "moon", the one a copy with no
// props().view gets, and no props().overlay), in the status row. main.js
// calls pulse() every PULSE_MS, and takeRequest(), observeNow() and
// viewToPublish() on every render. It is the one writer (D14): the popup and
// the confirm draw what they are handed and ask by naming a command. A pulse
// is cheap unless there is work:
//   - a request the popup left is taken, and a settings change saved, first;
//   - every TICK_MS a tick (D2): settings and records read again, Core's
//     terminals gathered, records reconciled (D4), the folders a Claude's
//     account can be in listed again (D15), live records kept while
//     automatic sleep is on and dropped while it's off (D13), the plan made,
//     confirmed against the last tick, and at most one stop;
//   - while a stop is young (SETTLE_MS), its terminal is checked each pulse,
//     so a Claude that exits in 12 s is asleep a second later (D4);
//   - a workspace's sleep (workspace-sleep D2, D10; workspace-sleep.js): a
//     new one's check, entry and settle, or one step of one under way, with
//     workspaces.json reconciled at start, on ticks and while one runs (D9);
//     and its wake (workspace-sleep D4) when one of its spaces is shown again;
//   - "Sleep now" / "Wake all" requests (D9);
//   - every visible terminal with an `asleep` record is resumed (D8: level,
//     not edge, so a reveal during a stop resumes once the shell is back).
//     Wake all and this reveal leave alone the terminals of a workspace put to
//     sleep as a whole until its wake (workspace-sleep D4: no undo of a sleep).
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
import { loadSession, loadConfigDirs, isClaudeName, parseExitScreen, exitSessionId, sessionFilePath } from "./claude-session.js";
import { readPrompt, classifyProbe, promptRestored, PROBE_KEY, ERASE_KEY } from "./prompt.js";
import { resumeFlags, resumeCommand, canResumeIn, hintDifference, REPLAYABLE_ENV } from "./resume.js";
import {
  WAIT_PULSES, INTERRUPT_DEADLINE_MS, PROGRAM_GRACE_MS, CLEAR_KEY, interruptArgs, localPlaces, shownSpace, entrySpaces,
  kindOf, UNTOUCHED, flightOf, promptStep, processGroups, hangUpGroup, shownEdges, cameBack, sleptTerminals, wakePlan,
  tabsToSettle, didntStopNotice, parseWorkspaceCommand,
} from "./workspace-sleep.js";
import {
  workspacesPaths, loadWorkspaces, saveWorkspaces, withEntry, withoutEntry, listedTabs, terminalsOf, reconcileSpaces,
} from "./workspaces-store.js";

// This mod's folder under mods/: asset paths go through it, never a literal
// (Herdr's mod.clone rewrites it in a copy).
export const MOD = "agent-sleep";
export const PULSE_MS = 1000;
// Shared values (D14): what the loop copy says to the popup, and the popup to it.
export const VIEW_KEY = "agent-sleep.view";
export const REQUEST_KEY = "agent-sleep.request";
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

// The workspace a record or a due terminal is named after in the popup and
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

// The popup's line for a Claude kept asleep because its exit hint asked for
// an env assignment the resume can't replay (Log L10).
const envHold = (label, env) => `${label} stays asleep: Claude asked for ${env}`;

// D15: its account's folder was removed while it slept. Resuming would
// recreate it as a fresh, signed-out config dir.
const goneHold = (label) => `${label} stays asleep: its account folder is gone`;

// ── Which copy runs the loop (D11) ─────────────────────────────────────────

// The view of the copy that runs it: the moon, in the status row with no
// props. main.js's views table names each copy's view (props().view, else its
// DEFAULT_VIEW), so `defaultView` is that line's: scripts/check-views.sh
// rewrites it to draw the popup or the confirm, and those copies, an overlay
// too, start no loop (workspace-sleep T7).
export const LOOP_VIEW = "moon";

export function isLoopCopy(props, defaultView = LOOP_VIEW) {
  const p = isObject(props) ? props : {};
  return (p.view ?? defaultView) === LOOP_VIEW && !p.overlay;
}

// Starts the pulse timer in the loop copy only. `timer` is cx.timer;
// `onPulse(cx)` gets each call's own cx. True when it started.
export function startLoop(props, timer, onPulse) {
  if (!isLoopCopy(props)) return false;
  timer.every(PULSE_MS, onPulse);
  return true;
}

// ── Core's terminals: terminals() or `hc get` ──────────────────────────────

// herdr.d.ts says terminals() is "as `hc ls --json` describes it", which is a
// summary (address, agent, cwd, state, status word, turn, where), but a live
// Herdr also gives pid, foreground and status_ms (the popup's headline then has
// "fields: terminals()" as its tooltip). A terminal with all three is used as is; any other one the
// plan needs is completed with `hc get <t> --json`. A status_ms of null only
// counts for a terminal with no status (a shell): the live Herdr of 2026-11-09
// sends null for every Claude too, and an idle clock without its status time
// starts again at each tick, so no Claude ever slept.
const hasCoreFields = (t) =>
  Number.isInteger(t.pid) && Object.hasOwn(t, "foreground") && Object.hasOwn(t, "status_ms") &&
  (Number.isFinite(t.status_ms) || (t.status ?? null) === null);

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

// ── What the moon and the popup show (S6, S12) ─────────────────────────────

// The popup's −/+ on "After N min": the next step down or up, a
// value written by hand snapping to the nearest one; 1 min to 24 h (D2).
const MINUTE_STEPS = [1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 480, 720, 1440];

export function stepMinutes(minutes, direction) {
  if (direction > 0) return MINUTE_STEPS.find((m) => m > minutes) ?? MINUTE_STEPS[MINUTE_STEPS.length - 1];
  return [...MINUTE_STEPS].reverse().find((m) => m < minutes) ?? MINUTE_STEPS[0];
}

// The popup's "After 30 min" (S6); whole hours as hours ("After 24 h").
export function windowLabel(minutes) {
  return minutes >= 60 && minutes % 60 === 0 ? `After ${minutes / 60} h` : `After ${minutes} min`;
}

// What they show, from the coordinator's state:
//   headline  "Agent sleep · 2 asleep · ~620 MB freed" ("nothing asleep"), the
//             moon's tooltip and the popup's first line
//   next      "Next: <workspace> in N min", "Automatic sleep is off", or null
//   last      the last thing it did ("Woke checkout-flow"), or null
//   holds     why an asleep Claude isn't resumed, one line each
//   debug     which path gave Core's fields ("fields: terminals()" or
//             "fields: hc get ×N (…)"), the headline's tooltip in the popup, or
//             null before the first tick
//   asleep    how many are asleep (the moon's number)
//   wakeable  how many of them Wake all would wake: not those `slept` holds,
//             the terminals of a workspace put to sleep as a whole, which wake
//             with it (workspace-sleep D4). Wake all has nothing to do at 0
export function blockModel({ now, records, settings, due, labels, lastEvent, holds, fields, slept }) {
  const asleepEntries = Object.entries(isObject(records) ? records : {}).filter(([, r]) => isObject(r) && r.state === "asleep");
  const asleep = asleepEntries.map(([, r]) => r);
  const held = slept instanceof Set ? slept : new Set();
  const wakeable = asleepEntries.filter(([address]) => !held.has(address)).length;
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
    wakeable,
  };
}

// ── Commands (D14) ─────────────────────────────────────────────────────────

// One table, for keys ("agent-sleep.<name>" in keys.json, or `herdr-app do
// agent-sleep.<name>`) and for the popup's requests. None does I/O: each only
// sets what the next pulse acts on, so a render can run them. `panel` isn't
// here: it opens the popup, from main.js.
export const COMMANDS = Object.freeze({
  "sleep-now": (co) => co.requestSleepNow(),
  "wake-all": (co) => co.requestWakeAll(),
  toggle: (co) => co.requestSettings({ enabled: !co.shownSettings().enabled }),
  less: (co) => co.requestSettings({ idleMinutes: stepMinutes(co.shownSettings().idleMinutes, -1) }),
  more: (co) => co.requestSettings({ idleMinutes: stepMinutes(co.shownSettings().idleMinutes, 1) }),
});

// A command by name: the table's, or a workspace sleep's (workspace-sleep
// D5), which stay out of the table the popup's buttons are: `sleep-workspace`
// sleeps the shown workspace, and the confirm's answers
// (`confirm-sleep.<question>`, `cancel-sleep.<question>`) name the question
// they answer. None does I/O either. Null for any other name.
export function commandOf(name) {
  if (typeof name !== "string") return null;
  if (Object.hasOwn(COMMANDS, name)) return COMMANDS[name];
  const c = parseWorkspaceCommand(name);
  if (c?.kind === "sleep") return (co) => co.requestSleepWorkspace();
  if (c?.kind === "answer") return (co) => co.answerQuestion(c.question, c.yes);
  return null;
}

// A workspace's sleep in this copy, from D10 step 4 on: waiting for its
// spaces to leave the screen (`pulses` counted), then its stops, one
// terminal at a time (`current`), and the ones that didn't stop.
const newJob = () => ({ phase: "wait", pulses: 0, queue: [], current: null, failed: [] });

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
    this.loaded = false; // the settings and records have been read once
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
    this.pendingSettings = null; // settings changes asked for, saved by the next pulse
    this.savingSettings = null; // the change that pulse is writing now
    this.lastRequestId = null; // the popup's last request seen (D14: it runs once)
    this.deferred = []; // commands that came before the settings were read
    this.lastView = null; // what the last pulse left to show (pulse's return)
    this.publishedView = null; // the view as last handed out to share with the popup
    this.badge = undefined;
    this.worktrees = new Map(); // cwd → workspace path (or null)
    this.transcripts = new Map(); // find argv → its result, found transcripts only
    this.configDirs = null; // D15: where a Claude's session file can be, listed once per tick
    // A workspace's sleep (workspace-sleep D9, D10).
    this.wp = workspacesPaths(deps.appHome);
    this.workspaces = {}; // workspaces.json's entries
    this.workspacesText = null;
    this.jobs = {}; // path → its sleep's steps 4–5, while this copy runs them
    this.sleepRequest = null; // { path, force }: a sleep asked for, taken by the next pulse
    this.question = null; // { id, path, label, count, at }: the confirm that sleep waits on (D5)
    this.questions = 0;
    this.shownSpaces = null; // the spaces shown at the last pulse (D4's edge); null before the first look
    this.spacesStarted = false; // the start reconcile (D9 rule 3) ran
  }

  // ── Entry points ──

  // One pulse. `sleep(ms)` is the caller's (cx.sleep), for D5's probe.
  // True when what it shows differs from what the last pulse left
  // (a minute rolling over between pulses included): main.js redraws only
  // then, since every redraw redraws the whole window.
  async pulse({ sleep } = {}) {
    if (this.running) return false;
    this.running = true;
    if (typeof sleep === "function") this.sleep = sleep;
    try {
      if (!this.started) await this.start();
      this.takeRequest(); // a render normally took it already
      if (this.pendingSettings) await this.applySettings();
      this.observeNow();
      const now = this.d.now();
      let ticked = false;
      if (this.lastTickAt === null || now - this.lastTickAt >= TICK_MS || now < this.lastTickAt) {
        this.lastTickAt = now;
        ticked = true;
        await this.tick();
      } else if (this.youngStop(now)) {
        await this.settle();
      }
      await this.workspaceStep({ ticked });
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

  // workspace-sleep D5: a workspace's sleep, by its path, or the shown one's
  // (the bare command). The next pulse takes it.
  requestSleepWorkspace(path = null) {
    this.sleepRequest = { path: typeof path === "string" && path !== "" ? path : null, force: false };
  }

  // The confirm's answer (D5): Sleep goes on with the sleep it asked about,
  // without asking again; Cancel changes nothing. An answer to any other
  // question (an older confirm) does nothing.
  answerQuestion(id, yes) {
    const q = this.question;
    if (q === null || q.id !== id) {
      this.log(`no question ${JSON.stringify(id)} to answer`);
      return;
    }
    this.question = null;
    if (yes) this.sleepRequest = { path: q.path, force: true };
  }

  // The popup's switch and −/+: a change is shown at once and saved by the
  // next pulse, so it never races a tick's read of settings.json.
  requestSettings(change) {
    if (isObject(change)) this.pendingSettings = { ...(this.pendingSettings ?? {}), ...change };
  }

  // The settings as the moon and the popup show them: the saved ones with the
  // change being written and any pending one, clamped as they will be saved.
  shownSettings() {
    return parseSettings(JSON.stringify({ ...this.settings, ...(this.savingSettings ?? {}), ...(this.pendingSettings ?? {}) })).settings;
  }

  model() {
    return blockModel({
      now: this.d.now(),
      records: this.records,
      settings: this.shownSettings(),
      due: this.due,
      labels: this.dueLabels,
      lastEvent: this.lastEvent,
      holds: { ...this.envHolds(), ...this.holds },
      fields: this.fields,
      slept: this.sleptTerminals(),
    });
  }

  // Everything the popup draws: its lines and the settings rows, and the
  // question a workspace's sleep waits on (D5: what its confirm draws), or null.
  view() {
    const q = this.question;
    return { ...this.model(), settings: this.shownSettings(), question: q ? { id: q.id, label: q.label, count: q.count } : null };
  }

  // A command by name (commandOf), from a key or a request. False, with a log
  // line, for a name it doesn't know. Until the settings are read it waits:
  // toggle would flip the defaults instead of what the file says.
  command(name) {
    const run = commandOf(name);
    if (run === null) {
      this.log(`no command ${JSON.stringify(name)}`);
      return false;
    }
    if (this.loaded) run(this);
    else this.deferred.push(name);
    return true;
  }

  // What the popup left under REQUEST_KEY. A render calls this, so no I/O: the
  // command only sets what the next pulse acts on. It runs once (D14): the same
  // id is ignored, and so is any request that doesn't name this copy, since
  // shared values outlive a reload or a restart and may span windows. Until the
  // settings are read it isn't looked at; the first pulse takes it. True when a
  // command ran.
  takeRequest() {
    if (!this.loaded) return false;
    const request = this.safe(() => this.d.shared(REQUEST_KEY), null);
    if (!isObject(request) || typeof request.id !== "string" || request.id === this.lastRequestId) return false;
    this.lastRequestId = request.id;
    if (request.owner !== this.d.copyId) return false;
    return this.command(request.command);
  }

  // What the loop copy's render shares under VIEW_KEY: the view when its JSON
  // changed since the last one, else null. setShared re-renders every mod, so
  // publishing on every render would never end. Null before the first pulse:
  // the defaults say less than what shared.json still has.
  viewToPublish(view = this.view()) {
    if (!this.loaded) return null;
    const json = JSON.stringify(view);
    if (json === this.publishedView) return null;
    this.publishedView = json;
    return view;
  }

  // Asleep Claudes whose stored env the resume can't replay: said by the
  // popup from their record, so a reload keeps saying it.
  envHolds() {
    const out = {};
    for (const [address, r] of Object.entries(this.records)) {
      if (r?.state === "asleep" && typeof r.env === "string" && !REPLAYABLE_ENV.includes(r.env)) {
        out[address] = envHold(labelOf(r) ?? address, r.env);
      }
    }
    return out;
  }

  // A settings change: merges `change` in, clamps it (store.js), saves it with a
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

  // The pending settings change; tried once more on a file that
  // changed under it (the change applies to what the file says now).
  async applySettings() {
    const change = this.pendingSettings;
    this.pendingSettings = null;
    this.savingSettings = change;
    try {
      if (!(await this.saveSettings(change))) await this.saveSettings(change);
    } finally {
      this.savingSettings = null;
    }
  }

  async start() {
    this.started = true;
    await this.loadSettings();
    await this.loadRecords();
    await this.loadEntries();
    this.badge = this.safe(() => this.d.shared(BADGE_KEY), undefined);
    this.loaded = true;
    for (const name of this.deferred.splice(0)) this.command(name);
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
    await this.listConfigDirs();
    const sessions = await this.sessionsOf(terminals);
    // Off (D11): nothing kept for restart recovery, and a live record left
    // from before goes, so a later restart resumes nothing on its own.
    if (this.settings?.enabled === true) await this.keepLive(terminals, sessions, now);
    else await this.dropLive();
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
  // own checks. Not those of a workspace put to sleep as a whole: they wake
  // with their workspace's click (workspace-sleep D4, R1#5), so Wake all stays
  // the undo of automatic sleep and no moon ever sits over running Claudes.
  async wakeAllStep() {
    this.wakeAllRequested = false;
    const slept = this.sleptTerminals();
    for (const address of Object.keys(this.records).sort()) {
      if (this.records[address]?.state === "asleep" && !slept.has(address)) await this.resume(address, "wake");
    }
  }

  // D8, level-triggered: every shown terminal with an asleep record. A
  // terminal of a space a workspace's sleep lists waits for that workspace's
  // wake (workspace-sleep D4): one still on screen when its stops began
  // (shownAtSleep), or shown again by a reload, would otherwise undo the sleep.
  async revealStep() {
    const now = this.d.now();
    const layout = this.layout();
    const visible = visibleTerminals(layout);
    const slept = sleptTerminals(this.workspaces, layout.spaces, layout.panes);
    for (const address of [...visible].sort()) {
      if (own(this.records, address)?.state !== "asleep" || slept.has(address)) continue;
      if ((this.retryAt[address] ?? 0) > now) continue;
      await this.resume(address, "reveal");
    }
  }

  // The terminals the workspaces put to sleep hold until their wake
  // (workspace-sleep D4), from workspaces.json and Herdr's layout now.
  sleptTerminals() {
    return sleptTerminals(this.workspaces, this.safe(() => list(this.d.live.spaces()), []), this.safe(() => list(this.d.live.panes()), []));
  }

  // The moon (D11), published only when it changes: setShared re-renders
  // every mod. No moon before and none now writes nothing. None for a
  // workspace put to sleep as a whole (workspace-sleep D3): its row has
  // projects-sidebar's own.
  publishBadges() {
    const slept = { paths: Object.keys(this.workspaces), terminals: this.sleptTerminals() };
    const value = badgeValue({ records: this.records, modFolder: MOD, slept });
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

  // T2: a Claude is stopped only if it can come back, in its own account
  // (D15: a config dir the resume would refuse is refused here, before
  // /exit). → { ok, flags, cwd, configDir } or { ok: false, reason }.
  resumable(t, session) {
    if (!isObject(t) || !isObject(session)) return { ok: false, reason: "no session" };
    const flags = resumeFlags(t.foreground?.argv);
    if (!flags.ok) return { ok: false, reason: `flags: ${flags.reason}${flags.token ? ` ${flags.token}` : ""}` };
    const shell = Array.isArray(t.argv) ? t.argv[0] : null;
    if (!canResumeIn(shell)) return { ok: false, reason: "unsupported shell" };
    if (typeof session.cwd !== "string" || session.cwd === "") return { ok: false, reason: "no cwd" };
    const configDir = session.configDir ?? null;
    const dry = resumeCommand({ flags: flags.flags, sessionId: session.sessionId, cwd: session.cwd, shellCwd: null, shell, configDir });
    if (!dry.ok) return { ok: false, reason: dry.reason };
    return { ok: true, flags: flags.flags, cwd: session.cwd, configDir };
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
      configDir: res.configDir,
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
    const file = await this.fileStatus(t.foreground.pid, record.sessionId, record.configDir);
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
      // configDir too (D15): restart recovery resumes from this record, so
      // without it a profile Claude would come back on System default. A
      // record from before T10 reads as null here, so it isn't rewritten.
      const want = {
        sessionId: session.sessionId,
        cwd: res.cwd,
        flags: res.flags,
        configDir: res.configDir,
        workspacePath: await this.workspaceOf(res.cwd),
        rootPid: Number.isInteger(t.pid) ? t.pid : null,
      };
      if (r && Object.keys(want).every((k) => JSON.stringify(r[k] ?? null) === JSON.stringify(want[k]))) continue;
      if (holder === undefined) holder = await this.holder();
      next = withRecord(next, t.address, { state: "live", ...want, rssKb: null, holder, at: r?.at ?? now, by: "auto" });
    }
    if (next !== this.records) await this.save(next);
  }

  async dropLive() {
    let next = this.records;
    for (const [address, r] of Object.entries(this.records)) {
      if (r.state === "live") next = withoutRecord(next, address);
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
    // D15: back in the account it slept in (a record without one is System
    // default), and only into a folder that still exists.
    const configDir = r.configDir ?? null;
    const cmd = resumeCommand({
      flags: r.flags, sessionId: r.sessionId, cwd: r.cwd, shellCwd: t.foreground.cwd ?? null, shell: t.foreground.name, env, configDir,
    });
    if (!cmd.ok) {
      this.hold(address, cmd.reason === "unsupported-env" ? envHold(label, env) : `${label} stays asleep: ${cmd.reason}`, now);
      return false;
    }
    if (configDir !== null && (await this.run("test", ["-d", configDir])).code !== 0) {
      this.hold(address, goneHold(label), now);
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

  // ── A workspace's sleep (workspace-sleep D2, D5, D9–D12) ──

  // Everything it does in one pulse: the shown edge (D4), the reconcile (D9)
  // at start, on a tick and while a sleep is under way, then a new sleep's
  // steps 1–3 or one step of one that runs (D10). With no workspace asleep
  // and none asked for it does no I/O. Without spaces there is no evidence.
  async workspaceStep({ ticked }) {
    const spaces = this.safe(() => list(this.d.live.spaces()), []);
    if (spaces.length === 0) return;
    if (ticked) await this.loadEntries();
    await this.watchShown(spaces);
    const sleeping = Object.values(this.workspaces).some((e) => e?.state === "sleeping");
    if (!this.spacesStarted || ticked || sleeping) await this.reconcileWorkspaces();
    if (this.sleepRequest) await this.beginSleep(this.sleepRequest);
    else await this.jobStep();
  }

  // D4: the person came back to a workspace put to sleep (cameBack: one of
  // its spaces went from not shown to shown, by a click on its row, the
  // picker, an agent's focus or `herdr-app do`). Asleep, it wakes now.
  // Mid-sleep, the rest of its stops are dropped, so no /exit reaches a Claude
  // the person just came back to, and `wakeAfter` makes step 6 wake it. The
  // first look after a start is no edge.
  async watchShown(spaces) {
    const previous = this.shownSpaces;
    const { shown, edges } = shownEdges(previous, spaces);
    this.shownSpaces = shown;
    if (edges.size === 0) return;
    for (const [path, e] of Object.entries(this.workspaces)) {
      if (!cameBack(e, { previous, shown })) continue;
      if (e.state === "asleep") {
        await this.wakeWorkspace(path);
        continue;
      }
      if (e.state !== "sleeping" || e.wakeAfter === true) continue;
      delete this.jobs[path];
      const saved = await this.updateEntries((entries) => {
        const cur = own(entries, path);
        return cur?.state === "sleeping" ? withEntry(entries, path, { ...cur, wakeAfter: true }) : null;
      });
      this.log(`${path}: shown again while going to sleep; its stops are dropped${saved ? "" : " (workspaces.json not written)"}`);
    }
  }

  // D9: workspaces.json against Herdr's spaces (reconcileSpaces), saved with a
  // compare-and-swap that, on a file changed under it, runs again on what the
  // file says now. Then: a sleep a reload interrupted is planned again
  // (rule 3), and one whose stops are done gets its step 6 (rule 4).
  async reconcileWorkspaces() {
    const start = !this.spacesStarted;
    this.spacesStarted = true;
    const input = () => ({
      entries: this.workspaces,
      spaces: this.safe(() => list(this.d.live.spaces()), []),
      panes: this.safe(() => list(this.d.live.panes()), []),
      records: this.records,
      queued: new Set(Object.keys(this.jobs)),
      start,
    });
    let result = reconcileSpaces(input());
    if (result.changed && !(await this.saveEntries(result.entries))) {
      result = reconcileSpaces(input());
      if (result.changed && !(await this.saveEntries(result.entries))) return;
    }
    for (const path of Object.keys(this.jobs)) if (!own(this.workspaces, path)) delete this.jobs[path];
    for (const path of result.replan) this.jobs[path] = newJob();
    for (const path of result.finish) await this.finishSleep(path);
  }

  // D10 steps 1–3, in one pulse. The workspace (the request's path, else the
  // shown space's, D12) and its spaces; work in flight asks first (D5) and
  // changes nothing until the answer; then the entry is written sleeping and
  // every tab settled, before any stop.
  async beginSleep({ path, force }) {
    this.sleepRequest = null;
    this.question = null; // a new request asks again
    const spaces = this.safe(() => list(this.d.live.spaces()), []);
    const panes = this.safe(() => list(this.d.live.panes()), []);
    const owners = await this.spaceWorkspaces(spaces, panes);
    const target = path ?? owners.get(shownSpace(spaces)?.id) ?? null;
    if (target === null) {
      this.lastEvent = "The shown space is in no workspace";
      return;
    }
    const label = basename(target) || target;
    const existing = own(this.workspaces, target);
    if (existing) {
      this.lastEvent = existing.state === "asleep" ? `${label} is already asleep` : `${label} is already going to sleep`;
      return;
    }
    const ids = [...owners].filter(([, p]) => p === target).map(([id]) => id);
    if (ids.length === 0) {
      this.lastEvent = `${label} has no open space`;
      return;
    }
    const tabs = entrySpaces(spaces, ids);
    if (!force) {
      const count = await this.inFlight(terminalsOf({ spaces: tabs }, panes));
      if (count > 0) {
        const now = this.d.now();
        this.questions += 1;
        this.question = { id: `q${now}-${this.questions}`, path: target, label, count, at: now };
        this.log(`${label}: ${count} working or with unsent text; asking first`);
        return;
      }
    }
    const entry = { spaces: tabs, state: "sleeping", at: this.d.now() };
    const saved = await this.updateEntries((entries) => (own(entries, target) ? null : withEntry(entries, target, entry)));
    if (!saved) {
      this.lastEvent = `Couldn't put ${label} to sleep`;
      return;
    }
    for (const id of listedTabs(entry)) this.herdr("tab.settle", { id });
    this.jobs[target] = newJob();
    this.lastEvent = `Putting ${label} to sleep`;
  }

  // D12: each local space's workspace, from its place through agent-sleep's
  // own workspaceOf (the deepest worktree of that folder's `git worktree
  // list`), asked once per place. → Map(spaceId → path or null).
  async spaceWorkspaces(spaces, panes) {
    const byPlace = new Map();
    const out = new Map();
    for (const { id, place } of localPlaces(spaces, panes, this.d.home)) {
      if (!byPlace.has(place)) byPlace.set(place, await this.workspaceOf(place, { fresh: true }));
      out.set(id, byPlace.get(place));
    }
    return out;
  }

  // D5: how many of the agents this sleep would stop are working, or, for a
  // Claude, may have unsent text (flightOf). Any other agent Core says is
  // working or blocked counts, whatever it is (step 4's F2): the stop
  // interrupts it and then hangs up (D2 b). Of the Claudes, only one that can
  // come back counts: one the gate refuses keeps running anyway. A hidden
  // line of text gets agent-sleep's probe, which never types where the person
  // can see it. What the sleep leaves alone (kindOf's UNTOUCHED) never counts.
  async inFlight(addresses) {
    let count = 0;
    for (const t of await this.freshTerminals(addresses)) {
      const kind = kindOf(t, { record: own(this.records, t.address), claude: isClaudeCodeTerminal(t) });
      if (kind === "program") {
        if (flightOf({ kind, status: statusWord(t.status) }) === "working") count += 1;
        continue;
      }
      if (kind !== "claude") continue;
      if (!(await this.gateClaude(t)).ok) continue;
      const screen = await this.read(t.address);
      const flight = flightOf({ kind, status: statusWord(t.status), prompt: readPrompt(screen, t.foreground.name), visible: this.isVisible(t.address) });
      if (flight === "clear") continue;
      if (flight === "probe" && (await this.probe(t.address, screen)) === "suggestion") continue;
      count += 1;
    }
    return count;
  }

  // D11 step 1: the Claude can come back, by agent-sleep's own checks: a
  // session file it trusts, its transcript, and resumable() (its flags, its
  // shell, its cwd, its account). → { ok, session, res } or { ok: false, why }.
  async gateClaude(t) {
    if (!isClaudeName(t.foreground?.name)) return { ok: false, why: "a Claude whose session it can't find" };
    const session = (await this.sessionsOf([t]))[t.address];
    if (!session) return { ok: false, why: "no session file it can trust" };
    if (session.transcript !== true) return { ok: false, why: "no transcript to resume" };
    const res = this.resumable(t, session);
    return res.ok ? { ok: true, session, res } : { ok: false, why: `it couldn't come back (${res.reason})` };
  }

  // D10 steps 4–5. A sleep waiting for its spaces to leave the screen looks
  // again; after WAIT_PULSES still shown (no keeper in this layout) it marks
  // shownAtSleep and its stops start anyway. Then one terminal's step, of the
  // first sleep whose stops run.
  async jobStep() {
    const spaces = this.safe(() => list(this.d.live.spaces()), []);
    for (const [path, job] of Object.entries(this.jobs)) {
      if (job.phase !== "wait") continue;
      const entry = own(this.workspaces, path);
      if (!entry) {
        delete this.jobs[path];
        continue;
      }
      if (spaces.some((s) => s?.active === true && Object.hasOwn(entry.spaces, s.id))) {
        job.pulses += 1;
        if (job.pulses < WAIT_PULSES) continue;
        await this.updateEntries((entries) => {
          const cur = own(entries, path);
          return cur?.state === "sleeping" ? withEntry(entries, path, { ...cur, shownAtSleep: true }) : null;
        });
      }
      job.phase = "stops";
      job.queue = terminalsOf(entry, this.safe(() => list(this.d.live.panes()), []));
    }
    const path = Object.keys(this.jobs).find((p) => this.jobs[p].phase === "stops");
    if (path !== undefined) await this.stopStep(path, this.jobs[path]);
  }

  // One terminal's step. A terminal with nothing to stop (D2's untouched,
  // a Claude asleep already, one closed meanwhile) takes no step, so the
  // next one goes in the same pulse.
  async stopStep(path, job) {
    for (;;) {
      if (job.current === null) {
        if (job.queue.length === 0) return this.endJob(path, job);
        job.current = { address: job.queue.shift(), phase: "start", at: null, wake: false, signalled: false };
      }
      const outcome = await this.advance(job, job.current);
      if (outcome === "wait") return;
      job.current = null;
      if (outcome === "done") {
        if (job.queue.length === 0) await this.endJob(path, job);
        return;
      }
    }
  }

  // Its stops are done: the toast names what didn't stop (D10). Step 6 comes
  // with the next reconcile, once no stop of it is still exiting.
  async endJob(path, job) {
    delete this.jobs[path];
    const notice = didntStopNotice(basename(path) || path, job.failed);
    if (notice) this.d.notify(notice);
  }

  // One terminal of the queue, phase by phase → "wait" (look again next
  // pulse), "done" (stopped, or left running and counted) or "skip".
  //   start        what it is (kindOf): left alone; another program gets the
  //                interrupt (D2 b); a Claude the gate (D11 step 1), then
  //                the interrupt when working or blocked (step 2), or its
  //                prompt line and /exit (steps 3–4)
  //   interrupted  a Claude: looked at until Core reads idle or done, for
  //                INTERRUPT_DEADLINE_MS, then steps 3–4
  //   program      another program after its interrupt: the shell back in
  //                front within PROGRAM_GRACE_MS, else the hang-up
  //   hup          after the hang-up: the shell back within the grace, else counted
  async advance(job, cur) {
    const address = cur.address;
    const [t] = await this.freshTerminals([address]);
    if (!t) return cur.phase === "start" ? "skip" : "done";
    const fail = (why) => {
      job.failed.push({ address, why });
      this.log(`${address}: left running: ${why}`);
      return "done";
    };
    if (cur.phase === "start") {
      const kind = kindOf(t, { record: own(this.records, address), claude: isClaudeCodeTerminal(t) });
      if (UNTOUCHED.includes(kind)) return "skip";
      if (kind === "program") {
        await this.interrupt(address);
        cur.phase = "program";
        cur.at = this.d.now();
        return "wait";
      }
      const gate = await this.gateClaude(t);
      if (!gate.ok) return fail(gate.why);
      const status = statusWord(t.status);
      if (status === "working" || status === "blocked") {
        await this.interrupt(address);
        cur.phase = "interrupted";
        cur.at = this.d.now();
        cur.wake = true;
        return "wait";
      }
      if (status !== "idle" && status !== "done") return fail(`Claude's status is ${status ?? "unknown"}`);
      return this.claudeExit(t, gate, cur, fail);
    }
    if (cur.phase === "interrupted") {
      const status = statusWord(t.status);
      if (status === "idle" || status === "done") {
        const gate = await this.gateClaude(t);
        return gate.ok ? this.claudeExit(t, gate, cur, fail) : fail(gate.why);
      }
      if (foregroundIsShell(t)) return "done"; // it ended on its own
      return this.d.now() - cur.at >= INTERRUPT_DEADLINE_MS ? fail("still working 10 s after the interrupt") : "wait";
    }
    // Another program (D2 b). Core may still show it right after an
    // interrupt that worked (T0b item 7), so it gets the grace first.
    if (foregroundIsShell(t)) return "done";
    if (this.d.now() - cur.at < PROGRAM_GRACE_MS) return "wait";
    if (cur.phase === "hup") {
      return fail(cur.signalled ? "still running after SIGHUP" : "still in front, in the shell's own process group");
    }
    const hup = await this.hangUp(t);
    if (hup.error) return fail(hup.error);
    cur.phase = "hup";
    cur.at = this.d.now();
    cur.signalled = hup.signalled;
    return "wait";
  }

  // `hc interrupt <t> --timeout 3 --json`: the stop key, watched for 3 s. Its
  // report decides nothing (T0b item 7: `stopped` with the program still in
  // front, `unknown` with it gone later); Core is looked at afterwards.
  async interrupt(address) {
    const r = await this.call(interruptArgs(address));
    this.log(`${address}: interrupt ${r.code === 0 ? r.stdout.trim() : `failed (${(r.stderr || r.stdout || "").trim()})`}`);
    return r;
  }

  // D2 (b): SIGHUP to the terminal's foreground process group, as a closing
  // terminal sends. Core's `foreground` is a pid, so the group comes from
  // `ps` on the root shell, and the signal goes only to a group that isn't the
  // shell's own (so the shell is never signalled; T0b item 5: the job ends,
  // the shell comes back in front, the terminal stays).
  // → { signalled } or { error }.
  async hangUp(t) {
    if (!Number.isInteger(t.pid) || t.pid <= 0) return { error: "no root pid to find its process group" };
    const r = await this.run("ps", ["-o", "pgid=,tpgid=", "-p", String(t.pid)]);
    const groups = r.code === 0 ? processGroups(r.stdout) : null;
    if (groups === null) return { error: "its process group couldn't be read" };
    const group = hangUpGroup(groups);
    if (group === null) {
      this.log(`${t.address}: no signal, the shell's own process group is in front`);
      return { signalled: false };
    }
    const k = await this.run("kill", ["-HUP", "--", `-${group}`]);
    if (k.code !== 0) return { error: `SIGHUP not sent (${(k.stderr || k.stdout || "").trim()})` };
    this.log(`${t.address}: SIGHUP to process group ${group}`);
    return { signalled: true };
  }

  // D11 steps 3–4, once Core reads idle or done. Its prompt line: empty
  // exits; text gets one ctrl+c and must then be empty or, hidden, what the
  // probe calls a suggestion; anything else, or text still on a shown
  // terminal, means no /exit (it would reach Claude as "<text>/exit"). Then
  // the record `stopping` (by: "manual", wake: "now" for one that was
  // working), Core read once more, and /exit as stop() sends it (`--if idle`
  // when Core says idle), whose tail writes asleep once the shell is back.
  async claudeExit(t, gate, cur, fail) {
    const address = t.address;
    const name = t.foreground.name;
    let screen = await this.read(address);
    let next = promptStep(readPrompt(screen, name), { visible: this.isVisible(address), cleared: false });
    if (next === "refuse") return fail("its prompt line couldn't be read");
    if (next === "clear") {
      const sent = await this.call(["keys", address, CLEAR_KEY]);
      if (sent.code !== 0) return fail(`its prompt line wasn't cleared (${(sent.stderr || sent.stdout || "").trim()})`);
      screen = await this.read(address);
      for (let i = 1; i < PROBE_READS && readPrompt(screen, name).state !== "empty"; i++) {
        await this.sleep(PROBE_WAIT_MS); // Claude redrawing
        screen = await this.read(address);
      }
      next = promptStep(readPrompt(screen, name), { visible: this.isVisible(address), cleared: true });
      if (next === "probe") next = (await this.probe(address, screen)) === "suggestion" ? "exit" : "refuse";
      if (next !== "exit") return fail(this.isVisible(address) ? "text still on its prompt line, on screen" : "its draft didn't clear");
    }
    const { session, res } = gate;
    const record = {
      state: "stopping",
      sessionId: session.sessionId,
      cwd: res.cwd,
      flags: res.flags,
      configDir: res.configDir,
      workspacePath: await this.workspaceOf(res.cwd, { fresh: true }),
      rssKb: await this.rssKb(t.foreground.pid),
      rootPid: Number.isInteger(t.pid) ? t.pid : null,
      holder: await this.holder(),
      at: this.d.now(),
      by: "manual",
      ...(cur.wake ? { wake: "now" } : {}),
    };
    let previous = own(this.records, address);
    if (!(await this.save(withRecord(this.records, address, record)))) {
      previous = own(this.records, address); // the file as it is now
      if (previous?.state === "asleep" || previous?.state === "stopping") return "done"; // another stop got there
      if (!(await this.save(withRecord(this.records, address, record)))) return fail("sleeping.json changed under it");
    }
    const undo = async () => {
      await this.save(previous ? withRecord(this.records, address, previous) : withoutRecord(this.records, address));
    };
    const fresh = await this.getTerminal(address);
    const core = statusWord(fresh?.status);
    if (!isObject(fresh?.foreground) || fresh.foreground.pid !== t.foreground.pid || (core !== "idle" && core !== "done")) {
      await undo();
      return fail("Claude started again before /exit");
    }
    const sent = await this.call(core === "idle" ? ["send", "--if", "idle", address, "/exit"] : ["send", address, "/exit"]);
    if (sent.code !== 0) {
      await undo();
      return fail(`/exit not sent (${(sent.stderr || sent.stdout || "").trim()})`);
    }
    this.log(`${address}: /exit sent (manual, its workspace's sleep)`);
    return "done";
  }

  // D10 step 6: the listed tabs that came back are settled again, then the
  // entry is asleep. One shown again mid-sleep (wakeAfter) is woken here
  // instead, and not put away (D4).
  async finishSleep(path) {
    const entry = own(this.workspaces, path);
    if (!entry || entry.state !== "sleeping") return;
    if (entry.wakeAfter === true) return this.wakeWorkspace(path);
    for (const id of tabsToSettle(entry, this.safe(() => list(this.d.live.spaces()), []))) this.herdr("tab.settle", { id });
    const saved = await this.updateEntries((entries) => {
      const cur = own(entries, path);
      return cur?.state === "sleeping" && cur.wakeAfter !== true ? withEntry(entries, path, { ...cur, state: "asleep" }) : null;
    });
    if (saved) this.lastEvent = `${basename(path) || path} asleep`;
  }

  // D4's wake, in one pulse: every tab the entry lists comes back
  // (tab.unsettle: a space.select brings none back, T0), each Claude asleep
  // with wake: "now" (working or blocked when it went to sleep) is resumed at
  // once, shown or not, and the entry is dropped, which lifts the reveal
  // path's skip: the rest resume when their tab shows, this pulse's reveal
  // included. Both resumes go through resume(): a bare prompt, its account,
  // claimed before anything is typed. A wake: "now" one that can't be resumed
  // yet (a typed shell line, another program in front) waits for its tab as
  // the rest do. A reload before the drop leaves an entry with its tabs back,
  // which D9's rule 2 drops at start.
  async wakeWorkspace(path) {
    const entry = own(this.workspaces, path);
    if (!entry) return;
    const label = basename(path) || path;
    const { unsettle, now } = wakePlan(entry, {
      spaces: this.safe(() => list(this.d.live.spaces()), []),
      panes: this.safe(() => list(this.d.live.panes()), []),
      records: this.records,
    });
    for (const id of unsettle) this.herdr("tab.unsettle", { id });
    let resumed = 0;
    for (const address of now) if (await this.resume(address, "wake")) resumed += 1;
    delete this.jobs[path];
    const saved = await this.updateEntries((entries) => (own(entries, path) ? withoutEntry(entries, path) : null));
    this.log(`${path}: woken, ${unsettle.length} tab(s) back, ${resumed} of ${now.length} wake: "now" Claude(s) resumed${saved ? "" : " (workspaces.json not written)"}`);
    if (resumed === 0) this.lastEvent = `${label} awake`; // a resume says "Woke <label>" itself
  }

  // Terminals as Core has them now, in the order asked, those it still has.
  async freshTerminals(addresses) {
    const want = new Set(addresses);
    const byAddress = new Map((await this.gather({ only: want })).filter((t) => want.has(t.address)).map((t) => [t.address, t]));
    return addresses.filter((a) => byAddress.has(a)).map((a) => byAddress.get(a));
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

  // D15: the folders a Claude's session file can be in (~/.claude, the saved
  // accounts', the profile folders), listed once per tick. Between ticks
  // (Sleep now, a stop) the tick's list is used: an account added since waits
  // for the next tick, so it fails closed.
  async listConfigDirs() {
    this.configDirs = await loadConfigDirs(
      { home: this.d.home, appHome: this.d.appHome },
      { readText: (path) => this.d.files.read(path), exec: (cmd, args) => this.d.exec(cmd, args) },
    );
    return this.configDirs;
  }

  // D3 for every local Claude in front of its terminal, in whichever account
  // folder holds its session file (D15).
  async sessionsOf(terminals) {
    const sessions = {};
    let configDirs = this.configDirs;
    for (const t of terminals) {
      if (!isLocal(t) || t.state !== "live" || !isObject(t.foreground) || !isClaudeName(t.foreground.name)) continue;
      if (configDirs === null) configDirs = await this.listConfigDirs();
      const s = await loadSession(
        { home: this.d.home, pid: t.foreground.pid, foregroundName: t.foreground.name, configDirs },
        { readText: (path) => this.d.files.read(path), exec: (cmd, args) => this.execFind(cmd, args) },
      );
      if (s.ok) {
        sessions[t.address] = { sessionId: s.sessionId, transcript: s.transcript !== null, cwd: s.cwd, status: s.status, configDir: s.configDir };
      }
    }
    return sessions;
  }

  // A transcript found once stays found: `find` over a config dir's
  // projects/ runs once per session id and folder, not once per Claude per
  // tick.
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

  // D4's re-read of the session file, in the record's account folder (D15):
  // its status, if it still names this session.
  async fileStatus(pid, sessionId, configDir = null) {
    const path = sessionFilePath(this.d.home, pid, configDir);
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

  // One of Herdr's commands (run(): tab.settle, tab.unsettle). They apply
  // right after the call returns; a failure is logged, never thrown.
  herdr(name, args) {
    try {
      this.d.herdrRun(name, args);
      return true;
    } catch (e) {
      this.log(`${name} ${JSON.stringify(args)} failed: ${e}`);
      return false;
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

  // workspaces.json (workspace-sleep D9); a bad file is kept as .bak.
  async loadEntries() {
    try {
      const { entries, text } = await loadWorkspaces(this.io(), this.wp);
      this.workspaces = entries;
      this.workspacesText = text ?? null;
    } catch (e) {
      this.log(`workspaces.json unreadable: ${e}`);
    }
  }

  // Its compare-and-swap save: false, with the file read again, on a stale snapshot.
  async saveEntries(next) {
    if (next === this.workspaces) return true;
    try {
      this.workspacesText = await saveWorkspaces(this.io(), this.wp, next, this.workspacesText);
      this.workspaces = next;
      return true;
    } catch (e) {
      this.log(`workspaces.json changed under it, reloaded: ${e}`);
      await this.loadEntries();
      return false;
    }
  }

  // A change to workspaces.json: `change(entries)` → the new entries, or null
  // for none. On a stale snapshot the file is read again and the change made
  // once more on what it says now (another write kept, not undone).
  async updateEntries(change) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = change(this.workspaces);
      if (next === null || next === undefined) return false;
      if (await this.saveEntries(next)) return true;
    }
    return false;
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
