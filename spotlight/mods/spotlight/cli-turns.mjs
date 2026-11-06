// What the CLI decides from Herdr's facts, as pure functions (no I/O, no
// clock): when an agent's turn ends (D13), when a holder was last active
// (D19), and when a task's turn needs a `light` (D12). The verbs in cli.mjs
// gather the facts (hc get, hc read, the accounts lookup) and apply these.

// D19: a holder idle this long shows "sin actividad hace N min" (T8).
export const IDLE_MS = 10 * 60_000;
// A pending marker with no pid yet: its `light` was just spawned.
const SPAWN_GRACE_MS = 5_000;

const SHELLS = new Set("bash zsh sh fish nu ksh mksh dash ash tcsh csh elvish xonsh".split(" "));
const baseName = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");
const isInt = (v) => Number.isInteger(v);

// ── Turn ends (D13) ────────────────────────────────────────────────────────

// Continuar's resume window is open: its own turn ends don't count.
export function inResumeWindow(req, now) {
  return Number.isFinite(req?.resumingUntil) && now < req.resumingUntil;
}

// The agent that asked is gone from the terminal: a shell now leads its
// foreground (a `--keep` shell left after the agent died) where another
// process led it when the terminal asked. A request made from a plain shell
// keeps that shell's pid, so it never reads as left.
export function agentLeft(req, term) {
  const fg = term?.foreground;
  if (!fg || !isInt(req?.fgPid)) return false;
  return fg.pid !== req.fgPid && SHELLS.has(baseName(fg.name));
}

const keep = (why) => ({ action: "keep", why });
const pauseFor = (reason, turn, msg) => ({ action: "pause", reason, turn, msg: msg || null });

// What one requesting terminal's facts do to its place (D13).
//   req    its request in state.json
//   term   its `hc get --json` (null: no such terminal)
//   usage  undefined: not read yet; null: no accounts plugin (or it can't
//          place the terminal); else accountUsage()'s { signin, atLimit, fresh }
// → { action, … }:
//   keep        nothing to do
//   baseline    the request has no turn to compare with yet: record `turn`
//   release     give the turn (or the place) back; `why`
//   pause       keep the place, claim nothing; `reason` limit | signin | error
//   need-usage  call again with the account's usage
//   classify    the usage is stale: the detached `classify` decides
export function decideTurnEnd(req, term, now, usage) {
  const window = inResumeWindow(req, now);
  if (!term || term.state !== "live") return window ? keep("gone inside the resume window") : { action: "release", why: "gone" };
  if (!window && agentLeft(req, term)) return { action: "release", why: "agent-left" };
  if (!isInt(term.turn)) return keep("no turn count");
  if (!isInt(req.requestTurn)) return { action: "baseline", turn: term.turn };
  const base = Math.max(req.requestTurn, isInt(req.handledTurn) ? req.handledTurn : -Infinity);
  if (term.turn <= base) return keep("no turn ended since the request");
  if (window) return keep("inside the resume window");

  const state = term.status?.state ?? null;
  const kind = term.status?.kind ?? null;
  const msg = typeof term.status?.msg === "string" ? term.status.msg : "";
  if (state === "working") return keep("working");
  // The agent waits on a person: still its turn.
  if (state === "blocked" && (kind === "permission" || kind === "question")) return keep("waiting on a person");
  const stopped = state === "error" || (state === "blocked" && (kind === "auth" || !kind));
  const ended = state === "done" || state === "idle";
  if (!stopped && !ended) return keep(`status ${state ?? "unknown"}`);
  // A paused agent stopping again changes nothing (Orca's re-published failure).
  if (stopped && req.state === "paused") return keep("already paused");
  if (stopped && kind === "auth") return pauseFor("signin", term.turn, msg);
  if (usage === undefined) return { action: "need-usage", turn: term.turn };
  if (usage === null) {
    if (!stopped) return { action: "release", why: "turn-end" };
    return pauseFor(/limit/i.test(msg) ? "limit" : "error", term.turn, msg);
  }
  if (usage.signin) return stopped ? pauseFor("signin", term.turn, msg) : { action: "release", why: "turn-end" };
  if (!usage.fresh) return { action: "classify", turn: term.turn };
  if (usage.atLimit) return pauseFor("limit", term.turn, msg);
  return stopped ? pauseFor("error", term.turn, msg) : { action: "release", why: "turn-end" };
}

// ── Idle (D19) ─────────────────────────────────────────────────────────────

// What a reap learns about a holder's activity: its status changed
// (status_ms moved) or its screen did (`outputHash`, the hash of `hc read
// --lines 40`; undefined when not read). The fields to write, or null.
export function activityUpdate(req, { statusMs, outputHash }, now) {
  if ((statusMs ?? null) !== (req.statusMs ?? null)) return { lastActivityAt: now, statusMs: statusMs ?? null };
  if (outputHash !== undefined && outputHash !== null && outputHash !== req.outputHash) {
    return { lastActivityAt: now, outputHash };
  }
  return null;
}

// ── Lighting markers (D12, D18) ────────────────────────────────────────────

// state.json's lighting[k] for a turn handed to `light`: `grantId` is the
// turn's grantedAt ("off" with the queue off; a time for a human's toggle),
// `members` what to light ({ root, name, workspace, workspaces }), `taskKey`
// the task whose remembered variant applies (null for none), `force` the
// human's "anyway".
export function lightingMarker(turn, { now, taskKey = null, force = false }) {
  return {
    grantId: turn.grantedAt,
    phase: "pending",
    pid: null,
    startedAt: now,
    error: null,
    errors: {},
    members: (turn.members ?? []).map((m) => ({
      root: m.root, name: m.name ?? null, workspace: m.workspace, workspaces: m.workspaces ?? [m.workspace],
    })),
    taskKey,
    force: Boolean(force),
  };
}

// Whether a marker's `light` is still at work: its pid lives, or it was
// spawned a moment ago and hasn't written its pid yet.
export function lightAlive(marker, { now, pidAlive }) {
  if (marker.phase !== "pending" && marker.phase !== "running") return false;
  if (isInt(marker.pid)) return pidAlive(marker.pid);
  return now - (marker.startedAt ?? 0) < SPAWN_GRACE_MS;
}

// A member is lit when its repo's holder is one of the task's worktrees there.
export function memberLit(member, repos) {
  const holder = repos?.[member.root]?.holder;
  return Boolean(holder) && (member.workspaces ?? [member.workspace]).includes(holder);
}

// Whether a holding turn needs a (new) `light` (D12): no marker for this
// grant, its repos grew, or its light died before it finished. With
// `checkLit` (every `on`, Orca's light-on-every-call), also when a finished
// lighting left some repo unlit (an error, or a human turned it off).
export function needsLight(marker, turn, { now, pidAlive, repos, checkLit = false }) {
  if (!turn || turn.slotOnly || (turn.members ?? []).length === 0) return false;
  if (!marker || marker.grantId !== turn.grantedAt) return true;
  const marked = new Set((marker.members ?? []).map((m) => m.root));
  if (turn.members.some((m) => !marked.has(m.root))) return true;
  if (marker.phase === "pending" || marker.phase === "running") return !lightAlive(marker, { now, pidAlive });
  return checkLit && turn.members.some((m) => !memberLit(m, repos));
}
