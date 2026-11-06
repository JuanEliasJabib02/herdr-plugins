// scripts/install.sh's safety guarantees: it never overwrites or removes a
// name it didn't install (it stops before touching anything), it drops what
// the plugin stopped shipping, --uninstall removes only what it installed,
// and a copy that fails partway leaves no half-written item and nothing it
// can't claim on the next run. Every run targets a fake Herdr home in a temp
// folder (HERDR_APP_HOME), never the person's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(repo, "scripts/install.sh");

const root = realpathSync(mkdtempSync(join(tmpdir(), "install-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const dir = join(root, String(++n));
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Files under dir, from { "relative/path": "content" }.
function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// Everything under dir: folders, file contents and links, by relative path.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = join(rel, name);
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out[path] = `-> ${readlinkSync(join(dir, path))}`;
      else if (st.isDirectory()) {
        out[`${path}/`] = "dir";
        walk(path);
      } else out[path] = readFileSync(join(dir, path), "utf8");
    }
  };
  walk("");
  return out;
}

// What a run left half-done: an item still being copied, an unswapped manifest.
const leftovers = (home) => Object.keys(snapshot(home)).filter((p) => /\.installing(\/|$)|\.new$/.test(p));

// A Herdr home as Herdr leaves it: mods and layouts folders, a keys.json.
function fakeHome(files = {}) {
  const home = join(freshDir(), "herdr-app");
  mkdirSync(join(home, "mods"), { recursive: true });
  mkdirSync(join(home, "layouts"));
  writeTree(home, { "keys.json": "{}\n", ...files });
  return home;
}

// A copy of this repo's installer next to a plugin folder `demo` holding
// `files`: the installer installs the plugin folders of its own repo.
function fakeRepo(files) {
  const dir = join(freshDir(), "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(INSTALL, join(dir, "scripts/install.sh"));
  writeTree(join(dir, "demo"), files);
  return { script: join(dir, "scripts/install.sh"), plugin: join(dir, "demo") };
}

function run(script, home, ...args) {
  assert.ok(home.startsWith(`${root}/`), `a fake home, never the person's: ${home}`);
  return spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, HOME: root, HERDR_APP_HOME: home } });
}

const manifest = (home, plugin) => readFileSync(join(home, ".herdr-plugins", `${plugin}.txt`), "utf8").split("\n").filter(Boolean).sort();

// A file cp can't read, so the copy of its folder fails partway.
function unreadable(path) {
  writeFileSync(path, "secret\n");
  chmodSync(path, 0o000);
}
const asRoot = process.getuid?.() === 0 && "root reads unreadable files";

// ── A name it didn't install stops it ──────────────────────────────────────

for (const [item, file] of [
  ["mods/projects", "mods/projects/main.js"],
  ["layouts/projects.json", "layouts/projects.json"],
]) {
  test(`a ${item} that isn't in the manifest stops the install: exit 1, named, nothing changed`, () => {
    const home = fakeHome({ [file]: "// theirs\n", "mods/other/main.js": "// theirs too\n" });
    const before = snapshot(home);
    const r = run(INSTALL, home, "--no-keys", "--alone");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`${home}/${item} exists and wasn't installed from projects-sidebar; nothing changed`));
    assert.deepEqual(snapshot(home), before, "nothing in the home changed");
    assert.equal(existsSync(join(home, ".herdr-plugins")), false, "no manifest written");
    assert.equal(readFileSync(join(home, file), "utf8"), "// theirs\n");
  });
}

// ── What the plugin stopped shipping ───────────────────────────────────────

test("re-install after the plugin stops shipping an item: it is removed and dropped from the manifest", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", "mods/b/main.js": "b\n", "layouts/demo.json": "{}\n" });
  const home = fakeHome({ "mods/other/main.js": "// theirs\n" });
  assert.equal(run(script, home, "demo").status, 0);
  assert.deepEqual(manifest(home, "demo"), ["layouts/demo.json", "mods/a", "mods/b"]);

  rmSync(join(plugin, "mods/b"), { recursive: true });
  const r = run(script, home, "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, "mods/b")), false);
  assert.match(r.stdout, new RegExp(`removed ${home}/mods/b`));
  assert.deepEqual(manifest(home, "demo"), ["layouts/demo.json", "mods/a"]);
  assert.equal(readFileSync(join(home, "mods/a/main.js"), "utf8"), "a\n");
  assert.equal(readFileSync(join(home, "mods/other/main.js"), "utf8"), "// theirs\n", "a foreign mod is never touched");
});

