// T2: what is on a terminal's screen (A/prompt.js, D5, D8). `hc read` is
// plain text, so: Claude's prompt line empty (or its `Try "…"` placeholder)
// vs any text, a dialog or a screen it can't read; D5's one-character probe
// (`x` typed over the prompt) telling a suggestion from a draft; a bare
// shell prompt vs a typed shell line. The classifier is picked by Core's
// foreground.name, never by the `❯` glyph, which Starship ends in too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROBE_KEY, ERASE_KEY,
  claudePrompt, shellPrompt, readPrompt, classifyProbe, promptRestored,
} from "../mods/agent-sleep/prompt.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// A fixture with its Claude prompt line replaced, as Claude draws it: `❯`
// alone when empty, else `❯` + no-break space + the text (T0's bytes).
function withPrompt(screen, text) {
  return screen
    .split("\n")
    .map((line) => (line.startsWith("❯") ? (text === "" ? "❯" : `❯ ${text}`) : line))
    .join("\n");
}

// ── Claude's prompt line (D5) ──────────────────────────────────────────────

test("the post-turn fixtures: turns 1 and 2 leave an empty prompt, turns 3 and 4 a suggestion (text)", () => {
  assert.equal(claudePrompt(fixture("claude-after-turn1.txt")), "empty");
  assert.equal(claudePrompt(fixture("claude-after-turn2.txt")), "empty");
  assert.equal(claudePrompt(fixture("claude-after-turn3.txt")), "text");
  assert.equal(claudePrompt(fixture("claude-after-turn4.txt")), "text");
});

test("a typed draft is text; the fresh `Try \"…\"` placeholder counts as empty, only when exact", () => {
  assert.equal(claudePrompt(fixture("claude-draft.txt")), "text");
  assert.equal(claudePrompt(fixture("claude-fresh-placeholder.txt")), "empty");
  const fresh = fixture("claude-fresh-placeholder.txt");
  assert.equal(claudePrompt(fresh.replace('Try "fix lint errors"', 'Try "fix lint errors" now')), "text");
  assert.equal(claudePrompt(fresh.replace('Try "fix lint errors"', 'try "fix lint errors"')), "text");
  assert.equal(claudePrompt(fresh.replace('Try "fix lint errors"', "Try fix lint errors")), "text");
});

test("a prompt with more than one line inside the box is a draft: no probe can tell it from a suggestion", () => {
  const screen = fixture("claude-draft.txt").replace("❯ hola", "❯ hola\n  y otra línea");
  assert.equal(claudePrompt(screen), "draft");
});

test("the trust dialog is a dialog (its `❯ No, exit` is a selection, not the prompt)", () => {
  assert.equal(claudePrompt(fixture("claude-trust-dialog.txt")), "dialog");
});

test("screens it can't read are unknown: empty, not text, a shell prompt, a box without the ❯ line", () => {
  assert.equal(claudePrompt(""), "unknown");
  assert.equal(claudePrompt(undefined), "unknown");
  assert.equal(claudePrompt(fixture("shell-bare.txt")), "unknown");
  assert.equal(claudePrompt(fixture("claude-exit.txt")), "unknown");
  const bang = fixture("claude-after-turn1.txt").replace(/^❯$/m, "! ls");
  assert.equal(claudePrompt(bang), "unknown");
});

test("trailing blank rows below the status lines don't hide the box", () => {
  assert.equal(claudePrompt(`${fixture("claude-after-turn1.txt")}\n\n\n`), "empty");
});

// ── D5's one-character probe ───────────────────────────────────────────────

test("the probe keys are `x` and backspace (hc keys names)", () => {
  assert.equal(PROBE_KEY, "x");
  assert.equal(ERASE_KEY, "backspace");
});

test("`❯ x` after the probe: it was a suggestion (treat as empty); the x is on screen, so erase it", () => {
  const before = fixture("claude-after-turn3.txt");
  assert.deepEqual(classifyProbe(before, withPrompt(before, "x")), { verdict: "suggestion", typed: true });
});

test("`❯ holax` after the probe: a draft, never slept; the x is on screen, so erase it", () => {
  const before = fixture("claude-draft.txt");
  assert.deepEqual(classifyProbe(before, withPrompt(before, "holax")), { verdict: "draft", typed: true });
  // A draft that ended in a space Claude doesn't draw: `hola ` + x.
  assert.deepEqual(classifyProbe(before, withPrompt(before, "hola x")), { verdict: "draft", typed: true });
  // A draft that reads exactly like the suggestion is still a draft.
  const same = fixture("claude-after-turn3.txt");
  assert.deepEqual(classifyProbe(same, withPrompt(same, "reply with the single word okx")), { verdict: "draft", typed: true });
});

test("the trust dialog after the probe: unknown, and no backspace (the x isn't on screen)", () => {
  const before = fixture("claude-draft.txt");
  assert.deepEqual(classifyProbe(before, fixture("claude-trust-dialog.txt")), { verdict: "unknown", typed: false });
});

