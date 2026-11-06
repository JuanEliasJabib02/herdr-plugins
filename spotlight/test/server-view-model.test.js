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
    state: stateWith(repo({ serverEnv: "prod" })),
  });
  assert.deepEqual(saved.envs.map((e) => [e.env, e.selected, e.command]), [
    ["local", false, "pnpm local"],
    ["prod", true, "pnpm start"],
  ]);
  assert.deepEqual(model({ detection: { detected: {}, scriptCommands: [] } }).envs, []);
  // Not known yet (detection still running): the saved ones only.
  assert.deepEqual(model({ detection: null }).envs, []);
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
