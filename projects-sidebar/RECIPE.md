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
    - Label: the branch on the main checkout, the folder name on the others.
      It is bright when the workspace has a space.
    - A dot on the right when a space is open there: `accent` while shown,
      `muted` otherwise.
    - The shown workspace has a `selected` background.
  - Agent rows: 24 px, under their workspace. Each shows the program's icon,
    the agent's title, and the time since its tab changed ("2m").
  - Empty group: "No projects in this group yet." and an "Add project" button.
    A project git can't list shows "Can't read this folder."
- **Groups bar:**
  - One chip per group, in creation order, 28 px tall. The first three show
    "F1", "F2", "F3" after the name, which is cut at 160 px.
  - The active chip has a `selected` background.
  - Another group's chip gets a dot when one of its agents is blocked or done:
    `blocked` if any is blocked, else `done`.
  - A "+" (New group) sits on the right.
- **Narrow sidebar** (under 160 px wide): projects show as initials ("HP" for
  herdr-plugins) with the most urgent status among their workspaces, and group chips
  show initials only ("Pr").
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
- **Overlays:** the project menu is a 220 × 300 popup: Open main, New
  workspace…, Move to group ▸, Remove from list. The group menu is a 210 ×
  104 popup: Rename…, Delete group. The New / Rename group form is a 380 ×
  214 dialog.

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
  - `project-menu`, `group-menu`, `group-form`.
  - Pure logic is in `lib.js`, `tree-model.js` and `new-workspace-model.js`,
    tested with `node --test`.
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
  `exec`, `run` (`space.select`, `space.new`, `pane.focus`), `openOverlay`,
  `closeOverlay`, `shared`, `setShared`, `notify`, `theme`, `props`,
  `nextCommand`.
- **Programs it runs:**
  - `git`, in the registered repos: `rev-parse --git-common-dir`,
    `worktree list --porcelain`, `for-each-ref`, `show-ref`, `fetch origin`
    (network) and `worktree add`.
  - `test -e`, to check whether a folder exists.
- **Art:** its own Lucide-style icons in `icons/` (folder, branch, home,
  plus), plus chevrons, check and spinner from Herdr's `workspace-chrome`
  and agent icons from Herdr's `icons/`.

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
- **`herdr-app check` draws only the tree view.** Check the other views
  from a copy whose `main.js` defaults to them.
- **Limits:**
  - Only the first three groups have keys.
  - Branch names have no user prefix and are slugged to 48 characters.
  - Linear, GitLab and fetching issue titles aren't supported; such a link
    is named by its slug.
  - Worktrees are never deleted from here.
  - Two chosen projects with the same folder name (`/a/web`, `/b/web`) would
    land on the same worktree path: the dialog says so and Create stays off.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check`
  passes on `mods/projects`.
- After `scripts/install.sh` and `layout.switch {name: "projects"}`, the
  sidebar shows "Projects" with an empty state, and the groups bar shows
  "Projects F1".
- With a space open in a repo, `herdr-app do projects.add-here` lists that
  repo with `main` (home icon, open dot) and its other worktrees.
  A space in a folder outside every project is not shown.
- `layout.resize {id: "sidebar", px: 76}` shows initials in the tree and in
  the groups bar.
- `herdr-app do projects.new-workspace` opens the dialog on the focused
  space's project, with `origin/main` (or the repo's default) marked
  "default".
- Creating `demo` with one companion makes `~/orca/workspaces/<repo>/demo`
  in both repos, on branch `demo`. It opens one space, and its agent was
  started with `--add-dir` for the companion.
