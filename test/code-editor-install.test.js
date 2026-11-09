// The code-editor plugin as Herdr gets it, on a fake Herdr home and a fake HOME,
// never the person's: cmd-l opens and closes the right panel (S2), the window
// wears One Dark Pro (S4), Material's icons travel with the Explorer (S5), the
// Markdown preview and the PDF reader travel with the file mod (lector-md), and
// the projects layout draws that Explorer in its panel.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(repo, "scripts/install.sh");
const plugin = (p) => join(repo, "code-editor", p);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const layout = () => readJson(join(repo, "projects-sidebar/layouts/projects.json"));

const root = realpathSync(mkdtempSync(join(tmpdir(), "code-editor-install-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

// A Herdr home whose keys.json is shaped like Herdr's own.
const PERSON_KEYS = { global: { "cmd-w": "tab.close", "cmd-t": "tab.new" }, terminal: { "cmd-c": "terminal.copy" } };
function fakeHome(keys = PERSON_KEYS) {
  const home = join(root, String(++n), "herdr-app");
  mkdirSync(join(home, "mods"), { recursive: true });
  mkdirSync(join(home, "layouts"));
  writeFileSync(join(home, "keys.json"), `${JSON.stringify(keys, null, 2)}\n`);
  return home;
}
const install = (home, ...args) =>
  spawnSync("sh", [INSTALL, ...args], { encoding: "utf8", env: { ...process.env, HOME: join(home, ".."), HERDR_APP_HOME: home } });
const manifest = (home, name) => readFileSync(join(home, ".herdr-plugins", `${name}.txt`), "utf8").split("\n").filter(Boolean).sort();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function mods(node, out = []) {
  if (node?.content?.mod) out.push(node.content.mod);
  for (const child of node?.children ?? []) mods(child, out);
  return out;
}

// ── S2: cmd-l ─────────────────────────────────────────────────────────────

// lector-md D7: the PDF's find and zoom, beside the file's save and close.
const FILE_KEYS = {
  "cmd-s": "code-file.save",
  "cmd-w": "code-file.close",
  "cmd-f": "code-file.find",
  "cmd-=": "code-file.zoom-in",
  "cmd-+": "code-file.zoom-in",
  "cmd--": "code-file.zoom-out",
  "cmd-0": "code-file.zoom-reset",
};

test("S2: cmd-l toggles the panel in the projects layout only, so other layouts keep theirs; cmd-s and cmd-w go to the open file (D3, D18)", () => {
  assert.deepEqual(readJson(plugin("keys.json")), {
    "layout:projects": { "cmd-l": "layout.toggle:panel" },
    "mod:code-file": FILE_KEYS,
  });
});

test("S2: what cmd-l toggles is the projects layout's right panel, closed until it is asked for", () => {
  const panel = find(layout(), "panel");
  assert.equal(readJson(plugin("keys.json"))["layout:projects"]["cmd-l"], `layout.toggle:${panel.id}`);
  assert.equal(panel.hidden, true);
  assert.equal(find(layout(), "work-row").children.at(-1).id, "panel", "on the right of the tabs and terminals");
});

test("S2: installing merges cmd-l into the person's keys, in that layout's section; global and terminal stay as they were", () => {
  const home = fakeHome();
  const r = install(home, "code-editor");
  assert.equal(r.status, 0, r.stderr);
  const keys = readJson(join(home, "keys.json"));
  assert.deepEqual(keys["layout:projects"], { "cmd-l": "layout.toggle:panel" });
  assert.deepEqual(keys["mod:code-file"], FILE_KEYS);
  assert.deepEqual(keys.global, PERSON_KEYS.global);
  assert.deepEqual(keys.terminal, PERSON_KEYS.terminal);
});

test("S2: a cmd-l the person already binds in that layout stays theirs, and the install says so", () => {
  const home = fakeHome({ ...PERSON_KEYS, "layout:projects": { "cmd-l": "terminal" } });
  const r = install(home, "code-editor");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(join(home, "keys.json"))["layout:projects"]["cmd-l"], "terminal");
  assert.match(r.stderr, /layout:projects cmd-l is already terminal; kept yours/);
});

// ── S4: One Dark Pro ───────────────────────────────────────────────────────

test("S4: the theme is a Herdr theme file with One Dark Pro's colors, and its MIT license stays with it (D4)", () => {
  const theme = readJson(plugin("themes/one-dark-pro.json"));
  const hex = /^#[0-9a-f]{6}$/;
  for (const field of ["background", "foreground", "selection", "cursor"]) assert.match(theme[field], hex, field);
  assert.equal(theme.ansi.length, 16);
  for (const color of theme.ansi) assert.match(color, hex);
  for (const color of Object.values(theme.colors)) assert.match(color, hex);
  assert.equal(theme.background, "#282c34");
  assert.equal(theme.foreground, "#abb2bf");
  assert.equal(theme.colors.accent, "#528bff");
  const license = readFileSync(plugin("themes/LICENSE"), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Binaryify/);
});

test("S4: the projects layout names that theme at its root, the one place Herdr reads a layout's look", () => {
  const { theme } = layout();
  assert.equal(theme, "one-dark-pro");
  assert.ok(existsSync(plugin(`themes/${theme}.json`)));
});

test("S4: install leaves the theme in Herdr's themes folder, byte for byte and listed; uninstall takes the theme and the mod, and nothing else", () => {
  const home = fakeHome();
  mkdirSync(join(home, "themes"));
  writeFileSync(join(home, "themes/theirs.json"), "{}\n");
  const r = install(home, "code-editor");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, "themes/one-dark-pro.json"), "utf8"), readFileSync(plugin("themes/one-dark-pro.json"), "utf8"));
  assert.deepEqual(manifest(home, "code-editor"), [...readdirSync(plugin("mods")).map((m) => `mods/${m}`), "themes/one-dark-pro.json"].sort());
  assert.ok(existsSync(join(home, "mods/code-explorer/main.js")));

  const gone = install(home, "--uninstall", "code-editor");
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(existsSync(join(home, "themes/one-dark-pro.json")), false);
  assert.equal(existsSync(join(home, "mods/code-explorer")), false);
  assert.equal(existsSync(join(home, ".herdr-plugins/code-editor.txt")), false);
  assert.equal(readFileSync(join(home, "themes/theirs.json"), "utf8"), "{}\n");
});

