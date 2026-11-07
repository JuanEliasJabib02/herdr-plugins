// What a terminal's screen says about its input line (D5, D8). Pure: screens
// in (`hc read` text, plain, no styling), verdicts out; no herdr import.
//
// The classifier is picked by Core's foreground.name, never by the `❯`
// glyph: Claude's prompt and Juan's Starship prompt both end in it.
//
// Claude Code 2.1.318 draws its input as a box between two rows of `─`:
//
//   ────────────────
//   ❯ <text>            `❯` alone when empty; `❯` + no-break space + text
//   ────────────────
//     <status lines>
//
// Plain text can't tell a prompt suggestion from a typed draft (T0: 2 of 4
// turns left one), so D5 sleeps a Claude only when that line is empty or
// exactly the fresh `Try "…"` placeholder, and otherwise probes: the
// coordinator types `x` (PROBE_KEY), reads the screen, and classifyProbe
// says what it was; the `x` is erased (ERASE_KEY) only when it is on screen,
// and promptRestored says whether the erase brought the line back.

import { isClaudeName } from "./claude-session.js";

export const PROBE_KEY = "x";
export const ERASE_KEY = "backspace";

const GLYPH = "❯";
// A row of Claude's box: only `─`, wide enough to be a border (a terminal
// is never narrower than this).
const BORDER = /^─{10,}$/;
// The prompt line: `❯`, then nothing or one (no-break) space and the text.
const PROMPT_LINE = /^❯(?:[  ](.*))?$/;
const PLACEHOLDER = /^Try "[^"]+"$/;
// A selection cursor in a dialog: an indented `❯` (` ❯ No, exit`).
const DIALOG_CURSOR = /^\s+❯\s/;

function rows(text) {
  return typeof text === "string" ? text.split("\n").map((l) => l.trimEnd()) : [];
}

// The rows inside the bottom-most box (the last two border rows with
// something between them), or null when there's no box.
function boxRows(lines) {
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BORDER.test(lines[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom === -1) return null;
  for (let i = bottom - 1; i >= 0; i--) {
    if (BORDER.test(lines[i])) return i < bottom - 1 ? lines.slice(i + 1, bottom) : null;
  }
  return null;
}

// The text on Claude's prompt line ("" when empty), or null when the box
// isn't there or holds more than that one line.
function promptText(text) {
  const box = boxRows(rows(text));
  if (box === null || box.length !== 1) return null;
  const match = PROMPT_LINE.exec(box[0]);
  return match ? (match[1] ?? "").trimEnd() : null;
}

// Claude's input line:
//   "empty"    `❯` alone, or exactly the `Try "…"` placeholder: nothing to lose
//   "text"     one line of text: a draft or a suggestion (D5's probe tells)
//   "draft"    more than one line in the box: typed, no probe needed
//   "dialog"   no prompt box, but a dialog's selection cursor (trust, pickers)
//   "unknown"  anything else (fail closed)
export function claudePrompt(text) {
  const lines = rows(text);
  const box = boxRows(lines);
  if (box !== null && box[0].startsWith(GLYPH)) {
    if (box.length > 1) return "draft";
    const match = PROMPT_LINE.exec(box[0]);
    if (match) {
      const typed = (match[1] ?? "").trimEnd();
      return typed === "" || PLACEHOLDER.test(typed) ? "empty" : "text";
    }
  }
  return lines.some((l) => DIALOG_CURSOR.test(l)) ? "dialog" : "unknown";
}

// D5's probe, from the screen before `x` was typed and the one after:
//   { verdict: "suggestion" }  `❯ x`: the text was a suggestion, gone on
//                              typing; sleep as if empty
//   { verdict: "draft" }       `❯ <text>x`: the person's draft; never sleep
//   { verdict: "unknown" }     anything else; never sleep
// `typed` is true only when the `x` this probe typed is on screen, so the
// coordinator sends a backspace then and only then: never into a line it
// can't read, never over a draft's own last `x`.
export function classifyProbe(before, after) {
  const was = promptText(before);
  const now = promptText(after);
  if (now === null) return { verdict: "unknown", typed: false };
  if (now === PROBE_KEY) return { verdict: "suggestion", typed: true };
  // Claude doesn't draw a draft's trailing spaces: `hola ` reads as `hola`
  // before and `hola x` after.
  if (was !== null && was !== "" && now.endsWith(PROBE_KEY) && now.slice(0, -PROBE_KEY.length).trimEnd() === was) {
    return { verdict: "draft", typed: true };
  }
  return { verdict: "unknown", typed: false };
}

// After the probe's backspace: true only when Claude's prompt line reads
// again exactly as it did before the `x` (T0: a backspace restores a
// suggestion and a draft alike). Anything else, a screen it can't read
// included, may still hold the `x`, so the coordinator sends no /exit after
// it (Claude would get `x/exit` as a prompt).
export function promptRestored(before, after) {
  const was = promptText(before);
  return was !== null && promptText(after) === was;
}

// ── The shell (D8: resume only into a bare prompt) ─────────────────────────

const SHELLS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "oksh", "pdksh", "yash", "ash",
  "csh", "tcsh", "nu", "elvish", "xonsh", "pwsh", "powershell",
]);
// What prompts end in: Starship/pure `❯`, bash `$`, zsh `%`, root `#`, and
// the usual themes' `>`, `›`, `»`, `➜`, `λ`.
const PROMPT_END = /[❯›»➜λ$%#>]$/u;
// A prompt glyph followed by a space and more: text typed after a prompt.
const TYPED_AFTER = /[❯›»➜λ$%#>]\s+\S/u;

// A program name as Core or argv[0] gives it: `/bin/zsh`, `-zsh` (a login
// shell), `pwsh.exe` → zsh, zsh, pwsh.
export function shellName(name) {
  if (typeof name !== "string") return null;
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/^-/, "").replace(/\.exe$/i, "");
  return SHELLS.has(base) ? base : null;
}

// The shell's input line, from the last non-blank row:
//   "bare"     it ends in a prompt glyph with nothing typed after any glyph
//   "typed"    anything else: a command typed, autosuggest ghost text, a
//              program's output
//   "unknown"  nothing on screen
// A typed line that happens to end in a glyph (`$ echo $`) still has the
// prompt's glyph followed by text, so it reads as typed (fail closed).
export function shellPrompt(text) {
  const lines = rows(text).filter((l) => l.trim() !== "");
  if (lines.length === 0) return "unknown";
  const last = lines[lines.length - 1].trim();
  return PROMPT_END.test(last) && !TYPED_AFTER.test(last) ? "bare" : "typed";
}

// The classifier Core's foreground.name picks:
// → { program: "claude" | "shell" | "other", state } with claudePrompt's or
// shellPrompt's state, or "unknown" for any other program.
export function readPrompt(text, foregroundName) {
  if (isClaudeName(foregroundName)) return { program: "claude", state: claudePrompt(text) };
  if (shellName(foregroundName) !== null) return { program: "shell", state: shellPrompt(text) };
  return { program: "other", state: "unknown" };
}
