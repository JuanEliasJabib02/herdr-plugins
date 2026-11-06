// T4: F1–F3 switch groups through the plugin's keys.json (section
// layout:projects), merged into the person's keys.json by the installer:
// missing keys only, never a key they use (warned instead), a backup before
// the write, and a second run changes nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeKeys, backupName } from "../scripts/keys-merge.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const MERGE = join(repo, "scripts/keys-merge.mjs");
const INSTALL = join(repo, "scripts/install.sh");
const PLUGIN_KEYS = join(repo, "projects-sidebar/keys.json");
const plugin = () => JSON.parse(readFileSync(PLUGIN_KEYS, "utf8"));

// A person's keys.json shaped like Herdr's own: F2 renames a tab everywhere,
// control characters escaped, an object action, other layouts and mods.
const HERDR = {
  global: {
    "cmd-t": "tab.new",
    f2: "tab.rename",
    "shift-f2": "space.rename",
    "ctrl-shift-r": { command: "layout.resize", args: { id: "sidebar", px: 240 } },
  },
  terminal: { "alt-left": "send:\u001bb", "cmd-c": "terminal.copy" },
  "layout:terminals": { "ctrl-shift-pagedown": "space.next" },
  "mod:editor": { "ctrl-s": "editor.save" },
};

const bindings = (keys) => Object.entries(keys).flatMap(([section, map]) => Object.entries(map).map(([key, action]) => [section, key, action]));

const root = realpathSync(mkdtempSync(join(tmpdir(), "keys-merge-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const dir = join(root, String(++n));
  mkdirSync(dir, { recursive: true });
  return dir;
};
const backups = (dir) => readdirSync(dir).filter((f) => f.startsWith("keys.json.bak-")).sort();
const merge = (pluginPath, personPath) => spawnSync(process.execPath, [MERGE, pluginPath, personPath], { encoding: "utf8" });

// ── The plugin's keys ──────────────────────────────────────────────────────

test("plugin keys.json: F1–F3 run projects.group1..3, only in layout:projects", () => {
  assert.deepEqual(plugin(), {
    "layout:projects": { f1: "projects.group1", f2: "projects.group2", f3: "projects.group3" },
  });
});

// ── mergeKeys (pure) ───────────────────────────────────────────────────────

test("merge adds only the layout:projects section, after the person's sections", () => {
  const { keys, added, changed } = mergeKeys(HERDR, plugin());
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(keys), [...Object.keys(HERDR), "layout:projects"]);
  for (const section of Object.keys(HERDR)) assert.deepEqual(keys[section], HERDR[section], section);
  assert.deepEqual(keys["layout:projects"], { f1: "projects.group1", f2: "projects.group2", f3: "projects.group3" });
  assert.deepEqual(added, [
    { section: "layout:projects", key: "f1", action: "projects.group1" },
    { section: "layout:projects", key: "f2", action: "projects.group2" },
    { section: "layout:projects", key: "f3", action: "projects.group3" },
  ]);
});

test("merge keeps every other key: F2 still renames tabs outside the projects layout", () => {
  const before = structuredClone(HERDR);
  const { keys } = mergeKeys(HERDR, plugin());
  assert.deepEqual(HERDR, before, "the person's value is not mutated");
  for (const [section, key, action] of bindings(HERDR)) assert.deepEqual(keys[section][key], action, `${section} ${key}`);
  assert.equal(bindings(keys).length, bindings(HERDR).length + 3);
  assert.equal(keys.global.f2, "tab.rename");
  assert.equal(keys.terminal["alt-left"], "send:\u001bb");
});

test("merge is idempotent: merging the result again adds nothing", () => {
  const once = mergeKeys(HERDR, plugin()).keys;
  const twice = mergeKeys(once, plugin());
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.kept, []);
  assert.deepEqual(twice.keys, once);
});

