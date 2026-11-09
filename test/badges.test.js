// T16: indicators from other plugins ("badges", D38). M/badges-model.js reads
// what other plugins publish under the fixed keys in config.js BADGE_KEYS:
// each key is { [workspacePath]: [badge] }, read through store.js, drawn
// after a workspace row's label by tree.js. The contract other plugins
// consume is RECIPE.md "Badges from other plugins". Spotlight T18 (its D29):
// a key `<groupId>/task:<KEY>` holds that group's task lane badges, drawn on
// the lane's header, and `spin: true` turns a badge's icon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE_KEYS } from "../projects-sidebar/mods/projects/config.js";
import {
  parseBadges, badgeTooltip, badgeMaxWidth, badgeRun, laneBadgeKey, execFailure, startFailure, BADGE_ROOM, BADGE_GAP,
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

test("caps: 3 per plugin and 4 per row, in key order; a badge with neither icon nor text is dropped and doesn't count", () => {
  const texts = (row) => row.map((b) => `${b.key.slice(7)}:${b.text}:${b.index}`);
  const five = ["a", "b", "c", "d", "e"].map((text) => ({ text }));
  assert.deepEqual(texts(parseBadges([{ "/w": five }])["/w"]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2"]);

  // Empty badges don't take a place.
  const holes = [{}, { text: "a" }, { tone: "done", tooltip: "t", action: { command: "a.b" } }, { text: "b" }, { icon: "../x.svg" }, { text: "c" }, { text: "d" }];
  assert.deepEqual(texts(parseBadges([{ "/w": holes }])["/w"]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2"]);
  assert.deepEqual(parseBadges([{ "/w": [{ tooltip: "x", action: { exec: ["/usr/bin/true"] } }] }]), {}, "a row with only empty badges draws none");

  // Three plugins on one row: 4 in all, spotlight's first.
  const three = (p) => ({ "/w": ["1", "2", "3"].map((n) => ({ text: `${p}${n}` })), "/v": [{ text: p }] });
  const all = parseBadges([three("s"), three("p"), three("h")]);
  assert.deepEqual(texts(all["/w"]), ["spotlight:s1:0", "spotlight:s2:1", "spotlight:s3:2", "pr:p1:0"]);
  assert.deepEqual(texts(all["/v"]), ["spotlight:s:0", "pr:p:0", "hibernate:h:0"], "each row has its own caps");

  // Two spellings of one path share the plugin's 3.
  assert.deepEqual(texts(parseBadges([{ "/w": [{ text: "a" }, { text: "b" }], "/w/": [{ text: "c" }, { text: "d" }] }])["/w"]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2"]);

  // The row's badges share a fixed room, so four never crush the label.
  assert.equal(badgeMaxWidth(1) > badgeMaxWidth(4), true);
  for (let n = 1; n <= 4; n++) assert.ok(n * badgeMaxWidth(n) + (n - 1) * BADGE_GAP <= BADGE_ROOM, `${n} badges fit in ${BADGE_ROOM} px`);
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
  const drawn = row.indexOf(".children(badges.map(");
  assert.ok(label >= 0 && drawn > label, "the badges come after the label");
  assert.match(row, /badgeMaxWidth\(badges\.length\)/, "they share the row's badge room");

  const badge = body("badge");
  assert.match(badge, /\.flex_none\(\)[\s\S]*?\.max_w\(width\)/, "a badge never grows past its width");
  assert.match(badge, /\.truncate\(\)/);
  assert.match(badge, /badgeTooltip\(b\)/);
  assert.match(badge, /on_mouse_down\("right", \(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*openWorkspaceMenu\(w\.project, w\.path\)/, "a right-click opens the workspace menu, never the action");
  assert.match(badge, /\.on_click\(\(_e, cx\) => \{\s*cx\.stop_propagation\(\);[\s\S]*?runBadge\(/, "a click runs the action, not the row's");
  assert.match(badge, /cursor_pointer\(\)/);

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

  // Caps: 3 per plugin and 4 per lane, in key order.
  const five = ["a", "b", "c", "d", "e"].map((text) => ({ text }));
  assert.deepEqual(brief(parseBadges([{ [AX]: five }])[AX]), ["spotlight:a:0", "spotlight:b:1", "spotlight:c:2"]);
  const three = (p) => ({ [AX]: ["1", "2", "3"].map((n) => ({ text: `${p}${n}` })) });
  assert.deepEqual(brief(parseBadges([three("s"), three("p"), three("h")])[AX]), ["spotlight:s1:0", "spotlight:s2:1", "spotlight:s3:2", "pr:p1:0"]);
  // A lane and a workspace row each have their own caps.
  const both = parseBadges([{ [AX]: five, [LOGIN]: five }]);
  assert.equal(both[AX].length, 3);
  assert.equal(both[LOGIN].length, 3);

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
  const drawn = header.indexOf(".children(badges.map(");
  const count = header.indexOf("String(l.count)");
  assert.ok(label >= 0 && drawn > label && count > drawn, "label, badges, count");
  assert.match(header, /badgeMaxWidth\(badges\.length\)/);

  // A lane badge: its hover; a click never folds the lane (stopped whether
  // or not it has an action) and runs the action with the lane as target;
  // a right-click opens the task menu, never the action.
  const lane = body("laneBadge");
  assert.match(lane, /\.flex_none\(\)[\s\S]*?\.max_w\(width\)/);
  assert.match(lane, /\.truncate\(\)/);
  assert.match(lane, /badgeTooltip\(b\)/);
  assert.match(lane, /on_mouse_down\("right", \(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*openTaskMenu\(l\.lane, l\.label\)/);
  assert.match(lane, /\.on_click\(\(_e, cx\) => \{\s*cx\.stop_propagation\(\);[^}]*if \(b\.action\) runBadge\(\{ group, lane: l\.lane \}, b, cx\);/);
  assert.doesNotMatch(lane, /\.when\(Boolean\(b\.action\), \(el\) => el\.cursor_pointer\(\)\.on_click/, "the click is caught with or without an action");

  // Both badge kinds draw their icon through badgeIcon, which turns it when
  // the badge asks.
  assert.match(lane, /badgeIcon\(b, color\)/);
  assert.match(body("badge"), /badgeIcon\(b, color\)/);
  assert.match(body("badgeIcon"), /b\.spin \? pic\.spin\(BADGE_SPIN\) : pic/);
  // gpui-kit's spin() takes at least 100 ms a turn.
  assert.ok(Number(/^const BADGE_SPIN = (\d+);/m.exec(tree)?.[1]) >= 100);
});
