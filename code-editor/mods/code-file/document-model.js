// One open file as a pure reducer (plan D22), with no herdr or gpui-kit imports
// so `node --test` can load it. reduce(state, event) answers { state, effects };
// main.js runs the effects, the only way anything reaches the disk or the editor.
//
// Two texts stand for "what we last agreed on": `diskText` is the disk's, the next
// `expected`; `baseline` is the editor's text at the last load or save. They differ
// in a CRLF file, where Enter inserts a loose \n that the save converts (D19) and
// the editor keeps. `dirty` is always computed, value !== baseline, so what's typed
// during a write's await stays dirty on its own.
//
// Events:
//   diskRead { text | null | error, visible?, gen? }  a read of the file
//   edit { value }                 the editor's text
//   settled { value }              what the editor holds after a load
//   saveStart                      cmd-s
//   saveOk                         the write landed
//   saveRejected { text | null | error }  the write failed, with a read made after
//   restore { meta, draftText, diskText }  a draft found at open (D20)
//   reload, overwrite, keepMine, discard { text | null | error }  S12's buttons,
//                                  with a read made after the click
//   retry, pin, access { readonly }
//   askClose, cancelClose, saveAndClose, dontSave  the card (D18)
//
// Effects: write { text, expected }, setValue { text }, loaded, scheduleDraft,
// dropDraft, reread, toast { title, level }, close, discardClose, focusCard,
// focusEditor.

import { restoreDraft, signature } from "./draft-model.js";

// Written by code-explorer: { [tabId]: { doc, file, preview } }.
export const DOCS_KEY = "code-editor.docs";
// Written by code-file, only when it changes: { [doc]: { dirty, pinned } }.
export const LIVE_KEY = "code-editor.live";

const MOD = "code-file";
const MIB = 1024 * 1024;

// S12's words, Orca's. Two come from the plan: D22's size message, because a read
// over the limit doesn't say how big the file is, and D15's clean banner.
export const TEXT = Object.freeze({
  tooLarge: "File too large: exceeds the 1 MiB limit",
  unableToLoad: "Unable to load file",
  noLongerThere: "This file no longer exists.",
  retry: "Retry",
  binary: "Binary file — cannot display",
  notUtf8: "This file isn't UTF-8 text",
  notUtf8Save: "This file isn't UTF-8 text, so it wasn't saved.",
  changedSinceEdits: "This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.",
  saveFailed: "Failed to save the file. Please try again.",
  conflict: "This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.",
  reloadFromDisk: "Reload from Disk",
  reloaded: "Reloaded from disk",
  overwrite: "Overwrite",
  keepMine: "Keep My Edits",
  keepMineTip: "Keeps your version. Your next save replaces the version on disk.",
  closeTitle: "Unsaved Changes",
  cancel: "Cancel",
  dontSave: "Don't Save",
  save: "Save",
  changedOnDisk: "Cambió en disco",
  reloadClean: "Recargar",
  restored: "Restored unsaved changes",
  discard: "Discard",
  noColors: "Sin colores: archivo grande",
  readOnly: "Read-only",
  deleted: "Deleted on disk",
  edit: "Editar",
  noTab: "Couldn't find this file's tab",
});

export const closeBody = (name) => `"${name}" has unsaved changes. Do you want to save before closing?`;

// ── Reading the state ────────────────────────────────────────────────────────

export function createDoc({ pinned = false } = {}) {
  return {
    phase: "loading", // "loading" | "ready" | "limit"
    limit: null, // { title, message, retry } while phase is "limit"
    value: "",
    baseline: "",
    diskText: null,
    baseSig: null, // the base a draft written now carries (D20)
    crlf: false,
    writing: null, // { text, value, expected } of the write that's running
    queued: false,
    gen: 0, // moves with each save, so a read older than it is read again
    banner: null, // "conflict" | "changed" | "restored" | "failed" | "readError"
    message: null, // the text of "failed" and "readError"
    blocked: false, // a restored conflict: no `expected` until Keep or Overwrite
    deleted: false,
    readonly: false,
    pinned,
    card: false,
    closing: false,
  };
}

export const isDirty = (s) => s.phase === "ready" && s.value !== s.baseline;

