// T5a: the command a repo's Spotlight server runs (M/server-plan.js, D10).
// Ports the cases of Orca's spotlight-server-variant.test.ts,
// spotlight-server-command.test.ts (resolve), spotlight-server-script-
// detection.test.ts, spotlight-server-variant-detection.test.ts,
// spotlight-variant-inference.test.ts and spotlight-lockfile-install(-uv)
// .test.ts, plus the task's own: a landing-style repo with dev:co/dev:mx and
// one touched apps/co/, a uv repo whose uv.lock changed, a script named
// `dev;rm -rf x` skipped, and a folder `apps/a b/` never substituted. Files
// are read through nodeIo on realpath'd temp dirs; git is real where the
// case needs a repository, a fake otherwise.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_ENVS, DEFAULT_ENV, MAX_VARIANT_PROMPT_CHOICES, MAX_REMEMBERED_VARIANTS,
  isSafeScriptName, isSafeVariant, needsVariant, fillVariant, formatVariant,
  normalizeCommand, normalizePort,
  commandTemplate, resolveCommand, serverEnvsWithCommand,
  detectServerScripts, hasServerCommand,
  mapChangedPathsToVariants, inferVariant, defaultBaseRef,
  variantKey, rememberedVariant, rememberVariant,
  planServerCommand, planServer, inferredVariantNote,
  lockfileInstalls, missingInstalls, installsFor, chainInstall,
  nodeIo, expectedPort, portFromCommand,
} from "../mods/spotlight/server-plan.js";

const io = nodeIo(fs);

const tmpRoots = [];
function tempDir(prefix = "sl-plan-") {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// Git with no global config or hooks, so Juan's own settings never leak in.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
const sh = (cwd, ...args) =>
  execFileSync("git", [...GIT_ID, ...args], { cwd, env: GIT_ENV, stdio: "pipe" }).toString().trim();
// The module's git port: (cwd, args) → stdout, rejecting when git fails.
const realGit = (cwd, args) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd, env: GIT_ENV, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
}
function writePackageJson(dir, contents) {
  writeFileSync(join(dir, "package.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}
function makeApps(dir, ...names) {
  for (const name of names) mkdirSync(join(dir, "apps", name), { recursive: true });
}

// ── Variants: safe tokens and the {variant} placeholder ───────────────────

const LOCAL_TEMPLATE = "pnpm exec dotenv -e .env.{variant}.local -e .env.{variant} -- pnpm --filter @ae/{variant} dev";
const UNSAFE = ["", " ", "do pt", "do;rm -rf ~", "$(whoami)", "`id`", "do&&x", "../do", "x".repeat(65), "a b"];

test("isSafeVariant: accepts plain tokens only", () => {
  for (const v of ["do", "DO", "pt_br", "es-2", "x".repeat(64)]) assert.equal(isSafeVariant(v), true, v);
  for (const v of [...UNSAFE, null, undefined, 7]) assert.equal(isSafeVariant(v), false, String(v));
});

test("fillVariant: fills every placeholder", () => {
  assert.equal(fillVariant(LOCAL_TEMPLATE, "do"), "pnpm exec dotenv -e .env.do.local -e .env.do -- pnpm --filter @ae/do dev");
});

test("fillVariant: leaves a command without the placeholder alone, whatever the variant", () => {
  assert.equal(fillVariant("pnpm local", undefined), "pnpm local");
  assert.equal(fillVariant("pnpm local", "do; rm -rf ~"), "pnpm local");
});

test("fillVariant: refuses a missing or unsafe variant instead of typing the placeholder", () => {
  assert.equal(fillVariant("pnpm dev:{variant}", null), null);
  assert.equal(fillVariant("pnpm dev:{variant}", undefined), null);
  for (const v of UNSAFE) assert.equal(fillVariant("pnpm dev:{variant}", v), null, v);
});

test("needsVariant and formatVariant: tell which commands need one, and how a label reads", () => {
  assert.equal(needsVariant("pnpm dev:{variant}"), true);
  assert.equal(needsVariant("pnpm dev:do"), false);
  assert.equal(formatVariant("do"), "DO");
});

// ── Commands per environment (settings over detected, port, Local → Dev) ─

const VARIANT_SETTINGS = { envs: { local: LOCAL_TEMPLATE, dev: "pnpm dev:{variant}", prod: "pnpm prod:{variant}" }, port: 3001 };

test("resolveCommand: fills the chosen variant, then appends the port", () => {
  assert.equal(resolveCommand({ settings: VARIANT_SETTINGS, env: "dev", variant: "pt" }), "pnpm dev:pt --port 3001");
  assert.equal(
    resolveCommand({ settings: VARIANT_SETTINGS, env: "local", variant: "do" }),
    "pnpm exec dotenv -e .env.do.local -e .env.do -- pnpm --filter @ae/do dev --port 3001",
  );
});

test("resolveCommand: resolves to nothing while no safe variant is chosen", () => {
  assert.equal(resolveCommand({ settings: VARIANT_SETTINGS, env: "prod" }), null);
  assert.equal(resolveCommand({ settings: VARIANT_SETTINGS, env: "prod", variant: "do pt" }), null);
});

test("resolveCommand: uses a detected variant template like a typed one", () => {
  const detected = { dev: "pnpm dev:{variant}", prod: "pnpm prod:{variant}" };
  assert.equal(resolveCommand({ detected, env: "local", variant: "ec" }), "pnpm dev:ec");
});

test("resolveCommand: ignores the variant for a command that does not use it", () => {
  assert.equal(resolveCommand({ settings: { envs: { dev: "pnpm dev" } }, env: "dev", variant: "do" }), "pnpm dev");
});

test("commandTemplate: keeps the placeholder in the template", () => {
  assert.equal(commandTemplate({ settings: VARIANT_SETTINGS, env: "dev" }), "pnpm dev:{variant} --port 3001");
  assert.equal(commandTemplate({ settings: { envs: {} }, env: "dev" }), null);
});

test("resolveCommand: prefers the saved command over the detected one", () => {
  assert.equal(resolveCommand({ settings: { envs: { dev: "ax-dev-back" } }, detected: { dev: "pnpm dev" }, env: "dev" }), "ax-dev-back");
});

test("resolveCommand: falls back to the detected command per environment", () => {
  const detected = { local: "pnpm local", dev: "pnpm dev", prod: "pnpm prod" };
  const settings = { envs: { dev: "custom" } };
  assert.equal(resolveCommand({ settings, detected, env: "local" }), "pnpm local");
  assert.equal(resolveCommand({ settings, detected, env: "prod" }), "pnpm prod");
});

test("resolveCommand: ignores a blank or null saved command and uses the detected one", () => {
  assert.equal(resolveCommand({ settings: { envs: { dev: "   " } }, detected: { dev: "pnpm dev" }, env: "dev" }), "pnpm dev");
  assert.equal(resolveCommand({ settings: { envs: { dev: null } }, detected: { dev: "pnpm dev" }, env: "dev" }), "pnpm dev");
});

test("resolveCommand: uses the dev command in local when there is no local one", () => {
  assert.equal(resolveCommand({ settings: { envs: { dev: "pnpm dev:do" } }, env: "local" }), "pnpm dev:do");
  assert.equal(resolveCommand({ detected: { dev: "pnpm dev" }, env: "local" }), "pnpm dev");
  assert.equal(resolveCommand({ settings: { envs: { dev: "saved dev" } }, detected: { dev: "detected dev" }, env: "local" }), "saved dev");
});

test("resolveCommand: keeps a local command over the dev fallback, saved or detected", () => {
  assert.equal(
    resolveCommand({ settings: { envs: { local: "saved local", dev: "saved dev" } }, detected: { local: "detected local" }, env: "local" }),
    "saved local",
  );
  assert.equal(resolveCommand({ settings: { envs: { dev: "saved dev" } }, detected: { local: "detected local" }, env: "local" }), "detected local");
});

test("resolveCommand: never falls back across other environments", () => {
  assert.equal(resolveCommand({ settings: { envs: { local: "pnpm local", dev: "pnpm dev" } }, env: "prod" }), null);
  assert.equal(resolveCommand({ settings: { envs: { local: "pnpm local" } }, env: "dev" }), null);
});

test("resolveCommand: returns null when there is nothing to run", () => {
  assert.equal(resolveCommand({ env: "local" }), null);
  assert.equal(resolveCommand({ settings: { envs: {} }, detected: {}, env: "dev" }), null);
  assert.equal(resolveCommand({ settings: { port: 3000 }, env: "local" }), null);
});

test("resolveCommand: appends the port as --port N, after npm's `--`", () => {
  assert.equal(resolveCommand({ settings: { envs: { dev: "pnpm dev" }, port: 3002 }, env: "dev" }), "pnpm dev --port 3002");
  assert.equal(resolveCommand({ settings: { port: 3004 }, detected: { dev: "pnpm dev" }, env: "local" }), "pnpm dev --port 3004");
  assert.equal(resolveCommand({ settings: { port: 3000 }, detected: { dev: "npm run dev --" }, env: "dev" }), "npm run dev -- --port 3000");
});

test("resolveCommand: ignores an invalid port", () => {
  for (const port of [0, 65536, 3000.5, Number.NaN, -1, "3000", null]) {
    assert.equal(resolveCommand({ settings: { envs: { dev: "pnpm dev" }, port }, env: "dev" }), "pnpm dev", String(port));
  }
});

test("resolveCommand: an unknown environment falls back to local", () => {
  assert.equal(DEFAULT_ENV, "local");
  assert.deepEqual(SERVER_ENVS, ["local", "dev", "prod"]);
  assert.equal(resolveCommand({ detected: { local: "pnpm local" }, env: "staging" }), "pnpm local");
  assert.equal(resolveCommand({ detected: { local: "pnpm local" } }), "pnpm local");
});

test("normalizeCommand: trims, and drops what can't be typed as one line", () => {
  assert.equal(normalizeCommand("  pnpm dev  "), "pnpm dev");
  assert.equal(normalizeCommand(""), null);
  assert.equal(normalizeCommand("   "), null);
  assert.equal(normalizeCommand(7), null);
  assert.equal(normalizeCommand("pnpm dev\nrm -rf ~"), null, "a second line would run as its own command");
  assert.equal(normalizeCommand("pnpm dev\rrm -rf ~"), null);
  assert.equal(normalizeCommand("x".repeat(2000)), "x".repeat(2000));
  assert.equal(normalizeCommand("x".repeat(2001)), null, "dropped, never truncated");
  assert.equal(resolveCommand({ settings: { envs: { dev: "pnpm dev\nrm -rf ~" } }, detected: { dev: "pnpm dev" }, env: "dev" }), "pnpm dev");
});

test("normalizePort: integers 1..65535 only", () => {
  assert.equal(normalizePort(1), 1);
  assert.equal(normalizePort(65535), 65535);
  for (const p of [0, 65536, 1.5, "80", null, undefined]) assert.equal(normalizePort(p), null, String(p));
});

test("serverEnvsWithCommand: the environments that would start something", () => {
  assert.deepEqual(serverEnvsWithCommand({ detected: { dev: "pnpm dev" } }), ["local", "dev"]);
  assert.deepEqual(serverEnvsWithCommand({ settings: { envs: { prod: "pnpm start" } } }), ["prod"]);
  assert.deepEqual(serverEnvsWithCommand({}), []);
});

// ── Script detection from package.json ────────────────────────────────────

const SCRIPTS = { local: "next dev", dev: "next dev", prod: "next start", build: "next build" };
const EMPTY = { detected: {}, scriptCommands: [] };

test("detectServerScripts: builds pnpm commands from the packageManager field", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.1.0", scripts: SCRIPTS });
  assert.deepEqual((await detectServerScripts(root, io)).detected, { local: "pnpm local", dev: "pnpm dev", prod: "pnpm prod" });
});

test("detectServerScripts: detects pnpm from its lockfile", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: { dev: "vite" } });
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  assert.deepEqual((await detectServerScripts(root, io)).detected, { dev: "pnpm dev" });
});

