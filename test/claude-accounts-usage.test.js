// claude-accounts T3: usage (D2, D4, D9, D14, D16). The Keychain read with
// Orca's limits and the credentials-file fallback, the usage request and its
// parsing in Orca's order (credits and the monthly window too), the error
// enum, the cadence and expiry rules, the fetch claims, the live/ drops from
// the statusline, the lock released across the network, and contractUsage's
// part of accounts.v1.json.
//
// Every CLI run is the installed form, the bin through its shebang, inside a
// sandbox of its own: HOME and CLAUDE_ACCOUNTS_HOME are tmp folders, the
// usage endpoint is a local http server (CLAUDE_ACCOUNTS_USAGE_URL), and
// `security` is a shim reading fake items from the sandbox. PATH holds only
// the shims, node's folder and /bin, none of which has the real `security`
// (/usr/bin/security), so no run can reach the real Keychain. The tokens are
// made up, all marked FAKE-T3, and the last test checks that none reaches
// stdout, stderr or a file the CLI wrote.
//
// usage-state.json's shape is private to usage.mjs; these tests seed and
// read it only to set the clock back (checkedAt, usageUpdatedAt, claims)
// without waiting.
import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const MOD = join(repo, "claude-accounts/mods/claude-accounts");
const BIN = join(MOD, "bin/claude-accounts");
const cliModule = (name) => import(pathToFileURL(join(MOD, "cli", `${name}.mjs`)).href);

// The real Keychain stays out of reach: the CLI finds `security` on PATH.
const NODE_DIR = dirname(process.execPath);
for (const dir of [NODE_DIR, "/bin"]) {
  assert.ok(!existsSync(join(dir, "security")), `no real security in ${dir}: the sandbox PATH relies on it`);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-accounts-t3-")));
after(() => rmSync(root, { recursive: true, force: true }));

// Every stdout and stderr of every run, and every token the endpoint got,
// for the leak check at the end.
const outputs = [];
const seenTokens = new Set();

// ── Made-up accounts and tokens ────────────────────────────────────────────

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const TOKEN = {
  default: "sk-ant-oat01-FAKE-T3-dddd-0123456789abcdef",
  [A]: "sk-ant-oat01-FAKE-T3-aaaa-0123456789abcdef",
  [B]: "sk-ant-oat01-FAKE-T3-bbbb-0123456789abcdef",
  file: "sk-ant-oat01-FAKE-T3-file-0123456789abcdef",
};
const LEAK = /FAKE-T3/;

const MIN = 60_000;
const HOUR = 60 * MIN;
const sha8 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);
const serviceOf = (configDir) => (configDir ? `Claude Code-credentials-${sha8(configDir.normalize("NFC"))}` : "Claude Code-credentials");

// Reset times in the future, in seconds (as the endpoint and the statusline
// send them) and in ms (as the contract stores them).
const RESET_5H_S = Math.ceil((Date.now() + 3 * HOUR) / 1000);
const RESET_WK_S = Math.ceil((Date.now() + 4 * 24 * HOUR) / 1000);
const RESET_5H = RESET_5H_S * 1000;
const RESET_WK = RESET_WK_S * 1000;
const win = (percent, resetsAt) => ({ percent, resetsAt });

// Claude's credentials JSON, as the Keychain item and .credentials.json hold it.
const oauth = (accessToken, extra = {}) => ({
  claudeAiOauth: {
    accessToken,
    refreshToken: "sk-ant-ort01-FAKE-T3-refresh",
    expiresAt: Date.now() + HOUR,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    ...extra,
  },
});

// ── The sandbox ────────────────────────────────────────────────────────────

// A fake macOS `security find-generic-password -s <service> -a <user> -w`.
// $SHIM_ITEMS/<service>.json is the item, printed; <service>.hang hangs;
// <service>.fail fails; anything else is absent (exit 44, as the real one).
// Each call's args (never a token) go to calls.log.
const SECURITY = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_ITEMS/calls.log"
[ "$1" = find-generic-password ] || exit 2
svc=
while [ $# -gt 0 ]; do
  case $1 in
    -s) svc=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -e "$SHIM_ITEMS/$svc.hang" ] && exec sleep 20
if [ -e "$SHIM_ITEMS/$svc.fail" ]; then
  echo "security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct." >&2
  exit 51
fi
if [ ! -f "$SHIM_ITEMS/$svc.json" ]; then
  echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
  exit 44
