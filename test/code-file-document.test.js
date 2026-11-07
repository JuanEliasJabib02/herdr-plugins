// One open file as a reducer (plan D22, D19, D15): every outcome of a save, a
// disk change and a banner or card button of S12 is one test here. S8: writing
// in the editor and saving. S3: the behavior and the strings are Orca's.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT, activeFileTab, batchNamesFile, bannerView, classifyReadError, closeAction, closeBody, commandFor,
  createDoc, fileMeta, isAllCrlf, isDirty, languageFor, needsRedraw, reduce, tabOfDoc, toDisk,
} from "../code-editor/mods/code-file/document-model.js";
import { signature } from "../code-editor/mods/code-file/draft-model.js";

const kinds = (r) => r.effects.map((e) => e.kind);
const effect = (r, kind) => r.effects.find((e) => e.kind === kind);
// Runs events in order; the result is the last step's { state, effects }.
function play(state, ...events) {
  let step = { state, effects: [] };
  for (const event of events) step = reduce(step.state, event);
  return step;
}
const ready = (text = "one\n") => reduce(createDoc(), { type: "diskRead", text }).state;
const edit = (value) => ({ type: "edit", value });
const dirtyDoc = (value = "one\ntwo\n", text = "one\n") => reduce(ready(text), edit(value)).state;

// ── First read ───────────────────────────────────────────────────────────────

test("S8: the first read opens the file, clean", () => {
  const r = reduce(createDoc(), { type: "diskRead", text: "one\n" });
  assert.equal(r.state.phase, "ready");
  assert.equal(r.state.value, "one\n");
  assert.equal(r.state.baseline, "one\n");
  assert.equal(r.state.diskText, "one\n");
  assert.equal(r.state.baseSig, signature("one\n"));
  assert.equal(isDirty(r.state), false);
  assert.deepEqual(kinds(r), ["loaded"]);
});

test("S12: limit views only on the first read: too large, binary, not UTF-8, missing, unknown", () => {
  const first = (event) => reduce(createDoc(), { type: "diskRead", ...event }).state;
  const large = first({ error: "Text file exceeds 1 MiB" });
  assert.equal(large.phase, "limit");
  assert.deepEqual(large.limit, { title: "File too large: exceeds the 1 MiB limit", message: null, retry: false });
  assert.deepEqual(first({ text: "a\0b" }).limit, { title: "Binary file — cannot display", message: null, retry: false });
  assert.deepEqual(first({ error: "stream did not contain valid UTF-8" }).limit, { title: "This file isn't UTF-8 text", message: null, retry: false });
  const missing = first({ text: null }).limit;
  assert.equal(missing.title, "Unable to load file");
  assert.equal(missing.retry, true);
  assert.deepEqual(first({ error: "Permission denied" }).limit, { title: "Unable to load file", message: "Permission denied", retry: true });
});

test("S12: Retry reads again and a file that is fine now opens", () => {
  const stuck = reduce(createDoc(), { type: "diskRead", error: "Permission denied" }).state;
  const retried = reduce(stuck, { type: "retry" });
  assert.equal(retried.state.phase, "loading");
  assert.deepEqual(kinds(retried), ["reread"]);
  const opened = reduce(retried.state, { type: "diskRead", text: "back\n" });
  assert.equal(opened.state.phase, "ready");
  assert.deepEqual(kinds(opened), ["loaded"]);
});

test("D22: reading stays limited to what the message says only on the first read", () => {
  assert.equal(classifyReadError("Text file exceeds 1 MiB"), "tooLarge");
  assert.equal(classifyReadError("stream did not contain valid UTF-8"), "notUtf8");
  assert.equal(classifyReadError("anything else"), "other");
});

// ── Editing ──────────────────────────────────────────────────────────────────

test("S8: typing makes it dirty, pins the preview and schedules a draft", () => {
  const r = reduce(ready(), edit("one\ntwo\n"));
  assert.equal(isDirty(r.state), true);
  assert.equal(r.state.pinned, true);
  assert.deepEqual(kinds(r), ["scheduleDraft"]);
});

test("D22: dirty is computed: undoing back to the baseline is clean, drops the draft, and stays pinned", () => {
  const r = play(ready(), edit("x"), edit("one\n"));
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.pinned, true);
  assert.deepEqual(kinds(r), ["dropDraft"]);
  assert.equal("dirty" in r.state, false, "dirty is never a stored field");
});

test("D22: a reload is not an edit: the change it may fire pins nothing and starts no draft", () => {
  const hidden = reduce(ready(), { type: "diskRead", text: "theirs\n", visible: false });
  assert.deepEqual(kinds(hidden), ["setValue"]);
  const change = reduce(hidden.state, edit("theirs\n"));
  assert.equal(change.state.pinned, false);
  assert.deepEqual(change.effects, []);
});

test("D22: only an open file takes edits: an old editor behind a limit view changes nothing", () => {
  const limit = reduce(createDoc(), { type: "diskRead", text: null }).state;
  const r = reduce(limit, edit("left over"));
  assert.equal(r.state, limit);
  assert.deepEqual(r.effects, []);
});

test("pin: a double click on the tab pins without any edit", () => {
  const s = reduce(ready(), { type: "pin" }).state;
  assert.equal(s.pinned, true);
  assert.equal(isDirty(s), false);
});

// ── Saving ───────────────────────────────────────────────────────────────────