test("detectServerScripts: builds yarn commands", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "yarn@4.0.0", scripts: SCRIPTS });
  assert.deepEqual((await detectServerScripts(root, io)).detected, { local: "yarn local", dev: "yarn dev", prod: "yarn prod" });
});

test("detectServerScripts: builds bun commands with `bun run`", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: { dev: "bun --hot server.ts" } });
  writeFileSync(join(root, "bun.lock"), "");
  assert.deepEqual((await detectServerScripts(root, io)).detected, { dev: "bun run dev" });
});

test("detectServerScripts: builds npm commands with a trailing `--` so an appended --port reaches the script", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: SCRIPTS });
  writeFileSync(join(root, "package-lock.json"), "{}");
  assert.deepEqual((await detectServerScripts(root, io)).detected, { local: "npm run local --", dev: "npm run dev --", prod: "npm run prod --" });
});

test("detectServerScripts: falls back to npm when no package manager can be told", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: { dev: "vite" } });
  assert.deepEqual((await detectServerScripts(root, io)).detected, { dev: "npm run dev --" });
});

test("detectServerScripts: only detects environments whose script has exactly that name", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: { dev: "next dev", "dev:do": "next dev", "prod:do": "next start", start: "node ." } });
  assert.deepEqual((await detectServerScripts(root, io)).detected, { dev: "pnpm dev" });
});

test("detectServerScripts: suggests every dev/local/prod/start script, sorted", async () => {
  const root = tempDir();
  writePackageJson(root, {
    packageManager: "pnpm@9.0.0",
    scripts: { "prod:do": "next start", build: "next build", "dev:mx": "next dev", start: "node .", lint: "oxlint", "dev:do": "next dev", "local:db": "docker compose up" },
  });
  assert.deepEqual((await detectServerScripts(root, io)).scriptCommands, ["pnpm dev:do", "pnpm dev:mx", "pnpm local:db", "pnpm prod:do", "pnpm start"]);
});

test("detectServerScripts: uses the package manager form for suggestions too", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "npm@10.0.0", scripts: { "dev:do": "next dev" } });
  assert.deepEqual((await detectServerScripts(root, io)).scriptCommands, ["npm run dev:do --"]);
});

test("detectServerScripts: skips script names that are not safe to type into a terminal", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: { "dev; rm -rf ~": "x", "dev$(whoami)": "x", "dev && echo": "x", "dev:ok": "x" } });
  assert.deepEqual((await detectServerScripts(root, io)).scriptCommands, ["pnpm dev:ok"]);
});

