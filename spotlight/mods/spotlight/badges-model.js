// Spotlight's badges on projects-sidebar's workspace rows (D2, D17): what
// badges.js publishes under the shared key `badges.spotlight`. Pure: it
// imports only the plugin's other pure modules, so `node --test` loads it.
// The contract it codes against is projects-sidebar's RECIPE.md "Badges
// from other plugins":
//   value  { [workspace path, as `git worktree list` prints it]: [badge],
//            [`<groupId>/task:<KEY>`, a Task-mode group's lane (D29)]: [badge] }
//   badge  { icon: "mods/spotlight/icons/<name>.svg", text? (≤ 16 code
//            points), tone: accent|dim|working|blocked|done, tooltip
//            (≤ 200, one line), action?: { exec: [absolute bin, …] } |
//            { command: "spotlight.<…>" }, spin?: true (its icon spins, D29) }
//   at most 3 per plugin on a row; a value with no rows is null (the key
//   cleared); written only when it changes (setShared re-renders every mod).
//
// Icons only, words in the tooltip (S11, S12), in this order on a row:
//   1. flashlight  working on the holder's row and the root's (amber, Orca's
//                  root bar; Herdr's accent is blue in its default theme),
//                  dim on the other workspaces of an enabled
//                  repo, blocked (red) on an error. A click toggles that
//                  workspace (`spotlight toggle --workspace <path>`).
//                  While a light, a turn-off, a Forzar sync or a restart
//                  works on the repo (its record's `busy`, D33), the
//                  holder's and the root's flashlight, and the target
//                  workspace's, is the ring instead: spinning,
//                  "Sincronizando…", no action.
//   2. server      on the holder's and the root's rows while Spotlight is on
//                  there: ":3000" / ":3000+1" listening, "…" starting, red
//                  when stopped or gone, with the error as its tooltip when
//                  a busy port or a death at start is why (D24, D25). A
//                  click opens the server popup:
//                  the command `spotlight.server.<id>` reaches the footer
//                  copy's nextCommand() as "server.<id>" (probed, RECIPE.md),
//                  and `servers[id]` names the workspace.
//   3. queue       with the queue on, on the rows of a task that asked for a
//                  turn: flask testing, clock + "#N" in line, pause paused.

import { normRoot, repoSettings } from "./settings.js";
import { portLabel, pickPort, portUrl } from "./ports.js";
import { positionOf } from "./queue.js";
import { MOD } from "./board-model.js";
import { serverDown } from "./server-errors.js";
import { oneLine } from "./text.js";

export const iconPath = (name) => `mods/${MOD}/icons/${name}.svg`;

const TEXT_MAX = 16;
const TOOLTIP_MAX = 200;
const PER_ROW = 3;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbsolute = (p) => typeof p === "string" && p.startsWith("/");
const baseName = (p) => normRoot(p).split("/").filter(Boolean).pop() ?? p;
const cut = (s, max) => {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
};

// ── Ids: sha1 of the workspace path, first 12 hex (the CLI's serverId) ─────

