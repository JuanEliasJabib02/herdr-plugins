// T3: the test queue (M/queue.js, D12), Orca Pro Max's turn queue as pure
// functions over state.json's `queue.requests`. Modeled on Orca's
// O/src/main/spotlight/spotlight-agent-turn-queue.test.ts (ported one by
// one), plus the per-space limit, queue off (S9), the tester cases 01–05 and
// 07–11 (~/Desktop/test-queue/specs) at the queue level, and the guarantees
// the CLI leans on: no input mutated, JSON-clean records, and the grant
// rules holding over any interleaving of calls.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  request, release, pause, regrant, positionOf, snapshot, describeBlocker,
} from "../mods/spotlight/queue.js";

// One repo of a task, as T4 gives it: the repo root and the worktree lit there.
const member = (root) => ({ root, workspace: `${root}--${root.length}` });

// A queue driven like Orca's tests: every call is one tick of the clock, and
// `limits` ({ cap, perSpace, enabled }) is read on every call, so a test
// changes the settings between calls as the settings dialog would.
function makeQueue(limits = {}) {
  let q = { requests: [], lighting: {} };
  let clock = 0;
  const ctx = () => ({ now: ++clock, ...limits });
  const run = (out) => {
    q = out.queue;
    return out;
  };
  return {
    limits,
    get q() {
      return q;
    },
    request: (terminal, taskKey, roots, lane = null, extra = {}) =>
      run(request(q, { terminal, taskKey, lane, members: roots.map(member), ...extra }, ctx())),
    release: (terminal) => run(release(q, terminal, ctx())),
    pause: (terminal, reason, msg) => run(pause(q, terminal, { reason, msg }, ctx())),
    regrant: () => run(regrant(q, ctx())),
    positionOf: (terminal) => positionOf(q, terminal, { ...limits }),
    snapshot: () => snapshot(q),
  };
}

const cappedQueue = (cap = 2, perSpace = {}) => makeQueue({ cap, perSpace });
const keys = (out) => out.granted.map((turn) => turn.taskKey);
const turns = (Q) => Q.snapshot().turns.map((turn) => [turn.taskKey, turn.repos, turn.terminals]);
const line = (Q) => Q.snapshot().waiting.map((r) => r.terminal);
const kind = (Q, terminal) => Q.positionOf(terminal)?.kind ?? null;