test("detectServerScripts: a script named `dev;rm -rf x` is skipped everywhere", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: { "dev;rm -rf x": "next dev", "local;rm -rf x": "x", "dev:co": "x", "dev:mx": "x" } });
  const r = await detectServerScripts(root, io);
  assert.equal(isSafeScriptName("dev;rm -rf x"), false);
  assert.equal(isSafeScriptName("dev:co"), true);
  assert.deepEqual(r.scriptCommands, ["pnpm dev:co", "pnpm dev:mx"]);
  assert.deepEqual(r.detected, { dev: "pnpm dev:{variant}" });
  for (const env of SERVER_ENVS) {
    const line = resolveCommand({ detected: r.detected, env, variant: "co" });
    assert.ok(line === null || !line.includes(";"), `${env}: ${line}`);
  }
  assert.equal(await hasServerCommand(root, io), true, "dev:co/dev:mx still count");
});

test("detectServerScripts: returns nothing when there are no scripts", async () => {
  const root = tempDir();
  writePackageJson(root, { name: "no-scripts", packageManager: "pnpm@9.0.0" });
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: returns nothing when no script is a server script", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: { build: "tsc", test: "vitest" } });
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: returns nothing when there is no package.json", async () => {
  assert.deepEqual(await detectServerScripts(tempDir(), io), EMPTY);
});

test("detectServerScripts: returns nothing when the root does not exist", async () => {
  assert.deepEqual(await detectServerScripts(join(tempDir(), "missing"), io), EMPTY);
});

test("detectServerScripts: returns nothing for invalid JSON", async () => {
  const root = tempDir();
  writePackageJson(root, '{ "scripts": { "dev": ');
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: returns nothing when scripts is not an object", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: ["dev"] });
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: returns nothing for an oversized package.json", async () => {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@9.0.0", scripts: { dev: "next dev" }, padding: "x".repeat(129 * 1024) });
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: returns nothing when conflicting lockfiles leave the package manager ambiguous", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: { dev: "vite" } });
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  writeFileSync(join(root, "yarn.lock"), "");
  assert.deepEqual(await detectServerScripts(root, io), EMPTY);
});

test("detectServerScripts: never throws, even when the injected io does", async () => {
  const broken = { readText: async () => { throw new Error("boom"); }, kind: async () => { throw new Error("boom"); }, listDirs: async () => { throw new Error("boom"); } };
  assert.deepEqual(await detectServerScripts("/x", broken), EMPTY);
});

// ── Variant detection (dev:<v> scripts + apps/<V>/) ───────────────────────

// The landing repo: one Next app per country, plus scripts for countries whose app is gone.
const LANDING_CODES = ["pt", "es", "co", "br", "mx", "us", "do", "gb", "ec"];
const LANDING_SCRIPTS = {
  prepare: "husky",
  lint: "eslint .",
  ...Object.fromEntries(LANDING_CODES.map((c) => [`dev:${c}`, "dotenv -- next dev"])),
  ...Object.fromEntries(LANDING_CODES.map((c) => [`prod:${c}`, "dotenv -- next dev"])),
  "build:do": "next build",
};
function landingRoot(scripts, extra = {}) {
  const root = tempDir();
  writePackageJson(root, { packageManager: "pnpm@10.0.0", scripts, ...extra });
  return root;
}

test("variants: a landing-like repo gives the countries with an apps/<V> app, sorted", async () => {
  const root = landingRoot(LANDING_SCRIPTS);
  makeApps(root, "BR", "DO", "EC", "ES", "GB", "PT");
  assert.deepEqual((await detectServerScripts(root, io)).variants, ["br", "do", "ec", "es", "gb", "pt"]);
});

test("variants: drops stale codes whose app folder is gone (co, mx, us)", async () => {
  const root = landingRoot(LANDING_SCRIPTS);
  makeApps(root, "DO", "PT");
  assert.deepEqual((await detectServerScripts(root, io)).variants, ["do", "pt"]);
});

test("variants: Dev and Prod default to the variant scripts; Local falls back to Dev at resolve time", async () => {
  const root = landingRoot(LANDING_SCRIPTS);
  makeApps(root, "DO", "PT");
  const r = await detectServerScripts(root, io);
  assert.deepEqual(r.detected, { dev: "pnpm dev:{variant}", prod: "pnpm prod:{variant}" });
  assert.equal(resolveCommand({ detected: r.detected, env: "local", variant: "do" }), "pnpm dev:do");
});

test("variants: an exact environment script wins over the variant template", async () => {
  const root = landingRoot({ ...LANDING_SCRIPTS, prod: "next start" });
  makeApps(root, "DO", "PT");
  assert.deepEqual((await detectServerScripts(root, io)).detected, { dev: "pnpm dev:{variant}", prod: "pnpm prod" });
});

test("variants: the template takes the package manager form", async () => {
  const root = landingRoot(LANDING_SCRIPTS, { packageManager: "npm@10.0.0" });
  makeApps(root, "DO", "PT");
  assert.equal((await detectServerScripts(root, io)).detected.dev, "npm run dev:{variant} --");
});

test("variants: app folders match ignoring case", async () => {
  const root = landingRoot({ "dev:DO": "x", "dev:pt": "x" });
  makeApps(root, "do", "Pt");
  assert.deepEqual((await detectServerScripts(root, io)).variants, ["DO", "pt"]);
});

test("variants: dev:<v> scripts count when the repo has no apps/ folder", async () => {
  const root = landingRoot({ "dev:do": "x", "dev:pt": "x" });
  assert.deepEqual((await detectServerScripts(root, io)).variants, ["do", "pt"]);
});

test("variants: still reported when the package manager is ambiguous", async () => {
  const root = tempDir();
  writePackageJson(root, { scripts: { "dev:do": "x", "dev:pt": "x" } });
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  writeFileSync(join(root, "yarn.lock"), "");
  const r = await detectServerScripts(root, io);
  assert.deepEqual(r.variants, ["do", "pt"]);
  assert.deepEqual(r.detected, {});
});

test("variants: a plain dev script makes dev:* helpers, not variants", async () => {
  const root = landingRoot({ dev: "run-p dev:*", "dev:next": "next dev", "dev:convex": "x" });
  const r = await detectServerScripts(root, io);
  assert.equal(r.variants, undefined);
  assert.deepEqual(r.detected, { dev: "pnpm dev" });
});

test("variants: a single dev:<v> script is not a choice", async () => {
  const root = landingRoot({ local: "next dev", "dev:web": "vite" });
  assert.equal((await detectServerScripts(root, io)).variants, undefined);
});

test("variants: fewer than two codes with an app folder are not a choice", async () => {
  const root = landingRoot({ "dev:do": "x", "dev:mx": "x", "dev:us": "x" });
  makeApps(root, "DO", "web");
  const r = await detectServerScripts(root, io);
  assert.equal(r.variants, undefined);
  assert.deepEqual(r.detected, {});
});

test("variants: codes that are unsafe to type are ignored", async () => {
  const root = landingRoot({ "dev:do": "x", "dev:$(id)": "x", "dev:a b": "x" });
  assert.equal((await detectServerScripts(root, io)).variants, undefined);
});

test("variants: a repo with ordinary scripts gets no variants field", async () => {
  const root = landingRoot({ dev: "next dev", local: "next dev", prod: "next start" });
  assert.deepEqual(await detectServerScripts(root, io), {
    detected: { local: "pnpm local", dev: "pnpm dev", prod: "pnpm prod" },
    scriptCommands: ["pnpm dev", "pnpm local", "pnpm prod"],
  });
});

// ── Variant inference from what the branch changed under apps/ ───────────

const VARIANTS = ["br", "do", "ec", "es", "gb", "pt"];
const MERGE_BASE = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const WS = "/ws/landing-AX-1";

