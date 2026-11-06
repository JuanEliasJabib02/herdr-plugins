// The command typed into a terminal's shell to bring its Claude back (D8).
// Pure: no herdr import, no I/O.
//
//   [cd <cwd> &&] CLAUDE_ACCOUNTS_DIR=<dir> [CLAUDE_CONFIG_DIR=<dir>] claude <the user's flags> --resume <id>
//
// - The account it slept in (D15), always first: CLAUDE_ACCOUNTS_DIR is the
//   claude launcher's rule 1 (~/my-mac-scripts/bin/claude, herdr_account):
//   set, even empty, it wins over claude-accounts' `active` file and is unset
//   before Claude starts. '' is System default (~/.claude). A named account
//   also gets CLAUDE_CONFIG_DIR, the same dir, so a shell without the
//   launcher lands there too (claude-accounts' runLogin does both). The dir
//   is the exact string, quoted, never normalized. What it decides is the
//   login (org, usage limit, telemetry): every profile's projects/ links to
//   ~/.claude/projects, so the conversation is found in any account.
// - Bare `claude`, whatever path Core shows (argv[0] must be claude by
//   Orca's isClaudeExecutableToken, agent-resume-launch-command.ts:20-23):
//   the shell finds it again, so a launcher function re-adds its own env and
//   flags.
// - The user's flags filtered exactly as Claude 2.1.318 filters them for its
//   own resume hint (rjo(), below): session selectors and one-shot options
//   stripped, teammate/agent options refused, anything it can't account for
//   refused. A refusal means that Claude never sleeps. Positionals (the
//   first prompt) and a `--` tail are never replayed (as rjo and Orca,
//   tui-agent-resume-startup.ts:107).
// - The launcher's own `--mcp-config=…` and `--add-dir=…` (always joined
//   with `=`; ~/my-mac-scripts/bin/claude) are dropped, never stored: it
//   adds them again. The user's space-separated forms are theirs and kept.
// - `cd <cwd> &&` when the shell sits elsewhere: `claude --resume <id>`
//   finds the transcript by the folder it runs in.
// - Every part shell-quoted (Orca's portable Unix form), only for shells
//   whose quoting that is: the sh family and fish.
// - `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` before `claude` when Claude's
//   exit hint asked for it (the only assignment 2.1.318 prints: `GI` in its
//   binary); any other assignment refuses, so that Claude is never resumed
//   without it (Log L10).

import { normalizeSessionId, isConfigDir } from "./claude-session.js";
import { shellName } from "./prompt.js";

// ── Claude Code 2.1.318 rjo() ──────────────────────────────────────────────
// Ported from the claude.exe 2.1.318 binary (find it with
// `strings claude.exe | grep -n CLAUDE_CODE_RELAUNCH_RESUME_HINT_FLAGS`: the
// module exporting rjo, next to its two sets and three regexes). Claude runs
// rjo(program.options, process.argv.slice(2)) to print the flags in "Resume
// this session with:"; "" there means it prints none. Re-check all of this
// against a new Claude version before trusting it.

export const CLAUDE_VERSION = "2.1.318";

// rjo's `c`: options left out of a resume (they pick a session, or act once).
export const SKIP = Object.freeze([
  "resume", "continue", "from-pr", "fork-session", "session-id", "name", "teleport", "cloud", "remote",
  "desktop", "environment", "pool", "project", "ref", "on-branch", "correlation-id", "forward-home-settings",
  "resume-session-at", "resume-drops-turn", "reply-on-resume", "rewind-files", "worktree", "tmux",
  "background", "routine", "file", "init", "init-only", "maintenance", "prefill", "prefill-b64",
  "deep-link-origin", "deep-link-repo", "deep-link-last-fetch", "deep-link-cwd-b64", "watch-artifact",
  "watch-artifact-no-autoreact",
]);

// rjo's `p`: options that make the whole hint unsafe (a teammate, an agent
// view, a server-side session): rjo prints no flags; here, never sleep.
export const REFUSE = Object.freeze([
  "agent-id", "agent-name", "team-name", "agent-color", "agent-type", "parent-session-id",
  "plan-mode-required", "inherit-permission-mode", "agents-view-if-allowed", "attach-serve",
  "session-began-as-copy", "messaging-socket-path", "project-config-root",
]);

const SKIP_SET = new Set(SKIP);
const REFUSE_SET = new Set(REFUSE);
const FLAG = /^-[\w/:@=+-]*$/; // rjo's `u`
const VALUE = /^[\w./:+][\w./:@=+-]*$/; // rjo's `E`
const DEVICE = /(^|=)\/(dev|proc)\//; // rjo's `f`

