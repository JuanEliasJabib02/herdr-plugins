// claude-accounts T1: only what stays true once every task has landed (D14).
// Each later task replaces a stub, so nothing here looks at what a command
// does: the CLI dispatches every command of its table, refuses an unknown
// command and a bad flag with 64, and prints its version; every module keeps
// the exports other tasks code against; main.js maps the six views. That the
// stubs exit 64 is shown only in T1's own run.
//
// The CLI runs in a sandbox, so a command that one day ignores a bad flag
// still can't reach the real state: HOME and CLAUDE_ACCOUNTS_HOME are tmp
// folders, PATH starts with shims (`security` says "absent", `hc`, `claude`
// and `claude-usage` fail), and the usage endpoint is a closed port.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MOD = new URL("../claude-accounts/mods/claude-accounts/", import.meta.url);
const BIN = fileURLToPath(new URL("bin/claude-accounts", MOD));
const source = (f) => readFileSync(new URL(f, MOD), "utf8");

// The final command table (D9, T1's What), in its order.
const COMMANDS = ["list", "use", "remove", "login", "import-orca", "settings", "usage", "terminal", "restart", "resume", "details"];

// ── The sandbox ────────────────────────────────────────────────────────────

const box = mkdtempSync(join(tmpdir(), "claude-accounts-smoke-"));
after(() => rmSync(box, { recursive: true, force: true }));
const shims = join(box, "bin");
mkdirSync(shims);
mkdirSync(join(box, "home"));
for (const [name, code] of [["security", 44], ["hc", 1], ["claude", 1], ["claude-usage", 1], ["open", 1]]) {
  writeFileSync(join(shims, name), `#!/bin/sh\nexit ${code}\n`);
  chmodSync(join(shims, name), 0o755);
}
const ENV = {
  HOME: join(box, "home"),
  PATH: [shims, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  TMPDIR: box,
  CLAUDE_ACCOUNTS_HOME: join(box, "state"),
  CLAUDE_ACCOUNTS_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
  CLAUDE_ACCOUNTS_USAGE_BIN: join(shims, "claude-usage"),
};

// Runs the installed form: the bin itself, through its shebang.
function cli(args) {
  const r = spawnSync(BIN, args, { env: ENV, encoding: "utf8", timeout: 20000 });
  if (r.error) throw r.error;
  return r;
}

// ── The CLI ────────────────────────────────────────────────────────────────

test("--version prints the version", () => {
  const r = cli(["--version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("an unknown command exits 64 and lists the command table", () => {
  const r = cli(["no-such-command"]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown command "no-such-command"/);
  const listed = r.stderr.match(/^commands: (.*)$/m);
  assert.ok(listed, "the usage lists the commands");
  assert.deepEqual(listed[1].split(", "), COMMANDS);
});

for (const command of COMMANDS) {
  test(`${command}: dispatched, and a bad flag exits 64`, () => {
    const r = cli([command, "--smoke-no-such-flag"]);
    assert.equal(r.status, 64, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /unknown command/);
  });
}

// ── Exports other tasks code against ───────────────────────────────────────
// Upper-case names are constants; the rest are functions.

function assertExports(mod, names, where) {
  for (const name of names) {
    assert.ok(name in mod, `${where} exports ${name}`);
    if (!/^[A-Z]/.test(name)) assert.equal(typeof mod[name], "function", `${where}: ${name} is a function`);
  }
}

const CLI_EXPORTS = {
  paths: ["FILES", "stateHome", "profilesHome", "statePath", "defaultConfigDir", "usageUrl", "usageBin", "cliPath"],
  files: ["withLock", "writeAtomic", "readJson", "rebuildContract"],
  accounts: ["list", "use", "remove", "login", "importOrca", "settings", "knownAccounts"],
  usage: ["usage", "contractUsage"],
  keychain: ["keychainService", "readCredentials"],
  terminals: ["terminal", "inspectTerminal"],
  restart: ["restart", "resume", "afterUse"],
  details: ["details"],
};

for (const [name, names] of Object.entries(CLI_EXPORTS)) {
  test(`cli/${name}.mjs exports its final names`, async () => {
    assertExports(await import(new URL(`cli/${name}.mjs`, MOD)), names, `cli/${name}.mjs`);
  });
}

// The mod's pure modules load outside Herdr (no herdr or gpui-kit import).
const PURE_EXPORTS = {
  format: ["formatPercent", "formatDuration", "formatResetsIn", "formatDate", "formatUpdated", "colorToken", "errorCopy", "densityLevel", "formatSince"],
  store: ["MOD", "FILES", "stateDir", "cliPath", "readAccounts", "readSettings", "readRestart", "readPendingSwitch", "readDetails", "readLoginLink", "classifyWatchPaths"],
  toasts: ["react"],
};

for (const [name, names] of Object.entries(PURE_EXPORTS)) {
  test(`${name}.js exports its final names`, async () => {
    assertExports(await import(new URL(`${name}.js`, MOD)), names, `${name}.js`);
  });
}

// A view file imports herdr, so it's read as text: its view class, and the
// function that opens it (the footer's is the refresh the others reuse).
const VIEWS = {
  footer: ["Footer", "refreshUsage"],
  popup: ["Popup", "openPopup"],
  panel: ["Panel", "openPanel"],
  accounts: ["Accounts", "openAccounts"],
  confirm: ["Confirm", "openConfirm"],
  details: ["Details", "openDetails"],
};

for (const [view, [cls, fn]] of Object.entries(VIEWS)) {
  test(`${view}.js exports ${cls} and ${fn}`, () => {
    const src = source(`${view}.js`);
    assert.match(src, new RegExp(`^export default class ${cls}\\b`, "m"));
    assert.match(src, new RegExp(`^export (async )?function ${fn}\\(`, "m"));
  });
}

test("main.js maps the six views, and a copy without one is the footer", () => {
  const src = source("main.js");
  for (const [view, [cls]] of Object.entries(VIEWS)) {
    assert.match(src, new RegExp(`^\\s+"?${view}"?:\\s*${cls},?$`, "m"), `"${view}" draws ${cls}`);
  }
  // scripts/check-views.sh rewrites this line to check each view.
  assert.match(src, /^const DEFAULT_VIEW = "footer";$/m);
});
