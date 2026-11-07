// scripts/install.sh's safety guarantees: it never overwrites or removes a
// name it didn't install (it stops before touching anything), it drops what
// the plugin stopped shipping, --uninstall removes only what it installed,
// and a copy that fails partway leaves no half-written item and nothing it
// can't claim on the next run. The same holds for the commands a plugin's
// `bin` file puts on PATH (links in ~/.local/bin). Every run targets a fake
// Herdr home in a temp folder (HERDR_APP_HOME) and a fake HOME beside it,
// never the person's.
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
  symlinkSync,
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

// Each fake Herdr home has its own fake HOME, its parent folder, so the
// command links of one test (HOME/.local/bin) never meet another's.
const userHome = (home) => dirname(home);
const binDir = (home) => join(userHome(home), ".local/bin");

function run(script, home, ...args) {
  assert.ok(home.startsWith(`${root}/`), `a fake home, never the person's: ${home}`);
  return spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, HOME: userHome(home), HERDR_APP_HOME: home } });
}

const manifest = (home, plugin) => readFileSync(join(home, ".herdr-plugins", `${plugin}.txt`), "utf8").split("\n").filter(Boolean).sort();

// Whether anything is at path, a dangling link included.
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// The node with id in a layout tree.
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

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

// ── Commands on PATH (a plugin's `bin` file) ───────────────────────────────

// A plugin `demo` whose mod `a` ships the command `a` and lists it in its
// `bin` file, as spotlight lists its CLI.
function commandRepo(extra = {}) {
  const r = fakeRepo({
    "mods/a/main.js": "a\n",
    "mods/a/bin/a": '#!/bin/sh\necho "a ran $*"\n',
    bin: "# commands on PATH\nmods/a/bin/a\n",
    ...extra,
  });
  chmodSync(join(r.plugin, "mods/a/bin/a"), 0o755);
  return r;
}

test("a plugin's bin file: each command is linked into ~/.local/bin, owned in the manifest, and runs the installed copy; a re-install keeps it", () => {
  const { script } = commandRepo();
  const home = fakeHome();
  const link = join(binDir(home), "a");

  const r = run(script, home, "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(link), join(home, "mods/a/bin/a"), "it points at the installed copy, never the checkout");
  assert.match(r.stdout, new RegExp(`linked ${link} -> ${home}/mods/a/bin/a`));
  assert.deepEqual(manifest(home, "demo"), [link, "mods/a"]);
  assert.equal(spawnSync(link, ["x"], { encoding: "utf8" }).stdout, "a ran x\n");

  const again = run(script, home, "demo");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readlinkSync(link), join(home, "mods/a/bin/a"));
  assert.deepEqual(manifest(home, "demo"), [link, "mods/a"]);
  assert.deepEqual(leftovers(home), []);
});

test("--uninstall removes the command's link and nothing else in ~/.local/bin", () => {
  const { script } = commandRepo();
  const home = fakeHome();
  const link = join(binDir(home), "a");
  writeTree(binDir(home), { other: "theirs\n" });
  assert.equal(run(script, home, "demo").status, 0);

  const r = run(script, home, "--uninstall", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`removed ${link}`));
  assert.equal(present(link), false);
  assert.equal(existsSync(join(home, "mods/a")), false);
  assert.equal(existsSync(join(home, ".herdr-plugins/demo.txt")), false, "manifest removed");
  assert.deepEqual(snapshot(binDir(home)), { other: "theirs\n" });
});

for (const [what, plant] of [
  ["a file", (link) => writeFileSync(link, "theirs\n")],
  ["a link to another program", (link) => symlinkSync("/usr/bin/true", link)],
]) {
  test(`${what} where a command's link goes stops the install: exit 1, named, nothing changed`, () => {
    const { script, plugin } = commandRepo({ requires: "dep\n" });
    writeTree(join(dirname(plugin), "dep"), { "mods/dep/main.js": "dep\n" });
    const home = fakeHome();
    const link = join(binDir(home), "a");
    mkdirSync(binDir(home), { recursive: true });
    plant(link);
    const before = snapshot(userHome(home));

    const r = run(script, home, "demo");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`${link} exists and wasn't installed from demo; nothing changed`));
    assert.deepEqual(snapshot(userHome(home)), before, "neither Herdr's home nor ~/.local/bin changed, and nothing it requires was installed");
  });
}