test("S8: cmd-s writes the editor's text over what was read, and saveOk leaves it clean", () => {
  const start = reduce(dirtyDoc(), { type: "saveStart" });
  assert.deepEqual(effect(start, "write"), { kind: "write", text: "one\ntwo\n", expected: "one\n" });
  const done = reduce(start.state, { type: "saveOk" });
  assert.equal(isDirty(done.state), false);
  assert.equal(done.state.diskText, "one\ntwo\n");
  assert.equal(done.state.baseSig, signature("one\ntwo\n"));
  assert.deepEqual(kinds(done), ["dropDraft", "reread"]);
});

test("S8: cmd-s on a clean file writes nothing", () => {
  assert.deepEqual(reduce(ready(), { type: "saveStart" }).effects, []);
});

test("D22: text typed during the await stays dirty and keeps its draft", () => {
  const r = play(dirtyDoc("a"), { type: "saveStart" }, edit("ab"), { type: "saveOk" });
  assert.equal(isDirty(r.state), true);
  assert.equal(r.state.baseline, "a");
  assert.equal(r.state.diskText, "a");
  assert.equal(effect(r, "dropDraft"), undefined);
  assert.ok(effect(r, "scheduleDraft"));
});

test("D22: double cmd-s: one write running and one queued, no false conflict", () => {
  const first = reduce(dirtyDoc("a"), { type: "saveStart" });
  const typed = reduce(first.state, edit("ab"));
  const second = reduce(typed.state, { type: "saveStart" });
  assert.deepEqual(second.effects, [], "the second waits");
  assert.equal(second.state.queued, true);
  const landed = reduce(second.state, { type: "saveOk" });
  assert.deepEqual(effect(landed, "write"), { kind: "write", text: "ab", expected: "a" });
  assert.equal(landed.state.banner, null);
  const again = reduce(landed.state, { type: "saveOk" });
  assert.equal(isDirty(again.state), false);
  assert.equal(again.state.diskText, "ab");
});

test("D22: double cmd-s with nothing typed between writes once", () => {
  const r = play(dirtyDoc("a"), { type: "saveStart" }, { type: "saveStart" }, { type: "saveOk" });
  assert.equal(effect(r, "write"), undefined);
  assert.equal(r.state.queued, false);
});

test("D22: the batch of our own write is ours, by its text or by diskText", () => {
  const start = reduce(dirtyDoc("a"), { type: "saveStart" }).state;
  const during = reduce(start, { type: "diskRead", text: "a" });
  assert.equal(during.state.banner, null);
  assert.deepEqual(during.effects, []);
  const after = play(start, { type: "saveOk" }, { type: "diskRead", text: "a", visible: false });
  assert.equal(after.state.banner, null);
  assert.deepEqual(after.effects, []);
  const untouched = reduce(dirtyDoc("a"), { type: "diskRead", text: "one\n" });
  assert.equal(untouched.state.banner, null);
});

test("D22: a read that started before the save finished never raises a conflict: it reads again", () => {
  const start = reduce(dirtyDoc("a"), { type: "saveStart" }).state;
  const gen = start.gen;
  const saved = reduce(start, { type: "saveOk" }).state;
  const stale = reduce(saved, { type: "diskRead", text: "one\n", gen });
  assert.equal(stale.state.banner, null);
  assert.deepEqual(kinds(stale), ["reread"]);
});

test("D19: CRLF: every loose \\n is saved as \\r\\n, and two saves with Enter between don't conflict", () => {
  const text = "a\r\nb\r\n";
  assert.equal(isAllCrlf(text), true);
  const first = play(ready(text), edit("a\r\nb\r\nc\n"), { type: "saveStart" });
  assert.deepEqual(effect(first, "write"), { kind: "write", text: "a\r\nb\r\nc\r\n", expected: text });
  const saved = reduce(first.state, { type: "saveOk" }).state;
  assert.equal(saved.baseline, "a\r\nb\r\nc\n", "the baseline is the editor's text");
  assert.equal(saved.diskText, "a\r\nb\r\nc\r\n", "diskText is the next expected");
  assert.equal(isDirty(saved), false);
  const second = play(saved, edit("a\r\nb\r\nc\nd\n"), { type: "saveStart" });
  assert.deepEqual(effect(second, "write"), { kind: "write", text: "a\r\nb\r\nc\r\nd\r\n", expected: "a\r\nb\r\nc\r\n" });
  const own = reduce(second.state, { type: "diskRead", text: "a\r\nb\r\nc\r\nd\r\n" });
  assert.equal(own.state.banner, null);
});

test("D19: a file not all CRLF is saved as it is; all-CRLF is worked out on each load", () => {
  assert.equal(isAllCrlf("a\nb\r\n"), false);
  assert.equal(isAllCrlf("a\n"), false);
  assert.equal(isAllCrlf("no newline"), false);
  assert.equal(isAllCrlf(""), false);
  const mixed = play(ready("a\nb\r\n"), edit("a\nb\r\nc\n"), { type: "saveStart" });
  assert.equal(effect(mixed, "write").text, "a\nb\r\nc\n");
  const reloaded = reduce(ready("a\r\n"), { type: "diskRead", text: "a\n", visible: false }).state;
  assert.equal(reloaded.crlf, false);
  assert.equal(toDisk(reloaded, "x\n"), "x\n");
});

test("D22: BOM stays: nothing touches the first character", () => {
  const r = play(ready("﻿a"), edit("﻿ab"), { type: "saveStart" });
  assert.equal(effect(r, "write").text, "﻿ab");
});

test("D22: a read-only file never writes", () => {
  const s = reduce(createDoc(), { type: "access", readonly: true }).state;
  const open = reduce(s, { type: "diskRead", text: "a" }).state;
  assert.equal(open.readonly, true);
  assert.deepEqual(reduce({ ...open, value: "ab" }, { type: "saveStart" }).effects, []);
});

