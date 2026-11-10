// A Claude stopped at a startup dialog, read off its screen (resume-gaps D4).
// Pure: `hc read` text in (plain, no styling), the question or null out; no
// hc call, no file.
//
// Claude Code asks some things before its first prompt, while it has no
// session file yet: the folder trust check ("Accessing workspace:"), "Allow
// external CLAUDE.md file imports?". Each is drawn under a row of `─`, with
// a list whose chosen line starts with an indented `❯` (one space in the
// trust dialog, two in the imports one), and "Enter to confirm" at the
// bottom:
//
//   ────────────────────────────────────────
//     Allow external CLAUDE.md file imports?
//     …
//     ❯ No, disable external imports
//       Yes, allow external imports
//
//     Enter to confirm · Esc to cancel
//
// Read from the bottom, as agent-sleep's prompt.js reads Claude's input box:
// a screen can still hold an older render of the dialog higher up, and its
// top line can be a border (test/fixtures/claude-screens/). Claude's input
// box draws a border under any dialog it answered, so a running Claude's
// screen doesn't read as one. A shell can still show the last frame of a
// dialog Claude quit from: the caller reads only a terminal whose
// foreground isn't its shell.
//
// dialogQuestion(screen): when below the screen's last border there is a
// dialog cursor and an "Enter to confirm" line under it, the dialog's
// question: the sentence ending in the first `?` of its text (the trust
// dialog's is inside a paragraph, under its "Accessing workspace:" label),
// else its first non-empty line, trimmed; null when there's no dialog.

// A row of `─` wide enough to be a border (agent-sleep's prompt.js BORDER).
const BORDER = /^─{10,}$/;
// A dialog's chosen line: an indented `❯` (prompt.js DIALOG_CURSOR). A
// shell prompt's `❯` starts its line.
const DIALOG_CURSOR = /^\s+❯\s/;
const CONFIRM = /^\s*Enter to confirm\b/;

export function dialogQuestion(screen) {
  const lines = typeof screen === "string" ? screen.split(/\r?\n/).map((l) => l.trimEnd()) : [];
  let border = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (BORDER.test(lines[i])) {
      border = i;
      break;
    }
  }
  if (border < 0) return null;
  const below = lines.slice(border + 1);
  const confirm = below.findLastIndex((l) => CONFIRM.test(l));
  if (confirm < 0) return null;
  const body = below.slice(0, confirm);
  if (!body.some((l) => DIALOG_CURSOR.test(l))) return null;
  const asked = body.find((l) => !DIALOG_CURSOR.test(l) && l.includes("?"));
  if (asked !== undefined) return askedSentence(asked);
  const question = body.find((l) => l.trim() !== "");
  return question ? question.trim() : null;
}

// The sentence that ends in a line's first `?`: "Quick safety check: Is this
// … trust? (Like …" → "Is this … trust?". A sentence starts after `. `, `: `
// or `! ` (so "CLAUDE.md" doesn't split one).
function askedSentence(line) {
  const upTo = line.slice(0, line.indexOf("?") + 1);
  const starts = [...upTo.matchAll(/[.:!]\s+/g)];
  const from = starts.length > 0 ? starts[starts.length - 1].index + starts[starts.length - 1][0].length : 0;
  return upTo.slice(from).trim();
}
