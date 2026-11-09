// The keeper (workspace-sleep D6, D7): a 1 px copy in the status row,
// { "mod": "projects", "props": { "view": "keeper" } }, the row's first cell.
// A copy starts the first time it shows, so a sidebar that starts hidden
// (cmd-b) would never start the tree's copy; this one starts with the
// window, and its timers keep running while hidden (AGENTS.md "Mods").
//
// It makes Inicio and keeps it right after the shown space, so closing the
// shown space by any path (Cmd+W, the tab or pane X, the menus, the picker,
// `exit`) lands on Inicio, never on another worktree (S10). It selects
// Inicio when the shown space is put away (a workspace sleep) or vanishes.
// The rules are inicio-model.js's; this file wires herdr in. It acts only
// from spawned tasks, never from render() (store.js "Never write from
// render()"), and without a window it is inert, so `herdr-app check` never
// makes a space.

import { div } from "gpui-kit";
import { run, spaces, panes, home, window, machines } from "herdr";
import * as store from "./store.js";
import {
  ensureInicio, inicioState, look, shouldSelect, targetIndex, newGuard, canMove, moved, observe, localReady,
} from "./inicio-model.js";

// A look this often, besides one each time the copy is drawn (spaces()
// changed): a pause running out, a hidden status row.
const TICK = 1000;
// After a making that didn't land, the next one waits this long.
const RETRY = 30000;

const log = (line) => console.log(`projects: keeper: ${line}`);

export default class Keeper {
  init(_props, cx) {
    this.live = Boolean(window());
    if (!this.live) return;
    this.last = null; // the last look (inicio-model.js look), null before the first
    this.guard = newGuard();
    this.busy = false;
    this.retryAt = 0;
    cx.timer.every(TICK, (cx) => this.wake(cx));
    this.wake(cx);
  }

  // One look at a time: one asked for while another runs is that one.
  wake(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        // Out of the render that may have asked for it first.
        await cx.sleep(0);
        await this.step(cx);
      } catch (e) {
        // A command Herdr refused (its layout unavailable) or a reload: the
        // next look starts over, as after a reload.
        this.last = null;
        log(`${e?.message ?? e}`);
      } finally {
        this.busy = false;
      }
    });
  }

  // Inicio there (made if it must be), selected when the last look and this
  // one say so, then moved right after the shown space if the guards allow.
  async step(cx) {
    // While this computer's spaces load, spaces() lists none.
    if (!localReady(machines())) {
      this.last = null;
      return;
    }
    const io = {
      stored: () => store.inicio(),
      store: (id) => store.saveInicio(id),
      run: (name, args) => run(name, args),
      spaces: () => spaces(),
      panes: () => panes(),
      home: home(),
      sleep: (ms) => cx.sleep(ms),
    };
    const before = spaces();
    const st = inicioState({ stored: store.inicio(), spaces: before, panes: panes() });
    let id = st.kind === "ok" ? st.space.id : null;
    const select = shouldSelect(this.last, look(before), id);
    let shown = false;
    if (!id && Date.now() >= this.retryAt) {
      // Made to be selected, it stays shown (inicio-model.js make()).
      const got = await ensureInicio(io, { stay: select });
      if (got) {
        id = got.id;
        shown = got.made && select;
      } else {
        this.retryAt = Date.now() + RETRY;
        log(`Inicio isn't there yet; trying again in ${RETRY / 1000} s`);
      }
    }
    if (select && id && !shown) run("space.select", { id });
    const after = spaces();
    this.last = look(after);
    if (!id) return;
    const now = Date.now();
    const seen = observe(this.guard, after, id, now);
    this.guard = seen.guard;
    if (seen.log) log(seen.log);
    if (!canMove(this.guard, now)) return;
    const index = targetIndex(after, id);
    if (index === null) return;
    run("space.move", { id, index });
    this.guard = moved(this.guard, index, now);
  }

  // Drawn again whenever spaces() changes: a look right away, from a task.
  render(cx) {
    if (this.live) this.wake(cx);
    return div().size_full();
  }
}