describe("queue: Orca's SpotlightTurnQueue", () => {
  test("grants tasks with no project in common at the same time", () => {
    const Q = makeQueue();
    const a = Q.request("pa", "AX-1", ["back", "admin"]);
    const b = Q.request("pb", "AX-2", ["landing"]);
    assert.equal(a.position.kind, "holding");
    assert.equal(b.position.kind, "holding");
    assert.deepEqual(keys(b), ["AX-2"]);
  });

  test("makes an overlapping task wait, then grants it when the holder releases", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back", "admin"]);
    const b = Q.request("pb", "AX-2", ["back"]);
    assert.deepEqual(b.position, {
      kind: "waiting",
      position: 1,
      blockers: [{ taskKey: "AX-1", repos: ["back"], holding: true }],
    });
    assert.deepEqual(b.granted, []);

    const released = Q.release("pa");
    assert.equal(released.releasedTaskKey, "AX-1");
    assert.deepEqual(keys(released), ["AX-2"]);
    assert.equal(kind(Q, "pb"), "holding");
  });

  test("never grants half of what a task needs", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["admin"]);
    Q.request("pb", "AX-2", ["back", "admin"]);
    assert.deepEqual(turns(Q), [["AX-1", ["admin"], ["pa"]]]);
    assert.equal(Q.snapshot().turns[0].grantedAt, 1);
  });

  test("never lets a later request overtake an earlier one for the same project", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["admin"]);
    Q.request("pb", "AX-2", ["back", "admin"]);
    // back is free, but AX-2 asked for it first.
    const c = Q.request("pc", "AX-3", ["back"]);
    assert.deepEqual(c.position, {
      kind: "waiting",
      position: 2,
      blockers: [{ taskKey: "AX-2", repos: ["back"], holding: false }],
    });

    assert.deepEqual(keys(Q.release("pa")), ["AX-2"]);
    assert.equal(kind(Q, "pc"), "waiting");
  });

  test("lets a request with no overlap pass a blocked one", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"]);
    Q.request("pb", "AX-2", ["back"]);
    assert.equal(Q.request("pc", "AX-3", ["landing"]).position.kind, "holding");
  });

  test("shares a turn between terminals of the same task and ends it with the last one", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back", "admin"]);
    const second = Q.request("pa2", "AX-1", ["admin"]);
    Q.request("pb", "AX-2", ["back"]);

    assert.equal(second.position.kind, "holding");
    assert.deepEqual(second.granted, []);
    // Why nothing yet: the turn keeps back while pa2 still holds it.
    assert.deepEqual(Q.release("pa").granted, []);
    assert.deepEqual(turns(Q), [["AX-1", ["admin", "back"], ["pa2"]]]);
    assert.deepEqual(keys(Q.release("pa2")), ["AX-2"]);
  });

  test("adds free projects to a joined turn and skips ones another task holds", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"]);
    Q.request("pb", "AX-2", ["landing"]);
    const joined = Q.request("pa2", "AX-1", ["back", "admin", "landing"]);

    assert.deepEqual(joined.skipped, [member("landing")]);
    assert.deepEqual(joined.granted.map((turn) => turn.repos), [["back", "admin"]]);
    // The joining request keeps only what it holds; the skipped one is the CLI's "Not included".
    const pa2 = Q.q.requests.find((r) => r.terminal === "pa2");
    assert.deepEqual(pa2.members.map((m) => m.root), ["back", "admin"]);
  });

  test("keeps the place in line when a waiting terminal asks again", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"]);
    Q.request("pb", "AX-2", ["back"]);
    Q.request("pc", "AX-3", ["back"]);
    const again = Q.request("pb", "AX-2", ["back"]);

    assert.equal(again.position.kind, "waiting");
    assert.equal(again.position.position, 1);
    assert.deepEqual(line(Q), ["pb", "pc"]);
  });

  test("drops a waiter that gives up its place without touching the holder", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"]);
    Q.request("pb", "AX-2", ["back"]);

    const out = Q.release("pb");
    assert.deepEqual(
      { releasedTaskKey: out.releasedTaskKey, wasWaiting: out.wasWaiting, granted: out.granted },
      { releasedTaskKey: null, wasWaiting: true, granted: [] },
    );
    assert.deepEqual(Q.q.requests.map((r) => r.terminal), ["pa"]);
  });

  test("gives up the old task when a terminal asks for another one", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"]);
    Q.request("pb", "AX-2", ["back"]);
    const moved = Q.request("pa", "AX-3", ["landing"]);

    assert.equal(moved.position.kind, "holding");
    assert.deepEqual(keys(moved).sort(), ["AX-2", "AX-3"]);
  });
});