// Only what the window shows: a keystroke that changes just the text redraws
// nothing of ours, and every mod's redraw redraws the whole window.
export function needsRedraw(prev, next) {
  if (isDirty(prev) !== isDirty(next)) return true;
  return Object.keys(next).some((k) => k !== "value" && k !== "gen" && next[k] !== prev[k]);
}

// ── Line endings (D19) ───────────────────────────────────────────────────────

// At least one line ending, and every one of them CRLF.
export function isAllCrlf(text) {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

export const toDisk = (s, value) => (s.crlf ? value.replace(/\r?\n/g, "\r\n") : value);

// ── Reads that fail ──────────────────────────────────────────────────────────

// Only for what to show on a read. A rejected save is decided by the text it
// finds on disk, never by words like these (D22).
export function classifyReadError(message) {
  const text = String(message);
  if (text.includes("exceeds 1 MiB")) return "tooLarge";
  if (text.includes("valid UTF-8")) return "notUtf8";
  return "other";
}

function limitOf(event) {
  if (event.error !== undefined) {
    const kind = classifyReadError(event.error);
    if (kind === "tooLarge") return { title: TEXT.tooLarge, message: null, retry: false };
    if (kind === "notUtf8") return { title: TEXT.notUtf8, message: null, retry: false };
    return { title: TEXT.unableToLoad, message: String(event.error), retry: true };
  }
  if (event.text === null) return { title: TEXT.unableToLoad, message: TEXT.noLongerThere, retry: true };
  return event.text.includes("\0") ? { title: TEXT.binary, message: null, retry: false } : null;
}

function readErrorText(error) {
  const kind = classifyReadError(error);
  if (kind === "tooLarge") return TEXT.tooLarge;
  if (kind === "notUtf8") return TEXT.notUtf8;
  return `${TEXT.unableToLoad}: ${error}`;
}

// ── What each banner shows (S12, D15, D20) ───────────────────────────────────

export function bannerView(s) {
  switch (s.banner) {
    case "conflict":
      return {
        text: TEXT.conflict,
        buttons: [
          { id: "reload", label: TEXT.reloadFromDisk },
          { id: "overwrite", label: TEXT.overwrite },
          { id: "keep-mine", label: TEXT.keepMine, tip: TEXT.keepMineTip },
        ],
      };
    case "changed":
      return { text: TEXT.changedOnDisk, buttons: [{ id: "reload", label: TEXT.reloadClean }] };
    case "restored":
      return { text: TEXT.restored, buttons: [{ id: "discard", label: TEXT.discard }] };
    case "readError":
      return { text: s.message, buttons: [{ id: "retry", label: TEXT.retry }] };
    case "failed":
      return { text: s.message, buttons: [] };
    default:
      return null;
  }
}

// ── The reducer ──────────────────────────────────────────────────────────────

const none = (state) => ({ state, effects: [] });
const toast = (title, level = "warning") => ({ kind: "toast", title, level });
const LOADED = { kind: "loaded" };
const REREAD = { kind: "reread" };
const DROP = { kind: "dropDraft" };
const SCHEDULE = { kind: "scheduleDraft" };
const CLOSE = { kind: "close" };
const FOCUS_EDITOR = { kind: "focusEditor" };

// UTF-8 bytes, without counting on TextEncoder in Herdr's runtime.
function utf8Length(text) {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x800) bytes += unit >= 0xd800 && unit <= 0xdbff ? 1 : 2;
    else if (unit >= 0x80) bytes += 1;
  }
  return bytes;
}

// The file's text becomes the buffer's. A write still running is forgotten: if it
// lands later, the next watch batch sees it as any other change.
function adopted(s, text) {
  return {
    ...s,
    phase: "ready",
    limit: null,
    value: text,
    baseline: text,
    diskText: text,
    baseSig: signature(text),
    crlf: isAllCrlf(text),
    writing: null,
    queued: false,
    gen: s.gen + 1,
    banner: null,
    message: null,
    blocked: false,
    deleted: false,
  };
}

function beginWrite(s, expected, effects = []) {
  const text = toDisk(s, s.value);
  return {
    state: { ...s, writing: { text, value: s.value, expected }, queued: false, gen: s.gen + 1 },
    effects: [...effects, { kind: "write", text, expected }],
  };
}

