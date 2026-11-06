// The sidebar folds to a rail (44 px, 76 on macOS for the traffic lights) and
// dragging its edge narrows it too. Below 160 px the block has no room for its
// lines and buttons, so main.js draws the compact form. The same width check
// as projects-sidebar's mods (projects-agents/main.js, projects/groups.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRail } from "../mods/agent-sleep/rail.js";

// As layout() shows it: the block sits inside the sidebar with its own px.
const sidebarAt = (size) => ({
  id: "root",
  type: "row",
  children: [
    { id: "sidebar", type: "column", size, children: [{ id: "agent-sleep", type: "block", size: { px: 124 } }] },
    { id: "main", type: "block", size: { weight: 1 } },
  ],
});

test("below 160 px is a rail: both of the rail's widths, and one dragged narrow", () => {
  for (const px of [44, 76, 159]) assert.equal(isRail(sidebarAt({ px })), true, `${px} px`);
});

test("160 px and wider isn't a rail, whatever px the blocks inside it have", () => {
  for (const px of [160, 268]) assert.equal(isRail(sidebarAt({ px })), false, `${px} px`);
});

test("the sidebar is found however deep the layout nests it", () => {
  const nested = { id: "root", children: [{ id: "body", children: [sidebarAt({ px: 44 })] }] };
  assert.equal(isRail(nested), true);
});

test("no sidebar, or none with a width, draws the full block", () => {
  const cases = [
    undefined,
    null,
    "not a layout",
    {},
    { id: "root", children: [{ id: "main", size: { px: 44 } }] },
    { id: "root", children: "not a list" },
    sidebarAt(undefined),
    sidebarAt({ weight: 1 }),
    sidebarAt({ px: "44" }),
  ];
  for (const layout of cases) assert.equal(isRail(layout), false, JSON.stringify(layout));
});

test("projects-sidebar's own layout has the sidebar it looks for, wide as shipped", () => {
  const shipped = JSON.parse(readFileSync(new URL("../../projects-sidebar/layouts/projects.json", import.meta.url), "utf8"));
  assert.equal(isRail(shipped), false);
  shipped.children.find((c) => c.id === "sidebar").size.px = 44;
  assert.equal(isRail(shipped), true);
});
