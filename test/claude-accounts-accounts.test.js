// claude-accounts T2: the accounts core (D2, D3, D9, D13). The registry and
// its Orca import, System default, list, use, remove, login (staging,
// provisioning, the duplicate check and the link capture), settings, the
// lock, atomic writes and the published accounts.v1.json against CONTRACT.md.
//
// Every run is the installed form, the bin through its shebang, inside a
// sandbox of its own: HOME and CLAUDE_ACCOUNTS_HOME are tmp folders, PATH
// starts with shims (`claude` is a fake `claude auth login`, `security` says
// "absent", `hc` and `claude-usage` fail), and Orca's settings DB is a
// fixture built with /usr/bin/sqlite3. Nothing here reaches the person's
// state: sandbox() asserts every path lies under this test's tmp root.
//
// `use` ends in restart.afterUse (T4's), so these tests read what `use`
// wrote, never its exit code: that belongs to T4.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const MOD = join(repo, "claude-accounts/mods/claude-accounts");
const BIN = join(MOD, "bin/claude-accounts");
const FILES_MJS = pathToFileURL(join(MOD, "cli/files.mjs")).href;
const CONTRACT_MD = join(repo, "claude-accounts/CONTRACT.md");
const FIXTURE_V1 = join(repo, "test/fixtures/claude-accounts/accounts.v1.json");

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-accounts-t2-")));
after(() => rmSync(root, { recursive: true, force: true }));

// ── Accounts used across tests (made up) ───────────────────────────────────

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const ORG_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ORG_B = "e4eaaaf2-d142-11e1-b3e4-080027620cdd";
const ANA = { emailAddress: "ana@example.com", organizationName: "Example Org", organizationUuid: ORG_A };
const BEN = { emailAddress: "ben@example.org", organizationName: "Acme", organizationUuid: ORG_B };

// ── The sandbox ────────────────────────────────────────────────────────────

// A fake `claude auth login --claudeai`. It records the CLAUDE_CONFIG_DIR it
// got and the state file it found, sleeps $FAKE_SLEEP seconds when set (a
// login left waiting), hands $FAKE_LINK to $BROWSER and copies
// the link the CLI captured, then signs in as $FAKE_EMAIL (when set) by
// writing oauthAccount into the state file, and exits $FAKE_EXIT.
const FAKE_CLAUDE = `#!/bin/sh
[ "$*" = "auth login --claudeai" ] || { echo "fake claude: unexpected args: $*" >&2; exit 2; }
printf '%s' "\${CLAUDE_CONFIG_DIR-<unset>}" > "$FAKE_OUT/config-dir"
state="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
[ -f "$state" ] && cp "$state" "$FAKE_OUT/state-before.json"
[ -n "\${FAKE_SLEEP:-}" ] && exec sleep "$FAKE_SLEEP"
if [ -n "\${FAKE_LINK:-}" ]; then
  "$BROWSER" "$FAKE_LINK"
  i=0
  while [ $i -lt "\${FAKE_LINK_WAIT:-50}" ] && [ ! -f "$CLAUDE_ACCOUNTS_HOME/login-link" ]; do sleep 0.1; i=$((i + 1)); done
  [ -f "$CLAUDE_ACCOUNTS_HOME/login-link" ] && cp "$CLAUDE_ACCOUNTS_HOME/login-link" "$FAKE_OUT/seen-link"
fi
if [ -n "\${FAKE_EMAIL:-}" ]; then
  node -e '
    import("node:fs").then((fs) => {
      const f = process.argv[1];
      let s = {};
      try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      s.oauthAccount = { emailAddress: process.env.FAKE_EMAIL, organizationName: process.env.FAKE_ORG || null, organizationUuid: process.env.FAKE_ORG_UUID || null };
      fs.writeFileSync(f, JSON.stringify(s));
    });
  ' "$state"
fi
exit "\${FAKE_EXIT:-0}"
`;