describe("queue: lanes and cap (Orca)", () => {
  test("grants one task per lane at the same time while under the cap", () => {
    const Q = cappedQueue(2);
    const ag = Q.request("pa", "AG-1", ["shop"], "acme");
    const ax = Q.request("pb", "AX-1", ["back"], "action");
    assert.equal(ag.position.kind, "holding");
    assert.equal(ax.position.kind, "holding");
    assert.deepEqual(Q.snapshot().turns.map((t) => [t.taskKey, t.lane]), [["AG-1", "acme"], ["AX-1", "action"]]);
  });

  test("makes a task of a busy lane wait even for other projects, in order", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    const second = Q.request("pb", "AG-2", ["admin"], "acme");
    const third = Q.request("pc", "AG-3", ["blog"], "acme");

    assert.deepEqual(second.position, {
      kind: "waiting",
      position: 1,
      blockers: [{ taskKey: "AG-1", repos: ["shop"], holding: true, reason: "lane" }],
    });
    assert.deepEqual(third.position, {
      kind: "waiting",
      position: 2,
      blockers: [
        { taskKey: "AG-1", repos: ["shop"], holding: true, reason: "lane" },
        { taskKey: "AG-2", repos: ["admin"], holding: false, reason: "lane" },
      ],
    });
    assert.deepEqual(keys(Q.release("pa")), ["AG-2"]);
  });

  test("makes a third lane wait while the cap is reached and grants it on a release", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AX-1", ["back"], "action");
    const third = Q.request("pc", "EX-1", ["budget"], "reef");
    const fourth = Q.request("pd", "OPM-1", [], "orca");

    assert.deepEqual(third.position, {
      kind: "waiting",
      position: 1,
      blockers: [
        { taskKey: "AG-1", repos: ["shop"], holding: true, reason: "cap" },
        { taskKey: "AX-1", repos: ["back"], holding: true, reason: "cap" },
      ],
    });
    assert.equal(fourth.position.kind, "waiting");
    assert.equal(fourth.position.position, 2);
    assert.deepEqual(keys(Q.release("pb")), ["EX-1"]);
    assert.equal(kind(Q, "pd"), "waiting");
  });

  test("reads the cap on every call, so lowering it holds back the next grant", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AX-1", ["back"], "action");
    Q.request("pc", "EX-1", ["budget"], "reef");
    Q.limits.cap = 1;

    assert.deepEqual(Q.release("pa").granted, []);
    assert.deepEqual(keys(Q.release("pb")), ["EX-1"]);
  });

  test("grants a waiter as soon as a raised cap is applied, with no other change", () => {
    const Q = cappedQueue(1);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AX-1", ["back"], "action");
    assert.deepEqual(Q.regrant().granted, []);

    Q.limits.cap = 2;
    assert.deepEqual(keys(Q.regrant()), ["AX-1"]);
    assert.equal(kind(Q, "pb"), "holding");
  });

  test("lets a lane-blocked waiter keep its projects from a later waiter of another lane", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["shared"], "acme");
    const later = Q.request("pc", "AX-1", ["shared"], "action");

    assert.deepEqual(later.position, {
      kind: "waiting",
      position: 2,
      blockers: [{ taskKey: "AG-2", repos: ["shared"], holding: false }],
    });
    assert.deepEqual(keys(Q.release("pa")), ["AG-2"]);
    assert.equal(kind(Q, "pc"), "waiting");
  });

  test("lets a terminal of a task holding a turn join it past the cap", () => {
    const Q = cappedQueue(1);
    Q.request("px", "AX-1", ["back"], "action");
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pa2", "AG-1", ["admin"], "acme");

    const released = Q.release("px");
    assert.deepEqual(
      released.granted.map((t) => [t.taskKey, t.repos, t.terminals]),
      [["AG-1", ["shop", "admin"], ["pa", "pa2"]]],
    );
    assert.equal(Q.request("pa3", "AG-1", ["shop"], "acme").position.kind, "holding");
  });

  test("gives a task with no project a slot of its own", () => {
    const Q = cappedQueue(1);
    const orca = Q.request("po", "OPM-1", [], "orca");
    const ag = Q.request("pa", "AG-1", ["shop"], "acme");

    assert.deepEqual(orca.position, {
      kind: "holding",
      turn: {
        taskKey: "OPM-1", lane: "orca", grantedAt: 1, terminals: ["po"], repos: [], members: [], slotOnly: true,
      },
    });
    assert.deepEqual(ag.position, {
      kind: "waiting",
      position: 1,
      blockers: [{ taskKey: "OPM-1", repos: [], holding: true, reason: "cap" }],
    });
    assert.deepEqual(keys(Q.release("po")), ["AG-1"]);
  });
});