// A git that knows `bases` (ref → merge-base), answers the diff with
// `changed` and the untracked listing with `untracked`.
function fakeGit(changed, bases = { "origin/main": MERGE_BASE }, untracked = []) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push([cwd, args]);
    if (args[0] === "merge-base") {
      const sha = bases[args[1] ?? ""];
      if (!sha) throw new Error(`fatal: Not a valid object name ${args[1]}`);
      return `${sha}\n`;
    }
    if (args[0] === "diff") return changed.map((p) => `${p}\0`).join("");
    if (args[0] === "ls-files") return untracked.map((p) => `${p}\0`).join("");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  git.calls = calls;
  return git;
}
const infer = (git, over = {}) =>
  inferVariant({ git, cwd: WS, variants: VARIANTS, baseRefs: ["origin/main"], resolveDefaultBaseRef: async () => null, ...over });

test("mapChangedPathsToVariants: apps/<V>/** maps to its variant, ignoring case, in variant order", () => {
  assert.deepEqual(mapChangedPathsToVariants(["apps/PT/page.tsx", "apps/DO/app/layout.tsx", "apps/do/x.ts", "shared/ui.tsx"], VARIANTS), ["do", "pt"]);
});

test("mapChangedPathsToVariants: ignores files directly under apps/, unknown apps and other folders", () => {
  assert.deepEqual(mapChangedPathsToVariants(["apps/DO", "apps/README.md", "apps/MX/page.tsx", "x/apps/DO/a"], VARIANTS), []);
});

test("inferVariant: infers the one app the branch changed", async () => {
  const git = fakeGit(["apps/DO/app/page.tsx", "apps/DO/next.config.ts", "shared/ui.tsx"]);
  assert.deepEqual(await infer(git), { kind: "inferred", variant: "do" });
});

test("inferVariant: diffs the merge-base against the working tree, limited to apps/, in the workspace", async () => {
  const git = fakeGit(["apps/DO/app/page.tsx"]);
  await infer(git);
  assert.deepEqual(git.calls, [
    [WS, ["merge-base", "origin/main", "HEAD"]],
    [WS, ["diff", "--name-only", "--no-renames", "-z", MERGE_BASE, "--", "apps/"]],
    [WS, ["ls-files", "--others", "--exclude-standard", "-z", "--", "apps/"]],
  ]);
});

test("inferVariant: a new untracked file under apps/<V>/ counts, as Spotlight projects it", async () => {
  assert.deepEqual(await infer(fakeGit([], undefined, ["apps/PT/new-page.tsx"])), { kind: "inferred", variant: "pt" });
  assert.deepEqual(await infer(fakeGit(["apps/DO/a.tsx"], undefined, ["apps/PT/new-page.tsx"])), { kind: "ambiguous", candidates: ["do", "pt"] });
});

test("inferVariant: ambiguous with the touched apps when the branch changed several", async () => {
  assert.deepEqual(await infer(fakeGit(["apps/PT/a.tsx", "apps/DO/b.tsx"])), { kind: "ambiguous", candidates: ["do", "pt"] });
});

test("inferVariant: ambiguous with no candidates when the branch changed no app", async () => {
  assert.deepEqual(await infer(fakeGit(["shared/ui.tsx"])), { kind: "ambiguous", candidates: [] });
  assert.deepEqual(await infer(fakeGit([])), { kind: "ambiguous", candidates: [] });
});

test("inferVariant: tries the next base when one has no merge-base, then the default base", async () => {
  const git = fakeGit(["apps/GB/a.tsx"], { main: MERGE_BASE });
  let asked = 0;
  const r = await infer(git, { baseRefs: ["origin/gone", undefined, null, ""], resolveDefaultBaseRef: async () => (asked++, "main") });
  assert.deepEqual(r, { kind: "inferred", variant: "gb" });
  assert.equal(asked, 1);
  assert.deepEqual(git.calls.filter(([, a]) => a[0] === "merge-base").map(([, a]) => a[1]), ["origin/gone", "main"]);
});

test("inferVariant: resolves the default base only when the known ones fail", async () => {
  let asked = 0;
  await infer(fakeGit(["apps/DO/a.tsx"]), { resolveDefaultBaseRef: async () => (asked++, "main") });
  assert.equal(asked, 0);
});

test("inferVariant: never passes a base that git would read as an option", async () => {
  const git = fakeGit(["apps/DO/a.tsx"], { "--output=/tmp/x": MERGE_BASE });
  assert.deepEqual(await infer(git, { baseRefs: ["--output=/tmp/x", "a b"] }), { kind: "ambiguous", candidates: [] });
  assert.equal(git.calls.length, 0);
});

test("inferVariant: ambiguous with no candidates when git fails", async () => {
  const git = async (cwd, args) => {
    if (args[0] === "merge-base") return MERGE_BASE;
    throw new Error("maxBuffer exceeded");
  };
  assert.deepEqual(await infer(git), { kind: "ambiguous", candidates: [] });
});

test("inferVariant: ignores a merge-base answer that is not a commit id", async () => {
  assert.deepEqual(await infer(fakeGit(["apps/DO/a.tsx"], { "origin/main": "warning: something" })), { kind: "ambiguous", candidates: [] });
});

test("inferVariant: reads nothing for a repo without variants", async () => {
  const git = fakeGit(["apps/DO/a.tsx"]);
  assert.deepEqual(await infer(git, { variants: [] }), { kind: "ambiguous", candidates: [] });
  assert.equal(git.calls.length, 0);
});

test("inferVariant: survives a default base lookup that throws", async () => {
  const r = await infer(fakeGit(["apps/DO/a.tsx"], {}), { baseRefs: [], resolveDefaultBaseRef: async () => { throw new Error("git gone"); } });
  assert.deepEqual(r, { kind: "ambiguous", candidates: [] });
});

test("defaultBaseRef: origin/HEAD's target first, else origin/main, origin/master, main, master", async () => {
  const answer = (out) => async (cwd, args) => {
    assert.equal(args[0], "for-each-ref");
    return out;
  };
  assert.equal(await defaultBaseRef(answer("refs/remotes/origin/HEAD\0refs/remotes/origin/develop\nrefs/remotes/origin/main\0\n"), "/r"), "origin/develop");
  assert.equal(await defaultBaseRef(answer("refs/heads/main\0\nrefs/remotes/origin/master\0\n"), "/r"), "origin/master");
  assert.equal(await defaultBaseRef(answer("refs/heads/master\0\n"), "/r"), "master");
  assert.equal(await defaultBaseRef(answer(""), "/r"), null);
  assert.equal(await defaultBaseRef(async () => { throw new Error("not a repo"); }, "/r"), null);
});

// ── Remembered per task ───────────────────────────────────────────────────

test("rememberVariant: per task and repo, safe variants only, newest last", () => {
  let m = {};
  m = rememberVariant(m, "AX-1", "/r/landing", "co");
  m = rememberVariant(m, "AX-1", "/r/other", "mx");
  m = rememberVariant(m, "AX-2", "/r/landing", "pt");
  assert.equal(rememberedVariant(m, "AX-1", "/r/landing"), "co");
  assert.equal(rememberedVariant(m, "AX-1", "/r/other"), "mx");
  assert.equal(rememberedVariant(m, "AX-2", "/r/landing"), "pt");
  assert.equal(rememberedVariant(m, "AX-3", "/r/landing"), null);
  // D46: keyed by the task alone, in any space.
  assert.equal(variantKey("AX-1", "/r/landing"), "task:AX-1::/r/landing");
  const again = rememberVariant(m, "AX-1", "/r/landing", "co");
  assert.equal(again, m, "an unchanged choice returns the same map");
  const moved = rememberVariant(m, "AX-1", "/r/landing", "br");
  assert.deepEqual(Object.keys(moved).at(-1), "task:AX-1::/r/landing", "a new choice moves last");
  assert.equal(rememberVariant(m, "AX-1", "/r/landing", "a b"), m, "an unsafe variant is never stored");
  for (const key of ["", "__proto__", "constructor", "x".repeat(201)]) {
    assert.equal(variantKey(key, "/r"), null, key);
    assert.equal(rememberVariant(m, key, "/r", "co"), m);
    assert.equal(rememberedVariant(m, key, "/r"), null);
  }
  assert.equal(variantKey("AX-1", ""), null);
  assert.equal(variantKey(null, "/r"), null);
});

