# Claude accounts

Orca's Claude usage and accounts, in Herdr. The sidebar footer shows how much
of its session, weekly and Fable limits the active Claude account has used,
and when each one resets. A popover and a panel show every account. Manage
Accounts signs accounts in, adds and removes them, and picks which one new
Claude terminals start on. When you switch accounts while Claude is running
in terminals, those conversations can restart on the new account. A details
window shows usage by model, project and account over 7, 30 or 90 days or all time.

All the logic is a command-line program, `claude-accounts`, that ships inside
the mod. The mod only draws and runs it. Other plugins (Spotlight first) read
the same files and run the same commands: see [CONTRACT.md](CONTRACT.md).

![Claude accounts](preview.png)

**What you see**

- **Footer** (the sidebar's status row, right of the workspace status): the
  active account's usage,
  `Used [Claude icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable [refresh]`:
  session, weekly and Fable, each with the time left until it resets.
  - Colors: under 60% `muted`, 60–79% `working` (amber), 80% or more
    `blocked` (red).
  - As the column narrows: bars and labels, then one number per window, then
    only the most-used window's number (`--` when there's none). Never the
    icon alone, which would read as all clear.
  - Signed out: "Sign in to see usage" and a **Sign in** action.
  - Click it for the popover; click again to close it.
- **Popover** (above the footer): `Usage`, a refresh button and a
  `Detailed | Compact` toggle for the footer. Then the `Claude` row with
  "Resets in 3h 2m" and its `5h`, `wk` and `Fable` bars (it opens the
  panel), `Usage details & history` and `Manage Accounts…`.
- **Claude panel:** "Claude · Updated 3m ago" (or "Not yet updated"). The
  active account's card: Session, Weekly and Fable, each "N% used · Resets
  in …", plus the monthly spend and credits when the account has them. Then
  the `Other accounts` list: each saved account but the active one, with
  their `wk` and `Fable` bars. System default, the Mac's own login (what
  `claude` uses outside Herdr), isn't listed here or in Manage Accounts
  unless it's the active account. Click one to switch. An
  active account that needs signing in keeps its row, with its ✓, to do it
  from there. An account whose login lapsed says "Sign in again to use this
  account", and its row opens the sign-in tab. One whose folder got someone
  else's login (a `/login` inside its Claude) keeps its saved email and says
  "Now signed in as {login}", with no bars, because those numbers aren't its
  own; its row opens the sign-in tab too. "No other accounts" when there are
  none.
