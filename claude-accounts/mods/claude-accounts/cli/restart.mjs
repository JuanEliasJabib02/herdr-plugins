// Moving running Claude terminals to another account (D8, D9). Owner: T4.
// T1 stubs the final exports: every command exits 64 until T4 fills it.
//
// Commands:
//   restart --detach                   the detached runner: claims its items
//                                      in restart.json under the lock, one
//                                      async loop per terminal
//   restart --cancel <t>               drops a terminal's queued item
//   resume --terminal <t> --account <id|default> [--message <text>] [--wait <s>]
//   resume --status <job>
//   resume --cancel <job>
//     asynchronous: validates, queues a job, spawns its own runner and exits
//     0 with {"job": "<id>"} (D9's codes and states).
//
// afterUse(from, to): called by accounts.use once `active` is written. It
// splits the Claude terminals (onAccount, elsewhere, cantMove) and applies
// settings.switchMode: restart queues the onAccount ones and spawns a runner,
// ask writes pending-switch.json, keep does nothing.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T4)`), { exitCode: 64 });

export async function restart(_args) {
  throw notYet();
}

export async function resume(_args) {
  throw notYet();
}

export async function afterUse(_from, _to) {
  throw notYet("restart.afterUse");
}