let n = 0;
function sandbox() {
  const box = join(root, String(++n));
  const home = join(box, "home");
  const state = join(box, "state");
  const out = join(box, "out");
  const shims = join(box, "bin");
  for (const dir of [home, out, shims]) mkdirSync(dir, { recursive: true });
  for (const [name, code] of [["security", 44], ["hc", 1], ["claude-usage", 1], ["open", 1]]) {
    writeFileSync(join(shims, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(shims, name), 0o755);
  }
  writeFileSync(join(shims, "claude"), FAKE_CLAUDE);
  chmodSync(join(shims, "claude"), 0o755);
  const env = {
    HOME: home,
    USER: "tester",
    PATH: [shims, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    TMPDIR: box,
    CLAUDE_ACCOUNTS_HOME: state,
    CLAUDE_ACCOUNTS_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
    CLAUDE_ACCOUNTS_USAGE_BIN: join(shims, "claude-usage"),
    FAKE_OUT: out,
  };
  for (const key of ["HOME", "TMPDIR", "CLAUDE_ACCOUNTS_HOME"]) {
    assert.ok(env[key].startsWith(`${root}/`), `a sandbox path, never the person's: ${key}=${env[key]}`);
  }
  const cli = (args, extra = {}) => {
    const r = spawnSync(BIN, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
    if (r.error) throw r.error;
    return r;
  };
  // The CLI in the background: { child, done }, done resolving to
  // { status, stdout, stderr }.
  const cliStart = (args, extra = {}) => {
    const child = spawn(BIN, args, { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { child, done };
  };
  const cliAsync = (args, extra = {}) => cliStart(args, extra).done;
  const read = (name) => readFileSync(join(state, name), "utf8");
  const registry = () => JSON.parse(read("accounts.json"));
  return { box, home, state, out, env, cli, cliStart, cliAsync, read, registry, profiles: join(box, "claude-accounts-profiles") };
}

// ── Orca, as it leaves the disk ────────────────────────────────────────────

const orcaRoot = (home, app = "Orca Dev") => join(home, "Library", "Application Support", app);

// A profile folder <root>/claude-profiles/<id>/home, signed in as `login`
// (an oauthAccount) when given. Returns its config dir, the exact string.
function orcaProfile(home, id, login, app) {
  const dir = join(orcaRoot(home, app), "claude-profiles", id, "home");
  mkdirSync(dir, { recursive: true });
  if (login) writeFileSync(join(dir, ".claude.json"), JSON.stringify({ theme: "dark", oauthAccount: login }));
  return dir;
}

// Orca's settings document in a fixture profile-state.db (rebuilt each call).
function orcaDb(home, payload, app) {
  const dir = join(orcaRoot(home, app), "profiles", "local-default");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "profile-state.db");
  rmSync(db, { force: true });
  const quoted = JSON.stringify(payload).replaceAll("'", "''");
  const sql = [
    "CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,",
    "domain_version INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL);",
    `INSERT INTO profile_state_documents VALUES ('ui', '{}', 1, 1, 0, 'u');`,
    `INSERT INTO profile_state_documents VALUES ('settings', '${quoted}', 1, 1, 0, 's');`,
  ].join(" ");
  const r = spawnSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

const orcaRow = (id, login, lastAuthenticatedAt) => ({
  id,
  email: login.emailAddress,
  organizationName: login.organizationName,
  organizationUuid: login.organizationUuid,
  managedAuthRuntime: "host",
  lastAuthenticatedAt,
});

// A registry written by hand: [{id, email, org, orgUuid, configDir, lastAuthenticatedAt, source}].
function writeRegistry(s, accounts, active = "", switchMode = "ask") {
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "accounts.json"), `${JSON.stringify(accounts, null, 2)}\n`);
  writeFileSync(join(s.state, "active"), active);
  writeFileSync(join(s.state, "settings.json"), JSON.stringify({ switchMode }));
}

// A signed-in config dir anywhere (for hand-written registries).
function signedInDir(dir, login) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: login }));
  return dir;
}

const listJson = (s) => {
  const r = s.cli(["list", "--json"]);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const byId = (doc, id) => doc.accounts.find((a) => a.id === id);

// ── The Orca import (D3) ───────────────────────────────────────────────────

test("first run: Orca's profiles come in from its settings DB, with email, org and date, and seed active and switchMode", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, { ...ANA, organizationName: "Stale name in the folder" });
  const dirB = orcaProfile(s.home, B, BEN);
  orcaProfile(s.home, C, { emailAddress: "stray@example.com" }); // a folder Orca no longer lists
  orcaDb(s.home, {
    claudeManagedAccounts: [
      orcaRow(A, ANA, 1793300000000),
      orcaRow(B, BEN, 1793658301633),
      orcaRow("dddddddd-4444-4444-8444-444444444444", ANA, 1), // a row whose folder is gone
    ],
    activeClaudeManagedAccountId: B,
    claudeAccountSwitchRunningSessions: "restart",
  });

  const doc = listJson(s);
  assert.equal(doc.active, B);
  assert.deepEqual(
    doc.accounts.map((a) => [a.id, a.email, a.org, a.lastAuthenticatedAt]),
    [
      ["default", null, null, null],
      [A, "ana@example.com", "Example Org", 1793300000000],
      [B, "ben@example.org", "Acme", 1793658301633],
    ],
  );
  assert.deepEqual(s.registry(), [
    { id: A, email: "ana@example.com", org: "Example Org", orgUuid: ORG_A, configDir: dirA, lastAuthenticatedAt: 1793300000000, source: "orca" },
    { id: B, email: "ben@example.org", org: "Acme", orgUuid: ORG_B, configDir: dirB, lastAuthenticatedAt: 1793658301633, source: "orca" },
  ]);
  assert.equal(s.read("active"), dirB, "the exact config dir, no newline");
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "restart" });
  // Orca's own files are never written.
  assert.ok(existsSync(join(orcaRoot(s.home), "claude-profiles", A, "home", ".claude.json")));
});

test("first run without Orca's DB: each folder's .claude.json, no date, and active from selected-host", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, ANA);
  const dirB = orcaProfile(s.home, B, BEN);
  orcaProfile(s.home, C, null); // never signed in: nothing to import
  writeFileSync(join(orcaRoot(s.home), "claude-profiles", "selected-host"), dirA);

  const doc = listJson(s);
  assert.equal(doc.active, A);
  assert.deepEqual(
    doc.accounts.map((a) => [a.id, a.email, a.org, a.lastAuthenticatedAt]),
    [
      ["default", null, null, null],
      [A, "ana@example.com", "Example Org", null],
      [B, "ben@example.org", "Acme", null],
    ],
  );
  assert.deepEqual(s.registry().map((a) => [a.id, a.configDir, a.orgUuid, a.source]), [
    [A, dirA, ORG_A, "orca"],
    [B, dirB, ORG_B, "orca"],
  ]);
  assert.equal(s.read("active"), dirA);
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "ask" }, "Orca's default without its settings");
});

