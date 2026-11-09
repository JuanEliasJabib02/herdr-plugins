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

## A busy port before the server starts

Beyond Orca, which neither checks nor frees the port: before typing the server line, Spotlight looks for a process already listening on the port the server will take, and starts nothing while one outside the server terminal's process tree holds it (D23, D24).

- The expected port is the repo's `port` setting when set. Otherwise it comes from `package.json`: the script the command runs, followed through `pnpm|npm|yarn|bun run <s>`, `pnpm|yarn <s>`, `npm-run-all`/`run-p`/`run-s` (globs like `dev:*` included) and `concurrently` (quoted commands and `npm:<s>`), up to three scripts deep. The first `-p N`, `--port N` or `--port=N` on a `next`, `vite`, `astro`, `nuxt`, `remix`, `react-router`, `webpack-dev-server` or `serve` line wins, else a `PORT=N` on it. `pnpm dev` → `npm-run-all --parallel dev:next dev:convex` → `next dev -p 3008` gives 3008. With no port found there is no check. `server-plan.js` `expectedPort` holds the rule.
- The check: `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn`, then the listener's pids against the tree under the server terminal's own process (`pgrep -P`), as the ports of a running server are read. A listener in that tree is Spotlight's own server, so a restart goes ahead. A listener outside it refuses the start:
  - `lastError {code: "port-busy", port, pid, command, cwd, message}`, the message reading "El puerto 3008 lo tiene next-server (v16.0.1) (pid 4242, en /Users/…/speaking-english)." The command comes from `ps -o command=`, cut to 120 characters, and the folder from `lsof -a -p <pid> -d cwd`.
  - A toast with that message whose action opens the server popup, once per holder; a line in the server log; nothing typed. `spotlight on` prints the message under the repo's line and doesn't wait for a port that won't open, and `spotlight restart` and `spotlight env` exit 1 with it.
  - A sync doesn't clear the error. A start that goes through does, and so does a lighting whose server needs no start (see "A root error and a server error").
- The popup shows "Liberar puerto y arrancar" on `port-busy` only. It runs `spotlight restart --repo <root> --free-port`: SIGTERM to the process the error names and to its descendants, up to 5 s for them to go, SIGKILL to the ones left, then a normal start. A note records it ("Puerto 3008 liberado: …").
  - It stops that process only while it still holds that port. If another one took it since, that one is shown and nothing is stopped.
  - It never signals pid 1, nor a process whose tree holds the CLI itself or the server terminal's shell.
- That click is the only path that ever stops a process Spotlight didn't start. Agents get the message; `--free-port` is left out of `spotlight --help` and of the skill.
- The pieces are `ports.js` (`portListeners`, `foreignListener`, `stopProcessTree`) and `cli-work.mjs` (`ensureServer`).

## A server that dies at start

Orca leaves such a server "stopped" with nothing said; here it is an error.

- When the server state is `starting` and the terminal's shell is back at its prompt with no port, the server died at start. The reap and `spotlight on` decide it under the repo lock (a busy lock leaves it for the next reap, so a restart in flight is never taken for a death).
- `server-log.js` reads the log after the last `── Spotlight: … · started: … ──` marker, ANSI stripped:
  - `EADDRINUSE`, "address already in use" or Vite's "Port N is already in use" → `port-busy` (the shape above), naming the process that still listens there, or "El puerto 3008 estaba ocupado al arrancar el server." when none does.
  - A server that found its port taken and moved to another didn't die of it: Next's "Port 3000 is in use, trying 3001 instead." (Next 16: "… is in use by process 4242, using available port 3001 instead.") and Vite's "Port 5173 is in use, trying another one..." are warnings, never `port-busy`. The error line after them decides, an `EADDRINUSE` on the next port included.
  - Anything else → `lastError {code: "server-exited", message: "El server se cayó al arrancar: <first error line>"}` (npm's `> ` echo lines skipped, the last line when no line looks like an error, cut at 160 characters).
- One toast per error, opening the server popup; the popup's first buttons read Ver log (the server terminal) and Reintentar (`restart`); the server badge is red with the message as tooltip. `spotlight on` stops waiting and prints the line.
- A change into `listening` or a start that goes through clears it, and so does a lighting whose server needs no start; a sync keeps it.

## Turning the server off

Turn-off (`toggle` off, Apagar, Apagar igual) always leaves the server dead (D26). Orca stops at the Ctrl-C (`spotlight-server-turn-off.ts:48-65`). Here the Ctrl-C comes first too, and is usually all it takes: live on 2026-11-08, a Next server (script → sh pnpm → pnpm → next → next-server) died whole on it. The rest is a safety net for a child that ignores SIGINT, or one that leaves the tree when the Ctrl-C takes its parent.

- Who a listener is. While the server runs, every read of its state (`server.js` `readServerState`: the reap, `spotlight on`, `status`) also names each process that listens under Spotlight's own `script`: `procs: [{pid, start, port}]`, the start time as `ps -o lstart=` prints it with its runs of spaces folded (`text.js` `oneLine`). The CLI keeps these identities on the repo's record and gives them back to the turn-off. A pid is the same process only while its start time is: compared as `ps` prints it, never parsed. The shell's own helpers and a job put in the background there get no identity, and neither does a process `ps` can't place under the `script`.
- One process records an identity (the reap, `spotlight on`) and another checks it (the detached turn-off), and `lstart` prints in the caller's time zone with words of its locale ("Mon Nov 9 01:58:50 2026" against "lun 9 nov 15:58:50 2026" for the same process). So every `ps` read that records or checks an identity runs with `LC_ALL=C` and `TZ=UTC` (`ports.js` `PS_ENV`, passed as `exec`'s `env`; `locks.js` pins `LC_ALL=C` the same way). Identities recorded before this carry the old locale's and time zone's words: they match nothing, which is the same as a record with no identities, and the next reap or `on` drops them as gone.
- Before the Ctrl-C, `server.js` `stopServer` reads the server:
  - Every process under the server's own process (the `script` Spotlight typed, which leads the terminal), each with its start time and command (`ps -o pid=,ppid=,stat=,lstart=`, `ps -o pid=,command=`). The `script` must be the shell's child and every process below it its parent's child, as `ps` reads them; a pid that changed hands between the reads is left out.
  - The ports those processes listen on, plus the ports recorded for the server and those of its identities.
  - Who else listens on those ports from outside the terminal, but only a process whose pid and start time match one of the recorded identities: a server child that left the tree earlier.
