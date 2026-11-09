// A copy of Herdr 0.1.13's shipped `tabs` mod (Apache License 2.0, see LICENSE in
// this folder), made the way `mod.clone` makes one: its window icons are its own.
// Changed from Herdr's version: a file's tab draws its Material icon, its name in
// italics while it's a preview, and a dot for unsaved changes; its X and a double
// click go to the file; the panels' buttons left the bar for the panel's own header,
// drawn by a second copy (`props.view: "panel"`), as in Orca, and the panel is one
// for the whole window (Herdr's layout click), with no per-space memory; the look
// follows the code editor's design.
// The decisions moved to tabs-model.js so they can be tested. Herdr never updates
// this copy.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, readTextFile, appHome, props } from "herdr";
import {
  DOCS_KEY,
  LIVE_KEY,
  ICON_THEME,
  parseIconTheme,
  tabView,
  closeSlot,
  closeCommand,
  doubleClickCommand,
  enabledPanels,
  panelTabs,
  panelTabClick,
  barToggle,
  openPanel,
  closePanel,
} from "./tabs-model.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const runAll = (commands) => { for (const [name, args] of commands) run(name, args); };

export default class Tabs extends View {
  init(_props, cx) {
    // The panel's header copy only draws its icons: the file icons belong to the
    // bar's copy.
    this.header = props()?.view === "panel";
    if (this.header) return;
    this.pressed = null;
    this.icons = null;
    cx.spawn(async (cx) => {
      try {
        this.icons = parseIconTheme(await readTextFile(`${appHome()}/${ICON_THEME}`));
        cx.notify();
      } catch {
        // Every file keeps the plain icon.
      }
    });
  }

  // The panel's header: an icon per panel with a bar under the shown one, and the
  // toggle that closes the panel at the right end.
  renderHeader(t) {
    const body = find(layout(), "panel-body");
    const stop = (_e, cx) => cx.stop_propagation();
    const tab = ({ id, icon }) => {
      const on = body?.active === id;
      return v_flex().id(`panel-tab-${id}`).w(34).h_full().flex_none().items_center().text_color(on ? t.foreground : t.muted)
        .hover(s => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => runAll(panelTabClick(id)))
        .child(div().flex_1().flex().items_center().child(svg(icon).size(16)))
        .child(div().w(18).h(2).rounded(1).when(on, el => el.bg(t.foreground)));
    };
    return h_flex().size_full().px(6).gap(2).items_center().border_b(1).border_color(t.border)
      .children(panelTabs(enabledPanels(shared("workspace.panels"))).map(tab))
      .child(div().flex_1())
      .child(div().id("panel-close").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(() => runAll(closePanel()))
        .child(svg("mods/code-tabs/panel.svg").size(16)));
  }

  render() {
    const t = theme();
    if (this.header) return this.renderHeader(t);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const docs = shared(DOCS_KEY), live = shared(LIVE_KEY), allPanes = panes();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // The X, or the dot for unsaved changes; on an inactive tab the dot is only a
    // mark, and a press on it reaches the tab.
    const slot = (c, view, mark) => div().id(`close-${c.id}`).w(24).h(27).flex_none().flex().items_center().justify_center().text_color(t.muted)
      .when(mark.closes, el => el.on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run(...closeCommand(c, view)); }))
      .child(mark.dot ? div().size(8).rounded(4).bg(t.ansi3) : svg("mods/pane/close.svg").size(12));
    const item = (c, i) => {
      const view = tabView(c, { docs, live, panes: allPanes, icons: this.icons });
      const { program } = view;
      const mark = closeSlot(c.active, view.dirty);
      return h_flex().id(`tab-${c.id}`).h(29).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation(); this.pressed = i;
          if (e.click_count === 2) { const command = doubleClickCommand(c, view); if (command) run(...command); }
        })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(h_flex().h_full().items_center().gap(7).pl(10).pr(mark ? 4 : 10)
          .when(Boolean(view.icon), el => el.child(image(view.icon).size(14).flex_none()))
          .when(!view.icon && Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
          .child(div().max_w(170).truncate().when(view.preview, el => el.font_family(".SystemUIFont").italic()).child(c.zoomed ? `${view.name} Z` : view.name))
          .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
          .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status]))))
        .when(Boolean(mark), el => el.child(slot(c, view, mark)));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = enabledPanels(shared("workspace.panels"));
    const toggle = barToggle(panel);
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", svg("mods/code-tabs/plus.svg").size(14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(Boolean(toggle), el => el.child(div().ml(4).flex_none().child(button(toggle?.id, svg(toggle?.icon ?? "").size(14), () => runAll(openPanel(body, enabled))))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/code-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/code-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/code-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
