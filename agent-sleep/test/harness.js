// The fake world the coordinator tests run against (T5, T7): Core terminals,
// Claude session files, Herdr's layout, and the injected hc / exec / files /
// clock. Shared by coordinator.test.js and restart.test.js. Workspace sleep
// (workspace-sleep T3) adds Herdr's run() as `herdrRun` (tab.settle and
// tab.unsettle change the tabs' `settled`), `hc interrupt`, and the `ps` and
// `kill` a hang-up runs: nothing reaches a real process.
import { readFileSync } from "node:fs";
import { Coordinator } from "../mods/agent-sleep/coordinator.js";

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const MIN = 60_000;
export const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
export const COPY = "copy-1"; // which loop copy this is (a popup's clicks name it)
export const HOME = "/Users/demo";
export const APP = `${HOME}/.config/herdr-app`;
export const SLEEPING = `${APP}/agent-sleep/sleeping.json`;
export const SETTINGS = `${APP}/agent-sleep/settings.json`;
// D15: where a Claude's account can be. claude-accounts' list of saved
// accounts (a top-level JSON array), and the three roots of profile folders
// (`<root>/<name>/home`).
export const ACCOUNTS = `${APP}/claude-accounts/accounts.json`;
export const ORCA_DEV_PROFILES = `${HOME}/Library/Application Support/Orca Dev/claude-profiles`;
export const ORCA_PROFILES = `${HOME}/Library/Application Support/Orca/claude-profiles`;
export const HERDR_PROFILES = `${APP}/claude-accounts-profiles`;
// An Orca profile no saved account names, and a saved account outside every
// root (its trailing slash is part of the exact string the launcher keys on).
export const PROFILE = `${ORCA_DEV_PROFILES}/p1/home`;
export const SAVED = "/Volumes/Work Claude/home/";
// claude-exit.txt prints this id under "Resume this session with:".
export const SID1 = "00000000-0000-4000-8000-000000000001";
export const SID2 = "00000000-0000-4000-8000-000000000002";
export const NVM_CLAUDE = "/Users/demo/.nvm/versions/node/v24.14.0/bin/claude";
export const PROC_START = "Fri Nov  6 08:00:00 2026";

export const EMPTY = fixture("claude-after-turn1.txt");
export const SUGGESTION = fixture("claude-after-turn3.txt");
export const DRAFT = fixture("claude-draft.txt");
export const EXIT = fixture("claude-exit.txt");
export const SHELL_BARE = fixture("shell-bare.txt");
export const SHELL_TYPED = fixture("shell-typed.txt");
// workspace-sleep's T0b (Claude Code 2.1.319): an empty prompt line, a one-line
// and a two-line draft, the line after one ctrl+c, and `hc interrupt`'s report.
export const IDLE_319 = fixture("t0b-claude-idle.txt");
export const DRAFT_319 = fixture("t0b-claude-draft.txt");
export const MULTI_319 = fixture("t0b-claude-draft-multi.txt");
export const CLEARED_319 = fixture("t0b-claude-ctrl-c.txt");
export const INTERRUPTED = fixture("t0b-interrupt.json");
export const WORKSPACES = `${APP}/agent-sleep/workspaces.json`;

// ── A fake world: Core terminals, Claude session files, Herdr's layout ─────

// A Claude in a zsh root, as `hc get <t> --json` shows one: finished an
// hour ago, three turns in.
export function claude(address, { pid, fgPid, cwd = "/code/app", flags = ["--dangerously-skip-permissions"], ...over } = {}) {
  return {
    address,
    argv: ["/bin/zsh", "-l"],
    state: "live",
    parent: null,
    pid,
    foreground: { argv: [NVM_CLAUDE, ...flags], cwd, name: "claude.exe", pid: fgPid },
    status: { app: "claude-code", state: "done" },
    status_ms: NOW - 60 * MIN,
    turn: 3,
    ...over,
  };
}

// The same terminal once Claude exited: its root zsh is the foreground.
export function shellOf(t, over = {}) {
  return {
    ...t,
    foreground: { argv: ["/bin/zsh", "-l"], cwd: t.foreground?.cwd ?? "/code/app", name: "zsh", pid: t.pid },
    status: null,
    status_ms: null,
    ...over,
  };
}

export const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "failed") => ({ code: 1, stdout: "", stderr });

