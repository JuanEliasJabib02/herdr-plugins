// The settings dialog (T9, D4, D7, D12, S9), opened as an overlay with props
// { view: "settings" } (the board's gear). It edits settings.json, which only
// the mod writes (writeTextFile compare-and-swap against the text it read):
//   Cola de pruebas   the queue switch, the global cap, each space's limit and
//                     auto-resume;
//   Repos             per repo: Spotlight on/off (or the registration default,
//                     shown with what it resolves to), the server command per
//                     env, the env in use and the port.
// Saving refuses a command of more than one line or a bad port, clamps the
// numbers, and after a change to the queue execs `spotlight reap`, which
// regrants (Orca's capChanged). The model is settings-form.js.
//
// T26 (D37, Orca's RepositorySpotlightServerFields / RepositorySpotlightSection):
//   - Each command field has a "▾" beside it listing the repo's package.json
//     scripts (detectServerScripts' scriptCommands, read in the root); a pick
//     sets the field. Its placeholder is the command that runs while it is
//     empty, or "No arranca". InputState has no placeholder setter, so the
//     inputs are made once the detection is in (load()).
//   - Apagado on a lit repo turns it off first: Guardar writes every other
//     field with that repo's `enabled` unchanged, keeps the dialog open with
//     "Apagando Spotlight en <repo>…", re-reads state.json and, while the repo
//     is still lit, runs `spotlight toggle --workspace <root> --inline` (the
//     root only ever turns off). When it went off (or nothing was lit any
//     more: `root-is-holder`), `enabled: false` is written and the dialog
//     closes; otherwise the switch stays on and the dialog shows the CLI's
//     first line. The save runs in a task no view owns (Herdr's Esc may close
//     even a modal dialog, and a closed dialog's tasks die after 250 ms), and
//     Esc and Cancelar do nothing while it runs; a dialog closed meanwhile
//     gets a toast instead.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, shared, appHome, home, readTextFile, writeTextFile, exec, notify } from "herdr";
import * as fs from "fs/promises";
import { ENVS, parseSettings, repoSettings } from "./settings.js";
import {
  lanesOf,
  reposOf,
  toForm,
  applyForm,
  enabledChoice,
  isHarnessRoot,
  serializeSettings,
  scriptSuggestions,
  commandPlaceholder,
  planSave,
  isLit,
  TURN_OFF_TIMEOUT_MS,
  turnOffOutcome,
  withEnabledOff,
} from "./settings-form.js";
import { hasServerCommand, detectServerScripts } from "./server-plan.js";
import { cliPathOf, readState } from "./board-model.js";
import { modIo } from "./server-view-model.js";

const ENV_LABEL = { local: "Local", dev: "Dev", prod: "Prod" };

// A "▾" list shows this many whole rows (28 px each) before it scrolls.
const LIST_ROWS = 6;

const settingsDir = () => `${appHome()}/spotlight`;

// state.json as board-model reads it; null when it couldn't be read (a
// missing file reads as the empty state), so the CLI decides what is lit.
async function readStateFile(dir) {
  try {
    return readState(await readTextFile(`${dir}/state.json`));
  } catch {
    return null;
  }
}

// T5a's file io (kind, readText, listDirs) over Herdr: the mod has no fs.
const KIND_SH = 'if [ -f "$1" ]; then echo file; elif [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo other; else echo none; fi';
const herdrIo = {
  async kind(path) {
    try {
      const r = await exec("/bin/sh", ["-c", KIND_SH, "sh", path]);
      return r.code === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  },
  async readText(path, maxBytes = Infinity) {
    try {
      const text = await readTextFile(path);
      return text != null && text.length <= maxBytes ? text : null;
    } catch {
      return null;
    }
  },
  async listDirs(path) {
    try {
      const r = await exec("/usr/bin/find", [path, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]);
      if (r.code !== 0) return null;
      return r.stdout.split("\n").filter(Boolean).map((p) => p.slice(p.lastIndexOf("/") + 1));
    } catch {
      return null;
    }
  },
};

async function isGitRepo(root) {
  try {
    return (await exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])).code === 0;
  } catch {
    return false;
  }
}

// `spotlight reap`, the CLI inside this mod's folder (as the board and the reaper run it).
const runReap = () => exec(cliPathOf(appHome()), ["reap"]);