describe("queue: paused terminals (Orca)", () => {
  const pausedBrief = (Q) => Q.snapshot().paused.map((r) => ({
    terminal: r.terminal, taskKey: r.taskKey, repos: r.members.map((m) => m.root), lane: r.lane,
    requestedAt: r.requestedAt, pauseReason: r.pauseReason, pausedAt: r.pausedAt,
  }));

  test("pauses a holder: the next task goes, the terminal keeps a place and claims nothing", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["shop"], "acme");

    const paused = Q.pause("pa", "limit", "usage limit");
    assert.equal(paused.pausedTaskKey, "AG-1");
    assert.equal(paused.wasHolding, true);
    assert.deepEqual(keys(paused), ["AG-2"]);

    assert.deepEqual(Q.snapshot().waiting, []);
    assert.deepEqual(pausedBrief(Q), [
      { terminal: "pa", taskKey: "AG-1", repos: ["shop"], lane: "acme", requestedAt: 3, pauseReason: "limit", pausedAt: 3 },
    ]);
    assert.equal(Q.snapshot().paused[0].pauseMsg, "usage limit");
    assert.deepEqual(Q.positionOf("pa"), {
      kind: "waiting",
      position: 1,
      blockers: [{ taskKey: "AG-2", repos: ["shop"], holding: true }],
      paused: { reason: "limit", pausedAt: 3 },
    });
  });

  test("pauses a paused terminal anew in its place, with the new reason and time", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["admin"]);
    Q.request("pb", "AX-2", ["admin"]);
    Q.request("pc", "AX-3", ["admin"]);
    Q.pause("pb", "limit");

    const again = Q.pause("pb", "error");
    assert.deepEqual(
      { pausedTaskKey: again.pausedTaskKey, wasHolding: again.wasHolding, granted: again.granted },
      { pausedTaskKey: "AX-2", wasHolding: false, granted: [] },
    );
    assert.deepEqual(pausedBrief(Q), [
      { terminal: "pb", taskKey: "AX-2", repos: ["admin"], lane: null, requestedAt: 2, pauseReason: "error", pausedAt: 5 },
    ]);
    Q.request("pb", "AX-2", ["admin"]);
    assert.deepEqual(keys(Q.release("pa")), ["AX-2"]);
  });

  test("keeps the turn of a two-terminal task while its other terminal works", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pa2", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["admin"], "acme");

    assert.deepEqual(Q.pause("pa", "limit").granted, []);
    assert.deepEqual(turns(Q), [["AG-1", ["shop"], ["pa2"]]]);
    assert.deepEqual(keys(Q.release("pa2")), ["AG-2"]);
  });

  test("puts a paused holder that asks again first in line for its lane", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["admin"], "acme");
    Q.request("pc", "AG-3", ["blog"], "acme");
    Q.pause("pa", "limit");

    const again = Q.request("pa", "AG-1", ["shop"], "acme");
    assert.deepEqual(again.position, {
      kind: "waiting",
      position: 1,
      blockers: [{ taskKey: "AG-2", repos: ["admin"], holding: true, reason: "lane" }],
    });
    assert.deepEqual(Q.snapshot().paused, []);
    assert.deepEqual(keys(Q.release("pb")), ["AG-1"]);
    assert.equal(kind(Q, "pc"), "waiting");
  });

  test("pauses a waiter in its place, so asking again keeps who is ahead and behind", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["admin"]);
    Q.request("p0", "AX-0", ["admin"]);
    Q.request("pb", "AX-2", ["admin"]);
    Q.request("pc", "AX-3", ["admin"]);

    const paused = Q.pause("pb", "error");
    assert.deepEqual(
      { pausedTaskKey: paused.pausedTaskKey, wasHolding: paused.wasHolding, granted: paused.granted },
      { pausedTaskKey: "AX-2", wasHolding: false, granted: [] },
    );
    assert.deepEqual(Q.positionOf("pc"), {
      kind: "waiting",
      position: 2,
      blockers: [
        { taskKey: "AX-1", repos: ["admin"], holding: true },
        { taskKey: "AX-0", repos: ["admin"], holding: false },
      ],
    });
    Q.request("pb", "AX-2", ["admin"]);
    assert.deepEqual(keys(Q.release("pa")), ["AX-0"]);
    assert.deepEqual(keys(Q.release("p0")), ["AX-2"]);
  });

  test("lets later waiters and joining terminals take what a paused waiter wanted", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["admin"]);
    Q.request("pb", "AX-2", ["back", "admin", "blog"]);
    Q.request("pc", "AX-3", ["back"]);

    assert.deepEqual(keys(Q.pause("pb", "limit")), ["AX-3"]);
    const joined = Q.request("pa2", "AX-1", ["blog"]);
    assert.deepEqual(joined.skipped, []);
    assert.deepEqual(joined.granted.map((t) => t.repos), [["admin", "blog"]]);
  });

  test("drops a paused terminal that gives up its place", () => {
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["admin"], "acme");
    Q.pause("pa", "error");

    const out = Q.release("pa");
    assert.deepEqual(
      { releasedTaskKey: out.releasedTaskKey, wasWaiting: out.wasWaiting, granted: out.granted },
      { releasedTaskKey: null, wasWaiting: true, granted: [] },
    );
    assert.equal(Q.positionOf("pa"), null);
    assert.deepEqual(Q.snapshot().paused, []);
    assert.deepEqual(Q.q.requests.map((r) => r.terminal), ["pb"]);
  });
});

