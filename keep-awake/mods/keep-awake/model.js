// Keep computer awake: the mode, whether it wants the Mac awake, and the
// texts (plan D4, D5, D8), Orca's Caffeinate status segment
// (CaffeinateStatusSegment.tsx, agent-awake-copy.ts). Pure: no "herdr"
// import, so main.js and the tests share it.
//
// The mode is the shared key MODE_KEY, persisted by Herdr in shared.json so
// every window's copy sees a change at once (D4). The status shows whether
// the holder really holds a caffeinate (holder.js), not only whether one is
// wanted: an unknown Herdr pid (D2) reads Inactive.

export const MODE_KEY = "keep-awake.mode";
// Orca's default, and what any value that isn't a mode reads as (D4).
export const DEFAULT_MODE = "off";
export const TITLE = "Keep computer awake";

// The popup's rows, in order (S3). "agent" is Orca's `auto`.
export const MODES = Object.freeze([
  Object.freeze({ value: "on", label: "On", description: "Keep this computer awake continuously" }),
  Object.freeze({ value: "agent", label: "Agent", description: "Stay awake while an agent is working" }),
  Object.freeze({ value: "off", label: "Off", description: "Allow normal system sleep behavior" }),
]);

// What macOS still does with the assertion held (Orca's lid note for a Mac):
// `caffeinate -i -s` blocks idle sleep, not the lid (D1).
const LID_NOTE = "Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.";

export function parseMode(value) {
  return MODES.some((m) => m.value === value) ? value : DEFAULT_MODE;
}

export function modeLabel(mode) {
  const value = parseMode(mode);
  return MODES.find((m) => m.value === value).label;
}

// Whether the Mac should be kept awake (D5): mode on, or mode agent with at
// least one agents() entry working. blocked (waiting for input or a
// permission), done and idle let it sleep, as in Orca; no grace period.
export function isActive(mode, agents) {
  const value = parseMode(mode);
  if (value === "on") return true;
  if (value !== "agent" || !Array.isArray(agents)) return false;
  return agents.some((a) => a?.status === "working");
}

// "On · Active", "Agent · Inactive", "Off · Inactive" (S2, D8).
export function statusText(mode, active) {
  return `${modeLabel(mode)} · ${active ? "Active" : "Inactive"}`;
}

export function tooltip(status) {
  return `${TITLE}, ${status}. ${LID_NOTE}`;
}

// caffeinate is macOS only, and herdr-app check runs with no window (D6):
// either one holds nothing. `win` is herdr's window().
export function canKeepAwake(win) {
  return Boolean(win) && win.platform === "macos";
}
