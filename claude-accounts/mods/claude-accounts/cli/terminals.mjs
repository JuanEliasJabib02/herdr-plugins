// Which account and conversation a Herdr terminal runs (D7, which answers S4:
// no hook needed). Owner: T4. T1 stubs the final exports.
//
//   terminal <t> [--json] → { account, sessionId, status }
//     Exits 64 until T4 fills it.
//
// inspectTerminal(t, known): the D7 chain for one terminal, read when it's
// needed and never cached (`hc get <t> --json`, then
// <configDir>/sessions/<foreground.pid>.json over every known config dir).
// Every hc call runs with HC_TERMINAL_ID removed from its env.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T4)`), { exitCode: 64 });

export async function terminal(_args) {
  throw notYet();
}

export async function inspectTerminal(_t, _known) {
  throw notYet("terminals.inspectTerminal");
}