// The root command's options as Claude 2.1.318 declares them (commander
// flag strings, in registration order, `-v, --version` included): rjo looks
// tokens up in program.options, so its arity is theirs.
const CLAUDE_OPTION_FLAGS = [
  "-d, --debug [filter]", "-d2e, --debug-to-stderr", "--debug-file <path>", "--verbose",
  "-p, --print", "--bare", "--safe-mode", "--init", "--init-only", "--maintenance",
  "--output-format <format>", "--json-schema <schema>", "--include-hook-events",
  "--include-partial-messages", "--forward-subagent-text", "--session-mirror", "--await-claim",
  "--input-format <format>", "--await-initialize", "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions", "--thinking <mode>", "--thinking-display <display>",
  "--max-thinking-tokens <tokens>", "--max-turns <turns>", "--max-budget-usd <amount>",
  "--task-budget <tokens>", "--replay-user-messages", "--prompt-suggestions [value]",
  "--enable-auth-status", "--allowedTools, --allowed-tools <tools...>", "--tools <tools...>",
  "--restricted", "--disallowedTools, --disallowed-tools <tools...>",
  "--mcp-config <configs...>", "--permission-prompt-tool <tool>",
  "--permission-prompts <target>", "--system-prompt <prompt>", "--system-prompt-file <file>",
  "--append-system-prompt <prompt>", "--append-system-prompt-file <file>",
  "--system-prompt-snapshot <on|off>", "--append-subagent-system-prompt <prompt>",
  "--append-subagent-system-prompt-file <file>", "--plan-mode-instructions <instructions>",
  "--exclude-dynamic-system-prompt-sections", "--permission-mode <mode>",
  "--inherit-permission-mode <mode>", "-c, --continue", "-r, --resume [value]", "--fork-session",
  "--watch-artifact <artifact>", "--watch-artifact-no-autoreact <artifact>", "--prefill <text>",
  "--deep-link-origin", "--deep-link-repo <slug>", "--deep-link-last-fetch <ms>",
  "--prefill-b64 <b64>", "--deep-link-cwd-b64 <b64>", "--from-pr [value]",
  "--no-session-persistence", "--resume-session-at <message id>",
  "--resume-drops-turn <message id>", "--reply-on-resume", "--rewind-files <user-message-id>",
  "--model <model>", "--include-unsupported-models", "--effort <level>", "--fast-mode <on|off>",
  "--agent <agent>", "--betas <betas...>", "--fallback-model <model>", "--workload <tag>",
  "--settings <file-or-json>", "--client-data-url <url>", "--allow-other-models",
  "--managed-settings <json>", "--host-auth-is-org-sign-in", "--add-dir <directories...>",
  "--project-config-root <dir>", "--ide", "--desktop", "--strict-mcp-config",
  "--session-id <uuid>", "-n, --name <name>", "--agents <json-or-file>",
  "--setting-sources <sources>", "--plugin-dir <path>", "--plugin-dir-no-mcp <path>",
  "--plugin-url <url>", "--disable-slash-commands", "--chrome", "--no-chrome",
  "--file <specs...>", "-v, --version", "-w, --worktree [name]", "--tmux", "--advisor <model>",
  "--autocompact <auto|tokens>", "--enable-auto-mode", "--proactivity <level>",
  "--agents-view-if-allowed", "--bg, --background", "--messaging-socket-path <path>", "--brief",
  "--ax-screen-reader", "--channels <servers...>",
  "--dangerously-load-development-channels <servers...>", "--agent-id <id>",
  "--agent-name <name>", "--team-name <name>", "--agent-color <color>", "--plan-mode-required",
  "--parent-session-id <id>", "--teammate-mode <mode>", "--agent-type <type>", "--sdk-url <url>",
  "--runner-declares <names>", "--session-began-as-copy <value>", "--teleport [session]",
  "--cloud [description|session_id|url]", "--forward-home-settings <true|false>",
  "--remote [description|session_id|url]", "--attach-serve <session_id>",
  "--environment <environment_id>", "--pool <pool_id>", "--correlation-id <id>", "--ref <ref>",
  "--on-branch <branch>", "--remote-control [name]", "--rc [name]",
  "--remote-control-session-name-prefix <prefix>",
];

