# Code editor

A code editor and Explorer for Herdr, built from how Orca does them. In the projects
layout, `ctrl-l` opens and closes a right panel with the Explorer: a file tree with
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
- **The bar's right end:** `+` (26 px, radius 6, `muted`), then 4 px further on,
  buttons 26 px high with radius 6, 12 px text and a 14 px icon: "Changes" if
  picked in Herdr's welcome, and last the toggle "Explorer" with `⌃L`. A button
  whose panel shows is `selected` with `foreground` text; otherwise `muted` on
  `chrome`.
- **Right panel** (`panel`, in projects-sidebar's layout): 368 px wide, 280 to
  900, to the right of the terminals, closed until you open it. It shows one
  block at a time: the Explorer, or Herdr's `changes`.
- **Explorer block:** described under **The Explorer**.
- **Theme:** One Dark Pro on the whole window, terminals and panels alike:
  background `#282c34`, foreground `#abb2bf`, accent `#528bff`, `chrome` and
  `surface` `#21252b`, `canvas` `#1d1f23`, `border` `#3e4452`.

**How it behaves**

- **`ctrl-l`** in the projects layout opens the panel, and closes it again, with
  a terminal focused too. The terminal's program doesn't get the key, so in this
  layout `ctrl-l` no longer clears the screen. Other layouts keep it.
- **The Explorer button** does the same for the Explorer: it opens the panel on
  it, and closes the panel when it shows. "Changes" does so for Changes.
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

- **`keys.json`:** `layout:projects` `ctrl-l` → `layout.toggle:panel`, and
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
  "one-dark-pro"`, the block `tabs` draws `{ "mod": "code-tabs" }`, and the stack
  `panel-body` has `active: "explorer"` with the
  children `explorer` → `{ "mod": "code-explorer" }` and `changes` →
  `{ "mod": "changes" }`. projects-sidebar's `requires` installs this plugin
  first.

**Watch out**

- **`ctrl-l` is taken from terminals** in the projects layout, on purpose. A
  `ctrl-l` you already bind in `layout:projects` stays yours, the install says
  so, and then the key doesn't toggle the panel.
- **Don't put Herdr's `tabs` mod back in this layout.** Its "Files" button selects
  a stack child `files`, which is gone, and its per-space memory of the panel only
  knows `files` and `changes`, so switching spaces closes an open Explorer.
- **The Explorer is always on offer,** whatever `workspace.panels` says: its first
  look in Herdr's welcome leaves an empty list, and `ctrl-l` opens the Explorer
  anyway, so leaving it out would close it at the next change of space.
- **A `<mod>.<command>` reaches only the copy in the shown tab,** so only the active
  tab can be closed from the bar, and an inactive tab's dot doesn't close it.
- **Close in the tab's right-click menu is Herdr's:** it doesn't ask the file.
- **`⌃L` is a fixed label:** with your own `ctrl-l` in `layout:projects` the button
  still works, and the label is wrong.
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
- In the projects layout, `ctrl-l` with a terminal focused opens the panel on the
  Explorer and closes it again, and the terminal's screen stays as it was.
- In the projects layout, the terminals' cards are `#282c34` and the canvas
  around them `#1d1f23`.
- With the Explorer open in a space, switching to another space and back shows it
  open again, and the button reads "Explorer" and `⌃L`, `selected` while it shows.
- A tab whose `code-editor.docs` entry has `preview: true`, with a `code-file` pane
  in it, shows its name in italics and its Material icon; with `dirty: true` in
  `code-editor.live` it shows the dot, active or not.

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
  says nothing if the disk already holds that text.
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
  watches the file's folder with `watchFolder` (every 10 s if that rejects), runs
  `/bin/realpath`, and `test -w` to open a file without write permission read-only.
- **`document-model.js`:** one file as a pure reducer: `diskText` is the next
  `expected`, `baseline` the editor's text at the last load or save, and `dirty` is
  always `value !== baseline`. A rejected save reads the disk and decides by that text,
  never by the error's words.
- **`draft-model.js`:** drafts in `<home>/code-editor/drafts/`, outside `mods/`, which
  the installer replaces. A file named `<hash of realpath>-<doc>-<seq>`, its first line
  JSON `{ path, baseSig, length, at }`, then the text. Writes and deletes share one
  queue; a write goes to a new sequence and only then are older ones removed.
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
