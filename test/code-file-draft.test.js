// Drafts (plan D20): a dirty buffer survives a reload, a crash, a silent close
// and a reopen. The store runs on an injected io: an in-memory one to hold a
// write open, and real files once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDraftStore, draftName, draftsDir, findDraft, hashPath, parseDraft, parseDraftName, resolveFile, restoreDraft, serializeDraft, signature,
} from "../code-editor/mods/code-file/draft-model.js";

const DIR = "/home/.config/herdr-app/code-editor/drafts";
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

// In-memory files; `hold` keeps writeFile open until released, as a stuck disk would.
function fakeIo(files = {}) {
  const io = {
    files: { ...files },
    log: [],
    held: [],
    hold: false,
    failNextWrite: false,
    badReads: new Set(),
    noDir: false,
    now: () => 1000,
    mkdir: async () => { io.log.push("mkdir"); io.noDir = false; },
    readdir: async () => {
      if (io.noDir) throw new Error("ENOENT");
      return Object.keys(io.files).map((p) => p.slice(p.lastIndexOf("/") + 1));
    },
    readFile: async (p) => {
      if (io.badReads.has(p.slice(p.lastIndexOf("/") + 1))) throw new Error("invalid utf-8");
      if (!(p in io.files)) throw new Error("ENOENT");
      return io.files[p];
    },
    writeFile: async (p, text) => {
      io.log.push(`write ${p.slice(p.lastIndexOf("/") + 1)}`);
      if (io.failNextWrite) { io.failNextWrite = false; throw new Error("disk full"); }
      if (io.hold) await new Promise((resolve) => io.held.push(resolve));
      io.files[p] = text;
    },
    unlink: async (p) => {
      io.log.push(`unlink ${p.slice(p.lastIndexOf("/") + 1)}`);
      delete io.files[p];
    },
  };
  return io;
}
const names = (io) => Object.keys(io.files).map((p) => p.slice(p.lastIndexOf("/") + 1)).sort();
const put = (io, name, text, baseSig = "sig", at = 1000) => { io.files[`${DIR}/${name}`] = serializeDraft({ path: "/a", baseSig, length: text.length, at }, text); };
const store = (io, over = {}) => createDraftStore(io, { dir: DIR, doc: "doc1", hash: "abc", path: "/a", ...over });

// ── Names and format ─────────────────────────────────────────────────────────

test("D20: drafts live under appHome()/code-editor/drafts, never under mods/", () => {
  assert.equal(draftsDir("/h/herdr-app"), "/h/herdr-app/code-editor/drafts");
  assert.equal(draftsDir("/h/herdr-app/"), "/h/herdr-app/code-editor/drafts");
});

test("D20: a draft's name is <hash>-<doc>-<seq>, and a doc may hold a dash", () => {
  assert.equal(draftName("abc", "doc1", 7), "abc-doc1-7");
  assert.deepEqual(parseDraftName("abc-doc1-7"), { name: "abc-doc1-7", hash: "abc", doc: "doc1", seq: 7 });
  assert.deepEqual(parseDraftName("abc-d-o-c-12"), { name: "abc-d-o-c-12", hash: "abc", doc: "d-o-c", seq: 12 });
  assert.equal(parseDraftName(".DS_Store"), null);
  assert.equal(parseDraftName("abc-doc1-x"), null);
});

test("D20: the path's hash is stable, and has no dash, so a name stays parseable", () => {
  assert.equal(hashPath("/private/tmp/a.js"), hashPath("/private/tmp/a.js"));
  assert.notEqual(hashPath("/private/tmp/a.js"), hashPath("/private/tmp/b.js"));
  assert.match(hashPath("/private/tmp/a.js"), /^[0-9a-f]+$/);
});

test("D20: baseSig is hashA-hashB-length of the text", () => {
  assert.match(signature("hello"), /^[0-9a-f]+-[0-9a-f]+-5$/);
  assert.equal(signature("hello"), signature("hello"));
  assert.notEqual(signature("hello"), signature("hellp"));
  assert.notEqual(signature("ab"), signature("ba"));
  assert.notEqual(signature("ā"), signature("Ā\u0001".slice(0, 1)));
});

