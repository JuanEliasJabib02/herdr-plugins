// The New workspace dialog (D12–D17): Orca's Create worktree for Herdr. A
// project, a name (or #issue, a GitHub or Jira link), the base it starts
// from, the agent, and "Also create in": the same branch as a worktree in
// other projects of the group, which the agent is given access to. Only the
// primary gets a space (S16). What it decides lives in
// new-workspace-model.js; this file draws it and runs it.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, spaces, panes, home, knownAgents, exec, notify } from "herdr";
import { MOD, WORKTREE_ROOT, icon } from "./config.js";
import { matchSpaces, findProject, normPath } from "./lib.js";
import * as store from "./store.js";
import * as G from "./git.js";
import {
  parseInput, freeName, nameTaken, worktreePath, repoName, baseChoices,
  agentChoices, defaultAgent, takesDirs, projectChoices, companionChoices, initialProject, clashError, createWorkspace,
} from "./new-workspace-model.js";

// Herdr's own glyphs (shipped with every install).
const CHEVRON = "mods/workspace-chrome/chevron-down.svg";
const CHECK = "mods/workspace-chrome/check.svg";

// Whether a path exists: a workspace never lands on a folder that's there.
async function pathExists(path) {
  try {
    return (await exec("test", ["-e", path])).code === 0;
  } catch {
    return false;
  }
}

// What createWorkspace runs: git.js's steps and the folder check.
const IO = { ...G, exists: pathExists };

