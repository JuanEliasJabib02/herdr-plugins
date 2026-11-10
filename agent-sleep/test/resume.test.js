// T2: the command typed into the shell to bring a Claude back (A/resume.js,
// D8). Bare `claude` (so the launcher runs again) + the user's flags as
// Claude 2.1.318's rjo() filters them for its own resume hint + `--resume
// <id>`, with `cd <cwd> &&` in front when the shell sits elsewhere. Every
// part is shell-quoted; anything rjo refuses means the Claude never sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  CLAUDE_VERSION, SKIP, REFUSE,
  claudeOption, filterFlags, isClaudeExecutable, resumeFlags,
  quoteArg, canResumeIn, resumeCommand, hintDifference, REPLAYABLE_ENV,
} from "../mods/agent-sleep/resume.js";
import { parseExitScreen } from "../mods/agent-sleep/claude-session.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const SID = "8f3c2a91-0000-4000-8000-000000000001";
const NVM_CLAUDE = "/Users/demo/.nvm/versions/node/v24.14.0/bin/claude";
const flagsOf = (...args) => resumeFlags([NVM_CLAUDE, ...args]);
const command = (over = {}) =>
  resumeCommand({ flags: [], sessionId: SID, cwd: "/code/app", shellCwd: "/code/app", shell: "zsh", ...over });
// What every System default resume starts with (D15).
const SYS = "CLAUDE_ACCOUNTS_DIR=''";

// ── The rjo() tables, verbatim ─────────────────────────────────────────────

test("the tables are Claude Code 2.1.318's rjo() lists", () => {
  assert.equal(CLAUDE_VERSION, "2.1.318");
  assert.deepEqual([...SKIP], [
    "resume", "continue", "from-pr", "fork-session", "session-id", "name", "teleport", "cloud", "remote",
    "desktop", "environment", "pool", "project", "ref", "on-branch", "correlation-id", "forward-home-settings",
    "resume-session-at", "resume-drops-turn", "reply-on-resume", "rewind-files", "worktree", "tmux",
    "background", "routine", "file", "init", "init-only", "maintenance", "prefill", "prefill-b64",
    "deep-link-origin", "deep-link-repo", "deep-link-last-fetch", "deep-link-cwd-b64", "watch-artifact",
    "watch-artifact-no-autoreact",
  ]);
  assert.deepEqual([...REFUSE], [
    "agent-id", "agent-name", "team-name", "agent-color", "agent-type", "parent-session-id",
    "plan-mode-required", "inherit-permission-mode", "agents-view-if-allowed", "attach-serve",
    "session-began-as-copy", "messaging-socket-path", "project-config-root",
  ]);
});

test("each option keeps its commander arity: -w [name] optional, -n <name> required, --add-dir variadic", () => {
  assert.deepEqual(claudeOption("-w"), { short: "-w", long: "--worktree", name: "worktree", required: false, optional: true, variadic: false });
  assert.deepEqual(claudeOption("--worktree"), claudeOption("-w"));
  assert.deepEqual(claudeOption("-n"), { short: "-n", long: "--name", name: "name", required: true, optional: false, variadic: false });
  assert.equal(claudeOption("--add-dir").variadic, true);
  assert.equal(claudeOption("--allowedTools").name, "allowed-tools");
  assert.equal(claudeOption("--bg").name, "background");
  assert.equal(claudeOption("-d2e").name, "debug-to-stderr");
  assert.equal(claudeOption("--no-chrome").name, "no-chrome");
  assert.equal(claudeOption("-c").required || claudeOption("-c").optional, false);
  assert.equal(claudeOption("-r").optional, true);
  assert.equal(claudeOption("--frobnicate"), null);
  assert.equal(claudeOption("-h"), null);
});

// ── resumeFlags: argv[0] and rjo() ─────────────────────────────────────────

test("/abs/nvm/bin/claude --dangerously-skip-permissions → CLAUDE_ACCOUNTS_DIR='' claude --dangerously-skip-permissions --resume <id>", () => {
  const flags = flagsOf("--dangerously-skip-permissions");
  assert.deepEqual(flags, { ok: true, flags: ["--dangerously-skip-permissions"] });
  assert.deepEqual(command({ flags: flags.flags }), {
    ok: true,
    command: `${SYS} claude --dangerously-skip-permissions --resume ${SID}`,
  });
});