test("merge never replaces a key the person uses: it is kept and reported", () => {
  const person = { ...HERDR, "layout:projects": { F2: "space.rename", f3: "projects.group3" } };
  const { keys, added, kept } = mergeKeys(person, plugin());
  assert.deepEqual(keys["layout:projects"], { F2: "space.rename", f3: "projects.group3", f1: "projects.group1" });
  assert.deepEqual(added, [{ section: "layout:projects", key: "f1", action: "projects.group1" }]);
  assert.deepEqual(kept, [{ section: "layout:projects", key: "F2", theirs: "space.rename", action: "projects.group2" }]);
});

test("merge reports a layout key that shadows a global one (F2 → tab.rename)", () => {
  const { shadows } = mergeKeys(HERDR, plugin());
  assert.deepEqual(shadows, [{ section: "layout:projects", key: "f2", action: "projects.group2", global: "tab.rename" }]);
  assert.deepEqual(mergeKeys(mergeKeys(HERDR, plugin()).keys, plugin()).shadows, [], "only for keys added now");
});

test("merge leaves a section that isn't an object alone and reports it", () => {
  const person = { global: { f2: "tab.rename" }, "layout:projects": "broken" };
  const { keys, added, skipped, changed } = mergeKeys(person, plugin());
  assert.equal(changed, false);
  assert.equal(keys["layout:projects"], "broken");
  assert.deepEqual(added, []);
  assert.deepEqual(skipped, ["layout:projects"]);
});

test("merge refuses values that aren't keys files", () => {
  for (const bad of [null, [], "keys", 3]) assert.throws(() => mergeKeys(bad, plugin()), /keys file/);
  assert.throws(() => mergeKeys(HERDR, { "layout:projects": "projects.group1" }), /plugin/);
  assert.throws(() => mergeKeys(HERDR, []), /plugin/);
});

test("backup name: keys.json.bak-<YYYYMMDD-HHMMSS>, local time", () => {
  assert.equal(backupName("/h/keys.json", new Date(2026, 10, 5, 9, 3, 7)), "/h/keys.json.bak-20261105-090307");
});

// ── The CLI the installer runs ─────────────────────────────────────────────

test("CLI: backs the file up, then writes; a second run changes nothing", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  const original = `${JSON.stringify(HERDR, null, 2)}\n`;
  writeFileSync(person, original);

  const first = merge(PLUGIN_KEYS, person);
  assert.equal(first.status, 0, first.stderr);
  const written = readFileSync(person, "utf8");
  assert.deepEqual(JSON.parse(written), mergeKeys(HERDR, plugin()).keys);
  assert.ok(written.endsWith("}\n") && written.includes('\n  "layout:projects": {\n    "f1"'), "two-space indent, final newline");
  assert.ok(written.includes('"send:\\u001bb"'), "control characters stay escaped");
  assert.equal(backups(dir).length, 1);
  assert.equal(readFileSync(join(dir, backups(dir)[0]), "utf8"), original, "the backup is the file as it was");
  assert.match(first.stdout, /added f1 → projects\.group1/);

  const second = merge(PLUGIN_KEYS, person);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(person, "utf8"), written, "unchanged");
  assert.equal(backups(dir).length, 1, "no second backup");
  assert.match(second.stdout, /nothing to add/);
});

test("CLI: keeps the file's own indentation", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  writeFileSync(person, `${JSON.stringify(HERDR, null, 4)}\n`);
  assert.equal(merge(PLUGIN_KEYS, person).status, 0);
  assert.ok(readFileSync(person, "utf8").includes('\n    "layout:projects": {\n        "f1"'));
});

test("CLI: a key the person uses is kept, with a warning", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  writeFileSync(person, JSON.stringify({ ...HERDR, "layout:projects": { f2: "space.rename" } }, null, 2));
  const r = merge(PLUGIN_KEYS, person);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(person, "utf8"))["layout:projects"].f2, "space.rename");
  assert.match(r.stderr, /f2 .*space\.rename.*kept/);
});