export default class SettingsView {
  init(p, cx) {
    this.loaded = false;
    this.text = null; // settings.json as read: the compare-and-swap snapshot
    this.settings = null;
    this.valid = true;
    this.lanes = [];
    this.repos = [];
    this.form = null;
    this.inputs = new Map(); // field key -> InputState
    this.facts = {}; // root -> repoEnabledFrom's facts, once looked up
    this.detections = {}; // root -> detectServerScripts' answer (the "▾" lists, the placeholders)
    this.open = null; // the command field whose "▾" list is open
    this.errors = [];
    this.message = "";
    this.alert = false; // the message is a failure (drawn red)
    this.busy = false; // a save runs: Esc, Cancelar and Guardar do nothing
    this.gone = false; // the dialog closed: a running save reports with a toast
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: the save's task may outlive this copy's props
    this.bin = cliPathOf(appHome());
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    cx.spawn(async (cx) => {
      await this.load(cx);
      cx.notify();
    });
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a save
  // still running reports with a toast.
  close() {
    this.gone = true;
  }

  dismiss() {
    if (!this.busy) closeOverlay(this.overlay);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    if (this.open) {
      this.open = null;
      cx.notify();
      return;
    }
    this.dismiss();
  }

  async load(cx) {
    const dir = settingsDir();
    let text = null;
    let stateRoots = [];
    try {
      text = await readTextFile(`${dir}/settings.json`);
    } catch {
      text = null;
    }
    try {
      const state = JSON.parse((await readTextFile(`${dir}/state.json`)) ?? "{}");
      stateRoots = Object.keys(state?.repos ?? {});
    } catch {
      stateRoots = [];
    }
    const { settings, valid } = parseSettings(text);
    const registry = shared("projects.v1");
    this.text = text;
    this.settings = settings;
    this.valid = valid;
    this.lanes = lanesOf(registry);
    this.repos = reposOf(registry, settings, stateRoots);
    this.form = toForm(settings, { lanes: this.lanes, repos: this.repos });
    await this.detectAll();
    this.makeInputs();
    this.loaded = true;
    this.lookUpFacts(cx);
  }

  // T5a's detection in each root (which holds the lit workspace's tree, as the
  // server popup reads it): the "▾" lists and the placeholders. Never throws.
  async detectAll() {
    const io = modIo({ readTextFile, readdir: fs.readdir });
    const found = await Promise.all(this.repos.map(async ({ root }) => {
      try {
        return [root, await detectServerScripts(root, io)];
      } catch {
        return [root, { detected: {}, scriptCommands: [] }];
      }
    }));
    this.detections = Object.fromEntries(found);
  }

  // One InputState per typed field, kept across renders.
  makeInputs() {
    const field = (key, value, placeholder, write) => {
      const s = InputState.new({ value, placeholder });
      s.on("change", (_e, cx) => {
        write(s.value());
        this.errors = this.errors.filter((e) => e.field !== key);
        this.message = "";
        this.alert = false;
        cx.notify();
      });
      s.on("submit", (e, cx) => {
        if (e?.secondary) this.save(cx);
      });
      this.inputs.set(key, s);
    };
    const q = this.form.queue;
    field("cap", q.cap, "2", (v) => { q.cap = v; });
    for (const lane of this.lanes) field(`lane:${lane.id}`, q.perSpace[lane.id], "1", (v) => { q.perSpace[lane.id] = v; });
    for (const { root } of this.repos) {
      const r = this.form.repos[root];
      const stored = repoSettings(this.settings, root);
      for (const env of ENVS) {
        const placeholder = commandPlaceholder(stored, this.detections[root], env);
        field(`${root}:envs.${env}`, r.envs[env], placeholder, (v) => { r.envs[env] = v; });
      }
      field(`${root}:port`, r.port, "automático", (v) => { r.port = v; });
    }
  }

  // A "▾" pick: the field takes the script's command.
  pickCommand(root, env, command) {
    const key = `${root}:envs.${env}`;
    this.form.repos[root].envs[env] = command;
    this.inputs.get(key)?.set_value(command);
    this.errors = this.errors.filter((e) => e.field !== key);
    this.message = "";
    this.alert = false;
  }

  // The registration default's facts, only for repos with nothing set (D7);
  // each repo is drawn with "…" until its facts arrive.
  lookUpFacts(cx) {
    for (const repo of this.repos) {
      const stored = repoSettings(this.settings, repo.root);
      const harness = isHarnessRoot(repo.root, home());
      if (harness || typeof stored.enabled === "boolean" || !repo.registered) {
        this.facts[repo.root] = { harness, registered: repo.registered, gitRepo: false, hasServerCommand: false };
        continue;
      }
      cx.spawn(async (cx) => {
        const gitRepo = await isGitRepo(repo.root);
        let server = false;
        try {
          server = gitRepo && Boolean(await hasServerCommand(repo.root, herdrIo, stored));
        } catch {
          server = false;
        }
        this.facts[repo.root] = { harness, registered: true, gitRepo, hasServerCommand: server };
        cx.notify();
      });
    }
  }

  save(cx) {
    if (!this.loaded || this.busy) return;
    const out = applyForm(this.settings, this.form);
    if (out.errors.length > 0) {
      this.errors = out.errors;
      this.message = "Revisa los campos marcados.";
      this.alert = true;
      cx.notify();
      return;
    }
    this.busy = true;
    this.message = "";
    this.alert = false;
    this.open = null;
    cx.notify();
    const view = this.redrawer(cx);
    cx.spawn(async () => {
      let r;
      try {
        r = await this.runSave(view.redraw);
      } catch (e) {
        r = { message: `No se pudo guardar: ${String(e?.message ?? e).split("\n")[0]}`, alert: true };
      }
      this.busy = false;
      if (r.reload) {
        // Stale snapshot: someone saved in between. Read it again, keep nothing typed.
        view.end(async (cx) => {
          this.loaded = false;
          this.inputs.clear();
          this.errors = [];
          this.open = null;
          cx.notify();
          await this.load(cx);
          this.message = "settings.json cambió mientras editabas: se volvió a cargar, guarda otra vez.";
          this.alert = false;
        });
        return;
      }
      if (r.close) {
        this.message = "";
        if (!this.gone) closeOverlay(this.overlay);
      } else {
        this.message = r.message;
        this.alert = Boolean(r.alert);
        if (this.gone && r.toast) notify(r.toast);
      }
      view.end();
    }, { owner: null });
  }

  // The save, in a task no view owns: the first write (every field, a lit
  // repo switched to Apagado keeping its stored `enabled`), then each such
  // repo turned off and its `enabled: false` written, then the reap when the
  // queue changed. Answers { close } when all went through, { reload } on a
  // stale snapshot, else { message, alert, toast }. `redraw()` redraws the
  // dialog while it is open.
  async runSave(redraw) {
    const dir = settingsDir();
    const plan = planSave(this.settings, this.form, await readStateFile(dir));
    if (!plan.settings) {
      this.errors = plan.errors;
      return { message: "Revisa los campos marcados.", alert: true };
    }
    const next = serializeSettings(plan.settings);
    try {
      if (this.text === null) await exec("mkdir", ["-p", dir]);
      await writeTextFile(`${dir}/settings.json`, next, this.text);
    } catch {
      return { reload: true };
    }
    this.text = next;
    this.settings = plan.settings;

    const off = []; // roots that went off (or had nothing lit any more)
    const failed = []; // { root, name, message }
    for (const { root, argv } of plan.turnOff) {
      const name = this.nameOf(root);
      this.message = `Apagando Spotlight en ${name}…`;
      redraw();
      // Lit at Guardar; still lit now? (null: unreadable, the CLI decides.)
      const state = await readStateFile(dir);
      if (state && !isLit(state, root)) {
        off.push(root);
        continue;
      }
      let outcome;
      try {
        outcome = turnOffOutcome(await exec(this.bin, argv, { timeout: TURN_OFF_TIMEOUT_MS }));
      } catch (e) {
        outcome = turnOffOutcome({ error: e });
      }
      if (outcome.ok) off.push(root);
      else failed.push({ root, name, message: outcome.message });
    }
    const saved = off.length === 0 || (await this.writeEnabledOff(off));

    if (plan.needsReap) {
      try {
        await runReap();
      } catch {
        // The next on/off or the footer's reaper picks the change up.
      }
    }
    if (failed.length === 0 && saved) return { close: true };

    // The switch of a repo that didn't go off stays on, as saved.
    for (const { root } of failed) {
      const stored = this.settings.repos[root]?.enabled;
      if (this.form.repos[root]) this.form.repos[root].enabled = typeof stored === "boolean" ? stored : null;
    }
    const lines = failed.map((f) => (plan.turnOff.length > 1 ? `${f.name}: ${f.message}` : f.message));
    if (!saved) {
      lines.push(`Spotlight se apagó en ${off.map((r) => this.nameOf(r)).join(", ")}, pero no se pudo guardar Apagado: elígelo y guarda otra vez.`);
    }
    const message = lines.join(" · ");
    const names = [...failed.map((f) => f.name), ...(saved ? [] : off.map((r) => this.nameOf(r)))];
    return {
      message,
      alert: true,
      toast: { title: `Spotlight sigue encendido en ${names.join(", ")}`, body: message, level: "error" },
    };
  }

  // `enabled: false` for `roots`, compare-and-swap against the first write;
  // when settings.json changed since, against what it holds now (up to 3 tries).
  async writeEnabledOff(roots) {
    const file = `${settingsDir()}/settings.json`;
    let text = this.text;
    let settings = this.settings;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        try {
          text = await readTextFile(file);
        } catch {
          continue;
        }
        settings = parseSettings(text).settings;
      }
      const next = withEnabledOff(settings, roots);
      const out = serializeSettings(next);
      try {
        await writeTextFile(file, out, text);
        this.text = out;
        this.settings = next;
        return true;
      } catch {
        // Stale: read it again.
      }
    }
    return false;
  }

  nameOf(root) {
    return this.repos.find((r) => r.root === root)?.name ?? root.split("/").filter(Boolean).pop() ?? root;
  }

  // Redraws the dialog from a task no view owns: `redraw()` asks for one,
  // `end(after?)` for the last one, after which `after(cx)` runs in the
  // dialog. The loop is the dialog's own task, so it goes with the dialog.
  redrawer(cx) {
    let wake = null;
    let pending = false;
    let ended = false;
    let after = null;
    const redraw = () => {
      pending = true;
      const w = wake;
      wake = null;
      w?.();
    };
    cx.spawn(async (cx) => {
      for (;;) {
        if (!pending) await new Promise((resolve) => { wake = resolve; });
        pending = false;
        try {
          if (ended && after) await after(cx);
          cx.notify();
        } catch {
          return; // closed meanwhile
        }
        if (ended) return;
      }
    });
    return {
      redraw,
      end: (then = null) => {
        ended = true;
        after = then;
        redraw();
      },
    };
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  error(key) {
    return this.errors.find((e) => e.field === key)?.message ?? "";
  }

  input(t, key, width) {
    const bad = Boolean(this.error(key));
    const el = Input.new(this.inputs.get(key)).h(28).px(8).rounded(6).border_1()
      .border_color(bad ? t.blocked : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return width ? el.w(width) : el.flex_1().min_w(0);
  }

  toggle(t, id, on, text, flip) {
    return h_flex().id(id).gap(8).items_center().cursor_pointer()
      .on_click((_e, cx) => { flip(); cx.notify(); })
      .child(h_flex().w(28).h(16).flex_none().rounded(8).px(2).items_center()
        .bg(on ? t.accent : t.input)
        .when(on, (el) => el.justify_end())
        .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.background)))
      .child(div().text_size(12.5).child(text));
  }

  chip(t, id, selected, text, pick) {
    return div().id(id).h(24).px(9).flex().items_center().rounded(6).border_1().text_size(12)
      .border_color(selected ? t.accent : t.input).bg(selected ? t.selected : t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { pick(); cx.notify(); })
      .child(text);
  }

  button(t, id, text, primary, action, enabled = true) {
    return h_flex().id(id).h(30).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(text);
  }

  // A command field: the env's chip, the input, and its "▾" (when the repo
  // has scripts to suggest), with the list under the row while open. Built
  // like projects-sidebar's new-workspace select: a press outside closes it.
  commandField(t, repo, env) {
    const f = this.form.repos[repo.root];
    const key = `${repo.root}:envs.${env}`;
    const id = (s) => `sl-set-${repo.root}-${env}-${s}`;
    const options = scriptSuggestions(this.detections[repo.root]);
    const open = this.open === key;
    const current = String(f.envs[env] ?? "").trim();
    return v_flex().id(id("field")).w_full()
      .when(open, (el) => el.on_mouse_down_out((_e, cx) => {
        if (this.open !== key) return;
        this.open = null;
        cx.notify();
      }))
      .child(h_flex().gap(8).items_center()
        .child(this.chip(t, `sl-set-${repo.root}-env-${env}`, f.env === env, ENV_LABEL[env], () => { f.env = env; }))
        .child(this.input(t, key))
        .when(options.length > 0, (el) => el.child(div().id(id("pick")).h(28).w(28).flex_none().flex().items_center().justify_center()
          .rounded(6).border_1().border_color(open ? t.accent : t.input).bg(t.background)
          .text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.open = open ? null : key; cx.notify(); })
          .child("▾"))))
      // Whole rows only, so the last one is never cut in half; with more,
      // the scrollbar always shows that the list goes on.
      .when(open, (el) => el.child(v_flex().id(id("list")).mt(4).max_h(LIST_ROWS * 28 + 10).p(4).rounded(7)
        .border_1().border_color(t.border).bg(t.raised).overflow_y_scrollbar()
        .when(options.length > LIST_ROWS, (l) => l.mode("always"))
        .children(options.map((command, i) => h_flex().id(id(`opt-${i}`)).h(28).flex_none().px(8).items_center().rounded(6)
          .cursor_pointer()
          .when(command === current, (o) => o.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.open = null;
            this.pickCommand(repo.root, env, command);
            cx.notify();
          })
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(command))))));
  }

  queueSection(t) {
    const q = this.form.queue;
    const row = (label, hint, control) => h_flex().gap(10).items_center().py(4)
      .child(div().flex_1().min_w(0).child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)))
      .child(control);
    return v_flex().gap(2)
      .child(this.toggle(t, "sl-set-queue", q.enabled, "Cola de pruebas activa", () => { q.enabled = !q.enabled; }))
      .child(div().text_size(11).text_color(t.dim).pb(4)
        .child(q.enabled ? "Un turno de pruebas por tarea, en orden de llegada." : "Apagada: `spotlight on` prende el server al instante, sin turno."))
      .child(row("Máximo en total", "1–4", this.input(t, "cap", 56)))
      .children(this.lanes.map((lane) => row(`${lane.name}: por espacio`, "1–4", this.input(t, `lane:${lane.id}`, 56))))
      .child(div().pt(6).child(this.toggle(t, "sl-set-resume", q.autoResume, "Continuar solo cuando vuelva el límite de uso",
        () => { q.autoResume = !q.autoResume; })));
  }

  repoBlock(t, repo) {
    const f = this.form.repos[repo.root];
    const choice = enabledChoice(f, this.facts[repo.root] ?? null);
    const defaultLabel = enabledChoice({ enabled: null }, this.facts[repo.root] ?? null).label;
    const id = (s) => `sl-set-${repo.root}-${s}`;
    const errs = [...ENVS.map((e) => `${repo.root}:envs.${e}`), `${repo.root}:port`].map((k) => this.error(k)).filter(Boolean);
    return v_flex().gap(6).py(10).border_t_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().font_medium().child(repo.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(repo.root)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(12).text_color(t.muted).pr(4).child("Spotlight"))
        .child(this.chip(t, id("def"), f.enabled === null, defaultLabel.replace("Por defecto: ", "Por defecto · "), () => { f.enabled = null; }))
        .child(this.chip(t, id("on"), f.enabled === true, "Encendido", () => { f.enabled = true; }))
        .child(this.chip(t, id("off"), f.enabled === false, "Apagado", () => { f.enabled = false; }))
        .when(this.facts[repo.root]?.harness, (el) => el.child(div().text_size(11).text_color(t.blocked).child(choice.label))))
      .children(ENVS.map((env) => this.commandField(t, repo, env)))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.muted).child("Puerto"))
        .child(this.input(t, `${repo.root}:port`, 90)))
      .when(errs.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(errs.join(" "))));
  }

  render() {
    const t = theme();
    const header = h_flex().px(18).pt(16).pb(8).items_center()
      .child(div().flex_1().text_size(15).font_semibold().child("Spotlight · Ajustes"))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "" : "Esc"));
    const root = v_flex().id("spotlight-settings").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(header);
    if (!this.loaded) return root.child(div().px(18).text_color(t.dim).child("Cargando…"));

    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const body = v_flex().id("spotlight-settings-body").flex_1().min_h(0).px(18).overflow_y_scrollbar()
      .when(!this.valid, (el) => el.child(div().text_size(11.5).text_color(t.blocked).pb(6)
        .child("settings.json no se pudo leer: se muestran los valores por defecto y guardar lo reemplaza.")))
      .child(label("Cola de pruebas"))
      .child(this.queueSection(t))
      .child(label("Repos"))
      .when(this.repos.length === 0, (el) => el.child(div().text_color(t.dim).child("Ningún repo en un espacio todavía.")))
      .children(this.repos.map((repo) => this.repoBlock(t, repo)));
    const footer = h_flex().px(18).py(12).gap(8).items_center().border_t_1().border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.alert || this.errors.length ? t.blocked : t.dim).child(this.message))
      .child(this.button(t, "sl-set-cancel", "Cancelar", false, () => this.dismiss(), !this.busy))
      .child(this.button(t, "sl-set-save", this.busy ? "Guardando…" : "Guardar", true, (cx) => this.save(cx), !this.busy));
    return root.child(body).child(footer);
  }
}
