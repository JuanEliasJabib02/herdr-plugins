# Code editor

A code editor and Explorer for Herdr, built from how Orca does them. So far:
in the projects layout, `ctrl-l` opens and closes the right panel, the panel
opens on an Explorer block, the whole window wears One Dark Pro, and Material's
file and folder icons are in place for the Explorer to draw. The Explorer is
still a placeholder, and there is no editor yet.

**What you see**

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
- The panel's width is kept with the layout's other clicks, by Herdr.
- Nothing here shows an agent's status.

**Built from**

- **`keys.json`:** `layout:projects` `ctrl-l` → `layout.toggle:panel`, and
  `mod:code-file` `cmd-s` → `code-file.save`, `cmd-w` → `code-file.close`. The
  installer merges them into the person's keys.
- **`themes/one-dark-pro.json`:** a Herdr theme file made from Orca's One Dark
  Pro plugin (`stablyai/orca-plugins`, `plugins/one-dark-pro-theme`, its
  `terminal/` and `themes/` files for the Pro variant), MIT, with its license in
  `themes/LICENSE`. The installer copies `themes/*.json` to `<home>/themes/`, and
  the license stays in the repo.
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
  "one-dark-pro"`, and the stack `panel-body` has `active: "explorer"` with the
  children `explorer` → `{ "mod": "code-explorer" }` and `changes` →
  `{ "mod": "changes" }`. projects-sidebar's `requires` installs this plugin
  first.

**Watch out**

- **`ctrl-l` is taken from terminals** in the projects layout, on purpose. A
  `ctrl-l` you already bind in `layout:projects` stays yours, the install says
  so, and then the key doesn't toggle the panel.
- **`cmd-s` and `cmd-w` do nothing yet:** they are bound for a `code-file` mod
  this plugin doesn't ship so far.
- **The tab bar is still Herdr's `tabs` mod.** Its "Files" button selects a stack
  child `files`, which is gone, and its per-space memory of the panel only knows
  `files` and `changes`, so switching spaces closes an open Explorer. `ctrl-l`
  doesn't depend on it.
- **A theme file at that name:** a `themes/one-dark-pro.json` this plugin didn't
  install stops the install with nothing changed. Move it away and install again.
- **The theme picker overrides the layout's theme,** as in any Herdr layout.
- **Installed on its own,** `scripts/install.sh code-editor` brings the theme, the
  mod and the keys, but neither the layout nor the block that draws them.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check
  "$PWD/code-editor/mods/code-explorer"` passes.
- `scripts/install.sh code-editor` leaves `<home>/themes/one-dark-pro.json` and
  `<home>/mods/code-explorer/icons/theme.json`, and `scripts/install.sh
  --uninstall code-editor` removes both.
- In the projects layout, `ctrl-l` with a terminal focused opens the panel on the
  "Explorer" card and closes it again, and the terminal's screen stays as it was.
- In the projects layout, the terminals' cards are `#282c34` and the canvas
  around them `#1d1f23`.
