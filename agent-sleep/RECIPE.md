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
    transcript, and a resume command can be built for it. The session file
    can be in `~/.claude` or in any Claude account's folder (see "Which
    accounts" below). Sub-agents, remote terminals, and anything it can't
    verify stay awake.
  - Its prompt is empty. A draft you typed keeps it awake.
- **How it sleeps.** One at a time: it checks everything again and sends
  `/exit`, and the shell comes back. Nothing else in the terminal changes.
- **How it wakes.** When you show its tab, it types
  `CLAUDE_ACCOUNTS_DIR=<its account> claude <your flags> --resume <id>` into
  the shell, exactly once, and a toast says so. It wakes in the account it
  slept in. If you typed something at the shell it waits for you, and if
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
  last event; "Sleep this workspace" with its Sleep button; and Sleep now and
  Wake all. It opens as tall as those lines are then. A line that appears later
  may be cut, never the rows or the buttons. The popup only draws and asks: the
  moon's copy is the one that writes and types.
- **Sleep now** puts every hidden, finished Claude to sleep at once, without
  the wait. **Wake all** resumes every sleeping one, except those of a
  workspace you put to sleep (see below), which wake with it; it is greyed out
  when it has nothing of its own to wake. Both work while automatic sleep is
  off.
- **The workspace's moon.** projects-sidebar also shows one after the label of
  a workspace that is awake with a sleeping Claude (reserved badge key
  `badges.hibernate`). A workspace you put to sleep has projects-sidebar's own
  moon instead.
- **The Agents list's Sleeping section.** projects-sidebar's Agents list ends
  with every Claude asleep, a workspace's ones too, as "space · title" and
  how long it has slept. A click opens its tab, which wakes it. This mod
  publishes that list under `agent-sleep.asleep` (`{ icon, claudes: [{
  address, title, since }] }`, newest first), only when it changes.