test("first run with no Orca at all: only System default, active empty, switchMode ask", () => {
  const s = sandbox();
  const doc = listJson(s);
  assert.equal(doc.active, "default");
  assert.deepEqual(doc.accounts.map((a) => a.id), ["default"]);
  assert.deepEqual(s.registry(), []);
  assert.equal(s.read("active"), "");
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "ask" });
});

test("import-orca again: new Orca accounts and fresh metadata come in; active, switchMode and Herdr's accounts stay", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)], activeClaudeManagedAccountId: A, claudeAccountSwitchRunningSessions: "restart" });
  listJson(s);
  const herdr = { id: C, email: "cy@example.net", org: "Cy", orgUuid: null, configDir: join(s.profiles, C, "home"), lastAuthenticatedAt: 5, source: "herdr" };
  writeFileSync(join(s.state, "accounts.json"), JSON.stringify([...s.registry(), herdr]));
  s.cli(["use", "default"]);
  s.cli(["settings", "set", "switchMode", "keep"]);

  const dirB = orcaProfile(s.home, B, BEN);
  orcaDb(s.home, {
    claudeManagedAccounts: [orcaRow(A, { ...ANA, organizationName: "Renamed Org" }, 2), orcaRow(B, BEN, 3)],
    activeClaudeManagedAccountId: B,
    claudeAccountSwitchRunningSessions: "restart",
  });
  const r = s.cli(["import-orca", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { added: [B], updated: [A] });
  assert.deepEqual(s.registry().map((a) => [a.id, a.org, a.lastAuthenticatedAt, a.configDir, a.source]), [
    [A, "Renamed Org", 2, dirA, "orca"],
    [C, "Cy", 5, herdr.configDir, "herdr"],
    [B, "Acme", 3, dirB, "orca"],
  ]);
  assert.equal(s.read("active"), "", "not reseeded");
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "keep" }, "not reseeded");
});

// ── System default ─────────────────────────────────────────────────────────

test("a folder signed in as someone else (S8): the account keeps its saved names, signedInAs says who's there, and it needs sign-in", () => {
  const s = sandbox();
  orcaProfile(s.home, A, BEN); // A /login inside its Claude: saved as Ana, signed in as Ben.
  orcaProfile(s.home, B);
  orcaProfile(s.home, C, { ...BEN, emailAddress: "cal@example.net" });
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2), orcaRow(C, { ...BEN, emailAddress: "cal@example.net" }, 3)] });
  const doc = listJson(s);
  const a = byId(doc, A);
  assert.deepEqual([a.label, a.email, a.org], [ANA.emailAddress, ANA.emailAddress, ANA.organizationName]);
  assert.equal(a.signedInAs, BEN.emailAddress);
  assert.equal(a.needsSignIn, true);
  // No login in the folder: what was saved, and nobody to name.
  assert.deepEqual([byId(doc, B).email, byId(doc, B).signedInAs, byId(doc, B).needsSignIn], [BEN.emailAddress, null, true]);
  // Its own login: nothing changes.
  assert.deepEqual([byId(doc, C).email, byId(doc, C).signedInAs, byId(doc, C).needsSignIn], ["cal@example.net", null, false]);
  assert.equal(byId(doc, "default").signedInAs, null);
  assert.equal(new Set(doc.accounts.map((x) => x.label)).size, doc.accounts.length, "no two rows read the same because of it");
});

test("signedInAs: the same email in another org is another login; a missing org id on either side isn't, nor is a change of case; no saved email has nothing to compare", () => {
  const s = sandbox();
  const entry = (id, email, orgUuid, login) => ({ id, email, org: null, orgUuid, configDir: signedInDir(join(s.box, "dirs", id), login), lastAuthenticatedAt: 1, source: "orca" });
  const D = "dddddddd-4444-4444-8444-444444444444";
  const E = "eeeeeeee-5555-4555-8555-555555555555";
  writeRegistry(s, [
    entry(A, "ana@example.com", ORG_A, { emailAddress: "ana@example.com", organizationUuid: ORG_B }),
    entry(B, "ben@example.org", null, { emailAddress: "ben@example.org", organizationUuid: ORG_B }),
    entry(C, "cal@example.net", ORG_A, { emailAddress: "cal@example.net" }),
    entry(D, "dee@example.com", ORG_A, { emailAddress: " DEE@Example.com", organizationUuid: ORG_A }),
    entry(E, null, null, { emailAddress: "eve@example.com" }),
  ]);
  const doc = listJson(s);
  assert.deepEqual(doc.accounts.slice(1).map((a) => a.signedInAs), ["ana@example.com", null, null, null, null]);
  assert.deepEqual(doc.accounts.slice(1).map((a) => a.needsSignIn), [true, false, false, false, false]);
});

test("duplicateOf compares saved emails: a folder holding System default's login isn't a duplicate of it", () => {
  const s = sandbox();
  orcaProfile(s.home, A, BEN); // Saved as Ana, signed in as Ben.
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)] });
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: BEN }));
  assert.equal(byId(listJson(s), "default").duplicateOf, null);
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: ANA }));
  assert.equal(byId(listJson(s), "default").duplicateOf, A);
});

test("a folder signed in as someone else: `use` refuses it with 5, and signing in through the plugin updates the saved names", () => {
  const s = sandbox();
  const dir = orcaProfile(s.home, A, BEN);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)], activeClaudeManagedAccountId: B });
  listJson(s);
  const refused = s.cli(["use", A]);
  assert.equal(refused.status, 5);
  assert.match(refused.stderr, /Sign in to this Claude account again before selecting it\./);
  assert.notEqual(s.read("active"), dir);

  const signed = s.cli(["login", A], { FAKE_EMAIL: "ana.new@example.com", FAKE_ORG: "New Org", FAKE_ORG_UUID: ORG_A });
  assert.equal(signed.status, 0, signed.stderr);
  const a = byId(listJson(s), A);
  assert.deepEqual([a.label, a.email, a.org, a.signedInAs, a.needsSignIn], ["ana.new@example.com", "ana.new@example.com", "New Org", null, false]);
  assert.equal(s.cli(["use", A]).status, 0);
});

