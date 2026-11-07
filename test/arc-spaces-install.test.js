// T3: scripts/install.sh with this plugin, on a fake Herdr home: it brings only
// its own mod, the wrapper stays executable at the path the sudo line links to,
// and removing the plugin leaves a dangling link that `open` simply skips.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK, isLinked } from "../arc-spaces/mods/arc-spaces/model.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(repo, "scripts/install.sh");
const WRAPPER = "mods/arc-spaces/bin/open";

let dir, home;
const install = (...args) => spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arc-spaces-install-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("it installs only its own mod, with no layout and no keys", () => {
  const result = install("arc-spaces");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(home, "mods")), ["arc-spaces"], "projects-sidebar must not come along");
  assert.deepEqual(readdirSync(join(home, "layouts")), []);
  assert.equal(existsSync(join(home, "keys.json")), false);
  assert.equal(readFileSync(join(home, ".herdr-plugins/arc-spaces.txt"), "utf8"), "mods/arc-spaces\n");
});

test("the installed wrapper is executable", () => {
  install("arc-spaces");
  assert.ok(statSync(join(home, WRAPPER)).mode & 0o111);
});

test("uninstalling removes it", () => {
  install("arc-spaces");
  assert.equal(install("--uninstall", "arc-spaces").status, 0);
  assert.equal(existsSync(join(home, "mods/arc-spaces")), false);
});

test("the RECIPE's lines link and unlink what the dialog checks", () => {
  const recipe = readFileSync(join(repo, "arc-spaces/RECIPE.md"), "utf8");
  assert.ok(recipe.includes(`sudo ln -s ~/.config/herdr-app/${WRAPPER} ${LINK}`));
  assert.ok(recipe.includes(`sudo rm ${LINK}`));
  assert.ok(isLinked(`${home}/${WRAPPER}\n`, home));
});

test("a link pointing nowhere is skipped, and the next `open` on PATH runs", () => {
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(join(home, WRAPPER), join(first, "open"));
  writeFileSync(join(second, "open"), "#!/bin/sh\necho the-real-one\n");
  chmodSync(join(second, "open"), 0o755);
  const result = spawnSync("open", [], { encoding: "utf8", env: { PATH: `${first}:${second}` } });
  assert.equal(result.stdout.trim(), "the-real-one");
});
