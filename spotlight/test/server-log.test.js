// T5b: the server's log file (D11). `script -F -q -a <logPath>` writes it
// (D10); M/server-log.js names it, rotates it as Orca's mirror does (past
// 4 MB keep the last 1 MB, in place), appends the CLI's header lines and
// prints its tail as plain text through the port of Orca's
// stripTerminalSequences (O/src/shared/terminal-escape-stripping.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, openSync, writeSync, closeSync, realpathSync, rmSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripTerminalSequences, repoSlug, logDir, logPathFor, formatClock, headerLine, appendLogHeader,
  rotateLog, tailLog, MAX_LOG_BYTES, KEEP_LOG_BYTES, TRIM_MARKER,
} from "../mods/spotlight/server-log.js";

const ESC = "\u001b";
const BEL = "\u0007";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sl-log-")));

// ── stripTerminalSequences: Orca's own cases (spotlight-log-mirror.test.ts) ──

test("stripTerminalSequences removes SGR colors and cursor movement", () => {
  assert.equal(stripTerminalSequences(`${ESC}[32mBUNDLE${ESC}[0m ready ${ESC}[2K${ESC}[1G`), "BUNDLE ready ");
});

test("stripTerminalSequences removes OSC title and hyperlink sequences", () => {
  assert.equal(stripTerminalSequences(`${ESC}]0;metro${BEL}hello`), "hello");
  assert.equal(stripTerminalSequences(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`), "link");
});

test("stripTerminalSequences converts carriage-return rewrites into separate lines", () => {
  assert.equal(stripTerminalSequences("Loading 10%\rLoading 99%\r\ndone"), "Loading 10%\nLoading 99%\ndone");
});

test("stripTerminalSequences drops residual control characters but keeps newlines and tabs", () => {
  assert.equal(stripTerminalSequences("a\u0008 bc\td\ne\u0000"), "a bc\td\ne");
});

test("stripTerminalSequences passes plain server output through unchanged", () => {
  const line = "ERROR  TypeError: undefined is not a function (App.tsx:42)\n";
  assert.equal(stripTerminalSequences(line), line);
});

// ── Paths ──

test("logPathFor: <home>/.local/state/herdr-spotlight/logs/<repo slug>.log, outside the repo and the app home", () => {
  assert.equal(logDir("/Users/demo"), "/Users/demo/.local/state/herdr-spotlight/logs");
  const p = logPathFor("/Users/demo/code/app", { home: "/Users/demo" });
  assert.equal(p, `/Users/demo/.local/state/herdr-spotlight/logs/${repoSlug("/Users/demo/code/app")}.log`);
});

test("repoSlug: readable, stable, ≤ 29 chars of [a-z0-9-] so `sl-<slug>` is a valid hc name; same basename, other root, other slug", () => {
  const a = repoSlug("/Users/demo/code/app");
  assert.match(a, /^app-[0-9a-f]{6}$/);
  assert.equal(repoSlug("/Users/demo/code/app"), a);
  assert.notEqual(repoSlug("/Users/demo/other/app"), a);
  const long = repoSlug("/x/My Very_Long.Repository Name With Spaces And Dots");
  assert.ok(long.length <= 29, long);
  assert.match(long, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.match(repoSlug("/x/!!!"), /^repo-[0-9a-f]{6}$/);
});

// ── Headers ──

test("headerLine: Orca's holder-switch header, with an optional event", () => {
  const at = new Date(2026, 10, 6, 22, 58, 4).getTime();
  assert.equal(formatClock(at), "22:58:04");
  assert.equal(headerLine({ workspace: "login", branch: "feat/login", at }), "── Spotlight: login (feat/login) · 22:58:04 ──");
  assert.equal(headerLine({ workspace: "login", branch: "feat/login", event: "stopped", at }), "── Spotlight: login (feat/login) · stopped · 22:58:04 ──");
  assert.equal(headerLine({ workspace: "app", event: "started: pnpm dev", at }), "── Spotlight: app · started: pnpm dev · 22:58:04 ──");
  assert.equal(headerLine({ event: "stopped", at }), "── Spotlight: stopped · 22:58:04 ──");
});

test("appendLogHeader creates the log folder and puts the header on its own line", () => {
  const dir = tmp();
  const p = join(dir, "deep", "logs", "app.log");
  const at = new Date(2026, 10, 6, 9, 5, 7).getTime();
  appendLogHeader(p, { workspace: "login", branch: "feat/login", at });
  writeFileSync(p, readFileSync(p, "utf8") + "ready in 120ms"); // server output, no newline yet
  appendLogHeader(p, { workspace: "login", branch: "feat/login", event: "stopped", at });
  assert.equal(
    readFileSync(p, "utf8"),
    "\n── Spotlight: login (feat/login) · 09:05:07 ──\nready in 120ms\n── Spotlight: login (feat/login) · stopped · 09:05:07 ──\n",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── Rotation ──

test("rotateLog: past 4 MB it keeps the last 1 MB in place, from a whole line, after a marker", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  const line = (i) => `line ${String(i).padStart(7, "0")} ${"x".repeat(80)}\r\n`; // 95 bytes
  const body = Array.from({ length: Math.ceil((MAX_LOG_BYTES + 1000) / 95) }, (_, i) => line(i)).join("");
  assert.ok(Buffer.byteLength(body) > MAX_LOG_BYTES);
  writeFileSync(p, body);
  const inode = statSync(p).ino;
  assert.equal(rotateLog(p), true);
  const after = readFileSync(p, "utf8");
  assert.equal(statSync(p).ino, inode, "same file: script's open fd keeps writing to it");
  assert.ok(after.startsWith(`${TRIM_MARKER}\n`), after.slice(0, 60));
  const kept = after.slice(TRIM_MARKER.length + 1);
  assert.ok(Buffer.byteLength(kept) <= KEEP_LOG_BYTES, `${Buffer.byteLength(kept)}`);
  assert.ok(Buffer.byteLength(kept) > KEEP_LOG_BYTES - 200, "keeps about the last 1 MB");
  assert.match(kept, /^line \d{7} x+\r\n/, "starts at a whole line");
  assert.ok(body.endsWith(kept), "the tail is the original's last bytes");
  rmSync(dir, { recursive: true, force: true });
});

test("rotateLog: a log at or under 4 MB, or missing, is left alone", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  writeFileSync(p, "small\n");
  const before = statSync(p).mtimeMs;
  assert.equal(rotateLog(p), false);
  assert.equal(readFileSync(p, "utf8"), "small\n");
  assert.equal(statSync(p).mtimeMs, before);
  assert.equal(rotateLog(join(dir, "missing.log")), false);
  assert.equal(existsSync(join(dir, "missing.log")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("rotateLog: an O_APPEND writer (script -a) open across the cut keeps appending right after the kept tail, no gap", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  const lines = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")} ${"z".repeat(46)}\n`);
  writeFileSync(p, lines.join("")); // 100 lines of 51 bytes
  const fd = openSync(p, "a");
  assert.equal(rotateLog(p, { max: 1000, keep: 2000 }), true);
  writeSync(fd, "after cut\n");
  closeSync(fd);
  // The last 2000 bytes start mid-line: that partial line goes, the 39 whole
  // lines after it stay, and the writer's next line lands right after them.
  assert.equal(readFileSync(p, "utf8"), `${TRIM_MARKER}\n${lines.slice(61).join("")}after cut\n`);
  rmSync(dir, { recursive: true, force: true });
});

test("rotateLog: a window that is one unbroken line is kept whole rather than emptied", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  writeFileSync(p, "a".repeat(3000));
  assert.equal(rotateLog(p, { max: 1000, keep: 500 }), true);
  assert.equal(readFileSync(p, "utf8"), `${TRIM_MARKER}\n${"a".repeat(500)}`);
  rmSync(dir, { recursive: true, force: true });
});

