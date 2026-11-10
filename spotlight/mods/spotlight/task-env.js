// The env per task (D32, D46, S21, S25; Orca's TaskSpotlightEnvPill,
// spotlight-env-key.ts, ui-slice-spotlight-env-actions.ts): which env a
// repo's server runs, read the same way by the CLI (cli-work.mjs
// effectiveEnv), the badges (the lane's env pill, badges-model.js) and the
// server popup (server-view-model.js). Pure, and imports only the plugin's
// pure modules, so the mod and the CLI share it, as they share
// server-errors.js.
//
// Every env pick is stored in state.json's `envs` under its key (store.js
// rememberEnv, which keeps the newest ENVS_MAX), surviving the turn-off:
//   task:<KEY>        a task's workspace, in any space (D46, as Orca's
//                     toSpotlightEnvKey: one pick sets the env of the whole
//                     task, in every space); never integer-like (a task
//                     named 2024 would sort first in the map and break the
//                     order the cap drops by) and never a ws: key
//   ws:<path>         a workspace with no task (Orca's toSpotlightEnvKey)
// Before D46 a task's key was its space's, `<groupId>/<KEY>`: those entries
// are still read, from any space, the later position in the map winning
// (entryKeys, storedEnv), until the task's next pick replaces them
// (cli-work.mjs writeEnv). A task's remembered variant is keyed the same way,
// `task:<KEY>::<root>` (server-plan.js variantKey), its old entries read the
// same way.
// A lit repo's record keeps its holder's key, `envKey`, written by the light
// (cli-work.mjs lightMember), so the env in force needs no git: the pick
// stored for record.envKey (one keyed before D46 too), else the repo's
// settings env. A record lit before T22 has no envKey: it reads the popup's
// old envOverride until it turns off, so installing T22 restarts no server.

import { ENVS, normRoot } from "./settings.js";
import { taskOf } from "./task.js";

// The env a repo runs with nothing picked: settings.js's default.
export const DEFAULT_ENV = ENVS[0];

// The env names as the popups and the pill show them.
export const ENV_LABELS = Object.freeze({ local: "Local", dev: "Dev", prod: "Prod" });

const TASK_PREFIX = "task:";
const WS_PREFIX = "ws:";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export const isEnv = (value) => ENVS.includes(value);

// A workspace's key when it has no task.
export const wsEnvKey = (workspace) => `${WS_PREFIX}${normRoot(workspace)}`;

// D46: a task's key, the same in every space, `task:<KEY>`: from
// `<lane>/<KEY>` (taskKeyOfWorkspace's, a lighting marker's: the KEY after
// its last `/`, as taskOf's keys hold none), from `task:<KEY>` itself, or
// from a lane's bare KEY. Null when it names no task.
export function taskEnvKey(taskKey) {
  if (typeof taskKey !== "string") return null;
  if (taskKey.startsWith(TASK_PREFIX)) return taskKey.length > TASK_PREFIX.length ? taskKey : null;
  const key = taskKey.slice(taskKey.lastIndexOf("/") + 1);
  return key === "" ? null : `${TASK_PREFIX}${key}`;
}

// A workspace's key: its task's (taskEnvKey of `<lane>/<KEY>`,
// taskKeyOfWorkspace's or a lighting marker's), else ws:<path>.
export const envKeyOf = (taskKey, workspace) => taskEnvKey(taskKey) ?? wsEnvKey(workspace);

// Any key, stored or asked for, in D46's form: a ws:<path> as it is, a
// task's as taskEnvKey makes it (an old `<groupId>/<KEY>` is task:<KEY>);
// null for none.
export function normEnvKey(key) {
  if (typeof key !== "string" || key === "") return null;
  return key.startsWith(WS_PREFIX) ? key : taskEnvKey(key);
}

// Whether two keys name one entry (a record's envKey written before D46 and
// a pick's task:<KEY>, D46).
export function sameEnvKey(a, b) {
  const form = normEnvKey(a);
  return form !== null && form === normEnvKey(b);
}

// The task key an entry stored before D46 names (`<groupId>/<KEY>` →
// task:<KEY>), or null for any other key: a ws:<path> (a worktree folder
// named after a task is no task's entry), a task:<KEY>, one with nothing
// before or after its last `/`.
function oldTaskKey(key) {
  if (key.startsWith(WS_PREFIX) || key.startsWith(TASK_PREFIX)) return null;
  const at = key.lastIndexOf("/");
  return at > 0 && at < key.length - 1 ? `${TASK_PREFIX}${key.slice(at + 1)}` : null;
}

// The own keys of `map` that hold `key`'s entry, in the map's order (D46):
// the key in its D46 form (normEnvKey) and, for a task, its old
// `<groupId>/<KEY>` of every space. `suffix` ends each of them (a variant's
// `::<root>`, server-plan.js rememberedVariant).
export function entryKeys(map, key, suffix = "") {
  const want = normEnvKey(key);
  if (!isObject(map) || want === null) return [];
  return Object.keys(map).filter((k) => {
    if (!k.endsWith(suffix)) return false;
    const head = k.slice(0, k.length - suffix.length);
    return head === want || (want.startsWith(TASK_PREFIX) && oldTaskKey(head) === want);
  });
}

// The env stored for `key` in state.json's `envs`, or null: the last of its
// entries (entryKeys: a task's task:<KEY> and its old `<groupId>/<KEY>` of
// any space; rememberEnv moves a pick to the end) that holds an env.
export function storedEnv(envs, key) {
  let env = null;
  for (const k of entryKeys(envs, key)) if (isEnv(envs[k])) env = envs[k];
  return env;
}

// The env a lit repo's server should run (`record`: its state.json record;
// `envs`: state.json's; `fallback`: the repo's settings env): the pick
// stored for its holder's key (storedEnv: a key written before D46 reads its
// task's entries too), else the fallback. A record with no envKey (lit
// before T22) reads its envOverride instead, until it turns off.
export function recordEnv(record, envs, fallback) {
  if (typeof record?.envKey === "string" && record.envKey !== "") return storedEnv(envs, record.envKey) ?? fallback;
  return isEnv(record?.envOverride) ? record.envOverride : fallback;
}

// The key of a workspace the CLI isn't asked about (the server popup of a
// root nobody holds, the workspace menu): taskOf's rule over
// projects-sidebar's worktree list, task:<KEY> in any space (D46: no lane,
// so projects.v1 isn't read), else ws:<path>. `cache`: projects.cache.v1 as
// badges-model.js parseCache reads it. Null when the cache doesn't list it.
export function checkoutEnvKey({ cache, root, workspace }) {
  const at = normRoot(workspace);
  const checkout = (isObject(cache) && Array.isArray(cache[normRoot(root)]) ? cache[normRoot(root)] : []).find((c) => c?.path === at);
  if (!checkout) return null;
  const task = taskOf({ path: at, branch: checkout.branch ?? null, main: Boolean(checkout.main) });
  return task ? taskEnvKey(task.key) : wsEnvKey(at);
}
