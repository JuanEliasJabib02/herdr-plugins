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
import * as serverLog from "../mods/spotlight/server-log.js";
import {
  stripTerminalSequences, repoSlug, logDir, logPathFor, formatClock, headerLine, appendLogHeader,
  rotateLog, tailLog, MAX_LOG_BYTES, KEEP_LOG_BYTES, TRIM_MARKER,
  isStartMarker, logSinceLastStart, startFailure, readStartFailure,
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

test("causeWords (M9): a cause's own words on one line as headerLine writes them; null when there are none (not a string, empty, or only spaces and control bytes)", () => {
  const { causeWords } = serverLog;
  assert.equal(causeWords("hc: spawn failed\nexit 1\r\n"), "hc: spawn failed exit 1");
  assert.equal(causeWords("  t1 has finished  "), "t1 has finished");
  for (const none of [undefined, null, 7, {}, "", "   ", "\u0007\r\n", "\t\u001b"]) assert.equal(causeWords(none), null, JSON.stringify(none));
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

// ── A start that died (T14, D25) ──
// When Spotlight's server was `starting` and the shell is back at its prompt
// with no port, the CLI reads the log since the last start marker: an
// address in use becomes port-busy, anything else server-exited with the
// first error line.

// The side-project log of the incident (S14, L15), byte for byte as
// `script -F` and the CLI wrote it: haddock's start interrupted, then two
// starts of spotlight-1 that died on EADDRINUSE :3008.
const SPEAKING_ENGLISH_LOG =
  "\n" +
  "── Spotlight: haddock (work-dev/fix-app-direction) · 19:38:20 ──\n" +
  "\n" +
  "── Spotlight: haddock (work-dev/fix-app-direction) · started: pnpm install --frozen-lockfile && pnpm dev · 19:38:20 ──\n" +
  "Lockfile is up to date, resolution step is skipped\r\n" +
  "Progress: resolved \u001b[96m1\u001b[39m, reused \u001b[96m0\u001b[39m, downloaded \u001b[96m0\u001b[39m, added \u001b[96m0\u001b[39m\r\n" +
  "\u001b[1APackages: \u001b[32m+228\u001b[39m\u001b[0K\r\n" +
  `${ESC}[32m+${ESC}[39m`.repeat(198) + "\r\n" +
  "Progress: resolved \u001b[96m1\u001b[39m, reused \u001b[96m0\u001b[39m, downloaded \u001b[96m0\u001b[39m, added \u001b[96m0\u001b[39m\r\n" +
  "\u001b[1AProgress: resolved \u001b[96m228\u001b[39m, reused \u001b[96m0\u001b[39m, downloaded \u001b[96m0\u001b[39m, added \u001b[96m0\u001b[39m\r\n" +
  "^C\n" +
  "── Spotlight: haddock (work-dev/fix-app-direction) · stopped · 19:38:22 ──\n" +
  "\n" +
  "── Spotlight: spotlight-1 (spotlight-1) · 12:49:42 ──\n" +
  "\n" +
  "── Spotlight: spotlight-1 (spotlight-1) · started: pnpm dev · 12:49:42 ──\n" +
  "\r\n" +
  "> side-project@1.0.0 dev /Users/alex/code/side-project\r\n" +
  "> npm-run-all --parallel dev:next dev:convex\r\n" +
  "\r\n" +
  "\r\n" +
  "> side-project@1.0.0 dev:next /Users/alex/code/side-project\r\n" +
  "> next dev -p 3008\r\n" +
  "\r\n" +
  "\r\n" +
  "> side-project@1.0.0 dev:convex /Users/alex/code/side-project\r\n" +
  "> convex dev\r\n" +
  "\r\n" +
  "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m Failed to start server\r\n" +
  "Error: listen EADDRINUSE: address already in use :::3008\r\n" +
  "    at <unknown> (Error: listen EADDRINUSE: address already in use :::3008)\r\n" +
  "    at new Promise (<anonymous>) {\r\n" +
  "  code: \u001b[32m'EADDRINUSE'\u001b[39m,\r\n" +
  "  errno: \u001b[33m-48\u001b[39m,\r\n" +
  "  syscall: \u001b[32m'listen'\u001b[39m,\r\n" +
  "  address: \u001b[32m'::'\u001b[39m,\r\n" +
  "  port: \u001b[33m3008\u001b[39m\r\n" +
  "}\r\n" +
  "\u001b[?25h\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed with exit code 1.\u001b[39m\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed.\u001b[39m\r\n" +
  "ERROR: \"dev:next\" exited with 1.\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed with exit code 1.\u001b[39m\r\n" +
  "\n" +
  "── Spotlight: spotlight-1 (spotlight-1) · 12:51:18 ──\n" +
  "\n" +
  "── Spotlight: spotlight-1 (spotlight-1) · started: pnpm dev · 12:51:18 ──\n" +
  "\r\n" +
  "> side-project@1.0.0 dev /Users/alex/code/side-project\r\n" +
  "> npm-run-all --parallel dev:next dev:convex\r\n" +
  "\r\n" +
  "\r\n" +
  "> side-project@1.0.0 dev:next /Users/alex/code/side-project\r\n" +
  "> next dev -p 3008\r\n" +
  "\r\n" +
  "\r\n" +
  "> side-project@1.0.0 dev:convex /Users/alex/code/side-project\r\n" +
  "> convex dev\r\n" +
  "\r\n" +
  "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m Failed to start server\r\n" +
  "Error: listen EADDRINUSE: address already in use :::3008\r\n" +
  "    at <unknown> (Error: listen EADDRINUSE: address already in use :::3008)\r\n" +
  "    at new Promise (<anonymous>) {\r\n" +
  "  code: \u001b[32m'EADDRINUSE'\u001b[39m,\r\n" +
  "  errno: \u001b[33m-48\u001b[39m,\r\n" +
  "  syscall: \u001b[32m'listen'\u001b[39m,\r\n" +
  "  address: \u001b[32m'::'\u001b[39m,\r\n" +
  "  port: \u001b[33m3008\u001b[39m\r\n" +
  "}\r\n" +
  "\u001b[?25h\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed with exit code 1.\u001b[39m\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed.\u001b[39m\r\n" +
  "ERROR: \"dev:next\" exited with 1.\r\n" +
  "\u001b[41m\u001b[30m ELIFECYCLE \u001b[39m\u001b[49m \u001b[31mCommand failed with exit code 1.\u001b[39m\r\n";

// A start marker as the CLI writes it (server.js typeWhenIdle: "started:" or
// "restarted:" and the command), then what the server printed.
const startedAt = new Date(2026, 10, 8, 10, 0, 0).getTime();
const marker = (event = "started", command = "pnpm dev") =>
  `\n${headerLine({ workspace: "app", branch: "main", event: `${event}: ${command}`, at: startedAt })}\n`;

// A Node server with a syntax error, colored as pnpm prints it.
const SYNTAX_ERROR_START =
  "\r\n> app@1.0.0 dev /Users/u/code/app\r\n> node server.js\r\n\r\n" +
  "/Users/u/code/app/server.js:3\r\n" +
  "const port = ;\r\n" +
  "             ^\r\n\r\n" +
  `${ESC}[31mSyntaxError: Unexpected token ';'${ESC}[39m\r\n` +
  "    at wrapSafe (node:internal/modules/cjs/loader:1469:18)\r\n" +
  "    at Module._compile (node:internal/modules/cjs/loader:1491:20)\r\n\r\n" +
  "Node.js v24.11.0\r\n" +
  `${ESC}[41m${ESC}[30m ELIFECYCLE ${ESC}[39m${ESC}[49m ${ESC}[31mCommand failed with exit code 1.${ESC}[39m\r\n`;

const logFile = (text) => {
  const dir = tmp();
  const p = join(dir, "app.log");
  writeFileSync(p, text);
  return { dir, p };
};

test("isStartMarker: the CLI's started and restarted headers, never a holder switch, a stop or a start left alone", () => {
  assert.equal(isStartMarker("── Spotlight: spotlight-1 (spotlight-1) · started: pnpm dev · 12:51:18 ──"), true);
  assert.equal(isStartMarker(headerLine({ workspace: "app", event: "restarted: pnpm install && pnpm dev", at: startedAt })), true);
  assert.equal(isStartMarker(headerLine({ event: "started: vite", at: startedAt })), true);
  assert.equal(isStartMarker("── Spotlight: spotlight-1 (spotlight-1) · 12:51:18 ──"), false);
  assert.equal(isStartMarker("── Spotlight: haddock (fix) · stopped · 19:38:22 ──"), false);
  assert.equal(isStartMarker(headerLine({ workspace: "app", event: "Server not started — port 3008 is held by node (pid 9)", at: startedAt })), false);
  assert.equal(isStartMarker("started: pnpm dev"), false);
});

test("logSinceLastStart: the side-project log (two starts of spotlight-1) → only what the last start printed, as plain text", () => {
  const { dir, p } = logFile(SPEAKING_ENGLISH_LOG);
  const text = logSinceLastStart(p);
  assert.ok(!text.includes(ESC) && !text.includes("\r"), "ANSI codes and CRs stripped");
  assert.ok(text.startsWith("\n> side-project@1.0.0 dev /Users/alex/code/side-project\n"), text.slice(0, 120));
  assert.equal(text.match(/Failed to start server/g)?.length, 1, "the first start of spotlight-1 is not read");
  assert.ok(!text.includes("Lockfile is up to date"), "nor haddock's");
  assert.ok(text.includes("\n⨯ Failed to start server\nError: listen EADDRINUSE: address already in use :::3008\n"));
  assert.ok(text.endsWith('ERROR: "dev:next" exited with 1.\n ELIFECYCLE  Command failed with exit code 1.\n'), text.slice(-120));
  rmSync(dir, { recursive: true, force: true });
});

test("readStartFailure: the side-project log is an address in use on 3008", () => {
  const { dir, p } = logFile(SPEAKING_ENGLISH_LOG);
  assert.deepEqual(readStartFailure(p), {
    kind: "addr-in-use", port: 3008, line: "Error: listen EADDRINUSE: address already in use :::3008",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("readStartFailure: any other death names its first error line (a SyntaxError), colors stripped", () => {
  const { dir, p } = logFile(`${marker()}${SYNTAX_ERROR_START}`);
  assert.deepEqual(readStartFailure(p), { kind: "exited", line: "SyntaxError: Unexpected token ';'" });
  rmSync(dir, { recursive: true, force: true });
});

test("only the text after the last start marker is read: an earlier start's EADDRINUSE doesn't decide a later SyntaxError, nor the reverse; a restart marker counts", () => {
  const first = `${marker()}Error: listen EADDRINUSE: address already in use :::3000\r\n`;
  const a = logFile(`${first}${marker("restarted")}${SYNTAX_ERROR_START}`);
  assert.deepEqual(readStartFailure(a.p), { kind: "exited", line: "SyntaxError: Unexpected token ';'" });
  const b = logFile(`${marker()}${SYNTAX_ERROR_START}${marker()}${first.slice(marker().length)}`);
  assert.deepEqual(readStartFailure(b.p), { kind: "addr-in-use", port: 3000, line: "Error: listen EADDRINUSE: address already in use :::3000" });
  for (const { dir } of [a, b]) rmSync(dir, { recursive: true, force: true });
});

test("startFailure: other address-in-use wordings and where their port is; npm's `> ` echoes and the CLI's headers are no error lines; no error line → the last line; no output → no line", () => {
  assert.deepEqual(startFailure("error when starting dev server:\nError: Port 5173 is already in use\n"), {
    kind: "addr-in-use", port: 5173, line: "Error: Port 5173 is already in use",
  });
  assert.deepEqual(startFailure("ERROR: [Errno 48] error while attempting to bind on address ('127.0.0.1', 8000): address already in use\n"), {
    kind: "addr-in-use", port: null, line: "ERROR: [Errno 48] error while attempting to bind on address ('127.0.0.1', 8000): address already in use",
  });
  assert.deepEqual(startFailure("Error: listen EADDRINUSE\n  port: 4000\n"), { kind: "addr-in-use", port: 4000, line: "Error: listen EADDRINUSE" });
  assert.deepEqual(
    startFailure(`\n> app@1.0.0 dev:error-page /x\n> node error.js\n${headerLine({ event: "Server left alone — failed", at: startedAt })}\nzsh: command not found: nodee\n`),
    { kind: "exited", line: "zsh: command not found: nodee" },
  );
  assert.deepEqual(startFailure("\n> app@1.0.0 dev\n> node quiet.js\nbye for now\n\n"), { kind: "exited", line: "bye for now" });
  assert.deepEqual(startFailure("\n\n> app@1.0.0 dev\n"), { kind: "exited", line: null });
  assert.deepEqual(startFailure(""), { kind: "exited", line: null });
  // A line too long for a toast is cut.
  const long = startFailure(`Error: ${"x".repeat(400)}\n`).line;
  assert.ok(long.length <= 160 && long.endsWith("…"), long);
});

test("startFailure (R2): Next's and Vite's \"Port N is in use, trying …\" warnings are no busy-port death; the real error line wins", () => {
  // Next before 15 moved to 3001, then died of something else.
  assert.deepEqual(
    startFailure(" ⚠ Port 3000 is in use, trying 3001 instead.\n ▲ Next.js 14.2.3\nError: Cannot find module 'left-pad'\n"),
    { kind: "exited", line: "Error: Cannot find module 'left-pad'" },
  );
  // Next 16's wording (next/dist/server/lib/start-server.js), both forms.
  assert.deepEqual(
    startFailure(" ⚠ Port 3000 is in use by process 4242, using available port 3001 instead.\nSyntaxError: Unexpected token ';'\n"),
    { kind: "exited", line: "SyntaxError: Unexpected token ';'" },
  );
  assert.deepEqual(
    startFailure(" ⚠ Port 3000 is in use by an unknown process, using available port 3001 instead.\nError: boom\n"),
    { kind: "exited", line: "Error: boom" },
  );
  // Vite moved on and the next port was taken for real: that line decides, with its port.
  assert.deepEqual(
    startFailure("Port 5173 is in use, trying another one...\nError: listen EADDRINUSE: address already in use :::5174\n"),
    { kind: "addr-in-use", port: 5174, line: "Error: listen EADDRINUSE: address already in use :::5174" },
  );
  // Vite's strictPort error still is one.
  assert.equal(startFailure("Port 5173 is in use, trying another one...\nError: Port 5174 is already in use\n").port, 5174);
});

test("logSinceLastStart: a marker far back in a big log is still found; a log with no marker, or no log, is null", () => {
  const filler = Array.from({ length: 6000 },(_, i) => `${ESC}[2mcompiling module ${i}${ESC}[22m\r\n`).join("");
  const big = logFile(`${"old output\r\n".repeat(10)}${marker()}${filler}Error: Cannot find module 'left-pad'\r\n`);
  assert.ok(Buffer.byteLength(readFileSync(big.p)) > 128 * 1024);
  assert.deepEqual(readStartFailure(big.p), { kind: "exited", line: "Error: Cannot find module 'left-pad'" });
  assert.ok(logSinceLastStart(big.p).startsWith("compiling module 0\n"));
  const none = logFile("just output\r\n");
  assert.equal(logSinceLastStart(none.p), null);
  assert.deepEqual(readStartFailure(none.p), { kind: "exited", line: null });
  assert.equal(logSinceLastStart(join(none.dir, "missing.log")), null);
  for (const { dir } of [big, none]) rmSync(dir, { recursive: true, force: true });
});