// commander's Option as Claude's bundled copy builds it: its loose flag
// split (`-d2e, --x` and `--bg, --background` take the first as short),
// required/optional by `<`/`[` anywhere in the string, variadic by `...`,
// and name() = the long flag (else the short) without its dashes.
function commanderOption(flags) {
  const parts = flags.split(/[ |,]+/);
  let short;
  if (parts.length > 1 && !/^[[<]/.test(parts[1])) short = parts.shift();
  let long = parts.shift();
  if (!short && /^-[^-]$/.test(long)) {
    short = long;
    long = undefined;
  }
  return Object.freeze({
    short: short ?? null,
    long: long ?? null,
    name: long ? long.replace(/^--/, "") : short.replace(/^-/, ""),
    required: flags.includes("<"),
    optional: flags.includes("["),
    variadic: /\w\.\.\.[>\]]$/.test(flags),
  });
}

const OPTIONS = Object.freeze(CLAUDE_OPTION_FLAGS.map(commanderOption));

// rjo's `vNe`: a token that reads as an option.
const isOptionToken = (token) => token.length > 1 && token.startsWith("-");

// rjo's `l`: the option a token names exactly (short or long), or null.
export function claudeOption(token) {
  return OPTIONS.find((o) => o.short === token || o.long === token) ?? null;
}

const refuse = (reason, token) => ({ ok: false, reason, token });

// rjo() itself, on argv without the program (Claude passes
// process.argv.slice(2)). Same walk, same order of checks; where rjo returns
// "" this returns { ok: false, reason, token } so callers can log why, and
// { ok: true, flags } where rjo returns flags.join(" "). The one addition is
// `drop`: option tokens it accepts are skipped before rjo looks at them
// (resumeFlags passes the launcher's joined flags).
export function filterFlags(args, drop = () => false) {
  const kept = [];
  let n = 0;
  while (n < args.length) {
    const o = args[n++];
    if (o === "--") break;
    if (!isOptionToken(o)) continue;
    if (drop(o)) continue;
    const values = [];
    let t = claudeOption(o);
    if (t) {
      if (t.required) {
        if (n >= args.length) return refuse("missing-value", o);
        values.push(args[n++]);
      } else if (t.optional && n < args.length && !isOptionToken(args[n])) {
        values.push(args[n++]);
      }
      if (t.variadic) while (n < args.length && !isOptionToken(args[n])) values.push(args[n++]);
    } else {
      // `--opt=value`, only for an option that takes a value.
      const a = o.startsWith("--") ? o.indexOf("=") : -1;
      t = a > 2 ? claudeOption(o.slice(0, a)) : null;
      if (!t || !(t.required || t.optional)) return refuse("unknown-option", o);
    }
    if (REFUSE_SET.has(t.name)) return refuse("refused-option", o);
    if (SKIP_SET.has(t.name)) continue;
    if (!FLAG.test(o)) return refuse("bad-flag", o);
    if (!values.every((v) => VALUE.test(v))) return refuse("bad-value", o);
    if ([o, ...values].some((v) => DEVICE.test(v))) return refuse("device-path", o);
    kept.push(o, ...values);
  }
  return { ok: true, flags: kept };
}

// ── From Core's foreground.argv to the flags a record stores ──────────────

// Orca agent-resume-launch-command.ts:20-23.
export function isClaudeExecutable(token) {
  if (typeof token !== "string") return false;
  const base = token.split(/[\\/]/).pop() ?? "";
  return /^claude(\.(exe|cmd|bat|ps1))?$/i.test(base);
}

// What the claude launcher adds itself (joined, so a prompt after them is
// never eaten as a value).
const LAUNCHER_PREFIXES = ["--mcp-config=", "--add-dir="];
const isLauncherFlag = (token) => LAUNCHER_PREFIXES.some((p) => token.startsWith(p));

// Core's foreground.argv of a Claude → { ok: true, flags } (what the record
// stores) or { ok: false, reason[, token] }: "not-claude" (argv[0] isn't
// claude), "bad-argv", or rjo's refusal.
export function resumeFlags(argv) {
  if (!Array.isArray(argv) || !isClaudeExecutable(argv[0])) return { ok: false, reason: "not-claude" };
  if (!argv.every((a) => typeof a === "string")) return { ok: false, reason: "bad-argv" };
  return filterFlags(argv.slice(1), isLauncherFlag);
}

// ── Quoting and the command ────────────────────────────────────────────────

// Words no sh-family shell or fish changes: no glob, tilde, `=` expansion
// (zsh) at the start, `$`, quotes, spaces or separators.
const BARE = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:@+=,-]*$/;

