// T16: indicators from other plugins ("badges", D38). M/badges-model.js reads
// what other plugins publish under the fixed keys in config.js BADGE_KEYS:
// each key is { [workspacePath]: [badge] }, read through store.js, drawn
// after a workspace row's label by tree.js. The contract other plugins
// consume is RECIPE.md "Badges from other plugins". Spotlight T18 (its D29):
// a key `<groupId>/task:<KEY>` holds that group's task lane badges, drawn on
// the lane's header, and `spin: true` turns a badge's icon. Spotlight T30
// (its D39): badges drawn as Orca's buttons, and `reveal`, `pill`, `dot` and
// `hover`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE_KEYS } from "../projects-sidebar/mods/projects/config.js";
import {
  parseBadges, badgeTooltip, badgeMaxWidth, badgeRun, laneBadgeKey, execFailure, startFailure, BADGE_ROOM, BADGE_GAP,
  iconOf, textOf, actionOf as validAction, publisherOf,
  tint, chipColor, pillStyle, badgeHover, revealStyle, dotStyle, badgeWidths, badgeGaps, badgeLayout, badgeClickable, hasReveal,
  BADGE_MOTION, BADGE_BOX,
} from "../projects-sidebar/mods/projects/badges-model.js";

const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");

const HOME = "/Users/demo";
const LOGIN = "/Users/demo/orca/workspaces/app/login";
const APP = "/code/app";
// A ticket lane of group g1, as the tree keys it (task-model.js laneKey).
const AX = "g1/task:AX-3653";
const ICON = "mods/spotlight/icons/flashlight.svg";

// The one badge a lone spotlight value draws on "/w", or null when dropped.
const one = (badge) => parseBadges([{ "/w": [badge] }])["/w"]?.[0] ?? null;
// Its action, or null.
const actionOf = (action) => one({ text: "x", action })?.action ?? null;

test("parseBadges: badges by workspace path, in BADGE_KEYS order; anything but an object, and non-absolute paths, read as none", () => {
  const spotlight = {
    [LOGIN]: [{ text: "on", tone: "working" }],
    [APP]: [{ icon: "mods/spotlight/icons/eye.svg" }],
  };
  const pr = { [LOGIN]: [{ text: "#12", tone: "done" }] };
  const got = parseBadges([spotlight, pr, undefined]);
  assert.deepEqual(got, {
    [LOGIN]: [
      { key: "badges.spotlight", index: 0, text: "on", tone: "working" },
      { key: "badges.pr", index: 0, text: "#12", tone: "done" },
    ],
    [APP]: [{ key: "badges.spotlight", index: 0, icon: "mods/spotlight/icons/eye.svg", tone: "dim" }],
  });
  // The pr key's badge comes after spotlight's on the same row, whatever the
  // order the values were published in.
  assert.deepEqual(parseBadges([{ [LOGIN]: [{ text: "s" }] }, { [LOGIN]: [{ text: "p" }] }])[LOGIN].map((b) => b.text), ["s", "p"]);

  // A value that isn't a plain object: no badges from that plugin.
  for (const value of [null, undefined, 7, true, "x", JSON.stringify(spotlight), [spotlight], [[{ text: "x" }]]]) {
    assert.deepEqual(parseBadges([value]), {}, JSON.stringify(value));
  }
  assert.deepEqual(parseBadges(undefined), {});
  assert.deepEqual(parseBadges("badges"), {});
  // A path whose value isn't a list draws nothing there; the rest stay.
  assert.deepEqual(Object.keys(parseBadges([{ "/a": { text: "x" }, "/b": "x", "/c": [{ text: "c" }] }])), ["/c"]);

  // Keys must be absolute paths: relative, `~` and empty keys are dropped, and
  // so is a parsed `__proto__`, which stays out of the result.
  const foreign = JSON.parse('{"__proto__": [{"text": "p"}], "rel/x": [{"text": "r"}], "~/x": [{"text": "t"}], "": [{"text": "e"}], "/ok": [{"text": "k"}]}');
  const kept = parseBadges([foreign]);
  assert.deepEqual(Object.keys(kept), ["/ok"]);
  assert.equal(Object.getPrototypeOf(kept), Object.prototype);
  assert.equal(Object.hasOwn(kept, "__proto__"), false);
  // Spelled as `git worktree list` prints them: a trailing slash still lands
  // on the row.
  assert.deepEqual(Object.keys(parseBadges([{ "/code/app/": [{ text: "x" }] }])), ["/code/app"]);
});

test("field rules: the icon path, text and tooltip cuts, the tone, unknown fields", () => {
  // icon: a mods/…/*.svg path, any depth, no `..` or empty segment.
  for (const icon of ["mods/spotlight/eye.svg", "mods/spotlight/icons/deep/eye.svg"]) {
    assert.equal(one({ icon })?.icon, icon, icon);
  }
  for (const icon of [
    "mods/eye.svg", "icons/eye.svg", "/Users/demo/.config/herdr-app/mods/s/eye.svg", "mods/s/../eye.svg", "mods/../s/eye.svg",
    "mods//eye.svg", "mods/s//eye.svg", "mods/s/eye.svg/", "mods/s/eye.png", "mods/s/.svg", "mods\\s\\eye.svg", "", 5, null, ["mods/s/eye.svg"],
  ]) {
    assert.equal(one({ icon }), null, `${JSON.stringify(icon)}: alone, the badge is dropped`);
    assert.equal(Object.hasOwn(one({ icon, text: "t" }), "icon"), false, `${JSON.stringify(icon)}: with text, only the icon goes`);
  }

  // text: cut to 16 code points (a surrogate pair is never split), runs of
  // whitespace and newlines as one space, trimmed; empty or not a string is
  // no text.
  assert.equal(one({ text: "abcdefghijklmnopqrstuvwxyz" }).text, "abcdefghijklmnop");
  const faces = one({ text: "😀".repeat(20) }).text;
  assert.equal([...faces].length, 16);
  assert.equal(faces, "😀".repeat(16));
  assert.equal(one({ text: "  3\n  tests " }).text, "3 tests");
  for (const text of ["", "   ", "\n", 42, null, { a: 1 }]) assert.equal(one({ text }), null, JSON.stringify(text));

  // tone: one of five, else dim.
  for (const tone of ["accent", "dim", "working", "blocked", "done"]) assert.equal(one({ text: "x", tone }).tone, tone);
  for (const tone of [undefined, "red", "idle", "Accent", 3]) assert.equal(one({ text: "x", tone }).tone, "dim", String(tone));

  // tooltip: cut to 200 code points; empty or not a string is none.
  assert.equal(one({ text: "x", tooltip: "t".repeat(250) }).tooltip, "t".repeat(200));
  assert.equal(one({ text: "x", tooltip: "Spotlight on" }).tooltip, "Spotlight on");
  for (const tooltip of ["", 7, null]) assert.equal(Object.hasOwn(one({ text: "x", tooltip }), "tooltip"), false);

  // Unknown fields are ignored: the format only grows.
  assert.deepEqual(one({ text: "x", color: "#f00", onClick: "rm -rf /", since: 3 }), { key: "badges.spotlight", index: 0, text: "x", tone: "dim" });
});

