// Spotlight's badges on projects-sidebar's workspace rows (D2, D17): what
// badges.js publishes under the shared key `badges.spotlight`. Pure: it
// imports only the plugin's other pure modules, so `node --test` loads it.
// The contract it codes against is projects-sidebar's RECIPE.md "Badges
// from other plugins":
//   value  { [workspace path, as `git worktree list` prints it]: [badge],
//            [`<groupId>/task:<KEY>`, a Task-mode group's lane (D29)]: [badge] }
//   badge  { icon?: "mods/spotlight/icons/<name>.svg", text? (≤ 16 code
//            points; a badge with no icon is a text badge), tone:
//            accent|dim|working|blocked|done, tooltip (≤ 200, one line),
//            action?: { exec: [absolute bin, …] } | { command:
//            "spotlight.<…>" }, spin?: true (its icon spins, D29),
//            reveal?: "hover" | "grow" (shown on its row's hover; "grow"
//            also opens its width), pill?: true (an outlined pill), dot?:
//            "on" | "off" (a server dot), hover?: <tone> (its hover's tone),
//            bar?: <tone> (the row's left bar), line?: 2 (under the row's
//            label), disabled?: true (half opacity, inert, no action),
//            look?: "secondary" | "outline" (beside pill: true, Orca's
//            Badge variants, the text in its own case) }
//   (D39, D42, projects-sidebar's T30 and T33) at most 4 per plugin on a
//   row, line-2 badges included; a value with no rows is null (the key
//   cleared); written only when it changes (setShared re-renders every
//   mod).
//
// Orca's cards (WorktreeCardSpotlightControls, D39, D42), words in the
// tooltip (S11, S12), in this order on a row:
//   1. variant     on the holder's row of a repo with variants (badges.js
//                  detects them, `variants`; else the record's candidates
//                  while it asks, or the variant its server ran), whatever
//                  the server does: Orca's SpotlightVariantTag, a dim pill
//                  with no icon, the variant uppercased and cut to 6 ("DO"),
//                  "?" with none picked (or while it asks for one). A click
//                  opens the server popup and its chips.
//   2. flashlight  on a workspace of an enabled repo. The holder's: working
//                  (amber, Orca's; Herdr's accent is blue in its default
//                  theme), always shown, with the server dot (Orca's
//                  SpotlightServerDot): "on" while a process runs in the
//                  Spotlight terminal (starting or listening), "off" when
//                  it doesn't, none with no server or its terminal gone.
//                  Its tooltip is Orca's: "Spotlight encendido: …",
//                  "Sincronizado hace 2 min." from the `now` given (Orca's
//                  formatTimeAgo), then the server's state. Blocked (red)
//                  on a root error (a sync's, not a server's: Orca's sync
//                  error), "La sincronización de Spotlight está fallando:
//                  …". Any other workspace's: dim, shown on its row's hover
//                  (`reveal: "hover"`), Orca's idle or takeover sentence. A
//                  click toggles that workspace (`spotlight toggle
//                  --workspace <path>`). While a light, a turn-off, a
//                  Forzar sync or a restart works on the repo (its record's
//                  `busy`, D33), the holder's flashlight (its dot kept) and
//                  the target workspace's is the ring instead: spinning,
//                  "Sincronizando…" (the holder's followed by the server's
//                  state, as Orca's), no action, always shown.
//   3. line 2      on the holder's row, under its label (Orca's details
//                  row): the root's ports, Orca's label ":3000" / ":3000
//                  +1", dim text, while the server listens on a port; a
//                  down server with an error instead (D24, D25: a busy
//                  port, a death at start, a failed start; Herdr's extra)
//                  as red text, "puerto ocupado", "server caído", "no
//                  arrancó", the message in its tooltip. A click opens the
//                  server popup: the command `spotlight.server.<id>`
//                  reaches the footer copy's nextCommand() as "server.<id>"
//                  (probed, RECIPE.md), and `servers[id]` names the
//                  workspace. No server badge (D42).
//   4. queue       with the queue on, on the rows of a task that asked for a
//                  turn: flask testing, clock + "#N" in line, pause paused
//                  (Herdr's extra on the rows).
//
// The root's row while Spotlight is on there (Orca's SpotlightPrimaryBadge
// and its amber root bar):
//   1. chip        a working pill, the flashlight and "Spotlight", the server
//                  dot after its text, carrying the row's amber bar (`bar:
//                  "working"`); a click shows the server's "Spotlight" tab
//                  (`spotlight peek --repo <root>`, the popup's Ver
//                  server), busy or not, whatever the record's error: never
//                  red, a root error shows on the holder's flashlight (D42,
//                  Orca's). Its tooltip names the holder and the server's
//                  state. Busy, its icon is the ring.
//   2. port        on line 2: ":3000" / ":3000 +1", a dim text badge,
//                  opening the server popup, only while the server listens
//                  on a port.
//   3. logs        the log, dim, on the row's hover, no click; its tooltip
//                  says how agents read it (`spotlight logs --repo <name>`).
//                  The root terminal's own queue badge takes its place.
//   4. X           dim, amber on hover, on the row's hover: turns Spotlight
//                  off and restores the root (`toggle --workspace <root>`).
//                  Busy, Orca's disabled X: `disabled`, with no action.
// A root with an error and no holder (a refused fresh light) keeps the red
// flashlight, which opens the popup (Proyectar igual).
//
// On a task lane's header, in every group organized by Task (D29, D31;
// projects-sidebar draws the active group's only), in Orca's order
// (TaskSectionHeader):
//   1. flashlight  the whole task's: working when every member's root is
//                  held by one of the task's workspaces (task.js taskLit),
//                  dim otherwise; the repos skipped (Spotlight off there)
//                  named in its tooltip. Always shown. A click runs
//                  `spotlight toggle --task <KEY> --group <id>`. While that
//                  batch runs (queue.taskBatch) or a member's repo is busy
//                  for one of the task's workspaces (the mark's target; not
//                  another task's work on a shared repo), the ring, with no
//                  action. None when no repo with
//                  Spotlight on has a workspace of the task.
//   2. queue       the task's place in the queue, so a folded lane still
//                  says it, as Orca's TaskTestTurnBadge (D42): a text pill
//                  with no tooltip and no click, "Probando" filled
//                  (`look: "secondary"`), "En cola #<n>" and "Pausado"
//                  outlined (`look: "outline"`).
//   3. env         the env of the task's servers (D32, D39, Orca's
//                  TaskSpotlightEnvPill): a dim text badge, the env's name
//                  and "▾" ("Local ▾"), "Mixto ▾" when the held repos run
//                  different ones (each named in the tooltip). Always shown
//                  while a member holds its root, or when the env stored
//                  for the task isn't Local; otherwise it grows in on the
//                  header's hover (`reveal: "grow"`). With no flashlight,
//                  none. A click opens the env popup (env-view.js): the
//                  command `spotlight.env.<id>`, the id sha1 of
//                  `<groupId>/<KEY>`, and `lanes[id]` names the lane.

