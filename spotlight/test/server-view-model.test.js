// T10: the server popup's model (D22, P3, P4), M/server-view-model.js: the
// env radio (only envs with a command), the variant chips (the inferred one
// marked), each URL, Ver server / Reiniciar / Apagar, and on
// `root-diverged` / `untracked-collision` only: Forzar sync, Proyectar igual
// and Apagar igual, each with the CLI argv it runs. Plus the file access the
// mod gives T5a's detection (Herdr's readTextFile and fs/promises readdir).
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverViewModel, modIo } from "../mods/spotlight/server-view-model.js";
import { cliPathOf, readSettings } from "../mods/spotlight/board-model.js";
import { detectServerScripts, inferredVariantNote } from "../mods/spotlight/server-plan.js";

const BIN = cliPathOf("/app");
const ROOT = "/Users/u/code/landing";
const H = "/Users/u/orca/workspaces/landing/ax-1";
const W2 = "/Users/u/orca/workspaces/landing/ax-2";

function repo(fields = {}) {
  return {
    holder: H, lastSyncAt: 1, lastError: null, serverTerminal: "t9", serverPid: 50, serverStartedAt: 1000,
    serverCommand: "pnpm dev:co", serverEnv: "local", serverVariant: "co", serverState: "listening", pendingInstalls: [],
    ports: [3001, 3000], logPath: "/l/landing.log", ...fields,
  };
}

function stateWith(record, over = {}) {
  return { version: 1, repos: record ? { [ROOT]: record } : {}, queue: { requests: [], lighting: {} }, notes: [], variants: {}, ...over };
}

const settingsOf = (raw = { version: 1 }) => readSettings(JSON.stringify(raw));
const DETECTED = { detected: { dev: "pnpm dev:{variant}" }, scriptCommands: [], variants: ["co", "mx"] };

function model(over = {}) {
  return serverViewModel({
    state: stateWith(repo()),
    settings: settingsOf(),
    repo: ROOT,
    workspace: H,
    detection: DETECTED,
    bin: BIN,
    ...over,
  });
}

const ids = (list) => list.map((a) => a.id);

test("envs: only those with a command, the running one selected, each with its argv", () => {
  const m = model();
  // Local falls back to Dev (T5a), so both start something; Prod has none.
  assert.deepEqual(m.envs.map((e) => e.env), ["local", "dev"]);
  assert.deepEqual(m.envs.map((e) => e.label), ["Local", "Dev"]);
  assert.deepEqual(m.envs.map((e) => e.selected), [true, false]);
  assert.deepEqual(m.envs[1].argv, [BIN, "env", "--workspace", H, "--env", "dev"]);

  const saved = model({
    settings: settingsOf({ version: 1, repos: { [ROOT]: { envs: { prod: "pnpm start" } } } }),
    detection: { detected: { local: "pnpm local" }, scriptCommands: [] },
    state: stateWith(repo({ envOverride: "prod" })),
  });
  assert.deepEqual(saved.envs.map((e) => [e.env, e.selected, e.command]), [
    ["local", false, "pnpm local"],
    ["prod", true, "pnpm start"],
  ]);
  assert.deepEqual(model({ detection: { detected: {}, scriptCommands: [] } }).envs, []);
  // Not known yet (detection still running): the saved ones only.
  assert.deepEqual(model({ detection: null }).envs, []);
});

test("envs: the effective env is selected (the popup's override, else the settings' env), not only the running one (J-002)", () => {
  const settings = settingsOf({ version: 1, repos: { [ROOT]: { env: "dev" } } });
  // The server still runs Local (serverEnv), the settings now say Dev.
  assert.deepEqual(model({ settings }).envs.map((e) => [e.env, e.selected]), [["local", false], ["dev", true]]);
  const override = model({ settings, state: stateWith(repo({ envOverride: "local", serverEnv: "dev" })) });
  assert.deepEqual(override.envs.map((e) => [e.env, e.selected]), [["local", true], ["dev", false]]);
});

