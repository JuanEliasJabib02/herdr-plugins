// Plain constants: no herdr or gpui-kit imports, so `node --test` can load them.

// This mod's folder name under mods/. Installers rename a mod whose name is
// taken, so overlays and asset paths go through this, never a literal.
export const MOD = "projects";

// Where new workspaces (git worktrees) go: <WORKTREE_ROOT>/<repo>/<name>.
// `~` is the person's home, expanded when used.
export const WORKTREE_ROOT = "~/orca/workspaces";

// Asset path of one of this mod's icons, for svg().
export const icon = (name) => `mods/${MOD}/icons/${name}.svg`;

// Other plugins' indicators on workspace rows ("badges", D38): the shared()
// keys this mod reads, never writes, in the order their badges are drawn.
// Adding a plugin is one line here. Each key is { [workspacePath]: [badge] },
// read by badges-model.js parseBadges; the format is RECIPE.md "Badges from
// other plugins". A fixed list, not an index key: shared state keeps the
// last write, so two plugins adding themselves to one index would race.
export const BADGE_KEYS = Object.freeze(["badges.spotlight", "badges.pr", "badges.hibernate"]);
