# Spotlight for Herdr

Orca Pro Max's Spotlight and test queue as a Herdr plugin. One dev server per repo runs at the repo ROOT, with the code of the workspace that holds the Spotlight projected there. Agents read its logs and restart it with the CLI, and take test turns through a queue: one per space, a global cap, and a pause when the account hits its usage limit.

- The mod is in `mods/spotlight/`. It shows the footer flask, the queue board, settings, the server popup, and the badges on projects-sidebar rows.
- The engine is the `spotlight` CLI, in `mods/spotlight/cli.mjs` and `bin/spotlight`.
- State lives in `~/.config/herdr-app/spotlight/`; logs in `~/.local/state/herdr-spotlight/logs/`.

Being built (ODD plan `odd/tasks/spotlight.md`, kept out of git). Verbs and probes get documented here as each task lands.

## Install

From the repo root:

```sh
scripts/install.sh            # projects-sidebar, which requires spotlight: both land, spotlight first
scripts/install.sh spotlight  # spotlight alone
scripts/install.sh --uninstall spotlight
```

- The installer copies `mods/spotlight/` into `~/.config/herdr-app/mods/`, with the CLI inside it, since Herdr doesn't load a symlinked mod. After an edit, run it again and Herdr hot-reloads the copy.
- It links `~/.local/bin/spotlight` to the installed `mods/spotlight/bin/spotlight`, as the plugin's `bin` file asks, so agents, the harness hook and badge clicks run `spotlight` by name. Herdr's exec PATH starts with `~/.local/bin`.
- The mod and the link are both listed in `~/.config/herdr-app/.herdr-plugins/spotlight.txt`. A `~/.local/bin/spotlight` that isn't that link stops the install before anything changes. `--uninstall` removes the mod and the link.
- `bin/spotlight` follows its own links to the mod folder. It runs `cli.mjs` on the `node` found on PATH, else `/opt/homebrew/bin/node`, else `/usr/local/bin/node`.
- The footer is a block in projects-sidebar's layout (D20, the way claude-accounts got its usage block). It shows the flask and is the copy that runs the reaper, badges and auto-sync.
  - The block: `layouts/projects.json` has `status-spotlight` (px 40, `{"mod": "spotlight", "props": {"view": "footer"}}`) in the status row, between `workspace-status` and claude-accounts' usage.
  - `projects-sidebar/requires` lists `spotlight`, so installing projects-sidebar installs this plugin first. Without it, the block shows "spotlight did not load".
  - With another layout shown, no footer copy runs. Its `close` clears `badges.spotlight`, so no stale badge stays, and `spotlight on` still syncs and reaps for agents.

## Server terminal probe

Probed 2026-11-06 against Herdr's hc, on a throwaway terminal `sl-probe` (created and removed each time). `mods/spotlight/server.js` relies on what it showed.

- The server line runs on the shell's Node. Typed into a `zsh -l` terminal, `script -F -q -a <log> /bin/zsh -c '…'` resolved `node` to the same nvm Node as `command -v node` outside it (v24.14.0), not Homebrew's.
- The log file keeps everything. After `seq 1 500` it held all 500 lines. After `seq 1 50000` it held all 50,000, written as they were printed. Lines end in CRLF, so strip `\r` before counting with `grep -x`: BSD grep miscounted one line.
- `hc read` is only a fallback. `hc read <t> --lines 600` returned all 500 lines. With 50,000 lines printed, `--lines 100000` returned only the last ~2,640, with `complete: false`. So `spotlight logs` reads the file, and uses `hc read` only when the file is missing.
- Ownership. While the server runs, `hc get --json` shows `foreground.argv = ["script","-F","-q","-a","<log>","/bin/zsh","-c","<line>"]`, with `name: "script"` and its own pid. With the prompt free, `foreground.pid` equals the terminal's `pid` (the `zsh -l`).
- Ports. The process tree is zsh -l → script → the server: zsh's `-c` execs the last command. `pgrep -P` walks it from the terminal's `pid`, and `lsof -F pcn` lists the listening socket under the server's pid.
- Interrupt. `hc interrupt` sent ctrl+c and answered `"outcome": "stopped"`, but `script` was still the foreground on the next `hc get`; the prompt came back a moment later. Restart and stop therefore poll for the prompt before typing again. The server log shows `^C`.
- hc's answers:
  - `hc get` of a missing terminal exits 3 with `{"error":{"kind":"not_found"}}`.
  - Running a second live terminal under a taken name exits 1 with `name_taken`.
  - `hc send` to a finished terminal exits 11 with `finished`.
  - After `hc kill`, the terminal reads `state: "finished"`, `reason: "killed"`, with no `foreground`. `hc get <name>` still finds it until `hc rm`, so `server.js` removes a finished server terminal before creating a new one.
  - `hc run --json` prints the new terminal's `address`.

