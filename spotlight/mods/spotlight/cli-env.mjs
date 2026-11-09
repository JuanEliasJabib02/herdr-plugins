// The CLI's reach into the world (D1, D7, D18): processes, git, hc, the
// state store, shared.json, the detached hand-off and the claude-accounts
// lookup. Node-only, like cli.mjs; the mod never imports it.
//
// Programs are called by bare name (hc, git, lsof, pgrep, herdr-app), so a
// fake earlier on PATH stands in for each in tests. Signals go through
// `serverDeps.kill` only.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore, appHomeDir } from "./store.js";
import { gitContext, runGit } from "./sync.js";
import { hasServerCommand, nodeIo } from "./server-plan.js";
import { normRoot } from "./settings.js";
import { taskOf, laneOf, SPACELESS } from "./task.js";
import { parseAccounts } from "./resume.js";

export const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

// D13: a usage read this recent decides a turn end on the spot.
export const USAGE_FRESH_MS = 2 * 60_000;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// A number from the environment, for the tests' shorter polls; else `fallback`.
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── Processes ──────────────────────────────────────────────────────────────

// Runs `file args` without a shell: { code, stdout, stderr }. A non-zero exit
// resolves with its code; a timeout resolves 124. Rejects only when the
// program can't start (ENOENT): server.js and ports.js read that as "can't
// tell", never as an answer. It takes no env, as Herdr's exec doesn't: a read
// that needs one carries it in its argv (ports.js psStatesArgv, H7).
export function exec(file, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
      if (err.killed || err.signal) return resolve({ code: 124, stdout, stderr: stderr || `${file} timed out` });
      reject(err);
    });
  });
}

// D18: the long work runs in a detached copy of this CLI, so whoever asked
// (Herdr's 30 s exec, the hook's 10 s) never waits on it. Its pid, or null.
export function spawnDetached(args) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

// ── git ────────────────────────────────────────────────────────────────────

// task.js's shape: (cwd, args) → { ok, out, err }, never rejects.
export async function taskGit(cwd, args) {
  try {
    const r = await runGit(args, cwd);
    return { ok: true, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ""), err: String(e?.stderr ?? e?.message ?? e) };
  }
}

// server-plan.js's shape: (cwd, args) → stdout, rejects when git fails.
export async function planGit(cwd, args) {
  return (await runGit(args, cwd)).stdout;
}

// The repo root (main checkout) of a folder: the shared .git's parent;
// null outside git.
export async function repoRootOf(dir) {
  const r = await taskGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = r.ok ? normRoot(r.out.trim()) : "";
  if (!common.startsWith("/")) return null;
  return common.endsWith("/.git") ? common.slice(0, -5) || "/" : common;
}

// The top folder of the checkout holding `dir`; null outside git.
export async function checkoutOf(dir) {
  const r = await taskGit(dir, ["rev-parse", "--show-toplevel"]);
  const top = r.ok ? normRoot(r.out.trim()) : "";
  return top.startsWith("/") ? top : null;
}

