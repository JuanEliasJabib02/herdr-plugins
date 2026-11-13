// Which workspace (a git checkout) and project each space is in, so an
// agent's row can name its project and open its workspace's menu. The rule is
// projects-sidebar's (projects/lib.js matchSpaces): the space's first
// terminal's live folder, else the folder it was made in; the deepest
// checkout of the worktree lists that is that folder or holds it; spaces on
// another machine match nothing. It reads the same shared keys the sidebar
// writes. A mod can't import another mod's files, so this is a copy, and
// the root suite holds it to matchSpaces. Each workspace also carries its
// task, so a row's tooltip can start with the note the sidebar shows on that
// task's lane: copies of task-model.js taskKeyOf and lib.js's note helpers,
// held to theirs the same way. Pure.

export const REGISTRY_KEY = "projects.v1"; // { groups: [{ projects: [{ path, name }] }] }
export const CACHE_KEY = "projects.cache.v1"; // { [projectPath]: [{ path, branch, main }] }
export const NOTES_KEY = "projects.notes.v1"; // { [taskKey]: note }

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function normPath(path, home) {
  if (typeof path !== "string" || !path) return "";
  let p = path.replace(/\\/g, "/");
  if (home && (p === "~" || p.startsWith("~/"))) p = normPath(home) + p.slice(1);
  return p.replace(/\/+$/, "") || "/";
}

const isAbsolute = (path) => typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:\//.test(path));
const inside = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? "";

function placeOf(space, panes) {
  const tabs = new Set((Array.isArray(space.tabs) ? space.tabs : []).map((t) => t?.id));
  return panes.find((p) => isObject(p) && tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

// space id → { project, path, main, name, task }: the project's and the
// checkout's paths (`~` expanded), whether it is the main checkout, the
// project's name as the sidebar shows it (its folder's when unnamed), and
// the key its task's note is filed under (noteKeyOfCheckout), else null.
export function workspacesBySpace({ registry, cache, spaces = [], panes = [], home = "" } = {}) {
  const names = new Map();
  for (const g of isObject(registry) && Array.isArray(registry.groups) ? registry.groups : []) {
    for (const p of Array.isArray(g?.projects) ? g.projects : []) {
      const path = normPath(p?.path, home);
      if (path && typeof p.name === "string" && p.name && !names.has(path)) names.set(path, p.name);
    }
  }
  const checkouts = [];
  for (const [project, list] of Object.entries(isObject(cache) ? cache : {})) {
    for (const c of Array.isArray(list) ? list : []) {
      const path = normPath(c?.path, home);
      if (path) checkouts.push({ project: normPath(project, home), path, main: c?.main === true, branch: typeof c?.branch === "string" ? c.branch : null });
    }
  }
  const out = new Map();
  for (const space of Array.isArray(spaces) ? spaces : []) {
    if (!isObject(space) || (space.machine ?? null) !== null) continue;
    const at = normPath(placeOf(space, Array.isArray(panes) ? panes : []), home);
    if (!isAbsolute(at)) continue;
    let best = null;
    for (const c of checkouts) if (inside(at, c.path) && (!best || c.path.length > best.path.length)) best = c;
    if (best) out.set(space.id, { project: best.project, path: best.path, main: best.main, name: names.get(best.project) ?? baseName(best.project), task: noteKeyOfCheckout(best) });
  }
  return out;
}

// ── A workspace's task and its note ────────────────────────────────────────

// Orca's ticket pattern, as task-model.js has it.
const TICKET = /(?<![A-Za-z0-9])(?:([A-Za-z][A-Za-z0-9]{1,5})[-_ ](\d{1,6})|([A-Za-z]{2,6})(\d{2,6}))(?![A-Za-z0-9])/;

function findTicket(text) {
  const m = TICKET.exec(String(text ?? ""));
  const prefix = m?.[1] ?? m?.[3];
  const digits = m?.[2] ?? m?.[4];
  return prefix && digits ? `${prefix.toUpperCase()}-${digits}` : null;
}

const stripRef = (branch) => String(branch).replace(/^refs\/heads\//, "");

function branchTicket(branch) {
  for (const segment of stripRef(branch).split("/").reverse()) {
    const ticket = findTicket(segment);
    if (ticket) return ticket;
  }
  return null;
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

function usableName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.toLowerCase() !== "none" && name.length <= 200 && !UNSAFE.has(name) ? name : null;
}

function isNoteKey(key) {
  if (typeof key !== "string") return false;
  const k = key.toLowerCase();
  return k !== "" && k !== "none" && k.length <= 200 && !UNSAFE.has(k);
}

// The key a checkout's ({ path, branch, main }) task note is filed under:
// the ticket in its branch, else in its folder's name ("AX-3797"); else the
// branch's last segment or the folder's name, lowercased; null for a main
// checkout, no task, or a key a note can't have. Task mode's lane without
// "task:" (task-model.js taskKeyOf, lib.js noteKeyOf).
export function noteKeyOfCheckout(checkout) {
  if (!isObject(checkout) || checkout.main) return null;
  const folder = baseName(String(checkout.path ?? ""));
  const ticket = (checkout.branch ? branchTicket(checkout.branch) : null) ?? findTicket(folder);
  if (ticket) return isNoteKey(ticket) ? ticket : null;
  const leaf = checkout.branch ? stripRef(checkout.branch).split("/").pop() : null;
  const name = usableName(leaf) ?? usableName(folder);
  return name && isNoteKey(name.toLowerCase()) ? name.toLowerCase() : null;
}

const NOTE_LENGTH = 30;
const NOTES_MAX = 500;

function normalizeNote(text) {
  if (typeof text !== "string") return "";
  const one = text.replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, NOTE_LENGTH).join("").trimEnd();
}

// A stored projects.notes.v1 value as the sidebar reads it (lib.js
// parseNotes): the usable entries, each note normalized, the first 500.
export function parseNotes(value) {
  if (!isObject(value)) return {};
  const out = {};
  let n = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (n >= NOTES_MAX) break;
    if (!isNoteKey(key) || typeof raw !== "string") continue;
    const note = normalizeNote(raw);
    if (!note) continue;
    out[key] = note;
    n += 1;
  }
  return out;
}

// The note stored under `key`, or null (lib.js noteOf).
export function noteOf(notes, key) {
  if (!isObject(notes) || typeof key !== "string" || !Object.hasOwn(notes, key)) return null;
  return typeof notes[key] === "string" ? notes[key] : null;
}

// What an agent's row offers of its workspace's menu: Sleep, Rename… and
// Delete… (asked for: only these, plus a manual Sleep for the agent);
// the sidebar's own keeps everything.
export const AGENT_MENU = Object.freeze(["sleep", "rename", "delete"]);

// The row's right-click: the sidebar's own menu with only AGENT_MENU, as a
// 1 px frameless popup at the pointer, the projects mod's
// `workspace-menu-at` view, which opens the real one from inside that mod
// (with the height its items take) and closes itself. The main checkout's
// asks for Sleep alone: it is never renamed or deleted, whatever the menu's
// own lookup of the checkout finds. Null for no workspace.
export function workspaceMenuSpec(w) {
  if (!isObject(w) || typeof w.path !== "string" || !w.path) return null;
  const only = w.main === true ? ["sleep"] : [...AGENT_MENU];
  return { mod: "projects", kind: "popup", width: 1, height: 1, frame: "none", props: { view: "workspace-menu-at", project: w.project, path: w.path, only } };
}