test("rememberedVariant: tolerates a hand-edited map", () => {
  assert.equal(rememberedVariant(null, "AX-1", "/r"), null);
  assert.equal(rememberedVariant({ "task:AX-1::/r": "a b" }, "AX-1", "/r"), null);
  assert.equal(rememberedVariant({ "task:AX-1::/r": 7 }, "AX-1", "/r"), null);
  assert.equal(rememberedVariant(Object.create({ "task:AX-1::/r": "co" }), "AX-1", "/r"), null, "only own keys");
});

test("D46: a light's <lane>/<KEY>, an `env --task` pick's task:<KEY> and any space's lane name one variant, task:<KEY>::<root>; an old <g>/<KEY>::<root> is still read, the later one winning", () => {
  for (const taskKey of ["g1/AX-1", "zz/AX-1", "task:AX-1"]) assert.equal(variantKey(taskKey, "/r"), "task:AX-1::/r", taskKey);
  const m = rememberVariant({}, "g1/AX-1", "/r", "co");
  assert.deepEqual(m, { "task:AX-1::/r": "co" });
  for (const taskKey of ["g1/AX-1", "g2/AX-1", "task:AX-1"]) assert.equal(rememberedVariant(m, taskKey, "/r"), "co", taskKey);
  // Written before D46, in any space: read until the next pick rewrites it.
  assert.equal(rememberedVariant({ "g1/AX-1::/r": "mx" }, "task:AX-1", "/r"), "mx");
  assert.equal(rememberedVariant({ "g1/AX-1::/r": "mx" }, "g2/AX-1", "/r"), "mx");
  assert.equal(rememberedVariant({ "task:AX-1::/r": "co", "g1/AX-1::/r": "mx" }, "task:AX-1", "/r"), "mx", "the later one");
  assert.equal(rememberedVariant({ "g1/AX-1::/r": "mx", "task:AX-1::/r": "co" }, "task:AX-1", "/r"), "co", "the later one");
  assert.equal(rememberedVariant({ "g1/AX-1::/r": "mx", "task:AX-1::/r": "a b" }, "task:AX-1", "/r"), "mx", "an unsafe value doesn't count");
  // Another repo's, another task's, a workspace's: never.
  const others = { "g1/AX-1::/r2": "mx", "g1/AX-1::/x/r": "mx", "g1/AX-2::/r": "mx", "g1/AX-10::/r": "mx", "ws:/w/AX-1::/r": "mx" };
  assert.equal(rememberedVariant(others, "task:AX-1", "/r"), null);
});

test("rememberVariant: keeps at most MAX_REMEMBERED_VARIANTS, dropping the oldest", () => {
  let m = {};
  for (let i = 0; i < MAX_REMEMBERED_VARIANTS + 3; i++) m = rememberVariant(m, `T-${i}`, "/r", "co");
  assert.equal(Object.keys(m).length, MAX_REMEMBERED_VARIANTS);
  assert.equal(rememberedVariant(m, "T-0", "/r"), null);
  assert.equal(rememberedVariant(m, "T-2", "/r"), null);
  assert.equal(rememberedVariant(m, "T-3", "/r"), "co");
  assert.equal(rememberedVariant(m, `T-${MAX_REMEMBERED_VARIANTS + 2}`, "/r"), "co");
});

// ── The plan: env, command, variant pick ──────────────────────────────────

const VARIANT_DETECTED = { dev: "pnpm dev:{variant}", prod: "pnpm prod:{variant}" };
const noInfer = async () => {
  throw new Error("inference must not run");
};

test("planServerCommand: none (with the env) when the repo has no command there", async () => {
  assert.deepEqual(await planServerCommand({ detected: { dev: "pnpm dev" }, env: "prod", infer: noInfer }), { kind: "none", env: "prod" });
  assert.deepEqual(await planServerCommand({ infer: noInfer }), { kind: "none", env: "local" });
});

test("planServerCommand: a command without {variant} is typed as is, port included", async () => {
  assert.deepEqual(await planServerCommand({ settings: { port: 3000 }, detected: { dev: "pnpm dev" }, infer: noInfer }), {
    kind: "command", env: "local", command: "pnpm dev --port 3000", variant: null, source: null, note: null,
  });
});

test("planServerCommand: a variant chosen now wins over the remembered one and inference", async () => {
  const p = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, env: "dev", chosenVariant: "pt", remembered: "do", infer: noInfer });
  assert.deepEqual(p, { kind: "command", env: "dev", command: "pnpm dev:pt", variant: "pt", source: "chosen", note: null });
});

test("planServerCommand: the task's remembered variant wins over inference", async () => {
  const p = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, remembered: "do", infer: noInfer });
  assert.deepEqual(p, { kind: "command", env: "local", command: "pnpm dev:do", variant: "do", source: "remembered", note: null });
});

test("planServerCommand: a remembered variant the repo no longer has falls through to inference", async () => {
  const p = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, remembered: "mx", infer: async () => ({ kind: "inferred", variant: "gb" }) });
  assert.equal(p.command, "pnpm dev:gb");
  assert.equal(p.source, "inferred");
});

test("planServerCommand: an inferred variant starts, flagged for the toast and to be remembered", async () => {
  const p = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, env: "prod", infer: async () => ({ kind: "inferred", variant: "ec" }) });
  assert.deepEqual(p, { kind: "command", env: "prod", command: "pnpm prod:ec", variant: "ec", source: "inferred", note: "Variante ec inferida de apps/ec/" });
  assert.equal(inferredVariantNote("co"), "Variante co inferida de apps/co/");
});

test("planServerCommand: an unsafe or unknown pick is never used", async () => {
  const unsafe = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, chosenVariant: "do; rm -rf ~", remembered: "a b", infer: async () => ({ kind: "inferred", variant: "$(id)" }) });
  assert.deepEqual(unsafe, { kind: "ask-variant", candidates: VARIANTS });
  const unknown = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, infer: async () => ({ kind: "inferred", variant: "mx" }) });
  assert.deepEqual(unknown, { kind: "ask-variant", candidates: VARIANTS });
});

test("planServerCommand: ambiguous asks among the touched apps, else every variant (at most 6)", async () => {
  const touched = await planServerCommand({ detected: VARIANT_DETECTED, variants: VARIANTS, infer: async () => ({ kind: "ambiguous", candidates: ["do", "pt", "mx"] }) });
  assert.deepEqual(touched, { kind: "ask-variant", candidates: ["do", "pt"] });
  const many = [...VARIANTS, "mx", "us"];
  const all = await planServerCommand({ detected: VARIANT_DETECTED, variants: many, infer: async () => ({ kind: "ambiguous", candidates: [] }) });
  assert.deepEqual(all, { kind: "ask-variant", candidates: many.slice(0, MAX_VARIANT_PROMPT_CHOICES) });
  assert.equal(MAX_VARIANT_PROMPT_CHOICES, 6);
});

