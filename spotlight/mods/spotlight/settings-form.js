// The settings dialog's model (T9, D4, D7, D12, S9): which lanes and repos it
// shows, the form it edits (text for the fields people type in), and the save:
// numbers clamped into their ranges, a server command of more than one line or
// a port outside 1..65535 refused, unknown keys kept, and whether a `queue.*`
// value changed, so the dialog execs `spotlight reap` (Orca's capChanged
// regrant). T26 (D37): each command field's "▾" suggestions and placeholder,
// and a save that turns a lit repo off before it stores `enabled: false`.
// Pure, no Herdr import, so node tests it.

import {
  ENVS,
  SPACELESS,
  CAP,
  PER_SPACE,
  normRoot,
  clampInt,
  parseCommand,
  defaultEnabled,
  repoSettings,
  perSpaceLimit,
} from "./settings.js";
import { commandTemplate } from "./server-plan.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const folderName = (root) => root.split("/").filter(Boolean).pop() ?? root;

export const COMMAND_ERROR = "El comando debe ser una sola línea.";
export const PORT_ERROR = "El puerto va de 1 a 65535.";

// The queue lanes in projects.v1's order (a group's id and name), then the
// lane of repos in no group.
export function lanesOf(registry) {
  const lanes = [];
  for (const g of isObject(registry) && Array.isArray(registry.groups) ? registry.groups : []) {
    if (typeof g?.id !== "string" || !g.id || lanes.some((l) => l.id === g.id)) continue;
    lanes.push({ id: g.id, name: typeof g.name === "string" && g.name ? g.name : g.id });
  }
  lanes.push({ id: SPACELESS, name: "Sin espacio" });
  return lanes;
}

// The repos the dialog lists: every project of a projects.v1 group, in its
// order, then the roots settings.json or state.json know of that no group
// has (lane spaceless). `stateRoots`: state.json's repo roots.
export function reposOf(registry, settings, stateRoots = []) {
  const repos = [];
  const seen = new Set();
  for (const g of isObject(registry) && Array.isArray(registry.groups) ? registry.groups : []) {
    for (const p of Array.isArray(g?.projects) ? g.projects : []) {
      const root = normRoot(p?.path);
      if (!root.startsWith("/") || seen.has(root)) continue;
      seen.add(root);
      const name = typeof p.name === "string" && p.name ? p.name : folderName(root);
      repos.push({ root, name, lane: typeof g.id === "string" && g.id ? g.id : SPACELESS, registered: true });
    }
  }
  for (const raw of [...Object.keys(settings?.repos ?? {}), ...stateRoots]) {
    const root = normRoot(raw);
    if (!root.startsWith("/") || seen.has(root)) continue;
    seen.add(root);
    repos.push({ root, name: folderName(root), lane: SPACELESS, registered: false });
  }
  return repos;
}

// The form for parsed settings: switches as booleans, numbers and commands as
// the text in their fields ("" for none). `lanes` from lanesOf, `repos` from
// reposOf: the ones the dialog shows.
export function toForm(settings, { lanes = [], repos = [] } = {}) {
  const q = settings.queue;
  const perSpace = {};
  for (const lane of lanes) perSpace[lane.id] = String(perSpaceLimit(settings, lane.id));
  const formRepos = {};
  for (const { root } of repos) {
    const r = repoSettings(settings, root);
    formRepos[root] = {
      enabled: typeof r.enabled === "boolean" ? r.enabled : null,
      envs: Object.fromEntries(ENVS.map((e) => [e, r.envs?.[e] ?? ""])),
      env: ENVS.includes(r.env) ? r.env : ENVS[0],
      port: r.port == null ? "" : String(r.port),
    };
  }
  return {
    queue: { enabled: q.enabled, cap: String(q.cap), autoResume: q.autoResume, perSpace },
    repos: formRepos,
  };
}

// A number field's text, clamped into `range`; empty or not a number keeps `current`.
function numberField(text, range, current) {
  const t = String(text ?? "").trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n)) return current;
  return clampInt(n, range);
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Whether a repo record says anything: one with nothing set isn't written.
function repoIsDefault(r) {
  return r.enabled === null && ENVS.every((e) => r.envs[e] === null) && r.env === ENVS[0] && r.port === null;
}

