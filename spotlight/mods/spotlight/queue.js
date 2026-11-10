// The test queue (D12): Orca Pro Max's turn queue
// (O/src/main/spotlight/spotlight-agent-turn-queue.ts and -pump.ts) as pure
// functions over state.json's `queue` (D7). No fs, no clock, no herdr or
// gpui-kit imports, so the CLI and the mod share it and `node --test` loads
// it: the CLI calls it under the state lock, passing the time and the
// settings, and writes back the queue it returns. The input is never changed.
//
// A request is one agent terminal asking for its task's test turn:
//   { terminal, taskKey, lane, members: [{ root, … }], state, requestedAt,
//     grantedAt, pausedAt, pauseReason, pauseMsg, …the CLI's own fields }
// `members` holds one entry per repo (T4): the queue claims repos by `root`
// and copies every other field through. `lane` is the space (a projects.v1
// group, or "spaceless"); null means no lane limit. The queue owns `state`
// (waiting | holding | paused), `requestedAt` (in line since: kept when the
// terminal asks again, reset when a paused holder goes to the front),
// `grantedAt` and the pause fields; every other field of an ask (requestTurn,
// fgPid, resumingUntil, …) is copied onto the request as given.
//
// The rules, Orca's:
// - A task gets all its repos or waits for them, so two tasks never hold half
//   of each other's.
// - First come first served per repo: a later request never overtakes an
//   earlier one wanting the same repo, but requests with no repo in common
//   never wait for each other.
// - On top of that, at most `perSpace[lane]` tasks (1 when unset) hold a turn
//   per lane, and at most `cap` tasks hold one at all. Both are read on every
//   call: lowering one never evicts a holder, raising it grants on the next
//   call (`regrant`).
// - Every terminal of a task shares its turn, past lane and cap; the turn
//   ends with its last terminal and its repos never shrink while it lives.
// - A task with no member still takes a slot (slot-only).
// - A paused terminal keeps its place in line but claims nothing until it
//   asks again; a paused holder goes to the front of the line.
// New (S9), queue off (`enabled: false`): `request` queues nothing and
// answers { kind: "off" } (the CLI lights at once) after dropping the
// caller's own place; nobody is granted while off, so the queue only shrinks
// until the switch is back on and a `regrant` lets the line move again.
//
// The line is the order of the requests that don't hold, in the array. A
// turn is the holding requests of one task: its repos are the union of their
// members, its lane the first holder's, its grantedAt shared by all of them.
//
// Every call takes `ctx` = { now, cap?, perSpace?, enabled? } (now in ms;
// no cap = no limit) and returns { queue, …outcome }; `granted` lists the
// turns a call created or extended, for the CLI to hand to `light` (D12).

const DEFAULT_PER_SPACE = 1;
// Why these words: agents read them to know why they wait (Orca's CLI).
const BLOCKER_LABELS = { lane: " (same space)", cap: " (limit reached)" };

const isHolding = (r) => r.state === "holding";
const isPaused = (r) => r.state === "paused";
const isWaiting = (r) => !isHolding(r) && !isPaused(r);
const laneOf = (r) => r.lane ?? null;
const rootsOf = (r) => r.members.map((m) => m.root);
const capOf = (ctx) => ctx.cap ?? Infinity;
const limitOf = (ctx, lane) => ctx.perSpace?.[lane] ?? DEFAULT_PER_SPACE;
const NO_PAUSE = { pausedAt: null, pauseReason: null, pauseMsg: null };

// Working copies: the members arrays are the only thing a call mutates.
function copyRequests(queue) {
  return (queue?.requests ?? []).map((r) => ({ ...r, members: (r.members ?? []).map((m) => ({ ...m })) }));
}

const withRequests = (queue, requests) => ({ ...(queue ?? {}), requests });

function uniqueByRoot(members) {
  const seen = new Set();
  return members.filter((m) => !seen.has(m.root) && seen.add(m.root)).map((m) => ({ ...m }));
}

// taskKey → { taskKey, lane, grantedAt, index, holders }, in grant order.
function turnsOf(requests) {
  const turns = new Map();
  requests.forEach((r, index) => {
    if (!isHolding(r)) return;
    const turn = turns.get(r.taskKey);
    if (turn) turn.holders.push(r);
    else turns.set(r.taskKey, { taskKey: r.taskKey, lane: laneOf(r), grantedAt: r.grantedAt, index, holders: [r] });
  });
  const ordered = [...turns.values()].sort((a, b) => a.grantedAt - b.grantedAt || a.index - b.index);
  return new Map(ordered.map((turn) => [turn.taskKey, turn]));
}

