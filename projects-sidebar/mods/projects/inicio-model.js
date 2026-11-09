// Inicio and its keeper (workspace-sleep D6, D7), with no herdr or gpui-kit
// imports so `node --test` can load it. Inicio is a space of this mod's own,
// in the home folder, whose only tab is this mod's `inicio` view: Orca's
// Landing. The keeper, a 1 px copy in the status row (keeper.js), keeps it
// right after the shown space, so closing the shown space by any path lands
// on it (Herdr shows the space now at the closed one's index, T0), and
// selects it when the shown space is put away or vanishes. Here: which stored
// id is Inicio, making it with the herdr side passed in (as tree-model.js
// addProjectAt), where it goes, when to select it, the guards on its moves,
// the space keys that skip it, and what the view says.

import { MOD } from "./config.js";

// ── Which space is Inicio (D6) ─────────────────────────────────────────────

export const INICIO_NAME = "Inicio";
export const INICIO_VIEW = "inicio";

// `projects.inicio.v1` (lib.js KEYS.inicio): { space: <id> }, the space the
// keeper made. Anything else reads as none.
export function parseInicio(value) {
  const ok = typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.space === "string" && value.space !== "";
  return ok ? value.space : null;
}

export const inicioValue = (id) => (typeof id === "string" && id ? { space: id } : null);

const local = (space) => (space?.machine ?? null) === null;

// The panes in a space's tabs (`panes`: panes(), read once).
function panesOf(space, panes) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  return (panes ?? []).filter((p) => tabs.has(p.tab));
}

// This mod's view, and a terminal (panes() gives a mod pane no terminal).
const isView = (p) => !p.terminal && p.mod === MOD;
const isTerminal = (p) => Boolean(p.terminal);

// D6: the stored id counts as Inicio while its space exists, is on this
// computer and holds a pane of this mod. panes() exposes no props, so the
// view itself can't be told from another of this mod's panes.
export function validInicio(id, spaces, panes) {
  const space = (spaces ?? []).find((s) => s.id === id);
  return Boolean(id) && Boolean(space) && local(space) && panesOf(space, panes).some(isView);
}

// A half-made Inicio, in the shape only the making leaves it: named Inicio,
// on this computer, its first tab a lone terminal (space.new's) and its last
// one the view alone (tab.new's), or, finished, the view's tab alone. A
// person's terminal tab comes after the view (Cmd+T appends), so a space
// shaped any other way is never taken for one and none of its terminals is
// closed. The terminal tabs to close, or null when it isn't one.
function halfMade(space, panes) {
  if (!local(space) || !space.named || space.name !== INICIO_NAME) return null;
  const tabs = (space.tabs ?? []).map((t) => panes.filter((p) => p.tab === t.id));
  const viewTab = (ps) => ps.length === 1 && isView(ps[0]);
  const shellTab = (ps) => ps.length === 1 && isTerminal(ps[0]);
  if (tabs.length === 1 && viewTab(tabs[0])) return [];
  if (tabs.length === 2 && shellTab(tabs[0]) && viewTab(tabs[1])) return [space.tabs[0].id];
  return null;
}

// What the stored id and the spaces say, first match winning:
//   ok     the stored Inicio, holding no terminal pane;
//   taken  the stored Inicio with a terminal pane anywhere in it (a tab from
//          Cmd+T or code-tabs' "+", a split beside the view): an ordinary
//          space now, given back (R2#1);
//   stale  a stored id that is neither: forgotten;
//   half   no stored id, and a space half-made or finished but not stored
//          (a reload between the making's steps): `close`, its terminal tabs;
//   none   nothing: Inicio is made.
export function inicioState({ stored, spaces, panes }) {
  const all = spaces ?? [];
  const ps = panes ?? [];
  if (stored) {
    const space = all.find((s) => s.id === stored);
    if (space && local(space) && panesOf(space, ps).some(isTerminal)) return { kind: "taken", space };
    if (validInicio(stored, all, ps)) return { kind: "ok", space };
    return { kind: "stale" };
  }
  for (const space of all) {
    const close = halfMade(space, ps);
    if (close) return { kind: "half", space, close };
  }
  return { kind: "none" };
}