// ── A rejected save: decided by the text, never by the message ───────────────

const rejectedDoc = () => reduce(dirtyDoc("mine"), { type: "saveStart" }).state;

test("S12: rejected and the disk has other text: conflict banner and toast, buffer intact, whichever the message", () => {
  for (const message of [
    "The file changed outside Herdr. Reload before saving; your draft is still here.",
    "The file changed while saving",
    "some other words",
    undefined,
  ]) {
    const r = reduce(rejectedDoc(), { type: "saveRejected", text: "theirs", message });
    assert.equal(r.state.banner, "conflict");
    assert.equal(r.state.value, "mine");
    assert.equal(isDirty(r.state), true);
    assert.equal(effect(r, "write"), undefined);
    assert.equal(effect(r, "dropDraft"), undefined);
    assert.equal(effect(r, "toast").title, "This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.");
  }
});

test("S12: rejected and the disk is as it was, even with a conflict's message: Failed to save, buffer and draft intact", () => {
  const r = reduce(rejectedDoc(), { type: "saveRejected", text: "one\n", message: "The file changed outside Herdr." });
  assert.equal(r.state.banner, "failed");
  assert.equal(bannerView(r.state).text, "Failed to save the file. Please try again.");
  assert.equal(r.state.value, "mine");
  assert.equal(isDirty(r.state), true);
  assert.deepEqual(r.effects, []);
});

test("D22: rejected but the disk already holds our text: it's saved", () => {
  const r = reduce(rejectedDoc(), { type: "saveRejected", text: "mine" });
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.banner, null);
  assert.equal(r.state.diskText, "mine");
});

test("S12: a save that fails because the file isn't UTF-8 says so", () => {
  const r = reduce(rejectedDoc(), { type: "saveRejected", error: "stream did not contain valid UTF-8" });
  assert.equal(bannerView(r.state).text, "This file isn't UTF-8 text, so it wasn't saved.");
  assert.equal(r.state.value, "mine");
});

test("D22: a re-read that fails after a rejection: Failed to save, buffer intact", () => {
  const r = reduce(rejectedDoc(), { type: "saveRejected", error: "disk on fire" });
  assert.equal(bannerView(r.state).text, "Failed to save the file. Please try again.");
  assert.equal(r.state.value, "mine");
});

test("D22: more than 1 MiB can't be written: shows the failure and keeps the draft", () => {
  const big = "x".repeat(1024 * 1024 + 1);
  const start = reduce(dirtyDoc(big), { type: "saveStart" }).state;
  const r = reduce(start, { type: "saveRejected", text: "one\n" });
  assert.equal(bannerView(r.state).text, "File too large: exceeds the 1 MiB limit");
  assert.equal(r.state.value, big);
  assert.equal(effect(r, "dropDraft"), undefined);
});

test("D22: rejected because the file is gone: deleted, and the next save creates it", () => {
  const r = reduce(rejectedDoc(), { type: "saveRejected", text: null });
  assert.equal(r.state.deleted, true);
  assert.equal(r.state.diskText, null);
  const next = reduce(r.state, { type: "saveStart" });
  assert.deepEqual(effect(next, "write"), { kind: "write", text: "mine", expected: null });
});

test("D22: creating a deleted file fails with the file still absent: Failed to save", () => {
  const r = play(rejectedDoc(), { type: "saveRejected", text: null }, { type: "saveStart" }, { type: "saveRejected", text: null });
  assert.equal(bannerView(r.state).text, "Failed to save the file. Please try again.");
});

test("S12: the failure banner goes when the next save starts", () => {
  const failed = reduce(rejectedDoc(), { type: "saveRejected", text: "one\n" }).state;
  assert.equal(reduce(failed, { type: "saveStart" }).state.banner, null);
});

test("D22: a rejection drops the queued save too", () => {
  const queued = reduce(rejectedDoc(), { type: "saveStart" }).state;
  const r = reduce(queued, { type: "saveRejected", text: "theirs" });
  assert.equal(r.state.queued, false);
  assert.equal(effect(r, "write"), undefined);
});

// ── The disk changed (D15, D22) ──────────────────────────────────────────────

test("D15: clean and not on screen: reloads quietly", () => {
  const r = reduce(ready(), { type: "diskRead", text: "theirs\n", visible: false });
  assert.deepEqual(effect(r, "setValue"), { kind: "setValue", text: "theirs\n" });
  assert.equal(r.state.banner, null);
  assert.equal(r.state.value, "theirs\n");
  assert.equal(r.state.diskText, "theirs\n");
  assert.equal(isDirty(r.state), false);
});

test("D15: clean and on screen: banner with Recargar, the page doesn't move until asked", () => {
  const r = reduce(ready(), { type: "diskRead", text: "theirs\n", visible: true });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.value, "one\n");
  const banner = bannerView(r.state);
  assert.equal(banner.text, "Cambió en disco");
  assert.deepEqual(banner.buttons.map((b) => [b.id, b.label]), [["reload", "Recargar"]]);
  const reloaded = reduce(r.state, { type: "reload", text: "theirs\n" });
  assert.deepEqual(effect(reloaded, "setValue"), { kind: "setValue", text: "theirs\n" });
  assert.equal(reloaded.state.banner, null);
});

test("D15: not knowing whether it's on screen counts as on screen", () => {
  const r = reduce(ready(), { type: "diskRead", text: "theirs\n" });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.banner, "changed");
});

