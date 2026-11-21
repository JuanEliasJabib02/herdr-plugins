#!/bin/sh
# A task's check on a snapshot (claude-accounts D14, projects-sidebar D19,
# split-tests D7). Parallel tasks share one worktree, so a coder checks HEAD
# plus its own files, never another coder's half-written edits:
#   1. rm -rf odd/check-<task>
#   2. extracts `git archive HEAD` there, adds the untracked files under the
#      top folders of the given files (files no commit has yet: a plugin
#      before its first commit), then the task's own files on top
#   3. runs there what `npm run test:changed` would for those files, through
#      the snapshot's `scripts/test.mjs --files`: their suites, and the other
#      suites' test files that read their folders (scripts/install.sh also
#      runs code-editor-install and dia-profiles-install). Prints the table
#      that ends the run, or "nothing to test", which passes
#   4. runs scripts/check-views.sh on the snapshot's mod, one line per view
#   5. exits non-zero on the first failure
#
#   scripts/check-snapshot.sh <task> <file>... [-- <view>...]
#   scripts/check-snapshot.sh T3 claude-accounts/mods/claude-accounts/cli/usage.mjs claude-accounts/test/claude-accounts-usage.test.js
#   scripts/check-snapshot.sh T1 claude-accounts/test/claude-accounts-smoke.test.js -- footer popup
#
# The task is letters, digits and dashes. Files are relative to the repo
# root (a leading ./ is dropped), at least one. A top folder that isn't a
# suite still adds its untracked files. Only untracked files are added under
# those folders:
# another task's edits to a committed file stay out. The views belong to
# $CHECK_MOD (default claude-accounts/mods/claude-accounts). The
# check-views.sh that runs is this checkout's, so a new one works before its
# commit.
set -u

usage() { echo "usage: scripts/check-snapshot.sh <task> <file>... [-- <view>...]" >&2; exit 64; }
fail() { echo "check-snapshot: $task: $1"; exit 1; }

[ $# -ge 1 ] || usage
task=$1
shift
case $task in
  '' | *[!A-Za-z0-9-]*) usage ;;
esac
[ $# -ge 1 ] && [ "$1" != "--" ] || usage

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo" || exit 1
snap="odd/check-$task"
mod="$snap/${CHECK_MOD:-claude-accounts/mods/claude-accounts}"

# Copies one repo file into the snapshot at the same path, mode included
# (bin/claude-accounts is executable).
put() {
  case $1 in
    /* | ../* | */../*) fail "give $1 relative to the repo root" ;;
  esac
  [ -f "$1" ] || fail "no file $1"
  mkdir -p "$snap/$(dirname "$1")" && cp -p "$1" "$snap/$1" || fail "couldn't copy $1"
}

# The given files without a leading ./ ("./keep-awake/x" is keep-awake/x:
# its folder is keep-awake, never "."), the views after the -- as given.
i=$#
in_views=0
while [ "$i" -gt 0 ]; do
  a=$1
  shift
  i=$((i - 1))
  if [ "$in_views" -eq 0 ] && [ "$a" != "--" ]; then
    while :; do
      case $a in
        ./*) a=${a#./} ;;
        *) break ;;
      esac
    done
  else
    in_views=1
  fi
  set -- "$@" "$a"
done

# The folders whose untracked files go in, from the given files, each once
# (space-separated; folder names have no spaces).
folders=
for f in "$@"; do
  [ "$f" = "--" ] && break
  case $f in
    */*) folder=${f%%/*} ;;
    *) folder= ;;
  esac
  case $folder in
    '' | . | ..) continue ;;
  esac
  case " $folders " in
    *" $folder "*) ;;
    *) folders="$folders $folder" ;;
  esac
done

# The snapshot's runner on the given files: "$@" up to its --.
run_tests() {
  i=$#
  while [ "$i" -gt 0 ]; do
    a=$1
    shift
    i=$((i - 1))
    if [ "$a" = "--" ]; then
      shift "$i"
      break
    fi
    set -- "$@" "$a"
  done
  node "$snap/scripts/test.mjs" --files "$@"
}

rm -rf "$snap"
mkdir -p "$snap"
git archive HEAD | tar -x -C "$snap" || fail "git archive HEAD failed"

untracked=0
if [ -n "$folders" ]; then
  # Unquoted: one pathspec per folder.
  list=$(git ls-files --others --exclude-standard -- $folders) || fail "git ls-files failed"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    put "$f"
    untracked=$((untracked + 1))
  done <<EOF
$list
EOF
fi

own=0
for f in "$@"; do
  [ "$f" = "--" ] && break
  put "$f"
  own=$((own + 1))
done
echo "check-snapshot: $task: HEAD $(git rev-parse --short HEAD) + $untracked untracked + $own own file(s) in $snap"

# 3. What --changed would run for those files, in the snapshot: its own
# runner finds its own repo.
log="$snap/check-snapshot.log"
run_tests "$@" > "$log" 2>&1
code=$?
# The lines after the log's last blank one: the table, or "nothing to test".
awk '/^$/ { n = 0; next } { last[++n] = $0 } END { for (i = 1; i <= n; i++) print last[i] }' "$log"
[ "$code" -eq 0 ] || fail "a suite failed (exit $code); full output in $log"

# 4. The views, if any: what follows the --.
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ $# -gt 0 ] && shift
if [ $# -gt 0 ]; then
  "$repo/scripts/check-views.sh" "$mod" "$@" || fail "a view check failed"
fi
echo "check-snapshot: $task ok"