## Badge command probe

Probed 2026-11-06 in Herdr 0.1.13, with a throwaway mod (`zz-sl-cmd-probe`, `{"place":"none"}`, shown as a `kind: "window"` overlay through `mod.open`, then closed and its folder removed). `badges.js` relies on what it showed.

- Dynamic command names reach `nextCommand()`. `herdr-app do zz-sl-cmd-probe.server.0a1b2c3d4e5f` from a shell, and `run("zz-sl-cmd-probe.server.fedcba987654")` from inside a mod (what projects-sidebar's badge click does), both arrived. `nextCommand()` yielded `server.0a1b2c3d4e5f` and `server.fedcba987654`: the name without the mod's prefix, dots kept. So the server badge uses `{ "command": "spotlight.server.<id>" }`, and D17's exec fallback (`ui.request` in state.json) isn't needed.
- With no shown copy, Herdr refuses the command (`unknown command "…": a mod's are <mod>.<command> and need the mod loaded`) and doesn't queue it: a copy opened afterwards got nothing. So the server badge and the error toasts open the popup only while the footer copy is in the layout (D20).
- What remains: Herdr's `seen.json` keeps the probe's name, as it keeps every mod folder it has seen.

## Badges, auto-sync and the server popup

- `badges.js` (footer copy only) publishes `badges.spotlight` per projects-sidebar's contract: a flashlight (amber on the holder's and the root's rows, dim on the other worktrees of an enabled repo, red on an error), the server (`:3000`, `:3000+1`, `…`, red when stopped or gone) and the queue state (flask, clock + `#N`, pause), at most three per row, written only when the value changes. The model is `badges-model.js`.
- The server badge's id is the first 12 hex chars of sha1(workspace path), the same id the CLI puts in its error toasts' action (`cli-work.mjs` serverId). `badges-model.js` computes SHA-1 itself, so the id doesn't depend on the runtime's crypto.
- `autosync.js` watches each holder's folder. It drops batches made only of Orca's ignored folders (`.git`, `node_modules`, `dist`, `build`, `.next`, `.cache`, `target`, `.venv`, `__pycache__`) and test output (`test-results`, `playwright-report`, `blob-report`, `coverage`), at any depth. After 300 ms of quiet it runs `spotlight sync --repo <root> --detach`. The filter is `watch-filter.js`.
- Env: the settings dialog's env is the repo's default; `spotlight env --env <e>` (the popup) stores an override on the repo's state record until `toggle` off. The effective env is the override, else the setting; when it differs from what runs, the server restarts on the next `on` or sync (the reap spawns one, only for Spotlight's own server). When that restart fails, a toast says so, the popup says which env didn't start and marks the one still running, and the reap doesn't try that env again until the settings are saved after the failure; `on`, a sync or Reiniciar always do. A repo waiting in `needs-variant` applies a changed env when its variant is picked.
- Turn-off (`toggle` off, Apagar, Apagar igual) never destroys an untracked root file in the way of a path it writes (the original commit's files, or those of the root's uncommitted changes saved at turn-on), gitignored files included. It looks on disk, without walking ignored folders like node_modules: a file at that path, a file where the path needs a folder, a folder where it needs a file, or, on a case-insensitive disk, a name that differs only in case. Before the reset it commits them, through a temp index, to `refs/herdr-spotlight/rescued/<time>-<sha>`, a ref on no branch that stays after the turn-off. After the restore it writes back on top, unstaged, each one whose exact path is a file of the original commit, so the file keeps its content and reads as an edit of the original. The others are saved and announced but not written back: where the root's own saved changes bring a version of that path (theirs wins), a file/folder conflict, or a case-only name. A toast names the files and the ref, with `git show <ref>:<archivo>` for the ones not written back. A turn-off that fails after saving them names the ref in its error and leaves `refs/herdr-spotlight/rescued-pending`; the next turn-off adds those files to its own save, writes them back and announces them. A fresh activation (not a takeover) drops a pending ref left behind; its ref under `rescued/` stays. A nested git repo in the way (inside a folder there, the folder itself, or above the path) refuses the turn-off with `untracked-collision` before anything is written, since the save could only hold it as a gitlink, and the popup then offers Apagar igual, which discards it, saves the rest and names it in a toast. On a diverged root the `root-diverged` refusal names it too. A submodule of the original commit doesn't refuse: the reset leaves it as it was. Orca has no such guard: its turn-off overwrites them.
- The server popup (`server-view.js`, model `server-view-model.js`) runs the CLI for every control. Proyectar igual runs `light --task <k> --force`, which works inline, through `sh -c 'nohup "$0" "$@" … &'`, so exec's 30 s limit can't cut a lighting short. The argv go in as positional args.

