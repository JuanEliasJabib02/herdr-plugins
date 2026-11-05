# herdr-plugins

Orca Pro Max features rebuilt as [Herdr](https://herdr.dev) plugins: layouts
and mods written in gpui-kit JS, shared in Herdr's plugin format.

## Plugins

| Folder | What it does |
|---|---|
| [`projects-sidebar/`](projects-sidebar/) | Replaces Herdr's Spaces list with projects and their workspaces (git worktrees), groups switched with F1–F3, Add project, and a New workspace dialog that can create the same branch in companion repos. |

## Install

```sh
git clone https://github.com/JuanEliasJabib02/herdr-plugins
cd herdr-plugins
scripts/install.sh            # copies projects-sidebar into ~/.config/herdr-app
herdr-app do layout.switch '{"name":"projects"}'
```

`ctrl-shift-l` switches back to your layout. `scripts/install.sh --uninstall`
removes only what it installed (listed in `~/.config/herdr-app/.herdr-plugins/`).

## Develop

```sh
npm test                                              # pure logic, node --test
herdr-app check "$PWD/projects-sidebar/mods/projects" # the mod loads
```

Herdr doesn't load a mod folder that is a symlink, so the installer copies.
After editing, run `scripts/install.sh --no-keys` again: Herdr hot-reloads the
copy a moment later.
