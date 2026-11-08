// Opening a file as the Explorer opens one (plan lector-md D8), for a link in the
// Markdown preview. Herdr refuses a module outside the mod's folder ("resolves
// outside the application directory"), so this is a copy of the opening half of
// code-explorer/tree-model.js (L2): same tables, same steps, same shared keys, held
// to the original by test/code-file-markdown.test.js, which runs both. Only the
// rename case (`moved`) is left out: a link never renames anything. Change one,
// change the other. No herdr or gpui-kit imports.

import { DOCS_KEY, LIVE_KEY } from "./document-model.js";

export { DOCS_KEY, LIVE_KEY };

export const FILE_MOD = "code-file";
const OPEN_POLL = 10, OPEN_TIMEOUT = 1000;

// `shared` persists: what comes back may be anything an older build or a broken
// file left, and an inherited name must not read as an entry.
export const table = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const entryOf = (docs, id) => {
  const entry = Object.hasOwn(docs, id) ? docs[id] : null;
  return entry && typeof entry === "object" && typeof entry.file === "string" ? entry : null;
};

// Letters and digits only: it goes in a draft's file name and a mod command.
export const newDoc = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, "0");

// Replaceable is a preview with no changes that code-file hasn't pinned, alone in
// its tab: a terminal beside it would go with it.
function replaceable(tab, entry, live) {
  if (!entry?.preview || tab.panes > 1) return false;
  const state = table(live)[entry.doc];
  return !state?.dirty && !state?.pinned;
}

// A tab that can go for a copy of the same file, at a line: props can't change, and
// nothing is lost with no changes and nothing beside it.
function reopenable(tab, entry, live) {
  return Boolean(entry) && tab.panes <= 1 && !table(live)[entry.doc]?.dirty;
}

const GOES = { replace: replaceable, reopen: reopenable };

// The decision, for the tabs of one space: { kind: "select", id, pin }, select what's
// open and maybe pin it; { kind: "replace", id }, a new tab in that preview's place;
// { kind: "reopen", id }, the same for a copy of this file, to show `line`;
// or { kind: "new" }. Opening pinned leaves a preview where it is.
export function planOpen({ file, pin, tabs, docs, live, panes, line = null }) {
  const known = table(docs);
  // An entry alone isn't enough: closing a file with a terminal beside it leaves the
  // tab and the entry, and that tab no longer holds the file.
  const entryHere = (tab) => (panes.some((p) => p.tab === tab.id && p.mod === FILE_MOD) ? entryOf(known, tab.id) : null);
  for (const tab of tabs) {
    const entry = entryHere(tab);
    if (entry?.file !== file) continue;
    return line && reopenable(tab, entry, live) ? { kind: "reopen", id: tab.id } : { kind: "select", id: tab.id, pin: Boolean(pin && entry.preview) };
  }
  if (!pin) for (const tab of tabs) if (replaceable(tab, entryHere(tab), live)) return { kind: "replace", id: tab.id };
  return { kind: "new" };
}

// The tab tab.new made. A tab Claude opened at the same moment is also new, so
// only one holding a code-file pane counts.
export function findNewTab(before, space, panes) {
  for (const tab of space?.tabs ?? []) {
    if (!before.has(tab.id) && panes.some((p) => p.tab === tab.id && p.mod === FILE_MOD)) return tab.id;
  }
  return null;
}

// The one way to close a file's tab. Never `confirmed: true`, which on the last
// tab closes the space without asking; pane.close always names its pane, since
// without one it can end the focused terminal.
export function closeCommand(tab, panes) {
  if (tab.panes <= 1) return ["tab.close", { id: tab.id }];
  const pane = panes.find((p) => p.tab === tab.id && p.mod === FILE_MOD);
  return pane ? ["pane.close", { pane: pane.pane }] : null;
}

// The next code-editor.docs: this entry in; tabs that no longer exist out, and
// anything that isn't an entry, so a broken value heals on the next open.
export function nextDocs(docs, tabIds, id, entry) {
  const known = table(docs), next = {};
  for (const tab of tabIds) if (tab !== id && entryOf(known, tab)) next[tab] = known[tab];
  next[id] = entry;
  return next;
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// Runs the decision against Herdr. `io`: { spaces, panes, shared, setShared, run,
// notify, wait, newDoc }. The caller runs one of these at a time.
export async function openFile({ file, pin = false, space, line = null }, io) {
  const spaceNow = () => io.spaces().find((s) => s.id === space);
  const name = baseName(file);
  const failed = () => {
    io.notify({ title: `Couldn't open ${name}`, level: "error" });
    return { kind: "failed" };
  };
  const target = spaceNow();
  if (!target) return failed();

  const plan = planOpen({ file, pin, line, tabs: target.tabs, docs: io.shared(DOCS_KEY), live: io.shared(LIVE_KEY), panes: io.panes() });
  if (plan.kind === "select") {
    io.run("tab.select", { id: plan.id });
    if (plan.pin) {
      const docs = table(io.shared(DOCS_KEY));
      io.setShared(DOCS_KEY, { ...docs, [plan.id]: { ...docs[plan.id], preview: false } });
    }
    // It can't go to a line and it can't be replaced, so it says which.
    if (line) io.notify({ title: `${name} is already open: line ${line}`, level: "info" });
    return plan;
  }

  const before = new Set(target.tabs.map((t) => t.id));
  const doc = io.newDoc();
  try {
    io.run("tab.new", { name, space, mod: FILE_MOD, props: line ? { doc, file, line } : { doc, file } });
  } catch {
    return failed();
  }
  // spaces() doesn't change in the same tick.
  let id = null;
  for (let waited = 0; !id && waited < OPEN_TIMEOUT; waited += OPEN_POLL) {
    await io.wait(OPEN_POLL);
    id = findNewTab(before, spaceNow(), io.panes());
  }
  if (!id) return failed();

  const allTabs = io.spaces().flatMap((s) => s.tabs.map((t) => t.id));
  io.setShared(DOCS_KEY, nextDocs(io.shared(DOCS_KEY), allTabs, id, { doc, file, preview: !pin }));
  if (!spaceNow().tabs.find((t) => t.id === id)?.active) io.run("tab.select", { id });

  if (Object.hasOwn(GOES, plan.kind)) {
    // Asked again: the tab may have been edited, closed or split meanwhile.
    const old = spaceNow().tabs.find((t) => t.id === plan.id);
    const entry = entryOf(table(io.shared(DOCS_KEY)), plan.id);
    if (old && GOES[plan.kind](old, entry, io.shared(LIVE_KEY))) {
      const close = closeCommand(old, io.panes());
      // With a terminal beside it the old tab stays, so there's no place to take.
      if (old.panes <= 1) io.run("tab.move", { id, index: old.index });
      if (close) io.run(...close);
    }
  }
  return { kind: plan.kind, id, doc };
}