test("envs: an env that didn't start says so, and the env still running is marked (the selection stays what was asked)", () => {
  const settings = settingsOf({ version: 1, repos: { [ROOT]: { env: "dev" } } });
  const failed = model({ settings, state: stateWith(repo({ envFailed: "dev", envFailedAt: 5 })) });
  assert.deepEqual(failed.envs.map((e) => [e.env, e.selected, e.running]), [["local", false, true], ["dev", true, false]]);
  assert.equal(failed.envNote, "Dev no arrancó: el server sigue en Local. Reiniciar lo intenta otra vez.");

  // Asked but not tried yet (the next reap restarts it): marked, no note.
  const pending = model({ settings });
  assert.deepEqual(pending.envs.map((e) => e.running), [true, false]);
  assert.equal(pending.envNote, null);

  // What runs is what's asked: nothing to mark. A stale mark for another env says nothing.
  const same = model({ state: stateWith(repo({ envFailed: "dev" })) });
  assert.deepEqual(same.envs.map((e) => e.running), [false, false]);
  assert.equal(same.envNote, null);

  // Nothing running: no env is marked; a failed start still says so.
  const down = model({ settings, state: stateWith(repo({ serverState: "stopped", serverEnv: null, envFailed: "dev" })) });
  assert.deepEqual(down.envs.map((e) => e.running), [false, false]);
  assert.equal(down.envNote, "Dev no arrancó. Reiniciar lo intenta otra vez.");
});

test("variant chips: the candidates, the running one selected, the inferred one marked", () => {
  const plain = model();
  assert.deepEqual(plain.variants.map((v) => [v.variant, v.label, v.selected, v.inferred]), [
    ["co", "CO", true, false],
    ["mx", "MX", false, false],
  ]);
  assert.deepEqual(plain.variants[1].argv, [BIN, "env", "--workspace", H, "--variant", "mx"]);

  const inferred = model({
    state: stateWith(repo(), { notes: [{ at: 1000, repo: ROOT, text: inferredVariantNote("co"), toast: true }] }),
  });
  assert.deepEqual(inferred.variants.map((v) => v.inferred), [true, false]);
  // A note from an earlier start doesn't mark this one.
  const old = model({ state: stateWith(repo(), { notes: [{ at: 999, repo: ROOT, text: inferredVariantNote("co"), toast: true }] }) });
  assert.deepEqual(old.variants.map((v) => v.inferred), [false, false]);

  // Waiting for a pick: the plan's candidates, none selected.
  const ask = model({ state: stateWith(repo({ serverState: "needs-variant", serverVariant: null, variantCandidates: ["mx"] })) });
  assert.deepEqual(ask.variants.map((v) => [v.variant, v.selected]), [["mx", false]]);
  assert.equal(ask.needsVariant, true);
  // An unsafe name never becomes a chip.
  const unsafe = model({ detection: { ...DETECTED, variants: ["co", "a b", "x;rm"] } });
  assert.deepEqual(unsafe.variants.map((v) => v.variant), ["co"]);
  assert.deepEqual(model({ detection: { detected: { dev: "pnpm dev" }, scriptCommands: [] } }).variants, []);
});

test("URLs: the picked port first, then the rest in order", () => {
  assert.deepEqual(model().urls, ["http://localhost:3000", "http://localhost:3001"]);
  const configured = model({ settings: settingsOf({ version: 1, repos: { [ROOT]: { port: 3001 } } }) });
  assert.deepEqual(configured.urls, ["http://localhost:3001", "http://localhost:3000"]);
  assert.deepEqual(model({ state: stateWith(repo({ ports: [], serverState: "starting" })) }).urls, []);
});

test("actions: Ver server, Reiniciar, Apagar with their argv; only Ver server without a holder", () => {
  const m = model();
  assert.deepEqual(m.actions, [
    { id: "peek", label: "Ver server", argv: [BIN, "peek", "--repo", ROOT] },
    { id: "restart", label: "Reiniciar", argv: [BIN, "restart", "--repo", ROOT] },
    { id: "off", label: "Apagar", argv: [BIN, "toggle", "--workspace", H], danger: true },
  ]);
  assert.deepEqual(m.force, []);
  assert.equal(m.name, "landing");
  assert.equal(m.holderName, "ax-1");
  assert.equal(m.serverState, "listening");

  const idle = model({ state: stateWith(repo({ holder: null })) });
  assert.deepEqual(ids(idle.actions), ["peek"]);
  assert.deepEqual(idle.envs.map((e) => e.argv[3]), [H, H], "env changes name the popup's workspace when nothing holds");
  assert.deepEqual(ids(model({ state: stateWith(null) }).actions), []);
});

