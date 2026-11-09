// T10: Spotlight's badges on projects-sidebar's workspace rows (D2, D17),
// built by M/badges-model.js from state.json, settings.json and the shared
// projects.v1 / projects.cache.v1 values, and published under
// badges.spotlight only when the value changes. Every badge has to pass
// projects-sidebar's contract (its RECIPE.md "Badges from other plugins"):
// an icon `mods/<mod>/…/<name>.svg` or a text (a text badge has no icon), text ≤ 16
// code points, tooltip ≤ 200, at most 4 per plugin on a row, `command` =
// `spotlight.<…>` matching its regex, `exec` argv0 absolute, and D39's
// `reveal`, `pill`, `dot` and `hover` with their values; projects-sidebar's
// own parser keeps every field.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as badgesModel from "../mods/spotlight/badges-model.js";
import {
  sha1Hex, serverIdOf, parseProjects, parseCache, buildBadges, nextPublish, canonicalJson,
  attempt, taskModeGroups,
} from "../mods/spotlight/badges-model.js";
import { serverViewModel } from "../mods/spotlight/server-view-model.js";
import { cliPathOf, readState, readSettings } from "../mods/spotlight/board-model.js";
import { serverId } from "../mods/spotlight/cli-work.mjs";
import { parseBadges } from "../../projects-sidebar/mods/projects/badges-model.js";

// Destructured, not named in the imports: a helper that's missing fails its
// own tests, not the whole file's load.
const { laneEnv, laneEnvChoices } = badgesModel;

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

// A row's badges by what shows: the icon's name, or a text badge's text.
const icons = (list) => (list ?? []).map((b) => (b.icon ? path.basename(b.icon, ".svg") : b.text));

