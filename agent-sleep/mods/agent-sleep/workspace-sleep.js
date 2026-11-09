// Sleeping a whole workspace, as Orca's right-click "Sleep" does, but
// without closing it (workspace-sleep D2): its Claudes end and come back
// with `claude --resume`, its other programs are stopped, and its tabs are
// put away (`tab.settle`), so its splits, sizes, scrollback and terminal
// addresses are all still there when it wakes. Pure: no herdr import, no
// I/O, no clock. The coordinator gathers the evidence, runs the steps across
// pulses and keeps their state in workspaces.json (workspaces-store.js).
//
// The order of a sleep (D10), so nobody sees half a sleep and nothing undoes it:
//   1. work in flight (D5, flightOf) is checked, and the person is asked;
//   2. the entry is written `sleeping`, with its spaces (D12) and their tabs;
//   3. every tab is settled, in the same pulse as 2. projects-sidebar then
//      draws the row asleep and its keeper shows Inicio (D3, D7);
//   4. the stops wait until none of its spaces is shown, for up to
//      WAIT_PULSES pulses; one still shown marks `shownAtSleep` (D4);
//   5. one terminal's step per pulse (kindOf): a Claude through the forced
//      manual stop (D11), another program through an interrupt and then a
//      hang-up (D2 b), anything else left alone;
//   6. the tabs that came back are settled again, and the entry becomes
//      `asleep`; a click mid-sleep (`wakeAfter`) wakes it instead.
// A step that fails leaves its terminal running, and a toast names it
// (didntStopNotice).
//
// The wake (D4), when the person comes back to it (cameBack): every tab it
// lists comes back, the Claudes that were working resume at once, the rest
// when their tab shows, and the entry goes (wakePlan). Until then the reveal
// path and Wake all leave its terminals alone (sleptTerminals), and
// agent-sleep's moon stays off its row (D3).

import { isShellRoot } from "./rules.js";
import { foregroundIsShell } from "./store.js";
import { isClaudeName } from "./claude-session.js";
import { listedTabs } from "./workspaces-store.js";

// The bare command: it sleeps the shown workspace (D5 b).
export const SLEEP_WORKSPACE = "sleep-workspace";
// D10 step 4: how many pulses the stops wait for no space of it to be shown.
export const WAIT_PULSES = 3;
// D11 step 2: `hc interrupt <t> --timeout 3 --json`, then Core is looked at on
// later pulses until it reads idle or done, for this long at most.
export const INTERRUPT_TIMEOUT_S = 3;
export const INTERRUPT_DEADLINE_MS = 10_000;
// D2 (b): after another program's interrupt, and again after its hang-up,
// Core gets this long to show the shell in front. T0b item 7: `sleep` was
// still in front right after an interrupt that worked, and zsh 2 s later.
export const PROGRAM_GRACE_MS = 3_000;
// D11 step 3: what clears Claude's prompt line, a one-line draft, a
// multi-line one or the prompt an interrupt put back (T0b item 4).
export const CLEAR_KEY = "ctrl+c";