export function makeWorld() {
  const w = {
    now: NOW,
    core: {},
    summary: false, // live terminals() shaped like `hc ls --json` (no pid/foreground/status_ms)
    screens: {},
    onRead: null,
    onKey: {},
    onSend: null,
    files: {},
    procStart: {},
    transcripts: new Set(),
    profiles: {}, // a profile root → the folder names in it (no key: the root doesn't exist)
    dirs: new Set(), // the config dirs that exist (`test -d`)
    rss: {},
    holder: "h1",
    spaces: [
      { id: "s1", name: "app", active: true, tabs: [{ id: "front", active: true }, { id: "back", active: false }] },
      { id: "s2", name: "checkout-flow", active: false, tabs: [{ id: "ws2", active: true }] },
    ],
    panes: [
      { pane: "p9", terminal: "t9", tab: "front" },
      { pane: "p1", terminal: "t1", tab: "back" },
      { pane: "p2", terminal: "t2", tab: "ws2" },
    ],
    focused: { space: "s1", tab: "front", pane: "p9", terminal: "t9", shown: null, agent: null, cwd: "/code/app" },
    calls: [],
    execs: [], // every exec, as [cmd, ...args]
    sends: [],
    keys: [],
    notes: [],
    publishes: [],
    shared: {},
    writes: [],
    logs: [],
    runs: [], // herdrRun calls, as [name, args]
    interrupts: [], // `hc interrupt` calls: { address, args }
    onInterrupt: null, // (address, w): what the interrupt did to the world
    interruptReport: null, // its JSON; T0b's by default
    pgids: {}, // a root pid → { pgid, tpgid }, as `ps -o pgid=,tpgid=` prints them
    kills: [], // every `kill`'s args
    onKill: null, // (args, w): what the signal did
  };
  w.core.t9 = shellOf(claude("t9", { pid: 900, fgPid: 900 }));
  w.screens.t9 = SHELL_BARE;
  return w;
}

// A running Claude whose session file passes D3, with its transcript.
// `configDir`: the account it runs in (D15), null for System default
// (~/.claude); its folder exists.
export function addClaude(w, address, { pid, fgPid, sid, screen = EMPTY, cwd = "/code/app", configDir = null, ...over }) {
  w.core[address] = claude(address, { pid, fgPid, cwd, ...over });
  w.screens[address] = screen;
  w.procStart[fgPid] = PROC_START;
  w.transcripts.add(sid);
  w.rss[fgPid] = 307_200;
  if (configDir !== null) w.dirs.add(configDir);
  putSession(w, fgPid, { sessionId: sid, cwd, configDir });
}

// Where Claude writes a session file: <configDir>/sessions/<pid>.json, or
// ~/.claude's for System default.
export const sessionPath = (pid, configDir = null) =>
  `${configDir === null ? `${HOME}/.claude` : configDir.replace(/\/+$/, "")}/sessions/${pid}.json`;

export function putSession(w, pid, { sessionId, cwd = "/code/app", status = "idle", configDir = null }) {
  w.files[sessionPath(pid, configDir)] = JSON.stringify({
    pid, sessionId, cwd, procStart: PROC_START, kind: "interactive", status,
  });
}

// An Orca or Herdr profile folder, `<root>/<name>/home`, as a listing of its
// root shows it. Returns the folder.
export function addProfile(w, root, name) {
  w.profiles[root] = [...(w.profiles[root] ?? []), name];
  const dir = `${root}/${name}/home`;
  w.dirs.add(dir);
  return dir;
}

// claude-accounts' accounts.json: a top-level array of accounts.
export function putAccounts(w, accounts) {
  w.files[ACCOUNTS] = typeof accounts === "string" ? accounts : JSON.stringify(accounts);
}

// Claude ran /exit: the shell is back with the exit screen.
export function exitClaude(w, address, screen = EXIT) {
  w.core[address] = shellOf(w.core[address]);
  w.screens[address] = screen;
}

export function show(w, tab) {
  w.spaces[0].tabs = w.spaces[0].tabs.map((t) => ({ ...t, active: t.id === tab }));
  w.focused = { ...w.focused, tab, pane: null, terminal: null };
}

export function liveTerminals(w) {
  const all = Object.values(w.core);
  if (!w.summary) return all.map((t) => ({ ...t, status: t.status?.state ?? null }));
  return all.map((t) => ({
    address: t.address,
    agent: t.status?.app ?? "zsh",
    cwd: t.foreground?.cwd ?? null,
    state: t.state,
    ...(t.status ? { status: t.status.state } : {}),
    turn: t.turn,
  }));
}

