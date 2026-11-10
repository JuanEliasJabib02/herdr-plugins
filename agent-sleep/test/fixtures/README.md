# Fixtures: real screens and Core states (T0 probe)

Captured 2026-11-06 with Claude Code 2.1.318 and Herdr Core (`hc`) 0.1.18 on macOS.
Session ids are replaced with `00000000-0000-4000-8000-…`; scratch paths with
`/tmp/scratch`. Screens are `hc read <t>` tails (plain text, no styling).

## Claude screens (a throwaway Claude in a shell-root terminal, `hc run --bg --no-parent --keep`, then `claude "say ok"`)

| File | What it shows |
|---|---|
| `claude-trust-dialog.txt` | First start in a new folder: the trust dialog. Its own `❯ No, exit` uses the same glyph as the prompt. |
| `claude-fresh-placeholder.txt` | A Claude that was never asked anything: the placeholder `❯ Try "fix lint errors"` (copied from a live idle Claude, not from the probe). |
| `claude-after-turn1.txt`, `claude-after-turn2.txt` | After a turn, read ~6 s after `hc send --wait`: empty prompt line `❯`. |
| `claude-after-turn3.txt`, `claude-after-turn4.txt` | After a turn: a prompt suggestion `❯ reply with the single word ok`. As plain text it is identical to a typed draft. |
| `claude-draft.txt` | A typed draft `❯ hola` (typed with `hc keys`, never sent). |
| `claude-exit.txt` | After `/exit`: Claude's last frame, then `Resume this session with:` / `claude --resume <id>`, then the shell prompt. |

## Claude Code 2.1.319 screens (workspace-sleep's T0b probe, 2026-11-08: a background terminal, `hc` run with `HC_TERMINAL_ID` and `HC_SCOPE` unset)

| File | What it shows |
|---|---|
| `t0b-claude-idle.txt` | After a turn: an empty prompt line `❯` (T0b `03-idle`). |
| `t0b-claude-draft.txt` | A one-line draft `❯ hola` (`04-draft`). |
| `t0b-claude-draft-multi.txt` | A two-line draft (`hola` / `mundo`, made with `ctrl+j`), with Claude's "ctrl+g to edit in Vim" hint above the box (`06-multi`). |
| `t0b-claude-ctrl-c.txt` | The one-line draft after one `ctrl+c`: the line is empty again (`07-ctrl-c`; `esc esc` gave the same). |
| `t0b-interrupt.json` | `hc interrupt <t> --timeout 3 --json` on a working turn: `{"key":"esc","outcome":"stopped"}`; Core read `idle` right after (`10-interrupt`). |

T0b also found: `ctrl+u` clears only the last line of a multi-line draft; one
`ctrl+c` on an empty line leaves Claude running; an interrupt right after a send
puts the prompt back on the input line; on `sleep 300` and `less` the report
(`stopped`, `unknown`) didn't say whether the program was still in front.

## Shell screens (zsh with Starship and zsh-autosuggestions)

| File | What it shows |
|---|---|
| `shell-bare.txt` | A bare prompt: the Starship line, then `❯` alone. Same glyph as Claude's prompt. |
| `shell-typed.txt` | After typing `echo`: zsh-autosuggestions completes it from history as ghost text (`❯ echo "OK $((6*7))" && exit`). Plain text shows the whole line. |

## Core states (a scratch Core: own `HC_SESSION` and XDG dirs, its `core.id` checked against the live one before every stop)

| File | What it shows |
|---|---|
| `core-before.json` | A `--keep` terminal running `sleep 600`. |
| `core-after-server-stop.json` | Right after `hc server stop` + `start`: `reason: "stopped_by_restart"`, `foreground: null`. A few seconds later the same terminal has `argv: ["/bin/zsh","-l"]`, a new root `pid` and `reason: null`. |
| `core-after-holder-lost.json` | After the holder process was killed (crash/reboot stand-in): shell back, new root `pid`, `reason: null`. |

## Findings

- **Suggestions:** 2 of 4 turns left a prompt suggestion on the `❯` line (turns 3 and 4, after a repeated prompt). Plain text can't tell it from a draft.
- **Telling them apart:** typing one character shows the difference. Over a suggestion, `x` gives `❯ x` (the ghost text goes away); over a draft, `❯ holax`. A backspace restores both. This types into the Claude's input for about a second.
- **`hc wait` right after starting Claude with a prompt** returned at once with `status: idle, turn: 0` (startup idle). Wait for `working` first, or use `hc send --wait`.
- **While Claude works**, its prompt line is an empty `❯`. Status, never the screen, says whether it is working.
- **`/clear`** changes `sessionId` in `~/.claude/sessions/<pid>.json`. The new transcript exists right away. `turn` goes up and the Core status is `idle`.
- **`/exit`**: the foreground went back to `zsh` in about 2 s, with the SessionEnd hook installed. The exit screen printed the post-`/clear` id.
- **`procStart`** in the session file equals `TZ=UTC ps -o lstart= -p <pid>` character for character.
- **The session file's `status`** is `idle` while Core reports `done`.
- **Lost terminal:** `reason` doesn't survive. It is set for a few seconds after a server stop, then `null` once the shell is back, and never set after a holder loss. Both cases leave a **new root `pid`** on the same address, and the holder instance in `hc server status --json` changes. A user's own `/exit` keeps the root shell's pid. So the per-terminal signal is the root `pid` (record it in the `live` record), with the holder instance as a second witness.
