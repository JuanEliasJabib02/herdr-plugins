// The errors about a repo's server rather than its root (D24, D25, D26),
// shared by the CLI (cli-work.mjs), the badges (badges-model.js) and the
// server popup (server-view-model.js), so the three never disagree on them.
// Pure.
//
// SERVER_ERRORS, the server errors a record's lastError holds:
//   port-busy            a process outside the server's terminal held the
//                        port its start takes (D24), or the server found it
//                        taken (D25)
//   server-exited        the server died at start (D25)
//   server-start-failed  Spotlight couldn't start it: hc couldn't read,
//                        make or type into its terminal, or the terminal
//                        runs something Spotlight didn't start (K3)
// A sync that goes through leaves them, and so does the same holder lit
// again; a start that goes through, or the server coming up to listen, ends
// them, and so does a takeover whose server needs no start (cli-work.mjs
// ensureServer's `takeover`, G1, H3, K2) and a plan with no command at all
// (K1: no server to be wrong about). A start that fails writes its own
// server-start-failed over any of them, so the record never blames another
// start's pid or port (K3, H2). They drive serverDown, the popup's actions
// (Ver log, Reintentar), the toasts' popup action and the record's two-error
// stack below.
export const PORT_BUSY = "port-busy";
export const SERVER_EXITED = "server-exited";
export const SERVER_START_FAILED = "server-start-failed";
export const SERVER_ERRORS = new Set([PORT_BUSY, SERVER_EXITED, SERVER_START_FAILED]);

// TURN_OFF_ERRORS, a turn-off whose server didn't stop (D26, cli-work.mjs
// turnOffError, which takes its codes from here, H9):
//   server-survived     some of it lived through SIGKILL, or was never
//                       signalled
//   server-not-stopped  it didn't stop for any other reason
// Never stored on a record (the record is gone with the turn-off): they live
// in its toast and its exit, so none of the above ever reads them (G9).
export const SERVER_SURVIVED = "server-survived";
export const SERVER_NOT_STOPPED = "server-not-stopped";
export const TURN_OFF_ERRORS = new Set([SERVER_SURVIVED, SERVER_NOT_STOPPED]);

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

// A record's lastError holds one root error and one server error
// (SERVER_ERRORS) at most. Every other code is a root error: what a git step
// on the root refused (orca-holds, root-diverged, untracked-collision,
// git-failed, …) and the reap's orphan-refs; a turn-off's TURN_OFF_ERRORS
// never get here. The root error goes on top, with the server error it
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
// listen, a takeover whose server needs no start, a plan with no command),
// wherever it is.
export function clearServerError(record) {
  if (isServerError(record.lastError)) {
    record.lastError = null;
  } else if (record.lastError?.serverError) {
    const { serverError, ...root } = record.lastError;
    record.lastError = root;
  }
  return record;
}
