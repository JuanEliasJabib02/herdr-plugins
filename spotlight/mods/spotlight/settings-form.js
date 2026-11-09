// The settings dialog's model (T9, D4, D7, D12, S9): which lanes and repos it
// shows, the form it edits (text for the fields people type in), and the save:
// numbers clamped into their ranges, a server command of more than one line or
// a port outside 1..65535 refused, unknown keys kept, and whether a `queue.*`
// value changed, so the dialog execs `spotlight reap` (Orca's capChanged
// regrant). T26 (D37): each command field's "▾" suggestions and placeholder,
// and turning a lit repo off before `enabled: false` is stored. T40 (D47,
// Orca's RepositorySpotlightSection / RepositorySpotlightServerFields): no
// Guardar; each control saves on its own (saveChange) through settings.json's
// compare-and-swap (casWrite): the "Usar Spotlight" switch on change (a lit
// repo turned off first, Apagar igual when refused), the fields on blur or
// Enter, and Orca's help texts in Spanish.
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
  parseSettings,
  repoSettings,
  perSpaceLimit,
} from "./settings.js";
import { commandTemplate, formatVariant, VARIANT_PLACEHOLDER } from "./server-plan.js";

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

// ── Orca's help texts, in Spanish (D47) ────────────────────────────────────

// RepositorySpotlightSection's (the section, the logs, the switch) and
// RepositorySpotlightServerFields' (Server, Puerto).
export const HELP = {
  section: "Prueba los cambios de un workspace en el root del proyecto sin duplicar dependencias instaladas ni builds.",
  logs: "Con Spotlight encendido, la salida de la terminal del server queda en un log que los agentes de cualquier workspace leen con `spotlight logs`.",
  switchLabel: "Usar Spotlight",
  switch: "Muestra un botón de Spotlight en los workspaces de este proyecto que refleja sus cambios en el root del proyecto.",
  serverTitle: "Server",
  server: "Spotlight corre este comando en la terminal de Spotlight al prenderse y le agrega --port N. Un campo vacío usa el script detectado en package.json. Local usa Dev si no tiene.",
  portLabel: "Puerto",
  port: "Se agrega al comando como --port N. Vacío deja el puerto del comando.",
  portPlaceholder: "Por defecto del comando",
  // Orca's toast action on a refused turn-off: the forced one.
  forceOff: "Apagar igual",
};

// Orca's variant help, only for a repo with variants (detectServerScripts'
// `variants`); null otherwise. `detection`: its answer, or null.
export function variantHelp(detection) {
  const variants = Array.isArray(detection?.variants) ? detection.variants.filter((v) => typeof v === "string" && v) : [];
  if (variants.length === 0) return null;
  return `Este proyecto corre uno de ${variants.map(formatVariant).join(", ")} a la vez. Escribe ${VARIANT_PLACEHOLDER} en un comando para correr el de cada tarea: Spotlight lo elige por las apps que cambió la rama de la tarea, o pregunta.`;
}

// ── One control, one save (D47) ────────────────────────────────────────────

// A change is one control's new value:
//   { queue: "enabled" | "autoResume", value: boolean }   the queue's switches
//   { queue: "cap", value: text }                          Máximo en total
//   { queue: "perSpace", lane, value: text }               a space's limit
//   { root, field: "enabled", value: boolean }             Usar Spotlight
//   { root, field: "env", value: "local" | "dev" | "prod" } the env chip
//   { root, field: "envs.<env>", value: text }             a command field
//   { root, field: "port", value: text }                   Puerto

const envOf = (field) => (typeof field === "string" && field.startsWith("envs.") ? field.slice(5) : null);

// The stored value a change is about, as parsed settings hold it (a repo
// with no record reads as the defaults).
function storedValue(settings, change) {
  if (change.root !== undefined) {
    const r = repoSettings(settings, change.root);
    const env = envOf(change.field);
    if (env) return r.envs?.[env] ?? null;
    if (change.field === "enabled") return typeof r.enabled === "boolean" ? r.enabled : null;
    if (change.field === "env") return ENVS.includes(r.env) ? r.env : ENVS[0];
    if (change.field === "port") return r.port ?? null;
    return undefined;
  }
  if (change.queue === "perSpace") return perSpaceLimit(settings, change.lane);
  return settings.queue?.[change.queue];
}

// What one change saves: applyForm's answer for a form that is the stored
// settings with that one control changed, so a save checks, trims and clamps
// exactly as before, and keeps every other value and unknown key.
// `settings` is null when nothing is written: the value is refused (errors:
// [{ field, message }]) or what is stored already (an unchanged value, Enter
// then blur). needsReap: a queue value changed (the dialog runs the reap).
export function saveChange(settings, change) {
  const nothing = { settings: null, errors: [], needsReap: false };
  const root = change?.root !== undefined ? normRoot(change.root) : null;
  const lanes = change?.queue === "perSpace" && change.lane ? [{ id: change.lane }] : [];
  const form = toForm(settings, { lanes, repos: root ? [{ root }] : [] });
  if (root) {
    const f = form.repos[root];
    const env = envOf(change.field);
    if (env && ENVS.includes(env)) f.envs[env] = change.value;
    else if (change.field === "enabled" || change.field === "env" || change.field === "port") f[change.field] = change.value;
    else return nothing;
  } else if (change?.queue === "perSpace" && change.lane) form.queue.perSpace[change.lane] = change.value;
  else if (["enabled", "autoResume", "cap"].includes(change?.queue)) form.queue[change.queue] = change.value;
  else return nothing;
  const out = applyForm(settings, form);
  if (!out.settings) return { settings: null, errors: out.errors, needsReap: false };
  const key = root ? { ...change, root } : change;
  if (sameJson(storedValue(out.settings, key), storedValue(settings, key))) return nothing;
  return out;
}

