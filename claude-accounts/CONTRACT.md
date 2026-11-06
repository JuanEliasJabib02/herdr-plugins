# claude-accounts: the contract for other plugins

Other plugins (the Spotlight plugin first) read which Claude accounts exist,
how much of their limits each has used, which one is active and which one a
Herdr terminal runs, and they can move a terminal to another account. They
share no code with this plugin: they read one file and run one program. This
page is everything a reader or caller codes against; anything not on it can
change without notice.

- **Version 1.** Adding fields keeps `version: 1`, so ignore fields you
  don't know. Renaming or removing a field, or changing what one means,
  bumps `version`.
- **Times** are epoch milliseconds. A **percent** is an integer from 0 to
  100.
- **Accounts** are named by `id`: a saved account's uuid, or `"default"`
  for System default (`~/.claude`, Claude run with `CLAUDE_CONFIG_DIR`
  unset).

## The file: `accounts.v1.json`

`~/.config/herdr-app/claude-accounts/accounts.v1.json`
(`$CLAUDE_ACCOUNTS_HOME/accounts.v1.json` when that is set, for tests).

- It's written to a temporary file and renamed into place, so a reader
  never sees half a file.
- It's rewritten only when something in it changes, and `updatedAt` moves
  only then. Watching the folder doesn't loop when you run the CLI from the
  watch.
