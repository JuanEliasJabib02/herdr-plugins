// The "Cola de pruebas" popup (T8, S1, S9, S13), opened from the footer
// flask: Orca's TestQueuePopover. A header with the limit and the gear
// (settings), then Probando / En cola / Pausados, a row per task (a paused
// agent gets its own): its name, and its repos · space · state ("sin
// actividad hace 12 min", "esperando 3 min", "se quedó sin límite"). A
// flagged testing row (idle or resuming) offers Soltar turno, which gives the
// turn back for every agent of the task (`spotlight off --terminal <t>`),
// and leaves room for Continuar (T11 fills continueButton). A row with a
// repo opens its server popup (D22). The model is board-model.js boardView.
// It reads state.json and settings.json, and re-reads them on each state.json
// write while open (watchState, shared with the footer copy).
//   props: { view: "board" }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, shared, appHome, exec, readTextFile, watchFolder, openOverlay, closeOverlay,
} from "herdr";
import { MOD, stateDirOf, cliPathOf, readState, readSettings, boardView, isStateBatch } from "./board-model.js";

// A popup is as tall as its rows; this is only the most.
const WIDTH = 300;
const MAX_HEIGHT = 440;
// The rows' scroll area, under the header.
const ROWS_HEIGHT = 360;
// Until state.json exists (the CLI never ran), it is looked for this often.
const MISSING_RETRY_MS = 5_000;
// A burst of state.json writes (a lighting) is read once.
const SETTLE_MS = 150;
// The minutes on the rows move on their own.
const TICK_MS = 30_000;

// ── Openers: the only places these overlays open from ──────────────────────

export function openBoard() {
  return openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height: MAX_HEIGHT, props: { view: "board" } });
}

// The settings dialog (T9, settings-view.js).
export function openSettings() {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 560, height: 600, props: { view: "settings" } });
}

// A repo's server popup (T10, server-view.js), with D22's props shape
// { view: "server", repo, workspace }, at the pointer.
export function openServer(target) {
  return openOverlay({ mod: MOD, kind: "popup", width: 320, height: 380, props: target });
}

// ── The state folder ───────────────────────────────────────────────────────

// state.json and settings.json as the board model reads them; `found`:
// state.json exists.
export async function readFiles() {
  const dir = stateDirOf(appHome());
  const [stateText, settingsText] = await Promise.all([
    readTextFile(`${dir}/state.json`),
    readTextFile(`${dir}/settings.json`),
  ]);
  return { state: readState(stateText), settings: readSettings(settingsText), found: stateText !== null };
}

/**
 * Reads the files now, then again after every state.json write, until
 * `alive()` is false: `read(files)` gets each reading, then the copy redraws.
 * Only batches that hold state.json count (board-model.js isStateBatch): lock
 * dirs and tmp files come and go on every CLI call. Until state.json exists,
 * it looks every few seconds instead of watching.
 */
export function watchState(cx, { alive, read }) {
  const dir = stateDirOf(appHome());
  cx.spawn(async (cx) => {
    try {
      let files = await readFiles();
      read(files);
      cx.notify();
      while (alive()) {
        if (!files.found) {
          await cx.sleep(MISSING_RETRY_MS);
        } else {
          let paths;
          try {
            paths = await watchFolder(dir);
          } catch {
            // Gone meanwhile: look again later, as if it were missing.
            await cx.sleep(MISSING_RETRY_MS);
            paths = [dir];
          }
          if (!isStateBatch(dir, paths)) continue;
          await cx.sleep(SETTLE_MS);
        }
        if (!alive()) return;
        files = await readFiles();
        read(files);
        cx.notify();
      }
    } catch (e) {
      // Closed or reloaded: the new build has its own loop.
    }
  });
}

// ── The popup ──────────────────────────────────────────────────────────────

export default class Board {
  init(_props, cx) {
    this.files = { state: readState(null), settings: readSettings(null), found: false };
    this.alive = true;
    // Rows whose Soltar turno is running: its button waits until it ends.
    this.pending = new Set();
    watchState(cx, { alive: () => this.alive, read: (files) => (this.files = files) });
    cx.timer.every(TICK_MS, (cx) => cx.notify());
  }

  close() {
    this.alive = false;
  }

