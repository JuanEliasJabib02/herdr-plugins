// The footer: the active account's usage in the sidebar's status row (S1,
// Image #1): `Used [icon][bar] 41% 3h 2m · 65% 4d 6h · 22% Fable [refresh]`,
// D5's colors and D10's density levels. Its copy is the one that always
// lives, so it also keeps the 15-min timer and the watch on the state folder,
// and applies toasts.react on each re-read (D1). Owner: T6. T1 draws a
// placeholder.
//   props: { view: "footer" }, or none

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, exec, appHome } from "herdr";
import { cliPath } from "./store.js";

// Fresh usage now (`usage --refresh`): the `refresh` command, and the
// refresh buttons of the footer, the popup and the panel. The CLI rewrites
// accounts.v1.json, and the footer's watch picks it up.
export async function refreshUsage() {
  const r = await exec(cliPath(appHome()), ["usage", "--refresh", "--json"]);
  if (r.code !== 0) console.log(`claude-accounts: usage --refresh exited ${r.code}: ${r.stderr.trim()}`);
  return r;
}

export default class Footer {
  init(_p, _cx) {}

  render() {
    const t = theme();
    return h_flex()
      .id("ca-footer")
      .size_full()
      .min_w(0)
      .px(8)
      .gap(6)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().text_color(t.dim).child("Used"))
      .child(div().text_color(t.muted).truncate().child("Claude usage (placeholder)"));
  }
}
