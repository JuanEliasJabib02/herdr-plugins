// What the Explorer's file operations decide and run (S13, D21, D23), with no herdr or
// gpui-kit imports so `node --test` can load it (D8). The programs and the tabs come in
// through `io`, as in remove-workspace-model.js: { exec, writeTextFile, readdir, appHome,
// spaces, panes, shared } on disk, and { setShared, run, notify, wait, newDoc } as well
// to touch tabs. Every outcome is read from the disk afterwards, never from a program's
// words or its code alone. Every path reaches a program as one absolute argument.
import { DOCS_KEY, FILE_MOD, LIVE_KEY, closeCommand, openFile, table } from "./tree-model.js";

export const MOD = "code-explorer";
// What the Delete dialog draws, written only by the panel's copy (D23).
export const OP_KEY = "code-editor.op";

// S13. "Copy" is D23's to leave out: write_to_clipboard only carries text, which is
// what Copy Path does, and Orca's copies a reference to the file.
export const OPS = {
  newFile: "New File",
  newFolder: "New Folder",
  copyPath: "Copy Path",
  copyRelativePath: "Copy Relative Path",
  duplicate: "Duplicate",
  openInTerminal: "Open in Terminal",
  collapseFolder: "Collapse Folder",
  findInFolder: "Find in Folder",
  reveal: "Reveal in Finder",
  rename: "Rename",
  delete: "Delete",
  deletePermanently: "Delete Permanently",
  cancel: "Cancel",
  cannotUndo: "This cannot be undone.",
  deleting: "Deleting…",
};

export const nameTaken = (name) => `A file or folder named '${name}' already exists in this location`;
export const trashOffer = (name) => `Couldn't move '${name}' to the Trash. Delete it permanently?`;
export const unsavedChanges = (name) => `"${name}" has unsaved changes`;
// S12's words, for a draft no tab holds: there's no tab to go to, so it says what clears it.
export const unsavedDraft = (name) => `${unsavedChanges(name)}. Open it to save or discard them.`;

const NOT_A_NAME = "That can't be a file or folder name";
const IS_ROOT = "The workspace's own folder can't be changed from here";
const NOT_HERE = "That path isn't in this workspace";
const IS_GIT = "Git's own folder can't be changed from here";
const CANT_CHECK = "Couldn't check for unsaved changes, so nothing changed";

const failed = (error) => ({ status: "error", error });

// ── Paths ──────────────────────────────────────────────────────────────────

const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const joined = (folder, name) => (folder ? `${folder}/${name}` : name);
// What follows `from` in `path`, or null when path is neither `from` nor under it.
const restAfter = (path, from) => (path === from || path.startsWith(`${from}/`) ? path.slice(from.length) : null);

// New File and New Folder go in the folder pressed, or beside the file pressed.
export const targetFolder = (rel, isFolder) => (isFolder ? rel : parentOf(rel));

// D2: a command's `<rel>//<name>`. A path has no empty part (checkTarget) and a name no
// slash (checkName), so neither can hold this.
export function splitTarget(arg) {
  const cut = arg.indexOf("//");
  return cut === -1 ? { rel: arg, name: null } : { rel: arg.slice(0, cut), name: arg.slice(cut + 2) };
}

// ── The guards (D23) ───────────────────────────────────────────────────────

// { name }, { cancel: true } or { error }.
export function checkName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return { cancel: true };
  if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) return { error: NOT_A_NAME };
  return { name };
}

// In any case: on this volume `.GIT/config` is `.git/config`.
const isGitPart = (part) => part.toLowerCase() === ".git";

// What's wrong with a path's shape, asking nothing of the disk, or null.
export function relProblem(rel) {
  if (!rel) return IS_ROOT;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) return NOT_HERE;
  return parts.some(isGitPart) ? IS_GIT : null;
}

// Why an operation may not act on `rel`, or null. `root` is the root's real path and
// `realpath` where rel really leads, null when it leads nowhere.
export function checkTarget({ root, rel, realpath }) {
  const shape = relProblem(rel);
  if (shape) return shape;
  if (!realpath) return `'${nameOf(rel)}' isn't there any more`;
  if (realpath === root) return IS_ROOT;
  if (!realpath.startsWith(`${root}/`)) return NOT_HERE;
  return realpath.slice(root.length + 1).split("/").some(isGitPart) ? IS_GIT : null;
}

