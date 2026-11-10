// The Agents list's "Sleeping" section: the Claudes agent-sleep stopped and
// will resume when their tab is shown. agent-sleep publishes them under
// ASLEEP_KEY as { icon?, claudes: [{ address, title, since }] }, newest
// first; nothing else goes in the section, so a terminal with no sleeping
// Claude never shows. Pure, so the root suite tests it without Herdr.

export const ASLEEP_KEY = "agent-sleep.asleep";

// What a title starts with that isn't a letter or digit goes (Claude's ✳).
export const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// One row per listed Claude whose terminal is still live, has a pane to open
// and has no agent in front again (agents() lists it then): { address, pane,
// spaceId, space, detail, since, icon }. `detail` is the title Claude had when it went
// to sleep, else its tab's label, never an automatic tab number. `agents`:
// the addresses agents() lists (a Map or a Set); `tabLabels`: tab id → label.
export function sleepingRows({ value, terminals = [], panes = [], spaces = [], agents = new Map(), tabLabels = new Map() } = {}) {
  if (!isObject(value) || !Array.isArray(value.claudes)) return [];
  const icon = typeof value.icon === "string" && value.icon !== "" ? value.icon : null;
  const live = new Set(terminals.filter((t) => isObject(t) && t.state === "live").map((t) => t.address));
  const paneOf = new Map();
  for (const p of panes) if (isObject(p) && typeof p.terminal === "string" && !paneOf.has(p.terminal)) paneOf.set(p.terminal, p);
  const spaceOf = new Map();
  for (const s of spaces) for (const tab of Array.isArray(s?.tabs) ? s.tabs : []) if (typeof tab?.id === "string") spaceOf.set(tab.id, s);
  const rows = [];
  const seen = new Set();
  for (const c of value.claudes) {
    if (!isObject(c) || typeof c.address !== "string" || !Number.isFinite(c.since)) continue;
    if (seen.has(c.address) || !live.has(c.address) || agents.has(c.address)) continue;
    const pane = paneOf.get(c.address);
    if (!pane) continue;
    seen.add(c.address);
    const label = tabLabels.get(pane.tab);
    // A tab number or the terminal's own address ("t54", a shell's title) says nothing.
    const telling = typeof label === "string" && label !== "" && !/^\d+$/.test(label) && label !== c.address;
    const detail = clean(typeof c.title === "string" ? c.title : "") || (telling ? label : null);
    const space = spaceOf.get(pane.tab);
    rows.push({ address: c.address, pane: pane.pane, spaceId: space?.id ?? null, space: space?.name ?? "", detail, since: c.since, icon });
  }
  return rows;
}
