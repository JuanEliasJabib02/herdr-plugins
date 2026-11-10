// resume-gaps T1, D2: agent-sleep's log file (A/log.js). Herdr starts mods
// with stdout and stderr on /dev/null, so every log() line also goes to
// <Herdr home>/agent-sleep/log.txt, with its local time. log.js is pure: the
// line's format, the pulse's buffer, and the one shell command that appends a
// pulse's lines and rotates the file past 1 MB. That command is run here for
// real, with /bin/sh, in a temporary folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logLine, logPaths, LogBuffer, appendCommand, LOG_MAX_BYTES } from "../mods/agent-sleep/log.js";

// What the mod's exec would run, run here.
const runAppend = (paths, text) => {
  const { cmd, args } = appendCommand(paths, text);
  execFileSync(cmd, args, { stdio: "pipe" });
};

const tempPaths = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-sleep-log-"));
  return { root, paths: logPaths(join(root, "agent-sleep")) };
};

test("a log line starts with its local time, YYYY-MM-DD HH:MM:SS", () => {
  const at = new Date(2026, 10, 9, 7, 5, 3).getTime(); // local time
  assert.equal(logLine(at, "t1: /exit sent (auto)"), "2026-11-09 07:05:03 t1: /exit sent (auto)");
  assert.equal(logLine(new Date(2026, 0, 1, 23, 59, 59).getTime(), "x"), "2026-01-01 23:59:59 x");
});

test("an event is one line: a stack's lines are joined", () => {
  const at = new Date(2026, 10, 9, 7, 5, 3).getTime();
  const line = logLine(at, "pulse failed: Error: boom\n    at tick (coordinator.js:1:2)\r\n    at pulse (coordinator.js:3:4)");
  assert.equal(line, "2026-11-09 07:05:03 pulse failed: Error: boom | at tick (coordinator.js:1:2) | at pulse (coordinator.js:3:4)");
  assert.ok(!line.includes("\n"));
});

test("its files: log.txt and one older generation, log.1.txt, in the mod's folder", () => {
  assert.deepEqual(logPaths("/h/agent-sleep/"), { dir: "/h/agent-sleep", file: "/h/agent-sleep/log.txt", rotated: "/h/agent-sleep/log.1.txt" });
  assert.equal(LOG_MAX_BYTES, 1024 * 1024);
});

test("the buffer holds a pulse's lines, timed when logged, and hands them out once", () => {
  const b = new LogBuffer();
  assert.equal(b.drain(), null, "nothing logged: nothing to append");
  b.add(new Date(2026, 10, 9, 7, 5, 3).getTime(), "t1: /exit sent (auto)");
  b.add(new Date(2026, 10, 9, 7, 5, 4).getTime(), "t2: not resumed (reveal): x");
  assert.equal(b.drain(), "2026-11-09 07:05:03 t1: /exit sent (auto)\n2026-11-09 07:05:04 t2: not resumed (reveal): x\n");
  assert.equal(b.drain(), null, "drained");
});

test("the append creates the folder and the file, then adds to it", () => {
  const { root, paths } = tempPaths();
  try {
    runAppend(paths, "a\n");
    runAppend(paths, "b\n");
    assert.equal(readFileSync(paths.file, "utf8"), "a\nb\n");
    assert.equal(existsSync(paths.rotated), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the text is written as is: no quote, $, backtick or % reaches the shell", () => {
  const { root, paths } = tempPaths();
  try {
    const text = "t1: 'x' \"y\" $(touch pwned) `touch pwned` $HOME %s %d \\n -n\n";
    runAppend(paths, text);
    assert.equal(readFileSync(paths.file, "utf8"), text);
    assert.equal(existsSync(join(root, "pwned")), false);
    assert.equal(existsSync("pwned"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotation at 1 MB: a log.txt of exactly 1 MB stays; past it, it becomes log.1.txt and the new lines start a fresh log.txt", () => {
  const { root, paths } = tempPaths();
  try {
    runAppend(paths, ""); // the folder
    writeFileSync(paths.file, "o".repeat(LOG_MAX_BYTES));
    runAppend(paths, "new\n");
    assert.equal(statSync(paths.file).size, LOG_MAX_BYTES + 4, "1 MB is not past 1 MB");
    assert.equal(existsSync(paths.rotated), false);
    runAppend(paths, "newer\n");
    assert.equal(readFileSync(paths.file, "utf8"), "newer\n");
    assert.equal(statSync(paths.rotated).size, LOG_MAX_BYTES + 4);
    // One generation: the next rotation replaces log.1.txt.
    writeFileSync(paths.file, "p".repeat(LOG_MAX_BYTES + 1));
    runAppend(paths, "newest\n");
    assert.equal(readFileSync(paths.file, "utf8"), "newest\n");
    assert.equal(readFileSync(paths.rotated, "utf8"), "p".repeat(LOG_MAX_BYTES + 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("log.js is pure: no herdr, no fs, no clock of its own", () => {
  const src = readFileSync(new URL("../mods/agent-sleep/log.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["'](herdr|gpui-kit|gpui-base|node:[a-z_]+)["']/);
  assert.doesNotMatch(src, /\bDate\.now\(|setTimeout|setInterval/);
});