test("force actions only on root-diverged and untracked-collision, each with its argv", () => {
  const failedTakeover = {
    "ax/AX-2": { grantId: 5, phase: "error", members: [{ root: ROOT, workspace: W2 }], errors: { [ROOT]: "moved" }, finishedAt: 7 },
    "ax/AX-1": { grantId: 1, phase: "done", members: [{ root: ROOT, workspace: H }], errors: {}, finishedAt: 2 },
    "ax/OTHER": { grantId: 6, phase: "error", members: [{ root: "/x", workspace: "/y" }], errors: { "/x": "no" }, finishedAt: 9 },
  };
  for (const code of ["root-diverged", "untracked-collision"]) {
    const m = model({
      state: stateWith(repo({ lastError: { code, message: "m", at: 3 } }), { queue: { requests: [], lighting: failedTakeover } }),
    });
    assert.deepEqual(m.force, [
      { id: "force-sync", label: "Forzar sync", argv: [BIN, "sync", "--repo", ROOT, "--force", "--detach"] },
      { id: "project-anyway", label: "Proyectar igual", argv: [BIN, "light", "--task", "ax/AX-2", "--force"], detach: true },
      { id: "off-anyway", label: "Apagar igual", argv: [BIN, "toggle", "--workspace", H, "--force"], danger: true },
    ], code);
    assert.equal(m.error.code, code);
  }
  // No failed lighting on this root: no Proyectar igual.
  const noTakeover = model({ state: stateWith(repo({ lastError: { code: "root-diverged", message: "m", at: 3 } })) });
  assert.deepEqual(ids(noTakeover.force), ["force-sync", "off-anyway"]);
  // No holder (a fresh activation refused): only Proyectar igual.
  const fresh = model({
    state: stateWith(repo({ holder: null, lastError: { code: "untracked-collision", message: "m", at: 3 } }), {
      queue: { requests: [], lighting: { [`direct/${ROOT}`]: { phase: "error", members: [{ root: ROOT, workspace: W2 }], errors: { [ROOT]: "x" } } } },
    }),
  });
  assert.deepEqual(fresh.force, [
    { id: "project-anyway", label: "Proyectar igual", argv: [BIN, "light", "--task", `direct/${ROOT}`, "--force"], detach: true },
  ]);
  // Any other error, or none: no force actions, the error still shown.
  for (const code of ["git-failed", "operation-in-progress", "orphan-refs", "restore-conflict"]) {
    const m = model({ state: stateWith(repo({ lastError: { code, message: "m", at: 3 } }), { queue: { requests: [], lighting: failedTakeover } }) });
    assert.deepEqual(m.force, [], code);
    assert.equal(m.error.message, "m");
  }
});

test("orca-holds (D27): Orca's Spotlight has the root: its message, and no Forzar sync, Proyectar igual nor Apagar igual", () => {
  const ORCA = { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 3 };
  const failedTakeover = {
    "ax/AX-2": { grantId: 5, phase: "error", members: [{ root: ROOT, workspace: W2 }], errors: { [ROOT]: ORCA.message }, finishedAt: 7 },
  };
  // Held by us when Orca took it, with a takeover it refused waiting.
  const held = model({ state: stateWith(repo({ lastError: ORCA }), { queue: { requests: [], lighting: failedTakeover } }) });
  assert.deepEqual(held.force, []);
  assert.deepEqual(held.error, ORCA);
  // Apagar (no force) stays: it refuses with the same message while Orca has it.
  assert.deepEqual(ids(held.actions), ["peek", "restart", "off"]);
  // A refused fresh turn-on: no holder, no Proyectar igual.
  const fresh = model({
    state: stateWith(repo({ holder: null, lastError: ORCA }), {
      queue: { requests: [], lighting: { [`direct/${ROOT}`]: { phase: "error", members: [{ root: ROOT, workspace: W2 }], errors: { [ROOT]: ORCA.message } } } },
    }),
  });
  assert.deepEqual(fresh.force, []);
  assert.equal(fresh.error.message, ORCA.message);
});

