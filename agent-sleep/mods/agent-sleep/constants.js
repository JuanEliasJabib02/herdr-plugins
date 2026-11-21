// What the mod and wake-agent's CLI (wake-cli.js) both need, here so the CLI
// doesn't load the coordinator for two constants. coordinator.js re-exports
// them, so the mod's other files import them from there.

// This mod's folder under mods/: asset paths go through it, never a literal
// (Herdr's mod.clone rewrites it in a copy). Its commands are named after it
// too (`herdr-app do agent-sleep.<command>`).
export const MOD = "agent-sleep";

// awake-agent D3: how long a wake by path keeps trying, from the first pulse
// that saw it. wake-agent's CLI waits longer (90 s), so the line it gives up
// with is in log.txt by then.
export const WAKE_DEADLINE_MS = 60_000;
