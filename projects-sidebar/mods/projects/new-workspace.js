// The New workspace dialog (T5 builds it). Placeholder.

import { div } from "gpui-kit";
import { theme, openOverlay } from "herdr";
import { MOD } from "./config.js";

export default class NewWorkspace {
  init(_props, _cx) {}

  render() {
    const t = theme();
    return div().size_full().p(16).bg(t.popover).text_color(t.muted).child("New workspace");
  }
}

// The only place that opens the dialog. projectPath: the project to start
// with, or null for the focused space's project.
export function openNewWorkspace(projectPath) {
  return openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 560, height: 560, props: { view: "new-workspace", project: projectPath ?? null } });
}

export const commands = {
  "new-workspace": () => openNewWorkspace(null),
};