test("planServerCommand: a {variant} command with nothing to offer starts nothing", async () => {
  const p = await planServerCommand({ settings: { envs: { dev: "pnpm dev:{variant}" } }, env: "dev", infer: async () => ({ kind: "ambiguous", candidates: [] }) });
  assert.deepEqual(p, { kind: "none", env: null });
});

test("planServerCommand: while detection knows no variants, any safe pick is accepted", async () => {
  const p = await planServerCommand({ settings: { envs: { dev: "pnpm dev:{variant}" } }, env: "dev", remembered: "zz", infer: noInfer });
  assert.equal(p.command, "pnpm dev:zz");
});

test("planServerCommand: a variants list that isn't one reads as unknown", async () => {
  const p = await planServerCommand({ settings: { envs: { dev: "pnpm dev:{variant}" } }, env: "dev", variants: null, remembered: "zz", infer: noInfer });
  assert.equal(p.command, "pnpm dev:zz");
});

test("planServerCommand: an inference that throws reads as ambiguous", async () => {
  const p = await planServerCommand({ detected: VARIANT_DETECTED, variants: ["do", "pt"], infer: async () => { throw new Error("git gone"); } });
  assert.deepEqual(p, { kind: "ask-variant", candidates: ["do", "pt"] });
});

// ── End to end: landing-style repo, real git ──────────────────────────────

// The repo's root on main with apps/co and apps/mx, and a task worktree.
function landingRepo() {
  const root = tempDir("sl-landing-");
  sh(root, "init", "-q", "-b", "main");
  writeFiles(root, {
    "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { "dev:co": "next dev", "dev:mx": "next dev", "prod:co": "next start", "prod:mx": "next start" } }),
    "apps/co/page.tsx": "export default 1\n",
    "apps/mx/page.tsx": "export default 1\n",
    "shared/ui.tsx": "export const ui = 1\n",
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "landing");
  const ws = join(tempDir("sl-landing-ws-"), "landing-AX-3447");
  sh(root, "worktree", "add", "-q", "-b", "AX-3447", ws, "main");
  return { root, ws };
}

test("planServer: a landing-style repo whose task touched apps/co/ runs pnpm dev:co, inferred and remembered", async () => {
  const { root, ws } = landingRepo();
  writeFiles(ws, { "apps/co/page.tsx": "export default 2\n", "shared/ui.tsx": "export const ui = 2\n" });
  sh(ws, "commit", "-q", "-am", "promo co");
  const p = await planServer({ root, workspace: ws, taskKey: "AX-3447", io, git: realGit });
  assert.equal(p.kind, "command");
  assert.equal(p.command, "pnpm dev:co");
  assert.equal(p.variant, "co");
  assert.equal(p.source, "inferred");
  assert.equal(p.note, "Variante co inferida de apps/co/");
  assert.deepEqual(p.detection.variants, ["co", "mx"]);

  // The caller stores the pick; next time it is the task's, with no git read.
  const remembered = rememberVariant({}, "AX-3447", root, p.variant);
  const again = await planServer({ root, workspace: ws, taskKey: "AX-3447", remembered, io, git: async () => { throw new Error("no git expected"); } });
  assert.equal(again.command, "pnpm dev:co");
  assert.equal(again.source, "remembered");

  // Prod with a port, from the same inference.
  const prod = await planServer({ root, workspace: ws, taskKey: "AX-3447", env: "prod", settings: { port: 3100 }, io, git: realGit });
  assert.equal(prod.command, "pnpm prod:co --port 3100");
  // With no env given, the repo's saved one (settings' `env`); an explicit one wins.
  const saved = await planServer({ root, workspace: ws, taskKey: "AX-3447", settings: { env: "prod" }, io, git: realGit });
  assert.equal(saved.command, "pnpm prod:co");
  const explicit = await planServer({ root, workspace: ws, taskKey: "AX-3447", env: "dev", settings: { env: "prod" }, io, git: realGit });
  assert.equal(explicit.command, "pnpm dev:co");
});

test("planServer: an uncommitted edit under apps/mx/ counts too (the working tree, not HEAD)", async () => {
  const { root, ws } = landingRepo();
  writeFiles(ws, { "apps/mx/page.tsx": "export default 3\n" });
  const p = await planServer({ root, workspace: ws, taskKey: "AX-3447", io, git: realGit });
  assert.equal(p.command, "pnpm dev:mx");
});

test("planServer: a task that touched both apps asks which one", async () => {
  const { root, ws } = landingRepo();
  writeFiles(ws, { "apps/mx/page.tsx": "export default 3\n", "apps/co/page.tsx": "export default 3\n" });
  const p = await planServer({ root, workspace: ws, taskKey: "AX-3447", io, git: realGit });
  assert.deepEqual({ kind: p.kind, candidates: p.candidates }, { kind: "ask-variant", candidates: ["co", "mx"] });
});

test("planServer: a folder `apps/a b/` is never substituted into the command", async () => {
  const { root, ws } = landingRepo();
  // The root's package.json gains a `dev:a b` script next to an apps/a b/
  // folder, and the task only touches that folder.
  writePackageJson(root, { packageManager: "pnpm@10.0.0", scripts: { "dev:co": "x", "dev:mx": "x", "dev:a b": "x" } });
  makeApps(root, "a b");
  writeFiles(ws, { "apps/a b/page.tsx": "export default 1\n" });
  const p = await planServer({ root, workspace: ws, taskKey: "AX-3447", io, git: realGit });
  assert.deepEqual(p.detection.variants, ["co", "mx"], "`a b` is no variant");
  assert.deepEqual({ kind: p.kind, candidates: p.candidates }, { kind: "ask-variant", candidates: ["co", "mx"] });
  assert.deepEqual(mapChangedPathsToVariants(["apps/a b/page.tsx"], p.detection.variants), []);
  const chosen = await planServer({ root, workspace: ws, taskKey: "AX-3447", chosenVariant: "a b", io, git: realGit });
  assert.notEqual(chosen.kind, "command", "an unsafe choice never starts");
  const remembered = await planServer({ root, workspace: ws, taskKey: "AX-3447", remembered: { [`AX-3447::${root}`]: "a b" }, io, git: realGit });
  assert.notEqual(remembered.kind, "command", "nor does a hand-edited remembered one");
  assert.equal(fillVariant("pnpm dev:{variant}", "a b"), null);
});

test("planServer: defaults the base to the repo's default branch; a new untracked apps/co/ file is enough", async () => {
  const { root, ws } = landingRepo();
  writeFiles(ws, { "apps/co/x.tsx": "1\n" });
  assert.equal(await defaultBaseRef(realGit, ws), "main");
  const p = await planServer({ root, workspace: ws, taskKey: "AX-3447", baseRefs: ["origin/gone"], io, git: realGit });
  assert.equal(p.command, "pnpm dev:co");
});

// ── hasServerCommand: the opt-in default (D7) ─────────────────────────────

test("hasServerCommand: a repo with a dev script has one, one with no scripts doesn't", async () => {
  const withDev = tempDir();
  writePackageJson(withDev, { scripts: { dev: "vite" } });
  writeFileSync(join(withDev, "pnpm-lock.yaml"), "");
  assert.equal(await hasServerCommand(withDev, io), true);

  const noScripts = tempDir();
  writePackageJson(noScripts, { name: "lib" });
  assert.equal(await hasServerCommand(noScripts, io), false);

  const onlyStart = tempDir();
  writePackageJson(onlyStart, { scripts: { start: "node .", build: "tsc" } });
  assert.equal(await hasServerCommand(onlyStart, io), false, "start is a suggestion, not a server command");

  assert.equal(await hasServerCommand(tempDir(), io), false, "no package.json");
  assert.equal(await hasServerCommand(join(tempDir(), "gone"), io), false);
});

test("hasServerCommand: a command typed in settings counts, a blank or two-line one doesn't", async () => {
  const backend = tempDir();
  assert.equal(await hasServerCommand(backend, io, { envs: { dev: "ax-dev-back" } }), true);
  assert.equal(await hasServerCommand(backend, io, { envs: { dev: "  ", local: null } }), false);
  assert.equal(await hasServerCommand(backend, io, { envs: { dev: "a\nb" } }), false);
  assert.equal(await hasServerCommand(backend, io, { port: 3000 }), false);
});

test("hasServerCommand: a landing-style repo (variant templates only) has one", async () => {
  const root = landingRoot({ "dev:co": "x", "dev:mx": "x" });
  makeApps(root, "co", "mx");
  assert.equal(await hasServerCommand(root, io), true);
});

// ── Lockfile installs chained before the server command ───────────────────

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const ROOT = "/repo/root";
const COMMAND = "ax-dev-back";
const PNPM_CHAIN = "pnpm install --frozen-lockfile && pnpm dev";
const UV_CHAIN = `uv sync --frozen && ${COMMAND}`;
const BOTH_CHAIN = `pnpm install --frozen-lockfile && uv sync --frozen && ${COMMAND}`;

// Answers the lockfile diff and the blob read in `toSha`.
function lockGit({ diff, blob = "c".repeat(40) }) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push([cwd, args]);
    const a = args[0] === "diff-tree" ? diff : blob;
    if (a instanceof Error) throw a;
    return a;
  };
  git.calls = calls;
  return git;
}
const changedInstalls = (git, fromSha = FROM, toSha = TO) => lockfileInstalls({ git, root: ROOT, fromSha, toSha });