// ── --uninstall ────────────────────────────────────────────────────────────

test("--uninstall removes only what the manifest lists; a foreign mod stays", () => {
  const home = fakeHome({ "mods/other/main.js": "// theirs\n", "layouts/other.json": "{}\n" });
  const installed = run(INSTALL, home, "--no-keys", "--alone");
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(existsSync(join(home, "mods/projects/main.js")));

  const r = run(INSTALL, home, "--uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, "mods/projects")), false);
  assert.equal(existsSync(join(home, "layouts/projects.json")), false);
  assert.equal(existsSync(join(home, "layouts/projects.svg")), false);
  assert.equal(existsSync(join(home, ".herdr-plugins/projects-sidebar.txt")), false, "manifest removed");
  assert.deepEqual(snapshot(home), {
    ".herdr-plugins/": "dir",
    "keys.json": "{}\n",
    "layouts/": "dir",
    "layouts/other.json": "{}\n",
    "mods/": "dir",
    "mods/other/": "dir",
    "mods/other/main.js": "// theirs\n",
  });
});

// ── What a plugin requires ─────────────────────────────────────────────────

test("a plugin's requires file: each listed plugin folder of the repo is installed first, with its own manifest", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", requires: "# what demo's layout draws\ndep\n" });
  writeTree(join(dirname(plugin), "dep"), { "mods/dep/main.js": "dep\n" });
  const home = fakeHome();
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(manifest(home, "demo"), ["mods/a"]);
  assert.deepEqual(manifest(home, "dep"), ["mods/dep"]);
  assert.equal(readFileSync(join(home, "mods/dep/main.js"), "utf8"), "dep\n");
  assert.ok(r.stdout.indexOf("mods/dep") < r.stdout.indexOf("mods/a"), "the required plugin lands first");
});

test("a required plugin this repo doesn't have, or a name that isn't one, is named and the install still succeeds", () => {
  const { script } = fakeRepo({ "mods/a/main.js": "a\n", requires: "missing\n../up\n" });
  const home = fakeHome();
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /requires: missing isn't in this checkout/);
  assert.match(r.stderr, /requires: \.\.\/up isn't a plugin name/);
  assert.deepEqual(manifest(home, "demo"), ["mods/a"]);
  assert.equal(existsSync(join(home, ".herdr-plugins/missing.txt")), false);
});

test("an install its own check refuses installs nothing it requires either", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", requires: "dep\n" });
  writeTree(join(dirname(plugin), "dep"), { "mods/dep/main.js": "dep\n" });
  const home = fakeHome({ "mods/a/main.js": "// theirs\n" });
  const before = snapshot(home);
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(snapshot(home), before, "nothing in the home changed");
});

test("--alone installs only the plugin; --uninstall never removes what it requires", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", requires: "dep\n" });
  writeTree(join(dirname(plugin), "dep"), { "mods/dep/main.js": "dep\n" });
  const home = fakeHome();
  assert.equal(run(script, home, "--no-keys", "--alone", "demo").status, 0);
  assert.equal(existsSync(join(home, "mods/dep")), false);
  assert.equal(run(script, home, "--no-keys", "demo").status, 0);
  assert.ok(existsSync(join(home, "mods/dep/main.js")));
  assert.equal(run(script, home, "--uninstall", "demo").status, 0);
  assert.equal(existsSync(join(home, "mods/a")), false);
  assert.ok(existsSync(join(home, "mods/dep/main.js")), "another plugin may use it");
});

test("requires that loop back (demo needs dep, dep needs demo) install each once", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", requires: "dep\n" });
  writeTree(join(dirname(plugin), "dep"), { "mods/dep/main.js": "dep\n", requires: "demo\n" });
  const home = fakeHome();
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/^installed .*\/mods\/a$/gm) ?? []).length, 1);
  assert.equal((r.stdout.match(/^installed .*\/mods\/dep$/gm) ?? []).length, 1);
});

