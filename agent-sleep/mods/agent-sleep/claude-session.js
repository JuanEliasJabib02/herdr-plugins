// Which Claude session a terminal holds (D3). Pure: no herdr import, no
// clock; the one function that needs I/O (loadSession) takes it injected,
// shaped like herdr's `exec(cmd, args)` → { code, stdout, stderr } and a
// text reader, so the coordinator passes the real ones and tests pass fakes.
//
// Claude Code 2.1.318 writes `<config dir>/sessions/<pid>.json` for every
// running Claude: { pid, sessionId, cwd, procStart, kind, status, ... }. The
// config dir is `~/.claude` (System default) or the CLAUDE_CONFIG_DIR it runs
// with: a claude-accounts account or an Orca profile (D15). It is trusted only
// when:
//   - Core's foreground.name says Claude (claude, or claude.exe as the OS
//     names the native binary);
//   - its procStart equals `TZ=UTC ps -o lstart= -p <pid>` (runs of spaces
//     collapsed), so a pid the OS reused never borrows a dead session;
//   - kind is "interactive";
//   - sessionId passes Orca's check (agent-session-resume.ts:115-131);
//   - its transcript exists, found by id with
//     `find -H <config dir>/projects -maxdepth 2 -name <id>.jsonl` (Claude
//     hashes folder names past 200 chars, so the folder is never rebuilt from
//     cwd; a profile's projects/ is a symlink to ~/.claude/projects, which
//     -H follows).
// Which config dir: the first candidate (loadConfigDirs) whose file passes
// those checks. A Claude whose file is in none of them never sleeps.
//
// After /exit, Claude prints "Resume this session with:" and the command;
// the id there wins over the file's (it follows /clear), taken only from a
// line shaped `^(\w+=\S+ )?claude( \S+)* (--resume|-r) (\S+)$`. Any other
// shape keeps the file's id and says why.

export const RESUME_HINT = "Resume this session with:";

// Core's foreground.name as the OS has it (`hc get t1p --json`: "claude.exe").
const CLAUDE_NAMES = new Set(["claude", "claude.exe"]);

export function isClaudeName(name) {
  return typeof name === "string" && CLAUDE_NAMES.has(name);
}

// ── The id check, Orca agent-session-resume.ts:105-131 ─────────────────────

const PROVIDER_SESSION_ID_MAX_LENGTH = 512;

function hasUnsafeProviderSessionIdChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// The trimmed id, or null: empty, longer than 512, starting with `-` (it
// would read as a flag) or carrying a control character.
export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > PROVIDER_SESSION_ID_MAX_LENGTH ||
    trimmed.startsWith("-") ||
    hasUnsafeProviderSessionIdChars(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

// What Claude 2.1.318 prints in its resume hint: a UUID or nothing (its
// `Ut()`, case-insensitive). A wrapped hint cuts the id at the terminal's
// edge; a cut UUID is no longer one.
const CLAUDE_HINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── A Claude's config dir (D15) ────────────────────────────────────────────

// The one check on a config dir, wherever one comes from: the candidate list,
// a stored record (store.js) and the resume command (resume.js). An absolute
// path with no control character (C0, DEL, C1). System default is null, never
// a string. The string is never normalized: the claude launcher and the
// Keychain key on it exactly, trailing slash included.
export function isConfigDir(value) {
  return typeof value === "string" && value.startsWith("/") && !/\p{Cc}/u.test(value);
}

// ── Paths and commands (argv arrays; the coordinator runs them) ───────────

const isPid = (pid) => Number.isSafeInteger(pid) && pid > 0;
const isHome = (home) => typeof home === "string" && home.startsWith("/") && home.length > 1;
const trimSlash = (path) => path.replace(/\/+$/, "");

// The folder Claude keeps its files in: the config dir (only for building
// paths: `/x/home/` and `/x/home` are the same folder), or ~/.claude for
// System default (null). Null when either fails its check.
function configFolder(home, configDir) {
  if (configDir === null || configDir === undefined) return isHome(home) ? `${trimSlash(home)}/.claude` : null;
  return isConfigDir(configDir) ? trimSlash(configDir) : null;
}

export function sessionFilePath(home, pid, configDir = null) {
  const folder = configFolder(home, configDir);
  if (folder === null || !isPid(pid)) return null;
  return `${folder}/sessions/${pid}.json`;
}

// `TZ=UTC ps -o lstart= -p <pid>`: `env` sets TZ so no shell is involved.
export function procStartCommand(pid) {
  if (!isPid(pid)) return null;
  return ["env", "TZ=UTC", "ps", "-o", "lstart=", "-p", String(pid)];
}

// ps pads a day under 10 with a second space and may end with spaces or a
// newline; the session file has its own padding. Both collapse to one form.
export function normalizeProcStart(text) {
  if (typeof text !== "string") return null;
  const flat = text.trim().replace(/\s+/g, " ");
  return flat === "" ? null : flat;
}

// ── The session file (D3) ──────────────────────────────────────────────────

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function parseFile(file) {
  if (file === null || file === undefined) return { reason: "no-session-file" };
  if (isObject(file)) return { data: file };
  if (typeof file !== "string") return { reason: "bad-session-file" };
  try {
    const data = JSON.parse(file);
    return isObject(data) ? { data } : { reason: "bad-session-file" };
  } catch {
    return { reason: "bad-session-file" };
  }
}

// One check of a session file against the process Core shows:
//   pid             foreground.pid
//   foregroundName  foreground.name
//   file            the file's text (or the object already parsed); null
//                   or undefined when it couldn't be read
//   procStart       what procStartCommand(pid) printed
// → { ok: true, sessionId, cwd, status } or { ok: false, reason }. `cwd` is
// null unless the file has an absolute one; `status` is the file's own
// ("idle" while Core says done), for D4's re-read before a stop.
export function checkSession({ pid, foregroundName, file, procStart } = {}) {
  if (!isClaudeName(foregroundName)) return { ok: false, reason: "not-claude" };
  if (!isPid(pid)) return { ok: false, reason: "bad-pid" };
  const parsed = parseFile(file);
  if (parsed.reason) return { ok: false, reason: parsed.reason };
  const data = parsed.data;
  if (data.pid !== undefined && data.pid !== pid) return { ok: false, reason: "pid-mismatch" };
  const live = normalizeProcStart(procStart);
  if (live === null) return { ok: false, reason: "no-proc-start" };
  if (normalizeProcStart(data.procStart) !== live) return { ok: false, reason: "proc-start-mismatch" };
  if (data.kind !== "interactive") return { ok: false, reason: "not-interactive" };
  const sessionId = normalizeSessionId(data.sessionId);
  if (sessionId === null) return { ok: false, reason: "invalid-session-id" };
  const cwd = typeof data.cwd === "string" && data.cwd.startsWith("/") ? data.cwd : null;
  const status = typeof data.status === "string" ? data.status : null;
  return { ok: true, sessionId, cwd, status };
}

// ── The transcript, found by id ────────────────────────────────────────────

// `-H` follows the start point when it is a symlink (a profile's projects/
// links to ~/.claude/projects) and nothing under it.
export function transcriptLookupCommand(home, sessionId, configDir = null) {
  const id = normalizeSessionId(sessionId);
  const folder = configFolder(home, configDir);
  if (folder === null || id === null) return null;
  return ["find", "-H", `${folder}/projects`, "-maxdepth", "2", "-name", `${id}.jsonl`];
}

// The first line of find's output that is exactly
// `<config dir>/projects/<one folder>/<id>.jsonl`. `-name` is a glob, so
// an id with `*` could list other transcripts: only the exact name counts.
export function parseTranscriptLookup(stdout, { home, sessionId, configDir = null } = {}) {
  const id = normalizeSessionId(sessionId);
  const folder = configFolder(home, configDir);
  if (typeof stdout !== "string" || folder === null || id === null) return null;
  const root = `${folder}/projects/`;
  const name = `/${id}.jsonl`;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(root) || !line.endsWith(name)) continue;
    const folder = line.slice(root.length, line.length - name.length);
    if (folder !== "" && !folder.includes("/")) return line;
  }
  return null;
}

// ── loadSession: D3 end to end, I/O injected ───────────────────────────────

async function run(exec, argv) {
  try {
    const result = await exec(argv[0], argv.slice(1));
    return isObject(result) && typeof result.stdout === "string" ? result : null;
  } catch {
    return null;
  }
}

