// badges.spotlight (D2, D17): Spotlight's icons on projects-sidebar's
// workspace rows and Task-mode lane headers (D29, D31), and the badge
// commands they hand out. Only the footer copy
// runs it (main.js): startBadges keeps the value in step with state.json
// (board.js watchState, whose readings also feed auto-sync's holders),
// settings.json and projects-sidebar's lists, and writes it only when it
// changes (setShared re-renders every mod). badges-model.js builds it.
// From the same readings it publishes `menus.spotlight` (D30): Spotlight's
// items in projects-sidebar's workspace menu (Proyectar este workspace /
// Apagar Spotlight, Forzar sync, Entorno de Spotlight ▸), built by
// menus-model.js and written the same way, only when it changes. Every item
// runs the CLI (an exec), so no command reaches this copy from the menu.
//
// `spotlight.server.<id>` (the server badge, and the CLI's error toasts)
// reaches this copy's nextCommand() as "server.<id>" (probed 2026-11-06,
// RECIPE.md): handleCommand maps the id to its workspace and opens the
// server popup at the pointer, still on the badge. With no shown footer copy
// Herdr refuses the command, so the click does nothing until the footer is
// in the layout (D20). `spotlight.env.<id>` (a task lane's env pill, D32)
// reaches it the same way, as "env.<id>": the id maps to its lane, and the
// env popup (env-view.js) opens there.

import { shared, setShared, appHome, home, readTextFile, notify } from "herdr";
import * as fs from "fs/promises";
import { repoSettings, repoEnabledFrom, normRoot } from "./settings.js";
import { hasServerCommand } from "./server-plan.js";
import { cliPathOf } from "./board-model.js";
import { readFiles, watchState, openServer } from "./board.js";
import { buildBadges, nextPublish, parseProjects, parseCache, attempt, taskModeGroups } from "./badges-model.js";
import { buildMenus } from "./menus-model.js";
import { openEnvPopup } from "./env-view.js";
import { modIo } from "./server-view-model.js";
import { followHolders } from "./autosync.js";

const KEY = "badges.spotlight";
export const MENU_KEY = "menus.spotlight";
// projects-sidebar's lists and settings.json have no watch here: looked at this often.
const REFRESH_MS = 15_000;
// How long a repo's "has a server command" fact (its package.json) is kept.
const FACTS_TTL_MS = 60_000;

// The last readings, and the server popup's and the env popup's id maps of
// the last build.
let files = null;
let servers = {};
let lanes = {};
// root → { at, envs, gitRepo, hasCommand }: D7's facts for a repo with no
// `enabled` value.
const facts = new Map();

export function startBadges(cx) {
  watchState(cx, {
    alive: () => true,
    read: (next) => {
      files = next;
      followHolders(next.state);
      cx.spawn(async () => refresh());
    },
  });
  cx.timer.every(REFRESH_MS, (cx) => {
    cx.spawn(async () => {
      files = await readFiles();
      followHolders(files.state);
      await refresh();
    });
  });
}

// Whether Spotlight is on for each registered repo (D7, settings.js
// repoEnabledFrom): never ~/.claude; else its `enabled` setting; unset, on
// when it is a git repo with a server command (T5a, read from its root).
async function enabledRoots(projects, settings) {
  const harness = normRoot(`${home()}/.claude`);
  const io = modIo({ readTextFile, readdir: fs.readdir });
  const now = Date.now();
  const out = {};
  for (const { root } of projects) {
    const repo = repoSettings(settings, root);
    if (root === harness || typeof repo.enabled === "boolean") {
      out[root] = repoEnabledFrom(repo, { harness: root === harness });
      continue;
    }
    const envs = JSON.stringify(repo.envs);
    let f = facts.get(root);
    if (!f || now - f.at > FACTS_TTL_MS || f.envs !== envs) {
      const gitRepo = await attempt(() => fs.exists(`${root}/.git`), false);
      const hasCommand = gitRepo ? Boolean(await attempt(() => hasServerCommand(root, io, repo), false)) : false;
      f = { at: now, envs, gitRepo, hasCommand };
      facts.set(root, f);
    }
    out[root] = repoEnabledFrom(repo, { harness: false, registered: true, gitRepo: f.gitRepo, hasServerCommand: f.hasCommand });
  }
  return out;
}

// Builds the badges and the workspace menu items from the last readings and
// publishes each if it changed. The task lanes of every group organized by
// Task get theirs too (D29, D31), whichever group projects-sidebar shows: a
// lane name can repeat across groups.
async function refresh() {
  if (!files) return;
  const { state, settings } = files;
  const registry = shared("projects.v1");
  const projects = parseProjects(registry);
  const cache = parseCache(shared("projects.cache.v1"));
  const enabled = await enabledRoots(projects, settings);
  const bin = cliPathOf(appHome());
  const built = buildBadges({ state, settings, projects, cache, enabled, bin, taskGroups: taskModeGroups(registry) });
  servers = built.servers;
  lanes = built.lanes;
  const out = nextPublish(shared(KEY), built.value);
  if (out.write) setShared(KEY, out.value);
  const menus = nextPublish(shared(MENU_KEY), buildMenus({ state, settings, projects, cache, enabled, registry, bin }));
  if (menus.write) setShared(MENU_KEY, menus.value);
}

/** Runs a command meant for Spotlight; false when the name isn't one. */
export async function handleCommand(name, { cx }) {
  const lane = /^env\.([0-9a-f]{12})$/.exec(String(name));
  if (lane) return openLaneEnv(lane[1]);
  const m = /^server\.([0-9a-f]{12})$/.exec(String(name));
  if (!m) return false;
  let target = servers[m[1]];
  if (!target) {
    // A toast older than the last build, or a workspace new since: read again once.
    files = await readFiles();
    await refresh();
    target = servers[m[1]];
  }
  if (!target) {
    notify({ title: "Spotlight", body: "Ese workspace ya no está en Spotlight.", level: "warning", timeout: 4000 });
    return true;
  }
  openServer({ view: "server", repo: target.root, workspace: target.workspace });
  return true;
}

// A lane's env pill (D32): the env popup for the lane its id names.
async function openLaneEnv(id) {
  let lane = lanes[id];
  if (!lane) {
    // A lane new since the last build: read again once.
    files = await readFiles();
    await refresh();
    lane = lanes[id];
  }
  if (!lane) {
    notify({ title: "Spotlight", body: "Esa tarea ya no tiene Spotlight.", level: "warning", timeout: 4000 });
    return true;
  }
  openEnvPopup({ view: "env", group: lane.group, task: lane.task, members: lane.members });
  return true;
}
