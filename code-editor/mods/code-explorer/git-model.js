// Git marks in the Explorer, as Orca computes them (right-sidebar/status-display.ts):
// the letter each file gets, the status a folder shows, and what's ignored. Pure:
// main.js runs git with these arguments and hands the output here.

// Reading writes nothing under .git (no index lock, no fsmonitor cookie), or the
// folder watch would wake itself (Herdr's files panel does the same).
const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
export const STATUS_ARGS = [...READ_ONLY, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
// D7. --directory stops at an ignored folder rather than listing all it holds.
export const IGNORED_ARGS = [...READ_ONLY, "ls-files", "-z", "-oi", "--exclude-standard", "--directory"];
export const ROOT_ARGS = ["rev-parse", "--show-toplevel", "--git-common-dir"];

// D5: Orca's colors for these letters, a conscious exception to theme().
export const GIT_COLORS = { M: "#e2c08d", A: "#81b88b", D: "#c74e39", R: "#73c991", U: "#73c991", C: "#73c991" };

const PRIORITY = { D: 5, M: 4, A: 3, U: 3, R: 2, C: 1 };
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// U is untracked, as in Orca. Porcelain's own U means a merge conflict, which
// Orca's letters don't have: it shows as modified.
export function statusLetter(xy) {
  if (xy === "??") return "U";
  if (UNMERGED.has(xy)) return "M";
  for (const letter of ["D", "A", "R", "C"]) if (xy.includes(letter)) return letter;
  return "M";
}

// The first of a tie stays, as in Orca's getDominantStatus.
export function dominantStatus(letters) {
  let best = null;
  for (const letter of letters) if (best === null || PRIORITY[letter] > PRIORITY[best]) best = letter;
  return best;
}

const withoutSlash = (path) => (path.endsWith("/") ? path.slice(0, -1) : path);

// Porcelain -z: `XY path` entries, each ended by a NUL, paths from the repo's top.
// What follows the last NUL is an entry exec's output limit cut short.
export function parseStatus(stdout) {
  const marks = new Map();
  for (const entry of stdout.split("\0").slice(0, -1)) {
    const path = withoutSlash(entry.slice(3)), letter = statusLetter(entry.slice(0, 2));
    marks.set(path, marks.has(path) ? dominantStatus([marks.get(path), letter]) : letter);
  }
  return marks;
}

// Each folder's dominant status over everything below it. A deleted file reaches
// no folder (Orca's shouldPropagateStatus).
export function buildFolderStatus(marks) {
  const folders = new Map();
  for (const [path, letter] of marks) {
    if (letter === "D") continue;
    for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
      const folder = path.slice(0, cut);
      folders.set(folder, folders.has(folder) ? dominantStatus([folders.get(folder), letter]) : letter);
    }
  }
  return folders;
}

export function parseIgnored(stdout) {
  return new Set(stdout.split("\0").filter(Boolean).map(withoutSlash));
}

// Ignored if it or any folder above it is listed.
export function isIgnored(ignored, path) {
  if (ignored.size === 0) return false;
  for (let at = path; ; at = at.slice(0, at.lastIndexOf("/"))) {
    if (ignored.has(at)) return true;
    if (!at.includes("/")) return false;
  }
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// ROOT_ARGS's output: the repo's top and the name the header shows. A worktree's
// common dir is the absolute `<main checkout>/.git`, so the name is the repo's and
// not the worktree's folder; a bare repo's is `<name>.git`. From a main checkout
// it's relative, and a submodule's lives under `modules/`: the folder's name.
export function parseRepo(stdout) {
  const [top, common] = stdout.split("\n");
  if (!top) return null;
  let name = baseName(top);
  if (common?.startsWith("/") && !common.includes("/modules/")) {
    if (common.endsWith("/.git")) name = baseName(common.slice(0, -"/.git".length));
    else if (common.endsWith(".git")) name = baseName(common).slice(0, -".git".length);
  }
  return { top, name };
}