test("S12: dirty: the buffer never reloads, the conflict banner shows", () => {
  const r = reduce(dirtyDoc(), { type: "diskRead", text: "theirs\n", visible: false });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.value, "one\ntwo\n");
  assert.equal(r.state.banner, "conflict");
  const banner = bannerView(r.state);
  assert.equal(banner.text, "This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.");
  assert.deepEqual(banner.buttons.map((b) => [b.id, b.label]), [["reload", "Reload from Disk"], ["overwrite", "Overwrite"], ["keep-mine", "Keep My Edits"]]);
  assert.equal(banner.buttons[2].tip, "Keeps your version. Your next save replaces the version on disk.");
});

test("D22: text typed while the read was out wins: dirty again at the read's end, no set_value", () => {
  const typed = reduce(ready(), edit("typed"));
  const r = reduce(typed.state, { type: "diskRead", text: "theirs", visible: false });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.value, "typed");
  assert.equal(r.state.banner, "conflict");
});

test("D22: the disk now holds what the editor shows: clean, draft dropped, no banner", () => {
  const r = reduce(dirtyDoc("same"), { type: "diskRead", text: "same", visible: true });
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.banner, null);
  assert.equal(r.state.diskText, "same");
  assert.deepEqual(kinds(r), ["dropDraft"]);
});

test("D19: the disk holds the editor's text in CRLF form: clean as well", () => {
  const doc = reduce(ready("a\r\n"), edit("a\r\nb\n")).state;
  const r = reduce(doc, { type: "diskRead", text: "a\r\nb\r\n", visible: true });
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.diskText, "a\r\nb\r\n");
});

test("D15: typing with Cambió en disco up turns it into the conflict; undoing turns it back", () => {
  const changed = reduce(ready(), { type: "diskRead", text: "theirs\n", visible: true }).state;
  const typed = reduce(changed, edit("mine"));
  assert.equal(typed.state.banner, "conflict");
  const undone = reduce(typed.state, edit("one\n"));
  assert.equal(undone.state.banner, "changed");
});

test("D22: the disk going back to what we had takes the banner away", () => {
  const conflict = reduce(dirtyDoc(), { type: "diskRead", text: "theirs\n" }).state;
  assert.equal(reduce(conflict, { type: "diskRead", text: "one\n" }).state.banner, null);
  const changed = reduce(ready(), { type: "diskRead", text: "theirs\n", visible: true }).state;
  assert.equal(reduce(changed, { type: "diskRead", text: "one\n" }).state.banner, null);
});

test("S12: cmd-s under the conflict banner writes nothing and says to use the banner", () => {
  const conflict = reduce(dirtyDoc(), { type: "diskRead", text: "theirs\n" }).state;
  const r = reduce(conflict, { type: "saveStart" });
  assert.equal(effect(r, "write"), undefined);
  assert.equal(effect(r, "toast").title, TEXT.changedSinceEdits);
});

// ── A vanished file (D22) ────────────────────────────────────────────────────

test("D22: a vanished file: marked deleted, the buffer is untouched, clean stays clean", () => {
  const r = reduce(ready(), { type: "diskRead", text: null });
  assert.equal(r.state.deleted, true);
  assert.equal(r.state.value, "one\n");
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.diskText, null);
  assert.deepEqual(r.effects, []);
  const dirty = reduce(dirtyDoc(), { type: "diskRead", text: null });
  assert.equal(dirty.state.value, "one\ntwo\n");
  assert.equal(isDirty(dirty.state), true);
});

test("D22: saving a vanished file uses expected = null, clean too, and clears the mark", () => {
  const clean = reduce(ready(), { type: "diskRead", text: null }).state;
  const start = reduce(clean, { type: "saveStart" });
  assert.deepEqual(effect(start, "write"), { kind: "write", text: "one\n", expected: null });
  const done = reduce(start.state, { type: "saveOk" });
  assert.equal(done.state.deleted, false);
  assert.equal(done.state.diskText, "one\n");
});

test("D22: the path comes back: the mark goes, and other text follows the usual rule", () => {
  const gone = reduce(ready(), { type: "diskRead", text: null }).state;
  const same = reduce(gone, { type: "diskRead", text: "one\n", visible: true });
  assert.equal(same.state.deleted, false);
  assert.equal(same.state.banner, null);
  const other = reduce(gone, { type: "diskRead", text: "theirs", visible: true });
  assert.equal(other.state.deleted, false);
  assert.equal(other.state.banner, "changed");
  const dirtyGone = reduce(dirtyDoc(), { type: "diskRead", text: null }).state;
  assert.equal(reduce(dirtyGone, { type: "diskRead", text: "theirs" }).state.banner, "conflict");
});

// ── A read that fails with a live buffer (D22) ───────────────────────────────

test("D22: a read error with a live buffer keeps buffer and banner, never a limit view", () => {
  for (const error of ["Text file exceeds 1 MiB", "stream did not contain valid UTF-8", "Permission denied"]) {
    const r = reduce(dirtyDoc(), { type: "diskRead", error });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.value, "one\ntwo\n");
    assert.equal(r.state.banner, "readError");
  }
  const conflict = reduce(dirtyDoc(), { type: "diskRead", text: "theirs" }).state;
  assert.equal(reduce(conflict, { type: "diskRead", error: "boom" }).state.banner, "conflict");
});

test("D22: a file that turned binary with a live buffer never reaches set_value", () => {
  const r = reduce(ready(), { type: "diskRead", text: "a\0b", visible: false });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.value, "one\n");
  assert.equal(bannerView(r.state).text, "Binary file — cannot display");
});

