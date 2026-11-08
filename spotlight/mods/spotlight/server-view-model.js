// The server popup's model (D22, P3, P4): what server-view.js draws for one
// repo, and the CLI argv each control runs. Pure, so `node --test` loads it.
//   envs      the env radio: Local / Dev / Prod, only those that start
//             something (T5a's serverEnvsWithCommand over the saved and the
//             detected commands); the effective one selected: the env picked
//             here before (the record's envOverride), else the settings' env;
//             `running` on the env the server still runs when that differs
//   envNote   the selected env couldn't start (the record's envFailed): what
//             runs instead and how to try again; else null
//   variants  the variant chips: the plan's candidates while it asks, else
//             the repo's dev:<v> apps; the running one selected, the
//             inferred one marked (its note, inferredVariantNote)
//   urls      each listening port, the picked one first
//   actions   Ver server, Reiniciar, Apagar; on a server that didn't come up
//             (port-busy, server-exited: D24, D25) the first two read Ver
//             log (the server terminal holds what it printed) and Reintentar
//   force     on root-diverged / untracked-collision only: Forzar sync (the
//             holder's tree over the root), Proyectar igual (a refused
//             takeover or fresh activation, forced), Apagar igual; on
//             port-busy only: Liberar puerto y arrancar (D24: stops the
//             process holding the server's port, then starts the server);
//             never on orca-holds (D27: Orca's Spotlight has the root, and
//             the engine refuses it forced too): only its message, in error
// Changing env or variant runs `spotlight env`, which restarts only a server
// whose command or env changes. The popup's props, D22's shape shared with T8's
// board row and the toasts' action: { view: "server", repo, workspace }
// (board.js openServer opens it).

import { normRoot, repoSettings } from "./settings.js";
import { serverEnvsWithCommand, commandTemplate, isSafeVariant, formatVariant, inferredVariantNote } from "./server-plan.js";
import { pickPort, portUrl } from "./ports.js";

const ENV_LABELS = { local: "Local", dev: "Dev", prod: "Prod" };
// Never orca-holds nor orca-active: forcing can't take a root from Orca (D27).
const FORCE_CODES = new Set(["root-diverged", "untracked-collision"]);
// The server didn't come up: a busy port refused its start (D24), or it died
// starting (D25).
const DOWN_CODES = new Set(["port-busy", "server-exited"]);
// A server that's up (state.json's serverState).
const RUNNING = new Set(["starting", "listening"]);

const baseName = (p) => normRoot(p).split("/").filter(Boolean).pop() ?? p;

// The lighting whose last run failed on `root`: the refused takeover (or
// fresh activation) that Proyectar igual forces. The latest one wins.
function failedLighting(lighting, root) {
  let best = null;
  for (const [key, m] of Object.entries(lighting ?? {})) {
    if (!m || typeof m !== "object" || !m.errors || typeof m.errors !== "object" || !(root in m.errors)) continue;
    const when = m.finishedAt ?? m.startedAt ?? 0;
    if (!best || when > best.when) best = { key, when };
  }
  return best?.key ?? null;
}

// The variant the running server was started with, when its start inferred
// it (the toast note T5a's plan leaves, written with serverStartedAt).
function inferredVariant(state, root, record, variants) {
  if (!record?.serverVariant || !Number.isFinite(record.serverStartedAt)) return null;
  const v = record.serverVariant;
  const text = inferredVariantNote(v);
  const hit = (state.notes ?? []).some((n) => n.repo === root && n.text === text && n.at >= record.serverStartedAt);
  return hit && variants.includes(v) ? v : null;
}

