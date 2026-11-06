// Usage details & history (D11, S7). Owner: T10. T1 stubs the final export.
//
//   details --range <7|30|90|all> [--json]
//     Runs claude-usage --json (paths.usageBin) detached into details.json,
//     because its run time against exec's 30 s is unmeasured. Exits 64 until
//     T10 fills it.

const notYet = (what) => Object.assign(new Error(`${what ? `${what}: ` : ""}not implemented yet (T10)`), { exitCode: 64 });

export async function details(_args) {
  throw notYet();
}