test("S12: the read error banner offers Retry", () => {
  const r = reduce(ready(), { type: "diskRead", error: "Permission denied" });
  const banner = bannerView(r.state);
  assert.equal(banner.text, "Unable to load file: Permission denied");
  assert.deepEqual(banner.buttons.map((b) => [b.id, b.label]), [["retry", "Retry"]]);
  const again = reduce(r.state, { type: "retry" });
  assert.equal(again.state.banner, null);
  assert.deepEqual(kinds(again), ["reread"]);
});

// ── The buttons (S12) ────────────────────────────────────────────────────────

const conflicted = () => reduce(dirtyDoc("mine"), { type: "diskRead", text: "theirs" }).state;

test("S12: Reload from Disk: takes the disk's text, drops the draft, and says Reloaded from disk", () => {
  const r = reduce(conflicted(), { type: "reload", text: "theirs" });
  assert.deepEqual(effect(r, "setValue"), { kind: "setValue", text: "theirs" });
  assert.ok(effect(r, "dropDraft"));
  assert.equal(effect(r, "toast").title, "Reloaded from disk");
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.banner, null);
  assert.equal(r.state.diskText, "theirs");
});

test("S12: Recargar on a clean file discards nothing, so no toast", () => {
  const changed = reduce(ready(), { type: "diskRead", text: "theirs", visible: true }).state;
  assert.equal(effect(reduce(changed, { type: "reload", text: "theirs" }), "toast"), undefined);
});

test("S12: Reload from Disk with the file gone keeps the buffer and marks it deleted", () => {
  const r = reduce(conflicted(), { type: "reload", text: null });
  assert.equal(effect(r, "setValue"), undefined);
  assert.equal(r.state.value, "mine");
  assert.equal(r.state.deleted, true);
  assert.equal(r.state.banner, null);
});

test("S12: Reload from Disk that can't read keeps the banner and the buffer", () => {
  const r = reduce(conflicted(), { type: "reload", error: "boom" });
  assert.equal(r.state.value, "mine");
  assert.equal(r.state.banner, "conflict");
  assert.equal(effect(r, "setValue"), undefined);
});

test("S12: Overwrite: writes over what is on disk now, banner gone, clean when done", () => {
  const r = reduce(conflicted(), { type: "overwrite", text: "theirs" });
  assert.deepEqual(effect(r, "write"), { kind: "write", text: "mine", expected: "theirs" });
  assert.equal(r.state.banner, null);
  const done = reduce(r.state, { type: "saveOk" });
  assert.equal(isDirty(done.state), false);
  assert.ok(effect(done, "dropDraft"));
});

test("S12: Overwrite losing a new race is a conflict again, never a blind write", () => {
  const r = play(conflicted(), { type: "overwrite", text: "theirs" }, { type: "saveRejected", text: "newer" });
  assert.equal(r.state.banner, "conflict");
  assert.equal(effect(r, "write"), undefined);
});

test("S12: Overwrite with the file gone creates it, and a failed read writes nothing", () => {
  assert.deepEqual(effect(reduce(conflicted(), { type: "overwrite", text: null }), "write"), { kind: "write", text: "mine", expected: null });
  const failed = reduce(conflicted(), { type: "overwrite", error: "boom" });
  assert.equal(effect(failed, "write"), undefined);
  assert.equal(failed.state.banner, "conflict");
  assert.equal(effect(failed, "toast").title, "Failed to save the file. Please try again.");
});

test("S12: Keep My Edits: banner gone, still dirty, the next save replaces the new disk text", () => {
  const r = reduce(conflicted(), { type: "keepMine", text: "theirs" });
  assert.equal(r.state.banner, null);
  assert.equal(r.state.value, "mine");
  assert.equal(isDirty(r.state), true);
  assert.equal(r.state.diskText, "theirs");
  assert.equal(r.state.baseSig, signature("theirs"));
  assert.equal(effect(r, "write"), undefined);
  assert.ok(effect(r, "scheduleDraft"), "the draft's base moved");
  const save = reduce(r.state, { type: "saveStart" });
  assert.deepEqual(effect(save, "write"), { kind: "write", text: "mine", expected: "theirs" });
});

test("S12: buttons do nothing outside their banner, so a stray command can't lose edits", () => {
  const doc = dirtyDoc();
  for (const type of ["reload", "keepMine", "overwrite", "discard"]) {
    const r = reduce(doc, { type, text: "theirs" });
    assert.equal(r.state, doc, type);
    assert.deepEqual(r.effects, [], type);
  }
  for (const type of ["cancelClose", "saveAndClose", "dontSave"]) {
    assert.deepEqual(reduce(doc, { type }).effects, [], type);
  }
});

// ── Restoring a draft (D20) ──────────────────────────────────────────────────

const meta = (baseSig) => ({ path: "/a", baseSig, length: 5, at: 1 });
const restored = (diskText, baseText = "base\n", draftText = "draft") =>
  reduce(createDoc(), { type: "restore", meta: meta(signature(baseText)), draftText, diskText });

test("D20: restore resume: disk is the draft's base: edits back, pinned, Restored banner with Discard", () => {
  const r = restored("base\n");
  assert.equal(r.state.phase, "ready");
  assert.equal(r.state.value, "draft");
  assert.equal(r.state.baseline, "base\n");
  assert.equal(r.state.diskText, "base\n");
  assert.equal(isDirty(r.state), true);
  assert.equal(r.state.pinned, true);
  const banner = bannerView(r.state);
  assert.equal(banner.text, "Restored unsaved changes");
  assert.deepEqual(banner.buttons.map((b) => [b.id, b.label]), [["discard", "Discard"]]);
  assert.deepEqual(kinds(r), ["loaded"]);
});