- It's refreshed by the plugin's footer every 15 minutes, after every Claude
  turn (the statusline's live limits), and whenever the accounts change. Run
  `claude-accounts usage --refresh --json` for a fresh read.
- Missing means the plugin never ran: `claude-accounts list --json` creates
  it.

### Top level

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | This contract's version. |
| `updatedAt` | epoch ms | When anything in the file last changed. |
| `active` | `"<id>"` or `"default"` | The active account: the one every new Claude terminal starts on. |
| `accounts` | array | System default first, then the saved accounts in the order they were added. |

### Each account

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The account's uuid, or `"default"`. |
| `label` | string | What to show: `"System default"`, or the account's email. |
| `email` | string or null | The email the account was saved with (see `signedInAs` when its folder holds another login); System default's login, null when it has none. |
| `org` | string or null | The organization's name. |
| `configDir` | string or null | Its Claude config folder, the exact `CLAUDE_CONFIG_DIR` its Claude runs with (never normalized). Null for System default. |
| `isDefault` | boolean | True for System default only. |
| `needsSignIn` | boolean | Its login is missing or lapsed, or its folder holds someone else's (`signedInAs`): Claude can't run on this account until you sign in again (the plugin shows "Sign in again"). |
| `error` | string or null | Why the last usage read failed (see Error values below); null when it worked. The last good `usage` stays alongside. |
| `errorDetail` | string or null | The error's own text where the plugin shows it: the server's message for a login without the profile scope (`unavailable`), or an unexpected failure's text (`refreshFailed`). Null otherwise. |
| `usage` | object | `{session, weekly, fable, monthly}`, each a usage window (below) or null when Claude doesn't report it for this account. |
| `credits` | `{balance, limit}` or null | Extra-usage credits, when the account has them. |
| `usageUpdatedAt` | epoch ms or null | When this account's usage was last read; null before the first read. |
| `lastAuthenticatedAt` | epoch ms or null | Its last sign-in. Null when unknown, and for System default. |
| `duplicateOf` | string or null | System default only: the id of a saved account saved with the same email (Orca's "System default is signed in as …, which is also a saved account" notice). Null on every other account. |
| `signedInAs` | string or null | The email its folder is signed in as, when that's another login than the saved one (a `/login` inside its Claude changes it without telling anyone); null otherwise, and always for System default. While it's set the account keeps its `label` and `email`, `needsSignIn` is true, and `usage`, `credits`, `error`, `errorDetail` and `usageUpdatedAt` are empty, because those numbers aren't this account's. |

The windows: `session` is the 5-hour limit, `weekly` the 7-day limit on all
models, `fable` the weekly Fable limit, and `monthly` the monthly spend
limit. When a folder's login changes (System default's too), its windows
empty until it's read again: no number survives from the old login.

### Each usage window

| Field | Type | Meaning |
|---|---|---|
| `percent` | integer 0–100 | How much of the window is used. 100 means the limit is reached. |
| `resetsAt` | epoch ms or null | When the window resets; null when Claude doesn't say. A window whose reset has passed is dropped (the account shows it as null) until it's read again. |

### Error values

| Value | Meaning (the plugin's label) |
|---|---|
| `expired` | The login was refused (HTTP 401 or 403). Usage updates the next time Claude runs. ("Updates when Claude runs") |
| `rateLimited` | The usage endpoint rate-limited this account; the last data is kept. ("Limited") |
| `keychain` | The login couldn't be read from the macOS Keychain. ("Sign-in unavailable") |
| `network` | The request failed on the network. ("Network issue") |
| `refreshFailed` | Any other failed read. ("Refresh failed") |
| `noSubscription` | The account has no Claude subscription. ("No subscription") |
| `unavailable` | The server can't give usage now (5xx, or a login without the profile scope). ("Usage unavailable") |

Treat a value you don't know as `unavailable`.

## The program: `claude-accounts`

Installed at `~/.config/herdr-app/mods/claude-accounts/bin/claude-accounts`
(Node 22.15 or newer). Run it with an argv (a mod's `exec`), never through a
shell string.

- Every command takes `--json`: its result is one JSON value on stdout.
- A failure prints one line on stderr and exits with a code from the table
  below. Exit 0 is the only success.
- No command waits longer than Herdr's 30-second `exec` limit: work that
  takes longer (moving a terminal) runs in a detached process, and the
  command returns a job to follow.

### `list --json`

The `accounts.v1.json` document, rebuilt first (it creates it on the first
run).

### `usage [--refresh] [--account <id>] --json`

Reads usage that is due (each account at most every 5 minutes, later after
failures or a rate limit's Retry-After; `--refresh` reads now, at most every
30 seconds for the active account and every 60 seconds for the others),
merges it, and prints the
`accounts.v1.json` document. `--account` limits the reading to one account;
the output still lists every account. It answers within 15 seconds: an
account whose read hasn't finished by then keeps its last data, and the exit
code is 4. An unknown `--account` exits 7.

### `terminal <t> --json`

The account a Herdr terminal (`t12`, as `hc ls` names it) is running Claude
on:

```text
{"account": "<id>" | "default" | null, "sessionId": "<Claude session id>", "status": "busy" | "idle", "resumable": true | false}
```

It's read live from Claude's own session file (`<configDir>/sessions/<pid>.json`
of the terminal's foreground Claude), never cached, so it holds after a
`/clear`, a restart or a typed `CLAUDE_CONFIG_DIR`. `account` is null when
that session lives in a config folder no account has. A terminal that is
missing or isn't running Claude exits 3; one whose Claude has no session file
yet exits 2. When hc itself fails, it exits 1. `status` is `idle` when
Claude's session file says idle, and `busy` otherwise.

`resumable` is true when the session's transcript exists
(`<configDir>/projects/*/<sessionId>.jsonl`, links followed), so `claude
--resume` can continue it. A Claude that hasn't saved a message yet (just
started, or right after `/clear`) is `resumable: false`; the exit is 0
either way.

To tell "limit" from "error" for a terminal, look its account up in the file:

```sh
cli=~/.config/herdr-app/mods/claude-accounts/bin/claude-accounts
account=$("$cli" terminal t12 --json | jq -r .account)
jq --arg a "$account" '.accounts[] | select(.id == $a) | {usage, error, needsSignIn}' \
  ~/.config/herdr-app/claude-accounts/accounts.v1.json
```

### `use <id|default> --json`

Makes an account the active one, then applies the switch setting (Ask,
Always restart or Never restart) to the Claude terminals still on the
previous one. A terminal on a saved account's folder counts only as that
account. One on System default counts as System default, and also as a saved
account signed in to the same login: both have an org id, the same org and
the same email. A terminal whose restart onto the previous account has
already stopped its Claude counts as on the previous account, whatever it
shows right then: Always restart moves it on to the new one once that
restart ends, and Ask lists it. A terminal with a live `resume` job is left
alone.

```text
{"from": "<id>" | "default", "to": "<id>" | "default", "switchMode": "ask" | "restart" | "keep"}
```

An unknown account exits 7. A saved account whose folder has no login, or
someone else's (`signedInAs`), exits 5 ("Sign in to this Claude account again
before selecting it."). An account whose Keychain login lapsed (its folder
still holds its own login, and `needsSignIn` is true from the last usage
read) is selected, as in Orca, and its card asks you to sign in again, while
`resume` to it exits 5.

### `resume --terminal <t> --account <id|default> [--message <text>] [--wait <s>] --json`

Restarts the Claude in terminal `<t>` on an account, continuing its
conversation (`claude --resume <session>`), then sends `--message` as if you
typed it. It never changes the active account.

- `<t>` is a terminal's address or a name `hc` knows it by. The job is kept
  under its address, so one terminal named two ways gets one job, and
  `--status` reports the address.
- It checks what needs no waiting and fails at once with 2, 3, 5, 7, 8, 11
  or 64, and 1 when hc can't read the terminal. The account comes first:
  an unknown one exits 7 and one that needs sign-in exits 5, even when the
  terminal already has a live job. It exits 2 when the
  terminal's conversation has no transcript yet ("there's no conversation
  to resume yet in terminal <t>: …"), unless the terminal already runs on
  `--account`, where only `--message` is sent.
- Otherwise it queues a job, starts a detached process for it, and exits 0
  in under a second with `{"job": "<id>"}`.
- The job waits for that Claude to be idle (however long it takes), stops
  it, types `CLAUDE_ACCOUNTS_DIR=<folder> claude <its safe flags> --resume
  <session>` in the same shell, waits for the new Claude to be idle (up to
  2 minutes), checks it landed on the account, and sends the message.
- A terminal that already has a live job to the same account gets that
  job's id back (exit 0). A live job to another account exits 11, with
  "terminal <t> already has a live job <job> to <account>: cancel it
  (resume --cancel <job>) or wait for it" on stderr (`<account>` is "System
  default" or the account's email). No second job is queued either way, and
  two `resume` calls at once on one terminal give the same answers.
- A terminal already on the account only gets the message.
- `--wait <s>` (at most 25) waits for the job: it exits with the job's
  final code, or 75 while it's still running. With `--json` it prints the
  same object as `--status`.

### `resume --status <job> --json`

```json
{"job": "<id>", "terminal": "<t>", "account": "<id>" | "default", "state": "<state>", "code": 0, "detail": null, "updatedAt": 1794000000000}
```

| State | Final | Code | Meaning |
|---|---|---|---|
| `queued` | no | | Waiting for its process to pick it up. |
| `waitingIdle` | no | | Waiting for that Claude to be idle. |
| `stopping` | no | | Stopping Claude. |
| `starting` | no | | Typing the resume line and waiting for the new Claude. |
| `sending` | no | | Sending the message. |
| `done` | yes | 0 | Resumed on the account, message sent. |
| `timeout` | yes | 4 | The shell or the new Claude didn't come back in time. |
| `landedElsewhere` | yes | 6 | The new Claude runs on another account. |
| `failed` | yes | 9 | It couldn't go on. `detail` says why, with the `claude --resume <session>` command to run by hand. |
| `cancelled` | yes | 10 | Cancelled before Claude was stopped. |

- A `failed` or `timeout` job's `detail` reads `<why>: <line>`, where
  `<line>` is what to type in that terminal to finish by hand:
  `CLAUDE_ACCOUNTS_DIR=<folder> claude <flags> --resume <session>`.
- `failed` (9) also covers two more cases:
  - right before Claude is stopped, the session has no transcript any more.
    Claude is not stopped, and `detail` is "there's no conversation to resume
    yet in terminal <t>: Claude hasn't saved session <id> (it has no
    messages)", with no line after it;
  - Claude refuses the resume line: the shell is back for 5 seconds with no
    new Claude. `detail` is the last line Claude printed (e.g. "No
    conversation found with session ID: <id>"), or "no new Claude came up
    after the resume line", followed by `: <line to run by hand>`.
- `--status` exits with the job's code once the job is final (0, 4, 6, 9 or
  10), and 0 while it runs. `--wait <s>` works here too.
- An unknown job exits 7.
- Jobs outlive a Herdr restart: they live in the plugin's state folder and
  their process runs outside Herdr.
- A job that isn't final but whose process died reads as `failed` (9), with
  `detail` "runner gone" and the manual command.
- A final job answers `--status` for 24 hours, then it's forgotten (7).
  Keep the final state the first time you see it.

### `resume --cancel <job>`

Cancels a job that hasn't stopped Claude yet; it ends as `cancelled`. Exits
0 when the job ends up cancelled (cancelling twice is fine), 1 when it can't
be cancelled any more (Claude was already stopped, or the job already
ended), and 7 for an unknown job. With `--json` it prints the job's status.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | OK, job accepted, or job done |
| 1 | Any other failure (a state file that can't be read, a failed sign-in); stderr says which |
| 2 | No session id for the terminal, or nothing to resume yet: the conversation has no transcript (Claude hasn't saved a message) |
| 3 | Terminal missing or not running Claude |
| 4 | Timeout |
| 5 | The account needs sign-in |
| 6 | Landed on another account |
| 7 | Unknown account or job id |
| 8 | The terminal can't move (Claude is its own program, no shell to come back to) |
| 9 | Job failed |
| 10 | Job cancelled |
| 11 | `resume`: the terminal already has a live job to another account; cancel it or wait for it |
| 64 | Bad usage: an unknown command or flag, a missing argument (sysexits `EX_USAGE`) |
| 75 | Still running, under `--wait` (sysexits `EX_TEMPFAIL`) |

Codes are only ever added under version 1 (11 came after the first
release, where that case answered 0 with the other account's job). Read a
code you don't know as a failure, as you read 1.

## Not part of the contract

- The other commands (`remove`, `login`, `import-orca`, `settings`,
  `restart`, `details`) serve this plugin's own views; their output can
  change.
- The other files in the state folder (`accounts.json`, `settings.json`,
  `usage-state.json`, `restart.json`, `pending-switch.json`, `live/`,
  `details.json`, `login-link`, `lock/`): read `accounts.v1.json` instead.
- `active` (the active account's config folder, the exact string, empty for
  System default) is read by the `claude` launcher in `~/my-mac-scripts`,
  which starts every new Claude in a Herdr terminal on it. Other plugins
  read `active` from `accounts.v1.json`.