fi
exec cat "$SHIM_ITEMS/$svc.json"
`;

let boxes = 0;

// A state folder with System default (signed in) and two saved accounts, A
// (active) and B, each signed in and with its Keychain item. Config dirs
// have a space, as Orca's do.
function sandbox() {
  const box = join(root, String(++boxes));
  const s = {
    box,
    home: join(box, "home"),
    state: join(box, "state"),
    shims: join(box, "bin"),
    items: join(box, "items"),
  };
  for (const dir of [s.home, s.state, s.shims, s.items]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(s.shims, "security"), SECURITY, { mode: 0o755 });
  for (const name of ["hc", "claude", "claude-usage", "open"]) {
    writeFileSync(join(s.shims, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  s.env = {
    HOME: s.home,
    USER: "tester",
    PATH: [s.shims, NODE_DIR, "/bin"].join(":"),
    TMPDIR: box,
    CLAUDE_ACCOUNTS_HOME: s.state,
    CLAUDE_ACCOUNTS_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
    CLAUDE_ACCOUNTS_USAGE_BIN: join(s.shims, "claude-usage"),
    SHIM_ITEMS: s.items,
  };
  for (const key of ["HOME", "TMPDIR", "CLAUDE_ACCOUNTS_HOME", "SHIM_ITEMS"]) {
    assert.ok(s.env[key].startsWith(`${root}/`), `a sandbox path, never the person's: ${key}=${s.env[key]}`);
  }
  s.dirs = {
    default: null,
    [A]: join(box, "Orca Dev", "claude-profiles", A, "home"),
    [B]: join(box, "Orca Dev", "claude-profiles", B, "home"),
  };
  const login = (email) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "Example Org" } });
  writeFileSync(join(s.home, ".claude.json"), login("dee@example.com"));
  for (const [id, email] of [[A, "ana@example.com"], [B, "ben@example.org"]]) {
    mkdirSync(s.dirs[id], { recursive: true });
    writeFileSync(join(s.dirs[id], ".claude.json"), login(email));
  }
  const registry = [A, B].map((id, i) => ({
    id,
    email: i === 0 ? "ana@example.com" : "ben@example.org",
    org: "Example Org",
    orgUuid: null,
    configDir: s.dirs[id],
    lastAuthenticatedAt: 1793300000000,
    source: "orca",
  }));
  writeFileSync(join(s.state, "accounts.json"), `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(s.state, "active"), s.dirs[A]);
  writeFileSync(join(s.state, "settings.json"), JSON.stringify({ switchMode: "ask" }));
  for (const id of ["default", A, B]) item(s, id, oauth(TOKEN[id]));
  return s;
}

// The Keychain item of an account: credentials JSON, "hang", "fail", or null
// (absent).
function item(s, id, value) {
  const base = join(s.items, serviceOf(s.dirs[id]));
  for (const ext of [".json", ".hang", ".fail"]) rmSync(`${base}${ext}`, { force: true });
  if (value === "hang" || value === "fail") writeFileSync(`${base}.${value}`, "");
  else if (value) writeFileSync(`${base}.json`, JSON.stringify(value));
}

const keychainCalls = (s) => {
  const log = join(s.items, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

// usage-state.json, seeded: { <id>: entry }. Fields an entry leaves out take
// their empty value.
function seed(s, accounts) {
  writeFileSync(join(s.state, "usage-state.json"), JSON.stringify({ version: 1, accounts }));
}
const stateOf = (s) => JSON.parse(readFileSync(join(s.state, "usage-state.json"), "utf8"));

// A statusline drop in live/ (D16).
function drop(s, name, value) {
  mkdirSync(join(s.state, "live"), { recursive: true });
  writeFileSync(join(s.state, "live", name), typeof value === "string" ? value : JSON.stringify(value));
}

// The CLI in the background: { child, done }, done resolving to { status,
// stdout, stderr, ms }.
function start(s, args, { url, env = {} } = {}) {
  const t0 = Date.now();
  const child = spawn(BIN, args, {
    env: { ...s.env, ...(url ? { CLAUDE_ACCOUNTS_USAGE_URL: url } : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(guard);
      outputs.push(stdout, stderr);
      resolve({ status, stdout, stderr, ms: Date.now() - t0 });
    });
  });
  return { child, done };
}
const run = (s, args, opts) => start(s, args, opts).done;

// Runs the CLI and returns the accounts.v1.json document it printed.
async function usageDoc(s, args, opts) {
  const r = await run(s, args, opts);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const listDoc = (s) => usageDoc(s, ["list", "--json"]);
const byId = (doc, id) => doc.accounts.find((a) => a.id === id);
const pick = (a) => ({ session: a.usage.session, weekly: a.usage.weekly, fable: a.usage.fable, error: a.error, needsSignIn: a.needsSignIn });

// The usage endpoint: a local server. `handler(req, res, token)`; every
// request is recorded as { method, url, headers, token }.
async function endpoint(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    seenTokens.add(token);
    requests.push({ method: req.method, url: req.url, headers: req.headers, token });
    handler(req, res, token);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/oauth/usage`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
const reply = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
// An endpoint body: session and weekly windows plus the Fable limit.
const body = (session, weekly, fable) => ({
  five_hour: { utilization: session, resets_at: new Date(RESET_5H).toISOString() },
  seven_day: { utilization: weekly, resets_at: new Date(RESET_WK).toISOString() },
  limits: [{ kind: "weekly_scoped", percent: fable, resets_at: RESET_WK_S, scope: { model: { display_name: "Fable" } } }],
});
const okEndpoint = (session = 41, weekly = 65, fable = 22) => endpoint((req, res) => reply(res, 200, body(session, weekly, fable)));

// Runs fn with an endpoint, closing it after.
async function withEndpoint(api, fn) {
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}

// Waits for `arrived` (the endpoint got a request), failing when the run
// ends first: it never asked.
function untilRequest(arrived, started) {
  const ended = started.done.then((r) => {
    throw new Error(`usage ended without asking the endpoint (exit ${r.status}): ${r.stderr}`);
  });
  ended.catch(() => {});
  return Promise.race([arrived, ended]);
}

// A pid that's surely dead: a process that ran and exited.
async function deadPid() {
  const child = spawn("/bin/sh", ["-c", "exit 0"]);
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid;
}

// ── keychain.mjs ───────────────────────────────────────────────────────────

test("keychainService: System default's item, and an account's from sha256 of its exact config dir (NFC, as Claude hashes it)", async () => {
  const { keychainService } = await cliModule("keychain");
  assert.equal(keychainService(null), "Claude Code-credentials");
  const dir = "/Users/ana/Library/Application Support/Orca Dev/claude-profiles/x/home";
  assert.equal(keychainService(dir), `Claude Code-credentials-${sha8(dir)}`);
  assert.notEqual(keychainService(`${dir}/`), keychainService(dir), "a trailing slash is another item");
  assert.equal(keychainService("/tmp/café"), keychainService("/tmp/café"));
});

// ── Parsing the endpoint's answer (Orca's claude-oauth-usage-request.ts) ───

test("Orca's order: five_hour and seven_day first, then limits[] (session, weekly_all); utilization before used_percentage; clamp and round; resets in s, ms and ISO", async () => {
  const { parseUsageResponse } = await cliModule("usage");
  const S = 1794010920;
  const first = parseUsageResponse({
    five_hour: { utilization: 41.6, used_percentage: 3, resets_at: S },
    seven_day: { used_percentage: 120, resets_at: S * 1000 },
    limits: [
      { kind: "session", percent: 99, resets_at: S },
      { kind: "weekly_all", percent: 98, resets_at: S },
    ],
  });
  assert.deepEqual(first.usage.session, win(42, S * 1000));
  assert.deepEqual(first.usage.weekly, win(100, S * 1000));

  const fallback = parseUsageResponse({
    limits: [
      { kind: "session", percent: -4, resets_at: "2026-11-06T21:02:00Z" },
      { kind: "weekly_all", percent: 64.5, resets_at: String(S) },
    ],
  });
  assert.deepEqual(fallback.usage.session, win(0, Date.parse("2026-11-06T21:02:00Z")));
  assert.deepEqual(fallback.usage.weekly, win(65, S * 1000));

  assert.deepEqual(parseUsageResponse({ five_hour: { utilization: 5 } }).usage.session, win(5, null), "no reset time");
  const none = parseUsageResponse({ five_hour: { resets_at: S }, seven_day: null, limits: "nope" });
  assert.deepEqual(none, { usage: { session: null, weekly: null, fable: null, monthly: null }, credits: null });
});

test("Fable: the weekly_scoped limit whose model is exactly fable (trimmed, any case), else fable_weekly, fable_seven_day, seven_day_fable", async () => {
  const { parseUsageResponse } = await cliModule("usage");
  const S = 1794367200;
  const fable = (data) => parseUsageResponse(data).usage.fable;
  const scoped = (name, percent = 22) => ({ kind: "weekly_scoped", percent, resets_at: S, scope: { model: { display_name: name } } });
  assert.deepEqual(fable({ limits: [scoped(" FABLE ")], fable_weekly: { utilization: 90 } }), win(22, S * 1000));
  assert.deepEqual(fable({ limits: [scoped("Fable Max", 50), scoped("Opus", 60)], fable_weekly: { utilization: 31, resets_at: S } }), win(31, S * 1000));
  assert.deepEqual(fable({ limits: [scoped("fable", "22")], fable_seven_day: { utilization: 32 } }), win(32, null), "a limit needs a numeric percent");
  assert.deepEqual(fable({ seven_day_fable: { used_percentage: 33 } }), win(33, null));
  assert.equal(fable({ limits: [{ kind: "weekly_all", percent: 10, scope: { model: { display_name: "Fable" } } }] }), null);
});

test("credits and the monthly spend window (claude-usage-credits.ts): spend before legacy extra_usage, monthly only without plan windows", async () => {
  const { parseUsageResponse } = await cliModule("usage");
  const empty = { session: null, weekly: null, fable: null, monthly: null };
  const spend = {
    used: { amount_minor: 1250, currency: "USD", exponent: 2 },
    limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
    balance: { amount_minor: 3750, exponent: 2 },
  };
  assert.deepEqual(parseUsageResponse({ spend }), { usage: { ...empty, monthly: win(25, null) }, credits: { balance: 37.5, limit: 50 } });
  const plan = parseUsageResponse({ five_hour: { utilization: 10 }, spend });
  assert.equal(plan.usage.monthly, null, "with plan windows, spend is overage, not the account's limit");
  assert.deepEqual(plan.credits, { balance: 37.5, limit: 50 });
  // spend.percent wins and is clamped; the cap stands in for a missing limit.
  assert.deepEqual(parseUsageResponse({ spend: { percent: 130, cap: { money: { amount_minor: 200000, exponent: 3 } } } }), {
    usage: { ...empty, monthly: win(100, null) },
    credits: { balance: null, limit: 200 },
  });
  // Legacy extra_usage: minor units with decimal_places, amounts before utilization.
  assert.deepEqual(parseUsageResponse({ extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 2500, utilization: 0.9, decimal_places: 2 } }), {
    usage: { ...empty, monthly: win(25, null) },
    credits: { balance: null, limit: 100 },
  });
  // Neither a limit nor a balance: no credits, no window.
  assert.deepEqual(parseUsageResponse({ spend: { used: { amount_minor: 5 } }, extra_usage: { utilization: 50 } }), { usage: empty, credits: null });
});