test("D20: Discard on the restored banner goes back to the disk and drops the draft", () => {
  const r = reduce(restored("base\n").state, { type: "discard", text: "base\n" });
  assert.deepEqual(effect(r, "setValue"), { kind: "setValue", text: "base\n" });
  assert.ok(effect(r, "dropDraft"));
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.banner, null);
  assert.equal(effect(r, "toast"), undefined);
});

test("D20: restore drop: disk equals the draft: opens clean, draft dropped", () => {
  const r = restored("draft");
  assert.equal(isDirty(r.state), false);
  assert.equal(r.state.value, "draft");
  assert.equal(r.state.banner, null);
  assert.deepEqual(kinds(r), ["loaded", "dropDraft"]);
});

test("D20: restore conflict: conflict banner, and no expected until Keep My Edits or Overwrite", () => {
  const r = restored("somebody else\n");
  assert.equal(r.state.value, "draft");
  assert.equal(r.state.banner, "conflict");
  assert.equal(r.state.blocked, true);
  assert.equal(r.state.baseSig, signature("base\n"), "a draft written now keeps the conflict's base");
  const save = reduce(r.state, { type: "saveStart" });
  assert.equal(effect(save, "write"), undefined);
  assert.equal(effect(save, "toast").title, TEXT.changedSinceEdits);
  const own = reduce(r.state, { type: "diskRead", text: "somebody else\n" });
  assert.equal(own.state.banner, "conflict", "the disk matching what it read doesn't settle it");
  const kept = reduce(r.state, { type: "keepMine", text: "somebody else\n" });
  assert.equal(kept.state.blocked, false);
  assert.deepEqual(effect(reduce(kept.state, { type: "saveStart" }), "write"), { kind: "write", text: "draft", expected: "somebody else\n" });
  assert.deepEqual(effect(reduce(r.state, { type: "overwrite", text: "somebody else\n" }), "write"), { kind: "write", text: "draft", expected: "somebody else\n" });
  assert.equal(reduce(r.state, { type: "reload", text: "somebody else\n" }).state.blocked, false);
});

test("D20: restore deleted: edits back, marked deleted, save creates the file", () => {
  const r = restored(null);
  assert.equal(r.state.value, "draft");
  assert.equal(r.state.deleted, true);
  assert.equal(isDirty(r.state), true);
  assert.deepEqual(effect(reduce(r.state, { type: "saveStart" }), "write"), { kind: "write", text: "draft", expected: null });
});

test("D20: restore with an unreadable disk keeps the edits as a conflict", () => {
  const r = restored(undefined);
  assert.equal(r.state.value, "draft");
  assert.equal(r.state.banner, "conflict");
  assert.equal(r.state.blocked, true);
});

test("D20: Discard with the file gone: draft dropped, Unable to load file", () => {
  const r = reduce(restored(null).state, { type: "discard", text: null });
  assert.ok(effect(r, "dropDraft"));
  assert.equal(r.state.phase, "limit");
  assert.equal(r.state.limit.title, "Unable to load file");
});

// ── settle: the editor may say it holds other text ───────────────────────────

test("D22: the baseline is the editor's text at the last load", () => {
  const s = reduce(ready("a"), { type: "settled", value: "a\n" }).state;
  assert.equal(s.baseline, "a\n");
  assert.equal(s.value, "a\n");
  assert.equal(isDirty(s), false);
  const dirty = reduce(restored("base\n").state, { type: "settled", value: "draft" }).state;
  assert.equal(dirty.baseline, "base\n");
  assert.equal(isDirty(dirty), true);
});

test("a reload while a write runs: the late answer doesn't touch the new text", () => {
  const writing = reduce(conflicted(), { type: "overwrite", text: "theirs" }).state;
  const conflictAgain = reduce(writing, { type: "diskRead", text: "newer" }).state;
  const reloaded = reduce(conflictAgain, { type: "reload", text: "newer" }).state;
  const late = reduce(reloaded, { type: "saveOk" });
  assert.equal(late.state, reloaded);
  assert.deepEqual(late.effects, []);
  assert.equal(isDirty(late.state), false);
});

// ── Closing (D18) ────────────────────────────────────────────────────────────

test("D18: closing a clean file closes at once", () => {
  assert.deepEqual(kinds(reduce(ready(), { type: "askClose" })), ["close"]);
  assert.deepEqual(kinds(reduce(createDoc(), { type: "askClose" })), ["close"], "still loading");
});

test("S12: closing a dirty file puts up the card, which takes the keyboard", () => {
  const r = reduce(dirtyDoc(), { type: "askClose" });
  assert.equal(r.state.card, true);
  assert.deepEqual(kinds(r), ["focusCard"]);
  assert.equal(closeBody("a.js"), '"a.js" has unsaved changes. Do you want to save before closing?');
  assert.deepEqual(reduce(r.state, { type: "askClose" }).effects, [], "a second cmd-w changes nothing");
});

test("S12: Cancel takes the card away and gives the keyboard back to the editor", () => {
  const r = play(dirtyDoc(), { type: "askClose" }, { type: "cancelClose" });
  assert.equal(r.state.card, false);
  assert.equal(isDirty(r.state), true);
  assert.deepEqual(kinds(r), ["focusEditor"]);
});

test("D18: Save closes only after saveOk", () => {
  const asked = play(dirtyDoc(), { type: "askClose" }, { type: "saveAndClose" });
  assert.ok(effect(asked, "write"));
  assert.equal(effect(asked, "close"), undefined);
  const done = reduce(asked.state, { type: "saveOk" });
  assert.ok(effect(done, "close"));
  assert.equal(done.state.card, false);
});