import { normRoot, repoSettings, ENVS } from "./settings.js";
import { taskOf, taskLit } from "./task.js";
import { pickPort, portUrl } from "./ports.js";
import { positionOf } from "./queue.js";
import { MOD } from "./board-model.js";
import { serverDown, isServerError, PORT_BUSY, SERVER_EXITED, SERVER_START_FAILED } from "./server-errors.js";
import { oneLine } from "./text.js";
import { ENV_LABELS, recordEnv, storedEnv } from "./task-env.js";
import { formatVariant, isSafeVariant } from "./server-plan.js";

export const iconPath = (name) => `mods/${MOD}/icons/${name}.svg`;

const TEXT_MAX = 16;
// D36: the variant on the holder's tag, in code points, "…" included.
const VARIANT_MAX = 6;
const TOOLTIP_MAX = 200;
// D39, D42: the lit root row's chip, port, logs and X (projects-sidebar's
// cap per plugin), line-2 badges included.
const PER_ROW = 4;

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

// The ids of projects.v1's groups organized by Task (`organize: "task"`,
// projects-sidebar's D29), in order: the ones whose task lanes get badges.
// A group id listed twice counts the first time, as projects-sidebar reads it.
export function taskModeGroups(registry) {
  if (!isObject(registry) || registry.version !== 1 || !Array.isArray(registry.groups)) return [];
  const seen = new Set();
  const ids = [];
  for (const g of registry.groups) {
    if (!isObject(g) || typeof g.id !== "string" || !g.id || !Array.isArray(g.projects) || seen.has(g.id)) continue;
    seen.add(g.id);
    if (g.organize === "task") ids.push(g.id);
  }
  return ids;
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

// Orca's formatTimeAgo (D42), in Spanish: "recién" under a minute (or for a
// time ahead of `now`), "hace <n> min" under an hour, else "hace <n> h".
function timeAgo(then, now) {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "recién";
  return minutes < 60 ? `hace ${minutes} min` : `hace ${Math.floor(minutes / 60)} h`;
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

// A text as a sentence: a final period when it ends in none, so the next
// sentence of a tooltip reads after it.
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);

// One badge as the contract spells it: an icon (none on a text badge), a
// text cut to TEXT_MAX, a tooltip when there is one (a lane's queue pill has
// none, D42), and D39's and D42's fields only when set. A disabled badge is
// published with no action (D42: an older reader draws it inert too).
function badge({ icon, text, tone, tooltip, action, spin, reveal, pill, dot, hover, bar, line, disabled, look }) {
  const b = {};
  if (icon) b.icon = iconPath(icon);
  if (text) b.text = cut(oneLine(text), TEXT_MAX);
  b.tone = tone;
  const tip = cut(oneLine(tooltip), TOOLTIP_MAX);
  if (tip) b.tooltip = tip;
  if (action && !disabled) b.action = action;
  if (spin) b.spin = true;
  if (reveal) b.reveal = reveal;
  if (pill) b.pill = true;
  if (dot) b.dot = dot;
  if (hover) b.hover = hover;
  if (bar) b.bar = bar;
  if (line === 2) b.line = 2;
  if (disabled) b.disabled = true;
  if (look) b.look = look;
  return b;
}

// D41: a click's toggle carries --note: a refusal the CLI answers at once is
// a Spotlight error toast and exit 0, so projects-sidebar's exec-failure
// toast doesn't say it a second time.
const toggle = (bin, workspace) => ({ exec: [bin, "toggle", "--workspace", workspace, "--note"] });
const popup = (workspace) => ({ command: `${MOD}.server.${serverIdOf(workspace)}` });
// D38's "Ver server": the root's "Spotlight" tab, as the popup's button.
const peek = (bin, root) => ({ exec: [bin, "peek", "--repo", root] });

// D33: a busy repo's flashlight. No action: the work holds the repo's lock,
// and a click would only queue behind it. `dot`: the holder's keeps its
// server dot (D39, Orca's held button while syncing); `server`: the holder's
// says the server's state after "Sincronizando…", as Orca's (D42).
const ring = (dot, server) => badge({ icon: "spinner", tone: "working", tooltip: server ? `Sincronizando… ${server}` : "Sincronizando…", spin: true, dot });

// A record's busy mark, or null.
const busyOf = (record) => (isObject(record?.busy) ? record.busy : null);

// The record's port numbers, the integers only.
const portsOf = (record) => (Array.isArray(record.ports) ? record.ports.filter(Number.isInteger) : []);

// Orca's port label (formatSpotlightPortLabel, D42): ":3000", or ":3000 +1"
// for several, the configured port first when it listens, else the lowest;
// null when none listens.
function portText(record, configured) {
  const ports = [...new Set(portsOf(record))];
  const picked = pickPort(ports, configured);
  if (picked === null) return null;
  return ports.length > 1 ? `:${picked} +${ports.length - 1}` : `:${picked}`;
}

// The server's dot (D39, Orca's SpotlightServerDot, spotlight-server-status.ts):
// "on" while a process runs in the Spotlight terminal (starting or
// listening; a busy mark changes nothing), "off" when it doesn't (stopped, a
// death at start, a variant to pick), null when there is no server to show:
// its terminal gone (Orca reads no terminal), or none configured and none
// started.
function serverDot(record) {
  const state = record.serverState;
  if (state === "gone") return null;
  if (state === "listening" || state === "starting") return "on";
  return record.serverCommand || record.serverTerminal ? "off" : null;
}

// The record's root error (a sync's, a light's, Orca's: not a server one),
// or null. Orca's sync error, on the holder's flashlight (D42).
const rootErrorOf = (record) => (record.lastError && !isServerError(record.lastError) ? record.lastError : null);

// ── The holder's row (D42, Orca's WorktreeCardSpotlightControls) ──────────

// The repo's variants (D36, D42): what badges.js detected for the root, else
// the record's candidates while it asks for one; the safe ones only.
function variantsOf(record, detected) {
  const asking = record.serverState === "needs-variant" && Array.isArray(record.variantCandidates) ? record.variantCandidates : [];
  const list = Array.isArray(detected) && detected.length > 0 ? detected : asking;
  return list.filter(isSafeVariant);
}

// The variant the holder's server runs (the popup's selected chip), or null
// when none is picked or a new one is asked for.
const holderVariant = (record) => (record.serverState !== "needs-variant" && isSafeVariant(record.serverVariant) ? record.serverVariant : null);

// 1. Orca's variant tag, on a repo with variants (or whose server ran one):
// a dim pill, the variant uppercased and cut, "?" with none; its click opens
// the server popup's chips. null on a repo with none.
function variantTag(record, at, detected) {
  const variant = holderVariant(record);
  if (variantsOf(record, detected).length === 0 && !isSafeVariant(record.serverVariant)) return null;
  if (!variant) {
    return badge({ text: "?", tone: "dim", pill: true, tooltip: "Todavía no elegiste variante de Spotlight. Clic para elegir una.", action: popup(at) });
  }
  const shown = formatVariant(variant);
  return badge({ text: cut(shown, VARIANT_MAX), tone: "dim", pill: true, tooltip: `Variante de Spotlight: ${shown}. Clic para cambiarla.`, action: popup(at) });
}

// 2. The flashlight of a lit repo's holder row, with the server dot. Its
// tooltip is Orca's: activeHere, lastSynced ("hace 2 min" from `now`; none
// without a sync or a clock), then the server's state; on a root error,
// red, Orca's sync error, then the server's state. A click turns it off.
function holderFlashlight(record, at, { bin, configured, now }) {
  const dot = serverDot(record);
  const server = serverStateText(record, configured, holderVariant(record));
  const error = rootErrorOf(record);
  if (error) {
    const said = sentence(ERROR_TEXT[error.code] ?? oneLine(error.message ?? error.code ?? "error"));
    return badge({ icon: "flashlight", tone: "blocked", tooltip: `La sincronización de Spotlight está fallando: ${said} ${server}`, action: toggle(bin, at), dot });
  }
  const synced = Number.isFinite(record.lastSyncAt) && Number.isFinite(now) ? ` Sincronizado ${timeAgo(record.lastSyncAt, now)}.` : "";
  const tooltip = `Spotlight encendido: este workspace se refleja en el root del proyecto. Clic para apagarlo.${synced} ${server}`;
  return badge({ icon: "flashlight", tone: "working", tooltip, action: toggle(bin, at), dot });
}

// A listening server's tooltip: what runs ("local · pnpm dev") and its URLs,
// the picked port's first.
function listeningTooltip(record, configured) {
  const ports = portsOf(record);
  const picked = pickPort(ports, configured);
  const urls = [picked, ...ports.filter((p) => p !== picked)].filter((p) => p != null).map(portUrl);
  const what = [record.serverEnv, record.serverCommand].filter(Boolean).join(" · ");
  return [what, urls.join(" ")].filter(Boolean).join(" · ");
}

// A down server's words on the holder's line 2 (Herdr's extra states, D24,
// D25), by its error.
const DOWN_TEXT = { [PORT_BUSY]: "puerto ocupado", [SERVER_EXITED]: "server caído", [SERVER_START_FAILED]: "no arrancó" };

// 3. The holder's line 2 (Orca's details row): a server that didn't come up
// and isn't up now (serverDown: the error on top is a server one) as red
// text with its message; else the root's ports, Orca's label, while it
// listens; else null. A click opens the server popup.
function holderLine2(record, at, configured) {
  if (serverDown(record)) {
    const { code, message } = record.lastError;
    return badge({ text: DOWN_TEXT[code], tone: "blocked", line: 2, tooltip: message || errorText(record.lastError), action: popup(at) });
  }
  return portLine2(record, at, configured);
}

// The port on line 2, a dim text badge (Orca's port label), opening the
// server popup; null unless the server listens on a port. The holder's and
// the root's (D42).
function portLine2(record, at, configured) {
  if (record.serverState !== "listening") return null;
  const port = portText(record, configured);
  return port ? badge({ text: port, tone: "dim", line: 2, tooltip: listeningTooltip(record, configured), action: popup(at) }) : null;
}

// ── The root's row while lit (D39, D42, Orca's SpotlightPrimaryBadge) ──────

// The server's state in a tooltip, Orca's sentences in Spanish ("Server
// running on port 3000."), with Herdr's states: a server that didn't come
// up says why. `variant` (the holder's, Orca's spotlightServerVariantLabel):
// "Server corriendo: DO en :3000.", "Server detenido (DO).".
function serverStateText(record, configured, variant = null) {
  if (serverDown(record)) return record.lastError.message || errorText(record.lastError);
  const shown = variant ? formatVariant(variant) : null;
  switch (record.serverState) {
    case "listening": {
      const picked = pickPort(portsOf(record), configured);
      if (shown) return picked === null ? `Server corriendo: ${shown}.` : `Server corriendo: ${shown} en :${picked}.`;
      return picked === null ? "Server corriendo." : `Server corriendo en el puerto ${picked}.`;
    }
    case "starting":
      return "Server arrancando.";
    case "needs-variant":
      return "Elige una variante para arrancar el server.";
    case "gone":
      return "Server cerrado.";
    default:
      if (!record.serverCommand && !record.serverTerminal) return "Sin server.";
      return shown ? `Server detenido (${shown}).` : "Server detenido.";
  }
}

// 1. The SPOTLIGHT chip: a working pill, the flashlight, "Spotlight" (drawn
// uppercase) and the server dot, carrying the row's amber bar (Orca's root
// bar). Its click shows the server's tab, busy or not, whatever the error:
// never red (D42, Orca's), a root error is the holder flashlight's. Busy,
// its icon is the ring.
function rootChip(record, root, { bin, configured, busy }) {
  return badge({
    icon: busy ? "spinner" : "flashlight", spin: busy, text: "Spotlight", tone: "working", pill: true, bar: "working",
    dot: serverDot(record), action: peek(bin, root),
    tooltip: `El root del proyecto refleja "${baseName(record.holder)}". Clic para abrir la terminal del server. ${serverStateText(record, configured)}`,
  });
}

// 3. The logs icon, on the row's hover, with no click: Orca's sentence, with
// the command agents run and the log's path (cli-format.mjs's `status` line).
function rootLogs(record, name) {
  const where = record.logPath ? ` (${record.logPath})` : "";
  return badge({
    icon: "logs", tone: "dim", reveal: "hover",
    tooltip: `Los agentes de cualquier workspace pueden leer los logs del server: spotlight logs --repo ${name}${where}.`,
  });
}

// 4. The X, on the row's hover, dim and amber on hover: the root's turn-off.
// Busy, Orca's disabled X: `disabled`, with no action (D42).
const rootOff = (bin, root, busy) => badge({
  icon: "x", tone: "dim", hover: "working", reveal: "hover", tooltip: "Apagar Spotlight y restaurar el root del proyecto",
  action: toggle(bin, root), disabled: busy,
});

const PAUSED = { limit: "Pausado · sin límite", signin: "Pausado · inicia sesión" };

// Why a waiting task waits, in a few words: its first blocker.
function waitReason(blockers) {
  const b = blockers?.[0];
  if (!b) return null;
  if (b.reason === "lane") return "mismo space";
  if (b.reason === "cap") return "límite alcanzado";
  return b.holding ? "repo ocupado" : "otro va antes";
}

// 4. One queue badge per task that asked: testing wins over waiting, which
// wins over paused. → Map(taskKey → { badge, pill, rows }): `badge` the
// rows' icon (Herdr's extra), `pill` the lane header's, Orca's
// TaskTestTurnBadge (D42): its words in a text pill, no tooltip, no click.
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
    let pill;
    if (t.requests.some((r) => r.state === "holding")) {
      b = badge({ icon: "flask", tone: "working", tooltip: "Probando" });
      pill = badge({ text: "Probando", tone: "working", pill: true, look: "secondary" });
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
        pill = badge({ text: `En cola #${n}`, tone: "dim", pill: true, look: "outline" });
      } else {
        const paused = t.requests.find((r) => r.state === "paused");
        if (!paused) continue;
        b = badge({ icon: "pause", tone: "blocked", tooltip: PAUSED[paused.pauseReason] ?? "Pausado · error" });
        pill = badge({ text: "Pausado", tone: "dim", pill: true, look: "outline" });
      }
    }
    out.set(key, { badge: b, pill, rows: [...t.rows] });
  }
  return out;
}