## Continuar and auto-resume

When an agent's turn ends in an error, a sign-in prompt or a usage limit, its request is paused in place (D13). Continuar picks it up again, like Orca. The rules are `resume.js` (pure, shared by the board and the CLI); the CLI side is `cli-resume.mjs`.

- `spotlight continue --terminal <t> [--account <id>]` opens the resume window (3 min) under the state lock, starts a detached `continue --inline` and returns at once. A second Continuar while the window is open, or while the plugin's job runs, reuses it.
  - A paused agent, with the claude-accounts plugin: a fresh `claude-accounts usage --refresh`, then the account with the lowest peak under 100% over session, weekly, fable and monthly (the active one wins a tie; accounts that need a sign-in, carry an error or have no known usage never win), then `claude-accounts resume --terminal <t> --account <id> --message "Continue where you left off." --json`. Every account full: "Vuelve a las <hora>", the earliest of each account's latest full-window reset.
  - A paused agent without the plugin: the message is typed into the same agent (`hc send`).
  - An idle holder (the board's flagged testing row): Esc, then the message, in the same account. It keeps its turn; the Esc's turn end is spent.
  - A `signin` pause is never switched to another account: the board offers Inicia sesión, which runs `claude-accounts.open-accounts`.
- The reap (and `on`, `off`) polls `claude-accounts resume --status <job>` while the job lives, which keeps the window open. Its final state is cached on the request the first time it is seen, so a job the plugin forgets after 24 h (exit 7) changes nothing.
  - `done`: the pause ends, and the request asks for its place back at the front of the line, granted when its repos are free. The turn count is re-baselined, so the resumed session's first turn end is decided like any other.
  - `timeout`, `landedElsewhere`, `failed` (its `detail` carries the manual `claude --resume <sid>`) and `cancelled`: the agent stays paused with that text on its board row, and the window closes.
  - A terminal that left inside the window is released when the job settles, if the job failed or the terminal is still gone.
- Auto-resume (settings, off by default): the reap starts `continue --auto` for `limit` pauses only, at most 3 delivered in a row. With no account left it tries again 60 s after the first reset. Each delivered one leaves a toast, "Reanudado con <cuenta>: <tarea>".
- `spotlight classify --terminal <t>` is spawned by the reap when a turn end needs the account's usage and the usage in `accounts.v1.json` is over 2 min old. It refreshes the usage, then releases the turn or pauses it (`limit`, `signin`, `error`). A classify that died, failed to spawn or got stuck (no answer in 90 s) is spawned again, up to 3 times per turn; after that the reap decides with the last usage it read.
- An `accounts.v1.json` whose `version` isn't 1 is refused: Continuar says so, and turn ends are decided as without the plugin.
- Spotlight never runs `claude-accounts use`, since that changes the global active account.

## Terminals with no task

A Herdr terminal on a main checkout or a non-git folder (or a worktree whose branch and folder can't name a task) still gets a test turn: `spotlight on` takes a slot-only turn keyed `cwd:<realpath>`, so two terminals in one folder share it, in the group holding its repo, else `spaceless`. It lights nothing. `on` with no `--terminal` and no `$HC_TERMINAL_ID` exits 2.

A `spotlight on` typed in a plain shell records the shell's pid as the agent, so the prompt coming back doesn't release the turn. A wrapper (`sh -c 'spotlight on; …'`, `make`) records the wrapper's pid and still releases when it ends.
