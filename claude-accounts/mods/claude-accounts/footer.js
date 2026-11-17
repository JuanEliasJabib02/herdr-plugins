// The footer: the active account's usage in the sidebar's status row (S1,
// Image #1): `Used [icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable [refresh]`,
// D5's colors and D10's density levels. What it says is footer-model.js's;
// this file draws it. Owner: T6.
//   props: { view: "footer" }, or none
//
// Its copy is the one that always lives, so it also keeps (D1):
// - the 15-minute timer, which runs `usage --json` (the CLI's cadence decides
//   what is due);
// - the watch on the state folder: a batch with the root or live/ runs `usage
//   --json` (it merges without fetching), any other only re-reads. Each wake
//   waits SETTLE first, so one write's events come as one batch;
// - on each re-read, toasts.react and its result: notify, the confirm view,
//   the sign-in link on the clipboard. What was shown is in
//   shared("claude-accounts.seen");
// - for toasts.react's Agents check, what Herdr's Agents list shows, read
//   only once AGENTS_WARMUP has passed since the start (right after one the
//   list is empty), a re-read then, another when react asks for one
//   (recheckIn), and a log line with hc's view of each restarted Claude the
//   list doesn't show, so the cause can be told apart next time: on stdout
//   and, stamped, in the state folder's AGENTS_LOG (Herdr under launchd
//   drops its stdout).
// A click on it opens the popover above it; the mode (Detailed | Compact) is
// the shared UI value the popover sets (D12).
//
// herdr-app check has no window (window() is null) and really runs exec, so
// that copy only draws: it runs nothing, reads nothing and posts nothing.
//
// The popover and the panel reuse what's exported here: refreshUsage,
// UsageView (their data), signInAccount and the small pieces they share.

import { div, image, PathBuilder } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, exec, run, notify, openOverlay, closeOverlay, readTextFile, watchFolder, shared, setShared, settings, props, home, appHome, window as appWindow, agents, panes, spaces } from "herdr";
import { FILES, stateDir, cliPath, readAccounts, classifyWatchPaths } from "./store.js";
import { react } from "./toasts.js";
import { openConfirm } from "./confirm.js";
import {
  UI_KEY, SEEN_KEY, FOOTER, MERGE_ARGS, REFRESH_ARGS, REFRESH_TIP, usageMode, footerModel, popupSpec, zoomOf, footerBounds, anchorFrom,
  rememberAnchor, lastAnchor, reactState, applyReact, signInTab, withClosedAt, closedJustNow,
} from "./footer-model.js";

// D4: the timer polls every 15 minutes.
const POLL = 15 * 60_000;
// A footer made before the app's window looks for it this often (D26).
const WINDOW_LOOK = 250;
// "3h 2m" moves once a minute.
const TICK = 60_000;
// A watch wake waits this long, so one write's events come as one batch.
const SETTLE = 150;
// Without a state folder to watch, it looks again this often.
const RETRY = 2000;
// Herdr's Agents list is empty right after a start; it's read after this.
const AGENTS_WARMUP = 20_000;
// The state folder's log of restarted Claudes Agents didn't list.
const AGENTS_LOG = "agents-check.log";
// The usage's hover area reaches this far past its text.
const TRIGGER_PAD = 4;
// The refresh spinner, drawn natively (frames()).
const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const CLAUDE_ICON = "icons/claude.svg";

// Fresh usage now (`usage --refresh`): the `refresh` command, and the
// refresh buttons of the footer, the popup and the panel. The CLI rewrites
// accounts.v1.json, and the footer's watch picks it up.
export async function refreshUsage() {
  const r = await exec(cliPath(appHome()), [...REFRESH_ARGS]);
  if (r.code !== 0) console.log(`claude-accounts: usage --refresh exited ${r.code}: ${r.stderr.trim()}`);
  return r;
}

// What Herdr's Agents list shows, for toasts.react: the terminals agents()
// lists, those with a pane, and each paned terminal's space name (its pane's
// tab, in spaces()); null when Herdr can't say.
function agentsShown() {
  try {
    const paned = panes();
    const spaceName = new Map();
    for (const s of spaces()) for (const tab of Array.isArray(s?.tabs) ? s.tabs : []) if (typeof tab?.id === "string") spaceName.set(tab.id, s.name);
    const names = {};
    for (const p of paned) {
      const name = spaceName.get(p?.tab);
      if (typeof p?.terminal === "string" && typeof name === "string" && !Object.hasOwn(names, p.terminal)) names[p.terminal] = name;
    }
    return { listed: agents().map((a) => a?.address), panes: paned.map((p) => p?.terminal), names };
  } catch {
    return null;
  }
}

