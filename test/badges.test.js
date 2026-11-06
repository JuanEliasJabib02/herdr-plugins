// T16: indicators from other plugins ("badges", D38). M/badges-model.js reads
// what other plugins publish under the fixed keys in config.js BADGE_KEYS:
// each key is { [workspacePath]: [badge] }, read through store.js, drawn
// after a workspace row's label by tree.js. The contract other plugins
// consume is RECIPE.md "Badges from other plugins".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE_KEYS } from "../projects-sidebar/mods/projects/config.js";
import {
  parseBadges, badgeTooltip, badgeMaxWidth, execFailure, startFailure, BADGE_ROOM, BADGE_GAP,
} from "../projects-sidebar/mods/projects/badges-model.js";

const src = (f) => readFileSync(new URL(`../projects-sidebar/mods/projects/${f}`, import.meta.url), "utf8");

const LOGIN = "/Users/demo/orca/workspaces/app/login";
const APP = "/code/app";

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
  for (const command of ["spotlight.toggle", "projects.new-workspace", "pr.open_2", "a1.b.c-d"]) {
    assert.deepEqual(actionOf({ command }), { command }, command);
  }
  for (const command of ["Spotlight.toggle", "spotlight", ".toggle", "spotlight.", "spot light.x", "-a.b", "a.-b", "a.b c", "", 7]) {
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
  assert.match(body("row"), /workspaceRow\(r, t, badges\[r\.path\] \?\? \[\]\)/);

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
  assert.match(runner, /exec\(argv\[0\], argv\.slice\(1\), \{ cwd: path \}\)/);
  assert.match(runner, /run\(command\)/);
  assert.match(runner, /level: "warning"/);
  assert.doesNotMatch(runner, /"sh"|"-c"/, "never a shell");
});
