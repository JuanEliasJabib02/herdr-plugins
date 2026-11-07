#!/bin/sh
# Installs one plugin folder of this repo into Herdr: copies its mods and
# layouts into Herdr's home. Herdr doesn't load a mod folder that is a
# symlink, so these are copies: after editing the repo, run this again and
# Herdr hot-reloads what changed.
#
#   scripts/install.sh [--no-keys] [--alone] [plugin]   install or update (default plugin: projects-sidebar)
#   scripts/install.sh --uninstall [plugin]             remove only what this installed
#
# Herdr's home is $HERDR_APP_HOME, else ~/.config/herdr-app. What it installed
# is listed in <home>/.herdr-plugins/<plugin>.txt; it never overwrites or
# removes anything else: a name already taken stops the install. The plugin's
# keys.json is merged into <home>/keys.json (new keys only, after a backup)
# unless --no-keys; uninstalling leaves keys.json as it is. A plugin's
# `requires` file names other plugin folders of this repo that it needs
# beside it; they are installed first, unless --alone. A plugin's `bin` file
# names executables of its mods to put on PATH: each is linked as
# ~/.local/bin/<its name> to the installed copy, listed in the manifest like
# the rest, and a name there that isn't such a link stops the install too.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
mode=install
keys=yes
alone=no
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode=uninstall ;;
    --no-keys) keys=no ;;
    --alone) alone=yes ;;
    -*) echo "install: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
plugin=${1:-projects-sidebar}
src="$repo/$plugin"
manifest="$home/.herdr-plugins/$plugin.txt"

[ -d "$src" ] || { echo "install: no plugin folder $src" >&2; exit 1; }
[ -d "$home" ] || { echo "install: no Herdr home at $home (set HERDR_APP_HOME)" >&2; exit 1; }

# What the plugin brings: each mod folder and each layout file (json, svg, png).
items() {
  for d in "$src"/mods/*/; do [ -d "$d" ] && echo "mods/$(basename "$d")"; done
  for f in "$src"/layouts/*; do [ -f "$f" ] && echo "layouts/$(basename "$f")"; done
  return 0
}

owned() { [ -f "$manifest" ] && grep -qxF "$1" "$manifest"; }

# Commands on PATH: links in ~/.local/bin to the installed copy, so agents,
# hooks and Herdr's exec (whose PATH starts with ~/.local/bin) find them.
# The manifest lists a link by its absolute path; the rest are relative to
# Herdr's home.
bindir=${HOME:+"$HOME/.local/bin"}
home_abs=$(cd "$home" 2>/dev/null && pwd) || home_abs=$home

# Removes one manifest line: an item of Herdr's home, or a command's link,
# only while it is still a link into this home (a file or a link someone put
# there since stays, named).
drop() {
  case $1 in
    /*)
      to=$(readlink "$1" 2>/dev/null || true)
      case $to in
        "$home_abs"/*) rm -f "$1" && echo "removed $1" ;;
        *) if [ -e "$1" ] || [ -L "$1" ]; then echo "kept $1: it no longer links into $home_abs" >&2; fi ;;
      esac
      ;;
    *)
      if [ -e "$home/$1" ]; then rm -rf "${home:?}/$1" && echo "removed $home/$1"; fi
      ;;
  esac
}

if [ "$mode" = uninstall ]; then
  [ -f "$manifest" ] || { echo "nothing installed for $plugin"; exit 0; }
  while IFS= read -r item; do
    [ -z "$item" ] || drop "$item"
  done < "$manifest"
  rm "$manifest"
  [ -f "$src/keys.json" ] && echo "keys: $home/keys.json keeps the plugin's shortcuts ($src/keys.json); remove them by hand if you want"
  exit 0
fi

# The commands the plugin's `bin` file lists, one per line (# comments): a
# path to an executable file inside one of its mods, linked under its file
# name. A line that isn't one, or a name an earlier line took, is named and
# skipped. Prints the paths that pass, one per line.
commands() {
  [ -f "$src/bin" ] || return 0
  names=" "
  while IFS= read -r entry || [ -n "$entry" ]; do
    entry=$(printf '%s' "${entry%%#*}" | tr -d '[:space:]')
    [ -n "$entry" ] || continue
    case $entry in
      mods/*/*) bad=no ;;
      *) bad=yes ;;
    esac
    case $entry in
      *[!A-Za-z0-9._/-]*|*//*|*/.*|*/) bad=yes ;;
    esac
    if [ "$bad" = yes ]; then
      echo "bin: $entry isn't a file of the plugin's mods; skipped" >&2
      continue
    fi
    if [ ! -f "$src/$entry" ] || [ ! -x "$src/$entry" ]; then
      echo "bin: $entry isn't an executable file of the plugin; skipped" >&2
      continue
    fi
    name=${entry##*/}
    case $names in
      *" $name "*) echo "bin: $entry: a command named $name is already listed; skipped" >&2; continue ;;
    esac
    names="$names$name "
    echo "$entry"
  done < "$src/bin"
}
cmds=$(commands)
if [ -n "$cmds" ] && [ -z "$bindir" ]; then
  echo "install: HOME isn't set, so there's no ~/.local/bin for $plugin's commands; nothing changed" >&2
  exit 1
fi

