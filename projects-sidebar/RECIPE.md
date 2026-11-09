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
  brand block, then the projects tree where Spaces was, the agents list
  (Herdr's, with the tree's working mark),
  the groups bar (44 px), then the footer. Background `chrome`, text 13 px
  in the person's UI font.
- **Projects tree:**
  - Header: 31 px, 11.5 px `dim` text. It reads "Projects · <group>", or
    "Projects" for the default group, with a filter button ("Filter
    workspaces", Orca's three-bar glyph) and a "+" (Add project) on the
    right. While Hide sleeping is on, the filter button carries Orca's
    badge, a small `accent` "1" at its top right, and its tooltip reads
    "Edit filters", as Orca's does.
  - Project rows: 28 px with rounded 8 corners. Each has a chevron (collapse),
    a folder icon, the repo name in `foreground` semibold, and a "+" (New
    workspace) that brightens on hover.
  - Workspace rows: 28 px, indented 26 px.
    - Leading icon: the agent's status mark while one of its spaces is
      working, blocked or done; otherwise a moon when the workspace is
      asleep, a home icon on the main checkout and a branch icon on the
      others.
    - Asleep (Orca's moon): no space shows the workspace, or every space on
      it has all its tabs put away (`tab.settle`, `settled` on each tab).
      The tree doesn't care who put them away. The moon's tooltip says
      "Sleeping", the label and icons are `dim`, there's no dot, and the
      main checkout keeps its home icon after the label.
    - The branch icon takes the color of the branch's newest GitHub PR, as
      Orca shows it: green (`ansi2`) open, purple (`ansi5`) merged, red
      (`ansi1`) closed without merging, `dim` gray as a draft. Its hover
      names it ("PR #161 · Open"). With no PR it stays `dim`. An asleep
      row draws the moon in its place, so it shows no PR color.
    - Label: the branch on the main checkout. On the others, the branch's
      last segment (`user/feat-x` → `feat-x`), or the folder name when
      detached. It is bright when the workspace has a space, `muted` with
      none, and `dim` while asleep.
    - After the label, other plugins' badges, if any (see Badges from
      other plugins).
    - A dot on the right when a space is open there and it isn't asleep:
      `accent` while shown, `muted` otherwise.
    - The shown workspace has a `selected` background.
  - Agent rows: 24 px, under their workspace. Each shows the program's icon,
    the agent's title, and the time since its tab changed ("2m").
  - **Hide sleeping** (the filter button's popup, or
    `projects.toggle-sleeping`; Orca's sleeping filter): asleep workspace
    rows go, with their agents, those never opened too, as in Orca.
    - The shown workspace never hides, nor does one whose agent is working,
      blocked or done: it shows that mark, not the moon.
    - "Except default branch", on by default, keeps every main checkout.
    - A project row stays even when all its workspaces hide, and the
      narrow rail is unchanged.
    - Both settings survive a reload.
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
- **Task mode** (a group's right-click menu → Organize by Task; Organize by
  Project brings back the tree above). Each group keeps its own mode.
  - Instead of projects, the tree shows task lanes: a bold header with a
    chevron and a count, then that task's workspaces from every project of
    the group, each with its project's name on the right, dim.
  - A task is a ticket found in the branch (`feat/ax-3356-fix` → `AX-3356`)
    or in the folder name. Without one, it is the branch's last segment, so
    the same branch in two projects (one made with "Also create in") is one
    task. A name merges whatever its casing.
  - Lanes go: tickets (newest number first), names (A–Z), "No task",
    "Servers". Servers holds each project's main checkout, or "<name> ·
    Loading…" while a project is still listed.
  - Click a lane header to fold it; folds survive a reload.
  - Right-click a ticket or name lane for its menu: "Add note…" ("Edit
    note…" once it has one), a separator, then "Delete task…" in the
    blocked color, dimmed with "No workspaces" when the lane has none in
    this group. A folded lane has the same menu. "No task" and "Servers"
    have no menu.
  - "Delete task…" deletes every workspace of the lane in this group (main
    checkouts never count), each the way Delete… does, one after another.
    The dialog takes the lane's workspaces when it opens, so one created
    after that is never deleted, and asks git about each. Only the rows git
    allows run: a locked one, one git couldn't check, or one that is no
    longer a workspace says why and is skipped. A row with changes makes the
    button "Delete anyway", which forces that row only. One failure doesn't
    stop the others.
    - All of them deleted: the dialog closes and a toast reads "Deleted 2
      workspaces of AX-3653", with the skipped ones ("Kept 1 locked
      workspace.") and any branch git kept.
    - Otherwise each row shows what happened and the dialog waits for
      Close. Closed meanwhile, one toast gives the count and the first
      failure.
    - The task's note goes once every workspace was deleted, none was
      skipped, and no other workspace, in any group, has the task.
  - A task's note is a word or two to recall it by ("contratos"): a small
    dialog, "Note for AX-3695", with one input. Enter saves, Esc cancels,
    and saving it empty removes the note. It is kept as one line of up to
    30 characters. Hovering the lane shows it as a tooltip, the note only.
    Notes live in Herdr only, per task across every group, and at most 500
    are kept: a new one past that is refused ("500 notes is the most;
    remove one first.").
  - The header gets a branch-icon button, "New workspace", next to Add
    project: the dialog opens on the focused space's project.
  - Hide sleeping leaves out the same workspaces as in Project mode: a lane
    counts only the rows it shows, and a lane left with none isn't shown.
    Servers keeps a project's "Loading…" row.
- **Narrow sidebar** (under 160 px wide): projects show as initials ("HP" for
  herdr-plugins) with the most urgent status among their workspaces. Group
  chips shrink to 26 px and center, and "+" hides. The tree's header shows
  its "+" only: the rail has no workspace rows to filter.
- **New workspace dialog:** a 560 × 600 modal with these parts:
  - Project select: the current group's projects only (the space you're in); switch groups for another's.
  - Name input: takes a name, a branch, `#123`, or a GitHub issue / pull
    request or Jira link. Under it, a live line:
    `~/orca/workspaces/<repo>/<name> · branch <name> · from <base>`.
  - "Create from": the project's saved base (D37) marked "default" when
    origin still has it, else `origin/HEAD`'s target; origin's default
    labelled "origin's default"; then the 30 latest remote branches. A
    saved base origin no longer has shows "origin/develop is gone" and the
    workspace starts from origin's default, with a warning. Companions start
    from their own saved base the same way. After a Create, the base the
    primary used is saved as its default (origin's default clears it).
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
    and, on a worktree that isn't the main checkout, Rename… and then
    Delete… after a separator, in `blocked`.
  - The Rename dialog is a 380 × 320 modal:
    - "Rename <label>" and the path with `~`;
    - a "Branch" input, prefilled with the branch and selected;
    - under it, a live line: "branch <old> → <new> · folder <new>", or
      "· folder stays <old> (a terminal is open there)", "(locked by git)"
      or "(has submodules)"; for a name that differs from the branch only
      in case, "Only the case changes: git on macOS can't rename a branch
      that way.", and Rename stays off;
    - for a pushed branch, from the moment it opens, what Rename does on
      origin: "Renames it on GitHub too (<owner>/<repo>).", "Pushes a copy
      as <new>; origin keeps <old>." or "origin no longer has <old>: renames
      it here only.";
    - an open pull request from the branch, in `blocked`: "GitHub closes PR
      #<n> when its branch is renamed.", and the button reads "Rename
      anyway";
    - a refusal in `blocked` once git has checked the typed name: "origin
      already has <new>.", "Branch <new> already exists." (naming the branch
      in the case it has: "Branch ax-1 already exists." for `AX-1`) or
      "<path> already exists." (only when the folder would move); and,
      whatever the name:
      "Couldn't reach origin: <git's first line>.", "Also pushed as
      <remote>/<old>: renaming would split it." or "You can't push to
      <owner>/<repo>.";
    - a detached worktree has no input and no Rename: "<label> is detached
      or in the middle of a rebase.";
    - footer: Cancel, and Rename (solid), off until git has answered
      ("Checking with git…"), "Renaming…" while it runs.
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
  - The Delete task dialog is a 400 × 380 modal:
    - "Delete Workspaces" ("Delete Workspace" for one), the task, and Orca's
      "Remove N workspaces from git and delete their workspace folders.",
      counting the rows that will run;
    - how many spaces close and how many other terminals stay, added up
      over the rows that will run;
    - a row per workspace: its label, its project's name on the right, and
      what applies: changes that will be lost, why it is skipped, "Checking
      with git…", "Deleting…", "Waiting…", then what happened;
    - footer: Cancel, and Delete (or "Delete anyway") as a `blocked` outline
      button, off until git has answered for every row, "Deleting…" while it
      runs; only Close once a run left rows behind.
  - The group menu is a 210 × 200 popup: Organize by Project, Organize by
    Task, a separator, Rename…, Delete group. The New / Rename group form is
    a 380 × 214 dialog.
  - The filter popup is 240 px wide, at the pointer, as Orca's: "Hide
    sleeping" with the moon and a switch, off by default; while it's on,
    "Except default branch" with the branch icon, indented and `muted`, on
    by default. A click, or Enter or Space on the highlighted row, flips a
    switch and the popup stays open; ↑/↓ move, Esc closes.
- **PR card** (the right panel's Changes, above Herdr's diff, as Orca shows
  the PR atop Source Control): a 176 px card with rounded 10 corners, a 1 px
  `border` and the terminals' `background`, 8 px above Changes' own card.
  - With a PR: "PR #161 · Open" after a branch icon, semibold, in the
    sidebar icon's color (green open, purple merged, red closed, `dim`
    draft), with "+2,305" (`ansi2`) and "−942" (`ansi1`) at its right; the
    title (13 px); "head → base" in `muted` with "↑4 ↓9" (ahead of and
    behind `origin/<base>` here) in `dim`; "Checks" then "✓ 5 de 5 pasan"
    (green), "✗ 1 falla" (red), "… 2 corriendo" (yellow) or "Sin checks";
    "Reviews" then "1 aprobado" (green), "Cambios pedidos" (red) or "Sin
    reviews"; then two 26 px buttons, "Abrir en GitHub" (outlined) and
    "Mergear ▾" (`solid`). When GitHub wouldn't merge it, "Mergear ▾" is
    drawn off (`raised`, `dim`), its hover saying why ("Es un draft",
    "Tiene conflictos con main", "Bloqueado por las reglas de main", …).
  - Without one, centered: "Esta rama no tiene PR", the branch under it, and
    a 26 px "Crear PR" button (`solid`).
    A detached workspace says "Este workspace no está en una rama"; GitHub
    not answering, "GitHub no respondió", or "Ninguna cuenta de gh ve
    <owner>/<repo>" when no account you're logged into sees the repo.
  - "Leyendo el PR…" while a workspace's first answer is read.
  - Mergear's popup (240 px wide, at the pointer): "Mergear PR #161 en
    main" in `dim`, then one 31 px row per method the repo allows, squash
    first: "Squash y mergear", "Crear un merge commit", "Rebase y mergear".
  - Mergear's confirm dialog (400 × 300, modal): "Mergear PR #161", the
    title, "head → base" in `muted`, the method, the account in `dim` ("Con
    la cuenta de gh de este repo", or "Con la cuenta <login>"), and "No se
    puede deshacer. La rama queda: Delete workspace la borra."; footer
    Cancelar and Mergear (`solid`), "Mergeando…" while it runs. An outcome
    that isn't a merge stays in the dialog in `blocked`.
  - Crear PR's dialog (480 × 540, modal): "Crear PR", "head → base" in
    `muted`, then the New workspace dialog's fields: Base (a select with the
    default marked "por defecto"), Título (an input), Descripción (a 96 px
    multi-line box), a Draft checkbox ("GitHub lo abre como borrador"), the
    account in `dim` ("Con la cuenta de gh de este repo", or "Con la cuenta
    <login>"), and why it publishes first ("origin no tiene <branch>: se
    publica primero.", "2 commits sin publicar: se publican primero.").
    What git says against a PR now shows under them in `blocked` ("… se
    separaron. Trae los commits de origin (git pull) antes de crear el PR.",
    "git no pudo leer origin (…). Crear PR lo vuelve a comprobar."), and
    what is left to fill in `dim` ("Escribe un título."). Footer Cancelar
    and "Crear PR" or "Publicar y crear PR" (`solid`, ⌘↵, off only while
    the base or the title is missing), "Creando…" while it runs.
- **Inicio** (Orca's Landing): what shows when the shown workspace closes or
  sleeps, instead of the next worktree.
  - It is a space named "Inicio" in the home folder. Its only tab is this
    mod's `inicio` view, centered on `background`.
  - Herdr's icon (the one the brand block draws) at 80 px, then "Herdr" in
    36 px bold.
  - "Select a workspace from the sidebar to begin.", or "Add a project to
    get started." while no group has a project, in `muted`.
  - Two buttons: "Add project" (the folder picker, as the header's "+") and
    "Create workspace" (the New workspace dialog on the active group's first
    project).
  - A row for each of Orca's shortcuts that has a key here, its key drawn as
    caps (⌘ ⇧ ↑ on macOS): "Create workspace" (`projects.new-workspace`),
    "Move up workspace" and "Move down workspace" (`projects.space-prev`
    and `projects.space-next`, else Herdr's `space.prev` and `space.next`).
    A key counts when keys.json binds it in `global`, in the shown layout's
    section or in `mod:projects`; a layout's key shadows a global one.
  - No "Star on GitHub".

**How it behaves**

- **Status marks:** Claude Code's working glyphs, · ✢ ✳ ✶ ✻ ✽ changing in
  place, in Claude's orange (`working`; Herdr's `spin()` turns at about 30 fps, which stutters),
  "!" (`blocked`), or a dot (`done`).
  Idle and unknown show the home or branch icon. A project row that is
  collapsed shows the most urgent status among its workspaces. The agents
  list's working agents show the same glyphs in the same orange.
- **Click a workspace:** selects its space (when two spaces share it, the
  shown one, else the first). If it has none, opens a space there named
  after its label. Click an agent row: focuses that agent's pane. Click a
  project row: collapse or expand, remembered.
- **Closing never shows another worktree.** The keeper, a 1 px copy of this
  mod in the status bar, keeps Inicio right after the shown space
  (`space.move`). Herdr shows the space now at a closed one's place, so
  closing the shown space by any path lands on Inicio: Cmd+W on its last
  tab, the tab or pane X, a menu, the picker, `exit` in its last terminal.
  - **When it selects Inicio:** the shown space just had all its tabs put
    away (a workspace sleep), or the shown space vanished and Herdr showed
    another (a flash, then Inicio). Inicio itself closed counts: a new one
    is shown, never the next worktree. A space that becomes shown already
    put away (a click on a sleeping row) is left alone, since agent-sleep
    wakes it. Only changes count: after a reload the first look does
    nothing.
  - **When it doesn't move Inicio:** while Inicio is shown, and while a
    remote space is shown (Inicio can't sit in another machine's block).
  - **Making it:** when none is there, the keeper makes it (`space.new`
    with the home folder on this computer, then the view's tab, then the
    first terminal tab closed) and shows again the space shown before, so
    Inicio is the only flash. Its id is kept in `projects.inicio.v1`. One
    left half-made by a reload is finished. A making that didn't land
    closes what it made and is tried again after 30 s.
  - **A terminal in Inicio** (Cmd+T, code-tabs' "+", a split beside the
    view) makes it an ordinary space: its view pane closes, it gets Herdr's
    name back, and a new Inicio is made.
  - **No worktree's:** its folder is the home folder and it holds no
    terminal, so it shows under no workspace, and no workspace's Delete or
    Rename touches it.
  - **Guards:** no new move until `spaces()` shows the last one applied (or
    2 s passed). When the space order changes under the keeper more than 3
    times in 10 s (two screens share the order, not the selection), Inicio
    stays put for 60 s and the keeper logs it once. Nothing is made while
    this computer's spaces load, and without a window (`herdr-app check`)
    the keeper does nothing.
- **Space keys skip Inicio.** In this layout `cmd-alt-]` and `cmd-alt-[`
  (`projects.space-next`, `projects.space-prev`) and `ctrl-1`…`ctrl-9`
  (`projects.space-1`…`projects.space-9`) do what Herdr's `space.next`,
  `space.prev` and `space.select:N` do, over the space order without
  Inicio: so they reach the same spaces as before Inicio, whatever is
  shown. Next and prev wrap at the ends, as Herdr's do. From Inicio they go
  to the space after or before it. `ctrl-N` past the last space, or a key
  that would select the shown space, does nothing.
- **Key commands run in the keeper.** A command reaches one shown copy of
  the mod only, the first one started, so the keeper, which starts with
  the window, is the only copy that reads them. Every `projects.*` command
  works with the sidebar hidden (cmd-b), and `projects.ping` says `view
  keeper`.
- **Drag a project row** (Project mode) up or down onto another project row:
  a line marks where it lands, and on release the project moves there within
  its group, remembered. Leaving the list, or a new press anywhere else,
  cancels the drag; a drag that ends on its own row changes nothing and
  doesn't fold it.
- **Add project** (header "+", or the empty state's button): a folder
  picker. The repo's main checkout is added to the active group, even if
  you picked a linked worktree or a subfolder. A folder that isn't a repo is
  added as itself. A folder already registered in any group switches to
  that group instead. Then the main checkout's space opens. This works with
  no space open.
- **Right-click a project:** opens the project menu. "Remove from list"
  forgets the project and never touches files, worktrees or spaces. "Move
  to group ▸" lists the other groups. "Default branch…" picks the base New
  workspace starts from (kept on the project in `projects.v1` as `base`,
  e.g. `origin/develop`): origin's default first (clears it), then the
  saved one, then the latest remote branches.
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
- **Rename…** (never on the main checkout): the input starts as the branch,
  and the untouched branch never renames. Each `/` segment of the name is
  slugged like a new workspace's (`Fix Login!` → `Fix-Login`), so `user/feat`
  keeps its namespace; a `HEAD` segment is dropped and a `.lock` ending
  goes, in any case. A name that differs from the branch only in case
  (`AX-1` for `ax-1`) counts as unchanged: on macOS git finds that branch
  already there, and the live line says so. Other names are compared the
  way a Mac's disk does, ignoring case: a new name is refused, before
  anything changes here or on origin, when a local branch has it (packed
  ones too: `ax-1` refuses `AX-1`), when a local branch would sit under or
  over it (`feat` refuses `Feat/y`, `Feat/x` refuses `feat`), or when a
  remote's copy (`origin/ax-1`) or origin itself has it or such a
  neighbour. On open the dialog asks git whether the folder can
  move (a fresh `worktree list`: the lock, and submodule checkouts as Delete
  counts them), and it checks the typed name a moment after typing stops.
  - **A pushed branch** (a copy on a remote, or an upstream of its own
    name) is decided by what origin has, read once with `git ls-remote
    --heads origin` (only `refs/heads/<old>` before a name is typed); whole
    names count, ignoring case, so `someone/<new>` doesn't and `ax-1` does
    for `AX-1`:
    - origin has `<new>` in any case → refused;
    - another remote has `<old>` too → refused, since renaming would split
      it;
    - origin no longer has `<old>` (a merged PR's deleted branch) → renamed
      here only, and its upstream is unset;
    - origin has `<old>` and is GitHub (`git remote get-url origin`, with
      `ssh -G` for an ssh alias) and `gh api repos/<o>/<r>` says you can
      push → the GitHub path, with the open PRs from `<old>` listed;
    - no `gh`, not logged in, an origin that isn't GitHub, or a PR list
      that fails → the copy path; `gh` saying you can't push → refused;
    - origin unreachable → refused.

    A branch that was never pushed (one that only tracks `origin/main`
    included) needs no network.

  Enter then runs, in this order:
  1. It checks again, on a fresh list: a worktree of the project, on a
     branch; the new branch free here and on origin; the new folder free
     when the folder would move. If what origin has, or its open PRs,
     changed since the dialog showed them, nothing runs and the dialog
     shows the new state. Otherwise nothing runs, and the dialog says why.
  2. On origin first, for a pushed branch: on GitHub, `gh api -X POST
     repos/<o>/<r>/branches/<old>/rename`; on the copy path, `git fetch` of
     origin's `<old>`, then `git push` of that same commit as `<new>`
     (nothing unpushed goes up; your hooks run). Origin's state then
     decides, looked at again for a few seconds while GitHub finishes. If
     origin doesn't show `<new>`, nothing changes here.
  3. `git branch -m <old> <new>` in the main checkout. If that fails after
     origin is done, a toast says how to finish it by hand.
  4. The upstream: `origin/<new>` after a remote step (written as config,
     then that one branch is fetched); otherwise an upstream with another
     name (the `origin/main` a new workspace starts from) is unset, so a
     push never lands there.
  5. The folder moves only when no space and no terminal is in it:
     `git worktree move` to a sibling named after the branch's last segment
     (`…/app/feat-login` → `…/app/signup`). A new listing decides; if git
     kept the folder, a toast says why. Otherwise the folder stays, and the
     row shows the new branch anyway.
  6. Once the branch is renamed here, the workspace's spaces still named
     after the old branch (its last segment, the name a click gave them)
     take the new one with `space.rename`, so the agents list, which shows
     space names, says what the tree says. A space you named otherwise
     keeps its name, and so does one nobody named.
  7. The fresh list is stored, so the row changes at once.
  - While it runs, Esc, Cancel and clicks do nothing. It runs in a task no
    view owns, so it finishes even if the dialog closes; the outcome is then
    a toast.
  - Like Delete, every outcome is read from git's state (the refs, the
    list, what origin lists), never from its words.
- **Groups:** F1/F2/F3 (in this layout only) select groups 1–3, and a
  missing group does nothing. "+" opens the form: Enter creates and selects
  the group, Esc cancels. Right-click a chip: Organize by Project or by Task
  (the current one checked), Rename…, or Delete group, which only works on
  an empty group that isn't the last one.
- **New workspace:**
  - Opens from a project's "+", Task mode's header button, the project menu
    or `projects.new-workspace`
    (the focused space's project, else the active group's first).
  - Choosing companions: each gets a worktree with the same branch from its
    own default branch, and no space.
  - A name taken in any chosen repo, by a branch (packed ones too) or a
    folder, in any case (`ax-3735` takes `AX-3735`, as a Mac's disk does),
    becomes `-2`, `-3`… for all of them.
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
- **The PR card:**
  - It is about the workspace whose folder Changes, right below, shows: the
    focused pane's live folder, else the focused terminal's, else the
    space's, placed in a checkout by the sidebar's own rule (the deepest
    checkout holding it). So the card and the diff are always the same
    repo, a companion repo's pane included.
  - It reads GitHub when that workspace or its branch changes, and again
    every 30 s while the same one shows, one read at a time, with the
    sidebar's account path (the account that sees the repo). An answer that
    comes after you moved to another workspace is never drawn; it is kept
    for its own workspace, so going back draws it at once.
  - Nothing is asked while the panel is closed or on the Explorer; it reads
    again once Changes shows.
  - It hides its own block, and Changes takes the whole panel, when it has
    nothing to say: a space on another machine, a folder outside every
    project, a project's main checkout, or an origin that isn't GitHub
    (Bitbucket's, for now). It shows again on the next workspace with
    something to say.
  - "Abrir en GitHub" runs `open <url>`, so with the arc-spaces plugin the
    PR opens in the Arc space of the workspace's group, where that group's
    GitHub account is signed in. Only a `https://github.com/` URL is
    opened; a failure is a toast.
- **Mergear** (the card's "Mergear ▾"):
  - It is on for an open PR GitHub would merge: off for a draft, a PR
    with conflicts, one the base's rules block, one that isn't open, a
    repo that allows no method, or when GitHub gave no head commit. GitHub
    still computing, behind or unstable leaves it on: GitHub refuses those
    itself.
  - Its popup lists the methods the repo allows; picking one opens the
    confirm dialog. Mergear there (a click; Enter doesn't merge):
    1. checks that origin is still that repo, and reads the PR again with
       the account that read it for the card; when it isn't the same PR
       any more (another state, a draft again, another base, new commits,
       or the branch's newest PR is another one) nothing is sent ("El PR
       #161 tiene commits nuevos: no se mergeó nada.") and Mergear stays
       off in the dialog. One merged meanwhile says "Ya estaba mergeado en
       GitHub.";
    2. merges it through GitHub's REST API with that same account, never
       another, pinned to the head commit the card showed: if the branch
       moved since, GitHub refuses. The branch is never deleted;
    3. GitHub refusing says GitHub's message ("GitHub no lo mergeó: …").
       No answer in time (exec's 30 s limit) or a server error reads the
       PR again and says what it shows: merged, closed, or "GitHub no
       confirmó el merge…: puede que aún se mergee."
  - The merge finishes even when the dialog is closed with Esc; it then
    reports with a toast. A merge closes the dialog with a toast "PR #161
    mergeado".
  - Afterwards the sidebar asks GitHub for its colors again
    (`projects.refresh-prs`; one already running gets one more after it),
    and the card reads again as soon as the sidebar stores the new state,
    so both turn purple. Clicking "Mergear ▾" also reads the card again.
- **Crear PR** (the card's "Crear PR", on a branch without a PR):
  - Its dialog starts on the project's saved base (Default branch…) when
    git has it, else the repo's default branch on GitHub; the list then has
    origin's 30 most recent branches, never the PR's own. The title starts as
    the branch's last commit's subject (a title typed meanwhile is kept).
  - When it opens it asks origin about the branch (`git ls-remote`): if
    origin doesn't have it, or lacks commits it has, the button says
    "Publicar y crear PR" and the dialog says why. A branch that split from
    origin's (each has commits the other lacks) is never pushed: nothing is
    forced, and the dialog says to bring origin's commits first. Each click
    checks again, so after a pull, or once origin answers, the same dialog
    goes on.
  - "Crear PR" (a click or ⌘↵):
    1. checks that origin is still that repo, and the branch against origin
       again: commits the button didn't say it publishes are never published
       unseen ("Hay commits de <branch> sin publicar: ahora el botón los
       publica antes de crear el PR.") and nothing is made;
    2. publishes the branch when the button said so, `git push -u origin
       <branch>` (your hooks run; up to 2 minutes);
    3. creates the PR through GitHub's REST API with the account that read
       the card, never another, as a draft when Draft is on. GitHub refusing
       says GitHub's message ("GitHub no creó el PR: Validation Failed: A
       pull request already exists for …"); a branch it published stays
       published, and the message says so;
    4. with no answer in time, or a server error, it reads the branch's PR
       again: one there into that base is the one made; none yet says it can
       be tried again (GitHub never opens a second PR from a branch to the
       same base).
  - The create finishes even when the dialog is closed with Esc; it then
    reports with a toast. A create closes the dialog with a toast "PR #162
    creado" ("<branch> → <base> · draft").
  - Afterwards the sidebar asks GitHub for its colors again, and the card
    reads again as soon as the sidebar stores the new PR, so both show it
    (gray while it is a draft). Clicking "Crear PR" also reads the card
    again.

**Built from**

- **Layout `layouts/projects.json`:** Herdr's `main` tree with block
  `spaces` → `{ "mod": "projects" }`, and a new block `groups` →
  `{ "mod": "projects", "props": { "view": "groups" } }` (px 44) between
  `sidebar-lists` and `sidebar-footer`. The status bar (`status`, px 28)
  is a row: `workspace-status` (weight 1), then `{ "mod": "spotlight",
  "props": { "view": "footer" } }` (px 40, the spotlight plugin's test-queue
  flask), then `{ "mod": "claude-accounts", "props": { "view": "footer" } }`
  (weight 1), Claude's usage at its right as in Orca, and last
  `status-agent-sleep` → `{ "mod": "agent-sleep" }` (px 40): the agent-sleep
  plugin's moon, which must be in the shown layout for its loop to run. The
  row's first cell is `status-projects-keeper` → `{ "mod": "projects",
  "props": { "view": "keeper" } }` (px 1), the keeper, outside the sidebar
  so a hidden sidebar still starts it. Block
  `agents` → `{ "mod": "projects-agents" }`. The root sets `"theme":
  "one-dark-pro"`. The right panel runs the window's height beside the tab bar
  and the terminals, as in Orca: the row `work-row` holds the column `work` and
  the column `panel`, whose block `panel-header` → `{ "mod": "code-tabs",
  "props": { "view": "panel" } }` sits above the stack `panel-body`, where the
  child `explorer` → `{ "mod": "code-explorer" }` is active where Herdr has
  `files`: all from the code-editor plugin, whose keys.json brings `cmd-l` →
  `layout.toggle:panel`. The stack's other child, `changes`, is a column
  (`"resizable": false`, gap 8) that keeps that id, so the panel's header and
  its per-space memory still select it: the block `pr-card` → `{ "mod":
  "projects", "props": { "view": "pr" } }` (px 176, the PR card) above
  `changes-diff` → `{ "mod": "changes" }` (weight 1, Herdr's Changes).
  Preview `layouts/projects.svg`.
- **Mod `mods/projects-agents/`:** a copy of Herdr 0.1.13's shipped
  `agents` mod, made the way `mod.clone` makes one (`mod.json` records
  `cloned_from: { name: "agents", version: "0.1.13" }`, and the sort menu
  opens `projects-agents`'s own overlay). The only change: a working agent's
  mark is the projects tree's glyphs in Claude's orange instead of Herdr's
  spinner. Herdr never updates this copy, so a newer Herdr's changes to its
  agents list don't reach it. Herdr's Apache 2.0 license is in the folder.
- **Mod `mods/projects/`** (`mod.json` `{ "place": "none" }`), one mod in
  views picked by `props.view`:
  - none = `tree.js` (the tree);
  - `groups` = `groups.js`;
  - `new-workspace` = `new-workspace.js`;
  - `delete-workspace` = `delete-workspace.js`;
  - `rename-workspace` = `rename-workspace.js`;
  - `task-menu` = `task-menu.js`, `task-note` = `task-note.js`,
    `delete-task` = `delete-task.js`;
  - `pr` = `pr-card.js` (the PR card, in the panel's `pr-card` block);
  - `merge-menu` and `merge-pr` = `merge-pr.js` (Mergear's methods popup
    and its confirm dialog);
  - `create-pr` = `create-pr.js` (Crear PR's dialog);
  - `project-menu`, `workspace-menu`, `group-menu`, `group-form`;
  - `filter-menu` = `filter-menu.js` (the header's Hide sleeping popup);
  - `keeper` = `keeper.js` (the status bar's 1 px cell, and the only copy
    that reads key commands: `main.js` gives it the whole table), `inicio`
    = `inicio.js` (Inicio's view).
  - `main.js` names the view a copy without props draws in one line,
    `const DEFAULT_VIEW = "tree";`, which `scripts/check-views.sh` rewrites
    to check each view.
  - Pure logic is in `lib.js`, `tree-model.js`, `task-model.js`,
    `new-workspace-model.js`, `remove-workspace-model.js`,
    `rename-workspace-model.js`, `badges-model.js`, `pr-model.js` (the PR
    colors), `pr-card-model.js` (the PR card) and `inicio-model.js`, tested
    with `node --test` (Delete's and Rename's against a real git, Inicio's
    against a fake Herdr whose commands land a moment later). The command
    loop is tested on the mod's real copies, with `herdr`, `gpui-kit` and
    `gpui-base` stood in for (`test/inicio-model.test.js`). The card finds
    its workspace with `lib.js` `checkoutAt`, the rule `matchSpaces` places
    spaces by.
  - `store.js` is the only code that touches the shared keys: `projects.v1`
    (groups and projects), `projects.ui.v1` (collapsed projects, folded
    lanes, and Hide sleeping: `"hideSleeping": true` only while on,
    `"exceptMain": false` only while Except default branch is off),
    `projects.cache.v1`
    (worktree lists), `projects.agents.v1` (`knownAgents()`),
    `projects.notes.v1` (task notes), `projects.prs.v1` (the PR of each
    workspace's branch, `pr-model.js`), `projects.prs-ask.v1` (a number
    that grows at each `projects.refresh-prs`) and `projects.inicio.v1` (Inicio's
    space id, `{ "space": "<id>" }`, written only by the keeper). A stored `projects.v1` with a malformed
    group or project keeps the valid rest, and the original is copied to
    `projects.v1.backup` before the first write over it; a malformed
    `projects.notes.v1` goes to `projects.notes.v1.backup` the same way.
    It also reads the badge keys `badges.spotlight`, `badges.pr` and
    `badges.hibernate`, read-only: other plugins write them, and this
    plugin never writes or clears one.
  - `config.js` holds `MOD`, `WORKTREE_ROOT` (`~/orca/workspaces`) and
    `BADGE_KEYS`.
- **Commands:** `projects.add`, `projects.add-here`, `projects.new-workspace`,
  `projects.group1`..`projects.group3`, `projects.ping`,
  `projects.refresh-prs` (a PR round now, or one more after the one
  running: Mergear and Crear PR run it after theirs. It leaves the ask in
  `projects.prs-ask.v1`, and the tree in the window in front runs the
  round at its next second, so the tree stays the only writer of the PR
  colors),
  `projects.space-next`, `projects.space-prev`,
  `projects.space-1`..`projects.space-9`, `projects.toggle-sleeping`
  (Hide sleeping on or off, Orca's "Toggle Sleeping Workspaces", with no
  default key). `keys.json` binds, in section
  `layout:projects`, F1–F3 to the groups, and `cmd-alt-]`, `cmd-alt-[` and
  `ctrl-1`…`ctrl-9` to the space commands. All of them run in the keeper's
  copy.
- **Herdr functions:** `spaces`, `panes`, `agents`, `focused`,
  `knownAgents`, `layout`, `window`, `machines`, `keys`, `home`,
  `pickFolder`, `watchFolder`, `exec`, `run` (`space.select`, `space.new`,
  `space.close`, `pane.focus`, the PR card's `layout.show` and
  `layout.hide` of its own block, and Mergear's and Crear PR's
  `projects.refresh-prs`; the keeper adds `space.move`, `space.rename`,
  `tab.new`, `tab.close` and `pane.close`), `openOverlay`, `closeOverlay`,
  `shared`, `setShared`, `notify`, `theme`, `props`, `nextCommand`.
- **Programs it runs:**
  - `git`, in the registered repos: `rev-parse --git-common-dir`,
    `worktree list --porcelain`, `for-each-ref`, `show-ref`, `fetch origin`
    (network) and `worktree add`. Delete adds `status --porcelain`,
    `rev-parse --git-path modules`, `ls-files --stage -z`, `worktree remove`
    and `branch -d`. Rename adds `config --get` (the branch's upstream),
    `branch -m`, `branch --unset-upstream` and `worktree move`; for a
    pushed branch, `ls-remote origin` (network), `remote get-url origin`,
    `fetch origin` of one branch, `push origin` (the copy), `config
    --replace-all` (the upstream) and `update-ref -d` (the local
    `origin/<old>` GitHub renamed away).
  - `gh api` (Rename of a pushed branch on GitHub): `repos/<o>/<r>` (can
    you push), `repos/<o>/<r>/pulls` (open PRs from the branch) and
    `branches/<old>/rename`, run in the repo with your gh account.
  - `gh api graphql` (the PR colors): one query per project of the active
    group, with every workspace branch but the main checkout's, every
    minute while the window is in front, and again on coming back to it or
    switching groups (at most every 10 s). Only the window in front asks,
    and only for repos whose origin is GitHub (an ssh alias of github.com
    counts). The answer is stored in `projects.prs.v1`, so every window
    draws it and it is there at the next start.
  - `gh api graphql` (the PR card): one query for the newest PR of the
    branch Changes shows, with its checks, reviews and the repo's merge
    methods, when that workspace changes and every 30 s while Changes
    shows; then `git rev-list --left-right --count origin/<base>...HEAD` in
    the workspace for ↑↓.
  - `gh api -X PUT repos/<o>/<r>/pulls/<n>/merge -f merge_method=<m> -f
    sha=<head>` (Mergear), after the card's query once more, both with the
    account that read the PR; the query again when GitHub gave no answer.
    Never `gh pr merge`, which from a worktree fails checking out the base.
  - Crear PR, in the workspace: `git log -1 --format=%s` (the title),
    `rev-parse --verify`, `ls-remote origin refs/heads/<branch>` (network),
    `rev-list --left-right --count`, a `fetch` of that one branch when
    origin's commit isn't here, and, when it publishes, `git push -u origin
    refs/heads/<branch>:refs/heads/<branch>` (never forced; 2 minutes
    instead of exec's 30 s, for your hooks). Then `gh api -X POST
    repos/<o>/<r>/pulls -f title=… -f head=<branch> -f base=<base> -f
    body=… -F draft=<true|false>` with the account that read the card, and
    the card's query again when GitHub gave no answer. Never `gh pr create`.
  - Two GitHub accounts: gh runs in the project's folder, where a gh
    wrapper that picks the account by repo picks it, and plain gh uses its
    active account. When GitHub answers that it can't see the repo, the
    other accounts `gh auth status --json hosts` lists are tried through
    `sh -c` with `GH_TOKEN` from `gh auth token --user <login>` (the token
    stays in that shell), and the account that sees it is remembered for
    that owner while Herdr runs.
  - `ssh -G <host>`, to read which host an ssh alias of origin's URL is.
  - `test -e`, to check whether a folder exists.
  - `open <url>`, the PR card's "Abrir en GitHub".
  - Whatever program another plugin's badge names in its `exec`, when you
    click that badge; its hover says which ("· runs <program>").
- **Art:** its own Lucide-style icons in `icons/` (folder, folder-plus,
  branch, home, plus, code, copy), plus chevrons, check, x and square-pen
  from Herdr's `workspace-chrome`, agent icons from Herdr's `icons/`, and
  Herdr's `frame/welcome/herdr.png` on Inicio.

**Badges from other plugins**

Other plugins can put small indicators ("badges") on workspace rows, the
Spotlight plugin first. This plugin knows none of them: it reads, draws and
runs what they publish. This section is the contract a publisher codes
against.

- **Keys:** `badges.spotlight`, `badges.pr` and `badges.hibernate`, read in
  that order (`config.js` `BADGE_KEYS`). A plugin writes only its own key,
  with `setShared(key, value)`; each write replaces the whole value, every
  path at once. Adding a plugin is one line in that list.
  There is no index key listing the plugins: shared state keeps the last
  write, so two plugins adding themselves to one list at start would race.
- **Value:** `{ [workspacePath]: [badge] }`.
  - A path is the workspace's folder, absolute, spelled as `git worktree
    list` prints it (a trailing slash is ignored). Any other key is ignored.
  - A value that isn't an object (`null`, a string, a list) is no badges.
  - A path whose value isn't a list draws nothing there.
- **A badge:** `{ icon?, text?, tone?, tooltip?, action? }`.
  - `icon`: an SVG under Herdr's home (`~/.config/herdr-app`),
    `mods/<mod>/…/<name>.svg` at any depth, with no `..`, empty segment or
    backslash. Drawn 12 px, tinted. Build it from your mod's folder name:
    an install may have renamed it.
  - `text`: at most 16 code points (a longer one is cut), on one line:
    runs of whitespace become one space.
  - `tone`: `accent`, `dim`, `working`, `blocked` or `done`, the theme's
    colors of those names; anything else is `dim`.
  - `tooltip`: at most 200 code points (a longer one is cut), on one line
    like `text`: runs of whitespace (newlines too) become one space, so
    what a click runs, shown after it, stays in view.
  - A badge needs an icon or a text; one with neither is dropped.
  - A field that breaks a rule is dropped alone: a bad icon or action goes
    and the rest of the badge stays. Unknown fields are ignored.
- **`action`:** `{ "command": "<mod>.<command>" }` or
  `{ "exec": [program, ...args] }`, never both (both drop the action):
  - `command` must match `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$`,
    and the part before its first `.` must be your key's first name after
    `badges.`: a badge under `badges.spotlight` (or `badges.spotlight.v2`)
    may run `spotlight.toggle`, never `pr.open` nor `app.quit`. `run` also
    runs Herdr's own commands (`app.quit`, `window.close`, `app.reset`…),
    so any other command drops the action. A mod an install renamed
    (`spotlight-2`) can't use `command`, since its commands no longer match
    its key: use `exec`. It goes through `run(command)`:
    it reaches that mod's shown copies only, with no args
    (`nextCommand()` yields only the name), and it can't report a failure
    (`run` returns null). An action that needs args, or must say it
    failed, uses `exec`.
  - `exec`: 1 to 20 strings, each at most 500 chars, with no NUL.
    `argv[0]` is a bare name (no `/`) or an absolute path. A relative path
    (`./x`, `bin/x`) drops the action: it would run a file from whatever
    branch the workspace has checked out. Prefer an absolute path.
  - An `exec` click runs `exec(argv[0], argv.slice(1), { cwd: <the
    workspace's folder> })`: argv only, never a shell. It gets Herdr's
    environment, whose PATH is `~/.local/bin` and then the login shell's
    (`$SHELL -l`, which reads `/etc/paths` and `.zprofile` but not
    `.zshrc`). So a bare name finds `/usr/local/bin`, but not a folder only
    `.zshrc` adds to PATH. exec stops it after 30 s.
  - A non-zero exit, or a program that can't start, shows a warning toast
    titled with the program's name: stderr's first line, else "exited with
    code N". While a badge's program runs, more clicks on it are ignored.
- **Limits:** at most 3 badges per plugin on a row, and 4 per row in all,
  in key order; the rest aren't drawn.
- **Drawing:** after the workspace row's label, in Project and Task modes,
  main checkouts included, never on the narrow rail. The icon, then the
  text (11.5 px), in the tone's color. The row's badges share 128 px (one
  badge up to 72 px, four up to 29 px each, 4 px apart), and a long text
  ends in "…", so the label keeps its room. The hover shows the tooltip,
  then what a click runs: "· runs <argv[0]>" or "· <command>".
- **Clicks:** a click runs the action and doesn't open the workspace. A
  right-click opens the workspace menu, as on the row, and never runs the
  action. A badge without an action clicks like its row.
- **Lifetime:** the format only grows; a breaking change gets a new key
  (e.g. `badges.spotlight.v2`). A publisher clears its own paths, and its
  key (`setShared(key, null)`), when they no longer apply: a stale badge
  stays until it does.
- **Example:** this `badges.spotlight` value draws a "live" badge in the
  `working` color on one workspace. Its hover reads "Spotlight is on · runs
  /usr/local/bin/spotlight", and a click runs that program with the three
  args, in that workspace's folder:

  ```json
  {
    "/Users/you/orca/workspaces/app/login": [
      {
        "icon": "mods/spotlight/icons/spotlight.svg",
        "text": "live",
        "tone": "working",
        "tooltip": "Spotlight is on",
        "action": { "exec": ["/usr/local/bin/spotlight", "toggle", "--workspace", "/Users/you/orca/workspaces/app/login"] }
      }
    ]
  }
  ```

**Watch out**

- **This mod runs git and reaches the network:** `git fetch origin` in
  every repo you create in, `ls-remote`, `fetch`, `push` and `gh` when
  you rename a pushed branch, and `gh api graphql` every minute for the PR
  colors while the window is in front (one GraphQL point per project with
  workspaces), plus one for the PR card every 30 s while Changes shows and
  each time it shows another workspace. Crear PR's dialog asks origin with
  `ls-remote` when it opens, and Crear PR may `push`. It reads repo
  folders outside its own and writes worktrees under `~/orca/workspaces`.
  Change `WORKTREE_ROOT` in `config.js` to put them elsewhere.
- **Install by copying.** Herdr doesn't load a mod folder that is a
  symlink ("no mod folder …"). `scripts/install.sh` copies the files and
  lists them in `<home>/.herdr-plugins/projects-sidebar.txt`.
- **A command sent while the mod reloads is lost** (no error). Wait for the
  reload before scripting `herdr-app do projects.*`.
- **Never launch the agent as `env VAR=1 claude`:** Herdr then sees `zsh`,
  not an agent, and shows no status. Use `claude --settings '{"env":{…}}'`.
- **Merging `keys.json`:** F1–F3 and the space keys need the plugin's
  `keys.json` merged into yours. Once edited, your keys.json no longer
  receives Herdr's new default shortcuts. In this layout, F2 replaces
  Herdr's `tab.rename`, and `cmd-alt-]`, `cmd-alt-[` and `ctrl-1`…`ctrl-9`
  replace `space.next`, `space.prev` and `space.select:N`; the installer
  names each global key the layout's binding shadows. A key you already
  bind in `layout:projects` keeps your binding.
- **Delete deletes.** It removes the worktree's folder, its uncommitted
  work after "Delete anyway", and its merged branch. Its spaces close with
  their agents, including an agent session running in that worktree.
- **Delete task deletes several workspaces at once,** in every project of
  the group, with their spaces and agents. It keeps going past one that
  fails. Its run, like Delete's, finishes even when the dialog closes; a
  reload of the plugin stops it before the next workspace.
- **exec's 30 s limit:** `git worktree remove` on a big worktree can hit it.
  The dialog then says "git didn't finish; the folder may be partly deleted.
  Check `git worktree list` in <project>."
- **Locked worktrees** are never deleted from here. Run `git worktree unlock
  <path>` first.
- **`branch -d` keeps squash-merged branches.** A branch merged on GitHub by
  squash or rebase isn't merged for git, so it stays ("Kept branch <b>").
  Delete it yourself with `git branch -D` once you're sure.
- **Mergear merges on GitHub, and that can't be undone** (only a revert
  commit follows it). It merges with the account that read the PR for the
  card: the folder's own gh account, or the other one you're logged into
  when only that one sees the repo. It never deletes the branch.
- **A merge with no answer may still finish.** exec gives up after 30 s;
  the dialog then reads the PR again and says what GitHub shows. Check the
  PR before trying again.
- **Crear PR publishes your branch** when origin doesn't have it or lacks
  its commits (the button then says "Publicar y crear PR"), with `git push
  -u`, so the branch tracks `origin/<branch>` from then on. It never forces a
  push. It creates the PR with the account that read the card, like Mergear.
  A branch it published stays published when GitHub then refuses the PR.
- **Rename can change GitHub:** it runs `gh` with your account, and GitHub
  closes a PR opened from the renamed branch. Without `gh` it pushes a copy;
  it never deletes the old branch.
- **A branch on two remotes isn't renamed** ("Also pushed as
  <remote>/<old>: renaming would split it."), and neither is one whose new
  name origin already has.
- **GitHub renames in the background.** If it hasn't shown the new name
  after a few seconds, nothing changes here and the dialog says how to
  check (`git ls-remote origin refs/heads/<new>`) and finish (`git branch -m
  <old> <new>`).
- **The folder stays** while a space or a terminal is in it, or while the
  worktree is locked or has submodules, even when a folder with the new
  name exists. The branch is still renamed, and the row shows it.
- **Claude Code's history after a move:** Claude Code keeps sessions under
  `~/.claude/projects/<old path with dashes>`, so `claude --continue` in the
  moved folder starts fresh.
- **In Task mode there are no project rows,** so a project's own menu (Move
  to group, Remove from list) isn't there: switch the group to Organize by
  Project to move or remove a project. Collapsing a project also only
  applies in Project mode.
- **`herdr-app check` draws only the tree view.** Check the other views
  from a copy whose `main.js` defaults to them: `scripts/check-views.sh
  projects-sidebar/mods/projects pr merge-menu merge-pr create-pr` checks
  the PR card, Mergear's popup and dialog, and Crear PR's dialog, and
  `scripts/check-views.sh projects-sidebar/mods/projects inicio keeper`
  checks Inicio and the keeper, and `scripts/check-views.sh
  projects-sidebar/mods/projects tree filter-menu` the tree and its filter
  popup. Outside Herdr there is no workspace and no
  props, so that check draws their empty states only.
- **The PR card hides by clicking:** its `layout.hide` / `layout.show` is a
  layout click, which Herdr saves in `layouts/.state/`. Moving between a
  workspace the card shows and one it doesn't (a main checkout, a Bitbucket
  repo) writes that file; it never runs when nothing changes.
- **After a restart or a layout switch the tree shows the card's block**
  when Herdr kept it hidden: a copy starts only when its block shows, so a
  hidden card would never come back on its own. The tree tries each second
  until it sees the card's copy running (shown after its show, or shown two
  seconds in a row), at most five shows per layout load. A space where the
  card has nothing to say only from what it reads (an origin that isn't
  GitHub) can flash the card that many times after a restart.
- **The PR card and the diff can differ** only when the folder Changes
  shows is a repo nested in a registered checkout (a submodule): the card
  shows the checkout's branch, the diff the nested repo.
- **Inicio rests on what Herdr shows after a close:** the space at the
  closed one's place, seen but not documented. If Herdr changes it, the
  keeper still shows Inicio, after a flash of the space Herdr chose.
- **Inicio counts in the space order** for Herdr's own commands. In this
  layout the plugin's keys skip it, but `space.next`, `space.prev` and
  `space.select:N` run any other way (the palette, `herdr-app do`, another
  layout's keys, a key you bound yourself) land on it.
- **Commands need the keeper.** In a layout without the keeper's cell, no
  copy reads `projects.*` commands: keys and `herdr-app do projects.*` do
  nothing there.
- **Limits:**
  - Only the first three groups have keys.
  - Branch names have no user prefix and are slugged to 48 characters,
    keeping the case typed (`AX-3735` stays `AX-3735`, as in Orca). A name
    is never `HEAD` (git refuses it, so the dialog asks for a name) and
    never ends in `.lock` in any case (`x.LOCK` becomes `x`: on a Mac's
    disk it is the lock file of `x`).
  - Names are compared ignoring case, as a Mac's disk does, so `ax-1` and
    `AX-1` never both come from the plugin, and a branch can't be renamed
    to a case change of itself.
  - Linear, GitLab and fetching issue titles aren't supported; such a link
    is named by its slug.
  - The main checkout is never renamed or deleted, and a branch is deleted
    only when git sees it merged.
  - Two chosen projects with the same folder name (`/a/web`, `/b/web`) would
    land on the same worktree path: the dialog says so and Create stays off.

**Done when**

- `node --test 'test/*.test.js'` reports `fail 0`, and `herdr-app check`
  passes on `mods/projects`, and `scripts/check-views.sh
  projects-sidebar/mods/projects pr merge-menu merge-pr create-pr` on the
  PR card, Mergear's and Crear PR's views.
- After `scripts/install.sh` and `layout.switch {name: "projects"}`, the
  sidebar shows "Projects" with an empty state. The groups bar shows one
  highlighted code icon whose tooltip reads "Projects · F1".
- With a space open in a repo, `herdr-app do projects.add-here` lists that
  repo with `main` (home icon, open dot) and its other worktrees.
  A space in a folder outside every project is not shown.
- With the layout shown, a space named Inicio exists right after the shown
  space and shows Herdr, the hint and both buttons. Cmd+W on the last tab of
  a middle space and of the last space both land on Inicio with no other
  worktree drawn, and so they do with the sidebar hidden (cmd-b).
- `layout.resize {id: "sidebar", px: 76}` shows initials in the tree and
  smaller, centered chips in the groups bar.
- With keys.json merged, F1–F3 select groups 1–3 while a terminal has focus,
  and F2 no longer opens Rename tab in this layout.
- With keys.json merged and Inicio right after the shown space,
  `cmd-alt-]` and `cmd-alt-[` step through the spaces without ever showing
  Inicio, and wrap at the ends; `ctrl-1`…`ctrl-9` select the spaces they
  selected before Inicio existed. With the sidebar hidden (cmd-b), `herdr-app
  do projects.ping` shows a toast that says `view keeper`.
- `herdr-app do projects.new-workspace` opens the dialog on the focused
  space's project, with `origin/main` (or the repo's default) marked
  "default".
- Creating `demo` with one companion makes `~/orca/workspaces/<repo>/demo`
  in both repos, on branch `demo`. It opens one space, and its agent was
  started with `--add-dir` for the companion.
- Right-click a throwaway worktree → Delete… → Delete: its space closes, and
  its folder, its row and its merged branch are gone. A dirty one asks
  "Delete anyway"; a locked one has no Delete.
- With a throwaway task `odd-t14` (one worktree in each of two projects of
  a Task-mode group, one holding an untracked file), right-click its lane →
  Delete task…: the button reads "Delete anyway", and afterwards both
  folders, both merged branches and the lane are gone, and so is its note.
- Right-click a throwaway worktree → Rename… → a new name → Enter: with no
  terminal in it, its branch and its folder take the name. With a space
  open there, the folder stays and the row shows the new name. A branch
  pushed with `-u` to a GitHub origin is renamed there too: `git ls-remote
  origin refs/heads/<new>` lists it, `refs/heads/<old>` is gone, and its
  upstream is `origin/<new>`.
- Right-click the group's chip → Organize by Task: the tree shows task lanes
  (`test`, `test-2`, … then "Servers" with `main`), each row naming its
  project. A folded lane stays folded after a reload. Organize by Project
  brings the tree back.
- `cmd-l`, then the panel's Changes icon, on a workspace whose branch has an
  open GitHub PR: the PR card sits above Changes with "PR #<n> · Open" in
  green, its title, "head → base" with ↑↓, Checks and Reviews, and "Abrir
  en GitHub" opens the PR. On a branch without one: "Esta rama no tiene
  PR". On the project's main checkout, or a repo whose origin isn't
  GitHub, the card is gone and Changes takes the whole panel. `cmd-l` and
  the header's icons still open, switch and close the panel.
- On a throwaway PR into a throwaway base (never `main`): "Mergear ▾" →
  "Squash y mergear" → Mergear merges it, the dialog closes with "PR #<n>
  mergeado", and the card and the sidebar's branch icon turn purple. With
  one more commit pushed to the head after the card read it, Mergear says
  "El PR #<n> tiene commits nuevos: no se mergeó nada." and nothing is
  merged.
- On a throwaway branch with commits origin doesn't have yet, into a
  throwaway base (never `main`): the card says "Esta rama no tiene PR" →
  "Crear PR" → the dialog starts on the base, the last commit's subject as
  the title, and "Publicar y crear PR"; with Draft on, it publishes the
  branch (`git ls-remote origin refs/heads/<branch>` lists it), the dialog
  closes with "PR #<n> creado", and the card and the sidebar's branch icon
  show the draft PR in gray. Close that PR on GitHub afterwards.