- A server started by hand on one of those ports, in the root or not, is never touched: it has no identity. The same goes for a process that got a recorded pid later (another start time). This holds on every path: with the server running, at a free prompt and with the terminal gone. Only "Liberar puerto y arrancar" (a click, D24) ever stops a process Spotlight didn't start. A record from before identities existed carries none, so its turn-off kills no listener outside the tree; the server's own tree, read from its pid at the turn-off, is killed as always.
- The terminal's shell is no part of the server, and neither are its own helpers (powerlevel10k's gitstatusd, a zsh-async worker, a job put in the background): they are never waited on and never signalled.
- After the Ctrl-C, the stop waits up to 8 s for the prompt to come back and these leftovers to be gone:
  - A process of the server that still runs as the same process (same pid, same start time, not a zombie), wherever it went. One the Ctrl-C reparented to launchd counts, even if it listens on nothing: spotlight-lab's `rama-terca` runs `(trap '' INT TERM HUP; exec sleep 900) &` next to `next dev`, and that `sleep` is killed. A pid another process took since (another start time) is never a leftover.
  - A recorded listener read before the Ctrl-C, outside the terminal, still on one of those ports and running inside the root (`lsof -a -p <pid> -d cwd`). One running outside the root is never a leftover, and neither is one in a folder that only shares the root's name as a prefix.
- When hc can't send the Ctrl-C, the stop doesn't give up and doesn't wait: what it read before is killed at once. The result carries `interruptError`.
- Leftovers still there after the 8 s are killed together with whatever runs under them now: SIGTERM, up to 3 s, then SIGKILL. A zombie counts as gone. Each process's children are read once (`pgrep -P`), however the leftovers' trees overlap.
- The server log says which: "Spotlight off — server stopped (interrupt sent)" or "Spotlight off — server stopped (forced: 2 processes)".
- A failed stop (`ok: false`) always means the server may still be up:
  - `survived`: a process still alive after the SIGKILL (not ours to signal, or stuck in the kernel), or a leftover never signalled because its tree holds the CLI itself or the terminal's shell (`refused`, counted among the survivors). The server did not die (S17). The log says "Spotlight off — server NOT stopped: 1 processes survived (pids 4242)", with "; not signalled: 4242" for a refused one.
  - `unreadable`: hc can't read the terminal, so there is no server pid to read and nothing is signalled.
  - `interrupt-failed`: the Ctrl-C couldn't be sent, and afterwards neither hc nor `ps` showed anything to kill or showed the server gone.
  - `still-running`: its processes were killed, but hc still shows Spotlight's old `script` (its `pid`) in front.
