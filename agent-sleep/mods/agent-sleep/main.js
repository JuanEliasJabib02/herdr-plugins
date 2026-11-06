// Agent sleep: Orca Pro Max's agent hibernation for Herdr (plan D1–D13). A
// Claude that finished and that nobody is looking at is stopped after a while
// (/exit) and resumed in the same terminal (`claude --resume <id>`) when its
// tab is shown again.
//
// The only file that imports "herdr": it hands Herdr's live data, hc, exec,
// files and clock to the Coordinator (coordinator.js), which holds the loop,
// and draws the block (views/). Copies, by their props:
//   no view, no overlay  the block in the layout (projects-sidebar's plugin
//                        slot, T6). The one copy that runs the loop (D11:
//                        a pulse every second, through startLoop) and reads
//                        key commands ("agent-sleep.sleep-now",
//                        "agent-sleep.wake-all").
//   any other copy       render-only: no timer, no loop, no command.
// The settings view is drawn in the block itself (its "Settings"), so it
// belongs to the loop copy and saves through it. In the sidebar's rail
// (rail.js) the block is its compact form, with no settings view; one left
// open is back when the sidebar is.

import { View, div } from "gpui-kit";
import {
  props, hc, exec, home, appHome, readTextFile, writeTextFile,
  terminals, spaces, panes, focused, notify, shared, setShared, theme, nextCommand, layout,
} from "herdr";
import { Coordinator, MOD, isLoopCopy, startLoop, stepMinutes, windowLabel } from "./coordinator.js";
import { iconPath } from "./badges.js";
import { isRail } from "./rail.js";
import { renderBlock, renderRail } from "./views/block.js";
import { renderSettings } from "./views/settings.js";

// Key commands ("agent-sleep.<name>" in keys.json, or `herdr-app do
// agent-sleep.<name>`), acted on by the loop's next pulse (D9).
const COMMANDS = {
  "sleep-now": (co) => co.requestSleepNow(),
  "wake-all": (co) => co.requestWakeAll(),
};

// What the Coordinator touches, from Herdr.
function herdrDeps() {
  return {
    hc: (args) => hc(args),
    exec: (cmd, args, options) => exec(cmd, args, options),
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
    this.co = null;
    this.mode = "block";
    if (!isLoopCopy(pr)) return;
    this.co = new Coordinator(herdrDeps());
    startLoop(pr, cx.timer, (cx) => {
      cx.spawn(async (cx) => {
        if (await this.co.pulse({ sleep: (ms) => cx.sleep(ms) })) cx.notify();
      });
    });
    this.listen(cx);
  }

  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const command = COMMANDS[c];
        if (command) command(this.co);
        else console.log(`agent-sleep: no command "${c}"`);
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    if (!this.co) {
      return div().p(8).text_size(11.5).text_color(t.dim)
        .child(`agent-sleep: no view "${this.name ?? "overlay"}" (the block runs in the layout)`);
    }
    // D6: what is on screen now, and what just left it, on every render.
    this.co.observeNow();
    if (isRail(layout())) return renderRail({ t, model: this.co.model(), moon: iconPath(MOD) });
    if (this.mode === "settings") {
      const settings = this.co.shownSettings();
      const change = (c) => (_e, cx) => {
        this.co.requestSettings(c);
        cx.notify();
      };
      return renderSettings({
        t,
        settings,
        windowText: windowLabel(settings.idleMinutes),
        onToggle: change({ enabled: !settings.enabled }),
        onLess: change({ idleMinutes: stepMinutes(settings.idleMinutes, -1) }),
        onMore: change({ idleMinutes: stepMinutes(settings.idleMinutes, 1) }),
        onDone: (_e, cx) => {
          this.mode = "block";
          cx.notify();
        },
      });
    }
    const act = (fn) => (_e, cx) => {
      fn();
      cx.notify();
    };
    return renderBlock({
      t,
      model: this.co.model(),
      moon: iconPath(MOD),
      onSleepNow: act(() => this.co.requestSleepNow()),
      onWakeAll: act(() => this.co.requestWakeAll()),
      onSettings: act(() => {
        this.mode = "settings";
      }),
    });
  }
}