test("actions: a command by pattern, or exec as argv (1–20 strings, no NUL, a bare or absolute program); a bad action goes, the badge stays", () => {
  // `one` publishes under badges.spotlight, so only spotlight.… commands
  // can pass (the publisher rule has its own test below).
  for (const command of ["spotlight.toggle", "spotlight.new-workspace", "spotlight.open_2", "spotlight.b.c-d"]) {
    assert.deepEqual(actionOf({ command }), { command }, command);
  }
  for (const command of [
    "Spotlight.toggle", "spotlight", ".toggle", "spotlight.", "spot light.x", "-a.b", "a.-b", "a.b c", "", 7,
    "spotlight.Toggle", "spotlight.-b", "spotlight.b c",
  ]) {
    assert.equal(actionOf({ command }), null, JSON.stringify(command));
  }

  const argv = ["spotlight", "toggle", "--workspace", LOGIN];
  assert.deepEqual(actionOf({ exec: argv }), { exec: argv });
  assert.deepEqual(actionOf({ exec: ["/usr/bin/true"] }), { exec: ["/usr/bin/true"] });
  const twenty = ["prog", ...Array.from({ length: 19 }, (_, i) => `a${i}`)];
  assert.deepEqual(actionOf({ exec: twenty }), { exec: twenty }, "20 strings");
  assert.deepEqual(actionOf({ exec: ["prog", "x".repeat(500)] }), { exec: ["prog", "x".repeat(500)] }, "500 chars");
  for (const exec of [
    [], [...twenty, "a20"], ["prog", "x".repeat(501)], ["x\0y"], ["prog", "a\0"], ["prog", 5], [null],
    ["./spotlight"], ["bin/spotlight"], ["../spotlight"], [""], "spotlight", { 0: "spotlight" },
  ]) {
    assert.equal(actionOf({ exec }), null, JSON.stringify(exec));
  }

  // Both, neither, or not an object: dropped. The badge always stays.
  for (const action of [{ command: "a.b", exec: ["/usr/bin/true"] }, {}, "spotlight.toggle", ["/usr/bin/true"], 1]) {
    const b = one({ text: "kept", action });
    assert.equal(b.text, "kept");
    assert.equal(Object.hasOwn(b, "action"), false, JSON.stringify(action));
  }

  // What a click's failure toasts (exec resolved or rejected).
  assert.equal(execFailure({ code: 0, stdout: "ok", stderr: "warning: x" }), null);
  assert.equal(execFailure({ code: 1, stdout: "", stderr: "\n  spotlight: no such workspace\nusage: …" }), "spotlight: no such workspace");
  assert.equal(execFailure({ code: 2, stdout: "", stderr: "" }), "exited with code 2");
  assert.equal(startFailure(new Error("No such file or directory (os error 2)\nmore")), "No such file or directory (os error 2)");
  assert.equal(startFailure(new Error("")), "couldn't start");
  assert.equal(startFailure(undefined), "couldn't start");
});

test("a command must be its publisher's own: Herdr's commands and another plugin's drop the action, the rest of the badge stays (L29)", () => {
  const badge = { icon: "mods/spotlight/eye.svg", text: "on", tone: "working", tooltip: "Spotlight on" };
  // The badge one key's value draws on "/w", carrying `command`.
  const under = (key, command) => parseBadges([{ "/w": [{ ...badge, action: { command } }] }], [key])["/w"][0];

  // The part before the first `.` is the key's name after `badges.`.
  assert.deepEqual(under("badges.spotlight", "spotlight.toggle").action, { command: "spotlight.toggle" });
  assert.deepEqual(under("badges.spotlight", "spotlight.b.c-d").action, { command: "spotlight.b.c-d" });
  assert.deepEqual(under("badges.pr", "pr.open").action, { command: "pr.open" });
  assert.deepEqual(under("badges.hibernate", "hibernate.sleep").action, { command: "hibernate.sleep" });
  // Through the fixed list too: pr's value is the second.
  assert.deepEqual(parseBadges([undefined, { "/w": [{ text: "#1", action: { command: "pr.open" } }] }])["/w"][0].action, { command: "pr.open" });
  // A breaking change's new key (badges.spotlight.v2) is still spotlight's.
  assert.deepEqual(under("badges.spotlight.v2", "spotlight.toggle").action, { command: "spotlight.toggle" });

  // `run` also runs Herdr's own commands, and other plugins' are theirs.
  for (const command of [
    "app.quit", "window.close", "app.reset", "pane.close", "tab.close", "space.close", "layout.reset",
    "pr.open", "hibernate.sleep", "projects.new-workspace", "spotlights.toggle", "spot.toggle", "v2.toggle",
  ]) {
    for (const key of ["badges.spotlight", "badges.spotlight.v2"]) {
      const b = under(key, command);
      assert.equal(Object.hasOwn(b, "action"), false, `${key}: ${command}`);
      assert.deepEqual(b, { key, index: 0, ...badge }, `${key}: ${command}, the rest of the badge stays`);
    }
  }
  assert.equal(Object.hasOwn(under("badges.pr", "spotlight.toggle"), "action"), false, "spotlight's command under pr's key");

  // A value with no badges.* key (past the end of the list) runs no command.
  assert.equal(Object.hasOwn(parseBadges([{ "/w": [{ text: "x", action: { command: "0.x" } }] }], [])["/w"][0], "action"), false);

  // exec actions don't name a mod: any publisher's stays.
  assert.deepEqual(parseBadges([{ "/w": [{ text: "x", action: { exec: ["/usr/bin/true"] } }] }], ["badges.pr"])["/w"][0].action, { exec: ["/usr/bin/true"] });
});

test("a tooltip reads as one line, so what a click runs stays in view (L29)", () => {
  const b = one({ text: "x", tooltip: "  Spotlight on\n\nport 3000\t\r\n ", action: { exec: ["spotlight", "toggle"] } });
  assert.equal(b.tooltip, "Spotlight on port 3000");
  assert.equal(badgeTooltip(b), "Spotlight on port 3000 · runs spotlight");

  // Collapsed before the 200-code-point cut; the suffix comes after it.
  const long = one({ text: "x", tooltip: "line\n".repeat(100), action: { exec: ["/usr/local/bin/spotlight"] } });
  assert.doesNotMatch(long.tooltip, /\n/);
  assert.equal([...long.tooltip].length, 200);
  assert.match(badgeTooltip(long), / · runs \/usr\/local\/bin\/spotlight$/);
  assert.doesNotMatch(badgeTooltip(long), /\n/);

  // Only whitespace is no tooltip.
  for (const tooltip of [" ", "\n", " \n\t "]) assert.equal(Object.hasOwn(one({ text: "x", tooltip }), "tooltip"), false, JSON.stringify(tooltip));
});

