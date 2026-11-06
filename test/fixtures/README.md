# Test fixtures

## `claude-accounts/`

A whole state folder of the `claude-accounts` plugin
(`~/.config/herdr-app/claude-accounts/`, or `$CLAUDE_ACCOUNTS_HOME`), one
file per shape the plugin pins. The CLI's writers and the mod's readers
(`store.js`) are both tested against these files, so a change to a shape
starts here. The data is made up: two saved accounts (`ana@example.com`
imported from Orca, `ben@example.org` added in Herdr) plus System default,
which is signed in as the same email as a saved account.

| File | Holds |
|---|---|
| `accounts.json` | the registry: `[{id, email, org, orgUuid, configDir, lastAuthenticatedAt, source}]` |
| `active` | the active account's config dir, the exact string, no newline (empty means System default) |
| `settings.json` | `{switchMode}`: `ask`, `restart` or `keep` |
| `accounts.v1.json` | the published state other plugins read (`claude-accounts/CONTRACT.md`) |
| `restart.json` | switch items and `resume` jobs, one per state worth reading: queued, waitingIdle (claimed), done, failed, timeout, cancelled |
| `pending-switch.json` | an Ask waiting for the confirm view: two sessions `onAccount`, one `elsewhere`, one `cantMove` |
| `details.json` | the details cache: range 7 done, 30 running, 90 failed, `all` never run |
| `login-link` | a captured sign-in URL, no newline |
| `live/5ba6c07f.json` | a statusline drop for `ana@example.com` (the file name is sha256 of its config dir, first 8 hex) |

Times are epoch ms (a statusline drop's `resets_at` is in seconds, as Claude
sends it). "Now" is `1794000000000` (Nov 6 2026, 4:20 PM in Bogota).

## `claude-usage.json`

One `claude-usage --json --last 7` result (usage details & history): every
section, a project whose transcript is gone (`path: null`, named by its
slug), cache figures that start after the range does (`cacheSince`), and
cache figures that cover only part of the range's tokens (`cacheCoverage`
0.7182).
Its token counts add up across `daily`, `byAccount`, `byModel` and
`byProject`.
