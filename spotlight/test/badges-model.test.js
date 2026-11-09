// T10: Spotlight's badges on projects-sidebar's workspace rows (D2, D17),
// built by M/badges-model.js from state.json, settings.json and the shared
// projects.v1 / projects.cache.v1 values, and published under
// badges.spotlight only when the value changes. Every badge has to pass
// projects-sidebar's contract (its RECIPE.md "Badges from other plugins"):
// icon `mods/<mod>/…/<name>.svg`, text ≤ 16 code points, tooltip ≤ 200, at
// most 3 per plugin on a row, `command` = `spotlight.<…>` matching its
// regex, `exec` argv0 absolute.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha1Hex, serverIdOf, parseProjects, parseCache, buildBadges, nextPublish, canonicalJson,
  attempt,
} from "../mods/spotlight/badges-model.js";
import { cliPathOf, readState, readSettings } from "../mods/spotlight/board-model.js";
import { serverId } from "../mods/spotlight/cli-work.mjs";

const MOD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mods", "spotlight");
const APP = "/Users/u/.config/herdr-app";
const BIN = cliPathOf(APP);

const BACK = "/Users/u/code/back";
const FRONT = "/Users/u/code/front";
const OTHER = "/Users/u/code/other"; // registered, not enabled
const WS = "/Users/u/orca/workspaces";
const B1 = `${WS}/back/ax-3447`; // the holder of back
const B2 = `${WS}/back/ax-3500`;
const F1 = `${WS}/front/ax-3447`;
const F2 = `${WS}/front/login`;
const O1 = `${WS}/other/ax-3447`;

const at = (h, m, s) => new Date(2026, 10, 6, h, m, s).getTime();

const projects = parseProjects({
  version: 1,
  groups: [
    { id: "ax", name: "AX", projects: [{ path: BACK, name: "back" }, { path: FRONT, name: "front" }, { path: OTHER, name: "other" }] },
  ],
});
const cache = parseCache({
  [BACK]: [
    { path: BACK, branch: "main", main: true },
    { path: B1, branch: "juan/AX-3447", main: false },
    { path: B2, branch: "juan/AX-3500", main: false },
  ],
  [FRONT]: [
    { path: FRONT, branch: "main", main: true },
    { path: F1, branch: "juan/AX-3447", main: false },
    { path: F2, branch: "login", main: false },
  ],
  [OTHER]: [
    { path: OTHER, branch: "main", main: true },
    { path: O1, branch: "juan/AX-3447", main: false },
  ],
});
const enabled = { [BACK]: true, [FRONT]: true, [OTHER]: false };

function repo(fields) {
  return {
    holder: null, lastSnapshotSha: "a".repeat(40), lastSyncAt: null, lastError: null, serverTerminal: null, serverPid: null,
    serverStartedAt: null, serverCommand: null, serverEnv: null, serverVariant: null, serverState: "stopped",
    pendingInstalls: [], ports: [], logPath: null, ...fields,
  };
}

const member = (root, name, workspace) => ({ root, name, workspace, workspaces: [workspace] });

// back is lit by AX-3447's holder B1 and listening on 3000 and 3001; AX-3447
// holds its turn; AX-3500 waits behind it in the same space.
function baseState(over = {}) {
  return {
    version: 1,
    repos: {
      [BACK]: repo({
        holder: B1, lastSyncAt: at(22, 58, 4), serverTerminal: "t9", serverCommand: "pnpm dev --port 3000", serverEnv: "local",
        serverState: "listening", ports: [3000, 3001],
      }),
    },
    queue: {
      requests: [
        {
          terminal: "t1", taskKey: "ax/AX-3447", label: "AX-3447", lane: "ax", state: "holding", requestedAt: 1, grantedAt: 2,
          members: [member(BACK, "back", B1), member(FRONT, "front", F1)], workspace: B1, root: BACK,
        },
        {
          terminal: "t2", taskKey: "ax/AX-3500", label: "AX-3500", lane: "ax", state: "waiting", requestedAt: 3, grantedAt: null,
          members: [member(BACK, "back", B2)], workspace: B2, root: BACK,
        },
      ],
      lighting: {},
    },
    notes: [],
    variants: {},
    ...over,
  };
}