// The same for a folder to create things in, which the root is.
export function checkPlace({ root, rel, realpath }) {
  if (!rel) return realpath === root ? null : NOT_HERE;
  return checkTarget({ root, rel, realpath });
}

// What a rename asks: { cancel: true }, { error }, or { name, rel, caseOnly }. The text as
// it came counts first: checkName trims, and a name can start or end with spaces.
export function renameTarget(rel, raw) {
  const checked = checkName(raw), old = nameOf(rel);
  if (raw === old || checked.cancel || checked.name === old) return { cancel: true };
  if (checked.error) return { error: checked.error };
  return { name: checked.name, rel: joined(parentOf(rel), checked.name), caseOnly: checked.name.toLowerCase() === old.toLowerCase() };
}

// ── Small decisions ────────────────────────────────────────────────────────

// Orca's: split at the last dot, one at the start being no extension; Orca retries 10.
const DUPLICATE_TRIES = 10;
export function duplicateNames(name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  return Array.from({ length: DUPLICATE_TRIES }, (_v, i) => `${stem} copy${i ? ` ${i + 1}` : ""}${ext}`);
}

// Orca's: the part before the last dot, or all of it with none or a leading one.
export function renameSelection(name) {
  const dot = name.lastIndexOf(".");
  return { start: 0, end: dot > 0 && !name.startsWith(".") ? dot : name.length };
}

export function entryTitle({ kind, folder, rel }) {
  if (kind === "rename") return `${OPS.rename} ${nameOf(rel)}`;
  const label = kind === "folder" ? OPS.newFolder : OPS.newFile;
  return folder ? `${label} in ${folder}` : label;
}

export const copyText = (kind, root, rel) => (kind === "path" ? `${root}/${rel}` : rel);

// S13, as Orca's Find in Folder: with what a glob would read as its own escaped,
// including the comma that would split the field.
export const folderPattern = (rel) => `${rel.replace(/[\\*?[\]{},]/g, "\\$&")}/**`;

export const withoutFolder = (expanded, path) => new Set([...expanded].filter((folder) => folder !== path && !folder.startsWith(`${path}/`)));

export const movedFolders = (expanded, from, to) => new Set([...expanded].map((folder) => {
  if (folder === from) return to;
  return folder.startsWith(`${from}/`) ? `${to}${folder.slice(from.length)}` : folder;
}));

// In Orca's order. `id` is also the panel's command, `copy` what a copy item writes.
// With no `rel` it's the menu of the empty space under the rows.
export function fileMenuItems({ rel, dir, open = false, filtering = false }) {
  const items = [{ id: "new-file", label: OPS.newFile }, { id: "new-folder", label: OPS.newFolder }];
  if (!rel) return items;
  items.push({ id: "copy-path", label: OPS.copyPath, copy: "path", separator: true }, { id: "copy-relative-path", label: OPS.copyRelativePath, copy: "relative" });
  if (dir) {
    items.push({ id: "open-in-terminal", label: OPS.openInTerminal });
    if (open && !filtering) items.push({ id: "collapse-folder", label: OPS.collapseFolder });
    items.push({ id: "find-in-folder", label: OPS.findInFolder });
  } else items.push({ id: "duplicate", label: OPS.duplicate });
  items.push({ id: "reveal", label: OPS.reveal }, { id: "rename", label: OPS.rename, separator: true }, { id: "delete", label: OPS.delete, danger: true });
  return items;
}

// ── Asking the disk ────────────────────────────────────────────────────────

// D23's one predicate: a broken link holds its name too, which `-e` alone doesn't see.
export const TAKEN_SCRIPT = '[ -e "$1" ] || [ -L "$1" ]';
const taken = async (path, io) => (await io.exec("/bin/sh", ["-c", TAKEN_SCRIPT, "sh", path])).code === 0;

async function readReal(path, io) {
  const r = await io.exec("/bin/realpath", [path]);
  return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
}