export function deps(w) {
  return {
    copyId: COPY,
    home: HOME,
    appHome: APP,
    now: () => w.now,
    log: (line) => w.logs.push(line),
    notify: (n) => w.notes.push(n),
    shared: (key) => w.shared[key],
    setShared: (key, value) => {
      w.shared[key] = value;
      w.publishes.push({ key, value });
    },
    live: {
      terminals: () => liveTerminals(w),
      spaces: () => w.spaces,
      panes: () => w.panes,
      focused: () => w.focused,
    },
    files: {
      read: async (path) => (Object.hasOwn(w.files, path) ? w.files[path] : null),
      write: async (path, text, expected) => {
        const current = Object.hasOwn(w.files, path) ? w.files[path] : null;
        if (current !== expected) throw new Error(`stale snapshot for ${path}`);
        w.files[path] = text;
        w.writes.push(path);
        return null;
      },
      mkdirp: async () => {},
    },
    hc: async (args) => {
      w.calls.push(args);
      const [cmd, ...rest] = args;
      if (cmd === "get") {
        const t = w.core[rest[0]];
        return t ? ok(JSON.stringify(t)) : fail("no such terminal");
      }
      if (cmd === "read") {
        if (w.onRead) w.onRead(rest[0], w);
        const screen = w.screens[rest[0]];
        return typeof screen === "string" ? ok(screen) : fail("no such terminal");
      }
      if (cmd === "send") {
        const text = rest[rest.length - 1];
        const address = rest[rest.length - 2];
        const opts = rest.slice(0, -2);
        const t = w.core[address];
        if (opts.includes("--if") && t?.status?.state !== opts[opts.indexOf("--if") + 1]) return fail("not idle");
        w.sends.push({ address, text, opts });
        if (w.onSend) w.onSend(address, text, w);
        return ok("");
      }
      if (cmd === "keys") {
        const [address, key] = rest;
        w.keys.push({ address, key });
        const f = w.onKey[address];
        if (f) w.screens[address] = f(key, w.screens[address]);
        return ok("");
      }
      if (cmd === "server") return ok(JSON.stringify({ holder: { instance: w.holder, pid: 1, current: true, terminals: 3 } }));
      if (cmd === "interrupt") {
        const address = rest[0];
        if (!w.core[address]) return fail("no such terminal");
        w.interrupts.push({ address, args: rest.slice(1) });
        if (w.onInterrupt) w.onInterrupt(address, w);
        return ok(w.interruptReport ?? INTERRUPTED);
      }
      return fail(`unknown command ${cmd}`);
    },
    // Herdr's run(): returns null. tab.settle / tab.unsettle put a tab away or
    // bring it back, as T0 saw.
    herdrRun: (name, args) => {
      w.runs.push([name, args]);
      if (name === "tab.settle" || name === "tab.unsettle") {
        for (const s of w.spaces) {
          s.tabs = s.tabs.map((t) => (t.id === args?.id ? { ...t, settled: name === "tab.settle" } : t));
        }
      }
      return null;
    },
    exec: async (cmd, args) => {
      w.execs.push([cmd, ...args]);
      if (cmd === "env" && args[1] === "ps") {
        const s = w.procStart[Number(args.at(-1))];
        return s ? ok(`${s}\n`) : fail();
      }
      if (cmd === "find") {
        // The folder find starts from (after `-H`, which follows it when it is
        // a symlink: a profile's projects/ links to ~/.claude/projects).
        const from = args[0] === "-H" ? args[1] : args[0];
        if (args.includes("-mindepth")) {
          // A profile root's folders.
          const names = w.profiles[from];
          if (!names) return { code: 1, stdout: "", stderr: `find: ${from}: No such file or directory` };
          return ok(names.map((n) => `${from}/${n}\n`).join(""));
        }
        const name = args.at(-1);
        const sid = name.replace(/\.jsonl$/, "");
        return ok(w.transcripts.has(sid) ? `${from}/-code-app/${name}\n` : "");
      }
      if (cmd === "test") return args[0] === "-d" && w.dirs.has(args[1]) ? ok("") : fail("");
      if (cmd === "ps" && args[1] === "pgid=,tpgid=") {
        const g = w.pgids[Number(args.at(-1))];
        return g ? ok(`${String(g.pgid).padStart(5)} ${String(g.tpgid).padStart(5)}\n`) : fail();
      }
      if (cmd === "kill") {
        w.kills.push(args);
        if (w.onKill) w.onKill(args, w);
        return ok("");
      }
      if (cmd === "ps") {
        const kb = w.rss[Number(args.at(-1))];
        return kb ? ok(`  ${kb}\n`) : fail();
      }
      if (cmd === "git") return ok("worktree /code/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /code/checkout-flow\n");
      return fail(`unknown program ${cmd}`);
    },
  };
}

export const records = (w) => (w.files[SLEEPING] ? JSON.parse(w.files[SLEEPING]).records : {});
export const exits = (w) => w.sends.filter((s) => s.text === "/exit");
export const resumes = (w) => w.sends.filter((s) => s.text !== "/exit");

export async function at(co, w, ms) {
  w.now = ms;
  return co.pulse();
}