// D6 step 1: home() as its folder, or a mod pane, having no cwd, would leave
// the space in the focused terminal's folder, a worktree's space (R2#1); ""
// is this computer, or a focused remote space's machine would be used.
export const spaceNewArgs = (home) => ({ name: INICIO_NAME, folder: home, machine: "" });

// A command lands a moment after run() returns: read back this often, for at
// most this long (as delete-workspace.js waits on space.close).
export const READ_STEP = 50;
export const READ_WAIT = 3000;

async function readBack(io, find) {
  for (let waited = 0; ; waited += READ_STEP) {
    const found = find();
    if (found) return found;
    if (waited >= READ_WAIT) return null;
    await io.sleep(READ_STEP);
  }
}

const byId = (io, id) => io.spaces().find((s) => s.id === id) ?? null;

// D6's given-back Inicio: its view closed (seen gone before anything else,
// or its terminals could later read as a half-made Inicio's), its name given
// back while it is still the one Inicio got, the id forgotten. False when
// the view didn't close: the id stays, and the next look tries again.
async function giveBack(space, io) {
  for (const p of panesOf(space, io.panes()).filter(isView)) io.run("pane.close", { pane: p.pane });
  const closed = await readBack(io, () => {
    const now = byId(io, space.id);
    return !now || !panesOf(now, io.panes()).some(isView);
  });
  if (!closed) return false;
  const now = byId(io, space.id);
  if (now?.named && now.name === INICIO_NAME) io.run("space.rename", { id: space.id, name: "" });
  io.store(null);
  return true;
}

// A half-made Inicio finished: its terminal tab closed, then its id stored.
async function finish(half, io) {
  for (const id of half.close) io.run("tab.close", { id, confirmed: true });
  const done = await readBack(io, () => {
    const now = byId(io, half.space.id);
    return now && !now.tabs.some((t) => half.close.includes(t.id)) ? now : null;
  });
  if (!done) return false;
  io.store(half.space.id);
  return true;
}

// D6's making: space.new; the new space and its terminal tab read back from
// spaces() (run() returns null); tab.new with the view, read back again; the
// terminal tab closed; the id stored. space.new showed Inicio, so the space
// shown before is shown again, unless `stay` (the keeper is selecting
// Inicio). A view that never shows closes the space just made, so a failure
// leaves nothing behind.
async function make(io, stay) {
  const before = io.spaces();
  const ids = new Set(before.map((s) => s.id));
  const shown = before.find((s) => s.active)?.id ?? null;
  const back = () => {
    if (!stay && shown && byId(io, shown)) io.run("space.select", { id: shown });
  };
  io.run("space.new", spaceNewArgs(io.home));
  const made = await readBack(io, () => io.spaces().find((s) => !ids.has(s.id) && local(s) && s.name === INICIO_NAME) ?? null);
  if (!made) return null;
  const shells = made.tabs.map((t) => t.id);
  io.run("tab.new", { space: made.id, mod: MOD, props: { view: INICIO_VIEW } });
  const withView = await readBack(io, () => {
    const now = byId(io, made.id);
    return now && panesOf(now, io.panes()).some(isView) ? now : null;
  });
  if (!withView) {
    io.run("space.close", { id: made.id, confirmed: true });
    back();
    return null;
  }
  for (const id of shells) io.run("tab.close", { id, confirmed: true });
  const clean = await readBack(io, () => {
    const now = byId(io, made.id);
    return now && !now.tabs.some((t) => shells.includes(t.id)) ? now : null;
  });
  // Not closed yet: it is a half-made Inicio, which the next look finishes.
  if (!clean) return null;
  io.store(made.id);
  back();
  return { id: made.id, made: true };
}