test("a successful login clears that account's usage: nothing read before it shows, for a saved account and for System default", () => {
  const s = sandbox();
  const dir = orcaProfile(s.home, A, ANA);
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: BEN }));
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)] });
  listJson(s);
  const now = Date.now();
  const resetsAt = now + 3_600_000;
  const entry = {
    usage: { session: { percent: 50, resetsAt }, weekly: null, fable: { percent: 22, resetsAt }, monthly: null },
    credits: { balance: 5, limit: 10 },
    source: "fetch",
    usageUpdatedAt: now,
    checkedAt: now,
  };
  writeFileSync(join(s.state, "usage-state.json"), JSON.stringify({ version: 1, accounts: { [A]: entry, default: entry } }));
  // The last drop of the login going away, never merged: live/ keeps it.
  const fiveHour = { five_hour: { used_percentage: 77, resets_at: Math.ceil(resetsAt / 1000) } };
  mkdirSync(join(s.state, "live"), { recursive: true });
  writeFileSync(join(s.state, "live", "a.json"), JSON.stringify({ configDir: dir, at: now - 1000, rate_limits: fiveHour }));
  writeFileSync(join(s.state, "live", "default.json"), JSON.stringify({ configDir: null, at: now - 1000, rate_limits: fiveHour }));
  assert.equal(byId(listJson(s), A).usage.session.percent, 50, "read before the sign-in");

  for (const target of [A, "default"]) {
    const r = s.cli(["login", target], { FAKE_EMAIL: "new@example.com" });
    assert.equal(r.status, 0, r.stderr);
  }
  const empty = { session: null, weekly: null, fable: null, monthly: null };
  const after = JSON.parse(s.cli(["usage", "--json"]).stdout);
  for (const id of [A, "default"]) {
    assert.deepEqual(byId(after, id).usage, empty, `${id}: no number from before`);
    assert.deepEqual([byId(after, id).credits, byId(after, id).usageUpdatedAt], [null, null]);
  }
});

test("System default comes from ~/.claude.json, and flags a saved account with the same email (Orca's notice)", () => {
  const s = sandbox();
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: { ...ANA, emailAddress: " ANA@Example.com" } }));
  orcaProfile(s.home, A, ANA);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)] });

  const doc = listJson(s);
  const def = byId(doc, "default");
  assert.deepEqual(
    { label: def.label, email: def.email, org: def.org, configDir: def.configDir, isDefault: def.isDefault, duplicateOf: def.duplicateOf },
    { label: "System default", email: "ANA@Example.com", org: "Example Org", configDir: null, isDefault: true, duplicateOf: A },
  );
  assert.equal(byId(doc, A).duplicateOf, null);
  assert.equal(byId(doc, A).isDefault, false);
  assert.equal(byId(doc, A).label, "ana@example.com");

  // Signed in as someone no saved account is: no notice.
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "zed@example.com" } }));
  assert.equal(byId(listJson(s), "default").duplicateOf, null);
});

test("an account whose folder holds no login reads as needing sign-in, and `use` refuses it with 5", () => {
  const s = sandbox();
  orcaProfile(s.home, A, ANA);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)], activeClaudeManagedAccountId: A });
  listJson(s);
  writeFileSync(join(orcaRoot(s.home), "claude-profiles", B, "home", ".claude.json"), JSON.stringify({ theme: "dark" }));

  const doc = listJson(s);
  assert.equal(byId(doc, A).needsSignIn, false);
  assert.equal(byId(doc, B).needsSignIn, true);
  assert.equal(byId(doc, "default").needsSignIn, true, "no ~/.claude.json login");
  const before = s.read("active");
  const r = s.cli(["use", B]);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /Sign in to this Claude account again before selecting it\./);
  assert.equal(s.read("active"), before);
});

// ── use and remove ─────────────────────────────────────────────────────────

test("use writes the account's exact config dir (spaces, no trailing slash, no newline), and default writes it empty", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, ANA);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)], activeClaudeManagedAccountId: B });
  listJson(s);
  assert.match(dirA, / /, "the fixture path has a space (Application Support)");

  s.cli(["use", A]);
  assert.equal(s.read("active"), dirA);
  assert.ok(!s.read("active").endsWith("/") && !s.read("active").endsWith("\n"));
  assert.equal(JSON.parse(s.read("accounts.v1.json")).active, A, "the contract follows `active`");

  s.cli(["use", "default"]);
  assert.equal(s.read("active"), "");
  assert.equal(JSON.parse(s.read("accounts.v1.json")).active, "default");

  // A registry string is used as written, never normalized.
  const odd = signedInDir(join(s.box, "odd  place", "Ünïcode dir", "home"), BEN);
  writeFileSync(join(s.state, "accounts.json"), JSON.stringify([{ id: C, email: "ben@example.org", org: "Acme", orgUuid: ORG_B, configDir: odd, lastAuthenticatedAt: null, source: "herdr" }]));
  s.cli(["use", C]);
  assert.equal(s.read("active"), odd);
});

