#!/bin/sh
# A task's check on a snapshot (claude-accounts D14, projects-sidebar D19).
# Parallel tasks share one worktree, so a coder checks HEAD plus its own
# files, never another coder's half-written edits:
#   1. rm -rf odd/check-<task>
#   2. extracts `git archive HEAD` there, adds the untracked files under
#      claude-accounts/ and test/fixtures/ (files no commit has yet: before
#      T1's commit, the whole plugin), then the task's own files on top
#   3. runs the whole suite there (node --test 'test/*.test.js') and prints
#      its last 8 lines
#   4. runs scripts/check-views.sh on the snapshot's mod, one line per view
#   5. exits non-zero on the first failure
#
#   scripts/check-snapshot.sh <task> <file>... [-- <view>...]
#   scripts/check-snapshot.sh T3 claude-accounts/mods/claude-accounts/cli/usage.mjs test/claude-accounts-usage.test.js
#   scripts/check-snapshot.sh T1 test/claude-accounts-smoke.test.js -- footer popup
#
# Files are relative to the repo root. Only untracked files are added under
# those folders: another task's edits to a committed file stay out. The views
# belong to $CHECK_MOD (default claude-accounts/mods/claude-accounts). The
# check-views.sh that runs is this checkout's, so a new one works before its
# commit.
set -u

usage() { echo "usage: scripts/check-snapshot.sh <task> <file>... [-- <view>...]" >&2; exit 64; }
fail() { echo "check-snapshot: $task: $1"; exit 1; }

[ $# -ge 1 ] || usage
task=$1
shift
case $task in
  T[0-9]*) ;;
  *) usage ;;
esac
case $task in
  *[!A-Za-z0-9-]*) usage ;;
esac

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

rm -rf "$snap"
mkdir -p "$snap"
git archive HEAD | tar -x -C "$snap" || fail "git archive HEAD failed"

untracked=0
list=$(git ls-files --others --exclude-standard -- claude-accounts test/fixtures) || fail "git ls-files failed"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  put "$f"
  untracked=$((untracked + 1))
done <<EOF
$list
EOF

own=0
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  put "$1"
  own=$((own + 1))
  shift
done
[ $# -gt 0 ] && shift
echo "check-snapshot: $task: HEAD $(git rev-parse --short HEAD) + $untracked untracked + $own own file(s) in $snap"

# 3. The whole suite, in the snapshot.
log="$snap/check-snapshot.log"
(cd "$snap" && node --test 'test/*.test.js') > "$log" 2>&1
code=$?
tail -n 8 "$log"
[ "$code" -eq 0 ] || fail "the suite failed (exit $code); full output in $log"

# 4. The views, if any.
if [ $# -gt 0 ]; then
  "$repo/scripts/check-views.sh" "$mod" "$@" || fail "a view check failed"
fi
echo "check-snapshot: $task ok"