// ── Task lanes (D29, D31) ──────────────────────────────────────────────────

// The task lanes of each Task-mode group, from projects.cache.v1 as
// projects-sidebar builds them (task.js taskOf: a ticket, or a name
// lowercased; main checkouts and No task have none): [{ group, key,
// members: [{ root, name, workspaces }], skipped: [name] }], members the repos with
// a worktree of the task and Spotlight on (`enabled`), skipped the others,
// both in the group's order. The CLI's `toggle --task` resolves the same
// members (task.js resolveGroupTask).
function taskLanes({ projects, cache, enabled, taskGroups }) {
  const lanes = [];
  for (const group of taskGroups) {
    const byKey = new Map();
    for (const { root, name, group: of } of projects) {
      if (of !== group) continue;
      const mine = new Map(); // task key → this repo's worktrees of it
      for (const c of cache[root] ?? []) {
        const key = taskOf(c)?.key;
        if (key) mine.set(key, [...(mine.get(key) ?? []), c.path]);
      }
      for (const [key, workspaces] of mine) {
        const lane = byKey.get(key) ?? { group, key, members: [], skipped: [] };
        if (enabled[root] === true) lane.members.push({ root, name, workspaces });
        else lane.skipped.push(name);
        byKey.set(key, lane);
      }
    }
    lanes.push(...byKey.values());
  }
  return lanes;
}

