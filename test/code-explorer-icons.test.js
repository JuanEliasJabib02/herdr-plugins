// T4, S5: which Material icon a row draws (code-explorer/icon-model.js), resolved
// as Orca's getPluginFileTypeIconIndex and getPluginFolderIconIndex do (D6),
// against the real icons/theme.json that ships in the mod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ICON_THEME, fileIcon, folderIcon, parseIconTheme } from "../code-editor/mods/code-explorer/icon-model.js";

const MOD = fileURLToPath(new URL("../code-editor/mods/code-explorer/", import.meta.url));
const theme = parseIconTheme(readFileSync(join(MOD, "icons/theme.json"), "utf8"));
const at = (name) => `mods/code-explorer/icons/${name}.svg`;

test("S5: the table is read from the mod's folder in Herdr's home", () => {
  assert.equal(ICON_THEME, "mods/code-explorer/icons/theme.json");
  assert.ok(theme.fileNames["package.json"]);
});

test("S5, D6: an exact file name wins over its extension", () => {
  assert.equal(fileIcon(theme, "package.json"), at("nodejs"));
  assert.equal(fileIcon(theme, "other.json"), at("json"));
});

test("S5, D6: the longest dotted suffix wins, and a compound one still reaches the last", () => {
  const table = { fileNames: {}, fileExtensions: { "d.ts": "icons/d.svg", ts: "icons/ts.svg", gz: "icons/gz.svg" }, icons: { file: "icons/file.svg" } };
  assert.equal(fileIcon(table, "types.d.ts"), at("d"));
  assert.equal(fileIcon(table, "a.ts"), at("ts"));
  assert.equal(fileIcon(table, "a.tar.gz"), at("gz"));
  assert.equal(fileIcon(theme, "App.tsx"), at("react_ts"));
});

test("S5, D6: case doesn't matter", () => {
  assert.equal(fileIcon(theme, "PACKAGE.JSON"), at("nodejs"));
  assert.equal(fileIcon(theme, "MAIN.TS"), at("typescript"));
  assert.equal(folderIcon(theme, "SRC", false), at("folder-src"));
});

test("S5, D6: nothing known falls back to the plain file icon, a dotfile's name isn't an empty extension", () => {
  assert.equal(fileIcon(theme, "nothing.unknownext"), at("file"));
  assert.equal(fileIcon(theme, "no-extension-here"), at("file"));
  assert.equal(fileIcon(theme, ".unknown-dotfile"), at("file"));
});

test("S5, D6: folders go by name, with the open variant; an unknown one uses the generic pair", () => {
  assert.equal(folderIcon(theme, "src", false), at("folder-src"));
  assert.equal(folderIcon(theme, "src", true), at("folder-src-open"));
  assert.equal(folderIcon(theme, "whatever", false), at("folder"));
  assert.equal(folderIcon(theme, "whatever", true), at("folder-open"));
});

test("S3: an open folder with only a closed named icon takes the generic open one, as Orca does", () => {
  const table = { folderNames: { lib: "icons/lib.svg" }, folderNamesExpanded: {}, icons: { folder: "icons/folder.svg", "folder-open": "icons/folder-open.svg" } };
  assert.equal(folderIcon(table, "lib", true), at("folder-open"));
  assert.equal(folderIcon(table, "lib", false), at("lib"));
});

test("a file named like something every object inherits finds nothing", () => {
  for (const name of ["constructor", "__proto__", "toString", "x.constructor", "x.__proto__"]) assert.equal(fileIcon(theme, name), at("file"), name);
  assert.equal(folderIcon(theme, "constructor", false), at("folder"));
});

test("with the table not loaded yet, or broken, rows still draw plain icons", () => {
  assert.equal(parseIconTheme("{ nope"), null);
  assert.equal(parseIconTheme("[]"), null);
  assert.equal(parseIconTheme(null), null);
  assert.equal(fileIcon(null, "a.js"), at("file"));
  assert.equal(folderIcon(null, "src", false), at("folder"));
  assert.equal(folderIcon(null, "src", true), at("folder-open"));
});

test("S5: every icon the table names ships in the mod's folder", () => {
  for (const table of ["icons", "fileNames", "fileExtensions", "folderNames", "folderNamesExpanded"]) {
    for (const [key, rel] of Object.entries(theme[table])) assert.ok(existsSync(join(MOD, rel)), `${table}.${key}: ${rel}`);
  }
});