function onFirstRead(s, event) {
  const limit = limitOf(event);
  if (limit) return none({ ...s, phase: "limit", limit });
  return { state: adopted(s, event.text), effects: [LOADED] };
}

// Keeps the buffer and whichever banner is up (D22): limit views are for the first
// read only, and a file gone unreadable must not take the text someone is typing.
const readFailed = (s, message) => none(s.banner ? s : { ...s, banner: "readError", message });

const SETTLED_BY_DISK = new Set(["changed", "conflict", "readError"]);
const clearDiskBanner = (s) => (SETTLED_BY_DISK.has(s.banner) ? { ...s, banner: null, message: null } : s);

function onDiskRead(s, event) {
  if (s.phase !== "ready") return onFirstRead(s, event);
  // Started before a save moved things: it may hold the old text.
  if (event.gen !== undefined && event.gen !== s.gen) return { state: s, effects: [REREAD] };
  if (event.error !== undefined) return readFailed(s, readErrorText(event.error));
  const { text } = event;
  if (text === null) {
    return none({ ...s, deleted: true, diskText: null, banner: s.banner === "changed" ? null : s.banner });
  }
  if (text.includes("\0")) return readFailed(s, TEXT.binary);
  // Our own write, by its text.
  if (s.writing && text === s.writing.text) return none(s);
  if (text === s.diskText) return none(s.blocked ? s : clearDiskBanner(s));
  // The disk now holds what the editor shows, whoever wrote it.
  if (text === toDisk(s, s.value) || text === s.value) {
    const settled = {
      ...clearDiskBanner(s),
      diskText: text,
      baseline: s.value,
      baseSig: signature(text),
      crlf: isAllCrlf(text),
      deleted: false,
      blocked: false,
    };
    const wasRestored = settled.banner === "restored" ? { ...settled, banner: null } : settled;
    return { state: wasRestored, effects: isDirty(s) ? [DROP] : [] };
  }
  if (isDirty(s)) {
    return none({ ...s, banner: "conflict", message: null, deleted: false, diskText: s.blocked ? text : s.diskText });
  }
  // Clean: the page moves only when no one is reading it (D15). Not knowing counts
  // as being read.
  if (event.visible === false) return { state: adopted(s, text), effects: [{ kind: "setValue", text }] };
  return none({ ...s, banner: "changed", message: null, deleted: false });
}

function onEdit(s, event) {
  // What set_value fires, if it fires anything: a reload is not an edit (D22). And
  // an editor left behind a limit view has nothing to say.
  if (s.phase !== "ready" || event.value === s.value) return none(s);
  let next = { ...s, value: event.value, pinned: true };
  if (!next.blocked && (s.banner === "changed" || s.banner === "conflict")) {
    next = { ...next, banner: isDirty(next) ? "conflict" : "changed" };
  }
  return { state: next, effects: [isDirty(next) ? SCHEDULE : DROP] };
}

function onSaveStart(s) {
  if (s.phase !== "ready" || s.readonly) return none(s);
  if (s.banner === "conflict") return { state: s, effects: [toast(TEXT.changedSinceEdits)] };
  if (s.writing) return none({ ...s, queued: true });
  if (!isDirty(s) && !s.deleted) return none(s);
  return beginWrite(s.banner === "failed" ? { ...s, banner: null, message: null } : s, s.diskText);
}

function onSaved(s) {
  const w = s.writing;
  if (!w) return none(s);
  const next = {
    ...s,
    writing: null,
    diskText: w.text,
    baseline: w.value,
    baseSig: signature(w.text),
    deleted: false,
    blocked: false,
    banner: null,
    message: null,
    gen: s.gen + 1,
  };
  const dirty = isDirty(next);
  // Anything that kept typing behind a second cmd-s or the card's Save goes now.
  if (dirty && (next.queued || next.closing)) return beginWrite(next, next.diskText);
  const settled = { ...next, queued: false };
  // The read afterward settles whatever the watch saw during the write.
  if (!settled.closing) return { state: settled, effects: [dirty ? SCHEDULE : DROP, REREAD] };
  return { state: { ...settled, closing: false, card: false }, effects: [DROP, CLOSE] };
}