test("caps (D39): 4 per plugin and 5 per row, in key order; a badge with neither icon nor text is dropped and doesn't count", () => {
  const texts = (row) => row.map((b) => `${b.key.slice(7)}:${b.text}:${b.index}`);
  const six = ["a", "b", "c", "d", "e", "f"].map((text) => ({ text }));
  // A fourth badge from one plugin on a row is kept, a fifth dropped.
  assert.deepEqual(texts(parseBadges([{ "/w": six }])["/w"]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2", "spotlight:d:3"]);

  // Empty badges don't take a place.
  const holes = [{}, { text: "a" }, { tone: "done", tooltip: "t", action: { command: "a.b" } }, { text: "b" }, { icon: "../x.svg" }, { text: "c" }, { text: "d" }, { text: "e" }];
  assert.deepEqual(texts(parseBadges([{ "/w": holes }])["/w"]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2", "spotlight:d:3"]);
  assert.deepEqual(parseBadges([{ "/w": [{ tooltip: "x", action: { exec: ["/usr/bin/true"] } }] }]), {}, "a row with only empty badges draws none");

  // Three plugins on one row: 5 in all, spotlight's first; a sixth is dropped.
  const four = (p) => ({ "/w": ["1", "2", "3", "4"].map((n) => ({ text: `${p}${n}` })), "/v": [{ text: p }] });
  const all = parseBadges([four("s"), four("p"), four("h")]);
  assert.deepEqual(texts(all["/w"]), ["spotlight:s1:0", "spotlight:s2:1", "spotlight:s3:2", "spotlight:s4:3", "pr:p1:0"]);
  assert.deepEqual(texts(all["/v"]), ["spotlight:s:0", "pr:p:0", "hibernate:h:0"], "each row has its own caps");
  // Five on a row from two plugins are all kept.
  const two = parseBadges([{ "/w": [{ text: "s1" }, { text: "s2" }, { text: "s3" }] }, { "/w": [{ text: "p1" }, { text: "p2" }, { text: "p3" }] }]);
  assert.deepEqual(texts(two["/w"]), ["spotlight:s1:0", "spotlight:s2:1", "spotlight:s3:2", "pr:p1:0", "pr:p2:1"]);

  // Two spellings of one path share the plugin's 4.
  assert.deepEqual(
    texts(parseBadges([{ "/w": [{ text: "a" }, { text: "b" }, { text: "c" }], "/w/": [{ text: "d" }, { text: "e" }] }])["/w"]),
    ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2", "spotlight:d:3"],
  );

  // The row's text badges share a fixed room, so five never crush the label.
  assert.equal(badgeMaxWidth(1) > badgeMaxWidth(5), true);
  for (let n = 1; n <= 5; n++) assert.ok(n * badgeMaxWidth(n) + (n - 1) * BADGE_GAP <= BADGE_ROOM, `${n} badges fit in ${BADGE_ROOM} px`);
});

test("badgeTooltip: the tooltip, then what a click runs", () => {
  const exec = { exec: ["spotlight", "toggle", "--workspace", LOGIN] };
  assert.equal(badgeTooltip({ tooltip: "Spotlight on", action: exec }), "Spotlight on · runs spotlight");
  assert.equal(badgeTooltip({ tooltip: "Spotlight on", action: { exec: ["/usr/local/bin/spotlight", "toggle"] } }), "Spotlight on · runs /usr/local/bin/spotlight");
  assert.equal(badgeTooltip({ tooltip: "PR open", action: { command: "pr.open" } }), "PR open · pr.open");
  assert.equal(badgeTooltip({ action: exec }), "runs spotlight");
  assert.equal(badgeTooltip({ action: { command: "pr.open" } }), "pr.open");
  assert.equal(badgeTooltip({ tooltip: "Spotlight on" }), "Spotlight on");
  assert.equal(badgeTooltip({ text: "on" }), null);
  // The suffix comes after the 200-char cut, so it always shows.
  const parsed = one({ text: "x", tooltip: "t".repeat(250), action: { exec: ["spotlight"] } });
  assert.equal(badgeTooltip(parsed), `${"t".repeat(200)} · runs spotlight`);
});

test("BADGE_KEYS is the fixed list, and store.badges reads it through parseBadges, never writing", () => {
  assert.deepEqual(BADGE_KEYS, ["badges.spotlight", "badges.pr", "badges.hibernate"]);
  assert.ok(Object.isFrozen(BADGE_KEYS));
  const store = src("store.js");
  assert.match(store, /import \{[^}]*\bBADGE_KEYS\b[^}]*\} from "\.\/config\.js"/);
  assert.match(store, /import \{[^}]*\bparseBadges\b[^}]*\} from "\.\/badges-model\.js"/);
  assert.match(store, /export const badges = \(\) => parseBadges\(BADGE_KEYS\.map\(\(k\) => shared\(k\)\)\);/);
  assert.doesNotMatch(store, /setShared\([^)]*BADGE/, "badge keys are other plugins' to write");
});