test("use to another account starts reading its usage at once, without waiting for it; to the same one it starts nothing (D22)", async () => {
  const s = sandbox();
  orcaProfile(s.home, A, ANA);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)], activeClaudeManagedAccountId: A });
  listJson(s);
  const state = () => (existsSync(join(s.state, "usage-state.json")) ? JSON.parse(s.read("usage-state.json")).accounts ?? {} : {});

  // The same account: nothing to read.
  assert.equal(s.cli(["use", A]).status, 0);
  await sleep(1500);
  assert.deepEqual(Object.keys(state()), []);

  const started = Date.now();
  const r = s.cli(["use", B, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 8000, "use doesn't wait for the read");
  // The read runs on its own: only B's, here with no login in the Keychain.
  const read = () => state()[B]?.needsSignIn === true;
  const deadline = Date.now() + 10_000;
  while (!read() && Date.now() < deadline) await sleep(100);
  assert.ok(read(), `B's usage was read: ${JSON.stringify(state()[B])}`);
  assert.equal(state()[A], undefined, "only the new account's");
});

test("use refuses an unknown account with 7 and a missing id with 64, writing nothing", () => {
  const s = sandbox();
  listJson(s);
  const r = s.cli(["use", "no-such-account"]);
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stderr, /unknown account "no-such-account"/);
  assert.equal(s.cli(["use"]).status, 64);
  assert.equal(s.cli(["use", "a", "b"]).status, 64);
  assert.equal(s.read("active"), "");
});

test("removing the active account falls back to System default; an Orca account's folder stays", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, ANA);
  orcaProfile(s.home, B, BEN);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1), orcaRow(B, BEN, 2)], activeClaudeManagedAccountId: A });
  listJson(s);
  assert.equal(s.read("active"), dirA);

  const r = s.cli(["remove", A, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { removed: A, active: "default", folderDeleted: false });
  assert.equal(s.read("active"), "");
  assert.deepEqual(s.registry().map((a) => a.id), [B]);
  const doc = JSON.parse(s.read("accounts.v1.json"));
  assert.equal(doc.active, "default");
  assert.deepEqual(doc.accounts.map((a) => a.id), ["default", B]);
  assert.ok(existsSync(join(dirA, ".claude.json")), "Orca's folder is never deleted");

  assert.equal(s.cli(["remove", A]).status, 7, "already gone");
  assert.equal(s.cli(["remove", "default"]).status, 64, "System default can't be removed");
});

test("remove deletes the folder only of an account added here, and only inside the profiles folder", () => {
  const s = sandbox();
  const own = signedInDir(join(s.profiles, A, "home"), ANA);
  const orca = signedInDir(join(s.box, "orca-ish", B, "home"), BEN);
  const stray = signedInDir(join(s.box, "elsewhere", C, "home"), ANA);
  writeRegistry(s, [
    { id: A, email: "ana@example.com", org: "Example Org", orgUuid: ORG_A, configDir: own, lastAuthenticatedAt: 1, source: "herdr" },
    { id: B, email: "ben@example.org", org: "Acme", orgUuid: ORG_B, configDir: orca, lastAuthenticatedAt: 2, source: "orca" },
    { id: C, email: "ana@example.com", org: "Other", orgUuid: null, configDir: stray, lastAuthenticatedAt: 3, source: "herdr" },
  ], orca);

  const r = s.cli(["remove", A, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { removed: A, active: B, folderDeleted: true });
  assert.ok(!existsSync(join(s.profiles, A)), "the whole <profiles>/<id> folder goes");
  assert.equal(s.read("active"), orca, "removing another account leaves active alone");

  assert.equal(s.cli(["remove", B]).status, 0);
  assert.ok(existsSync(orca), "source orca: the folder stays");

  const rc = s.cli(["remove", C, "--json"]);
  assert.equal(rc.status, 0, rc.stderr);
  assert.equal(JSON.parse(rc.stdout).folderDeleted, false);
  assert.ok(existsSync(stray), "a herdr account outside the profiles folder keeps its folder");
  assert.deepEqual(s.registry(), []);
});

// ── login (D3, D13) ────────────────────────────────────────────────────────

// A ~/.claude with some of the shared entries, and a ~/.claude.json holding
// account-bound keys next to shareable ones.
function personalClaude(s) {
  const dot = join(s.home, ".claude");
  mkdirSync(join(dot, "agents"), { recursive: true });
  mkdirSync(join(dot, "skills"), { recursive: true });
  mkdirSync(join(dot, "sessions"), { recursive: true });
  writeFileSync(join(dot, "settings.json"), "{}");
  writeFileSync(join(dot, "history.jsonl"), "");
  writeFileSync(join(dot, "odd-trial.md"), "");
  writeFileSync(join(dot, "CLAUDE.md"), "# mine\n");
  writeFileSync(join(dot, ".credentials.json"), "{}");
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({
    theme: "dark",
    projects: { "/code/app": { hasTrustDialogAccepted: true } },
    oauthAccount: ANA,
    userID: "u-1",
    primaryApiKey: "sk-fake",
    cachedUsageUtilization: 1,
    groveConfigCache: {},
    passesEligibilityCache: {},
    hasAvailableSubscription: true,
    subscriptionNoticeCount: 2,
  }));
  return dot;
}