test("D20: first line JSON, then the text; a body shorter than `length` is broken", () => {
  const raw = serializeDraft({ path: "/a b\nc", baseSig: "s", length: 7, at: 5 }, "l1\nl2\r\n");
  assert.equal(raw.split("\n")[0], JSON.stringify({ path: "/a b\nc", baseSig: "s", length: 7, at: 5 }));
  assert.deepEqual(parseDraft(raw), { meta: { path: "/a b\nc", baseSig: "s", length: 7, at: 5 }, text: "l1\nl2\r\n" });
  assert.equal(parseDraft(raw.slice(0, -1)), null);
  assert.equal(parseDraft("not json\nbody"), null);
  assert.equal(parseDraft("no newline at all"), null);
  assert.equal(parseDraft('{"path":"/a"}\nbody'), null);
  assert.equal(parseDraft('[1]\nbody'), null);
});

// ── restoreDraft: the four outcomes ──────────────────────────────────────────

const META = { path: "/a", baseSig: signature("base"), length: 5, at: 1 };

test("D20: restoreDraft resume: the disk matches baseSig", () => {
  assert.equal(restoreDraft(META, "draft", "base"), "resume");
});
test("D20: restoreDraft drop: the disk equals the draft", () => {
  assert.equal(restoreDraft(META, "draft", "draft"), "drop");
  assert.equal(restoreDraft(META, "base", "base"), "drop", "a draft equal to its base");
});
test("D20: restoreDraft conflict: the disk moved on", () => {
  assert.equal(restoreDraft(META, "draft", "someone else"), "conflict");
  assert.equal(restoreDraft({ ...META, baseSig: null }, "draft", "x"), "conflict");
  assert.equal(restoreDraft(META, "draft", undefined), "conflict", "a read that failed");
});
test("D20: restoreDraft deleted: the file is gone", () => {
  assert.equal(restoreDraft(META, "draft", null), "deleted");
});

// ── Finding a draft ──────────────────────────────────────────────────────────