// The text a typed field shows for the stored value: the trimmed command,
// the clamped number, or the stored one again for text that wasn't a number.
export function fieldText(settings, change) {
  const value = storedValue(settings, change?.root !== undefined ? { ...change, root: normRoot(change.root) } : change);
  return value == null ? "" : String(value);
}

// One change written through settings.json's compare-and-swap (D7: only the
// mod writes it, against the text it read). `io`: { read() → text | null,
// write(text, expected) }, which rejects on a stale snapshot (expected null
// creates the file). `snapshot`: { text, settings } as last read or written.
// `apply(settings)`: saveChange's answer for those settings. A stale snapshot
// reads the file again and applies the change to what it holds now (another
// writer's values kept), up to `tries` times. Answers { ok, wrote, text,
// settings } (the snapshot to keep), { ok: false, wrote: false, errors } for
// a refused value, or { ok: false, wrote: false } when every try was stale.
export async function casWrite(io, snapshot, apply, tries = 3) {
  let text = snapshot.text;
  let settings = snapshot.settings;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      try {
        text = await io.read();
      } catch {
        continue;
      }
      settings = parseSettings(text).settings;
    }
    const out = apply(settings);
    if (out.errors?.length > 0) return { ok: false, wrote: false, errors: out.errors };
    if (!out.settings) return { ok: true, wrote: false, text, settings, needsReap: false };
    const next = serializeSettings(out.settings);
    try {
      await io.write(next, text);
    } catch {
      continue; // Stale: read it again.
    }
    return { ok: true, wrote: true, text: next, settings: parseSettings(next).settings, needsReap: out.needsReap };
  }
  return { ok: false, wrote: false };
}

// ── Usar Spotlight (D47) and turning a lit repo off first (D37) ────────────

// The switch of one repo: `on` what it shows (the stored value, or the
// registration default for an unset repo), `disabled` when it can't be
// flipped (~/.claude, always off; or the default still being looked up), and
// `note` the dim line beside it: the default and why, or the harness. `repo`:
// its repoSettings record; `facts`: as enabledChoice takes them.
export function spotlightSwitch(repo, facts) {
  const choice = enabledChoice(repo, facts);
  const harness = Boolean(facts?.harness);
  return {
    on: choice.effective === true,
    disabled: harness || choice.effective === null,
    note: harness || choice.value === null ? choice.label : "",
  };
}

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

// Apagar igual: the same turn-off, forced (the root's own changes or the
// untracked files in the way are dropped, as the server popup's).
export const forceTurnOffArgv = (root) => [...turnOffArgv(root), "--force"];

// What flipping a repo's switch does: `shown` is what it shows (spotlightSwitch's
// `on`), the flip saves the opposite. Off on a repo `state` (state.json) has
// lit turns it off first: `turnOff` { root, argv }, and `change` is written
// only once it went off (afterTurnOff's writeOff); otherwise `change` is
// written at once. null when what it shows isn't known.
export function flipSpotlight(root, shown, state) {
  if (typeof shown !== "boolean") return null;
  const key = normRoot(root);
  const change = { root: key, field: "enabled", value: !shown };
  const turnOff = shown && isLit(state, key) ? { root: key, argv: turnOffArgv(key) } : null;
  return { change, turnOff };
}

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// The turn-off's exec answer ({ code, stdout, stderr }, or { error } when the
// exec threw) as { ok, message }. Exit 0 went off; `root-is-holder` means
// nothing is lit any more (the record went since state.json was read), so
// the switch can be written too. Otherwise the switch stays on and `message`
// is stderr's first line (else stdout's, else the exit code).
export function turnOffOutcome(result) {
  if (result?.error !== undefined) {
    return { ok: false, message: firstLine(result.error?.message ?? result.error) || "no se pudo apagar" };
  }
  if (result?.code === 0) return { ok: true, message: "" };
  const line = firstLine(result?.stderr);
  if (line.startsWith("root-is-holder")) return { ok: true, message: "" };
  return { ok: false, message: line || firstLine(result?.stdout) || `salió con código ${result?.code}` };
}

// The refusals Apagar igual forces, the CLI's own (its hint and the server
// popup's): the root changed outside the workspace, or untracked files in the
// way. A message is `<code>: …` (the CLI's stderr).
const FORCEABLE = ["root-diverged", "untracked-collision"];
export const offersForce = (message) => FORCEABLE.some((code) => String(message ?? "").startsWith(`${code}:`));

// What the dialog does once a turn-off answered: { ok, message, writeOff,
// offerForce }. A turn-off of the switch that went off writes `enabled:
// false`; a refused one leaves the switch on and offers Apagar igual when
// forcing fixes the refusal. Apagar igual (`forced`) never writes the switch:
// it stays on whatever the answer, as after Orca's toast action.
export function afterTurnOff(result, { forced = false } = {}) {
  const { ok, message } = turnOffOutcome(result);
  return { ok, message, writeOff: ok && !forced, offerForce: !ok && !forced && offersForce(message) };
}