test("login new: a provisioned staging folder signs in and is registered as a Herdr account", () => {
  const s = sandbox();
  const dot = personalClaude(s);
  listJson(s);
  const start = Date.now();
  const r = s.cli(["login", "new", "--json"], { FAKE_EMAIL: "cy@example.net", FAKE_ORG: "Cy Org", FAKE_ORG_UUID: "org-cy", CLAUDE_CONFIG_DIR: "/should/be/replaced" });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

  const [added] = s.registry();
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...added, id: "<uuid>", lastAuthenticatedAt: "<now>" }, {
    id: "<uuid>", email: "cy@example.net", org: "Cy Org", orgUuid: "org-cy",
    configDir: join(s.profiles, added.id, "home"), lastAuthenticatedAt: "<now>", source: "herdr",
  });
  assert.ok(added.lastAuthenticatedAt >= start && added.lastAuthenticatedAt <= Date.now());
  assert.equal(readFileSync(join(s.out, "config-dir"), "utf8"), added.configDir, "claude ran on the staging folder");
  assert.deepEqual(JSON.parse(r.stdout), { account: added.id, email: "cy@example.net", org: "Cy Org" });
  assert.ok(byId(JSON.parse(s.read("accounts.v1.json")), added.id), "published");

  // Only the shared entries that exist in ~/.claude, each a link to it.
  const home = added.configDir;
  const links = readdirSync(home).filter((name) => lstatSync(join(home, name)).isSymbolicLink()).sort();
  assert.deepEqual(links, ["agents", "history.jsonl", "odd-trial.md", "settings.json", "skills"]);
  for (const name of links) assert.equal(readlinkSync(join(home, name)), join(dot, name));
  assert.equal(readFileSync(join(home, "CLAUDE.md"), "utf8"), "@~/.claude/CLAUDE.md\n");
  assert.ok(!existsSync(join(home, "sessions")) && !existsSync(join(home, ".credentials.json")), "per-account state stays out");

  // .claude.json as the login found it: shareable keys only.
  const copied = JSON.parse(readFileSync(join(s.out, "state-before.json"), "utf8"));
  assert.deepEqual(copied, { theme: "dark", projects: { "/code/app": { hasTrustDialogAccepted: true } } });
  assert.equal(statSync(join(home, ".claude.json")).mode & 0o777, 0o600);
});

test("login new: a failed login, a login with no account, and a duplicate each remove the staging folder", () => {
  const s = sandbox();
  personalClaude(s);
  orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)] });
  listJson(s);
  const before = s.read("accounts.json");
  const staged = () => (existsSync(s.profiles) ? readdirSync(s.profiles) : []);

  const failed = s.cli(["login", "new"], { FAKE_EXIT: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Claude sign-in failed\. Please try again\./);
  assert.deepEqual(staged(), []);

  const nobody = s.cli(["login", "new"]);
  assert.equal(nobody.status, 1);
  assert.match(nobody.stderr, /could not resolve the account email/);
  assert.deepEqual(staged(), []);

  const dup = s.cli(["login", "new"], { FAKE_EMAIL: "ANA@example.com", FAKE_ORG: "Example Org", FAKE_ORG_UUID: ORG_A });
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /This Claude account is already added\./);
  assert.deepEqual(staged(), []);
  assert.equal(s.read("accounts.json"), before, "the registry is untouched");

  // Same email in another org is another account, as in Orca.
  const other = s.cli(["login", "new"], { FAKE_EMAIL: "ana@example.com", FAKE_ORG: "Second", FAKE_ORG_UUID: "org-2" });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(staged().length, 1);
  assert.equal(s.registry().length, 2);
});

test("closing the login's tab (SIGHUP) cancels it: Claude is stopped, the staging folder goes, exit 130", async () => {
  const s = sandbox();
  listJson(s);
  const { child, done } = s.cliStart(["login", "new"], { FAKE_SLEEP: "30" });
  const started = join(s.out, "config-dir");
  for (let i = 0; i < 100 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(started), "the fake claude started");
  assert.equal(readdirSync(s.profiles).length, 1, "the staging folder exists while it signs in");
  const t0 = Date.now();
  child.kill("SIGHUP");
  const r = await done;
  assert.equal(r.status, 130, r.stderr);
  assert.match(r.stderr, /Sign-in cancelled\./);
  assert.ok(Date.now() - t0 < 5000, "it doesn't wait for the 30 s login");
  assert.deepEqual(readdirSync(s.profiles), []);
  assert.deepEqual(s.registry(), []);
});

test("login <id> signs in again in place and records the date; login default runs with CLAUDE_CONFIG_DIR unset", () => {
  const s = sandbox();
  const dirA = orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)] });
  listJson(s);
  const start = Date.now();
  const r = s.cli(["login", A], { FAKE_EMAIL: "ana@example.com", FAKE_ORG: "New Name", FAKE_ORG_UUID: ORG_A });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(s.out, "config-dir"), "utf8"), dirA);
  const [a] = s.registry();
  assert.equal(a.org, "New Name");
  assert.equal(a.configDir, dirA);
  assert.equal(a.source, "orca");
  assert.ok(a.lastAuthenticatedAt >= start);

  const d = s.cli(["login", "default"], { FAKE_EMAIL: "zed@example.com", CLAUDE_CONFIG_DIR: join(s.box, "inherited") });
  assert.equal(d.status, 0, d.stderr);
  assert.equal(readFileSync(join(s.out, "config-dir"), "utf8"), "<unset>");
  assert.equal(byId(JSON.parse(s.read("accounts.v1.json")), "default").email, "zed@example.com");

  assert.equal(s.cli(["login", "no-such-account"]).status, 7);
  assert.equal(s.cli(["login"]).status, 64);
});