// A restarted Claude Agents doesn't list, logged with hc's view of its
// terminal: a null status with `reported` means Claude stopped reporting,
// a status there means the window lost it. The line also goes, after an
// ISO timestamp, to the end of `dir`'s AGENTS_LOG.
async function logUnlisted({ terminal, sessionId }, dir) {
  const r = await exec("hc", ["get", terminal, "--json"]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  let view = (r.stderr ?? "").trim() || `hc exited ${r.code}`;
  try {
    const t = JSON.parse(r.stdout);
    view = JSON.stringify({ status: t.status ?? null, status_ms: t.status_ms ?? null, reported: t.reported ?? false, pid: t.foreground?.pid ?? null });
  } catch {
    // Not hc's JSON: what it said stays.
  }
  const line = `claude-accounts: ${terminal} (session ${sessionId}) was restarted, but Agents doesn't list it; hc get: ${view}`;
  console.log(line);
  await exec("sh", ["-c", 'printf "%s\\n" "$1" >> "$2"', "sh", `${new Date().toISOString()} ${line}`, `${dir}/${AGENTS_LOG}`]);
}

// A Herdr tab runs the CLI's login, which runs `claude auth login` there (D3).
export function signInAccount(id) {
  run("tab.new", signInTab(cliPath(appHome()), id));
}

// A file of the state folder's text, null when it isn't there.
async function readState(name) {
  try {
    return await readTextFile(`${stateDir(home())}/${name}`);
  } catch {
    return null;
  }
}

// accounts.v1.json now, for an overlay about to open.
export async function readContract() {
  const text = await readState(FILES.contract);
  return { text, doc: readAccounts(text) };
}

// ── What the footer, the popover and the panel share ────────────────────────

export class UsageView {
  // props: what the opener read (the first frame has the numbers), where it
  // opened and how tall.
  setup(p) {
    const pr = props() ?? p ?? {};
    this.overlay = pr.overlay ?? null;
    this.anchor = pr.anchor ?? null;
    this.height = pr.height ?? null;
    this.dir = stateDir(home());
    this.text = pr.text ?? null;
    this.doc = readAccounts(this.text);
    this.refreshing = false;
    this.gone = false; // a copy of another size took this one's place
  }

  // Reads accounts.v1.json; true when it changed.
  async reload() {
    const text = await readState(FILES.contract);
    if (text === this.text) return false;
    this.text = text;
    this.doc = readAccounts(text);
    return true;
  }

  // An overlay's data: its file now, again when the state folder changes, and
  // the countdowns once a minute.
  follow(cx) {
    const wake = async (cx) => {
      if (await this.reload() && !this.fit()) cx.notify();
    };
    cx.spawn(wake);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          try {
            await watchFolder(this.dir);
          } catch {
            await cx.sleep(RETRY);
          }
          await cx.sleep(SETTLE);
          await wake(cx);
        }
      } catch {
        // The overlay closed, or this build was reloaded: its cx is gone.
      }
    });
    cx.timer.every(TICK, (cx) => cx.notify());
  }

  // An open overlay can't change its size, and what it draws may have: a copy
  // of the new size takes its place, at the same anchor, its bottom still
  // above the footer. Each view's spec() says what it would open. True when
  // this copy is gone.
  fit() {
    if (this.gone || !this.overlay || !this.anchor || this.height === null) return this.gone;
    const spec = this.spec();
    if (spec.height === this.height) return false;
    this.gone = true;
    openOverlay(spec);
    closeOverlay(this.overlay);
    return true;
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await refreshUsage();
      } catch (e) {
        console.log(`claude-accounts: usage --refresh failed: ${e}`);
      }
      this.refreshing = false;
      if (await this.reload()) this.fit();
      if (!this.gone) cx.notify();
    });
  }

  // The press that closed an overlay may reach the footer: it marks the time
  // (closedJustNow). A task still running here won't open a copy any more.
  async close() {
    this.gone = true;
    if (this.overlay) setShared(UI_KEY, withClosedAt(shared(UI_KEY), Date.now()));
  }
}

// ── Small pieces ─────────────────────────────────────────────────────────────

export const claudeIcon = (size) => image(CLAUDE_ICON).size(size).flex_none();

// Lucide's icons, as Orca draws them, painted natively: a 24-unit grid in
// percent of the icon's box, with Lucide's stroke (2 of 24).
const P = (n) => `${(n / 24) * 100}%`;
const strokeIcon = (draw, color, size) => window.paint_path(draw(PathBuilder.stroke(size / 12)).build(), color).size(size).flex_none();

