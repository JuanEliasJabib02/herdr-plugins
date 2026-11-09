// The server popup (D22, P3, P4), props { view: "server", repo, workspace }:
// opened at the pointer by the server badge's command (badges.js), a
// toast's action, or a board row, always through board.js openServer. It
// shows the repo's env (Local / Dev / Prod, only those with a command), its
// variant chips, each URL, and Ver server / Reiniciar / Apagar; on a root
// that diverged or has an untracked collision, also Forzar sync, Proyectar
// igual and Apagar igual. Every control runs the `spotlight` CLI
// (server-view-model.js builds the argv); the popup follows state.json while
// it is open (board.js watchState), so what a control changed shows here.
// Esc closes it.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, appHome, readTextFile, exec, shared } from "herdr";
import * as fs from "fs/promises";
import { detectServerScripts } from "./server-plan.js";
import { cliPathOf, readState, readSettings } from "./board-model.js";
import { readFiles, watchState } from "./board.js";
import { iconPath } from "./badges-model.js";
import { serverViewModel, modIo } from "./server-view-model.js";

const STATE_WORDS = {
  listening: "escuchando",
  starting: "arrancando",
  stopped: "parado",
  gone: "cerrado",
  "needs-variant": "elige una variante",
};

// Controls whose work is done once they ran: the popup closes on success.
const CLOSES = new Set(["peek", "off", "off-anyway", "force-sync", "project-anyway"]);