test("login --link keeps a valid one-click link in login-link and drops a bad one", () => {
  const s = sandbox();
  orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)] });
  listJson(s);
  const good = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=x";
  const r = s.cli(["login", A, "--link"], { FAKE_LINK: good, FAKE_EMAIL: "ana@example.com" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(s.out, "seen-link"), "utf8"), good);
  assert.ok(!existsSync(join(s.state, "login-link")), "a finished login leaves no link behind");

  rmSync(join(s.out, "seen-link"));
  for (const bad of [
    "http://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://evil.example/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback",
    "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcallback",
  ]) {
    const rb = s.cli(["login", A, "--link"], { FAKE_LINK: bad, FAKE_LINK_WAIT: "10", FAKE_EMAIL: "ana@example.com" });
    assert.equal(rb.status, 0, rb.stderr);
    assert.ok(!existsSync(join(s.out, "seen-link")), `dropped: ${bad}`);
    assert.match(rb.stderr, /unexpected sign-in link/);
  }
  assert.deepEqual(readdirSync(s.box).filter((f) => f.startsWith("claude-accounts-link-")), [], "the BROWSER helper is cleaned up");
});

// ── settings ───────────────────────────────────────────────────────────────

test("settings reads and sets switchMode; a bad value exits 64 and writes nothing", () => {
  const s = sandbox();
  const r = s.cli(["settings", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { switchMode: "ask" });
  const set = s.cli(["settings", "set", "switchMode", "restart", "--json"]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), { switchMode: "restart" });
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "restart" });
  assert.equal(s.cli(["settings", "set", "switchMode", "sometimes"]).status, 64);
  assert.equal(s.cli(["settings", "set", "colour", "red"]).status, 64);
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "restart" });
});

// ── accounts.v1.json and CONTRACT.md (D9) ──────────────────────────────────

// The field names of the table under a CONTRACT.md heading.
function contractFields(heading) {
  const md = readFileSync(CONTRACT_MD, "utf8");
  const start = md.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `CONTRACT.md has "${heading}"`);
  const section = md.slice(start + heading.length + 2).split(/\n#{1,4} /)[0];
  return [...section.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]);
}

test("accounts.v1.json carries exactly the fields of CONTRACT.md's tables, and so does the pinned fixture", () => {
  const s = sandbox();
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ oauthAccount: ANA }));
  orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)], activeClaudeManagedAccountId: A });
  const doc = listJson(s);
  assert.deepEqual(JSON.parse(s.read("accounts.v1.json")), doc, "list --json prints the published file");

  const top = contractFields("### Top level");
  const account = contractFields("### Each account");
  const usage = contractFields("### Each usage window");
  assert.deepEqual(Object.keys(doc), top);
  for (const a of doc.accounts) {
    assert.deepEqual(Object.keys(a), account, `account ${a.id}`);
    assert.deepEqual(Object.keys(a.usage), ["session", "weekly", "fable", "monthly"]);
  }
  assert.equal(doc.version, 1);
  assert.ok(Number.isInteger(doc.updatedAt));
  assert.equal(doc.active, A);

  // The fixture other tasks test against says nothing CONTRACT.md doesn't.
  const fixture = JSON.parse(readFileSync(FIXTURE_V1, "utf8"));
  assert.deepEqual(Object.keys(fixture), top);
  for (const a of fixture.accounts) {
    for (const key of Object.keys(a)) assert.ok(account.includes(key), `fixture field ${key} is in CONTRACT.md`);
    for (const w of Object.values(a.usage).filter(Boolean)) assert.deepEqual(Object.keys(w), usage);
  }
});

test("a rebuild that changes nothing leaves accounts.v1.json alone (same inode, same mtime); a change rewrites it", () => {
  const s = sandbox();
  orcaProfile(s.home, A, ANA);
  orcaDb(s.home, { claudeManagedAccounts: [orcaRow(A, ANA, 1)], activeClaudeManagedAccountId: A });
  listJson(s);
  const file = join(s.state, "accounts.v1.json");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const before = statSync(file);
  const text = s.read("accounts.v1.json");
  listJson(s);
  s.cli(["use", A]);
  const after = statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(s.read("accounts.v1.json"), text);

  s.cli(["use", "default"]);
  const changed = JSON.parse(s.read("accounts.v1.json"));
  assert.equal(changed.active, "default");
  assert.ok(changed.updatedAt > JSON.parse(text).updatedAt);
});

// ── The lock and the writes (D2) ───────────────────────────────────────────

test("the lock: concurrent processes all land their read-modify-write, and a nested withLock doesn't deadlock", async () => {
  const s = sandbox();
  mkdirSync(s.state, { recursive: true });
  const counter = join(s.box, "counter");
  writeFileSync(counter, "0");
  const script = join(s.box, "locker.mjs");
  writeFileSync(script, `
    import { withLock } from ${JSON.stringify(FILES_MJS)};
    import { readFileSync, writeFileSync } from "node:fs";
    const [home, counter, times] = process.argv.slice(2);
    for (let i = 0; i < Number(times); i++) {
      await withLock(home, async () => {
        const n = Number(readFileSync(counter, "utf8"));
        await new Promise((r) => setTimeout(r, 2));
        writeFileSync(counter, String(n + 1));
      });
    }
  `);
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, s.state, counter, "15"], { stdio: "inherit" });
      child.on("close", resolve);
    });
  assert.deepEqual(await Promise.all([run(), run(), run()]), [0, 0, 0]);
  assert.equal(readFileSync(counter, "utf8"), "45");
  assert.ok(!existsSync(join(s.state, "lock")), "released");

  const { withLock } = await import(FILES_MJS);
  assert.equal(await withLock(s.state, () => withLock(s.state, async () => 42)), 42);
  assert.ok(!existsSync(join(s.state, "lock")));
});