# Refuse before touching anything when a name belongs to someone else: an
# item, or a command's link that isn't already this install's (a link to the
# installed copy).
for item in $(items); do
  if { [ -e "$home/$item" ] || [ -L "$home/$item" ]; } && ! owned "$item"; then
    echo "install: $home/$item exists and wasn't installed from $plugin; nothing changed" >&2
    exit 1
  fi
done
for entry in $cmds; do
  link="$bindir/${entry##*/}"
  if { [ -e "$link" ] || [ -L "$link" ]; } && [ "$(readlink "$link" 2>/dev/null || true)" != "$home_abs/$entry" ]; then
    echo "install: $link exists and wasn't installed from $plugin; nothing changed" >&2
    exit 1
  fi
done

# What the plugin needs beside it, installed after its own names pass the
# check above (a refused install changes nothing) and before its own copy: its
# `requires` file, one plugin folder of this repo per line (# comments).
# projects-sidebar's layout draws claude-accounts' and spotlight's footers,
# and a block whose mod isn't installed shows "<mod> did not load". Each runs
# once per install (HERDR_PLUGINS_SEEN breaks a loop); one this repo doesn't
# have is named and skipped. --uninstall never removes them: another plugin
# may use them.
if [ "$alone" = no ] && [ -f "$src/requires" ]; then
  seen=" ${HERDR_PLUGINS_SEEN:-} $plugin "
  while IFS= read -r dep || [ -n "$dep" ]; do
    dep=$(printf '%s' "${dep%%#*}" | tr -d '[:space:]')
    [ -n "$dep" ] || continue
    case "$dep" in
      .*|*[!A-Za-z0-9._-]*) echo "requires: $dep isn't a plugin name; skipped" >&2; continue ;;
    esac
    case "$seen" in *" $dep "*) continue ;; esac
    seen="$seen$dep "
    if [ -d "$repo/$dep" ]; then
      echo "requires: installing $dep"
      if [ "$keys" = no ]; then
        HERDR_PLUGINS_SEEN="$seen" sh "$repo/scripts/install.sh" --no-keys "$dep"
      else
        HERDR_PLUGINS_SEEN="$seen" sh "$repo/scripts/install.sh" "$dep"
      fi
    else
      echo "requires: $dep isn't in this checkout; install it on its own"
    fi
  done < "$src/requires"
fi

mkdir -p "$home/.herdr-plugins" "$home/mods" "$home/layouts"
# A run that stops partway leaves nothing half-written: the item being copied
# and an unswapped manifest go on any exit, and those a killed run left
# behind go before copying.
installing=
cleanup() {
  [ -z "$installing" ] || rm -rf "$installing"
  rm -f "$manifest.new"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
for item in $(items); do rm -rf "${home:?}/$item.installing"; done

# Owned as soon as it lands: the manifest becomes the earlier one plus each
# item copied so far, so a run that fails partway never leaves one of its own
# items looking foreign to the next run.
record() {
  { [ ! -f "$manifest" ] || cat "$manifest"; echo "$1"; } | awk 'NF && !seen[$0]++' > "$manifest.new"
  mv "$manifest.new" "$manifest"
}
for item in $(items); do
  # Copy next to it, then swap, so Herdr never reads a half-written mod.
  installing="$home/$item.installing"
  cp -R "$src/$item" "$installing"
  rm -rf "${home:?}/$item"
  mv "$installing" "$home/$item"
  installing=
  record "$item"
  echo "installed $home/$item"
done
# The commands, once the copies they point at are in place. A link already
# pointing there is kept as it is (the check above refused any other).
for entry in $cmds; do
  link="$bindir/${entry##*/}"
  target="$home_abs/$entry"
  if [ "$(readlink "$link" 2>/dev/null || true)" != "$target" ]; then
    mkdir -p "$bindir"
    ln -s "$target" "$link"
  fi
  record "$link"
  echo "linked $link -> $target"
done
if [ -n "$cmds" ]; then
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) echo "bin: $bindir isn't on your PATH; add it to run $(for e in $cmds; do printf '%s ' "${e##*/}"; done)by name" ;;
  esac
fi
# Only once every copy succeeded: what an earlier install brought and the
# plugin no longer has.
{
  items
  for entry in $cmds; do echo "$bindir/${entry##*/}"; done
} > "$manifest.new"
if [ -f "$manifest" ]; then
  while IFS= read -r item; do
    if [ -n "$item" ] && ! grep -qxF "$item" "$manifest.new"; then
      drop "$item"
    fi
  done < "$manifest"
fi
mv "$manifest.new" "$manifest"

# The plugin's shortcuts: merged into the person's keys.json, adding only the
# keys they don't bind (scripts/keys-merge.mjs backs the file up first and
# writes nothing when there's nothing to add). An edited keys.json no longer
# gets Herdr's new default shortcuts on upgrade, so --no-keys skips this.
if [ -f "$src/keys.json" ]; then
  if [ "$keys" = no ]; then
    echo "keys: not merged (--no-keys); the plugin's shortcuts are in $src/keys.json"
  elif command -v node >/dev/null 2>&1; then
    node "$repo/scripts/keys-merge.mjs" "$src/keys.json" "$home/keys.json"
  else
    echo "keys: node isn't installed; add the sections of $src/keys.json to $home/keys.json by hand" >&2
  fi
fi

echo "done: show it with  herdr-app do layout.switch '{\"name\":\"projects\"}'  (ctrl-shift-l switches back)"