const LANE_OFF = "Spotlight de esta tarea: proyecta sus workspaces en el root de cada proyecto.";
const LANE_ON = "Spotlight prendido para esta tarea. Clic para apagarlo en todos los proyectos.";

// A member's repo busy for one of this task's own workspaces (the mark's
// target, D33). Another task's work on a shared repo isn't this task's:
// Orca's TaskSpotlightButton spins only for its own task.
const busyForTask = (member, repos) => {
  const target = busyOf(repos[member.root])?.workspace;
  return isAbsolute(target) && member.workspaces.some((w) => normRoot(w) === normRoot(target));
};

// 1. A task lane's flashlight, or null when no member can hold it. The ring
// while its batch runs (queue.taskBatch[<groupId>/<KEY>]) or a member's repo
// is busy for one of the task's workspaces (D33): no action, the work holds
// the repos' locks.
function laneFlashlight({ group, key, members, skipped }, { state, bin }) {
  if (members.length === 0) return null;
  const repos = state?.repos ?? {};
  if (isObject(state?.queue?.taskBatch?.[`${group}/${key}`]) || members.some((m) => busyForTask(m, repos))) return ring();
  const lit = taskLit(members, repos);
  const off = skipped.length > 0 ? ` Saltado, Spotlight apagado en: ${skipped.join(", ")}` : "";
  return badge({
    icon: "flashlight", tone: lit ? "working" : "dim", tooltip: `${lit ? LANE_ON : LANE_OFF}${off}`,
    action: { exec: [bin, "toggle", "--task", key, "--group", group] },
  });
}