test("D20: no drafts folder yet is no draft", async () => {
  const io = fakeIo();
  io.noDir = true;
  assert.deepEqual(await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" }), { draft: null, names: [], seq: 0 });
});

test("D20: the highest sequence whose body has its length wins; a truncated one is skipped", async () => {
  const io = fakeIo();
  put(io, "abc-doc1-1", "old");
  put(io, "abc-doc1-2", "newer");
  io.files[`${DIR}/abc-doc1-3`] = serializeDraft({ path: "/a", baseSig: "s", length: 99, at: 1 }, "cut");
  const found = await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" });
  assert.equal(found.draft.text, "newer");
  assert.equal(found.draft.doc, "doc1");
  assert.equal(found.seq, 3, "a new write goes above even a broken one");
  assert.deepEqual(found.names.sort(), ["abc-doc1-1", "abc-doc1-2", "abc-doc1-3"]);
});

test("D20: a rejected read counts as broken and goes on to the next", async () => {
  const io = fakeIo();
  put(io, "abc-doc1-1", "good");
  put(io, "abc-doc1-2", "unreadable");
  io.badReads.add("abc-doc1-2");
  assert.equal((await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" })).draft.text, "good");
});

test("D20: every draft broken: no draft, and the names so they get cleared", async () => {
  const io = fakeIo();
  io.files[`${DIR}/abc-doc1-1`] = "garbage";
  const found = await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" });
  assert.equal(found.draft, null);
  assert.deepEqual(found.names, ["abc-doc1-1"]);
});

test("D20: a restored tab finds by its doc first, with no hash at all (realpath failed on a missing file)", async () => {
  const io = fakeIo();
  put(io, "otherhash-doc1-4", "mine");
  const found = await findDraft(io, { dir: DIR, doc: "doc1", hash: null });
  assert.equal(found.draft.text, "mine");
});

test("D20: its own doc beats the path's hash", async () => {
  const io = fakeIo();
  put(io, "abc-gone-9", "someone's old", "s", 5000);
  put(io, "abc-doc1-1", "mine", "s", 1);
  assert.equal((await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" })).draft.text, "mine");
});

test("D20: a new doc is a reopen: finds the hash's newest draft, and owns all the names it supersedes", async () => {
  const io = fakeIo();
  put(io, "abc-gone-9", "older", "s", 100);
  put(io, "abc-gone2-1", "latest", "s", 200);
  put(io, "other-gone3-1", "another file", "s", 900);
  const found = await findDraft(io, { dir: DIR, doc: "new", hash: "abc" });
  assert.equal(found.draft.text, "latest");
  assert.equal(found.draft.doc, "gone2");
  assert.equal(found.seq, 0);
  assert.deepEqual(found.names.sort(), ["abc-gone-9", "abc-gone2-1"]);
});

test("D20: ignores a doc alive in another tab", async () => {
  const io = fakeIo();
  put(io, "abc-alive-1", "someone else's live draft");
  const found = await findDraft(io, { dir: DIR, doc: "new", hash: "abc", isLive: (doc) => doc === "alive" });
  assert.equal(found.draft, null);
  assert.deepEqual(found.names, []);
});

test("D20: realpath rejecting: the folder's realpath plus the name, else the path as given", async () => {
  const both = await resolveFile({ realpath: async (p) => `/private${p}` }, "/tmp/a.js");
  assert.deepEqual(both, { key: "/private/tmp/a.js", dir: "/tmp", realDir: "/private/tmp", name: "a.js" });
  const fileGone = await resolveFile({ realpath: async (p) => { if (p === "/tmp/a.js") throw new Error("no such file"); return `/private${p}`; } }, "/tmp/a.js");
  assert.deepEqual(fileGone, { key: "/private/tmp/a.js", dir: "/tmp", realDir: "/private/tmp", name: "a.js" });
  const nothing = await resolveFile({ realpath: async () => null }, "/tmp/a.js");
  assert.deepEqual(nothing, { key: "/tmp/a.js", dir: "/tmp", realDir: "/tmp", name: "a.js" });
});

// ── The queue ────────────────────────────────────────────────────────────────

test("D20: a write goes to a new sequence, and only after it lands are the old ones removed", async () => {
  const io = fakeIo();
  put(io, "abc-doc1-1", "first");
  const s = store(io, { seq: 1, names: ["abc-doc1-1"] });
  await s.write("second", "sig2");
  assert.deepEqual(names(io), ["abc-doc1-2"]);
  assert.deepEqual(io.log, ["mkdir", "write abc-doc1-2", "unlink abc-doc1-1"]);
  const { meta, text } = parseDraft(io.files[`${DIR}/abc-doc1-2`]);
  assert.equal(text, "second");
  assert.deepEqual(meta, { path: "/a", baseSig: "sig2", length: 6, at: 1000 });
});

test("D20: while one write runs, later ones collapse into the latest", async () => {
  const io = fakeIo();
  io.hold = true;
  const s = store(io);
  s.write("a", "x");
  await flush();
  s.write("ab", "x");
  s.write("abc", "x");
  await flush();
  assert.deepEqual(io.log.filter((l) => l.startsWith("write")), ["write abc-doc1-1"]);
  io.held.shift()();
  await flush();
  io.held.shift()();
  await flush();
  assert.deepEqual(names(io), ["abc-doc1-2"]);
  assert.equal(parseDraft(io.files[`${DIR}/abc-doc1-2`]).text, "abc");
});

test("D20: a draft never lands after its deletion: a write running plus Don't Save leaves no file", async () => {
  const io = fakeIo();
  io.hold = true;
  const s = store(io);
  s.write("typed", "x");
  await flush();
  s.write("typed more", "x");
  let cleared = false;
  s.clear().then(() => { cleared = true; });
  await flush();
  assert.equal(cleared, false, "the delete waits for the write that's running");
  assert.equal(io.log.filter((l) => l.startsWith("write")).length, 1, "the queued write is gone");
  io.held.shift()();
  await flush();
  assert.equal(cleared, true);
  assert.deepEqual(names(io), []);
});

test("D20: clear removes every file of its doc, those it didn't write too, and no other doc's", async () => {
  const io = fakeIo();
  put(io, "abc-doc1-1", "a");
  put(io, "zzz-doc1-2", "b");
  put(io, "abc-other-1", "c");
  await store(io).clear();
  assert.deepEqual(names(io), ["abc-other-1"]);
});

test("D20: clear removes the superseded names of a reopen too", async () => {
  const io = fakeIo();
  put(io, "abc-gone-9", "older");
  await store(io, { names: ["abc-gone-9"] }).clear();
  assert.deepEqual(names(io), []);
});

test("D20: after a reopen, the first write replaces the adopted draft", async () => {
  const io = fakeIo();
  put(io, "abc-gone-9", "older");
  await store(io, { names: ["abc-gone-9"] }).write("now mine", "x");
  assert.deepEqual(names(io), ["abc-doc1-1"]);
});

test("D20: a sequence always goes above what exists", async () => {
  const io = fakeIo();
  await store(io, { seq: 41 }).write("x", "s");
  assert.deepEqual(names(io), ["abc-doc1-42"]);
});

test("D20: a failed write doesn't stall the queue and keeps the old draft", async () => {
  const io = fakeIo();
  put(io, "abc-doc1-1", "first");
  const errors = [];
  const s = store(io, { seq: 1, names: ["abc-doc1-1"], onError: (e) => errors.push(String(e)) });
  io.failNextWrite = true;
  await s.write("lost", "x");
  assert.deepEqual(names(io), ["abc-doc1-1"]);
  assert.equal(errors.length, 1);
  await s.write("second", "x");
  assert.deepEqual(names(io), ["abc-doc1-3"]);
});

test("D20: a hung write plus close(): writeNow still writes, and recovery picks it", async () => {
  const io = fakeIo();
  io.hold = true;
  const s = store(io);
  s.write("older", "x");
  await flush();
  s.write("queued", "x");
  io.hold = false;
  await s.writeNow("last words", "x");
  assert.deepEqual(names(io), ["abc-doc1-2"]);
  const found = await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" });
  assert.equal(found.draft.text, "last words");
  assert.equal(found.seq, 2);
  // The hung write lands afterwards, under a lower sequence: recovery still picks the last words.
  io.held.shift()();
  await flush();
  assert.equal((await findDraft(io, { dir: DIR, doc: "doc1", hash: "abc" })).draft.text, "last words");
  assert.deepEqual(io.log.filter((l) => l.startsWith("write")), ["write abc-doc1-1", "write abc-doc1-2"], "the queued write never ran");
});

test("D20: clearNow skips the queue as well, and hasDrafts says whether there's anything to do", async () => {
  const io = fakeIo();
  const s = store(io);
  assert.equal(s.hasDrafts(), false);
  await s.write("x", "s");
  assert.equal(s.hasDrafts(), true);
  await s.clearNow();
  assert.deepEqual(names(io), []);
  assert.equal(s.hasDrafts(), false);
  assert.equal(store(fakeIo(), { names: ["abc-doc1-1"] }).hasDrafts(), true);
});

// ── Real files ───────────────────────────────────────────────────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), "code-file-draft-")));
after(() => rmSync(root, { recursive: true, force: true }));

const realIo = {
  now: () => Date.now(),
  mkdir: (d) => fsp.mkdir(d, { recursive: true }),
  readdir: (d) => fsp.readdir(d),
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, t) => fsp.writeFile(p, t),
  unlink: (p) => fsp.unlink(p),
};

test("D20: real files: over 1 MiB, unicode and CRLF round-trip, and clear leaves the folder empty", async () => {
  const dir = join(root, "home", "code-editor", "drafts");
  const s = createDraftStore(realIo, { dir, doc: "d1", hash: hashPath("/a"), path: "/a" });
  const text = `ñandú 🐙\r\n${"x".repeat(1_300_000)}\nend`;
  await s.write(text, signature("base"));
  const found = await findDraft(realIo, { dir, doc: "d1", hash: null });
  assert.equal(found.draft.text, text);
  assert.equal(found.draft.meta.baseSig, signature("base"));
  assert.equal(found.draft.meta.length, text.length);
  await s.clear();
  assert.deepEqual(readdirSync(dir), []);
});

test("D20: real files: a write cut in half on disk reads as broken, and the previous one is found", async () => {
  const dir = join(root, "cut");
  mkdirSync(dir);
  writeFileSync(join(dir, "abc-d1-1"), serializeDraft({ path: "/a", baseSig: "s", length: 4, at: 1 }, "good"));
  const whole = serializeDraft({ path: "/a", baseSig: "s", length: 8, at: 2 }, "éééééééé");
  writeFileSync(join(dir, "abc-d1-2"), Buffer.from(whole).subarray(0, Buffer.byteLength(whole) - 3));
  const found = await findDraft(realIo, { dir, doc: "d1", hash: "abc" });
  assert.equal(found.draft.text, "good");
  assert.equal(readFileSync(join(dir, "abc-d1-1"), "utf8").endsWith("good"), true);
});
