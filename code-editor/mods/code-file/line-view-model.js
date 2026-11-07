// The read-only view that opens a file at a line (plan D16), because the editor
// can't scroll or jump: which row, what's on it, and its colors. No herdr or
// gpui-kit imports. The tokenizer is deliberately minimal and works line by line,
// so a block comment colors only the line it opens on.

// The syntax colors of plan D5, also what EditorState gets: One Dark Pro's differ
// from the theme's ANSI colors, the one conscious exception to theme().
export const SYNTAX = Object.freeze({
  comment: "#7f848e",
  keyword: "#c678dd",
  string: "#98c379",
  "string.escape": "#56b6c2",
  number: "#d19a66",
  constant: "#d19a66",
  boolean: "#d19a66",
  function: "#61afef",
  type: "#e5c07b",
  variable: "#e06c75",
  operator: "#56b6c2",
  punctuation: "#abb2bf",
});

// Null: plain text, drawn in the theme's foreground.
export const colorOf = (kind) => (kind === "plain" ? null : Object.hasOwn(SYNTAX, kind) ? SYNTAX[kind] : null);

// Rows without line endings. A tab draws as two spaces, Orca's tab size.
export function splitLines(text) {
  return text.split("\n").map((line) => line.replace(/\r$/, "").replaceAll("\t", "  "));
}

// Línea N, from 1, as a row inside the file.
export function lineIndex(line, count) {
  return Math.max(0, Math.min(line, count) - 1);
}

const HASH_COMMENTS = new Set(["py", "sh", "bash", "zsh", "rb", "yaml", "makefile", "pl", "r"]);
const DASH_COMMENTS = new Set(["sql", "lua", "hs"]);

const KEYWORDS = new Set(`
  abstract and as async await break case catch class const continue def default defer del do elif else
  enum export extends false final finally fn for from func function go if impl implements import in
  instanceof interface is let match module mut new nil none not null of or package private protected pub
  public raise return select self static struct super switch this throw trait true try type typeof
  undefined use var void where while with yield
`.trim().split(/\s+/));

// A screen shows less than this; the rest of a minified line stays plain.
const MAX_SCAN = 2000;
const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d[\w.]*/y;

function stringEnd(line, start) {
  const quote = line[start];
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === quote) return i + 1;
  }
  return line.length;
}

function commentMark(language) {
  if (HASH_COMMENTS.has(language)) return "#";
  return DASH_COMMENTS.has(language) ? "--" : "//";
}

function matchAt(regex, line, at) {
  regex.lastIndex = at;
  return regex.exec(line)?.[0] ?? null;
}

export function tokenizeLine(line, language) {
  const tokens = [];
  const mark = commentMark(language);
  const blocks = mark === "//";
  const scan = Math.min(line.length, MAX_SCAN);
  let plainFrom = 0;
  let i = 0;
  const push = (end, kind) => {
    if (i > plainFrom) tokens.push({ text: line.slice(plainFrom, i), kind: "plain" });
    tokens.push({ text: line.slice(i, end), kind });
    i = end;
    plainFrom = end;
  };
  while (i < scan) {
    const c = line[i];
    if (line.startsWith(mark, i)) {
      push(line.length, "comment");
    } else if (blocks && line.startsWith("/*", i)) {
      const close = line.indexOf("*/", i + 2);
      push(close === -1 ? line.length : close + 2, "comment");
    } else if (c === '"' || c === "'" || c === "`") {
      push(stringEnd(line, i), "string");
    } else if (/\d/.test(c)) {
      push(i + matchAt(NUMBER, line, i).length, "number");
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = matchAt(WORD, line, i);
      if (KEYWORDS.has(word)) push(i + word.length, "keyword");
      else i += word.length;
    } else {
      i++;
    }
  }
  if (line.length > plainFrom) tokens.push({ text: line.slice(plainFrom), kind: "plain" });
  return tokens;
}
