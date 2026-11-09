// Which account and conversation a Herdr terminal runs (D7, which answers S4:
// no hook needed). Owner: T4.
//
//   terminal <t> [--json] → { account, sessionId, status, resumable }
//     account: the id of the account whose config dir holds the terminal's
//     live session file ("default" for ~/.claude), or null when that folder
//     belongs to no account (an Orca or Herdr profile folder the registry
//     doesn't have, such as a removed account's). status: "idle" or "busy".
//     resumable: the conversation has a transcript, so `claude --resume`
//     can continue it (a Claude that hasn't been sent a message yet has a
//     session file but no transcript: it can't move, Orca's no-session).
//     Exits 3 when the terminal is missing or isn't running Claude, 2 when
//     its Claude has no session file yet (CONTRACT.md), 1 when hc fails.
//
// inspectTerminal(t, known): the D7 chain for one terminal, read when it's
// needed and never cached (`/clear` changes the session id live):
//   1. `hc get <t> --json`: .pid, .foreground {pid, name, argv}, .status
//      {app, state} and .title;
//   2. <dir>/sessions/<foreground.pid>.json, searched over every config dir
//      this Mac has (configDirs). The dir where it's found is the account.
// Returns { terminal, kind, error, pid, foregroundPid, ownProgram, title,
// app, state, argv, account, configDir, sessionId, session, agents }:
//   kind: "claude" (a session file was found), "noSession" (Claude runs but
//   has no readable session file yet), "notClaude" (the shell or another
//   program is in the foreground), "missing" (no such live terminal) or
//   "unreadable" (hc failed: error says why);
//   ownProgram: Claude is the terminal's own program (pid == foreground.pid),
//   so there is no shell to come back to: it can't move (D7, D8);
//   session: the session file's status word, "idle" or "busy";
//   state: Herdr's .status.state ("idle", "working", "done", "blocked", …);
//   agents: the titles of the subagents Herdr lists as working or blocked
//   (.records, keyed by agent id): a restart stops them with Claude.
//
// lastTurn(configDir, sessionId): how the conversation's last turn ended,
// read from the end of its transcript (Orca's isClaudePaneMidTurn, which
// reads the same moment from its Stop hook). { backgroundAgents } when the
// last line that tells is Claude's end-of-turn line (type "system", subtype
// "turn_duration", whose pendingBackgroundAgentCount says how many
// background agents still ran), null while a turn is under way (a later
// user or assistant line, or a queued message) or when the tail doesn't
// tell. A Claude with background agents reads "busy" in its session file
// and "working" in Herdr until they end (probe, Claude Code 2.1.319), so
// this is what says its own turn is over. Never throws.
//
// hasTranscript(configDir, sessionId): whether
// <configDir>/projects/*/<sessionId>.jsonl exists, symlinks followed (every
// profile's projects/ links to ~/.claude/projects), searched over every
// project folder rather than guessing the slug from the cwd.
//
// lastPrompt(configDir, sessionId): the conversation's last prompt, for the
// switch dialog's row (D23, Orca's agent status `prompt`), or null. It's the
// last user line of that transcript with text: tool results, meta lines
// (isMeta, a compaction's summary, a subagent's line), slash commands and
// their output (`<command-name>…`, `<local-command-stdout>…`), `!` shell
// lines (`<bash-input>…`) and "[Request interrupted by user…]" don't count.
// Its text parts are joined, its whitespace runs folded to one space,
// trimmed, and cut at Orca's 200 characters (AGENT_STATUS_MAX_FIELD_LENGTH).
// The file is read backwards in chunks, so a long conversation costs only
// what follows its last prompt. Never throws: anything unreadable is null.
//
// listClaudeTerminals(): `hc ls --json`, the live local terminals whose agent
// is "claude-code" (D7 step 1). Terminals on other machines (`vps/t7`) are
// left out: their logins are their own (Orca's rule).
//
// Every hc call runs with HC_TERMINAL_ID and HC_SCOPE removed from its env
// (D7), and
// passes the terminal after `--`, so a name can't read as a flag.

import { execFile } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { defaultConfigDir, orcaRoots, profilesHome, stateHome } from "./paths.mjs";
import { failure, render } from "./files.mjs";
import { knownAccounts } from "./accounts.mjs";

