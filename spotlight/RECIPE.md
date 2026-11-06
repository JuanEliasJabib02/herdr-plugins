# Spotlight for Herdr

Orca Pro Max's Spotlight and test queue as a Herdr plugin. One dev server per repo runs at the repo ROOT, with the code of the workspace that holds the Spotlight projected there. Agents read its logs and restart it with the CLI, and take test turns through a queue: one per space, a global cap, and a pause when the account hits its usage limit.

- The mod is in `mods/spotlight/`. It shows the footer flask, the queue board, settings, the server popup, and the badges on projects-sidebar rows.
- The engine is the `spotlight` CLI, in `mods/spotlight/cli.mjs` and `bin/spotlight`.
- State lives in `~/.config/herdr-app/spotlight/`; logs in `~/.local/state/herdr-spotlight/logs/`.

Being built (ODD plan `odd/tasks/spotlight.md`, kept out of git). Install, verbs and probes get documented here as each task lands.
