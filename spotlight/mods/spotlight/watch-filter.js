// Auto-sync's filter (D9, D44). Pure: no herdr, gpui-kit or node imports, so
// `node --test` loads it; the watcher (`spotlight watch`, watch.mjs) uses it.
//
// The watcher's watch (Node's recursive fs.watch) sees every folder, ignored
// ones included, so the filter Orca's watcher applies before an event exists
// (WATCHER_IGNORE_DIRS, O/src/main/ipc/filesystem/watchers/
// filesystem-watcher-ignore.ts) runs here on each path: a path with any of
// those folder names in it, at any depth, is noise. Then Orca's
// shouldRefreshGitStatusForFileChange: a directory event is dropped, and
// what's left must lie inside the holder; an event for the watched folder
// itself means "too many changes, refresh everything" (an overflow), and
// syncs. Herdr's extra test-output folders went with T37 (L31): Orca's list,
// nothing more; a test run's output in a gitignored folder changes no tree,
// so its sync is the engine's no-op.

export const IGNORED_DIRS = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "target",
  ".venv",
  "__pycache__",
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

// Whether one event of the holder's watch syncs. An event is a path (a
// file's), or { path, isDirectory } where isDirectory is a boolean or a
// function, asked only for a path the folder filter keeps (the watcher
// stats nothing under node_modules).
function eventSyncs(event, dir) {
  const raw = typeof event === "string" ? event : event?.path;
  const rel = relativeTo(normPath(raw), dir);
  if (rel === null) return false;
  if (rel === "") return true;
  if (rel.split("/").some((segment) => IGNORED.has(segment))) return false;
  const isDirectory = typeof event === "object" ? event.isDirectory : false;
  return !(typeof isDirectory === "function" ? isDirectory() : isDirectory === true);
}

// Whether a batch of the holder's watch events should sync its repo: the
// holder itself (overflow), or a file inside it that no ignored folder holds.
export function shouldSync(events, holder) {
  const dir = normPath(holder);
  if (!dir || !Array.isArray(events)) return false;
  return events.some((event) => eventSyncs(event, dir));
}

// The holders to watch, one per lit repo: [{ root, holder }], from a parsed
// state.json.
export function watchTargets(state) {
  const repos = state && typeof state.repos === "object" && state.repos !== null ? state.repos : {};
  return Object.entries(repos)
    .filter(([, r]) => typeof r?.holder === "string" && r.holder.startsWith("/"))
    .map(([root, r]) => ({ root, holder: normPath(r.holder) }));
}

// The CLI args of the sync the watcher spawns detached (D18) after a burst:
// an automatic one (`--auto`), which doesn't retry an env that couldn't run
// until settings are saved, as a sync someone asked for does (cli-work.mjs
// syncRepo, N4).
export const syncArgs = (root) => ["sync", "--repo", root, "--auto"];

// A debounce per key over an injected one-shot timer, `after(ms, fn)` →
// { cancel() } (the watcher passes setTimeout's). Each call cancels the
// key's pending one and schedules `fn` `ms` later, so a burst runs it once.
// `cancelAll()` drops every pending one (the watcher exiting).
export function debouncer(after, ms) {
  const pending = new Map();
  const bounce = (key, fn) => {
    pending.get(key)?.cancel();
    pending.set(
      key,
      after(ms, (...args) => {
        pending.delete(key);
        fn(...args);
      }),
    );
  };
  bounce.cancelAll = () => {
    for (const timer of pending.values()) timer.cancel();
    pending.clear();
  };
  return bounce;
}