const settingsOf = (raw = { version: 1 }) => readSettings(JSON.stringify(raw));

function build(state = baseState(), settings = settingsOf()) {
  return buildBadges({ state, settings, projects, cache, enabled, bin: BIN });
}

const icons = (list) => (list ?? []).map((b) => path.basename(b.icon, ".svg"));

// projects-sidebar's checks, as its badges-model.js applies them.
const COMMAND = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;
const codePoints = (s) => [...s].length;
function assertContract(value) {
  for (const [at, list] of Object.entries(value)) {
    assert.ok(at.startsWith("/") && !at.endsWith("/"), `absolute path without trailing slash: ${at}`);
    assert.ok(Array.isArray(list) && list.length >= 1 && list.length <= 3, `1..3 badges on ${at}`);
    for (const b of list) {
      assert.match(b.icon, /^mods\/spotlight\/icons\/[a-z-]+\.svg$/);
      assert.ok(fs.existsSync(path.join(MOD_DIR, "icons", path.basename(b.icon))), `${b.icon} exists`);
      if (b.text !== undefined) assert.ok(codePoints(b.text) <= 16 && !/\s{2}|\n/.test(b.text), `text "${b.text}"`);
      assert.ok(["accent", "dim", "working", "blocked", "done"].includes(b.tone), `tone ${b.tone}`);
      assert.ok(typeof b.tooltip === "string" && codePoints(b.tooltip) <= 200 && !/\n/.test(b.tooltip), `tooltip "${b.tooltip}"`);
      // D29: `spin` is true or absent.
      if (b.spin !== undefined) assert.equal(b.spin, true, `spin on ${b.icon}`);
      const { action } = b;
      if (action === undefined) {
        // The queue badges click like their row; the busy ring (D33) has no action.
        assert.ok(["flask", "clock", "pause", "spinner"].includes(path.basename(b.icon, ".svg")), "only queue badges and the ring have no action");
        continue;
      }
      assert.ok((action.command === undefined) !== (action.exec === undefined), "exactly one of command / exec");
      if (action.command !== undefined) {
        assert.match(action.command, COMMAND);
        assert.equal(action.command.split(".")[0], "spotlight");
      } else {
        assert.ok(action.exec.length >= 1 && action.exec.length <= 20);
        assert.ok(action.exec[0].startsWith("/"), "argv0 absolute");
        assert.ok(action.exec.every((a) => typeof a === "string" && a.length <= 500 && !a.includes("\0")));
      }
    }
  }
}