function utf8(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// SHA-1 of a string's UTF-8 bytes, as hex. Written out so the id is the
// same in Herdr's runtime and in Node (cli-work.mjs serverId uses
// node:crypto), whatever the runtime's crypto offers.
export function sha1Hex(text) {
  const bytes = utf8(text);
  const length = bytes.length;
  const total = Math.ceil((length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000));
  view.setUint32(total - 4, (length * 8) >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
      else if (i < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
      else if (i < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
      else [f, k] = [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

// The server badge's id of a workspace's row (D17), equal to cli-work.mjs's
// serverId, which the CLI's error toasts name in their action.
export const serverIdOf = (workspace) => sha1Hex(normRoot(workspace)).slice(0, 12);

// ── Reading what projects-sidebar keeps ───────────────────────────────────

// projects.v1 (projects-sidebar's, read-only) as [{ root, name, group }], every
// group's projects in order; a value that isn't a v1 registry is none, a
// malformed group or project is skipped, a root listed twice counts once.
export function parseProjects(registry) {
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.groups)) return [];
  const out = [];
  const seen = new Set();
  for (const g of registry.groups) {
    if (!isObject(g) || typeof g.id !== "string" || !g.id || !Array.isArray(g.projects)) continue;
    for (const p of g.projects) {
      if (!isObject(p) || !isAbsolute(p.path) || typeof p.name !== "string") continue;
      const root = normRoot(p.path);
      if (seen.has(root)) continue;
      seen.add(root);
      out.push({ root, name: p.name, group: g.id });
    }
  }
  return out;
}

const isCheckout = (c) => isObject(c) && isAbsolute(c.path) && (c.branch === null || typeof c.branch === "string") && typeof c.main === "boolean";

// projects.cache.v1 (each project's last worktree list, projects-sidebar's)
// as { [root]: [{ path, branch, main }] }; a malformed project entry is dropped.
export function parseCache(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [root, list] of Object.entries(value)) {
    if (!isAbsolute(root) || !Array.isArray(list) || !list.every(isCheckout)) continue;
    out[normRoot(root)] = list.map((c) => ({ path: normRoot(c.path), branch: c.branch, main: c.main }));
  }
  return out;
}

// ── The badges ─────────────────────────────────────────────────────────────

// "22:58:04" in local time.
function clock(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

const ERROR_TEXT = {
  "root-diverged": "Root desviado: abre el server para forzar",
  "untracked-collision": "Archivos sin seguimiento en el root: abre el server para forzar",
  "orphan-refs": "Refs de Spotlight sin dueño: clic para restaurar el root",
  "operation-in-progress": "Merge o rebase en curso: termínalo y se sincroniza",
};

// An async check that may throw, at once or later (Herdr's fs throws at once
// for a path outside the window's home): anything thrown reads `fallback`.
export async function attempt(check, fallback) {
  try {
    return await check();
  } catch {
    return fallback;
  }
}

export const errorText = (error) => ERROR_TEXT[error?.code] ?? `Spotlight: ${oneLine(error?.message ?? error?.code ?? "error")}`;

function badge({ icon, text, tone, tooltip, action, spin }) {
  const b = { icon: iconPath(icon) };
  if (text) b.text = cut(oneLine(text), TEXT_MAX);
  b.tone = tone;
  b.tooltip = cut(oneLine(tooltip), TOOLTIP_MAX);
  if (action) b.action = action;
  if (spin) b.spin = true;
  return b;
}

const toggle = (bin, workspace) => ({ exec: [bin, "toggle", "--workspace", workspace] });
const popup = (workspace) => ({ command: `${MOD}.server.${serverIdOf(workspace)}` });

// D33: a busy repo's flashlight. No action: the work holds the repo's lock,
// and a click would only queue behind it.
const ring = () => badge({ icon: "spinner", tone: "working", tooltip: "Sincronizando…", spin: true });

// A record's busy mark, or null.
const busyOf = (record) => (isObject(record?.busy) ? record.busy : null);

// 1. The flashlight of a lit repo's holder or root row.
function litFlashlight(record, at, { bin, root }) {
  if (record.lastError) return badge({ icon: "flashlight", tone: "blocked", tooltip: errorText(record.lastError), action: toggle(bin, at) });
  const synced = Number.isFinite(record.lastSyncAt) ? ` · sincronizado ${clock(record.lastSyncAt)}` : "";
  const who = at === root ? ` · ${baseName(record.holder)}` : "";
  return badge({ icon: "flashlight", tone: "working", tooltip: `Spotlight${who}${synced}`, action: toggle(bin, at) });
}

// 2. The server badge of a lit repo's holder or root row. A server that
// didn't come up (a busy port refused its start, D24, or it died starting,
// D25: server-errors.js serverDown) says why.
function serverBadge(record, at, configured) {
  const ports = Array.isArray(record.ports) ? record.ports.filter(Number.isInteger) : [];
  const what = [record.serverEnv, record.serverCommand].filter(Boolean).join(" · ");
  const action = popup(at);
  if (serverDown(record)) {
    return badge({ icon: "server", tone: "blocked", tooltip: record.lastError.message || errorText(record.lastError), action });
  }
  switch (record.serverState) {
    case "listening": {
      const picked = pickPort(ports, configured);
      const urls = [picked, ...ports.filter((p) => p !== picked)].filter((p) => p != null).map(portUrl);
      return badge({ icon: "server", text: portLabel(ports, configured) || undefined, tone: "done", tooltip: [what, urls.join(" ")].filter(Boolean).join(" · "), action });
    }
    case "starting":
      return badge({ icon: "server", text: "…", tone: "working", tooltip: ["Arrancando", what].filter(Boolean).join(" · "), action });
    case "needs-variant":
      return badge({ icon: "server", text: "?", tone: "accent", tooltip: "Elige una variante: clic para abrir el server", action });
    case "gone":
      return badge({ icon: "server", tone: "blocked", tooltip: "Server cerrado · clic para reiniciarlo", action });
    default:
      if (!record.serverCommand && !record.serverTerminal) {
        return badge({ icon: "server", tone: "dim", tooltip: "Sin server · clic para elegir uno", action });
      }
      return badge({ icon: "server", tone: "blocked", tooltip: ["Server parado", what].filter(Boolean).join(" · "), action });
  }
}

const PAUSED = { limit: "Pausado · sin límite", signin: "Pausado · inicia sesión" };

// Why a waiting task waits, in a few words: its first blocker.
function waitReason(blockers) {
  const b = blockers?.[0];
  if (!b) return null;
  if (b.reason === "lane") return "mismo space";
  if (b.reason === "cap") return "límite alcanzado";
  return b.holding ? "repo ocupado" : "otro va antes";
}

// 3. One queue badge per task that asked: testing wins over waiting, which
// wins over paused. → Map(taskKey → { badge, rows }).
function queueBadges(state, qctx) {
  const tasks = new Map();
  for (const r of state.queue.requests) {
    if (typeof r.taskKey !== "string" || typeof r.terminal !== "string") continue;
    const t = tasks.get(r.taskKey) ?? { requests: [], rows: new Set() };
    t.requests.push(r);
    for (const m of Array.isArray(r.members) ? r.members : []) {
      for (const w of Array.isArray(m?.workspaces) ? m.workspaces : [m?.workspace]) if (isAbsolute(w)) t.rows.add(normRoot(w));
    }
    if (isAbsolute(r.workspace)) t.rows.add(normRoot(r.workspace));
    tasks.set(r.taskKey, t);
  }
  const out = new Map();
  for (const [key, t] of tasks) {
    let b;
    if (t.requests.some((r) => r.state === "holding")) {
      b = badge({ icon: "flask", tone: "working", tooltip: "Probando" });
    } else {
      const places = t.requests
        .filter((r) => r.state !== "paused")
        .map((r) => positionOf(state.queue, r.terminal, qctx))
        .filter((p) => p && p.kind === "waiting")
        .sort((x, y) => x.position - y.position);
      if (places.length > 0) {
        const n = places[0].position;
        const why = waitReason(places[0].blockers);
        b = badge({ icon: "clock", text: `#${n}`, tone: "dim", tooltip: `En cola #${n}${why ? ` · ${why}` : ""}` });
      } else {
        const paused = t.requests.find((r) => r.state === "paused");
        if (!paused) continue;
        b = badge({ icon: "pause", tone: "blocked", tooltip: PAUSED[paused.pauseReason] ?? "Pausado · error" });
      }
    }
    out.set(key, { badge: b, rows: [...t.rows] });
  }
  return out;
}

// Every badge of the moment, and the server popup's id map:
//   state     board-model.js readState(state.json's text)
//   settings  board-model.js readSettings(settings.json's text)
//   projects  parseProjects(shared("projects.v1"))
//   cache     parseCache(shared("projects.cache.v1"))
//   enabled   { [root]: boolean }: whether Spotlight is on for each
//             registered repo (D7, settings.js repoEnabledFrom)
//   bin       board-model.js cliPathOf(appHome())
// → { value: { [path]: [badge] } | null, servers: { [id]: { workspace, root } } }
// `servers` names every workspace Spotlight knows (lit rows, the enabled
// repos' worktrees, the queue's members, the lightings'), so a toast's
// `spotlight.server.<id>` (cli-work.mjs errorNote) resolves too.
export function buildBadges({ state, settings, projects = [], cache = {}, enabled = {}, bin }) {
  const rows = new Map(); // path → [badge, …] in D17's order
  const add = (at, b) => {
    const list = rows.get(at) ?? [];
    list.push(b);
    rows.set(at, list);
  };
  const servers = {};
  const know = (workspace, root) => {
    if (isAbsolute(workspace) && isAbsolute(root)) servers[serverIdOf(workspace)] ??= { workspace: normRoot(workspace), root: normRoot(root) };
  };

  const repos = state?.repos ?? {};
  const lit = new Map(); // root → holder
  const spun = new Set(); // target rows of a busy repo, the ring in their flashlight's place (D33)
  for (const [root, record] of Object.entries(repos)) {
    const busy = busyOf(record);
    if (isAbsolute(record.holder)) {
      const holder = normRoot(record.holder);
      lit.set(root, holder);
      const configured = repoSettings(settings, root).port;
      for (const at of [holder, root]) {
        add(at, busy ? ring() : litFlashlight(record, at, { bin, root }));
        add(at, serverBadge(record, at, configured));
        know(at, root);
      }
    } else if (record.lastError) {
      // A refused fresh activation leaves an error and no holder: the root's
      // row shows it, and its click opens the popup (Proyectar igual).
      add(root, busy ? ring() : badge({ icon: "flashlight", tone: "blocked", tooltip: errorText(record.lastError), action: popup(root) }));
      know(root, root);
    }
    // The workspace the work is for: a fresh light's (no holder yet, as
    // Orca's optimistic holder) or a takeover's spins in its own row too.
    const target = busy && isAbsolute(busy.workspace) ? normRoot(busy.workspace) : null;
    if (target && target !== lit.get(root) && target !== root) {
      add(target, ring());
      spun.add(target);
      know(target, root);
    }
  }

  for (const { root } of projects) {
    for (const c of cache[root] ?? []) {
      know(c.path, root);
      if (enabled[root] !== true || c.main || c.path === lit.get(root) || spun.has(c.path)) continue;
      const holder = lit.get(root);
      const tooltip = holder ? `Spotlight · proyectar aquí (ahora ${baseName(holder)})` : "Spotlight · encender aquí";
      add(c.path, badge({ icon: "flashlight", tone: "dim", tooltip, action: toggle(bin, c.path) }));
    }
  }

  for (const r of state?.queue?.requests ?? []) {
    for (const m of Array.isArray(r.members) ? r.members : []) for (const w of m?.workspaces ?? [m?.workspace]) know(w, m?.root);
  }
  for (const marker of Object.values(state?.queue?.lighting ?? {})) {
    for (const m of Array.isArray(marker?.members) ? marker.members : []) know(m?.workspace, m?.root);
  }

  const queue = settings?.queue ?? {};
  if (queue.enabled !== false) {
    for (const { badge: b, rows: at } of queueBadges(state, { ...queue }).values()) {
      for (const p of at) add(p, b);
    }
  }

  const value = {};
  for (const at of [...rows.keys()].sort()) {
    value[at] = rows.get(at).slice(0, PER_ROW);
  }
  return { value: Object.keys(value).length > 0 ? value : null, servers };
}

// ── Publishing only on change ──────────────────────────────────────────────

// JSON with object keys sorted, so a value read back from shared state
// compares equal to the same value built again.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// What to write under badges.spotlight: { write, value }. `current` is the
// stored value (shared()), `next` buildBadges' value (null: no badges).
// Unchanged → no write; no badges and nothing stored → no write.
export function nextPublish(current, next) {
  const now = next ?? null;
  return { write: canonicalJson(current ?? null) !== canonicalJson(now), value: now };
}