// The form applied to parsed settings: { settings, errors, needsReap }.
// `settings` is null when any field is refused (errors: [{ field, message }],
// field `<root>:envs.<env>` or `<root>:port`); nothing is saved then.
// needsReap: a queue value differs from the stored one.
export function applyForm(settings, form) {
  const errors = [];
  const q = settings.queue;
  const perSpace = { ...q.perSpace };
  for (const [lane, text] of Object.entries(form.queue.perSpace ?? {})) {
    const value = numberField(text, PER_SPACE, perSpaceLimit(settings, lane));
    // A lane at the default isn't written, unless it was stored already.
    if (value === PER_SPACE.fallback && !(lane in q.perSpace)) delete perSpace[lane];
    else perSpace[lane] = value;
  }
  const queue = {
    ...q,
    enabled: Boolean(form.queue.enabled),
    cap: numberField(form.queue.cap, CAP, q.cap),
    autoResume: Boolean(form.queue.autoResume),
    perSpace,
  };

  const repos = { ...settings.repos };
  for (const [root, f] of Object.entries(form.repos ?? {})) {
    const envs = {};
    for (const env of ENVS) {
      const text = String(f.envs?.[env] ?? "").trim();
      envs[env] = text ? parseCommand(text) : null;
      if (text && envs[env] === null) errors.push({ field: `${root}:envs.${env}`, message: COMMAND_ERROR });
    }
    const portText = String(f.port ?? "").trim();
    let port = null;
    if (portText) {
      const n = Number(portText);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
      else errors.push({ field: `${root}:port`, message: PORT_ERROR });
    }
    const next = {
      ...(settings.repos[root] ?? {}),
      enabled: typeof f.enabled === "boolean" ? f.enabled : null,
      envs,
      env: ENVS.includes(f.env) ? f.env : ENVS[0],
      port,
    };
    if (root in settings.repos || !repoIsDefault(next)) repos[root] = next;
  }

  if (errors.length > 0) return { settings: null, errors, needsReap: false };
  const needsReap =
    queue.enabled !== q.enabled ||
    queue.cap !== q.cap ||
    queue.autoResume !== q.autoResume ||
    !sameJson(perSpaceValues(settings, perSpace), perSpaceValues(settings, q.perSpace));
  return { settings: { ...settings, queue, repos }, errors: [], needsReap };
}

// Each lane's effective limit, in a stable order, for comparing two perSpace maps.
function perSpaceValues(settings, perSpace) {
  const lanes = [...new Set([...Object.keys(settings.queue.perSpace), ...Object.keys(perSpace)])].sort();
  return lanes.map((lane) => [lane, perSpace[lane] ?? PER_SPACE.fallback]);
}

export const serializeSettings = (settings) => `${JSON.stringify(settings, null, 2)}\n`;

// ~/.claude, the live harness every session loads: Spotlight is always off there (D7).
export function isHarnessRoot(root, home) {
  return normRoot(root) === `${normRoot(home)}/.claude`;
}

// The Spotlight switch of one repo: its stored value (true, false, or null
// for "not set"), what is in force, and its label. `facts`: repoEnabledFrom's
// { harness, registered, gitRepo, hasServerCommand }, or null while they are
// being looked up.
export function enabledChoice(repo, facts) {
  const value = typeof repo?.enabled === "boolean" ? repo.enabled : null;
  if (facts?.harness) return { value, effective: false, label: "Siempre apagado (~/.claude es el harness en vivo)" };
  if (value !== null) return { value, effective: value, label: value ? "Encendido" : "Apagado" };
  if (!facts) return { value, effective: null, label: "Por defecto: …" };
  const effective = defaultEnabled(facts);
  if (effective) return { value, effective, label: "Por defecto: encendido" };
  const why = !facts.registered
    ? "no está en un espacio"
    : !facts.gitRepo
      ? "no es un repo git"
      : "sin comando de server";
  return { value, effective, label: `Por defecto: apagado (${why})` };
}

// ── Command fields: "▾" suggestions and placeholders (D37) ─────────────────

// What a command field shows when nothing would start for its env.
export const NO_START = "No arranca";

