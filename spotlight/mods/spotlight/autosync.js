// Auto-sync (D9): while a workspace holds a repo's Spotlight, every change in
// it reaches the repo's root without anyone asking (Orca's
// useSpotlightAutoSync). One watch per holder folder (watchFolder); a batch
// of nothing but Git internals, build or test output, or paths outside the
// holder, is dropped (watch-filter.js shouldSync); the rest is debounced
// 300 ms per repo, then `spotlight sync --repo <root> --detach` runs and
// returns at once (D18). The engine skips a sync whose tree didn't change.
// A sync the root refuses (diverged, an operation in progress) lands in
// state.json as the repo's error, once per new error (cli-work syncRepo).
//
// Only the footer copy runs it (main.js startAutosync). Which folders to
// watch comes from state.json's holders: badges.js's state watch hands each
// reading to followHolders, so the footer copy keeps one extra watch on the
// state folder, not two. A holder's watch ends at its first batch after it
// stopped holding.

import { appHome, watchFolder, exec } from "herdr";
import { cliPathOf } from "./board-model.js";
import { shouldSync, watchTargets, syncArgv, debouncer, SYNC_DEBOUNCE_MS } from "./watch-filter.js";

// The footer copy's init context (an AsyncContext, valid across awaits),
// which owns the holder watches; null in every other copy.
let owner = null;
// holder → root: what state.json says now; holder → { root, gen }: what is
// watched, and by which footer copy.
let holders = new Map();
const watching = new Map();
let generation = 0;

// A new footer copy forgets the earlier copy's watches: a task dropped with
// its view may never reach its finally, and a stale entry would keep the
// holder from being watched again. The earlier copy's loops stop when they
// next wake (their generation is gone).
export function startAutosync(cx) {
  owner = cx;
  generation += 1;
  watching.clear();
  holders = new Map();
}

// The holders of a fresh state.json reading (board-model.js readState):
// starts a watch for each new one.
export function followHolders(state) {
  if (!owner) return;
  holders = new Map(watchTargets(state).map((t) => [t.holder, t.root]));
  for (const [holder, root] of holders) {
    if (watching.get(holder)?.root === root) continue;
    const entry = { root, gen: generation };
    watching.set(holder, entry);
    watchHolder(owner, holder, root, entry);
  }
}

function watchHolder(cx, holder, root, entry) {
  cx.spawn(async (cx) => {
    const bounce = debouncer((ms, fn) => cx.timer.after(ms, fn), SYNC_DEBOUNCE_MS);
    try {
      for (;;) {
        const paths = await watchFolder(holder);
        if (entry.gen !== generation || holders.get(holder) !== root) break;
        if (shouldSync(paths, holder)) bounce(root, (cx) => runSync(cx, root));
      }
    } catch (e) {
      // The folder is gone, or this build was reloaded: the next reading starts it again.
      console.log(`spotlight autosync: stopped watching ${holder}: ${e}`);
    } finally {
      if (watching.get(holder) === entry) watching.delete(holder);
    }
  });
}

function runSync(cx, root) {
  const bin = cliPathOf(appHome());
  const [program, ...args] = syncArgv(bin, root);
  cx.spawn(async () => {
    try {
      const r = await exec(program, args, { cwd: root });
      if (r.code !== 0) console.log(`spotlight autosync: ${root}: ${r.stderr.trim() || `exit ${r.code}`}`);
    } catch (e) {
      console.log(`spotlight autosync: ${root}: ${e}`);
    }
  });
}
