// The projects tree (T3 builds it). Placeholder: the header only.

import { v_flex, h_flex } from "gpui-base";
import { theme, props, notify, shared, setShared } from "herdr";

export default class Tree {
  init(_props, _cx) {}

  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).items_center().text_size(11.5).text_color(t.dim).child("Projects (placeholder)"))
      .child(h_flex().pl(16).text_size(11.5).text_color(t.muted).child(ping()));
  }
}

// The last ping, shown under the header until the tree replaces this file.
function ping() {
  const p = shared("projects.ping");
  return p ? `ping: ${p.body}` : "";
}

export const commands = {
  // Says which copy ran it: proves a mod command reaches the one loop.
  ping: ({ copy }) => {
    const body = `view ${props()?.view ?? "tree"}, copy ${copy}`;
    setShared("projects.ping", { body, at: Date.now() });
    notify({ title: "projects: ping", body, level: "info", timeout: 4000 });
  },
};