function onRejected(s, event) {
  const w = s.writing;
  if (!w) return none(s);
  if (event.error === undefined && event.text === w.text) return onSaved(s);
  const base = { ...s, writing: null, queued: false, closing: false, card: false, gen: s.gen + 1 };
  const focus = s.card ? [FOCUS_EDITOR] : [];
  const failed = (message, extra = {}) => ({ state: { ...base, banner: "failed", message, ...extra }, effects: focus });
  if (event.error !== undefined) {
    return failed(classifyReadError(event.error) === "notUtf8" ? TEXT.notUtf8Save : TEXT.saveFailed);
  }
  if (event.text === null) {
    return failed(TEXT.saveFailed, w.expected === null ? {} : { deleted: true, diskText: null });
  }
  if (event.text === w.expected) return failed(utf8Length(w.text) > MIB ? TEXT.tooLarge : TEXT.saveFailed);
  return { state: { ...base, banner: "conflict", message: null }, effects: [...focus, toast(TEXT.changedSinceEdits)] };
}

function onRestore(s, { meta, draftText, diskText }) {
  const outcome = restoreDraft(meta, draftText, diskText);
  if (outcome === "drop") return { state: adopted(s, diskText), effects: [LOADED, DROP] };
  const known = typeof diskText === "string" ? diskText : null;
  const kept = {
    ...s,
    phase: "ready",
    limit: null,
    value: draftText,
    pinned: true,
    crlf: isAllCrlf(known ?? draftText),
  };
  if (outcome === "resume") {
    return { state: { ...kept, baseline: known, diskText: known, baseSig: signature(known), banner: "restored" }, effects: [LOADED] };
  }
  // Both keep the draft's base: a draft written from here must still say so on the
  // next open, or it would come back as a clean resume.
  if (outcome === "deleted") {
    return { state: { ...kept, baseline: null, diskText: null, baseSig: meta.baseSig, deleted: true, banner: "restored" }, effects: [LOADED] };
  }
  return { state: { ...kept, baseline: known, diskText: known, baseSig: meta.baseSig, blocked: true, banner: "conflict" }, effects: [LOADED] };
}

function onReload(s, event) {
  if (s.banner !== "conflict" && s.banner !== "changed") return none(s);
  if (event.error !== undefined) return { state: s, effects: [toast(`${TEXT.unableToLoad}: ${event.error}`)] };
  if (event.text === null) return none({ ...s, deleted: true, diskText: null, banner: null, blocked: false });
  if (event.text.includes("\0")) return { state: s, effects: [toast(TEXT.binary)] };
  const effects = [{ kind: "setValue", text: event.text }, DROP];
  if (isDirty(s)) effects.push(toast(TEXT.reloaded, "info"));
  return { state: adopted(s, event.text), effects };
}

function onDiscard(s, event) {
  if (s.banner !== "restored") return none(s);
  if (event.error !== undefined) return { state: s, effects: [toast(`${TEXT.unableToLoad}: ${event.error}`)] };
  if (event.text === null) {
    return { state: { ...s, value: "", baseline: "", banner: null, phase: "limit", limit: limitOf(event), deleted: false }, effects: [DROP] };
  }
  if (event.text.includes("\0")) return { state: s, effects: [toast(TEXT.binary)] };
  return { state: adopted(s, event.text), effects: [{ kind: "setValue", text: event.text }, DROP] };
}

// The next save replaces what is on disk now, so that text becomes the base and
// going back to the old text counts as a change.
function onKeepMine(s, event) {
  if (s.banner !== "conflict") return none(s);
  if (event.error !== undefined) return { state: s, effects: [toast(TEXT.saveFailed)] };
  const text = event.text;
  const next = {
    ...s,
    baseline: text,
    diskText: text,
    baseSig: text === null ? null : signature(text),
    crlf: text === null ? s.crlf : isAllCrlf(text),
    deleted: text === null,
    banner: null,
    message: null,
    blocked: false,
  };
  return { state: next, effects: [isDirty(next) ? SCHEDULE : DROP] };
}

