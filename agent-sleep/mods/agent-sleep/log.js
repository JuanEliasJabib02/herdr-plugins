// agent-sleep's log file (resume-gaps D2): <Herdr home>/agent-sleep/log.txt.
// Herdr starts mods with stdout and stderr on /dev/null, so a console.log is
// lost; this file is where "why didn't it resume?" gets its answer.
//
// Pure: the line's format, the buffer a pulse's lines wait in, and the one
// shell command that appends them. The Coordinator runs that command through
// its exec once, at the end of a pulse; a failed append never stops it.
//
//   log.txt    one line per event: "YYYY-MM-DD HH:MM:SS <what happened>",
//              local time
//   log.1.txt  the generation before: past LOG_MAX_BYTES, log.txt is moved
//              here (replacing the older one) before the next append

export const LOG_MAX_BYTES = 1024 * 1024;

const pad = (n) => String(n).padStart(2, "0");

// "2026-11-09 07:05:03", local time.
const localTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// One event, one line: a stack's lines are joined with " | ", and control
// characters (a NUL can't travel in an argument) are dropped.
const oneLine = (text) =>
  String(text)
    .replace(/[ \t]*\r?\n[ \t]*/g, " | ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

export function logLine(ms, text) {
  return `${localTime(ms)} ${oneLine(text)}`;
}

// The mod's folder (paths(appHome).dir) → its log files.
export function logPaths(dir) {
  const d = String(dir).replace(/\/+$/, "");
  return { dir: d, file: `${d}/log.txt`, rotated: `${d}/log.1.txt` };
}

// A pulse's lines, timed when they are logged, handed out once.
export class LogBuffer {
  constructor() {
    this.lines = [];
  }

  add(ms, text) {
    this.lines.push(logLine(ms, text));
  }

  // The text to append ("…\n" per line), or null with nothing logged.
  drain() {
    if (this.lines.length === 0) return null;
    const text = this.lines.map((l) => `${l}\n`).join("");
    this.lines = [];
    return text;
  }
}

// $1 the folder, $2 log.txt, $3 log.1.txt, $4 the size past which log.txt is
// rotated, $5 the text. The text is an argument, never part of the script, so
// nothing in it reaches the shell. `wc -c`'s padding is dropped by leaving
// $size unquoted. A failed rotation still appends: only printf's status counts.
const APPEND_SCRIPT = [
  'mkdir -p "$1" || exit 1',
  'if [ -f "$2" ]; then',
  '  size=$(wc -c < "$2")',
  '  if [ -n "$size" ] && [ $size -gt "$4" ]; then mv -f "$2" "$3"; fi',
  "fi",
  'printf "%s" "$5" >> "$2"',
].join("\n");

// The exec that appends `text` (LogBuffer.drain's) to log.txt, rotating it first.
export function appendCommand(paths, text) {
  return {
    cmd: "/bin/sh",
    args: ["-c", APPEND_SCRIPT, "agent-sleep", paths.dir, paths.file, paths.rotated, String(LOG_MAX_BYTES), String(text)],
  };
}
