// What the CLI prints (D1), Orca's wording (O/src/cli/spotlight-format.ts,
// spotlight-agent-turns.ts) with `spotlight` in place of `orca spotlight`,
// and the model behind `status --json`. Pure: no I/O, no clock (now is passed).

import { positionOf, snapshot, describeBlocker } from "./queue.js";
import { portUrl } from "./ports.js";
import { inResumeWindow } from "./cli-turns.mjs";

const REQUEST_ON = "spotlight on";

// The note of a turn that lights nothing (spotlight-agent-turns.ts:54-56).
export function slotOnlyNote(label) {
  return `No project of ${label} can hold a Spotlight here, so this turn only holds a test slot: run your tests.`;
}

export const NEEDS_VARIANT = "needs a variant: pick it in the server popup (spotlight env --variant <v>)";

// A task's key as people read it: the label its requests carry, else the
// key without its lane.
export function labelOf(requests, key) {
  const r = (requests ?? []).find((x) => x.taskKey === key && x.label);
  if (r) return r.label;
  const slash = String(key).indexOf("/");
  return slash === -1 ? String(key) : String(key).slice(slash + 1);
}

// ── on ─────────────────────────────────────────────────────────────────────

// Orca's state word for one server of the turn (spotlight-format.ts:11-19),
// plus the variant prompt (D10) and a start failure on a lit repo.
export function serverWord(s) {
  if (s.needsVariant) return NEEDS_VARIANT;
  if (!s.lit) return `not lit${s.error ? `: ${s.error}` : ""}`;
  if (s.listening) return "listening";
  return s.server === "running" ? "starting (port not open yet)" : "no server running";
}

// `spotlight on` holding (or with the queue off). `servers`: one per repo of
// the turn ({ name, url, logPath, lit, listening, server, error, syncError }).
export function formatOn({ label, servers = [], skipped = [], ready, note }) {
  const lines = note ? [`Your test turn for ${label} is on.`, note] : [`Spotlight on for ${label}.`];
  const width = Math.max(0, ...servers.map((s) => s.name.length));
  for (const s of servers) {
    lines.push(`  ${s.name.padEnd(width)}  ${s.url ?? "-"}  ${serverWord(s)}`);
    if (s.syncError) lines.push(`  ${" ".repeat(width)}  sync failed: ${s.syncError}`);
  }
  if (skipped.length > 0) lines.push(`Not included: ${skipped.join(", ")}.`);
  if (!note && !ready) {
    lines.push(`Not every server is listening yet. Read its log, or run \`${REQUEST_ON}\` again to keep waiting.`);
  }
  if (servers.length > 0) {
    // D11: the verb first, the raw file second.
    lines.push("Logs: spotlight logs");
    for (const s of servers) lines.push(`  ${s.name.padEnd(width)}  ${s.logPath}`);
  }
  lines.push("When you finish testing, run `spotlight off` so the next task can test.");
  return lines.join("\n");
}

// `spotlight on` still waiting at its deadline (exit 1).
export function formatWaiting({ label, position, blockers }) {
  return [
    `Waiting for a test turn for ${label}: ${blockers.map((b) => describeBlocker(b, (n) => n)).join("; ")}.`,
    `You are #${position} in line. Your place is kept: run \`${REQUEST_ON}\` again to keep waiting.`,
  ].join("\n");
}

// ── off ────────────────────────────────────────────────────────────────────

export function formatOff({ released, wasWaiting, next }) {
  if (released === null) return wasWaiting ? "Left the line for the Spotlight." : "This terminal held no Spotlight turn.";
  const after =
    next.length > 0
      ? ` ${next.join(", ")} ${next.length === 1 ? "is" : "are"} testing next.`
      : " The servers keep running until another task takes the projects.";
  return `Gave back the Spotlight turn of ${released}.${after}`;
}

// ── status ─────────────────────────────────────────────────────────────────

const latest = (times) => {
  const known = times.filter(Number.isFinite);
  return known.length > 0 ? Math.max(...known) : null;
};
const unique = (list) => [...new Set(list)];

// Blockers as status and `on` show them: task labels, repo names.
export function namedBlockers(blockers, requests, nameOf) {
  return blockers.map((b) => ({
    taskKey: labelOf(requests, b.taskKey),
    repos: b.repos.map(nameOf),
    holding: b.holding,
    ...(b.reason ? { reason: b.reason } : {}),
  }));
}

