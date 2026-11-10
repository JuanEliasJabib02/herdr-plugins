// The footer flask (T8, S1, S9, S11, S12): Orca's TestQueueButton in the
// status row. A flask and how many tasks test or wait (paused agents never
// count); dimmed when nothing is in line; "Nadie está probando" or "Cola de
// pruebas" on hover; a click opens the board (board.js).
// Its copy is the footer copy, so it also keeps the state watch: on every
// state.json write (watchState) it re-reads the queue for the flask and
// posts the CLI's notes with `toast: true` as toasts, each once, behind a
// high-water mark (D18). The reap and auto-sync are no longer this copy's:
// `spotlight watch` runs them in any layout (D44, main.js). Herdr runs this copy
// only while `projects` is shown, so the mark is kept in shared state
// (TOAST_KEY, D45): a copy that starts again, after another layout or a
// restart, toasts the notes written meanwhile if under 10 minutes old; with
// none stored the mark starts when this copy starts, so it never replays
// older notes. Every read starts from the later of its own mark and the
// stored one, so two copies (two windows) don't both toast a note one of
// them already moved past. A note's action (`spotlight.server.<id>`, the
// server popup) rides on its toast.
//   props: { view: "footer" }, or none

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, notify, shared, setShared } from "herdr";
import { MOD, TOAST_KEY, boardView, footerView, toastMark, takeToasts } from "./board-model.js";
import { openBoard, watchState } from "./board.js";

export default class Footer {
  init(_props, cx) {
    this.flask = { count: 0, quiet: true, tooltip: "Nadie está probando" };
    this.mark = toastMark(Date.now(), shared(TOAST_KEY));
    this.alive = true;
    watchState(cx, { alive: () => this.alive, read: (files) => this.read(files) });
  }

  close() {
    this.alive = false;
  }

  // One reading of state.json and settings.json: the flask, and the toasts
  // newer than the mark, whose new mark is written back for the next copy.
  read({ state, settings }) {
    const now = Date.now();
    this.flask = footerView(boardView({ state, settings, now }));
    const { toasts, mark } = takeToasts(state.notes, this.mark, { now, stored: shared(TOAST_KEY) });
    this.mark = mark;
    if (toasts.length > 0) setShared(TOAST_KEY, mark);
    for (const toast of toasts) notify(toast);
  }

  render() {
    const t = theme();
    const f = this.flask;
    return h_flex()
      .size_full()
      .items_center()
      .justify_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(h_flex()
        .id(`${MOD}-flask`)
        .px(6)
        .py(2)
        .gap(4)
        .rounded(5)
        .items_center()
        .cursor_pointer()
        .tooltip(f.tooltip)
        .when(f.quiet, (el) => el.opacity(0.4))
        .hover((s) => s.opacity(1).bg(t.hover).text_color(t.foreground))
        .on_click(() => openBoard())
        .child(svg(`mods/${MOD}/icons/flask.svg`).size(13).flex_none())
        .when(f.count > 0, (el) => el.child(div().child(String(f.count)))));
  }
}
