# Code editor

A code editor and Explorer for Herdr, built from how Orca does them. In the projects
layout, `cmd-l` opens and closes a right panel with the Explorer: a file tree with
git marks, `Names` to filter by path, `Contents` to search inside files, and file
operations. Each file opens in its own tab, in Herdr's editor, with saving, conflicts,
drafts and a Blame view. The whole window wears One Dark Pro, and files wear Material's
icons.

**What you see**

- **Tab bar** (the layout's `tabs` block, 42 px high, `chrome`, a 1 px `border`
  below): one pill per tab, 29 px high, radius 7, 12.8 px text. The active one is
  `raised` with a 1 px `border` and `foreground` text; the others are `muted`, with
  `hover` behind them under the pointer. A file's tab draws its Material icon at
  14 px and its name, up to 170 px, in italics while it's a preview. At its right
  end, a 24 by 27 px slot: an X at 12 px in `muted` on the active tab, or an 8 px
  dot in `ansi3` on any tab with unsaved changes; an inactive tab with nothing
  unsaved has no slot. A terminal's tab draws its program's icon and, as in Herdr,
  a spinner in `working` or a 6 px dot in `blocked` or `done`.
- **The bar's right end:** `+` (26 px, radius 6, `muted`), level with the
  terminals' right edge: the bar ends where they do. While the panel is closed,
  4 px further on, the toggle that opens it: the same 26 px button with a 14 px
  panel icon.
- **Right panel** (`panel`, in projects-sidebar's layout), as in Orca: the
  window's whole height beside the tab bar and the terminals, down to the status
  bar, on `chrome`, flush with the window's edge, a 1 px `border` divider on its
  left. 368 px wide, 280 to 900, closed until you open it. It shows one block at a
  time: the Explorer, or Herdr's `changes`, which draws its own card.
- **The panel's header** (42 px, like the tab bar, so their bottom lines run on
  as one): an icon per panel, 34 px wide with a 16 px icon, the Explorer's files
  and then Changes' branch if picked in Herdr's welcome. The shown one is
  `foreground` with an 18 by 2 px bar under it; the others `muted`. At the right
  end, the panel icon closes the panel.
- **Explorer block:** described under **The Explorer**.
- **Theme:** One Dark Pro on the whole window, terminals and panels alike:
  background `#282c34`, foreground `#abb2bf`, accent `#528bff`, `chrome` and
  `surface` `#21252b`, `canvas` `#1d1f23`, `border` `#3e4452`.

**How it behaves**

- **`cmd-l`** in the projects layout opens the panel, and closes it again, with
  a terminal focused too. The terminal's program doesn't get the key, and its
  `ctrl-l` still clears the screen.
- **The bar's toggle** opens the panel on the panel it last showed, the Explorer
  if that one isn't on offer. **A header icon** shows its panel; the header's
  panel icon closes the panel.
- The panel's width is kept with the layout's other clicks, by Herdr.
- **Each space remembers its panel:** which one was open, or closed. Switching
  away and back brings it back; a space that never had one shows it closed.
- **Tabs:** a click selects, a drag moves, the wheel goes to the next or previous
  one, a right click opens Herdr's tab menu, and `+` opens Herdr's new-tab menu.
- **A double click** pins a file's preview, so the next preview doesn't replace
  it; it does nothing on a pinned file, and renames any other tab.
- **The X or the dot of the active tab:** a file's asks that file, unsaved changes
  or not, and the file decides. Any other tab closes with `tab.close`, and closing
  a space's last tab still asks.
- **The dot on an inactive tab** only marks it: a click there selects the tab.
- Agents show on their tabs as in Herdr: a spinner while working, a dot when
  blocked or done.

**Built from**

- **`keys.json`:** `layout:projects` `cmd-l` → `layout.toggle:panel`, and
  `mod:code-file` `cmd-s` → `code-file.save`, `cmd-w` → `code-file.close`. The
  installer merges them into the person's keys.
- **`themes/one-dark-pro.json`:** a Herdr theme file made from Orca's One Dark
  Pro plugin (`stablyai/orca-plugins`, `plugins/one-dark-pro-theme`, its
  `terminal/` and `themes/` files for the Pro variant), MIT, with its license in
  `themes/LICENSE`. The installer copies `themes/*.json` to `<home>/themes/`, and
  the license stays in the repo.