test("the plugin stops shipping a command: the next install removes its link", () => {
  const { script, plugin } = commandRepo();
  const home = fakeHome();
  const link = join(binDir(home), "a");
  assert.equal(run(script, home, "demo").status, 0);

  writeFileSync(join(plugin, "bin"), "# nothing on PATH now\n");
  const r = run(script, home, "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`removed ${link}`));
  assert.equal(present(link), false);
  assert.deepEqual(manifest(home, "demo"), ["mods/a"]);
});

test("a bin line that isn't an executable of the plugin's mods, or a name already taken, is named and skipped; the rest install", () => {
  const { script, plugin } = commandRepo({
    "mods/b/bin/a": "#!/bin/sh\necho b\n",
    bin: "../a\n/usr/bin/true\nlayouts/x\nmods/a/main.js\nmods/a/missing\nmods/a/../a/bin/a\nmods/a/bin/a\nmods/b/bin/a\n",
  });
  chmodSync(join(plugin, "mods/b/bin/a"), 0o755);
  const home = fakeHome();
  const link = join(binDir(home), "a");

  const r = run(script, home, "demo");
  assert.equal(r.status, 0, r.stderr);
  for (const bad of ["\\.\\./a", "/usr/bin/true", "layouts/x", "mods/a/\\.\\./a/bin/a"]) {
    assert.match(r.stderr, new RegExp(`bin: ${bad} isn't a file of the plugin's mods; skipped`));
  }
  for (const bad of ["mods/a/main.js", "mods/a/missing"]) {
    assert.match(r.stderr, new RegExp(`bin: ${bad} isn't an executable file of the plugin; skipped`));
  }
  assert.match(r.stderr, /bin: mods\/b\/bin\/a: a command named a is already listed; skipped/);
  assert.equal(readlinkSync(link), join(home, "mods/a/bin/a"), "the first one listed wins");
  assert.deepEqual(manifest(home, "demo"), [link, "mods/a", "mods/b"]);
  assert.deepEqual(readdirSync(binDir(home)), ["a"]);
});

// ── A plugin's themes ──────────────────────────────────────────────────────

test("a plugin's themes/*.json land in the home's themes folder, owned in the manifest, and a re-install keeps them; what isn't a theme stays in the repo", () => {
  const { script } = fakeRepo({ "mods/a/main.js": "a\n", "themes/demo.json": "{}\n", "themes/LICENSE": "MIT\n" });
  const home = fakeHome();
  for (const attempt of ["first", "again"]) {
    const r = run(script, home, "--no-keys", "demo");
    assert.equal(r.status, 0, `${attempt}: ${r.stderr}`);
    assert.equal(readFileSync(join(home, "themes/demo.json"), "utf8"), "{}\n", attempt);
    assert.equal(existsSync(join(home, "themes/LICENSE")), false, "Herdr reads themes/*.json; a license there would clash with another plugin's");
    assert.deepEqual(manifest(home, "demo"), ["mods/a", "themes/demo.json"], attempt);
    assert.deepEqual(leftovers(home), [], attempt);
  }
});

test("a theme that isn't in the manifest stops the install: exit 1, named, nothing changed", () => {
  const { script } = fakeRepo({ "mods/a/main.js": "a\n", "themes/demo.json": "{}\n" });
  const home = fakeHome({ "themes/demo.json": "// theirs\n" });
  const before = snapshot(home);
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`${home}/themes/demo.json exists and wasn't installed from demo; nothing changed`));
  assert.deepEqual(snapshot(home), before, "nothing in the home changed");
});

test("--uninstall removes the plugin's themes; a foreign theme stays", () => {
  const { script } = fakeRepo({ "themes/demo.json": "{}\n" });
  const home = fakeHome({ "themes/other.json": "// theirs\n" });
  assert.equal(run(script, home, "--no-keys", "demo").status, 0);
  assert.ok(existsSync(join(home, "themes/demo.json")));

  const r = run(script, home, "--uninstall", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`removed ${home}/themes/demo.json`));
  assert.equal(existsSync(join(home, "themes/demo.json")), false);
  assert.equal(readFileSync(join(home, "themes/other.json"), "utf8"), "// theirs\n");
});

