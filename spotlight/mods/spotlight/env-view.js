// The env popup of a task lane (D32, S21; Orca's TaskSpotlightEnvPill
// menu), props { view: "env", group, task, members }: opened at the pointer
// by the lane's env pill (badges.js handleCommand, `spotlight.env.<id>`).
// Local / Dev / Prod with the lane's env checked (badges-model.js laneEnv,
// the value the pill says), none while its repos run different ones: Mixto,
// each repo's env named under. A click on another runs `spotlight env
// --task <KEY> --group <id> --env <e>`, which stores the pick for the task
// before it answers and switches the task's lit servers in the background
// (each restarts only when its command changes); the popup closes once it
// answered, its failure stays on screen. It follows state.json while open
// (board.js watchState). Esc closes it.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, appHome, exec } from "herdr";
import { MOD, cliPathOf, readState, readSettings } from "./board-model.js";
import { watchState } from "./board.js";
import { iconPath, laneEnv, laneEnvChoices } from "./badges-model.js";
import { ENV_LABELS } from "./task-env.js";

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** Opens a lane's env popup at the pointer: `target` { view: "env", group, task, members }. */
export function openEnvPopup(target) {
  return openOverlay({ mod: MOD, kind: "popup", width: 240, height: 190, props: target });
}

export default class EnvView {
  init(p, cx) {
    this.group = p?.group ?? null;
    this.task = p?.task ?? null;
    this.members = Array.isArray(p?.members) ? p.members : [];
    this.overlay = p?.overlay ?? null;
    this.bin = cliPathOf(appHome());
    this.state = readState(null);
    this.settings = readSettings(null);
    this.busy = null; // the env being picked now
    this.failure = null; // its error line, when it failed
    this.alive = true;
    watchState(cx, {
      alive: () => this.alive,
      read: ({ state, settings }) => {
        this.state = state;
        this.settings = settings;
      },
    });
  }

  close() {
    this.alive = false;
  }

  // Runs the pick's argv; the CLI answers at once (it detaches the restarts).
  pick(choice, cx) {
    if (this.busy) return;
    this.busy = choice.env;
    this.failure = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failure = null;
      try {
        const r = await exec(choice.argv[0], choice.argv.slice(1));
        if (r.code !== 0) failure = firstLine(r.stderr) || firstLine(r.stdout) || `salió con código ${r.code}`;
      } catch (e) {
        failure = firstLine(e?.message ?? e) || "no arrancó";
      }
      this.busy = null;
      this.failure = failure;
      if (!failure && this.overlay) {
        closeOverlay(this.overlay);
        return;
      }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    if (!this.group || !this.task) return div().p(10).text_size(12).text_color(t.dim).child("spotlight: falta la tarea");
    const env = laneEnv({ group: this.group, key: this.task, members: this.members, state: this.state, settings: this.settings });
    const choices = laneEnvChoices({ group: this.group, key: this.task, value: env.value, bin: this.bin });
    const mixed = env.value === null && env.repos.length > 0
      ? `Mixto: ${env.repos.map((r) => `${r.name} ${ENV_LABELS[r.env] ?? r.env}`).join(" · ")}`
      : null;

    const row = (c) => h_flex()
      .id(`ev-${c.env}`)
      .h(24)
      .px(6)
      .gap(8)
      .rounded(6)
      .items_center()
      .when(c.selected, (el) => el.bg(t.selected))
      .when(this.busy === c.env, (el) => el.opacity(0.6))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (!c.selected) this.pick(c, cx);
      })
      .child(div().flex_none().text_color(c.selected ? t.accent : t.dim).child(c.selected ? "●" : "○"))
      .child(div().flex_1().min_w(0).child(this.busy === c.env ? `${c.label}…` : c.label));

    return v_flex()
      .id("env-view")
      .w_full()
      .min_h(0)
      .p(10)
      .gap(5)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(svg(iconPath("server")).size(14).flex_none().text_color(t.muted))
        .child(div().font_semibold().flex_none().child(this.task))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Entorno de Spotlight")))
      .children(choices.map(row))
      .when(Boolean(mixed), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(mixed)))
      .when(Boolean(this.failure), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.failure)));
  }
}
