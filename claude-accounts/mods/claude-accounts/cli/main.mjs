// claude-accounts: the CLI that holds all of the plugin's logic (D1). The mod
// only draws and calls this with exec; Spotlight and the launcher read its
// files. bin/claude-accounts imports this file, so it runs on import: tests
// spawn the bin, they never import it.
//
//   claude-accounts <command> [args] [--json]
//   claude-accounts --version
//
// The command table below is final (T1). Each command lives in its module and
// gets the args after its name. It parses them itself, with node:util
// parseArgs and strict: true, so a later task adds a flag without touching
// this file. It returns an exit code (D9's table), or throws: an Error with
// an `exitCode` exits with that code, and a parseArgs error (an unknown flag,
// a missing value) exits 64. Anything else is a bug and exits 1.

import * as accounts from "./accounts.mjs";
import * as usage from "./usage.mjs";
import * as terminals from "./terminals.mjs";
import * as restart from "./restart.mjs";
import * as details from "./details.mjs";

const VERSION = "0.1.0";

// sysexits EX_USAGE: an unknown command, a bad flag, a missing argument.
const EX_USAGE = 64;

const COMMANDS = {
  list: accounts.list,
  use: accounts.use,
  remove: accounts.remove,
  login: accounts.login,
  "import-orca": accounts.importOrca,
  settings: accounts.settings,
  usage: usage.usage,
  terminal: terminals.terminal,
  restart: restart.restart,
  resume: restart.resume,
  details: details.details,
};

const USAGE = [
  "usage: claude-accounts <command> [args] [--json]",
  "       claude-accounts --version",
  `commands: ${Object.keys(COMMANDS).join(", ")}`,
].join("\n");

const say = (text) => process.stderr.write(`${text}\n`);

async function main(argv) {
  const [name, ...args] = argv;
  if (name === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const run = Object.hasOwn(COMMANDS, name ?? "") ? COMMANDS[name] : null;
  if (!run) {
    say(`claude-accounts: ${name === undefined ? "no command" : `unknown command "${name}"`}`);
    say(USAGE);
    return EX_USAGE;
  }
  try {
    const code = await run(args);
    return Number.isInteger(code) ? code : 0;
  } catch (e) {
    if (typeof e?.code === "string" && e.code.startsWith("ERR_PARSE_ARGS_")) {
      say(`claude-accounts ${name}: ${e.message}`);
      return EX_USAGE;
    }
    if (Number.isInteger(e?.exitCode)) {
      say(`claude-accounts ${name}: ${e.message}`);
      return e.exitCode;
    }
    say(`claude-accounts ${name}: ${e?.stack ?? e}`);
    return 1;
  }
}

// exitCode, not exit(): a command's pending work (a detached runner's spawn,
// a write) finishes before the process ends.
process.exitCode = await main(process.argv.slice(2));
