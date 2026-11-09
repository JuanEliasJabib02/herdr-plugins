// Spotlight's items in projects-sidebar's workspace menu (D30, S21; Orca's
// WorktreeSpotlightMenuItems.tsx and WorktreeSpotlightEnvSubMenu.tsx): what
// badges.js publishes under the shared key `menus.spotlight`, beside the
// badges. Pure: it imports only the plugin's other pure modules, so
// `node --test` loads it. The contract it codes against is projects-sidebar's
// RECIPE.md "Menu items from other plugins":
//   value  { [workspace path, as `git worktree list` prints it]: [item] }
//   item   { id, text (≤ 40 code points), icon?, danger?, disabled?, why?,
//            tooltip?, checked?, action?: { exec: [absolute bin, …] },
//            items?: [item] (one submenu level, at most 6) }
//   at most 8 per plugin on a workspace; a value with no paths is null (the
//   key cleared); written only when it changes (badges-model.js nextPublish).
//
// Orca's rules, per workspace row projects-sidebar draws:
//   toggle      "Proyectar este workspace" on a workspace that can hold the
//               root (a worktree, not the main checkout, of a repo with
//               Spotlight on), a takeover when another holds it; "Apagar
//               Spotlight" on the holder, and on the root's own row while
//               Spotlight is on there, whatever its setting (Orca's
//               spotlightOffOnMain: the root is what Spotlight rewrites),
//               refs nobody holds included (orphan-refs: the turn-off
//               restores from them). `spotlight toggle --workspace <path>`,
//               as the row's flashlight.
//   force-sync  "Forzar sync" on the holder of a root-diverged root (Orca's
//               "Force Sync Spotlight (overwrite root changes)",
//               destructive): danger, the server popup's `spotlight sync
//               --repo <root> --force --detach`.
//   env         "Entorno de Spotlight ▸ Local / Dev / Prod" on a workspace
//               that can hold the root, its env checked (D32, the value the
//               server popup and the lane's pill read: the holder's, the env
//               its server runs, task-env.js recordEnv; any other's, the
//               pick stored for its key, else the repo's settings env). A
//               pick runs `spotlight env --workspace <path> --env <e>`,
//               which stores it for the workspace's task (or ws:<path>) and
//               restarts only its own holder. No key (a workspace
//               projects-sidebar's lists don't name): no submenu, as Orca's.
// While the repo is busy (D33: a light, a turn-off, a Forzar sync, a
// restart) the toggles and Forzar sync are disabled, "Sincronizando…"; the
// env submenu stays, as Orca disables only those two while it syncs.

import { normRoot, repoSettings, ENVS } from "./settings.js";
import { ENV_LABELS, recordEnv, storedEnv, checkoutEnvKey } from "./task-env.js";
import { iconPath } from "./badges-model.js";

const BUSY_WHY = "Sincronizando…";
// Orca's label says it: "(overwrite root changes)".
const FORCE_TOOLTIP = "Sobrescribe los cambios del root con los de este workspace.";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbsolute = (p) => typeof p === "string" && p.startsWith("/");

function item({ id, text, icon, danger, busy, tooltip, checked, action, items }) {
  const it = { id, text };
  if (icon) it.icon = iconPath(icon);
  if (danger) it.danger = true;
  if (busy) {
    it.disabled = true;
    it.why = BUSY_WHY;
  }
  if (tooltip) it.tooltip = tooltip;
  if (checked) it.checked = true;
  if (action) it.action = action;
  if (items) it.items = items;
  return it;
}

const toggleItem = (bin, at, off, busy) => item({
  id: "toggle", text: off ? "Apagar Spotlight" : "Proyectar este workspace", icon: "flashlight", busy,
  action: { exec: [bin, "toggle", "--workspace", at] },
});

const forceItem = (bin, root, busy) => item({
  id: "force-sync", text: "Forzar sync", icon: "flashlight", danger: true, busy, tooltip: FORCE_TOOLTIP,
  action: { exec: [bin, "sync", "--repo", root, "--force", "--detach"] },
});

// The env a workspace's server runs, or would at its light (D32): the
// holder's, what its record's key holds (recordEnv: a record lit before T22
// reads its envOverride); another's, the pick stored for its key; else the
// repo's settings env.
function workspaceEnv({ state, record, holder, workspace, key, fallback }) {
  if (workspace === holder) return recordEnv(record, state?.envs, fallback);
  return storedEnv(state?.envs, key) ?? fallback;
}

const envMenu = (bin, workspace, env) => item({
  id: "env", text: "Entorno de Spotlight", icon: "server",
  items: ENVS.map((e) => item({
    id: `env-${e}`, text: ENV_LABELS[e], checked: e === env,
    action: { exec: [bin, "env", "--workspace", workspace, "--env", e] },
  })),
});

// Every workspace's items of the moment:
//   state     board-model.js readState(state.json's text)
//   settings  board-model.js readSettings(settings.json's text)
//   projects  badges-model.js parseProjects(shared("projects.v1"))
//   cache     badges-model.js parseCache(shared("projects.cache.v1"))
//   enabled   { [root]: boolean }: whether Spotlight is on for each
//             registered repo (D7, badges.js enabledRoots)
//   registry  shared("projects.v1") as Herdr returns it: a workspace's task
//             lane, for its env key (task-env.js checkoutEnvKey)
//   bin       board-model.js cliPathOf(appHome())
// → { [path]: [item] } with its paths sorted, or null when no row has any.
export function buildMenus({ state, settings, projects = [], cache = {}, enabled = {}, registry = null, bin }) {
  const repos = isObject(state?.repos) ? state.repos : {};
  const rows = new Map();
  for (const { root } of projects) {
    const record = isObject(repos[root]) ? repos[root] : null;
    const holder = isAbsolute(record?.holder) ? normRoot(record.holder) : null;
    const busy = isObject(record?.busy);
    if (holder || record?.lastError?.code === "orphan-refs") rows.set(root, [toggleItem(bin, root, true, busy)]);
    if (enabled[root] !== true) continue;
    const fallback = repoSettings(settings, root).env;
    for (const c of cache[root] ?? []) {
      if (c.main || c.path === root) continue;
      const held = c.path === holder;
      const list = [toggleItem(bin, c.path, held, busy)];
      if (held && record.lastError?.code === "root-diverged") list.push(forceItem(bin, root, busy));
      const key = checkoutEnvKey({ registry, cache, root, workspace: c.path });
      if (key) list.push(envMenu(bin, c.path, workspaceEnv({ state, record, holder, workspace: c.path, key, fallback })));
      rows.set(c.path, list);
    }
  }
  if (rows.size === 0) return null;
  const value = {};
  for (const at of [...rows.keys()].sort()) value[at] = rows.get(at);
  return value;
}
