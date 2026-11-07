// A row's right-click menu, a popup with props { root, rel, dir, open, filtering }; with
// no `rel`, the menu of the empty space under the rows. ↑/↓ move, Enter runs, Esc closes.
// It only chooses: D23 keeps the operations off this copy, because a closed popup's tasks
// are cut at 250 ms, so each item runs its `code-explorer.<id>:<rel>` in the panel's copy.
// Only the copies happen here, with this copy's cx.
//
// `herdr` as a namespace: main.js imports this file, and a test's stand-in for Herdr
// that lacks a named import fails the whole file at load.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as herdr from "herdr";
import { MOD, copyText, fileMenuItems } from "./ops-model.js";
import { parseCommand } from "./tree-model.js";

const ROW = 30;
const WIDTH = 240;
const MOST_ROWS = 13;

const COPIED_FOR = 2500;

// The only place that opens the menu, at the pointer. A popup is as tall as its items;
// height is only the most.
export function openFileMenu(target) {
  return herdr.openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height: MOST_ROWS * ROW, props: { view: "file-menu", ...target } });
}

export default class FileMenu {
  init(p, cx) {
    this.root = p?.root ?? "";
    this.rel = p?.rel ?? "";
    this.overlay = p?.overlay ?? null;
    this.items = fileMenuItems({ rel: this.rel, dir: Boolean(p?.dir), open: Boolean(p?.open), filtering: Boolean(p?.filtering) });
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.listen(cx);
  }

  // D2: `menu-pick:<id>`, the same choice as a click, so what a test can't click it can
  // still run. It never reaches the clipboard: a test window would overwrite the person's.
  listen(cx) {
    cx.spawn(async () => {
      for (;;) {
        const { name, arg } = parseCommand(await herdr.nextCommand());
        if (name !== "menu-pick") continue;
        this.choose(this.items.find((item) => item.id === arg), (text) => { console.log(`code-explorer: menu would copy ${text}`); });
      }
    });
  }

  close() {
    herdr.closeOverlay(this.overlay);
  }

  choose(item, write) {
    if (!item) return;
    if (item.copy) {
      const text = copyText(item.copy, this.root, this.rel);
      write(text);
      herdr.notify({ title: "Copied", body: text, level: "success", timeout: COPIED_FOR });
    } else herdr.run(this.rel ? `${MOD}.${item.id}:${this.rel}` : `${MOD}.${item.id}`);
    this.close();
  }

  key(event, cx) {
    const count = this.items.length;
    if (event.key === "escape") return this.close();
    if (event.key === "down") this.at = (this.at + 1) % count;
    else if (event.key === "up") this.at = (this.at + count - 1) % count;
    else if (event.key === "enter") return this.choose(this.items[this.at], (text) => cx.write_to_clipboard(text));
    else return undefined;
    cx.notify();
    return undefined;
  }

  render() {
    const t = herdr.theme();
    return v_flex().id("file-menu").track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx))
      .w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .when(Boolean(this.rel), (el) => el.child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(this.rel)))
      .children(this.items.map((item, i) => v_flex()
        .when(Boolean(item.separator), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`file-menu-${item.id}`).h(ROW).px(8).rounded(7).items_center().cursor_pointer()
          .text_color(item.danger ? t.blocked : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(item, (text) => cx.write_to_clipboard(text)))
          .child(div().flex_1().min_w(0).truncate().child(item.label)))));
  }
}