// A turn's members, one per repo: the first holder that carries it wins.
function turnMembers(turn) {
  const byRoot = new Map();
  for (const r of turn.holders) for (const m of r.members) if (!byRoot.has(m.root)) byRoot.set(m.root, m);
  return [...byRoot.values()];
}

function holderOf(turns, root) {
  for (const turn of turns.values()) {
    if (turn.holders.some((r) => r.members.some((m) => m.root === root))) return turn.taskKey;
  }
  return null;
}

function laneHasRoom(turns, lane, ctx) {
  if (lane === null) return true;
  const holding = [...turns.values()].filter((turn) => turn.lane === lane).length;
  return holding < limitOf(ctx, lane);
}

function snapshotTurn(turn) {
  const members = turnMembers(turn).map((m) => ({ ...m }));
  return {
    taskKey: turn.taskKey,
    lane: turn.lane,
    grantedAt: turn.grantedAt,
    terminals: turn.holders.map((r) => r.terminal),
    repos: members.map((m) => m.root),
    members,
    slotOnly: members.length === 0,
  };
}

function grantedTurns(requests, taskKeys) {
  const turns = turnsOf(requests);
  return [...new Set(taskKeys)].flatMap((taskKey) => (turns.has(taskKey) ? [snapshotTurn(turns.get(taskKey))] : []));
}

// Takes `r` out of its turn. Why the hand-over: a turn's repos never shrink
// while it lives (Orca keeps them on the turn), so what only `r` carried goes
// to the task's next holder.
function leaveTurn(requests, r) {
  const rest = requests.filter((o) => o !== r && isHolding(o) && o.taskKey === r.taskKey);
  if (rest.length === 0) return;
  const kept = new Set(rest.flatMap(rootsOf));
  rest[0].members.push(...r.members.filter((m) => !kept.has(m.root)));
}

// Repos another task holds or waits for; paused requests claim nothing.
function claimedRoots(requests, taskKey) {
  const claimed = new Set();
  for (const r of requests) {
    if (r.taskKey !== taskKey && !isPaused(r)) rootsOf(r).forEach((root) => claimed.add(root));
  }
  return claimed;
}

/**
 * Grants, in line order, every waiter whose repos are free and unclaimed by an
 * earlier waiter, whose lane has room and for whom a slot is left under the
 * cap. A terminal of a task that already holds a turn joins it past lane and
 * cap. Nobody is granted with the queue off. Returns the granted task keys.
 */
function pump(requests, ctx) {
  if (ctx.enabled === false) return [];
  const turns = turnsOf(requests);
  const cap = capOf(ctx);
  // Repos an earlier waiter is still waiting for: nobody behind it may take them.
  const claimed = new Set();
  const granted = [];
  for (const r of requests) {
    if (!isWaiting(r)) continue;
    const own = turns.get(r.taskKey);
    const roots = rootsOf(r);
    const reposFree = roots.every((root) => !claimed.has(root) && (holderOf(turns, root) ?? r.taskKey) === r.taskKey);
    const slotFree = own !== undefined || (laneHasRoom(turns, laneOf(r), ctx) && turns.size < cap);
    if (!reposFree || !slotFree) {
      // Why claim even when only the lane or the cap blocks: nobody behind may overtake it.
      roots.forEach((root) => claimed.add(root));
      continue;
    }
    const grantedAt = own ? own.grantedAt : ctx.now;
    Object.assign(r, { state: "holding", grantedAt }, NO_PAUSE);
    if (own) own.holders.push(r);
    else turns.set(r.taskKey, { taskKey: r.taskKey, lane: laneOf(r), grantedAt, index: -1, holders: [r] });
    granted.push(r.taskKey);
  }
  return granted;
}

/**
 * The place of `requests[index]`: 1 + the earlier waiters of other tasks that
 * want what it waits for (a repo, its lane, or a slot while every slot is
 * taken), plus who blocks it and why. Paused requests block nobody.
 * New (S9): a lane holds `perSpace[lane]` tasks, so its holders and earlier
 * waiters block for the lane only when, together, they fill it (with 1, any
 * of them does, as in Orca).
 */