test("tree.js draws a row's badges after its label and runs their actions (D38)", () => {
  const tree = src("tree.js");
  const body = (name) => {
    const start = tree.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `tree.js has ${name}`);
    return tree.slice(start, tree.indexOf("\n}\n", start));
  };

  // render reads the badges once, and the wide tree hands each workspace row its own.
  assert.equal(tree.split("store.badges()").length - 1, 1, "store.badges() is read once, in render");
  assert.match(body("row"), /workspaceRow\(r, t, badges\[r\.path\] \?\? \[\], prs\[r\.path\] \?\? null\)/);

  const row = body("workspaceRow");
  const label = row.indexOf(".child(w.label)");
  const drawn = row.indexOf("badgeStrip(");
  assert.ok(label >= 0 && drawn > label, "the badges come after the label");
  assert.match(row, /badgeLayout\(badges, /, "they share the row's badge room (badgeLayout, D39)");

  const badge = body("badge");
  assert.match(badge, /badgeButton\(/, "drawn as a button (D39)");
  assert.match(badge, /badgeTooltip\(b\)/);
  assert.match(badge, /on_mouse_down\("right", \(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*openWorkspaceMenu\(w\.project, w\.path\)/, "a right-click opens the workspace menu, never the action");
  assert.match(badge, /\.when\(Boolean\(b\.action\), \(el\) => el[\s\S]*?\.on_click\(\(_e, cx\) => \{\s*cx\.stop_propagation\(\);[\s\S]*?if \(clickRuns\(id, slot\)\) runBadge\(/, "a click runs the action, not the row's; without one it is the row's");
  const button = body("badgeButton");
  assert.match(button, /\.flex_none\(\)[\s\S]*?\.max_w\(slot\.maxW\)/, "a badge never grows past its width");
  assert.match(button, /\.truncate\(\)/);
  assert.match(button, /cursor_pointer\(\)/);

  // An exec in flight is guarded by a module Set; argv only, never a shell.
  assert.match(tree, /^const running = new Set\(\);/m);
  const runner = body("runBadge");
  assert.match(runner, /if \(running\.has\(id\)\) return;\s*running\.add\(id\);/);
  assert.match(runner, /finally \{\s*running\.delete\(id\);/);
  // Where it runs and its guard's id come from badgeRun (tested above): a
  // workspace row's badge runs in that workspace's folder, as before.
  assert.match(runner, /const \{ id, cwd \} = badgeRun\(\{ target, badge: b, home: home\(\) \}\);/);
  assert.match(runner, /exec\(argv\[0\], argv\.slice\(1\), \{ cwd \}\)/);
  assert.match(badge, /runBadge\(\{ path: w\.path \}, b, cx\)/);
  assert.match(runner, /run\(command\)/);
  assert.match(runner, /level: "warning"/);
  assert.doesNotMatch(runner, /"sh"|"-c"/, "never a shell");
});

// ── Lane badges and spin (Spotlight T18, its D29) ─────────────────────────

// A row's badges as "<plugin>:<text>:<index>".
const brief = (row) => (row ?? []).map((b) => `${b.key.slice(7)}:${b.text}:${b.index}`);

test("lane keys (D29): `<groupId>/task:<KEY>` holds that group's lane badges, beside path keys, with the same field rules and caps", () => {
  const flashlight = {
    icon: ICON,
    tone: "working",
    tooltip: "Spotlight prendido para esta tarea.",
    action: { exec: ["spotlight", "toggle", "--task", "AX-3653", "--group", "g1"] },
  };
  const got = parseBadges([{
    [LOGIN]: [{ text: "on", tone: "working" }],
    [AX]: [flashlight, { text: "Dev" }],
    "g1/task:login": [{ text: "#2", tone: "accent" }],
    "g2/task:AX-3653": [{ text: "Prod" }],
  }]);
  assert.deepEqual(got, {
    [LOGIN]: [{ key: "badges.spotlight", index: 0, text: "on", tone: "working" }],
    [AX]: [
      { key: "badges.spotlight", index: 0, ...flashlight },
      { key: "badges.spotlight", index: 1, text: "Dev", tone: "dim" },
    ],
    "g1/task:login": [{ key: "badges.spotlight", index: 0, text: "#2", tone: "accent" }],
    // Every group's lanes are read; the tree draws only the active group's.
    "g2/task:AX-3653": [{ key: "badges.spotlight", index: 0, text: "Prod", tone: "dim" }],
  });

  // Each field follows a path badge's rule: a lane key parses a badge
  // exactly as a path key does.
  const onLane = (raw, key = "badges.spotlight") => parseBadges([{ [AX]: [raw] }], [key])[AX]?.[0] ?? null;
  const onPath = (raw, key = "badges.spotlight") => parseBadges([{ [LOGIN]: [raw] }], [key])[LOGIN]?.[0] ?? null;
  for (const raw of [
    { icon: "mods/s/../x.svg", text: "t" },
    { icon: "mods/s/../x.svg" },
    { text: "abcdefghijklmnopqrstuvwxyz", tone: "red" },
    { text: "  3\n  tests ", tooltip: "  a\n\n b ", color: "#f00" },
    { text: "x", action: { command: "spotlight.toggle" } },
    { text: "x", action: { command: "pr.open" } },
    { text: "x", action: { command: "app.quit" } },
    { text: "x", action: { exec: ["./spotlight"] } },
    { text: "x", action: { exec: ["/usr/bin/true", "--task", "AX-3653"] } },
    { text: "x", action: { command: "spotlight.toggle", exec: ["/usr/bin/true"] } },
    { tooltip: "neither icon nor text" },
  ]) {
    assert.deepEqual(onLane(raw), onPath(raw), JSON.stringify(raw));
  }
  assert.deepEqual(onLane({ text: "#1", action: { command: "pr.open" } }, "badges.pr").action, { command: "pr.open" }, "the publisher rule holds on a lane");

  // Caps (D39): 4 per plugin and 5 per lane, in key order.
  const six = ["a", "b", "c", "d", "e", "f"].map((text) => ({ text }));
  assert.deepEqual(brief(parseBadges([{ [AX]: six }])[AX]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2", "spotlight:d:3"]);
  const four = (p) => ({ [AX]: ["1", "2", "3", "4"].map((n) => ({ text: `${p}${n}` })) });
  assert.deepEqual(brief(parseBadges([four("s"), four("p"), four("h")])[AX]), ["spotlight:s1:0", "spotlight:s2:1", "spotlight:s3:2", "spotlight:s4:3", "pr:p1:0"]);
  // A lane and a workspace row each have their own caps.
  const both = parseBadges([{ [AX]: six, [LOGIN]: six }]);
  assert.equal(both[AX].length, 4);
  assert.equal(both[LOGIN].length, 4);

  // The key the tree looks a lane up by: its group's id, "/", its lane.
  assert.equal(laneBadgeKey("g1", "task:AX-3653"), AX);
  assert.equal(laneBadgeKey("g2", "task:login"), "g2/task:login");
});

test("lane keys (D29): no group, no task, No task's lane or a name noteKeyOf refuses is dropped; an absolute key is still a path", () => {
  const raw = (key) => ({ [key]: [{ text: "x" }] });
  for (const key of [
    "g1/task:", "g1/task:none", "g1/task:NONE", "task:AX-3653", "AX-3653", "servers", "g1/servers", "g1/AX-3653",
    "g1/task:__proto__", "g1/task:constructor", "g1/task:Prototype", `g1/task:${"x".repeat(201)}`,
    "g1:task:AX-3653", "g1/Task:AX-3653", "g1task:AX-3653", "",
  ]) {
    assert.deepEqual(parseBadges([raw(key)]), {}, JSON.stringify(key.slice(0, 24)));
  }
  // noteKeyOf's limit: a 200-char name is still a lane.
  const long = `g1/task:${"x".repeat(200)}`;
  assert.deepEqual(Object.keys(parseBadges([raw(long)])), [long]);

  // A parsed `__proto__`, alone or as a lane name, stays out of the result
  // and its prototype.
  const kept = parseBadges([JSON.parse('{"__proto__": [{"text": "p"}], "g1/task:__proto__": [{"text": "q"}], "g1/task:AX-1": [{"text": "k"}]}')]);
  assert.deepEqual(Object.keys(kept), ["g1/task:AX-1"]);
  assert.equal(Object.getPrototypeOf(kept), Object.prototype);

  // A key is read as it is written: no case or slash is fixed, so a lane
  // published in another form than the tree's is kept but drawn nowhere
  // (tree-model.test.js).
  assert.deepEqual(Object.keys(parseBadges([raw("g1/task:ax-3653")])), ["g1/task:ax-3653"]);
  // An absolute key is a path, as before, whatever it spells.
  assert.deepEqual(Object.keys(parseBadges([raw("/g1/task:AX-3653/")])), ["/g1/task:AX-3653"]);
});

test("spin (D29): `spin: true` is kept on path and lane badges; any other value drops alone; a badge without it parses as before", () => {
  const plain = { key: "badges.spotlight", index: 0, icon: ICON, tone: "dim" };
  assert.deepEqual(one({ icon: ICON, spin: true }), { ...plain, spin: true });
  assert.deepEqual(parseBadges([{ [AX]: [{ icon: ICON, spin: true }] }])[AX][0], { ...plain, spin: true });
  assert.deepEqual(one({ text: "x", spin: true }).spin, true, "kept with text alone; only an icon turns");
  // false is the default: no field, as a badge that never had one.
  assert.deepEqual(one({ icon: ICON, spin: false }), plain);
  for (const spin of ["true", 1, 0, null, {}, [true]]) {
    assert.deepEqual(one({ icon: ICON, spin }), plain, `${JSON.stringify(spin)}: dropped alone, the badge stays`);
    assert.deepEqual(one({ icon: ICON, text: "t", tone: "working", spin }), { ...plain, text: "t", tone: "working" }, JSON.stringify(spin));
  }
  // A badge with no icon or text still goes, spin or not.
  assert.equal(one({ spin: true }), null);
});

test("badgeRun (D29): a path badge's exec runs in its workspace, keyed as before; a lane badge's in the home folder, keyed by group and lane", () => {
  const b = { key: "badges.spotlight", index: 1, text: "x", tone: "dim", action: { exec: ["spotlight"] } };
  // A workspace row's: the id runBadge built before T18, and its folder.
  assert.deepEqual(badgeRun({ target: { path: LOGIN }, badge: b, home: HOME }), { id: `${LOGIN}\nbadges.spotlight\n1`, cwd: LOGIN });

  const lane = badgeRun({ target: { group: "g1", lane: "task:AX-3653" }, badge: b, home: HOME });
  assert.equal(lane.cwd, HOME, "a lane has no folder: the home one");
  assert.equal(lane.id, `${AX}\nbadges.spotlight\n1`, "the id holds the group and the lane");

  // Another group's lane of the same name, another plugin's badge or
  // another place in the row is another guard.
  const ids = [
    lane.id,
    badgeRun({ target: { group: "g2", lane: "task:AX-3653" }, badge: b, home: HOME }).id,
    badgeRun({ target: { group: "g1", lane: "task:AX-3653" }, badge: { ...b, key: "badges.pr" }, home: HOME }).id,
    badgeRun({ target: { group: "g1", lane: "task:AX-3653" }, badge: { ...b, index: 0 }, home: HOME }).id,
    badgeRun({ target: { group: "g1", lane: "task:login" }, badge: b, home: HOME }).id,
    badgeRun({ target: { path: LOGIN }, badge: b, home: HOME }).id,
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test("tree.js draws the active group's lane badges on a lane's header, and spins a badge's icon (D29)", () => {
  const tree = src("tree.js");
  const body = (name) => {
    const start = tree.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `tree.js has ${name}`);
    return tree.slice(start, tree.indexOf("\n}\n", start));
  };

  // render hands the rows the active group's id; a lane header gets the
  // badges published under that group and its lane.
  assert.match(tree, /model\.rows\.map\(\(r\) => row\(r, t, notes, badges, prs, model\.group\.id\)\)/);
  assert.match(body("row"), /taskRow\(r, t, notes, group, badges\[laneBadgeKey\(group, r\.lane\)\] \?\? \[\]\)/);

  // After the label, before the count, sharing the row's badge room.
  const header = body("taskRow");
  const label = header.indexOf(".child(l.label)");
  const drawn = header.indexOf("badgeStrip(");
  const count = header.indexOf("String(l.count)");
  assert.ok(label >= 0 && drawn > label && count > drawn, "label, badges, count");
  assert.match(header, /badgeLayout\(badges, /);

  // A lane badge: its hover; a click never folds the lane (stopped whether
  // or not it has an action) and runs the action with the lane as target,
  // only while the badge shows (D39); a right-click opens the task menu,
  // never the action.
  const lane = body("laneBadge");
  assert.match(lane, /badgeButton\(/);
  assert.match(lane, /badgeTooltip\(b\)/);
  assert.match(lane, /on_mouse_down\("right", \(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*openTaskMenu\(l\.lane, l\.label\)/);
  assert.match(lane, /\.on_click\(\(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*if \(b\.action && clickRuns\(id, slot\)\) runBadge\(\{ group, lane: l\.lane \}, b, cx\);/);
  assert.doesNotMatch(lane, /\.when\(Boolean\(b\.action\), \(el\) => el\.cursor_pointer\(\)\.on_click/, "the click is caught with or without an action");

  // Both badge kinds draw their icon through badgeButton's badgeIcon, which
  // turns it when the badge asks. badgeIcon sets no color of its own (D39):
  // the button's color, and its hover's, reach the icon.
  const button = body("badgeButton");
  assert.match(button, /badgeIcon\(b, /);
  assert.doesNotMatch(lane, /badgeIcon\(b, color\)/);
  assert.doesNotMatch(body("badge"), /badgeIcon\(b, color\)/);
  assert.match(body("badgeIcon"), /b\.spin \? pic\.spin\(BADGE_SPIN\) : pic/);
  assert.doesNotMatch(body("badgeIcon"), /text_color/, "the icon inherits the button's color");
  // gpui-kit's spin() takes at least 100 ms a turn.
  assert.ok(Number(/^const BADGE_SPIN = (\d+);/m.exec(tree)?.[1]) >= 100);
});

// ── The validators menu items share (Spotlight T19, its D30) ──────────────

test("the badge validators are exported for menus-model.js, and publisherOf knows badges.* and menus.* (D30)", () => {
  // The publisher: the name right after `badges.` or `menus.`.
  for (const key of ["badges.spotlight", "badges.spotlight.v2", "menus.spotlight", "menus.spotlight.v2"]) {
    assert.equal(publisherOf(key), "spotlight", key);
  }
  assert.equal(publisherOf("badges.pr"), "pr");
  assert.equal(publisherOf("menus.pr"), "pr");
  for (const key of ["badges.", "menus.", "spotlight", "menu.spotlight", "badge.spotlight", "closeGuards.spotlight", "xmenus.spotlight", "", 5, null]) {
    assert.equal(publisherOf(key), null, JSON.stringify(key));
  }

  // actionOf: the publisher's own command, or exec as argv.
  assert.deepEqual(validAction({ command: "spotlight.toggle" }, "spotlight"), { command: "spotlight.toggle" });
  assert.equal(validAction({ command: "pr.open" }, "spotlight"), null);
  assert.equal(validAction({ command: "spotlight.toggle" }, null), null);
  assert.deepEqual(validAction({ exec: ["/usr/bin/true", "a"] }, null), { exec: ["/usr/bin/true", "a"] });
  assert.equal(validAction({ exec: ["./x"] }, "spotlight"), null);

  // textOf: one line, cut at a badge's 16 code points unless told another cap.
  assert.equal(textOf("  a\n  b "), "a b");
  assert.equal(textOf("x".repeat(20)), "x".repeat(16));
  assert.equal(textOf("x".repeat(50), 40), "x".repeat(40));
  assert.equal(textOf(" \n "), null);
  assert.equal(textOf(5), null);

  // iconOf: a mods/…/*.svg path or null.
  assert.equal(iconOf(ICON), ICON);
  assert.equal(iconOf("mods/s/../x.svg"), null);

  // Badges still parse under their keys only: a value read as menus.* is a
  // badge publisher's for commands, but the keys list stays BADGE_KEYS.
  assert.deepEqual(parseBadges([{ "/w": [{ text: "x", action: { command: "spotlight.x" } }] }])["/w"][0].action, { command: "spotlight.x" });
});

// ── Orca's buttons, and reveal / pill / dot / hover (Spotlight T30, its D39) ──

// A theme as theme() hands it: #rrggbb colors by name.
const THEME = {
  hover: "#2c313a", border: "#3e4452", foreground: "#abb2bf", dim: "#8f95a1",
  accent: "#528bff", working: "#e5c07b", blocked: "#e06c75", done: "#98c379",
};
const TOGGLE = { exec: ["spotlight", "toggle", "--workspace", LOGIN] };

test("parse (D39): reveal, pill, dot and hover are kept when valid and dropped alone; the badge always stays", () => {
  const plain = { key: "badges.spotlight", index: 0, icon: ICON, tone: "dim" };
  // reveal: "hover" or "grow".
  for (const reveal of ["hover", "grow"]) assert.deepEqual(one({ icon: ICON, reveal }), { ...plain, reveal }, reveal);
  // pill: true only.
  assert.deepEqual(one({ icon: ICON, pill: true }), { ...plain, pill: true });
  // dot: "on" or "off".
  for (const dot of ["on", "off"]) assert.deepEqual(one({ icon: ICON, dot }), { ...plain, dot }, dot);
  // hover: one of the five tones.
  for (const hover of ["accent", "dim", "working", "blocked", "done"]) assert.deepEqual(one({ icon: ICON, hover }), { ...plain, hover }, hover);

  // Anything else drops that field, never the badge.
  const bad = [undefined, null, 1, 0, true, "", "HOVER", "Grow", "show", {}, ["hover"]];
  for (const reveal of bad) assert.deepEqual(one({ icon: ICON, reveal }), plain, `reveal ${JSON.stringify(reveal)}`);
  for (const pill of [false, "true", 1, null, {}, [true]]) assert.deepEqual(one({ icon: ICON, pill }), plain, `pill ${JSON.stringify(pill)}`);
  for (const dot of [...bad, "ON", "running", "stopped"]) assert.deepEqual(one({ icon: ICON, dot }), plain, `dot ${JSON.stringify(dot)}`);
  for (const hover of [...bad, "red", "idle", "Working"]) assert.deepEqual(one({ icon: ICON, hover }), plain, `hover ${JSON.stringify(hover)}`);
  // All four bad at once, with text and an action: only they go.
  assert.deepEqual(
    one({ text: "x", tone: "working", action: TOGGLE, reveal: "x", pill: 1, dot: "x", hover: "x" }),
    { key: "badges.spotlight", index: 0, text: "x", tone: "working", action: TOGGLE },
  );
  // All four valid together, on a lane key too.
  const all = { icon: ICON, text: "Spotlight", tone: "working", reveal: "grow", pill: true, dot: "off", hover: "blocked" };
  assert.deepEqual(parseBadges([{ [AX]: [all] }])[AX][0], { key: "badges.spotlight", index: 0, ...all });

  // A text badge with no icon is kept (the port, the env pill); one with
  // neither is still dropped, whatever new fields it carries.
  assert.deepEqual(one({ text: ":3000", tone: "dim", action: TOGGLE }), { key: "badges.spotlight", index: 0, text: ":3000", tone: "dim", action: TOGGLE });
  assert.equal(one({ reveal: "hover", pill: true, dot: "on", hover: "working" }), null);
});

test("look (D39): the chip behind a button by tone, the working and blocked tones at 10 %, else the foreground at 15 %", () => {
  assert.equal(tint("#e5c07b", 0.1), "#e5c07b1a");
  assert.equal(tint("#E5C07B", 0.3), "#e5c07b4d");
  assert.equal(tint("#abc", 0.05), "#aabbcc0d", "#rgb is spelled out");
  assert.equal(tint("#e5c07b80", 0.5), "#e5c07b40", "an alpha already there is scaled");
  for (const color of [undefined, null, "", "red", "rgb(1,2,3)", "#12345", "#ggg"]) assert.equal(tint(color, 0.1), null, String(color));

  assert.equal(chipColor("working", THEME), "#e5c07b1a");
  assert.equal(chipColor("blocked", THEME), "#e06c751a");
  // Any other tone: the foreground at 15 %, drawn over the hovered row, so it
  // shows as Orca's gray square does (Juan's screenshot, S24); the theme's
  // hover color alone is the row's own and wouldn't show.
  for (const tone of ["dim", "accent", "done"]) assert.equal(chipColor(tone, THEME), "#abb2bf26", tone);
  // A tone the theme spells as no #hex falls back to the hover color.
  assert.equal(chipColor("working", { ...THEME, working: "orange" }), THEME.hover);
  assert.equal(chipColor("dim", { ...THEME, foreground: "white" }), THEME.hover);
});

test("look (D39): a pill is Orca's dim variant tag or its tone chip", () => {
  // Dim: the theme's border, no fill, Orca's px-1 and semibold.
  assert.deepEqual(pillStyle({ tone: "dim", pill: true }, THEME), { border: THEME.border, bg: null, color: THEME.dim, px: 4, weight: "semibold", size: 10 });
  // Any other tone: the tone's border at 30 %, a 5 % fill, its color, px-1.5, medium.
  assert.deepEqual(pillStyle({ tone: "working", pill: true }, THEME), { border: "#e5c07b4d", bg: "#e5c07b0d", color: THEME.working, px: 6, weight: "medium", size: 10 });
  assert.deepEqual(pillStyle({ tone: "blocked", pill: true }, THEME), { border: "#e06c754d", bg: "#e06c750d", color: THEME.blocked, px: 6, weight: "medium", size: 10 });
  // On hover: the dim tag takes the hover color and lifts its text; the tone chip goes to 15 %.
  assert.deepEqual(badgeHover({ tone: "dim", pill: true, action: TOGGLE }, THEME), { bg: THEME.hover, color: THEME.foreground });
  assert.deepEqual(badgeHover({ tone: "working", pill: true, action: TOGGLE }, THEME), { bg: "#e5c07b26", color: THEME.working });
  // Not a pill: no pill style.
  assert.equal(pillStyle({ tone: "working" }, THEME), null);
});

test("look (D39): a button's hover lifts a dim icon to the foreground, keeps another tone, and `hover` names the tone instead", () => {
  // The chip and the color on hover, by tone.
  assert.deepEqual(badgeHover({ tone: "dim", icon: ICON, action: TOGGLE }, THEME), { bg: "#abb2bf26", color: THEME.foreground });
  assert.deepEqual(badgeHover({ tone: "working", icon: ICON, action: TOGGLE }, THEME), { bg: "#e5c07b1a", color: THEME.working });
  assert.deepEqual(badgeHover({ tone: "blocked", icon: ICON, action: TOGGLE }, THEME), { bg: "#e06c751a", color: THEME.blocked });
  assert.deepEqual(badgeHover({ tone: "done", icon: ICON, action: TOGGLE }, THEME), { bg: "#abb2bf26", color: THEME.done });
  // `hover` (Orca's X: dim, amber on hover): the chip and the icon take that tone.
  assert.deepEqual(badgeHover({ tone: "dim", hover: "working", icon: ICON, action: TOGGLE }, THEME), { bg: "#e5c07b1a", color: THEME.working });
  assert.deepEqual(badgeHover({ tone: "working", hover: "blocked", icon: ICON, action: TOGGLE }, THEME), { bg: "#e06c751a", color: THEME.blocked });
  assert.deepEqual(badgeHover({ tone: "dim", hover: "working", pill: true, action: TOGGLE }, THEME), { bg: "#e5c07b26", color: THEME.working });
  // A badge with nothing to click has no hover look (Orca's logs icon).
  assert.equal(badgeHover({ tone: "dim", icon: ICON }, THEME), null);
  assert.equal(badgeHover({ tone: "dim", icon: ICON, hover: "working" }, THEME), null);
});

test("look (D39): reveal fades in with its row's hover, grow also opens from width 0 to its measured width, at 150 ms ease-in-out", () => {
  assert.deepEqual(BADGE_MOTION, { duration: 150, easing: "ease-in-out" });
  assert.ok(Object.isFrozen(BADGE_MOTION));

  // No reveal: shown at its own width, hovered or not.
  for (const hovered of [false, true]) assert.deepEqual(revealStyle({ icon: ICON }, { hovered, measured: 40 }), { opacity: 1, width: null });
  // "hover": opacity 0 until the row is hovered; it keeps its place (no width).
  assert.deepEqual(revealStyle({ icon: ICON, reveal: "hover" }, { hovered: false }), { opacity: 0, width: null });
  assert.deepEqual(revealStyle({ icon: ICON, reveal: "hover" }, { hovered: true }), { opacity: 1, width: null });
  // "grow": width 0, then the measured width; not measured yet, its own width.
  assert.deepEqual(revealStyle({ text: "Local ▾", reveal: "grow" }, { hovered: false, measured: 46 }), { opacity: 0, width: 0 });
  assert.deepEqual(revealStyle({ text: "Local ▾", reveal: "grow" }, { hovered: true, measured: 46 }), { opacity: 1, width: 46 });
  assert.deepEqual(revealStyle({ text: "Local ▾", reveal: "grow" }, { hovered: true }), { opacity: 1, width: null });
  assert.deepEqual(revealStyle({ text: "Local ▾", reveal: "grow" }, { hovered: false }), { opacity: 0, width: 0 });

  // Which rows track their hover: only those holding a reveal badge.
  assert.equal(hasReveal([{ icon: ICON }, { text: "x", reveal: "hover" }]), true);
  assert.equal(hasReveal([{ text: "x", reveal: "grow" }]), true);
  assert.equal(hasReveal([{ icon: ICON }, { text: "x", pill: true }]), false);
  assert.equal(hasReveal([]), false);
  assert.equal(hasReveal(undefined), false);
});

test("look (D39): the server dot, filled in the done tone or a hollow dim ring, at an icon's corner or after a pill's text", () => {
  assert.deepEqual(dotStyle({ icon: ICON, dot: "on" }, THEME), { place: "corner", size: 6, fill: THEME.done, ring: null });
  assert.deepEqual(dotStyle({ icon: ICON, dot: "off" }, THEME), { place: "corner", size: 6, fill: null, ring: THEME.dim });
  assert.deepEqual(dotStyle({ icon: ICON, text: "Spotlight", pill: true, dot: "on" }, THEME), { place: "after", size: 6, fill: THEME.done, ring: null });
  assert.deepEqual(dotStyle({ icon: ICON, text: ":3000", dot: "on" }, THEME).place, "corner", "an icon badge with text: still the icon's corner");
  assert.deepEqual(dotStyle({ text: ":3000", dot: "off" }, THEME).place, "after", "no icon: after the text");
  assert.equal(dotStyle({ icon: ICON }, THEME), null);
});

test("width (D39): a pill keeps its width, an icon-only badge takes 16 px, text badges share what is left of the room", () => {
  assert.equal(BADGE_BOX, 16);
  const pill = { icon: ICON, text: "Spotlight", tone: "working", pill: true };
  const port = { text: ":3000" };
  const logs = { icon: ICON, reveal: "hover" };
  const x = { icon: ICON, reveal: "hover", hover: "working" };
  // Spotlight's lit root: the pill uncut (null), the port's share, 16 px each icon.
  assert.deepEqual(badgeWidths([pill, port, logs, x]), [null, 72, 16, 16]);
  // Text badges share what icons and gaps leave: 128 - 16 - 2 gaps = 104, by 2.
  assert.deepEqual(badgeWidths([{ icon: ICON }, { text: "a" }, { icon: ICON, text: "b" }]), [16, 52, 52]);
  // Rows of text badges only share as before (badgeMaxWidth).
  for (let n = 1; n <= 5; n++) assert.deepEqual(badgeWidths(Array.from({ length: n }, () => ({ text: "t" }))), Array(n).fill(badgeMaxWidth(n)), `${n} texts`);
  // Pills sit outside the room, never cut, however many.
  assert.deepEqual(badgeWidths([pill, pill, { text: "t" }]), [null, null, 72]);
  assert.deepEqual(badgeWidths([]), []);
  assert.deepEqual(badgeWidths(undefined), []);
});

test("width (D39): gaps go between badges, and a grow badge carries the one beside it, so collapsed it takes none", () => {
  const n = { icon: ICON };
  const g = { text: "Local ▾", reveal: "grow" };
  const gaps = (list) => badgeGaps(list).map(({ ml, pl, pr }) => `${ml}/${pl}/${pr}`);
  const G = BADGE_GAP;
  assert.deepEqual(gaps([n, n, n]), ["0/0/0", `${G}/0/0`, `${G}/0/0`], "a margin before each but the first");
  // The env pill after the flashlight: its gap is inside its width.
  assert.deepEqual(gaps([n, g]), ["0/0/0", `0/${G}/0`]);
  // Between two others: it carries the gap before it; the next keeps its own.
  assert.deepEqual(gaps([n, g, n]), ["0/0/0", `0/${G}/0`, `${G}/0/0`]);
  // First: it carries the gap after it, so nothing is left at the start.
  assert.deepEqual(gaps([g, n]), [`0/0/${G}`, "0/0/0"]);
  assert.deepEqual(gaps([g, g, n]), ["0/0/0", `0/${G}/${G}`, "0/0/0"]);

  // The space a row's badges take outside their own widths, collapsed and
  // shown: collapsed, a grow badge is 0 wide with its gap inside.
  const outside = (list, hovered) => badgeLayout(list, { hovered, measured: list.map(() => 40) })
    .reduce((sum, s, i) => sum + s.ml + (list[i].reveal === "grow" ? s.width ?? 0 : 0), 0);
  for (const list of [[n, g], [n, g, n], [g, n], [g, g, n]]) {
    const others = list.filter((b) => b.reveal !== "grow").length;
    assert.equal(outside(list, false), G * Math.max(others - 1, 0), `collapsed ${JSON.stringify(list.map((b) => (b.reveal ? "g" : "n")))}`);
    // Shown: each grow badge is its measured width plus the gap it carries.
    assert.equal(outside(list, true), G * (list.length - 1) + 40 * (list.length - others), `shown ${list.length}`);
  }
  const [flash, env] = badgeLayout([n, g], { hovered: false, measured: [null, 46] });
  assert.deepEqual(env, { maxW: 72, ml: 0, pl: G, pr: 0, opacity: 0, width: 0, clickable: false });
  assert.deepEqual(flash, { maxW: 16, ml: 0, pl: 0, pr: 0, opacity: 1, width: null, clickable: true });
  assert.deepEqual(badgeLayout([n, g], { hovered: true, measured: [null, 46] })[1], { maxW: 72, ml: 0, pl: G, pr: 0, opacity: 1, width: 46 + G, clickable: true });
});

test("clicks (D39): a reveal badge takes clicks only while its row is hovered", () => {
  assert.equal(badgeClickable({ icon: ICON, action: TOGGLE }, false), true, "no reveal: always");
  assert.equal(badgeClickable({ icon: ICON, action: TOGGLE }, true), true);
  for (const reveal of ["hover", "grow"]) {
    assert.equal(badgeClickable({ icon: ICON, reveal, action: TOGGLE }, false), false, `${reveal}, row not hovered: does nothing`);
    assert.equal(badgeClickable({ icon: ICON, reveal, action: TOGGLE }, true), true, `${reveal}, row hovered`);
  }
  // badgeLayout hands each badge its own answer.
  const row = [{ icon: ICON, action: TOGGLE }, { icon: ICON, reveal: "hover", action: TOGGLE }];
  assert.deepEqual(badgeLayout(row, { hovered: false }).map((s) => s.clickable), [true, false]);
  assert.deepEqual(badgeLayout(row, { hovered: true }).map((s) => s.clickable), [true, true]);
});

test("D39: badges with none of the new fields draw as before, apart from the chip", () => {
  const b = one({ icon: ICON, text: "on", tone: "working", tooltip: "t", action: TOGGLE });
  assert.deepEqual(b, { key: "badges.spotlight", index: 0, icon: ICON, text: "on", tone: "working", tooltip: "t", action: TOGGLE });
  assert.deepEqual(revealStyle(b, { hovered: false }), { opacity: 1, width: null }, "always shown");
  assert.equal(dotStyle(b, THEME), null, "no dot");
  assert.equal(pillStyle(b, THEME), null, "no pill");
  assert.equal(hasReveal([b]), false, "its row tracks no hover");
  assert.deepEqual(badgeLayout([b, b], { hovered: false }).map((s) => [s.maxW, s.ml, s.opacity, s.clickable]), [[62, 0, 1, true], [62, BADGE_GAP, 1, true]]);
  // The chip is the one change: with an action, a hover look in its tone.
  assert.deepEqual(badgeHover(b, THEME), { bg: "#e5c07b1a", color: THEME.working });
});

test("tree.js applies D39's look: the button, the reveal, the grow clip, the hovered row, the shrinking names", () => {
  const tree = src("tree.js");
  const body = (name) => {
    const start = tree.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `tree.js has ${name}`);
    return tree.slice(start, tree.indexOf("\n}\n", start));
  };
  for (const name of ["badgeLayout", "badgeHover", "pillStyle", "dotStyle", "hasReveal", "BADGE_MOTION", "BADGE_BOX"]) {
    assert.match(tree, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./badges-model\\.js"`), `tree.js imports ${name}`);
  }

  // The button: Orca's 16 px rounded box, its chip and lift on hover (only
  // with an action), the pill's border and fill, the dot, and the reveal's
  // opacity moving at BADGE_MOTION.
  const button = body("badgeButton");
  assert.match(button, /badgeHover\(b, t\)/);
  assert.match(button, /pillStyle\(b, t\)/);
  assert.match(button, /dotStyle\(b, t\)/);
  assert.match(button, /\.h\(BADGE_BOX\)/);
  assert.match(button, /\.rounded\(4\)/);
  assert.match(button, /\.when\(Boolean\(hover\), \(el\) => el\.hover\(\(s\) => s\.bg\(hover\.bg\)\.text_color\(hover\.color\)\)\)/, "the chip and the lift, instant");
  assert.match(button, /\.when\(Boolean\(b\.action\) && slot\.clickable, \(el\) => el\.cursor_pointer\(\)\)/, "a pointer only on what can be clicked");
  assert.match(button, /b\.reveal === "hover"[\s\S]*?\.opacity\(slot\.opacity\)\.transition\("opacity", BADGE_MOTION\)/);
  assert.match(button, /\.when\(slot\.maxW !== null, \(el\) => el\.max_w\(slot\.maxW\)\)/, "a pill (maxW null) is never cut");
  assert.match(button, /\.when\(Boolean\(b\.icon\), /, "a text badge with no icon draws no icon slot");
  assert.match(button, /\.border\(1\)\.border_color\(pill\.border\)/);
  assert.match(button, /toUpperCase\(\)/, "a pill's text is uppercase");

  // The strip: a grow badge sits in a clip whose width and opacity move, the
  // gap it carries inside; its button reports its width.
  const strip = body("badgeStrip");
  assert.match(strip, /\.overflow_hidden\(\)/);
  assert.match(strip, /\.transition\("width", BADGE_MOTION\)/);
  assert.match(strip, /\.transition\("opacity", BADGE_MOTION\)/);
  assert.match(strip, /on_size_change\(/);
  assert.doesNotMatch(strip, /\.gap\(/, "gaps come from badgeLayout, never the strip");

  // The hovered row: on_hover only on rows holding a reveal badge, workspace
  // rows and lane headers; none on project or agent rows.
  for (const name of ["workspaceRow", "taskRow"]) {
    assert.match(body(name), /\.when\(hasReveal\(badges\), \(el\) => el\.on_hover\(\(on, cx\) => hoverRow\(/, `${name} tracks its hover only with a reveal badge`);
    assert.match(body(name), /badgeLayout\(badges, \{ hovered: hovered === /, `${name} lays its badges out with its hover`);
  }
  for (const name of ["projectRow", "agentRow", "railRow"]) assert.doesNotMatch(body(name), /on_hover\(/, `${name} has no on_hover`);
  // Redrawn on enter and leave, only when it changes.
  assert.match(body("hoverRow"), /cx\.notify\(\)/);
  // A press while the badge shows arms its click, so a row's hover lost
  // during the press (GPUI reports a pressed row as left when the pointer
  // moves) never refuses it; a press while it doesn't show disarms it.
  for (const name of ["badge", "laneBadge"]) assert.match(body(name), /on_mouse_down\("left", \(\) => armBadge\(id, slot\)\)/, `${name} arms on its press`);
  assert.match(body("armBadge"), /pressed = slot\.clickable \? id : null;/);
  assert.match(body("clickRuns"), /const runs = slot\.clickable \|\| pressed === id;\s*pressed = null;\s*return runs;/);
  // A click that moves rows clears it: a lane's fold (but the lane clicked,
  // still under the pointer), a project's fold, a project's drop; leaving
  // the list too.
  assert.match(body("taskRow"), /\.on_click\(\(\) => \{\s*rowsMoved\(hasReveal\(badges\) \? id : null\);\s*store\.toggleTaskCollapsed\(l\.lane\);/);
  assert.match(body("projectRow"), /rowsMoved\(null\);\s*store\.toggleCollapsed\(p\.path\);/);
  assert.match(body("drop"), /rowsMoved\(null\);/);
  assert.match(tree, /\.on_hover\(\(on, cx\) => \{\s*if \(!on\) hoverRow\(hovered, false, cx\);/, "leaving the list clears the hovered row");

  // The width order: the label gives way first (flex_1, min_w 0), then the
  // Task-mode project name (it shrinks now, under its 110 px cap), then the
  // text badges, already cut to their share; the strip itself never shrinks.
  const row = body("workspaceRow");
  assert.match(row, /div\(\)\.flex_1\(\)\.min_w\(0\)\.truncate\(\)[^\n]*w\.label/);
  assert.match(row, /div\(\)\.flex_shrink\(1\)\.min_w\(0\)\.max_w\(110\)\.truncate\(\)[^\n]*w\.projectName/);
  assert.doesNotMatch(row, /flex_none\(\)\.max_w\(110\)/);
  assert.match(strip, /h_flex\(\)\.flex_none\(\)/);
});
