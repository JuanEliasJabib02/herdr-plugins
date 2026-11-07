// The editor: one file per tab, written and saved here, in a tab whose props are
// { doc, file, line? } (plan D10). What happens to the file is document-model.js's
// reducer; this file reads and writes the disk, runs the effects it answers with,
// and draws. Every banner and card button goes through act(), by its on_click and
// by a command of the same name, so what can't be clicked in a test can still be
// run (D2). A command reaches only the copy in the shown tab.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { appHome, exec, home, nextCommand, notify, panes, props, readTextFile, run, setShared, settings, shared, spaces, theme, watchFolder, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import {
  DOCS_KEY, LIVE_KEY, TEXT, activeFileTab, batchNamesFile, bannerView, closeAction, closeBody, commandFor, createDoc,
  fileMeta, holdsHome, isDirty, languageFor, needsRedraw, reduce, tabInfo, tabOfDoc, toDisk,
} from "./document-model.js";
import { createDraftStore, draftsDir, findDraft, hashPath, resolveFile } from "./draft-model.js";
import { SYNTAX, colorOf, lineIndex, splitLines, tokenizeLine } from "./line-view-model.js";
import { BLAME_TEXT, blameArgs, blameDir, blameFailure, blameLabel, blameTarget, isBlameCommand, parseBlame } from "./blame-model.js";

const DRAFT_DELAY = 300; // after the last keystroke
const GONE_WAIT = 250; // a file missing this long is gone, not mid-replace (D22)
const POLL = 10000; // when watchFolder rejects or would take the whole home, as Herdr's `files` mod
const FOCUS_DELAY = 50; // the frame that draws what takes the keyboard goes first
const HIDDEN_POLL = 150; // a hidden copy never renders, so only a timer sees its tab leave
const CLEAR_WAIT = 1000; // Don't Save doesn't sit behind a stuck draft write
const DISCARD_WAIT = 1500; // close() had time to run: the tab survived

// The design's banner, like D5's syntax colors one of the few fixed colors here.
const BANNER_BG = "#38342a";
const BANNER_TEXT = "#e5c07b";
const CARD_DIM = "#00000073";
const LINE_LIST = "code-file-lines";
const ROW_HEIGHT = 20;
const BLAME_WIDTH = 210; // an author's name, truncated, and a date

const realpath = async (path) => {
  const r = await exec("/bin/realpath", [path]);
  return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
};

// Drafts and Blame's copy are the buffer's plain text, which a 0600 file keeps from
// other users, and Herdr's mkdir takes no `mode` (MakeDirectoryOptions in
// gpui-kit.d.ts). Once per folder: close() shares 250 ms on quit (D20) and shouldn't
// wait on a process at every draft. A failure loses no draft: the next one tries again.
const privateDirs = new Set();

const privateDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
  if (privateDirs.has(dir)) return;
  try {
    const r = await exec("/bin/chmod", ["700", dir]);
    if (r.code === 0) privateDirs.add(dir);
    else console.log(`code-file: chmod ${dir}: ${r.stderr}`);
  } catch (e) {
    console.log(`code-file: chmod ${dir}: ${e}`);
  }
};

const IO = {
  mkdir: privateDir,
  readdir: (dir) => fs.readdir(dir),
  readFile: (path) => fs.readFile(path, "utf8"),
  writeFile: (path, text) => fs.writeFile(path, text),
  unlink: (path) => fs.unlink(path),
  realpath,
  now: () => Date.now(),
};

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