- **Manage Accounts** (a dialog):
  - One row per account: its email, "This device", `org · date` of its last
    sign-in ("Now signed in as {login}" under it when its folder got someone
    else's login), `Sign in again ▾` (its menu: "Copy sign-in link instead")
    and `Remove`. Then `Add account ▾`, with the same menu.
  - Only while System default is the active account: "System default:
    {email}" / "Use your current {email} Claude login.", and Orca's notice
    when it is signed in as an email that is also a saved account.
  - "Switching applies to the next Claude you start in any tab."
  - The setting **When you switch accounts while Claude is running in
    terminals**, "Restarting continues each terminal conversation on the new
    account.": Ask, Always restart or Never restart.
- **Switch dialog** (Ask): "Switched to {account}", the sessions still
  running on the previous account with a checkbox each: each shows its last
  prompt, its terminal's title, and whether it's Working or Idle, live. Then "Don't ask again
  (restart automatically)", **Keep as is** and **Restart N sessions**.
- **Toasts:** "Restarting N Claude sessions on {account}", "N other sessions
  weren't moved." with **Review**, a terminal waiting for idle, a restart
  that failed with the `claude --resume <session>` command to run by hand,
  "Claude in … is asking a question" with the question a restarted Claude
  stopped at, and "Sign-in link copied. Open it in a private window to sign
  in with a different account."
- **Usage details & history** (a window): 7, 30 or 90 days or all time.
  Orca's eight cards: input and output tokens, cache read, cache write, cache
  reuse rate, zero-cache-read turns, sessions / turns, and the estimated
  API-equivalent cost ("• excludes unpriced models" when some model has no
  price); then total tokens and active time. Each group of figures says
  "since <date>" when the range starts before its data does, with a note of
  the share of tokens it covers when some sessions are gone from disk. Usage
  by model and by project (sessions and turns) and by account; recent
  sessions in Orca's columns (turns, input, output, cache), with the account
  and length on hover; a daily chart; and how often and how fast each account
  hits its 5-hour and weekly limits. A figure an older claude-usage doesn't
  print reads "n/a". Opening it, picking a range or Refresh reads that range
  again; the last result stays, with "Updated Xm ago", until the new one
  lands. Orca's "Orca worktrees only" scope and share card aren't ported.

**How it behaves**

- **Accounts.**
  - System default is `~/.claude`, the login Claude uses with no
    `CLAUDE_CONFIG_DIR`.
  - A saved account is a Claude config folder with its own login in the
    macOS Keychain. Orca's accounts are imported the first time, in place
    (they're never moved, which would mean signing in again), along with
    Orca's active account and switch setting. `claude-accounts import-orca`
    imports again: the Orca accounts added since, and fresh emails, orgs
    and sign-in dates. It never changes the active account or the switch
    setting.
  - **Add account** makes a new folder under
    `~/.config/herdr-app/claude-accounts-profiles/`, sharing your
    `~/.claude` settings, skills, agents, commands and history through
    symlinks, with a copy of `~/.claude.json` minus its login and every
    account-bound key (as Orca does). It's kept only when the sign-in
    succeeds with an email and org that aren't saved yet; otherwise the
    folder goes.
  - An account whose folder holds no login, or someone else's, can't be
    picked until it signs in again, as in Orca.
  - **Sign in** opens a Herdr tab running `claude auth login`. Closing the
    tab cancels it. "Copy sign-in link instead" puts the one-click link on
    the clipboard instead of opening the browser.
  - **Remove** forgets the account. It deletes the folder only for one added
    here, and never touches the Keychain. Removing the active account goes
    back to System default.
- **Usage.**
  - Each account's limits come from Claude's usage endpoint, with its own
    login. It's asked every 15 minutes, at most every 5 minutes per account
    (30 seconds with refresh, 60 for accounts that aren't active), less often
    after failures, and not before a rate limit's Retry-After.
  - Between polls, the numbers follow every Claude turn: Claude Code hands
    its statusline the current limits, and the statusline drops them in the
    state folder. Fable comes from polling only.
  - Logins are never refreshed, written or logged: Claude Code owns them. An
    account whose login lapsed shows "Sign in again".
  - Numbers belong to the login they were read from. When a folder's login
    changes (System default's too), or after a sign-in here, its numbers go
    and it's read again. A folder holding someone else's login isn't read at
    all, and its statusline drops are ignored.
- **Which account a terminal runs.** Inside Herdr, the `claude` launcher
  starts each new Claude on the active account. A running terminal's
  account is the config folder holding its live session file.
- **Switching while Claude runs.**
  - Always restart: every Claude terminal on the previous account restarts
    on the new one, continuing its conversation. Ask: the switch dialog
    first. Never restart: they stay as they are.
  - A terminal on a saved account's folder counts only as that account. One
    on System default also counts as a saved account signed in to the same
    login (same email and same org, as in Orca): it moves when you leave that
    account, and stays when you switch to it.
  - A restart waits until that terminal's Claude finishes its turn, however
    long it takes, stops it, types `CLAUDE_ACCOUNTS_DIR=<folder> claude <its
    flags> --resume <session>` in the same shell, and checks the new Claude
    landed on the new account. Terminals restart independently.
  - Background subagents don't hold the restart up, as in Orca: they stop
    with Claude, and the resumed Claude gets a message naming the ones that
    were still running, so it launches them again. A Claude waiting on a
    question isn't restarted until it's answered.
  - If you quit Claude yourself (`/exit`) while its restart waits, the
    resume line goes in at once, on the new account.
  - Only safe flags are kept (`--model`, `--permission-mode`, `--effort`,
    `--settings`, `--add-dir`, `--dangerously-skip-permissions`), so a
    resumed agent never gets its first task again.
  - A terminal whose program is Claude itself (no shell to come back to)
    can't move, and says so.
  - A terminal whose Claude has nothing to resume yet (no message since it
    started or since `/clear`) isn't restarted. It counts as one Claude
    couldn't move, as in Orca.
  - If Claude refuses the resume line (say, the conversation isn't there),
    the restart fails within seconds with Claude's own message and the line
    to run by hand, instead of waiting out the 2-minute limit.
  - If the restarted Claude stops at a startup question (the folder trust
    check, "Allow external CLAUDE.md file imports?"), a toast says the
    question, for a `resume` from another plugin too (Spotlight's moves).
    The restart waits up to 10 minutes for your answer instead of 2, then
    ends with the question and no line to run, since Claude is running.
    Orca says nothing in that case.
  - A Claude that sits for 10 minutes with no session file while its
    restart waits (one stopped at such a question never writes one) isn't
    restarted: the restart fails with the question it asks, so you answer
    it and switch again.
  - A Claude that agent-sleep is putting to sleep, or put to sleep, isn't
    restarted: claude-accounts reads agent-sleep's
    `<Herdr home>/agent-sleep/sleeping.json` (read only) and drops that
    terminal's restart, or holds it while agent-sleep can still undo its
    stop. agent-sleep's wake starts that Claude on the active account, where
    the restart would have moved it. Orca restarts every terminal once it's
    idle. One gap: a working Claude that agent-sleep interrupts to sleep its
    workspace can still be restarted in the moment before agent-sleep writes
    its record.
  - A later switch moves restarts still waiting for idle to the account
    selected then, and drops the ones whose terminal is already on it.

**Install**

```sh
scripts/install.sh claude-accounts
```

- The footer lives in the projects layout's status row
  (`projects-sidebar/layouts/projects.json`), so install `projects-sidebar`
  too and switch to the `projects` layout.
- New terminals follow the active account only through the `claude`
  launcher (a wrapper script on the PATH), which reads the `active` file.
- Live numbers between polls need the statusline drop in
  `~/.claude/statusline.sh`.
- Usage details & history runs `~/.local/bin/claude-usage --json`.
- Node 22.15 or newer on the PATH Herdr's `exec` sees.

**Built from**

- **Mod `mods/claude-accounts/`** (`mod.json` `{ "place": "none" }`), one mod
  in views picked by `props.view`:
  - none or `footer` = `footer.js`: the only copy that reads key commands. It
    also keeps the 15-minute timer and the watch on the state folder, and
    turns the CLI's progress into toasts (`toasts.js`).
  - `popup` = `popup.js`, `panel` = `panel.js`, `accounts` = `accounts.js`,
    `confirm` = `confirm.js`, `details` = `details.js` (a window).
  - Pure modules, tested with `node --test`: `store.js` (reading the CLI's
    files), `format.js` (percent, durations, dates, colors, error copy,
    density, "since <date>" and the cache-coverage note), `footer-model.js`
    (what the footer, popover and panel draw, and where they open),
    `accounts-model.js` (what the accounts and confirm views draw),
    `details-model.js` (what the details window draws) and `toasts.js`.
- **CLI `mods/claude-accounts/bin/claude-accounts`** (Node, `cli/*.mjs`).
  Every command takes `--json`:

  | Command | Does |
  |---|---|
  | `list` | the accounts and the active one |
  | `use <id\|default>` | switches the active account, then applies the switch setting to running terminals |
  | `remove <id>` | forgets an account |
  | `login <id\|new\|default> [--link]` | signs an account in, in the current terminal |
  | `import-orca` | imports Orca's accounts again |
  | `settings [set switchMode ask\|restart\|keep]` | reads or sets the switch setting |
  | `usage [--refresh] [--force] [--account <id>]` | the usage, fetched when due; `--force` has no floor (`use` runs it for the new account) |
  | `terminal <t>` | a Herdr terminal's account, session and status |
  | `restart --cancel <t>` | cancels a terminal's restart or job that hasn't stopped Claude yet |
  | `restart --answer keep\|restart [--terminal <t>]...` | the switch dialog's answer: keep, or restart the ticked sessions |
  | `resume --terminal <t> --account <id\|default> [--message <text>] [--wait <s>]` | restarts one terminal on an account and sends a message; `--status <job>`, `--cancel <job>` |
  | `details --range <7\|30\|90\|all>` | refreshes one range of the details window in the background: it returns at once, and a run already going is returned, not started twice |
  | `--version` | its version |

  Exit codes: 0 ok, 1 any other failure (a state file that can't be read,
  a failed sign-in), 2 no session id, 3 terminal missing or not Claude, 4
  timeout, 5 account needs sign-in, 6 landed on another account, 7 unknown
  account or job, 8 terminal can't move, 9 job failed, 10 job cancelled, 11
  `resume` with a live job to another account, 64 bad usage, 75 still running
  (under `--wait`). The contract other plugins
  code against (`accounts.v1.json`, and `list`, `usage`, `terminal`, `use`
  and `resume` with their output shapes) is [CONTRACT.md](CONTRACT.md).
- **Commands:** `claude-accounts.open-popup`, `claude-accounts.open-panel`,
  `claude-accounts.open-accounts`, `claude-accounts.open-confirm`,
  `claude-accounts.open-details` and `claude-accounts.refresh`, reached
  through the footer copy (`herdr-app do claude-accounts.<name>`).
- **Herdr functions:** `exec`, `run`, `readTextFile`, `watchFolder`,
  `openOverlay`, `closeOverlay`, `notify`, `shared`, `setShared`, `settings`,
  `window`, `theme`, `props`, `nextCommand`, `home`, `appHome`.
- **Programs the CLI runs:** `security find-generic-password` (reads a
  login, never writes one), `/usr/bin/sqlite3` (Orca's settings, read-only),
  `hc` (Herdr's terminals: list, read, type), `claude auth login`,
  `claude-usage`, and HTTPS to `api.anthropic.com/api/oauth/usage`.

**Files**

The state folder is `~/.config/herdr-app/claude-accounts/`
(`$CLAUDE_ACCOUNTS_HOME` replaces it, for tests). The CLI is its only
writer, except `live/`, which only the statusline writes. Every write is a
temporary file and a rename, under a lock held only for the write. A state
file that isn't valid JSON stops the CLI with its path (exit 1) and is never
overwritten.

| File | Holds |
|---|---|
| `accounts.json` | the saved accounts: id, email, org, config folder, last sign-in, and whether Orca or Herdr made it |
| `active` | the active account's config folder, the exact string; empty for System default |
| `settings.json` | the switch setting: `ask`, `restart` or `keep` |
| `accounts.v1.json` | what other plugins read: every account with its usage ([CONTRACT.md](CONTRACT.md)) |
| `usage-state.json` | when each account was fetched, its last data, the login that data was read from, and its failures |
| `restart.json` | the queued restarts and `resume` jobs, with their progress |
| `pending-switch.json` | what the last switch found: the sessions on the previous account and the others (`mode` ask: the switch dialog's question; `mode` restart: the restart notice and its Review list) |
| `live/` | the statusline's latest limits, one file per account |
| `details.json` | the details window's last result per range, kept while a new run goes and after one fails |
| `login-link` | a captured sign-in link |
| `lock/` | the lock |

**Watch out**

- **It reads your Claude logins.** The CLI reads each account's OAuth token
  from the Keychain to ask for its usage. Tokens never leave that request:
  they aren't logged, written or refreshed.
- **The usage endpoint, Claude's session files and the statusline limits
  aren't documented.** A Claude Code update can change them; the footer then
  shows "Usage unavailable" or stale numbers.
- **A restart stops Claude.** It waits for idle first, but a half-typed
  prompt in that terminal is lost. Never restart (or Ask) avoids it.
- **exec's 30 s limit:** restarts and the details refresh run in a detached
  process, so a command returns at once and the work goes on.
- **Orca shares the accounts.** Imported accounts are Orca's own folders, so
  signing in or out in either app affects both.
- **Install by copying.** Herdr doesn't load a mod folder that is a symlink;
  `scripts/install.sh claude-accounts` copies it and lists what it copied in
  `<home>/.herdr-plugins/claude-accounts.txt`.
- **`herdr-app check` draws only the footer.** `scripts/check-views.sh
  claude-accounts/mods/claude-accounts <views…>` checks the others.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and
  `scripts/check-views.sh claude-accounts/mods/claude-accounts footer popup
  panel accounts confirm details` prints `ok` for each view.
- `claude-accounts list --json` shows System default and each Orca account,
  with the active one marked.
- The footer shows the active account's session, weekly and Fable usage, and
  the popover, panel and Manage Accounts show Orca's texts with the same
  numbers.
- Switching accounts with a Claude terminal open restarts it on the new
  account (Always restart) or asks first (Ask), and the conversation goes on.
- Usage details & history shows every section for each range.
