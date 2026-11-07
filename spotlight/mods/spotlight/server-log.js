// The server's log file (D11), the port of Orca's `.orca/spotlight.log`
// mirror (O/src/main/spotlight/spotlight-log-mirror.ts). Node-only: the CLI
// uses it, the mod never imports it.
//
// `script -F -q -a <logPath>` writes the file as the server prints (D10):
// raw terminal output, CRLF lines, colors and all. Here the CLI names the
// file (outside the repo and outside the app home, so server output never
// wakes the footer's state watch), rotates it as Orca's mirror does, appends
// its header lines (holder switch, start, restart, stop) and prints its tail
// as plain text through the port of Orca's stripTerminalSequences.

import {
  openSync, closeSync, fstatSync, readSync, writeSync, ftruncateSync, appendFileSync, mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";

// Orca's mirror bounds: once the log passes MAX, keep its last KEEP bytes.
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const KEEP_LOG_BYTES = 1 * 1024 * 1024;
// The first line of a rotated log (Orca's "[log trimmed by Orca]").
export const TRIM_MARKER = "[log trimmed by Spotlight]";
// `spotlight logs` without --lines.
export const DEFAULT_TAIL_LINES = 200;

// ── stripTerminalSequences (O/src/shared/terminal-escape-stripping.ts) ──────
// Canonical terminal-escape stripper for turning raw PTY output into plain,
// greppable text: CSI + OSC with BEL/ST terminators + CR normalization +
// residual control sweep.

// CSI (colors/cursor), OSC (titles/hyperlinks), and stray escapes.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// Remaining two-byte Fe escapes; any stray lone ESC falls into the final
// control-char sweep below.
// eslint-disable-next-line no-control-regex
const OTHER_ESC_RE = /\u001b[@-Z\\-_]/g;
// Everything below 0x20 except \n and \t, plus DEL.
// eslint-disable-next-line no-control-regex
const RESIDUAL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripTerminalSequences(data) {
  return (
    String(data)
      .replace(OSC_RE, "")
      .replace(CSI_RE, "")
      .replace(OTHER_ESC_RE, "")
      // Progress spinners rewrite lines with bare CR; in a file each rewrite
      // becomes its own line so the final state is still readable.
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(RESIDUAL_CONTROL_RE, "")
  );
}

// ── Where the log lives ─────────────────────────────────────────────────────

// A repo's short name for files and its server terminal: its folder name in
// [a-z0-9-] (at most 22 chars) plus 6 hex of sha1(root), so two repos with
// one folder name never share a log. At most 29 chars, so `sl-<slug>` fits
// hc's names (1-32 of a-z 0-9 - _).
export function repoSlug(root) {
  const path = String(root).replace(/\/+$/, "") || "/";
  const base =
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 22)
      .replace(/-+$/, "") || "repo";
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

// ~/.local/state/herdr-spotlight/logs (D11).
export function logDir(home = homedir()) {
  return join(home, ".local", "state", "herdr-spotlight", "logs");
}

// The log file of a repo's server: <logDir>/<repo slug>.log.
export function logPathFor(root, { home } = {}) {
  return join(logDir(home ?? homedir()), `${repoSlug(root)}.log`);
}

// ── Header lines ────────────────────────────────────────────────────────────

const two = (n) => String(n).padStart(2, "0");

// Local wall-clock time, HH:MM:SS.
export function formatClock(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// One line, whatever it's given: control bytes become spaces.
// eslint-disable-next-line no-control-regex
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

// The CLI's marker line in the log, like Orca's holder-switch headers:
// "── Spotlight: login (feat/login) · 22:58:04 ──", with the event (started,
// restarted, stopped, a start left alone) before the time when there is one.
export function headerLine({ workspace, branch, event, at } = {}) {
  const label = workspace ? oneLine(branch ? `${workspace} (${branch})` : workspace) : null;
  const parts = [label, event ? oneLine(event) : null, formatClock(at ?? Date.now())].filter(Boolean);
  return `── Spotlight: ${parts.join(" · ")} ──`;
}

// Appends a header on its own line (the server's last line may not have
// ended), creating the log folder. `script -a` and this both append
// (O_APPEND), so neither overwrites the other. Best-effort, like Orca's
// appendSpotlightLogNote: false when it couldn't write, never throws.
export function appendLogHeader(logPath, fields) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `\n${headerLine(fields)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ── Rotation ────────────────────────────────────────────────────────────────

function readRange(fd, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

// Past `max` bytes, cut the log down to its last `keep` bytes, in place (D11:
// at each start and on reap). The kept part starts at a whole line (a window
// that is one unbroken line is kept whole) after TRIM_MARKER.
//
// In place because `script -a` keeps the file open with O_APPEND: after the
// cut its next write lands at the new end, no gap. The cut itself goes
// through an O_APPEND handle too, so a line the server writes between the
// truncate and the rewrite comes before the kept tail rather than being
// overwritten; bytes written after the tail was read are re-read just before
// the truncate. Returns true when it cut; false when the log is missing,
// small enough, or couldn't be cut (the log then just stays bigger).
export function rotateLog(logPath, { max = MAX_LOG_BYTES, keep = KEEP_LOG_BYTES } = {}) {
  let reader;
  try {
    reader = openSync(logPath, "r");
  } catch {
    return false;
  }
  let writer;
  try {
    const st = fstatSync(reader);
    if (!st.isFile() || st.size <= max) return false;
    const start = Math.max(0, st.size - keep);
    // One byte before the window says whether it starts at a line.
    const before = start > 0 ? readRange(reader, start - 1, start) : Buffer.from("\n");
    let tail = readRange(reader, start, st.size);
    if (before[0] !== 0x0a) {
      const nl = tail.indexOf(0x0a);
      if (nl !== -1 && nl < tail.length - 1) tail = tail.subarray(nl + 1);
    }
    writer = openSync(logPath, "a");
    const now = fstatSync(writer).size;
    if (now > st.size) tail = Buffer.concat([tail, readRange(reader, st.size, now)]);
    ftruncateSync(writer, 0);
    const body = Buffer.concat([Buffer.from(`${TRIM_MARKER}\n`), tail]);
    let written = 0;
    while (written < body.length) written += writeSync(writer, body, written, body.length - written);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(reader);
    if (writer !== undefined) closeSync(writer);
  }
}

// ── Tail ────────────────────────────────────────────────────────────────────

const TAIL_CHUNK = 64 * 1024;

// The log's last `lines` lines as plain text (stripTerminalSequences, so a
// bare-CR progress bar reads as one line per redraw, as Orca's mirror wrote
// it), each ending in "\n"; "" for an empty log, null when there's no log
// file. Reads backwards in growing chunks, never the whole file for a short
// tail; a chunk that starts mid-line drops that partial line.
export function tailLog(logPath, { lines = DEFAULT_TAIL_LINES } = {}) {
  const want = Number.isInteger(lines) && lines > 0 ? lines : DEFAULT_TAIL_LINES;
  let fd;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    let start = st.size;
    let chunk = TAIL_CHUNK;
    let raw = Buffer.alloc(0);
    let all = [];
    for (;;) {
      const from = Math.max(0, start - chunk);
      raw = Buffer.concat([readRange(fd, from, start), raw]);
      start = from;
      let text = raw;
      if (start > 0) {
        const nl = raw.indexOf(0x0a);
        text = nl === -1 ? Buffer.alloc(0) : raw.subarray(nl + 1);
      }
      all = stripTerminalSequences(text.toString("utf8")).split("\n");
      if (all.at(-1) === "") all.pop();
      if (start === 0 || all.length >= want) break;
      chunk *= 2;
    }
    const last = all.slice(-want);
    return last.length > 0 ? `${last.join("\n")}\n` : "";
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
