// The read-only view for opening at a line (plan D16): rows, the row to scroll
// to, and a minimal per-line tokenizer colored as D5 says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNTAX, colorOf, lineIndex, splitLines, tokenizeLine } from "../code-editor/mods/code-file/line-view-model.js";

const kindsOf = (tokens) => tokens.filter((t) => t.kind !== "plain").map((t) => [t.text, t.kind]);
const joined = (tokens) => tokens.map((t) => t.text).join("");

test("D16: lines without their line endings; tabs drawn as two spaces", () => {
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("a\n"), ["a", ""]);
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("\tx"), ["  x"]);
});

test("D16: Línea N is the row N-1, inside the file", () => {
  assert.equal(lineIndex(1, 10), 0);
  assert.equal(lineIndex(10, 10), 9);
  assert.equal(lineIndex(99, 10), 9);
  assert.equal(lineIndex(0, 10), 0);
  assert.equal(lineIndex(5, 0), 0);
});

test("D16: comments, strings, numbers, keywords, per line", () => {
  assert.deepEqual(kindsOf(tokenizeLine('const a = "x" + 12; // done', "js")), [
    ["const", "keyword"], ['"x"', "string"], ["12", "number"], ["// done", "comment"],
  ]);
  assert.deepEqual(kindsOf(tokenizeLine("# note", "py")), [["# note", "comment"]]);
  assert.deepEqual(kindsOf(tokenizeLine("def f(x): return 1 # one", "py")), [["def", "keyword"], ["return", "keyword"], ["1", "number"], ["# one", "comment"]]);
  assert.deepEqual(kindsOf(tokenizeLine("select 1 -- x", "sql")), [["select", "keyword"], ["1", "number"], ["-- x", "comment"]]);
  assert.deepEqual(kindsOf(tokenizeLine("/* a */ x", "js")), [["/* a */", "comment"]]);
});

test("D16: a # in JS and a // in Python aren't comments", () => {
  assert.deepEqual(kindsOf(tokenizeLine("a.#b", "js")), []);
  assert.deepEqual(kindsOf(tokenizeLine("a // b", "py")), []);
});

test("D16: strings hold escapes and comment marks; one left open runs to the line's end", () => {
  assert.deepEqual(kindsOf(tokenizeLine(String.raw`"a\"b // c"`, "js")), [[String.raw`"a\"b // c"`, "string"]]);
  assert.deepEqual(kindsOf(tokenizeLine("'open", "js")), [["'open", "string"]]);
  assert.deepEqual(kindsOf(tokenizeLine("`tpl`", "js")), [["`tpl`", "string"]]);
});

test("D16: a word holding a keyword or a digit isn't one", () => {
  assert.deepEqual(kindsOf(tokenizeLine("constant a1 _if", "js")), []);
});

test("D16: the tokens always add up to the line", () => {
  for (const line of ['const a = "x"; // y', "  plain  ", "", "/* open", "'''", "a = 1.5e3 # z", "😀 const 😀"]) {
    assert.equal(joined(tokenizeLine(line, "js")), line);
    assert.equal(joined(tokenizeLine(line, "py")), line);
  }
});

test("D16: a very long line isn't tokenized past what a screen could show", () => {
  const line = `const ${"x".repeat(50_000)} = 1`;
  const tokens = tokenizeLine(line, "js");
  assert.equal(joined(tokens), line);
  assert.ok(tokens.length < 10);
});

test("D5: the colors, in hex, and plain text takes the theme's", () => {
  assert.deepEqual(SYNTAX, {
    comment: "#7f848e", keyword: "#c678dd", string: "#98c379", "string.escape": "#56b6c2",
    number: "#d19a66", constant: "#d19a66", boolean: "#d19a66", function: "#61afef", type: "#e5c07b",
    variable: "#e06c75", operator: "#56b6c2", punctuation: "#abb2bf",
  });
  assert.equal(colorOf("comment"), "#7f848e");
  assert.equal(colorOf("keyword"), "#c678dd");
  assert.equal(colorOf("string"), "#98c379");
  assert.equal(colorOf("number"), "#d19a66");
  assert.equal(colorOf("plain"), null);
});