// ── lector-md: the Markdown preview and the PDF reader travel with the file mod ──

test("lector-md T4: install ships the readers whole, byte for byte: the PDF helper's Swift source, the toolbar's icons with their license, and every model", () => {
  const home = fakeHome();
  const r = install(home, "code-editor");
  assert.equal(r.status, 0, r.stderr);
  const shipped = [
    "pdfpages.swift", "pdf-model.js", "pdf-view.js", "markdown-model.js", "image-cache.js", "open-model.js",
    "preview-view.js", "reader-model.js", "ui/LICENSE",
    ...["code", "eye", "copy", "check", "zoom-in", "zoom-out", "rotate-ccw", "search", "chevron-up", "chevron-down", "x", "image"].map((i) => `ui/${i}.svg`),
  ];
  for (const file of shipped) {
    const from = plugin(`mods/code-file/${file}`);
    const to = join(home, "mods/code-file", file);
    assert.ok(existsSync(to), `${file} installed`);
    assert.equal(readFileSync(to, "utf8"), readFileSync(from, "utf8"), file);
  }
  assert.match(readFileSync(plugin("mods/code-file/ui/LICENSE"), "utf8"), /ISC/, "Lucide's license");
});

// ── S5: Material icons ─────────────────────────────────────────────────────

const ICONS = plugin("mods/code-explorer/icons");