test("ids: the server badge's id is the CLI's serverId (sha1 of the path, 12 hex)", () => {
  assert.equal(sha1Hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  for (const p of [B1, BACK, `${WS}/back/ñandú-ü`, `${WS}/x/${"a".repeat(130)}`, "/x/🚀/y"]) {
    assert.equal(serverIdOf(p), serverId(p));
    assert.equal(serverIdOf(`${p}/`), serverId(p));
  }
  assert.match(serverIdOf(B1), /^[0-9a-f]{12}$/);
});

test("holder and root rows: amber flashlight, the server's port, and the holder's flask", () => {
  const { value } = build();
  assert.deepEqual(icons(value[B1]), ["flashlight", "server", "flask"]);
  assert.deepEqual(icons(value[BACK]), ["flashlight", "server"]);

  const [light, server, flask] = value[B1];
  assert.equal(light.tone, "working", "amber: Herdr's accent is blue in its default theme");
  assert.equal(light.tooltip, "Spotlight · sincronizado 22:58:04");
  assert.deepEqual(light.action, { exec: [BIN, "toggle", "--workspace", B1] });
  assert.equal(value[BACK][0].tone, "working");
  assert.equal(value[BACK][0].tooltip, "Spotlight · ax-3447 · sincronizado 22:58:04");
  assert.deepEqual(value[BACK][0].action, { exec: [BIN, "toggle", "--workspace", BACK] });

  assert.equal(server.text, ":3000+1");
  assert.equal(server.tone, "done");
  assert.equal(server.tooltip, "local · pnpm dev --port 3000 · http://localhost:3000 http://localhost:3001");
  assert.deepEqual(server.action, { command: `spotlight.server.${serverIdOf(B1)}` });
  assert.deepEqual(value[BACK][1].action, { command: `spotlight.server.${serverIdOf(BACK)}` });

  assert.equal(flask.tone, "working");
  assert.equal(flask.tooltip, "Probando");
  assert.equal(flask.text, undefined);
});

test("the configured port wins the label when it listens", () => {
  const settings = settingsOf({ version: 1, repos: { [BACK]: { port: 3001 } } });
  assert.equal(build(baseState(), settings).value[B1][1].text, ":3001+1");
  const one = baseState();
  one.repos[BACK].ports = [5173];
  assert.equal(build(one).value[B1][1].text, ":5173");
});

test("server states: starting, stopped, gone, needs-variant, no command", () => {
  const with_ = (fields) => {
    const s = baseState();
    Object.assign(s.repos[BACK], fields);
    return build(s).value[B1][1];
  };
  const starting = with_({ serverState: "starting", ports: [] });
  assert.equal(starting.text, "…");
  assert.equal(starting.tone, "working");
  assert.equal(starting.tooltip, "Arrancando · local · pnpm dev --port 3000");
  for (const state of ["stopped", "gone"]) {
    const b = with_({ serverState: state, ports: [] });
    assert.equal(b.tone, "blocked");
    assert.equal(b.text, undefined);
  }
  assert.equal(with_({ serverState: "gone", ports: [] }).tooltip, "Server cerrado · clic para reiniciarlo");
  assert.equal(with_({ serverState: "stopped", ports: [] }).tooltip, "Server parado · local · pnpm dev --port 3000");
  const ask = with_({ serverState: "needs-variant", serverCommand: null, ports: [] });
  assert.equal(ask.text, "?");
  assert.equal(ask.tone, "accent");
  assert.equal(ask.tooltip, "Elige una variante: clic para abrir el server");
  const none = with_({ serverState: "stopped", serverCommand: null, serverTerminal: null, ports: [] });
  assert.equal(none.tone, "dim");
  assert.equal(none.tooltip, "Sin server · clic para elegir uno");
});

test("dim flashlights on the other workspaces of enabled repos; none on disabled repos or idle roots", () => {
  const { value } = build();
  assert.deepEqual(icons(value[B2]), ["flashlight", "clock"]);
  assert.equal(value[B2][0].tone, "dim");
  assert.equal(value[B2][0].tooltip, "Spotlight · proyectar aquí (ahora ax-3447)");
  assert.deepEqual(value[B2][0].action, { exec: [BIN, "toggle", "--workspace", B2] });
  // front: enabled, nothing lit there.
  assert.deepEqual(icons(value[F2]), ["flashlight"]);
  assert.equal(value[F2][0].tooltip, "Spotlight · encender aquí");
  assert.equal(value[FRONT], undefined, "an idle root has no badge");
  // F1 is AX-3447's member in front: dim flashlight plus the task's flask.
  assert.deepEqual(icons(value[F1]), ["flashlight", "flask"]);
  // other: not enabled.
  assert.equal(value[OTHER], undefined);
  assert.equal(value[O1], undefined);
});

test("attempt: a check that throws, at once or later, reads as the fallback", async () => {
  assert.equal(await attempt(async () => true, false), true);
  assert.equal(await attempt(() => { throw new Error("outside the window's home"); }, false), false);
  assert.equal(await attempt(async () => { throw new Error("no such file"); }, false), false);
});

test("an error turns the flashlight red with its text; a root with an error and no holder opens the popup", () => {
  const s = baseState();
  s.repos[BACK].lastError = { code: "root-diverged", message: "The repository root moved off the Spotlight snapshot.", at: 5 };
  const { value } = build(s);
  for (const at of [B1, BACK]) {
    assert.equal(value[at][0].tone, "blocked");
    assert.equal(value[at][0].tooltip, "Root desviado: abre el server para forzar");
  }
  const failed = baseState();
  failed.repos = { [FRONT]: repo({ lastError: { code: "git-failed", message: "git exploded", at: 5 } }) };
  const out = build(failed);
  assert.deepEqual(icons(out.value[FRONT]), ["flashlight"]);
  assert.equal(out.value[FRONT][0].tone, "blocked");
  assert.equal(out.value[FRONT][0].tooltip, "Spotlight: git exploded");
  assert.deepEqual(out.value[FRONT][0].action, { command: `spotlight.server.${serverIdOf(FRONT)}` });
});

test("a server that didn't come up (D24, D25): the server badge is red and its tooltip is the error's message, also before any server ran", () => {
  const exited = { code: "server-exited", message: "El server se cayó al arrancar: SyntaxError: Unexpected token ';'", at: 5 };
  const busy = {
    code: "port-busy", port: 3008, pid: 900, command: "next-server (v16.0.1)", cwd: "/Users/u/old",
    message: "El puerto 3008 lo tiene next-server (v16.0.1) (pid 900, en /Users/u/old).", at: 5,
  };
  for (const lastError of [exited, busy]) {
    const s = baseState();
    Object.assign(s.repos[BACK], { serverState: "stopped", ports: [], lastError });
    const { value } = build(s);
    for (const at of [B1, BACK]) {
      const server = value[at][1];
      assert.equal(server.tone, "blocked", lastError.code);
      assert.equal(server.tooltip, lastError.message);
      assert.deepEqual(server.action, { command: `spotlight.server.${serverIdOf(at)}` });
      assert.equal(value[at][0].tone, "blocked");
      assert.equal(value[at][0].tooltip, `Spotlight: ${lastError.message}`);
    }
    assertContract(value);
  }
  // A start refused before any server ran (no command, no terminal yet)
  // says why, not "Sin server".
  const first = baseState();
  Object.assign(first.repos[BACK], { serverState: "stopped", serverCommand: null, serverTerminal: null, ports: [], lastError: busy });
  assert.equal(build(first).value[B1][1].tooltip, busy.message);
  assert.equal(build(first).value[B1][1].tone, "blocked");
  // Listening again: the port badge, whatever an older error says.
  const back = baseState();
  back.repos[BACK].lastError = exited;
  assert.equal(build(back).value[B1][1].text, ":3000+1");
});

// F6, F7: a server error under a root error (lastError.serverError). The
// badges show the error on top: the root's, on the flashlight; the server
// badge reads the server as stopped, not the error under it.
test("a server error under a root error: the badges show the root error on top", () => {
  const ORCA = { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 5 };
  const busy = { code: "port-busy", port: 3008, pid: null, command: null, cwd: null, message: "El puerto 3008 estaba ocupado al arrancar el server.", at: 4 };
  const s = baseState();
  Object.assign(s.repos[BACK], { serverState: "stopped", ports: [], lastError: { ...ORCA, serverError: busy } });
  const { value } = build(s);
  for (const at of [B1, BACK]) {
    assert.equal(value[at][0].tone, "blocked");
    assert.equal(value[at][0].tooltip, `Spotlight: ${ORCA.message}`);
    assert.equal(value[at][1].tone, "blocked");
    assert.notEqual(value[at][1].tooltip, busy.message);
  }
  assertContract(value);
});

// D33: while a light, a turn-off, a Forzar sync or a restart works on a
// repo, its flashlight is M's own ring, spinning, with no action.
const RING = { icon: "mods/spotlight/icons/spinner.svg", tone: "working", tooltip: "Sincronizando…", spin: true };

test("D33: a busy repo: the ring replaces the flashlight on the holder's and the root's rows, and on the target's; it spins, reads 'Sincronizando…' and has no action", () => {
  // A Forzar sync of the holder: its row and the root's spin; the server
  // badge and the queue's flask stay; the other workspaces keep their dim
  // flashlight, which still toggles.
  const s = baseState();
  s.repos[BACK].busy = { op: "sync", since: 5, pid: 4242, workspace: B1 };
  const { value } = build(s);
  assert.deepEqual(icons(value[B1]), ["spinner", "server", "flask"]);
  assert.deepEqual(icons(value[BACK]), ["spinner", "server"]);
  for (const at of [B1, BACK]) assert.deepEqual(value[at][0], RING, at);
  assert.equal(value[B1][1].text, ":3000+1");
  assert.deepEqual(icons(value[B2]), ["flashlight", "clock"]);
  assert.deepEqual(value[B2][0].action, { exec: [BIN, "toggle", "--workspace", B2] });
  assertContract(value);

  // A takeover in flight: the target spins too, in its flashlight's place.
  const takeover = baseState();
  takeover.repos[BACK].busy = { op: "light", since: 5, pid: 4242, workspace: B2 };
  const moving = build(takeover).value;
  for (const at of [B1, BACK, B2]) assert.deepEqual(moving[at][0], RING, at);
  assert.deepEqual(icons(moving[B2]), ["spinner", "clock"]);
  assertContract(moving);

  // A fresh light: no holder yet (the record made for the mark). The
  // target's row spins before it holds; the root, not lit, has no badge.
  const fresh = baseState();
  fresh.repos[FRONT] = repo({ busy: { op: "light", since: 5, pid: 4242, workspace: F2 } });
  const lighting = build(fresh).value;
  assert.deepEqual(lighting[F2], [RING]);
  assert.equal(lighting[FRONT], undefined);
  assert.deepEqual(icons(lighting[F1]), ["flashlight", "flask"], "another workspace of the repo keeps its flashlight");
  assertContract(lighting);

  // A target the worktree cache doesn't list yet still spins.
  const unlisted = `${WS}/front/brand-new`;
  fresh.repos[FRONT].busy.workspace = unlisted;
  assert.deepEqual(build(fresh).value[unlisted], [RING]);

  // A refused fresh activation retried (Proyectar igual): the root's red
  // flashlight spins until it's decided.
  const retry = baseState();
  retry.repos[FRONT] = repo({ lastError: { code: "untracked-collision", message: "x", at: 5 }, busy: { op: "light", since: 5, pid: 4242, workspace: F2 } });
  const retried = build(retry).value;
  assert.deepEqual(retried[FRONT], [RING]);
  assert.deepEqual(retried[F2], [RING]);
  assertContract(retried);

  // A turn-off from the root's row (no workspace to name): the lit rows spin.
  const off = baseState();
  off.repos[BACK].busy = { op: "off", since: 5, pid: 4242, workspace: null };
  const going = build(off).value;
  for (const at of [B1, BACK]) assert.deepEqual(going[at][0], RING, at);

  // The ring's rows still resolve the server popup's id.
  assert.equal(build(fresh).servers[serverIdOf(unlisted)]?.root, FRONT);
});

// F9, G6: one oneLine, in text.js, for the mod's models and the CLI's
// modules alike (ports.js folded ps's start times with a copy of it).
test("G6: one oneLine (text.js) flattens whitespace to single spaces; the badges, the popup, ports.js and the CLI import it and fold none themselves", async () => {
  const { oneLine } = await import("../mods/spotlight/text.js");
  assert.equal(oneLine("  a\n\tb   c "), "a b c");
  assert.equal(oneLine(42), "42");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine(undefined), "");
  for (const file of ["badges-model.js", "server-view-model.js", "ports.js", "cli-work.mjs"]) {
    const src = fs.readFileSync(path.join(MOD_DIR, file), "utf8");
    assert.match(src, /import \{[^}]*\boneLine\b[^}]*\} from "\.\/text\.js";/, `${file} imports it`);
    assert.doesNotMatch(src, /\.replace\(\/\\s\+\/g, " "\)/, `${file} folds whitespace itself`);
  }
});