test("the x didn't land: unknown and no backspace, even when the draft itself ends in x", () => {
  const before = fixture("claude-draft.txt");
  assert.deepEqual(classifyProbe(before, before), { verdict: "unknown", typed: false });
  const fix = withPrompt(before, "fix");
  assert.deepEqual(classifyProbe(fix, fix), { verdict: "unknown", typed: false });
  assert.deepEqual(classifyProbe(fix, withPrompt(before, "fixx")), { verdict: "draft", typed: true });
  // Something else replaced the line: no backspace into text we didn't type.
  assert.deepEqual(classifyProbe(before, withPrompt(before, "otra cosax")), { verdict: "unknown", typed: false });
  assert.deepEqual(classifyProbe(before, undefined), { verdict: "unknown", typed: false });
});

// J-001: after the probe's backspace, /exit goes only into a prompt line
// that reads again exactly as before the `x` (T0: a backspace restores a
// suggestion and a draft alike).
test("the prompt line is back only when it reads as before the probe", () => {
  const suggestion = fixture("claude-after-turn3.txt");
  const draft = fixture("claude-draft.txt");
  assert.equal(promptRestored(suggestion, suggestion), true);
  assert.equal(promptRestored(draft, withPrompt(draft, "hola")), true);
  assert.equal(promptRestored(suggestion, withPrompt(suggestion, "x")), false, "the x is still there");
  assert.equal(promptRestored(suggestion, withPrompt(suggestion, "reply with the single word okx")), false);
  assert.equal(promptRestored(draft, withPrompt(draft, "holax")), false);
  assert.equal(promptRestored(suggestion, withPrompt(suggestion, "")), false, "an empty line isn't what was there");
  assert.equal(promptRestored(suggestion, fixture("claude-trust-dialog.txt")), false);
  assert.equal(promptRestored(suggestion, null), false, "a read that failed");
  assert.equal(promptRestored(null, suggestion), false);
});

// ── The shell's line (D8: resume only into a bare prompt) ─────────────────

test("a bare Starship ❯ is a bare shell prompt; a typed line (with autosuggest ghost text) isn't", () => {
  assert.equal(shellPrompt(fixture("shell-bare.txt")), "bare");
  assert.equal(shellPrompt(fixture("shell-typed.txt")), "typed");
  // Right after /exit: the hint, then the shell's prompt.
  assert.equal(shellPrompt(fixture("claude-exit.txt")), "bare");
  assert.equal(shellPrompt(`${fixture("shell-bare.txt")}\n\n`), "bare");
});

test("other prompts: bash $, zsh %, root #, a glyph after the path; typed text after the glyph is typed", () => {
  for (const line of ["juan@mac:~/code$", "bash-5.2$", "juan@mac ~ %", "root@box:/#", "~/code ❯", "λ", "~/code >", "[main $] ~ %"]) {
    assert.equal(shellPrompt(line), "bare", line);
  }
  for (const line of ["juan@mac:~/code$ ls", "juan@mac:~/code$ echo $", "❯ ls >", "% echo hi #", "~/code ❯ git", "❯ e"]) {
    assert.equal(shellPrompt(line), "typed", line);
  }
});

test("a screen with no prompt to read is unknown", () => {
  assert.equal(shellPrompt(""), "unknown");
  assert.equal(shellPrompt("\n\n"), "unknown");
  assert.equal(shellPrompt(null), "unknown");
});

// ── readPrompt: the classifier picked by foreground.name, never by ❯ ──────

test("a bare Starship ❯ is a shell prompt only when the foreground is the shell", () => {
  const bare = fixture("shell-bare.txt");
  assert.deepEqual(readPrompt(bare, "zsh"), { program: "shell", state: "bare" });
  assert.deepEqual(readPrompt(bare, "-zsh"), { program: "shell", state: "bare" });
  assert.deepEqual(readPrompt(bare, "/bin/bash"), { program: "shell", state: "bare" });
  // Claude in the foreground: the same ❯ isn't Claude's empty prompt either.
  assert.deepEqual(readPrompt(bare, "claude.exe"), { program: "claude", state: "unknown" });
  assert.deepEqual(readPrompt(bare, "node"), { program: "other", state: "unknown" });
  assert.deepEqual(readPrompt(bare, undefined), { program: "other", state: "unknown" });
});

test("Claude's empty prompt read with the shell's classifier is not a bare prompt", () => {
  assert.deepEqual(readPrompt(fixture("claude-after-turn1.txt"), "claude.exe"), { program: "claude", state: "empty" });
  assert.deepEqual(readPrompt(fixture("claude-after-turn1.txt"), "zsh"), { program: "shell", state: "typed" });
  assert.deepEqual(readPrompt(fixture("shell-typed.txt"), "zsh"), { program: "shell", state: "typed" });
});

test("prompt.js is pure: no herdr import, no I/O", () => {
  const src = readFileSync(new URL("../mods/agent-sleep/prompt.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']herdr["']/);
  assert.doesNotMatch(src, /\brequire\(|\bDate\.now\(|node:child_process|node:fs/);
});
