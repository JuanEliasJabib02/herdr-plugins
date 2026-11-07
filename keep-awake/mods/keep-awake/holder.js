// The one caffeinate that keeps the Mac awake (plan D1, D2, D3, D6, D7).
// Pure: no "herdr" import. main.js hands it Herdr's exec, readTextFile,
// writeTextFile, a mkdir and a clock:
//
//   new Holder({
//     exec: (cmd, args) => exec(cmd, args),          // → { code, stdout, stderr }
//     read: (path) => readTextFile(path),            // → text | null
//     write: (path, text, expected) => writeTextFile(path, text, expected),
//     mkdirp: (dir) => exec("mkdir", ["-p", dir]),
//     appHome: appHome(),
//     now: () => Date.now(),                         // optional
//     log: (line) => console.log(`keep-awake: ${line}`), // optional
//   })
//
// and calls `tick(wanted, now)` every second from the loop copy; it resolves
// to whether this copy holds a caffeinate now. `release()` is for close().
//
// D1  `/usr/bin/caffeinate -i -s -w <Herdr app pid>`, started detached
//     through sh (exec has a 30 s limit); the sh prints its pid. `-w` ends it
//     when Herdr ends, so a crash or a quit never leaves one behind.
// D2  The Herdr app's pid: the sh's $PPID, or its nearest ancestor whose
//     command ends in /Contents/MacOS/Herdr. Unknown → nothing is started
//     (never a caffeinate without -w) and the status reads Inactive.
// D3  One caffeinate for every window: its pid is in
//     appHome()/keep-awake/caffeinate.pid, written compare-and-swap. A copy
//     finding a live one there adopts it; a copy that started one and lost
//     the swap kills its own. A pid is ours only while `ps` shows exactly
//     this Herdr's caffeinate command line: any other (a reused pid, Orca's
//     own caffeinate) is forgotten, never killed.
// D6  A change of `wanted` is acted on at that tick; a held one is looked at
//     every LIVENESS_MS and started again if it died; a failed start waits
//     RETRY_MS. Mode off runs nothing at all.
// D7  release() kills the one this copy holds (started or adopted) and
//     clears the file; another window's copy starts a new one at its next
//     liveness check.

export const CAFFEINATE = "/usr/bin/caffeinate";
// D1 verbatim: "$1" is the Herdr pid, passed as a positional argument.
export const SPAWN_SCRIPT = 'nohup /usr/bin/caffeinate -i -s -w "$1" </dev/null >/dev/null 2>&1 & echo $!';
export const LIVENESS_MS = 15_000;
// Orca's MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS.
export const RETRY_MS = 30_000;
export const HERDR_APP_SUFFIX = "/Contents/MacOS/Herdr";
// How far up from the sh the Herdr app is looked for (D2).
const MAX_HOPS = 8;

export function paths(appHome) {
  const dir = `${String(appHome).replace(/\/+$/, "")}/keep-awake`;
  return { dir, pid: `${dir}/caffeinate.pid` };
}