test("D18: Save with a write already running waits for it and writes what's new, then closes", () => {
  const running = reduce(dirtyDoc("a"), { type: "saveStart" }).state;
  const typed = reduce(running, edit("ab")).state;
  const asked = play(typed, { type: "askClose" }, { type: "saveAndClose" });
  assert.deepEqual(asked.effects, []);
  const first = reduce(asked.state, { type: "saveOk" });
  assert.deepEqual(effect(first, "write"), { kind: "write", text: "ab", expected: "a" });
  assert.equal(effect(first, "close"), undefined);
  assert.ok(effect(reduce(first.state, { type: "saveOk" }), "close"));
});

test("D18: a failed Save takes the card away and leaves the banner, the keyboard back in the editor", () => {
  const asked = play(dirtyDoc(), { type: "askClose" }, { type: "saveAndClose" }).state;
  const failed = reduce(asked, { type: "saveRejected", text: "one\n" });
  assert.equal(failed.state.card, false);
  assert.equal(failed.state.closing, false);
  assert.equal(failed.state.banner, "failed");
  assert.equal(effect(failed, "close"), undefined);
  assert.ok(effect(failed, "focusEditor"));
  const conflict = reduce(asked, { type: "saveRejected", text: "theirs" });
  assert.equal(conflict.state.card, false);
  assert.equal(conflict.state.banner, "conflict");
  assert.equal(effect(conflict, "close"), undefined);
});

test("D18: Save under the conflict banner can't write: the card goes, the banner stays", () => {
  const conflict = reduce(dirtyDoc(), { type: "diskRead", text: "theirs" }).state;
  const r = play(conflict, { type: "askClose" }, { type: "saveAndClose" });
  assert.equal(r.state.card, false);
  assert.equal(r.state.banner, "conflict");
  assert.equal(effect(r, "write"), undefined);
  assert.equal(effect(r, "close"), undefined);
  assert.equal(effect(r, "toast").title, TEXT.changedSinceEdits);
});

test("D22: Save on the card never writes a read-only file, a restored draft's included", () => {
  const restoredDraft = reduce(reduce(createDoc(), { type: "access", readonly: true }).state, {
    type: "restore", meta: { path: "/a", baseSig: signature("base"), length: 5, at: 1 }, draftText: "draft", diskText: "base",
  }).state;
  const r = play(restoredDraft, { type: "askClose" }, { type: "saveAndClose" });
  assert.equal(effect(r, "write"), undefined);
  assert.equal(effect(r, "close"), undefined);
  assert.equal(r.state.card, false);
  assert.equal(effect(r, "toast").title, "Read-only");
  assert.equal(r.state.value, "draft");
});

test("D18: Don't Save asks main for its sequence: clear the drafts, then close", () => {
  const r = play(dirtyDoc(), { type: "askClose" }, { type: "dontSave" });
  assert.equal(r.state.card, false);
  assert.deepEqual(kinds(r), ["discardClose"]);
});

test("D18: where a close goes: the last pane closes the tab, else that pane, never `confirmed` nor a bare pane.close", () => {
  const spaces = [{ id: "s", active: true, tabs: [{ id: "t1", panes: 1, active: true }, { id: "t2", panes: 2, active: false }] }];
  const panes = [
    { pane: "p1", tab: "t1", mod: "code-file" },
    { pane: "p2", tab: "t2", terminal: "w1" },
    { pane: "p3", tab: "t2", mod: "code-file" },
  ];
  assert.deepEqual(closeAction("t1", spaces, panes), ["tab.close", { id: "t1" }]);
  assert.deepEqual(closeAction("t2", spaces, panes), ["pane.close", { pane: "p3" }]);
  assert.equal(closeAction("gone", spaces, panes), null);
  assert.equal(closeAction("t2", spaces, [{ pane: "p2", tab: "t2", terminal: "w1" }]), null, "never a pane.close that could end the terminal");
});

// ── Commands (D18) ───────────────────────────────────────────────────────────

test("D18: a copy ignores a doc that isn't its own, with or without the mod's prefix", () => {
  assert.equal(commandFor("ask-close-abc", "abc"), "close");
  assert.equal(commandFor("code-file.ask-close-abc", "abc"), "close");
  assert.equal(commandFor("ask-close-other", "abc"), null);
  assert.equal(commandFor("ask-close-", "abc"), null);
  assert.equal(commandFor("pin-abc", "abc"), "pin");
  assert.equal(commandFor("pin-other", "abc"), null);
  assert.equal(commandFor("code-file.save", "abc"), "save");
});

test("every banner and card button is a command", () => {
  for (const c of ["save", "close", "reload", "overwrite", "keep-mine", "discard", "retry", "cancel", "dont-save", "card-save", "edit", "focus"]) {
    assert.equal(commandFor(c, "abc"), c);
  }
  assert.equal(commandFor("nonsense", "abc"), null);
  assert.equal(commandFor("constructor", "abc"), null);
});

// ── Watch batches (D19, D22) ─────────────────────────────────────────────────

test("D19: a batch names the file by the folder's realpath plus the name; temporaries don't count", () => {
  const w = { dir: "/tmp/x", realDir: "/private/tmp/x", name: "a.js" };
  assert.equal(batchNamesFile(["/private/tmp/x/a.js"], w), true);
  assert.equal(batchNamesFile(["/tmp/x/a.js"], w), true);
  assert.equal(batchNamesFile(["/private/tmp/x/b.js"], w), false);
  assert.equal(batchNamesFile(["/private/tmp/x/.herdr-app-write-1234"], w), false);
  assert.equal(batchNamesFile(["/private/tmp/x/sub/a.js"], w), false);
  assert.equal(batchNamesFile([], w), false);
});

