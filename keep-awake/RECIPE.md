# Keep awake

Orca's "Keep computer awake" for Herdr: a coffee cup in projects-sidebar's
status bar, right before agent-sleep's moon, that keeps the Mac from going to
sleep while you want it to.

**Off until you pick a mode:** installing projects-sidebar installs this too,
and it does nothing until you choose On or Agent in the popup the cup opens.

**How it behaves**

- **The popup.** Click the cup. At the top, "Keep computer awake" and, at its
  right, the mode and whether it is holding the Mac awake right now
  ("On · Active", "Agent · Inactive", "Off · Inactive"). Under them, the three
  modes, with a dot next to the one in use:
  - **On**: "Keep this computer awake continuously".
  - **Agent**: "Stay awake while an agent is working".
  - **Off**: "Allow normal system sleep behavior".
  Picking one closes the popup. The mode is shared by every Herdr window and
  survives a restart.
- **When an agent counts as working.** Agent mode holds the Mac awake while at
  least one terminal's agent reports `working`, in any space. An agent waiting
  for your answer or a permission (`blocked`), or one that finished (`done`,
  `idle`), doesn't: the Mac may sleep while it waits for you. The moment the
  last one stops working, the Mac sleeps on its normal schedule again.
- **How it holds the Mac awake.** It runs `/usr/bin/caffeinate -i -s -w <Herdr's
  pid>`, the same flags Orca uses: no idle sleep, no system sleep while on
  power, and it ends when Herdr ends. The screen may still turn off, and
  closing the lid still puts the Mac to sleep. `pmset -g assertions` lists it
  under `caffeinate`.
- **One for every window.** Each projects window has a cup, but they share one
  `caffeinate`, whose pid is in `~/.config/herdr-app/keep-awake/caffeinate.pid`.
  Closing a window lets it go and another window's cup starts it again within
  15 seconds; the same if it dies. If it can't start, it tries again after 30.
- **Only while the cup is shown.** The cup is what runs it: switch to a layout
  without it and the `caffeinate` is let go, so the Mac sleeps as usual
  whatever the mode, until the projects layout is back.
- **The cup.** The mode's name, and a dot that is bright while it holds the
  Mac awake and dim while it doesn't. Its tooltip says the same, and that the
  lid still sleeps the Mac.
- **macOS only.** On another system the cup shows the mode and never holds
  anything.

**Install**

`scripts/install.sh projects-sidebar` installs it with the layout (it is in
`projects-sidebar/requires`). On its own: `scripts/install.sh keep-awake`, and
then a block `{"mod": "keep-awake"}` in a layout's status row runs it.