// The env of a task's servers (D32), what its pill says and its popup
// checks. `group`, `key`: the lane (its env key `<group>/<key>`); `members`:
// taskLanes'; `state`, `settings`: board-model.js's. The basis is the
// members held by a workspace of the task, each with the env its server
// runs for it (task-env.js recordEnv: what is stored for its record's key,
// else its settings env; a record lit before T22, its envOverride); with
// none held, every member with its settings env, the env a light would
// start. → { value, shown, repos: [{ name, env }] }: value the env stored
// for the task, else the basis' env when it agrees, else null (Mixto);
// shown as Orca shows its pill, while a member holds or the stored env
// isn't Local.
export function laneEnv({ group, key, members, state, settings }) {
  const repos = isObject(state?.repos) ? state.repos : {};
  const list = Array.isArray(members) ? members : [];
  const stored = storedEnv(state?.envs, `${group}/${key}`);
  const held = list.filter((m) => taskLit([m], repos));
  const basis = (held.length > 0 ? held : list).map((m) => {
    const fallback = repoSettings(settings, m.root).env;
    return { name: m.name ?? baseName(m.root), env: held.length > 0 ? recordEnv(repos[m.root], state?.envs, fallback) : fallback };
  });
  const agreed = basis.length > 0 && basis.every((b) => b.env === basis[0].env) ? basis[0].env : null;
  return {
    value: stored ?? agreed,
    shown: list.length > 0 && (held.length > 0 || (stored !== null && stored !== ENVS[0])),
    repos: basis,
  };
}

