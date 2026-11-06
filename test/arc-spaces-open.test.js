// T1: the `open` wrapper. It runs from a fake Herdr (a symlink to bash at the
// app's path, which is what `ps -o comm=` shows) with fake tools that record
// their arguments, so nothing here opens a browser or talks to Arc.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(new URL("../arc-spaces/mods/arc-spaces/bin/open", import.meta.url));
const URL_A = "https://example.com/a?x=1&y=2";

let dir, home, herdrParent, otherParent;

const tool = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

// Each fake writes one line per argument to its own log.
const recorder = (name, tail = "exit 0") => tool(name, `printf '%s\\n' "$@" > "${join(dir, `${name}.log`)}"\n${tail}`);
const logOf = (name) => {
  const path = join(dir, `${name}.log`);
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : null;
};

// What Herdr's `ls` answers: `active` names the shown space.
const lsAnswer = (spaces) => tool("herdr", `cat <<'EOF'\n${JSON.stringify({ spaces })}\nEOF`);

const space = (folder, extra = {}) => ({ id: `s-${folder}`, folder, machine: null, active: true, tabs: [], ...extra });

const GROUPS = {
  version: 1,
  activeGroup: "g2",
  groups: [
    { id: "g1", name: "Action Experience", projects: [{ path: "/repos/action" }] },
    { id: "g2", name: "Arrecife", projects: [{ path: "/repos/mine" }] },
    { id: "g3", name: "AG", projects: [{ path: "/repos/ag" }] },
  ],
};
const CACHE = {
  "/repos/action": [{ path: "/repos/action", main: true }, { path: "/work/action/feature" }],
  "/repos/mine": [{ path: "/repos/mine", main: true }],
  "/repos/ag": [{ path: "/repos/ag", main: true }, { path: "/repos/mine/nested-ag" }],
};
const NAMES = { g1: "Action", g2: "Personal", g3: "Bulbasour" };

const writeShared = (value) => writeFileSync(join(home, "shared.json"), typeof value === "string" ? value : JSON.stringify(value));
const shared = (config = { enabled: true, names: NAMES }, more = {}) => ({
  "projects.v1": GROUPS,
  "projects.cache.v1": CACHE,
  "arc-spaces.v1": config,
  ...more,
});

// Runs the wrapper with `parent` as its parent process. The trailing `true`
// keeps bash from exec-ing the wrapper, which would make the parent node.
function run(args, { parent = herdrParent, env = {} } = {}) {
  const quoted = args.map((a) => `'${a}'`).join(" ");
  return spawnSync(parent, ["-c", `'${WRAPPER}' ${quoted}; code=$?; exit $code`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      HERDR_APP_HOME: home,
      ARC_SPACES_OPEN: join(dir, "real-open"),
      ARC_SPACES_OSASCRIPT: join(dir, "osascript"),
      ARC_SPACES_HERDR: join(dir, "herdr"),
      ARC_SPACES_APP: join(dir, "Arc.app"),
      // Under the whole suite macOS can take over 10 s to run a new script, so
      // the real limit would stop the fake osascript and fail the test.
      ARC_SPACES_TIMEOUT: "300",
      ...env,
    },
  });
}

// The space name and URL the fake osascript got, after the script's -e lines.
function routed() {
  const args = logOf("osascript");
  if (!args) return null;
  return { url: args.at(-2), space: args.at(-1) };
}

