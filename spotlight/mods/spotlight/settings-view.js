// The settings dialog (T9, D4, D7, D12, S9), opened as an overlay with props
// { view: "settings" } (the board's gear). It edits settings.json, which only
// the mod writes (writeTextFile compare-and-swap against the text it read):
//   Cola de pruebas   the queue switch, the global cap, each space's limit and
//                     auto-resume;
//   Repos             per repo: Usar Spotlight, the server command per env,
//                     the env in use and the port.
// The numbers are clamped, a command of more than one line or a bad port is
// refused, and after a change to the queue it execs `spotlight reap`, which
// regrants (Orca's capChanged). The model is settings-form.js.
//
// T26 (D37, Orca's RepositorySpotlightServerFields / RepositorySpotlightSection):
//   - Each command field has a "▾" beside it listing the repo's package.json
//     scripts (detectServerScripts' scriptCommands, read in the root); a pick
//     sets the field. Its placeholder is the command that runs while it is
//     empty, or "No arranca". InputState has no placeholder setter, so the
//     inputs are made once the detection is in (load()).
//
// T40 (D47, Orca's settings): no Guardar and no Cancelar; each control saves
// on its own, one write at a time, each through the compare-and-swap (a
// stale snapshot reads the file again and applies the change to it):
//   - "Usar Spotlight" is a switch saved on change, showing what is in force
//     (an unset repo shows its registration default; a flip writes it).
//     Switched off on a lit repo, it turns it off first (D37): the dialog
//     says "Apagando Spotlight en <repo>…" and runs `spotlight toggle
//     --workspace <root> --inline` (the root only ever turns off); when it
//     went off (or nothing was lit any more: `root-is-holder`), `enabled:
//     false` is written. Refused, the switch stays on and the CLI's first
//     line shows under it, with "Apagar igual" when forcing fixes it (Orca's
//     toast action): the forced turn-off, which leaves the switch on.
//   - The queue switches and the env chips save on click; a command field on
//     blur or Enter, the port and the numbers on blur or Enter (Orca's
//     NumberField). Only a field edited since its last save is saved, so a
//     blur alone never writes back a value another writer changed. A refused
//     value stays in its field with its error, nothing written.
//   - Orca's help texts, in Spanish, and its variant help when the repo has
//     variants.
//   - Cerrar (and Esc) saves what is still typed in a field and closes; a
//     refused one keeps the dialog open.
// The saves and the turn-offs run in tasks no view owns (Herdr's Esc may
// close even a modal dialog, and a closed dialog's tasks die after 250 ms);
// Esc and Cerrar do nothing while a turn-off runs, and a dialog closed
// meanwhile gets a toast instead.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, shared, appHome, home, readTextFile, writeTextFile, exec, notify } from "herdr";
import * as fs from "fs/promises";
import { ENVS, parseSettings, repoSettings } from "./settings.js";
import {
  lanesOf,
  reposOf,
  toForm,
  isHarnessRoot,
  scriptSuggestions,
  commandPlaceholder,
  TURN_OFF_TIMEOUT_MS,
  saveChange,
  fieldText,
  casWrite,
  spotlightSwitch,
  flipSpotlight,
  forceTurnOffArgv,
  afterTurnOff,
  HELP,
  variantHelp,
} from "./settings-form.js";
import { hasServerCommand, detectServerScripts } from "./server-plan.js";
import { cliPathOf, readState } from "./board-model.js";
import { modIo } from "./server-view-model.js";

const ENV_LABEL = { local: "Local", dev: "Dev", prod: "Prod" };

// A "▾" list shows this many whole rows (28 px each) before it scrolls.
const LIST_ROWS = 6;

const settingsDir = () => `${appHome()}/spotlight`;
const settingsFile = () => `${settingsDir()}/settings.json`;

const firstLine = (e) => String(e?.message ?? e ?? "").split("\n")[0];

// state.json as board-model reads it; null when it couldn't be read (a
// missing file reads as the empty state), so the CLI decides what is lit.
async function readStateFile(dir) {
  try {
    return readState(await readTextFile(`${dir}/state.json`));
  } catch {
    return null;
  }
}

