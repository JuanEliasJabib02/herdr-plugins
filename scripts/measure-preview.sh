#!/bin/sh
# measure-preview.sh <file.md> | --stop
#
# How much CPU Herdr spends while a Markdown file is open in code-file, in an
# isolated Herdr (home /tmp/mdp: the live one at ~/.config/herdr-app is never
# touched). It starts that Herdr from scratch, installs this checkout's plugins,
# opens a space whose terminal is a fake agent reporting "working", opens
# <file.md> in a code-file tab, brings the test window to the front and samples
# Herdr's CPU with top:
#   source    the file in Source, nothing moving
#   preview   the file in Preview, nothing moving
#   source-scroll / preview-scroll   the same while the wheel scrolls it
#             (Hammerspoon moves the pointer over the window, then puts it back)
# One line each: "<state> cpu <avg>%". The instance stays up for a look;
# --stop ends it. Needs Hammerspoon's `hs` CLI.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
base=/tmp/mdp # short: Herdr's sockets hit SUN_LEN under long paths
app=/Applications/Herdr.app/Contents/MacOS/Herdr
SAMPLES=${SAMPLES:-6} # top readings of 2 s each; the first is dropped

iso() {
  env -i HOME="$base" HC_SESSION=mdp HERDR_APP_HOME="$base/app" HERDR_TELEMETRY=0 DO_NOT_TRACK=1 \
    HERDR_APP_NO_SOUND=1 TERM=xterm-256color \
    PATH="$base/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin" "$@"
}
hs_() { perl -e 'alarm 10; exec @ARGV' hs -c "$1" 2>/dev/null || true; }

# The isolated Herdr's pid: the Herdr process whose environment names $base.
pid_of() {
  for p in $(pgrep -x Herdr || true); do
    if ps eww -p "$p" | grep -q "HERDR_APP_HOME=$base/app"; then echo "$p"; return 0; fi
  done
  return 0
}

stop() {
  iso hc server stop >/dev/null 2>&1 || true
  p=$(pid_of)
  if [ -n "$p" ]; then kill "$p"; echo "stopped $p"; fi
  return 0
}

if [ "${1:-}" = "--stop" ]; then stop; exit 0; fi
[ $# -eq 1 ] || { echo "usage: measure-preview.sh <file.md> | --stop" >&2; exit 2; }
case $1 in /*) file=$1 ;; *) file=$(pwd)/$1 ;; esac
[ -f "$file" ] || { echo "measure-preview: no file $file" >&2; exit 1; }

# From scratch every run: same window, same tabs, no welcome.
stop >/dev/null
sleep 1
rm -rf "$base"
mkdir -p "$base/app"
[ -f "$HOME/.config/herdr-app/seen.json" ] && cp "$HOME/.config/herdr-app/seen.json" "$base/app/seen.json"
printf '{"frame.welcomed":"skipped"}\n' >"$base/app/shared.json" # the welcome's own "seen" mark
iso nohup "$app" >"$base/herdr.log" 2>&1 &
pid=
for _ in $(seq 60); do
  pid=$(pid_of)
  if [ -n "$pid" ] && iso herdr-app status >/dev/null 2>&1; then break; fi
  sleep 1
done
[ -n "$pid" ] || { echo "measure-preview: the isolated Herdr didn't start ($base/herdr.log)" >&2; exit 1; }

iso sh "$repo/scripts/install.sh" --no-keys >/dev/null
sleep 2
iso herdr-app do layout.switch '{"name":"projects"}' >/dev/null 2>&1 || true

# A space whose terminal is a fake agent that says "working" (OSC 7501) and stays.
cat >"$base/fake-agent.sh" <<'EOF'
#!/bin/sh
printf '\033]7501;app=fake:state=working\007'
while :; do sleep 60; done
EOF
chmod +x "$base/fake-agent.sh"
iso herdr-app do space.new "{\"name\":\"md\",\"folder\":\"$repo\",\"argv\":[\"$base/fake-agent.sh\"]}" >/dev/null
sleep 2
iso herdr-app do tab.new --name "md-$(basename "$file")" --mod code-file --props "{\"file\":\"$file\"}" >/dev/null
iso herdr-app do tab.select '{"index":2}' >/dev/null
sleep 4

# The test window in front while it measures (a covered window draws nothing),
# then whatever was in front before.
front=$(hs_ 'return hs.application.frontmostApplication():pid()')
restore() { [ -n "$front" ] && [ "$front" != "$pid" ] && hs_ "hs.application.applicationForPID($front):activate()"; return 0; }
trap restore EXIT
hs_ 'hs.alert.show("Herdr de prueba: midiendo el lector de Markdown…", 4)' >/dev/null

cpu() {
  hs_ "hs.application.applicationForPID($pid):activate()" >/dev/null
  sleep 1
  top -l "$SAMPLES" -s 2 -pid "$pid" -stats pid,cpu 2>/dev/null | grep -E "^$pid" | tail -n +2 |
    awk -v l="$1" '{s += $2; n++} END {printf "%-15s cpu %.1f%%\n", l, (n ? s / n : 0)}'
}

# The wheel over the window's content for the whole sample, 3 lines a tick at
# 60 ticks a second, changing direction every 2 s; the pointer goes back after.
scroll() {
  ticks=$(( (SAMPLES * 2 + 2) * 60 ))
  hs_ "hs.timer.doAfter(0, function()
    local w = hs.application.applicationForPID($pid):mainWindow(); if not w then return end
    local f = w:frame(); local saved = hs.mouse.absolutePosition()
    hs.mouse.absolutePosition({ x = f.x + f.w * 0.62, y = f.y + f.h * 0.55 })
    local n, dir = 0, -3
    _G.mdpScroll = hs.timer.doEvery(1 / 60, function()
      n = n + 1
      if n % 120 == 0 then dir = -dir end
      hs.eventtap.event.newScrollEvent({ 0, dir }, {}, 'line'):post()
      if n >= $ticks then _G.mdpScroll:stop(); hs.mouse.absolutePosition(saved) end
    end)
  end)" >/dev/null
}

# A scroll sample says "(didn't scroll)" when the frame 1.5 s into it is the
# frame from before it: the wheel missed (the pointer moved, another window on top).
scrolled_cpu() {
  iso herdr-app shot "$base/before.png" >/dev/null 2>&1 || true
  scroll
  (sleep 2.5; iso herdr-app shot "$base/during.png" >/dev/null 2>&1) &
  shooter=$!
  line=$(cpu "$1")
  wait "$shooter" # only it: the Herdr this script started is a background job too
  if cmp -s "$base/before.png" "$base/during.png"; then echo "$line (didn't scroll)"; else echo "$line"; fi
  sleep 3
}

iso herdr-app do code-file.source >/dev/null; sleep 2
cpu source
scrolled_cpu source-scroll
iso herdr-app do code-file.preview >/dev/null; sleep 2
cpu preview
scrolled_cpu preview-scroll
iso herdr-app shot "$base/shot.png" >/dev/null 2>&1 || true