function waitingPlace(requests, turns, index, ctx) {
  const me = requests[index];
  const lane = laneOf(me);
  const wanted = new Set(rootsOf(me));
  // Why: a terminal of a task holding a turn joins it past lane and cap.
  const slotted = turns.has(me.taskKey);
  const capFull = !slotted && turns.size >= capOf(ctx);
  const earlier = requests.slice(0, index).filter(isWaiting);
  let laneFull = false;
  if (!slotted && lane !== null) {
    const contenders = new Set();
    for (const turn of turns.values()) if (turn.lane === lane) contenders.add(turn.taskKey);
    for (const r of earlier) if (laneOf(r) === lane && r.taskKey !== me.taskKey) contenders.add(r.taskKey);
    laneFull = contenders.size >= limitOf(ctx, lane);
  }
  const blockerOf = (other, holding) => {
    // Why skip the own task: its terminals are granted together, never one ahead of another.
    if (other.taskKey === me.taskKey) return null;
    const contested = other.roots.filter((root) => wanted.has(root));
    if (contested.length > 0) return { taskKey: other.taskKey, repos: contested, holding };
    const sameLane = laneFull && other.lane === lane;
    if (!sameLane && !capFull) return null;
    return { taskKey: other.taskKey, repos: [...other.roots], holding, reason: sameLane ? "lane" : "cap" };
  };
  const blockers = [...turns.values()].flatMap(
    (turn) => blockerOf({ taskKey: turn.taskKey, lane: turn.lane, roots: turnMembers(turn).map((m) => m.root) }, true) ?? [],
  );
  let ahead = 0;
  for (const r of earlier) {
    const blocker = blockerOf({ taskKey: r.taskKey, lane: laneOf(r), roots: rootsOf(r) }, false);
    if (blocker) {
      ahead += 1;
      blockers.push(blocker);
    }
  }
  return { position: ahead + 1, blockers };
}

function placeOf(requests, terminal, ctx) {
  const index = requests.findIndex((r) => r.terminal === terminal);
  if (index === -1) return null;
  const r = requests[index];
  const turns = turnsOf(requests);
  if (isHolding(r)) return { kind: "holding", turn: snapshotTurn(turns.get(r.taskKey)) };
  const { position, blockers } = waitingPlace(requests, turns, index, ctx);
  return isPaused(r)
    ? { kind: "waiting", position, blockers, paused: { reason: r.pauseReason, pausedAt: r.pausedAt } }
    : { kind: "waiting", position, blockers };
}

// Joins the task's turn: repos another task holds or waits for are skipped,
// free ones are added to the turn. Returns whether any was added, and the
// skipped members (the CLI's "Not included").
function join(requests, turn, mine, ask, members, ctx) {
  // Why every waiter counts: anyone already in line asked before this terminal did.
  const unavailable = claimedRoots(requests.filter((r) => r !== mine), turn.taskKey);
  const inTurn = new Set(turn.holders.flatMap(rootsOf));
  const extra = members.filter((m) => !inTurn.has(m.root));
  const skipped = extra.filter((m) => unavailable.has(m.root));
  const kept = members.filter((m) => !skipped.includes(m));
  // Why keep what it held: asking again never shrinks the turn.
  const held = mine && isHolding(mine) ? mine.members.filter((m) => !kept.some((k) => k.root === m.root)) : [];
  const record = mine ?? {};
  if (!mine) requests.push(record);
  Object.assign(record, ask, {
    taskKey: ask.taskKey,
    lane: laneOf(ask),
    members: [...kept, ...held],
    state: "holding",
    requestedAt: mine?.requestedAt ?? ctx.now,
    grantedAt: turn.grantedAt,
  }, NO_PAUSE);
  return { added: extra.length > skipped.length, skipped };
}

/**
 * A terminal asks for its task's turn (`spotlight on`). Asking again keeps
 * its place in line and ends a pause; asking for another task gives up the
 * turn it held. → { queue, position, granted, skipped }, position
 * { kind: "holding", turn } | { kind: "waiting", position, blockers, paused? }
 * | { kind: "off" }.
 */
export function request(queue, ask, ctx) {
  const requests = copyRequests(queue);
  let mine = requests.find((r) => r.terminal === ask.terminal) ?? null;
  if (ctx.enabled === false) {
    // Why drop it: with the queue off the caller lights at once, so its old place means nothing.
    if (mine) {
      if (isHolding(mine)) leaveTurn(requests, mine);
      requests.splice(requests.indexOf(mine), 1);
    }
    return { queue: withRequests(queue, requests), position: { kind: "off" }, granted: [], skipped: [] };
  }
  const members = uniqueByRoot(ask.members ?? []);
  // Why: a terminal works for one task; asking for another gives up the turn it held for the old one.
  if (mine && isHolding(mine) && mine.taskKey !== ask.taskKey) {
    leaveTurn(requests, mine);
    requests.splice(requests.indexOf(mine), 1);
    mine = null;
  }
  const own = turnsOf(requests).get(ask.taskKey);
  let skipped = [];
  let added = false;
  if (own) {
    ({ added, skipped } = join(requests, own, mine, ask, members, ctx));
  } else if (mine) {
    // Why in place: asking again keeps the place in line, and ends a pause.
    Object.assign(mine, ask, {
      taskKey: ask.taskKey, lane: laneOf(ask), members, state: "waiting", requestedAt: mine.requestedAt, grantedAt: null,
    }, NO_PAUSE);
  } else {
    requests.push({
      ...ask, taskKey: ask.taskKey, lane: laneOf(ask), members, state: "waiting", requestedAt: ctx.now, grantedAt: null, ...NO_PAUSE,
    });
  }
  const freed = pump(requests, ctx);
  return {
    queue: withRequests(queue, requests),
    position: placeOf(requests, ask.terminal, ctx),
    granted: grantedTurns(requests, added ? [ask.taskKey, ...freed] : freed),
    skipped,
  };
}