describe("queue: per-space limit (S9)", () => {
  test("with a limit of 2, two tasks of one space test at once and the third waits for the space", () => {
    const Q = cappedQueue(3, { action: 2 });
    assert.equal(Q.request("t1", "AX-1", ["back"], "action").position.kind, "holding");
    assert.equal(Q.request("t2", "AX-2", ["admin"], "action").position.kind, "holding");
    const third = Q.request("t3", "AX-3", ["landing"], "action");
    assert.deepEqual(third.position, {
      kind: "waiting",
      position: 1,
      blockers: [
        { taskKey: "AX-1", repos: ["back"], holding: true, reason: "lane" },
        { taskKey: "AX-2", repos: ["admin"], holding: true, reason: "lane" },
      ],
    });
    // Another space still has its own room under the cap.
    assert.equal(Q.request("t4", "AG-1", ["shop"], "acme").position.kind, "holding");
    assert.deepEqual(keys(Q.release("t1")), ["AX-3"]);
  });

  test("a space with room is not a blocker; a space whose limit is 1 by default still is", () => {
    const Q = cappedQueue(4, { action: 2 });
    Q.request("t1", "AX-1", ["back"], "action");
    // AX-2 wants back too: it waits for the repo, not for the space.
    const repoBound = Q.request("t2", "AX-2", ["back"], "action");
    assert.deepEqual(repoBound.position.blockers, [{ taskKey: "AX-1", repos: ["back"], holding: true }]);
    // ag has no setting: one task at a time.
    Q.request("t3", "AG-1", ["shop"], "acme");
    assert.deepEqual(Q.request("t4", "AG-2", ["blog"], "acme").position.blockers, [
      { taskKey: "AG-1", repos: ["shop"], holding: true, reason: "lane" },
    ]);
  });

  test("lowering a space's limit evicts nobody; raising it lets its waiter in on the next regrant", () => {
    const Q = cappedQueue(4, { action: 2 });
    Q.request("t1", "AX-1", ["back"], "action");
    Q.request("t2", "AX-2", ["admin"], "action");
    Q.limits.perSpace = { action: 1 };
    assert.deepEqual(Q.regrant().granted, []);
    assert.deepEqual(turns(Q).map((t) => t[0]), ["AX-1", "AX-2"]);
    assert.equal(Q.request("t3", "AX-3", ["landing"], "action").position.kind, "waiting");
    assert.deepEqual(Q.release("t1").granted, []);
    Q.limits.perSpace = { action: 2 };
    assert.deepEqual(keys(Q.regrant()), ["AX-3"]);
  });
});

