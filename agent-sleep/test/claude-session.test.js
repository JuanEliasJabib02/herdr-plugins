// T2: which Claude session a terminal holds (A/claude-session.js, D3). The
// session file `~/.claude/sessions/<pid>.json` is trusted only for the same
// process (procStart), an interactive session, a Claude foreground and an id
// that passes Orca's check; its transcript is found by id. After /exit the id
// Claude prints under "Resume this session with:" wins, but only from the
// shapes D3 names; anything else keeps the file's id and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESUME_HINT,
  isClaudeName, normalizeSessionId, normalizeProcStart, sessionFilePath, procStartCommand,
  checkSession, transcriptLookupCommand, parseTranscriptLookup, loadSession,
  parseExitScreen, exitSessionId,
} from "../mods/agent-sleep/claude-session.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const HOME = "/Users/demo";
const PID = 70285;
const SID = "8f3c2a91-0000-4000-8000-000000000001";
// The id in T0's exit fixture (ids replaced there).
const EXIT_SID = "00000000-0000-4000-8000-000000000001";
// As Claude 2.1.318 writes it, and as `TZ=UTC ps -o lstart=` prints it:
// a day under 10 is padded with a space.
const PROC_START = "Thu Nov  5 21:06:27 2026";

// A session file as Claude 2.1.318 writes it (trimmed: no socket, no name).
function sessionFile(over = {}) {
  return JSON.stringify({
    pid: PID,
    sessionId: SID,
    cwd: "/code/app",
    startedAt: 1793912787763,
    procStart: PROC_START,
    version: "2.1.318",
    kind: "interactive",
    entrypoint: "cli",
    status: "idle",
    ...over,
  });
}

const check = (over = {}) =>
  checkSession({ pid: PID, foregroundName: "claude.exe", file: sessionFile(), procStart: `${PROC_START}\n`, ...over });

// ── The id check (Orca agent-session-resume.ts:115-131) ────────────────────

test("normalizeSessionId is Orca's check: trimmed, 1-512 chars, no leading '-', no control chars", () => {
  assert.equal(normalizeSessionId(SID), SID);
  assert.equal(normalizeSessionId(`  ${SID}\t`), SID);
  assert.equal(normalizeSessionId(""), null);
  assert.equal(normalizeSessionId("   "), null);
  assert.equal(normalizeSessionId("-abc"), null);
  assert.equal(normalizeSessionId("--resume"), null);
  assert.equal(normalizeSessionId("a\nb"), null);
  assert.equal(normalizeSessionId("a\u007fb"), null);
  assert.equal(normalizeSessionId("x".repeat(512)), "x".repeat(512));
  assert.equal(normalizeSessionId("x".repeat(513)), null);
  assert.equal(normalizeSessionId(42), null);
  assert.equal(normalizeSessionId(null), null);
});

test("isClaudeName takes Core's foreground.name: claude or claude.exe, nothing else", () => {
  assert.equal(isClaudeName("claude"), true);
  assert.equal(isClaudeName("claude.exe"), true);
  assert.equal(isClaudeName("zsh"), false);
  assert.equal(isClaudeName("node"), false);
  assert.equal(isClaudeName("claude-code"), false);
  assert.equal(isClaudeName(undefined), false);
});

// ── Paths and commands, never run here ─────────────────────────────────────

test("the session file lives at $HOME/.claude/sessions/<pid>.json; a bad pid gives no path", () => {
  assert.equal(sessionFilePath(HOME, PID), "/Users/demo/.claude/sessions/70285.json");
  for (const pid of [0, -1, 1.5, "70285", Number.NaN, null]) assert.equal(sessionFilePath(HOME, pid), null, String(pid));
  assert.equal(sessionFilePath("", PID), null);
  assert.equal(sessionFilePath("relative/home", PID), null);
});

test("procStartCommand is `TZ=UTC ps -o lstart= -p <pid>` as an argv (env sets TZ, no shell)", () => {
  assert.deepEqual(procStartCommand(PID), ["env", "TZ=UTC", "ps", "-o", "lstart=", "-p", "70285"]);
  assert.equal(procStartCommand(0), null);
  assert.equal(procStartCommand("70285; rm -rf ~"), null);
});

test("normalizeProcStart collapses runs of spaces and trims, so ps and the file compare char for char", () => {
  assert.equal(normalizeProcStart("Thu Nov  5 21:06:27 2026  \n"), "Thu Nov 5 21:06:27 2026");
  assert.equal(normalizeProcStart(PROC_START), "Thu Nov 5 21:06:27 2026");
  assert.equal(normalizeProcStart("  \n"), null);
  assert.equal(normalizeProcStart(undefined), null);
});

