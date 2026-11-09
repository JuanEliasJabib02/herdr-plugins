// The errors about a repo's server rather than its root (D24, D25), shared by
// the CLI (cli-work.mjs), the badges (badges-model.js) and the server popup
// (server-view-model.js), so the three never disagree on them. Pure.
//   port-busy      a process outside the server's terminal held the port its
//                  start takes (D24), or the server found it taken (D25)
//   server-exited  the server died at start (D25)
// A sync that goes through leaves them; a start that goes through, or the
// server coming up to listen, ends them.
export const SERVER_ERRORS = new Set(["port-busy", "server-exited"]);

// A server that's not up (state.json's serverState; a record without one
// reads stopped).
const DOWN_STATES = new Set(["stopped", "gone"]);

// The server didn't come up and isn't up now: a server error over a server
// stopped or gone. A refused restart keeps its port-busy over a server that
// still runs (D24): that server is up, and the badge and the popup say so.
export function serverDown(record) {
  return SERVER_ERRORS.has(record?.lastError?.code) && DOWN_STATES.has(record?.serverState ?? "stopped");
}