// R9: the server errors were spelled three times (the CLI, the badges, the
// popup); one constant now, which the three import. G9: the turn-off's
// (server-survived, server-not-stopped) are never on a record, so they are
// another set: SERVER_ERRORS drives serverDown, the popup's actions and the
// record's two-error stack, none of which they reach.
test("G9: a record's server errors (port-busy, server-exited, server-start-failed) are one constant, imported by the CLI, the badges and the popup; the turn-off's are another", async () => {
  const { SERVER_ERRORS, TURN_OFF_ERRORS, isServerError, serverDown } = await import("../mods/spotlight/server-errors.js");
  assert.deepEqual([...SERVER_ERRORS].sort(), ["port-busy", "server-exited", "server-start-failed"]);
  assert.deepEqual([...(TURN_OFF_ERRORS ?? [])].sort(), ["server-not-stopped", "server-survived"]);
  for (const code of SERVER_ERRORS) {
    assert.equal(isServerError({ code }), true, code);
    assert.equal(serverDown({ serverState: "stopped", lastError: { code } }), true, code);
  }
  for (const code of TURN_OFF_ERRORS ?? []) assert.equal(isServerError({ code }), false, code);
  for (const file of ["cli-work.mjs", "badges-model.js", "server-view-model.js"]) {
    const src = fs.readFileSync(path.join(MOD_DIR, file), "utf8");
    assert.match(src, /from "\.\/server-errors\.js";/, `${file} imports it`);
    assert.doesNotMatch(src, /"port-busy",\s*"server-exited"/, `${file} spells the set itself`);
  }
});