test("CLI: a keys.json that is a symlink (dotfiles) stays one; its target gets the keys and keeps its mode", () => {
  const dir = freshDir();
  mkdirSync(join(dir, "dotfiles"));
  mkdirSync(join(dir, "herdr-app"));
  const target = join(dir, "dotfiles/keys.json");
  const original = `${JSON.stringify(HERDR, null, 2)}\n`;
  writeFileSync(target, original);
  chmodSync(target, 0o600);
  const link = join(dir, "herdr-app/keys.json");
  symlinkSync("../dotfiles/keys.json", link);

  const r = merge(PLUGIN_KEYS, link);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(link).isSymbolicLink(), "still a symlink");
  assert.equal(readlinkSync(link), "../dotfiles/keys.json");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), mergeKeys(HERDR, plugin()).keys);
  assert.equal(statSync(target).mode & 0o777, 0o600, "mode kept");
  assert.equal(backups(join(dir, "dotfiles")).length, 1, "backed up next to the real file");
  assert.equal(readFileSync(join(dir, "dotfiles", backups(join(dir, "dotfiles"))[0]), "utf8"), original);
  for (const d of ["dotfiles", "herdr-app"]) assert.deepEqual(readdirSync(join(dir, d)).filter((f) => f.includes(".merging-")), [], `no temp file left in ${d}`);
});

test("CLI: a plain keys.json keeps its mode", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  writeFileSync(person, `${JSON.stringify(HERDR, null, 2)}\n`);
  chmodSync(person, 0o600);
  assert.equal(merge(PLUGIN_KEYS, person).status, 0);
  assert.equal(statSync(person).mode & 0o777, 0o600);
});

test("CLI: no keys file → nothing is created", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  const r = merge(PLUGIN_KEYS, person);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(person), false);
  assert.deepEqual(backups(dir), []);
  assert.match(r.stderr, /no .*keys\.json/);
});

test("CLI: an invalid keys file is left untouched and fails", () => {
  const dir = freshDir();
  const person = join(dir, "keys.json");
  writeFileSync(person, "{ not json");
  const r = merge(PLUGIN_KEYS, person);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(person, "utf8"), "{ not json");
  assert.deepEqual(backups(dir), []);
  assert.match(r.stderr, /nothing changed/);
});

// ── install.sh ─────────────────────────────────────────────────────────────

function fakeHome() {
  const home = freshDir();
  mkdirSync(join(home, "mods"));
  mkdirSync(join(home, "layouts"));
  writeFileSync(join(home, "keys.json"), `${JSON.stringify(HERDR, null, 2)}\n`);
  return home;
}
const install = (home, ...args) => spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } });

test("install: merges the plugin's keys once; a second install changes nothing", () => {
  const home = fakeHome();
  const first = install(home);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(home, "mods/projects/main.js")));
  const keys = JSON.parse(readFileSync(join(home, "keys.json"), "utf8"));
  assert.deepEqual(keys["layout:projects"], { f1: "projects.group1", f2: "projects.group2", f3: "projects.group3" });
  assert.equal(keys.global.f2, "tab.rename");
  const written = readFileSync(join(home, "keys.json"), "utf8");
  assert.equal(install(home).status, 0);
  assert.equal(readFileSync(join(home, "keys.json"), "utf8"), written);
  assert.equal(backups(home).length, 1);
});

test("install --no-keys installs the mod and leaves keys.json untouched", () => {
  const home = fakeHome();
  const before = readFileSync(join(home, "keys.json"), "utf8");
  const r = install(home, "--no-keys");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, "mods/projects/main.js")));
  assert.ok(existsSync(join(home, "layouts/projects.json")));
  assert.equal(readFileSync(join(home, "keys.json"), "utf8"), before);
  assert.deepEqual(backups(home), []);
});

test("uninstall removes what it installed and leaves keys.json alone", () => {
  const home = fakeHome();
  assert.equal(install(home, "--no-keys").status, 0);
  const before = readFileSync(join(home, "keys.json"), "utf8");
  const r = install(home, "--uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, "mods/projects")), false);
  assert.equal(existsSync(join(home, "layouts/projects.json")), false);
  assert.equal(readFileSync(join(home, "keys.json"), "utf8"), before);
});