// A positive whole number alone (surrounding whitespace allowed), else null.
export function parsePid(text) {
  const m = /^\s*(\d+)\s*$/.exec(String(text ?? ""));
  const pid = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// What `ps -o command=` shows for the caffeinate this Herdr starts.
export function caffeinateCommand(herdrPid) {
  return `${CAFFEINATE} -i -s -w ${herdrPid}`;
}

const reason = (e) => (e instanceof Error ? e.message : String(e));

export class Holder {
  constructor({ exec, read, write, mkdirp, appHome, now = () => Date.now(), log = () => {} }) {
    this.io = { exec, read, write, mkdirp };
    this.paths = paths(appHome);
    this.now = now;
    this.log = log;
    this.pid = null; // the caffeinate this copy holds, started or adopted
    this.herdrPid = null; // the Herdr app's, once found (it doesn't change)
    this.checkedAt = 0; // when the held one was last seen alive
    this.retryAt = 0; // no start before this (a failed one, D6)
    this.busy = null; // the tick in flight
    this.closed = false; // released: holds nothing from now on
  }

  get holding() {
    return this.pid !== null;
  }

  // Resolves to whether this copy holds a caffeinate after the tick. A tick
  // asked for while one is in flight gets that one's result: never two
  // starts at once from one copy.
  tick(wanted, now = this.now()) {
    if (this.closed) return Promise.resolve(false);
    if (this.busy) return this.busy;
    this.busy = this.step(Boolean(wanted), now)
      .catch((e) => {
        this.log(`tick: ${reason(e)}`);
        return this.holding;
      })
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  // For close(): a tick in flight ends first, so what it started goes too.
  async release() {
    this.closed = true;
    if (this.busy) await this.busy;
    try {
      await this.drop();
    } catch (e) {
      this.log(`release: ${reason(e)}`);
    }
  }

  async step(wanted, now) {
    if (!wanted) {
      if (this.holding) await this.drop();
      return false;
    }
    if (this.holding) {
      if (now - this.checkedAt < LIVENESS_MS) return true;
      const alive = await this.isOurs(this.pid);
      this.checkedAt = now;
      // ps couldn't run (null): keep it rather than start a second one.
      if (alive !== false) return true;
      this.log(`caffeinate ${this.pid} is gone`);
      this.pid = null;
    }
    if (now < this.retryAt) return false;
    return this.acquire(now);
  }

  // Adopts the file's caffeinate, or starts one and claims the file.
  async acquire(now) {
    const herdr = await this.findHerdr();
    if (herdr === null) return this.fail(now, "the Herdr app's pid is unknown: nothing started");
    let text;
    try {
      text = await this.io.read(this.paths.pid);
    } catch (e) {
      return this.fail(now, `reading ${this.paths.pid}: ${reason(e)}`);
    }
    const listed = parsePid(text);
    if (listed !== null) {
      const ours = await this.isOurs(listed);
      if (ours === true) return this.hold(listed, now);
      // Without ps there's no telling whether it's alive: start no second one.
      if (ours === null) return this.fail(now, `can't look at caffeinate ${listed}`);
    }
    const started = await this.spawn(herdr);
    if (started === null) return this.fail(now, "caffeinate didn't start");
    try {
      await this.io.mkdirp?.(this.paths.dir);
      await this.io.write(this.paths.pid, `${started}\n`, text ?? null);
      return this.hold(started, now);
    } catch (e) {
      // One caffeinate for every window: this one goes.
      await this.kill(started);
      let after;
      try {
        after = await this.io.read(this.paths.pid);
      } catch {
        after = text;
      }
      // Nobody else wrote: the file can't be written (not a race).
      if ((after ?? null) === (text ?? null)) return this.fail(now, `writing ${this.paths.pid}: ${reason(e)}`);
      // Another copy won the swap: hold its caffeinate, or look again next tick.
      const winner = parsePid(after);
      if (winner !== null && (await this.isOurs(winner)) === true) return this.hold(winner, now);
      return false;
    }
  }

  // Kills the held one if it's still ours, and clears the file if it still
  // names it (a file naming another copy's caffeinate is left alone).
  async drop() {
    const pid = this.pid;
    if (pid === null) return;
    this.pid = null;
    if ((await this.isOurs(pid)) === true) await this.kill(pid);
    let text;
    try {
      text = await this.io.read(this.paths.pid);
    } catch {
      return;
    }
    if (parsePid(text) !== pid) return;
    try {
      await this.io.write(this.paths.pid, "", text);
    } catch {
      // Another copy wrote first: what it wrote stays.
    }
  }

  hold(pid, now) {
    this.pid = pid;
    this.checkedAt = now;
    return true;
  }

  fail(now, why) {
    this.retryAt = now + RETRY_MS;
    this.log(why);
    return false;
  }

  // exec that never rejects: null when the program couldn't start.
  async run(cmd, args) {
    try {
      return await this.io.exec(cmd, args);
    } catch (e) {
      this.log(`${cmd}: ${reason(e)}`);
      return null;
    }
  }

  // true: `ps` shows this Herdr's caffeinate at that pid; false: it's gone
  // or another program; null: ps couldn't run.
  async isOurs(pid) {
    const r = await this.run("ps", ["-p", String(pid), "-o", "command="]);
    if (r === null) return null;
    return r.code === 0 && String(r.stdout).trim() === caffeinateCommand(this.herdrPid);
  }

  async spawn(herdr) {
    const r = await this.run("/bin/sh", ["-c", SPAWN_SCRIPT, "sh", String(herdr)]);
    return r && r.code === 0 ? parsePid(r.stdout) : null;
  }

  async kill(pid) {
    await this.run("kill", [String(pid)]);
  }

  // D2: the sh's $PPID, or the nearest ancestor that is the Herdr app.
  async findHerdr() {
    if (this.herdrPid !== null) return this.herdrPid;
    const sh = await this.run("/bin/sh", ["-c", "echo $PPID"]);
    let pid = sh && sh.code === 0 ? parsePid(sh.stdout) : null;
    for (let hop = 0; pid !== null && pid > 1 && hop < MAX_HOPS; hop++) {
      const r = await this.run("ps", ["-p", String(pid), "-o", "ppid=,comm="]);
      const m = r && r.code === 0 ? /^\s*(\d+)\s+(.+?)\s*$/.exec(String(r.stdout)) : null;
      if (!m) return null;
      if (m[2].endsWith(HERDR_APP_SUFFIX)) {
        this.herdrPid = pid;
        return pid;
      }
      pid = Number(m[1]);
    }
    return null;
  }
}