test("queue badges: queued #N with its reason, paused for the limit or sign-in, none with the queue off", () => {
  const { value } = build();
  const clock = value[B2][1];
  assert.equal(clock.text, "#1");
  assert.equal(clock.tone, "dim");
  assert.equal(clock.tooltip, "En cola #1 · repo ocupado");

  const lane = baseState();
  lane.queue.requests[1].members = [member(FRONT, "front", F2)];
  lane.queue.requests[1].workspace = F2;
  lane.queue.requests[0].members = [member(BACK, "back", B1)];
  lane.queue.requests.push({
    terminal: "t3", taskKey: "ax/login", label: "login", lane: "ax", state: "waiting", requestedAt: 4,
    members: [member(FRONT, "front", F2)], workspace: F2, root: FRONT,
  });
  const laneOut = build(lane).value;
  assert.equal(laneOut[F2][1].tooltip, "En cola #1 · mismo space");
  const cap = build(lane, settingsOf({ version: 1, queue: { perSpace: { ax: 4 }, cap: 1 } })).value;
  assert.equal(cap[F2][1].tooltip, "En cola #1 · límite alcanzado");

  const paused = baseState();
  Object.assign(paused.queue.requests[1], { state: "paused", pauseReason: "limit", pausedAt: 9 });
  let b = build(paused).value[B2][1];
  assert.equal(path.basename(b.icon), "pause.svg");
  assert.equal(b.tone, "blocked");
  assert.equal(b.tooltip, "Pausado · sin límite");
  paused.queue.requests[1].pauseReason = "signin";
  assert.equal(build(paused).value[B2][1].tooltip, "Pausado · inicia sesión");
  paused.queue.requests[1].pauseReason = "error";
  assert.equal(build(paused).value[B2][1].tooltip, "Pausado · error");

  const off = build(baseState(), settingsOf({ version: 1, queue: { enabled: false } })).value;
  assert.deepEqual(icons(off[B1]), ["flashlight", "server"]);
  assert.deepEqual(icons(off[B2]), ["flashlight"]);
});