// RefreshCw.
const refreshPath = (b) => b
  .move_to(P(3), P(12)).arc_to(P(9), P(9), 0, false, true, P(12), P(3)).arc_to(P(9.75), P(9.75), 0, false, true, P(18.74), P(5.74)).line_to(P(21), P(8))
  .move_to(P(21), P(3)).line_to(P(21), P(8)).line_to(P(16), P(8))
  .move_to(P(21), P(12)).arc_to(P(9), P(9), 0, false, true, P(12), P(21)).arc_to(P(9.75), P(9.75), 0, false, true, P(5.26), P(18.26)).line_to(P(3), P(16))
  .move_to(P(8), P(16)).line_to(P(3), P(16)).line_to(P(3), P(21));
export const refreshIcon = (color, size = 12) => strokeIcon(refreshPath, color, size);

// TriangleAlert.
const warningPath = (b) => b
  .move_to(P(21.73), P(18)).line_to(P(13.73), P(4)).arc_to(P(2), P(2), 0, false, false, P(10.25), P(4)).line_to(P(2.25), P(18))
  .arc_to(P(2), P(2), 0, false, false, P(4), P(21)).line_to(P(20), P(21)).arc_to(P(2), P(2), 0, false, false, P(21.73), P(18))
  .move_to(P(12), P(9)).line_to(P(12), P(13))
  .move_to(P(12), P(16.5)).line_to(P(12), P(18));
const warningIcon = (color) => strokeIcon(warningPath, color, FOOTER.warning);

// A refresh button: the icon, or the spinner while it runs.
export function refreshButton(id, t, busy, onClick) {
  return h_flex().id(id).size(FOOTER.refresh).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(REFRESH_TIP)
    .on_click((_e, cx) => onClick(cx))
    .child(busy
      ? div().text_size(11).text_color(t.muted).frames(SPINNER, 90).child(SPINNER[0])
      : refreshIcon(t.muted));
}

// A usage bar, the caller gives its width: `fill` percent in D5's color.
export function usageBar(t, fill, color, height = 6) {
  return div().h(height).rounded(height).overflow_hidden().bg(t.raised)
    .child(div().h(height).rounded(height).bg(t[color] ?? t.muted).w(`${fill}%`));
}

// ── The footer ───────────────────────────────────────────────────────────────

export default class Footer extends UsageView {
  init(p, cx) {
    this.setup(p);
    this.size = null; // its size, in window px
    this.width = undefined; // its width, in layout px (unmeasured: full)
    this.pressed = null; // its bounds at the last press
    this.merging = false;
    this.mergeAgain = false;
    this.started = false;
    if (this.overlay) return;
    if (appWindow()) {
      this.start(cx);
      return;
    }
    // Herdr opening on a layout makes its views before its window (D26). A
    // copy that never gets one (herdr-app check) only looks.
    const look = cx.timer.every(WINDOW_LOOK, (cx) => {
      if (this.started || !appWindow()) return;
      look?.cancel?.();
      this.start(cx);
    });
  }