// `light` runs inline in the CLI and can outlive exec's 30 s (D18): it runs
// detached through sh, its argv passed as positional args (never parsed).
const DETACH = ["/bin/sh", "-c", 'nohup "$0" "$@" </dev/null >/dev/null 2>&1 &'];

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export default class ServerView {
  init(p, cx) {
    this.repo = p?.repo ?? null;
    this.workspace = p?.workspace ?? null;
    this.overlay = p?.overlay ?? null;
    this.bin = cliPathOf(appHome());
    this.state = readState(null);
    this.settings = readSettings(null);
    this.detection = null;
    this.busy = null; // the id of the control running now
    this.failure = null; // its error line, when it failed
    this.alive = true;
    watchState(cx, {
      alive: () => this.alive,
      read: ({ state, settings }) => {
        this.state = state;
        this.settings = settings;
      },
    });
    cx.spawn(async (cx) => {
      await this.detect();
      cx.notify();
    });
  }

  close() {
    this.alive = false;
  }

  // T5a's detection in the root, which holds the lit workspace's tree.
  async detect() {
    if (!this.repo) return;
    try {
      this.detection = await detectServerScripts(this.repo, modIo({ readTextFile, readdir: fs.readdir }));
    } catch {
      this.detection = { detected: {}, scriptCommands: [] };
    }
  }

  // Runs one control's argv in the root; its failure stays on screen.
  act(item, cx) {
    if (this.busy) return;
    this.busy = item.id;
    this.failure = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failure = null;
      try {
        const argv = item.detach ? [...DETACH, ...item.argv] : item.argv;
        const r = await exec(argv[0], argv.slice(1), { cwd: this.repo });
        if (r.code !== 0) failure = firstLine(r.stderr) || firstLine(r.stdout) || `salió con código ${r.code}`;
      } catch (e) {
        failure = firstLine(e?.message ?? e) || "no arrancó";
      }
      this.busy = null;
      this.failure = failure;
      if (!failure && CLOSES.has(item.id) && this.overlay) {
        closeOverlay(this.overlay);
        return;
      }
      const files = await readFiles();
      this.state = files.state;
      this.settings = files.settings;
      if (item.id.startsWith("env-")) await this.detect();
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    if (!this.repo) return div().p(10).text_size(12).text_color(t.dim).child("spotlight: falta el repo");
    const m = serverViewModel({
      state: this.state, settings: this.settings, repo: this.repo, workspace: this.workspace, detection: this.detection, bin: this.bin,
      // D32: an unlit workspace's task, for the env stored for it.
      registry: shared("projects.v1"), cache: shared("projects.cache.v1"),
    });
    const word = m.holder ? STATE_WORDS[m.serverState] ?? m.serverState ?? "" : "apagado";
    const label = (text) => div().pt(2).text_size(11).text_color(t.dim).child(text);

    const button = (item) => h_flex()
      .id(`sv-${item.id}`)
      .h(24)
      .px(9)
      .rounded(6)
      .items_center()
      .border(1)
      .border_color(item.danger ? t.blocked : t.border)
      .text_color(item.danger ? t.blocked : t.foreground)
      .when(this.busy === item.id, (el) => el.opacity(0.6))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.act(item, cx))
      .child(this.busy === item.id ? `${item.label}…` : item.label);

    const envRow = (e) => h_flex()
      .id(`sv-env-${e.env}`)
      .h(24)
      .px(6)
      .gap(8)
      .rounded(6)
      .items_center()
      .when(e.selected, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (!e.selected) this.act({ id: `env-${e.env}`, argv: e.argv, label: e.label }, cx);
      })
      .child(div().flex_none().text_color(e.selected ? t.accent : t.dim).child(e.selected ? "●" : "○"))
      .child(div().flex_none().w(40).child(e.label))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(e.command ?? ""))
      .when(e.running, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("corriendo")));

    const chip = (v) => h_flex()
      .id(`sv-variant-${v.variant}`)
      .h(22)
      .px(8)
      .gap(4)
      .rounded(11)
      .items_center()
      .border(1)
      .border_color(v.selected ? t.accent : t.border)
      .text_color(v.selected ? t.accent : t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (!v.selected) this.act({ id: `variant-${v.variant}`, argv: v.argv, label: v.label }, cx);
      })
      .child(v.label)
      .when(v.inferred, (el) => el.child(div().text_size(10).text_color(t.dim).child("inferida")));

    const url = (u) => h_flex()
      .id(`sv-url-${u}`)
      .h(22)
      .px(6)
      .rounded(6)
      .items_center()
      .text_color(t.accent)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => cx.open_url(u))
      .child(u.replace(/^http:\/\//, ""));

    return v_flex()
      .id("server-view")
      .w_full()
      .min_h(0)
      .p(10)
      .gap(5)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(svg(iconPath("server")).size(14).flex_none().text_color(t.muted))
        .child(div().font_semibold().flex_none().child(m.name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(m.holderName ? `← ${m.holderName}` : ""))
        .child(div().flex_none().text_size(11).text_color(m.serverState === "listening" && m.holder ? t.done : t.dim).child(word)))
      .when(Boolean(m.errorTitle), (el) => el.child(v_flex().gap(2).p(6).rounded(6).border(1).border_color(t.blocked)
        .child(div().text_color(t.blocked).child(m.errorTitle))
        // The engine's message, only when the words above don't carry it (T2).
        .when(Boolean(m.errorDetail), (box) => box.child(div().text_size(11).text_color(t.dim).truncate().child(m.errorDetail)))))
      .when(this.detection === null, (el) => el.child(div().text_size(11).text_color(t.dim).child("Leyendo package.json…")))
      .when(m.envs.length > 0, (el) => el.child(label("Entorno")).children(m.envs.map(envRow)))
      .when(Boolean(m.envNote), (el) => el.child(div().text_size(11).text_color(t.blocked).child(m.envNote)))
      .when(m.variants.length > 0, (el) => el
        .child(label(m.needsVariant ? "Elige una variante" : "Variante"))
        .child(h_flex().flex_wrap().gap(6).children(m.variants.map(chip))))
      .when(m.urls.length > 0, (el) => el.child(h_flex().flex_wrap().gap(4).children(m.urls.map(url))))
      .when(m.actions.length > 0, (el) => el.child(h_flex().pt(2).flex_wrap().gap(6).children(m.actions.map(button))))
      .when(m.force.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(m.force.map(button))))
      .when(Boolean(this.failure), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.failure)));
  }
}
