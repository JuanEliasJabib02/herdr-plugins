import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE_KEY, ASLEEP_KEY, iconPath, parseWorktreeList, workspaceOf, badgeValue, asleepValue, sameValue } from "../mods/agent-sleep/badges.js";

const at = (h, m) => new Date(2026, 10, 6, h, m).getTime();
const rec = (over = {}) => ({
  state: "asleep", sessionId: "00000000-0000-4000-8000-000000000001", cwd: "/r/ws", flags: [],
  workspacePath: "/r/ws", rssKb: 1, rootPid: 1, holder: null, at: at(14, 2), by: "auto", ...over,
});

const PORCELAIN = [
  "worktree /Users/alex/code/herdr-plugins",
  "HEAD 15ddd03",
  "branch refs/heads/main",
  "",
  "worktree /Users/alex/orca/workspaces/herdr-plugins/wahoo",
  "HEAD 944008f",
  "branch refs/heads/work-dev/agent-sleep",
  "",
  "worktree /Users/alex/orca/workspaces/herdr-plugins/wahoo-2",
  "HEAD 1111111",
  "detached",
  "",
].join("\n");

test("the key is projects-sidebar's reserved badges.hibernate", () => {
  assert.equal(BADGE_KEY, "badges.hibernate");
});

test("the icon path is built from the mod's own folder name", () => {
  assert.equal(iconPath("agent-sleep"), "mods/agent-sleep/icons/moon.svg");
  assert.equal(iconPath("agent-sleep-2"), "mods/agent-sleep-2/icons/moon.svg");
  assert.equal(iconPath(""), null);
  assert.equal(iconPath("../x"), null);
  assert.equal(iconPath("a/b"), null);
});

test("the moon icon ships with the mod and is a tintable svg", () => {
  const svg = readFileSync(new URL("../mods/agent-sleep/icons/moon.svg", import.meta.url), "utf8");
  assert.match(svg, /^<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(svg, /currentColor/);
});

test("git worktree list --porcelain → the worktree folders", () => {
  assert.deepEqual(parseWorktreeList(PORCELAIN), [
    "/Users/alex/code/herdr-plugins",
    "/Users/alex/orca/workspaces/herdr-plugins/wahoo",
    "/Users/alex/orca/workspaces/herdr-plugins/wahoo-2",
  ]);
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(null), []);
});

test("a terminal in a subfolder maps to its worktree as git prints it", () => {
  const trees = parseWorktreeList(PORCELAIN);
  assert.equal(workspaceOf("/Users/alex/orca/workspaces/herdr-plugins/wahoo/agent-sleep/test", trees),
    "/Users/alex/orca/workspaces/herdr-plugins/wahoo");
  assert.equal(workspaceOf("/Users/alex/orca/workspaces/herdr-plugins/wahoo/", trees),
    "/Users/alex/orca/workspaces/herdr-plugins/wahoo");
  // a sibling whose name starts the same is not a subfolder
  assert.equal(workspaceOf("/Users/alex/orca/workspaces/herdr-plugins/wahoo-2/x", trees),
    "/Users/alex/orca/workspaces/herdr-plugins/wahoo-2");
  // outside every worktree: no workspace
  assert.equal(workspaceOf("/tmp/elsewhere", trees), null);
});

test("one bare moon per workspace with a sleeping Claude, time in the tooltip", () => {
  const value = badgeValue({ records: { t1: rec() }, modFolder: "agent-sleep" });
  assert.deepEqual(value, {
    "/r/ws": [{
      icon: "mods/agent-sleep/icons/moon.svg",
      tone: "dim",
      tooltip: "Claude asleep since 14:02 · wakes when you show its tab",
    }],
  });
});

test("two Claudes in one workspace → one badge, the earliest time", () => {
  const value = badgeValue({
    records: { t1: rec({ at: at(15, 40) }), t2: rec({ at: at(9, 5) }) },
    modFolder: "agent-sleep",
  });
  assert.equal(value["/r/ws"].length, 1);
  assert.equal(value["/r/ws"][0].tooltip, "2 Claudes asleep since 09:05 · wake when you show their tabs");
});

test("only asleep records count; stopping and live draw nothing", () => {
  const value = badgeValue({
    records: { t1: rec({ state: "stopping" }), t2: rec({ state: "live", workspacePath: "/r/other" }) },
    modFolder: "agent-sleep",
  });
  assert.deepEqual(value, {});
});

