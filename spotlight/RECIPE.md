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
- The server popup (`server-view.js`, model `server-view-model.js`) runs the CLI for every control. Proyectar igual runs `light --task <k> --force`, which works inline, through `sh -c 'nohup "$0" "$@" … &'`, so exec's 30 s limit can't cut a lighting short. The argv go in as positional args.
