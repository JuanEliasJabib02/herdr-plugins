# Spotlight for Herdr

Orca Pro Max's Spotlight and test queue as a Herdr plugin. One dev server per repo runs at the repo ROOT, with the code of the workspace that holds the Spotlight projected there. Agents read its logs and restart it with the CLI, and take test turns through a queue: one per space, a global cap, and a pause when the account hits its usage limit.

- The mod is in `mods/spotlight/`. It shows the footer flask, the queue board, settings, the server popup, and the badges on projects-sidebar rows.
- The engine is the `spotlight` CLI, in `mods/spotlight/cli.mjs` and `bin/spotlight`.
- State lives in `~/.config/herdr-app/spotlight/`; logs in `~/.local/state/herdr-spotlight/logs/`.

Being built (ODD plan `odd/tasks/spotlight.md`, kept out of git). Install, verbs and probes get documented here as each task lands.

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