test("a record without a workspace path falls back to its cwd; none → skipped", () => {
  const value = badgeValue({
    records: { t1: rec({ workspacePath: null, cwd: "/r/plain/" }), t2: rec({ workspacePath: null, cwd: "" }) },
    modFolder: "agent-sleep",
  });
  assert.deepEqual(Object.keys(value), ["/r/plain"]);
});

test("keys come out sorted, so the same records give the same value", () => {
  const records = { t2: rec({ workspacePath: "/r/b" }), t1: rec({ workspacePath: "/r/a" }) };
  assert.deepEqual(Object.keys(badgeValue({ records, modFolder: "agent-sleep" })), ["/r/a", "/r/b"]);
});

test("workspace-sleep D3: no moon for a workspace asleep as a whole, by its path or by a terminal in one of its spaces", () => {
  const records = {
    t1: rec({ workspacePath: "/r/slept" }), // in the workspace put to sleep
    t6: rec({ workspacePath: "/r/awake" }), // its terminal is in a slept space (one with panes in two worktrees)
    t2: rec({ workspacePath: "/r/awake", at: at(9, 5) }), // asleep in an awake workspace
  };
  const value = badgeValue({ records, modFolder: "agent-sleep", slept: { paths: ["/r/slept/"], terminals: new Set(["t6"]) } });
  assert.deepEqual(Object.keys(value), ["/r/awake"]);
  assert.equal(value["/r/awake"][0].tooltip, "Claude asleep since 09:05 · wakes when you show its tab");
  const before = badgeValue({ records, modFolder: "agent-sleep" });
  assert.deepEqual(Object.keys(before), ["/r/awake", "/r/slept"]);
  assert.deepEqual(badgeValue({ records, modFolder: "agent-sleep", slept: { paths: [], terminals: [] } }), before, "nothing slept: as before");
  assert.deepEqual(badgeValue({ records, modFolder: "agent-sleep", slept: { paths: "/r/slept", terminals: null } }), before, "a malformed one is nothing");
});

test("no sleeping Claude → {} (clears the badges)", () => {
  assert.deepEqual(badgeValue({ records: {}, modFolder: "agent-sleep" }), {});
});

test("a bad mod folder still publishes, without the icon (text-less badge needs one → text)", () => {
  const value = badgeValue({ records: { t1: rec() }, modFolder: "" });
  assert.deepEqual(value["/r/ws"], [{ text: "asleep", tone: "dim", tooltip: "Claude asleep since 14:02 · wakes when you show its tab" }]);
});

test("sameValue tells an unchanged value from a changed one", () => {
  const a = badgeValue({ records: { t1: rec() }, modFolder: "agent-sleep" });
  const b = badgeValue({ records: { t1: rec() }, modFolder: "agent-sleep" });
  assert.equal(sameValue(a, b), true);
  assert.equal(sameValue(a, {}), false);
  assert.equal(sameValue(undefined, {}), false);
  assert.equal(sameValue({}, {}), true);
});

// ── The Sleeping section's list (projects-agents) ─────────────────────────

test("asleepValue: one entry per asleep Claude, newest first, its slept workspace's ones too; live and stopping ones aren't asleep", () => {
  assert.equal(ASLEEP_KEY, "agent-sleep.asleep");
  const records = {
    t1: rec({ at: at(14, 2), title: "  Lector de md sin mergear " }),
    t2: rec({ at: at(15, 30), cwd: "/r/other", workspacePath: "/r/other" }),
    t3: rec({ state: "live", at: at(16, 0) }),
    t4: rec({ state: "stopping", at: at(16, 1) }),
    t5: rec({ at: at(15, 30), title: "" }),
  };
  assert.deepEqual(asleepValue({ records, modFolder: "agent-sleep" }), {
    icon: "mods/agent-sleep/icons/moon.svg",
    claudes: [
      { address: "t2", title: null, since: at(15, 30) },
      { address: "t5", title: null, since: at(15, 30) },
      { address: "t1", title: "Lector de md sin mergear", since: at(14, 2) },
    ],
  });
});

test("asleepValue: nothing asleep is an empty list; a bad mod folder leaves the icon out", () => {
  assert.deepEqual(asleepValue({ records: {}, modFolder: "agent-sleep" }), { icon: "mods/agent-sleep/icons/moon.svg", claudes: [] });
  assert.deepEqual(asleepValue({ records: { t1: rec({ title: 7 }) }, modFolder: "a/b" }), { claudes: [{ address: "t1", title: null, since: at(14, 2) }] });
  const a = asleepValue({ records: { t1: rec() }, modFolder: "agent-sleep" });
  assert.equal(sameValue(a, asleepValue({ records: { t1: rec() }, modFolder: "agent-sleep" })), true);
});
