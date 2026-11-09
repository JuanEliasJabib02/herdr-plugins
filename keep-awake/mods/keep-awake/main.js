// Keep computer awake: Orca's Caffeinate status segment for Herdr (plan
// D1–D10). A coffee cup in projects-sidebar's status bar opens a popup with
// three modes, On, Agent and Off (shared key "keep-awake.mode", every window
// the same), and one `/usr/bin/caffeinate -i -s -w <Herdr's pid>` keeps the
// Mac awake while the mode wants it (holder.js).
//
// The only file that imports "herdr": it hands Herdr's exec, files, shared
// values and live terminals to the holder and the loop (popup-model.js), and
// draws the cup and its popup (views/). Copies, by their props:
//   no view, no overlay  the cup, a cell of the status row. The one copy that
//                        runs the loop: a tick every second (startLoop) that
//                        asks the holder for a caffeinate when the mode wants
//                        one, shares what it found under VIEW_KEY and redraws
//                        only when that changed. Its close() lets go of the
//                        caffeinate (D7).
//   { view: "popup" }    the popup above the cup. Render-only: it draws the
//                        mode and what the loop shared; a row's click sets
//                        the mode itself and closes it (D9).
//   any other copy       render-only: no timer, nothing run.

import { View, div } from "gpui-kit";
import {
  props, exec, appHome, readTextFile, writeTextFile, settings, openOverlay, closeOverlay,
  terminals, shared, setShared, theme, window as appWindow,
} from "herdr";
import { MODE_KEY } from "./model.js";
import { Holder } from "./holder.js";
import {
  COFFEE, VIEW_KEY, CLOSED_KEY, WINDOW_LOOK_MS, Loop, isLoopCopy, startLoop, anchorFrom, cellBounds, zoomOf,
  closedJustNow, popupSpec, cellModel, popupModel, choose,
} from "./popup-model.js";
import { renderCell } from "./views/cell.js";
import { renderPopup } from "./views/popup.js";

// The holder's IO, from Herdr (holder.js's header).
function herdrHolder() {
  return new Holder({
    exec: (cmd, args) => exec(cmd, args),
    read: (path) => readTextFile(path),
    write: (path, text, expected) => writeTextFile(path, text, expected),
    mkdirp: (dir) => exec("mkdir", ["-p", dir]),
    appHome: appHome(),
    log: (line) => console.log(`keep-awake: ${line}`),
  });
}

export default class KeepAwake extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = typeof pr?.view === "string" ? pr.view : null;
    this.overlay = pr?.overlay ?? null;
    this.isCell = isLoopCopy(pr);
    this.loop = null;
    this.pressed = null; // its bounds at the last press, for that press's click
    this.pressedAt = null; // when that press was
    this.anchor = null; // where the popup opens from without a press's bounds
    this.popup = null; // the popup this copy opened last
    if (!this.isCell) return;
    if (appWindow()) {
      this.start(pr, cx);
      return;
    }
    // Herdr opening on a layout makes its views before its window. A copy
    // that never gets one (herdr-app check, which really runs what it is
    // handed) only looks: it starts nothing and writes nothing.
    const look = cx.timer.every(WINDOW_LOOK_MS, (cx) => {
      if (this.loop || !appWindow()) return;
      look?.cancel?.();
      this.start(pr, cx);
    });
  }

  // The loop, once, in a window (D6).
  start(pr, cx) {
    if (this.loop) return;
    this.loop = new Loop({
      holder: herdrHolder(),
      live: { mode: () => shared(MODE_KEY), terminals: () => terminals(), window: () => appWindow() },
    });
    startLoop(pr, cx.timer, (cx) => {
      cx.spawn(async (cx) => {
        const view = await this.loop.tick();
        // setShared re-renders every mod (the popup shows it), so only a
        // change is shared. Also redrawn while its place isn't known: the
        // first frame may have no window size.
        if (view) setShared(VIEW_KEY, view);
        if (view || this.anchor === null) cx.notify();
      });
    });
  }

  // The cup's: the caffeinate it holds goes (D7); another window's copy
  // starts one at its next liveness check, and `-w` covers a quit or crash.
  // The popup's: the press that closed it may reach the cup, whose click
  // then doesn't open it again (closedJustNow).
  async close() {
    if (this.overlay) setShared(CLOSED_KEY, Date.now());
    if (this.loop) await this.loop.release();
  }

  // ── The cup's copy ──

  press(e) {
    if (!e?.bounds) return;
    this.pressed = e.bounds;
    this.pressedAt = Date.now();
  }

  // The cup's click: the press that closed the popup doesn't open it again,
  // so a second click closes it.
  toggle() {
    const pressedAt = this.pressedAt ?? undefined;
    const anchor = anchorFrom(this.pressed) ?? this.anchor;
    this.pressed = null;
    this.pressedAt = null;
    if (closedJustNow(shared(CLOSED_KEY), Date.now(), pressedAt)) return;
    this.openPopup(anchor);
  }

  // Above the cup. One open replaces the one before, so they don't stack;
  // closing an id already gone does nothing.
  openPopup(anchor) {
    const previous = this.popup;
    this.popup = openOverlay(popupSpec({ anchor, zoom: zoomOf(settings()) }));
    if (previous !== null) closeOverlay(previous);
  }

  renderCup(t) {
    this.anchor = anchorFrom(cellBounds(window.viewport_size(), zoomOf(settings())));
    return renderCell({
      t,
      model: cellModel(shared(MODE_KEY), this.loop?.last ?? null),
      icon: COFFEE,
      onPress: (e) => this.press(e),
      onClick: () => this.toggle(),
    });
  }

  // ── The popup's copy ──

  renderPopupView(t) {
    return renderPopup({
      t,
      model: popupModel(shared(MODE_KEY), shared(VIEW_KEY)),
      onPick: (value) => choose(value, { overlay: this.overlay, setShared, closeOverlay }),
    });
  }

  render() {
    const t = theme();
    if (this.isCell) return this.renderCup(t);
    if (this.name === "popup") return this.renderPopupView(t);
    return div().p(8).text_size(11.5).text_color(t.dim)
      .child(`keep-awake: no view "${this.name ?? "overlay"}" (the cup runs in the layout)`);
  }
}
