# Agent sleep

Puts idle Claude Code terminals you aren't looking at to sleep, the way
Orca's agent hibernation works, and resumes each one when you show its tab.
A Claude holds a few hundred MB while it waits for you. Asleep, only its
shell is left, and its conversation comes back with `claude --resume`.

**Off until you turn it on:** installing projects-sidebar installs this too,
so it does nothing on its own until you switch on "Sleep idle agents" in the
popup the moon opens. That covers coming back after a restart: while off,
nothing keeps track of a running Claude, so one Core loses doesn't come back on
its own.

**How it behaves**

- **What sleeps.** Each minute it looks at every local terminal. A Claude
  sleeps when all of this holds, on two checks in a row with nothing changed:
  - It finished its turn (`done` or `idle`), and that was 30 minutes ago or
    more (the popup's −/+: 1 minute to 24 hours).
  - You haven't had its tab on screen for that long. Showing it restarts the
    wait, and a visible Claude is never stopped.
  - It is a top-level Claude in a kept shell, with a session file and a
    transcript, and a resume command can be built for it. Sub-agents,
    remote terminals, and anything it can't verify stay awake.
  - Its prompt is empty. A draft you typed keeps it awake.
- **How it sleeps.** One at a time: it checks everything again and sends
  `/exit`, and the shell comes back. Nothing else in the terminal changes.
- **How it wakes.** When you show its tab, it types
  `claude <your flags> --resume <id>` into the shell, exactly once, and a
  toast says so. If you typed something at the shell it waits for you, and if
  another program is in front it forgets that Claude.
- **After a restart** (needs automatic sleep on). If Core loses a kept
  terminal (crash, reboot, logout, `hc server stop`), the Claude that was
  running there comes back the same way when you show its tab. A Claude you
  ended yourself doesn't. `hc server restart` keeps programs running, so
  nothing happens.
- **The moon** (last in projects-sidebar's status bar): dim while off, muted
  while on, in the accent color with how many are asleep beside it. Its tooltip
  is the headline, "Agent sleep · 2 asleep · ~620 MB freed".
- **The popup** (a click on the moon): the headline, whose tooltip ("fields:")
  says where it got each terminal's details; "Sleep idle agents"; "After 30
  min" with −/+; why a Claude stays asleep if one does, the next one due, the
  last event; and Sleep now and Wake all. It opens as tall as those lines are
  then. A line that appears later may be cut, never the buttons. The popup only
  draws and asks: the moon's copy is the one that writes and types.
- **Sleep now** puts every hidden, finished Claude to sleep at once, without
  the wait. **Wake all** resumes every sleeping one. Both work while automatic
  sleep is off.
- **The workspace's moon.** projects-sidebar also shows one on a workspace with
  a sleeping Claude (reserved badge key `badges.hibernate`).

**Keys** (projects layout): `cmd-alt-s` Sleep now, `cmd-alt-w` Wake all. Commands
you can bind or run with `herdr-app do agent-sleep.<name>`: `sleep-now`,
`wake-all`, `toggle` (automatic sleep), `less` and `more` (the wait), `panel`
(the popup).

**Files:** `<Herdr home>/agent-sleep/settings.json` (`enabled`, `idleMinutes`)
and `sleeping.json` (one record per Claude: session id, folder, flags). A
broken `sleeping.json` is kept as `sleeping.json.bak`.

**Install:** `scripts/install.sh agent-sleep`. The mod only runs while its moon
is in the shown layout, and projects-sidebar's status bar has it.

**Tests:** `cd agent-sleep && npm test`.

**Watch out**

- **It types into your terminals.** `/exit` into an idle Claude, and the
  resume command into its shell. To tell a prompt suggestion from a draft it
  types one `x`, reads the screen and erases it, only in a tab you can't see.
  If it can't confirm the erase, it doesn't sleep that Claude. With Claude's
  vim mode in normal mode, that `x` deletes a character instead.
- **Only Claudes using `~/.claude`.** A Claude run with another
  `CLAUDE_CONFIG_DIR` (a saved claude-accounts account, for one) writes its
  session file elsewhere, so it never sleeps.
- **Built against Claude Code 2.1.318.** Its session files, its exit screen
  and its resume flags come from that version. If they change, Claudes stop
  sleeping rather than being stopped wrongly.
- **Your shell prompt must end in `❯ › » ➜ λ $ % # >`.** A prompt with text at
  its right, or another ending, reads as a typed line, so the resume keeps
  waiting. Wake it by typing the command.
- **When the mod isn't running** (another layout shown, Herdr closed), nothing
  sleeps and nothing wakes. Records stay, and a sleeping Claude resumes the
  first time its tab is shown once the mod is back.
- **Off doesn't wake anyone.** A Claude already asleep when you turn it off
  still wakes when you show its tab.
- **Two Herdr windows on one Core.** Each one showing the moon runs its own
  loop and can type into terminals, so run it in one. `sleeping.json` is
  written with a compare-and-swap before each `/exit` and each resume, so the
  copy whose write comes second drops that step. Nothing covers the rest: the
  probe's `x` is typed before any write, so both can type one, and each copy
  sees only its own window, so a Claude shown only in the other can be stopped.