test("the lock: two CLIs removing different accounts at once both land", async () => {
  const s = sandbox();
  const ids = [A, B, C, "dddddddd-4444-4444-8444-444444444444", "eeeeeeee-5555-4555-8555-555555555555", "ffffffff-6666-4666-8666-666666666666"];
  writeRegistry(s, ids.map((id, i) => ({ id, email: `u${i}@example.com`, org: null, orgUuid: null, configDir: signedInDir(join(s.box, "dirs", id), { emailAddress: `u${i}@example.com` }), lastAuthenticatedAt: i, source: "orca" })));
  const results = await Promise.all(ids.map((id) => s.cliAsync(["remove", id])));
  assert.deepEqual(results.map((r) => r.status), ids.map(() => 0), results.map((r) => r.stderr).join("\n"));
  assert.deepEqual(s.registry(), []);
  assert.deepEqual(JSON.parse(s.read("accounts.v1.json")).accounts.map((a) => a.id), ["default"]);
});

test("the lock: one left by a dead process, or older than 60 s, is removed", () => {
  const s = sandbox();
  listJson(s);
  const lock = join(s.state, "lock");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(dead));
  const t0 = Date.now();
  const r = s.cli(["settings", "set", "switchMode", "keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(!existsSync(lock));

  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid)); // alive, but stuck
  const old = new Date(Date.now() - 61_000);
  utimesSync(join(lock, "pid"), old, old);
  utimesSync(lock, old, old);
  const r2 = s.cli(["settings", "set", "switchMode", "ask"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!existsSync(lock));
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "ask" });
});

test("the lock: a folder with no pid file is dead after 2 s, not after 60 s, and a fresh one is waited for", () => {
  const s = sandbox();
  listJson(s);
  const lock = join(s.state, "lock");
  mkdirSync(lock); // Its process died before it wrote its pid.
  const t0 = Date.now();
  const r = s.cli(["settings", "set", "switchMode", "keep"]);
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms >= 1900, `waited out the grace: ${ms} ms`);
  assert.ok(!existsSync(lock));
  assert.deepEqual(JSON.parse(s.read("settings.json")), { switchMode: "keep" });
});

// A script that makes writing the lock's pid file fail, then takes the lock.
// `body` runs with `withLock` and `home`; it prints what the test checks.
function lockScript(s, failWith, body) {
  const script = join(s.box, "pid-fails.mjs");
  writeFileSync(script, `
    import fsp from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const real = fsp.writeFile;
    let failures = 1;
    fsp.writeFile = async (path, ...rest) => {
      if (String(path).endsWith("/lock/pid") && failures-- > 0) ${failWith}
      return real(path, ...rest);
    };
    syncBuiltinESMExports();
    const { withLock } = await import(${JSON.stringify(FILES_MJS)});
    const home = process.argv[2];
    ${body}
  `);
  const r = spawnSync(process.execPath, [script, s.state], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("the lock: a pid that can't be written takes its folder with it, so nobody waits on it", () => {
  const s = sandbox();
  mkdirSync(s.state, { recursive: true });
  const out = lockScript(s, `throw Object.assign(new Error("no space"), { code: "ENOSPC" });`, `
    const first = await withLock(home, async () => "held").catch((e) => e.code);
    const { existsSync } = await import("node:fs");
    console.log(JSON.stringify({ first, left: existsSync(home + "/lock") }));
  `);
  assert.deepEqual(JSON.parse(out), { first: "ENOSPC", left: false });
});

test("the lock: a holder too slow to write its pid, whose folder was broken meanwhile, takes the lock again", () => {
  const s = sandbox();
  mkdirSync(s.state, { recursive: true });
  const out = lockScript(s, `{ await fsp.rm(String(path).slice(0, -"/pid".length), { recursive: true }); throw Object.assign(new Error("gone"), { code: "ENOENT" }); }`, `
    const first = await withLock(home, async () => "held").catch((e) => e.code);
    console.log(JSON.stringify({ first }));
  `);
  assert.deepEqual(JSON.parse(out), { first: "held" });
  assert.ok(!existsSync(join(s.state, "lock")), "released");
});

// ── The stated Node version ────────────────────────────────────────────────

test("the stated Node version covers module.registerHooks (22.15): package.json and the docs agree", () => {
  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).engines.node, ">=22.15");
  for (const doc of [CONTRACT_MD, join(repo, "claude-accounts/RECIPE.md")]) {
    const text = readFileSync(doc, "utf8");
    assert.match(text, /Node 22\.15 or newer/, doc);
    assert.doesNotMatch(text, /Node 22 or newer/, doc);
  }
});

test("a corrupt accounts.json gives a clear error and is never overwritten", () => {
  const s = sandbox();
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "accounts.json"), "[{ not json");
  for (const args of [["list", "--json"], ["use", "default"], ["import-orca"]]) {
    const r = s.cli(args);
    assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /accounts\.json.*not valid JSON/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "a message, not a stack");
  }
  assert.equal(s.read("accounts.json"), "[{ not json");
  assert.ok(!existsSync(join(s.state, "accounts.v1.json")));
  assert.ok(!existsSync(join(s.state, "lock")), "the lock is released on the way out");

  writeFileSync(join(s.state, "accounts.json"), '{"not":"a list"}');
  const r = s.cli(["list"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /accounts\.json.*a list of accounts/);
});
