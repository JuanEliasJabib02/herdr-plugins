// Spotlight's settings.json (D7, D12, S9): the queue switch, the per-space
// limit, the global cap, auto-resume, and per repo whether Spotlight is on,
// its server command per env, the env and the port. Written only by the mod
// (the settings view, writeTextFile compare-and-swap); the CLI reads it
// through store.js. Pure, no Node or Herdr import, so the mod and the CLI
// share it:
//   { version: 1,
//     queue: { enabled: true, perSpace: { <groupId>|"spaceless": 1 }, cap: 2, autoResume: false },
//     repos: { <root>: { enabled: true|false|null, envs: { local, dev, prod: command|null },
//                        env: "local", port: null } } }
// Reading never throws: a value that isn't a v1 object is the defaults
// (valid: false, so the CLI keeps a backup); inside one, each field is
// clamped or falls back on its own. Unknown keys at the top and in a repo
// record are kept, so a later field survives a read-modify-write.

export const SETTINGS_VERSION = 1;

// The server environments, in the settings view's order; the first is the default.
export const ENVS = ["local", "dev", "prod"];

// The lane of a repo outside every projects.v1 group (D12).
export const SPACELESS = "spaceless";

// Integer ranges: the global cap (1..4, D12) and each space's limit, which
// can't usefully pass the cap.
export const CAP = { min: 1, max: 4, fallback: 2 };
export const PER_SPACE = { min: 1, max: 4, fallback: 1 };
const PORT = { min: 1, max: 65535 };

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// One spelling per repo root: forward slashes, no trailing slash ("/" stays
// "/"). Anything but a string is "".
export function normRoot(path) {
  if (typeof path !== "string" || !path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    queue: { enabled: true, perSpace: {}, cap: CAP.fallback, autoResume: false },
    repos: {},
  };
}

// A repo with nothing set: `enabled: null` means "not set", so the
// registration default applies (repoEnabledFrom).
export function defaultRepoSettings() {
  return { enabled: null, envs: { local: null, dev: null, prod: null }, env: ENVS[0], port: null };
}

// A number rounded and clamped into [min, max]; anything but a finite
// number is the fallback.
export function clampInt(value, { min, max, fallback }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// A server command is one non-empty line (it is typed into a shell); anything else is null.
export function parseCommand(value) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line && !/[\r\n]/.test(line) ? line : null;
}

function parsePort(value) {
  return Number.isInteger(value) && value >= PORT.min && value <= PORT.max ? value : null;
}

function parseQueue(value) {
  const q = isObject(value) ? value : {};
  const perSpace = {};
  for (const [lane, limit] of Object.entries(isObject(q.perSpace) ? q.perSpace : {})) {
    if (!lane || typeof limit !== "number" || !Number.isFinite(limit)) continue;
    perSpace[lane] = clampInt(limit, PER_SPACE);
  }
  return {
    ...q,
    enabled: typeof q.enabled === "boolean" ? q.enabled : true,
    perSpace,
    cap: clampInt(q.cap, CAP),
    autoResume: typeof q.autoResume === "boolean" ? q.autoResume : false,
  };
}

function parseRepo(value) {
  const r = isObject(value) ? value : {};
  const envs = isObject(r.envs) ? r.envs : {};
  return {
    ...r,
    enabled: typeof r.enabled === "boolean" ? r.enabled : null,
    envs: Object.fromEntries(ENVS.map((e) => [e, parseCommand(envs[e])])),
    env: ENVS.includes(r.env) ? r.env : ENVS[0],
    port: parsePort(r.port),
  };
}

// A stored settings value, as text (the file) or already parsed, read as
// { settings, valid }. Nothing stored is the defaults and valid; text that
// isn't JSON, or a value that isn't a v1 object, is the defaults and not
// valid. Repo keys are normalized (normRoot); a relative one, or a record
// that isn't an object, is dropped; a root listed twice keeps the first.
export function parseSettings(raw) {
  if (raw == null) return { settings: defaultSettings(), valid: true };
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { settings: defaultSettings(), valid: false };
    }
  }
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return { settings: defaultSettings(), valid: false };
  const repos = {};
  for (const [root, record] of Object.entries(isObject(value.repos) ? value.repos : {})) {
    const key = normRoot(root);
    if (!key.startsWith("/") || !isObject(record) || key in repos) continue;
    repos[key] = parseRepo(record);
  }
  return {
    settings: { ...value, version: SETTINGS_VERSION, queue: parseQueue(value.queue), repos },
    valid: true,
  };
}

// A repo's record from parsed settings, the defaults when it has none.
export function repoSettings(settings, root) {
  return settings?.repos?.[normRoot(root)] ?? defaultRepoSettings();
}

// How many tasks of one lane (a projects.v1 group id, or "spaceless") may
// hold a turn at once.
export function perSpaceLimit(settings, lane) {
  return settings?.queue?.perSpace?.[lane] ?? PER_SPACE.fallback;
}

// Whether Spotlight is on for a repo (D7). `repo`: its repoSettings record.
// `facts`: { harness, registered, gitRepo, hasServerCommand }, booleans:
//   harness            the root is ~/.claude (realpath match), the live
//                      harness every session loads: always off;
//   registered         the root is a project in a projects.v1 group;
//   gitRepo            it is a git repo;
//   hasServerCommand   T5a finds a server command for it.
// A set `enabled` wins; unset, it is on only when registered, a git repo
// and with a server command (Orca turns Spotlight on for new local repos,
// new-project-defaults.ts:27-28; repos with nothing to serve still get
// slot-only turns, D12).
export function repoEnabledFrom(repo, facts) {
  if (facts?.harness) return false;
  if (typeof repo?.enabled === "boolean") return repo.enabled;
  return defaultEnabled(facts);
}

// The registration default alone, for a repo with no `enabled` value.
export function defaultEnabled(facts) {
  return Boolean(facts?.registered && facts?.gitRepo && facts?.hasServerCommand);
}
