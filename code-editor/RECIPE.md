# Code editor

A code editor and Explorer for Herdr, built from how Orca does them. So far:
in the projects layout, `ctrl-l` opens and closes the right panel, the panel
opens on an Explorer block, the whole window wears One Dark Pro, Material's file
and folder icons are in place for the Explorer to draw, and the tab bar knows the
Explorer and draws a file's tab. The Explorer is still a placeholder, and there is
no editor yet.

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
- **Explorer block:** a card with the `background` color, a 1 px `border` and
  radius 10, 12 px of padding, and "Explorer" in `muted` at 13 px.
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
- **Mod `mods/code-explorer/`** (`mod.json` `{ "place": "none" }`): `main.js` is
  the placeholder. It uses Herdr's `theme`, and runs no program and no command.
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
- **`cmd-s` and `cmd-w` do nothing yet:** they are bound for a `code-file` mod
  this plugin doesn't ship so far. So do a file tab's X and double click, which go
  to that same mod.
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
  "Explorer" card and closes it again, and the terminal's screen stays as it was.
- In the projects layout, the terminals' cards are `#282c34` and the canvas
  around them `#1d1f23`.
- With the Explorer open in a space, switching to another space and back shows it
  open again, and the button reads "Explorer" and `⌃L`, `selected` while it shows.
- A tab whose `code-editor.docs` entry has `preview: true`, with a `code-file` pane
  in it, shows its name in italics and its Material icon; with `dirty: true` in
  `code-editor.live` it shows the dot, active or not.