test("a slot-only request shows its flask on the caller's own workspace", () => {
  const s = baseState();
  s.queue.requests = [
    { terminal: "t5", taskKey: "ax/AX-9", label: "AX-9", lane: "ax", state: "holding", requestedAt: 1, grantedAt: 1, members: [], workspace: O1, root: OTHER, slotOnly: true },
  ];
  assert.deepEqual(icons(build(s).value[O1]), ["flask"]);
});

test("every badge passes projects-sidebar's contract, at most 3 per row", () => {
  const busy = baseState();
  busy.repos[FRONT] = repo({
    holder: F1, lastSyncAt: at(9, 1, 2), serverTerminal: "t8", serverCommand: `pnpm dev:${"x".repeat(300)}`, serverEnv: "dev",
    serverState: "listening", ports: [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, 3011],
    lastError: { code: "untracked-collision", message: "a\nb", at: 1 },
  });
  assertContract(build(busy).value);
  assertContract(build().value);
  const long = build(busy).value[F1];
  assert.ok(codePoints(long[1].tooltip) <= 200);
  assert.equal(long[1].text, ":3000+11");
});

test("the id map resolves every server command it published, and every workspace a toast can name", () => {
  const busy = baseState();
  busy.repos[FRONT] = repo({ holder: F1, serverState: "starting", serverCommand: "pnpm dev" });
  const { value, servers } = build(busy);
  const commands = Object.entries(value).flatMap(([at, list]) =>
    list.filter((b) => b.action?.command).map((b) => ({ at, id: b.action.command.slice("spotlight.server.".length) })));
  assert.ok(commands.length >= 4);
  for (const { at, id } of commands) assert.equal(servers[id]?.workspace, at);
  assert.equal(servers[serverIdOf(B1)].root, BACK);
  assert.equal(servers[serverIdOf(BACK)].root, BACK);
  // A takeover that failed names its workspace in the toast (cli-work errorNote).
  assert.deepEqual(servers[serverIdOf(B2)], { workspace: B2, root: BACK });
  assert.deepEqual(servers[serverIdOf(F2)], { workspace: F2, root: FRONT });
});