// Where `terminal` stands (Orca's SpotlightAgentMine): holding, waiting,
// paused or none.
export function mineOf(state, terminal, qctx, nameOf) {
  const requests = state.queue.requests;
  const pos = positionOf(state.queue, terminal, qctx);
  if (!pos) return { kind: "none" };
  const req = requests.find((r) => r.terminal === terminal);
  const key = req?.taskKey ?? pos.turn?.taskKey;
  const taskKey = labelOf(requests, key);
  if (pos.kind === "holding") return { kind: "holding", taskKey, key };
  const blockers = namedBlockers(pos.blockers, requests, nameOf);
  if (pos.paused) {
    return { kind: "paused", taskKey, key, position: pos.position, reason: pos.paused.reason, pausedAt: pos.paused.pausedAt, blockers };
  }
  return { kind: "waiting", taskKey, key, position: pos.position, blockers };
}

// `status --json`'s result (D1): the queue (turns, waiting, paused), where
// `terminal` stands (`mine`, only when a terminal is known), the switch
// (`queue`), the cap, and every repo's Spotlight (root, holder, server state,
// URLs, log path).
export function buildStatus({ state, settings, terminal, now, nameOf }) {
  const q = settings.queue;
  const qctx = { now, ...q };
  const requests = state.queue.requests;
  const snap = snapshot(state.queue);
  const rootsOfRequests = (reqs) => unique(reqs.map((r) => r.root).filter(Boolean));
  // A slot-only row has no repos: it is named by the repos its terminals work in (Orca).
  const rowRepos = (roots, reqs) => (roots.length > 0 ? roots : rootsOfRequests(reqs)).map(nameOf);

  const turns = snap.turns.map((turn) => {
    const reqs = requests
      .filter((r) => r.state === "holding" && r.taskKey === turn.taskKey)
      .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0));
    const lastActivityAt = latest(reqs.flatMap((r) => [r.lastActivityAt, r.requestedAt]));
    return {
      taskKey: labelOf(requests, turn.taskKey),
      key: turn.taskKey,
      lane: turn.lane,
      grantedAt: turn.grantedAt,
      terminals: reqs.map((r) => r.terminal),
      repos: rowRepos(turn.repos, reqs),
      roots: turn.repos,
      slotOnly: turn.slotOnly,
      lastActivityAt,
      lighting: state.queue.lighting[turn.taskKey]?.phase ?? null,
      resuming: reqs.some((r) => inResumeWindow(r, now)),
    };
  });

  const waiting = [];
  for (const r of snap.waiting) {
    const row = waiting.find((w) => w.key === r.taskKey);
    if (row) {
      row.terminals.push(r.terminal);
      continue;
    }
    const reqs = snap.waiting.filter((x) => x.taskKey === r.taskKey);
    waiting.push({
      taskKey: labelOf(requests, r.taskKey),
      key: r.taskKey,
      lane: r.lane ?? null,
      repos: rowRepos(unique(reqs.flatMap((x) => x.members.map((m) => m.root))), reqs),
      since: r.requestedAt,
      terminals: [r.terminal],
    });
  }

  const paused = snap.paused.map((r) => ({
    terminal: r.terminal,
    taskKey: labelOf(requests, r.taskKey),
    key: r.taskKey,
    lane: r.lane ?? null,
    repos: rowRepos(r.members.map((m) => m.root), [r]),
    reason: r.pauseReason,
    msg: r.pauseMsg ?? null,
    pausedAt: r.pausedAt,
    since: r.requestedAt,
    resuming: inResumeWindow(r, now),
    autoResumes: r.autoResumes ?? 0,
  }));

  const turnOfRoot = (root, holder) =>
    snap.turns.find((t) => t.members.some((m) => m.root === root && (m.workspaces ?? [m.workspace]).includes(holder)));
  const repos = Object.entries(state.repos).map(([root, r]) => {
    const turn = r.holder ? turnOfRoot(root, r.holder) : null;
    const ports = Array.isArray(r.ports) ? r.ports : [];
    const configured = settings.repos?.[root]?.port ?? null;
    const port = configured != null && ports.includes(configured) ? configured : ports.length > 0 ? Math.min(...ports) : null;
    return {
      root,
      name: nameOf(root),
      holder: r.holder,
      turnTaskKey: turn ? labelOf(requests, turn.taskKey) : null,
      serverState: r.serverState,
      serverCommand: r.serverCommand,
      serverEnv: r.serverEnv,
      serverVariant: r.serverVariant,
      serverTerminal: r.serverTerminal,
      ports,
      port,
      url: portUrl(port),
      urls: ports.map(portUrl),
      logPath: r.logPath,
      lastSyncAt: r.lastSyncAt,
      lastError: r.lastError,
    };
  });

  const result = {
    queue: q.enabled ? "on" : "off",
    cap: q.cap,
    perSpace: q.perSpace,
    autoResume: q.autoResume,
    turns,
    waiting,
    paused,
    repos,
  };
  if (terminal) result.mine = mineOf(state, terminal, qctx, nameOf);
  return result;
}