// ── The usage command ──────────────────────────────────────────────────────
// Each case has its own sandbox and endpoint, so they run side by side: the
// slow ones (a `security` that hangs, the 15 s answer) overlap the rest.

describe("usage", { concurrency: 8, timeout: 60_000 }, () => {
  it("reads every account with its own token and Orca's request, and publishes it in accounts.v1.json", async () => {
    const s = sandbox();
    const values = { [TOKEN.default]: [5, 6, 7], [TOKEN[A]]: [41, 65, 22], [TOKEN[B]]: [12, 94, 42] };
    const api = await endpoint((req, res, token) => reply(res, 200, body(...values[token])));
    await withEndpoint(api, async () => {
      const before = Date.now();
      const r = await run(s, ["usage", "--json"], { url: api.url });
      const after = Date.now();
      assert.equal(r.status, 0, r.stderr);
      const doc = JSON.parse(r.stdout);
      assert.equal(readFileSync(join(s.state, "accounts.v1.json"), "utf8"), r.stdout, "it prints the published file");
      assert.deepEqual(doc.accounts.map((a) => a.id), ["default", A, B]);
      assert.deepEqual(pick(byId(doc, A)), { session: win(41, RESET_5H), weekly: win(65, RESET_WK), fable: win(22, RESET_WK), error: null, needsSignIn: false });
      assert.deepEqual(pick(byId(doc, B)), { session: win(12, RESET_5H), weekly: win(94, RESET_WK), fable: win(42, RESET_WK), error: null, needsSignIn: false });
      assert.deepEqual(byId(doc, "default").usage.session, win(5, RESET_5H));
      for (const a of doc.accounts) {
        assert.ok(a.usageUpdatedAt >= before && a.usageUpdatedAt <= after, `${a.id} usageUpdatedAt`);
        assert.equal(a.credits, null);
        assert.equal(a.usage.monthly, null);
      }

      assert.equal(api.requests.length, 3);
      assert.deepEqual(new Set(api.requests.map((q) => q.token)), new Set([TOKEN.default, TOKEN[A], TOKEN[B]]));
      for (const q of api.requests) {
        assert.equal(q.method, "GET");
        assert.equal(q.url, "/api/oauth/usage");
        assert.equal(q.headers["anthropic-beta"], "oauth-2025-04-20");
        assert.equal(q.headers["user-agent"], "claude-code/2.1.0");
      }
      assert.deepEqual(keychainCalls(s).sort(), [
        `find-generic-password -s ${serviceOf(null)} -a tester -w`,
        `find-generic-password -s ${serviceOf(s.dirs[A])} -a tester -w`,
        `find-generic-password -s ${serviceOf(s.dirs[B])} -a tester -w`,
      ].sort());

      // Read again at once: nothing is due, nothing is asked, and the text
      // form names each account's numbers.
      const human = await run(s, ["usage"], { url: api.url });
      assert.equal(human.status, 0, human.stderr);
      assert.equal(api.requests.length, 3);
      assert.match(human.stdout, /^\* ana@example\.com .*41%.*65%.*22%/m);
      assert.match(human.stdout, /^ {2}ben@example\.org .*12%.*94%.*42%/m);
    });
  });

  it("--account reads only that account and still lists every account; an unknown one exits 7", async () => {
    const s = sandbox();
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--account", B, "--json"], { url: api.url });
      assert.deepEqual(api.requests.map((q) => q.token), [TOKEN[B]]);
      assert.deepEqual(doc.accounts.map((a) => a.id), ["default", A, B]);
      assert.equal(byId(doc, B).usage.session.percent, 41);
      assert.equal(byId(doc, A).usage.session, null);

      const r = await run(s, ["usage", "--account", "no-such-account", "--json"], { url: api.url });
      assert.equal(r.status, 7);
      assert.match(r.stderr, /unknown account "no-such-account"/);
      assert.equal(api.requests.length, 1);
    });
  });

  // D4's mapping (claude-usage-error-classification.ts), each status alone.
  const STATUS_CASES = [
    ["401", (res) => reply(res, 401, { error: { message: "OAuth token has expired." } }), { error: "expired", needsSignIn: false, errorDetail: null }],
    ["403", (res) => reply(res, 403, { error: { message: "Forbidden" } }), { error: "expired", needsSignIn: false, errorDetail: null }],
    [
      "403 naming user:profile (its text is kept, the token in it is not)",
      (res, token) => reply(res, 403, { error: { message: `OAuth token does not meet scope requirement user:profile (Bearer ${token})` } }),
      { error: "unavailable", needsSignIn: false, errorDetail: "OAuth token does not meet scope requirement user:profile (Bearer [redacted])" },
    ],
    ["500", (res) => reply(res, 500, { error: { message: "Internal" } }), { error: "unavailable", needsSignIn: false, errorDetail: null }],
    ["503", (res) => reply(res, 503, "<html>down</html>"), { error: "unavailable", needsSignIn: false, errorDetail: null }],
    ["429", (res) => reply(res, 429, { error: { message: "slow down" } }, { "retry-after": "120" }), { error: "rateLimited", needsSignIn: false, errorDetail: null }],
    ["another status whose text names a rate limit", (res) => reply(res, 400, { error: { message: "Rate limit exceeded for this organization" } }), { error: "rateLimited", needsSignIn: false, errorDetail: null }],
    ["another status", (res) => reply(res, 404, { error: { message: "Not found" } }), { error: "unavailable", needsSignIn: false, errorDetail: null }],
    ["a 200 that isn't JSON", (res) => reply(res, 200, "{not json"), { error: "unavailable", needsSignIn: false, errorDetail: null }],
    ["401 whose login Claude can't renew (revoked)", (res) => reply(res, 401, { error: { message: "OAuth token has been revoked." } }), { error: null, needsSignIn: true, errorDetail: null }],
  ];
  for (const [name, handler, want] of STATUS_CASES) {
    it(`HTTP ${name} → ${want.error ?? "needsSignIn"}`, async () => {
      const s = sandbox();
      const { contractUsage } = await cliModule("usage");
      const api = await endpoint((req, res, token) => handler(res, token));
      await withEndpoint(api, async () => {
        const t0 = Date.now();
        const doc = await usageDoc(s, ["usage", "--account", A, "--json"], { url: api.url });
        assert.equal(api.requests.length, 1);
        const a = byId(doc, A);
        assert.deepEqual({ error: a.error, needsSignIn: a.needsSignIn }, { error: want.error, needsSignIn: want.needsSignIn });
        const own = await contractUsage(s.state, { id: A, configDir: s.dirs[A], isDefault: false });
        assert.equal(own.errorDetail, want.errorDetail);
        if (name === "429") {
          const { retryAt } = stateOf(s).accounts[A];
          assert.ok(retryAt >= t0 + 120_000 && retryAt <= Date.now() + 120_000, `Retry-After kept: ${retryAt}`);
        }
      });
    });
  }

  it("HTTP 401 on a login with no refresh token → needsSignIn; a network failure → network", async () => {
    const s = sandbox();
    const { refreshToken, ...noRefresh } = oauth(TOKEN[A]).claudeAiOauth;
    assert.ok(refreshToken);
    item(s, A, { claudeAiOauth: noRefresh });
    const api = await endpoint((req, res) => reply(res, 401, { error: { message: "OAuth token has expired." } }));
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--account", A, "--json"], { url: api.url });
      assert.deepEqual({ error: byId(doc, A).error, needsSignIn: byId(doc, A).needsSignIn }, { error: null, needsSignIn: true });
    });
    // CLAUDE_ACCOUNTS_USAGE_URL's default here is a closed port.
    const doc = await usageDoc(s, ["usage", "--account", B, "--json"]);
    assert.equal(byId(doc, B).error, "network");
  });

  // ── The Keychain (D4) ──────────────────────────────────────────────────

  it("Keychain: an absent item (exit 44) falls back to <configDir>/.credentials.json; with neither, the account needs sign-in and nothing is asked", async () => {
    const s = sandbox();
    item(s, A, null);
    writeFileSync(join(s.dirs[A], ".credentials.json"), JSON.stringify(oauth(TOKEN.file)));
    item(s, B, null);
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--json"], { url: api.url });
      assert.deepEqual(api.requests.map((q) => q.token).sort(), [TOKEN.default, TOKEN.file].sort());
      assert.equal(byId(doc, A).usage.session.percent, 41);
      assert.deepEqual({ error: byId(doc, B).error, needsSignIn: byId(doc, B).needsSignIn, session: byId(doc, B).usage.session }, { error: null, needsSignIn: true, session: null });
    });
  });

  it("Keychain: System default reads the unsuffixed item, then ~/.claude/.credentials.json", async () => {
    const s = sandbox();
    item(s, "default", null);
    mkdirSync(join(s.home, ".claude"));
    writeFileSync(join(s.home, ".claude", ".credentials.json"), JSON.stringify(oauth(TOKEN.file)));
    const api = await okEndpoint(9);
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--account", "default", "--json"], { url: api.url });
      assert.deepEqual(api.requests.map((q) => q.token), [TOKEN.file]);
      assert.equal(byId(doc, "default").usage.session.percent, 9);
      assert.deepEqual(keychainCalls(s), ["find-generic-password -s Claude Code-credentials -a tester -w"]);
    });
  });

  it("Keychain: a `security` that hangs is cut at 3 s → keychain", async () => {
    const s = sandbox();
    item(s, A, "hang");
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const r = await run(s, ["usage", "--account", A, "--json"], { url: api.url });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.ms >= 2900 && r.ms < 9000, `cut at 3 s, took ${r.ms} ms`);
      assert.equal(byId(JSON.parse(r.stdout), A).error, "keychain");
      assert.equal(api.requests.length, 0);
    });
  });

  it("Keychain: any other failure, or an unreadable item → keychain; an expired refresh token → needsSignIn (Sign in again) without a request", async () => {
    const s = sandbox();
    item(s, A, "fail");
    writeFileSync(join(s.items, `${serviceOf(null)}.json`), "{\"claudeAiOauth\": {\"accessToken\": \"sk-ant-oat01-FAKE-T3-cut");
    item(s, B, oauth(TOKEN[B], { refreshTokenExpiresAt: Date.now() - HOUR }));
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const r = await run(s, ["usage", "--json"], { url: api.url });
      assert.equal(r.status, 0, r.stderr);
      const doc = JSON.parse(r.stdout);
      assert.equal(api.requests.length, 0);
      assert.deepEqual([byId(doc, A).error, byId(doc, A).needsSignIn], ["keychain", false]);
      assert.deepEqual([byId(doc, "default").error, byId(doc, "default").needsSignIn], ["keychain", false]);
      assert.deepEqual([byId(doc, B).error, byId(doc, B).needsSignIn], [null, true]);
    });
  });

  // ── Claims (D2) ────────────────────────────────────────────────────────

  it("a fetch claim left by a dead pid, or older than 15 s, is void: the account is read", async () => {
    const s = sandbox();
    seed(s, {
      [A]: { claim: { pid: await deadPid(), at: Date.now() } },
      [B]: { claim: { pid: process.pid, at: Date.now() - 16_000 } },
      default: { checkedAt: Date.now() - MIN },
    });
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--json"], { url: api.url });
      assert.deepEqual(api.requests.map((q) => q.token).sort(), [TOKEN[A], TOKEN[B]].sort());
      assert.equal(byId(doc, A).usage.session.percent, 41);
      assert.equal(byId(doc, B).usage.session.percent, 41);
      assert.equal(stateOf(s).accounts[A].claim, null);
      assert.equal(stateOf(s).accounts[B].claim, null);
    });
  });

  it("a live claim: usage skips the account at once, and usage --refresh waits for that claim's merge and returns it", async () => {
    const s = sandbox();
    const sleeper = spawn("/bin/sleep", ["30"]);
    try {
      seed(s, { [A]: { claim: { pid: sleeper.pid, at: Date.now() } } });
      const idle = await okEndpoint();
      await withEndpoint(idle, async () => {
        const r = await run(s, ["usage", "--account", A, "--json"], { url: idle.url });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.ms < 5000, `no wait without --refresh (${r.ms} ms)`);
        assert.equal(idle.requests.length, 0);
      });
    } finally {
      sleeper.kill();
    }

    // Two real runs: the first claims A and its request is held; the second
    // meets that claim, waits, and returns the first one's result.
    seed(s, {});
    let release;
    const arrived = new Promise((resolve) => {
      release = resolve;
    });
    const pending = [];
    const api = await endpoint((req, res) => {
      pending.push(res);
      release();
    });
    await withEndpoint(api, async () => {
      const first = start(s, ["usage", "--refresh", "--account", A, "--json"], { url: api.url });
      await untilRequest(arrived, first);
      const second = start(s, ["usage", "--refresh", "--account", A, "--json"], { url: api.url });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(second.child.exitCode, null, "the second run is waiting");
      reply(pending[0], 200, body(77, 65, 22));
      const [r1, r2] = await Promise.all([first.done, second.done]);
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal(api.requests.length, 1, "one request between them");
      assert.equal(byId(JSON.parse(r2.stdout), A).usage.session.percent, 77);
    });
  });

  // ── Live drops (D16) ───────────────────────────────────────────────────

  it("a drop merges without asking the endpoint; a lower value in the same window is ignored; live/ is never written or deleted", async () => {
    const s = sandbox();
    const now = Date.now();
    seed(s, {
      [A]: {
        usage: { session: win(50, RESET_5H), weekly: win(60, RESET_WK), fable: win(22, RESET_WK), monthly: null },
        source: "fetch",
        usageUpdatedAt: now - MIN,
        checkedAt: now - MIN,
      },
      [B]: { checkedAt: now - MIN },
      default: { checkedAt: now - MIN },
    });
    drop(s, `${sha8(s.dirs[A])}.json`, {
      configDir: s.dirs[A],
      at: now - 1000,
      rate_limits: { five_hour: { used_percentage: 40, resets_at: RESET_5H_S }, seven_day: { used_percentage: 70, resets_at: RESET_WK_S } },
    });
    // System default's drop (no CLAUDE_CONFIG_DIR), with the OAuth-shaped field.
    drop(s, "default.json", { configDir: null, at: now - 2000, rate_limits: { five_hour: { utilization: 33, resets_at: String(RESET_5H_S) } } });
    drop(s, "0badc0de.json", { configDir: "/no/such/account", at: now, rate_limits: { five_hour: { used_percentage: 99, resets_at: RESET_5H_S } } });
    drop(s, "junk.json", "not json");
    drop(s, `${sha8(s.dirs[B])}.json.4242.tmp`, "{\"configDir\":");
    const live = join(s.state, "live");
    const snapshot = () =>
      readdirSync(live)
        .sort()
        .map((name) => [name, readFileSync(join(live, name), "utf8"), statSync(join(live, name)).mtimeMs]);
    const before = snapshot();

    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--json"], { url: api.url });
      assert.equal(api.requests.length, 0);
      const a = byId(doc, A);
      assert.deepEqual(pick(a), { session: win(50, RESET_5H), weekly: win(70, RESET_WK), fable: win(22, RESET_WK), error: null, needsSignIn: false });
      assert.equal(a.usageUpdatedAt, now - 1000);
      assert.deepEqual(byId(doc, "default").usage.session, win(33, RESET_5H));
      assert.equal(byId(doc, B).usage.session, null);
      assert.deepEqual(snapshot(), before, "live/ untouched");
    });
  });

  it("a drop newer than the last check clears that account's error; an older one merges but keeps it", async () => {
    const s = sandbox();
    const now = Date.now();
    const failed = (checkedAt) => ({
      usage: { session: win(10, RESET_5H), weekly: null, fable: null, monthly: null },
      source: "fetch",
      usageUpdatedAt: now - 3 * MIN,
      checkedAt,
      error: "network",
      failureStreak: 5,
    });
    seed(s, { [A]: failed(now - 2 * MIN), [B]: failed(now - MIN), default: { checkedAt: now - MIN } });
    const fiveHour = (percent) => ({ five_hour: { used_percentage: percent, resets_at: RESET_5H_S } });
    drop(s, "a.json", { configDir: s.dirs[A], at: now - 1000, rate_limits: fiveHour(55) });
    drop(s, "b.json", { configDir: s.dirs[B], at: now - 90_000, rate_limits: fiveHour(12) });
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const doc = await usageDoc(s, ["usage", "--json"], { url: api.url });
      assert.equal(api.requests.length, 0);
      assert.deepEqual([byId(doc, A).usage.session.percent, byId(doc, A).error], [55, null]);
      assert.deepEqual([byId(doc, B).usage.session.percent, byId(doc, B).error], [12, "network"]);
    });
  });

  // ── Cadence (D4) ───────────────────────────────────────────────────────

  // Seeds A's (or B's) last check, runs usage, and returns how many requests
  // that run made.
  async function requestsAfter(s, api, id, entry, args) {
    seed(s, { [id]: entry });
    const before = api.requests.length;
    const r = await run(s, ["usage", "--account", id, "--json", ...args], { url: api.url });
    assert.equal(r.status, 0, r.stderr);
    return api.requests.length - before;
  }

  it("an account is not refetched within 5 min; --refresh has a 30 s floor; inactive accounts are debounced 60 s", async () => {
    const s = sandbox();
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const ago = (ms) => ({ checkedAt: Date.now() - ms });
      assert.equal(await requestsAfter(s, api, A, ago(4 * MIN), []), 0, "4 min ago");
      assert.equal(await requestsAfter(s, api, A, ago(6 * MIN), []), 1, "6 min ago");
      assert.equal(await requestsAfter(s, api, A, ago(20_000), ["--refresh"]), 0, "refresh, 20 s ago");
      assert.equal(await requestsAfter(s, api, A, ago(45_000), ["--refresh"]), 1, "refresh, 45 s ago (active)");
      assert.equal(await requestsAfter(s, api, B, ago(45_000), ["--refresh"]), 0, "refresh, 45 s ago (inactive)");
      assert.equal(await requestsAfter(s, api, B, ago(70_000), ["--refresh"]), 1, "refresh, 70 s ago (inactive)");
    });
  });

  it("failures back off from 30 s, doubling to 15 min, and the streak stops at 8", async () => {
    const s = sandbox();
    const api = await endpoint((req, res) => reply(res, 500, {}));
    await withEndpoint(api, async () => {
      const failed = (streak, ms) => ({ checkedAt: Date.now() - ms, failureStreak: streak, error: "unavailable" });
      assert.equal(await requestsAfter(s, api, A, failed(1, 20_000), []), 0, "streak 1, 20 s ago");
      assert.equal(await requestsAfter(s, api, A, failed(1, 35_000), []), 1, "streak 1, 35 s ago");
      assert.equal(stateOf(s).accounts[A].failureStreak, 2);
      assert.equal(await requestsAfter(s, api, A, failed(3, 100_000), []), 0, "streak 3, 100 s ago");
      assert.equal(await requestsAfter(s, api, A, failed(3, 130_000), []), 1, "streak 3, 130 s ago");
      assert.equal(await requestsAfter(s, api, A, failed(8, 14 * MIN), []), 0, "streak 8, 14 min ago");
      assert.equal(await requestsAfter(s, api, A, failed(8, 16 * MIN), []), 1, "streak 8, 16 min ago");
      assert.equal(stateOf(s).accounts[A].failureStreak, 8);
    });
  });

  it("a 429's Retry-After holds the automated reads; --refresh still reads", async () => {
    const s = sandbox();
    const api = await okEndpoint();
    await withEndpoint(api, async () => {
      const held = () => ({ checkedAt: Date.now() - 10 * MIN, failureStreak: 1, error: "rateLimited", retryAt: Date.now() + 100_000 });
      assert.equal(await requestsAfter(s, api, A, held(), []), 0);
      assert.equal(await requestsAfter(s, api, A, held(), ["--refresh"]), 1);
      assert.equal(stateOf(s).accounts[A].retryAt, null, "a good read clears it");
    });
  });

  // ── Expiry (D4: cached data 30 min, or 24 h after a 429 or a lapsed token) ─

  it("after a failure, the last data is kept 30 min, or 24 h after a 429 or a lapsed token; past-reset windows are dropped", async () => {
    const data = (updatedAgo, extra = {}) => ({
      usage: { session: win(41, RESET_5H), weekly: win(65, RESET_WK), fable: win(22, RESET_WK), monthly: null },
      credits: { balance: 1, limit: 5 },
      source: "fetch",
      usageUpdatedAt: Date.now() - updatedAgo,
      checkedAt: Date.now() - MIN,
      ...extra,
    });
    const kept = (a) => a.usage.session?.percent === 41 && a.credits !== null && a.usageUpdatedAt !== null;
    const gone = (a) => Object.values(a.usage).every((w) => w === null) && a.credits === null && a.usageUpdatedAt === null;

    const s1 = sandbox();
    seed(s1, {
      [A]: data(31 * MIN, { error: "network", failureStreak: 1 }),
      [B]: data(29 * MIN, { error: "network", failureStreak: 1 }),
      default: data(2 * HOUR, { error: "rateLimited", failureStreak: 1 }),
    });
    let doc = await listDoc(s1);
    assert.ok(gone(byId(doc, A)), "network, 31 min");
    assert.equal(byId(doc, A).error, "network");
    assert.ok(kept(byId(doc, B)), "network, 29 min");
    assert.ok(kept(byId(doc, "default")), "rateLimited, 2 h");

    const s2 = sandbox();
    seed(s2, {
      [A]: data(23 * HOUR, { error: "expired", failureStreak: 1 }),
      [B]: data(25 * HOUR, { error: "rateLimited", failureStreak: 1 }),
      default: data(31 * MIN, { needsSignIn: true, failureStreak: 1 }),
    });
    doc = await listDoc(s2);
    assert.ok(kept(byId(doc, A)), "expired, 23 h");
    assert.ok(gone(byId(doc, B)), "rateLimited, 25 h");
    assert.ok(gone(byId(doc, "default")), "needsSignIn, 31 min");

    const s3 = sandbox();
    seed(s3, {
      [A]: data(3 * HOUR, { usage: { session: win(41, Date.now() - MIN), weekly: win(65, RESET_WK), fable: null, monthly: win(12, null) } }),
    });
    doc = await listDoc(s3);
    assert.deepEqual(byId(doc, A).usage, { session: null, weekly: win(65, RESET_WK), fable: null, monthly: win(12, null) }, "no failure: kept; the past-reset window dropped");
  });

  it("a failed read keeps the last data alongside its error (a 429, 2 h old) or drops it (a 500, 2 h old)", async () => {
    const old = () => ({
      usage: { session: win(41, RESET_5H), weekly: win(65, RESET_WK), fable: null, monthly: null },
      source: "fetch",
      usageUpdatedAt: Date.now() - 2 * HOUR,
      checkedAt: Date.now() - 10 * MIN,
    });
    const limited = sandbox();
    seed(limited, { [A]: old() });
    const api429 = await endpoint((req, res) => reply(res, 429, {}));
    await withEndpoint(api429, async () => {
      const a = byId(await usageDoc(limited, ["usage", "--account", A, "--json"], { url: api429.url }), A);
      assert.deepEqual([a.error, a.usage.session, a.usage.weekly], ["rateLimited", win(41, RESET_5H), win(65, RESET_WK)]);
      assert.ok(a.usageUpdatedAt < Date.now() - HOUR, "the data keeps its own time");
    });
    const down = sandbox();
    seed(down, { [A]: old() });
    const api500 = await endpoint((req, res) => reply(res, 500, {}));
    await withEndpoint(api500, async () => {
      const a = byId(await usageDoc(down, ["usage", "--account", A, "--json"], { url: api500.url }), A);
      assert.deepEqual([a.error, a.usage.session, a.usage.weekly, a.usageUpdatedAt], ["unavailable", null, null, null]);
    });
  });

  // ── The lock and concurrency (D2) ──────────────────────────────────────

  it("the lock is free while the endpoint stalls: another command runs meanwhile", async () => {
    const s = sandbox();
    let arrivedOne;
    const arrived = new Promise((resolve) => {
      arrivedOne = resolve;
    });
    const pending = [];
    const api = await endpoint((req, res) => {
      pending.push(res);
      arrivedOne();
    });
    await withEndpoint(api, async () => {
      const stalled = start(s, ["usage", "--refresh", "--account", A, "--json"], { url: api.url });
      await untilRequest(arrived, stalled);
      assert.ok(!existsSync(join(s.state, "lock")), "no lock held across the request");
      assert.equal(stateOf(s).accounts[A].claim.pid, stalled.child.pid, "the fetch is claimed instead");
      const list = await run(s, ["list", "--json"]);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(stalled.child.exitCode, null, "list finished while usage still waits on the endpoint");
      reply(pending[0], 200, body(41, 65, 22));
      const r = await stalled.done;
      assert.equal(r.status, 0, r.stderr);
      assert.equal(byId(JSON.parse(r.stdout), A).usage.session.percent, 41);
    });
  });

  it("two concurrent usage runs keep both results", async () => {
    const s = sandbox();
    const pending = [];
    const api = await endpoint((req, res, token) => {
      pending.push([res, token]);
      if (pending.length < 2) return;
      for (const [r, t] of pending) reply(r, 200, body(t === TOKEN[A] ? 11 : 22, 65, 22));
    });
    await withEndpoint(api, async () => {
      const [ra, rb] = await Promise.all([
        run(s, ["usage", "--refresh", "--account", A, "--json"], { url: api.url }),
        run(s, ["usage", "--refresh", "--account", B, "--json"], { url: api.url }),
      ]);
      assert.equal(ra.status, 0, ra.stderr);
      assert.equal(rb.status, 0, rb.stderr);
      const doc = await listDoc(s);
      assert.deepEqual([byId(doc, A).usage.session.percent, byId(doc, B).usage.session.percent], [11, 22]);
    });
  });

  it("an account whose read can't finish within 15 s keeps its last data, and usage exits 4", async () => {
    const s = sandbox();
    const sleeper = spawn("/bin/sleep", ["40"]);
    try {
      seed(s, {
        [A]: {
          usage: { session: win(41, RESET_5H), weekly: null, fable: null, monthly: null },
          source: "fetch",
          usageUpdatedAt: Date.now() - 10 * MIN,
          checkedAt: Date.now() - 10 * MIN,
          claim: { pid: sleeper.pid, at: Date.now() },
        },
      });
      const api = await okEndpoint(99);
      await withEndpoint(api, async () => {
        const r = await run(s, ["usage", "--refresh", "--account", A, "--json"], { url: api.url });
        assert.equal(r.status, 4, r.stderr);
        assert.ok(r.ms < 15_000, `answered within 15 s (${r.ms} ms)`);
        assert.equal(byId(JSON.parse(r.stdout), A).usage.session.percent, 41);
        assert.equal(r.stderr.trim().split("\n").length, 1, "one line on stderr");
        assert.equal(api.requests.length, 0);
      });
    } finally {
      sleeper.kill();
    }
  });
});

// ── Tokens never leave the request (Risk item 2) ───────────────────────────

test("no fake token reaches stdout, stderr or any file the CLI wrote", () => {
  assert.ok(seenTokens.size >= 4, "the endpoint did get the fake tokens, so their absence below means something");
  assert.ok(outputs.length > 0);
  for (const text of outputs) assert.doesNotMatch(text, LEAK);
  // Every file under every sandbox, except the token-bearing ones the tests
  // wrote themselves: the fake Keychain items and .credentials.json files.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return walk(path);
      return e.isFile() ? [path] : [];
    });
  const files = walk(root).filter((f) => !(dirname(f).endsWith("/items") && f.endsWith(".json")) && !f.endsWith("/.credentials.json"));
  assert.ok(files.some((f) => f.endsWith("/usage-state.json")) && files.some((f) => f.endsWith("/accounts.v1.json")));
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), LEAK, file);
});
