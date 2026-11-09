// The workspaces a person put to sleep (workspace-sleep D9):
// `appHome()/agent-sleep/workspaces.json`, one entry per workspace, keyed by
// its path as `git worktree list` prints it:
//
//   { version: 1, workspaces: { [path]: {
//       spaces: { [spaceId]: [tabId] },   the spaces of it (D12) and their tabs
//       state: "sleeping" | "asleep",     its stops still under way, or done
//       at,                               ms, when it was written sleeping
//       shownAtSleep?,                    still shown when its stops began (D10 step 4)
//       wakeAfter?,                       shown again while sleeping (D4)
//   } } }
//
// Its own file, because store.js's serializeRecords writes only
// {version, records}. Pure, as store.js is: the file calls are injected as
// `io` ({ read(path), write(path, text, expected), mkdirp?(dir) }), Herdr's
// readTextFile / writeTextFile, whose write is a compare-and-swap. One
// writer: the loop copy (agent-sleep D11).

export const WORKSPACES_VERSION = 1;
export const ENTRY_STATES = Object.freeze(["sleeping", "asleep"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const isId = (v) => typeof v === "string" && v !== "" && v !== "__proto__";
// An absolute folder (`/…`, or `C:/…`), never a key that writes a prototype.
const isPath = (v) => isId(v) && /^(\/|[A-Za-z]:\/)/.test(v);
const isFlag = (v) => v === undefined || typeof v === "boolean";

export function workspacesPaths(appHome) {
  const dir = `${String(appHome).replace(/\/+$/, "")}/agent-sleep`;
  return { dir, file: `${dir}/workspaces.json`, bak: `${dir}/workspaces.json.bak` };
}

function validEntry(e) {
  if (!isObject(e) || !ENTRY_STATES.includes(e.state) || !Number.isFinite(e.at)) return false;
  if (!isFlag(e.shownAtSleep) || !isFlag(e.wakeAfter)) return false;
  if (!isObject(e.spaces)) return false;
  const spaces = Object.entries(e.spaces);
  return spaces.length > 0 && spaces.every(([id, tabs]) => isId(id) && Array.isArray(tabs) && tabs.every(isId));
}

// A missing file is no entries. One that isn't version 1 with a workspaces
// object, or that holds an entry this code can't read, is flagged `bad` (the
// caller keeps it as .bak before writing over it); valid entries survive.
export function parseWorkspaces(text) {
  if (text == null) return { entries: {}, bad: false };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { entries: {}, bad: true };
  }
  if (!isObject(value) || value.version !== WORKSPACES_VERSION || !isObject(value.workspaces)) {
    return { entries: {}, bad: true };
  }
  const entries = {};
  let bad = false;
  for (const [path, e] of Object.entries(value.workspaces)) {
    if (isPath(path) && validEntry(e)) entries[path] = e;
    else bad = true;
  }
  return { entries, bad };
}

export function serializeWorkspaces(entries) {
  return `${JSON.stringify({ version: WORKSPACES_VERSION, workspaces: entries }, null, 2)}\n`;
}

// → { entries, text }: `text` is what is on disk now, the `expected` of the
// next save. A bad file is copied to .bak first.
export async function loadWorkspaces(io, p) {
  const text = await io.read(p.file);
  const { entries, bad } = parseWorkspaces(text);
  if (bad && text != null) await io.write(p.bak, text, await io.read(p.bak));
  return { entries, text };
}

// Rejects (through io.write) when the file changed since `expected` was read.
// → the text written, the next `expected`.
export async function saveWorkspaces(io, p, entries, expected) {
  if (typeof io.mkdirp === "function") await io.mkdirp(p.dir);
  const text = serializeWorkspaces(entries);
  await io.write(p.file, text, expected);
  return text;
}

// ── Pure updates and reads ──────────────────────────────────────────────────

export function withEntry(entries, path, entry) {
  return { ...entries, [path]: entry };
}

export function withoutEntry(entries, path) {
  const next = { ...entries };
  delete next[path];
  return next;
}

// Every tab the entry lists, in its order.
export function listedTabs(entry) {
  return Object.values(isObject(entry?.spaces) ? entry.spaces : {}).flatMap(list);
}

// The terminals in the entry's tabs, in panes() order, once each. A mod
// pane has none.
export function terminalsOf(entry, panes) {
  const tabs = new Set(listedTabs(entry));
  const out = [];
  for (const p of list(panes)) {
    if (isObject(p) && tabs.has(p.tab) && isId(p.terminal) && !out.includes(p.terminal)) out.push(p.terminal);
  }
  return out;
}

const anySettled = (entry, byId) =>
  Object.entries(entry.spaces).some(([id, tabs]) => list(byId.get(id)?.tabs).some((t) => tabs.includes(t?.id) && t.settled === true));

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : Object.keys(isObject(v) ? v : {})));