// Orca tui-agent-startup-shell.ts:152-177: single-quoted runs, `'` as "'"
// and `\` as "\\", which sh, bash, zsh and fish all read back unchanged.
function quotePortableUnixArg(value) {
  const parts = [];
  let literal = "";
  const flushLiteral = () => {
    if (literal) {
      parts.push(`'${literal}'`);
      literal = "";
    }
  };
  for (const char of value) {
    if (char === "'") {
      flushLiteral();
      parts.push(`"'"`);
    } else if (char === "\\") {
      flushLiteral();
      parts.push(`"\\\\"`);
    } else {
      literal += char;
    }
  }
  flushLiteral();
  return parts.join("");
}

export function quoteArg(value) {
  if (value === "") return "''";
  return BARE.test(value) ? value : quotePortableUnixArg(value);
}

// Shells where quoteArg's output and `&&` mean what they say. csh/tcsh
// (history `!` and backslashes in double quotes), nu, pwsh, elvish and
// xonsh quote differently: a Claude in one of those never sleeps.
const QUOTABLE = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "oksh", "pdksh", "yash", "ash", "fish"]);

// `shell`: the shell's foreground.name or the terminal's argv[0].
export function canResumeIn(shell) {
  const name = shellName(shell);
  return name !== null && QUOTABLE.has(name);
}

// The env assignments a resume replays before `claude` (record field `env`).
export const REPLAYABLE_ENV = Object.freeze(["CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1"]);

const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
const sameTokens = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// The assignments that put a resumed Claude in its account (D15).
function accountWords(configDir) {
  const dir = quoteArg(configDir ?? "");
  return configDir == null ? [`CLAUDE_ACCOUNTS_DIR=${dir}`] : [`CLAUDE_ACCOUNTS_DIR=${dir}`, `CLAUDE_CONFIG_DIR=${dir}`];
}

// { flags (resumeFlags' list, as stored), sessionId, cwd (the session's),
//   shellCwd (the shell's now; unknown → cd anyway), shell, env (optional,
//   one of REPLAYABLE_ENV), configDir (the account's exact dir; null or
//   absent for System default) }
// → { ok: true, command } or { ok: false, reason }: "unsupported-shell",
// "unsupported-env", "invalid-session-id", "bad-cwd" (not absolute, or a
// control character), "bad-config-dir" (fails isConfigDir), "bad-flags" (not
// what rjo would keep: the record was edited or broken).
export function resumeCommand({ flags, sessionId, cwd, shellCwd, shell, env, configDir } = {}) {
  if (!canResumeIn(shell)) return { ok: false, reason: "unsupported-shell" };
  if (env !== null && env !== undefined && !REPLAYABLE_ENV.includes(env)) return { ok: false, reason: "unsupported-env" };
  const id = normalizeSessionId(sessionId);
  if (id === null) return { ok: false, reason: "invalid-session-id" };
  if (typeof cwd !== "string" || !cwd.startsWith("/") || hasControl(cwd)) return { ok: false, reason: "bad-cwd" };
  if (configDir != null && !isConfigDir(configDir)) return { ok: false, reason: "bad-config-dir" };
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string")) return { ok: false, reason: "bad-flags" };
  const again = filterFlags(flags);
  if (!again.ok || !sameTokens(again.flags, flags)) return { ok: false, reason: "bad-flags" };
  const words = ["claude", ...flags, "--resume", id].map(quoteArg);
  // REPLAYABLE_ENV entries are plain words: written as they are, never quoted.
  const claude = [...accountWords(configDir), ...(env ? [env] : []), ...words].join(" ");
  return { ok: true, command: cwd === shellCwd ? claude : `cd ${quoteArg(cwd)} && ${claude}` };
}

// D3: the flags Claude printed in its exit hint (parseExitScreen) against
// the ones this command replays. A line for the log when they differ (or
// the hint's env assignment isn't the one the command sets, `env`), else
// null. Expected for launcher-run Claudes: rjo refuses the launcher's JSON,
// so Claude prints no flags at all.
export function hintDifference(parsed, flags, env = null) {
  if (typeof parsed !== "object" || parsed === null || parsed.shape !== "resume" || !Array.isArray(parsed.flags)) {
    return null;
  }
  const notes = [];
  const printed = parsed.flags.join(" ");
  const ours = Array.isArray(flags) ? flags.join(" ") : "";
  if (printed !== ours) notes.push(`Claude's hint printed flags "${printed}", the resume command has "${ours}"`);
  const replayed = env ?? null;
  const theirs = parsed.env ?? null;
  if (theirs !== replayed) {
    notes.push(theirs === null
      ? `Claude's hint sets no env, the resume command sets ${replayed}`
      : `Claude's hint sets ${theirs}, the resume command ${replayed === null ? "doesn't" : `sets ${replayed}`}`);
  }
  return notes.length > 0 ? notes.join("; ") : null;
}