// The tester cases, at the queue level. Their tasks have no Spotlight repo
// (slot-only turns), so the blocker lines read exactly as the cases expect.
describe("queue: tester cases", () => {
  const TESTER = { cap: 2, perSpace: {} };

  test("01 two tasks in one space: the second waits for the space although the cap has room", () => {
    const Q = makeQueue({ ...TESTER });
    assert.equal(Q.request("t-checkout", "checkout-flow", [], "action").position.kind, "holding");
    const second = Q.request("t-login", "login-fix", [], "action");
    assert.equal(second.position.kind, "waiting");
    assert.equal(second.position.position, 1);
    assert.deepEqual(second.position.blockers.map((b) => describeBlocker(b)), ["checkout-flow is testing (same space)"]);
    const s = Q.snapshot();
    assert.equal(s.turns.length + s.waiting.length, 2);
  });

  test("02 tasks in two spaces test at the same time", () => {
    const Q = makeQueue({ ...TESTER });
    assert.equal(Q.request("t-acme", "acme-checkout", [], "acme").position.kind, "holding");
    assert.equal(Q.request("t-checkout", "checkout-flow", [], "action").position.kind, "holding");
    assert.deepEqual(turns(Q).map((t) => t[0]), ["acme-checkout", "checkout-flow"]);
    assert.deepEqual(line(Q), []);
  });

  test("03 a third space waits with limit reached and gets the turn when one finishes", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-acme", "acme-checkout", [], "acme");
    Q.request("t-checkout", "checkout-flow", [], "action");
    const waiting = Q.request("t-exp", "budget-export", [], "reef");
    assert.equal(waiting.position.position, 1);
    assert.deepEqual(waiting.position.blockers.map((b) => describeBlocker(b)), [
      "acme-checkout is testing (limit reached)",
      "checkout-flow is testing (limit reached)",
    ]);

    // Granted by the release itself: no new request needed.
    assert.deepEqual(keys(Q.release("t-acme")), ["budget-export"]);
    assert.deepEqual(turns(Q).map((t) => t[0]), ["checkout-flow", "budget-export"]);
    assert.equal(kind(Q, "t-exp"), "holding");
  });

  test("04 projects without a space share one line", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-notes", "notes-sync", [], "spaceless");
    const waiting = Q.request("t-scratch", "scratch-cleanup", [], "spaceless");
    assert.deepEqual(waiting.position.blockers.map((b) => describeBlocker(b)), ["notes-sync is testing (same space)"]);
  });

  test("05 empty queue: nobody testing, one task, then nobody again", () => {
    const Q = makeQueue({ ...TESTER });
    assert.deepEqual(Q.snapshot(), { turns: [], waiting: [], paused: [] });
    Q.request("t-acme", "acme-checkout", [], "acme");
    assert.equal(Q.snapshot().turns.length, 1);
    Q.release("t-acme");
    assert.deepEqual(Q.snapshot(), { turns: [], waiting: [], paused: [] });
  });

  test("07 changing the limit never evicts a task; raising it lets a waiter in at once", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-acme", "acme-checkout", [], "acme");
    Q.request("t-checkout", "checkout-flow", [], "action");
    Q.limits.cap = 1;
    assert.deepEqual(Q.regrant().granted, []);
    assert.deepEqual(turns(Q).map((t) => t[0]), ["acme-checkout", "checkout-flow"]);

    const waiting = Q.request("t-exp", "budget-export", [], "reef");
    assert.match(describeBlocker(waiting.position.blockers[0]), /\(limit reached\)$/);
    // With cap 1, acme-checkout alone fills it.
    assert.deepEqual(Q.release("t-checkout").granted, []);
    assert.deepEqual(line(Q), ["t-exp"]);

    Q.limits.cap = 2;
    assert.deepEqual(keys(Q.regrant()), ["budget-export"]);
    assert.deepEqual(turns(Q).map((t) => t[0]), ["acme-checkout", "budget-export"]);
  });

  test("08 an agent that stops on a failure is paused and the next task gets the turn", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-checkout", "checkout-flow", [], "action");
    Q.request("t-login", "login-fix", [], "action");
    const paused = Q.pause("t-checkout", "error", "stopped on an error");
    assert.deepEqual(keys(paused), ["login-fix"]);
    const s = Q.snapshot();
    assert.deepEqual(s.paused.map((r) => [r.terminal, r.pauseReason]), [["t-checkout", "error"]]);
    assert.deepEqual(s.turns.map((t) => t.taskKey), ["login-fix"]);
    assert.deepEqual(s.waiting, []);
    // The paused task doesn't count: one testing, nobody waiting.
    assert.equal(s.turns.length + s.waiting.length, 1);
    const mine = Q.positionOf("t-checkout");
    assert.equal(mine.kind, "waiting");
    assert.equal(mine.position, 1);
    assert.equal(mine.paused.reason, "error");
  });

  test("09 the paused task keeps its place ahead of a later task", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-checkout", "checkout-flow", [], "action");
    Q.request("t-login", "login-fix", [], "action");
    Q.request("t-signup", "signup-page", [], "action");
    assert.equal(Q.positionOf("t-signup").position, 2);

    Q.pause("t-checkout", "error");
    assert.deepEqual(turns(Q).map((t) => t[0]), ["login-fix"]);
    assert.deepEqual(line(Q), ["t-signup"]);

    const again = Q.request("t-checkout", "checkout-flow", [], "action");
    assert.equal(again.position.position, 1);
    assert.equal(Q.positionOf("t-signup").position, 2);
    assert.deepEqual(line(Q), ["t-checkout", "t-signup"]);
    assert.deepEqual(Q.snapshot().paused, []);

    assert.deepEqual(keys(Q.release("t-login")), ["checkout-flow"]);
    assert.equal(Q.positionOf("t-signup").position, 1);
  });

  test("10 an agent that finishes normally releases its turn without pausing", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-checkout", "checkout-flow", [], "action");
    Q.request("t-login", "login-fix", [], "action");
    const out = Q.release("t-checkout");
    assert.equal(out.releasedTaskKey, "checkout-flow");
    assert.deepEqual(keys(out), ["login-fix"]);
    assert.deepEqual(Q.snapshot().paused, []);
    assert.equal(Q.positionOf("t-checkout"), null);
  });

  test("11 releasing an idle holder hands the turn to the next task", () => {
    const Q = makeQueue({ ...TESTER });
    Q.request("t-checkout", "checkout-flow", [], "action", { lastActivityAt: 0 });
    Q.request("t-login", "login-fix", [], "action");
    assert.equal(Q.q.requests[0].lastActivityAt, 0);
    assert.deepEqual(keys(Q.release("t-checkout")), ["login-fix"]);
    assert.deepEqual(line(Q), []);
    assert.equal(Q.positionOf("t-checkout"), null);
  });
});

describe("queue: off (S9)", () => {
  test("a request with the queue off queues nothing and answers off", () => {
    const Q = makeQueue({ cap: 2, enabled: false });
    const out = Q.request("t1", "AX-1", ["back"], "action");
    assert.deepEqual(out.position, { kind: "off" });
    assert.deepEqual(out.granted, []);
    assert.deepEqual(Q.q.requests, []);
    // A second task of the same space and repo isn't held back either.
    assert.deepEqual(Q.request("t2", "AX-2", ["back"], "action").position, { kind: "off" });
  });

  test("switching it off drops the caller's place and grants nobody until it's back on", () => {
    const Q = makeQueue({ cap: 2 });
    Q.request("t1", "AX-1", [], "action");
    Q.request("t2", "AX-2", [], "action");
    Q.request("t3", "AX-3", [], "action");
    Q.limits.enabled = false;
    // t2 asks while off: it lights at once, its old place goes.
    assert.deepEqual(Q.request("t2", "AX-2", [], "action").position, { kind: "off" });
    assert.deepEqual(line(Q), ["t3"]);
    // A release while off frees the turn but grants nobody.
    assert.deepEqual(Q.release("t1").granted, []);
    assert.deepEqual(Q.regrant().granted, []);
    assert.equal(kind(Q, "t3"), "waiting");

    Q.limits.enabled = true;
    assert.deepEqual(keys(Q.regrant()), ["AX-3"]);
  });
});