test("the launcher's --mcp-config=… and --add-dir=… are dropped, never stored (Core's real t28 argv)", () => {
  const argv = [
    NVM_CLAUDE,
    '--mcp-config={"mcpServers":{"action_board_mcp":{"type":"stdio","command":"node","args":["/x/dist/server.js"]}}}',
    "--add-dir=/Users/demo/code/work/support-scripts",
    "--resume",
    "c2950f2d-2b78-43cd-b888-5e5f4d5d0ac3",
  ];
  assert.deepEqual(resumeFlags(argv), { ok: true, flags: [] });
  assert.equal(command({ flags: resumeFlags(argv).flags }).command, `${SYS} claude --resume ${SID}`);
  // The user's own space-separated --add-dir is theirs: kept, with its values.
  assert.deepEqual(flagsOf("--add-dir", "/a", "/b", "--verbose"), { ok: true, flags: ["--add-dir", "/a", "/b", "--verbose"] });
});

test("-c doesn't eat the next flag; -r and --resume take their id, or nothing before a flag", () => {
  assert.deepEqual(flagsOf("-c", "--dangerously-skip-permissions"), { ok: true, flags: ["--dangerously-skip-permissions"] });
  assert.deepEqual(flagsOf("-r", "abc", "--verbose"), { ok: true, flags: ["--verbose"] });
  assert.deepEqual(flagsOf("--resume", "--verbose"), { ok: true, flags: ["--verbose"] });
  assert.deepEqual(flagsOf("--continue", "task"), { ok: true, flags: [] });
});

test("--fork-session and -w x are stripped (rjo's skip set), with their values", () => {
  assert.deepEqual(flagsOf("--fork-session", "-w", "x", "--model", "opus"), { ok: true, flags: ["--model", "opus"] });
  assert.deepEqual(flagsOf("-w", "--verbose"), { ok: true, flags: ["--verbose"] });
  assert.deepEqual(flagsOf("-n", "my name", "--session-id", "abc"), { ok: true, flags: [] });
});

test("--agent-id x is refused (rjo's refuse set): that Claude never sleeps", () => {
  assert.deepEqual(flagsOf("--agent-id", "x"), { ok: false, reason: "refused-option", token: "--agent-id" });
  assert.deepEqual(flagsOf("--plan-mode-required"), { ok: false, reason: "refused-option", token: "--plan-mode-required" });
});

test("a value with a space is refused", () => {
  assert.deepEqual(flagsOf("--model", "opus 4"), { ok: false, reason: "bad-value", token: "--model" });
});

test("claude \"task\" and -- x resume without the prompt (positionals and the -- tail dropped)", () => {
  assert.deepEqual(resumeFlags([NVM_CLAUDE, "task"]), { ok: true, flags: [] });
  assert.deepEqual(flagsOf("--model", "opus", "--", "x", "--verbose"), { ok: true, flags: ["--model", "opus"] });
  assert.deepEqual(flagsOf("task", "--verbose"), { ok: true, flags: ["--verbose"] });
  assert.equal(command({ flags: resumeFlags([NVM_CLAUDE, "task"]).flags }).command, `${SYS} claude --resume ${SID}`);
});

test("anything rjo can't account for is refused: unknown option, a value on a boolean, a cluster, a missing value", () => {
  assert.deepEqual(flagsOf("--frobnicate"), { ok: false, reason: "unknown-option", token: "--frobnicate" });
  assert.deepEqual(flagsOf("--verbose=1"), { ok: false, reason: "unknown-option", token: "--verbose=1" });
  assert.deepEqual(flagsOf("-pc"), { ok: false, reason: "unknown-option", token: "-pc" });
  assert.deepEqual(flagsOf("--model"), { ok: false, reason: "missing-value", token: "--model" });
});

