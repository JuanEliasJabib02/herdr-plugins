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

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, shared, appHome, home, readTextFile, writeTextFile, exec } from "herdr";
import { ENVS, parseSettings, repoSettings } from "./settings.js";
import { lanesOf, reposOf, toForm, applyForm, enabledChoice, isHarnessRoot, serializeSettings } from "./settings-form.js";
import { hasServerCommand } from "./server-plan.js";
import { cliPathOf } from "./board-model.js";

const ENV_LABEL = { local: "Local", dev: "Dev", prod: "Prod" };

const settingsDir = () => `${appHome()}/spotlight`;

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
  init(_props, cx) {
    this.loaded = false;
    this.text = null; // settings.json as read: the compare-and-swap snapshot
    this.settings = null;
    this.valid = true;
    this.lanes = [];
    this.repos = [];
    this.form = null;
    this.inputs = new Map(); // field key -> InputState
    this.facts = {}; // root -> repoEnabledFrom's facts, once looked up
    this.errors = [];
    this.message = "";
    this.busy = false;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      await this.load(cx);
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
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
    this.makeInputs();
    this.loaded = true;
    this.lookUpFacts(cx);
  }

  // One InputState per typed field, kept across renders.
  makeInputs() {
    const field = (key, value, placeholder, write) => {
      const s = InputState.new({ value, placeholder });
      s.on("change", (_e, cx) => {
        write(s.value());
        this.errors = this.errors.filter((e) => e.field !== key);
        this.message = "";
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
      for (const env of ENVS) {
        field(`${root}:envs.${env}`, r.envs[env], env === "local" ? "detectado del package.json" : "", (v) => { r.envs[env] = v; });
      }
      field(`${root}:port`, r.port, "automático", (v) => { r.port = v; });
    }
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

  async save(cx) {
    if (!this.loaded || this.busy) return;
    const out = applyForm(this.settings, this.form);
    if (out.errors.length > 0) {
      this.errors = out.errors;
      this.message = "Revisa los campos marcados.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.message = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const dir = settingsDir();
      const next = serializeSettings(out.settings);
      try {
        if (this.text === null) await exec("mkdir", ["-p", dir]);
        await writeTextFile(`${dir}/settings.json`, next, this.text);
      } catch {
        // Stale snapshot: someone saved in between. Read it again, keep nothing typed.
        this.busy = false;
        this.inputs.clear();
        this.errors = [];
        await this.load(cx);
        this.message = "settings.json cambió mientras editabas: se volvió a cargar, guarda otra vez.";
        cx.notify();
        return;
      }
      if (out.needsReap) {
        try {
          await runReap();
        } catch {
          // The next on/off or the footer's reaper picks the change up.
        }
      }
      this.busy = false;
      this.close();
    });
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
      .children(ENVS.map((env) => h_flex().gap(8).items_center()
        .child(this.chip(t, id(`env-${env}`), f.env === env, ENV_LABEL[env], () => { f.env = env; }))
        .child(this.input(t, `${repo.root}:envs.${env}`))))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.muted).child("Puerto"))
        .child(this.input(t, `${repo.root}:port`, 90)))
      .when(errs.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(errs.join(" "))));
  }

  render() {
    const t = theme();
    const header = h_flex().px(18).pt(16).pb(8).items_center()
      .child(div().flex_1().text_size(15).font_semibold().child("Spotlight · Ajustes"))
      .child(div().text_size(11).text_color(t.dim).child("Esc"));
    const root = v_flex().id("spotlight-settings").track_focus(this.handle)
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
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.errors.length ? t.blocked : t.dim).child(this.message))
      .child(this.button(t, "sl-set-cancel", "Cancelar", false, () => this.close()))
      .child(this.button(t, "sl-set-save", this.busy ? "Guardando…" : "Guardar", true, (cx) => this.save(cx), !this.busy));
    return root.child(body).child(footer);
  }
}