  // Soltar turno: every agent of the task gives the turn back, so the next
  // task gets it (Orca's releaseTurnPanes). The state watch redraws.
  release(row, cx) {
    if (this.pending.has(row.key)) return;
    this.pending.add(row.key);
    cx.spawn(async (cx) => {
      for (const terminal of row.terminals) {
        try {
          const r = await exec(cliPathOf(appHome()), ["off", "--terminal", terminal]);
          if (r.code !== 0) console.log(`spotlight: off --terminal ${terminal} exited ${r.code}: ${r.stderr.trim()}`);
        } catch (e) {
          console.log(`spotlight: off --terminal ${terminal} failed: ${e}`);
        }
      }
      this.pending.delete(row.key);
      cx.notify();
    });
  }

  // The row's server popup, in place of this one.
  openServerOf(row) {
    closeOverlay(props()?.overlay);
    openServer(row.server);
  }

  gear(t) {
    return div()
      .id("spotlight-board-gear")
      .p(3)
      .rounded(5)
      .flex_none()
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Ajustes")
      .on_click(() => {
        closeOverlay(props()?.overlay);
        openSettings();
      })
      .child(svg("mods/workspace-chrome/settings.svg").size(13));
  }

  button(t, id, label, { primary = false, disabled = false, onClick }) {
    return div()
      .id(id)
      .px(8)
      .py(2)
      .rounded(5)
      .border(1)
      .text_size(11)
      .border_color(t.border)
      .when(primary, (el) => el.bg(t.raised))
      .when(disabled, (el) => el.text_color(t.dim))
      .when(!disabled, (el) => el.text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        // The row behind it opens the server popup on a click.
        cx.stop_propagation();
        if (!disabled) onClick(cx);
      })
      .child(label);
  }

  // T11 fills this: the Continuar button of a flagged testing row and of each
  // paused row (account pick, "Retomando…", "Vuelve a las …"). Null until then.
  continueButton(_row, _t) {
    return null;
  }

  actionsOf(kind, row, t) {
    if (kind === "testing") {
      if (!row.release) return [];
      const releasing = this.pending.has(row.key);
      return [
        this.continueButton(row, t),
        this.button(t, `release-${row.key}`, "Soltar turno", { disabled: releasing, onClick: (cx) => this.release(row, cx) }),
      ].filter(Boolean);
    }
    if (kind === "paused") return [this.continueButton(row, t)].filter(Boolean);
    return [];
  }

  row(kind, row, t) {
    const actions = this.actionsOf(kind, row, t);
    return v_flex()
      .id(`spotlight-row-${row.key}`)
      .w_full()
      .px(8)
      .py(5)
      .rounded(6)
      .when(Boolean(row.server), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openServerOf(row)))
      .child(div().truncate().text_size(12).font_medium().text_color(t.foreground).child(row.name))
      .when(Boolean(row.meta), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(row.meta)))
      .when(actions.length > 0, (el) => el.child(h_flex().pt(5).gap(6).flex_wrap().items_center().children(actions)));
  }

  section(s, t) {
    return v_flex()
      .w_full()
      .py(3)
      .child(div().px(8).pb(1).text_size(10.5).font_semibold().text_color(t.muted).child(s.title))
      .children(s.rows.map((row) => this.row(s.kind, row, t)));
  }

  render() {
    const t = theme();
    const board = boardView({ state: this.files.state, settings: this.files.settings, registry: shared("projects.v1"), now: Date.now() });
    const header = h_flex()
      .w_full()
      .px(12)
      .py(8)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(board.title))
      .child(div().flex_none().text_size(10.5).text_color(t.muted).child(board.limit))
      .child(this.gear(t));
    const line = (text) => div().px(12).py(10).text_size(12).text_color(t.muted).child(text);
    return v_flex()
      .id("spotlight-board")
      .w_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(header)
      .when(Boolean(board.offNote), (el) => el.child(div().px(12).pt(8).text_size(11).text_color(t.dim).child(board.offNote)))
      .when(board.empty, (el) => el.child(line(board.emptyText)))
      .when(!board.empty, (el) => el.child(v_flex()
        .id("spotlight-board-rows")
        .w_full()
        .max_h(ROWS_HEIGHT)
        .p(4)
        .overflow_y_scrollbar()
        .children(board.sections.map((s) => this.section(s, t)))));
  }
}
