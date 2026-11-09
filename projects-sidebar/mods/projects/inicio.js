// Inicio (workspace-sleep D6, S2): what a closed or slept workspace leaves on
// screen instead of the next worktree, Orca's Landing (Landing.tsx:255-322).
// The only pane of Inicio's space, { "mod": "projects", "props": { "view":
// "inicio" } }, which the keeper (keeper.js) makes and keeps right after the
// shown space. Herdr's icon and name, a hint, Add project and Create
// workspace, and a row for each of Orca's shortcuts that has a key here.
// What it says comes from inicio-model.js landing().

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, keys, shared, window } from "herdr";
import { icon } from "./config.js";
import * as store from "./store.js";
import { landing } from "./inicio-model.js";
import { addFromPicker } from "./tree.js";
import { openNewWorkspace } from "./new-workspace.js";

// Add project runs the tree's picker in this copy: `projects.add` reaches
// only the copy that reads commands (R1#10). Create workspace opens the New
// workspace dialog on the active group's first project.
const ACTIONS = {
  "inicio-add-project": (cx) => cx.spawn(async () => addFromPicker()),
  "inicio-create-workspace": () => openNewWorkspace(null),
};

export default class Inicio {
  init(_props, _cx) {}

  render() {
    const t = theme();
    const l = landing({ registry: store.registry(), bindings: keys(), layout: shared("layout"), platform: window()?.platform ?? null });
    return v_flex().id("inicio").size_full().items_center().justify_center().bg(t.background).text_size(13)
      .child(v_flex().w_full().max_w(512).px(24).py(32).gap(16).items_center()
        // The brand icon workspace-chrome draws.
        .child(image("frame/welcome/herdr.png").size(80).rounded(18).shadow_lg())
        .child(div().text_size(36).font_bold().text_color(t.foreground).child(l.title))
        .child(div().text_size(14).text_color(t.muted).text_center().child(l.hint))
        .child(h_flex().gap(10).items_center().justify_center().flex_wrap().children(l.buttons.map((b) => button(b, t))))
        .when(l.shortcuts.length > 0, (el) => el.child(v_flex().mt(24).w(320).gap(8).children(l.shortcuts.map((s) => shortcut(s, t))))));
  }
}

function button(b, t) {
  return h_flex().id(b.id).h(36).px(16).gap(6).items_center().rounded(6).border(1).border_color(t.border).bg(t.raised)
    .text_size(14).font_medium().text_color(t.foreground).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => ACTIONS[b.id](cx))
    .child(svg(icon(b.icon)).size(14).flex_none())
    .child(b.label);
}

// A label on the left, its key as caps on the right (Orca's ShortcutKeyCombo).
function shortcut(s, t) {
  return h_flex().h(22).gap(12).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(t.muted).child(s.label))
    .child(h_flex().flex_none().gap(3).items_center().children(s.caps.map((c) => div().min_w(20).h(20).px(5).flex().items_center().justify_center()
      .rounded(4).border(1).border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(c))));
}
