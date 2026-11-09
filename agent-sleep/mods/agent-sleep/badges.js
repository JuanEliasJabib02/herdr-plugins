// The moon in projects-sidebar (plan D1, D11): the value agent-sleep
// publishes under its reserved key, per projects-sidebar's contract
// (RECIPE.md "Badges from other plugins"): { [workspacePath]: [badge] }, the
// path spelled as `git worktree list` prints it, the icon an svg under the
// mod's own folder. Pure: the mod passes the records, its folder name and
// publishes only when sameValue() says the value changed, because setShared
// re-renders every mod. A bare moon with the time in the tooltip, never a
// per-minute text. No action: showing the tab is what wakes a Claude. None on
// a workspace put to sleep as a whole (workspace-sleep D3): its row has
// projects-sidebar's own moon.

export const BADGE_KEY = "badges.hibernate";

const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const trimSlash = (p) => (typeof p === "string" ? p.replace(/\/+$/, "") || (p ? "/" : "") : "");

// mods/<folder>/icons/moon.svg, or null for a folder name that isn't one plain segment.
export function iconPath(modFolder) {
  if (typeof modFolder !== "string" || !modFolder || modFolder === "." || modFolder === "..") return null;
  if (/[/\\]/.test(modFolder)) return null;
  return `mods/${modFolder}/icons/moon.svg`;
}

// The folders of `git worktree list --porcelain`, as git prints them.
export function parseWorktreeList(text) {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

// The worktree a folder is in: the longest worktree path that is the folder
// itself or one of its parents; null when it is in none.
export function workspaceOf(cwd, worktrees) {
  const folder = trimSlash(cwd);
  if (!folder) return null;
  let best = null;
  for (const tree of worktrees ?? []) {
    const root = trimSlash(tree);
    if (!root) continue;
    const inside = folder === root || folder.startsWith(root === "/" ? "/" : `${root}/`);
    if (inside && (best === null || root.length > best.length)) best = tree.replace(/\/+$/, "") || "/";
  }
  return best;
}

function tooltip(count, since) {
  return count === 1
    ? `Claude asleep since ${since} · wakes when you show its tab`
    : `${count} Claudes asleep since ${since} · wake when you show their tabs`;
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

// One badge per workspace with at least one "asleep" record; {} when none,
// which clears projects-sidebar's moons. Keys sorted, so equal records give
// an equal value. `formatTime` is injectable for tests in other time zones.
// `slept`: { paths, terminals } of the workspaces put to sleep as a whole
// (workspace-sleep D3, D9), their paths and the terminals in their spaces.
// projects-sidebar draws its own moon on those rows, so a record whose
// terminal is in one of their spaces, or whose workspace is one, gets none
// from here: the moon after the label is only for a Claude asleep in a
// workspace that is awake.
export function badgeValue({ records, modFolder, formatTime = clock, slept = null }) {
  const sleptPaths = new Set([...toSet(slept?.paths)].map(trimSlash));
  const sleptTerminals = toSet(slept?.terminals);
  const groups = new Map();
  for (const [address, r] of Object.entries(records ?? {})) {
    if (!r || r.state !== "asleep" || sleptTerminals.has(address)) continue;
    const path = trimSlash(r.workspacePath) || trimSlash(r.cwd);
    if (!path || sleptPaths.has(path)) continue;
    const g = groups.get(path) ?? { count: 0, since: Infinity };
    g.count += 1;
    g.since = Math.min(g.since, r.at);
    groups.set(path, g);
  }
  const icon = iconPath(modFolder);
  const value = {};
  for (const path of [...groups.keys()].sort()) {
    const { count, since } = groups.get(path);
    value[path] = [{
      ...(icon ? { icon } : { text: "asleep" }),
      tone: "dim",
      tooltip: tooltip(count, formatTime(since)),
    }];
  }
  return value;
}

// Values are built with sorted keys and fixed field order, so text equality
// is value equality.
export function sameValue(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