test("a /dev/ or /proc/ path is refused, joined or apart; a joined --opt=value is kept as one token", () => {
  assert.deepEqual(flagsOf("--settings", "/dev/stdin"), { ok: false, reason: "device-path", token: "--settings" });
  assert.deepEqual(flagsOf("--settings=/proc/self/fd/0"), { ok: false, reason: "device-path", token: "--settings=/proc/self/fd/0" });
  assert.deepEqual(flagsOf("--model=opus"), { ok: true, flags: ["--model=opus"] });
  assert.deepEqual(flagsOf("--allowed-tools", "Read", "Edit", "--verbose"), { ok: true, flags: ["--allowed-tools", "Read", "Edit", "--verbose"] });
});

test("argv[0] must be claude by Orca's isClaudeExecutableToken; anything else never sleeps", () => {
  assert.equal(isClaudeExecutable(NVM_CLAUDE), true);
  assert.equal(isClaudeExecutable("claude"), true);
  assert.equal(isClaudeExecutable("C:\\bin\\claude.exe"), true);
  assert.equal(isClaudeExecutable("CLAUDE"), true);
  assert.equal(isClaudeExecutable("/x/claude-code"), false);
  assert.equal(isClaudeExecutable("node"), false);
  assert.deepEqual(resumeFlags(["node", "/x/cli.js"]), { ok: false, reason: "not-claude" });
  assert.deepEqual(resumeFlags([]), { ok: false, reason: "not-claude" });
  assert.deepEqual(resumeFlags(null), { ok: false, reason: "not-claude" });
  assert.deepEqual(resumeFlags([NVM_CLAUDE, 7]), { ok: false, reason: "bad-argv" });
});

test("filterFlags is rjo() on its own: what Claude would print in its hint, joined by spaces", () => {
  assert.deepEqual(filterFlags(["--model", "opus", "-w", "x", "prompt"]), { ok: true, flags: ["--model", "opus"] });
  // rjo knows nothing of the launcher: its JSON fails the flag regex.
  assert.deepEqual(filterFlags(['--mcp-config={"a":1}']), { ok: false, reason: "bad-flag", token: '--mcp-config={"a":1}' });
});

// ── resumeCommand: id, cwd, quoting ────────────────────────────────────────

test("an id starting with - is refused (Orca's check)", () => {
  assert.deepEqual(command({ sessionId: "-abc" }), { ok: false, reason: "invalid-session-id" });
  assert.deepEqual(command({ sessionId: "" }), { ok: false, reason: "invalid-session-id" });
  assert.deepEqual(command({ sessionId: "a\nb" }), { ok: false, reason: "invalid-session-id" });
});

test("a cwd with ' and $ is quoted in cd, and only when the shell sits elsewhere", () => {
  const cwd = "/tmp/it's $HOME";
  assert.deepEqual(command({ cwd, shellCwd: "/Users/demo" }), {
    ok: true,
    command: `cd '/tmp/it'"'"'s $HOME' && ${SYS} claude --resume ${SID}`,
  });
  assert.equal(command({ shellCwd: "/elsewhere" }).command, `cd /code/app && ${SYS} claude --resume ${SID}`);
  // The shell's cwd unknown: cd anyway.
  assert.equal(command({ shellCwd: undefined }).command, `cd /code/app && ${SYS} claude --resume ${SID}`);
  assert.equal(command().command, `${SYS} claude --resume ${SID}`);
});

test("the cwd must be an absolute path without control characters", () => {
  assert.deepEqual(command({ cwd: "code/app" }), { ok: false, reason: "bad-cwd" });
  assert.deepEqual(command({ cwd: null }), { ok: false, reason: "bad-cwd" });
  assert.deepEqual(command({ cwd: "/code/a\nrm -rf ~" }), { ok: false, reason: "bad-cwd" });
});

test("stored flags are checked again before typing them (sleeping.json can be edited by hand)", () => {
  assert.deepEqual(command({ flags: ["--model", "opus; rm -rf ~"] }), { ok: false, reason: "bad-flags" });
  assert.deepEqual(command({ flags: ["--model", "/dev/stdin"] }), { ok: false, reason: "bad-flags" });
  assert.deepEqual(command({ flags: "--verbose" }), { ok: false, reason: "bad-flags" });
  assert.deepEqual(command({ flags: ["--verbose", 1] }), { ok: false, reason: "bad-flags" });
});