// ── A copy that fails partway ──────────────────────────────────────────────

test("a copy that fails partway: what landed stays owned, no .installing is left, the next run succeeds", { skip: asRoot }, () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", "mods/b/main.js": "b\n", "layouts/demo.json": "{}\n" });
  unreadable(join(plugin, "mods/b/secret.txt"));
  const home = fakeHome();

  const failed = run(script, home, "demo");
  assert.notEqual(failed.status, 0, "the copy of mods/b fails");
  assert.equal(readFileSync(join(home, "mods/a/main.js"), "utf8"), "a\n", "mods/a landed");
  assert.deepEqual(manifest(home, "demo"), ["mods/a"], "and is owned");
  assert.deepEqual(leftovers(home), [], "no half-written item or manifest left");
  assert.equal(existsSync(join(home, "mods/b")), false);
  assert.equal(existsSync(join(home, "layouts/demo.json")), false);

  chmodSync(join(plugin, "mods/b/secret.txt"), 0o644);
  const again = run(script, home, "demo");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(manifest(home, "demo"), ["layouts/demo.json", "mods/a", "mods/b"]);
  assert.equal(readFileSync(join(home, "mods/b/secret.txt"), "utf8"), "secret\n");
  assert.deepEqual(leftovers(home), []);
});

test("a run that fails partway prunes nothing; the next good run does", { skip: asRoot }, () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", "mods/old/main.js": "old\n", "layouts/demo.json": "{}\n" });
  const home = fakeHome();
  assert.equal(run(script, home, "demo").status, 0);

  rmSync(join(plugin, "mods/old"), { recursive: true });
  unreadable(join(plugin, "mods/a/secret.txt"));
  assert.notEqual(run(script, home, "demo").status, 0);
  assert.equal(readFileSync(join(home, "mods/old/main.js"), "utf8"), "old\n", "not pruned");
  assert.deepEqual(manifest(home, "demo"), ["layouts/demo.json", "mods/a", "mods/old"]);
  assert.deepEqual(leftovers(home), []);

  chmodSync(join(plugin, "mods/a/secret.txt"), 0o644);
  const r = run(script, home, "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, "mods/old")), false);
  assert.deepEqual(manifest(home, "demo"), ["layouts/demo.json", "mods/a"]);
});

test("the real agent-sleep plugin: its mod is copied, its keys merged, projects-sidebar's files left alone", () => {
  const home = fakeHome({ "layouts/projects.json": "the sidebar's\n", "mods/projects/main.js": "the sidebar's\n", "keys.json": "{}\n" });
  const r = run(INSTALL, home, "agent-sleep");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(manifest(home, "agent-sleep"), ["mods/agent-sleep"]);
  for (const file of ["main.js", "mod.json", "coordinator.js", "panel-model.js", "views/status.js", "views/panel.js", "icons/moon.svg"]) {
    assert.ok(existsSync(join(home, "mods/agent-sleep", file)), file);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(home, "keys.json"), "utf8"))["layout:projects"], {
    "cmd-alt-s": "agent-sleep.sleep-now",
    "cmd-alt-w": "agent-sleep.wake-all",
  });
  assert.equal(readFileSync(join(home, "layouts/projects.json"), "utf8"), "the sidebar's\n");
  assert.equal(readFileSync(join(home, "mods/projects/main.js"), "utf8"), "the sidebar's\n");
});

test("the real projects-sidebar install brings agent-sleep through requires, and nothing turns it on", () => {
  const home = fakeHome();
  const r = run(INSTALL, home, "--no-keys", "projects-sidebar");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(manifest(home, "agent-sleep"), ["mods/agent-sleep"]);
  assert.ok(existsSync(join(home, "mods/agent-sleep/main.js")));
  assert.match(readFileSync(join(home, "layouts/projects.json"), "utf8"), /"mod": "agent-sleep"/);
  assert.ok(!existsSync(join(home, "agent-sleep/settings.json")), "no settings file: off");
});