// ── Tail ──

// What `script -F` writes for a dev server: CRLF lines, colors, an OSC
// title, and a progress bar redrawn with bare CRs.
const SCRIPT_FIXTURE =
  `${ESC}]0;pnpm dev${BEL}` +
  `${ESC}[1m${ESC}[32m> app@1.0.0 dev${ESC}[39m${ESC}[22m\r\n` +
  `${ESC}[2m  next dev --port 3000${ESC}[22m\r\n` +
  `Compiling  10%\rCompiling  55%\rCompiling 100%\r\n` +
  `${ESC}[32m✓${ESC}[39m Ready in 812ms\r\n` +
  `  - Local:        ${ESC}[4mhttp://localhost:3000${ESC}[24m\r\n` +
  `${ESC}[31merror${ESC}[39m - TypeError: x is not a function\r\n`;

test("tailLog turns ANSI colors, CRLF and a bare-CR progress bar into Orca's plain text", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  writeFileSync(p, SCRIPT_FIXTURE);
  assert.equal(
    tailLog(p),
    [
      "> app@1.0.0 dev",
      "  next dev --port 3000",
      "Compiling  10%",
      "Compiling  55%",
      "Compiling 100%",
      "✓ Ready in 812ms",
      "  - Local:        http://localhost:3000",
      "error - TypeError: x is not a function",
      "",
    ].join("\n"),
  );
  assert.equal(tailLog(p, { lines: 2 }), "  - Local:        http://localhost:3000\nerror - TypeError: x is not a function\n");
  rmSync(dir, { recursive: true, force: true });
});

test("tailLog: the last N lines of a big log without reading it whole; a missing log is null", () => {
  const dir = tmp();
  const p = join(dir, "app.log");
  let body = "";
  for (let i = 0; i < 60000; i++) body += `${ESC}[2mline ${i}${ESC}[22m\r\n`;
  writeFileSync(p, body);
  assert.equal(tailLog(p, { lines: 3 }), "line 59997\nline 59998\nline 59999\n");
  const all = tailLog(p, { lines: 100000 }).split("\n");
  assert.equal(all[0], "line 0");
  assert.equal(all.length, 60001);
  assert.equal(tailLog(join(dir, "missing.log")), null);
  mkdirSync(join(dir, "folder.log"));
  assert.equal(tailLog(join(dir, "folder.log")), null);
  rmSync(dir, { recursive: true, force: true });
});