// projects-sidebar's checks, as its badges-model.js applies them.
const COMMAND = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;
// D29: a task lane's key, `<groupId>/task:<KEY>`.
const LANE_KEY = /^[^/]+\/task:[^/].*$/;
const TONES = ["accent", "dim", "working", "blocked", "done"];
const codePoints = (s) => [...s].length;
function assertContract(value) {
  for (const [at, list] of Object.entries(value)) {
    assert.ok((at.startsWith("/") && !at.endsWith("/")) || LANE_KEY.test(at), `absolute path without trailing slash, or a lane key: ${at}`);
    assert.ok(Array.isArray(list) && list.length >= 1 && list.length <= 4, `1..4 badges on ${at}`);
    for (const b of list) {
      // D39: a text badge has no icon; every badge has one or the other.
      assert.ok(b.icon !== undefined || b.text !== undefined, `an icon or a text on ${at}`);
      if (b.icon !== undefined) {
        assert.match(b.icon, /^mods\/spotlight\/icons\/[a-z-]+\.svg$/);
        assert.ok(fs.existsSync(path.join(MOD_DIR, "icons", path.basename(b.icon))), `${b.icon} exists`);
      }
      if (b.text !== undefined) assert.ok(codePoints(b.text) <= 16 && !/\s{2}|\n/.test(b.text), `text "${b.text}"`);
      assert.ok(TONES.includes(b.tone), `tone ${b.tone}`);
      assert.ok(typeof b.tooltip === "string" && codePoints(b.tooltip) <= 200 && !/\n/.test(b.tooltip), `tooltip "${b.tooltip}"`);
      // D29: `spin` is true or absent.
      if (b.spin !== undefined) assert.equal(b.spin, true, `spin on ${b.icon}`);
      // D39's fields, each with its own values.
      if (b.reveal !== undefined) assert.ok(["hover", "grow"].includes(b.reveal), `reveal ${b.reveal}`);
      if (b.pill !== undefined) assert.equal(b.pill, true, `pill on ${at}`);
      if (b.dot !== undefined) assert.ok(["on", "off"].includes(b.dot), `dot ${b.dot}`);
      if (b.hover !== undefined) assert.ok(TONES.includes(b.hover), `hover ${b.hover}`);
      const { action } = b;
      if (action === undefined) {
        // The queue badges click like their row; the busy ring (D33) and the
        // root's logs icon (D39, Orca's) have no action.
        assert.ok(["flask", "clock", "pause", "spinner", "logs"].includes(path.basename(b.icon ?? "", ".svg")), "only queue badges, the ring and the logs icon have no action");
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
  // projects-sidebar's own parser (what it draws from) keeps every badge and
  // every field as published: nothing is dropped field by field.
  const parsed = parseBadges([value], ["badges.spotlight"]);
  for (const [at, list] of Object.entries(value)) {
    assert.deepEqual((parsed[at] ?? []).map(({ key, index, ...b }) => b), list, `projects-sidebar keeps ${at} as published`);
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
  // D39: the root row is Orca's: the SPOTLIGHT chip, the port, logs and the X.
  assert.deepEqual(icons(value[BACK]), ["flashlight", ":3000+1", "logs", "x"]);

  const [light, server, flask] = value[B1];
  assert.equal(light.tone, "working", "amber: Herdr's accent is blue in its default theme");
  // Orca's holder tooltip (WorktreeCardSpotlightControls activeHere + lastSynced + the server's state).
  assert.equal(light.tooltip, "Spotlight encendido: este workspace se refleja en el root del proyecto. Clic para apagarlo. Sincronizado a las 22:58:04. Server corriendo en el puerto 3000.");
  assert.deepEqual(light.action, { exec: [BIN, "toggle", "--workspace", B1] });

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

test("D36, D39: the holder's server badge shows the variant as Orca's tag (a dim pill, no icon), with the port in its tooltip; the root row keeps the port", () => {
  const s = baseState();
  Object.assign(s.repos[BACK], { serverVariant: "do", serverCommand: "pnpm dev:do", ports: [3000] });
  const { value } = build(s);
  const [, server] = value[B1];
  assert.deepEqual(server, {
    text: "DO", tone: "dim", pill: true, tooltip: "DO en :3000 · local · pnpm dev:do · http://localhost:3000",
    action: { command: `spotlight.server.${serverIdOf(B1)}` },
  });
  const [, rootServer] = value[BACK];
  assert.equal(rootServer.text, ":3000");
  assert.equal(rootServer.tooltip, "local · pnpm dev:do · http://localhost:3000");
  assertContract(value);

  // Longer than 6 code points: cut with "…" (6 in all); the tooltip names it whole.
  Object.assign(s.repos[BACK], { serverVariant: "storefront", ports: [3000, 3001] });
  const long = build(s).value[B1][1];
  assert.equal(long.text, "STORE…");
  assert.equal(codePoints(long.text), 6);
  assert.equal(long.pill, true);
  assert.equal(long.tooltip, "STOREFRONT en :3000+1 · local · pnpm dev:do · http://localhost:3000 http://localhost:3001");
  assert.equal(build(s).value[BACK][1].text, ":3000+1");

  // Not listening yet: the server's state, as before, with its icon and no pill.
  Object.assign(s.repos[BACK], { serverState: "starting", ports: [] });
  const starting = build(s).value[B1][1];
  assert.deepEqual([starting.text, starting.pill, path.basename(starting.icon)], ["…", undefined, "server.svg"]);
  // No variant: the port, as before.
  Object.assign(s.repos[BACK], { serverState: "listening", serverVariant: null, ports: [3000] });
  const plain = build(s).value[B1][1];
  assert.deepEqual([plain.text, plain.tone, plain.pill, path.basename(plain.icon)], [":3000", "done", undefined, "server.svg"]);
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
  // Orca's SpotlightVariantTag with no variant: a muted outlined "?" pill, no icon.
  assert.equal(ask.text, "?");
  assert.equal(ask.icon, undefined);
  assert.equal(ask.tone, "dim");
  assert.equal(ask.pill, true);
  assert.equal(ask.tooltip, "Aún no hay variante de Spotlight. Clic para elegir una.");
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
    const server = value[B1][1];
    assert.equal(server.tone, "blocked", lastError.code);
    assert.equal(server.tooltip, lastError.message);
    assert.deepEqual(server.action, { command: `spotlight.server.${serverIdOf(B1)}` });
    assert.equal(value[B1][0].tone, "blocked");
    assert.equal(value[B1][0].tooltip, `Spotlight: ${lastError.message}`);
    // D39: the root row has no port; the chip (a server error is no root
    // error) keeps its tone and its click, and its tooltip says why.
    assert.deepEqual(icons(value[BACK]), ["flashlight", "logs", "x"]);
    const [chip] = value[BACK];
    assert.equal(chip.tone, "working", lastError.code);
    assert.deepEqual(chip.action, { exec: [BIN, "peek", "--repo", BACK] });
    assert.equal(chip.dot, "off");
    assert.equal(chip.tooltip, `El root del proyecto refleja "ax-3447". Clic para abrir la terminal del server. ${lastError.message}`);
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
  }
  assert.equal(value[B1][1].tone, "blocked");
  assert.notEqual(value[B1][1].tooltip, busy.message);
  // D39: the root row has no port badge while nothing listens.
  assert.deepEqual(icons(value[BACK]), ["flashlight", "logs", "x"]);
  assertContract(value);
});

// D33: while a light, a turn-off, a Forzar sync or a restart works on a
// repo, its flashlight is M's own ring, spinning, with no action.
const RING = { icon: "mods/spotlight/icons/spinner.svg", tone: "working", tooltip: "Sincronizando…", spin: true };
// The holder's ring keeps its server dot (D39, Orca's holder button while syncing).
const HOLDER_RING = { ...RING, dot: "on" };
// The root's chip while busy (D39): the ring in its icon's place, its click kept.
const isBusyChip = (b, root) =>
  b.pill === true && b.text === "Spotlight" && b.icon === RING.icon && b.spin === true && b.action?.exec?.join(" ") === `${BIN} peek --repo ${root}`;

test("D33: a busy repo: the ring replaces the flashlight on the holder's and the root's rows, and on the target's; it spins, reads 'Sincronizando…' and has no action", () => {
  // A Forzar sync of the holder: its row and the root's spin; the server
  // badge and the queue's flask stay; the other workspaces keep their dim
  // flashlight, which still toggles.
  const s = baseState();
  s.repos[BACK].busy = { op: "sync", since: 5, pid: 4242, workspace: B1 };
  const { value } = build(s);
  assert.deepEqual(icons(value[B1]), ["spinner", "server", "flask"]);
  assert.deepEqual(icons(value[BACK]), ["spinner", ":3000+1", "logs"]);
  assert.deepEqual(value[B1][0], HOLDER_RING);
  assert.ok(isBusyChip(value[BACK][0], BACK), "the root's chip spins");
  assert.equal(value[B1][1].text, ":3000+1");
  assert.deepEqual(icons(value[B2]), ["flashlight", "clock"]);
  assert.deepEqual(value[B2][0].action, { exec: [BIN, "toggle", "--workspace", B2] });
  assertContract(value);

  // A takeover in flight: the target spins too, in its flashlight's place.
  const takeover = baseState();
  takeover.repos[BACK].busy = { op: "light", since: 5, pid: 4242, workspace: B2 };
  const moving = build(takeover).value;
  assert.deepEqual(moving[B1][0], HOLDER_RING);
  assert.ok(isBusyChip(moving[BACK][0], BACK));
  assert.deepEqual(moving[B2][0], RING);
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
  assert.deepEqual(going[B1][0], HOLDER_RING);
  assert.ok(isBusyChip(going[BACK][0], BACK));

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

test("every badge passes projects-sidebar's contract, at most 4 per row", () => {
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
  // back's holder and root (its port, D39), front's holder (its root, still
  // starting, has no port badge).
  assert.ok(commands.length >= 3);
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

// ── T21 (D31, D29): the task lane's flashlight and queue badge ─────────────
// The fixture's group "ax" in Task mode: lanes AX-3447 (back B1, the holder;
// front F1; other O1, whose Spotlight is off), AX-3500 (back B2) and login
// (front F2).

const laneKey = (key) => `ax/task:${key}`;
const NOT_LIT = "Spotlight de esta tarea: proyecta sus workspaces en el root de cada proyecto.";
const LIT = "Spotlight prendido para esta tarea. Clic para apagarlo en todos los proyectos.";
const laneToggle = (key) => ({ exec: [BIN, "toggle", "--task", key, "--group", "ax"] });

function buildLanes(state = baseState(), { settings = settingsOf(), taskGroups = ["ax"], laneCache = cache } = {}) {
  return buildBadges({ state, settings, projects, cache: laneCache, enabled, bin: BIN, taskGroups });
}

test("taskModeGroups: the ids of projects.v1's groups organized by Task; anything else is none", () => {
  const registry = {
    version: 1,
    groups: [
      { id: "ax", name: "AX", projects: [], organize: "task" },
      { id: "ag", name: "AG", projects: [] },
      { id: "", name: "x", projects: [], organize: "task" },
      { id: "ar", name: "Arrecife", projects: [], organize: "project" },
      { id: "ax", name: "again", projects: [], organize: "task" },
    ],
  };
  assert.deepEqual(taskModeGroups(registry), ["ax"]);
  assert.deepEqual(taskModeGroups({ version: 2, groups: registry.groups }), []);
  assert.deepEqual(taskModeGroups(null), []);
});

test("D31: a Task-mode group's lanes get the task's flashlight, keyed and acting with the group; dim until every member is held, then working; skipped repos named", () => {
  const { value } = buildLanes();
  // AX-3447: back held by B1, front not lit, other skipped (Spotlight off).
  // Orca's order (TaskSectionHeader): the flashlight, the queue badge, then
  // the env pill (D32, D39).
  const [light, flask] = value[laneKey("AX-3447")];
  assert.deepEqual(light, {
    icon: "mods/spotlight/icons/flashlight.svg", tone: "dim", tooltip: `${NOT_LIT} Saltado, Spotlight apagado en: other`, action: laneToggle("AX-3447"),
  });
  assert.deepEqual(icons([flask]), ["flask"]);
  // AX-3500: its only member (back) is held by AX-3447's workspace.
  assert.equal(value[laneKey("AX-3500")][0].tone, "dim");
  assert.equal(value[laneKey("AX-3500")][0].tooltip, NOT_LIT);
  // A name lane: the lowercased name, as projects-sidebar keys it.
  assert.deepEqual(value[laneKey("login")][0], { icon: "mods/spotlight/icons/flashlight.svg", tone: "dim", tooltip: NOT_LIT, action: laneToggle("login") });
  assertContract(value);

  // Every member held by one of the task's workspaces: working, the lit tooltip.
  const both = baseState();
  both.repos[FRONT] = repo({ holder: F1, serverState: "listening", ports: [5173] });
  const lit = buildLanes(both).value[laneKey("AX-3447")][0];
  assert.equal(lit.tone, "working");
  assert.equal(lit.tooltip, `${LIT} Saltado, Spotlight apagado en: other`);
  assert.deepEqual(lit.action, laneToggle("AX-3447"));
  // front held by a workspace of another task: not lit.
  both.repos[FRONT].holder = F2;
  assert.equal(buildLanes(both).value[laneKey("AX-3447")][0].tone, "dim");
  assertContract(buildLanes(both).value);

  // The workspace rows keep their own badges, as before.
  assert.deepEqual(value[B1], build().value[B1]);
});

test("D31: no eligible member, no flashlight: a task only in repos whose Spotlight is off, the Servers lane and the No task lane publish none", () => {
  const laneCache = {
    ...cache,
    [OTHER]: [...cache[OTHER], { path: `${WS}/other/ax-9`, branch: "juan/AX-9", main: false }, { path: `${WS}/other/none`, branch: null, main: false }],
  };
  const { value } = buildLanes(baseState(), { laneCache });
  assert.equal(value[laneKey("AX-9")], undefined);
  assert.deepEqual(Object.keys(value).filter((k) => !k.startsWith("/")).sort(), [laneKey("AX-3447"), laneKey("AX-3500"), laneKey("login")]);
  // A task with no eligible member still shows its queue badge.
  const s = baseState();
  s.queue.requests.push({
    terminal: "t9", taskKey: "ax/AX-9", label: "AX-9", lane: "ax", state: "holding", requestedAt: 5, grantedAt: 6, members: [], workspace: `${WS}/other/ax-9`, root: OTHER, slotOnly: true,
  });
  assert.deepEqual(icons(buildLanes(s, { laneCache }).value[laneKey("AX-9")]), ["flask"]);
});

test("D31, D33: a member's repo busy, or the task's batch marker set: the lane's flashlight is the ring, spinning, with no action", () => {
  const busy = baseState();
  busy.repos[FRONT] = repo({ busy: { op: "light", since: 5, pid: 4242, workspace: F1 } });
  const out = buildLanes(busy).value;
  assert.deepEqual(out[laneKey("AX-3447")][0], RING);
  assert.equal(out[laneKey("AX-3447")][0].action, undefined);
  assert.equal(out[laneKey("AX-3500")][0].icon, "mods/spotlight/icons/flashlight.svg", "back isn't busy: AX-3500 keeps its flashlight");
  assert.deepEqual(out[laneKey("login")][0], RING, "front is login's member too");

  const batch = baseState();
  batch.queue.taskBatch = { "ax/AX-3500": { op: "on", since: 5, pid: 4242 } };
  const running = buildLanes(batch).value;
  assert.deepEqual(running[laneKey("AX-3500")][0], RING);
  assert.equal(running[laneKey("AX-3447")][0].icon, "mods/spotlight/icons/flashlight.svg", "another task's batch doesn't spin this lane");
  assertContract(running);
});

test("D31: the task's queue badge on its lane, as on its rows: testing, queued #2, paused; none with the queue off", () => {
  const s = baseState();
  s.queue.requests.push({
    terminal: "t3", taskKey: "ax/login", label: "login", lane: "ax", state: "waiting", requestedAt: 4, members: [member(FRONT, "front", F2)], workspace: F2, root: FRONT,
  });
  const { value } = buildLanes(s);
  // AX-3447 holds back: the queue badge, then its env pill (D32), as Orca's header.
  assert.deepEqual(icons(value[laneKey("AX-3447")]), ["flashlight", "flask", "Local ▾"]);
  assert.deepEqual(icons(value[laneKey("AX-3500")]), ["flashlight", "clock", "Local ▾"]);
  const second = value[laneKey("login")][1];
  assert.deepEqual(icons([second]), ["clock"]);
  assert.equal(second.text, "#2");
  // Behind AX-3500, and AX-3447 holds front.
  assert.equal(second.tooltip, "En cola #2 · repo ocupado");
  assert.deepEqual(second, value[F2][1], "the lane's badge is the row's");

  Object.assign(s.queue.requests[1], { state: "paused", pauseReason: "limit", pausedAt: 9 });
  assert.equal(buildLanes(s).value[laneKey("AX-3500")][1].tooltip, "Pausado · sin límite");
  const off = buildLanes(s, { settings: settingsOf({ version: 1, queue: { enabled: false } }) }).value;
  assert.deepEqual(icons(off[laneKey("AX-3447")]), ["flashlight", "Local ▾"]);
});

test("D29: a group not in Task mode gets no lane keys", () => {
  // buildBadges with no taskGroups at all (build()), or with groups that aren't the fixture's.
  for (const taskGroups of [[], ["ag"], "ax"]) {
    const { value } = buildLanes(baseState(), { taskGroups });
    assert.deepEqual(Object.keys(value).filter((k) => !k.startsWith("/")), [], JSON.stringify(taskGroups));
    assert.deepEqual(value, build().value);
  }
  assert.deepEqual(Object.keys(build().value).filter((k) => !k.startsWith("/")), []);
});

// ── T22 (D32), T31 (D39): the env pill on the task lane ───────────────────
// After the lane's flashlight and its queue badge, as Orca's header
// (TaskSectionHeader): the env of the task's servers, Orca's TaskSpotlightEnvPill,
// a text badge "<env> ▾" with no icon and no border. Shown as Orca shows it:
// always while a member holds its root or the stored env isn't Local,
// otherwise it grows in on the header's hover (`reveal: "grow"`).

const envIdOf = (key) => sha1Hex(`ax/${key}`).slice(0, 12);
const envCommand = (key) => ({ command: `spotlight.env.${envIdOf(key)}` });
const ENV_TIP = (label) => `Entorno de Spotlight de esta tarea: ${label}. Clic para cambiarlo.`;
const pill = (key, label, { tooltip = ENV_TIP(label), reveal } = {}) =>
  ({ text: `${label} ▾`, tone: "dim", tooltip, action: envCommand(key), ...(reveal ? { reveal } : {}) });
// A lane's env pill: its text badge ending in "▾".
const envOf = (list) => (list ?? []).find((b) => !b.icon && b.text?.endsWith(" ▾"));

test("D32: the env pill shows while a member holds: with nothing stored, the held repo's env; it opens the lane's env popup, which the id map names", () => {
  const built = buildLanes();
  const { value } = built;
  // AX-3447: back held by B1, nothing stored, back's settings env (Local).
  assert.deepEqual(icons(value[laneKey("AX-3447")]), ["flashlight", "flask", "Local ▾"]);
  assert.deepEqual(envOf(value[laneKey("AX-3447")]), pill("AX-3447", "Local"));
  // AX-3500's only member is held by another task's workspace; login's isn't
  // lit: their pill grows in on the header's hover.
  assert.deepEqual(icons(value[laneKey("AX-3500")]), ["flashlight", "clock", "Local ▾"]);
  assert.deepEqual(envOf(value[laneKey("AX-3500")]), pill("AX-3500", "Local", { reveal: "grow" }));
  assert.deepEqual(value[laneKey("login")], [value[laneKey("login")][0], pill("login", "Local", { reveal: "grow" })]);
  assertContract(value);
  // The id map: the command's id → the lane, with its members for the popup.
  assert.deepEqual(built.lanes[envIdOf("AX-3447")], {
    group: "ax", task: "AX-3447",
    members: [{ root: BACK, name: "back", workspaces: [B1] }, { root: FRONT, name: "front", workspaces: [F1] }],
  });
  assert.equal(built.lanes[envIdOf("login")]?.task, "login", "every lane with a flashlight is named");
  // The settings' env of the held repo, or a pick stored for the task (Local included), wins.
  const dev = buildLanes(baseState(), { settings: settingsOf({ version: 1, repos: { [BACK]: { env: "dev" } } }) }).value;
  assert.deepEqual(envOf(dev[laneKey("AX-3447")]), pill("AX-3447", "Dev"));
  const stored = buildLanes(baseState({ envs: { "ax/AX-3447": "prod" } })).value;
  assert.deepEqual(envOf(stored[laneKey("AX-3447")]), pill("AX-3447", "Prod"));
  const local = buildLanes(baseState({ envs: { "ax/AX-3447": "local" } }), { settings: settingsOf({ version: 1, repos: { [BACK]: { env: "dev" } } }) }).value;
  assert.deepEqual(envOf(local[laneKey("AX-3447")]), pill("AX-3447", "Local"));
  // The ring while the batch runs keeps the pill beside it.
  const batch = baseState();
  batch.queue.taskBatch = { "ax/AX-3447": { op: "on", since: 5, pid: 4242 } };
  assert.deepEqual(icons(buildLanes(batch).value[laneKey("AX-3447")]), ["spinner", "flask", "Local ▾"]);
});

test("D32, D39: with nobody holding, the pill is always shown only for a stored env that isn't Local, else it grows in on hover; the same task in another space is another key", () => {
  const s = baseState({ envs: { "ax/AX-3500": "dev", "ax/login": "local", "ag/AX-3447": "prod" } });
  const { value } = buildLanes(s);
  assert.deepEqual(envOf(value[laneKey("AX-3500")]), pill("AX-3500", "Dev"));
  assert.deepEqual(envOf(value[laneKey("login")]), pill("login", "Local", { reveal: "grow" }), "Local stored, nothing held: on hover");
  assert.deepEqual(envOf(value[laneKey("AX-3447")]), pill("AX-3447", "Local"), "another space's pick for AX-3447 isn't this one's");
  // No flashlight (no member with Spotlight on), no pill: there is no server to run.
  const laneCache = { ...cache, [OTHER]: [...cache[OTHER], { path: `${WS}/other/ax-9`, branch: "juan/AX-9", main: false }] };
  assert.equal(buildLanes(baseState({ envs: { "ax/AX-9": "dev" } }), { laneCache }).value[laneKey("AX-9")], undefined);
  assertContract(value);
});

test("D32: nothing stored, two repos held: their env when they agree, else Mixto (dim) with each repo's env in the tooltip", () => {
  const both = (fields = {}) => {
    const s = baseState();
    s.repos[FRONT] = repo({ holder: F1, serverState: "listening", ports: [5173], ...fields });
    return s;
  };
  const agree = settingsOf({ version: 1, repos: { [BACK]: { env: "dev" }, [FRONT]: { env: "dev" } } });
  assert.deepEqual(envOf(buildLanes(both(), { settings: agree }).value[laneKey("AX-3447")]), pill("AX-3447", "Dev"));
  const differ = settingsOf({ version: 1, repos: { [FRONT]: { env: "dev" } } });
  const mixed = envOf(buildLanes(both(), { settings: differ }).value[laneKey("AX-3447")]);
  assert.deepEqual(mixed, pill("AX-3447", "Mixto", { tooltip: "Entorno de Spotlight de esta tarea: mixto (back Local · front Dev). Clic para elegir uno." }));
  // A held record lit before T22 counts with its envOverride; a keyed one with what is stored for its key.
  const legacy = envOf(buildLanes(both({ envOverride: "local" }), { settings: differ }).value[laneKey("AX-3447")]);
  assert.equal(legacy.text, "Local ▾");
  const keyed = envOf(buildLanes(both({ envKey: "ax/AX-3447" }), { settings: differ }).value[laneKey("AX-3447")]);
  assert.equal(keyed.text, "Mixto ▾", "nothing stored for the key: the settings' env");
  assertContract(buildLanes(both(), { settings: differ }).value);
  // Mixto with nobody holding (the members' settings differ): on hover.
  const idle = baseState();
  delete idle.repos[BACK];
  assert.deepEqual(envOf(buildLanes(idle, { settings: differ }).value[laneKey("AX-3447")]).reveal, "grow");
});

test("D32: laneEnv, the pill's value: the stored env, else the held repos' env when they agree, else null (Mixto); with nobody holding, every member's would-be env, and not shown", () => {
  const members = [{ root: BACK, name: "back", workspaces: [B1] }, { root: FRONT, name: "front", workspaces: [F1] }];
  const at = (state, settings = settingsOf()) => laneEnv({ group: "ax", key: "AX-3447", members, state, settings });
  assert.deepEqual(at(baseState()), { value: "local", shown: true, repos: [{ name: "back", env: "local" }] });
  const idle = baseState();
  delete idle.repos[BACK];
  assert.deepEqual(at(idle), { value: "local", shown: false, repos: [{ name: "back", env: "local" }, { name: "front", env: "local" }] });
  assert.deepEqual(at(idle, settingsOf({ version: 1, repos: { [FRONT]: { env: "prod" } } })).value, null);
  assert.deepEqual(at({ ...idle, envs: { "ax/AX-3447": "prod" } }), { value: "prod", shown: true, repos: [{ name: "back", env: "local" }, { name: "front", env: "local" }] });
  assert.equal(laneEnv({ group: "ax", key: "AX-3447", members: [], state: baseState(), settings: settingsOf() }).shown, false);
});

test("D32: the env popup's radio: Local, Dev, Prod, the lane's value checked (none for Mixto), each running `env --task <KEY> --group <id> --env <e>`", () => {
  const argv = (env) => [BIN, "env", "--task", "AX-3447", "--group", "ax", "--env", env];
  assert.deepEqual(laneEnvChoices({ group: "ax", key: "AX-3447", value: "dev", bin: BIN }), [
    { env: "local", label: "Local", selected: false, argv: argv("local") },
    { env: "dev", label: "Dev", selected: true, argv: argv("dev") },
    { env: "prod", label: "Prod", selected: false, argv: argv("prod") },
  ]);
  assert.deepEqual(laneEnvChoices({ group: "ax", key: "AX-3447", value: null, bin: BIN }).map((c) => c.selected), [false, false, false]);
});

test("D32: the server popup's selected env equals the pill's when they agree", () => {
  const detection = { detected: { local: "pnpm local", dev: "pnpm dev", prod: "pnpm start" }, scriptCommands: [] };
  const popupEnv = (state, settings) =>
    serverViewModel({ state, settings, repo: BACK, workspace: B1, detection, bin: BIN }).envs.find((e) => e.selected)?.env;
  const cases = [
    [baseState(), settingsOf()],
    [baseState(), settingsOf({ version: 1, repos: { [BACK]: { env: "prod" } } })],
    [baseState({ envs: { "ax/AX-3447": "dev" } }), settingsOf()],
  ];
  cases[2][0].repos[BACK].envKey = "ax/AX-3447";
  for (const [state, settings] of cases) {
    const shown = envOf(buildLanes(state, { settings }).value[laneKey("AX-3447")]).text;
    assert.equal(shown, `${{ local: "Local", dev: "Dev", prod: "Prod" }[popupEnv(state, settings)]} ▾`, JSON.stringify(state.envs ?? null));
  }
});

// ── T31 (D39): Spotlight's sidebar as Orca's ───────────────────────────────
// WorktreeCardSpotlightControls: the idle flashlight on the row's hover, the
// holder's flashlight with its server dot, and the root row's SPOTLIGHT chip,
// port, logs icon and X; projects-sidebar draws the fields (its T30).

const LOG = "/Users/u/.local/state/herdr-spotlight/logs/back.log";
const CHIP_TIP = (server) => `El root del proyecto refleja "ax-3447". Clic para abrir la terminal del server. ${server}`;
const LOGS_TIP = (where) => `Los agentes de cualquier workspace pueden leer los logs del server: spotlight logs --repo ${where}.`;
const PEEK = { exec: [BIN, "peek", "--repo", BACK] };
const ROOT_OFF = { exec: [BIN, "toggle", "--workspace", BACK] };
const X = {
  icon: "mods/spotlight/icons/x.svg", tone: "dim", hover: "working", reveal: "hover",
  tooltip: "Apagar Spotlight y restaurar el root del proyecto", action: ROOT_OFF,
};

// back's root row, with `fields` on its record.
function rootRow(fields = {}, over = {}) {
  const s = baseState(over);
  Object.assign(s.repos[BACK], fields);
  return build(s).value[BACK];
}

test("D39: a workspace that doesn't hold the root shows its dim flashlight on its row's hover; the holder's, a busy target's ring and the lane's are always shown", () => {
  const { value } = build();
  for (const at of [B2, F1, F2]) {
    assert.equal(value[at][0].reveal, "hover", at);
    assert.equal(path.basename(value[at][0].icon), "flashlight.svg");
    assert.equal(value[at][0].dot, undefined, "only the holder's flashlight has a dot");
  }
  assert.equal(value[B1][0].reveal, undefined);
  const takeover = baseState();
  takeover.repos[BACK].busy = { op: "light", since: 5, pid: 4242, workspace: B2 };
  assert.deepEqual(build(takeover).value[B2][0], RING);
  assert.equal(buildLanes().value[laneKey("AX-3447")][0].reveal, undefined);
  assertContract(value);
});

test("D39: the holder's flashlight carries the server dot: on while starting or listening, and while syncing; off when stopped; none with no server or its terminal gone", () => {
  const dotOf = (fields, busy) => {
    const s = baseState();
    Object.assign(s.repos[BACK], fields);
    if (busy) s.repos[BACK].busy = { op: "sync", since: 5, pid: 4242, workspace: B1 };
    return build(s).value[B1][0].dot;
  };
  assert.equal(dotOf({}), "on");
  assert.equal(dotOf({ serverState: "starting", ports: [] }), "on");
  assert.equal(dotOf({}, true), "on", "the ring keeps it");
  assert.equal(dotOf({ serverState: "starting", ports: [] }, true), "on");
  assert.equal(dotOf({ serverState: "stopped", ports: [] }), "off");
  assert.equal(dotOf({ serverState: "stopped", ports: [] }, true), "off");
  assert.equal(dotOf({ serverState: "stopped", ports: [], lastError: { code: "server-exited", message: "x", at: 5 } }), "off");
  assert.equal(dotOf({ serverState: "gone", ports: [] }), undefined);
  assert.equal(dotOf({ serverState: "stopped", serverCommand: null, serverTerminal: null, ports: [] }), undefined);
  // On an error the red flashlight keeps it (Orca's held button always does).
  assert.equal(dotOf({ lastError: { code: "root-diverged", message: "x", at: 5 } }), "on");
});

test("D39: the lit root row, in Orca's order: the SPOTLIGHT chip (the server's tab), the port, the logs icon and the X on hover", () => {
  const row = rootRow({ logPath: LOG });
  assert.deepEqual(icons(row), ["flashlight", ":3000+1", "logs", "x"]);
  const [chip, port, logs, x] = row;
  assert.deepEqual(chip, {
    icon: "mods/spotlight/icons/flashlight.svg", text: "Spotlight", tone: "working", pill: true, dot: "on",
    tooltip: CHIP_TIP("Server corriendo en el puerto 3000."), action: PEEK,
  });
  assert.deepEqual(port, {
    text: ":3000+1", tone: "dim", tooltip: "local · pnpm dev --port 3000 · http://localhost:3000 http://localhost:3001",
    action: { command: `spotlight.server.${serverIdOf(BACK)}` },
  });
  assert.deepEqual(logs, { icon: "mods/spotlight/icons/logs.svg", tone: "dim", reveal: "hover", tooltip: LOGS_TIP(`back (${LOG})`) });
  assert.deepEqual(x, X);
  // The configured port leads the chip's tooltip, as the port badge's label.
  const settings = settingsOf({ version: 1, repos: { [BACK]: { port: 3001 } } });
  assert.equal(build(baseState(), settings).value[BACK][0].tooltip, CHIP_TIP("Server corriendo en el puerto 3001."));
  // No log path yet: the command alone.
  assert.equal(rootRow()[2].tooltip, LOGS_TIP("back"));
  // The repo's name is projects-sidebar's (the CLI's `--repo` takes it).
  const named = buildBadges({
    state: baseState(), settings: settingsOf(), cache, enabled, bin: BIN,
    projects: parseProjects({ version: 1, groups: [{ id: "ax", name: "AX", projects: [{ path: BACK, name: "back-api" }] }] }),
  });
  assert.equal(named.value[BACK][2].tooltip, LOGS_TIP("back-api"));
  assertContract(build().value);
});

test("D39: with no port the root row has no port badge: the chip's dot and tooltip carry the server's state", () => {
  const cases = [
    [{ serverState: "starting", ports: [] }, "on", "Server arrancando."],
    [{ serverState: "stopped", ports: [] }, "off", "Server detenido."],
    [{ serverState: "gone", ports: [] }, undefined, "Server cerrado."],
    [{ serverState: "needs-variant", serverCommand: null, ports: [] }, "off", "Elige una variante para arrancar el server."],
    [{ serverState: "stopped", serverCommand: null, serverTerminal: null, ports: [] }, undefined, "Sin server."],
  ];
  for (const [fields, dot, server] of cases) {
    const row = rootRow(fields);
    assert.deepEqual(icons(row), ["flashlight", "logs", "x"], fields.serverState);
    assert.equal(row[0].dot, dot, fields.serverState);
    assert.equal(row[0].tooltip, CHIP_TIP(server), fields.serverState);
    assert.deepEqual(row[0].action, PEEK);
    assert.equal(row[0].tone, "working");
  }
  // Listening with no port read: the chip says it runs, and there is no port badge.
  const bare = rootRow({ ports: [] });
  assert.deepEqual(icons(bare), ["flashlight", "logs", "x"]);
  assert.equal(bare[0].tooltip, CHIP_TIP("Server corriendo."));
  // The holder's server badge keeps the state and the popup.
  const s = baseState();
  Object.assign(s.repos[BACK], { serverState: "starting", ports: [] });
  assert.deepEqual(build(s).value[B1][1].action, { command: `spotlight.server.${serverIdOf(B1)}` });
});

test("D39: the root terminal's own queue badge takes the logs icon's place on the lit root row; an unlit root keeps it as before", () => {
  const ask = (root) => ({
    terminal: "t7", taskKey: `cwd:${root}`, label: path.basename(root), lane: "ax", state: "holding", requestedAt: 5, grantedAt: 6,
    members: [], workspace: root, root, slotOnly: true,
  });
  const s = baseState();
  s.queue.requests.push(ask(BACK), { ...ask(FRONT), terminal: "t8" });
  const { value } = build(s);
  assert.deepEqual(icons(value[BACK]), ["flashlight", ":3000+1", "flask", "x"]);
  assert.equal(value[BACK][2].tooltip, "Probando");
  assert.deepEqual(icons(value[FRONT]), ["flask"], "an unlit root: its queue badge alone");
  assertContract(value);
});

test("D39, D33: a busy repo's chip spins with its click kept, and the X is gone", () => {
  const s = baseState();
  s.repos[BACK].busy = { op: "restart", since: 5, pid: 4242, workspace: B1 };
  const row = build(s).value[BACK];
  assert.deepEqual(icons(row), ["spinner", ":3000+1", "logs"]);
  assert.deepEqual(row[0], {
    icon: "mods/spotlight/icons/spinner.svg", spin: true, text: "Spotlight", tone: "working", pill: true, dot: "on",
    tooltip: CHIP_TIP("Server corriendo en el puerto 3000."), action: PEEK,
  });
  assertContract(build(s).value);
});

test("D39: a root error makes the chip blocked, its click the toggle as the root's flashlight did; busy, it spins and shows the server's tab", () => {
  const diverged = { code: "root-diverged", message: "The repository root moved off the Spotlight snapshot.", at: 5 };
  const row = rootRow({ lastError: diverged });
  assert.deepEqual(icons(row), ["flashlight", ":3000+1", "logs", "x"]);
  assert.deepEqual(row[0], {
    icon: "mods/spotlight/icons/flashlight.svg", text: "Spotlight", tone: "blocked", pill: true, dot: "on",
    tooltip: "Root desviado: abre el server para forzar", action: ROOT_OFF,
  });
  // A server error under it: still the root's.
  const under = rootRow({ serverState: "stopped", ports: [], lastError: { ...diverged, serverError: { code: "port-busy", message: "x", at: 4 } } });
  assert.deepEqual([under[0].tone, under[0].action], ["blocked", ROOT_OFF]);
  // Busy (a Forzar sync of it): the ring, and a click that shows the tab.
  const busy = rootRow({ lastError: diverged, busy: { op: "sync", since: 5, pid: 4242, workspace: B1 } });
  assert.deepEqual([path.basename(busy[0].icon), busy[0].spin, busy[0].tone, busy[0].action], ["spinner.svg", true, "blocked", PEEK]);
  assert.deepEqual(icons(busy), ["spinner", ":3000+1", "logs"]);
});

test("D39: an unlit refused root keeps today's flashlight and popup", () => {
  const s = baseState();
  s.repos = { [FRONT]: repo({ lastError: { code: "untracked-collision", message: "x", at: 5 } }) };
  assert.deepEqual(build(s).value[FRONT], [{
    icon: "mods/spotlight/icons/flashlight.svg", tone: "blocked", tooltip: "Archivos sin seguimiento en el root: abre el server para forzar",
    action: { command: `spotlight.server.${serverIdOf(FRONT)}` },
  }]);
});

test("D39: at most 4 badges per row from Spotlight", () => {
  const s = baseState();
  for (const n of [1, 2, 3]) {
    s.queue.requests.push({
      terminal: `q${n}`, taskKey: `ax/AX-9${n}`, label: `AX-9${n}`, lane: "ax", state: "paused", pauseReason: "limit", requestedAt: 9 + n,
      members: [member(BACK, "back", B1)], workspace: B1, root: BACK,
    });
  }
  const { value } = build(s);
  assert.deepEqual(icons(value[B1]), ["flashlight", "server", "flask", "pause"]);
  assertContract(value);
});
