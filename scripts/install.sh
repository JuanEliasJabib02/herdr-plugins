#!/bin/sh
# Installs one plugin folder of this repo into Herdr: copies its mods and
# layouts into Herdr's home. Herdr doesn't load a mod folder that is a
# symlink, so these are copies: after editing the repo, run this again and
# Herdr hot-reloads what changed.
#
#   scripts/install.sh [--no-keys] [plugin]   install or update (default plugin: projects-sidebar)
#   scripts/install.sh --uninstall [plugin]   remove only what this installed
#
# Herdr's home is $HERDR_APP_HOME, else ~/.config/herdr-app. What it installed
# is listed in <home>/.herdr-plugins/<plugin>.txt; it never overwrites or
# removes anything else: a name already taken stops the install. The plugin's
# keys.json is merged into <home>/keys.json (new keys only, after a backup)
# unless --no-keys; uninstalling leaves keys.json as it is.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
mode=install
keys=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode=uninstall ;;
    --no-keys) keys=no ;;
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

if [ "$mode" = uninstall ]; then
  [ -f "$manifest" ] || { echo "nothing installed for $plugin"; exit 0; }
  while IFS= read -r item; do
    [ -n "$item" ] && [ -e "$home/$item" ] && rm -rf "${home:?}/$item" && echo "removed $home/$item"
  done < "$manifest"
  rm "$manifest"
  [ -f "$src/keys.json" ] && echo "keys: $home/keys.json keeps the plugin's shortcuts ($src/keys.json); remove them by hand if you want"
  exit 0
fi

# Refuse before touching anything when a name belongs to someone else.
for item in $(items); do
  if { [ -e "$home/$item" ] || [ -L "$home/$item" ]; } && ! owned "$item"; then
    echo "install: $home/$item exists and wasn't installed from $plugin; nothing changed" >&2
    exit 1
  fi
done

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
# Only once every copy succeeded: what an earlier install brought and the
# plugin no longer has.
items > "$manifest.new"
if [ -f "$manifest" ]; then
  while IFS= read -r item; do
    if [ -n "$item" ] && ! grep -qxF "$item" "$manifest.new"; then
      rm -rf "${home:?}/$item" && echo "removed $home/$item"
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
