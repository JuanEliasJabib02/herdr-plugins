// badges.spotlight (D2, D17) and the badge commands it hands out
// ("spotlight.server.<id>" opens a repo's server popup). Stub from T0;
// T10 fills it. Only the footer copy calls these (main.js).
export function startBadges(cx) {}

/** Runs a command meant for Spotlight; false when the name isn't one. */
export async function handleCommand(name, { cx }) {
  return false;
}
