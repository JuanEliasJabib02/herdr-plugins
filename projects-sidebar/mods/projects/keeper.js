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
//
// It is also the mod's only listener (D7, T8): a key command reaches one
// shown copy only, the first one started (T0b item 2), and this one starts
// with the window, so every `projects.<name>` runs here, the sidebar shown
// or not (listen). Its own commands are the space keys, which skip Inicio.

import { div } from "gpui-kit";
import { run, spaces, panes, home, window, machines, nextCommand } from "herdr";
import * as store from "./store.js";
import {
  ensureInicio, inicioState, look, shouldSelect, targetIndex, newGuard, canMove, moved, observe, localReady,
  SPACE_COMMANDS, spaceTarget,
} from "./inicio-model.js";

// A look this often, besides one each time the copy is drawn (spaces()
// changed): a pause running out, a hidden status row.
const TICK = 1000;
// After a making that didn't land, the next one waits this long.
const RETRY = 30000;

const log = (line) => console.log(`projects: keeper: ${line}`);

// Inicio's id now, by D6's rule (inicio-model.js inicioState), or null.
function inicioId(sp, ps) {
  const st = inicioState({ stored: store.inicio(), spaces: sp, panes: ps });
  return st.kind === "ok" ? st.space.id : null;
}

// The space keys (D7, T8): projects.space-next, -prev and -1…-9, which
// keys.json binds to cmd-alt-] / cmd-alt-[ and ctrl-1…ctrl-9 in the projects
// layout. Each does what Herdr's own space.next, space.prev or
// space.select:N does, over the order without Inicio (inicio-model.js
// spaceTarget), so the keys act as they did before Inicio. A key with
// nothing to change runs nothing.
export const commands = Object.fromEntries(SPACE_COMMANDS.map((name) => [name, () => {
  const sp = spaces();
  const id = spaceTarget(name, sp, inicioId(sp, panes()));
  if (id) run("space.select", { id });
}]));

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
    let id = inicioId(before, panes());
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

  // The mod's command loop, moved here from the tree's copy (D7, T0b item
  // 2): main.js starts it in this copy only, with `commands`, the mod's
  // table (main.js COMMANDS), so no other copy waits on nextCommand(). A
  // handler gets { cx, copy } and keeps no copy's state: it reads and writes
  // the shared keys (store.js), which the tree's copy draws, and acts
  // through herdr. Not tied to a window, as the look is: a command only
  // comes from one, and a window that shows up later finds it listening.
  listen(cx, commands) {
    const copy = Math.random().toString(36).slice(2, 7);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // Only the table's own names: "toString" is no command.
        const handler = Object.hasOwn(commands, c) ? commands[c] : null;
        try {
          if (handler) await handler({ cx, copy });
          else console.log(`projects: no command "${c}"`);
        } catch (e) {
          console.log(`projects: ${c} failed: ${e}`);
        }
        cx.notify();
      }
    });
  }

  // Drawn again whenever spaces() changes: a look right away, from a task.
  render(cx) {
    if (this.live) this.wake(cx);
    return div().size_full();
  }
}
