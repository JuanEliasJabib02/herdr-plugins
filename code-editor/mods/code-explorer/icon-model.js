// Which Material icon a row draws (D6): the same resolution as Orca's plugin icon
// themes (renderer/src/lib/file-type-icons.ts). Files: exact name, then the longest
// dotted suffix, then the plain file. Folders: by name, an open one by its expanded
// name or else the generic open folder. All lower case: the tables are.
// The result is a path in Herdr's home, as image() takes it.
const MOD = "mods/code-explorer";

export const ICON_THEME = `${MOD}/icons/theme.json`;

const inMod = (rel) => `${MOD}/${rel}`;

// The table is a plain object: a file called `constructor` must not find what
// every object inherits.
const own = (entries, key) => (entries && Object.hasOwn(entries, key) ? entries[key] : null);

// The table from theme.json's text, or null: a missing or broken table only costs
// the icons, and every row then draws the plain one.
export function parseIconTheme(text) {
  if (typeof text !== "string") return null;
  try {
    const theme = JSON.parse(text);
    return theme && typeof theme === "object" && !Array.isArray(theme) ? theme : null;
  } catch {
    return null;
  }
}

export function fileIcon(theme, name) {
  const lower = name.toLowerCase();
  let found = own(theme?.fileNames, lower);
  // From the first dot on, so a theme's `d.ts` wins over `ts` and `gz` still
  // matches `a.tar.gz`.
  const parts = lower.split(".");
  for (let start = 1; !found && start < parts.length; start++) found = own(theme?.fileExtensions, parts.slice(start).join("."));
  return inMod(found ?? own(theme?.icons, "file") ?? "icons/file.svg");
}

export function folderIcon(theme, name, open) {
  const lower = name.toLowerCase();
  const expanded = open ? own(theme?.folderNamesExpanded, lower) ?? own(theme?.icons, "folder-open") : null;
  const found = expanded ?? own(theme?.folderNames, lower) ?? own(theme?.icons, "folder");
  return inMod(found ?? (open ? "icons/folder-open.svg" : "icons/folder.svg"));
}
