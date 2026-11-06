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
import { parseRegistry, parseCache, matchSpaces, findProject, activeGroup } from "../projects-sidebar/mods/projects/lib.js";

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

// What Herdr's `ls` answers: `active` names the shown space. Each call is logged.
const lsAnswer = (spaces) => tool("herdr", `echo "$1" >> "${join(dir, "herdr.log")}"\ncat <<'EOF'\n${JSON.stringify({ spaces })}\nEOF`);

const space = (folder, extra = {}) => ({ id: `s-${folder}`, folder, machine: null, active: true, tabs: [], ...extra });
// A space's tabs holding these terminals, in order, as `ls` lists them.
const withTerminals = (...addresses) => ({ tabs: [{ id: "tb1", terminals: addresses.map((terminal) => ({ terminal })) }] });

// What herdr-core's `hc get <terminal>` answers, per terminal; any other
// terminal fails. Each call's terminal is logged.
const hcAnswer = (records) => tool("hc", [
  `printf '%s\\n' "$2" >> "${join(dir, "hc.log")}"`,
  "case $2 in",
  ...Object.entries(records).map(([terminal, record]) => `  ${terminal}) cat <<'EOF'\n${JSON.stringify(record)}\nEOF\n  ;;`),
  "  *) exit 1 ;;",
  "esac",
].join("\n"));

// The shapes projects-sidebar writes: a project has a name, a checkout its
// branch and whether it's the main one (lib.js isProject, isCheckout).
const project = (path) => ({ path, name: path.split("/").pop() });
const checkout = (path, main = false) => ({ path, branch: main ? "main" : "feature", main });