function minutesAgo(at, now) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
}

function pauseReason(reason) {
  if (reason === "limit") return "out of usage limit";
  if (reason === "signin") return "needs sign-in";
  return "stopped on an error";
}

function describeMine(mine) {
  const behind = (mine.blockers ?? []).map((b) => describeBlocker(b, (n) => n)).join("; ");
  switch (mine.kind) {
    case "holding":
      return `This terminal: testing ${mine.taskKey}.`;
    case "waiting":
      return `This terminal: #${mine.position} in line for ${mine.taskKey}${behind ? `: ${behind}` : ""}.`;
    case "paused":
      return `This terminal: paused (${pauseReason(mine.reason)}), #${mine.position} in line for ${mine.taskKey}. Run \`${REQUEST_ON}\` to take your place back.`;
    default:
      return `This terminal: no turn. Run \`${REQUEST_ON}\` before testing.`;
  }
}

// `spotlight status` as text (Orca's formatSpotlightStatus, plus each
// repo's root, holder, server, URLs and log, D1).
export function formatStatus(status, now) {
  const lines = [];
  if (status.queue === "off") lines.push("Queue: off (`spotlight on` lights at once, with no turn).");
  lines.push(`Limit: ${status.cap} ${status.cap === 1 ? "task" : "tasks"} at a time`);
  lines.push(status.turns.length > 0 ? "Testing:" : "Testing: nobody");
  for (const turn of status.turns) {
    const n = turn.terminals.length;
    const agents = n === 1 ? "1 agent" : `${n} agents`;
    const active = turn.lastActivityAt == null ? "" : `, last active ${minutesAgo(turn.lastActivityAt, now)}`;
    lines.push(`  ${turn.taskKey}  ${turn.repos.join(", ")}  (${agents}, since ${minutesAgo(turn.grantedAt, now)}${active})`);
  }
  if (status.waiting.length > 0) {
    lines.push("Waiting:");
    for (const w of status.waiting) lines.push(`  ${w.taskKey}  ${w.repos.join(", ")}  (since ${minutesAgo(w.since, now)})`);
  }
  if (status.paused.length > 0) {
    lines.push("Paused:");
    for (const p of status.paused) {
      const resuming = p.resuming ? ", resuming" : "";
      lines.push(`  ${p.taskKey}  ${p.repos.join(", ") || "-"}  (${pauseReason(p.reason)}, paused ${minutesAgo(p.pausedAt, now)}${resuming})`);
    }
  }
  if (status.mine) lines.push(describeMine(status.mine));
  const on = status.repos.filter((r) => r.holder);
  lines.push(on.length > 0 ? "Spotlight on:" : "Spotlight on: no project");
  for (const r of on) {
    const turn = r.turnTaskKey ? `turn of ${r.turnTaskKey}` : "no turn, free to take";
    lines.push(`  ${r.name}  ${r.root}  holds ${r.holder.split("/").pop()}  (${turn})`);
    const urls = r.urls.length > 0 ? `  ${r.urls.join(" ")}` : "";
    lines.push(`    server: ${r.serverState ?? "unknown"}${urls}`);
    if (r.lastError) lines.push(`    error: ${r.lastError.code}: ${r.lastError.message}`);
    if (r.logPath) lines.push(`    log: spotlight logs --repo ${r.name}  (${r.logPath})`);
  }
  for (const r of status.repos.filter((x) => !x.holder && x.lastError)) {
    lines.push(`  ${r.name}  ${r.root}  ${r.lastError.code}: ${r.lastError.message}`);
  }
  return lines.join("\n");
}