test("S5: the Explorer carries Material's 279 icons, its theme.json and their licenses (D6)", () => {
  const files = readdirSync(ICONS);
  assert.equal(files.filter((f) => f.endsWith(".svg")).length, 279);
  for (const f of ["theme.json", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) assert.ok(files.includes(f), f);
  assert.match(readFileSync(join(ICONS, "LICENSE"), "utf8"), /Material Extensions/);
  assert.match(readFileSync(join(ICONS, "THIRD_PARTY_NOTICES.txt"), "utf8"), /Material Icon Theme/);
});

test("S5: every icon theme.json names is in the folder, for files by name and extension and for folders open and closed", () => {
  const map = readJson(join(ICONS, "theme.json"));
  const tables = ["icons", "fileNames", "fileExtensions", "folderNames", "folderNamesExpanded"];
  for (const table of tables) assert.ok(Object.keys(map[table]).length > 0, `${table} has entries`);
  const named = new Set(tables.flatMap((table) => Object.values(map[table])));
  for (const path of named) assert.ok(existsSync(plugin(`mods/code-explorer/${path}`)), path);
  assert.deepEqual(map.icons, { file: "icons/file.svg", folder: "icons/folder.svg", "folder-open": "icons/folder-open.svg" });
});

test("S5: install brings the icons with the mod, where image() finds them", () => {
  const home = fakeHome();
  assert.equal(install(home, "code-editor").status, 0);
  const installed = join(home, "mods/code-explorer/icons");
  assert.deepEqual(readdirSync(installed).sort(), readdirSync(ICONS).sort());
});

// ── The layout ─────────────────────────────────────────────────────────────

test("the panel opens on the Explorer: the stack's files child became it, and changes stays, now a column with projects-sidebar's PR card above Herdr's Changes (D1)", () => {
  const body = find(layout(), "panel-body");
  assert.equal(body.type, "stack");
  assert.equal(body.active, "explorer");
  assert.deepEqual(body.children.map((c) => c.id), ["explorer", "changes"]);
  assert.deepEqual(body.children[0], { id: "explorer", type: "block", content: { mod: "code-explorer" } });
  const changes = body.children[1];
  assert.equal(changes.type, "column", "the header selects it by its id, whatever it holds");
  assert.equal(changes.resizable, false);
  const [card, diff] = changes.children;
  assert.equal(card.id, "pr-card");
  assert.deepEqual(card.content, { mod: "projects", props: { view: "pr" } });
  assert.ok(card.size.px > 0, "the card is a fixed height");
  assert.deepEqual(diff, { id: "changes-diff", type: "block", size: { weight: 1 }, content: { mod: "changes" } });
  assert.ok(!mods(layout()).includes("files"), "no copy of Herdr's files mod");
});

test("code-explorer docks nowhere on its own: the layout places it, and it loads as a mod", () => {
  const dir = plugin("mods/code-explorer");
  assert.equal(readJson(join(dir, "mod.json")).place, "none");
  assert.match(readFileSync(join(dir, "main.js"), "utf8"), /export default class \w+ extends View/);
});

test("projects-sidebar requires code-editor: it lands first, so the layout's theme and Explorer are there, and uninstalling the sidebar leaves them", () => {
  const requires = readFileSync(join(repo, "projects-sidebar/requires"), "utf8");
  assert.ok(requires.split("\n").includes("code-editor"));

  const home = fakeHome();
  const r = install(home, "projects-sidebar");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf(`installed ${home}/mods/code-explorer\n`) !== -1, r.stdout);
  assert.ok(r.stdout.indexOf(`installed ${home}/mods/code-explorer\n`) < r.stdout.indexOf(`installed ${home}/layouts/projects.json\n`));
  const shown = readJson(join(home, "layouts/projects.json"));
  assert.ok(existsSync(join(home, `themes/${shown.theme}.json`)));
  assert.ok(existsSync(join(home, "mods", find(shown, "explorer").content.mod, "main.js")));
  assert.equal(readJson(join(home, "keys.json"))["layout:projects"]["cmd-l"], "layout.toggle:panel");

  const gone = install(home, "--uninstall", "projects-sidebar");
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(existsSync(join(home, "themes/one-dark-pro.json")), "another layout may use it");
  assert.ok(existsSync(join(home, "mods/code-explorer/main.js")));
});

test("a theme someone else put at that name stops the install before anything lands", () => {
  const home = fakeHome();
  mkdirSync(join(home, "themes"));
  writeFileSync(join(home, "themes/one-dark-pro.json"), "// theirs\n");
  const r = install(home, "code-editor");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /themes\/one-dark-pro\.json exists and wasn't installed from code-editor; nothing changed/);
  assert.equal(readFileSync(join(home, "themes/one-dark-pro.json"), "utf8"), "// theirs\n");
  assert.equal(existsSync(join(home, "mods/code-explorer")), false);
});
