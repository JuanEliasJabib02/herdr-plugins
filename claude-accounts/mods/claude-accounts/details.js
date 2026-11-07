// Usage details & history (S7, D11, D24), a window: Orca's Claude usage pane
// (renderer/src/components/stats/ClaudeUsagePane.tsx and its
// ClaudeUsageDetails) fed by claude-usage --json. The range picker (7, 30,
// 90 days, all time), Orca's eight cards in a grid of four columns with
// Herdr's tokens and active time under them (each card with its group's
// "since <date>", and a coverage note per group that doesn't cover the
// range), the daily chart, by model, by project and by account, the time to
// each limit, and recent sessions in Orca's seven columns. What it says is
// details-model.js's; this file only draws it. Owners: T10, T20b.
//   props: { view: "details" }
//
// Data: details.json, which `claude-accounts details --range <r>` fills in
// a detached run (cli/details.mjs). Opening the window, picking a range and
// Refresh each ask the CLI for a run of that range (it returns a run already
// going instead of a second one); the last result stays on screen, with its
// "Updated Xm ago", until the new one lands. A watch on the state folder
// re-reads details.json when it changes (a missing folder is polled until it
// exists). The picked range is shared("claude-accounts.details").range.
// A copy without an overlay (herdr-app check) only draws what's on disk: it
// starts no run and no watch.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, exec, readTextFile, watchFolder, home, appHome, shared, setShared } from "herdr";
import { MOD, FILES, stateDir, cliPath, readDetails } from "./store.js";
import { detailsModel, pickRange, SECTION_ROWS } from "./details-model.js";

// The window's own shared key: { range }.
const UI_KEY = "claude-accounts.details";
// A watch wake waits this long, so one write's events come as one batch.
const SETTLE = 150;
// Without a state folder to watch, it looks again this often.
const RETRY = 2000;
// "Updated Xm ago" moves once a minute.
const TICK = 60_000;
// The chart's bar area, in px.
const CHART_H = 110;
// Cards per row: Orca's widest grid (xl:grid-cols-4).
const CARDS_PER_ROW = 4;
// The refresh spinner, drawn natively (frames()).
const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const lastLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

// The only place that opens it: the popup's Usage details & history and the
// open-details command. A window keeps its place (key); Esc goes to the mod,
// so it has its own Close.
export function openDetails() {
  return openOverlay({ mod: MOD, kind: "window", key: "claude-accounts.details", width: 780, height: 640, props: { view: "details" } });
}

