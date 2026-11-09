// The errors about a repo's server rather than its root (D24, D25, D26),
// shared by the CLI (cli-work.mjs), the badges (badges-model.js) and the
// server popup (server-view-model.js), so the three never disagree on them.
// Pure.
//   port-busy           a process outside the server's terminal held the
//                       port its start takes (D24), or the server found it
//                       taken (D25)
//   server-exited       the server died at start (D25)
//   server-survived     a turn-off whose server lived through SIGKILL (D26)
//   server-not-stopped  a turn-off whose server didn't stop for any other
//                       reason (D26)
// A sync that goes through leaves them; a start that goes through, or the
// server coming up to listen, ends them. The turn-off's two leave no record
// (it is gone with the turn-off): they live in its toast and its exit.
export const SERVER_ERRORS = new Set(["port-busy", "server-exited", "server-survived", "server-not-stopped"]);

// A server that's not up (state.json's serverState; a record without one
// reads stopped).
const DOWN_STATES = new Set(["stopped", "gone"]);

// The server didn't come up and isn't up now: a server error over a server
// stopped or gone. A refused restart keeps its port-busy over a server that
// still runs (D24): that server is up, and the badge and the popup say so.
export function serverDown(record) {
  return SERVER_ERRORS.has(record?.lastError?.code) && DOWN_STATES.has(record?.serverState ?? "stopped");
}

// ── A record's two errors (F6, F7) ─────────────────────────────────────────

// A record's lastError holds one root error and one server error at most.
// Every other code is a root error: what a git step on the root refused
// (orca-holds, root-diverged, untracked-collision, git-failed, …) and the
// reap's orphan-refs. The root error goes on top, with the server error it
// covers as its `serverError`; the top one is what the popup, the badges,
// `status` and the harness hook show. Each kind is written and cleared on
// its own, whatever the other one does, so neither flips the other off:
// every writer of lastError goes through these four. Each mutates `record`
// and returns it.

export const isServerError = (error) => SERVER_ERRORS.has(error?.code);

// The server error in force: the one on top, or the one under a root error.
export function serverErrorOf(lastError) {
  if (!lastError) return null;
  return isServerError(lastError) ? lastError : lastError.serverError ?? null;
}

// The root error `error` on top, over the server error in force.
export function setRootError(record, error) {
  const { serverError, ...root } = error;
  const kept = serverErrorOf(record.lastError);
  record.lastError = kept ? { ...root, serverError: kept } : root;
  return record;
}

// The server error `error`: under the root error on top, else on top.
export function setServerError(record, error) {
  const top = record.lastError;
  record.lastError = top && !isServerError(top) ? { ...top, serverError: error } : error;
  return record;
}

// The root error ends (a sync or lighting goes through, Orca lets go): the
// server error it covered comes back on top.
export function clearRootError(record) {
  if (record.lastError && !isServerError(record.lastError)) record.lastError = record.lastError.serverError ?? null;
  return record;
}

// The server error ends (a start goes through, the server comes up to
// listen), wherever it is.
export function clearServerError(record) {
  if (isServerError(record.lastError)) {
    record.lastError = null;
  } else if (record.lastError?.serverError) {
    const { serverError, ...root } = record.lastError;
    record.lastError = root;
  }
  return record;
}