// Makes sure Inicio exists: gives back a taken one, forgets a stale id,
// finishes a half-made one, else makes it. `io`, the herdr side:
//   { stored(), store(id | null), run(name, args), spaces(), panes(), home, sleep(ms) }
// Resolves { id, made } once Inicio is there, null when a step didn't land
// (the next look tries again). `stay`: see make().
export async function ensureInicio(io, { stay = false } = {}) {
  for (let round = 0; round < 4; round += 1) {
    const st = inicioState({ stored: io.stored(), spaces: io.spaces(), panes: io.panes() });
    if (st.kind === "ok") return { id: st.space.id, made: false };
    if (st.kind === "stale") io.store(null);
    else if (st.kind === "taken") {
      if (!(await giveBack(st.space, io))) return null;
    } else if (st.kind === "half") {
      if (!(await finish(st, io))) return null;
    } else return make(io, stay);
  }
  return null;
}

// ── The keeper's look and when it selects Inicio (D7) ──────────────────────

// tree-model.js putAway (`:75-77`): every tab of the space put away
// (`tab.settle`); a space with no tabs listed isn't one. The shown space's
// own state, not D3's workspace rule, which knows only spaces inside
// registered projects (R2 suggestion 1).
export function putAway(space) {
  const tabs = space?.tabs ?? [];
  return tabs.length > 0 && tabs.every((t) => t.settled === true);
}

// What the keeper remembers from a look: the shown space, whether it is put
// away, and the order.
export function look(spaces) {
  const all = spaces ?? [];
  const shown = all.find((s) => s.active) ?? null;
  return { shown: shown?.id ?? null, putAway: shown ? putAway(shown) : false, ids: all.map((s) => s.id) };
}

// Whether to select Inicio, from the last look and this one. It reacts to a
// change, never to a state (R1#2):
//   the same shown space went from not put away to put away → yes;
//   the shown space it remembered is gone and another is shown → yes, the
//   fallback if Herdr ever stops landing on the space after (a flash, then
//   Inicio). That includes Inicio itself closed: a new one is shown, never
//   the next worktree (S10);
//   a space that becomes shown already put away (a click, the picker) → no:
//   agent-sleep wakes it (D4);
//   no last look (a reload), or Inicio shown → no.
// `inicio`: Inicio's id now, or null while there is none.
export function shouldSelect(last, now, inicio) {
  if (!last?.shown || !now?.shown || now.shown === inicio) return false;
  if (now.shown === last.shown) return !last.putAway && now.putAway;
  return !now.ids.includes(last.shown);
}

// ── Where Inicio goes (D7) ─────────────────────────────────────────────────

// The 1-based index (space.move: "1 = first", the final position) that puts
// Inicio right after the shown space, counted in the order without Inicio,
// so it holds whichever side Inicio is on now. null when nothing moves:
// Inicio already there, Inicio or a remote space shown (Inicio can't sit in
// another machine's block: closing it falls back on shouldSelect), no shown
// space, or no Inicio.
export function targetIndex(spaces, inicio) {
  const all = spaces ?? [];
  const at = all.findIndex((s) => s.id === inicio);
  const shown = all.find((s) => s.active);
  if (at < 0 || !shown || shown.id === inicio || !local(shown)) return null;
  const index = all.filter((s) => s.id !== inicio).indexOf(shown) + 2;
  return index === at + 1 ? null : index;
}

// ── Space keys that skip Inicio (D7, T8) ───────────────────────────────────

// The keeper's space commands, `projects.<name>`: keys.json binds Herdr's
// own space keys to them in the projects layout (cmd-alt-] / cmd-alt-[,
// ctrl-1…ctrl-9), since Herdr's space.next, space.prev and space.select:N
// would land on Inicio every other press, and reach different spaces
// depending on what's shown.
export const SPACE_COMMANDS = Object.freeze(["space-next", "space-prev", ...Array.from({ length: 9 }, (_, i) => `space-${i + 1}`)]);