test("publish: only a changed value is written; no badges clear the key once", () => {
  const { value } = build();
  const first = nextPublish(undefined, value);
  assert.equal(first.write, true);
  assert.deepEqual(first.value, value);
  // The stored value read back (other key order) and a rebuild from the same state: nothing to write.
  const stored = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).reverse())));
  assert.equal(nextPublish(stored, build().value).write, false);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  // Something changed: written.
  const later = baseState();
  later.repos[BACK].lastSyncAt = at(23, 0, 0);
  assert.equal(nextPublish(stored, build(later).value).write, true);
  // Nothing to show: the key is cleared once, then left alone.
  const empty = buildBadges({ state: readState(null), settings: settingsOf(), projects: [], cache: {}, enabled: {}, bin: BIN });
  assert.equal(empty.value, null);
  assert.deepEqual(nextPublish(stored, empty.value), { write: true, value: null });
  assert.equal(nextPublish(null, empty.value).write, false);
  assert.equal(nextPublish(undefined, empty.value).write, false);
});

test("parsing is tolerant: a bad registry or cache reads as empty", () => {
  assert.deepEqual(parseProjects({ version: 2 }), []);
  assert.deepEqual(parseProjects(null), []);
  assert.deepEqual(parseProjects({ version: 1, groups: [{ id: "g", name: "G", projects: [{ path: "rel", name: "x" }, { path: `${BACK}/`, name: "back" }] }] }), [
    { root: BACK, name: "back", group: "g" },
  ]);
  assert.deepEqual(parseCache({ [BACK]: [{ path: B1, branch: 3, main: false }], [FRONT]: "x", rel: [] }), {});
  assert.deepEqual(parseCache(undefined), {});
});