// A control's press is its own, never a drag of the window.
const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class Details {
  init(p, cx) {
    this.overlay = props()?.overlay ?? p?.overlay ?? null;
    this.dir = stateDir(home());
    this.file = `${this.dir}/${FILES.details}`;
    this.text = undefined; // details.json's last text read (null: no file)
    this.details = readDetails(null);
    this.range = pickRange(shared(UI_KEY)?.range);
    this.asking = new Set(); // ranges whose `details` call hasn't returned
    this.execErrors = {}; // range → why the CLI couldn't start its run
    this.expanded = {}; // breakdown → all its rows shown
    cx.spawn(async (cx) => {
      if (await this.reload()) cx.notify();
    });
    if (!this.overlay) return;
    this.refresh(cx, this.range);
    this.watch(cx);
    cx.timer.every(TICK, (cx) => cx.notify());
  }

  // Reads details.json; true when it changed.
  async reload() {
    let text = null;
    try {
      text = await readTextFile(this.file);
    } catch {
      text = null;
    }
    if (text === this.text) return false;
    this.text = text;
    this.details = readDetails(text);
    return true;
  }

  // Asks the CLI for a run of the range; it returns at once (the run is
  // detached), and the watch brings the result.
  refresh(cx, range) {
    if (this.asking.has(range)) return;
    this.asking.add(range);
    cx.spawn(async (cx) => {
      try {
        const r = await exec(cliPath(appHome()), ["details", "--range", range, "--json"]);
        this.execErrors[range] = r.code === 0 ? null : lastLine(r.stderr) || `claude-accounts details exited ${r.code}`;
      } catch (e) {
        this.execErrors[range] = String(e?.message ?? e);
      } finally {
        this.asking.delete(range);
      }
      await this.reload();
      cx.notify();
    });
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          try {
            await watchFolder(this.dir);
          } catch {
            await cx.sleep(RETRY);
          }
          await cx.sleep(SETTLE);
          if (await this.reload()) cx.notify();
        }
      } catch {
        // The window closed, or this build was reloaded: its cx is gone.
      }
    });
  }

  select(cx, range) {
    if (range === this.range) return;
    this.range = range;
    const ui = shared(UI_KEY);
    setShared(UI_KEY, { ...(isObject(ui) ? ui : {}), range });
    this.refresh(cx, range);
    cx.notify();
  }

  render() {
    const t = theme();
    const m = detailsModel({ details: this.details, range: this.range, now: Date.now(), execError: this.execErrors[this.range] ?? null });
    return v_flex()
      .id("ca-details")
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .child(this.header(m, t))
      .child(own(v_flex().id("ca-details-body").flex_1().min_h(0).overflow_y_scrollbar())
        .child(v_flex().px(14).pt(12).pb(16).gap(14)
          .children(m.report ? this.report(m.report, t) : [notice(m.notice, t)])));
  }

  // ── Header: title, Refresh, Close; the ranges and Updated ────────────────

  header(m, t) {
    return v_flex().flex_none().px(14).pt(12).pb(10).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).text_size(14).font_semibold().truncate().child("Usage details & history"))
        .child(own(h_flex().id("ca-details-refresh").px(8).py(2).gap(5).items_center().rounded(6).cursor_pointer()
          .text_size(12).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Refresh Claude usage")
          .on_click((_e, cx) => this.refresh(cx, this.range)))
          .when(m.running, (el) => el.child(div().w(10).text_color(t.muted).frames(SPINNER, 90).child(SPINNER[0])))
          .child("Refresh"))
        .child(own(div().id("ca-details-close").px(8).py(2).rounded(6).cursor_pointer().text_size(12).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(this.overlay ?? props()?.overlay)))
          .child("Close")))
      .child(h_flex().items_center().gap(10)
        .child(h_flex().flex_none().gap(2).p(2).rounded(7).bg(t.raised)
          .children(m.ranges.map((r) => own(div().id(`ca-details-range-${r.key}`).px(9).py(3).rounded(5).cursor_pointer()
            .text_size(12)
            .text_color(r.selected ? t.foreground : t.dim)
            .when(r.selected, (el) => el.bg(t.selected).font_medium())
            .when(!r.selected, (el) => el.hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => this.select(cx, r.key)))
            .child(r.label))))
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate().text_right().child(m.status)))
      .when(Boolean(m.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(m.error)));
  }

  // ── Body ──────────────────────────────────────────────────────────────────

  report(r, t) {
    return [
      cardGrid(r, t),
      chart(r.daily, t),
      h_flex().gap(10).items_start()
        .child(this.breakdown("model", r.byModel, t))
        .child(this.breakdown("project", r.byProject, t)),
      h_flex().gap(10).items_start()
        .child(this.breakdown("account", r.byAccount, t))
        .child(limitsSection(r.limits, t)),
      recentSection(r.recent, t),
    ];
  }

  // Orca's UsageBreakdownSection, with each row's share of the range as a
  // thin bar, and "Show all" past its five rows.
  breakdown(name, b, t) {
    const all = this.expanded[name] === true;
    const rows = all ? b.rows : b.rows.slice(0, SECTION_ROWS);
    return section(t, b.title, b.top)
      .flex_1()
      .min_w(0)
      .child(v_flex().gap(9)
        .when(b.rows.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Nothing in this range.")))
        .children(rows.map((row) => v_flex().id(`ca-details-${name}-${row.key}`).gap(3)
          .when(Boolean(row.hint), (el) => el.tooltip(row.hint))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(row.gone ? t.muted : t.foreground).child(row.label))
            .child(div().flex_none().text_color(t.muted).child(row.value)))
          .child(meter(row.share, t))
          .when(Boolean(row.sub), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(row.sub))))))
      .when(b.rows.length > SECTION_ROWS, (el) => el.child(own(div().id(`ca-details-${name}-more`).pt(8).cursor_pointer()
        .text_size(11.5).text_color(t.accent)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.expanded[name] = !all;
          cx.notify();
        }))
        .child(all ? "Show less" : `Show all ${b.rows.length}`)));
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function notice(text, t) {
  return div().py(40).w_full().text_center().text_size(12.5).text_color(t.dim).child(text ?? "");
}

// A bordered block with Orca's title and one dim line under it.
function section(t, title, sub) {
  return v_flex().p(12).gap(10).rounded(8).border_1().border_color(t.border).bg(t.background)
    .child(v_flex().gap(2)
      .child(div().text_size(13).font_semibold().child(title))
      .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(sub))));
}

// Orca's StatCard: the value large, its label under it (it wraps: the cost's
// "• excludes unpriced models" is longer than a card), then its group's
// "since <date>" when there is one.
function card(c, t) {
  return v_flex().id(`ca-details-card-${c.key}`).flex_1().min_w(0).px(12).py(9).gap(1).rounded(8).border_1().border_color(t.border).bg(t.background)
    .when(Boolean(c.hint), (el) => el.tooltip(c.hint))
    .child(div().text_size(17).font_semibold().truncate().child(c.value))
    .child(div().text_size(11).text_color(t.dim).child(c.label))
    .when(Boolean(c.since), (el) => el.child(div().text_size(10.5).text_color(t.muted).truncate().child(c.since)));
}

