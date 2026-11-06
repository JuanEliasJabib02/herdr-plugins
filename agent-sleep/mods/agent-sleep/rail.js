// Whether the sidebar is folded to its rail: by the layout's width, not a flag,
// since dragging its edge narrows it too. The same check and the same 160 px as
// projects-sidebar's mods (projects-agents/main.js, projects/groups.js). Pure:
// main.js passes it layout(). No sidebar, or none with a px, isn't a rail.

const RAIL_PX = 160;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of Array.isArray(node?.children) ? node.children : []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export function isRail(layout) {
  const px = find(layout, "sidebar")?.size?.px;
  return typeof px === "number" && px < RAIL_PX;
}