// A checkout's branch; null when detached or unreadable.
export async function branchOf(dir) {
  const r = await taskGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

// ── hc ─────────────────────────────────────────────────────────────────────

function parseJson(text) {
  try {
    const v = JSON.parse(String(text ?? "").trim());
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

// `hc get <t> --json`: { terminal }, { missing: true } (no such terminal:
// exit 3, not_found), or { error } when hc couldn't say. Doubt is never
// death: only `missing` reads as gone.
export async function hcGet(t) {
  let r;
  try {
    r = await exec("hc", ["get", t, "--json"], { timeoutMs: 10_000 });
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
  const json = parseJson(r.stdout) ?? parseJson(r.stderr);
  if (r.code === 0 && json && !json.error) return { terminal: json };
  if (r.code === 3 || json?.error?.kind === "not_found") return { missing: true };
  return { error: String(json?.error?.message ?? r.stderr ?? `hc exited ${r.code}`).trim() };
}

// The terminals task.js's pick reads: `hc ls --json` for every cwd, and
// `hc get` for status_ms (ls has none) of the ones running an agent. [] when
// hc can't list.
export async function terminalFacts() {
  let r;
  try {
    r = await exec("hc", ["ls", "--json"], { timeoutMs: 10_000 });
  } catch {
    return [];
  }
  const list = r.code === 0 ? parseJson(r.stdout)?.terminals : null;
  if (!Array.isArray(list)) return [];
  return Promise.all(
    list.map(async (t) => {
      if (!isObject(t) || Number.isFinite(t.status_ms) || !(t.agent || t.status)) return t;
      const got = await hcGet(t.address);
      return got.terminal ?? t;
    }),
  );
}

// `hc read <t> --lines N --json`'s text; null when hc can't say.
export async function hcReadText(t, lines) {
  try {
    const r = await exec("hc", ["read", t, "--lines", String(lines), "--json"], { timeoutMs: 10_000 });
    const text = r.code === 0 ? parseJson(r.stdout)?.text : null;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

// ── Files ──────────────────────────────────────────────────────────────────

// shared.json's values (read-only, AGENTS.md:88-90); {} when unreadable.
export function readShared(appHome) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(appHome, "shared.json"), "utf8"));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

// The roots of every project in a projects.v1 group (absolute, normalized).
export function registeredRoots(shared) {
  const reg = shared?.["projects.v1"];
  if (!isObject(reg) || !Array.isArray(reg.groups)) return [];
  const roots = [];
  for (const g of reg.groups) {
    for (const p of Array.isArray(g?.projects) ? g.projects : []) {
      const root = normRoot(p?.path);
      if (root.startsWith("/") && !roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

// How a repo is named in output: its projects.v1 name, else its folder.
export function repoNamer(shared) {
  const names = new Map();
  const reg = shared?.["projects.v1"];
  for (const g of Array.isArray(reg?.groups) ? reg.groups : []) {
    for (const p of Array.isArray(g?.projects) ? g.projects : []) {
      const root = normRoot(p?.path);
      if (root.startsWith("/") && typeof p.name === "string" && p.name && !names.has(root)) names.set(root, p.name);
    }
  }
  return (root) => names.get(normRoot(root)) ?? (normRoot(root).split("/").filter(Boolean).pop() || root);
}

// A workspace's task as the queue keys it, `<lane>/<taskKey>` (D12), for
// the variant remembered per task; null when the checkout names no task.
export async function taskKeyOfWorkspace(workspace, root, shared) {
  const branch = await branchOf(workspace);
  const task = taskOf({ path: workspace, branch, main: normRoot(workspace) === normRoot(root) });
  return task ? `${laneOf(shared?.["projects.v1"], root)}/${task.key}` : null;
}

// The task of a terminal whose folder names none (J-003): a main checkout
// (~/.claude), a folder outside git, or a worktree whose branch and folder
// can't name a task. It still takes a test turn, slot-only (it lights
// nothing), keyed by its folder, `cwd:<realpath>`, so two terminals in one
// folder share it; its lane is the projects.v1 group holding the repo the
// folder is in, else SPACELESS. resolveTask's shape.
export async function folderTask(cwd, shared) {
  let dir;
  try {
    dir = normRoot(fs.realpathSync(cwd));
  } catch {
    dir = normRoot(path.resolve(cwd));
  }
  const root = await repoRootOf(dir);
  return {
    ok: true,
    root,
    workspace: (root && (await checkoutOf(dir))) || dir,
    branch: null,
    taskKey: `cwd:${dir}`,
    label: path.basename(dir) || dir,
    lane: root ? laneOf(shared?.["projects.v1"], root) : SPACELESS,
    members: [],
    skipped: [],
    slotOnly: true,
  };
}

// ── claude-accounts (D13, D15) ─────────────────────────────────────────────

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The accounts plugin's CLI: installed in the app home, else on PATH; null
// when it isn't installed.
export function accountsBin(appHome) {
  const own = path.join(appHome, "mods", "claude-accounts", "bin", "claude-accounts");
  if (isExecutable(own)) return own;
  for (const dir of String(process.env.PATH ?? "").split(":")) {
    if (dir && isExecutable(path.join(dir, "claude-accounts"))) return path.join(dir, "claude-accounts");
  }
  return null;
}

const toMs = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);

// The accounts plugin's usage file (its CONTRACT.md).
export const accountsFileOf = (appHome) => path.join(appHome, "claude-accounts", "accounts.v1.json");

// The terminal's Claude account and where its usage stands, from the
// accounts plugin's contract (claude-accounts.md D9): `claude-accounts
// terminal <t> --json` → { account }, then accounts.v1.json. null when the
// plugin is absent, can't place the terminal (not Claude's), or wrote a file
// of another version (refused, D15): the caller then decides without it.
// Otherwise { account, signin, atLimit, fresh }:
// signin for exit 5 or an account that needs it; atLimit when some window
// is at 100% or more (Orca's paneAccountAtLimit); fresh when its usage was
// read under USAGE_FRESH_MS ago.
export async function accountUsage(terminal, { appHome, now }) {
  const bin = accountsBin(appHome);
  if (!bin) return null;
  let r;
  try {
    r = await exec(bin, ["terminal", terminal, "--json"], { timeoutMs: 5_000 });
  } catch {
    return null;
  }
  if (r.code === 5) return { account: null, signin: true, atLimit: false, fresh: true };
  if (r.code !== 0) return null;
  const raw = parseJson(r.stdout)?.account;
  const id = typeof raw === "string" ? raw : isObject(raw) && typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  let text = null;
  try {
    text = fs.readFileSync(accountsFileOf(appHome), "utf8");
  } catch {
    // No usage file: the usage is unknown, so a classify must read it.
  }
  const parsed = parseAccounts(text);
  // Another version of the file is refused (D15): decide as without the plugin.
  if (!parsed.ok && parsed.reason === "version") return null;
  const account = parsed.ok ? parsed.doc.accounts.find((a) => a.id === id) : null;
  if (!account) return { account: id, signin: false, atLimit: false, fresh: false };
  if (account.needsSignIn) return { account: id, signin: true, atLimit: false, fresh: true };
  const updated = toMs(account.usageUpdatedAt);
  const fresh = Number.isFinite(updated) && now - updated < USAGE_FRESH_MS;
  const windows = Object.values(isObject(account.usage) ? account.usage : {}).filter(isObject);
  const atLimit = windows.some((w) => Number(w.percent) >= 100);
  return { account: id, signin: false, atLimit, fresh };
}

// ── The context every verb gets ────────────────────────────────────────────

// Settings and shared.json are read once, on first use; `status` reads its
// settings itself (no backup write).
export function makeContext() {
  const appHome = appHomeDir();
  const io = nodeIo(fsp);
  const serverCheck = (root, repo) => hasServerCommand(root, io, repo);
  const store = createStore({ appHome, hasServerCommand: serverCheck });
  // `reap` must return in under a second (D18): it skips a repo whose lock
  // is busy (someone is working on it) instead of waiting.
  const reapStore = createStore({ appHome, hasServerCommand: serverCheck, locks: { repo: { timeoutMs: 300 } } });
  let settings = null;
  let shared = null;
  let namer = null;
  const cx = {
    appHome,
    store,
    reapStore,
    io,
    exec,
    gitCtx: gitContext(),
    taskGit,
    planGit,
    now: Date.now,
    sleep,
    spawn: spawnDetached,
    // Every signal Spotlight sends (a turn-off's leftovers, D26; Liberar
    // puerto y arrancar, D24) goes through `kill`, process.kill's shape.
    serverDeps: { exec, now: Date.now, sleep, kill: (pid, signal) => process.kill(pid, signal) },
    pollMs: envMs("SPOTLIGHT_POLL_MS", 2_500),
    portPollMs: envMs("SPOTLIGHT_PORT_POLL_MS", 2_500),
    graceMs: envMs("SPOTLIGHT_NO_SERVER_GRACE_MS", 15_000),
    get settings() {
      settings ??= store.readSettings().settings;
      return settings;
    },
    reloadSettings() {
      settings = store.readSettings().settings;
      return settings;
    },
    get shared() {
      shared ??= readShared(appHome);
      return shared;
    },
    nameOf: (root) => {
      namer ??= repoNamer(cx.shared);
      return namer(root);
    },
    accountUsage: (terminal) => accountUsage(terminal, { appHome, now: Date.now() }),
  };
  return cx;
}