test("lockfileInstalls: flags pnpm when its lockfile changed and exists after", async () => {
  const git = lockGit({ diff: "pnpm-lock.yaml\n" });
  assert.deepEqual(await changedInstalls(git), ["pnpm"]);
  assert.deepEqual(git.calls, [
    [ROOT, ["diff-tree", "--name-only", FROM, TO, "--", "pnpm-lock.yaml", "uv.lock"]],
    [ROOT, ["rev-parse", "--verify", "-q", `${TO}:pnpm-lock.yaml`]],
  ]);
});

test("lockfileInstalls: stops after one read when no lockfile changed", async () => {
  const git = lockGit({ diff: "" });
  assert.deepEqual(await changedInstalls(git), []);
  assert.equal(git.calls.length, 1);
});

test("lockfileInstalls: a lockfile the new snapshot deleted is not flagged", async () => {
  assert.deepEqual(await changedInstalls(lockGit({ diff: "pnpm-lock.yaml", blob: "" })), []);
});

test("lockfileInstalls: nothing is flagged when either git read fails", async () => {
  assert.deepEqual(await changedInstalls(lockGit({ diff: new Error("fatal: bad object") })), []);
  assert.deepEqual(await changedInstalls(lockGit({ diff: "pnpm-lock.yaml", blob: new Error("fatal: not a git repo") })), []);
});

test("lockfileInstalls: skips git with no earlier commit, nothing moved, or an id that isn't one", async () => {
  const git = lockGit({ diff: "pnpm-lock.yaml" });
  assert.deepEqual(await changedInstalls(git, null), []);
  assert.deepEqual(await changedInstalls(git, TO), []);
  assert.deepEqual(await changedInstalls(git, "--output=/tmp/x"), []);
  assert.deepEqual(await changedInstalls(git, FROM, "HEAD; rm -rf ~"), []);
  assert.deepEqual(git.calls, []);
});

test("lockfileInstalls: uv is checked in the same diff, and both come back pnpm first", async () => {
  const uv = lockGit({ diff: "uv.lock\n" });
  assert.deepEqual(await changedInstalls(uv), ["uv"]);
  assert.deepEqual(uv.calls[1], [ROOT, ["rev-parse", "--verify", "-q", `${TO}:uv.lock`]]);
  assert.deepEqual(await changedInstalls(lockGit({ diff: "uv.lock\npnpm-lock.yaml\n" })), ["pnpm", "uv"]);
});

test("lockfileInstalls: a pnpm repo for real — only commits whose pnpm-lock.yaml differs and still exists", async () => {
  const root = tempDir("sl-lock-");
  sh(root, "init", "-q", "-b", "main");
  const commit = (files) => {
    for (const [f, text] of Object.entries(files)) {
      if (text === null) sh(root, "rm", "-q", f);
      else {
        writeFiles(root, { [f]: text });
        sh(root, "add", f);
      }
    }
    sh(root, "commit", "-q", "-m", "change");
    return sh(root, "rev-parse", "HEAD");
  };
  const noLockfile = commit({ "package.json": "{}\n" });
  const added = commit({ "pnpm-lock.yaml": "lockfileVersion: 9\n" });
  const other = commit({ "package.json": '{"name":"app"}\n' });
  const changed = commit({ "pnpm-lock.yaml": "lockfileVersion: 9\nfoo: 1\n" });
  const deleted = commit({ "pnpm-lock.yaml": null });
  const run = (a, b) => lockfileInstalls({ git: realGit, root, fromSha: a, toSha: b });
  assert.deepEqual(await run(noLockfile, added), ["pnpm"]);
  assert.deepEqual(await run(added, other), []);
  assert.deepEqual(await run(other, changed), ["pnpm"]);
  assert.deepEqual(await run(changed, deleted), []);
  assert.deepEqual(await run(deleted, "f".repeat(40)), []);
});

test("lockfileInstalls: a uv repo whose uv.lock changed chains uv sync --frozen before the server", async () => {
  const root = tempDir("sl-uv-");
  sh(root, "init", "-q", "-b", "main");
  const commit = (files) => {
    for (const [f, text] of Object.entries(files)) {
      if (text === null) sh(root, "rm", "-q", f);
      else {
        writeFiles(root, { [f]: text });
        sh(root, "add", f);
      }
    }
    sh(root, "commit", "-q", "-m", "change");
    return sh(root, "rev-parse", "HEAD");
  };
  const noLockfile = commit({ "pyproject.toml": '[project]\nname = "api"\n' });
  const added = commit({ "uv.lock": "version = 1\n" });
  const other = commit({ "pyproject.toml": '[project]\nname = "api2"\n' });
  const pypdf = commit({ "uv.lock": 'version = 1\n[[package]]\nname = "pypdf"\n' });
  const both = commit({ "uv.lock": "version = 1\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" });
  const deleted = commit({ "uv.lock": null });
  const line = async (a, b) => chainInstall(COMMAND, await lockfileInstalls({ git: realGit, root, fromSha: a, toSha: b }));
  assert.equal(await line(noLockfile, added), UV_CHAIN);
  assert.equal(await line(added, other), COMMAND);
  assert.equal(await line(other, pypdf), UV_CHAIN);
  assert.equal(await line(pypdf, both), BOTH_CHAIN);
  assert.equal(await line(both, deleted), COMMAND);
});

test("missingInstalls: a pnpm lockfile without a node_modules directory needs an install", async () => {
  const root = tempDir("sl-deps-");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  assert.deepEqual(await missingInstalls(root, io), ["pnpm"]);
  writeFileSync(join(root, "node_modules"), "not a dir");
  assert.deepEqual(await missingInstalls(root, io), ["pnpm"], "a file in its place is no install");
  rmSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules"));
  assert.deepEqual(await missingInstalls(root, io), []);
  assert.deepEqual(await missingInstalls(tempDir(), io), [], "no lockfile, nothing to install");
  assert.deepEqual(await missingInstalls(join(root, "gone"), io), []);
});