// D9's reconcile, run at start (`start: true`) and while there is something
// to follow. Its rules, in this order, the first match winning:
//   1. a listed space that is gone (closed for real) leaves the entry; an
//      entry with no space left goes;
//   2. none of its listed tabs still settled → it goes: woken by hand, or a
//      reload between D10's steps 2 and 3 (nothing was stopped yet, step 5
//      follows step 3). It applies to an asleep entry, and at start to a
//      sleeping one, but not to a sleep this copy is running or has just
//      run: Herdr brings a settled tab back when an agent in it needs the
//      person (H/AGENTS.md:124-127), which its own interrupts do (T0b item
//      8), and step 6 settles those again. A click mid-sleep is caught by
//      the shown edge instead (D4: wakeAfter). A reload after an interrupt
//      brought every tab back drops it at start too: what slept stays
//      asleep and wakes as any Claude does, when its tab shows;
//   3. `start` and sleeping → steps 4–5 planned again (`replan`): the plan is
//      idempotent. Not one a click already woke (wakeAfter): step 6 wakes it;
//   4. sleeping, nothing `queued` (its steps 4–5 done in this copy) and no
//      `stopping` record left on its terminals → step 6 (`finish`).
// `queued`: the paths whose steps are still running here (a Set, an array or
// an object's keys). `panes`: panes(), for the terminals rule 4 looks at.
// Without spaces there is no evidence (Core not connected yet): nothing is
// decided. → { entries, replan, finish, changed }; the input stays.
export function reconcileSpaces({ entries, spaces, panes, records, queued, start = false } = {}) {
  const none = { entries, replan: [], finish: [], changed: false };
  if (!isObject(entries) || !Array.isArray(spaces) || spaces.length === 0) return none;
  const byId = new Map(spaces.filter((s) => isObject(s) && isId(s.id)).map((s) => [s.id, s]));
  const busy = toSet(queued);
  let next = entries;
  const replan = [];
  const finish = [];
  for (const [path, original] of Object.entries(entries)) {
    let entry = original;
    const kept = Object.keys(entry.spaces).filter((id) => byId.has(id));
    if (kept.length === 0) {
      next = withoutEntry(next, path);
      continue;
    }
    if (kept.length < Object.keys(entry.spaces).length) {
      entry = { ...entry, spaces: Object.fromEntries(kept.map((id) => [id, entry.spaces[id]])) };
      next = withEntry(next, path, entry);
    }
    if ((entry.state === "asleep" || start) && !anySettled(entry, byId)) {
      next = withoutEntry(next, path);
      continue;
    }
    if (entry.state !== "sleeping") continue;
    if (start && entry.wakeAfter !== true) {
      replan.push(path);
      continue;
    }
    if (busy.has(path)) continue;
    const stopping = terminalsOf(entry, panes).some((a) => isObject(records) && Object.hasOwn(records, a) && records[a]?.state === "stopping");
    if (!stopping) finish.push(path);
  }
  return { entries: next, replan, finish, changed: next !== entries };
}