// The env popup's choices for a lane (env-view.js): Local, Dev, Prod, the
// lane's `value` (laneEnv's) selected, none for Mixto; each runs `spotlight
// env --task <KEY> --group <id> --env <e>` through `bin`.
export function laneEnvChoices({ group, key, value, bin }) {
  return ENVS.map((env) => ({
    env, label: ENV_LABELS[env], selected: env === value, argv: [bin, "env", "--task", key, "--group", group, "--env", env],
  }));
}

// The id of a lane's env popup: sha1 of `<groupId>/<KEY>`, first 12 hex.
export const laneEnvIdOf = (group, key) => sha1Hex(`${group}/${key}`).slice(0, 12);

// 3. A task lane's env pill (D39, Orca's TaskSpotlightEnvPill): a dim text
// badge, the env and Orca's chevron ("Local ▾"), with no icon and no border.
// Always shown while laneEnv says so (a member holds its root, or the stored
// env isn't Local), otherwise it grows in on the header's hover.
function lanePill({ group, key, members }, { state, settings }) {
  const env = laneEnv({ group, key, members, state, settings });
  const action = { command: `${MOD}.env.${laneEnvIdOf(group, key)}` };
  const reveal = env.shown ? undefined : "grow";
  if (env.value) {
    const label = ENV_LABELS[env.value];
    return badge({ text: `${label} ▾`, tone: "dim", tooltip: `Entorno de Spotlight de esta tarea: ${label}. Clic para cambiarlo.`, action, reveal });
  }
  const each = env.repos.map((r) => `${r.name} ${ENV_LABELS[r.env] ?? r.env}`).join(" · ");
  return badge({ text: "Mixto ▾", tone: "dim", tooltip: `Entorno de Spotlight de esta tarea: mixto (${each}). Clic para elegir uno.`, action, reveal });
}

