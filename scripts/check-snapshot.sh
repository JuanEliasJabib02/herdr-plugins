#!/bin/sh
# A task's check on a snapshot (claude-accounts D14, projects-sidebar D19,
# split-tests D7). Parallel tasks share one worktree, so a coder checks HEAD
# plus its own files, never another coder's half-written edits:
#   1. rm -rf odd/check-<task>
#   2. extracts `git archive HEAD` there, adds the untracked files under the
#      top folders of the given files (files no commit has yet: a plugin
#      before its first commit), then the task's own files on top
#   3. runs the suites of those files there, through the snapshot's
#      scripts/test.mjs: each file's top folder, and root for a file in
#      scripts/, in the root test/ or at the root; once each, in the order
#      given. Prints the table that ends the run
#   4. runs scripts/check-views.sh on the snapshot's mod, one line per view
#   5. exits non-zero on the first failure
#
#   scripts/check-snapshot.sh <task> <file>... [-- <view>...]
#   scripts/check-snapshot.sh T3 claude-accounts/mods/claude-accounts/cli/usage.mjs claude-accounts/test/claude-accounts-usage.test.js
#   scripts/check-snapshot.sh T1 claude-accounts/test/claude-accounts-smoke.test.js -- footer popup
#
# The task is letters, digits and dashes. Files are relative to the repo
# root, at least one. Only untracked files are added under those folders:
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

# The suites to run and the folders whose untracked files go in, from the
# given files, each once (space-separated; folder names have no spaces).
suites=
folders=
for f in "$@"; do
  [ "$f" = "--" ] && break
  case $f in
    */*) folder=${f%%/*} ;;
    *) folder= ;;
  esac
  case $folder in
    '' | scripts | test) suite=root ;;
    *) suite=$folder ;;
  esac
  case " $suites " in
    *" $suite "*) ;;
    *) suites="$suites $suite" ;;
  esac
  if [ -n "$folder" ]; then
    case " $folders " in
      *" $folder "*) ;;
      *) folders="$folders $folder" ;;
    esac
  fi
done

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
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  put "$1"
  own=$((own + 1))
  shift
done
[ $# -gt 0 ] && shift
echo "check-snapshot: $task: HEAD $(git rev-parse --short HEAD) + $untracked untracked + $own own file(s) in $snap"

# 3. The suites, in the snapshot: its own runner finds its own repo.
log="$snap/check-snapshot.log"
# Unquoted: one argument per suite.
node "$snap/scripts/test.mjs" $suites > "$log" 2>&1
code=$?
count=0
for s in $suites; do count=$((count + 1)); done
tail -n $((count + 1)) "$log"
[ "$code" -eq 0 ] || fail "a suite failed (exit $code); full output in $log"

# 4. The views, if any.
if [ $# -gt 0 ]; then
  "$repo/scripts/check-views.sh" "$mod" "$@" || fail "a view check failed"
fi
echo "check-snapshot: $task ok"
