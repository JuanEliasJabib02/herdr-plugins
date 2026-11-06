// The reaper loop (D13, D19): runs `spotlight reap` when the terminals that
// matter change (1 s trailing debounce) and every 30 s, so a finished,
// paused or closed agent never blocks the line and a closed server terminal
// turns red. The reap itself is the CLI's: turn ends, gone servers, idle
// times, grants (it returns in under a second, D18).
// Only the footer copy calls startReaper (main.js). It looks at terminals()
// twice a second, but only the agents in line and the server terminals count
// (board-model.js reapFingerprint): the footer copy hands them over from
// each state.json read (setReapTargets). The timing is board-model.js's
// reapTick, tested there.

import { exec, appHome, terminals } from "herdr";
import { cliPathOf, reapClock, reapTick, reapDone, reapFingerprint } from "./board-model.js";

// How often terminals() is looked at; the debounce is measured in these steps.
const LOOK_MS = 500;

// The agents in line and the server terminals, from the last state.json read.
let targets = [];

export function setReapTargets(ids) {
  targets = Array.isArray(ids) ? ids : [];
}

// The last failure logged, so a missing CLI logs once, not every 30 s.
let lastFailure = null;

function logFailure(text) {
  if (text === lastFailure) return;
  lastFailure = text;
  console.log(`spotlight: reap: ${text}`);
}

export function startReaper(cx) {
  let clock = reapClock();
  cx.timer.every(LOOK_MS, (cx) => {
    const r = reapTick(clock, { now: Date.now(), print: reapFingerprint(terminals(), targets) });
    clock = r.clock;
    if (!r.reap) return;
    cx.spawn(async () => {
      try {
        const out = await exec(cliPathOf(appHome()), ["reap"]);
        if (out.code === 0) lastFailure = null;
        else logFailure(`exited ${out.code}: ${out.stderr.trim()}`);
      } catch (e) {
        logFailure(String(e));
      } finally {
        clock = reapDone(clock);
      }
    });
  });
}
