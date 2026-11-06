// Which account and conversation a Herdr terminal runs (D7, which answers S4:
// no hook needed). Owner: T4.
//
//   terminal <t> [--json] → { account, sessionId, status }
//     account: the id of the account whose config dir holds the terminal's
//     live session file ("default" for ~/.claude), or null when that folder
//     belongs to no account (an Orca or Herdr profile folder the registry
//     doesn't have, such as a removed account's). status: "idle" or "busy".
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
// app, state, argv, account, configDir, sessionId, session }:
//   kind: "claude" (a session file was found), "noSession" (Claude runs but
//   has no readable session file yet), "notClaude" (the shell or another
//   program is in the foreground), "missing" (no such live terminal) or
//   "unreadable" (hc failed: error says why);
//   ownProgram: Claude is the terminal's own program (pid == foreground.pid),
//   so there is no shell to come back to: it can't move (D7, D8);
//   session: the session file's status word, "idle" or "busy";
//   state: Herdr's .status.state ("idle", "working", "done", "blocked", …).
//
// listClaudeTerminals(): `hc ls --json`, the live local terminals whose agent
// is "claude-code" (D7 step 1). Terminals on other machines (`vps/t7`) are
// left out: their logins are their own (Orca's rule).
//
// Every hc call runs with HC_TERMINAL_ID removed from its env (D7), and
// passes the terminal after `--`, so a name can't read as a flag.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
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

// The env every hc call gets: this process's, minus HC_TERMINAL_ID, so hc
// never takes the call for the terminal this CLI runs in (D7, probe b3).
export function hcEnv(env = process.env) {
  const out = { ...env };
  delete out.HC_TERMINAL_ID;
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
  const out = { account: found.account, sessionId: found.sessionId, status: found.session === "idle" ? "idle" : "busy" };
  process.stdout.write(
    values.json ? render(out) : `${t}: ${out.account ?? "a folder no account has"} · ${out.sessionId} · ${out.status}\n`,
  );
  return 0;
}