function onOverwrite(s, event) {
  if (s.banner !== "conflict" || s.writing || s.readonly) return none(s);
  if (event.error !== undefined) return { state: s, effects: [toast(TEXT.saveFailed)] };
  const text = event.text;
  const next = {
    ...s,
    diskText: text,
    crlf: text === null ? s.crlf : isAllCrlf(text),
    deleted: text === null,
    banner: null,
    message: null,
    blocked: false,
  };
  return beginWrite(next, text);
}

function onSaveAndClose(s) {
  if (!s.card) return none(s);
  if (!isDirty(s) && !s.writing) return { state: { ...s, card: false }, effects: [CLOSE] };
  // writeTextFile would replace even a 0444 file: a draft restored over one stays a draft.
  if (s.readonly) return { state: { ...s, card: false }, effects: [FOCUS_EDITOR, toast(TEXT.readOnly)] };
  // It can't write under the banner, which says what to do instead.
  if (s.banner === "conflict") {
    return { state: { ...s, card: false }, effects: [FOCUS_EDITOR, toast(TEXT.changedSinceEdits)] };
  }
  if (s.writing) return none({ ...s, closing: true, queued: true });
  const closing = { ...s, closing: true, banner: s.banner === "failed" ? null : s.banner };
  return beginWrite(closing, s.diskText);
}

export function reduce(s, event) {
  switch (event.type) {
    case "diskRead":
      return onDiskRead(s, event);
    case "edit":
      return onEdit(s, event);
    case "settled":
      return none({ ...s, value: event.value, baseline: s.value === s.baseline ? event.value : s.baseline });
    case "saveStart":
      return onSaveStart(s);
    case "saveOk":
      return onSaved(s);
    case "saveRejected":
      return onRejected(s, event);
    case "restore":
      return onRestore(s, event);
    case "reload":
      return onReload(s, event);
    case "discard":
      return onDiscard(s, event);
    case "keepMine":
      return onKeepMine(s, event);
    case "overwrite":
      return onOverwrite(s, event);
    case "retry":
      if (s.phase === "limit") return { state: { ...s, phase: "loading", limit: null }, effects: [REREAD] };
      if (s.banner === "readError") return { state: { ...s, banner: null, message: null }, effects: [REREAD] };
      return none(s);
    case "pin":
      return none(s.pinned ? s : { ...s, pinned: true });
    case "access":
      return none({ ...s, readonly: Boolean(event.readonly) });
    case "askClose":
      if (s.card) return none(s);
      return isDirty(s) ? { state: { ...s, card: true }, effects: [{ kind: "focusCard" }] } : { state: s, effects: [CLOSE] };
    case "cancelClose":
      return s.card ? { state: { ...s, card: false, closing: false }, effects: [FOCUS_EDITOR] } : none(s);
    case "saveAndClose":
      return onSaveAndClose(s);
    case "dontSave":
      return s.card ? { state: { ...s, card: false, closing: false }, effects: [{ kind: "discardClose" }] } : none(s);
    default:
      return none(s);
  }
}

// ── Commands (D18) ───────────────────────────────────────────────────────────

const PLAIN_COMMANDS = new Set(["save", "close", "reload", "overwrite", "keep-mine", "discard", "retry", "cancel", "dont-save", "card-save", "edit", "focus"]);

// What a command asks of this copy, or null. An order naming a doc only counts for
// that doc: the X of one tab must never close another.
export function commandFor(raw, doc) {
  const text = String(raw);
  const command = text.startsWith(`${MOD}.`) ? text.slice(MOD.length + 1) : text;
  if (PLAIN_COMMANDS.has(command)) return command;
  if (command === `ask-close-${doc}`) return "close";
  if (command === `pin-${doc}`) return "pin";
  return null;
}

// ── Tabs (D10, D18) ──────────────────────────────────────────────────────────

const allTabs = (spaces) => spaces.flatMap((s) => s.tabs);

// This copy's tab: its doc in `docs`, while that tab exists.
export function tabOfDoc(docs, doc, spaces) {
  const tabs = allTabs(spaces);
  for (const [tab, entry] of Object.entries(docs ?? {})) {
    if (entry?.doc === doc && tabs.some((t) => t.id === tab)) return tab;
  }
  return null;
}