// Orca's eight cards, then Herdr's two, CARDS_PER_ROW to a row, a short row
// padded so its cards keep the grid's widths; the coverage notes and Orca's
// explanation line under them.
function cardGrid(r, t) {
  const all = [...r.cards, ...r.extras];
  const rows = [];
  for (let i = 0; i < all.length; i += CARDS_PER_ROW) rows.push(all.slice(i, i + CARDS_PER_ROW));
  return v_flex().gap(8)
    .children(rows.map((row) => h_flex().gap(8).items_stretch()
      .children(row.map((c) => card(c, t)))
      .children(Array.from({ length: CARDS_PER_ROW - row.length }, () => div().flex_1().min_w(0)))))
    .children(r.coverage.map((note) => div().px(1).text_size(11.5).text_color(t.muted).child(note)))
    .child(div().px(1).text_size(11.5).text_color(t.dim).child(r.explanation));
}

// A row's share of the range, 0–1.
function meter(share, t) {
  const pct = Math.max(0, Math.min(100, Math.round(share * 1000) / 10));
  return div().w_full().h(3).rounded(2).bg(t.raised)
    .child(div().h(3).rounded(2).bg(t.accent).w(`${pct}%`));
}

// Orca's ClaudeUsageDailyChart: a bar per day (per week past a month), the
// value over each while they fit, MM-DD under some, the exact count on hover.
function chart(d, t) {
  const el = section(t, d.title, d.description);
  if (d.bars.length === 0) return el.child(div().text_size(11.5).text_color(t.dim).child("No days in this range."));
  return el.child(h_flex().h(CHART_H + 34).gap(d.bars.length > 20 ? 2 : 6).items_end()
    .children(d.bars.map((b) => v_flex().id(`ca-details-day-${b.key}`).flex_1().min_w(0).h_full().justify_end().items_center().gap(3)
      .tooltip(b.tooltip)
      .when(d.showValues, (col) => col.child(div().text_size(10.5).text_color(t.dim).whitespace_nowrap().child(b.value)))
      .child(div().w_full().max_w(40).rounded_t(3).bg(b.tokens > 0 ? t.accent : t.raised)
        .h(b.tokens > 0 ? Math.max(2, Math.round(b.share * CHART_H)) : 1))
      .child(div().h(13).text_size(10.5).text_color(t.dim).whitespace_nowrap().child(b.label ?? "")))));
}

// The time to each limit: one row per account, a column per window.
function limitsSection(l, t) {
  const el = section(t, l.title, l.description).flex_1().min_w(0);
  if (l.empty) return el.child(div().text_size(11.5).text_color(t.dim).child(l.empty));
  return el.child(v_flex().gap(9).children(l.rows.map((row) => v_flex().gap(3)
    .child(div().truncate().child(row.account))
    .children(row.cells.map((c) => h_flex().gap(8).text_size(11.5)
      .child(div().w(92).flex_none().text_color(t.dim).child(c.label))
      .child(div().flex_1().min_w(0).truncate().text_color(c.text === "Not hit" ? t.dim : t.foreground).child(c.text)))))));
}

// Orca's UsageRecentSessionsTable: Last active, Project, Model, Turns,
// Input, Output, Cache. The counts are right-aligned.
const COLUMNS = Object.freeze([
  { w: 112 },
  { flex: true },
  { w: 96 },
  { w: 52, right: true },
  { w: 58, right: true },
  { w: 58, right: true },
  { w: 58, right: true },
]);

function cell(i, value, t, head) {
  const c = COLUMNS[i];
  const base = c.flex ? div().flex_1().min_w(0) : div().w(c.w).flex_none();
  return base.truncate().px(4)
    .when(Boolean(c.right), (el) => el.text_right())
    .text_color(head ? t.dim : i === 1 ? t.foreground : t.muted)
    .child(value);
}

function recentSection(r, t) {
  const el = section(t, r.title, r.description);
  if (r.empty) return el.child(div().text_size(11.5).text_color(t.dim).child(r.empty));
  return el.child(v_flex()
    .child(h_flex().py(5).text_size(11).border_b(1).border_color(t.border)
      .children(r.headings.map((h, i) => cell(i, h, t, true))))
    .children(r.rows.map((row, n) => h_flex().id(`ca-details-session-${row.key}`).py(5)
      .when(Boolean(row.hint), (s) => s.tooltip(row.hint))
      .when(n < r.rows.length - 1, (s) => s.border_b(1).border_color(t.border))
      .children(row.cells.map((v, i) => cell(i, v, t, false))))));
}
