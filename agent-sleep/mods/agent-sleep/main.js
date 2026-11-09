// Agent sleep: Orca Pro Max's agent hibernation for Herdr (plan D1–D14). A
// Claude that finished and that nobody is looking at is stopped after a while
// (/exit) and resumed in the same terminal (`claude --resume <id>`) when its
// tab is shown again. And Orca's "Sleep" of a whole workspace, which keeps
// everything (workspace-sleep).
//
// The only file that imports "herdr": it hands Herdr's live data, hc, exec,
// files and clock to the Coordinator (coordinator.js), which holds the loop,
// and draws the moon, its popup and the confirm (views/). One mod in views,
// as claude-accounts is: each copy's is props().view, else DEFAULT_VIEW.
//   moon     the last cell of projects-sidebar's status row, with no props.
//            With no overlay, the one copy that runs the loop (D11: a pulse
//            every second, through startLoop), reads key commands, takes the
//            popup's and the confirm's requests, and opens the confirm when a
//            workspace's sleep asks first (workspace-sleep D5), popup open or
//            not.
//   panel    the popup above the moon. Render-only (D14): it draws what the
//            loop copy shares under VIEW_KEY and asks by leaving a command
//            under REQUEST_KEY. Its clicks never touch records, settings or
//            Core.
//   confirm  workspace-sleep D5's "Sleep anyway?" dialog. Render-only too: it
//            draws the question its props carry and answers it under
//            REQUEST_KEY; closed without an answer, it answers Cancel.
//   any other copy, a moon with an overlay too, draws one line saying so: no
//   timer, no loop, no command.

import { View, div } from "gpui-kit";
import {
  props, hc, exec, run, home, appHome, readTextFile, writeTextFile, settings, openOverlay, closeOverlay,
  terminals, spaces, panes, focused, notify, shared, setShared, theme, nextCommand, window as appWindow,
} from "herdr";
import { Coordinator, MOD, VIEW_KEY, REQUEST_KEY, isLoopCopy, startLoop, windowLabel } from "./coordinator.js";
import { iconPath } from "./badges.js";
import {
  CLOSED_KEY, anchorFrom, closedJustNow, makeRequest, moonBounds, moonTone, panelSpec, panelView, zoomOf,
  confirmAnswer, confirmModel, confirmSpec, confirmStep,
} from "./panel-model.js";
import { renderStatus } from "./views/status.js";
import { renderPanel } from "./views/panel.js";
import { renderConfirm } from "./views/confirm.js";

// A copy without a view is the moon. scripts/check-views.sh rewrites this line
// in a tmp copy, because herdr-app check draws only the default view.
const DEFAULT_VIEW = "moon";

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

const noView = (t, name) => div().p(8).text_size(11.5).text_color(t.dim)
  .child(`agent-sleep: no view "${name}" (the moon runs in the layout)`);

// ── The moon: the loop copy ──

class Moon {
  init(pr, cx) {
    this.co = null;
    this.pressed = null; // its bounds at the last press, for that press's click
    this.pressedAt = null; // when that press was
    this.anchor = null; // where the popup opens from
    this.panel = null; // the popup this copy opened last
    this.confirm = null; // { question, overlay }: the confirm it has open (workspace-sleep D5)
    if (!isLoopCopy(pr, DEFAULT_VIEW)) return;
    this.co = new Coordinator(herdrDeps());
    // herdr-app check has no window and really runs what it is handed: that
    // copy only draws, and writes nothing to the home it checks in.
    if (!appWindow()) return;
    startLoop(pr, cx.timer, (cx) => {
      cx.spawn(async (cx) => {
        // Also while its place isn't known: the first frame has no window size,
        // and nothing else may redraw this copy before a `panel` key.
        if ((await this.co.pulse({ sleep: (ms) => cx.sleep(ms) })) || this.anchor === null) cx.notify();
        this.syncConfirm();
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

  // workspace-sleep D5, after each pulse (the only place a question is
  // asked): a sleep waiting on its answer gets the confirm, opened here so it
  // asks with no popup open too (T6's right-click). One per question: a newer
  // one replaces it, and one answered or dropped closes it. Closing one that
  // closed itself (its answer) does nothing.
  syncConfirm() {
    const step = confirmStep(this.confirm?.question ?? null, this.co.view().question);
    if (step.close && this.confirm !== null) closeOverlay(this.confirm.overlay);
    if (step.close) this.confirm = null;
    if (step.open) this.confirm = { question: step.open.id, overlay: openOverlay(confirmSpec({ question: step.open, owner: this.co.d.copyId })) };
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

  render(cx) {
    const t = theme();
    if (!this.co) return noView(t, "overlay");
    // D14: what the popup or the confirm asked for (its setShared re-rendered this copy).
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
}

// ── The popup ──

class Panel {
  init(pr) {
    this.overlay = pr.overlay ?? null;
    this.owner = pr.owner ?? null; // the loop copy its clicks ask
  }

  // The popup's last act: the press that closed it may reach the moon, whose
  // click then doesn't open it again (closedJustNow).
  async close() {
    if (this.overlay) setShared(CLOSED_KEY, Date.now());
  }

  render() {
    const t = theme();
    const view = panelView(shared(VIEW_KEY));
    return renderPanel({
      t,
      view,
      windowText: windowLabel(view.settings.idleMinutes),
      ask: (command) => () => setShared(REQUEST_KEY, makeRequest(command, Date.now(), this.owner)),
    });
  }
}

// ── The confirm (workspace-sleep D5, T7) ──

class Confirm {
  init(pr) {
    this.overlay = pr.overlay ?? null;
    this.owner = pr.owner ?? null; // the loop copy whose question it is
    this.question = pr.question ?? null; // { id, label, count }, from confirmSpec
    this.answered = false; // sent: closing doesn't answer again
  }

  // Its answer, once, for the loop copy that asked (D14's request). One whose
  // copy is gone (a reload) reaches no one: the new copy never asked it.
  send(yes) {
    const command = confirmAnswer(this.question, yes);
    if (this.answered || command === null) return;
    this.answered = true;
    setShared(REQUEST_KEY, makeRequest(command, Date.now(), this.owner));
  }

  // Cancel or Sleep: the answer, then it closes.
  answer(yes) {
    this.send(yes);
    if (this.overlay) closeOverlay(this.overlay);
  }

  // Herdr's last call when it goes. Closed without an answer (Esc, a click
  // beside it, the moon closing it for a newer question) is Cancel, as Orca's
  // dialog is.
  async close() {
    if (this.overlay && !this.answered) this.send(false);
  }

  render() {
    return renderConfirm({
      t: theme(),
      model: confirmModel(this.question),
      onCancel: () => this.answer(false),
      onSleep: () => this.answer(true),
    });
  }
}

const VIEWS = {
  moon: Moon,
  panel: Panel,
  confirm: Confirm,
};

export default class AgentSleep extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.name = pr.view ?? DEFAULT_VIEW;
    const V = typeof this.name === "string" && Object.hasOwn(VIEWS, this.name) ? VIEWS[this.name] : null;
    this.view = V ? new V() : null;
    this.view?.init(pr, cx);
  }

  async close(cx) {
    await this.view?.close?.(cx);
  }

  render(cx) {
    if (!this.view) return noView(theme(), String(this.name));
    return this.view.render(cx);
  }
}