// The popup's model. `state` and `settings`: board-model.js readState and
// readSettings of the files; `repo`: the root; `workspace`: the row it was
// opened from; `detection`: T5a's detectServerScripts(root, io), null while
// it runs; `bin`: board-model.js cliPathOf(appHome()).
export function serverViewModel({ state, settings, repo, workspace, detection, bin }) {
  const root = normRoot(repo);
  const record = state?.repos?.[root] ?? null;
  const repoSet = repoSettings(settings, root);
  const holder = record?.holder ?? null;
  const target = holder ?? normRoot(workspace ?? root);
  const detected = detection?.detected ?? {};

  // J-002: what the server runs next, not only what it runs now (serverEnv).
  const selectedEnv = record?.envOverride ?? repoSet.env;
  const up = RUNNING.has(record?.serverState) && record?.serverEnv && record.serverEnv !== selectedEnv;
  const runningEnv = up ? record.serverEnv : null;
  const envName = (env) => ENV_LABELS[env] ?? env;
  let envNote = null;
  if (record?.envFailed && record.envFailed === selectedEnv && record.serverEnv !== selectedEnv) {
    const still = runningEnv ? `: el server sigue en ${envName(runningEnv)}` : "";
    envNote = `${envName(selectedEnv)} no arrancó${still}. Reiniciar lo intenta otra vez.`;
  }
  const envs = detection
    ? serverEnvsWithCommand({ settings: repoSet, detected }).map((env) => ({
        env,
        label: ENV_LABELS[env] ?? env,
        command: commandTemplate({ settings: repoSet, detected, env }),
        selected: env === selectedEnv,
        running: env === runningEnv,
        argv: [bin, "env", "--workspace", target, "--env", env],
      }))
    : [];

  const asking = record?.serverState === "needs-variant";
  const pool = asking && Array.isArray(record.variantCandidates) ? record.variantCandidates : detection?.variants ?? [];
  const variants = pool.filter(isSafeVariant);
  const inferred = inferredVariant(state, root, record, variants);
  const chips = variants.map((v) => ({
    variant: v,
    label: formatVariant(v),
    selected: !asking && v === record?.serverVariant,
    inferred: v === inferred,
    argv: [bin, "env", "--workspace", target, "--variant", v],
  }));

  const ports = Array.isArray(record?.ports) ? record.ports.filter(Number.isInteger) : [];
  const picked = pickPort(ports, repoSet.port);
  const urls = picked === null ? [] : [picked, ...ports.filter((p) => p !== picked)].map(portUrl);

  const error = record?.lastError ?? null;
  // D25: same controls, named for a server that didn't come up.
  const down = DOWN_CODES.has(error?.code);
  const actions = [];
  if (record?.serverTerminal || holder) actions.push({ id: "peek", label: down ? "Ver log" : "Ver server", argv: [bin, "peek", "--repo", root] });
  if (holder) {
    actions.push({ id: "restart", label: down ? "Reintentar" : "Reiniciar", argv: [bin, "restart", "--repo", root] });
    actions.push({ id: "off", label: "Apagar", argv: [bin, "toggle", "--workspace", holder], danger: true });
  }

  const force = [];
  if (error && FORCE_CODES.has(error.code)) {
    if (holder) force.push({ id: "force-sync", label: "Forzar sync", argv: [bin, "sync", "--repo", root, "--force", "--detach"] });
    const key = failedLighting(state?.queue?.lighting, root);
    // `light` runs inline in the CLI; the view detaches it (D18: exec dies at 30 s).
    if (key) force.push({ id: "project-anyway", label: "Proyectar igual", argv: [bin, "light", "--task", key, "--force"], detach: true });
    if (holder) force.push({ id: "off-anyway", label: "Apagar igual", argv: [bin, "toggle", "--workspace", holder, "--force"], danger: true });
  }
  // D24: the only path that stops a process Spotlight didn't start, a click.
  if (error?.code === "port-busy" && holder) {
    force.push({ id: "free-port", label: "Liberar puerto y arrancar", argv: [bin, "restart", "--repo", root, "--free-port"], danger: true });
  }

  return {
    root,
    name: baseName(root),
    holder,
    holderName: holder ? baseName(holder) : null,
    serverState: record?.serverState ?? null,
    serverCommand: record?.serverCommand ?? null,
    needsVariant: asking,
    error,
    envs,
    envNote,
    variants: chips,
    urls,
    actions,
    force,
  };
}

// ── File access for T5a's detection, from the mod ──────────────────────────

// server-plan.js's `io` over Herdr's readTextFile (null when absent, 1 MiB
// at most) and `fs/promises` readdir with file types (Herdr's fs has no
// stat). A kind is read from the parent's listing, kept for the io's
// lifetime: one listing serves every lockfile check of a repo.
export function modIo({ readTextFile, readdir }) {
  const listings = new Map();
  const list = (dir) => {
    if (!listings.has(dir)) listings.set(dir, Promise.resolve().then(() => readdir(dir, { withFileTypes: true })));
    return listings.get(dir);
  };
  const split = (p) => {
    const n = normRoot(p);
    const i = n.lastIndexOf("/");
    return [n.slice(0, i) || "/", n.slice(i + 1)];
  };
  return {
    async readText(path, maxBytes = Infinity) {
      try {
        const text = await readTextFile(path);
        return typeof text === "string" && text.length <= maxBytes ? text : null;
      } catch {
        return null;
      }
    },
    async kind(path) {
      const [dir, name] = split(path);
      try {
        const entry = (await list(dir)).find((e) => e.name === name);
        if (!entry) return "none";
        return entry.isDirectory() ? "dir" : "file";
      } catch {
        return null;
      }
    },
    async listDirs(path) {
      try {
        return (await list(normRoot(path))).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return null;
      }
    },
  };
}
