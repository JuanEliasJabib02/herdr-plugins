// T10: Spotlight's badges on projects-sidebar's workspace rows (D2, D17),
// built by M/badges-model.js from state.json, settings.json and the shared
// projects.v1 / projects.cache.v1 values, and published under
// badges.spotlight only when the value changes. Every badge has to pass
// projects-sidebar's contract (its RECIPE.md "Badges from other plugins"):
// an icon `mods/<mod>/…/<name>.svg` or a text (a text badge has no icon), text ≤ 16
// code points, tooltip ≤ 200, at most 4 per plugin on a row, `command` =
// `spotlight.<…>` matching its regex, `exec` argv0 absolute, D39's
// `reveal`, `pill`, `dot` and `hover` and D42's `bar`, `line`, `disabled`
// and `look` with their values; projects-sidebar's own parser keeps every
// field.
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

// D42: badges.js passes the clock; back's last sync (22:58:04) was 2 min ago.
const NOW = at(23, 0, 4);

// `variants`: badges.js's { [root]: [variant] } for the lit roots (D42).
function build(state = baseState(), settings = settingsOf(), { variants, now = NOW } = {}) {
  return buildBadges({ state, settings, projects, cache, enabled, bin: BIN, now, variants });
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
      // D42: a lane's queue pill (Orca's test-turn badge) has no tooltip; every other badge has one.
      if (b.tooltip !== undefined || !b.look) {
        assert.ok(typeof b.tooltip === "string" && b.tooltip && codePoints(b.tooltip) <= 200 && !/\n/.test(b.tooltip), `tooltip "${b.tooltip}"`);
      }
      // D29: `spin` is true or absent.
      if (b.spin !== undefined) assert.equal(b.spin, true, `spin on ${b.icon}`);
      // D39's fields, each with its own values.
      if (b.reveal !== undefined) assert.ok(["hover", "grow"].includes(b.reveal), `reveal ${b.reveal}`);
      if (b.pill !== undefined) assert.equal(b.pill, true, `pill on ${at}`);
      if (b.dot !== undefined) assert.ok(["on", "off"].includes(b.dot), `dot ${b.dot}`);
      if (b.hover !== undefined) assert.ok(TONES.includes(b.hover), `hover ${b.hover}`);
      // D42's fields: a bar's tone, line 2 only, disabled with no action, a look beside a pill.
      if (b.bar !== undefined) assert.ok(TONES.includes(b.bar), `bar ${b.bar}`);
      if (b.line !== undefined) assert.equal(b.line, 2, `line on ${at}`);
      if (b.disabled !== undefined) {
        assert.equal(b.disabled, true, `disabled on ${at}`);
        assert.equal(b.action, undefined, "a disabled badge is published with no action");
      }
      if (b.look !== undefined) {
        assert.ok(["secondary", "outline"].includes(b.look), `look ${b.look}`);
        assert.equal(b.pill, true, "a look comes with pill: true");
      }
      const { action } = b;
      if (action === undefined) {
        // The queue badges click like their row; the busy ring (D33), the
        // root's logs icon (D39, Orca's), a disabled badge (D42's busy X)
        // and a lane's queue pill (D42) have no action.
        const quiet = ["flask", "clock", "pause", "spinner", "logs"].includes(path.basename(b.icon ?? "", ".svg"));
        assert.ok(quiet || b.disabled === true || b.look !== undefined, "only queue badges, the ring, the logs icon, a disabled badge and a queue pill have no action");
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

// ── T34 (D42): the holder's and the root's rows as Orca's cards ────────────

// The holder's tooltip, Orca's (WorktreeCardSpotlightControls): activeHere,
// lastSynced from the `now` given, then the server's state.
const HOLDER_ON = "Spotlight encendido: este workspace se refleja en el root del proyecto. Clic para apagarlo.";
const HOLDER_TIP = (synced, server) => `${HOLDER_ON} Sincronizado ${synced}. ${server}`;
const popupOf = (workspace) => ({ command: `spotlight.server.${serverIdOf(workspace)}` });
const PORT_TIP = "local · pnpm dev --port 3000 · http://localhost:3000 http://localhost:3001";
// D42: the holder's line 2, the root's ports as the root row's label.
const holderPort = (text = ":3000 +1", tooltip = PORT_TIP) => ({ text, tone: "dim", line: 2, tooltip, action: popupOf(B1) });

test("holder and root rows: amber flashlight, the root's ports on line 2, and the holder's flask; no server badge", () => {
  const { value } = build();
  assert.deepEqual(icons(value[B1]), ["flashlight", ":3000 +1", "flask"]);
  // D39, D42: the root row is Orca's: the SPOTLIGHT chip, the port (line 2), logs and the X.
  assert.deepEqual(icons(value[BACK]), ["flashlight", ":3000 +1", "logs", "x"]);

  const [light, port, flask] = value[B1];
  assert.equal(light.tone, "working", "amber: Herdr's accent is blue in its default theme");
  assert.equal(light.tooltip, HOLDER_TIP("hace 2 min", "Server corriendo en el puerto 3000."));
  assert.deepEqual(light.action, { exec: [BIN, "toggle", "--workspace", B1, "--note"] });

  // Orca's port label (formatSpotlightPortLabel): ":3000 +1", under the label.
  assert.deepEqual(port, holderPort());
  assert.deepEqual(value[BACK][1].action, popupOf(BACK));
  assert.equal(value[BACK][1].line, 2);

  assert.equal(flask.tone, "working");
  assert.equal(flask.tooltip, "Probando");
  assert.equal(flask.text, undefined);
  // The server badge goes (D42): no badge with the server icon on any row.
  assert.ok(Object.values(value).flat().every((b) => b.icon !== "mods/spotlight/icons/server.svg"));
  assertContract(value);
});

test("the configured port wins the label when it listens; one port has no count", () => {
  const settings = settingsOf({ version: 1, repos: { [BACK]: { port: 3001 } } });
  assert.equal(build(baseState(), settings).value[B1][1].text, ":3001 +1");
  assert.equal(build(baseState(), settings).value[BACK][1].text, ":3001 +1");
  const one = baseState();
  one.repos[BACK].ports = [5173];
  assert.equal(build(one).value[B1][1].text, ":5173");
  assert.equal(build(one).value[BACK][1].text, ":5173");
});

test("D42: the holder: the variant tag first whenever the repo has variants, then the flashlight with its dot, the root's ports on line 2", () => {
  const variants = { [BACK]: ["co", "do"] };
  const s = baseState();
  Object.assign(s.repos[BACK], { serverVariant: "do", serverCommand: "pnpm dev:do", ports: [3000] });
  const { value } = build(s, settingsOf(), { variants });
  assert.deepEqual(icons(value[B1]), ["DO", "flashlight", ":3000", "flask"]);
  const [tag, light, port] = value[B1];
  // Orca's SpotlightVariantTag: a dim outlined pill, no icon, opening the popup's chips.
  assert.deepEqual(tag, { text: "DO", tone: "dim", pill: true, tooltip: "Variante de Spotlight: DO. Clic para cambiarla.", action: popupOf(B1) });
  assert.equal(light.dot, "on");
  // Orca's server label with the variant.
  assert.equal(light.tooltip, HOLDER_TIP("hace 2 min", "Server corriendo: DO en :3000."));
  assert.deepEqual(port, holderPort(":3000", "local · pnpm dev:do · http://localhost:3000"));
  // The root row keeps its port; the chip names no variant (Orca's primary badge).
  assert.deepEqual(icons(value[BACK]), ["flashlight", ":3000", "logs", "x"]);
  assert.equal(value[BACK][0].tooltip, CHIP_TIP("Server corriendo en el puerto 3000."));
  assertContract(value);

  // Longer than 6 code points: cut with "…" (D36); the tooltip names it whole.
  Object.assign(s.repos[BACK], { serverVariant: "storefront" });
  const long = build(s, settingsOf(), { variants: { [BACK]: ["do", "storefront"] } }).value[B1][0];
  assert.equal(long.text, "STORE…");
  assert.equal(long.tooltip, "Variante de Spotlight: STOREFRONT. Clic para cambiarla.");

  // No variants detected and none on the record: no tag.
  Object.assign(s.repos[BACK], { serverVariant: null, serverCommand: "pnpm dev" });
  assert.deepEqual(icons(build(s).value[B1]), ["flashlight", ":3000", "flask"]);
  // A repo with variants whose holder runs none yet: "?".
  const unset = build(s, settingsOf(), { variants }).value[B1][0];
  assert.deepEqual(unset, { text: "?", tone: "dim", pill: true, tooltip: "Todavía no elegiste variante de Spotlight. Clic para elegir una.", action: popupOf(B1) });
  // Busy: the tag still leads, before the ring.
  s.repos[BACK].busy = { op: "variant", since: 5, pid: 4242, workspace: B1 };
  assert.deepEqual(icons(build(s, settingsOf(), { variants }).value[B1]).slice(0, 2), ["?", "spinner"]);
});

test("D42: a holder whose server is stopped (or its terminal busy), of a repo with variants, keeps its tag; '?' with none picked", () => {
  const variants = { [BACK]: ["co", "do"] };
  const holderOf = (fields, opts = { variants }) => {
    const s = baseState();
    Object.assign(s.repos[BACK], fields);
    return build(s, settingsOf(), opts).value[B1];
  };
  const stopped = holderOf({ serverState: "stopped", serverVariant: "do", ports: [] });
  assert.deepEqual(icons(stopped), ["DO", "flashlight", "flask"], "no line 2 while nothing listens");
  assert.equal(stopped[1].dot, "off");
  assert.equal(stopped[1].tooltip, HOLDER_TIP("hace 2 min", "Server detenido (DO)."));
  const busyTerminal = holderOf({ serverState: "stopped", serverReason: "terminal-busy", serverVariant: null, ports: [] });
  assert.deepEqual(icons(busyTerminal), ["?", "flashlight", "flask"]);
  assert.equal(busyTerminal[0].tooltip, "Todavía no elegiste variante de Spotlight. Clic para elegir una.");
  // Waiting for a variant: "?", even over the variant it ran before; the
  // record's candidates say the repo has variants when nothing was detected.
  const asking = holderOf({ serverState: "needs-variant", serverVariant: "do", variantCandidates: ["co", "do"], serverCommand: null, ports: [] }, {});
  assert.deepEqual(icons(asking), ["?", "flashlight", "flask"]);
  assert.equal(asking[1].tooltip, HOLDER_TIP("hace 2 min", "Elige una variante para arrancar el server."));
  // A variant on the record, whatever was detected: its tag.
  assert.deepEqual(icons(holderOf({ serverState: "stopped", serverVariant: "do", ports: [] }, {})), ["DO", "flashlight", "flask"]);
  assertContract(build(baseState(), settingsOf(), { variants }).value);
});

test("D42: the holder's server states: the dot and the tooltip say them; line 2 only while it listens, or a down server's error", () => {
  const holderOf = (fields) => {
    const s = baseState();
    Object.assign(s.repos[BACK], fields);
    return build(s).value[B1];
  };
  const cases = [
    [{ serverState: "starting", ports: [] }, "on", "Server arrancando."],
    [{ serverState: "stopped", ports: [] }, "off", "Server detenido."],
    [{ serverState: "gone", ports: [] }, undefined, "Server cerrado."],
    [{ serverState: "stopped", serverCommand: null, serverTerminal: null, ports: [] }, undefined, "Sin server."],
    [{ ports: [] }, "on", "Server corriendo."],
  ];
  for (const [fields, dot, server] of cases) {
    const row = holderOf(fields);
    assert.deepEqual(icons(row), ["flashlight", "flask"], JSON.stringify(fields));
    assert.equal(row[0].dot, dot, JSON.stringify(fields));
    assert.equal(row[0].tooltip, HOLDER_TIP("hace 2 min", server), JSON.stringify(fields));
  }
});

test("D42: a down server with an error: red text on the holder's line 2 ('server caído', 'puerto ocupado', 'no arrancó'), opening the popup", () => {
  const exited = { code: "server-exited", message: "El server se cayó al arrancar: SyntaxError: Unexpected token ';'", at: 5 };
  const busy = {
    code: "port-busy", port: 3008, pid: 900, command: "next-server (v16.0.1)", cwd: "/Users/u/old",
    message: "El puerto 3008 lo tiene next-server (v16.0.1) (pid 900, en /Users/u/old).", at: 5,
  };
  const failed = { code: "server-start-failed", message: "El server no arrancó: hc no pudo leer su terminal", at: 5 };
  for (const [lastError, words, state] of [[exited, "server caído", "stopped"], [busy, "puerto ocupado", "stopped"], [failed, "no arrancó", "gone"]]) {
    const s = baseState();
    Object.assign(s.repos[BACK], { serverState: state, ports: [], lastError });
    const { value } = build(s);
    assert.deepEqual(icons(value[B1]), ["flashlight", words, "flask"], lastError.code);
    assert.deepEqual(value[B1][1], { text: words, tone: "blocked", line: 2, tooltip: lastError.message, action: popupOf(B1) });
    assertContract(value);
  }
});

test("D42: the holder's tooltip: Orca's, 'Sincronizado recién / hace <n> min / hace <n> h' from the `now` given, then the server's state", () => {
  const synced = at(22, 58, 4);
  const tipAt = (now) => build(baseState(), settingsOf(), { now }).value[B1][0].tooltip;
  const SERVER = "Server corriendo en el puerto 3000.";
  assert.equal(tipAt(synced), HOLDER_TIP("recién", SERVER));
  assert.equal(tipAt(synced + 59_999), HOLDER_TIP("recién", SERVER));
  assert.equal(tipAt(synced - 5_000), HOLDER_TIP("recién", SERVER), "a sync ahead of the clock is recent");
  assert.equal(tipAt(synced + 60_000), HOLDER_TIP("hace 1 min", SERVER));
  assert.equal(tipAt(synced + 59 * 60_000 + 59_999), HOLDER_TIP("hace 59 min", SERVER));
  assert.equal(tipAt(synced + 60 * 60_000), HOLDER_TIP("hace 1 h", SERVER));
  assert.equal(tipAt(synced + 150 * 60_000), HOLDER_TIP("hace 2 h", SERVER));
  // Never synced, or no clock given: no sync sentence.
  assert.equal(tipAt(null), `${HOLDER_ON} ${SERVER}`);
  assert.equal(buildBadges({ state: baseState(), settings: settingsOf(), projects, cache, enabled, bin: BIN }).value[B1][0].tooltip, `${HOLDER_ON} ${SERVER}`);
  const never = baseState();
  never.repos[BACK].lastSyncAt = null;
  assert.equal(build(never).value[B1][0].tooltip, `${HOLDER_ON} ${SERVER}`);
  // Syncing (busy): Orca's "Sincronizando…", then the server's state.
  const busy = baseState();
  busy.repos[BACK].busy = { op: "sync", since: 5, pid: 4242, workspace: B1 };
  assert.equal(build(busy).value[B1][0].tooltip, `Sincronizando… ${SERVER}`);
  // A sync error (a root error): Orca's, red, its click still the turn-off.
  const failing = baseState();
  failing.repos[BACK].lastError = { code: "git-failed", message: "git exploded", at: 5 };
  const red = build(failing).value[B1][0];
  assert.equal(red.tone, "blocked");
  assert.equal(red.tooltip, `La sincronización de Spotlight está fallando: git exploded. ${SERVER}`);
  assert.deepEqual(red.action, { exec: [BIN, "toggle", "--workspace", B1, "--note"] });
});

test("D42: the idle and takeover tooltips are Orca's", () => {
  const { value } = build();
  assert.equal(value[B2][0].tooltip, 'Quitarle el Spotlight a "ax-3447": el root del proyecto reflejará este workspace.');
  assert.equal(value[F2][0].tooltip, "Spotlight en este workspace: refleja sus cambios en el root del proyecto para probar.");
});

test("dim flashlights on the other workspaces of enabled repos; none on disabled repos or idle roots", () => {
  const { value } = build();
  assert.deepEqual(icons(value[B2]), ["flashlight", "clock"]);
  assert.equal(value[B2][0].tone, "dim");
  // D42: Orca's takeover tooltip.
  assert.equal(value[B2][0].tooltip, 'Quitarle el Spotlight a "ax-3447": el root del proyecto reflejará este workspace.');
  assert.deepEqual(value[B2][0].action, { exec: [BIN, "toggle", "--workspace", B2, "--note"] });
  // front: enabled, nothing lit there. D42: Orca's idle tooltip.
  assert.deepEqual(icons(value[F2]), ["flashlight"]);
  assert.equal(value[F2][0].tooltip, "Spotlight en este workspace: refleja sus cambios en el root del proyecto para probar.");
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

test("D42: a root error turns the holder's flashlight red with Orca's sync error, never the root's chip; a root with an error and no holder opens the popup", () => {
  const s = baseState();
  s.repos[BACK].lastError = { code: "root-diverged", message: "The repository root moved off the Spotlight snapshot.", at: 5 };
  const { value } = build(s);
  assert.equal(value[B1][0].tone, "blocked");
  assert.equal(value[B1][0].tooltip, "La sincronización de Spotlight está fallando: Root desviado: abre el server para forzar. Server corriendo en el puerto 3000.");
  assert.equal(value[BACK][0].tone, "working", "the chip is never red");
  assert.deepEqual(value[BACK][0].action, { exec: [BIN, "peek", "--repo", BACK] });
  assert.equal(value[BACK][0].tooltip, `El root del proyecto refleja "ax-3447". Clic para abrir la terminal del server. Server corriendo en el puerto 3000.`);
  const failed = baseState();
  failed.repos = { [FRONT]: repo({ lastError: { code: "git-failed", message: "git exploded", at: 5 } }) };
  const out = build(failed);
  assert.deepEqual(icons(out.value[FRONT]), ["flashlight"]);
  assert.equal(out.value[FRONT][0].tone, "blocked");
  assert.equal(out.value[FRONT][0].tooltip, "Spotlight: git exploded");
  assert.deepEqual(out.value[FRONT][0].action, { command: `spotlight.server.${serverIdOf(FRONT)}` });
});

test("a server that didn't come up (D24, D25): its error is the holder's line 2, red with the message; the flashlight stays amber and says it too, also before any server ran", () => {
  const exited = { code: "server-exited", message: "El server se cayó al arrancar: SyntaxError: Unexpected token ';'", at: 5 };
  const busy = {
    code: "port-busy", port: 3008, pid: 900, command: "next-server (v16.0.1)", cwd: "/Users/u/old",
    message: "El puerto 3008 lo tiene next-server (v16.0.1) (pid 900, en /Users/u/old).", at: 5,
  };
  for (const lastError of [exited, busy]) {
    const s = baseState();
    Object.assign(s.repos[BACK], { serverState: "stopped", ports: [], lastError });
    const { value } = build(s);
    const down = value[B1][1];
    assert.equal(down.tone, "blocked", lastError.code);
    assert.equal(down.line, 2);
    assert.equal(down.tooltip, lastError.message);
    assert.deepEqual(down.action, { command: `spotlight.server.${serverIdOf(B1)}` });
    // D42: a server error isn't a sync error: the flashlight stays amber, its
    // tooltip ending in the server's state, the message.
    assert.equal(value[B1][0].tone, "working");
    assert.equal(value[B1][0].tooltip, `Spotlight encendido: este workspace se refleja en el root del proyecto. Clic para apagarlo. Sincronizado hace 2 min. ${lastError.message}`);
    // D39: the root row has no port; the chip keeps its tone and its click,
    // and its tooltip says why.
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
  assert.equal(build(first).value[B1][1].text, "puerto ocupado");
  // Listening again: the port, whatever an older error says.
  const back = baseState();
  back.repos[BACK].lastError = exited;
  assert.equal(build(back).value[B1][1].text, ":3000 +1");
});

// F6, F7: a server error under a root error (lastError.serverError). The
// badges show the error on top: the root's, on the holder's flashlight; the
// holder's line 2 reads the server as stopped (nothing), not the error under it.
test("a server error under a root error: the badges show the root error on top", () => {
  const ORCA = { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 5 };
  const busy = { code: "port-busy", port: 3008, pid: null, command: null, cwd: null, message: "El puerto 3008 estaba ocupado al arrancar el server.", at: 4 };
  const s = baseState();
  Object.assign(s.repos[BACK], { serverState: "stopped", ports: [], lastError: { ...ORCA, serverError: busy } });
  const { value } = build(s);
  assert.equal(value[B1][0].tone, "blocked");
  assert.equal(value[B1][0].tooltip, `La sincronización de Spotlight está fallando: ${ORCA.message} Server detenido.`);
  assert.deepEqual(icons(value[B1]), ["flashlight", "flask"], "no red line 2: the error on top is the root's");
  // D42: the chip is never red.
  assert.equal(value[BACK][0].tone, "working");
  // D39: the root row has no port badge while nothing listens.
  assert.deepEqual(icons(value[BACK]), ["flashlight", "logs", "x"]);
  assertContract(value);
});

// D33: while a light, a turn-off, a Forzar sync or a restart works on a
// repo, its flashlight is M's own ring, spinning, with no action.
const RING = { icon: "mods/spotlight/icons/spinner.svg", tone: "working", tooltip: "Sincronizando…", spin: true };
// The holder's ring keeps its server dot (D39, Orca's holder button while
// syncing) and, as Orca's, says the server's state after "Sincronizando…" (D42).
const HOLDER_RING = { ...RING, tooltip: "Sincronizando… Server corriendo en el puerto 3000.", dot: "on" };
// The root's chip while busy (D39): the ring in its icon's place, its click kept.
const isBusyChip = (b, root) =>
  b.pill === true && b.text === "Spotlight" && b.icon === RING.icon && b.spin === true && b.action?.exec?.join(" ") === `${BIN} peek --repo ${root}`;

test("D33: a busy repo: the ring replaces the flashlight on the holder's and the root's rows, and on the target's; it spins, reads 'Sincronizando…' and has no action", () => {
  // A Forzar sync of the holder: its row and the root's spin; the port, the
  // queue's flask and the root's (disabled) X stay; the other workspaces
  // keep their dim flashlight, which still toggles.
  const s = baseState();
  s.repos[BACK].busy = { op: "sync", since: 5, pid: 4242, workspace: B1 };
  const { value } = build(s);
  assert.deepEqual(icons(value[B1]), ["spinner", ":3000 +1", "flask"]);
  assert.deepEqual(icons(value[BACK]), ["spinner", ":3000 +1", "logs", "x"]);
  assert.deepEqual(value[B1][0], HOLDER_RING);
  assert.ok(isBusyChip(value[BACK][0], BACK), "the root's chip spins");
  assert.equal(value[B1][1].text, ":3000 +1");
  assert.deepEqual(icons(value[B2]), ["flashlight", "clock"]);
  assert.deepEqual(value[B2][0].action, { exec: [BIN, "toggle", "--workspace", B2, "--note"] });
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
  assert.deepEqual(icons(off[B1]), ["flashlight", ":3000 +1"]);
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
  assert.ok(codePoints(long[0].tooltip) <= 200);
  assert.ok(codePoints(long[1].tooltip) <= 200);
  assert.equal(long[1].text, ":3000 +11");
  assert.equal(long[1].line, 2);
});

test("the id map resolves every server command it published, and every workspace a toast can name", () => {
  const busy = baseState();
  busy.repos[FRONT] = repo({ holder: F1, serverState: "starting", serverCommand: "pnpm dev" });
  const { value, servers } = build(busy);
  const commands = Object.entries(value).flatMap(([at, list]) =>
    list.filter((b) => b.action?.command).map((b) => ({ at, id: b.action.command.slice("spotlight.server.".length) })));
  // back's holder and root (their ports on line 2, D42); front's holder and
  // root, still starting, have no port badge.
  assert.ok(commands.length >= 2);
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

test("D42: the holder's 'hace <n> min' changes the value once a minute, not on every build", () => {
  const synced = at(22, 58, 4);
  const stored = build(baseState(), settingsOf(), { now: synced + 2 * 60_000 }).value;
  // Later in the same minute: nothing to write.
  assert.equal(nextPublish(stored, build(baseState(), settingsOf(), { now: synced + 2 * 60_000 + 45_000 }).value).write, false);
  // The next minute: written.
  assert.equal(nextPublish(stored, build(baseState(), settingsOf(), { now: synced + 3 * 60_000 }).value).write, true);
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
  return buildBadges({ state, settings, projects, cache: laneCache, enabled, bin: BIN, taskGroups, now: NOW });
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
  const [light, queued] = value[laneKey("AX-3447")];
  assert.deepEqual(light, {
    icon: "mods/spotlight/icons/flashlight.svg", tone: "dim", tooltip: `${NOT_LIT} Saltado, Spotlight apagado en: other`, action: laneToggle("AX-3447"),
  });
  // D42: the queue badge is Orca's text pill.
  assert.deepEqual(icons([queued]), ["Probando"]);
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
  assert.deepEqual(buildLanes(s, { laneCache }).value[laneKey("AX-9")], [PROBANDO]);
});

test("D31, D33: a member's repo busy for one of the task's own workspaces, or the task's batch marker set: the lane's flashlight is the ring, spinning, with no action; another task's work on a shared repo spins nothing here", () => {
  const busy = baseState();
  busy.repos[FRONT] = repo({ busy: { op: "light", since: 5, pid: 4242, workspace: F1 } });
  const out = buildLanes(busy).value;
  assert.deepEqual(out[laneKey("AX-3447")][0], RING);
  assert.equal(out[laneKey("AX-3447")][0].action, undefined);
  assert.equal(out[laneKey("AX-3500")][0].icon, "mods/spotlight/icons/flashlight.svg", "back isn't busy: AX-3500 keeps its flashlight");
  // Juan's report (2026-11-09): lighting one task's workspace spun every
  // lane with a workspace in that repo. Front is login's member too, but
  // the work is for AX-3447's F1: login keeps its flashlight, as Orca's
  // TaskSpotlightButton spins only for its own task.
  assert.equal(out[laneKey("login")][0].icon, "mods/spotlight/icons/flashlight.svg", "front busy for AX-3447's F1 doesn't spin login");
  assert.ok(out[laneKey("login")][0].action, "login's flashlight keeps its click");

  // A mark with no workspace (a restart) spins no lane.
  const restart = baseState();
  restart.repos[FRONT] = repo({ busy: { op: "restart", since: 5, pid: 4242, workspace: null } });
  const quiet = buildLanes(restart).value;
  assert.equal(quiet[laneKey("AX-3447")][0].icon, "mods/spotlight/icons/flashlight.svg");
  assert.equal(quiet[laneKey("login")][0].icon, "mods/spotlight/icons/flashlight.svg");

  // Work for login's F2 spins login only.
  const other = baseState();
  other.repos[FRONT] = repo({ busy: { op: "light", since: 5, pid: 4242, workspace: F2 } });
  const mine = buildLanes(other).value;
  assert.deepEqual(mine[laneKey("login")][0], RING);
  assert.equal(mine[laneKey("AX-3447")][0].icon, "mods/spotlight/icons/flashlight.svg", "front busy for login's F2 doesn't spin AX-3447");

  const batch = baseState();
  batch.queue.taskBatch = { "ax/AX-3500": { op: "on", since: 5, pid: 4242 } };
  const running = buildLanes(batch).value;
  assert.deepEqual(running[laneKey("AX-3500")][0], RING);
  assert.equal(running[laneKey("AX-3447")][0].icon, "mods/spotlight/icons/flashlight.svg", "another task's batch doesn't spin this lane");
  assertContract(running);
});

// D42: a lane's queue badge is Orca's test-turn badge (TaskTestTurnBadge), a
// text pill with no tooltip: "Probando" filled, "En cola #<n>" and "Pausado"
// outlined.
const PROBANDO = { text: "Probando", tone: "working", pill: true, look: "secondary" };
const queuedPill = (n) => ({ text: `En cola #${n}`, tone: "dim", pill: true, look: "outline" });
const PAUSADO = { text: "Pausado", tone: "dim", pill: true, look: "outline" };

test("D31, D42: the task's queue badge on its lane, Orca's text pill: Probando, En cola #2, Pausado; the rows keep their icons; none with the queue off", () => {
  const s = baseState();
  s.queue.requests.push({
    terminal: "t3", taskKey: "ax/login", label: "login", lane: "ax", state: "waiting", requestedAt: 4, members: [member(FRONT, "front", F2)], workspace: F2, root: FRONT,
  });
  const { value } = buildLanes(s);
  // Orca's order (TaskSectionHeader): the flashlight, the queue badge, then the env pill (D32).
  assert.deepEqual(icons(value[laneKey("AX-3447")]), ["flashlight", "Probando", "Local ▾"]);
  assert.deepEqual(value[laneKey("AX-3447")][1], PROBANDO);
  assert.deepEqual(icons(value[laneKey("AX-3500")]), ["flashlight", "En cola #1", "Local ▾"]);
  assert.deepEqual(value[laneKey("AX-3500")][1], queuedPill(1));
  // Behind AX-3500, and AX-3447 holds front.
  assert.deepEqual(value[laneKey("login")][1], queuedPill(2));
  // The workspace rows keep their queue icons (Herdr's extra), with their reason.
  assert.deepEqual(icons([value[F2][1]]), ["clock"]);
  assert.equal(value[F2][1].text, "#2");
  assert.equal(value[F2][1].tooltip, "En cola #2 · repo ocupado");
  assertContract(value);

  Object.assign(s.queue.requests[1], { state: "paused", pauseReason: "limit", pausedAt: 9 });
  const paused = buildLanes(s).value;
  assert.deepEqual(paused[laneKey("AX-3500")][1], PAUSADO);
  assert.equal(paused[B2][1].tooltip, "Pausado · sin límite", "the row's pause icon keeps its reason");
  assertContract(paused);
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
  assert.deepEqual(icons(value[laneKey("AX-3447")]), ["flashlight", "Probando", "Local ▾"]);
  assert.deepEqual(envOf(value[laneKey("AX-3447")]), pill("AX-3447", "Local"));
  // AX-3500's only member is held by another task's workspace; login's isn't
  // lit: their pill grows in on the header's hover.
  assert.deepEqual(icons(value[laneKey("AX-3500")]), ["flashlight", "En cola #1", "Local ▾"]);
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
  const stored = buildLanes(baseState({ envs: { "task:AX-3447": "prod" } })).value;
  assert.deepEqual(envOf(stored[laneKey("AX-3447")]), pill("AX-3447", "Prod"));
  const local = buildLanes(baseState({ envs: { "task:AX-3447": "local" } }), { settings: settingsOf({ version: 1, repos: { [BACK]: { env: "dev" } } }) }).value;
  assert.deepEqual(envOf(local[laneKey("AX-3447")]), pill("AX-3447", "Local"));
  // The ring while the batch runs keeps the pill beside it.
  const batch = baseState();
  batch.queue.taskBatch = { "ax/AX-3447": { op: "on", since: 5, pid: 4242 } };
  assert.deepEqual(icons(buildLanes(batch).value[laneKey("AX-3447")]), ["spinner", "Probando", "Local ▾"]);
});

test("D32, D39, D46: with nobody holding, the pill is always shown only for a stored env that isn't Local, else it grows in on hover; the same task in another space is the same task", () => {
  const s = baseState({ envs: { "task:AX-3500": "dev", "task:login": "local", "ag/AX-3447": "prod" } });
  const { value } = buildLanes(s);
  assert.deepEqual(envOf(value[laneKey("AX-3500")]), pill("AX-3500", "Dev"));
  assert.deepEqual(envOf(value[laneKey("login")]), pill("login", "Local", { reveal: "grow" }), "Local stored, nothing held: on hover");
  // D46: another space's pick for AX-3447 (stored before D46 as `ag/AX-3447`) is this one's.
  assert.deepEqual(envOf(value[laneKey("AX-3447")]), pill("AX-3447", "Prod"), "another space's pick for AX-3447 is this one's");
  // Its own space's old key too, the later position winning over task:<KEY>.
  const both = buildLanes(baseState({ envs: { "task:AX-3500": "prod", "ax/AX-3500": "dev" } })).value;
  assert.deepEqual(envOf(both[laneKey("AX-3500")]), pill("AX-3500", "Dev"));
  // No flashlight (no member with Spotlight on), no pill: there is no server to run.
  const laneCache = { ...cache, [OTHER]: [...cache[OTHER], { path: `${WS}/other/ax-9`, branch: "juan/AX-9", main: false }] };
  assert.equal(buildLanes(baseState({ envs: { "task:AX-9": "dev" } }), { laneCache }).value[laneKey("AX-9")], undefined);
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
  assert.deepEqual(at({ ...idle, envs: { "task:AX-3447": "prod" } }), { value: "prod", shown: true, repos: [{ name: "back", env: "local" }, { name: "front", env: "local" }] });
  // D46: the group names the lane, not the key: a lane of another space reads the same pick.
  assert.equal(laneEnv({ group: "ag", key: "AX-3447", members, state: { ...idle, envs: { "task:AX-3447": "prod" } }, settings: settingsOf() }).value, "prod");
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
    [baseState({ envs: { "task:AX-3447": "dev" } }), settingsOf()],
    // D46: a record keyed before D46 and an old entry of another space.
    [baseState({ envs: { "ag/AX-3447": "prod" } }), settingsOf()],
  ];
  cases[2][0].repos[BACK].envKey = "task:AX-3447";
  cases[3][0].repos[BACK].envKey = "ax/AX-3447";
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
// D41: the click's argv carries --note, so a refusal is a Spotlight toast and exit 0.
const ROOT_OFF = { exec: [BIN, "toggle", "--workspace", BACK, "--note"] };
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

test("D39, D42: the lit root row, in Orca's order: the SPOTLIGHT chip with the amber bar (the server's tab), the port on line 2, the logs icon and the X on hover", () => {
  const row = rootRow({ logPath: LOG });
  assert.deepEqual(icons(row), ["flashlight", ":3000 +1", "logs", "x"]);
  const [chip, port, logs, x] = row;
  assert.deepEqual(chip, {
    icon: "mods/spotlight/icons/flashlight.svg", text: "Spotlight", tone: "working", pill: true, dot: "on", bar: "working",
    tooltip: CHIP_TIP("Server corriendo en el puerto 3000."), action: PEEK,
  });
  assert.deepEqual(port, {
    text: ":3000 +1", tone: "dim", line: 2, tooltip: "local · pnpm dev --port 3000 · http://localhost:3000 http://localhost:3001",
    action: { command: `spotlight.server.${serverIdOf(BACK)}` },
  });
  assert.deepEqual(logs, { icon: "mods/spotlight/icons/logs.svg", tone: "dim", reveal: "hover", tooltip: LOGS_TIP(`back (${LOG})`) });
  assert.deepEqual(x, X);
  // One port: Orca's ":3000".
  assert.equal(rootRow({ ports: [3000] })[1].text, ":3000");
  // The configured port leads the chip's tooltip, as the port badge's label.
  const settings = settingsOf({ version: 1, repos: { [BACK]: { port: 3001 } } });
  assert.equal(build(baseState(), settings).value[BACK][0].tooltip, CHIP_TIP("Server corriendo en el puerto 3001."));
  // No log path yet: the command alone.
  assert.equal(rootRow()[2].tooltip, LOGS_TIP("back"));
  // The repo's name is projects-sidebar's (the CLI's `--repo` takes it).
  const named = buildBadges({
    state: baseState(), settings: settingsOf(), cache, enabled, bin: BIN, now: NOW,
    projects: parseProjects({ version: 1, groups: [{ id: "ax", name: "AX", projects: [{ path: BACK, name: "back-api" }] }] }),
  });
  assert.equal(named.value[BACK][2].tooltip, LOGS_TIP("back-api"));
  assertContract(build().value);
});

test("D39, D42: with nothing listening the root row has no port: the chip's dot and tooltip carry the server's state; the holder has no server badge", () => {
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
    assert.equal(row[0].bar, "working");
  }
  // Listening with no port read: the chip says it runs, and there is no port badge.
  const bare = rootRow({ ports: [] });
  assert.deepEqual(icons(bare), ["flashlight", "logs", "x"]);
  assert.equal(bare[0].tooltip, CHIP_TIP("Server corriendo."));
  // The holder's row: no server badge, no line 2 while it starts.
  const s = baseState();
  Object.assign(s.repos[BACK], { serverState: "starting", ports: [] });
  assert.deepEqual(icons(build(s).value[B1]), ["flashlight", "flask"]);
});

test("D39: the root terminal's own queue badge takes the logs icon's place on the lit root row; an unlit root keeps it as before", () => {
  const ask = (root) => ({
    terminal: "t7", taskKey: `cwd:${root}`, label: path.basename(root), lane: "ax", state: "holding", requestedAt: 5, grantedAt: 6,
    members: [], workspace: root, root, slotOnly: true,
  });
  const s = baseState();
  s.queue.requests.push(ask(BACK), { ...ask(FRONT), terminal: "t8" });
  const { value } = build(s);
  assert.deepEqual(icons(value[BACK]), ["flashlight", ":3000 +1", "flask", "x"]);
  assert.equal(value[BACK][2].tooltip, "Probando");
  assert.deepEqual(icons(value[FRONT]), ["flask"], "an unlit root: its queue badge alone");
  assertContract(value);
});

test("D39, D33, D42: a busy repo's chip spins with its click kept, and the X stays, disabled, with no action", () => {
  const s = baseState();
  s.repos[BACK].busy = { op: "restart", since: 5, pid: 4242, workspace: B1 };
  const row = build(s).value[BACK];
  assert.deepEqual(icons(row), ["spinner", ":3000 +1", "logs", "x"]);
  assert.deepEqual(row[0], {
    icon: "mods/spotlight/icons/spinner.svg", spin: true, text: "Spotlight", tone: "working", pill: true, dot: "on", bar: "working",
    tooltip: CHIP_TIP("Server corriendo en el puerto 3000."), action: PEEK,
  });
  // Orca's X while syncing: disabled (half opacity), revealed on hover as before.
  const { action, ...shown } = X;
  assert.deepEqual(row[3], { ...shown, disabled: true });
  assert.equal(row[3].action, undefined);
  assertContract(build(s).value);
});

test("D42: the chip is never red: a root error, or a server error under one, leaves it amber with the server's tab as its click, busy or not", () => {
  const diverged = { code: "root-diverged", message: "The repository root moved off the Spotlight snapshot.", at: 5 };
  const row = rootRow({ lastError: diverged });
  assert.deepEqual(icons(row), ["flashlight", ":3000 +1", "logs", "x"]);
  assert.deepEqual(row[0], {
    icon: "mods/spotlight/icons/flashlight.svg", text: "Spotlight", tone: "working", pill: true, dot: "on", bar: "working",
    tooltip: CHIP_TIP("Server corriendo en el puerto 3000."), action: PEEK,
  });
  // A server error under it: the same.
  const under = rootRow({ serverState: "stopped", ports: [], lastError: { ...diverged, serverError: { code: "port-busy", message: "x", at: 4 } } });
  assert.deepEqual([under[0].tone, under[0].action, under[0].bar], ["working", PEEK, "working"]);
  // orca-holds too.
  const orca = rootRow({ lastError: { code: "orca-holds", message: "Este root lo tiene el Spotlight de Orca: apágalo allá primero.", at: 5 } });
  assert.deepEqual([orca[0].tone, orca[0].action], ["working", PEEK]);
  // Busy (a Forzar sync of it): the ring, and a click that shows the tab.
  const busy = rootRow({ lastError: diverged, busy: { op: "sync", since: 5, pid: 4242, workspace: B1 } });
  assert.deepEqual([path.basename(busy[0].icon), busy[0].spin, busy[0].tone, busy[0].action], ["spinner.svg", true, "working", PEEK]);
  assert.deepEqual(icons(busy), ["spinner", ":3000 +1", "logs", "x"]);
});

test("D39: an unlit refused root keeps today's flashlight and popup", () => {
  const s = baseState();
  s.repos = { [FRONT]: repo({ lastError: { code: "untracked-collision", message: "x", at: 5 } }) };
  assert.deepEqual(build(s).value[FRONT], [{
    icon: "mods/spotlight/icons/flashlight.svg", tone: "blocked", tooltip: "Archivos sin seguimiento en el root: abre el server para forzar",
    action: { command: `spotlight.server.${serverIdOf(FRONT)}` },
  }]);
});

test("D39, D42: at most 4 badges per row from Spotlight, line-2 badges included", () => {
  const s = baseState();
  for (const n of [1, 2, 3]) {
    s.queue.requests.push({
      terminal: `q${n}`, taskKey: `ax/AX-9${n}`, label: `AX-9${n}`, lane: "ax", state: "paused", pauseReason: "limit", requestedAt: 9 + n,
      members: [member(BACK, "back", B1)], workspace: B1, root: BACK,
    });
  }
  const { value } = build(s);
  assert.deepEqual(icons(value[B1]), ["flashlight", ":3000 +1", "flask", "pause"]);
  assertContract(value);
  // With the variant tag: the tag, the flashlight and the port (line 2) come first.
  s.repos[BACK].serverVariant = "do";
  const tagged = build(s, settingsOf(), { variants: { [BACK]: ["co", "do"] } }).value;
  assert.deepEqual(icons(tagged[B1]), ["DO", "flashlight", ":3000 +1", "flask"]);
  assert.equal(tagged[B1].filter((b) => b.line === 2).length, 1);
  // A down server's error counts the same.
  Object.assign(s.repos[BACK], { serverState: "stopped", ports: [], lastError: { code: "server-exited", message: "x", at: 5 } });
  assert.deepEqual(icons(build(s, settingsOf(), { variants: { [BACK]: ["co", "do"] } }).value[B1]), ["DO", "flashlight", "server caído", "flask"]);
  // The lit root: chip, port (line 2), logs and X, four.
  assert.equal(value[BACK].length, 4);
  assertContract(tagged);
});

// badges.js imports herdr, so node --test can't load it: its D42 wiring is
// asserted on the source, as the other wiring checks do.
test("D42: badges.js passes the clock and each lit root's variants (from state.json's records, detected as the popup does) to buildBadges", () => {
  const src = fs.readFileSync(path.join(MOD_DIR, "badges.js"), "utf8");
  assert.match(src, /buildBadges\(\{[^}]*\bnow: Date\.now\(\)[^}]*\}\)/, "now: Date.now()");
  assert.match(src, /buildBadges\(\{[^}]*\bvariants\b[^}]*\}\)/, "variants");
  assert.match(src, /const variants = await litVariants\(state\);/);
  assert.match(src, /async function litVariants\(state\) \{[\s\S]*?Object\.entries\(state\?\.repos[\s\S]*?record\.holder[\s\S]*?FACTS_TTL_MS[\s\S]*?detectServerScripts\(root, io\)/, "the lit roots of state.repos, the facts TTL, detectServerScripts");
});
