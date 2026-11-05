// Plain constants: no herdr or gpui-kit imports, so `node --test` can load them.

// This mod's folder name under mods/. Installers rename a mod whose name is
// taken, so overlays and asset paths go through this, never a literal.
export const MOD = "projects";

// Where new workspaces (git worktrees) go: <WORKTREE_ROOT>/<repo>/<name>.
// `~` is the person's home, expanded when used.
export const WORKTREE_ROOT = "~/orca/workspaces";

// Asset path of one of this mod's icons, for svg().
export const icon = (name) => `mods/${MOD}/icons/${name}.svg`;