export default class CodeFile extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = typeof p.file === "string" && p.file !== "" ? p.file : null;
    // `herdr-app check` runs init with empty props (D18): nothing to touch.
    if (!this.file) return;
    this.doc = typeof p.doc === "string" && p.doc !== "" ? p.doc : `f${hashPath(this.file)}`;
    this.line = Number.isInteger(p.line) && p.line >= 1 ? p.line : null;
    this.mode = this.line ? "lines" : "editor"; // D16, or "blame" (D12)
    this.blameFrom = null; // the mode Blame came from, for a failure to go back to
    this.blameText = null; // the text the column is of
    this.blameLines = null; // parseBlame's; null while git answers
    this.blaming = false;
    const live = shared(LIVE_KEY);
    this.model = createDoc({ pinned: Boolean(live && Object.hasOwn(live, this.doc) && live[this.doc]?.pinned) });
    this.editor = null;
    this.noColors = false;
    this.store = null;
    this.where = null;
    this.discard = false; // Don't Save ran: close() writes no draft
    this.shownTab = null;
    this.handle = cx.focus_handle();
    this.cardHandle = cx.focus_handle();
    this.scroll = this.line ? VirtualListScrollHandle.new() : null;
    this.wasVisible = this.isVisible();
    cx.timer.every(HIDDEN_POLL, () => {
      if (!this.isVisible()) this.wasVisible = false;
    });
    this.pruneLive();
    this.listen(cx);
    this.open(cx);
  }

  // ── Where this copy is ─────────────────────────────────────────────────────

  tabId() {
    return tabOfDoc(shared(DOCS_KEY), this.doc, spaces()) ?? this.shownTab;
  }

  // Not knowing counts as on screen: a banner never moves anyone's page.
  isVisible() {
    const id = this.tabId();
    if (!id) return true;
    return Boolean(spaces().find((s) => s.active)?.tabs.some((t) => t.id === id && t.active));
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  open(cx) {
    cx.spawn(async (cx) => {
      this.where = await resolveFile(IO, this.file);
      const hash = hashPath(this.where.key);
      const dir = draftsDir(appHome());
      const isLive = (doc) => tabOfDoc(shared(DOCS_KEY), doc, spaces()) !== null;
      const found = await findDraft(IO, { dir, doc: this.doc, hash, isLive });
      this.store = createDraftStore(IO, {
        dir,
        doc: this.doc,
        hash,
        path: this.where.key,
        seq: found.seq,
        names: found.names,
        unread: found.unread,
        onError: (e) => console.log(`code-file: draft: ${e}`),
      });
      const read = await this.readDisk();
      await this.checkAccess(read, cx);
      if (found.draft) {
        const diskText = read.error !== undefined ? undefined : read.text;
        this.send({ type: "restore", meta: found.draft.meta, draftText: found.draft.text, diskText }, cx);
        // Found through a closed tab's doc: its next write goes under this one.
        if (found.draft.doc !== this.doc && isDirty(this.model)) this.scheduleDraft(cx);
      } else {
        this.send({ type: "diskRead", ...read }, cx);
        // Nothing whole among them.
        if (found.names.length > 0) cx.spawn(() => this.store.clear());
      }
      this.watch(cx);
    });
  }

  async readDisk() {
    try {
      return { text: await readTextFile(this.file) };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  // writeTextFile replaces even a 0444 file (D22), so the editor is what respects it.
  async checkAccess(read, cx) {
    if (typeof read.text !== "string") return;
    try {
      const r = await exec("/bin/sh", ["-c", 'test -w "$1"', "sh", this.file]);
      this.step({ type: "access", readonly: r.code !== 0 }, cx);
    } catch {
      // Can't tell: a save reports its own failure.
    }
  }

  // ── The disk changing ──────────────────────────────────────────────────────

  watch(cx) {
    // AGENTS.md: watch what you show, not a whole home folder. The timer of D22 covers it.
    if (holdsHome(this.where.dir, home()) || holdsHome(this.where.realDir, home())) {
      cx.timer.every(POLL, (cx) => this.rereadDisk(cx));
      return;
    }
    cx.spawn(async (cx) => {
      for (;;) {
        let batch;
        try {
          batch = await watchFolder(this.where.dir);
        } catch {
          cx.timer.every(POLL, (cx) => this.rereadDisk(cx));
          return;
        }
        if (batchNamesFile(batch, this.where)) this.rereadDisk(cx);
      }
    });
  }

  // One read at a time; what's asked meanwhile runs once more behind it.
  rereadDisk(cx) {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.readAgain = false;
          const gen = this.model.gen;
          let read = await this.readDisk();
          if (read.text === null && this.model.phase === "ready") {
            await cx.sleep(GONE_WAIT);
            read = await this.readDisk();
          }
          if (this.model.phase !== "ready") await this.checkAccess(read, cx);
          // The read-only views have no cursor to lose, so they're never "being read" (D15, D16).
          const visible = this.mode === "editor" ? this.isVisible() : false;
          this.send({ type: "diskRead", ...read, gen, visible }, cx);
        } while (this.readAgain);
      } finally {
        this.reading = false;
      }
    });
  }

  // ── The reducer ────────────────────────────────────────────────────────────

  // The editor's text first, in case its change event hasn't come: everything is
  // decided against what's on screen now (D22).
  send(event, cx) {
    this.syncEditor(cx);
    this.step(event, cx);
  }

  syncEditor(cx) {
    if (!this.editor) return;
    const value = this.editor.value();
    if (value !== this.model.value) this.step({ type: "edit", value }, cx);
  }

  step(event, cx) {
    const before = this.model;
    const { state, effects } = reduce(before, event);
    this.model = state;
    this.publish();
    for (const effect of effects) this.apply(effect, cx);
    // The column says nothing about text it wasn't asked about.
    if (this.mode === "blame" && this.model.phase === "ready" && this.model.value !== this.blameText) this.runBlame(cx);
    if (needsRedraw(before, this.model)) cx.notify();
  }

  apply(effect, cx) {
    switch (effect.kind) {
      case "write":
        return this.runWrite(effect, cx);
      case "setValue":
        return this.setEditorValue(effect.text, cx);
      case "loaded":
        return this.onLoaded(cx);
      case "scheduleDraft":
        return this.scheduleDraft(cx);
      case "dropDraft":
        return this.dropDraft(cx);
      case "reread":
        return this.rereadDisk(cx);
      case "toast":
        notify({ title: effect.title, body: baseName(this.file), level: effect.level });
        return undefined;
      case "close":
        return this.closeTab();
      case "discardClose":
        return this.discardAndClose(cx);
      case "focusCard":
      case "focusEditor":
        return this.scheduleFocus(cx);
      default:
        return undefined;
    }
  }

  // Only when it changes: setShared redraws every mod (D10).
  publish() {
    const dirty = isDirty(this.model);
    const { pinned } = this.model;
    const live = shared(LIVE_KEY) ?? {};
    const now = Object.hasOwn(live, this.doc) ? live[this.doc] : null;
    if (now ? now.dirty === dirty && now.pinned === pinned : !dirty && !pinned) return;
    setShared(LIVE_KEY, { ...live, [this.doc]: { dirty, pinned } });
  }

  // D10: entries of tabs that are gone go when the next file opens. An entry can't
  // go at close(), which also runs on quit, when `pinned` has to survive. With no
  // spaces yet, nothing can be told.
  pruneLive() {
    const live = shared(LIVE_KEY);
    const all = spaces();
    if (!live || all.length === 0) return;
    const docs = shared(DOCS_KEY);
    const kept = Object.entries(live).filter(([doc]) => doc === this.doc || tabOfDoc(docs, doc, all) !== null);
    if (kept.length !== Object.keys(live).length) setShared(LIVE_KEY, Object.fromEntries(kept));
  }

  // ── The editor ─────────────────────────────────────────────────────────────

  onLoaded(cx) {
    if (this.mode === "lines" && isDirty(this.model)) this.mode = "editor";
    if (this.mode === "editor") {
      this.showEditor(cx);
    } else {
      // An editor waiting behind Blame must not keep the old text: it would pass for an edit.
      this.setEditorValue(this.model.value, cx);
      this.scrollToLine(cx);
    }
    this.scheduleFocus(cx);
  }

  // Once more after the first frame: the list doesn't exist until then. Only a tab
  // opened at a line has a handle: Blame can get here from one opened without.
  scrollToLine(cx) {
    if (!this.scroll) return;
    const go = () => this.scroll.scroll_to_item(lineIndex(this.line, this.rows().length), "center");
    go();
    cx.timer.after(FOCUS_DELAY, go);
  }

  showEditor(cx) {
    if (this.editor) {
      this.setEditorValue(this.model.value, cx);
      return;
    }
    const { language, noColors } = languageFor(this.file, this.model.value.length);
    this.noColors = noColors;
    const editor = EditorState.new({
      language,
      value: this.model.value,
      readonly: this.model.readonly,
      font_family: settings().font_family,
      font_size: 13,
      syntax: SYNTAX,
    });
    editor.on("change", (_event, cx) => {
      if (!this.applying) this.step({ type: "edit", value: editor.value() }, cx);
    });
    this.editor = editor;
    this.step({ type: "settled", value: editor.value() }, cx);
  }

  // A reload is not an edit, whether set_value fires change or not (D22).
  setEditorValue(text, cx) {
    if (!this.editor) return;
    this.applying = true;
    try {
      this.editor.set_value(text);
    } finally {
      this.applying = false;
    }
    this.step({ type: "settled", value: this.editor.value() }, cx);
  }

  // D16's Editar. The editor opens at the top: the header keeps "Línea N". One that
  // was waiting behind Blame keeps its cursor, which set_value would lose (D15).
  startEditing(cx) {
    if (this.mode === "editor" || this.model.phase !== "ready") return;
    this.mode = "editor";
    if (!this.editor) this.showEditor(cx);
    this.scheduleFocus(cx);
    cx.notify();
  }

  // ── Blame (S7, D12) ────────────────────────────────────────────────────────

  showBlame(cx) {
    if (this.mode === "blame" || this.model.phase !== "ready") return;
    this.syncEditor(cx);
    this.blameFrom = this.mode;
    this.mode = "blame";
    this.scrollToLine(cx);
    // The editor leaves the screen and takes the keyboard with it: cmd-w would fall
    // through to `global` and close the tab without asking (D18).
    this.scheduleFocus(cx);
    this.runBlame(cx);
  }

  // One run at a time, since the copy of the buffer has one name per tab. Text that
  // moved during a run runs again behind it, and only the last answer counts.
  runBlame(cx) {
    this.blameText = this.model.value;
    this.blameLines = null;
    cx.notify();
    if (this.blaming) return;
    this.blaming = true;
    cx.spawn(async (cx) => {
      try {
        let asked;
        let answer;
        do {
          asked = this.blameText;
          answer = await this.askGit(toDisk(this.model, asked));
        } while (this.blameText !== asked);
        if (this.mode === "blame") this.takeBlame(answer, cx);
      } finally {
        this.blaming = false;
      }
    });
  }

  blameCopy() {
    return `${blameDir(appHome())}/${this.doc}`;
  }

  // Herdr's exec has no stdin, and an argument couldn't hold 1 MiB.
  async askGit(text) {
    const copy = this.blameCopy();
    const { cwd, name } = blameTarget(this.where.key);
    try {
      await IO.mkdir(blameDir(appHome()));
      await IO.writeFile(copy, text);
      return await exec("git", blameArgs(name, copy), { cwd });
    } catch (e) {
      return { code: -1, stdout: "", stderr: String(e?.message ?? e) };
    } finally {
      await IO.unlink(copy).catch(() => {});
    }
  }

  // An error with lines is output cut short, and those lines still hold.
  takeBlame(answer, cx) {
    const lines = parseBlame(answer.stdout);
    if (answer.code !== 0 && lines.length === 0) {
      notify({ title: BLAME_TEXT.failed, body: blameFailure(answer), level: "error" });
      this.mode = this.blameFrom;
      this.scheduleFocus(cx);
    } else {
      this.blameLines = lines;
    }
    cx.notify();
  }

  scheduleFocus(cx) {
    this.focusTimer?.cancel();
    this.focusTimer = cx.timer.after(FOCUS_DELAY, () => {
      this.focusTimer = null;
      this.focusNow();
    });
  }

  // D17: the wrapper, then the next tab stop, which is the editor. Never in render.
  focusNow() {
    if (!this.isVisible()) return;
    if (this.model.card) {
      this.cardHandle.focus();
      return;
    }
    this.handle.focus();
    if (this.editor && this.mode === "editor" && this.model.phase === "ready") window.focus_next();
  }

  // What render notices but mustn't act on: a tab coming back wants the keyboard,
  // or cmd-w would fall through to `global` and close it without asking; and a
  // preview with a pane beside it stays pinned (D18).
  followWindow(cx) {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.scheduleFocus(cx);
    this.wasVisible = visible;
    if (this.model.pinned || this.pinning) return;
    const id = this.tabId();
    if (id && tabInfo(id, spaces())?.panes > 1) {
      this.pinning = true;
      cx.timer.after(0, (cx) => {
        this.pinning = false;
        this.send({ type: "pin" }, cx);
      });
    }
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  // Any failure reads the disk again: the reducer decides by the text it finds,
  // never by the message (D22).
  runWrite({ text, expected }, cx) {
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.file, text, expected);
      } catch (e) {
        const read = await this.readDisk();
        this.send({ type: "saveRejected", ...read, message: String(e?.message ?? e) }, cx);
        return;
      }
      this.send({ type: "saveOk" }, cx);
    });
  }

  // ── Drafts (D20) ───────────────────────────────────────────────────────────

  scheduleDraft(cx) {
    this.draftTimer?.cancel();
    this.draftTimer = cx.timer.after(DRAFT_DELAY, (cx) => {
      this.draftTimer = null;
      this.flushDraft(cx);
    });
  }

  flushDraft(cx) {
    if (!this.store || this.discard || !isDirty(this.model)) return;
    const text = this.editor?.value() ?? this.model.value;
    const { baseSig } = this.model;
    cx.spawn(() => this.store.write(text, baseSig));
  }

  dropDraft(cx) {
    this.draftTimer?.cancel();
    this.draftTimer = null;
    if (this.store?.hasDrafts()) cx.spawn(() => this.store.clear());
  }

  // ── Closing (D18) ──────────────────────────────────────────────────────────

  closeTab() {
    const id = this.tabId();
    const action = id ? closeAction(id, spaces(), panes()) : null;
    if (!action) {
      notify({ title: TEXT.noTab, body: baseName(this.file), level: "error" });
      return;
    }
    // A tab that outlives its file stops carrying its name: called by its number again.
    if (action[0] === "pane.close") run("tab.rename", { id, name: "" });
    run(action[0], action[1]);
  }

  // The draft goes with the copy still alive, since a closing copy's tasks get cut.
  // Herdr asks before closing a space's last tab: if that tab survives, the timer
  // takes `discard` off and the buffer gets a draft again.
  discardAndClose(cx) {
    this.discard = true;
    this.draftTimer?.cancel();
    this.draftTimer = null;
    cx.spawn(async (cx) => {
      await new Promise((resolve) => {
        this.store.clear().then(resolve, resolve);
        cx.timer.after(CLEAR_WAIT, () => resolve());
      });
      this.closeTab();
      cx.timer.after(DISCARD_WAIT, (cx) => {
        this.discard = false;
        if (isDirty(this.model)) this.scheduleDraft(cx);
      });
    });
  }

  // Herdr's last call. It can't wait for work already started, so a dirty buffer
  // goes straight to its next sequence. No `cx`: nothing here redraws. Only a copy
  // that finished loading has decided about its drafts: a loading one hasn't brought
  // them back yet, and a limit view holds none it means to end, so both leave them.
  async close() {
    if (!this.file) return;
    const ready = this.model.phase === "ready";
    const value = this.editor ? this.editor.value() : this.model.value;
    const dirty = ready && value !== this.model.baseline;
    let work = null;
    if (this.store && !this.discard) {
      if (dirty) work = this.store.writeNow(value, this.model.baseSig);
      else if (ready && this.store.hasDrafts()) work = this.store.clearNow();
    }
    // A closing copy's tasks get cut, and that one would have taken its copy of the text.
    const copy = this.blaming ? IO.unlink(this.blameCopy()).catch(() => {}) : null;
    this.editor?.release();
    this.scroll?.release();
    try {
      await work;
    } catch (e) {
      console.log(`code-file: draft at close: ${e}`);
    }
    await copy;
  }

  // ── Commands and buttons ───────────────────────────────────────────────────

  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const raw = await nextCommand();
        const command = isBlameCommand(raw) ? "blame" : commandFor(raw, this.doc);
        if (!command) continue;
        // One bad command must not take cmd-s with it.
        try {
          this.act(command, cx);
        } catch (e) {
          console.log(`code-file: ${command}: ${e}`);
        }
      }
    });
  }

  // The one path of every command and every button (D2).
  act(name, cx) {
    // Both only reach the copy in the shown tab: that's ours, if docs doesn't say.
    this.shownTab = activeFileTab(spaces(), panes()) ?? this.shownTab;
    switch (name) {
      case "save":
        return this.send({ type: this.model.card ? "saveAndClose" : "saveStart" }, cx);
      case "card-save":
        return this.send({ type: "saveAndClose" }, cx);
      case "close":
        return this.send({ type: "askClose" }, cx);
      case "cancel":
        return this.send({ type: "cancelClose" }, cx);
      case "dont-save":
        return this.send({ type: "dontSave" }, cx);
      case "retry":
        return this.send({ type: "retry" }, cx);
      case "pin":
        return this.send({ type: "pin" }, cx);
      case "reload":
      case "overwrite":
      case "discard":
        return this.withDisk(name, cx);
      case "keep-mine":
        return this.withDisk("keepMine", cx);
      case "edit":
        return this.startEditing(cx);
      case "blame":
        return this.showBlame(cx);
      case "focus":
        return this.focusNow();
      default:
        return undefined;
    }
  }

  // S12's buttons act on what's on disk now, not on what the banner saw.
  withDisk(type, cx) {
    cx.spawn(async (cx) => {
      const read = await this.readDisk();
      this.send({ type, ...read }, cx);
    });
  }

  cardKey(event, cx) {
    // Esc is Cancel, and there's no Enter: closing must be a choice (D18).
    if (event.key !== "escape") return;
    cx.stop_propagation();
    this.act("cancel", cx);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  rows() {
    if (this.rowsFor !== this.model.value) {
      this.rowsFor = this.model.value;
      this.rowsCache = splitLines(this.model.value);
    }
    return this.rowsCache;
  }

  button(t, id, label, action, tip) {
    return h_flex().id(id).flex_none().h(26).px(10).items_center().rounded(6).border_1().border_color(t.input)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => this.act(action, cx))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(label);
  }

  header(t) {
    const m = this.model;
    const mono = settings().font_family;
    const shown = this.file.startsWith(`${home()}/`) ? `~${this.file.slice(home().length)}` : this.file;
    const notes = [
      this.line ? `Línea ${this.line}` : null,
      m.deleted ? TEXT.deleted : null,
      m.readonly ? TEXT.readOnly : null,
      this.mode === "editor" && this.noColors ? TEXT.noColors : null,
      this.mode === "blame" && m.phase === "ready" && !this.blameLines ? BLAME_TEXT.running : null,
    ].filter(Boolean);
    return h_flex().id("file-header").h(30).flex_none().pl(12).pr(8).gap(10).items_center().border_b_1().border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).when(Boolean(mono), (el) => el.font_family(mono)).child(shown))
      .children(notes.map((note) => div().flex_none().text_color(t.dim).child(note)))
      .when(m.phase === "ready", (el) => el.child(div().flex_none().text_color(t.dim).child(fileMeta(m, this.file))))
      .when(this.mode !== "blame" && m.phase === "ready", (el) => el.child(this.button(t, "header-blame", BLAME_TEXT.button, "blame")))
      .when(this.mode !== "editor" && m.phase === "ready", (el) => el.child(this.button(t, "header-edit", TEXT.edit, "edit")));
  }

  banner(view, t) {
    return h_flex().id("banner").flex_wrap().flex_none().px(12).py(8).gap(10).items_center().bg(BANNER_BG).border_b_1().border_color(t.border).text_size(12.5)
      .child(div().flex_1().min_w(200).text_color(BANNER_TEXT).child(view.text))
      .children(view.buttons.map((b) => this.button(t, `banner-${b.id}`, b.label, b.id, b.tip)));
  }

  // `entry` is parseBlame's, undefined when git hasn't said.
  blameCell(entry, t) {
    const label = blameLabel(entry);
    return h_flex().flex_none().w(BLAME_WIDTH).h_full().pl(12).pr(12).gap(10).items_center().border_r_1().border_color(t.border).text_size(12).text_color(t.dim)
      .when(Boolean(label), (el) => el.child(div().flex_1().min_w(0).truncate().when(!label.date, (name) => name.italic()).child(label.author)))
      .when(Boolean(label?.date), (el) => el.child(div().flex_none().child(label.date)));
  }

  lineRow(text, index, marked, language, mono, t, cell) {
    return h_flex().h(ROW_HEIGHT).w_full().flex_none().items_center().text_size(13).whitespace_nowrap()
      .when(Boolean(mono), (el) => el.font_family(mono))
      .when(marked, (el) => el.bg(t.hover))
      .when(Boolean(cell), (el) => el.child(cell))
      .child(div().flex_none().w(60).pr(20).text_right().text_color(marked ? t.foreground : t.dim).child(String(index + 1)))
      .children(tokenizeLine(text, language).map((token) => {
        const color = colorOf(token.kind);
        return div().flex_none().when(Boolean(color), (el) => el.text_color(color)).when(token.kind === "comment", (el) => el.italic()).child(token.text);
      }));
  }

  lineList(t) {
    const rows = this.rows();
    const marked = this.line ? lineIndex(this.line, rows.length) : -1;
    const { language } = languageFor(this.file);
    const mono = settings().font_family;
    const blame = this.mode === "blame" ? this.blameLines ?? [] : null;
    // Not uniform_list, which ignores track_scroll and so could never reach the line.
    const list = v_virtual_list(LINE_LIST, rows.length, ROW_HEIGHT, (index) => String(index), (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(this.lineRow(rows[i], i, i === marked, language, mono, t, blame ? this.blameCell(blame[i], t) : null));
      return out;
    });
    // Without a handle it still scrolls, and its Scrollbar still drives it.
    return (this.scroll ? list.track_scroll(this.scroll) : list).flex_1().min_h(0);
  }

  body(t) {
    const m = this.model;
    const wrap = div().id("file-body").track_focus(this.handle).flex_1().min_h(0).flex().flex_col();
    if (m.phase === "limit") {
      return wrap.items_center().justify_center().gap(8).p(24)
        .child(div().text_color(t.foreground).child(m.limit.title))
        .when(Boolean(m.limit.message), (el) => el.child(div().text_size(12).text_color(t.dim).child(m.limit.message)))
        .when(m.limit.retry, (el) => el.child(this.button(t, "limit-retry", TEXT.retry, "retry")));
    }
    if (m.phase !== "ready") return wrap.p(12).text_color(t.dim).child("Loading");
    if (this.mode !== "editor") return wrap.relative().child(this.lineList(t)).child(Scrollbar.vertical(LINE_LIST).absolute().inset_0());
    return wrap.child(this.editor ? Editor.new(this.editor).flex_1().min_h(0) : div());
  }

  // In the tab itself, not an overlay: a copy in an overlay would get orders too,
  // and `confirm` only has two buttons (D18).
  card(t) {
    const cardButton = (id, label, action, solid) => this.button(t, id, label, action).h(30).px(14).rounded(7).when(solid, (el) => el.bg(t.raised).font_medium());
    const card = v_flex().id("close-card").track_focus(this.cardHandle).on_key_down((event, cx) => this.cardKey(event, cx))
      .w(440).max_w_full().p(20).rounded(10).border_1().border_color(t.border).bg(t.popover).text_size(13)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(TEXT.closeTitle))
      .child(div().mt(8).text_color(t.foreground).child(closeBody(baseName(this.file))))
      .child(h_flex().mt(18).gap(8).flex_wrap().justify_end()
        .child(cardButton("card-cancel", TEXT.cancel, "cancel", false))
        .child(cardButton("card-dont-save", TEXT.dontSave, "dont-save", false))
        .child(cardButton("card-save", TEXT.save, "card-save", true)));
    return div().id("close-dim").absolute().inset_0().flex().items_center().justify_center().p(24).bg(CARD_DIM)
      .on_mouse_down("left", (_event, cx) => {
        // Nothing under it takes the press, and the keyboard stays on the card.
        cx.stop_propagation();
        this.cardHandle.focus();
      })
      .child(card);
  }

  render(cx) {
    const t = theme();
    const root = div().id("code-file").relative().flex().flex_col().size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13);
    if (!this.file) return root.items_center().justify_center().child(div().text_color(t.dim).child("No file"));
    this.followWindow(cx);
    const banner = bannerView(this.model);
    return root
      .child(this.header(t))
      .when(Boolean(banner), (el) => el.child(this.banner(banner, t)))
      .child(this.body(t))
      .when(this.model.card, (el) => el.child(this.card(t)));
  }
}