test("the plugin stops shipping a theme: the next install removes it", () => {
  const { script, plugin } = fakeRepo({ "mods/a/main.js": "a\n", "themes/demo.json": "{}\n" });
  const home = fakeHome();
  assert.equal(run(script, home, "--no-keys", "demo").status, 0);
  assert.ok(existsSync(join(home, "themes/demo.json")));

  rmSync(join(plugin, "themes/demo.json"));
  const r = run(script, home, "--no-keys", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, "themes/demo.json")), false);
  assert.deepEqual(manifest(home, "demo"), ["mods/a"]);
});

test("a plugin with no themes leaves the home without a themes folder", () => {
  const { script } = fakeRepo({ "mods/a/main.js": "a\n" });
  const home = fakeHome();
  assert.equal(run(script, home, "--no-keys", "demo").status, 0);
  assert.equal(existsSync(join(home, "themes")), false);
});

// ── This repo's plugins: spotlight and projects-sidebar ────────────────────

test("spotlight puts its CLI on PATH as ~/.local/bin/spotlight: it runs through that link and a relative link to it, finds node off PATH, and --uninstall removes it", () => {
  const home = fakeHome();
  const link = join(binDir(home), "spotlight");
  const r = run(INSTALL, home, "spotlight");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(link), join(home, "mods/spotlight/bin/spotlight"));
  assert.deepEqual(manifest(home, "spotlight"), [link, "mods/spotlight"]);

  const help = spawnSync(link, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^spotlight: /);

  const hop = join(userHome(home), "tools/sl");
  mkdirSync(dirname(hop));
  symlinkSync("../.local/bin/spotlight", hop);
  const viaHop = spawnSync(hop, ["--help"], { encoding: "utf8" });
  assert.equal(viaHop.status, 0, viaHop.stderr);
  assert.match(viaHop.stdout, /^spotlight: /);

  // A PATH with no node: bin/spotlight falls back to Homebrew's (or /usr/local's).
  const offPath = spawnSync(link, ["--help"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
  if (["/usr/bin/node", "/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"].some(existsSync)) {
    assert.equal(offPath.status, 0, offPath.stderr);
    assert.match(offPath.stdout, /^spotlight: /);
  } else {
    assert.equal(offPath.status, 127);
    assert.match(offPath.stderr, /spotlight: node not found/);
  }

  const gone = run(INSTALL, home, "--uninstall", "spotlight");
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(present(link), false);
  assert.equal(existsSync(join(home, "mods/spotlight")), false);
});

test("projects-sidebar requires spotlight: it lands first, with its command, and the installed layout draws its footer between workspace-status and claude-accounts (D20)", () => {
  const home = fakeHome();
  const r = run(INSTALL, home, "--no-keys");
  assert.equal(r.status, 0, r.stderr);
  const spot = r.stdout.indexOf(`installed ${home}/mods/spotlight\n`);
  assert.ok(spot !== -1, r.stdout);
  assert.ok(spot < r.stdout.indexOf(`installed ${home}/mods/projects\n`), "spotlight lands before projects-sidebar");
  assert.equal(readlinkSync(join(binDir(home), "spotlight")), join(home, "mods/spotlight/bin/spotlight"));
  assert.deepEqual(manifest(home, "spotlight"), [join(binDir(home), "spotlight"), "mods/spotlight"]);

  const status = find(JSON.parse(readFileSync(join(home, "layouts/projects.json"), "utf8")), "status");
  assert.deepEqual(
    status.children.map((c) => c.id),
    ["status-workspace", "status-spotlight", "status-usage", "status-keep-awake", "status-agent-sleep"],
  );
  assert.deepEqual(status.children[1], {
    id: "status-spotlight",
    type: "block",
    size: { px: 40 },
    content: { mod: "spotlight", props: { view: "footer" } },
  });
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

test("the real projects-sidebar install brings keep-awake through requires, and nothing turns it on (keep-awake D4, D10)", () => {
  const home = fakeHome();
  const r = run(INSTALL, home, "--no-keys", "projects-sidebar");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(manifest(home, "keep-awake"), ["mods/keep-awake"]);
  for (const file of ["main.js", "mod.json", "icons/coffee.svg"]) {
    assert.ok(existsSync(join(home, "mods/keep-awake", file)), file);
  }
  assert.match(readFileSync(join(home, "layouts/projects.json"), "utf8"), /"mod": "keep-awake"/);
  assert.ok(!existsSync(join(home, "keep-awake")), "no state of its own until it runs: the mode starts off");
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
