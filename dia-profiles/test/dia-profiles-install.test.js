// scripts/install.sh with this plugin, on a fake Herdr home: it brings only
// its own mod, the wrapper stays executable at the path the sudo line links to,
// and removing the plugin leaves a dangling link that `open` simply skips.
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK, isLinked } from "../mods/dia-profiles/model.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL = join(repo, "scripts/install.sh");
const WRAPPER = "mods/dia-profiles/bin/open";

let dir, home;
const install = (...args) => spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dia-profiles-install-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("it installs only its own mod, with no layout and no keys", () => {
  const result = install("dia-profiles");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(home, "mods")), ["dia-profiles"], "projects-sidebar must not come along");
  assert.deepEqual(readdirSync(join(home, "layouts")), []);
  assert.equal(existsSync(join(home, "keys.json")), false);
  assert.equal(readFileSync(join(home, ".herdr-plugins/dia-profiles.txt"), "utf8"), "mods/dia-profiles\n");
});

test("the installed wrapper is executable", () => {
  install("dia-profiles");
  assert.ok(statSync(join(home, WRAPPER)).mode & 0o111);
});

test("uninstalling removes it", () => {
  install("dia-profiles");
  assert.equal(install("--uninstall", "dia-profiles").status, 0);
  assert.equal(existsSync(join(home, "mods/dia-profiles")), false);
});

test("the RECIPE's lines link and unlink what the dialog checks", () => {
  const recipe = readFileSync(join(repo, "dia-profiles/RECIPE.md"), "utf8");
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
