// Agent sleep: Orca Pro Max's agent hibernation for Herdr (plan D1–D14). A
// Claude that finished and that nobody is looking at is stopped after a while
// (/exit) and resumed in the same terminal (`claude --resume <id>`) when its
// tab is shown again.
//
// The only file that imports "herdr": it hands Herdr's live data, hc, exec,
// files and clock to the Coordinator (coordinator.js), which holds the loop,
// and draws the moon and its popup (views/). Copies, by their props:
//   no view, no overlay  the moon, last cell of projects-sidebar's status row.
//                        The one copy that runs the loop (D11: a pulse every
//                        second, through startLoop), reads key commands and
//                        takes the popup's requests.
//   { view: "panel" }    the popup above the moon. Render-only (D14): it draws
//                        what the loop copy shares under VIEW_KEY and asks by
//                        leaving a command under REQUEST_KEY. Its clicks never
//                        touch records, settings or Core.
//   any other copy       render-only: no timer, no loop, no command.

import { View, div } from "gpui-kit";
import {
  props, hc, exec, run, home, appHome, readTextFile, writeTextFile, settings, openOverlay, closeOverlay,
  terminals, spaces, panes, focused, notify, shared, setShared, theme, nextCommand, window as appWindow,
} from "herdr";
import { Coordinator, MOD, VIEW_KEY, REQUEST_KEY, isLoopCopy, startLoop, windowLabel } from "./coordinator.js";
import { iconPath } from "./badges.js";
import {
  CLOSED_KEY, anchorFrom, closedJustNow, makeRequest, moonBounds, moonTone, panelSpec, panelView, zoomOf,
} from "./panel-model.js";
import { renderStatus } from "./views/status.js";
import { renderPanel } from "./views/panel.js";

// What the Coordinator touches, from Herdr.
function herdrDeps() {
  return {
    // Which copy this is: a popup's clicks name it (D14).
    copyId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    hc: (args) => hc(args),
    exec: (cmd, args, options) => exec(cmd, args, options),
    // Herdr's commands, for a workspace's sleep (tab.settle, tab.unsettle).
    // Not `run`: Coordinator.run wraps exec.
    herdrRun: (name, args) => run(name, args),
    files: {
      read: (path) => readTextFile(path),
      write: (path, text, expected) => writeTextFile(path, text, expected),
      // appHome()/agent-sleep before a write; saves are rare (a stop, a
      // resume, a live record that changed).
      mkdirp: async (dir) => {
        await exec("mkdir", ["-p", dir]);
      },
    },
    now: () => Date.now(),
    live: { terminals, spaces, panes, focused },
    notify,
    shared,
    setShared,
    home: home(),
    appHome: appHome(),
    log: (line) => console.log(`agent-sleep: ${line}`),
  };
}

export default class AgentSleep extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = typeof pr?.view === "string" ? pr.view : null;
    this.overlay = pr?.overlay ?? null;
    this.owner = pr?.owner ?? null; // the popup's: the copy its clicks ask
    this.co = null;
    this.pressed = null; // its bounds at the last press, for that press's click
    this.pressedAt = null; // when that press was
    this.anchor = null; // where the popup opens from
    this.panel = null; // the popup this copy opened last
    if (!isLoopCopy(pr)) return;
    this.co = new Coordinator(herdrDeps());
    // herdr-app check has no window and really runs what it is handed: that
    // copy only draws, and writes nothing to the home it checks in.
    if (!appWindow()) return;
    startLoop(pr, cx.timer, (cx) => {
      cx.spawn(async (cx) => {
        // Also while its place isn't known: the first frame has no window size,
        // and nothing else may redraw this copy before a `panel` key.
        if ((await this.co.pulse({ sleep: (ms) => cx.sleep(ms) })) || this.anchor === null) cx.notify();
      });
    });
    this.listen(cx);
  }

  // "agent-sleep.<name>" in keys.json, or `herdr-app do agent-sleep.<name>`.
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "panel") this.openPanel();
        else this.co.command(c);
        cx.notify();
      }
    });
  }

  // The popup's last act: the press that closed it may reach the moon, whose
  // click then doesn't open it again (closedJustNow).
  async close() {
    if (this.overlay) setShared(CLOSED_KEY, Date.now());
  }

  // ── The moon's copy ──

  press(e) {
    if (!e.bounds) return;
    this.pressed = e.bounds;
    this.pressedAt = Date.now();
  }

  // The moon's click: the press that closed the popup doesn't open it again, so
  // a second click closes it.
  toggle() {
    const pressedAt = this.pressedAt ?? undefined;
    const anchor = anchorFrom(this.pressed) ?? this.anchor;
    this.pressed = null;
    this.pressedAt = null;
    if (closedJustNow(shared(CLOSED_KEY), Date.now(), pressedAt)) return;
    this.openPanel(anchor);
  }

  // Above the moon, as tall as its lines now. A `panel` key pressed with one open
  // replaces it, so they don't stack. Closing an id already gone does nothing, and
  // ids aren't reused (o1, o2, …). With no anchor given (a key) it goes by the
  // cell as it is now: a press's bounds are only for that press's click.
  openPanel(anchor = this.anchor) {
    const previous = this.panel;
    this.panel = openOverlay(panelSpec({ view: this.co.view(), anchor, zoom: zoomOf(settings()), owner: this.co.d.copyId }));
    if (previous !== null) closeOverlay(previous);
  }

  // The popup sees a change at once. From a task that yields first, so not
  // inside this render: setShared re-renders every mod, this one too, and
  // viewToPublish stops it there.
  publish(view, cx) {
    const published = this.co.viewToPublish(view);
    if (published === null) return;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      setShared(VIEW_KEY, published);
    });
  }

  renderMoon(t, cx) {
    // D14: what the popup asked for (its setShared re-rendered this copy).
    this.co.takeRequest();
    // D6: what is on screen now, and what just left it, on every render.
    this.co.observeNow();
    const view = this.co.view();
    this.publish(view, cx);
    this.anchor = anchorFrom(moonBounds(window.viewport_size(), zoomOf(settings())));
    return renderStatus({
      t,
      model: view,
      tone: moonTone({ enabled: view.settings.enabled, asleep: view.asleep }),
      moon: iconPath(MOD),
      onPress: (e) => this.press(e),
      onClick: () => this.toggle(),
    });
  }

  // ── The popup's copy ──

  renderPanelView(t) {
    const view = panelView(shared(VIEW_KEY));
    return renderPanel({
      t,
      view,
      windowText: windowLabel(view.settings.idleMinutes),
      ask: (command) => () => setShared(REQUEST_KEY, makeRequest(command, Date.now(), this.owner)),
    });
  }

  render(cx) {
    const t = theme();
    if (this.co) return this.renderMoon(t, cx);
    if (this.name === "panel") return this.renderPanelView(t);
    return div().p(8).text_size(11.5).text_color(t.dim)
      .child(`agent-sleep: no view "${this.name ?? "overlay"}" (the moon runs in the layout)`);
  }
}
