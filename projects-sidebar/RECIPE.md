# Projects sidebar

Herdr's Spaces list becomes a list of projects, each with its workspaces (git
worktrees), the way Orca's sidebar works. Projects are sorted into groups you
switch with F1, F2 and F3. Folders that aren't a registered project don't
show. A "+" on a project opens a New workspace dialog. It makes the branch as
a worktree, opens a space for it with your agent, and can make the same
branch in other projects of the group ("Also create in") so one agent works
across repos.

![Projects sidebar](preview.png)

**What you see**

- **Sidebar column** (layout `projects`, a clone of Herdr's `main`): the
  brand block, then the projects tree where Spaces was, Herdr's agents list,
  the groups bar (44 px), then the footer. Background `chrome`, text 13 px
  in the person's UI font.
- **Projects tree:**
  - Header: 31 px, 11.5 px `dim` text. It reads "Projects · <group>", or
    "Projects" for the default group, with a "+" (Add project) on the right.
  - Project rows: 28 px with rounded 8 corners. Each has a chevron (collapse),
    a folder icon, the repo name in `foreground` semibold, and a "+" (New
    workspace) that brightens on hover.
  - Workspace rows: 28 px, indented 26 px.
    - Leading icon: the agent's status mark while one of its spaces is
      working, blocked or done; otherwise a home icon on the main checkout and
      a branch icon on the others.
    - Label: the branch on the main checkout. On the others, the branch's
      last segment (`user/feat-x` → `feat-x`), or the folder name when
      detached. It is bright when the workspace has a space.
    - A dot on the right when a space is open there: `accent` while shown,
      `muted` otherwise.
    - The shown workspace has a `selected` background.
  - Agent rows: 24 px, under their workspace. Each shows the program's icon,
    the agent's title, and the time since its tab changed ("2m").
  - Empty group: "No projects in this group yet." and an "Add project" button.
    A project git can't list shows "Can't read this folder."
- **Groups bar** (drawn like Orca's, so a long name never takes the bar):
  - One icon chip per group, in creation order: 28 × 28 px with a 16 px code
    icon (`<>`).
  - Hovering a chip shows a tooltip with the name, "Needs attention" or
    "Agent done" when the chip has a dot, and the key on the first three
    ("AG · Needs attention · F3").
  - The active chip has a `selected` background and a `foreground` icon. The
    others are `muted` and brighten on hover.
  - Another group's chip gets a dot at its top right when one of its agents
    is blocked or done: `blocked` if any is blocked, else `done`.
  - A "+" (New group) sits on the right.
- **Narrow sidebar** (under 160 px wide): projects show as initials ("HP" for
  herdr-plugins) with the most urgent status among their workspaces. Group
  chips shrink to 26 px and center, and "+" hides.
- **New workspace dialog:** a 560 × 600 modal with these parts:
  - Project select: the current group first, then "Other groups".
  - Name input: takes a name, a branch, `#123`, or a GitHub issue / pull
    request or Jira link. Under it, a live line:
    `~/orca/workspaces/<repo>/<name> · branch <name> · from <base>`.
  - "Create from": `origin/HEAD`'s target marked "default", then the 30
    latest remote branches.
  - "Agent": installed agents plus "Blank terminal".
  - "Also create in · <group>": chips for the group's other projects; a
    chosen chip shows a check.
  - "Give the agent access to these worktrees": a checkbox, shown when a
    companion is chosen.
  - Footer: "Create more", Cancel, and Create ⌘↵.
- **Overlays:**
  - The project menu is a 220 × 300 popup: Open main, New workspace…, Move to
    group ▸, Remove from list.
  - The workspace menu is a 220-wide popup: Copy Path, Copy Worktree Name
    and, on a worktree that isn't the main checkout, Delete… after a
    separator, in `blocked`.
  - The Delete dialog is a 380 × 320 modal:
    - always: "Delete <label>?", the path with `~`, and "Branch <b>" or
      "Detached HEAD";
    - when they apply: "Its N spaces close, with their agents." and "N more
      terminals are in this folder and stay open.";
    - changes or submodules: "<label> has changes that aren't committed.
      They'll be lost." or "<label> has submodules. They're deleted too." in
      `blocked`, and the button reads "Delete anyway";
    - locked: "Locked by git: <reason>. Unlock it with `git worktree unlock
      <path>`." and no Delete button;
    - footer: Cancel, and Delete as a `blocked` outline button, off until git
      has answered ("Checking with git…"), "Deleting…" while it runs.
  - The group menu is a 210 × 104 popup: Rename…, Delete group. The New /
    Rename group form is a 380 × 214 dialog.

**How it behaves**

- **Status marks:** a spinner (`working`), "!" (`blocked`), or a dot (`done`).
  Idle and unknown show the home or branch icon. A project row that is
  collapsed shows the most urgent status among its workspaces.
- **Click a workspace:** selects its space (when two spaces share it, the
  shown one, else the first). If it has none, opens a space there named
  after its label. Click an agent row: focuses that agent's pane. Click a
  project row: collapse or expand, remembered.
- **Add project** (header "+", or the empty state's button): a folder
  picker. The repo's main checkout is added to the active group, even if
  you picked a linked worktree or a subfolder. A folder that isn't a repo is
  added as itself. A folder already registered in any group switches to
  that group instead. Then the main checkout's space opens. This works with
  no space open.
- **Right-click a project:** opens the project menu. "Remove from list"
  forgets the project and never touches files, worktrees or spaces. "Move
  to group ▸" lists the other groups.
- **Right-click a workspace:** opens the workspace menu. Copy Path and Copy
  Worktree Name (the folder's name) go to the clipboard, and a toast says
  "Copied".
- **Delete…** (never on the main checkout): the dialog asks git first, on a
  fresh `worktree list`: the lock, `status` with untracked files, and
  submodule checkouts as git counts them. Delete then runs, in this order:
  1. It checks again. A path that isn't a worktree of the project, a lock,
     or changes or submodules the dialog didn't show: nothing runs, and the
     dialog says why.
  2. The workspace's spaces close (`space.close`, confirmed), with their
     agents. It waits until they are gone, 3 s at most.
  3. `git worktree remove` runs in the main checkout, with `--force` only
     after "Delete anyway". A new listing decides: still listed means the
     error stays in the dialog.
  4. The branch: `git branch -d`, never `-D`. It is skipped when detached or
     checked out in another worktree. A branch git doesn't see as merged
     stays, and a toast reads "Kept branch <b>".
  5. The fresh list is stored, so the row goes at once.
  - While it runs, Esc, Cancel and clicks do nothing. It runs in a task no
    view owns, so it finishes even if the dialog closes; the outcome is then
    a toast.
  - Every outcome is read from git's state (the list, the refs, the exit
    code), never from its words, which change with the locale and the
    version.
- **Groups:** F1/F2/F3 (in this layout only) select groups 1–3, and a
  missing group does nothing. "+" opens the form: Enter creates and selects
  the group, Esc cancels. Right-click a chip: Rename…, or Delete group, which
  only works on an empty group that isn't the last one.
- **New workspace:**
  - Opens from a project's "+", the project menu or `projects.new-workspace`
    (the focused space's project, else the active group's first).
  - Choosing companions: each gets a worktree with the same branch from its
    own default branch, and no space.
  - A name taken in any chosen repo (branch or folder) becomes `-2`, `-3`… for
    all of them.
  - ⌘↵ creates:
    1. A fetch from origin, in every repo at once. A failure warns and the
       create continues.
    2. The companions' worktrees.
    3. The primary's worktree.
    4. One space on the primary, with the agent.
  - With companions and access on, Claude gets `--add-dir <path>` per
    companion and `--settings {"env":{"CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD":"1"}}`,
    so it reads their CLAUDE.md. Codex gets only the `--add-dir`s.
  - A pasted link also becomes the agent's first message: `Complete <url>`.
  - Create more keeps the project, base and agent, clears the name and stays
    open.
- **What moves:** a worktree made or removed outside Herdr shows up within
  a moment (the repo's `.git/worktrees` is watched). A 60 s fallback runs
  while the window is in front.

**Built from**

- **Layout `layouts/projects.json`:** Herdr's `main` tree with block
  `spaces` → `{ "mod": "projects" }`, and a new block `groups` →
  `{ "mod": "projects", "props": { "view": "groups" } }` (px 44) between
  `sidebar-lists` and `sidebar-footer`. Preview `layouts/projects.svg`.
- **Mod `mods/projects/`** (`mod.json` `{ "place": "none" }`), one mod in
  views picked by `props.view`:
  - none = `tree.js` (the tree; the only copy that reads key commands);
  - `groups` = `groups.js`;
  - `new-workspace` = `new-workspace.js`;
  - `delete-workspace` = `delete-workspace.js`;
  - `project-menu`, `workspace-menu`, `group-menu`, `group-form`.
  - Pure logic is in `lib.js`, `tree-model.js`, `new-workspace-model.js` and
    `remove-workspace-model.js`, tested with `node --test` (Delete's against
    a real git).
  - `store.js` is the only code that touches the shared keys: `projects.v1`
    (groups and projects), `projects.ui.v1` (collapsed), `projects.cache.v1`
    (worktree lists) and `projects.agents.v1` (`knownAgents()`). A stored
    `projects.v1` with a malformed group or project keeps the valid rest, and
    the original is copied to `projects.v1.backup` before the first write
    over it.
  - `config.js` holds `MOD` and `WORKTREE_ROOT` (`~/orca/workspaces`).
- **Commands:** `projects.add`, `projects.add-here`, `projects.new-workspace`,
  `projects.group1`..`projects.group3`, `projects.ping`. `keys.json` binds
  F1–F3 in section `layout:projects`.
- **Herdr functions:** `spaces`, `panes`, `agents`, `focused`,
  `knownAgents`, `layout`, `window`, `home`, `pickFolder`, `watchFolder`,
  `exec`, `run` (`space.select`, `space.new`, `space.close`, `pane.focus`),
  `openOverlay`, `closeOverlay`, `shared`, `setShared`, `notify`, `theme`,
  `props`, `nextCommand`.
- **Programs it runs:**
  - `git`, in the registered repos: `rev-parse --git-common-dir`,
    `worktree list --porcelain`, `for-each-ref`, `show-ref`, `fetch origin`
    (network) and `worktree add`. Delete adds `status --porcelain`,
    `rev-parse --git-path modules`, `ls-files --stage -z`, `worktree remove`
    and `branch -d`.
  - `test -e`, to check whether a folder exists.
- **Art:** its own Lucide-style icons in `icons/` (folder, branch, home,
  plus, code, copy), plus chevrons, check, x and spinner from Herdr's
  `workspace-chrome` and agent icons from Herdr's `icons/`.

**Watch out**

- **This mod runs git and reaches the network:** `git fetch origin` in
  every repo you create in. It reads repo folders outside its own and writes
  worktrees under `~/orca/workspaces`. Change `WORKTREE_ROOT` in `config.js`
  to put them elsewhere.
- **Install by copying.** Herdr doesn't load a mod folder that is a
  symlink ("no mod folder …"). `scripts/install.sh` copies the files and
  lists them in `<home>/.herdr-plugins/projects-sidebar.txt`.
- **A command sent while the mod reloads is lost** (no error). Wait for the
  reload before scripting `herdr-app do projects.*`.
- **Never launch the agent as `env VAR=1 claude`:** Herdr then sees `zsh`,
  not an agent, and shows no status. Use `claude --settings '{"env":{…}}'`.
- **Merging `keys.json`:** F1–F3 need the plugin's `keys.json` merged into
  yours. Once edited, your keys.json no longer receives Herdr's new default
  shortcuts. In this layout, F2 replaces Herdr's `tab.rename`.
- **Delete deletes.** It removes the worktree's folder, its uncommitted
  work after "Delete anyway", and its merged branch. Its spaces close with
  their agents, including an agent session running in that worktree.
- **exec's 30 s limit:** `git worktree remove` on a big worktree can hit it.
  The dialog then says "git didn't finish; the folder may be partly deleted.
  Check `git worktree list` in <project>."
- **Locked worktrees** are never deleted from here. Run `git worktree unlock
  <path>` first.
- **`branch -d` keeps squash-merged branches.** A branch merged on GitHub by
  squash or rebase isn't merged for git, so it stays ("Kept branch <b>").
  Delete it yourself with `git branch -D` once you're sure.
- **`herdr-app check` draws only the tree view.** Check the other views
  from a copy whose `main.js` defaults to them.
- **Limits:**
  - Only the first three groups have keys.
  - Branch names have no user prefix and are slugged to 48 characters.
  - Linear, GitLab and fetching issue titles aren't supported; such a link
    is named by its slug.
  - The main checkout is never deleted, and a branch only when git sees it
    merged.
  - Two chosen projects with the same folder name (`/a/web`, `/b/web`) would
    land on the same worktree path: the dialog says so and Create stays off.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check`
  passes on `mods/projects`.
- After `scripts/install.sh` and `layout.switch {name: "projects"}`, the
  sidebar shows "Projects" with an empty state. The groups bar shows one
  highlighted code icon whose tooltip reads "Projects · F1".
- With a space open in a repo, `herdr-app do projects.add-here` lists that
  repo with `main` (home icon, open dot) and its other worktrees.
  A space in a folder outside every project is not shown.
- `layout.resize {id: "sidebar", px: 76}` shows initials in the tree and
  smaller, centered chips in the groups bar.
- With keys.json merged, F1–F3 select groups 1–3 while a terminal has focus,
  and F2 no longer opens Rename tab in this layout.
- `herdr-app do projects.new-workspace` opens the dialog on the focused
  space's project, with `origin/main` (or the repo's default) marked
  "default".
- Creating `demo` with one companion makes `~/orca/workspaces/<repo>/demo`
  in both repos, on branch `demo`. It opens one space, and its agent was
  started with `--add-dir` for the companion.
- Right-click a throwaway worktree → Delete… → Delete: its space closes, and
  its folder, its row and its merged branch are gone. A dirty one asks
  "Delete anyway"; a locked one has no Delete.
