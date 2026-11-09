// `spotlight toggle --task <KEY> --group <id>` (D31): the whole-task
// Spotlight button on a task lane's header, Orca's "Spotlight this task"
// (TaskSpotlightButton, task-spotlight-batch.ts). Node-only, like cli.mjs;
// the mod never imports it (the lane's flashlight execs bin/spotlight).
//
// The task's members are its workspaces in the group's enabled repos, one
// per repo (task.js resolveGroupTask). Lit (task.js taskLit: every member's
// root held by one of the task's workspaces) → each member turned off, in
// order. Not lit → first every repo of the group lit by no member is turned
// off (the switch-away), then each member not held yet is lit the way a
// human's toggle lights a workspace: a `direct/<root>` lighting marker, then
// lightTask inline. A member held by another workspace is taken over.
// Everything goes through cli-work.mjs (lightTask, deactivateRepo) with
// `quiet`, so no repo says "Spotlight on · …" or "Spotlight off — root
// restaurado" itself; a failure never stops the rest and toasts itself; one
// summary note says how the batch went (summaryNote: Orca's toast, the
// text summaryOf's).
//
// The batch runs inside queue.taskBatch[<groupId>/<KEY>] (cli-work.mjs
// withTaskBatch), so the lane's flashlight spins and takes no click until it
// ends. It takes no repo lock itself: lightTask and deactivateRepo take each
// repo's in turn, never two at once.

import { resolveGroupTask, taskLit } from "./task.js";
import { lightTask, deactivateRepo, withTaskBatch } from "./cli-work.mjs";
import { lightingMarker } from "./cli-turns.mjs";
import { addNote } from "./store.js";
import { toSpotlightError } from "./sync.js";

// The batch's one note (Orca's batch toasts): every member went through →
// "Spotlight on · AX-3653" / "Spotlight off · AX-3653"; some → "Spotlight on
// en 1 de 2 proyectos"; none → null (each failure already toasted).
export function summaryOf(op, label, ok, total) {
  if (!(ok > 0)) return null;
  return ok === total ? `Spotlight ${op} · ${label}` : `Spotlight ${op} en ${ok} de ${total} proyectos`;
}

// The batch's toast (D41, Orca's notifyTaskSpotlightBatch): every member →
// a success, "Spotlight on para AX-3653"; some → a warning, "Spotlight on en
// 1 de 2 proyectos"; Orca's words as the title alone. Its `text` stays
// summaryOf's, what the CLI prints. null when none went through.
export function summaryNote(op, label, ok, total) {
  const text = summaryOf(op, label, ok, total);
  if (!text) return null;
  const all = ok === total;
  return {
    text, toast: true, level: all ? "success" : "warning",
    title: all ? `Spotlight ${op} para ${label}` : `Spotlight ${op} en ${ok} de ${total} proyectos`, body: "",
  };
}

// The lane's task in its group, with each repo's holder from state.json, so
// a member's workspace is the one holding its root when the task holds it.
// `terminals`: cli-env.mjs terminalFacts(), for the pick in the other repos.
export function resolveLane(cx, { group, task, terminals = [] }) {
  const holders = Object.fromEntries(Object.entries(cx.store.readState().repos).map(([root, r]) => [root, r.holder]));
  return resolveGroupTask({
    group, task, shared: cx.shared, git: cx.taskGit, enabled: (root) => cx.store.repoEnabled(root, cx.settings), terminals, holders,
  });
}

// A turn-off or a light that threw (a repo lock that never came free, a
// state write that failed) instead of answering.
const thrown = (e) => toSpotlightError(e).message;

// Each member still held by the task, turned off. → { [root]: message } of
// the ones that didn't go off (deactivateRepo toasts its own refusals).
async function turnOff(cx, members) {
  const errors = {};
  for (const m of members) {
    // Lit by someone else since the batch looked: nothing of this task is there.
    if (!taskLit([m], cx.store.readState().repos)) continue;
    try {
      const r = await deactivateRepo(cx, m.root, { quiet: true });
      if (!r.ok) errors[m.root] = r.message;
    } catch (e) {
      errors[m.root] = thrown(e);
    }
  }
  return errors;
}

// The switch-away, then each member not held yet lit as a human's toggle
// lights it. `key`: `<groupId>/<KEY>`, the lighting marker's taskKey (the
// variant remembered per task, D12). → { [root]: message } of the members
// that didn't light (lightMember toasts its own refusals).
async function turnOn(cx, lane, key) {
  const mine = new Set(lane.members.map((m) => m.root));
  for (const { root } of lane.projects) {
    if (mine.has(root) || !cx.store.readState().repos[root]?.holder) continue;
    try {
      await deactivateRepo(cx, root, { quiet: true });
    } catch {
      // Its refusals toast themselves; the task's members go on all the same.
    }
  }
  const errors = {};
  for (const m of lane.members) {
    if (taskLit([m], cx.store.readState().repos)) continue;
    const marker = `direct/${m.root}`;
    const now = cx.now();
    await cx.store.updateState((s) => {
      s.queue.lighting[marker] = lightingMarker({ grantedAt: now, members: [m] }, { now, taskKey: key });
    });
    try {
      const r = await lightTask(cx, marker, { quiet: true });
      if (!r.ran) errors[m.root] = "Another light took this repo's marker first.";
      else if (r.errors[m.root]) errors[m.root] = r.errors[m.root];
    } catch (e) {
      errors[m.root] = thrown(e);
    }
  }
  return errors;
}

// The whole batch, inline (the CLI's `--inline`, which a detached copy runs,
// D18). → { ok: true | false, op: "on" | "off", label, taskKey, summary,
// errors: { [root]: message }, skipped: [name], members } with ok when at
// least one member went through; or { ok: false, code, message, skipped? }:
// "no-group", "no-task" (resolveGroupTask's) or "no-members" (no workspace
// of the task in a repo with Spotlight on; nothing is touched).
export async function toggleTask(cx, { group, task, terminals = [] }) {
  const lane = await resolveLane(cx, { group, task, terminals });
  if (!lane.ok) return lane;
  const { members, skipped, label } = lane;
  if (members.length === 0) {
    const off = skipped.length > 0 ? ` Spotlight is off in: ${skipped.join(", ")}.` : "";
    return { ok: false, code: "no-members", message: `${label} has no workspace in a repo of ${group} with Spotlight on.${off}`, skipped };
  }
  const key = `${lane.group}/${lane.taskKey}`;
  const op = taskLit(members, cx.store.readState().repos) ? "off" : "on";
  return withTaskBatch(cx, key, op, async () => {
    const errors = op === "off" ? await turnOff(cx, members) : await turnOn(cx, lane, key);
    const done = members.length - Object.keys(errors).length;
    const summary = summaryOf(op, label, done, members.length);
    const note = summaryNote(op, label, done, members.length);
    if (note) {
      await cx.store.updateState((s) => {
        addNote(s, note, cx.now());
      });
    }
    return { ok: done > 0, op, label, taskKey: lane.taskKey, summary, errors, skipped, members };
  });
}