test("D22: a batch with the watch's root, or that isn't a list, means read everything", () => {
  const w = { dir: "/tmp/x", realDir: "/private/tmp/x", name: "a.js" };
  assert.equal(batchNamesFile(["/private/tmp/x"], w), true);
  assert.equal(batchNamesFile(["/tmp/x/"], w), true);
  assert.equal(batchNamesFile(null, w), true);
  assert.equal(batchNamesFile([5], w), false);
});

// ── Finding the tab (D10) ────────────────────────────────────────────────────

test("D10: a copy finds its tab by its doc in docs, only while that tab exists", () => {
  const spaces = [{ id: "s", active: true, tabs: [{ id: "t1", active: true }] }];
  assert.equal(tabOfDoc({ t1: { doc: "abc" } }, "abc", spaces), "t1");
  assert.equal(tabOfDoc({ t9: { doc: "abc" } }, "abc", spaces), null);
  assert.equal(tabOfDoc({}, "abc", spaces), null);
  assert.equal(tabOfDoc(null, "abc", spaces), null);
});

test("a tab nobody listed in docs: the active tab, when it holds a code-file pane", () => {
  const spaces = [
    { id: "other", active: false, tabs: [{ id: "x", active: true }] },
    { id: "s", active: true, tabs: [{ id: "t0", active: false }, { id: "t1", active: true }] },
  ];
  assert.equal(activeFileTab(spaces, [{ pane: "p", tab: "t1", mod: "code-file" }]), "t1");
  assert.equal(activeFileTab(spaces, [{ pane: "p", tab: "t1", terminal: "w" }]), null);
  assert.equal(activeFileTab([], []), null);
});

// ── What the header and the editor are told (D14) ────────────────────────────

test("D14: language: the same names as Herdr's files mod", () => {
  const lang = (p) => languageFor(p).language;
  for (const ext of ["ts", "tsx", "mts", "cts", "jsx", "mjs"]) assert.equal(lang(`/a/b.${ext}`), "js", ext);
  assert.equal(lang("/a/b.toml"), "yaml");
  assert.equal(lang("/a/b.yml"), "yaml");
  assert.equal(lang("/a/b.jsonc"), "json");
  assert.equal(lang("/a/b.svelte"), "html");
  assert.equal(lang("/a/b.vue"), "html");
  assert.equal(lang("/a/b.py"), "py");
  assert.equal(lang("/a/Makefile"), "txt");
  assert.equal(lang("/a/.env"), "txt");
  assert.equal(lang("/a/b.TS"), "js");
  assert.equal(lang("/a/b.constructor"), "constructor");
  assert.equal(lang("/a/b.__proto__"), "__proto__");
});

test("D14: over 256 KB opens as txt and the header says so", () => {
  const limit = 256 * 1024;
  assert.deepEqual([languageFor("/a/b.js", limit).language, languageFor("/a/b.js", limit).noColors], ["js", false]);
  assert.deepEqual([languageFor("/a/b.js", limit + 1).language, languageFor("/a/b.js", limit + 1).noColors], ["txt", true]);
  assert.equal(languageFor("/a/b.txt", limit + 1).noColors, false, "plain text loses no colors");
  assert.equal(TEXT.noColors, "Sin colores: archivo grande");
});

test("header: Language · UTF-8 · line ending", () => {
  assert.equal(fileMeta(ready("a\n"), "/a/b.js"), "JavaScript · UTF-8 · LF");
  assert.equal(fileMeta(ready("a\r\n"), "/a/b.json"), "JSON · UTF-8 · CRLF");
  assert.equal(fileMeta(ready("a\n"), "/a/README.md"), "Markdown · UTF-8 · LF");
  assert.equal(fileMeta(ready("a\n"), "/a/plain"), "Plain Text · UTF-8 · LF");
});

test("a keystroke that changes only the text doesn't redraw the window", () => {
  const dirty = dirtyDoc("a");
  assert.equal(needsRedraw(dirty, reduce(dirty, edit("ab")).state), false);
  assert.equal(needsRedraw(ready(), reduce(ready(), edit("a")).state), true, "the dirty flip does");
  assert.equal(needsRedraw(dirty, reduce(dirty, { type: "askClose" }).state), true);
});

test("S12: every string, exact", () => {
  assert.equal(TEXT.binary, "Binary file — cannot display");
  assert.equal(TEXT.unableToLoad, "Unable to load file");
  assert.equal(TEXT.retry, "Retry");
  assert.equal(TEXT.notUtf8Save, "This file isn't UTF-8 text, so it wasn't saved.");
  assert.equal(TEXT.changedSinceEdits, "This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.");
  assert.equal(TEXT.saveFailed, "Failed to save the file. Please try again.");
  assert.equal(TEXT.conflict, "This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.");
  assert.equal(TEXT.reloadFromDisk, "Reload from Disk");
  assert.equal(TEXT.reloaded, "Reloaded from disk");
  assert.equal(TEXT.overwrite, "Overwrite");
  assert.equal(TEXT.keepMine, "Keep My Edits");
  assert.equal(TEXT.keepMineTip, "Keeps your version. Your next save replaces the version on disk.");
  assert.equal(TEXT.closeTitle, "Unsaved Changes");
  assert.equal(TEXT.cancel, "Cancel");
  assert.equal(TEXT.dontSave, "Don't Save");
  assert.equal(TEXT.save, "Save");
});