// The space a space command selects, over the order without Inicio, so it
// acts exactly as Herdr's own does when there is no Inicio:
//   space-next, space-prev  the space after or before the shown one,
//                           wrapping at the ends as Herdr's do (T0b item
//                           3). From Inicio itself, the first space after
//                           or before it;
//   space-<N>               the Nth space (1-based); nothing past the last.
// null when nothing changes: the target is the shown space (the only one
// besides Inicio), no space is shown (next, prev), or the command isn't one.
// `inicio`: Inicio's id now, or null while there is none.
export function spaceTarget(command, spaces, inicio) {
  const all = spaces ?? [];
  const shown = all.find((s) => s.active)?.id ?? null;
  const pick = (s) => (s && s.id !== shown ? s.id : null);
  const nth = /^space-([1-9][0-9]*)$/.exec(command ?? "");
  if (nth) return pick(all.filter((s) => s.id !== inicio)[Number(nth[1]) - 1]);
  const dir = command === "space-next" ? 1 : command === "space-prev" ? -1 : 0;
  const at = all.findIndex((s) => s.id === shown);
  if (!dir || at < 0) return null;
  for (let k = 1; k < all.length; k += 1) {
    const s = all[(((at + dir * k) % all.length) + all.length) % all.length];
    if (s.id !== inicio) return pick(s);
  }
  return null;
}

// ── Guards on the moves (D7, R1#3) ─────────────────────────────────────────

// A move not seen applied by then stops being waited on.
export const MOVE_WAIT = 2000;
// More than BUDGET changes of the order under the keeper (made by someone
// else) within BUDGET_WINDOW stop its moves for BUDGET_PAUSE, logged once.
// Space order is shared between screens and selection isn't (AGENTS.md "The
// model"), so two screens would move Inicio back and forth forever.
export const BUDGET = 3;
export const BUDGET_WINDOW = 10000;
export const BUDGET_PAUSE = 60000;

// { inflight: { index, at } | null, order: [id] | null, changes: [ms], pausedUntil: ms }
export const newGuard = () => ({ inflight: null, order: null, changes: [], pausedUntil: 0 });

export const canMove = (guard, now) => !guard.inflight && now >= guard.pausedUntil;

export const moved = (guard, index, now) => ({ ...guard, inflight: { index, at: now } });

// Whether the spaces both orders list moved relative to each other: a space
// made or closed changes membership, not order.
export function reordered(before, after) {
  if (!before || !after) return false;
  const a = new Set(after);
  const b = new Set(before);
  const was = before.filter((id) => a.has(id));
  const is = after.filter((id) => b.has(id));
  return was.some((id, i) => id !== is[i]);
}

// One look at the order. A move in flight is done once spaces() shows
// Inicio at its index, or after MOVE_WAIT (someone moved it meanwhile: a
// change under it). Otherwise an order that moved since the last look is a
// change under it. Changes while paused aren't counted: the keeper isn't
// moving then. { guard, log }: log, a line to log, only when a pause starts.
export function observe(guard, spaces, inicio, now) {
  const order = (spaces ?? []).map((s) => s.id);
  let change = false;
  if (guard.inflight) {
    const applied = order.indexOf(inicio) + 1 === guard.inflight.index;
    if (!applied && now - guard.inflight.at <= MOVE_WAIT) return { guard, log: null };
    change = !applied;
  } else change = reordered(guard.order, order);
  const next = { ...guard, inflight: null, order };
  if (!change || now < guard.pausedUntil) return { guard: next, log: null };
  const changes = [...guard.changes.filter((at) => now - at < BUDGET_WINDOW), now];
  if (changes.length <= BUDGET) return { guard: { ...next, changes }, log: null };
  const log = `the space order changed under the keeper ${changes.length} times in ${BUDGET_WINDOW / 1000} s: Inicio stays put for ${BUDGET_PAUSE / 1000} s`;
  return { guard: { ...next, changes: [], pausedUntil: now + BUDGET_PAUSE }, log };
}