// hc get and hc ls answer at once; hc send waits for a person to pause.
const HC_TIMEOUT_MS = 10_000;
export const HC_SEND_TIMEOUT_MS = 60_000;

const str = (value) => (typeof value === "string" && value ? value : null);

// ── hc ──────────────────────────────────────────────────────────────────────

// The env every hc call gets: this process's, minus HC_TERMINAL_ID and
// HC_SCOPE, so hc never takes the call for the terminal this CLI runs in
// (D7, probe b3): with them, hc send wraps the text in <hc from=…>, and
// Claude reads a typed line as another terminal's message.
export function hcEnv(env = process.env) {
  const out = { ...env };
  delete out.HC_TERMINAL_ID;
  delete out.HC_SCOPE;
  return out;
}

// Runs hc and resolves to its stdout. A failure rejects with an Error whose
// `kind` is hc's own error kind when it printed one (`not_found` for a
// terminal that doesn't exist), else "failed".
export function hc(args, { timeout = HC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("hc", args, { env: hcEnv(), timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      let kind = "failed";
      let message = String(stderr || error.message).trim();
      try {
        const said = JSON.parse(stderr)?.error;
        if (typeof said?.kind === "string") kind = said.kind;
        if (typeof said?.message === "string") message = said.message;
      } catch {
        // Not hc's JSON error (a timeout, a missing hc): keep the text.
      }
      reject(Object.assign(new Error(`hc ${args[0]}: ${message || `exit ${error.code}`}`), { kind }));
    });
  });
}

async function hcJson(args) {
  const out = await hc(args);
  try {
    return JSON.parse(out);
  } catch {
    throw Object.assign(new Error(`hc ${args[0]}: its output isn't JSON`), { kind: "failed" });
  }
}

// `hc get <t>`: the terminal, or null when there's no such terminal. Any
// other hc failure throws.
export async function getTerminal(t) {
  try {
    return await hcJson(["get", "--json", "--", t]);
  } catch (e) {
    if (e.kind === "not_found") return null;
    throw e;
  }
}

export async function listClaudeTerminals() {
  const doc = await hcJson(["ls", "--json"]);
  const terminals = Array.isArray(doc?.terminals) ? doc.terminals : [];
  return terminals
    .filter((t) => t && str(t.address) && !t.address.includes("/") && t.state === "live" && t.agent === "claude-code")
    .map((t) => ({ terminal: t.address, where: str(t.where) }));
}

// ── Config dirs and session files ───────────────────────────────────────────

// Every config dir a Claude on this Mac may write its sessions/ to, in the
// order they're searched: [{ dir, account }]. System default (~/.claude),
// then each saved account's exact configDir, then the profile folders no
// account has (Orca's claude-profiles/*/home and Herdr's
// claude-accounts-profiles/*/home), with account null.
async function configDirs(known, env = process.env) {
  const dirs = [{ dir: defaultConfigDir(env), account: "default" }];
  const seen = new Set(dirs.map((d) => d.dir));
  const add = (dir, account) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push({ dir, account });
    }
  };
  for (const a of known.accounts) if (!a.isDefault) add(a.configDir, a.id);
  const roots = [...orcaRoots(env).map((root) => join(root, "claude-profiles")), profilesHome(env)];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) add(join(root, e.name, "home"), null);
  }
  return dirs;
}

// <dir>/sessions/<pid>.json: { sessionId, status }, null when there's none,
// or { unreadable: true } when it doesn't parse twice in a row (Claude
// rewrites it live).
async function readSession(dir, pid) {
  const path = join(dir, "sessions", `${pid}.json`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
      return { unreadable: true };
    }
    try {
      const s = JSON.parse(text);
      if (s && typeof s === "object") return { sessionId: str(s.sessionId), status: str(s.status) };
    } catch {
      // Caught mid-write: read it once more.
    }
    await sleep(50);
  }
  return { unreadable: true };
}

async function findSession(dirs, pid) {
  const found = await Promise.all(dirs.map((d) => readSession(d.dir, pid)));
  const i = found.findIndex(Boolean);
  return i < 0 ? null : { ...dirs[i], session: found[i] };
}