// Where a path really leads. A broken link leads nowhere (measured: realpath fails), and
// acting on one touches only the link, so its folder decides.
async function realOf(path, io) {
  const direct = await readReal(path, io);
  if (direct) return direct;
  const folder = await readReal(parentOf(path), io);
  return folder && (await taken(path, io)) ? `${folder}/${nameOf(path)}` : null;
}

async function listNames(folder, io) {
  const r = await io.exec("/bin/ls", ["-a", folder]);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.split("\n");
}

// `-ef` follows links, so `link → a` passes it against `a`: only a name that differs in
// capitals and that the folder doesn't list by itself is the same entry.
async function sameEntry(from, to, name, io) {
  const r = await io.exec("/bin/sh", ["-c", '[ "$1" -ef "$2" ]', "sh", from, to]);
  return r.code === 0 && !(await listNames(parentOf(from), io)).includes(name);
}

// ── What's open (D21) ──────────────────────────────────────────────────────

// The tabs holding a file at `abs` or under it, in every space. A docs entry alone
// proves nothing: closing a file beside a terminal leaves the tab and the entry behind.
// Compared by the real folder and the name as given, so the same file through another
// way to its folder counts, and a tab on a link isn't one on what it points to. The path
// as written counts too: a tab on `link/x` resolves to `real/x` and still hangs from
// `link`. `rest` is what follows `abs` in the tab's path.
export async function findTabs(abs, io) {
  const docs = table(io.shared(DOCS_KEY)), panes = io.panes(), folders = new Map();
  const located = async (path) => {
    const folder = parentOf(path);
    if (!folders.has(folder)) folders.set(folder, await readReal(folder, io));
    return folders.get(folder) ? `${folders.get(folder)}/${nameOf(path)}` : path;
  };
  const target = await located(abs), found = [];
  for (const space of io.spaces()) {
    for (const tab of space.tabs) {
      const entry = Object.hasOwn(docs, tab.id) ? docs[tab.id] : null;
      if (typeof entry?.file !== "string" || !panes.some((p) => p.tab === tab.id && p.mod === FILE_MOD)) continue;
      const rest = restAfter(await located(entry.file), target) ?? restAfter(entry.file, abs);
      if (rest !== null) found.push({ id: tab.id, space: space.id, doc: entry.doc, file: entry.file, preview: Boolean(entry.preview), rest });
    }
  }
  return found;
}

const draftsFolder = (io) => `${io.appHome()}/code-editor/drafts`;

// The names in the drafts folder. No folder yet is no drafts; one that can't be read
// says nothing, which is null, and nothing moves on that.
export async function draftNames(io) {
  const dir = draftsFolder(io);
  try {
    return await io.readdir(dir);
  } catch {
    return (await taken(dir, io).catch(() => true)) ? null : [];
  }
}

// As code-file's parseDraftName: what isn't named so is never offered back on reopening.
const DRAFT_NAME = /^[0-9a-z]+-.+-\d+$/;