describe("queue: describeBlocker", () => {
  test("names the repos by folder, and why: same space, limit reached, ahead of you", () => {
    const back = "/Users/demo/code/nimbus-back";
    const admin = "/Users/demo/code/nimbus-admin/";
    assert.equal(describeBlocker({ taskKey: "AX-1", repos: [back], holding: true }), "AX-1 is testing nimbus-back");
    assert.equal(
      describeBlocker({ taskKey: "AX-2", repos: [back, admin], holding: false }),
      "AX-2 is ahead of you for nimbus-back, nimbus-admin",
    );
    assert.equal(
      describeBlocker({ taskKey: "AG-1", repos: ["/code/shop"], holding: true, reason: "lane" }),
      "AG-1 is testing shop (same space)",
    );
    assert.equal(
      describeBlocker({ taskKey: "AG-2", repos: [], holding: false, reason: "cap" }),
      "AG-2 is ahead of you (limit reached)",
    );
    assert.equal(
      describeBlocker({ taskKey: "AX-1", repos: [back], holding: true }, (root) => root.toUpperCase()),
      `AX-1 is testing ${back.toUpperCase()}`,
    );
  });
});

describe("queue: the records in state.json", () => {
  test("keeps the CLI's own fields, and the queue's own fields follow the request's state", () => {
    const Q = makeQueue();
    Q.request("pa", "AX-1", ["back"], "action", { requestTurn: 3, fgPid: 42, requestedAt: 999, state: "holding" });
    Q.request("pb", "AX-2", ["back"], "action", { requestTurn: 0, fgPid: 7 });
    const [pa, pb] = Q.q.requests;
    assert.deepEqual(
      { state: pa.state, requestedAt: pa.requestedAt, grantedAt: pa.grantedAt, requestTurn: pa.requestTurn, fgPid: pa.fgPid, lane: pa.lane },
      { state: "holding", requestedAt: 1, grantedAt: 1, requestTurn: 3, fgPid: 42, lane: "action" },
    );
    assert.deepEqual(
      { state: pb.state, grantedAt: pb.grantedAt, pausedAt: pb.pausedAt, pauseReason: pb.pauseReason, pauseMsg: pb.pauseMsg },
      { state: "waiting", grantedAt: null, pausedAt: null, pauseReason: null, pauseMsg: null },
    );
    // Asking again re-baselines the CLI's fields and keeps the place (requestedAt).
    Q.request("pb", "AX-2", ["back"], "action", { requestTurn: 5, fgPid: 8, resumingUntil: null });
    const again = Q.q.requests.find((r) => r.terminal === "pb");
    assert.deepEqual([again.requestTurn, again.fgPid, again.requestedAt, again.resumingUntil], [5, 8, 2, null]);
    // The other members' fields go through untouched.
    assert.deepEqual(again.members, [member("back")]);
    // Every terminal of a turn shares its grantedAt.
    Q.request("pa2", "AX-1", ["back"], "action");
    assert.equal(Q.q.requests.find((r) => r.terminal === "pa2").grantedAt, 1);
  });

  test("never changes its input, and keeps every other key of the queue", () => {
    const deepFreeze = (o) => {
      if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    const Q = cappedQueue(2);
    Q.request("pa", "AG-1", ["shop"], "acme");
    Q.request("pb", "AG-2", ["shop", "blog"], "acme");
    Q.request("pc", "AX-1", ["back"], "action");
    const frozen = deepFreeze(structuredClone(Q.q));
    const copy = structuredClone(frozen);
    const ctx = { now: 100, cap: 2 };
    const ask = (terminal, taskKey, roots, lane) => ({ terminal, taskKey, lane, members: roots.map(member) });
    request(frozen, ask("pd", "AG-1", ["shop", "blog"], "acme"), ctx);
    request(frozen, ask("pa", "AX-9", ["x"], "acme"), ctx);
    release(frozen, "pa", ctx);
    pause(frozen, "pa", { reason: "limit" }, ctx);
    pause(frozen, "pb", { reason: "error" }, ctx);
    regrant(frozen, { ...ctx, cap: 4 });
    positionOf(frozen, "pb", ctx);
    snapshot(frozen);
    assert.deepEqual(frozen, copy);
    assert.deepEqual(release(frozen, "pa", ctx).queue.lighting, {});
    // A missing queue reads as an empty one.
    assert.deepEqual(snapshot(undefined), { turns: [], waiting: [], paused: [] });
    assert.equal(request(undefined, ask("pa", "AX-1", [], "acme"), ctx).position.kind, "holding");
  });
});

// Risk item 4: the CLI runs one call at a time under the state lock, but in
// any order and with state.json read back between calls. Random interleavings
// (seeded) must keep the grant rules after every call.
describe("queue: grant rules over any interleaving", () => {
  function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  }
  const TASK_LANE = { K0: "a", K1: "a", K2: "a", K3: "b", K4: "b", K5: "spaceless" };
  const ROOTS = ["r0", "r1", "r2", "r3", "r4"];
  const TERMINALS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];

  function checkRules(q, limits) {
    const requests = q.requests;
    const terminals = requests.map((r) => r.terminal);
    assert.equal(new Set(terminals).size, terminals.length, "a terminal is in the queue once");
    const { turns: all } = snapshot(q);
    const owner = new Map();
    for (const turn of all) {
      for (const root of turn.repos) {
        assert.ok(!owner.has(root) || owner.get(root) === turn.taskKey, `${root} held by two tasks`);
        owner.set(root, turn.taskKey);
      }
      const holders = requests.filter((r) => r.state === "holding" && r.taskKey === turn.taskKey);
      assert.ok(holders.every((r) => r.grantedAt === turn.grantedAt), "a turn has one grantedAt");
    }
    assert.ok(all.length <= limits.cap, "never more turns than the cap");
    for (const lane of ["a", "b", "spaceless"]) {
      const limit = limits.perSpace[lane] ?? 1;
      assert.ok(all.filter((t) => t.lane === lane).length <= limit, `lane ${lane} over its limit`);
    }
    // Nobody left waiting could have been granted: a regrant changes nothing.
    assert.deepEqual(regrant(q, { now: 0, ...limits }).granted, []);
    for (const r of requests.filter((x) => x.state !== "holding")) {
      const at = positionOf(q, r.terminal, limits);
      assert.equal(at.kind, "waiting");
      assert.ok(at.position >= 1);
    }
  }

  for (const seed of [1, 7, 42, 2026, 31337]) {
    test(`seed ${seed}: 400 calls keep every rule`, () => {
      const random = rng(seed);
      const pick = (list) => list[Math.floor(random() * list.length)];
      const limits = { cap: 3, perSpace: { a: 2 } };
      let q = { requests: [] };
      const seen = { granted: 0, waiting: 0, paused: 0, joined: 0 };
      for (let now = 1; now <= 400; now++) {
        const ctx = { now, ...limits };
        const terminal = pick(TERMINALS);
        const roll = random();
        let out;
        if (roll < 0.55) {
          const taskKey = pick(Object.keys(TASK_LANE));
          const roots = ROOTS.filter(() => random() < 0.35);
          out = request(q, { terminal, taskKey, lane: TASK_LANE[taskKey], members: roots.map(member) }, ctx);
        } else if (roll < 0.8) {
          out = release(q, terminal, ctx);
        } else if (roll < 0.95) {
          out = pause(q, terminal, { reason: pick(["limit", "signin", "error"]) }, ctx);
        } else {
          out = regrant(q, ctx);
        }
        // state.json between calls: what goes in comes back the same.
        const text = JSON.stringify(out.queue);
        assert.deepEqual(JSON.parse(text), out.queue, "records are JSON-clean");
        q = JSON.parse(text);
        for (const turn of out.granted) assert.ok(snapshot(q).turns.some((t) => t.taskKey === turn.taskKey));
        checkRules(q, limits);
        const s = snapshot(q);
        seen.granted += out.granted.length;
        seen.waiting += s.waiting.length > 0 ? 1 : 0;
        seen.paused += s.paused.length > 0 ? 1 : 0;
        seen.joined += s.turns.some((t) => t.terminals.length > 1) ? 1 : 0;
      }
      // Why: the rules above hold vacuously on a queue that never moves.
      assert.ok(Object.values(seen).every((n) => n > 0), `every path ran: ${JSON.stringify(seen)}`);
    });
  }
});