// Whether a doc is still on screen. A file closed beside a terminal leaves its tab, and
// the table naming it, behind: only a tab still holding this mod keeps the doc's draft.
export function docIsOpen(docs, doc, spaces, panes) {
  const tab = tabOfDoc(docs, doc, spaces);
  return tab !== null && panes.some((p) => p.tab === tab && p.mod === MOD);
}

// A tab nobody listed in `docs`. Only a command or a click may ask: they reach the
// copy in the shown tab and no other.
export function activeFileTab(spaces, panes) {
  const tab = spaces.find((s) => s.active)?.tabs.find((t) => t.active);
  return tab && panes.some((p) => p.tab === tab.id && p.mod === MOD) ? tab.id : null;
}

export const tabInfo = (id, spaces) => allTabs(spaces).find((t) => t.id === id) ?? null;

// How a tab's file goes. Never `confirmed`, which on a space's last tab closes the
// space without asking, and pane.close always with its pane, because without one it
// can end the focused terminal. Null: nothing safe to run.
export function closeAction(id, spaces, panes) {
  const tab = tabInfo(id, spaces);
  if (!tab) return null;
  if (tab.panes <= 1) return ["tab.close", { id }];
  const pane = panes.find((p) => p.tab === id && p.mod === MOD);
  return pane ? ["pane.close", { pane: pane.pane }] : null;
}

// watchFolder is recursive on macOS, and AGENTS.md says to watch what you show, not a
// whole home folder: neither the home nor anything above it.
export const holdsHome = (dir, home) => dir === "/" || dir === home || home.startsWith(`${dir}/`);

// ── Watch batches (D19, D22) ─────────────────────────────────────────────────

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const WRITE_TEMP = ".herdr-app-write-";

// watchFolder hands out resolved paths and writeTextFile's temporaries; the file
// itself may not exist, so it's compared by its folder's realpath plus its name. The
// root in a batch means the pending paths overflowed: read again. So does anything
// that isn't a list.
export function batchNamesFile(batch, { dir, realDir, name }) {
  if (!Array.isArray(batch)) return true;
  const roots = [trimSlash(dir), trimSlash(realDir)];
  const targets = roots.map((root) => `${root}/${name}`);
  for (const entry of batch) {
    if (typeof entry !== "string") continue;
    const path = trimSlash(entry);
    if (path.slice(path.lastIndexOf("/") + 1).startsWith(WRITE_TEMP)) continue;
    if (roots.includes(path) || targets.includes(path)) return true;
  }
  return false;
}

// ── Language and header (D14) ────────────────────────────────────────────────

// The names Herdr's `files` mod gives EditorState. Coloring blocks the window
// (1 MiB 4.5 s, 200 KB 0.43 s), so a big file opens as plain text.
const LANGUAGES = Object.freeze({ ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html" });
// Herdr colors the whole file again on each key: 125 ms at 50 KB, 440 ms at 200 KB
// (measured), against 25 ms for a small file.
export const COLOR_LIMIT = 50 * 1024;

const LABELS = Object.freeze({
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  json: "JSON", jsonc: "JSON", md: "Markdown", sh: "Shell", bash: "Shell", zsh: "Shell", svg: "SVG", html: "HTML", css: "CSS", py: "Python", rs: "Rust",
  go: "Go", rb: "Ruby", php: "PHP", lua: "Lua", sql: "SQL", java: "Java", c: "C", h: "C", cpp: "C++", yaml: "YAML", yml: "YAML", toml: "TOML", swift: "Swift",
  kt: "Kotlin", vue: "Vue", svelte: "Svelte", xml: "XML",
});

const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

// A leading dot isn't an extension: `.env` has none.
function extensionOf(path) {
  const name = String(path).slice(String(path).lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

export function languageFor(path, length = 0) {
  const ext = extensionOf(path);
  const language = ext ? own(LANGUAGES, ext) ?? ext : "txt";
  const big = length > COLOR_LIMIT;
  return { language: big ? "txt" : language, noColors: big && language !== "txt" };
}

export function fileMeta(s, path) {
  const label = own(LABELS, extensionOf(path)) ?? "Plain Text";
  return `${label} · UTF-8 · ${s.crlf ? "CRLF" : "LF"}`;
}