/**
 * Gives the terminal's turn back, or its place in line (paused or not)
 * (`spotlight off`, a turn end, a gone terminal). → { queue,
 * releasedTaskKey, wasWaiting, granted }.
 */
export function release(queue, terminal, ctx) {
  const requests = copyRequests(queue);
  const mine = requests.find((r) => r.terminal === terminal);
  const wasHolding = mine !== undefined && isHolding(mine);
  if (mine) {
    if (wasHolding) leaveTurn(requests, mine);
    requests.splice(requests.indexOf(mine), 1);
  }
  const freed = pump(requests, ctx);
  return {
    queue: withRequests(queue, requests),
    releasedTaskKey: wasHolding ? mine.taskKey : null,
    wasWaiting: mine !== undefined && !wasHolding,
    granted: grantedTurns(requests, freed),
  };
}

/**
 * The terminal's agent stopped mid-turn (D13): takes it out of its turn but
 * keeps its place, a holder at the front of the line (with the whole turn's
 * members, so it asks for all of it back) and a waiter where it stands; a
 * paused one gets the new reason and time. Its next `request` ends the pause.
 * `info` = { reason: "limit" | "signin" | "error", msg? }. → { queue,
 * pausedTaskKey, wasHolding, granted }.
 */
export function pause(queue, terminal, info, ctx) {
  const requests = copyRequests(queue);
  const mine = requests.find((r) => r.terminal === terminal);
  if (!mine) return { queue: withRequests(queue, requests), pausedTaskKey: null, wasHolding: false, granted: [] };
  const paused = { state: "paused", pausedAt: ctx.now, pauseReason: info.reason, pauseMsg: info.msg ?? null };
  const wasHolding = isHolding(mine);
  if (wasHolding) {
    const members = turnMembers(turnsOf(requests).get(mine.taskKey)).map((m) => ({ ...m }));
    leaveTurn(requests, mine);
    requests.splice(requests.indexOf(mine), 1);
    // Why the front: it lost its turn mid-run, so it goes first once it asks again.
    requests.unshift(Object.assign(mine, paused, { members, requestedAt: ctx.now, grantedAt: null }));
  } else {
    // Why a paused request too: a resumed agent that fails again is paused anew, in the same place.
    Object.assign(mine, paused);
  }
  const freed = pump(requests, ctx);
  return {
    queue: withRequests(queue, requests),
    pausedTaskKey: mine.taskKey,
    wasHolding,
    granted: grantedTurns(requests, freed),
  };
}

/** A setting changed with nothing else moving (D12): grants whoever the new limits let through. */
export function regrant(queue, ctx) {
  const requests = copyRequests(queue);
  const freed = pump(requests, ctx);
  return { queue: withRequests(queue, requests), granted: grantedTurns(requests, freed) };
}

/** Where the terminal stands, null when it has no place; a paused one reports its place with `paused`. */
export function positionOf(queue, terminal, ctx = {}) {
  return placeOf(copyRequests(queue), terminal, ctx);
}

/** The turns in grant order, and the waiting and paused requests in line order. */
export function snapshot(queue) {
  const requests = copyRequests(queue);
  return {
    turns: [...turnsOf(requests).values()].map(snapshotTurn),
    waiting: requests.filter(isWaiting),
    paused: requests.filter(isPaused),
  };
}

// "/code/nimbus-back/" → "nimbus-back".
const folderName = (root) => root.split("/").filter(Boolean).pop() ?? root;

/**
 * One blocker as the CLI prints it after "Waiting for a test turn for …:"
 * (Orca's describeBlocker): "AX-1 is testing back (same space)", "AX-2 is
 * ahead of you for back, admin (limit reached)". Repos are named by
 * `nameOf(root)`, the root's folder by default.
 */
export function describeBlocker(blocker, nameOf = folderName) {
  const repos = blocker.repos.map((root) => nameOf(root)).join(", ");
  const label = blocker.reason ? BLOCKER_LABELS[blocker.reason] : "";
  if (blocker.holding) return `${blocker.taskKey} is testing${repos ? ` ${repos}` : ""}${label}`;
  return `${blocker.taskKey} is ahead of you${repos ? ` for ${repos}` : ""}${label}`;
}