// settings.json's compare-and-swap for casWrite: a file not there yet
// (expected null) gets its folder first.
const settingsIo = {
  read: () => readTextFile(settingsFile()),
  async write(text, expected) {
    if (expected === null) await exec("mkdir", ["-p", settingsDir()]);
    await writeTextFile(settingsFile(), text, expected);
  },
};

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
    this.text = null; // settings.json as last read or written: the compare-and-swap snapshot
    this.settings = null; // the same, parsed: what the switches and chips show
    this.valid = true;
    this.lanes = [];
    this.repos = [];
    this.form = null; // the typed fields' text
    this.fields = new Map(); // field key -> { state: InputState, change(text), write(text) }
    this.dirty = new Set(); // field keys edited since their last save
    this.facts = {}; // root -> repoEnabledFrom's facts, once looked up
    this.detections = {}; // root -> detectServerScripts' answer (the "▾" lists, the placeholders, the variants)
    this.open = null; // the command field whose "▾" list is open
    this.errors = [];
    this.message = "";
    this.alert = false; // the message is a failure (drawn red)
    this.busy = null; // the root a switch flip or a turn-off runs for: Esc, Cerrar and the switches wait
    this.trouble = {}; // root -> { message, force }: a refused turn-off, under its switch
    this.writes = Promise.resolve(); // the write chain: one save at a time, in order
    this.gone = false; // the dialog closed: a running turn-off reports with a toast
    this.overlay = props()?.overlay ?? p?.overlay ?? null; // kept: a save's task may outlive this copy's props
    this.bin = cliPathOf(appHome());
    this.redraw = this.redrawLoop(cx);
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The dialog may take the keyboard a moment after it opens (mods/prompt).
    cx.timer.after(600, () => this.handle.focus());
    cx.spawn(async (cx) => {
      await this.load(cx);
      cx.notify();
    });
  }

  // Herdr's last call when the overlay goes, by Esc too: from here on a
  // turn-off still running reports with a toast.
  close() {
    this.gone = true;
  }

  // Cerrar and Esc: what is still typed in a field is saved first (as its
  // blur would); a refused value keeps the dialog open. Nothing while a
  // turn-off runs.
  dismiss(cx) {
    if (this.busy) return;
    if (this.loaded && !this.flush(cx)) {
      this.message = "Revisa los campos marcados.";
      this.alert = true;
      cx.notify();
      return;
    }
    closeOverlay(this.overlay);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    if (this.open) {
      this.open = null;
      cx.notify();
      return;
    }
    this.dismiss(cx);
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
  // server popup reads it): the "▾" lists, the placeholders and the variants.
  // Never throws.
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

  // One InputState per typed field, kept across renders. `change(text)` is
  // the field's saveChange change; `write(text)` keeps the form's text.
  makeInputs() {
    const field = (key, value, placeholder, change, write) => {
      const s = InputState.new({ value, placeholder });
      s.on("change", (_e, cx) => {
        write(s.value());
        this.dirty.add(key);
        this.errors = this.errors.filter((e) => e.field !== key);
        if (!this.busy) {
          this.message = "";
          this.alert = false;
        }
        cx.notify();
      });
      s.on("blur", (_e, cx) => this.commit(key, cx));
      s.on("submit", (_e, cx) => this.commit(key, cx));
      this.fields.set(key, { state: s, change, write });
    };
    const q = this.form.queue;
    field("cap", q.cap, "2", (value) => ({ queue: "cap", value }), (v) => { q.cap = v; });
    for (const lane of this.lanes) {
      field(`lane:${lane.id}`, q.perSpace[lane.id], "1",
        (value) => ({ queue: "perSpace", lane: lane.id, value }), (v) => { q.perSpace[lane.id] = v; });
    }
    for (const { root } of this.repos) {
      const r = this.form.repos[root];
      const stored = repoSettings(this.settings, root);
      for (const env of ENVS) {
        const placeholder = commandPlaceholder(stored, this.detections[root], env);
        field(`${root}:envs.${env}`, r.envs[env], placeholder,
          (value) => ({ root, field: `envs.${env}`, value }), (v) => { r.envs[env] = v; });
      }
      field(`${root}:port`, r.port, HELP.portPlaceholder, (value) => ({ root, field: "port", value }), (v) => { r.port = v; });
    }
  }

  // A typed field's save (its blur or Enter): only when it was edited since
  // its last save. A refused value stays with its error and nothing is
  // written; otherwise the field shows the value as stored (trimmed, clamped,
  // or the stored one again for text that isn't a number) and the write
  // runs. Answers false when refused.
  commit(key, cx) {
    if (!this.loaded || !this.dirty.has(key)) return true;
    const f = this.fields.get(key);
    if (!f) return true;
    const change = f.change(f.state.value());
    const check = saveChange(this.settings, change);
    if (check.errors.length > 0) {
      this.errors = [...this.errors.filter((e) => e.field !== key), ...check.errors];
      cx.notify();
      return false;
    }
    this.dirty.delete(key);
    const shown = fieldText(check.settings ?? this.settings, change);
    if (f.state.value() !== shown) {
      f.write(shown);
      f.state.set_value(shown);
      this.dirty.delete(key); // set_value may report a change
    }
    this.persist(change, cx);
    return true;
  }

  // Every field still edited, saved (Cerrar, Esc). False when one is refused.
  flush(cx) {
    let ok = true;
    for (const key of [...this.dirty]) ok = this.commit(key, cx) && ok;
    return ok;
  }

  // A "▾" pick: the field takes the script's command and saves it.
  pickCommand(root, env, command, cx) {
    const key = `${root}:envs.${env}`;
    const f = this.fields.get(key);
    if (!f) return;
    f.write(command);
    f.state.set_value(command);
    this.dirty.add(key);
    this.errors = this.errors.filter((e) => e.field !== key);
    this.commit(key, cx);
  }

  // The registration default's facts, only for repos with nothing set (D7);
  // each such switch is drawn with "Por defecto: …" until its facts arrive.
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

  // ── Saving ───────────────────────────────────────────────────────────────

  // A change saved in a task no view owns, then the dialog redrawn.
  persist(change, cx) {
    cx.spawn(async () => {
      await this.save(change);
      this.redraw();
    }, { owner: null });
  }

  // One change through the write chain, then the reap when a queue value
  // changed. False when it couldn't be written (the dialog says so).
  async save(change) {
    let r;
    try {
      r = await this.write((settings) => saveChange(settings, change));
    } catch (e) {
      r = { ok: false, wrote: false, failure: firstLine(e) };
    }
    if (r.errors?.length > 0) {
      const fields = new Set(r.errors.map((e) => e.field));
      this.errors = [...this.errors.filter((e) => !fields.has(e.field)), ...r.errors];
      return false;
    }
    if (!r.ok) {
      this.message = `No se pudo guardar en settings.json${r.failure ? ` (${r.failure})` : ""}: prueba otra vez.`;
      this.alert = true;
      return false;
    }
    if (r.needsReap) {
      try {
        await runReap();
      } catch {
        // The next on/off or the reaper picks the change up.
      }
    }
    return true;
  }

  // One write at a time, in order: each runs casWrite against the snapshot
  // the one before it left, and keeps the new one (another writer's values
  // included, when the file had changed).
  write(apply) {
    const run = this.writes.then(async () => {
      const r = await casWrite(settingsIo, { text: this.text, settings: this.settings }, apply);
      if (r.ok) {
        this.text = r.text;
        this.settings = r.settings;
        if (r.wrote) this.valid = true;
      }
      return r;
    });
    this.writes = run.catch(() => null);
    return run;
  }

  // ── Usar Spotlight and the turn-off (D37, D47) ───────────────────────────

  switchOf(repo) {
    return spotlightSwitch(repoSettings(this.settings, repo.root), this.facts[repo.root] ?? null);
  }

  // The switch flipped: `enabled` written at once, or, switched off on a lit
  // repo, the turn-off first (state.json read now, in the task).
  flip(repo, cx) {
    if (!this.loaded || this.busy) return;
    const sw = this.switchOf(repo);
    if (sw.disabled) return;
    this.begin(repo, cx);
    cx.spawn(async () => {
      try {
        const flip = flipSpotlight(repo.root, sw.on, await readStateFile(settingsDir()));
        if (flip?.turnOff) await this.turnOff(repo, flip.turnOff.argv, flip.change);
        else if (flip) await this.save(flip.change);
      } catch (e) {
        this.message = `No se pudo guardar: ${firstLine(e)}`;
        this.alert = true;
      }
      this.busy = null;
      this.redraw();
    }, { owner: null });
  }

  // Apagar igual: the forced turn-off, which leaves the switch on.
  forceOff(repo, cx) {
    if (!this.loaded || this.busy) return;
    this.begin(repo, cx);
    cx.spawn(async () => {
      try {
        await this.turnOff(repo, forceTurnOffArgv(repo.root), null);
      } catch (e) {
        this.trouble[repo.root] = { message: firstLine(e), force: false };
      }
      this.busy = null;
      this.redraw();
    }, { owner: null });
  }

  begin(repo, cx) {
    delete this.trouble[repo.root];
    this.busy = repo.root;
    this.message = "";
    this.alert = false;
    this.open = null;
    cx.notify();
  }

  // A turn-off (up to 120 s), the dialog saying so meanwhile. `change` (the
  // switch's `enabled: false`) is written once it went off; null for Apagar
  // igual, which leaves the switch on. A refusal stays under the repo's
  // switch, with Apagar igual when forcing fixes it; a dialog closed
  // meanwhile gets a toast instead.
  async turnOff(repo, argv, change) {
    this.message = `Apagando Spotlight en ${repo.name}…`;
    this.alert = false;
    this.redraw();
    let result;
    try {
      result = await exec(this.bin, argv, { timeout: TURN_OFF_TIMEOUT_MS });
    } catch (e) {
      result = { error: e };
    }
    const after = afterTurnOff(result, { forced: change === null });
    this.message = "";
    if (after.writeOff) {
      if (await this.save(change)) return;
      this.message = `Spotlight se apagó en ${repo.name}, pero no se pudo guardar ${HELP.switchLabel} apagado: apágalo otra vez.`;
      this.alert = true;
      if (this.gone) notify({ title: `Spotlight se apagó en ${repo.name}`, body: this.message, level: "error" });
      return;
    }
    if (after.ok) {
      this.message = `Spotlight se apagó en ${repo.name}.`;
      return;
    }
    this.trouble[repo.root] = { message: after.message, force: after.offerForce };
    if (this.gone) notify({ title: `Spotlight sigue encendido en ${repo.name}`, body: after.message, level: "error" });
  }

  // Redraws the dialog from tasks no view owns: `redraw()` asks for one. The
  // loop is the dialog's own task, so it goes with the dialog.
  redrawLoop(cx) {
    let wake = null;
    let pending = false;
    cx.spawn(async (cx) => {
      for (;;) {
        if (!pending) await new Promise((resolve) => { wake = resolve; });
        pending = false;
        try {
          cx.notify();
        } catch {
          return; // closed meanwhile
        }
      }
    });
    return () => {
      pending = true;
      const w = wake;
      wake = null;
      w?.();
    };
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  error(key) {
    return this.errors.find((e) => e.field === key)?.message ?? "";
  }

  input(t, key, width) {
    const bad = Boolean(this.error(key));
    const el = Input.new(this.fields.get(key).state).h(28).px(8).rounded(6).border_1()
      .border_color(bad ? t.blocked : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return width ? el.w(width) : el.flex_1().min_w(0);
  }

  toggle(t, id, on, text, flip, enabled = true) {
    return h_flex().id(id).gap(8).items_center()
      .when(enabled, (el) => el.cursor_pointer().on_click((_e, cx) => { flip(cx); cx.notify(); }))
      .when(!enabled, (el) => el.opacity(0.5))
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
      .on_click((_e, cx) => { pick(cx); cx.notify(); })
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

  hint(t, text) {
    return div().text_size(11).text_color(t.dim).child(text);
  }

  // A command field: the env's chip (the env in use, saved on click), the
  // input, and its "▾" (when the repo has scripts to suggest), with the list
  // under the row while open. Built like projects-sidebar's new-workspace
  // select: a press outside closes it.
  commandField(t, repo, env) {
    const f = this.form.repos[repo.root];
    const key = `${repo.root}:envs.${env}`;
    const id = (s) => `sl-set-${repo.root}-${env}-${s}`;
    const options = scriptSuggestions(this.detections[repo.root]);
    const open = this.open === key;
    const current = String(f.envs[env] ?? "").trim();
    const inUse = repoSettings(this.settings, repo.root).env === env;
    return v_flex().id(id("field")).w_full()
      .when(open, (el) => el.on_mouse_down_out((_e, cx) => {
        if (this.open !== key) return;
        this.open = null;
        cx.notify();
      }))
      .child(h_flex().gap(8).items_center()
        .child(this.chip(t, `sl-set-${repo.root}-env-${env}`, inUse, ENV_LABEL[env],
          (cx) => this.persist({ root: repo.root, field: "env", value: env }, cx)))
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
            this.pickCommand(repo.root, env, command, cx);
            cx.notify();
          })
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(command))))));
  }

  queueSection(t) {
    const q = this.settings.queue;
    const row = (label, hint, control) => h_flex().gap(10).items_center().py(4)
      .child(div().flex_1().min_w(0).child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)))
      .child(control);
    return v_flex().gap(2)
      .child(this.toggle(t, "sl-set-queue", q.enabled, "Cola de pruebas activa",
        (cx) => this.persist({ queue: "enabled", value: !q.enabled }, cx)))
      .child(div().text_size(11).text_color(t.dim).pb(4)
        .child(q.enabled ? "Un turno de pruebas por tarea, en orden de llegada." : "Apagada: `spotlight on` prende el server al instante, sin turno."))
      .child(row("Máximo en total", "1–4", this.input(t, "cap", 56)))
      .children(this.lanes.map((lane) => row(`${lane.name}: por espacio`, "1–4", this.input(t, `lane:${lane.id}`, 56))))
      .child(div().pt(6).child(this.toggle(t, "sl-set-resume", q.autoResume, "Continuar solo cuando vuelva el límite de uso",
        (cx) => this.persist({ queue: "autoResume", value: !q.autoResume }, cx))));
  }

  // One repo, as Orca's repository section: Usar Spotlight with its help (and
  // the default or the harness beside it, a refused turn-off under it), then
  // Server: its help, the variant help, the command per env and Puerto.
  repoBlock(t, repo) {
    const sw = this.switchOf(repo);
    const harness = Boolean(this.facts[repo.root]?.harness);
    const trouble = this.trouble[repo.root] ?? null;
    const variant = variantHelp(this.detections[repo.root]);
    const id = (s) => `sl-set-${repo.root}-${s}`;
    const errs = [...ENVS.map((e) => `${repo.root}:envs.${e}`), `${repo.root}:port`].map((k) => this.error(k)).filter(Boolean);
    return v_flex().gap(6).py(10).border_t_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().font_medium().child(repo.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(repo.root)))
      .child(this.toggle(t, id("switch"), sw.on, HELP.switchLabel, (cx) => this.flip(repo, cx), !sw.disabled && !this.busy))
      .child(this.hint(t, HELP.switch))
      .when(Boolean(sw.note), (el) => el.child(div().text_size(11).text_color(harness ? t.blocked : t.dim).child(sw.note)))
      .when(Boolean(trouble), (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.blocked).child(trouble.message))
        .when(Boolean(trouble?.force), (r) => r.child(this.button(t, id("force"), HELP.forceOff, false,
          (cx) => this.forceOff(repo, cx), !this.busy)))))
      .child(div().pt(6).text_size(12).font_medium().child(HELP.serverTitle))
      .child(this.hint(t, HELP.server))
      .when(Boolean(variant), (el) => el.child(this.hint(t, variant)))
      .children(ENVS.map((env) => this.commandField(t, repo, env)))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.muted).child(HELP.portLabel))
        .child(this.input(t, `${repo.root}:port`, 90)))
      .child(this.hint(t, HELP.port))
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
        .child("settings.json no se pudo leer: se muestran los valores por defecto y el primer cambio lo reemplaza.")))
      .child(label("Cola de pruebas"))
      .child(this.queueSection(t))
      .child(label("Repos"))
      .child(v_flex().gap(4).pb(8)
        .child(this.hint(t, HELP.section))
        .child(this.hint(t, HELP.logs)))
      .when(this.repos.length === 0, (el) => el.child(div().text_color(t.dim).child("Ningún repo en un espacio todavía.")))
      .children(this.repos.map((repo) => this.repoBlock(t, repo)));
    const footer = h_flex().px(18).py(12).gap(8).items_center().border_t_1().border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.alert ? t.blocked : t.dim).child(this.message))
      .child(this.button(t, "sl-set-close", "Cerrar", false, (cx) => this.dismiss(cx), !this.busy));
    return root.child(body).child(footer);
  }
}