// A session id that names a file, never a path.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// <configDir>/projects/<any>/<sessionId>.jsonl, the first one found, or null.
async function findTranscript(configDir, sessionId) {
  if (!configDir || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const projects = join(configDir, "projects");
  const names = await readdir(projects).catch(() => []);
  const file = `${sessionId}.jsonl`;
  const found = await Promise.all(names.map((name) => stat(join(projects, name, file)).then((st) => st.isFile(), () => false)));
  const i = found.indexOf(true);
  return i < 0 ? null : join(projects, names[i], file);
}

export async function hasTranscript(configDir, sessionId) {
  return (await findTranscript(configDir, sessionId)) !== null;
}

// ── The last turn (Orca's "not mid-turn") ───────────────────────────────────

// How much of the transcript lastTurn reads, from its end: the lines after a
// turn's end are short, so its end-of-turn line lies well inside.
const TURN_CHUNK = 256 * 1024;

export async function lastTurn(configDir, sessionId) {
  try {
    const file = await findTranscript(configDir, sessionId);
    if (!file) return null;
    const handle = await open(file, "r");
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - TURN_CHUNK);
      const chunk = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      const lines = chunk.subarray(0, bytesRead).toString("utf8").split("\n");
      // The first line is cut by the chunk's start.
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        let row;
        try {
          row = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (!row || typeof row !== "object" || row.isSidechain) continue;
        if (row.type === "system" && row.subtype === "turn_duration") {
          const n = row.pendingBackgroundAgentCount;
          return { backgroundAgents: Number.isInteger(n) && n > 0 ? n : 0 };
        }
        if (row.type === "user" || row.type === "assistant" || (row.type === "queue-operation" && row.operation === "enqueue")) return null;
      }
      return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// ── The last prompt (D23) ───────────────────────────────────────────────────

// Orca's AGENT_STATUS_MAX_FIELD_LENGTH: a prompt is a row's title, never a body.
const PROMPT_MAX = 200;
// How much of the transcript one read takes, from its end.
const PROMPT_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;
// A user line that holds a slash command, its output or a `!` shell line.
const COMMAND_TEXT = /^<(command-(name|message|args)|local-command-[a-z-]+|bash-(input|stdout|stderr))>/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
// What the harness wraps around a turn: never what the person wrote, and it
// can share a line with what they did write.
const HARNESS_BLOCK = /<(task-notification|system-reminder|agent-message|cross-session-message)\b[^>]*>[\s\S]*?<\/\1>/g;
// A paste's wrapper: the text inside is the person's.
const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g;

// Cut at max UTF-16 units, without leaving half a surrogate pair (Orca's
// truncatePreservingSurrogates).
function cutAt(text, max) {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

// One transcript line (a Buffer) → its prompt, or null when it isn't one.
function promptOf(line) {
  // Most lines aren't the user's: skip them before parsing.
  if (line.length === 0 || !line.includes('"user"')) return null;
  let entry;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return null;
  const content = entry.message?.content;
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((part) => part?.type === "tool_result")) return null;
    text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ");
  } else return null;
  const oneLine = text.replace(HARNESS_BLOCK, " ").replace(PASTE_TAG, " ").replace(/\s+/g, " ").trim();
  if (!oneLine || COMMAND_TEXT.test(oneLine) || INTERRUPTED.test(oneLine)) return null;
  return cutAt(oneLine, PROMPT_MAX).trimEnd();
}

// The file's last prompt, reading it from its end. `tail` holds the pieces of
// the line still cut by a chunk's start, joined only once that line is whole,
// so a long line is never copied once per chunk.
async function lastPromptIn(file) {
  const handle = await open(file, "r");
  try {
    let end = (await handle.stat()).size;
    let tail = [];
    while (end > 0) {
      const start = Math.max(0, end - PROMPT_CHUNK);
      const chunk = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      const data = chunk.subarray(0, bytesRead);
      end = start;
      let cut = data.length;
      for (let i = data.lastIndexOf(NEWLINE); i >= 0; i = i > 0 ? data.lastIndexOf(NEWLINE, i - 1) : -1) {
        const line = data.subarray(i + 1, cut);
        const prompt = promptOf(tail.length ? Buffer.concat([line, ...tail]) : line);
        if (prompt) return prompt;
        tail = [];
        cut = i;
      }
      tail.unshift(data.subarray(0, cut));
    }
    return promptOf(Buffer.concat(tail));
  } finally {
    await handle.close();
  }
}

export async function lastPrompt(configDir, sessionId) {
  try {
    const file = await findTranscript(configDir, sessionId);
    return file ? await lastPromptIn(file) : null;
  } catch {
    return null;
  }
}

// The titles of the subagents a terminal's records list as working or
// blocked, each on one line.
function runningAgents(records) {
  if (!records || typeof records !== "object") return [];
  return Object.values(records)
    .filter((r) => r && (r.state === "working" || r.state === "blocked"))
    .map((r) => (str(r.title) ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// The foreground looks like Claude Code: the native binary (`claude`,
// `claude.exe`) or node running its bin.
const CLAUDE_BIN = /(^|\/)claude(\.exe)?$/i;
function looksLikeClaude(fg) {
  const argv = Array.isArray(fg.argv) ? fg.argv : [];
  return [fg.name, argv[0], argv[1]].some((part) => typeof part === "string" && CLAUDE_BIN.test(part));
}

// ── The D7 chain ────────────────────────────────────────────────────────────

export async function inspectTerminal(t, known) {
  const result = {
    terminal: t,
    kind: null,
    error: null,
    pid: null,
    foregroundPid: null,
    ownProgram: false,
    title: null,
    app: null,
    state: null,
    argv: [],
    account: null,
    configDir: null,
    sessionId: null,
    session: null,
    agents: [],
  };
  let info;
  try {
    info = await getTerminal(t);
  } catch (e) {
    return { ...result, kind: "unreadable", error: e.message };
  }
  if (!info || info.state !== "live") return { ...result, kind: "missing", error: `no live terminal "${t}"` };
  result.pid = Number.isInteger(info.pid) ? info.pid : null;
  result.title = str(info.title);
  result.app = str(info.status?.app);
  result.state = str(info.status?.state);
  result.agents = runningAgents(info.records);
  const fg = info.foreground;
  if (!fg || !Number.isInteger(fg.pid)) return { ...result, kind: "notClaude" };
  result.foregroundPid = fg.pid;
  result.argv = Array.isArray(fg.argv) ? fg.argv.filter((a) => typeof a === "string") : [];
  const claudeish = looksLikeClaude(fg);
  result.ownProgram = fg.pid === result.pid && claudeish;
  const found = await findSession(await configDirs(known), fg.pid);
  if (found) {
    // A session file names it Claude, whatever the process is called.
    const located = { ...result, ownProgram: fg.pid === result.pid, account: found.account, configDir: found.dir };
    if (found.session.unreadable || !found.session.sessionId) return { ...located, kind: "noSession" };
    return { ...located, kind: "claude", sessionId: found.session.sessionId, session: found.session.status };
  }
  // No session file: Claude still starting, or the shell is back.
  return { ...result, kind: claudeish ? "noSession" : "notClaude" };
}

// Idle, as D8 reads it: the session file says idle and Herdr doesn't see the
// terminal working or blocked on a question.
export function isIdle(inspected) {
  return inspected.session === "idle" && !["working", "blocked"].includes(inspected.state);
}

// ── terminal ────────────────────────────────────────────────────────────────

export async function terminal(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true, allowPositionals: true });
  if (positionals.length !== 1 || !positionals[0]) throw failure("usage: claude-accounts terminal <t> [--json]", 64);
  const [t] = positionals;
  const found = await inspectTerminal(t, await knownAccounts(stateHome()));
  if (found.kind === "unreadable") throw failure(`couldn't read terminal ${t} (${found.error})`);
  if (found.kind === "missing") throw failure(`terminal ${t} is missing`, 3);
  if (found.kind === "notClaude") throw failure(`terminal ${t} isn't running Claude`, 3);
  if (found.kind === "noSession") throw failure(`Claude in terminal ${t} has no session file yet`, 2);
  const out = {
    account: found.account,
    sessionId: found.sessionId,
    status: found.session === "idle" ? "idle" : "busy",
    resumable: await hasTranscript(found.configDir, found.sessionId),
  };
  process.stdout.write(
    values.json
      ? render(out)
      : `${t}: ${out.account ?? "a folder no account has"} · ${out.sessionId} · ${out.status}${out.resumable ? "" : " · nothing to resume yet"}\n`,
  );
  return 0;
}
