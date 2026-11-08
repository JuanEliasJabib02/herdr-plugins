// The command a repo's Spotlight server runs (D10): per environment (local,
// dev, prod; Local falls back to Dev), from the repo's settings or detected
// from its package.json, `--port N` appended, the `{variant}` placeholder
// filled with the app the task works on (chosen now, remembered for the
// task, or inferred from the `apps/<V>/` folders its branch touched), and the
// lockfile installs chained first. Ports Orca Pro Max's
// spotlight-server-script-detection, -server-variant(-detection),
// -variant-inference, -server-command and -lockfile-install. Beyond Orca:
// the port a start will take (D23), read from the scripts the command runs,
// so a port someone else holds is caught before the line is typed (D24).
//
// Everything here ends up as a line typed into a shell, and a branch's
// package.json and folder names feed it, so only exact `local`/`dev`/`prod`
// scripts or names matching SAFE_SCRIPT_NAME become commands, and only
// variants matching ^[A-Za-z0-9_-]+$ are ever substituted.
//
// No herdr, gpui-kit or node imports, so the mod and the CLI share it and
// `node --test` loads it. File reads and git are passed in:
//   io   { readText(path, maxBytes) → string | null,
//          kind(path) → "file" | "dir" | "other" | "none" | null (couldn't tell),
//          listDirs(path) → folder names | null }
//        nodeIo(fs) builds one from `node:fs/promises`.
//   git  (cwd, args) → stdout; rejects when git fails or can't start.

// ── Environments ───────────────────────────────────────────────────────────

export const SERVER_ENVS = Object.freeze(["local", "dev", "prod"]);
export const DEFAULT_ENV = "local";

export const isServerEnv = (value) => SERVER_ENVS.includes(value);

// ── Variants ───────────────────────────────────────────────────────────────
// A repo's variants are the apps one server runs one at a time (landing's
// countries); a command picks the chosen one through `{variant}`.

export const VARIANT_PLACEHOLDER = "{variant}";
export const MAX_VARIANT_LENGTH = 64;
// Why: the value is typed into a terminal, so only plain tokens are ever substituted.
const SAFE_VARIANT = /^[A-Za-z0-9_-]+$/;

export function isSafeVariant(value) {
  return typeof value === "string" && value.length <= MAX_VARIANT_LENGTH && SAFE_VARIANT.test(value);
}

export function needsVariant(command) {
  return typeof command === "string" && command.includes(VARIANT_PLACEHOLDER);
}

// Fills every `{variant}`; null when the command needs one and `variant` is
// missing or unsafe, so a literal placeholder is never typed.
export function fillVariant(command, variant) {
  if (!needsVariant(command)) return command;
  return isSafeVariant(variant) ? command.replaceAll(VARIANT_PLACEHOLDER, variant) : null;
}

// How a variant label reads in the UI (`do` → `DO`).
export const formatVariant = (variant) => variant.toUpperCase();

// The toast an inferred variant leaves (D10).
export const inferredVariantNote = (variant) => `Variante ${variant} inferida de ${APPS_DIR}/${variant}/`;

// ── Commands per environment ───────────────────────────────────────────────

export const MAX_COMMAND_LENGTH = 2000;

