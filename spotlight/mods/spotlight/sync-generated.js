// Files a framework's dev server rewrites in the checkout it runs in (port of
// Orca's spotlight-generated-files.ts). Why: `next dev` (Next 16) rewrites the
// tracked next-env.d.ts on every start ("This file should not be edited"), and
// `convex dev` regenerates the tracked convex/_generated/* whenever the
// projected functions don't match the committed codegen, so a Spotlight server
// running at the root made the root look diverged and blocked turn-off, sync
// and takeovers. Changes to these never count as root divergence nor as an
// untracked collision; the reset of a sync or a turn-off restores them like any
// tracked file, and the server writes them again.
export const GENERATED_FILE_NAMES = new Set(["next-env.d.ts"]);

/** Folders whose whole content a dev server owns, matched as a `parent/dir/`
 *  pair so an unrelated `_generated/` elsewhere doesn't count. */
export const GENERATED_DIRS = ["convex/_generated/"];

/** `gitPath` (repo-relative, `/`-separated as git prints it) names a known
 *  framework-generated file, at any depth so monorepo apps
 *  (`apps/web/next-env.d.ts`, `packages/backend/convex/_generated/api.d.ts`)
 *  count too. */
export function isGeneratedFile(gitPath) {
  if (GENERATED_FILE_NAMES.has(gitPath.slice(gitPath.lastIndexOf("/") + 1))) return true;
  const path = `/${gitPath}`;
  return GENERATED_DIRS.some((dir) => path.includes(`/${dir}`));
}
