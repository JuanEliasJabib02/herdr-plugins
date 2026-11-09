// Auto-sync's filter (D9). Pure: no herdr, gpui-kit or node imports, so
// `node --test` loads it; autosync.js uses it.
//
// Herdr's watchFolder on macOS watches recursively, ignored folders
// included, so the filter Orca's watcher applies before an event exists
// (WATCHER_IGNORE_DIRS, O/src/main/ipc/filesystem/watchers/
// filesystem-watcher-ignore.ts) runs here on each path: a path with any of
// those folder names in it, at any depth, is noise. On top of Orca's list,
// test output (D9): a test run writes there while the holder's code stays
// the same. What's left must lie inside the holder (Orca's
// shouldRefreshGitStatusForFileChange); a batch holding the watched folder
// itself means "too many changes, refresh everything" (watchFolder's
// overflow), and syncs.

export const IGNORED_DIRS = Object.freeze([
  // Orca's, verbatim.
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "target",
  ".venv",
  "__pycache__",
  // Test output.
  "test-results",
  "playwright-report",
  "blob-report",
  "coverage",
]);

// Orca's: agents and editors write in bursts; one sync per burst is enough,
// since the engine skips a sync whose tree didn't change.
export const SYNC_DEBOUNCE_MS = 300;

const IGNORED = new Set(IGNORED_DIRS);

// One spelling per folder: forward slashes, no trailing slash.
function normPath(p) {
  if (typeof p !== "string" || !p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

// The part of `p` under `dir` ("" for dir itself), or null when it isn't inside.
function relativeTo(p, dir) {
  if (p === dir) return "";
  const prefix = dir === "/" ? "/" : `${dir}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

// Whether a watchFolder batch from the holder's folder should sync its
// repo: the holder itself (overflow), or a path inside it that no ignored
// folder holds.
export function shouldSync(paths, holder) {
  const dir = normPath(holder);
  if (!dir || !Array.isArray(paths)) return false;
  return paths.some((raw) => {
    const rel = relativeTo(normPath(raw), dir);
    if (rel === null) return false;
    if (rel === "") return true;
    return !rel.split("/").some((segment) => IGNORED.has(segment));
  });
}

// The holders to watch, one per lit repo: [{ root, holder }], from a parsed
// state.json (board-model.js readState).
export function watchTargets(state) {
  const repos = state && typeof state.repos === "object" && state.repos !== null ? state.repos : {};
  return Object.entries(repos)
    .filter(([, r]) => typeof r?.holder === "string" && r.holder.startsWith("/"))
    .map(([root, r]) => ({ root, holder: normPath(r.holder) }));
}

// The sync auto-sync runs: detached, so the CLI answers at once (D18), and
// automatic (`--auto`): it doesn't retry an env that couldn't run until
// settings are saved, as a sync someone asked for does (cli-work.mjs
// syncRepo, N4).
export const syncArgv = (bin, root) => [bin, "sync", "--repo", root, "--detach", "--auto"];

// A debounce per key over an injected one-shot timer, `after(ms, fn)` →
// { cancel() } (the mod passes cx.timer.after). Each call cancels the key's
// pending one and schedules `fn` `ms` later, so a burst runs it once.
export function debouncer(after, ms) {
  const pending = new Map();
  return (key, fn) => {
    pending.get(key)?.cancel();
    pending.set(
      key,
      after(ms, (...args) => {
        pending.delete(key);
        fn(...args);
      }),
    );
  };
}