// A saved command as it can be typed: trimmed, one line, at most 2000
// characters; null otherwise. Truncating would run half a command and a
// second line would run as its own, so both are dropped instead.
export function normalizeCommand(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

export function normalizePort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

// `settings`: the repo's entry in settings.json ({ envs: { local, dev, prod },
// port }); `detected`: detectServerScripts(...).detected. The saved command
// wins, then the detected one.
function pickCommand(env, settings, detected) {
  return normalizeCommand(settings?.envs?.[env]) ?? normalizeCommand(detected?.[env]);
}

// The command for `env` with `{variant}` left in place and the port
// appended; null when the repo isn't started there. Local falls back to Dev
// (some repos, landing, have no Local script and run their Dev one).
export function commandTemplate({ settings, detected, env } = {}) {
  const e = isServerEnv(env) ? env : DEFAULT_ENV;
  const command = pickCommand(e, settings, detected) ?? (e === "local" ? pickCommand("dev", settings, detected) : null);
  if (!command) return null;
  const port = normalizePort(settings?.port);
  return port === null ? command : `${command} --port ${port}`;
}

// The command that starts the server in `env`, or null when it isn't started
// there; a `{variant}` command is null until a safe `variant` is given.
export function resolveCommand(args = {}) {
  const template = commandTemplate(args);
  return template === null ? null : fillVariant(template, args.variant);
}

// The environments that would start something (the server popup's radio).
export function serverEnvsWithCommand({ settings, detected } = {}) {
  return SERVER_ENVS.filter((env) => commandTemplate({ settings, detected, env }) !== null);
}

// ── Script detection from package.json ────────────────────────────────────

const PACKAGE_JSON = "package.json";
// A bigger package.json is not a normal project manifest.
const PACKAGE_JSON_MAX_BYTES = 128 * 1024;
const PACKAGE_MANAGER_FIELD_MAX_BYTES = 64 * 1024;
const MAX_SCRIPT_SUGGESTIONS = 50;
const SERVER_SCRIPT_PREFIXES = ["dev", "local", "prod", "start"];
// Why: suggested commands are typed into a terminal, so a script name with
// shell syntax is skipped (Orca's SAFE_SCRIPT_NAME).
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/;

export const isSafeScriptName = (name) => typeof name === "string" && SAFE_SCRIPT_NAME.test(name);

const PACKAGE_MANAGER_LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function utf8Length(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function scriptNamesOf(pkg) {
  const scripts = pkg?.scripts;
  return scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) ? Object.keys(scripts) : [];
}

function managerFromField(value) {
  if (typeof value !== "string" || utf8Length(value) > PACKAGE_MANAGER_FIELD_MAX_BYTES) return null;
  const v = value.trim().toLowerCase();
  return ["pnpm", "bun", "yarn", "npm"].find((m) => v.startsWith(`${m}@`)) ?? null;
}

// The repo's package manager: package.json's packageManager field, else its
// lockfiles (one manager's), else npm; null when lockfiles of different
// managers leave it ambiguous.
async function packageManagerOf(pkg, dir, io) {
  const fromField = managerFromField(pkg.packageManager);
  if (fromField) return fromField;
  const present = [];
  for (const [file, manager] of PACKAGE_MANAGER_LOCKFILES) {
    if ((await kindOf(io, join(dir, file))) === "file") present.push(manager);
  }
  const managers = new Set(present);
  if (managers.size > 1) return null;
  return present[0] ?? "npm";
}

function scriptCommand(runner, script) {
  switch (runner) {
    case "pnpm":
    case "yarn":
      return `${runner} ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      // The trailing `--` makes the appended `--port N` reach the script.
      return `npm run ${script} --`;
  }
}

// Monorepo folder whose `<V>` subfolders are the apps a variant runs.
const APPS_DIR = "apps";
const VARIANT_SCRIPT_PREFIX = "dev:";
const MAX_VARIANTS = 50;
// Bounds the folder listing; a real apps/ folder holds a handful of apps.
const MAX_APP_DIR_ENTRIES = 1000;

async function appDirNames(dir, io) {
  const names = await io.listDirs(join(dir, APPS_DIR));
  if (!Array.isArray(names)) return null;
  return new Set(names.slice(0, MAX_APP_DIR_ENTRIES).map((n) => String(n).toLowerCase()));
}

// Codes `<v>` of the `dev:<v>` scripts that pick one app to serve. With an
// apps/ folder only codes with an apps/<V> app count (stale scripts drop
// out). None when the repo has a plain `dev` script (its dev:* siblings are
// helpers) or fewer than two codes (no choice to make).
async function detectVariants(dir, scriptNames, io) {
  if (scriptNames.includes("dev")) return [];
  const codes = new Map();
  for (const name of scriptNames) {
    if (!name.startsWith(VARIANT_SCRIPT_PREFIX)) continue;
    const code = name.slice(VARIANT_SCRIPT_PREFIX.length);
    // Case-insensitive: `dev:do` and `dev:DO` would run the same app.
    if (isSafeVariant(code) && !codes.has(code.toLowerCase())) codes.set(code.toLowerCase(), code);
  }
  if (codes.size < 2) return [];
  const apps = await appDirNames(dir, io);
  const variants = [...codes.values()].filter((code) => apps === null || apps.has(code.toLowerCase()));
  return variants.length >= 2 ? variants.sort().slice(0, MAX_VARIANTS) : [];
}

// The `<env>:{variant}` script for each environment some variant has a script for.
function variantScriptTemplates(scriptNames, variants) {
  const names = new Set(scriptNames);
  const templates = {};
  for (const env of SERVER_ENVS) {
    if (variants.some((v) => names.has(`${env}:${v}`))) templates[env] = `${env}:${VARIANT_PLACEHOLDER}`;
  }
  return templates;
}

// The repo's package.json scripts as server commands, read in `dir` (the
// root, which holds the lit workspace's tree):
//   detected        { local?, dev?, prod? }: an exact script of that name,
//                   else the variant family (`pnpm dev:{variant}`)
//   scriptCommands  every safe dev/local/prod/start script, sorted (settings' suggestions)
//   variants        the dev:<v> apps, sorted; absent when the repo has none
// Never throws: anything unreadable is "nothing detected".
export async function detectServerScripts(dir, io) {
  const result = { detected: {}, scriptCommands: [] };
  try {
    const text = await io.readText(join(dir, PACKAGE_JSON), PACKAGE_JSON_MAX_BYTES);
    if (typeof text !== "string" || utf8Length(text) > PACKAGE_JSON_MAX_BYTES) return result;
    const pkg = parseObject(text);
    const scriptNames = scriptNamesOf(pkg);
    if (scriptNames.length === 0) return result;
    // Before the runner: a typed `{variant}` command needs them whatever the manager.
    const variants = await detectVariants(dir, scriptNames, io);
    if (variants.length > 0) result.variants = variants;
    const runner = await packageManagerOf(pkg, dir, io);
    if (runner === null) return result;
    const names = new Set(scriptNames);
    const templates = variantScriptTemplates(scriptNames, variants);
    for (const env of SERVER_ENVS) {
      const script = names.has(env) ? env : templates[env];
      if (script) result.detected[env] = scriptCommand(runner, script);
    }
    result.scriptCommands = scriptNames
      .filter((n) => isSafeScriptName(n) && SERVER_SCRIPT_PREFIXES.some((p) => n.startsWith(p)))
      .sort()
      .slice(0, MAX_SCRIPT_SUGGESTIONS)
      .map((n) => scriptCommand(runner, n));
    return result;
  } catch {
    return { detected: {}, scriptCommands: [] };
  }
}

// Whether the repo has a server command in some environment: one saved in
// its settings entry, or one detected from package.json. With none, an
// enabled-by-default repo stays off (D7); `start` alone is only a suggestion.
export async function hasServerCommand(root, io, settings) {
  if (SERVER_ENVS.some((env) => normalizeCommand(settings?.envs?.[env]) !== null)) return true;
  const { detected } = await detectServerScripts(root, io);
  return serverEnvsWithCommand({ detected }).length > 0;
}

// ── The port a start will take (D23) ───────────────────────────────────────
// Read before the server line is typed, so a port someone else already
// holds is caught first (D24): settings' port when set (the command carries
// it as `--port N`), else the first port the command's server line names,
// found by following package.json's scripts. Unknown is null: no pre-check.

// The dev servers whose port flags are read; anything else's -p is not a port.
const PORT_SERVERS = new Set(["next", "vite", "astro", "nuxt", "remix", "react-router", "webpack-dev-server", "serve"]);
// Script references followed: the command, then up to this many scripts deep.
const MAX_SCRIPT_DEPTH = 3;
const PACKAGE_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const RUN_ALL = new Set(["npm-run-all", "run-p", "run-s"]);
// Options of npm-run-all and concurrently that take the next word as their value.
const RUN_ALL_VALUE_OPTIONS = new Set(["--max-parallel", "--npm-path"]);
const CONCURRENTLY_VALUE_OPTIONS = new Set([
  "-n", "--names", "-c", "--prefix-colors", "-p", "--prefix", "-l", "--prefix-length", "-m", "--max-processes",
  "-t", "--timestamp-format", "-s", "--success", "--name-separator", "--restart-tries", "--restart-after",
  "--kill-signal", "--default-input-target", "--hide",
]);
// `npm:dev:*` and its siblings: concurrently's shorthand for running scripts.
const CONCURRENTLY_SCRIPT = /^(?:npm|pnpm|yarn|bun):(.+)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const wordBase = (word) => String(word).split("/").pop();
const toPort = (text) => (/^\d{1,5}$/.test(text ?? "") ? normalizePort(Number(text)) : null);
const quoteWord = (word) => (PLAIN_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// A script line split as sh would, as far as package.json scripts go: '…',
// "…" and \x quoting, and commands joined by && || ; | &. Each command is
// its words, quotes removed.
function shellCommands(line) {
  const commands = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word = (word ?? "") + line.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && j + 1 < line.length) {
          text += line[j + 1];
          j += 2;
        } else {
          text += line[j];
          j += 1;
        }
      }
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i += 1;
    } else if (c === " " || c === "\t" || c === "\n") {
      endWord();
    } else if (c === "&" || c === "|" || c === ";") {
      endCommand();
      if (c !== ";" && line[i + 1] === c) i += 1;
    } else {
      word = (word ?? "") + c;
    }
  }
  endCommand();
  return commands;
}

// The scripts a name or an npm-run-all glob names: `*` is one `:` segment,
// `**` any number.
function scriptsMatching(pattern, scripts) {
  if (!pattern.includes("*")) return Object.hasOwn(scripts, pattern) ? [pattern] : [];
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^:]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const re = new RegExp(`^${source}$`);
  return Object.keys(scripts).filter((name) => re.test(name));
}

// The port of a dev server's command: the first -p N, --port N or --port=N
// after the server's word, else a PORT=N among its words (the flag wins, as
// the servers read it). Not a server command: undefined.
function serverLinePort(words) {
  const at = words.findIndex((w) => PORT_SERVERS.has(wordBase(w)));
  if (at === -1) return undefined;
  for (let i = at + 1; i < words.length; i += 1) {
    const w = words[i];
    const port = w === "-p" || w === "--port" ? toPort(words[i + 1]) : w.startsWith("--port=") ? toPort(w.slice(7)) : null;
    if (port !== null) return port;
  }
  for (const w of words) {
    const port = w.startsWith("PORT=") ? toPort(w.slice(5)) : null;
    if (port !== null) return port;
  }
  return null;
}

function portOfScript(name, extra, scripts, depth) {
  if (depth >= MAX_SCRIPT_DEPTH || !Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") return null;
  // Extra args reach the script's end, as the package managers pass them.
  const line = extra.length > 0 ? `${scripts[name]} ${extra.map(quoteWord).join(" ")}` : scripts[name];
  return portOfLine(line, scripts, depth + 1);
}

function firstPort(names, scripts, depth) {
  for (const name of names) {
    const port = portOfScript(name, [], scripts, depth);
    if (port !== null) return port;
  }
  return null;
}

function portOfCommand(words, scripts, depth) {
  let i = 0;
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i += 1;
  const tool = wordBase(words[i] ?? "");
  const rest = words.slice(i + 1);
  let script = null;
  if (PACKAGE_RUNNERS.has(tool) && (rest[0] === "run" || rest[0] === "run-script") && rest[1]) script = [rest[1], rest.slice(2)];
  // `pnpm dev`, `yarn dev`: a script by its bare name.
  else if ((tool === "pnpm" || tool === "yarn") && rest[0] && Object.hasOwn(scripts, rest[0])) script = [rest[0], rest.slice(1)];
  if (script) {
    const [name, extra] = script;
    return portOfScript(name, extra[0] === "--" ? extra.slice(1) : extra, scripts, depth);
  }
  if (RUN_ALL.has(tool)) {
    const names = [];
    for (let j = 0; j < rest.length; j += 1) {
      if (RUN_ALL_VALUE_OPTIONS.has(rest[j])) j += 1;
      else if (!rest[j].startsWith("-")) names.push(...scriptsMatching(rest[j].split(/\s+/)[0], scripts));
    }
    return firstPort(names, scripts, depth);
  }
  if (tool === "concurrently") {
    for (let j = 0; j < rest.length; j += 1) {
      const arg = rest[j];
      if (CONCURRENTLY_VALUE_OPTIONS.has(arg)) {
        j += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      const shorthand = CONCURRENTLY_SCRIPT.exec(arg);
      // A quoted command is a shorter line than this one, so this ends.
      const port = shorthand ? firstPort(scriptsMatching(shorthand[1], scripts), scripts, depth) : portOfLine(arg, scripts, depth);
      if (port !== null) return port;
    }
    return null;
  }
  return serverLinePort(words) ?? null;
}

function portOfLine(line, scripts, depth) {
  for (const words of shellCommands(line)) {
    const port = portOfCommand(words, scripts, depth);
    if (port !== null) return port;
  }
  return null;
}

// The port `command` will listen on, from its own words and the package.json
// `scripts` it runs (pnpm|npm|yarn|bun run <s>, pnpm|yarn <s>, npm-run-all,
// run-p, run-s and concurrently, three scripts deep); null when no next,
// vite, astro, nuxt, remix, react-router, webpack-dev-server or serve line
// on the way names one.
export function portFromCommand(command, scripts) {
  const known = scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
  if (typeof command !== "string" || command === "") return null;
  return portOfLine(command, known, 0);
}

// A repo's package.json scripts ({} when unreadable).
async function readScripts(root, io) {
  try {
    const text = await io.readText(join(root, PACKAGE_JSON), PACKAGE_JSON_MAX_BYTES);
    const scripts = typeof text === "string" ? parseObject(text)?.scripts : null;
    return scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
  } catch {
    return {};
  }
}

// The port a start of `command` in `root` takes (D23): `settings.port` (the
// repo's entry in settings.json) when set, else portFromCommand over the
// root's package.json. null when unknown.
export async function expectedPort({ root, command, settings, io } = {}) {
  const configured = normalizePort(settings?.port);
  if (configured !== null) return configured;
  if (typeof command !== "string" || command === "") return null;
  return portFromCommand(command, await readScripts(root, io));
}

// ── Variant inference from what the branch changed ─────────────────────────

// A branch that rewrote thousands of files still only needs its first paths read.
const MAX_CHANGED_PATHS = 20_000;
const MAX_BASE_REF_LENGTH = 512;
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

const ambiguous = (candidates = []) => ({ kind: "ambiguous", candidates });

// Variants (in their own order) whose apps/<V>/ folder holds one of the
// repo-relative `paths`, matched ignoring case.
export function mapChangedPathsToVariants(paths, variants) {
  const byFolder = new Map(variants.map((v) => [v.toLowerCase(), v]));
  const prefix = `${APPS_DIR}/`;
  const touched = new Set();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    // A file directly under apps/ belongs to no app.
    if (slash <= 0) continue;
    const v = byFolder.get(rest.slice(0, slash).toLowerCase());
    if (v) touched.add(v);
  }
  return variants.filter((v) => touched.has(v));
}

// Why: refs come from saved settings, and one starting with `-` would read as
// a git option.
function isUsableBaseRef(ref) {
  return typeof ref === "string" && ref.length > 0 && ref.length <= MAX_BASE_REF_LENGTH && !ref.startsWith("-") && !/\s/.test(ref);
}

async function mergeBaseWith(git, cwd, ref) {
  try {
    const sha = String(await git(cwd, ["merge-base", ref, "HEAD"])).trim();
    return COMMIT_ID.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// HEAD's merge-base with the first base that has one; the default base is
// resolved only when every given one fails.
async function findMergeBase(git, cwd, baseRefs, resolveDefaultBaseRef) {
  for (const ref of baseRefs ?? []) {
    if (!isUsableBaseRef(ref)) continue;
    const sha = await mergeBaseWith(git, cwd, ref);
    if (sha) return sha;
  }
  const fallback = await Promise.resolve()
    .then(() => resolveDefaultBaseRef?.() ?? null)
    .catch(() => null);
  return isUsableBaseRef(fallback) ? mergeBaseWith(git, cwd, fallback) : null;
}

// Which variant the workspace `cwd` works on: the apps/<V>/ folders its
// working tree changed since it left its base. Uncommitted edits count, and
// so do new untracked files (beyond Orca, whose diff misses them): Spotlight
// projects both onto the root. Exactly one is { kind: "inferred", variant };
// several or none stay { kind: "ambiguous", candidates } with the touched
// ones. Never throws: a git failure is ambiguous with no candidates.
export async function inferVariant({ git, cwd, variants, baseRefs = [], resolveDefaultBaseRef } = {}) {
  if (!Array.isArray(variants) || variants.length === 0) return ambiguous();
  const mergeBase = await findMergeBase(git, cwd, baseRefs, resolveDefaultBaseRef);
  if (!mergeBase) return ambiguous();
  let out;
  try {
    // The working tree, not `...HEAD`; the pathspec keeps the output to apps/.
    out = String(await git(cwd, ["diff", "--name-only", "--no-renames", "-z", mergeBase, "--", `${APPS_DIR}/`]));
    out += String(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", `${APPS_DIR}/`]));
  } catch {
    return ambiguous();
  }
  const paths = out.split("\0").filter(Boolean).slice(0, MAX_CHANGED_PATHS);
  const touched = mapChangedPathsToVariants(paths, variants);
  return touched.length === 1 ? { kind: "inferred", variant: touched[0] } : ambiguous(touched);
}

const DEFAULT_BASE_PROBES = [
  ["refs/remotes/origin/main", "origin/main"],
  ["refs/remotes/origin/master", "origin/master"],
  ["refs/heads/main", "main"],
  ["refs/heads/master", "master"],
];

// The repo's default base: origin/HEAD's target, else the first of
// origin/main, origin/master, main, master that exists; null when none does
// or git fails. One for-each-ref read.
export async function defaultBaseRef(git, cwd) {
  const originHead = "refs/remotes/origin/HEAD";
  const refs = [originHead, ...DEFAULT_BASE_PROBES.map(([ref]) => ref)];
  // A character class forces an exact match instead of descendants such as main/topic.
  const patterns = refs.map((ref) => `${ref.slice(0, -1)}[${ref.slice(-1)}]`);
  try {
    const out = String(await git(cwd, ["for-each-ref", "--format=%(refname)%00%(symref)", ...patterns]));
    const present = new Set();
    for (const line of out.split(/\r?\n/)) {
      const sep = line.indexOf("\0");
      if (sep === -1) continue;
      const ref = line.slice(0, sep);
      const target = line.slice(sep + 1);
      if (ref === originHead && target) return target.replace(/^refs\/remotes\//, "");
      present.add(ref);
    }
    return DEFAULT_BASE_PROBES.find(([ref]) => present.has(ref))?.[1] ?? null;
  } catch {
    return null;
  }
}

// ── The variant remembered per task ────────────────────────────────────────
// A plain map { "<task key>::<root>": variant }, oldest first, which the
// caller persists; a hand-edited one is read defensively.

export const MAX_REMEMBERED_VARIANTS = 500;
const MAX_TASK_KEY_LENGTH = 200;
const MAX_ROOT_LENGTH = 4096;
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function variantKey(taskKey, root) {
  if (typeof taskKey !== "string" || taskKey === "" || taskKey.length > MAX_TASK_KEY_LENGTH || UNSAFE_RECORD_KEYS.has(taskKey)) return null;
  if (typeof root !== "string" || root === "" || root.length > MAX_ROOT_LENGTH) return null;
  return `${taskKey}::${root}`;
}

// The variant last chosen or inferred for this repo in this task; null when none.
export function rememberedVariant(map, taskKey, root) {
  const key = variantKey(taskKey, root);
  if (key === null || map === null || typeof map !== "object" || !Object.hasOwn(map, key)) return null;
  return isSafeVariant(map[key]) ? map[key] : null;
}

// A new map with `variant` stored for the task's repo, re-added last; the
// oldest entries go past MAX_REMEMBERED_VARIANTS. The same map back when
// nothing changes or the pick can't be stored.
export function rememberVariant(map, taskKey, root, variant) {
  const key = variantKey(taskKey, root);
  const current = map !== null && typeof map === "object" ? map : {};
  if (key === null || !isSafeVariant(variant)) return map;
  if (Object.hasOwn(current, key) && current[key] === variant) return map;
  const next = { ...current };
  delete next[key];
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_VARIANTS + 1))) delete next[stale];
  next[key] = variant;
  return next;
}

// ── The plan ───────────────────────────────────────────────────────────────

// At most this many variants offered when the branch doesn't tell.
export const MAX_VARIANT_PROMPT_CHOICES = 6;

// The server command for one repo in `env`, Orca's planSpotlightActivationCommand:
//   { kind: "command", env, command, variant, source, note }
//       source: "chosen" | "remembered" | "inferred" (variant commands) | null;
//       note: the toast text when inferred. The caller remembers a chosen or
//       inferred variant for the task (rememberVariant).
//   { kind: "none", env }            no command for `env` (e.g. a backend in Dev)
//   { kind: "none", env: null }      a {variant} command nothing can fill
//   { kind: "ask-variant", candidates }  the branch doesn't tell: the apps it
//       touched, else every variant (at most 6). Never a literal `{variant}`.
// `variants`: detection's; while it knows none, any safe pick is accepted (a
// failed detection must not drop a choice). `infer`: () → inferVariant(...),
// run only when no chosen or remembered variant settles it.
export async function planServerCommand({ settings, detected, variants: given, env = DEFAULT_ENV, chosenVariant, remembered, infer } = {}) {
  const variants = Array.isArray(given) ? given : [];
  const e = isServerEnv(env) ? env : DEFAULT_ENV;
  const template = commandTemplate({ settings, detected, env: e });
  if (template === null) return { kind: "none", env: e };
  const command = (variant, source, note = null) => ({ kind: "command", env: e, command: fillVariant(template, variant), variant, source, note });
  if (!needsVariant(template)) return command(null, null);
  const known = (v) => isSafeVariant(v) && (variants.length === 0 || variants.includes(v));
  if (isSafeVariant(chosenVariant)) return command(chosenVariant, "chosen");
  if (known(remembered)) return command(remembered, "remembered");
  let inference;
  try {
    inference = (await infer?.()) ?? ambiguous();
  } catch {
    inference = ambiguous();
  }
  if (inference.kind === "inferred" && known(inference.variant)) {
    return command(inference.variant, "inferred", inferredVariantNote(inference.variant));
  }
  const touched = inference.kind === "ambiguous" && Array.isArray(inference.candidates) ? inference.candidates.filter(known) : [];
  const candidates = (touched.length > 0 ? touched : variants.filter(isSafeVariant)).slice(0, MAX_VARIANT_PROMPT_CHOICES);
  return candidates.length > 0 ? { kind: "ask-variant", candidates } : { kind: "none", env: null };
}

// The whole plan for a lit workspace: detection in `root`, inference in
// `workspace` against `baseRefs` (then the repo's default base), the task's
// remembered pick from `remembered` (the map rememberVariant keeps), `env`
// or else the repo's saved one (settings' `env`). The plan plus `detection`,
// for the server popup's envs and variant chips.
export async function planServer({ root, workspace, settings, env, taskKey, remembered, chosenVariant, baseRefs = [], io, git }) {
  const detection = await detectServerScripts(root, io);
  const variants = detection.variants ?? [];
  const cwd = workspace ?? root;
  const plan = await planServerCommand({
    settings,
    detected: detection.detected,
    variants,
    env: env ?? settings?.env ?? DEFAULT_ENV,
    chosenVariant,
    remembered: rememberedVariant(remembered, taskKey, root),
    infer: () => inferVariant({ git, cwd, variants, baseRefs, resolveDefaultBaseRef: () => defaultBaseRef(git, cwd) }),
  });
  return { ...plan, detection };
}

// ── Lockfile installs ──────────────────────────────────────────────────────
// Spotlight projects code onto the root but not installed dependencies, so a
// lockfile change leaves the root's install stale, and a root never
// installed has none. The next line typed into the server terminal installs
// first. pnpm and uv; also the install order for a repo with both.

const INSTALLERS = {
  pnpm: { lockfile: "pnpm-lock.yaml", installed: "node_modules", install: "pnpm install --frozen-lockfile" },
  uv: { lockfile: "uv.lock", installed: ".venv", install: "uv sync --frozen" },
};
const INSTALLER_ORDER = ["pnpm", "uv"];

// Known installers only, each once, in install order (a state.json list is
// read defensively).
export function installsFor(...lists) {
  const wanted = new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
  return INSTALLER_ORDER.filter((i) => wanted.has(i));
}

// The installers whose lockfile differs between two snapshots of the root
// and still exists in `toSha`: one diff for both lockfiles, then one read per
// changed one. A git failure, or an id that isn't a commit id, flags nothing
// (it never blocks Spotlight). The caller adds them to `pendingInstalls`.
export async function lockfileInstalls({ git, root, fromSha, toSha }) {
  if (!fromSha || fromSha === toSha || !COMMIT_ID.test(String(fromSha)) || !COMMIT_ID.test(String(toSha))) return [];
  const lockfiles = INSTALLER_ORDER.map((i) => INSTALLERS[i].lockfile);
  let changed;
  try {
    changed = String(await git(root, ["diff-tree", "--name-only", fromSha, toSha, "--", ...lockfiles]));
  } catch {
    return [];
  }
  const paths = new Set(changed.split(/\r?\n/).map((l) => l.trim()));
  const flagged = [];
  for (const installer of INSTALLER_ORDER) {
    const { lockfile } = INSTALLERS[installer];
    if (!paths.has(lockfile)) continue;
    // A deleted lockfile also reads as changed, but there is nothing to install from.
    try {
      if (String(await git(root, ["rev-parse", "--verify", "-q", `${toSha}:${lockfile}`])).trim()) flagged.push(installer);
    } catch {
      // Missing in toSha, or git failed: don't flag.
    }
  }
  return flagged;
}

// The installers whose lockfile is at the root without what they install
// (node_modules, .venv as a directory): its server can't start before one.
// Read on disk now; a lookup that fails for any reason but absence never
// asks for an install.
export async function missingInstalls(root, io) {
  const missing = [];
  for (const installer of INSTALLER_ORDER) {
    const { lockfile, installed } = INSTALLERS[installer];
    try {
      if ((await io.kind(join(root, lockfile))) !== "file") continue;
      const k = await io.kind(join(root, installed));
      if (k !== null && k !== "dir") missing.push(installer);
    } catch {
      // Unknown: never ask.
    }
  }
  return missing;
}

// The installs in order, then `command`, each only if the previous one
// succeeded (zsh's `&&`). No installs: `command` alone.
export function chainInstall(command, installers) {
  return installsFor(installers).reduceRight((rest, i) => `${INSTALLERS[i].install} && ${rest}`, command);
}

// ── Node file access for the CLI ───────────────────────────────────────────

// An `io` over `node:fs/promises` (passed in, so this file imports nothing).
// stat follows symlinks: a worktree's linked node_modules is a directory.
export function nodeIo(fs) {
  const kind = async (path) => {
    try {
      const s = await fs.stat(path);
      return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
    } catch (e) {
      return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? "none" : null;
    }
  };
  return {
    kind,
    async readText(path, maxBytes = Infinity) {
      try {
        const s = await fs.stat(path);
        if (!s.isFile() || s.size > maxBytes) return null;
        return await fs.readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async listDirs(path) {
      try {
        const entries = await fs.readdir(path, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return null;
      }
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function join(dir, name) {
  return `${String(dir).replace(/\/+$/, "")}/${name}`;
}

async function kindOf(io, path) {
  try {
    return await io.kind(path);
  } catch {
    return null;
  }
}