// ── checkSession (D3) ──────────────────────────────────────────────────────

test("a session file for this very process is accepted: id, cwd and the file's status come back", () => {
  assert.deepEqual(check(), { ok: true, sessionId: SID, cwd: "/code/app", status: "idle" });
  // The file already parsed works the same.
  assert.equal(check({ file: JSON.parse(sessionFile()) }).ok, true);
  // ps pads a day under 10 with one space or two; both match.
  assert.equal(check({ procStart: "Thu Nov 5 21:06:27 2026" }).ok, true);
});

test("procStart mismatch is refused: a pid reused by another process never borrows the old session", () => {
  assert.deepEqual(check({ procStart: "Thu Nov  5 21:06:28 2026\n" }), { ok: false, reason: "proc-start-mismatch" });
  assert.deepEqual(check({ file: sessionFile({ procStart: undefined }) }), { ok: false, reason: "proc-start-mismatch" });
});

test("no ps output (the process is gone, or ps failed) is refused", () => {
  assert.deepEqual(check({ procStart: "" }), { ok: false, reason: "no-proc-start" });
  assert.deepEqual(check({ procStart: null }), { ok: false, reason: "no-proc-start" });
});

test("only an interactive session sleeps: kind other than interactive, or none, is refused", () => {
  assert.deepEqual(check({ file: sessionFile({ kind: "background" }) }), { ok: false, reason: "not-interactive" });
  assert.deepEqual(check({ file: sessionFile({ kind: undefined }) }), { ok: false, reason: "not-interactive" });
});

test("the foreground must be Claude: claude and claude.exe pass, anything else is refused before the file", () => {
  assert.equal(check({ foregroundName: "claude" }).ok, true);
  assert.deepEqual(check({ foregroundName: "node" }), { ok: false, reason: "not-claude" });
  assert.deepEqual(check({ foregroundName: "zsh" }), { ok: false, reason: "not-claude" });
});

test("an id that fails Orca's check is refused", () => {
  for (const sessionId of ["-abc", "", "a\nb", "x".repeat(513), 7, null]) {
    assert.deepEqual(check({ file: sessionFile({ sessionId }) }), { ok: false, reason: "invalid-session-id" }, String(sessionId));
  }
});

test("a missing, broken or foreign session file is refused", () => {
  assert.deepEqual(check({ file: null }), { ok: false, reason: "no-session-file" });
  assert.deepEqual(check({ file: undefined }), { ok: false, reason: "no-session-file" });
  assert.deepEqual(check({ file: "{not json" }), { ok: false, reason: "bad-session-file" });
  assert.deepEqual(check({ file: "[1,2]" }), { ok: false, reason: "bad-session-file" });
  assert.deepEqual(check({ file: sessionFile({ pid: 4680 }) }), { ok: false, reason: "pid-mismatch" });
  assert.deepEqual(check({ pid: 0 }), { ok: false, reason: "bad-pid" });
});

test("a cwd that isn't an absolute path comes back as null (resume.js then refuses to build a command)", () => {
  assert.equal(check({ file: sessionFile({ cwd: "code/app" }) }).cwd, null);
  assert.equal(check({ file: sessionFile({ cwd: undefined }) }).cwd, null);
  assert.equal(check({ file: sessionFile({ cwd: "/code/app" }) }).cwd, "/code/app");
});

// ── The transcript, found by id (Claude hashes long folder names) ─────────

test("transcriptLookupCommand is `find ~/.claude/projects -maxdepth 2 -name <id>.jsonl` as an argv", () => {
  assert.deepEqual(transcriptLookupCommand(HOME, SID), [
    "find", "/Users/demo/.claude/projects", "-maxdepth", "2", "-name", `${SID}.jsonl`,
  ]);
  assert.equal(transcriptLookupCommand(HOME, "-bad"), null);
  assert.equal(transcriptLookupCommand("", SID), null);
});