// machines(): this computer's layout read. While it loads, spaces() lists
// nothing, and Inicio would be made a second time.
export function localReady(machines) {
  return Array.isArray(machines) && machines.some((m) => m?.name === null && m.layout === "ready");
}

// ── The view (D6, S2) ──────────────────────────────────────────────────────

// Orca's Landing rows (Landing.tsx), each with the commands that do it here,
// the first with a key winning: projects.space-prev/-next are the space keys
// the keeper runs over the order without Inicio (D7, T8).
const SHORTCUTS = [
  { label: "Create workspace", actions: ["projects.new-workspace"] },
  { label: "Move up workspace", actions: ["projects.space-prev", "space.prev"] },
  { label: "Move down workspace", actions: ["projects.space-next", "space.next"] },
];

const MAC_MODS = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const OTHER_MODS = { cmd: "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const MAC_KEYS = { enter: "↵", tab: "⇥", backspace: "⌫", delete: "⌦", escape: "Esc", space: "Space", up: "↑", down: "↓", left: "←", right: "→" };
const OTHER_KEYS = { enter: "Enter", tab: "Tab", backspace: "Backspace", delete: "Delete", escape: "Esc", space: "Space", up: "↑", down: "↓", left: "←", right: "→" };

// A keys.json key ("cmd-shift-up", "cmd--", "ctrl-1") as key caps, in the
// order written: ⌘ ⇧ ↑ on macOS, words elsewhere.
export function keyCaps(keys, platform) {
  const mac = platform === "macos";
  const mods = mac ? MAC_MODS : OTHER_MODS;
  const named = mac ? MAC_KEYS : OTHER_KEYS;
  const caps = [];
  for (const chord of String(keys ?? "").split(" ").filter(Boolean)) {
    let rest = chord;
    for (let m = /^(cmd|ctrl|alt|shift)-(.+)$/.exec(rest); m; m = /^(cmd|ctrl|alt|shift)-(.+)$/.exec(rest)) {
      caps.push(mods[m[1]]);
      rest = m[2];
    }
    caps.push(named[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest[0].toUpperCase() + rest.slice(1)));
  }
  return caps;
}

// The command a key runs in Inicio: its view's own section, then the shown
// layout's, then global, the first that binds it (a layout's key shadows a
// global one). A terminal's keys don't reach a mod pane.
function bound(bindings, layout) {
  const order = [`mod:${MOD}`, `layout:${layout}`, "global"];
  const out = new Map();
  for (const section of order) {
    for (const b of bindings ?? []) if (b?.section === section && !out.has(b.keys)) out.set(b.keys, b);
  }
  return [...out.values()];
}

// What the Inicio view shows (Orca's Landing.tsx:255-322, in English like
// the rest of this mod, titled Herdr, no Star on GitHub): the hint, the two
// buttons, and a shortcut row for each command that has a key.
//   registry: projects.v1; bindings: keys(); layout: the shown layout's name;
//   platform: window().platform.
export function landing({ registry, bindings, layout, platform }) {
  const any = (registry?.groups ?? []).some((g) => (g.projects ?? []).length > 0);
  const keys = bound(bindings, layout);
  const shortcuts = [];
  for (const row of SHORTCUTS) {
    const hit = row.actions.map((a) => keys.find((b) => b.action === a)).find(Boolean);
    if (hit) shortcuts.push({ label: row.label, caps: keyCaps(hit.keys, platform) });
  }
  return {
    title: "Herdr",
    hint: any ? "Select a workspace from the sidebar to begin." : "Add a project to get started.",
    buttons: [
      { id: "inicio-add-project", label: "Add project", icon: "folder-plus" },
      { id: "inicio-create-workspace", label: "Create workspace", icon: "branch" },
    ],
    shortcuts,
  };
}
