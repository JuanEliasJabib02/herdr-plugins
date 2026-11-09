// The env per task (D32, S21; Orca's TaskSpotlightEnvPill,
// ui-slice-spotlight-env-actions.ts): which env a repo's server runs, read
// the same way by the CLI (cli-work.mjs effectiveEnv), the badges (the lane's
// env pill, badges-model.js) and the server popup (server-view-model.js).
// Pure, and imports only the plugin's pure modules, so the mod and the CLI
// share it, as they share server-errors.js.
//
// Every env pick is stored in state.json's `envs` under its key (store.js
// rememberEnv, which keeps the newest ENVS_MAX), surviving the turn-off:
//   <groupId>/<KEY>   a task's workspace: its task in its space, the key
//                     state.variants uses (cli-env.mjs taskKeyOfWorkspace),
//                     so one pick sets the env of the whole task there
//   ws:<path>         a workspace with no task (Orca's toSpotlightEnvKey)
// A lit repo's record keeps its holder's key, `envKey`, written by the light
// (cli-work.mjs lightMember), so the env in force needs no git:
// envs[record.envKey], else the repo's settings env. A record lit before T22
// has no envKey: it reads the popup's old envOverride until it turns off, so
// installing T22 restarts no server.

import { ENVS, normRoot } from "./settings.js";
import { taskOf, laneOf } from "./task.js";

// The env a repo runs with nothing picked: settings.js's default.
export const DEFAULT_ENV = ENVS[0];

// The env names as the popups and the pill show them.
export const ENV_LABELS = Object.freeze({ local: "Local", dev: "Dev", prod: "Prod" });

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export const isEnv = (value) => ENVS.includes(value);

// A workspace's key when it has no task.
export const wsEnvKey = (workspace) => `ws:${normRoot(workspace)}`;

// A workspace's key: its task's (`<lane>/<KEY>`, taskKeyOfWorkspace's or a
// lighting marker's), else ws:<path>.
export const envKeyOf = (taskKey, workspace) => taskKey ?? wsEnvKey(workspace);

// The env stored under `key` in state.json's `envs`, or null.
export function storedEnv(envs, key) {
  if (!isObject(envs) || typeof key !== "string" || !Object.hasOwn(envs, key)) return null;
  return isEnv(envs[key]) ? envs[key] : null;
}

// The env a lit repo's server should run (`record`: its state.json record;
// `envs`: state.json's; `fallback`: the repo's settings env): the pick
// stored for its holder's key, else the fallback. A record with no envKey
// (lit before T22) reads its envOverride instead, until it turns off.
export function recordEnv(record, envs, fallback) {
  if (typeof record?.envKey === "string" && record.envKey !== "") return storedEnv(envs, record.envKey) ?? fallback;
  return isEnv(record?.envOverride) ? record.envOverride : fallback;
}

// The key of a workspace the CLI isn't asked about (the server popup of a
// root nobody holds): taskKeyOfWorkspace's rule over projects-sidebar's
// lists. `registry`: shared projects.v1; `cache`: projects.cache.v1 as
// badges-model.js parseCache reads it. Null when the cache doesn't list it.
export function checkoutEnvKey({ registry, cache, root, workspace }) {
  const at = normRoot(workspace);
  const checkout = (isObject(cache) && Array.isArray(cache[normRoot(root)]) ? cache[normRoot(root)] : []).find((c) => c?.path === at);
  if (!checkout) return null;
  const task = taskOf({ path: at, branch: checkout.branch ?? null, main: Boolean(checkout.main) });
  return task ? `${laneOf(registry, normRoot(root))}/${task.key}` : wsEnvKey(at);
}