// A path as people read it: the home folder as ~.
function tilde(path) {
  const h = normPath(home());
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

export default class NewWorkspace {
  init(_props, cx) {
    const asked = props()?.project ?? null;
    this.project = initialProject(store.registry(), asked)?.path ?? null; // the primary
    this.companions = []; // chosen chips, by path
    this.access = true; // "Give the agent access to these worktrees"
    this.more = false; // "Create more"
    this.base = null; // the primary's Create from; null: its default
    this.agentKey = null; // null: defaultAgent ("" is Blank terminal)
    this.agents = store.agents(); // the last knownAgents(), shown while it's asked again
    this.bases = {}; // repo path -> { def, recent }; def undefined: looking, null: not git
    this.open = null; // the open list: "project" | "base" | "agent"
    this.text = "";
    this.free = ""; // the name the last check found free in every repo
    this.seq = 0; // the latest name check; older ones are dropped
    this.busy = false; // a create is running: no second one
    this.error = "";
    this.warnings = [];
    this.created = []; // after a failure: the worktrees that stay
    this.done = ""; // after Create more: what was made
    this.input = InputState.new({ placeholder: "Name, branch, #issue, or a GitHub / Jira link" });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      this.error = "";
      this.done = "";
      this.recheck(cx);
      cx.notify();
    });
    // ⌘↵ creates; a plain Enter doesn't, so the chips can still be picked.
    this.input.on("submit", (e, cx) => {
      if (e?.secondary) this.submit(cx);
    });
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    if (this.project) this.loadBases(this.project, cx);
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents();
        this.agents = list;
        store.saveAgents(list);
      } catch {
        this.agentsFailed = true;
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // ── State ────────────────────────────────────────────────────────────────

  primary() {
    return this.project ? findProject(store.registry(), this.project)?.project ?? null : null;
  }

  chips() {
    return companionChoices(store.registry(), this.project);
  }

  companionProjects() {
    return this.chips().projects.filter((p) => this.companions.includes(p.path));
  }

  repos() {
    const p = this.primary();
    return p ? [...this.companionProjects(), p] : [];
  }

  // The chosen projects that would share a worktree path, said with ~, or "".
  clash() {
    return clashError(this.repos(), tilde);
  }

  agent() {
    const choices = agentChoices(this.agents);
    return choices.find((a) => a.key === this.agentKey) ?? defaultAgent(choices);
  }

  // A repo's default base and recent branches, asked once.
  loadBases(path, cx) {
    if (this.bases[path]) return;
    this.bases[path] = { def: undefined, recent: [] };
    cx.spawn(async (cx) => {
      let def = null;
      let recent = [];
      try {
        [def, recent] = await Promise.all([G.defaultBase(path), G.recentBases(path)]);
      } catch {}
      this.bases[path] = { def, recent };
      cx.notify();
    });
  }

  // The name the live line shows: checked a moment after typing stops, in
  // the primary and every chosen companion (branch or folder taken → -2…).
  recheck(cx) {
    const seq = ++this.seq;
    this.free = "";
    const wanted = parseInput(this.text).name;
    const repos = this.repos();
    if (!wanted || repos.length === 0) return;
    cx.spawn(async (cx) => {
      await cx.sleep(250);
      if (seq !== this.seq) return;
      let name = "";
      try {
        name = await freeName(wanted, repos, nameTaken(IO, WORKTREE_ROOT, home()));
      } catch {}
      if (seq !== this.seq) return;
      this.free = name;
      cx.notify();
    });
  }

  pickProject(path, cx) {
    if (path === this.project) return;
    this.project = path;
    this.companions = []; // D16: the chips are the new primary's group
    this.base = null;
    this.error = "";
    this.created = [];
    this.loadBases(path, cx);
    this.recheck(cx);
  }

  toggleCompanion(path, cx) {
    this.companions = this.companions.includes(path) ? this.companions.filter((p) => p !== path) : [...this.companions, path];
    this.loadBases(path, cx);
    this.recheck(cx);
    this.input.focus();
    cx.notify();
  }

  // Why Create can't run now, or "".
  blocker() {
    const p = this.primary();
    if (!p) return "Pick a project.";
    const notGit = [p, ...this.companionProjects()].find((x) => this.bases[x.path]?.def === null);
    if (notGit) return `${notGit.name} is not a git repository.`;
    const clash = this.clash();
    if (clash) return clash;
    if (!parseInput(this.text).name) return "Type a name.";
    return "";
  }

  submit(cx) {
    if (this.busy || this.blocker()) return;
    const req = {
      primary: this.primary(), companions: this.companionProjects(), text: this.text, base: this.base,
      agent: this.agent(), access: this.access, root: WORKTREE_ROOT, home: home(),
    };
    this.busy = true;
    this.error = "";
    this.warnings = [];
    this.created = [];
    this.done = "";
    this.open = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await createWorkspace(req, IO);
      } catch (e) {
        r = { ok: false, error: String(e?.message ?? e), created: [], warnings: [] };
      }
      this.busy = false;
      this.warnings = r.warnings ?? [];
      if (!r.ok) {
        this.error = r.error;
        this.created = r.created ?? [];
        cx.notify();
        return;
      }
      const before = spaces().find((s) => s.active)?.id ?? null;
      run("space.new", r.launch); // the primary only; companions never get a space
      if (this.more) {
        // D17: stay here, on the space that was shown.
        if (before) run("space.select", { id: before });
        this.done = `Created ${r.name}${r.created.length > 1 ? ` in ${r.created.map((s) => s.project).join(", ")}` : ""}.`;
        this.text = "";
        this.free = "";
        this.seq++;
        this.input.set_value("");
        this.input.focus();
      } else {
        if (this.warnings.length) notify({ title: `Created ${r.name}`, body: this.warnings.join("\n"), level: "warning", timeout: 8000 });
        this.close();
      }
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.open) {
        this.open = null;
        cx.notify();
      } else this.close();
      cx.stop_propagation();
    } else if (e.key === "enter" && e.modifiers?.platform) {
      this.submit(cx);
      cx.stop_propagation();
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  // A select: a trigger, and under it its list while open. Options:
  // { key, label, hint?, icon?: () => element } or { header }.
  select(t, id, current, options, pick) {
    const open = this.open === id;
    return v_flex().id(`nw-${id}`).w_full()
      .when(open, (el) => el.on_mouse_down_out((_e, cx) => {
        if (this.open !== id) return;
        this.open = null;
        cx.notify();
      }))
      .child(h_flex().id(`nw-${id}-trigger`).h(32).px(10).gap(8).items_center().rounded(7).border_1()
        .border_color(open ? t.accent : t.input).bg(t.background).cursor_pointer()
        .on_click((_e, cx) => { this.open = open ? null : id; cx.notify(); })
        .when(Boolean(current.icon), (el) => el.child(current.icon()))
        .child(div().flex_1().min_w(0).truncate().child(current.label))
        .when(Boolean(current.hint), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(current.hint)))
        .child(svg(CHEVRON).size(14).flex_none().text_color(t.dim)))
      .when(open, (el) => el.child(v_flex().id(`nw-${id}-list`).mt(4).max_h(196).p(4).rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_y_scrollbar()
        .children(options.map((o, i) => (o.header
          ? div().flex_none().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(o.header)
          : h_flex().id(`nw-${id}-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(o.key === current.key, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.open = null;
              pick(o, cx);
              this.input.focus();
              cx.notify();
            })
            .when(Boolean(o.icon), (el) => el.child(o.icon()))
            .child(div().flex_1().min_w(0).truncate().child(o.label))
            .when(Boolean(o.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(o.hint))))))));
  }

  // A select that can't open: a value being looked up, or none.
  still(t, text, color) {
    return h_flex().h(32).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(div().flex_1().min_w(0).truncate().text_color(color ?? t.dim).child(text));
  }

  checkbox(t, id, on, text, hint, toggle) {
    return h_flex().id(id).gap(8).items_center().cursor_pointer()
      .on_click((_e, cx) => { toggle(); this.input.focus(); cx.notify(); })
      .child(h_flex().size(16).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).items_center().justify_center()
        .when(on, (el) => el.child(svg(CHECK).size(12).text_color(t.accent_foreground))))
      .child(div().text_size(12.5).child(text))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  button(t, id, text, primary, action, enabled = true, hint = "") {
    return h_flex().id(id).h(32).px(14).gap(8).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text)
      .when(Boolean(hint), (el) => el.child(div().text_size(11).opacity(0.7).child(hint)));
  }

  agentIcon(t, a) {
    if (!a.icon) return div().size(14).flex_none();
    return a.tint ? svg(a.icon).size(14).flex_none().text_color(t.foreground) : image(a.icon).size(14).flex_none();
  }

  render() {
    const t = theme();
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const header = h_flex().px(18).pt(16).pb(2).items_center()
      .child(div().flex_1().text_size(15).font_semibold().child("New workspace"))
      .child(div().text_size(11).text_color(t.dim).child("Esc"));
    const root = v_flex().id("new-workspace").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(header);
    const primary = this.primary();
    if (!primary) {
      return root
        .child(div().px(18).pt(14).text_color(t.muted).child("Add a project before creating a workspace."))
        .child(div().flex_1())
        .child(h_flex().px(18).py(14).justify_end().child(this.button(t, "nw-close", "Close", false, () => this.close())));
    }

    const reg = store.registry();
    const folder = () => svg(icon("folder")).size(14).flex_none().text_color(t.muted);

    // Project: the active group first, then the others.
    const projectOptions = [];
    for (const p of projectChoices(reg)) {
      if (p.other && !projectOptions.some((o) => o.header)) projectOptions.push({ header: "Other groups" });
      projectOptions.push({ key: p.path, label: p.name, hint: p.other ? p.group : "", icon: folder });
    }
    const projectSelect = this.select(t, "project", { key: primary.path, label: primary.name, icon: folder }, projectOptions, (o, cx) => this.pickProject(o.key, cx));

    // Create from: the primary's default, then its recent remote branches.
    const bases = this.bases[primary.path];
    const def = bases?.def;
    const base = this.base ?? def;
    const baseSelect = def
      ? this.select(t, "base", { key: base, label: base, hint: base === def ? "default" : "" },
        baseChoices(def, bases.recent).map((b) => ({ key: b, label: b, hint: b === def ? "default" : "" })),
        (o) => { this.base = o.key === def ? null : o.key; })
      : this.still(t, def === null ? "not a git repository" : "…", def === null ? t.blocked : t.dim);

    // Agent: the installed ones, then Blank terminal.
    const agent = this.agent();
    const agentSelect = this.select(t, "agent", { key: agent.key, label: agent.name, icon: () => this.agentIcon(t, agent) },
      agentChoices(this.agents).map((a) => ({ key: a.key, label: a.name, icon: () => this.agentIcon(t, a) })),
      (o) => { this.agentKey = o.key; });

    // The live line: where it goes, the branch, the base.
    const parsed = parseInput(this.text);
    const name = this.free || parsed.name;
    const live = parsed.name
      ? `${tilde(worktreePath(WORKTREE_ROOT, repoName(primary), name, home()))} · branch ${name} · from ${base ?? "…"}`
      : "Type a name, a branch, #123, or paste a GitHub issue / pull request or Jira link.";
    const taken = Boolean(this.free) && this.free !== parsed.name;

    // Also create in: the rest of the primary's group.
    const chips = this.chips();
    const chosen = this.companionProjects();
    const clash = this.clash();
    const chip = (p, i) => {
      const on = this.companions.includes(p.path);
      const d = this.bases[p.path]?.def;
      return h_flex().id(`nw-chip-${i}`).h(28).px(10).gap(6).items_center().rounded(7).border_1()
        .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.background).cursor_pointer()
        .hover((s) => s.border_color(t.accent))
        .on_click((_e, cx) => this.toggleCompanion(p.path, cx))
        .child(on ? svg(CHECK).size(13).flex_none().text_color(t.accent) : svg(icon("folder")).size(13).flex_none().text_color(t.dim))
        .child(div().text_size(12.5).child(p.name))
        .when(on, (el) => el.child(div().text_size(11).text_color(d === null ? t.blocked : t.dim).child(d === null ? "not git" : d ?? "…")));
    };

    const blocker = this.blocker();
    const body = v_flex().id("nw-body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(label("Project"))
      .child(projectSelect)
      .child(label("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).truncate().child(live))
      .when(taken, (el) => el.child(div().pt(2).text_size(11.5).text_color(t.dim).child(`${parsed.name} is taken in one of the repos.`)))
      .when(Boolean(parsed.task) && Boolean(agent.run), (el) => el.child(div().pt(2).text_size(11.5).text_color(t.dim).truncate().child(`The agent starts with: ${parsed.task}`)))
      .child(h_flex().gap(12).items_start()
        .child(v_flex().flex_1().min_w(0).child(label("Create from")).child(baseSelect))
        .child(v_flex().flex_1().min_w(0).child(label("Agent")).child(agentSelect)))
      // Shown even with no other project in the group, so the feature can be
      // found: the hint says where companions come from.
      .when(Boolean(chips.group), (el) => el.child(label(`Also create in · ${chips.group.name}`)))
      .when(Boolean(chips.group) && chips.projects.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim)
        .child(`No other project in ${chips.group.name}. Add one with the "+" next to Projects to make this branch there too.`)))
      .when(chips.projects.length > 0, (el) => el
        .child(h_flex().flex_wrap().gap(6).children(chips.projects.map(chip)))
        .when(chosen.length > 0 && Boolean(agent.run), (el) => el.child(div().pt(10).child(
          this.checkbox(t, "nw-access", this.access, "Give the agent access to these worktrees",
            takesDirs(agent) ? "" : "Claude Code and Codex only", () => { this.access = !this.access; }))))
        .when(chosen.length > 0, (el) => el.child(div().pt(6).text_size(11.5).text_color(t.dim)
          .child("Each one from its own default branch, with no space of its own.")))
        .when(Boolean(clash), (el) => el.child(div().pt(6).text_size(11.5).text_color(t.blocked).child(clash))))
      .when(this.agentsFailed && this.agents.length === 0, (el) => el.child(div().pt(10).text_size(11.5).text_color(t.dim).child("Could not load agents.")))
      .children(this.warnings.map((w) => div().pt(10).text_size(12).text_color(t.muted).child(w)))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.created.length > 0, (el) => el.child(div().pt(4).text_size(12).text_color(t.muted)
        .child(`Already created, kept: ${this.created.map((s) => tilde(s.path)).join(", ")}`)))
      .when(Boolean(this.done), (el) => el.child(div().pt(10).text_size(12).text_color(t.done).child(this.done)));

    const footer = h_flex().px(18).py(14).gap(8).items_center().border_t_1().border_color(t.border)
      .child(this.checkbox(t, "nw-more", this.more, "Create more", "", () => { this.more = !this.more; }))
      .child(div().flex_1())
      .child(this.button(t, "nw-cancel", "Cancel", false, () => this.close()))
      .child(this.button(t, "nw-create", this.busy ? "Creating…" : "Create", true, (cx) => this.submit(cx), !this.busy && !blocker, "⌘↵"));

    return root.child(body).child(footer);
  }
}

// The project of the focused space (D7), or null.
function focusedProject() {
  const all = spaces();
  const active = all.find((s) => s.active);
  if (!active) return null;
  return matchSpaces(store.cache(), all, panes(), home())[active.id]?.project ?? null;
}

// The only place that opens the dialog. projectPath: the project to start
// with; null (or one that isn't registered) starts on the active group's
// first project.
export function openNewWorkspace(projectPath) {
  const project = projectPath && typeof projectPath === "object" ? projectPath.path : projectPath;
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 560, height: 600, props: { view: "new-workspace", project: project ?? null } });
}

export const commands = {
  // `herdr-app do projects.new-workspace`: for the focused space's project.
  "new-workspace": () => openNewWorkspace(focusedProject()),
};