export const interruptArgs = (address) => ["interrupt", address, "--timeout", String(INTERRUPT_TIMEOUT_S), "--json"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const isAddress = (a) => typeof a === "string" && a !== "" && a !== "__proto__";
const isAbsolute = (p) => typeof p === "string" && (p.startsWith("/") || /^[A-Za-z]:\//.test(p));

// ── D12: which spaces are a workspace's ─────────────────────────────────────

// projects-sidebar's rule, so the two plugins agree (agent-sleep never
// imports across plugins, D1). Ported from its placeOf
// (projects-sidebar/mods/projects/lib.js:52-56) the way resume.js ports
// Claude's rjo(): a space is where its first pane with a folder is, in
// panes() order, else the folder it was made in. D12 adds: a space with no
// terminal pane is nobody's (Inicio, even if its folder were a checkout).
// `~` is expanded with `home`, as its normPath does (lib.js:36-41).
export function placeOf(space, panes, home) {
  if (!isObject(space)) return null;
  const tabs = new Set(list(space.tabs).map((t) => t?.id));
  const mine = list(panes).filter((p) => isObject(p) && tabs.has(p.tab));
  if (!mine.some((p) => isAddress(p.terminal))) return null;
  const place = mine.find((p) => p.cwd)?.cwd || space.folder || null;
  if (typeof place !== "string") return null;
  return home && (place === "~" || place.startsWith("~/")) ? `${String(home).replace(/\/+$/, "")}${place.slice(1)}` : place;
}

// This computer's spaces with an absolute place, as matchSpaces takes them
// (lib.js:487-499): [{ id, place }]. The coordinator maps each place to the
// deepest worktree of its own `git worktree list` (workspaceOf), and the
// spaces whose worktree is the workspace are its spaces. The known limit
// (D12, RECIPE): projects-sidebar takes the deepest *registered* checkout
// instead, so a space inside a submodule or a nested repo can get two answers.
export function localPlaces(spaces, panes, home) {
  const out = [];
  for (const space of list(spaces)) {
    if (!isObject(space) || !isAddress(space.id) || (space.machine ?? null) !== null) continue;
    const place = placeOf(space, panes, home);
    if (isAbsolute(place)) out.push({ id: space.id, place });
  }
  return out;
}

// The space shown now, or null.
export function shownSpace(spaces) {
  return list(spaces).find((s) => isObject(s) && s.active === true) ?? null;
}

// D10 step 2's `spaces`: each space's tabs, all of them (D2 c).
export function entrySpaces(spaces, ids) {
  const out = {};
  for (const space of list(spaces)) {
    if (!isObject(space) || !ids.includes(space.id)) continue;
    out[space.id] = list(space.tabs).map((t) => t?.id).filter(isAddress);
  }
  return out;
}

// ── D2: what each terminal gets ─────────────────────────────────────────────

// Left alone (D2 "What is never touched", and what has nothing to stop):
//   remote          on another machine
//   not-live        Core says it finished
//   sub-agent       another terminal started it (`parent`)
//   root-not-shell  its own program isn't a shell: ending it would end the
//                   terminal, close its pane and maybe the space (H/AGENTS.md:122-133)
//   asleep          its Claude is asleep already, or exiting (idempotent: a
//                   reload plans the stops again)
//   no-foreground   Core doesn't say what is in front: no evidence
//   shell           its shell is in front: nothing to stop
// A terminal without a pane (background ones, Spotlight's server) is in no
// tab, so it never gets here.
export const UNTOUCHED = Object.freeze(["remote", "not-live", "sub-agent", "root-not-shell", "asleep", "no-foreground", "shell"]);

// → one of UNTOUCHED, "claude" (D11's forced stop) or "program" (D2 b).
// `claude`: the coordinator's isClaudeCodeTerminal(t), so a Claude Code whose
// process isn't called claude is still a Claude: one that can't come back
// keeps running, never hung up on as an "other program" (D2 a). `record`:
// its sleeping.json record, if any.
export function kindOf(t, { record, claude = false } = {}) {
  if (!isObject(t) || !isAddress(t.address)) return "not-live";
  if (t.address.includes("/")) return "remote";
  if (t.state !== "live") return "not-live";
  if (t.parent !== null && t.parent !== undefined) return "sub-agent";
  if (!isShellRoot(t.argv)) return "root-not-shell";
  const state = isObject(record) ? record.state : null;
  if (state === "asleep" || state === "stopping") return "asleep";
  if (!isObject(t.foreground)) return "no-foreground";
  if (foregroundIsShell(t)) return "shell";
  if (claude || isClaudeName(t.foreground.name)) return "claude";
  return "program";
}

// ── D5: work in flight ──────────────────────────────────────────────────────

// One Claude that would be stopped, before anything changes:
//   "working"  Core says working or blocked
//   "clear"    its prompt line is empty
//   "probe"    one line of text on a hidden terminal: agent-sleep's probe
//              (D5 there) tells a draft from a suggestion
//   "text"     anything else: text where the person can see it (plain text
//              can't tell a draft from a suggestion, and the probe never
//              types there), a multi-line draft, a dialog, a screen it can't read
// The coordinator counts working, text, and a probe that didn't say
// "suggestion"; any count asks first.
export function flightOf({ status, prompt, visible }) {
  if (status === "working" || status === "blocked") return "working";
  if (!isObject(prompt) || prompt.program !== "claude") return "text";
  if (prompt.state === "empty") return "clear";
  if (prompt.state === "text" && visible !== true) return "probe";
  return "text";
}

// ── D11 step 3: the prompt line before /exit ────────────────────────────────

// → "exit" (empty: step 4), "clear" (text before the ctrl+c: press it),
// "probe" (text after it, on a hidden terminal: only a suggestion lets it
// exit) or "refuse" (no /exit: `/exit` after "hola" would reach Claude as
// "hola/exit", agent-sleep's J-001 class).
export function promptStep(prompt, { visible, cleared }) {
  if (!isObject(prompt) || prompt.program !== "claude") return "refuse";
  if (prompt.state === "empty") return "exit";
  if (!cleared) return prompt.state === "text" || prompt.state === "draft" ? "clear" : "refuse";
  return prompt.state === "text" && visible !== true ? "probe" : "refuse";
}

// ── D2 (b): the hang-up ─────────────────────────────────────────────────────

// `ps -o pgid=,tpgid= -p <root pid>` → { pgid, tpgid }, or null for anything
// that isn't two integers. Core's `foreground` gives a pid, not a group.
export function processGroups(stdout) {
  if (typeof stdout !== "string") return null;
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
  const [pgid, tpgid] = parts.map(Number);
  return { pgid, tpgid };
}

// The group SIGHUP goes to: the terminal's foreground one, only when it
// isn't the root shell's own (so the shell is never signalled) and there is
// one (tpgid 0 or -1: no controlling terminal). Null: no signal.
export function hangUpGroup(groups) {
  if (!isObject(groups) || !Number.isInteger(groups.pgid) || !Number.isInteger(groups.tpgid)) return null;
  return groups.tpgid > 0 && groups.tpgid !== groups.pgid ? groups.tpgid : null;
}

// ── D4: the shown edge ──────────────────────────────────────────────────────

// The spaces shown now, and those that went from not shown to shown since
// `previous` (the last pulse's `shown`). Null `previous` (the first look
// after a start or a reload): no edges.
export function shownEdges(previous, spaces) {
  const shown = new Set(list(spaces).filter((s) => isObject(s) && s.active === true && isAddress(s.id)).map((s) => s.id));
  const edges = new Set();
  if (previous instanceof Set) for (const id of shown) if (!previous.has(id)) edges.add(id);
  return { shown, edges };
}

// Whether the person just came back to the entry's workspace, from the last
// pulse's `previous` and `shown` now (shownEdges). A wake reacts to a change,
// never to a state (D4, R1#2): one of its spaces went from not shown to shown,
// whichever (the row's click selects only one, R2#3). The first look after a
// start or a reload never does. One still shown when its stops began
// (`shownAtSleep`, D10 step 4) comes back only once none of its spaces was
// shown at the last pulse: looking on at it, or moving to another of its
// spaces, never undoes the sleep. The coordinator wakes an asleep entry, and
// marks a sleeping one `wakeAfter`.
export function cameBack(entry, { previous, shown } = {}) {
  if (!(previous instanceof Set) || !(shown instanceof Set) || !isObject(entry?.spaces)) return false;
  const ids = Object.keys(entry.spaces);
  const now = ids.filter((id) => shown.has(id));
  if (now.length === 0) return false;
  if (entry.shownAtSleep === true) return !ids.some((id) => previous.has(id));
  return now.some((id) => !previous.has(id));
}

// Every terminal in a space an entry lists, a tab opened in it since
// included: what a workspace's sleep holds until its wake. The reveal path and
// Wake all leave them alone (D4: no undo of a sleep, R1#5), and agent-sleep's
// moon stays off them (D3: projects-sidebar draws the row's own).
export function sleptTerminals(entries, spaces, panes) {
  const ids = new Set();
  const tabs = new Set();
  for (const e of Object.values(isObject(entries) ? entries : {})) {
    if (!isObject(e?.spaces)) continue;
    for (const [id, listed] of Object.entries(e.spaces)) {
      ids.add(id);
      for (const tab of list(listed)) tabs.add(tab);
    }
  }
  for (const space of list(spaces)) {
    if (isObject(space) && ids.has(space.id)) for (const t of list(space.tabs)) if (isObject(t)) tabs.add(t.id);
  }
  const out = new Set();
  for (const p of list(panes)) if (isObject(p) && tabs.has(p.tab) && isAddress(p.terminal)) out.add(p.terminal);
  return out;
}

// D4's wake, steps 1–2: `unsettle`, every tab the entry lists that still
// exists, in its spaces' order (T0: a space.select brings none back, a
// tab.select only its own); `now`, the Claudes of its terminals asleep with
// `wake: "now"` (working or blocked when it went to sleep), resumed at once.
// The rest resume when their tab shows (step 3, the reveal path), and the
// coordinator drops the entry (step 4).
export function wakePlan(entry, { spaces, panes, records } = {}) {
  const listed = new Set(listedTabs(entry));
  const unsettle = [];
  for (const space of list(spaces)) {
    if (!isObject(space) || !Object.hasOwn(entry?.spaces ?? {}, space.id)) continue;
    for (const t of list(space.tabs)) if (isObject(t) && listed.has(t.id)) unsettle.push(t.id);
  }
  const record = (a) => (isObject(records) && Object.hasOwn(records, a) ? records[a] : null);
  const now = [...sleptTerminals({ entry }, spaces, panes)].filter((a) => record(a)?.state === "asleep" && record(a).wake === "now");
  return { unsettle, now };
}

// ── D10 step 6 ──────────────────────────────────────────────────────────────

// The listed tabs that came back (Herdr brings a settled tab back when an
// agent in it needs the person: an interrupt does it, T0b item 8) and still exist.
export function tabsToSettle(entry, spaces) {
  const listed = new Set(listedTabs(entry));
  const out = [];
  for (const space of list(spaces)) {
    if (!isObject(space) || !Object.hasOwn(entry?.spaces ?? {}, space.id)) continue;
    for (const t of list(space.tabs)) if (isObject(t) && listed.has(t.id) && t.settled !== true) out.push(t.id);
  }
  return out;
}

// D10's toast for the terminals a sleep left running ({ address, why }), or
// null when every one stopped.
export function didntStopNotice(label, failed) {
  const n = list(failed).length;
  if (n === 0) return null;
  return {
    title: `${label}: ${n} terminal${n === 1 ? "" : "s"} didn't stop`,
    body: failed.map((f) => `${f.address}: ${f.why}`).join(" · "),
    level: "warning",
  };
}

// ── The commands ────────────────────────────────────────────────────────────

// The confirm's answers (D5) name the question they answer, so a click on an
// older confirm never answers a newer one. They come as agent-sleep's
// requests do (agent-sleep D14: the copy that opened the popup, once).
const CONFIRM = "confirm-sleep.";
const CANCEL = "cancel-sleep.";
const QUESTION_ID = /^[A-Za-z0-9-]{1,64}$/;

export const answerCommand = (question, yes) => `${yes ? CONFIRM : CANCEL}${question}`;

// → { kind: "sleep" } | { kind: "answer", question, yes } | null.
export function parseWorkspaceCommand(name) {
  if (typeof name !== "string") return null;
  if (name === SLEEP_WORKSPACE) return { kind: "sleep" };
  for (const [prefix, yes] of [[CONFIRM, true], [CANCEL, false]]) {
    if (!name.startsWith(prefix)) continue;
    const question = name.slice(prefix.length);
    return QUESTION_ID.test(question) ? { kind: "answer", question, yes } : null;
  }
  return null;
}