- **Mod `mods/code-tabs/`** (`mod.json` `{ "place": "none" }`, with `cloned_from`
  Herdr's `tabs` 0.1.13): a copy of Herdr's `tabs` mod under its Apache License
  2.0, in `LICENSE`, with its window icons. `tabs-model.js` holds the decisions,
  including the per-space memory, and `main.js` draws. It reads the shared keys
  `code-editor.docs` (`{ [tabId]: { doc, file, preview } }`, written by the
  Explorer) and `code-editor.live` (`{ [doc]: { dirty, pinned } }`, written by the
  file) and `workspace.panels`, and writes nothing shared; a docs entry counts only
  while a `code-file` pane is in that tab. It runs `code-file.ask-close-<doc>`,
  `code-file.pin-<doc>`, `tab.select`, `tab.move`, `tab.close`, `tab.rename`,
  `tab.next`, `tab.prev`, `layout.select`, `layout.show`, `layout.hide` and the
  window commands. It runs no program. It reads
  `<home>/mods/code-explorer/icons/theme.json`, outside its own folder, and draws
  those icons with `image()`: exact name first, then longest suffix, in lower case,
  else `icons/file.svg`. It also draws `mods/pane/close.svg`,
  `mods/workspace-chrome/spinner.svg` and `mods/changes/changes.svg`, Herdr's own.
- **Mod `mods/code-explorer/`** (`mod.json` `{ "place": "none" }`): described
  under **The Explorer**.
- **Art, `mods/code-explorer/icons/`:** Orca's Material Icons plugin
  (`stablyai/orca-plugins`, `plugins/material-icons/icons`) byte for byte: 279
  SVGs, 21 of them `_light` variants, and `theme.json`. Its tables `icons`,
  `fileNames`, `fileExtensions`, `folderNames` and `folderNamesExpanded` give
  paths relative to the mod's folder. `LICENSE` and `THIRD_PARTY_NOTICES.txt`
  (Material Icon Theme 5.39.0, MIT) are beside them. Draw them with `image()`:
  `svg()` tints an icon to one color.
- **Layout `projects-sidebar/layouts/projects.json`:** the root sets `"theme":
  "one-dark-pro"`, the block `tabs` draws `{ "mod": "code-tabs" }`, the row
  `work-row` holds the column `work` (tab bar and terminals) and the column
  `panel`, whose block `panel-header` draws `{ "mod": "code-tabs", "props": {
  "view": "panel" } }` above the stack `panel-body`, which has `active: "explorer"` with the
  children `explorer` → `{ "mod": "code-explorer" }` and `changes` →
  `{ "mod": "changes" }`. projects-sidebar's `requires` installs this plugin
  first.

**Watch out**

- **A `cmd-l` you already bind in `layout:projects` stays yours:** the install
  says so, and then the key doesn't toggle the panel.
- **Don't put Herdr's `tabs` mod back in this layout.** Its "Files" button selects
  a stack child `files`, which is gone, and its per-space memory of the panel only
  knows `files` and `changes`, so switching spaces closes an open Explorer.
- **The Explorer is always on offer,** whatever `workspace.panels` says: its first
  look in Herdr's welcome leaves an empty list, and `cmd-l` opens the Explorer
  anyway, so leaving it out would close it at the next change of space.
- **A `<mod>.<command>` reaches only the copy in the shown tab,** so only the active
  tab can be closed from the bar, and an inactive tab's dot doesn't close it.
- **Close in the tab's right-click menu is Herdr's:** it doesn't ask the file.
- **The header is a second copy of `code-tabs`:** it only draws, and the bar's
  copy keeps the per-space memory, so a layout with the header and no bar forgets
  the panel per space.
- **The active tab's text is `foreground`** (`#abb2bf`). The design's `#d7dae0` has
  no theme name of its own, and the dot's `ansi3` (`#d18f52`) stands in for its
  `#e5c07b`: both follow the theme picker this way.
- **A theme file at that name:** a `themes/one-dark-pro.json` this plugin didn't
  install stops the install with nothing changed. Move it away and install again.
- **The theme picker overrides the layout's theme,** as in any Herdr layout.
- **Installed on its own,** `scripts/install.sh code-editor` brings the theme, the
  mods and the keys, but neither the layout nor the blocks that draw them.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check` passes on
  `"$PWD/code-editor/mods/code-explorer"` and `"$PWD/code-editor/mods/code-tabs"`.
- `scripts/install.sh code-editor` leaves `<home>/themes/one-dark-pro.json` and
  `<home>/mods/code-explorer/icons/theme.json`, and `scripts/install.sh
  --uninstall code-editor` removes both.
- In the projects layout, `cmd-l` with a terminal focused opens the panel on the
  Explorer and closes it again, and the terminal's screen stays as it was.
- In the projects layout, the terminals' cards are `#282c34` and the canvas
  around them `#1d1f23`.
- With the Explorer open in a space, switching to another space and back shows it
  open again, with its header's files icon in `foreground` and the bar under it.
- A tab whose `code-editor.docs` entry has `preview: true`, with a `code-file` pane
  in it, shows its name in italics and its Material icon; with `dirty: true` in
  `code-editor.live` it shows the dot, active or not.

## The Explorer

Mod `mods/code-explorer/`, in the right panel: the files of the space's repo as a tree
with git marks, `Names` to filter them by path, `Contents` to search inside them, and
the operations on them, with Orca's behavior and Orca's words. A file opens in a tab of
its own, under **The editor**.

**What you see**

- **The card:** `chrome`, a 1 px `border`, radius 10, 13 px text in `foreground`.
- **Header:** 42 px: the repo's name, semibold and truncated, with its folder as the
  tooltip, then three 26 px buttons with radius 6 and 14 px icons in `muted`: "Collapse
  All", "Refresh Explorer", which spins from 200 ms on, and "More Explorer Actions". A
  button with nothing to do is at half opacity.
- **More Explorer Actions:** under the header at the right, 228 px, `popover`, a 1 px
  `border`, radius 8, 26 px rows at 12.5 px: "Show Dotfiles" and, in a git repo, "Show
  Git Ignored Files", with a check while on, then "Reveal in Finder".
- **The switch:** "Names" and "Contents" on `canvas`, radius 8, each 28 px high with
  radius 6: `selected` and `foreground` when on, `muted` when not.
- **"Find files",** in Names: 32 px, radius 7, a 1 px `input` border, `accent` while
  focused, with a spinner while the list loads and an X, "Clear file filter", once
  something's typed.
- **A row:** 24 px, indented `depth × 16 + 8`, `hover` under the pointer, `selected` for
  the file of the shown tab: a 12 px chevron on a folder that opens, its Material icon at
  16 px, the name truncated, and at the right a read's error in `ansi1` at 11 px or the
  git letter, semibold at 11 px.
- **Git's colors,** on the letter and the name: M `#e2c08d`, A `#81b88b`, D `#c74e39`, R,
  U and C `#73c991`. Ignored and with no letter: italic, `dim`, and a 12 px icon labeled
  "Ignored by .gitignore". A folder that can't be entered is `dim`, with no chevron.
- **In place of rows:** "No files in this workspace", "Select a workspace to browse
  files", "Explorer works on this computer only", "No files match this filter", or "Could
  not load files for this workspace:" and why, with "Retry". Over the rows, when it
  applies, at 11 px: "A folder shows its first 5000 entries", "Searching the first 20000
  files".
- **Contents:** a 32 px bar, placeholder "Search", labeled "Search files": a spinner while
  it runs, an X, "Clear search", and 22 px toggles "Match Case", "Match Whole Word", "Use
  Regular Expression". Under it "{{count}} active" and "Toggle search details", which shows
  "files to include" (`e.g. *.ts, src/**`) and "files to exclude" (`e.g. *.min.js,
  dist/**`).
- **Results:** "5 results in 2 files" at 11 px in `dim`, with "(results truncated)" when
  they are. A file's row: chevron, icon, name, its folder in `dim` and a count. A match's
  row: its line number, up to 26 characters before it, the match on `selected`, the rest.
  Otherwise "Type to search in files", "No results. Try another search or adjust your
  filters.", "Search failed. Try again." in `ansi1`, or "Select a workspace to search".
- **A row's menu:** a popup at the pointer, 240 px, `popover`, the row's path in `dim` at
  the top, 30 px rows with radius 7 at 12.8 px, in this order: "New File", "New Folder", a
  line, "Copy Path", "Copy Relative Path", on a file "Duplicate", on a folder "Open in
  Terminal", "Collapse Folder" and "Find in Folder", then "Reveal in Finder", a line,
  "Rename", and "Delete" in `blocked`. Empty space under the rows offers the first two.
- **The entry,** for naming: above the rows, what it's for at 11 px in `dim` ("New File in
  src", "Rename a.js"), then a 26 px box with radius 5 and a 1 px `accent` border: an icon,
  the input and an X, "Cancel".
- **The Delete dialog:** modal, 400 by 230 px, `popover`. "Delete 'a.js'?", the path in
  `dim`, "It moves to the Trash." (a folder: "It moves to the Trash with everything in
  it."), an error in `blocked` if there is one, and "Cancel" and "Delete", 32 px high with
  radius 8, "Delete" in `blocked`.
- **When the Trash says no,** the same dialog: "Couldn't move 'a.js' to the Trash. Delete
  it permanently?", "This cannot be undone.", and "Delete Permanently" in place of "Delete".

**How it behaves**

- **Which folder:** the focused terminal's, up to its repo's top. A focused file has none,
  so the tree stays where it was; failing that, the space's first terminal, then the
  space's folder. Going back to a folder already seen is instant.
- **The tree:** a folder is read when opened. Folders come first, then natural order
  without regard to case or accents. `.git`, `node_modules` and Herdr's write temporaries
  never show. A symlinked folder that leaves the root shows and isn't entered.
- **Keeping up:** a watch on the root, settled for 100 ms, and every 10 s, which also covers
  a commit in a worktree. A hidden panel reads again when it shows.
- **Git's marks** need the root to be the repo's top. A folder shows the strongest letter
  below it, D over M over A and U over R over C, and a deleted file reaches no folder. A
  letter wins over the ignored look.
- **Show Dotfiles** is per root and **Show Git Ignored Files** for all of them, both on by
  default and both kept across restarts.
- **Opening a file:** a click opens it in preview, replacing the last preview in its place.
  A double click within 400 ms pins it. A file already open is selected. A preview with
  changes, pinned, or with a terminal beside it is never replaced.
- **Names:** each word somewhere in the lower-cased path, in any order: no fuzzy match, no
  ranking. Matches show as a tree with its folders open, and a chevron collapses one until
  the filter's emptied. A query over 2 KiB matches nothing. Collapse All is off, and the
  list leaves out what the tree hides plus caches like `.next`, `.cache`, `.vscode` and
  `.local/share`.
- **Contents:** starts 300 ms after the last change, and a new search stops the last one,
  whose results stay until the new ones come. Up to 2000 results, and after 15 s what it
  found is the answer, marked truncated. Esc clears it. Patterns split on commas, and
  `*.{ts,tsx}` works. Leaving Contents stops the search and keeps the text.
- **A result** opens pinned at its line. A clean file open alone in its tab reopens there; if
  it can't, it's selected and a toast says "a.js is already open: line N".
- **New File and New Folder** go in the folder pressed, or beside the file pressed, and open
  that folder first. Enter creates, a blank name cancels, and Esc and the X cancel. A new
  file opens pinned; a new folder opens nothing.
- **Rename** fills the entry and selects the name before its extension. The same text does
  nothing, on a name with spaces at its ends too; any other text is trimmed. An open folder
  stays open under its new name.
- **An invalid or used name:** a toast, in Orca's words when it's taken ("A file or folder
  named 'a.js' already exists in this location"), and the entry stays with its text to fix.
  A file, a folder and a broken link all hold a name, and nothing is ever overwritten.
- **Duplicate,** on files: `<stem> copy<ext>`, then `copy 2`, up to `copy 10`, with the same
  mode, not opened. A link stays a link.
- **Delete** asks, then moves to the Trash, and nothing happens on Enter. If the Trash fails
  and the path is still there, the dialog offers "Delete Permanently", which is the one way
  to `rm`. If it stopped without an answer, it says so and offers nothing, since nobody knows
  what's left. Closing the dialog mid-run doesn't stop it: a failure becomes a toast.
- **Unsaved changes stop it:** Rename, Duplicate and Delete refuse with `"a.js" has unsaved
  changes` before touching the disk, for any file at that path or under it, in any space. A
  tab opened through a link to a folder is on that link as well as on the folder. A draft of
  that tab's on disk counts too, because `code-editor.live` can lag after a hang.
- **A draft with no tab stops it too:** a close that doesn't ask leaves one, and moving the
  file would leave it keyed to the old path, where reopening wouldn't offer it. Any draft for
  that real path or under it refuses with `"a.js" has unsaved changes. Open it to save or
  discard them.` A draft that can't be read is passed over, and a drafts folder that can't be
  listed stops the operation.
- **Tabs follow:** a clean file's tab reopens at the new name in its old place, keeping
  preview or pin, one at a time and each in its own space, and the tab that was active comes
  back. With a terminal beside it, only the file's pane is replaced. Delete closes the tabs,
  and only after the disk says the path is gone.
- **Copy Path** is absolute and **Copy Relative Path** from the root. **Open in Terminal** is
  a new tab in that folder. **Collapse Folder** takes what's open inside too, and shows only
  with no filter. **Find in Folder** opens Contents with the folder in "files to include",
  its special characters escaped, keeping what's typed.
- **Refused everywhere:** the root itself, `.git` in any capitals, a path with `..`, and
  anything whose real path leaves the root, including a link to it.

**Commands,** `herdr-app do code-explorer.<command>`, each the same method as its click:
`open:<rel>`, `pin:<rel>`, `toggle:<rel>`, `collapse-all`, `refresh`, `more`, `dotfiles`,
`ignored`, `names`, `contents`, `filter:<text>`, `clear-filter`, `search:<text>`,
`clear-search`, `match-case`, `whole-word`, `regex`, `search-details`, `include:<text>`,
`exclude:<text>`, `open-result:<n>`, `toggle-result:<path>`, `menu:<rel>`, `new-file:<rel>`,
`new-folder:<rel>`, `rename:<rel>`, `entry:<text>`, `entry-submit`, `entry-cancel`,
`duplicate:<rel>`, `delete:<rel>`, `delete-confirm`, `delete-permanent`, `delete-cancel`,
`copy-path:<rel>`, `copy-relative-path:<rel>`, `reveal:<rel>`, `open-in-terminal:<rel>`,
`collapse-folder:<rel>`, `find-in-folder:<rel>`. On `menu`, `new-file`, `new-folder`, `reveal`
and `open-in-terminal`, an empty `<rel>` is the root; `rename`, `duplicate` and `delete` refuse it.

- **`<rel>//<name>`** on `new-file`, `new-folder` and `rename` is the entry, its text and
  Enter in one command. No path and no valid name can hold `//`.
- **What a click would have done** goes to the log as `code-explorer: <json>`: `tree` for the
  rows, `results` for the search, `ops` for the entry, the dialog, the last operation and the
  last copy.
- **`menu-pick:<id>`** reaches an open menu's own copy, the same choice as clicking that item.
- **`copy-path` and `copy-relative-path`** only report, in `ops`, and `menu-pick` on a copy item
  only logs: from a test window, a real copy would overwrite the person's clipboard.

**Built from**

- **`main.js`:** one mod in views. The layout's copy is the panel, which draws and runs
  programs, reads commands and runs every operation. An overlay's props `{ view }` make a
  copy `file-menu.js`, the popup, or `file-dialog.js`, the dialog. A closed popup's tasks are
  cut at 250 ms, so a menu only chooses and sends the panel a command, and copies with its
  own `cx`.
- **`tree-model.js`:** order, listing, rows, where a space is rooted, what a batch of changes
  reloads, and opening a file: `planOpen` decides, `openFile` runs it, and `closeCommand` is
  the one way to close a file's tab.
- **`names-model.js`, `search-model.js`:** the filter, and the search with its arguments, parse
  and trim. Neither has a Herdr import.
- **`ops-model.js`:** the operations and their guards, with the programs and tabs passed in as
  `io`. Each outcome is read from the disk afterwards, because `mv -n` onto a taken name says 0
  and in this volume `foo` still resolves after `mv foo Foo`.
- **`git-model.js`, `icon-model.js`:** the letters and what's ignored; which icon. `ui/` holds the
  mod's own icons. It also draws `mods/workspace-chrome/` chevrons, `x`, `check` and `spinner`,
  Herdr's own.
- **Programs:** `git`, `sh`, `find` and `grep` to read, `pkill -f` to stop a search, `/bin/realpath`,
  `/bin/ls`, `/usr/bin/head -n 1`, `/bin/mkdir`, `/bin/mv`, `/bin/cp`, `/usr/bin/cmp`,
  `/usr/bin/trash -s`, `/bin/rm -rf` and `/usr/bin/open -R`. Every path goes as one absolute argument, so `-rf` and `$(x)` are
  names like any other.
- **Herdr's shared state:** writes `code-editor.docs` (`{ [tabId]: { doc, file, preview } }`, nobody
  else does) and `code-editor.op` (the Delete dialog's `{ rel, name, folder, step, busy, error }`),
  and reads `code-editor.live`. An entry counts only while a `code-file` pane is in that tab. It
  reads the names in `<home>/code-editor/drafts/` and each draft's first line.

**Watch out**

- **Clicks can't be posted to Herdr,** so the right click, the menu's items and the dialog's
  buttons are proved through their commands, and pressing them for real is left for a person.
- **The entry sits above the rows, not at the row:** a virtual list's row can't hold a handler,
  and the rows scroll under it.
- **Leaving the entry doesn't create anything,** unlike Orca: focus can leave on its own here, and
  half a name isn't a name. Enter, Esc or its X.
- **Delete asks first,** unlike Orca's local delete, and there's no undo.
- **There's no "Copy":** `write_to_clipboard` only carries text, which is what Copy Path does.
- **Duplicate refuses a file with unsaved changes** too, though it wouldn't lose them: it would
  copy the disk's text, not what's on screen.
- **A link that leaves the root can't be renamed or deleted from here,** even though only the link
  would move. A broken link can, since it leads nowhere.
- **A tab at a line reopens at the top** when its file's renamed: the Explorer doesn't know the line.
- **Beside a terminal,** a renamed file's tab keeps its old name, as closing the file there does.
- **`<mod>.<command>` reaches shown copies only:** hide the panel with the dialog open and its action
  buttons don't arrive. Cancel and Esc close it anyway, and the file's untouched.
- **`reveal` brings Finder forward,** so it's no command for a test window behind the person's work.
- **macOS only:** `trash` and `open -R`. Without `trash`, Delete says it didn't finish and offers
  nothing.
- **Local files only:** in a remote space the panel says "Explorer works on this computer only" and
  does nothing, since `writeTextFile` and `watchFolder` don't reach other machines.
- **`main.js` and what it imports use `import * as herdr`** for what `test/code-explorer-names.test.js`'s
  stand-in lacks: a named import of it fails that whole test file at load. For the same reason, an
  `InputState` goes before `filterInput` in `init`.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`: real files under a temp folder for taking a name,
  a folder as the target, a change of capitals, names with a dash and the guards, and a stand-in
  `trash` for its four outcomes. `herdr-app check "$PWD/code-editor/mods/code-explorer"` passes.
- The tree shows a repo's letters, with its folders' strongest one, and `.git` and `node_modules`
  never.
- `filter:<word>` shows a tree of what matches, and `search:<word>` results that open at their line.
- `new-file:<rel>//<name>` leaves an empty file and a pinned tab, `new-folder:<rel>//<name>` a folder,
  and either one on a used name leaves a toast and the disk as it was.
- `duplicate:<rel>` leaves `<stem> copy<ext>`, then `copy 2`.
- `delete:<rel>`, then `delete-confirm`: `trash -s` for real, and the path gone from the disk.
- `rename:<rel>//<name>` with a clean tab on that file reopens it with the new path. With unsaved
  changes it's refused, and the file and the tab stay.

## The editor

Mod `mods/code-file/`, one copy per file tab, with props `{ doc, file, line? }`:
write a file and save it with `cmd-s`, with Orca's behavior and Orca's words when
someone else changes it.

**What you see**

- **Header:** 30 px, a 1 px `border` below, 12 px text in `dim`: the path with `~`
  in the code font, truncated, then at the right `JavaScript · UTF-8 · LF` (`CRLF`
  for a file that is all CRLF). Before it, when they apply: "Línea N", "Deleted on
  disk", "Read-only", "Sin colores: archivo grande".
- **Editor:** Herdr's, 13 px in the terminal's font, line numbers, no wrap, and the
  colors of One Dark Pro's syntax (see Built from).
- **Banner:** under the header, `#38342a` with `#e5c07b` text at 12.5 px, padding 8
  by 12, its buttons 26 px high with a 1 px `input` border and radius 6, wrapping
  when narrow.
  - "This file changed on disk while you have unsaved edits. Overwrite replaces the
    newer disk content." with "Reload from Disk", "Overwrite", "Keep My Edits"
    (tooltip "Keeps your version. Your next save replaces the version on disk.").
  - "Cambió en disco" with "Recargar".
  - "Restored unsaved changes" with "Discard".
  - "Failed to save the file. Please try again.", or "This file isn't UTF-8 text, so
    it wasn't saved.", or "File too large: exceeds the 1 MiB limit", no button.
  - A read that failed under a live buffer: its message with "Retry".
- **Card when closing with changes:** inside the tab, over a dimmed tab (`#00000073`,
  which covers the editor): 440 px, `popover`, 1 px `border`, radius 10, padding 20.
  "Unsaved Changes" at 15 px, `"a.js" has unsaved changes. Do you want to save before
  closing?`, and "Cancel", "Don't Save", "Save" at the right, 30 px high, radius 7,
  "Save" on `raised`.
- **Instead of the editor,** centered: "Binary file — cannot display", "File too
  large: exceeds the 1 MiB limit", "This file isn't UTF-8 text", or "Unable to load
  file" with its message and "Retry".
- **Opening at a line** (`props.line`): a read-only view with 20 px rows, a 60 px
  gutter, the line in the middle of the view on `hover`, a scrollbar, and "Editar" in
  the header.

**How it behaves**

- **`cmd-s`** writes the text only if the disk still holds what was read. A second
  `cmd-s` during a write waits behind it. Text typed during a write stays unsaved.
- **A file that is all CRLF** stays that way: Enter's `\n` is saved as `\r\n`. Any
  other file is saved as it is. A BOM stays.
- **The file changed on disk,** and it isn't the save's own write:
  - With unsaved changes: the buffer is never touched, and the conflict banner
    shows. `cmd-s` then writes nothing and says to use the banner.
  - Clean and on screen: "Cambió en disco", so the page doesn't jump while you read.
  - Clean and hidden, or in the line view: it reloads quietly.
- **Reload from Disk** drops your changes and says "Reloaded from disk". **Overwrite**
  replaces what's on disk now. **Keep My Edits** only takes the banner away: your next
  `cmd-s` replaces the disk's text.
- **The file disappeared:** after 250 ms the header says "Deleted on disk", the
  buffer stays, and `cmd-s` creates the file again.
- **Unsaved changes survive** a hot reload, a crash, a quit and a close that doesn't
  ask: a draft is written 300 ms after the last change. Reopening brings it back with
  "Restored unsaved changes" and "Discard" if the disk is as it was, with the conflict
  banner if it isn't (`cmd-s` writes nothing until Keep My Edits or Overwrite), and
  says nothing if the disk already holds that text. A tab closed while its file is
  still loading, or on one of the views instead of the editor, leaves its drafts for
  the next open. So does a draft that can't be read right now; one that reads but is
  cut short goes.
- **Closing,** by `cmd-w` or the tab's X: clean closes at once, unsaved changes bring
  the card, which takes the keyboard. Esc is Cancel, Enter does nothing, and `cmd-s`
  is its Save. Save closes only once the write landed; if it fails the card goes and
  the banner stays. Don't Save deletes the draft, then closes.
- **Which close:** the last pane closes the tab, and a space's last tab still asks.
  With a terminal beside the file, only the file's pane closes, and the tab goes back
  to being called by its number.
- **A preview becomes permanent** on the first edit, on a double click on its tab, and
  when a pane splits in beside it.
- **The keyboard:** the editor takes it when the file opens and when its tab comes back.
- **Editar** in the line view opens the editor at the top, and the header keeps
  "Línea N", because this editor can't jump to a line.

**Commands,** `herdr-app do code-file.<command>`, each the same path as its button:
`save`, `close`, `ask-close-<doc>`, `pin-<doc>`, `reload`, `overwrite`, `keep-mine`,
`discard`, `retry`, `cancel`, `dont-save`, `card-save`, `edit`, `focus`. A command
reaches only the copy in the shown tab, and one naming another doc is ignored.

**Built from**

- **`main.js`:** reads and writes with Herdr's `readTextFile` and `writeTextFile`,
  watches the file's folder with `watchFolder` (every 10 s if that rejects, or if the
  folder is the home folder, which is too much to watch), runs `/bin/realpath`, and
  `test -w` to open a file without write permission read-only.
- **`document-model.js`:** one file as a pure reducer: `diskText` is the next
  `expected`, `baseline` the editor's text at the last load or save, and `dirty` is
  always `value !== baseline`. A rejected save reads the disk and decides by that text,
  never by the error's words.
- **`draft-model.js`:** drafts in `<home>/code-editor/drafts/`, outside `mods/`, which
  the installer replaces, and mode 0700 like `blame/`, since both hold the buffer's
  plain text (`main.js` runs `/bin/chmod`: Herdr's `mkdir` takes no mode, and a chmod
  that fails doesn't stop the write). A file named `<hash of realpath>-<doc>-<seq>`,
  its first line JSON `{ path, baseSig, length, at }`, then the text. Writes and
  deletes share one queue; a write goes to a new sequence and only then are older ones
  removed.
- **`line-view-model.js`:** the line view's rows, a tokenizer per line (comments,
  strings, numbers, keywords), and the syntax colors: comment `#7f848e`, keyword
  `#c678dd`, string `#98c379`, string.escape and operator `#56b6c2`, number, constant
  and boolean `#d19a66`, function `#61afef`, type `#e5c07b`, variable `#e06c75`,
  punctuation `#abb2bf`. They differ from the theme's ANSI colors, so they're hex.
- **`code-editor.live`** in Herdr's shared state: `{ [doc]: { dirty, pinned } }`, written
  only by this mod and only when it changes. Entries of tabs that are gone go when the
  next file opens. It finds its tab through `code-editor.docs`, written by the Explorer.

**Watch out**

- **Closes that don't ask,** on purpose: `cmd-w` with the keyboard outside the mod, and
  Close in the tab's menu. The draft covers them.
- **Over 50 KB opens without colors,** because Herdr colors the whole file again on
  each key: 125 ms at 50 KB, 440 ms at 200 KB. Herdr's
  editor colors `js`, `json`, `py`, `rs`, `go`, `sh`, `css`, `yaml`, `sql`, `java`, `c`,
  `rb`, `php`, `lua` and `makefile`, and TS, JSX and such go as `js`. Markdown, HTML and
  a few others come out plain.
- **Over 1 MiB doesn't open,** and a buffer grown past it can't be saved: the failure
  shows and the draft stays.
- **Reloading sends the cursor to line 1,** which is why a file on screen asks first.
- **No find, no go-to-line, and the line view's block comments color only their first
  line:** Herdr's editor exposes neither to mods.
- **A symlinked file** is watched in the link's folder: a change through its target
  shows at the next read, or as a conflict when saving. The save itself is still safe.
- **Long lines in the line view are clipped;** Editar to see them.
- **Don't Save on a space's last tab:** Herdr asks whether to close the space. If you
  take more than 1.5 s to say yes, a draft comes back and reopening shows "Restored
  unsaved changes" with its "Discard".
- **Local files only:** `writeTextFile` and `watchFolder` don't reach other machines.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check
  "$PWD/code-editor/mods/code-file"` passes.
- In a tab with props `{ doc, file }`, typing and `cmd-s` leaves exactly that text in
  the file.
- With unsaved changes and the mod's `main.js` touched, the tab comes back with them and
  "Restored unsaved changes".
- With unsaved changes, the tab closed by Close in its menu and the file changed
  elsewhere, reopening shows the conflict banner.
- Don't Save, then reopening, shows the file with no banner.
- `cmd-w` with a terminal beside the file leaves the terminal running.
- `code-file.ask-close-<another doc>` does nothing.

### Blame

"Blame" in a file's header: who last changed each line, with its date, in the
read-only line view. It doesn't follow the cursor, because Herdr's editor doesn't
say where the cursor is.

**What you see**

- **The button:** "Blame" at the header's right end, with the look of the banner's
  buttons. The line view shows it beside "Editar". The Blame view shows only "Editar".
- **The view:** the line view of **Opening at a line**, with a column before the line
  numbers: 210 px, padding 12 at each side, a 1 px `border` at its right, 12 px text
  in `dim`. The author, truncated, then the date as `2024-03-05`, the day where the
  author was.
- **A line with no commit:** "sin commit" in italics and no date.
- **While git answers:** the rows with an empty column, and "Blame…" in the header.

**How it behaves**

- **What's blamed is the text on screen,** not the file: a line not saved yet says
  "sin commit", and so does one saved but not committed. Nothing is saved or changed,
  and the draft goes on being written.
- **Opening it asks git every time,** so a commit since the last time shows.
- **`cmd-s` and `cmd-w`** work as in the editor, and closing with changes brings the
  card.
- **Editar** goes back to the same editor, with its cursor where it was. In a tab
  opened at a line, Blame marks that line and scrolls to it, and an editor not yet
  created opens at the top.
- **The file changes on disk** while it shows, as in the line view: clean, it reloads
  quietly; with unsaved changes, the conflict banner. Any new text asks git again.
- **git says no** (no repo, a file that's in no commit, a repo with no commits): a
  toast "Blame no disponible" with git's first line, without `fatal:`, and back to the
  view it came from.

**Commands,** as the others: `blame`, the same path as its button.

**Built from**

- **`blame-model.js`:** `parseBlame` reads `--porcelain` into one entry per line (a
  commit's fields come only the first time it shows, and a line counts when its text
  arrives), and `blameLabel` says what a row shows. A sha of all zeros is no commit.
- **`main.js`:** writes the text to `<home>/code-editor/blame/<doc>`, beside `drafts/`
  and not in it, runs `git blame --porcelain --contents <that file> -- <name>` in the
  folder of the file's realpath, and deletes the copy. `exec` has no stdin, and an
  argument couldn't hold 1 MiB. One run at a time per tab.

**Watch out**

- **A commit made while the view shows** doesn't reach it, since nothing watches
  `.git`: Editar and Blame again.
- **A symlink is blamed through its target:** by its own name, git finds no line in
  any commit.
- **`exec`'s limit is 8 MiB of output,** which a file of very many short lines can pass.
  Whatever lines arrive show, and the rows past them have an empty column, which is not
  "sin commit". If `exec` gives back no lines, it's the toast.
- **A crash or a hot reload during a run** leaves that tab's copy in
  `<home>/code-editor/blame/`. Nothing reads it.

**Done when**

- `node --test test/code-file-blame.test.js` reports `fail 0`: it parses what a real
  git prints, a line with no commit included.
- In a committed file, Blame shows an author and a date on each line, and a line typed
  and not saved says "sin commit" while the rest keep theirs.
- In a file git doesn't know, Blame shows the toast and leaves the editor as it was.
- Editar after Blame shows the typed text with the cursor where it was.
