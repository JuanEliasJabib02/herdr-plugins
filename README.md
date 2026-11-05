# herdr-plugins

Orca Pro Max features rebuilt as [Herdr](https://herdr.dev) plugins: layouts
and mods in gpui-kit JS, each in Herdr's sharing format (a folder laid out
like Herdr's home, with a `RECIPE.md` and a `preview.png`).

## Plugins

| Folder | What it does |
|---|---|
| [`projects-sidebar/`](projects-sidebar/) | Replaces Herdr's Spaces list with projects and their workspaces (git worktrees), groups switched with F1–F3, Add project, and a New workspace dialog that can make the same branch in companion repos and give the agent access to them. [Recipe](projects-sidebar/RECIPE.md) |

![Projects sidebar](projects-sidebar/preview.png)

## Install

```sh
git clone https://github.com/JuanEliasJabib02/herdr-plugins
cd herdr-plugins
scripts/install.sh                                # copies projects-sidebar into ~/.config/herdr-app
herdr-app do layout.switch '{"name":"projects"}'  # ctrl-shift-l switches back
```

- `scripts/install.sh` copies the mod and the layout, and never overwrites a
  name it didn't install. It lists what it installed in
  `~/.config/herdr-app/.herdr-plugins/projects-sidebar.txt`. Set
  `HERDR_APP_HOME` for another Herdr home.
- **Keys:** F1–F3 come from the plugin's `keys.json`, which the installer
  merges into yours. It adds only keys you don't use and backs the file up
  first (`keys.json.bak-<time>`). Once your keys.json is edited, Herdr stops
  adding its new default shortcuts to it. In the projects layout, F2 selects
  group 2 instead of renaming the tab. `scripts/install.sh --no-keys` skips
  the merge; then switch groups by clicking, or with
  `herdr-app do projects.group1`.
- **Uninstall:** `scripts/install.sh --uninstall` removes only what the
  install copied. Your keys.json keeps the F1–F3 lines.

## Where workspaces go

New workspaces are git worktrees at `~/orca/workspaces/<repo>/<name>`, on a
branch named like the workspace. Change `WORKTREE_ROOT` in
`projects-sidebar/mods/projects/config.js` to put them elsewhere. The mod runs
`git` in your repos, including `git fetch origin` before creating.

## Develop

```sh
npm test                                              # pure logic, node --test
herdr-app check "$PWD/projects-sidebar/mods/projects" # the mod loads
scripts/install.sh --no-keys                          # copy your edits into Herdr
```

Herdr doesn't load a mod folder that is a symlink, so the installer copies.
After an edit, run it again and Herdr hot-reloads the copy a moment later.
`herdr-app check` draws only the tree view: to check another view, use a copy
whose `main.js` defaults to it.