const assertRouted = (spaceName, url = URL_A) => {
  assert.deepEqual(routed(), { url, space: spaceName });
  assert.equal(logOf("real-open"), null, "the real open must not run too");
};
const assertPassedThrough = (args) => {
  assert.deepEqual(logOf("real-open"), args);
  assert.equal(logOf("osascript"), null, "Arc must not be scripted");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arc-spaces-"));
  home = join(dir, "home");
  mkdirSync(home);
  mkdirSync(join(dir, "Arc.app"));
  const macos = join(dir, "Herdr.app/Contents/MacOS");
  mkdirSync(macos, { recursive: true });
  herdrParent = join(macos, "Herdr");
  symlinkSync("/bin/bash", herdrParent);
  otherParent = "/bin/bash";
  recorder("real-open");
  recorder("osascript");
  lsAnswer([space("/repos/action")]);
  writeShared(shared());
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── Passing through ────────────────────────────────────────────────────────

test("a parent other than Herdr passes through, even with a URL", () => {
  run([URL_A], { parent: otherParent });
  assertPassedThrough([URL_A]);
});

test("Herdr started from a terminal, as herdr-app, counts as Herdr", () => {
  const link = join(dir, "herdr-app");
  symlinkSync("/bin/bash", link);
  run([URL_A], { parent: link });
  assertRouted("Action");
});

test("flags and several arguments pass through untouched, in order", () => {
  run(["-a", "Safari", URL_A]);
  assertPassedThrough(["-a", "Safari", URL_A]);
});

test("a file path passes through", () => {
  run(["/tmp/some file.png"]);
  assertPassedThrough(["/tmp/some file.png"]);
});

test("other schemes pass through", () => {
  run(["mailto:someone@example.com"]);
  assertPassedThrough(["mailto:someone@example.com"]);
});

test("no arguments pass through", () => {
  run([]);
  assert.equal(logOf("osascript"), null);
  assert.notEqual(existsSync(join(dir, "real-open.log")), false);
});

test("the real open's exit code comes back", () => {
  tool("real-open", "exit 7");
  assert.equal(run([URL_A], { parent: otherParent }).status, 7);
});

// ── Off ────────────────────────────────────────────────────────────────────

test("never configured: off", () => {
  writeShared({ "projects.v1": GROUPS, "projects.cache.v1": CACHE });
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("switched off, names kept: off", () => {
  writeShared(shared({ enabled: false, names: NAMES }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("a group with a blank name doesn't route", () => {
  writeShared(shared({ enabled: true, names: { ...NAMES, g1: "   " } }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("a group with no name doesn't route", () => {
  writeShared(shared({ enabled: true, names: { g2: "Personal" } }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

// ── Which space ────────────────────────────────────────────────────────────

test("the space's own group wins over the active one", () => {
  run([URL_A]);
  assertRouted("Action");
});

test("http works too, and the URL arrives whole", () => {
  run(["http://localhost:3000/x?a=b&c=d#e"]);
  assertRouted("Action", "http://localhost:3000/x?a=b&c=d#e");
});

test("a space in a worktree belongs to its project's group", () => {
  lsAnswer([space("/work/action/feature")]);
  run([URL_A]);
  assertRouted("Action");
});

test("a space in a folder inside a checkout belongs to it", () => {
  lsAnswer([space("/repos/ag/packages/web")]);
  run([URL_A]);
  assertRouted("Bulbasour");
});

test("the longest checkout wins", () => {
  lsAnswer([space("/repos/mine/nested-ag/src")]);
  run([URL_A]);
  assertRouted("Bulbasour");
});

test("a folder that only shares a prefix doesn't match", () => {
  lsAnswer([space("/repos/action-other")]);
  run([URL_A]);
  assertRouted("Personal");
});

test("only the shown space counts", () => {
  lsAnswer([space("/repos/ag", { active: false }), space("/repos/action")]);
  run([URL_A]);
  assertRouted("Action");
});

test("a trailing slash in a stored path still matches", () => {
  writeShared(shared(undefined, { "projects.cache.v1": { "/repos/action/": [{ path: "/repos/action/" }] } }));
  run([URL_A]);
  assertRouted("Action");
});

test("a space outside every group uses the active group", () => {
  lsAnswer([space("/Users/someone")]);
  run([URL_A]);
  assertRouted("Personal");
});

test("a space on another machine uses the active group", () => {
  lsAnswer([space("/repos/action", { machine: "vps" })]);
  run([URL_A]);
  assertRouted("Personal");
});

test("no valid active group: the first group", () => {
  lsAnswer([space("/Users/someone")]);
  writeShared(shared(undefined, { "projects.v1": { ...GROUPS, activeGroup: "gone" } }));
  run([URL_A]);
  assertRouted("Action");
});

test("the name is trimmed", () => {
  writeShared(shared({ enabled: true, names: { ...NAMES, g1: "  Action " } }));
  run([URL_A]);
  assertRouted("Action");
});

// ── The script ─────────────────────────────────────────────────────────────

test("the URL and the name reach AppleScript as arguments, never as script text", () => {
  const url = 'https://example.com/"&quit';
  writeShared(shared({ enabled: true, names: { ...NAMES, g1: 'Sp"ace' } }));
  run([url]);
  assertRouted('Sp"ace', url);
  const script = logOf("osascript").slice(0, -2).join("\n");
  assert.ok(!script.includes("example.com"));
  assert.ok(!script.includes('Sp"ace'), "the name stays out of the script");
  for (const line of ["on run argv", "set targetUrl to item 1 of argv", "set spaceName to item 2 of argv", "focus", "make new tab with properties {URL:targetUrl}"]) {
    assert.ok(script.includes(line), line);
  }
  assert.ok(script.includes('tell application id "company.thebrowser.Browser"'));
});

// ── Failing back to the real open ──────────────────────────────────────────

test("Arc not installed: the real open", () => {
  run([URL_A], { env: { ARC_SPACES_APP: join(dir, "no-such.app") } });
  assertPassedThrough([URL_A]);
});

test("a script failure (a space Arc doesn't have): the real open", () => {
  recorder("osascript", "exit 1");
  run([URL_A]);
  assert.deepEqual(logOf("real-open"), [URL_A]);
});

test("a hung Arc: stopped at the limit, then the real open", () => {
  tool("osascript", "exec sleep 600");
  const started = Date.now();
  run([URL_A], { env: { ARC_SPACES_TIMEOUT: "1" } });
  assert.ok(Date.now() - started < 300_000, "it must not wait for the sleep to end");
  assert.deepEqual(logOf("real-open"), [URL_A]);
});

test("Herdr's ls failing: the real open", () => {
  tool("herdr", "exit 1");
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("Herdr's ls answering garbage: the real open", () => {
  tool("herdr", "echo '{ not json'");
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("a broken shared.json: the real open", () => {
  writeShared("{ not json");
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("no shared.json: the real open", () => {
  rmSync(join(home, "shared.json"));
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

test("a stored registry of the wrong shape: the real open", () => {
  writeShared(shared(undefined, { "projects.v1": "nope", "projects.cache.v1": 7 }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
});

// ── The file itself ────────────────────────────────────────────────────────

test("the wrapper is executable and POSIX sh", () => {
  assert.ok(spawnSync("test", ["-x", WRAPPER]).status === 0);
  assert.equal(spawnSync("/bin/sh", ["-n", WRAPPER]).status, 0);
  assert.ok(readFileSync(WRAPPER, "utf8").startsWith("#!/bin/sh\n"));
});