test("parseTranscriptLookup takes the first path that is exactly projects/<folder>/<id>.jsonl", () => {
  const path = `/Users/demo/.claude/projects/-code-app/${SID}.jsonl`;
  assert.equal(parseTranscriptLookup(`${path}\n`, { home: HOME, sessionId: SID }), path);
  // A folder Claude hashed past 200 chars is just another folder name.
  const hashed = `/Users/demo/.claude/projects/-very-long-a1b2c3/${SID}.jsonl`;
  assert.equal(parseTranscriptLookup(`${hashed}\n${path}\n`, { home: HOME, sessionId: SID }), hashed);
  assert.equal(parseTranscriptLookup("", { home: HOME, sessionId: SID }), null);
  assert.equal(parseTranscriptLookup(undefined, { home: HOME, sessionId: SID }), null);
  // -name is a glob: `*` in an id would match other transcripts; only the exact name counts.
  assert.equal(parseTranscriptLookup(`/Users/demo/.claude/projects/-a/aXb.jsonl\n`, { home: HOME, sessionId: "a*b" }), null);
  // Outside projects/, or not one folder deep: not Claude's transcript.
  assert.equal(parseTranscriptLookup(`/tmp/x/${SID}.jsonl\n`, { home: HOME, sessionId: SID }), null);
  assert.equal(parseTranscriptLookup(`/Users/demo/.claude/projects/${SID}.jsonl\n`, { home: HOME, sessionId: SID }), null);
});

// ── loadSession: the whole D3 check with injected I/O ─────────────────────

function fakeIo({ file = sessionFile(), ps = `${PROC_START}\n`, found = `/Users/demo/.claude/projects/-code-app/${SID}.jsonl\n` } = {}) {
  const calls = [];
  return {
    calls,
    readText: async (path) => {
      calls.push(["read", path]);
      if (file instanceof Error) throw file;
      return file;
    },
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "env") return { code: ps ? 0 : 1, stdout: ps ?? "", stderr: "" };
      if (cmd === "find") return { code: 0, stdout: found, stderr: "" };
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

test("loadSession reads the file, checks procStart with ps and finds the transcript, all through injected I/O", async () => {
  const io = fakeIo();
  const result = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, io);
  assert.deepEqual(result, {
    ok: true,
    sessionId: SID,
    cwd: "/code/app",
    status: "idle",
    transcript: `/Users/demo/.claude/projects/-code-app/${SID}.jsonl`,
  });
  assert.deepEqual(io.calls, [
    ["read", "/Users/demo/.claude/sessions/70285.json"],
    ["env", "TZ=UTC", "ps", "-o", "lstart=", "-p", "70285"],
    ["find", "/Users/demo/.claude/projects", "-maxdepth", "2", "-name", `${SID}.jsonl`],
  ]);
});

test("loadSession: no transcript found → ok with transcript null (rules.js says no-transcript)", async () => {
  const result = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, fakeIo({ found: "" }));
  assert.equal(result.ok, true);
  assert.equal(result.transcript, null);
});

test("loadSession refuses early: not Claude (nothing read), no file (another CLAUDE_CONFIG_DIR), procStart mismatch", async () => {
  const io = fakeIo();
  assert.deepEqual(await loadSession({ home: HOME, pid: PID, foregroundName: "zsh" }, io), { ok: false, reason: "not-claude" });
  assert.deepEqual(io.calls, []);
  const gone = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, fakeIo({ file: new Error("ENOENT") }));
  assert.deepEqual(gone, { ok: false, reason: "no-session-file" });
  const moved = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, fakeIo({ file: null }));
  assert.deepEqual(moved, { ok: false, reason: "no-session-file" });
  const reused = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, fakeIo({ ps: "Fri Nov  6 08:00:00 2026\n" }));
  assert.deepEqual(reused, { ok: false, reason: "proc-start-mismatch" });
  const noPs = await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, fakeIo({ ps: null }));
  assert.deepEqual(noPs, { ok: false, reason: "no-proc-start" });
});

test("loadSession turns a failing exec (find missing, exec's time limit) into a refusal, never a throw", async () => {
  const io = {
    readText: async () => sessionFile(),
    exec: async () => {
      throw new Error("exec timed out");
    },
  };
  assert.deepEqual(await loadSession({ home: HOME, pid: PID, foregroundName: "claude.exe" }, io), { ok: false, reason: "no-proc-start" });
});

// ── The exit screen ("Resume this session with:") ─────────────────────────

const exitScreen = (command) =>
  ["❯", "─".repeat(80), "   main  Opus 5.5", "", RESUME_HINT, command, "", "as-probe-cwd [ main]", "❯"].join("\n");

test("T0's exit screen: the id under 'Resume this session with:' is parsed, no flags printed", () => {
  const parsed = parseExitScreen(fixture("claude-exit.txt"));
  assert.equal(parsed.shape, "resume");
  assert.equal(parsed.sessionId, EXIT_SID);
  assert.deepEqual(parsed.flags, []);
  assert.equal(parsed.env, null);
  assert.equal(parsed.worktree, null);
  assert.equal(parsed.line, `claude --resume ${EXIT_SID}`);
});