- **Sleep a workspace** (the popup's "Sleep this workspace", or
  `agent-sleep.sleep-workspace`; Orca's "Sleep"): every space of the shown
  workspace goes to sleep without closing. projects-sidebar's right-click
  Sleep (a workspace's row, or an agent's in the Agents list) sleeps the one
  it was opened on, shown or not, with `agent-sleep.sleep-workspace.<hex>`,
  the workspace's path as UTF-8 in hex (a command is only a name). Either
  way its tabs, splits, sizes, scrollback and terminal addresses are all
  there when it wakes. It works
  whether automatic sleep is on or off.
  - **Which spaces.** A space belongs to the workspace its first pane with a
    folder is in (else the folder it was made in), as projects-sidebar
    decides. A space with no terminal pane, like Inicio, belongs to none.
  - **It asks first** when any agent it would stop is working (or blocked),
    whatever the agent: a Claude, Codex, or any other that reports its
    status to Herdr. It asks too when a Claude may have text you haven't
    sent. An agent it leaves alone (see below) doesn't count. A dialog in
    the middle of the window, titled with the workspace, says "<N> agents
    are working or may have unsent text. Sleep anyway?" ("1 agent is" for
    one), with Cancel and Sleep. It opens whether
    the popup is open or not. Nothing changes until you answer, and Cancel
    changes nothing; so does closing it any other way (Esc, a click beside it),
    as in Orca. Asking again while it is open replaces it with the new
    question. A hidden line of text gets the probe below; text on a tab you can
    see always counts.
  - **What it does, in order.** Its tabs are put away at once (`tab.settle`),
    so its row shows the moon and projects-sidebar shows Inicio. The stops wait
    until none of its spaces is shown, for up to 3 seconds. Then, one terminal
    a second:
    - a Claude that is working gets `hc interrupt` and has 10 s to finish its
      turn. A draft on its prompt line is cleared with one `ctrl+c`. Then it
      gets `/exit` and resumes like any other, with `wake: "now"` on its record
      when it was working;
    - any other program in front of the shell gets `hc interrupt`, and if it
      is still there 3 s later its process group gets SIGHUP, as closing the
      terminal would send. The shell itself is never signalled;
    - bare shells, sub-agents, remote terminals, terminals whose own program
      isn't a shell, and terminals without a pane are left alone.
    - Last, the tabs an interrupt brought back are put away again.
  - **What stays running.** A Claude that couldn't come back (see "What
    sleeps"), one still working after 10 s, and one whose text didn't clear
    keep running, as does a program a hang-up didn't end. A toast names them:
    "<workspace>: <N> terminals didn't stop".
  - **Waking it** (Orca's click on a sleeping workspace): showing any of its
    spaces, by a click on its row, the picker, an agent's focus or `herdr-app
    do`, wakes all of them. Its tabs come back, each Claude that was working
    when it went to sleep resumes at once, and the others when their tab is
    shown, each in the account it slept in. A space already shown when Herdr
    or the mod starts again isn't a wake: leave it and come back.
  - **Shown again mid-sleep** (a click on its row): its remaining stops are
    dropped, so no `/exit` reaches a Claude you came back to, and it wakes once
    the stops already under way are done.
  - **Still on screen when its stops began** (no Inicio in the layout): it
    stays asleep while you keep looking at it, or move to another of its
    spaces, and wakes once you leave it and come back.
  - **Until it wakes**, showing a tab of it doesn't resume its Claudes, and
    neither does Wake all. Its row has projects-sidebar's moon, and no moon of
    this mod after the label.

**Keys** (projects layout): `cmd-alt-s` Sleep now, `cmd-alt-w` Wake all. Commands
you can bind or run with `herdr-app do agent-sleep.<name>`: `sleep-now`,
`wake-all`, `toggle` (automatic sleep), `less` and `more` (the wait), `panel`
(the popup), `sleep-workspace` (no key, as in Orca; the popup's row runs it),
and `sleep-workspace.<hex>` (a workspace by its path's UTF-8 in hex, what
projects-sidebar's right-click Sleep runs).

**Files:** `<Herdr home>/agent-sleep/settings.json` (`enabled`, `idleMinutes`)
and `sleeping.json` (one record per Claude: session id, folder, flags, its
account's folder, `configDir`, null for `~/.claude`, and the `title` Claude
had when it was stopped, for the Sleeping row). A broken `sleeping.json`
is kept as `sleeping.json.bak`. `workspaces.json` holds the workspaces you put
to sleep, by path: their spaces and tabs, and whether each is still going to
sleep or asleep. A broken one is kept as `workspaces.json.bak`.

**Install:** `scripts/install.sh agent-sleep`. The mod only runs while its moon
is in the shown layout, and projects-sidebar's status bar has it.

**Tests:** `cd agent-sleep && npm test`.

**Watch out**

- **It types into your terminals.** `/exit` into an idle Claude, and the
  resume command into its shell. To tell a prompt suggestion from a draft it
  types one `x`, reads the screen and erases it, only in a tab you can't see.
  If it can't confirm the erase, it doesn't sleep that Claude. With Claude's
  vim mode in normal mode, that `x` deletes a character instead.
- **Which accounts.** A Claude writes its session file in its config dir:
  `~/.claude`, or the `CLAUDE_CONFIG_DIR` it runs with. It sleeps when that
  is `~/.claude`, a saved claude-accounts account's folder
  (`<Herdr home>/claude-accounts/accounts.json`), or a profile folder
  (`<root>/<name>/home` under Orca Dev's and Orca's `claude-profiles`, and
  `<Herdr home>/claude-accounts-profiles`). A Claude with any other
  `CLAUDE_CONFIG_DIR` never sleeps. It only reads claude-accounts' files and
  doesn't need it installed; if their layout changes, fewer Claudes sleep. The
  folders are listed once a minute, so an account added since waits for the
  next check.
- **It wakes in the account it slept in.** The resume starts with
  `CLAUDE_ACCOUNTS_DIR='<its folder>'` (`''` for `~/.claude`), which the
  `claude` launcher (`~/my-mac-scripts/bin/claude`) takes over claude-accounts'
  active account. A named account also gets `CLAUDE_CONFIG_DIR`, so a shell
  without the launcher lands there too. This decides the login (org, usage
  limit, telemetry), not whether the conversation is found: every profile
  shares `~/.claude/projects`. A Claude asleep through an account switch wakes
  on the account it slept in, unlike claude-accounts' `restart` switch mode,
  which moves only running Claudes. Move it afterwards with
  `claude-accounts resume --terminal <t> --account <id>`.
- **An account removed while its Claude sleeps.** That Claude stays asleep and
  the popup says "its account folder is gone": resuming would recreate the
  folder, signed out. Start it yourself in another account.
- **The account prefix and your shell.** `NAME=value claude …` reaches
  `claude` in sh, bash, zsh, dash and ksh, and through a zsh or bash `claude()`
  function. fish needs 3.1 or later (not verified here). A `claude()` function
  in ksh drops the prefix (the launcher then uses the active account), and one
  in `sh` (bash in POSIX mode) leaves it set in that shell afterwards. Without
  the launcher, `''` doesn't unset a `CLAUDE_CONFIG_DIR` your shell exports.
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
- **Sleeping a workspace stops what runs in it.** A program other than Claude
  gets the stop key and then SIGHUP, so an editor with unsaved changes or a
  build is ended as a closing terminal would end it. Claudes that were
  working lose that turn.
- **`/exit` must come from the mod, not from a terminal.** Typed with `hc send`
  from inside a Herdr terminal, it arrives wrapped in `<hc from="…">` and
  Claude reads it as a message. The mod's own `hc` runs from the app, which
  should carry no `HC_TERMINAL_ID`; that is checked live.
- **Which spaces are a workspace's can differ from projects-sidebar's.**
  projects-sidebar takes the deepest checkout you registered, while this mod
  takes the deepest entry of the folder's own `git worktree list`. A space
  inside a git submodule or a repo nested in another can get two answers:
  its row and its sleep may not match. Known, and not fixed.
- **Two Herdr windows on one Core.** Each one showing the moon runs its own
  loop and can type into terminals, so run it in one. `sleeping.json` is
  written with a compare-and-swap before each `/exit` and each resume, so the
  copy whose write comes second drops that step. Nothing covers the rest: the
  probe's `x` is typed before any write, so both can type one, and each copy
  sees only its own window, so a Claude shown only in the other can be stopped.
  A popup's clicks, and a confirm's answer, only reach the window that opened
  it, but the popup's lines can be the other window's.
