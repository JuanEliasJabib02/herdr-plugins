// The "Cola de pruebas" popup (T8, S1, S9, S13), opened from the footer
// flask: Orca's TestQueuePopover. A header with the limit and the gear
// (settings), then Probando / En cola / Pausados, a row per task (a paused
// agent gets its own): its name, and its repos · space · state ("sin
// actividad hace 12 min", "esperando 3 min", "se quedó sin límite"). A
// flagged testing row (idle or resuming) offers Soltar turno, which gives the
// turn back for every agent of the task (`spotlight off --terminal <t>`),
// and Continuar (T11, D15): Esc and "Continue where you left off." to the
// turn's last agent. A paused row offers Continuar with the account it would
// resume on ("Continuar con <cuenta>"), "Vuelve a las <hora>" while every
// account is full, or Inicia sesión (the claude-accounts plugin's sign-in)
// for a sign-in pause, and shows why its last Continuar didn't land. Both run
// `spotlight continue --terminal <t>`, which returns at once; "Retomando…"
// shows while its window is open. The labels are resume.js continueView. A
// row with a repo opens its server popup (D22). The model is board-model.js
// boardView. It reads state.json and settings.json, and re-reads them on
// each state.json write while open (watchState, shared with the footer
// copy); the accounts plugin's accounts.v1.json is read on open and every
// 30 s.
//   props: { view: "board" }

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, shared, appHome, exec, readTextFile, watchFolder, openOverlay, closeOverlay, run,
} from "herdr";
import { MOD, stateDirOf, cliPathOf, readState, readSettings, boardView, isStateBatch } from "./board-model.js";
import { continueView, pickFromText } from "./resume.js";

// A popup is as tall as its rows; this is only the most.
const WIDTH = 300;
const MAX_HEIGHT = 440;
// The rows' scroll area, under the header.
const ROWS_HEIGHT = 360;
// Until state.json exists (the CLI never ran), it is looked for this often.
const MISSING_RETRY_MS = 5_000;
// A burst of state.json writes (a lighting) is read once.
const SETTLE_MS = 150;
// The minutes on the rows move on their own; the accounts' pick is read again.
const TICK_MS = 30_000;

// The claude-accounts plugin (its CONTRACT.md): its usage file, its CLI
// (installed or not), and the command that opens its sign-in dialog.
const accountsFileOf = (home) => `${home}/claude-accounts/accounts.v1.json`;
const accountsBinOf = (home) => `${home}/mods/claude-accounts/bin/claude-accounts`;
const ACCOUNTS_SIGN_IN = "claude-accounts.open-accounts";

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
    // The accounts plugin: installed or not, and the account Continuar would use.
    this.accounts = { plugin: false, pick: null };
    this.alive = true;
    // Rows whose Soltar turno or Continuar is running: its button waits until it ends.
    this.pending = new Set();
    watchState(cx, { alive: () => this.alive, read: (files) => (this.files = files) });
    this.readAccounts(cx);
    cx.timer.every(TICK_MS, (cx) => {
      this.readAccounts(cx);
      cx.notify();
    });
  }

  // Whether the accounts plugin is installed, and its pick from
  // accounts.v1.json as it is (a usage refresh is Continuar's own, in the CLI).
  readAccounts(cx) {
    cx.spawn(async (cx) => {
      try {
        const home = appHome();
        const [doc, bin] = await Promise.all([readTextFile(accountsFileOf(home)), readTextFile(accountsBinOf(home))]);
        this.accounts = { plugin: bin !== null, pick: bin !== null ? pickFromText(doc) : null };
        cx.notify();
      } catch (e) {
        // Closed meanwhile: nothing to draw.
      }
    });
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

  // Continuar (D15): `spotlight continue` returns at once (the work runs
  // detached); the state watch then shows "Retomando…" from its window.
  continueTask(row, terminal, cx) {
    const key = `continue:${row.key}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    cx.spawn(async (cx) => {
      try {
        const r = await exec(cliPathOf(appHome()), ["continue", "--terminal", terminal]);
        if (r.code !== 0) console.log(`spotlight: continue --terminal ${terminal} exited ${r.code}: ${r.stderr.trim()}`);
      } catch (e) {
        console.log(`spotlight: continue --terminal ${terminal} failed: ${e}`);
      }
      this.pending.delete(key);
      cx.notify();
    });
  }

  // Inicia sesión: the accounts plugin's own dialog, in place of this popup.
  signIn() {
    closeOverlay(props()?.overlay);
    run(ACCOUNTS_SIGN_IN);
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

  button(t, id, label, { primary = false, disabled = false, tooltip = null, onClick }) {
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
      .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .on_click((_e, cx) => {
        // The row behind it opens the server popup on a click.
        cx.stop_propagation();
        if (!disabled) onClick(cx);
      })
      .child(label);
  }

  // The Continuar slot of a flagged testing row (the turn's last agent, as
  // Orca) or of a paused row (its own agent): resume.js continueView's model
  // plus the terminal it acts on; null for no button.
  continueSlot(kind, row) {
    if (kind === "testing" && !row.release) return null;
    if (kind !== "testing" && kind !== "paused") return null;
    const terminal = kind === "paused" ? row.terminal : row.terminals[row.terminals.length - 1];
    if (!terminal) return null;
    const request = kind === "paused" ? (this.files.state.queue.requests.find((r) => r.terminal === terminal) ?? null) : null;
    const view = continueView({
      kind,
      request,
      resuming: row.resuming,
      pending: this.pending.has(`continue:${row.key}`),
      plugin: this.accounts.plugin,
      pick: this.accounts.pick,
      now: Date.now(),
    });
    return view ? { ...view, terminal } : null;
  }

  continueButton(row, slot, t) {
    if (!slot) return null;
    const onClick = slot.action === "signin" ? () => this.signIn() : (cx) => this.continueTask(row, slot.terminal, cx);
    return this.button(t, `continue-${row.key}`, slot.label, { primary: true, disabled: slot.disabled, tooltip: slot.tooltip, onClick });
  }

  actionsOf(kind, row, slot, t) {
    if (kind === "testing") {
      if (!row.release) return [];
      const releasing = this.pending.has(row.key);
      return [
        this.continueButton(row, slot, t),
        this.button(t, `release-${row.key}`, "Soltar turno", { disabled: releasing, onClick: (cx) => this.release(row, cx) }),
      ].filter(Boolean);
    }
    if (kind === "paused") return [this.continueButton(row, slot, t)].filter(Boolean);
    return [];
  }

  row(kind, row, t) {
    const slot = this.continueSlot(kind, row);
    const actions = this.actionsOf(kind, row, slot, t);
    return v_flex()
      .id(`spotlight-row-${row.key}`)
      .w_full()
      .px(8)
      .py(5)
      .rounded(6)
      .when(Boolean(row.server), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openServerOf(row)))
      .child(div().truncate().text_size(12).font_medium().text_color(t.foreground).child(row.name))
      .when(Boolean(row.meta), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(row.meta)))
      // Why the last Continuar didn't land, whole (a failed job's manual `claude --resume <sid>`).
      .when(Boolean(slot?.note), (el) => el.child(div().pt(2).text_size(11).text_color(t.dim).child(slot.note)))
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
