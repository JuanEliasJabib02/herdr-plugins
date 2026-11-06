// The New workspace dialog's model, with no herdr or gpui-kit imports so
// `node --test` can load it: the name a workspace gets (slug, smart input,
// a name free in every repo), the base it starts from (a project's saved
// base, D37, and the Default branch… menu's rows), the projects and
// agents the dialog offers, the agent's argv, and the creation itself. git
// and the file check are passed in (M/git.js binds them to Herdr's exec;
// tests pass a real git), like lib.js's repo resolution.

import { normPath, baseName, activeGroup, findProject, setProjectBase } from "./lib.js";

// ── Names (D12) ────────────────────────────────────────────────────────────

export const NAME_MAX = 48;

// Dashes and dots at either end: git refuses a branch that starts with a dot
// or ends with one, and a name that starts with a dash would read as a flag.
const trimEnds = (s) => s.replace(/^[-.]+|[-.]+$/g, "");

// What a typed name becomes, as the branch and the folder: the case typed
// (AX-3735 stays AX-3735, as in Orca), accents dropped, every run of other characters one dash, no dashes or dots
// at the ends, no "..", no ".lock" ending, at most NAME_MAX characters.
// Always a name git takes as a branch, or "".
export function slug(text) {
  if (typeof text !== "string") return "";
  let s = text.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".");
  s = trimEnds(trimEnds(s).slice(0, NAME_MAX));
  while (s.endsWith(".lock")) s = trimEnds(s.slice(0, -5));
  return s;
}

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)(?:[/?#]|$)/i;
const JIRA = /^https?:\/\/[^/]+(?:\/[^?#]*)?\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]|$)/;

// The name field read the way Orca reads it: `#12` or `12` → issue-12, a
// GitHub pull or issue URL → pr-N / issue-N, a Jira /browse/KEY-N link →
// KEY-N, anything else its slug. A URL also becomes the agent's first
// message, `Complete <url>`; nothing is fetched. { name, task }
export function parseInput(text) {
  const t = typeof text === "string" ? text.trim() : "";
  const issue = /^#?(\d+)$/.exec(t);
  if (issue) return { name: `issue-${issue[1]}`, task: null };
  if (!/^https?:\/\/\S+$/i.test(t)) return { name: slug(t), task: null };
  const task = `Complete ${t}`;
  const gh = GITHUB.exec(t);
  if (gh) return { name: `${gh[1].toLowerCase() === "pull" ? "pr" : "issue"}-${gh[2]}`, task };
  const jira = JIRA.exec(t);
  if (jira) return { name: slug(jira[1]), task };
  return { name: slug(t), task };
}

// The n-th try of a name: the name itself, then name-2, name-3… cut so the
// whole stays within NAME_MAX.
function nth(name, n) {
  if (n < 2) return name;
  const suffix = `-${n}`;
  return `${trimEnds(name.slice(0, NAME_MAX - suffix.length))}${suffix}`;
}

// The first of name, name-2, name-3… that no repo has taken. `takenByRepo`:
// each repo's taken names (arrays or sets), by repo or as a list. One name
// for all of them: a name taken in one companion moves every repo on.
export function pickName(name, takenByRepo) {
  if (!name) return "";
  const lists = Array.isArray(takenByRepo) ? takenByRepo : Object.values(takenByRepo ?? {});
  const sets = lists.map((t) => (t instanceof Set ? t : new Set(t ?? [])));
  for (let n = 1; ; n++) {
    const candidate = nth(name, n);
    if (!sets.some((s) => s.has(candidate))) return candidate;
  }
}

// Asks `taken(repo, name)` (async) of every repo, one candidate at a time,
// and returns the first name free in all of them (pickName).
export async function freeName(name, repos, taken, tries = 100) {
  const known = repos.map(() => new Set());
  for (let i = 0; i < tries; i++) {
    const candidate = pickName(name, known);
    if (!candidate) return "";
    const hits = await Promise.all(repos.map((r) => taken(r, candidate)));
    if (!hits.some(Boolean)) return candidate;
    hits.forEach((hit, j) => hit && known[j].add(candidate));
  }
  throw new Error(`No free name for ${name}.`);
}

// Where a workspace goes: <root>/<repo name>/<name>, `~` expanded.
export const worktreePath = (root, repoName, name, home) => normPath(`${normPath(root, home)}/${repoName}/${name}`);

// The folder name a project's workspaces go under.
export const repoName = (project) => project.name || baseName(project.path);

// ── Bases (D13) ────────────────────────────────────────────────────────────

export const BASE_FALLBACKS = ["origin/main", "origin/master", "main", "master"];

// The base a new workspace starts from: origin/HEAD's target when that branch
// exists, else the first of BASE_FALLBACKS that exists, else HEAD.
// `existing`: short names (origin/main, main).
export function pickDefaultBase(originHead, existing) {
  const have = new Set(existing ?? []);
  if (originHead && have.has(originHead)) return originHead;
  return BASE_FALLBACKS.find((b) => have.has(b)) ?? "HEAD";
}

// The Create from list: the default, then the most recent remote branches
// (30 at most), without origin/HEAD or repeats.
export function baseChoices(defaultBase, recent) {
  const rest = (recent ?? []).filter((b) => b !== "origin/HEAD" && b !== defaultBase).slice(0, 30);
  return [...new Set([defaultBase, ...rest].filter(Boolean))];
}

// refs/remotes/origin/main → origin/main, refs/heads/main → main.
const shortRef = (ref) => ref.replace(/^refs\/(remotes|heads)\//, "");
const lines = (out) => String(out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// The git each step runs. Typed text only ever reaches git as one argv entry
// (Herdr's exec runs no shell); names can't start with a dash (slug) and
// `--` ends the options before the path and the base.
export const GIT = {
  fetch: ["fetch", "origin"],
  originHead: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
  refs: (refs) => ["for-each-ref", "--format=%(refname)", ...refs],
  recent: ["for-each-ref", "--sort=-committerdate", "--count=31", "--format=%(refname)", "refs/remotes/origin"],
  branch: (name) => ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
  add: (name, path, base) => ["worktree", "add", "--no-track", "-b", name, "--", path, base],
};

// `git fetch origin`; never rejects: { ok: false, err } when it fails, times
// out or can't start.
export async function fetchOrigin(repo, git) {
  try {
    return await git(repo, GIT.fetch);
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

// A repo's default base (pickDefaultBase), or null when it isn't a git
// repository.
export async function defaultBaseOf(repo, git) {
  const h = await git(repo, GIT.originHead);
  const originHead = h.ok && h.out ? shortRef(h.out) : null;
  const wanted = [...(originHead ? [`refs/remotes/${originHead}`] : []), "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  const r = await git(repo, GIT.refs(wanted));
  if (!r.ok) return null;
  return pickDefaultBase(originHead, lines(r.out).map(shortRef));
}

// The 30 most recently committed remote branches (origin/…), newest first;
// none outside git.
export async function recentBasesOf(repo, git) {
  const r = await git(repo, GIT.recent);
  return r.ok ? lines(r.out).map(shortRef).filter((b) => b !== "origin/HEAD").slice(0, 30) : [];
}

// Whether origin/<branch> (`base`, a short ref) is there: one exact
// for-each-ref lookup, as defaultBaseOf does. for-each-ref also matches a
// pattern up to a slash, so the answer must name the ref itself:
// origin/release/1 alone is not origin/release.
export async function baseExistsIn(repo, base, git) {
  const ref = `refs/remotes/${base}`;
  const r = await git(repo, GIT.refs([ref]));
  return r.ok && lines(r.out).includes(ref);
}

export async function branchExistsIn(repo, name, git) {
  return (await git(repo, GIT.branch(name))).ok;
}

// `git worktree add --no-track -b <name> -- <path> <base>` in the repo; git
// creates the folders on the way. { ok, out, err }.
export function addWorktreeIn(repo, { name, path, base }, git) {
  return git(repo, GIT.add(name, path, base));
}

// The git steps above bound to one git(cwd, args).
export function gitOps(git) {
  return {
    fetch: (repo) => fetchOrigin(repo, git),
    defaultBase: (repo) => defaultBaseOf(repo, git),
    recentBases: (repo) => recentBasesOf(repo, git),
    baseExists: (repo, base) => baseExistsIn(repo, base, git),
    branchExists: (repo, name) => branchExistsIn(repo, name, git),
    addWorktree: (repo, spec) => addWorktreeIn(repo, spec, git),
  };
}

// taken(project, name) for freeName: the branch exists in that repo, or the
// workspace's folder is already there. `io`: { branchExists, exists }.
export function nameTaken(io, root, home) {
  return async (project, name) =>
    (await io.branchExists(project.path, name)) || (await io.exists(worktreePath(root, repoName(project), name, home)));
}

// ── A project's saved base (D37, S33) ──────────────────────────────────────
// Saved on the project in projects.v1 (lib.js setProjectBase): from the
// Default branch… menu, or remembered from a Create. Without one, a repo's
// default is origin's (defaultBaseOf). The root's branch never counts: it
// moves.

// A repo's default base: the project's saved base when git has it (`has`:
// baseExistsIn's answer), else `originDefault` (defaultBaseOf). { def, gone }:
// gone is the saved base git doesn't have ("origin/develop"), else null. A
// repo that isn't git (originDefault null) has neither.
export function baseFor(project, originDefault, has) {
  if (originDefault === null) return { def: null, gone: null };
  const saved = project?.base ?? null;
  if (!saved) return { def: originDefault, gone: null };
  return has ? { def: saved, gone: null } : { def: originDefault, gone: saved };
}

// The registry after a successful Create, which `ran` (the primary's step
// base) started: origin's default clears the saved base, another base is
// saved, and the saved one changes nothing (the same registry). Picking a
// base in the dialog alone never saves. A base setProjectBase refuses (a
// local one: "main", "HEAD") changes nothing either.
export function rememberBase(registry, path, ran, originDefault) {
  if (ran === originDefault) return setProjectBase(registry, path, null);
  const saved = findProject(registry, path)?.project.base ?? null;
  return ran === saved ? registry : setProjectBase(registry, path, ran);
}

// The Default branch… menu's rows: [{ base, label, checked }], base null for
// "origin's default (<ref>)", which clears the saved base and comes first;
// then the saved base, pinned right after it when the recent branches lack
// it; then the recent branches (recentBasesOf) without origin's default,
// which the first row already is. The saved one is checked, else the first.
// None outside git (originDefault null), nor with no remote branch and
// nothing saved: the menu says "No remote branches".
export function baseMenuRows(originDefault, recent, saved) {
  const list = recent ?? [];
  if (originDefault === null || (list.length === 0 && !saved)) return [];
  const rest = list.filter((b) => b !== originDefault && b !== "origin/HEAD");
  const pinned = saved && !rest.includes(saved) ? [saved] : [];
  return [
    { base: null, label: `origin's default (${originDefault})`, checked: !saved },
    ...[...pinned, ...rest].map((b) => ({ base: b, label: b, checked: b === saved })),
  ];
}

// ── Projects (D16) ─────────────────────────────────────────────────────────

// The Project list: the active group's projects only, the space you're in
// (Juan: "no esta filtrado x el space en el q estoy"). Another group's
// projects are reached by switching groups. [{ path, name, group }]
export function projectChoices(registry) {
  const active = activeGroup(registry);
  return (active?.projects ?? []).map((p) => ({ path: p.path, name: p.name, group: active.name }));
}

// The "Also create in" chips: the other projects of the primary's group.
export function companionChoices(registry, primaryPath) {
  const found = primaryPath ? findProject(registry, primaryPath) : null;
  if (!found) return { group: null, projects: [] };
  return { group: found.group, projects: found.group.projects.filter((p) => p.path !== found.project.path) };
}

// The project the dialog opens on: `wanted` when it is in the active group,
// else the active group's first, else null (the empty state, whose Add
// project adds to the active group). Never another group's: the focused
// space may belong to one.
export function initialProject(registry, wanted) {
  const active = activeGroup(registry);
  const found = wanted ? findProject(registry, wanted) : null;
  if (found && found.group.id === active?.id) return found.project;
  return active?.projects[0] ?? null;
}

// ── Agents (D15) ───────────────────────────────────────────────────────────

// The Agent list's last entry: a shell, no argv.
export const BLANK = Object.freeze({ key: "", name: "Blank terminal", icon: "icons/shell.svg", tint: true, run: null, installed: true });

// Read by Claude Code: load the CLAUDE.md and rules of every --add-dir too.
// Passed through --settings, never an `env` prefix: Herdr only recognizes an
// agent launched as itself (T1 probe).
export const CLAUDE_SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } });

// knownAgents() (or its cached copy) as the Agent list: the installed ones,
// then Blank terminal.
export function agentChoices(agents) {
  const installed = (agents ?? []).filter((a) => a?.installed && Array.isArray(a.run) && a.run.length > 0);
  return [...installed, BLANK];
}

export function defaultAgent(choices) {
  return choices.find((a) => a.key === "claude") ?? choices[0] ?? BLANK;
}

// Whether "Give the agent access to these worktrees" means anything for it.
export const takesDirs = (agent) => agent?.key === "claude" || agent?.key === "codex";

// The primary's launch argv (null: a blank terminal). With companions and
// access on, Claude gets one --add-dir per companion plus --settings with
// CLAUDE_SETTINGS, Codex the --add-dirs only, others nothing extra. The
// --add-dirs come before --settings: Claude's --add-dir takes several
// values, so it never ends the argv where a first message could follow.
export function agentArgv(agent, companionPaths, access) {
  if (!Array.isArray(agent?.run) || agent.run.length === 0) return null;
  const dirs = access && takesDirs(agent) ? (companionPaths ?? []).flatMap((d) => ["--add-dir", d]) : [];
  if (dirs.length === 0) return [...agent.run];
  return agent.key === "claude" ? [...agent.run, ...dirs, "--settings", CLAUDE_SETTINGS] : [...agent.run, ...dirs];
}

// ── Creation (D14) ─────────────────────────────────────────────────────────

// The worktrees to add, in order: every companion from its own default base,
// then the primary from the chosen base (else its default). `defaults`:
// { [repo path]: base }.
export function creationPlan({ primary, companions, name, base, defaults, root, home }) {
  const step = (p, from, isPrimary) => ({
    repo: p.path, project: repoName(p), name, path: worktreePath(root, repoName(p), name, home), base: from, primary: isPrimary,
  });
  return [
    ...(companions ?? []).map((c) => step(c, defaults?.[c.path] || "HEAD", false)),
    step(primary, base || defaults?.[primary.path] || "HEAD", true),
  ];
}

// Every workspace goes to <root>/<repo name>/<name>, so two chosen projects
// with one folder name (/a/web and /b/web) would get the same path: the
// second `git worktree add` fails after the first one was made. The groups
// of chosen projects that share a folder name (case ignored, as macOS
// folders do), in the order given; [] when there is none.
export function pathClashes(projects) {
  const byFolder = new Map();
  for (const p of projects ?? []) {
    const key = repoName(p).toLowerCase();
    byFolder.set(key, [...(byFolder.get(key) ?? []), p]);
  }
  return [...byFolder.values()].filter((g) => g.length > 1);
}

const andList = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// What pathClashes means to the person creating, or "" when there is no
// clash. `show`: how a project's path is written (the dialog: ~/…).
export function clashError(projects, show = (path) => path) {
  return pathClashes(projects)
    .map((g) => `${andList(g.map((p) => show(p.path)))} share the folder name ${repoName(g[0])}, so their workspaces would land on the same path: pick only one of them.`)
    .join(" ");
}

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// Creates a workspace in the primary and every companion:
//   req = { primary, companions, text, base, agent, access, root, home }
//   io  = { fetch, defaultBase, baseExists, branchExists, addWorktree, exists }
//         (gitOps plus a file check)
// Refuses, before any git runs, projects whose workspaces would share a path
// (pathClashes). Fetches every repo at once (a failure warns, the local refs
// are used), resolves each repo's default (baseFor: its saved base when git
// has it, else origin's, with a warning when the saved one is gone and is
// the one that would have been used), finds a name free in all of them, adds
// the companions then the primary, and stops at the first failure without
// undoing anything. Resolves
//   { ok: true, name, created, warnings, launch, originDefault }  launch:
//     space.new's args, for the primary only: { folder, name, argv?, task? };
//     originDefault: the primary's origin default, for rememberBase
//   { ok: false, error, name?, created, warnings }
export async function createWorkspace(req, io) {
  const { primary, companions = [], text, base, agent, access, root, home } = req;
  const { name: wanted, task } = parseInput(text);
  const warnings = [];
  if (!wanted) return { ok: false, error: "Type a name, a branch, #issue or a link.", created: [], warnings };
  if (!primary) return { ok: false, error: "Pick a project.", created: [], warnings };
  const repos = [...companions, primary];
  const clash = clashError(repos);
  if (clash) return { ok: false, error: clash, created: [], warnings };
  const fetched = await Promise.all(repos.map((p) => io.fetch(p.path)));
  fetched.forEach((r, i) => {
    if (!r?.ok) warnings.push(`Couldn't fetch origin in ${repoName(repos[i])} (${firstLine(r?.err) || "no answer"}): used the local refs.`);
  });
  const defaults = {};
  let originDefault = null;
  for (const [i, p] of repos.entries()) {
    const d = await io.defaultBase(p.path);
    if (d === null) return { ok: false, error: `${repoName(p)} is not a git repository.`, created: [], warnings };
    const isPrimary = i === repos.length - 1;
    const { def, gone } = baseFor(p, d, p.base ? await io.baseExists(p.path, p.base) : false);
    // A base picked in the dialog replaces the primary's default: then a gone
    // saved base changed nothing.
    if (gone && !(isPrimary && base)) warnings.push(`${isPrimary ? "" : `${repoName(p)}: `}${gone} is gone: created from ${def}`);
    defaults[p.path] = def;
    if (isPrimary) originDefault = d;
  }
  const name = await freeName(wanted, repos, nameTaken(io, root, home));
  const plan = creationPlan({ primary, companions, name, base, defaults, root, home });
  const created = [];
  for (const step of plan) {
    let r;
    try {
      r = await io.addWorktree(step.repo, step);
    } catch (e) {
      r = { ok: false, err: String(e?.message ?? e) };
    }
    if (!r?.ok) {
      return { ok: false, error: `Couldn't create ${name} in ${step.project}: ${firstLine(r?.err) || "git worktree add failed"}.`, name, created, warnings };
    }
    created.push(step);
  }
  const argv = agentArgv(agent, plan.filter((s) => !s.primary).map((s) => s.path), access);
  const launch = { folder: plan.at(-1).path, name, ...(argv ? { argv } : {}), ...(argv && task ? { task } : {}) };
  return { ok: true, name, created, warnings, launch, originDefault };
}
