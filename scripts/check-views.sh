#!/bin/sh
# Checks each view of a mod with `herdr-app check`. check draws only the view
# a copy gets without props, so each view is checked on a tmp copy of the mod
# whose main.js defaults to it. main.js names its default view in one line,
#   const DEFAULT_VIEW = "<view>";
# and the copy gets that line rewritten. Prints one line per view and stops
# at the first failure, with the end of check's output.
#
#   scripts/check-views.sh <mod folder> <view>...
#   scripts/check-views.sh claude-accounts/mods/claude-accounts footer popup
set -u

usage() { echo "usage: scripts/check-views.sh <mod folder> <view>..." >&2; exit 64; }
[ $# -ge 2 ] || usage
mod=${1%/}
shift
[ -f "$mod/main.js" ] || { echo "check-views: no main.js in $mod" >&2; exit 1; }
grep -q '^const DEFAULT_VIEW = "[^"]*";$' "$mod/main.js" \
  || { echo "check-views: $mod/main.js has no line  const DEFAULT_VIEW = \"<view>\";" >&2; exit 1; }
command -v herdr-app >/dev/null 2>&1 || { echo "check-views: herdr-app isn't on PATH" >&2; exit 1; }

# The copy keeps the mod's folder name: asset paths and overlays use it.
name=$(basename "$mod")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-views.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

for view in "$@"; do
  case $view in
    '' | *[!a-z0-9-]*) echo "check-views: bad view name \"$view\"" >&2; exit 64 ;;
  esac
  # main.js must map it (`  <view>: <Class>,`): a copy with an unknown view
  # draws "no view" and check would still pass.
  if ! grep -Eq "^[[:space:]]+\"?$view\"?:[[:space:]]*[A-Z]" "$mod/main.js"; then
    echo "check-views: $view FAILED (main.js maps no view \"$view\")"
    exit 1
  fi
  copy="$tmp/$view/$name"
  mkdir -p "$tmp/$view"
  cp -R "$mod" "$copy"
  sed "s/^const DEFAULT_VIEW = \"[^\"]*\";\$/const DEFAULT_VIEW = \"$view\";/" "$mod/main.js" > "$copy/main.js"
  if out=$(herdr-app check "$copy" 2>&1); then
    echo "check-views: $view ok"
  else
    code=$?
    echo "check-views: $view FAILED (herdr-app check exited $code)"
    printf '%s\n' "$out" | tail -n 20
    exit 1
  fi
done