  // The re-read, the merge, the watch and the timers: once, in a window.
  start(cx) {
    if (this.started) return;
    this.started = true;
    cx.spawn(async (cx) => {
      await this.reread(cx);
      this.merge(cx);
    });
    cx.spawn(async (cx) => {
      await cx.sleep(AGENTS_WARMUP);
      this.warm = true;
      try {
        await this.reread(cx);
      } catch {
        // This build was reloaded.
      }
    });
    this.watch(cx);
    cx.timer.every(POLL, (cx) => this.merge(cx));
    cx.timer.every(TICK, (cx) => cx.notify());
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          let action = "reread";
          try {
            action = classifyWatchPaths(this.dir, await watchFolder(this.dir));
          } catch {
            await cx.sleep(RETRY);
          }
          await cx.sleep(SETTLE);
          if (action === "merge") {
            this.merge(cx);
            continue;
          }
          try {
            await this.reread(cx);
          } catch (e) {
            console.log(`claude-accounts: re-read failed: ${e}`);
          }
        }
      } catch {
        // This build was reloaded: the new one has its own loop.
      }
    });
  }

  // `usage --json`, one at a time: a batch meanwhile runs it once more. It
  // doesn't hold up the watch, and what it writes wakes it.
  merge(cx) {
    if (this.merging) {
      this.mergeAgain = true;
      return;
    }
    this.merging = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.mergeAgain = false;
          const r = await exec(cliPath(appHome()), [...MERGE_ARGS]);
          if (r.code !== 0) console.log(`claude-accounts: usage exited ${r.code}: ${r.stderr.trim()}`);
        } while (this.mergeAgain);
      } catch (e) {
        console.log(`claude-accounts: usage failed: ${e}`);
      }
      this.merging = false;
      try {
        await this.reread(cx);
      } catch {
        // This build was reloaded.
      }
    });
  }

  // The files again, and what they have to say to the person (D1).
  async reread(cx) {
    const [restart, pending, link] = await Promise.all([FILES.restart, FILES.pendingSwitch, FILES.loginLink].map(readState));
    if (await this.reload()) cx.notify();
    const agentsNow = this.warm ? agentsShown() : null;
    const r = applyReact(react, reactState({ doc: this.doc, restart, pending, link, now: Date.now(), agents: agentsNow }), shared(SEEN_KEY));
    if (r.seen) setShared(SEEN_KEY, r.seen);
    for (const n of r.notify) notify(n);
    if (r.openConfirm) openConfirm();
    if (r.copyLink) cx.write_to_clipboard(r.copyLink);
    for (const u of r.unlisted) logUnlisted(u, this.dir).catch(() => {});
    if (r.recheckIn !== null) this.recheck(cx, r.recheckIn);
  }

  // One re-read in `ms`, for an item toasts.react can't decide yet; an
  // earlier one already waiting covers it.
  recheck(cx, ms) {
    const at = Date.now() + ms;
    if (this.recheckAt && this.recheckAt <= at) return;
    this.recheckAt = at;
    cx.spawn(async (cx) => {
      await cx.sleep(ms);
      if (this.recheckAt !== at) return;
      this.recheckAt = null;
      try {
        await this.reread(cx);
      } catch {
        // This build was reloaded.
      }
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  measure(size, cx) {
    this.size = size;
    this.pressed = null;
    this.width = size.width / zoomOf(settings());
    cx.notify();
  }

  press(e) {
    if (!e.bounds) return;
    this.pressed = e.bounds;
    rememberAnchor(anchorFrom(e.bounds, zoomOf(settings())));
  }

  // The popover, above the usage. The press that closed it doesn't open it
  // again, so a second click closes it, as Orca's trigger does.
  toggle() {
    const ui = shared(UI_KEY);
    const now = Date.now();
    if (closedJustNow(ui, now)) return;
    openOverlay(popupSpec({ doc: this.doc, text: this.text, mode: usageMode(ui), anchor: lastAnchor(), zoom: zoomOf(settings()), now }));
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  render() {
    const t = theme();
    const zoom = zoomOf(settings());
    const m = footerModel({ doc: this.doc, mode: usageMode(shared(UI_KEY)), width: this.width, now: Date.now() });
    rememberAnchor(anchorFrom(this.pressed ?? footerBounds(window.viewport_size(), this.size), zoom));
    return h_flex()
      .id("ca-footer")
      .size_full()
      .min_w(0)
      .overflow_hidden()
      .px(FOOTER.pad - TRIGGER_PAD)
      .gap(FOOTER.gap - TRIGGER_PAD)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .whitespace_nowrap()
      .on_size_change((size, cx) => this.measure(size, cx))
      .on_mouse_down("left", (e) => this.press(e))
      .child(this.usage(m, t))
      .when(Boolean(m.signIn), (el) => el.child(this.signIn(m.signIn, t)))
      .when(m.refresh, (el) => el.child(refreshButton("ca-footer-refresh", t, this.refreshing, (cx) => this.refresh(cx))));
  }

  // `Used [icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable`, or `[icon] ⚠ label`.
  usage(m, t) {
    return h_flex().id("ca-footer-usage").flex_none().px(TRIGGER_PAD).py(2).gap(FOOTER.gap).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .when(Boolean(m.tooltip), (el) => el.tooltip(m.tooltip))
      .on_click(() => this.toggle())
      .when(Boolean(m.unit), (el) => el.child(m.unit))
      .child(claudeIcon(FOOTER.icon))
      .when(Boolean(m.bar), (el) => el.child(usageBar(t, m.bar.fill, m.bar.color).w(FOOTER.bar).flex_none()))
      .when(m.sections.length > 0, (el) => el.child(h_flex().gap(FOOTER.sectionGap).items_center()
        .children(m.sections.flatMap((s, i) => [
          ...(i > 0 ? [div().text_color(t.dim).child("·")] : []),
          div().text_color(t[s.color] ?? t.muted).child(s.text),
        ]))))
      .when(m.warning, (el) => el.child(warningIcon(t.dim)))
      .when(Boolean(m.label), (el) => el.child(div().text_color(t[m.label.color] ?? t.muted).child(m.label.text)));
  }

  // Orca's Sign in (InlineUsageSignInAction).
  signIn(s, t) {
    return h_flex().id("ca-footer-sign-in").flex_none().px(5).py(2).gap(4).items_center().rounded(4).cursor_pointer()
      .text_color(t.muted)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click(() => signInAccount(s.id))
      .child(refreshIcon(t.muted))
      .child(s.text);
  }
}