// The real path a draft belongs to, from its first line, or null when it can't be read or
// isn't one. Only that line, with `head`: the rest is a whole file's text. A line with no
// end is a cut draft, as code-file's parseDraft has it.
async function draftPath(name, io) {
  try {
    const r = await io.exec("/usr/bin/head", ["-n", "1", `${draftsFolder(io)}/${name}`]);
    if (r.code !== 0 || !r.stdout.endsWith("\n")) return null;
    const path = JSON.parse(r.stdout)?.path;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

// The first file at `real` or under it with a draft, or null. A close that doesn't ask
// leaves one with no tab, keyed to this path, and reopening at a new one wouldn't find it.
// A draft whose file is gone stops nothing: there'd be nothing to open to settle it.
async function draftUnder(real, names, io) {
  for (const name of names.filter((n) => DRAFT_NAME.test(n))) {
    const path = await draftPath(name, io);
    if (path !== null && restAfter(path, real) !== null && (await taken(path, io))) return path;
  }
  return null;
}

// What unsaved text says against touching `real`, or null. First S12's words for a tab
// with changes: `shared` can lag after a hang, so a draft of that doc counts too. A draft
// is `<hash>-<doc>-<seq>`. Then any other draft there, with or without a tab.
async function unsavedIn(tabs, real, io) {
  const live = table(io.shared(LIVE_KEY)), drafts = await draftNames(io);
  if (!drafts) return CANT_CHECK;
  const dirty = tabs.find((tab) => table(live)[tab.doc]?.dirty || drafts.some((name) => name.includes(`-${tab.doc}-`)));
  if (dirty) return unsavedChanges(nameOf(dirty.file));
  const left = await draftUnder(real, drafts, io);
  return left === null ? null : unsavedDraft(nameOf(left));
}

// What every operation on an existing path goes through, before it touches the disk:
// { abs, name, tabs }, or { error }. Never rejects.
export async function clearPath({ root, real, rel }, io) {
  const shape = relProblem(rel);
  if (shape) return { error: shape };
  const abs = `${root}/${rel}`, name = nameOf(rel);
  try {
    const realpath = await realOf(abs, io);
    const problem = checkTarget({ root: real, rel, realpath });
    if (problem) return { error: problem };
    const tabs = await findTabs(abs, io);
    const unsaved = await unsavedIn(tabs, realpath, io);
    return unsaved ? { error: unsaved } : { abs, name, tabs };
  } catch {
    return { error: `Couldn't check '${name}', so nothing changed` };
  }
}

// ── The operations ─────────────────────────────────────────────────────────
// Each resolves { status: "ok", … }, { status: "cancel" }, { status: "error", error } or
// Trash's { status: "offer", error, name }. None of them rejects.

// New File and New Folder (kind "file" or "folder"), in `folder`, relative to the root.
export async function createPath({ root, real, folder, raw, kind }, io) {
  const checked = checkName(raw);
  if (checked.cancel) return { status: "cancel" };
  if (checked.error) return failed(checked.error);
  const { name } = checked, rel = joined(folder, name);
  const shape = relProblem(rel);
  if (shape) return failed(shape);
  const place = folder ? `${root}/${folder}` : root, abs = `${place}/${name}`;
  try {
    const problem = checkPlace({ root: real, rel: folder, realpath: await realOf(place, io) });
    if (problem) return failed(problem);
    if (await taken(abs, io)) return failed(nameTaken(name));
    // Not `-p`, and writeTextFile with null only creates.
    if (kind === "folder") {
      const r = await io.exec("/bin/mkdir", [abs]);
      if (r.code !== 0) throw new Error(r.stderr);
    } else await io.writeTextFile(abs, "", null);
    return { status: "ok", rel, abs };
  } catch {
    // Someone else may have taken the name meanwhile.
    return failed((await taken(abs, io).catch(() => false)) ? nameTaken(name) : `Failed to create '${name}'.`);
  }
}

// D23: `mv -n` to a free name, a plain `mv` for a change of capitals on the same entry.
// Which is read from the disk afterwards: `mv -n` onto a taken name says 0 (measured).
export async function renamePath({ root, real, rel, raw }, io) {
  const target = renameTarget(rel, raw);
  if (target.cancel) return { status: "cancel" };
  if (target.error) return failed(target.error);
  const shape = relProblem(target.rel);
  if (shape) return failed(shape);
  const cleared = await clearPath({ root, real, rel }, io);
  if (cleared.error) return failed(cleared.error);
  const from = cleared.abs, to = `${parentOf(from)}/${target.name}`;
  const moved = { status: "ok", rel: target.rel, abs: to, tabs: cleared.tabs };
  const didnt = failed(`Failed to rename '${cleared.name}'.`);
  const move = (args) => io.exec("/bin/mv", args).catch(() => null);
  try {
    if (target.caseOnly && (await sameEntry(from, to, target.name, io))) {
      await move(["--", from, to]);
      // In this volume `foo` still resolves after `mv foo Foo`: only the listing tells.
      const names = await listNames(parentOf(from), io);
      return names.includes(target.name) && !names.includes(cleared.name) ? moved : didnt;
    }
    if (await taken(to, io)) return failed(nameTaken(target.name));
    await move(["-n", "--", from, to]);
    return !(await taken(from, io)) && (await taken(to, io)) ? moved : didnt;
  } catch {
    return didnt;
  }
}

// D23: files only, under the first free name of ten. `cp -n` onto a name taken since the
// check says 1 and leaves it (measured), so that goes on to the next; cmp only confirms.
export async function duplicateFile({ root, real, rel }, io) {
  const cleared = await clearPath({ root, real, rel }, io);
  if (cleared.error) return failed(cleared.error);
  const { abs, name } = cleared, didnt = failed(`Failed to duplicate '${name}'.`);
  try {
    if ((await io.exec("/bin/sh", ["-c", '[ -d "$1" ]', "sh", abs])).code === 0) return failed("Only files can be duplicated");
    for (const candidate of duplicateNames(name)) {
      const to = `${parentOf(abs)}/${candidate}`;
      if (await taken(to, io)) continue;
      const copy = await io.exec("/bin/cp", ["-pPn", "--", abs, to]);
      if (copy.code !== 0) {
        if (await taken(to, io)) continue;
        return didnt;
      }
      const same = await io.exec("/usr/bin/cmp", ["-s", abs, to]);
      return same.code === 0 ? { status: "ok", rel: joined(parentOf(rel), candidate) } : didnt;
    }
    return didnt;
  } catch {
    return didnt;
  }
}

// D23: to the Trash, read from the state. Gone is a success whatever trash said. Still
// there with a failing code is the offer of Delete Permanently; with code 0, an error. If
// exec stopped it (30 s) or the state can't be read nobody knows what happened, so there's
// never an offer. Its tabs close after this says ok (closeTabs).
export async function trashPath({ root, real, rel }, io) {
  const cleared = await clearPath({ root, real, rel }, io);
  if (cleared.error) return failed(cleared.error);
  const { abs, name, tabs } = cleared;
  const unfinished = failed(`The Trash didn't finish, so '${name}' may still be there.`);
  const result = await io.exec("/usr/bin/trash", ["-s", abs]).catch(() => null);
  let present;
  try {
    present = await taken(abs, io);
  } catch {
    return unfinished;
  }
  if (!present) return { status: "ok", name, tabs };
  if (!result) return unfinished;
  return result.code !== 0 ? { status: "offer", error: trashOffer(name), name } : failed(`Failed to move '${name}' to the Trash.`);
}

// D23: only from its own button, which only the offer shows.
export async function deleteForever({ root, real, rel }, io) {
  const cleared = await clearPath({ root, real, rel }, io);
  if (cleared.error) return failed(cleared.error);
  const { abs, name, tabs } = cleared;
  const result = await io.exec("/bin/rm", ["-rf", "--", abs]).catch(() => null);
  const present = await taken(abs, io).catch(() => true);
  if (!present) return { status: "ok", name, tabs };
  return failed(result ? `Failed to delete '${name}'.` : `rm didn't finish: part of '${name}' may already be deleted.`);
}

// ── The tabs of what moved or went (D21) ───────────────────────────────────

// D18's close for each one still there, and with no changes: one typed since the check
// keeps its text on screen, and the file says it's gone.
export function closeTabs(tabs, io) {
  const live = table(io.shared(LIVE_KEY));
  for (const { id, doc } of tabs) {
    const tab = io.spaces().flatMap((space) => space.tabs).find((t) => t.id === id);
    if (!tab || table(live)[doc]?.dirty) continue;
    const close = closeCommand(tab, io.panes());
    if (close) io.run(...close);
  }
}

// One at a time, each in its own space, by openFile's own sequence. Then what was active
// comes back, or its replacement: other spaces first, since a tab.select can move the
// window, so it ends on the space it was on.
export async function reopenTabs({ tabs, to }, io) {
  const before = io.spaces(), live = table(io.shared(LIVE_KEY));
  const activeIn = new Map(before.map((space) => [space.id, space.tabs.find((t) => t.active)?.id ?? null]));
  const replaced = new Map();
  for (const tab of tabs) {
    const pin = !tab.preview || Boolean(table(live)[tab.doc]?.pinned);
    const opened = await openFile({ file: `${to}${tab.rest}`, pin, space: tab.space, moved: tab.id }, io);
    if (opened.id) replaced.set(tab.id, opened.id);
  }
  const touched = new Set(tabs.map((tab) => tab.space)), here = before.find((space) => space.active);
  const order = [...before.filter((space) => space !== here && touched.has(space.id)), ...(here ? [here] : [])];
  for (const space of order) {
    const id = activeIn.get(space.id);
    if (id) io.run("tab.select", { id: replaced.get(id) ?? id });
  }
}
