// Text helpers shared by the mod's models (badges-model.js,
// server-view-model.js) and the CLI's modules (ports.js, cli-work.mjs). Pure:
// it imports nothing, so the mod, the CLI and `node --test` all load it.

// Text on one line: every run of whitespace one space, trimmed; null and
// undefined read "". A badge's text and tooltip, a popup line, a command line
// shown in an error, and a start time as `ps -o lstart=` prints it ("Sun Nov
// 8 …", its runs of spaces folded) all go through it.
export const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