const GROUPS = {
  version: 1,
  activeGroup: "g2",
  groups: [
    { id: "g1", name: "Action Experience", projects: [project("/repos/action")] },
    { id: "g2", name: "Arrecife", projects: [project("/repos/mine")] },
    { id: "g3", name: "AG", projects: [project("/repos/ag")] },
  ],
};
const CACHE = {
  "/repos/action": [checkout("/repos/action", true), checkout("/work/action/feature")],
  "/repos/mine": [checkout("/repos/mine", true)],
  "/repos/ag": [checkout("/repos/ag", true), checkout("/repos/mine/nested-ag")],
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
function run(args, { parent = herdrParent, env = {}, capMs, prelude = "" } = {}) {
  const quoted = args.map((a) => `'${a}'`).join(" ");
  return spawnSync(parent, ["-c", `${prelude}'${WRAPPER}' ${quoted}; code=$?; exit $code`], {
    encoding: "utf8",
    // The timing tests' cap: a limit that stops holding fails them instead of
    // hanging the suite.
    timeout: capMs,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      HERDR_APP_HOME: home,
      ARC_SPACES_OPEN: join(dir, "real-open"),
      ARC_SPACES_OSASCRIPT: join(dir, "osascript"),
      ARC_SPACES_HERDR: join(dir, "herdr"),
      ARC_SPACES_HC: join(dir, "hc"),
      ARC_SPACES_APP: join(dir, "Arc.app"),
      // Under the whole suite macOS can take over 10 s to run a new script, so
      // the real limits would stop the fakes and fail the test.
      ARC_SPACES_TIMEOUT: "300",
      ARC_SPACES_LS_TIMEOUT: "300",
      ARC_SPACES_HC_TIMEOUT: "300",
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
  hcAnswer({});
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

test("switched off, names kept: off, and Herdr isn't asked", () => {
  writeShared(shared({ enabled: false, names: NAMES }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
  assert.equal(logOf("herdr"), null);
});

test("on with no group named: Herdr isn't asked", () => {
  writeShared(shared({ enabled: true, names: { g1: "  ", g2: "" } }));
  run([URL_A]);
  assertPassedThrough([URL_A]);
  assert.equal(logOf("herdr"), null);
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
  writeShared(shared(undefined, { "projects.cache.v1": { "/repos/action/": [checkout("/repos/action/", true)] } }));
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

// ── Where the space is now (projects-sidebar's placeOf) ────────────────────

test("a space whose terminal moved into a checkout belongs to that checkout's group", () => {
  lsAnswer([space("/repos/ag", withTerminals("t1"))]);
  hcAnswer({ t1: { address: "t1", cwd: "/repos/ag", foreground: { name: "zsh", cwd: "/work/action/feature" } } });
  run([URL_A]);
  assertRouted("Action");
});

test("a space made outside every group joins the group its terminal moved into", () => {
  lsAnswer([space("/Users/someone", withTerminals("t1"))]);
  hcAnswer({ t1: { cwd: "/Users/someone", foreground: { cwd: "/repos/ag/web" } } });
  run([URL_A]);
  assertRouted("Bulbasour");
});

test("with no foreground, the terminal's own folder", () => {
  lsAnswer([space("/Users/someone", withTerminals("t1"))]);
  hcAnswer({ t1: { cwd: "/repos/action", foreground: null } });
  run([URL_A]);
  assertRouted("Action");
});

test("the first terminal with a folder counts", () => {
  lsAnswer([space("/Users/someone", withTerminals("t1", "t2", "t3"))]);
  hcAnswer({ t1: { foreground: null }, t2: { cwd: "/repos/ag" }, t3: { cwd: "/repos/action" } });
  run([URL_A]);
  assertRouted("Bulbasour");
  assert.deepEqual(logOf("hc"), ["t1", "t2"]);
});

test("hc failing: the folder the space was made in", () => {
  lsAnswer([space("/repos/ag", withTerminals("t1"))]);
  tool("hc", "exit 1");
  run([URL_A]);
  assertRouted("Bulbasour");
});

test("a terminal hc can't read is skipped, as the sidebar skips a pane with no folder", () => {
  lsAnswer([space("/repos/ag", withTerminals("gone", "t2"))]);
  hcAnswer({ t2: { cwd: "/repos/action" } });
  run([URL_A]);
  assertRouted("Action");
  assert.deepEqual(logOf("hc"), ["gone", "t2"]);
});

// A fake hc for the timing tests, run once before the test: macOS can take
// seconds to start a script the first time, which would eat the limit before
// any terminal is asked and let the test pass without testing anything.
function slowHc(body) {
  const path = tool("hc", `[ "$1" = warm ] && exit 0\nprintf '%s\\n' "$2" >> "${join(dir, "hc.log")}"\n${body}`);
  spawnSync(path, ["warm"]);
}

// Whether a process whose command line holds `marker` is still running.
const running = (marker) => spawnSync("pgrep", ["-f", marker]).status === 0;

test("a hung hc: stopped at the limit with what it started, then the folder the space was made in", () => {
  lsAnswer([space("/repos/ag", withTerminals("t1", "t2"))]);
  // A number no other command line holds, so pgrep finds only this sleep.
  const marker = `sleep ${700_000 + Math.floor(Math.random() * 100_000)}`;
  slowHc(`exec ${marker}`);
  const result = run([URL_A], { env: { ARC_SPACES_HC_TIMEOUT: "3" }, capMs: 120_000 });
  assert.equal(result.signal, null, "the click must not wait for the sleep to end");
  assertRouted("Bulbasour");
  assert.deepEqual(logOf("hc"), ["t1"], "t1 is asked, and nothing after the limit");
  // Its own alarm ends the hc left running when the search was cut.
  assert.ok(endsSoon(marker), "the hung hc ends by itself, not left behind");
});

// Waits up to 6 s for the process holding `marker` to end.
function endsSoon(marker) {
  for (let i = 0; i < 60; i += 1) {
    if (!running(marker)) return true;
    spawnSync("sleep", ["0.1"]);
  }
  return false;
}

test("a zero, bad or huge limit is 1 s, not none", () => {
  lsAnswer([space("/repos/ag", withTerminals("t1"))]);
  for (const value of ["0", "0.5", "soon", "200000000"]) {
    const marker = `sleep ${700_000 + Math.floor(Math.random() * 100_000)}`;
    slowHc(`exec ${marker}`);
    rmSync(join(dir, "osascript.log"), { force: true });
    const result = run([URL_A], { env: { ARC_SPACES_HC_TIMEOUT: value }, capMs: 120_000 });
    assert.equal(result.signal, null, `ARC_SPACES_HC_TIMEOUT=${value} must still stop the search`);
    assertRouted("Bulbasour");
    assert.ok(endsSoon(marker), `ARC_SPACES_HC_TIMEOUT=${value}: the hung hc ends by itself`);
  }
});

test("an ignored SIGALRM, inherited from Herdr, doesn't turn the limits off", () => {
  lsAnswer([space("/repos/ag", withTerminals("t1"))]);
  const marker = `sleep ${700_000 + Math.floor(Math.random() * 100_000)}`;
  slowHc(`exec ${marker}`);
  const result = run([URL_A], { env: { ARC_SPACES_HC_TIMEOUT: "2" }, capMs: 120_000, prelude: "trap '' ALRM; " });
  assert.equal(result.signal, null, "the search must still stop");
  assertRouted("Bulbasour");
  assert.ok(endsSoon(marker), "the hung hc ends by itself");
});

test("many terminals hc can't read share one limit", () => {
  const terminals = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
  lsAnswer([space("/repos/ag", withTerminals(...terminals))]);
  slowHc("sleep 1\nexit 1");
  run([URL_A], { env: { ARC_SPACES_HC_TIMEOUT: "3" }, capMs: 120_000 });
  assertRouted("Bulbasour");
  const asked = logOf("hc") ?? [];
  assert.ok(asked.length >= 1 && asked.length < terminals.length, `asked ${asked.length} terminals`);
});

test("a repeated group id: only the first group counts, as parseRegistry keeps it", () => {
  const dup = { id: "g1", name: "Dup", projects: [project("/repos/action")] };
  writeShared(shared(undefined, { "projects.v1": { ...GROUPS, groups: [{ id: "g1", name: "Action Experience", projects: [project("/repos/other")] }, ...GROUPS.groups.slice(1), dup] } }));
  run([URL_A]);
  assertRouted("Personal");
});

test("a registry of another version reads as the sidebar's empty one: g1, active", () => {
  lsAnswer([space("/repos/ag")]);
  writeShared(shared(undefined, { "projects.v1": { ...GROUPS, version: 2 } }));
  run([URL_A]);
  assertRouted("Action");
});

test("a checkout the sidebar would drop takes its whole project with it", () => {
  writeShared(shared(undefined, { "projects.cache.v1": { ...CACHE, "/repos/action": [checkout("/repos/action", true), { path: "/work/action/feature" }] } }));
  run([URL_A]);
  assertRouted("Personal");
});

test("a project with no name counts for nothing, as the sidebar drops it", () => {
  writeShared(shared(undefined, { "projects.v1": { ...GROUPS, groups: [{ id: "g1", name: "Action Experience", projects: [{ path: "/repos/action" }] }, ...GROUPS.groups.slice(1)] } }));
  run([URL_A]);
  assertRouted("Personal");
});

test("a group the sidebar would drop isn't the fallback", () => {
  lsAnswer([space("/Users/someone")]);
  writeShared(shared(undefined, { "projects.v1": { ...GROUPS, activeGroup: "gone", groups: [{ id: "", name: "No id", projects: [] }, ...GROUPS.groups.slice(1)] } }));
  run([URL_A]);
  assertRouted("Personal");
});

test("a space on another machine: its terminals aren't asked", () => {
  lsAnswer([space("/repos/action", { machine: "vps", ...withTerminals("vps/t1") })]);
  hcAnswer({ "vps/t1": { cwd: "/repos/ag" } });
  run([URL_A]);
  assertRouted("Personal");
  assert.equal(logOf("hc"), null);
});

test("~ in the space's place is the home folder, as projects-sidebar reads it", () => {
  const action = join(dir, "repos/action");
  writeShared(shared(undefined, {
    "projects.v1": { ...GROUPS, groups: [{ id: "g1", name: "Action Experience", projects: [project(action)] }, ...GROUPS.groups.slice(1)] },
    "projects.cache.v1": { [action]: [checkout(action, true)] },
  }));
  lsAnswer([space("~/repos/action/src")]);
  run([URL_A]);
  assertRouted("Action");
});

test("a stored path that isn't absolute counts for nothing, as projects-sidebar drops it", () => {
  writeShared(shared(undefined, {
    "projects.v1": { ...GROUPS, groups: [{ id: "g1", name: "Action Experience", projects: [project("~/repos/action")] }, ...GROUPS.groups.slice(1)] },
    "projects.cache.v1": { "~/repos/action": [checkout("~/repos/action", true)], "/repos/ag": [checkout("/repos/ag", true), checkout("relative/ag")] },
  }));
  for (const folder of [join(dir, "repos/action"), "/repos/ag"]) {
    lsAnswer([space(folder)]);
    rmSync(join(dir, "osascript.log"), { force: true });
    run([URL_A]);
    assertRouted("Personal");
  }
});

test("the name is trimmed", () => {
  writeShared(shared({ enabled: true, names: { ...NAMES, g1: "  Action " } }));
  run([URL_A]);
  assertRouted("Action");
});

// ── The same group as the sidebar ──────────────────────────────────────────
// Each case runs through projects-sidebar's own lib.js and through the wrapper:
// the Arc space that opens must be the one of the group the sidebar puts the
// space in. The wrapper copies those rules into jq, so this is what keeps the
// two from drifting apart.

const ALL_NAMES = Object.fromEntries(["g1", "g2", "g3", "g4"].map((id) => [id, `Space-${id}`]));

function sidebarGroup({ registry, cache, folder, live, machine = null }) {
  const sp = space(folder, { machine, ...withTerminals("t1") });
  const panes = live ? [{ tab: "tb1", cwd: live }] : [];
  const parsed = parseRegistry(registry);
  const match = matchSpaces(parseCache(cache), [sp], panes, dir)[sp.id];
  return ((match && findProject(parsed, match.project)?.group) ?? activeGroup(parsed)).id;
}

const twoGroupsWithAction = (first, second) => ({ ...GROUPS, groups: [first, second, GROUPS.groups[2]] });
const PARITY = [
  { name: "a checkout of a project", folder: "/repos/action/src" },
  { name: "a worktree", folder: "/work/action/feature" },
  { name: "the longest checkout", folder: "/repos/mine/nested-ag/src" },
  { name: "a prefix that isn't a folder", folder: "/repos/action-other" },
  { name: "outside every group", folder: "/Users/someone" },
  { name: "on another machine", folder: "/repos/action", machine: "vps", live: "/repos/ag" },
  { name: "a terminal moved into a checkout", folder: "/Users/someone", live: "/repos/ag/web" },
  { name: "a terminal moved out of one", folder: "/repos/ag", live: "/Users/someone" },
  { name: "~ in the place", folder: "~/repos/action", cache: { "DIR/repos/action": [checkout("DIR/repos/action", true)] }, registry: twoGroupsWithAction({ id: "g1", name: "A", projects: [project("DIR/repos/action")] }, GROUPS.groups[1]) },
  { name: "trailing slashes stored", folder: "/repos/action", cache: { "/repos/action/": [checkout("/repos/action/", true)] }, registry: twoGroupsWithAction({ id: "g1", name: "A", projects: [project("/repos/action/")] }, GROUPS.groups[1]) },
  { name: "~ stored", folder: "DIR/repos/action", cache: { "~/repos/action": [checkout("~/repos/action", true)] }, registry: twoGroupsWithAction({ id: "g1", name: "A", projects: [project("~/repos/action")] }, GROUPS.groups[1]) },
  { name: "a checkout without branch", folder: "/repos/action", cache: { ...CACHE, "/repos/action": [{ path: "/repos/action", main: true }] } },
  { name: "a project without name", folder: "/repos/action", registry: twoGroupsWithAction({ id: "g1", name: "A", projects: [{ path: "/repos/action" }] }, GROUPS.groups[1]) },
  { name: "a repeated group id", folder: "/repos/action", registry: { ...GROUPS, groups: [{ id: "g3", name: "First", projects: [] }, ...GROUPS.groups] } },
  { name: "a path in two groups", folder: "/repos/action", registry: { ...GROUPS, groups: [{ id: "g4", name: "Also", projects: [project("/repos/action")] }, ...GROUPS.groups] } },
  { name: "a group with no id", folder: "/Users/someone", registry: { ...GROUPS, activeGroup: "gone", groups: [{ id: "", name: "No id", projects: [] }, ...GROUPS.groups.slice(1)] } },
  { name: "an unknown active group", folder: "/Users/someone", registry: { ...GROUPS, activeGroup: "gone" } },
  { name: "another registry version", folder: "/repos/ag", registry: { ...GROUPS, version: 2 } },
  { name: "a registry of the wrong shape", folder: "/repos/ag", registry: "nope" },
  { name: "no registry", folder: "/repos/ag", registry: undefined },
  { name: "a cache of the wrong shape", folder: "/repos/ag", cache: 7 },
  { name: "the same checkout under two projects: the first", folder: "/repos/x/y", cache: { "/repos/action": [checkout("/repos/x", true)], "/repos/ag": [checkout("/repos/x/", true)] } },
];

test("every case lands in the group projects-sidebar's lib.js picks", () => {
  const withDir = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value).replaceAll("DIR", dir)));
  for (const c of PARITY) {
    const kase = {
      ...c,
      folder: c.folder.replace("DIR", dir),
      registry: "registry" in c ? withDir(c.registry) : GROUPS,
      cache: "cache" in c ? withDir(c.cache) : CACHE,
    };
    const stored = { "arc-spaces.v1": { enabled: true, names: ALL_NAMES }, "projects.cache.v1": kase.cache };
    if (kase.registry !== undefined) stored["projects.v1"] = kase.registry;
    writeShared(stored);
    lsAnswer([space(kase.folder, { machine: kase.machine ?? null, ...withTerminals("t1") })]);
    hcAnswer(kase.live ? { t1: { cwd: kase.live } } : {});
    for (const log of ["osascript.log", "real-open.log"]) rmSync(join(dir, log), { force: true });
    run([URL_A]);
    assert.deepEqual(routed()?.space, `Space-${sidebarGroup(kase)}`, c.name);
  }
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
  tool("osascript", `echo started > "${join(dir, "osascript.log")}"\nexec sleep 600`);
  const started = Date.now();
  run([URL_A], { env: { ARC_SPACES_TIMEOUT: "1" } });
  assert.ok(Date.now() - started < 300_000, "it must not wait for the sleep to end");
  assert.deepEqual(logOf("osascript"), ["started"], "Arc was asked");
  assert.deepEqual(logOf("real-open"), [URL_A]);
});

test("an osascript that can't start: the real open", () => {
  run([URL_A], { env: { ARC_SPACES_OSASCRIPT: join(dir, "no-such-osascript") } });
  assertPassedThrough([URL_A]);
});

test("a hung Herdr ls: stopped at the limit, then the real open", () => {
  tool("herdr", "exec sleep 600");
  const started = Date.now();
  run([URL_A], { env: { ARC_SPACES_LS_TIMEOUT: "1" } });
  assert.ok(Date.now() - started < 300_000, "it must not wait for the sleep to end");
  assertPassedThrough([URL_A]);
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

test("no stored registry at all reads as the sidebar's empty one: g1", () => {
  const { "projects.v1": _, ...rest } = shared();
  writeShared(rest);
  run([URL_A]);
  assertRouted("Action");
});

test("a stored registry of the wrong shape reads as the sidebar's empty one: g1", () => {
  writeShared(shared(undefined, { "projects.v1": "nope", "projects.cache.v1": 7 }));
  run([URL_A]);
  assertRouted("Action");
});

// ── The file itself ────────────────────────────────────────────────────────

test("the wrapper is executable and POSIX sh", () => {
  assert.ok(spawnSync("test", ["-x", WRAPPER]).status === 0);
  assert.equal(spawnSync("/bin/sh", ["-n", WRAPPER]).status, 0);
  assert.ok(readFileSync(WRAPPER, "utf8").startsWith("#!/bin/sh\n"));
});
