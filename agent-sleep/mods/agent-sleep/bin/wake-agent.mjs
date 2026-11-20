// wake-agent's entry on Node (awake-agent D5): bin/wake-agent runs it. The
// logic is ../wake-cli.js, pure; this file only wires node's files,
// programs and clock into it. The mod never imports it.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { main } from "../wake-cli.js";

// Runs `file args` without a shell: { code, stdout, stderr }. A non-zero exit
// resolves with its code, a timeout with 124; it rejects only when the
// program can't start (ENOENT). As spotlight's cli-env.mjs exec: a plugin is
// installed alone, so it can't import spotlight's.
function exec(file, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
      if (err.killed || err.signal) return resolve({ code: 124, stdout, stderr: stderr || `${file} timed out` });
      reject(err);
    });
  });
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

const home = os.homedir();

main(process.argv.slice(2), {
  exec,
  readText,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  home,
  // The plugin's home: HERDR_APP_HOME, else ~/.config/herdr-app.
  appHome: process.env.HERDR_APP_HOME || path.join(home, ".config", "herdr-app"),
  cwd: process.cwd(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`wake-agent: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  },
);