test("only shells whose quoting this module knows (sh family and fish) get a command", () => {
  for (const shell of ["zsh", "-zsh", "/bin/bash", "sh", "dash", "fish", "ksh"]) assert.equal(canResumeIn(shell), true, shell);
  for (const shell of ["nu", "pwsh", "powershell", "tcsh", "csh", "xonsh", "elvish", "claude", undefined]) assert.equal(canResumeIn(shell), false, String(shell));
  assert.deepEqual(command({ shell: "nu" }), { ok: false, reason: "unsupported-shell" });
});

test("quoteArg leaves plain words bare and single-quotes the rest (Orca's portable form)", () => {
  assert.equal(quoteArg("--dangerously-skip-permissions"), "--dangerously-skip-permissions");
  assert.equal(quoteArg("/code/app"), "/code/app");
  assert.equal(quoteArg(SID), SID);
  assert.equal(quoteArg(""), "''");
  assert.equal(quoteArg("~/x"), "'~/x'");
  assert.equal(quoteArg("=ls"), "'=ls'");
  assert.equal(quoteArg("a b"), "'a b'");
  assert.equal(quoteArg("it's"), `'it'"'"'s'`);
  assert.equal(quoteArg("a\\b"), `'a'"\\\\"'b'`);
});

// The real test of quoting: each shell gives back exactly the original.
const NASTY = ["/tmp/it's $HOME", "a b", "~/x", "=ls", "a\\b", "$(touch /tmp/agent-sleep-pwned)", "`id`", "*", "!!", "%1", "{a,b}", "x;y&&z|w", "'", "\"q\""];
for (const shell of ["/bin/sh", "/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish", "/usr/local/bin/fish"]) {
  test(`quoteArg round-trips through ${shell}`, { skip: !existsSync(shell) && `${shell} not installed` }, () => {
    for (const value of NASTY) {
      const out = execFileSync(shell, ["-c", `printf '%s' ${quoteArg(value)}`], { encoding: "utf8" });
      assert.equal(out, value, `${shell}: ${value}`);
    }
  });
}

// ── The hint's flags vs ours (D3: any difference is logged) ───────────────

test("hintDifference: the flags Claude printed vs the command's, null when they agree or there's no hint", () => {
  const exit = parseExitScreen(fixture("claude-exit.txt"));
  assert.equal(hintDifference(exit, []), null);
  assert.match(hintDifference(exit, ["--dangerously-skip-permissions"]), /--dangerously-skip-permissions/);
  const withEnv = parseExitScreen(["Resume this session with:", `X_Y=1 claude --model opus --resume ${SID}`, ""].join("\n"));
  assert.match(hintDifference(withEnv, ["--model", "opus"]), /X_Y=1/);
  const cloud = parseExitScreen(["Resume this session with:", `claude --cloud ${SID}`, ""].join("\n"));
  assert.equal(hintDifference(cloud, ["--model", "opus"]), null);
});

// ── D15: the account a Claude resumes in ──────────────────────────────────

const PROFILE = "/Users/demo/Library/Application Support/Orca Dev/claude-profiles/p1/home";

test("System default (configDir null or absent) types CLAUDE_ACCOUNTS_DIR='' first, and no CLAUDE_CONFIG_DIR", () => {
  for (const configDir of [null, undefined]) {
    assert.deepEqual(command({ configDir }), { ok: true, command: `CLAUDE_ACCOUNTS_DIR='' claude --resume ${SID}` }, String(configDir));
  }
});

test("a named account sets CLAUDE_ACCOUNTS_DIR and CLAUDE_CONFIG_DIR to the same exact, quoted dir", () => {
  const quoted = `'${PROFILE}'`;
  assert.deepEqual(command({ configDir: PROFILE }), {
    ok: true, command: `CLAUDE_ACCOUNTS_DIR=${quoted} CLAUDE_CONFIG_DIR=${quoted} claude --resume ${SID}`,
  });
  // Kept exactly: a trailing slash stays (the launcher and the Keychain key on the string).
  assert.equal(command({ configDir: "/x/home/" }).command, `CLAUDE_ACCOUNTS_DIR=/x/home/ CLAUDE_CONFIG_DIR=/x/home/ claude --resume ${SID}`);
  // A ' in it round-trips the same way a cwd does.
  assert.equal(command({ configDir: "/it's/home" }).command, `CLAUDE_ACCOUNTS_DIR='/it'"'"'s/home' CLAUDE_CONFIG_DIR='/it'"'"'s/home' claude --resume ${SID}`);
});

