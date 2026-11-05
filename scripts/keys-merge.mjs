// Merges a plugin's keys.json into the person's (Herdr's AGENTS.md, "Layouts
// and mods other people made", step 4): its sections and keys are added, a
// key the person already binds in that section is never replaced (it is
// reported instead), the file is backed up before it is written, and a run
// with nothing to add writes nothing.
//
//   node scripts/keys-merge.mjs <plugin keys.json> <person's keys.json>
//
// Exit 0 when merged, already merged, or the person has no keys file yet
// (nothing is created: Herdr writes its own on start); 1 when either file
// can't be read as a keys file (nothing changed).

import { chmodSync, copyFileSync, constants, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Herdr's key names are lowercase; "F2" and "f2" are the same key.
const sameKey = (a, b) => a.toLowerCase() === b.toLowerCase();
const sameAction = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const findKey = (map, key) => Object.keys(map).find((k) => sameKey(k, key));

// The merged keys, never mutating either input:
//   keys     the person's sections in their order, each with its keys in
//            their order, then the keys and sections the plugin adds
//   added    [{ section, key, action }] bound now
//   kept     [{ section, key, theirs, action }] the person binds that key to
//            something else: theirs stays, the plugin's isn't bound
//   skipped  [section] the person's section isn't an object: left alone
//   shadows  [{ section, key, action, global }] a key added to a layout:
//            section that `global` also binds: in that layout it runs the
//            plugin's action instead (the more specific section wins)
//   changed  whether keys differs from the person's
export function mergeKeys(person, plugin) {
  if (!isObject(person)) throw new Error("not a keys file: expected an object of sections");
  if (!isObject(plugin) || !Object.values(plugin).every(isObject)) throw new Error("not a plugin keys file: expected an object of sections, each an object of keys");
  const keys = structuredClone(person);
  const added = [];
  const kept = [];
  const skipped = [];
  const shadows = [];
  const global = isObject(person.global) ? person.global : {};
  for (const [section, bindings] of Object.entries(plugin)) {
    if (!Object.hasOwn(keys, section)) keys[section] = {};
    const mine = keys[section];
    if (!isObject(mine)) {
      skipped.push(section);
      continue;
    }
    for (const [key, action] of Object.entries(bindings)) {
      const have = findKey(mine, key);
      if (have !== undefined) {
        if (!sameAction(mine[have], action)) kept.push({ section, key: have, theirs: mine[have], action });
        continue;
      }
      mine[key] = structuredClone(action);
      added.push({ section, key, action });
      const g = findKey(global, key);
      if (section.startsWith("layout:") && g !== undefined && !sameAction(global[g], action)) {
        shadows.push({ section, key, action, global: global[g] });
      }
    }
    if (Object.keys(mine).length === 0 && !Object.hasOwn(person, section)) delete keys[section];
  }
  return { keys, added, kept, skipped, shadows, changed: added.length > 0 };
}

const pad = (n) => String(n).padStart(2, "0");

// Where the file is copied before a write: <path>.bak-YYYYMMDD-HHMMSS.
export function backupName(path, date = new Date()) {
  const d = date;
  return `${path}.bak-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// The keys as text in the file's own indentation (two spaces when it has
// none) and with its final newline, if it had one.
function format(keys, original) {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  return JSON.stringify(keys, null, indent) + (original.endsWith("\n") ? "\n" : "");
}

const show = (action) => (typeof action === "string" ? action : JSON.stringify(action));

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { missing: true };
    throw new Error(`can't read ${what} ${path}: ${e.message}`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (e) {
    throw new Error(`${what} ${path} isn't valid JSON (${e.message})`);
  }
}

// The command line: returns the exit code. `out` and `err` take one line each.
export function main(pluginPath, personPath, { out = console.log, err = console.error, now = () => new Date() } = {}) {
  if (!pluginPath || !personPath) {
    err("usage: keys-merge.mjs <plugin keys.json> <person's keys.json>");
    return 2;
  }
  try {
    const plugin = readJson(pluginPath, "plugin keys file");
    if (plugin.missing) throw new Error(`no plugin keys file ${pluginPath}`);
    const person = readJson(personPath, "keys file");
    if (person.missing) {
      err(`keys: no ${personPath} yet; start Herdr once (it writes its own), then install again. Nothing changed.`);
      return 0;
    }
    const r = mergeKeys(person.value, plugin.value);
    for (const s of r.skipped) err(`keys: "${s}" in ${personPath} isn't a section of keys; left as is, its keys not added`);
    for (const k of r.kept) err(`keys: ${k.section} ${k.key} is already ${show(k.theirs)}; kept yours (${show(k.action)} not bound)`);
    if (!r.changed) {
      out(`keys: nothing to add to ${personPath}`);
      return 0;
    }
    // The file itself: a keys.json that is a symlink (dotfiles) stays one,
    // and the file it points to gets the keys.
    const real = realpathSync(personPath);
    let backup = backupName(real, now());
    for (let i = 2; ; i++) {
      try {
        copyFileSync(real, backup, constants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if (e.code !== "EEXIST" || i > 99) throw e;
        backup = `${backupName(real, now())}-${i}`;
      }
    }
    // Written next to it, with its mode, then swapped: Herdr reloads
    // keys.json live and never sees half a file.
    const tmp = `${real}.merging-${process.pid}`;
    writeFileSync(tmp, format(r.keys, person.text));
    chmodSync(tmp, statSync(real).mode & 0o7777);
    renameSync(tmp, real);
    for (const a of r.added) out(`keys: added ${a.key} → ${show(a.action)} in ${a.section}`);
    for (const s of r.shadows) out(`keys: in the ${s.section.slice(7)} layout, ${s.key} runs ${show(s.action)} instead of ${show(s.global)} (global)`);
    out(`keys: backed up ${backup}`);
    out("keys: Herdr won't add its new default shortcuts to an edited keys.json on upgrade; add those by hand");
    return 0;
  } catch (e) {
    err(`keys: ${e.message}; nothing changed`);
    return 1;
  }
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = main(process.argv[2], process.argv[3]);
