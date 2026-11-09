// What the code-tabs bar decides, with no herdr or gpui-kit imports so
// `node --test` can load it. main.js draws and runs what comes out of here.
//
// A command here is [name, args?], ready for run(name, args). A mod command
// reaches only the copy in the shown tab, which is why only the active tab can
// be closed from the bar and why a file's commands name its doc: a copy ignores
// a doc that isn't its own.

// Written by code-explorer: { [tabId]: { doc, file, preview } }.
export const DOCS_KEY = "code-editor.docs";
// Written by code-file: { [doc]: { dirty, pinned } }.
export const LIVE_KEY = "code-editor.live";

const FILE_MOD = "code-file";

// The Explorer's copy of Material's icons. Paths in Herdr's home, as image() takes
// them; the table's own paths are relative to the mod's folder.
const ICON_FOLDER = "mods/code-explorer";
export const ICON_THEME = `${ICON_FOLDER}/icons/theme.json`;
const PLAIN_FILE_ICON = "icons/file.svg";

// `shared` values and the icon table are plain objects, so `constructor` or
// `__proto__` as a file's name must not find what every object inherits.
const own = (table, key) => (table && Object.hasOwn(table, key) ? table[key] : undefined);

const baseName = (path) => String(path ?? "").split("/").pop();

// The icon table from theme.json's text, or null: a missing or broken table
// only costs the icons, every file then draws the plain one.
export function parseIconTheme(text) {
  try {
    const theme = JSON.parse(text);
    return theme && typeof theme === "object" && !Array.isArray(theme) ? theme : null;
  } catch {
    return null;
  }
}

// Exact name first, then the longest suffix (`a.test.ts` is `test.ts` before
// `ts`), all lower case: the tables are.
export function fileIcon(name, theme) {
  const lower = String(name ?? "").toLowerCase();
  let path = own(theme?.fileNames, lower);
  for (let dot = lower.indexOf("."); !path && dot !== -1; dot = lower.indexOf(".", dot + 1)) {
    path = own(theme?.fileExtensions, lower.slice(dot + 1));
  }
  return `${ICON_FOLDER}/${path ?? own(theme?.icons, "file") ?? PLAIN_FILE_ICON}`;
}

// What the bar shows for one tab. `doc` is null for anything that isn't a file.
// A docs entry alone isn't enough: closing a file with a terminal split in beside
// it leaves the tab and the entry, and that tab must close like any other.
export function tabView(tab, { docs, live, panes = [], icons } = {}) {
  const here = panes.filter((p) => p.tab === tab.id);
  const program = here.find((p) => p.program?.agent)?.program ?? here[0]?.program ?? null;
  const entry = own(docs, tab.id);
  if (!entry?.doc || !here.some((p) => p.mod === FILE_MOD)) {
    const name = /^tb\d+$/.test(tab.name) ? program?.name ?? "Terminal" : tab.name;
    return { doc: null, name, preview: false, dirty: false, icon: null, program };
  }
  const state = own(live, entry.doc);
  return {
    doc: entry.doc,
    name: tab.name,
    preview: Boolean(entry.preview) && !state?.pinned,
    dirty: Boolean(state?.dirty),
    icon: fileIcon(baseName(entry.file ?? tab.name), icons),
    program,
  };
}

// The slot at a tab's right end, or null for none. Only the active tab closes;
// a dirty tab shows its dot wherever it is, and on an inactive tab a click on the
// dot selects the tab like the rest of it.
export function closeSlot(active, dirty) {
  if (dirty) return { dot: true, closes: active };
  return active ? { dot: false, closes: true } : null;
}

// One way to close a file, clean or dirty: it decides, because it knows what's
// unsaved and what is split in beside it. Never `confirmed`: closing a space's
// last tab closes the space, and that still asks.
export function closeCommand(tab, view) {
  return view.doc ? [`${FILE_MOD}.ask-close-${view.doc}`] : ["tab.close", { id: tab.id }];
}

// A double click pins a preview, through its file, which owns `pinned`. A file's
// tab has no other use for one: its name is the file's.
export function doubleClickCommand(tab, view) {
  if (!view.doc) return ["tab.rename", { id: tab.id }];
  return view.preview ? [`${FILE_MOD}.pin-${view.doc}`] : null;
}

// Which panels are on offer in the panel's header. The Explorer always: cmd-l
// opens it whatever the person picked in Herdr's welcome (its first look leaves
// an empty list), and the header would otherwise lack the icon of the panel it
// shows. Changes as they picked. Whether the panel is open, and on which child,
// is Herdr's: a click of the layout, the same in every space, as in Orca.
export function enabledPanels(chosen) {
  const offersChanges = Array.isArray(chosen) ? chosen.includes("changes") : true;
  return offersChanges ? ["explorer", "changes"] : ["explorer"];
}

// The panel's own header, as in Orca: an icon per child of its stack, the
// Explorer first, and Changes when picked.
const PANEL_TABS = Object.freeze([
  { id: "explorer", label: "Explorer", icon: "mods/code-tabs/files.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
]);

export function panelTabs(enabled) {
  return PANEL_TABS.filter((b) => enabled.includes(b.id));
}

const showPanel = (id) => [
  ["layout.select", { stack: "panel-body", child: id }],
  ["layout.show", { id: "panel" }],
];

export const closePanel = () => [["layout.hide", { id: "panel" }]];

export function panelTabClick(id) {
  return [["layout.select", { stack: "panel-body", child: id }]];
}

// The bar's right end has the toggle only while the panel is closed: open, the
// toggle is in the panel's header.
export function barToggle(panel) {
  return panel?.hidden ? { id: "panel-open", icon: "mods/code-tabs/panel.svg" } : null;
}

// Opening goes back to the child the panel had, if it's still on offer.
export function openPanel(body, enabled) {
  return showPanel(enabled.includes(body?.active) ? body.active : "explorer");
}