// Three ticks put an idle hidden Claude to sleep: the first one sees it
// (idle start = first sighting), the second, 30 min later, makes it a
// candidate, the third confirms it and sends /exit. Returns when /exit went.
export async function sleepT1(co, w, start = NOW) {
  await at(co, w, start);
  await at(co, w, start + 30 * MIN);
  await at(co, w, start + 31 * MIN);
  return start + 31 * MIN;
}

// `settings`: what settings.json holds. Automatic sleep is off by default
// (D11), so the world starts with it on; null means no file, a fresh install.
export function setup({ t1 = true, t2 = false, settings = { enabled: true, idleMinutes: 30 } } = {}) {
  const w = makeWorld();
  if (settings) w.files[SETTINGS] = JSON.stringify(settings);
  if (t1) addClaude(w, "t1", { pid: 100, fgPid: 200, sid: SID1 });
  if (t2) addClaude(w, "t2", { pid: 101, fgPid: 201, sid: SID2, cwd: "/code/checkout-flow" });
  return { w, co: new Coordinator(deps(w)) };
}

// ── Workspace sleep (workspace-sleep T3) ───────────────────────────────────

// Herdr's spaces as spaces() and panes() give them, panes with their folder.
// `list`: [{ id, folder?, machine?, tabs: { [tabId]: [[pane, terminal, cwd]] } }];
// a pane whose terminal is null is a mod pane (projects-sidebar's, as
// Inicio's). Every tab starts unsettled, the first of each space its active
// one; `shown` is the shown space.
export function spacesWorld(w, list, shown = list[0]?.id ?? null) {
  w.spaces = list.map((s, i) => ({
    id: s.id,
    index: i + 1,
    name: s.id,
    folder: s.folder ?? "",
    machine: s.machine ?? null,
    active: false,
    tabs: Object.keys(s.tabs).map((id, j) => ({ id, index: j + 1, active: j === 0, settled: false })),
  }));
  w.panes = list.flatMap((s) => Object.entries(s.tabs).flatMap(([tab, panes]) => panes.map(([pane, terminal, cwd]) => ({
    pane, terminal, tab, cwd: cwd ?? null, ...(terminal === null ? { mod: "projects" } : {}),
  }))));
  showSpace(w, shown);
}

// The shown space changes (a click on its row, or the keeper selecting Inicio).
export function showSpace(w, id) {
  w.spaces = w.spaces.map((s) => ({ ...s, active: s.id === id }));
  const tab = w.spaces.find((s) => s.id === id)?.tabs.find((t) => t.active)?.id ?? null;
  w.focused = { space: id, tab, pane: null, terminal: null, shown: null, agent: null, cwd: null };
}

export const settledTabs = (w) => w.spaces.flatMap((s) => s.tabs.filter((t) => t.settled).map((t) => t.id));

// A terminal whose zsh root is in front, at a bare prompt.
export function addShell(w, address, { pid, cwd = "/code/app", ...over }) {
  w.core[address] = { ...shellOf(claude(address, { pid, fgPid: pid, cwd })), ...over };
  w.screens[address] = SHELL_BARE;
}

// A program other than Claude in front of its zsh root (`sleep 300`, `less`):
// its own process group, the terminal's foreground one, as `ps` prints them
// (T0b item 5).
export function addProgram(w, address, { pid, fgPid, name = "sleep", cwd = "/code/app" }) {
  w.core[address] = {
    ...shellOf(claude(address, { pid, fgPid: pid, cwd })),
    foreground: { argv: [name, "300"], cwd, name, pid: fgPid },
  };
  w.screens[address] = "";
  w.pgids[pid] = { pgid: pid, tpgid: fgPid };
}

export const entries = (w) => (w.files[WORKSPACES] ? JSON.parse(w.files[WORKSPACES]).workspaces : {});

// A world for workspace sleep: automatic sleep off (a sleep the person asks
// for works either way, and no tick of its own gets in the way), no Claude yet.
export function workspaceSetup({ settings = { enabled: false, idleMinutes: 30 } } = {}) {
  const w = makeWorld();
  if (settings) w.files[SETTINGS] = JSON.stringify(settings);
  return { w, co: new Coordinator(deps(w)) };
}

export function storeRecord(w, address, over = {}) {
  const current = records(w);
  current[address] = {
    state: "asleep",
    sessionId: SID1,
    cwd: "/code/app",
    flags: ["--dangerously-skip-permissions"],
    workspacePath: "/code/app",
    rssKb: 307_200,
    rootPid: 100,
    holder: "h1",
    at: NOW - 40 * MIN,
    by: "auto",
    ...over,
  };
  w.files[SLEEPING] = `${JSON.stringify({ version: 1, records: current }, null, 2)}\n`;
}
