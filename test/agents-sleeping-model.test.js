// The Agents list's "Sleeping" section (projects-agents/sleeping-model.js):
// the Claudes agent-sleep stopped and will resume, from what it publishes
// under agent-sleep.asleep. Only those whose terminal is still there with a
// pane and no agent in front; a terminal with no sleeping Claude never shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASLEEP_KEY, clean, sleepingRows } from "../projects-sidebar/mods/projects-agents/sleeping-model.js";
import { ASLEEP_KEY as PUBLISHED_KEY } from "../agent-sleep/mods/agent-sleep/badges.js";

const T = 1_794_250_000_000;
const MOON = "mods/agent-sleep/icons/moon.svg";
const shell = (address, state = "live") => ({ address, state, status: null });
const world = () => ({
  terminals: [shell("t4d"), shell("t54"), shell("t9"), shell("t5w")],
  panes: [
    { pane: "p1", terminal: "t4d", tab: "tb1" },
    { pane: "p2", terminal: "t54", tab: "tb2" },
    { pane: "p9", terminal: "t9", tab: "tb9" },
    { pane: "p5", terminal: "t5w", tab: "tb5" },
  ],
  spaces: [
    { id: "s1", name: "lector-md", tabs: [{ id: "tb1" }] },
    { id: "s2", name: "claude-accounts", tabs: [{ id: "tb2" }] },
    { id: "s9", name: "main", tabs: [{ id: "tb9" }] },
    { id: "s5", name: "AX-3704", tabs: [{ id: "tb5" }] },
  ],
  agents: new Map([["t5w", "done"]]),
  tabLabels: new Map([["tb1", "1"], ["tb2", "Carga automática"], ["tb9", "1"], ["tb5", "1"]]),
});
const value = (claudes) => ({ icon: MOON, claudes });

test("the key is the one agent-sleep publishes", () => {
  assert.equal(ASLEEP_KEY, PUBLISHED_KEY);
});

test("one row per sleeping Claude, in agent-sleep's order: its space, its title (or its named tab), since when, its pane", () => {
  const rows = sleepingRows({
    ...world(),
    value: value([
      { address: "t54", title: null, since: T },
      { address: "t4d", title: "✳ Lector de md sin mergear", since: T - 3_600_000 },
    ]),
  });
  assert.deepEqual(rows, [
    { address: "t54", pane: "p2", space: "claude-accounts", detail: "Carga automática", since: T, icon: MOON },
    { address: "t4d", pane: "p1", space: "lector-md", detail: "Lector de md sin mergear", since: T - 3_600_000, icon: MOON },
  ]);
});

test("a terminal with no sleeping Claude never shows: only what agent-sleep lists", () => {
  const rows = sleepingRows({ ...world(), value: value([{ address: "t4d", title: "x", since: T }]) });
  assert.deepEqual(rows.map((r) => r.address), ["t4d"], "t9, a plain shell, isn't there");
});

test("left out: a terminal that is gone or not live, one without a pane, one with an agent in front again, and a repeat", () => {
  const w = world();
  w.terminals = w.terminals.map((t) => (t.address === "t54" ? shell("t54", "exited") : t));
  w.panes = w.panes.filter((p) => p.terminal !== "t9");
  const rows = sleepingRows({
    ...w,
    value: value([
      { address: "t4d", title: "a", since: T },
      { address: "t4d", title: "b", since: T },
      { address: "t54", title: "c", since: T },
      { address: "t9", title: "d", since: T },
      { address: "t5w", title: "e", since: T },
      { address: "t77", title: "f", since: T },
    ]),
  });
  assert.deepEqual(rows.map((r) => [r.address, r.detail]), [["t4d", "a"]]);
});

test("an automatic tab number or the terminal's address says nothing; with no title and no named tab the row is its space alone", () => {
  const rows = sleepingRows({ ...world(), value: value([{ address: "t4d", title: "  ", since: T }]) });
  assert.equal(rows[0].detail, null);
  assert.equal(rows[0].space, "lector-md");
  const w = world();
  w.tabLabels.set("tb2", "t54"); // a shell's title, seen live on 2026-11-09
  assert.equal(sleepingRows({ ...w, value: value([{ address: "t54", title: null, since: T }]) })[0].detail, null);
});

test("nothing published, or a malformed value or entry, is no rows", () => {
  for (const v of [undefined, null, "x", {}, { claudes: "x" }, value([null, { address: 7, since: T }, { address: "t4d", since: "x" }])]) {
    assert.deepEqual(sleepingRows({ ...world(), value: v }), []);
  }
  assert.deepEqual(sleepingRows({ value: value([{ address: "t4d", title: "a", since: T }]) }), [], "no Herdr lists yet");
  assert.equal(sleepingRows({ ...world(), value: { claudes: [{ address: "t4d", title: "a", since: T }] } })[0].icon, null);
});

test("clean drops what a title starts with that isn't a letter or digit (Claude's ✳)", () => {
  assert.equal(clean("✳ Lector de md"), "Lector de md");
  assert.equal(clean(null), "");
});