// Every badge of the moment, and the server popup's id map:
//   state     board-model.js readState(state.json's text)
//   settings  board-model.js readSettings(settings.json's text)
//   projects  parseProjects(shared("projects.v1"))
//   cache     parseCache(shared("projects.cache.v1"))
//   enabled   { [root]: boolean }: whether Spotlight is on for each
//             registered repo (D7, settings.js repoEnabledFrom)
//   bin       board-model.js cliPathOf(appHome())
//   taskGroups  taskModeGroups(shared("projects.v1")): the groups whose
//             task lanes get badges (D29); none by default
//   now       the clock (ms) the holder's "Sincronizado hace <n> min" is
//             told from (D42, badges.js's Date.now()); not a number: no
//             sync sentence
//   variants  { [root]: [variant] }: each lit root's dev:<v> apps (D42,
//             badges.js's detectServerScripts), for the holder's tag; none
//             by default
// → { value: { [path | laneKey]: [badge] } | null, servers: { [id]: { workspace, root } },
//     lanes: { [id]: { group, task, members: [{ root, name, workspaces }] } } }
// `servers` names every workspace Spotlight knows (lit rows, the enabled
// repos' worktrees, the queue's members, the lightings'), so a toast's
// `spotlight.server.<id>` (cli-work.mjs errorNote) resolves too. `lanes`
// names every task lane with a flashlight (and so an env pill), for the env
// popup's `spotlight.env.<id>` (laneEnvIdOf).
export function buildBadges({ state, settings, projects = [], cache = {}, enabled = {}, bin, taskGroups = [], now = null, variants = {} }) {
  const rows = new Map(); // path → [badge, …] in D42's order
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
  const logsOn = new Map(); // lit root → its logs badge, which the root's queue badge replaces (D39)
  const names = new Map(projects.map((p) => [p.root, p.name]));
  for (const [root, record] of Object.entries(repos)) {
    const busy = busyOf(record);
    if (isAbsolute(record.holder)) {
      const holder = normRoot(record.holder);
      lit.set(root, holder);
      const configured = repoSettings(settings, root).port;
      // The holder's row, Orca's order: the variant tag, the flashlight (the
      // ring while busy), then line 2 (before the queue badges, so the cap
      // keeps it).
      const tag = variantTag(record, holder, isObject(variants) ? variants[root] : null);
      if (tag) add(holder, tag);
      const server = serverStateText(record, configured, holderVariant(record));
      add(holder, busy ? ring(serverDot(record), server) : holderFlashlight(record, holder, { bin, configured, now }));
      const under = holderLine2(record, holder, configured);
      if (under) add(holder, under);
      know(holder, root);
      // The root's row, Orca's order: chip (its bar), port (line 2), logs, X
      // (disabled while busy).
      add(root, rootChip(record, root, { bin, configured, busy: Boolean(busy) }));
      const port = portLine2(record, root, configured);
      if (port) add(root, port);
      const logs = rootLogs(record, names.get(root) || baseName(root));
      add(root, logs);
      logsOn.set(root, logs);
      add(root, rootOff(bin, root, Boolean(busy)));
      know(root, root);
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
      // D42: Orca's takeover and idle sentences.
      const tooltip = holder
        ? `Quitarle el Spotlight a "${baseName(holder)}": el root del proyecto reflejará este workspace.`
        : "Spotlight en este workspace: refleja sus cambios en el root del proyecto para probar.";
      // D39: shown on the row's hover, as Orca's idle flashlight.
      add(c.path, badge({ icon: "flashlight", tone: "dim", tooltip, action: toggle(bin, c.path), reveal: "hover" }));
    }
  }

  for (const r of state?.queue?.requests ?? []) {
    for (const m of Array.isArray(r.members) ? r.members : []) for (const w of m?.workspaces ?? [m?.workspace]) know(w, m?.root);
  }
  for (const marker of Object.values(state?.queue?.lighting ?? {})) {
    for (const m of Array.isArray(marker?.members) ? marker.members : []) know(m?.workspace, m?.root);
  }

  const queue = settings?.queue ?? {};
  const queued = queue.enabled !== false ? queueBadges(state, { ...queue }) : new Map();
  for (const { badge: b, rows: at } of queued.values()) {
    for (const p of at) {
      // D39: on a lit root (the root terminal's own request, `cwd:<root>`),
      // the queue badge takes the logs icon's place, within the cap.
      const logs = logsOn.get(p);
      if (!logs) {
        add(p, b);
        continue;
      }
      const list = rows.get(p);
      list[list.indexOf(logs)] = b;
      logsOn.delete(p);
    }
  }

  // The task lanes: `<groupId>/task:<KEY>`, as projects-sidebar keys them
  // (D29); a lane's queue key, and its env key (D32), is `<groupId>/<KEY>` (D12).
  const lanes = {};
  for (const lane of taskLanes({ projects, cache, enabled, taskGroups: Array.isArray(taskGroups) ? taskGroups : [] })) {
    const at = `${lane.group}/task:${lane.key}`;
    // Orca's order (TaskSectionHeader): the flashlight, the queue pill (D42), the env pill.
    const light = laneFlashlight(lane, { state, bin });
    if (light) add(at, light);
    const asked = queued.get(`${lane.group}/${lane.key}`);
    if (asked) add(at, asked.pill);
    if (light) {
      lanes[laneEnvIdOf(lane.group, lane.key)] = { group: lane.group, task: lane.key, members: lane.members };
      add(at, lanePill(lane, { state, settings }));
    }
  }

  const value = {};
  for (const at of [...rows.keys()].sort()) {
    value[at] = rows.get(at).slice(0, PER_ROW);
  }
  return { value: Object.keys(value).length > 0 ? value : null, servers, lanes };
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