test("missingInstalls: a uv root syncs until .venv exists; both when node_modules is missing too", async () => {
  const root = tempDir("sl-uv-deps-");
  writeFileSync(join(root, "uv.lock"), "version = 1\n");
  assert.deepEqual(await missingInstalls(root, io), ["uv"]);
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  assert.deepEqual(await missingInstalls(root, io), ["pnpm", "uv"]);
  mkdirSync(join(root, ".venv"));
  assert.deepEqual(await missingInstalls(root, io), ["pnpm"]);
});

test("missingInstalls: a stat that fails for any reason but absence never asks for an install", async () => {
  const flaky = { kind: async (p) => (p.endsWith(".lock") || p.endsWith(".yaml") ? "file" : null), readText: async () => null, listDirs: async () => null };
  assert.deepEqual(await missingInstalls("/r", flaky), []);
  const broken = { kind: async () => { throw new Error("EACCES"); }, readText: async () => null, listDirs: async () => null };
  assert.deepEqual(await missingInstalls("/r", broken), []);
});

test("installsFor: a pending change and a missing install chain once, in order, unknown names dropped", () => {
  assert.deepEqual(installsFor(["pnpm"], ["pnpm"]), ["pnpm"]);
  assert.deepEqual(installsFor(["uv"], ["pnpm"]), ["pnpm", "uv"]);
  assert.deepEqual(installsFor(["npm", "rm -rf ~", "uv"], []), ["uv"]);
  assert.deepEqual(installsFor(null, undefined), []);
});

test("chainInstall: installs first, each only if the previous one succeeded", () => {
  assert.equal(chainInstall("pnpm dev", ["pnpm"]), PNPM_CHAIN);
  assert.equal(chainInstall(COMMAND, ["uv"]), UV_CHAIN);
  assert.equal(chainInstall(COMMAND, ["uv", "pnpm"]), BOTH_CHAIN);
  assert.equal(chainInstall(COMMAND, []), COMMAND);
  assert.equal(chainInstall(COMMAND, ["bogus"]), COMMAND);
});

// ── The port a start will take (T13, D23) ──────────────────────────────────
// Read before typing the server line, so a port someone else holds is caught
// first (D24). speaking-english's live incident: `pnpm dev` runs
// `npm-run-all --parallel dev:next dev:convex`, and dev:next is
// `next dev -p 3008`.

const SPEAKING_ENGLISH = {
  dev: "npm-run-all --parallel dev:next dev:convex",
  "dev:next": "next dev -p 3008",
  "dev:convex": "convex dev",
};

test("expectedPort: settings.port wins over what package.json says", async () => {
  const root = tempDir("sl-port-settings-");
  writePackageJson(root, { scripts: SPEAKING_ENGLISH });
  assert.equal(await expectedPort({ root, command: "pnpm dev --port 4100", settings: { port: 4100 }, io }), 4100);
  // An out-of-range port in settings is no port: package.json decides.
  assert.equal(await expectedPort({ root, command: "pnpm dev", settings: { port: 70000 }, io }), 3008);
});

test("expectedPort: next dev -p 3008 behind pnpm dev → npm-run-all --parallel dev:next dev:convex", async () => {
  const root = tempDir("sl-port-se-");
  writePackageJson(root, { scripts: SPEAKING_ENGLISH });
  assert.equal(await expectedPort({ root, command: "pnpm dev", settings: {}, io }), 3008);
  // npm-run-all's own -p (--parallel) is never read as a port.
  assert.equal(portFromCommand("pnpm dev", { ...SPEAKING_ENGLISH, dev: "npm-run-all -p dev:convex dev:next" }), 3008);
  // The lockfile install chained first changes nothing.
  assert.equal(portFromCommand("pnpm install --frozen-lockfile && pnpm dev", SPEAKING_ENGLISH), 3008);
});

test("expectedPort: --port=5173, --port N and PORT=4000 next dev", () => {
  assert.equal(portFromCommand("pnpm dev", { dev: "vite --port=5173" }), 5173);
  assert.equal(portFromCommand("npm run dev --", { dev: "astro dev --port 4321" }), 4321);
  assert.equal(portFromCommand("yarn dev", { dev: "PORT=4000 next dev" }), 4000);
  assert.equal(portFromCommand("bun run dev", { dev: "cross-env PORT=4000 next dev" }), 4000);
  // A flag on the server's line beats the PORT it inherits.
  assert.equal(portFromCommand("pnpm dev", { dev: "PORT=4000 next dev -p 3000" }), 3000);
  // A command typed in settings, straight to the server.
  assert.equal(portFromCommand("npx next dev -p 3001", {}), 3001);
  // Extra args reach the script, as npm, pnpm and yarn pass them.
  assert.equal(portFromCommand("pnpm dev --port 4000", { dev: "vite" }), 4000);
  assert.equal(portFromCommand("npm run dev -- -p 4001", { dev: "next dev" }), 4001);
  for (const server of ["nuxt dev", "remix vite:dev", "react-router dev", "webpack-dev-server", "serve"]) {
    assert.equal(portFromCommand("pnpm dev", { dev: `${server} --port 8123` }), 8123, server);
  }
});

test("expectedPort: run-p / run-s globs and concurrently's commands are followed", () => {
  const scripts = { "dev:api": "node api.js -p 9", "dev:web": "vite --port 5174" };
  assert.equal(portFromCommand("pnpm dev", { ...scripts, dev: "run-p dev:*" }), 5174);
  assert.equal(portFromCommand("pnpm dev", { ...scripts, dev: "run-s dev:api dev:web" }), 5174);
  assert.equal(portFromCommand("pnpm dev", { ...scripts, dev: 'concurrently -n api,web "convex dev" "next dev -p 3005"' }), 3005);
  assert.equal(portFromCommand("pnpm dev", { ...scripts, dev: 'concurrently -p "[{name}]" "npm:dev:*"' }), 5174);
});

test("expectedPort: unknown is null — no package.json, no port flag, a non-server line's -p, past 3 levels, a cycle", async () => {
  const empty = tempDir("sl-port-none-");
  assert.equal(await expectedPort({ root: empty, command: "pnpm dev", settings: {}, io }), null);
  assert.equal(await expectedPort({ root: empty, command: null, settings: {}, io }), null);
  assert.equal(portFromCommand("pnpm dev", { dev: "next dev" }), null);
  assert.equal(portFromCommand("pnpm dev", { dev: "node server.js -p 3000" }), null);
  assert.equal(portFromCommand("pnpm dev", { dev: "next dev -p notaport" }), null);
  assert.equal(portFromCommand("pnpm dev", { dev: "next dev -p 99999" }), null);
  assert.equal(portFromCommand("pnpm missing", { dev: "next dev -p 3000" }), null);
  // Three script levels are read; a fourth is not.
  const deep = { dev: "pnpm a", a: "pnpm b", b: "pnpm c", c: "next dev -p 3000" };
  assert.equal(portFromCommand("pnpm a", deep), 3000);
  assert.equal(portFromCommand("pnpm dev", deep), null);
  assert.equal(portFromCommand("pnpm dev", { dev: "pnpm loop", loop: "pnpm dev" }), null);
  assert.equal(portFromCommand("pnpm dev", null), null);
});