// A command field's "▾" list: every dev/local/prod/start script of the repo's
// package.json as a command (detectServerScripts' scriptCommands, Orca's
// datalist). `detection`: detectServerScripts' answer, or null.
export function scriptSuggestions(detection) {
  const list = detection?.scriptCommands;
  return Array.isArray(list) ? list.filter((c) => typeof c === "string" && c) : [];
}

// A command field's placeholder: the command that runs for `env` while the
// field is empty (Orca's commandsExcluding): the other envs' saved commands,
// then the detected ones; Local falls back to Dev; `{variant}` left unfilled
// and no `--port` (the port has its own field). NO_START when none.
// `stored`: the repo's settings entry (repoSettings), as saved.
export function commandPlaceholder(stored, detection, env) {
  const envs = {};
  for (const other of ENVS) {
    if (other !== env && stored?.envs?.[other]) envs[other] = stored.envs[other];
  }
  return commandTemplate({ settings: { envs }, detected: detection?.detected ?? {}, env }) ?? NO_START;
}

// ── Apagado on a lit repo (D37, Orca's RepositorySpotlightSection) ─────────

// The turn-off waits this long: a turn-off stops the server (up to 8 s for
// the prompt, 3 s more to kill) and restores the root (git work).
export const TURN_OFF_TIMEOUT_MS = 120000;

// Whether state.json (board-model readState's shape) has the repo lit: its
// record exists from the turn-on to the turn-off. `state` null (the file
// couldn't be read) can't tell, so it counts as lit: the turn-off then asks
// the CLI, whose `root-is-holder` says nothing was lit.
export function isLit(state, root) {
  if (state == null) return true;
  const key = normRoot(root);
  return Object.keys(state?.repos ?? {}).some((r) => normRoot(r) === key);
}

// The CLI argv that turns the repo off: always the root, which only ever
// turns off (never lights), whoever holds it now.
export const turnOffArgv = (root) => ["toggle", "--workspace", normRoot(root), "--inline"];

// The save in two steps when a lit repo is switched to Apagado: applyForm's
// answer, plus `turnOff` [{ root, argv }], the repos switched to Apagado
// (stored value not already false) that `state` (state.json) has lit. Their
// `enabled` keeps its stored value in `settings`, the first write; the dialog
// turns each off, then writes `enabled: false` (withEnabledOff) for the ones
// that went off. Nothing to turn off when a field is refused.
export function planSave(settings, form, state) {
  const out = applyForm(settings, form);
  if (!out.settings) return { ...out, turnOff: [] };
  const turnOff = [];
  const repos = { ...out.settings.repos };
  for (const [root, f] of Object.entries(form.repos ?? {})) {
    const before = settings.repos[root];
    if (f.enabled !== false || before?.enabled === false || !isLit(state, root)) continue;
    turnOff.push({ root, argv: turnOffArgv(root) });
    if (before) repos[root] = { ...repos[root], enabled: before.enabled ?? null };
    else if (repos[root] && repoIsDefault({ ...repos[root], enabled: null })) delete repos[root];
    else if (repos[root]) repos[root] = { ...repos[root], enabled: null };
  }
  return { ...out, settings: { ...out.settings, repos }, turnOff };
}

// Settings with `enabled: false` for `roots` (the repos whose turn-off went
// through); every other value kept. A new object: `settings` is left alone.
export function withEnabledOff(settings, roots) {
  const repos = { ...settings.repos };
  for (const raw of roots) {
    const root = normRoot(raw);
    repos[root] = { ...(repos[root] ?? {}), enabled: false };
  }
  return { ...settings, repos };
}

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// The turn-off's exec answer ({ code, stdout, stderr }, or { error } when the
// exec threw) as { ok, message }. Exit 0 went off; `root-is-holder` means
// nothing is lit any more (the record went since the re-read), so the switch
// can be written too. Otherwise the switch stays on and `message` is stderr's
// first line (else stdout's, else the exit code).
export function turnOffOutcome(result) {
  if (result?.error !== undefined) {
    return { ok: false, message: firstLine(result.error?.message ?? result.error) || "no se pudo apagar" };
  }
  if (result?.code === 0) return { ok: true, message: "" };
  const line = firstLine(result?.stderr);
  if (line.startsWith("root-is-holder")) return { ok: true, message: "" };
  return { ok: false, message: line || firstLine(result?.stdout) || `salió con código ${result?.code}` };
}