- Any `ok: false` fails the turn-off. The root is restored all the same, the CLI exits 1, and an error toast replaces "Spotlight off — root restaurado". `survived` gives `server-survived`, naming who lived through SIGKILL and who couldn't be signalled. Every other reason gives `server-not-stopped`: "El server no paró al apagar Spotlight: <detalle> (el root sí se restauró)." The detail is Spanish only, one per reason, never `stopServer`'s English message (which says again that the server may still be running): "hc no pudo mandarle Ctrl-C ni leer su terminal", "el proceso 4242 siguió corriendo en su terminal", "hc no pudo leer su terminal", and for a reason the CLI doesn't know yet "Spotlight no pudo confirmar que paró (<reason>)". These two codes are `TURN_OFF_ERRORS` (`server-errors.js`): never stored on a record, only toasted and printed.
- When the stop fails and the restore then refuses too (the root changed during the stop, say), the turn-off reports both in one toast and one line, with the git error's code and exit 1: "<git error>. Además, el server no paró: <detalle>." The record keeps only the git error, the root error the popup acts on.
- The identities live on the record as `serverProcs`: every `procs` the reap and `spotlight on` saw while the repo was lit, across restarts, one per pid and start time, the newest 32 (`cli-work.mjs` `rememberProcs`). A restart keeps them: an old child that escaped holding 3000 while the restarted server moved to 3001 still dies at the turn-off. Before each look merges what it saw, the identities that no longer run as that process (the pid gone, a zombie, or another start time) are dropped, read with one `ps` before the state write (`ports.js` `goneIdentities`; when `ps` can't say, none is dropped). So a watch-mode server that respawns its listener on every save never pushes a live escaped listener out of the 32. `ports` stays what listens now. The turn-off passes `procs: serverProcs` and the live `ports`; `serverSnapshot` adds the ports of the identities itself.
- An identity is a valid pid and a start that is a non-empty string (`ports.js` `isIdentity`), the same rule for what the record keeps and what the turn-off reads.
- With the prompt already free (the server had stopped on its own), or no server terminal at all, nothing is interrupted, but a recorded listener on a recorded port running inside the root is still killed, at once. The result lists it under `escaped` and the log says "(forced: 1 processes)".
- Never killed:
  - The terminal, its shell and the shell's helpers. The terminal stays for the next start, as in Orca.
  - The CLI itself: a leftover whose tree holds it is left alone, and the stop says the server was NOT stopped.
  - Anything that started after the Ctrl-C, such as a restart typed into the terminal during the wait, and any listener Spotlight never recorded, such as a server started by hand in the root. Spotlight's own starts and restarts can't land in the wait anyway: the stop runs under the repo's lock, which every start takes.
- A process Spotlight didn't start in front of the terminal: nothing is sent or killed.
- Every signal goes through the injected `kill` (`deps.kill`, process.kill's shape). `stopServer`, `stopLeftovers` and `stopProcessTree` throw without one; nothing falls back to the real `process.kill`.
- The pieces are `ports.js` (`treeListening`, `serverSnapshot`, `serverLeftovers`, `stopLeftovers`, which share T13's TERM-then-KILL with `stopProcessTree`; `PS_ENV`, `isIdentity`, `goneIdentities`), `server.js` (`readServerState`, `stopServer`) and `cli-work.mjs` (`rememberProcs`, `deactivateRepo`, `turnOffError`).

## A root error and a server error

`lastError` holds one root error (any code but `port-busy` and `server-exited`) and one server error (`SERVER_ERRORS`, `server-errors.js`: `port-busy`, `server-exited`). The root error is on top, with the server error under it as `lastError.serverError`. A turn-off's `server-survived` and `server-not-stopped` are another set, `TURN_OFF_ERRORS`: the record is gone with the turn-off, so they are never on it, and nothing that reads a record (the badges, the popup, `serverDown`, the error stack) ever sees them.

- Writing a root error keeps the server error underneath. Clearing it (a sync, Forzar sync that goes through, or Orca letting go) gives the server error back.
- A lighting that goes through (a takeover, a fresh activation, Proyectar igual) clears both: the server error a last holder left (its dead start, its busy port) says nothing of the new one. Its server decides it again: a start that goes through leaves none, a port still taken writes `port-busy` again (one toast per new error: the same process on the same port doesn't toast again), and a server that needs no start (no command, a variant to pick, the same command already running) leaves none.
- A dead start or a busy port under a root error goes underneath and toasts once. The toast says the root comes first: "<server error> Antes resuelve el root: <root error>", since the popup shows the root error and can't act on the server's until it is resolved. It opens the popup only when the popup can act on that root error (Forzar sync, Apagar igual); under `orca-holds` it opens nothing.
- A listen, or a start that goes through, clears the server error wherever it is.
- `status --json`, the badges, the popup and the hook show the top error; `spotlight on` reports the server error in force.
- Every writer goes through `setRootError`, `setServerError`, `clearRootError` and `clearServerError`. `store.js` `reconcileRepo` writes `lastError` itself, so `cli-work.mjs` wraps it (`underRootError`).

## A root Orca's Spotlight holds

While both apps run, Orca Pro Max's Spotlight can take a root this plugin holds (seen on 2026-11-08: Orca reset the root under Herdr's holder). The two must never fight over it.

- The sign: the root's HEAD is detached on a commit authored exactly "Orca Spotlight" (`git cat-file commit HEAD`). An attached HEAD never counts.
- Turning on, syncing and turning off refuse with `lastError {code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero."}` and leave the root as Orca left it. No `--force` gets past it; the popup shows the message and no Forzar sync, Proyectar igual or Apagar igual.
- The reap's reconcile keeps `orca-holds` instead of flipping it to `root-diverged`, and drops it once Orca lets go (back on our snapshot: cleared; anywhere else: the usual `root-diverged`).
- Not caught: when Orca lit a clean workspace its snapshot is the user's own commit, so the root reads `root-diverged`. Orca's `refs/orca/spotlight/*` would tell, but stale ones stay behind for weeks and would block legitimate turn-offs.
- The pieces are `sync.js` (`orcaHoldsRoot`, checked before every git step of on, sync and off) and `cli-work.mjs` (`reconcileWithOrca`).

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
