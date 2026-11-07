// Blame (plan D12, S7): who last changed each line, from `git blame --porcelain`,
// drawn as a column in the read-only line view of D16. It doesn't follow a cursor,
// because Herdr's editor doesn't say where the cursor is. No herdr or gpui-kit
// imports.

export const BLAME_TEXT = Object.freeze({
  button: "Blame",
  uncommitted: "sin commit",
  running: "Blame…",
  failed: "Blame no disponible",
});

const MOD = "code-file";
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

// The button's command (D2), with or without the mod's prefix. document-model's
// commandFor knows the reducer's commands, and the reducer never sees this one.
export const isBlameCommand = (raw) => raw === "blame" || raw === `${MOD}.blame`;

// Beside drafts/, not in it: that folder's names are read back as drafts.
export const blameDir = (appHome) => `${trimSlash(String(appHome))}/code-editor/blame`;

// Always --contents, even for a clean file: the column then describes the text on
// screen, whatever the disk holds by now, and unsaved lines come out with no commit.
export const blameArgs = (name, contentsPath) => ["blame", "--porcelain", "--contents", contentsPath, "--", name];

// The resolved path, not the one the tab was opened with: by a symlink's own name
// git compares the text with the link's target and finds no line in any commit.
export function blameTarget(path) {
  const cut = path.lastIndexOf("/");
  return { cwd: cut > 0 ? path.slice(0, cut) : "/", name: path.slice(cut + 1) };
}

// ── Reading porcelain ────────────────────────────────────────────────────────

const HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/;
const ZERO_SHA = /^0+$/;

// One entry per line of the file, by index: { sha, author, time, tz }. A commit's
// fields come only the first time it shows, and every line's text starts with a
// tab, so nothing a file says can pass for a field. A line counts when its text
// arrives: exec's limit is 8 MiB of output, and a header cut short has a number that
// could be any, so what comes back can be short but is never wrong.
export function parseBlame(stdout) {
  const commits = new Map();
  const lines = [];
  let sha = null;
  let index = -1;
  for (const raw of String(stdout).split("\n")) {
    if (raw.startsWith("\t")) {
      if (sha !== null) lines[index] = commits.get(sha);
      sha = null;
      continue;
    }
    const header = HEADER.exec(raw);
    if (header) {
      sha = header[1];
      index = Number(header[2]) - 1;
      if (!commits.has(sha)) commits.set(sha, { sha, author: "", time: Number.NaN, tz: "" });
      continue;
    }
    if (sha === null) continue;
    const commit = commits.get(sha);
    if (raw.startsWith("author ")) commit.author = raw.slice("author ".length);
    else if (raw.startsWith("author-time ")) commit.time = Number(raw.slice("author-time ".length));
    else if (raw.startsWith("author-tz ")) commit.tz = raw.slice("author-tz ".length);
  }
  return lines;
}

// ── What a row shows ─────────────────────────────────────────────────────────

const zoneSeconds = (tz) => {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(String(tz));
  if (!m) return 0;
  const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60;
  return m[1] === "-" ? -seconds : seconds;
};

// The day where the author was, as `git blame` prints it, so it doesn't depend on
// this computer's zone. In a frame, so nothing here throws.
export function blameDate(time, tz) {
  if (!Number.isFinite(time)) return "";
  return new Date((time + zoneSeconds(tz)) * 1000).toISOString().slice(0, 10);
}

// Null: nothing known about this row, which isn't the same as having no commit.
export function blameLabel(entry) {
  if (!entry) return null;
  if (ZERO_SHA.test(entry.sha)) return { author: BLAME_TEXT.uncommitted, date: null };
  return { author: entry.author, date: blameDate(entry.time, entry.tz) };
}

// git's own first line, for the toast.
export function blameFailure({ code, stderr }) {
  const line = String(stderr).split("\n").find((l) => l.trim() !== "");
  return line ? line.replace(/^fatal: /, "") : `git blame: exit ${code}`;
}