test("modIo: T5a's detection over Herdr-style readTextFile and readdir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-modio-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "dev:co": "x", "dev:mx": "y", "dev;rm -rf x": "z" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    fs.mkdirSync(path.join(dir, "apps", "co"), { recursive: true });
    fs.mkdirSync(path.join(dir, "apps", "mx"), { recursive: true });
    const readTextFile = async (p) => {
      try {
        return await fsp.readFile(p, "utf8");
      } catch {
        return null;
      }
    };
    const io = modIo({ readTextFile, readdir: fsp.readdir });
    assert.equal(await io.kind(path.join(dir, "pnpm-lock.yaml")), "file");
    assert.equal(await io.kind(path.join(dir, "apps")), "dir");
    assert.equal(await io.kind(path.join(dir, "yarn.lock")), "none");
    assert.equal(await io.kind(path.join(dir, "nope", "x")), null);
    assert.deepEqual((await io.listDirs(path.join(dir, "apps"))).sort(), ["co", "mx"]);
    assert.equal(await io.listDirs(path.join(dir, "nope")), null);
    assert.equal(await io.readText(path.join(dir, "package.json"), 10), null);
    const found = await detectServerScripts(dir, io);
    assert.deepEqual(found.detected, { dev: "pnpm dev:{variant}" });
    assert.deepEqual(found.variants, ["co", "mx"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// T13 (D24): a port someone else holds. The popup offers "Liberar puerto y
// arrancar", which stops that process and starts the server; only there.
const PORT_BUSY = {
  code: "port-busy", port: 3008, pid: 900, command: "next-server (v16.0.1)", cwd: "/Users/u/old",
  message: "El puerto 3008 lo tiene next-server (v16.0.1) (pid 900, en /Users/u/old).", at: 3,
};

test("Liberar puerto y arrancar: only on port-busy, with its argv; never a force path there", () => {
  const busy = model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError: PORT_BUSY })) });
  assert.deepEqual(busy.force, [
    { id: "free-port", label: "Liberar puerto y arrancar", argv: [BIN, "restart", "--repo", ROOT, "--free-port"], danger: true },
  ]);
  assert.equal(busy.error.message, PORT_BUSY.message);
  // Reiniciar stays: it starts once the port is free, and says so when it isn't.
  assert.deepEqual(ids(busy.actions), ["peek", "restart", "off"]);
  // Not on any other error, nor without one.
  for (const code of ["root-diverged", "untracked-collision", "git-failed", "orphan-refs"]) {
    const m = model({ state: stateWith(repo({ lastError: { code, message: "m", at: 3 } })) });
    assert.ok(!ids(m.force).includes("free-port"), code);
  }
  assert.deepEqual(model().force, []);
  // Nothing holds the root (nothing to start): no button.
  assert.deepEqual(model({ state: stateWith(repo({ holder: null, lastError: PORT_BUSY })) }).force, []);
});

// T14 (D25): a server that died at start, or a start a busy port refused.
// The popup offers Ver log (the server terminal, which holds what it
// printed) and Reintentar (`spotlight restart`), in the places of Ver server
// and Reiniciar, on both codes.
const SERVER_EXITED = { code: "server-exited", message: "El server se cayó al arrancar: SyntaxError: Unexpected token ';'", at: 4 };

test("a server that didn't come up: Ver log and Reintentar on port-busy and server-exited, with Ver server's and Reiniciar's argv", () => {
  for (const lastError of [PORT_BUSY, SERVER_EXITED]) {
    const m = model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError })) });
    assert.deepEqual(m.actions, [
      { id: "peek", label: "Ver log", argv: [BIN, "peek", "--repo", ROOT] },
      { id: "restart", label: "Reintentar", argv: [BIN, "restart", "--repo", ROOT] },
      { id: "off", label: "Apagar", argv: [BIN, "toggle", "--workspace", H], danger: true },
    ], lastError.code);
    assert.equal(m.error.message, lastError.message);
  }
  // A server that exited holds no port of anyone's: no force path.
  assert.deepEqual(model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError: SERVER_EXITED })) }).force, []);
  // Any other error, or none: Ver server and Reiniciar.
  for (const lastError of [null, { code: "root-diverged", message: "m", at: 3 }, { code: "git-failed", message: "m", at: 3 }]) {
    const m = model({ state: stateWith(repo({ lastError })) });
    assert.deepEqual(m.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"], lastError?.code ?? "none");
  }
});