test("the order: cd, the account, the replayed env, then claude", () => {
  assert.equal(
    command({ configDir: "/x/home", env: "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1", shellCwd: "/elsewhere", flags: ["--model", "opus"] }).command,
    `cd /code/app && CLAUDE_ACCOUNTS_DIR=/x/home CLAUDE_CONFIG_DIR=/x/home CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --model opus --resume ${SID}`,
  );
});

test("a configDir failing the shared predicate is refused (sleeping.json can be edited by hand)", () => {
  for (const configDir of ["", "rel/home", "/x\n/home", "/x\u0085", 7, ["/x"]]) {
    assert.deepEqual(command({ configDir }), { ok: false, reason: "bad-config-dir" }, JSON.stringify(configDir));
  }
});

// The prefix as each shell reads it: the variable reaches the command, the
// empty value included, and with the exact string. `claude` is swapped for a
// shell that prints them, and the line is checked first, so nothing but that
// printf ever runs (and PATH holds no claude).
const PRINT_ACCOUNT = `-c 'printf "%s|%s" "\${CLAUDE_ACCOUNTS_DIR-unset}" "\${CLAUDE_CONFIG_DIR-unset}"'`;
for (const shell of ["/bin/sh", "/bin/zsh", "/bin/bash"]) {
  test(`the account prefix reaches the command through ${shell}`, { skip: !existsSync(shell) && `${shell} not installed` }, () => {
    for (const configDir of [null, PROFILE, "/it's $HOME/home/"]) {
      const full = command({ configDir }).command;
      const tail = `claude --resume ${SID}`;
      assert.ok(full.startsWith("CLAUDE_ACCOUNTS_DIR=") && full.endsWith(` ${tail}`), full);
      const line = `${full.slice(0, -tail.length)}${shell} ${PRINT_ACCOUNT}`;
      const out = execFileSync(shell, ["-c", line], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
      assert.equal(out, configDir === null ? "|unset" : `${configDir}|${configDir}`, `${shell}: ${line}`);
    }
  });
}

test("resume.js is pure: no herdr import, no I/O", () => {
  const src = readFileSync(new URL("../mods/agent-sleep/resume.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']herdr["']/);
  assert.doesNotMatch(src, /\brequire\(|\bDate\.now\(|node:child_process|node:fs/);
});

// ── T5: the env assignment Claude's hint asks for (Log L10) ───────────────

test("resumeCommand replays CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 before claude, and only that", () => {
  assert.deepEqual(REPLAYABLE_ENV, ["CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1"]);
  assert.deepEqual(command({ env: "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1" }), {
    ok: true, command: `${SYS} CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${SID}`,
  });
  assert.deepEqual(command({ env: "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1", shellCwd: "/elsewhere", flags: ["--model", "opus"] }), {
    ok: true, command: `cd /code/app && ${SYS} CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --model opus --resume ${SID}`,
  });
  for (const env of [null, undefined]) assert.equal(command({ env }).command, `${SYS} claude --resume ${SID}`);
  for (const env of ["FOO=1", "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0", "X=$(id)", "", 1]) {
    assert.deepEqual(command({ env }), { ok: false, reason: "unsupported-env" }, `env ${JSON.stringify(env)}`);
  }
});

test("hintDifference: an env the command replays is no difference; another one is", () => {
  const hint = (env) => parseExitScreen(["Resume this session with:", `${env} claude --resume ${SID}`, ""].join("\n"));
  const mode = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1";
  assert.equal(hintDifference(hint(mode), [], mode), null);
  assert.match(hintDifference(hint(mode), []), /sets CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1, the resume command doesn't/);
  assert.match(hintDifference(hint("FOO=1"), [], mode), /FOO=1/);
  assert.match(hintDifference(parseExitScreen(fixture("claude-exit.txt")), [], mode), /the resume command sets CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1/);
});