test("after /exit the printed id wins over the file's (covers /clear)", () => {
  const parsed = parseExitScreen(fixture("claude-exit.txt"));
  assert.deepEqual(exitSessionId(SID, parsed), { sessionId: EXIT_SID, from: "exit", log: null });
});

test("synthetic: flags and a worktree, `claude <flags> -w \"n\" -r <id>` → id, flags and worktree apart", () => {
  const parsed = parseExitScreen(exitScreen(`claude --dangerously-skip-permissions -w "n" -r ${EXIT_SID}`));
  assert.equal(parsed.shape, "resume");
  assert.equal(parsed.sessionId, EXIT_SID);
  assert.deepEqual(parsed.flags, ["--dangerously-skip-permissions"]);
  assert.equal(parsed.worktree, "n");
  const long = parseExitScreen(exitScreen(`claude --model opus --worktree "feat-x" --resume ${EXIT_SID}`));
  assert.deepEqual(long.flags, ["--model", "opus"]);
  assert.equal(long.worktree, "feat-x");
});

test("synthetic: `ENV=1 claude …` → id parsed, the assignment kept apart", () => {
  const parsed = parseExitScreen(exitScreen(`CLAUDE_CODE_X=1 claude --dangerously-skip-permissions --resume ${EXIT_SID}`));
  assert.equal(parsed.shape, "resume");
  assert.equal(parsed.sessionId, EXIT_SID);
  assert.equal(parsed.env, "CLAUDE_CODE_X=1");
  assert.deepEqual(parsed.flags, ["--dangerously-skip-permissions"]);
});

test("synthetic: no id (`claude --resume`) → the file's id is kept and the reason logged", () => {
  const parsed = parseExitScreen(exitScreen("claude --resume"));
  assert.equal(parsed.shape, "no-id");
  assert.equal(parsed.sessionId, null);
  const picked = exitSessionId(SID, parsed);
  assert.equal(picked.sessionId, SID);
  assert.equal(picked.from, "file");
  assert.match(picked.log, /no-id/);
});

test("synthetic: `claude --cloud <id>` → the file's id is kept and logged", () => {
  const parsed = parseExitScreen(exitScreen(`claude --cloud ${EXIT_SID}`));
  assert.equal(parsed.shape, "cloud");
  assert.equal(parsed.sessionId, null);
  const picked = exitSessionId(SID, parsed);
  assert.equal(picked.sessionId, SID);
  assert.match(picked.log, /cloud/);
});

test("a wrapped hint (the id cut at the terminal's edge) never yields a partial id", () => {
  const wrapped = ["", RESUME_HINT, "claude --model opus --resume 00000000-0000-4000-80", "00-000000000001", "", "❯"].join("\n");
  const parsed = parseExitScreen(wrapped);
  assert.equal(parsed.shape, "other");
  assert.equal(parsed.sessionId, null);
  assert.equal(exitSessionId(SID, parsed).sessionId, SID);
});

test("other shapes keep the file's id: an id failing Orca's check, a path to claude, no hint on screen", () => {
  for (const command of ["claude --resume -x", "/usr/local/bin/claude --resume " + EXIT_SID, "claude  --resume " + EXIT_SID]) {
    const parsed = parseExitScreen(exitScreen(command));
    assert.equal(parsed.shape, "other", command);
    assert.equal(exitSessionId(SID, parsed).sessionId, SID, command);
  }
  const none = parseExitScreen(fixture("shell-bare.txt"));
  assert.equal(none.shape, "absent");
  const picked = exitSessionId(SID, none);
  assert.equal(picked.sessionId, SID);
  assert.match(picked.log, /absent/);
});

test("with two hints on screen (an earlier Claude in the same terminal) the last one counts", () => {
  const older = "00000000-0000-4000-8000-0000000000aa";
  const screen = ["", RESUME_HINT, `claude --resume ${older}`, "", "❯ claude", "", RESUME_HINT, `claude --resume ${EXIT_SID}`, "", "❯"].join("\n");
  assert.equal(parseExitScreen(screen).sessionId, EXIT_SID);
});

test("the file's id has to be valid too: with neither id valid there's no session", () => {
  const parsed = parseExitScreen(exitScreen("claude --resume"));
  assert.deepEqual(exitSessionId("-bad", parsed).sessionId, null);
  assert.deepEqual(exitSessionId(SID, parseExitScreen(42)).sessionId, SID);
});

test("claude-session.js is pure: no herdr import, no clock", () => {
  const src = readFileSync(new URL("../mods/agent-sleep/claude-session.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']herdr["']/);
  assert.doesNotMatch(src, /\brequire\(|\bDate\.now\(|\bperformance\.now\(|node:child_process|node:fs/);
});