// R7: a refused restart keeps its port-busy over a server that is still up
// (D24). The popup says what the badge says: down only when the server is
// stopped or gone.
test("a server error over a server still up (a refused restart, D24): Ver server and Reiniciar; Ver log and Reintentar only once it is stopped or gone", () => {
  for (const serverState of ["listening", "starting"]) {
    const m = model({ state: stateWith(repo({ serverState, lastError: PORT_BUSY })) });
    assert.deepEqual(m.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"], serverState);
    // The port's holder is still someone else's: Liberar puerto y arrancar stays.
    assert.deepEqual(ids(m.force), ["free-port"], serverState);
  }
  for (const serverState of ["stopped", "gone", null]) {
    const m = model({ state: stateWith(repo({ serverState, ports: [], lastError: SERVER_EXITED })) });
    assert.deepEqual(m.actions.map((a) => a.label), ["Ver log", "Reintentar", "Apagar"], String(serverState));
  }
});

// F6, F7: a server error can sit under a root error (lastError.serverError).
// The popup follows the error on top: under orca-holds no Ver log, Reintentar
// nor Liberar puerto y arrancar (D27); under root-diverged its force path.
test("a server error under a root error: the popup follows the root error on top", () => {
  const ORCA = { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 3 };
  for (const serverError of [PORT_BUSY, SERVER_EXITED]) {
    const held = model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError: { ...ORCA, serverError } })) });
    assert.deepEqual(held.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"], serverError.code);
    assert.deepEqual(held.force, [], serverError.code);
    assert.equal(held.errorTitle, `Spotlight: ${ORCA.message}`);
    const diverged = { code: "root-diverged", message: "m", at: 3, serverError };
    const moved = model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError: diverged })) });
    assert.deepEqual(moved.actions.map((a) => a.label), ["Ver server", "Reiniciar", "Apagar"], serverError.code);
    assert.deepEqual(ids(moved.force), ["force-sync", "off-anyway"], serverError.code);
    assert.equal(moved.errorTitle, "Root desviado: abre el server para forzar");
  }
});

// F9: one oneLine, badges-model's.
test("the popup flattens text with badges-model's oneLine, not one of its own", () => {
  const src = fs.readFileSync(new URL("../mods/spotlight/server-view-model.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /const oneLine\s*=/);
  assert.match(src, /import \{[^}]*\boneLine\b[^}]*\} from "\.\/badges-model\.js";/);
});

// T2 (live test): the popup showed the error twice, a red "Spotlight: <msg>"
// and a grey, cut copy of the same text. It says it once; the grey line is
// only for an engine message the red line's words don't carry.
test("the popup says the error once: the message alone, or the badge's words with the engine's message under them when they differ", () => {
  const ORCA = { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 3 };
  for (const lastError of [PORT_BUSY, SERVER_EXITED, ORCA, { code: "git-failed", message: "git exploded", at: 3 }]) {
    const m = model({ state: stateWith(repo({ serverState: "stopped", ports: [], lastError })) });
    assert.equal(m.errorTitle, `Spotlight: ${lastError.message}`, lastError.code);
    assert.equal(m.errorDetail, null, lastError.code);
  }
  const moved = "The repository root moved off the Spotlight snapshot.";
  const diverged = model({ state: stateWith(repo({ lastError: { code: "root-diverged", message: moved, at: 3 } })) });
  assert.equal(diverged.errorTitle, "Root desviado: abre el server para forzar");
  assert.equal(diverged.errorDetail, moved);
  const none = model();
  assert.equal(none.errorTitle, null);
  assert.equal(none.errorDetail, null);
});