async function read(readText, path) {
  try {
    const text = await readText(path);
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

// { home, pid, foregroundName, configDirs } and { readText(path),
// exec(cmd, args) } → checkSession's result plus `configDir` (the candidate
// whose file passed, exactly as given; null for ~/.claude) and `transcript`
// (its path, or null when none was found: rules.js's `no-transcript`).
// `configDirs` is loadConfigDirs' list, ~/.claude alone by default; a
// candidate failing isConfigDir is skipped unread. ps runs once, at the first
// file found. With no file passing: the first failure, or `no-session-file`
// when no candidate had one. Never throws: a read or exec that fails is a
// refusal. ps's output counts only when it exited 0; find's stdout counts
// whatever its exit code (unreadable folders make it exit 1 while still
// listing what it found).
export async function loadSession({ home, pid, foregroundName, configDirs = [null] } = {}, { readText, exec } = {}) {
  if (!isClaudeName(foregroundName)) return { ok: false, reason: "not-claude" };
  if (sessionFilePath(home, pid) === null) return { ok: false, reason: "bad-pid" };
  let procStart;
  let failure = null;
  for (const configDir of Array.isArray(configDirs) ? configDirs : [null]) {
    const path = sessionFilePath(home, pid, configDir);
    if (path === null) continue;
    const file = await read(readText, path);
    if (file === null) continue;
    if (procStart === undefined) {
      const ps = await run(exec, procStartCommand(pid));
      procStart = ps && ps.code === 0 ? ps.stdout : null;
    }
    const checked = checkSession({ pid, foregroundName, file, procStart });
    if (!checked.ok) {
      failure ??= checked;
      continue;
    }
    const dir = configDir ?? null;
    const found = await run(exec, transcriptLookupCommand(home, checked.sessionId, dir));
    const transcript = found ? parseTranscriptLookup(found.stdout, { home, sessionId: checked.sessionId, configDir: dir }) : null;
    return { ...checked, configDir: dir, transcript };
  }
  return failure ?? { ok: false, reason: "no-session-file" };
}

// ── Where a Claude's config dir can be (D15) ───────────────────────────────
// As claude-accounts searches for a Claude's account (its cli/terminals.mjs
// configDirs, cli/paths.mjs): System default, every saved account's exact
// configDir, then every profile folder no account has. Read-only: this mod
// never writes claude-accounts' files, nor needs it installed.

// claude-accounts' list of saved accounts, under Herdr's home.
export function accountsPath(appHome) {
  return isHome(appHome) ? `${trimSlash(appHome)}/claude-accounts/accounts.json` : null;
}

// accounts.json → the saved accounts' config dirs, in file order. It is a
// top-level JSON array (claude-accounts' readRegistry); anything else, or a
// file that doesn't parse, gives none. Each element counts only for a
// configDir that passes isConfigDir, kept exactly.
export function parseAccounts(text) {
  if (typeof text !== "string") return [];
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((a) => isObject(a) && isConfigDir(a.configDir)).map((a) => a.configDir);
}

// The folders holding profile folders (`<root>/<name>/home`): Orca Dev's and
// Orca's claude-profiles, then claude-accounts' own beside Herdr's home.
export function profileRoots(home, appHome) {
  const roots = [];
  if (isHome(home)) {
    const support = `${trimSlash(home)}/Library/Application Support`;
    roots.push(`${support}/Orca Dev/claude-profiles`, `${support}/Orca/claude-profiles`);
  }
  if (isHome(appHome)) roots.push(`${trimSlash(appHome)}/claude-accounts-profiles`);
  return roots;
}

// The folders right under a root (no listing API in Herdr, so `find`). -H
// follows the root itself when it is a symlink; entries that are symlinks
// aren't folders here, as for claude-accounts' readdir.
export function profileListCommand(root) {
  return ["find", "-H", root, "-mindepth", "1", "-maxdepth", "1", "-type", "d"];
}

// find's lines → `<root>/<name>/home` for each folder exactly one level down,
// sorted (find lists in directory order).
export function parseProfileList(stdout, root) {
  if (typeof stdout !== "string" || typeof root !== "string") return [];
  const prefix = `${root}/`;
  const names = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const name = line.slice(prefix.length);
    if (name !== "" && !name.includes("/")) names.push(name);
  }
  return names.sort().map((name) => `${prefix}${name}/home`);
}

// The candidates loadSession tries, in order: null (~/.claude), the saved
// accounts' dirs, the profile folders; each string once, ~/.claude's own
// path never as a string (it is System default). One read and up to three
// listings. Never throws: what can't be read gives no candidate.
export async function loadConfigDirs({ home, appHome } = {}, { readText, exec } = {}) {
  const dirs = [null];
  const seen = new Set(isHome(home) ? [`${trimSlash(home)}/.claude`] : []);
  const add = (dir) => {
    if (isConfigDir(dir) && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  };
  const accounts = accountsPath(appHome);
  if (accounts !== null) for (const dir of parseAccounts(await read(readText, accounts))) add(dir);
  for (const root of profileRoots(home, appHome)) {
    const found = await run(exec, profileListCommand(root));
    if (found) for (const dir of parseProfileList(found.stdout, root)) add(dir);
  }
  return dirs;
}

// ── The exit screen ────────────────────────────────────────────────────────

const HINT_COMMAND = /^(\w+=\S+ )?claude( \S+)* (--resume|-r) (\S+)$/;
const HINT_NO_ID = /^(\w+=\S+ )?claude( \S+)* (--resume|-r)$/;
const HINT_CLOUD = /^(\w+=\S+ )?claude --cloud( |$)/;

// The last "Resume this session with:" on the screen and the line under it:
//   shape     "resume"  a resume command with a valid id
//             "no-id"   `claude … --resume` and nothing after
//             "cloud"   `claude --cloud <id>` (a cloud session)
//             "other"   any other line: wrapped, a path to claude, an id
//                       that fails Orca's check or isn't the UUID Claude
//                       prints
//             "absent"  no hint on the screen
//   sessionId the id, only for "resume"
//   env       a leading `NAME=value` Claude asked for, or null
//   flags     the flags Claude printed between `claude` and its worktree
//             and resume selector (for "resume"), else null
//   worktree  the name in `--worktree "<n>"` / `-w "<n>"`, or null
//   line      the command line as read, or null
export function parseExitScreen(text) {
  const result = { shape: "absent", sessionId: null, env: null, flags: null, worktree: null, line: null };
  if (typeof text !== "string") return result;
  const lines = text.split("\n").map((l) => l.trimEnd());
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].endsWith(RESUME_HINT)) {
      at = i;
      break;
    }
  }
  if (at === -1) return result;
  const line = lines[at + 1] ?? "";
  result.line = line;
  if (HINT_CLOUD.test(line)) return { ...result, shape: "cloud" };
  if (HINT_NO_ID.test(line)) return { ...result, shape: "no-id" };
  const match = HINT_COMMAND.exec(line);
  const id = match ? normalizeSessionId(match[4]) : null;
  if (id === null || id !== match[4] || !CLAUDE_HINT_ID.test(id)) return { ...result, shape: "other" };
  const tokens = line.split(" ");
  const env = match[1] ? tokens.shift() : null;
  tokens.shift(); // claude
  tokens.splice(-2); // the selector and the id
  let worktree = null;
  const n = tokens.length;
  if (n >= 2 && (tokens[n - 2] === "--worktree" || tokens[n - 2] === "-w") && /^".*"$/.test(tokens[n - 1])) {
    worktree = tokens[n - 1].slice(1, -1);
    tokens.splice(-2);
  }
  return { ...result, shape: "resume", sessionId: id, env, flags: tokens, worktree };
}

// The id to resume after /exit: the printed one when parseExitScreen found
// it, else the session file's, with a line saying why for the log.
// → { sessionId (null when neither is valid), from: "exit" | "file" | null, log }
export function exitSessionId(fileSessionId, parsed) {
  if (isObject(parsed) && parsed.shape === "resume") {
    const id = normalizeSessionId(parsed.sessionId);
    if (id !== null) return { sessionId: id, from: "exit", log: null };
  }
  const shape = isObject(parsed) && typeof parsed.shape === "string" ? parsed.shape : "absent";
  const seen = isObject(parsed) && typeof parsed.line === "string" ? ` (${JSON.stringify(parsed.line)})` : "";
  const fileId = normalizeSessionId(fileSessionId);
  if (fileId === null) {
    return { sessionId: null, from: null, log: `exit screen: ${shape}${seen}; no valid session id to fall back on` };
  }
  return { sessionId: fileId, from: "file", log: `exit screen: ${shape}${seen}; kept the session file's id` };
}
