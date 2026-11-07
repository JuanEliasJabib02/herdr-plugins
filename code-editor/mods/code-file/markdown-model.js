// What the Markdown preview decides (plan lector-md T2), with no herdr or gpui-kit
// imports so `node --test` can load it: the source split into the blocks TextView
// can't draw (D1), the colors of fenced code (D13), where a link goes (D8) and where
// an image comes from (D3). preview-view.js draws and runs it.

import { languageFor } from "./document-model.js";
import { colorOf, splitLines, tokenizeLine } from "./line-view-model.js";

// Orca's words (S6).
export const PREVIEW_TEXT = Object.freeze({
  frontMatter: "Front Matter",
  copy: "Copy code",
  copied: "Copied",
});
export const notFound = (path) => `File not found: ${path}`;
export const cannotOpenDir = (path) => `Cannot open directory: ${path}`;

// ── The blocks (D1) ──────────────────────────────────────────────────────────

// Orca's (markdown-frontmatter.ts): only at the very top, closed by the same fence.
const FRONT_MATTER = /^(---|\+\+\+)\n(?:[\s\S]*?\n)?\1(?:\n|$)/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const BULLET = /^ {0,3}[-+*][ \t]+\S/;
const FIRST_ITEM = /^ {0,3}1[.)][ \t]+\S/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+\S|[ \t]*$)/;
const DEFINITION = /^ {0,3}\[((?:[^\\\]]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
// A paragraph starts at column 0–3: four spaces or a tab are indented code.
const PARAGRAPH_START = /^ {0,3}[^ \t]/;

const isBlank = (line) => /^\s*$/.test(line);

// { indent, mark, lang } for a line that opens a fenced block, else null. A
// backtick fence's info can't hold a backtick: that line is inline code.
function fenceOpen(line) {
  const m = FENCE.exec(line);
  if (!m) return null;
  if (m[2][0] === "`" && m[3].includes("`")) return null;
  return { indent: m[1].length, mark: m[2], lang: m[3].trim().split(/\s+/)[0] ?? "" };
}

const closesFence = (line, mark) => {
  const m = FENCE_CLOSE.exec(line);
  return Boolean(m) && m[1][0] === mark[0] && m[1].length >= mark.length;
};

const stripIndent = (line, n) => line.replace(new RegExp(`^ {0,${n}}`), "");

// CommonMark matches labels without case and with spaces collapsed.
const labelKey = (label) => label.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();
const unescape = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, "$1").replaceAll("&amp;", "&");
const unwrap = (dest) => unescape(dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest);
const titleOf = (raw) => (raw ? unescape(raw.slice(1, -1)) : "");

// Every link reference definition outside fenced code: the map for images, and
// the lines themselves, which every run gets (a run is its own document to TextView).
function definitionsOf(lines) {
  const map = new Map();
  const raw = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open.mark;
      continue;
    }
    const m = DEFINITION.exec(line);
    if (!m) continue;
    const key = labelKey(m[1]);
    if (!map.has(key)) map.set(key, { url: unwrap(m[2]), title: titleOf(m[3]) });
    raw.push(line.trim());
  }
  return { map, raw };
}

// ── Images in a line: ![alt](src "title"), ![alt][ref], [![alt](src)](href) ──

// The end of a bracketed label starting at `at` (the `[`), escapes and nesting
// respected; -1 if it doesn't close.
function labelEnd(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

const DESTINATION = /\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/y;

// What follows a label: an inline (dest "title"), a [ref], [] (the label itself), or
// nothing (the label itself, if it was defined). Null if it leads nowhere.
function targetAt(s, at, label, defs, shortcut) {
  DESTINATION.lastIndex = at;
  const inline = DESTINATION.exec(s);
  if (inline) return { url: unwrap(inline[1]), title: titleOf(inline[2]), end: DESTINATION.lastIndex };
  if (s[at] === "[") {
    const close = labelEnd(s, at);
    if (close === -1) return null;
    const ref = s.slice(at + 1, close);
    const found = defs.get(labelKey(ref.trim() === "" ? label : ref));
    return found ? { ...found, end: close + 1 } : null;
  }
  if (!shortcut) return null;
  const found = defs.get(labelKey(label));
  return found ? { ...found, end: at } : null;
}

function imageAt(s, at, defs) {
  if (s[at] !== "!" || s[at + 1] !== "[") return null;
  const close = labelEnd(s, at + 1);
  if (close === -1) return null;
  const alt = s.slice(at + 2, close);
  const target = targetAt(s, close + 1, alt, defs, true);
  if (!target) return null;
  return { image: { alt: unescape(alt), src: target.url, title: target.title, href: null }, end: target.end };
}

function linkedImageAt(s, at, defs) {
  if (s[at] !== "[") return null;
  const inner = imageAt(s, at + 1, defs);
  if (!inner || s[inner.end] !== "]") return null;
  const target = targetAt(s, inner.end + 1, s.slice(at + 1, inner.end), defs, false);
  if (!target) return null;
  return { image: { ...inner.image, href: target.url }, end: target.end };
}

// The images of a line made of nothing else, or null.
function imagesOf(line, defs) {
  if (!PARAGRAPH_START.test(line)) return null;
  const s = line.trim();
  const images = [];
  let at = 0;
  while (at < s.length) {
    if (/\s/.test(s[at])) {
      at++;
      continue;
    }
    const found = linkedImageAt(s, at, defs) ?? imageAt(s, at, defs);
    if (!found) return null;
    images.push(found.image);
    at = found.end;
  }
  return images.length > 0 ? images : null;
}

// A line that ends the paragraph above it. A setext underline isn't one: it makes
// the paragraph a heading.
const interrupts = (line) => !SETEXT.test(line)
  && (fenceOpen(line) !== null || ATX.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || FIRST_ITEM.test(line));

// GitHub's callouts (`> [!NOTE]`), which Orca titles. TextView would print the marker,
// so it becomes the title, bold, in a paragraph of its own inside the quote.
const CALLOUT = /^([ \t]{0,3}>[ \t]?)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gim;
const CALLOUT_TITLES = Object.freeze({ NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" });
export const titleCallouts = (text) => text.replace(CALLOUT, (_m, quote, kind) => `${quote}**${CALLOUT_TITLES[kind.toUpperCase()]}**\n${quote.trimEnd()}`);

// A line after which the next one starts a block of its own.
const endsBlock = (line) => isBlank(line) || ATX.test(line) || RULE.test(line) || DEFINITION.test(line);

// The source as blocks, top to bottom:
//   { kind: "frontmatter", text }   the text between the fences
//   { kind: "markdown", text }      a run for one TextView, with the definitions
//   { kind: "code", lang, text }    a fenced block; lang as the info string wrote it
//   { kind: "images", images: [{ alt, src, title, href }] }  a paragraph of images alone
export function splitBlocks(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const blocks = [];
  let body = text;
  const front = FRONT_MATTER.exec(text);
  if (front) {
    const inner = front[0].replace(/^(?:---|\+\+\+)\n/, "").replace(/\n?(?:---|\+\+\+)\n?$/, "");
    blocks.push({ kind: "frontmatter", text: inner.trim() });
    body = text.slice(front[0].length);
  }
  const lines = body.split("\n");
  const defs = definitionsOf(lines);
  let run = [];
  const flush = () => {
    const words = run.filter((line) => !isBlank(line));
    if (words.some((line) => !DEFINITION.test(line))) {
      const own = new Set(words.map((line) => line.trim()));
      const missing = defs.raw.filter((def) => !own.has(def));
      const runText = titleCallouts(run.join("\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, ""));
      blocks.push({ kind: "markdown", text: missing.length > 0 ? `${runText}\n\n${missing.join("\n")}` : runText });
    }
    run = [];
  };

  let boundary = true; // the line before ended a block, so this one may start one
  // R9: inside a list item, an indented fence or image paragraph is the item's:
  // pulled out, it would cut the list in two. Those stay in the run for TextView.
  let inList = false;
  let blankBefore = true;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const open = fenceOpen(line);
    const indented = /^[ \t]/.test(line);
    if (LIST_ITEM.test(line)) inList = true;
    else if (inList && !isBlank(line) && !indented && (blankBefore || ATX.test(line) || RULE.test(line) || QUOTE.test(line) || open)) inList = false;
    blankBefore = isBlank(line);
    if (open && inList && indented) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j], open.mark)) j++;
      for (const end = Math.min(j, lines.length - 1); i <= end; i++) run.push(lines[i]);
      boundary = true;
      blankBefore = false;
      continue;
    }
    if (open) {
      flush();
      const code = [];
      let j = i + 1;
      for (; j < lines.length && !closesFence(lines[j], open.mark); j++) code.push(stripIndent(lines[j], open.indent));
      blocks.push({ kind: "code", lang: open.lang, text: code.join("\n") });
      i = j + 1;
      boundary = true;
      continue;
    }
    const first = boundary && !(inList && indented) ? imagesOf(line, defs.map) : null;
    if (first) {
      const images = [...first];
      let j = i + 1;
      for (let more; j < lines.length && !isBlank(lines[j]) && (more = imagesOf(lines[j], defs.map)); j++) images.push(...more);
      if (j >= lines.length || isBlank(lines[j]) || interrupts(lines[j])) {
        flush();
        blocks.push({ kind: "images", images });
        i = j;
        boundary = true;
        continue;
      }
      // A lazy line or an underline follows: the paragraph is text after all.
      for (; i < j; i++) run.push(lines[i]);
      boundary = false;
      continue;
    }
    run.push(line);
    boundary = endsBlock(line);
    i++;
  }
  flush();
  return blocks;
}

// ── Fenced code in One Dark (D13) ────────────────────────────────────────────

// The names a fence uses for what document-model.js knows by extension.
const FENCE_NAMES = Object.freeze({
  javascript: "js", node: "js", typescript: "ts", python: "py", py3: "py", shell: "sh", console: "sh", shellscript: "sh",
  shellsession: "sh", ruby: "rb", rust: "rs", golang: "go", kotlin: "kt", perl: "pl", "c++": "cpp", make: "makefile",
  dockerfile: "sh", markdown: "md",
});
const PLAIN = new Set(["", "text", "txt", "plain", "plaintext"]);

// The tokenizer's language for a fence's name, or null: no colors.
export function codeLanguage(name) {
  const key = String(name ?? "").toLowerCase();
  if (PLAIN.has(key)) return null;
  const ext = Object.hasOwn(FENCE_NAMES, key) ? FENCE_NAMES[key] : key;
  return languageFor(`code.${ext}`).language;
}

// One array of { text, color, italic } per line; color null is the theme's text.
export function highlight(text, lang) {
  const language = codeLanguage(lang);
  return splitLines(String(text)).map((line) => {
    if (line === "") return [];
    if (!language) return [{ text: line, color: null, italic: false }];
    return tokenizeLine(line, language).map((t) => ({ text: t.text, color: colorOf(t.kind), italic: t.kind === "comment" }));
  });
}

// ── Where a link goes (D8) and where an image comes from (D3) ────────────────

const dirOf = (file) => {
  const cut = String(file).lastIndexOf("/");
  return cut > 0 ? file.slice(0, cut) : "/";
};

// `rel` from `dir`, with `.` and `..` resolved; never above the root.
function resolvePath(dir, rel) {
  const parts = [];
  for (const part of `${rel.startsWith("/") ? "" : dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// file:// off, ?query and #fragment cut, then %-decoded (so an escaped # stays in
// the name), from the Markdown file's folder.
function pathOf(url, file) {
  let path = url.replace(/^file:\/\/(?:localhost)?/i, "");
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray % stays as written.
  }
  return resolvePath(dirOf(file), path);
}

const WEB = /^https?:\/\//i;

// { kind: "web", url } | { kind: "mail", url } | { kind: "anchor" } | { kind: "path", path }
export function linkTarget(raw, file) {
  const url = String(raw ?? "").trim();
  if (url === "" || url.startsWith("#")) return { kind: "anchor" };
  if (WEB.test(url)) return { kind: "web", url };
  if (/^mailto:/i.test(url)) return { kind: "mail", url };
  return { kind: "path", path: pathOf(url, file) };
}

// { kind: "url", url, key } | { kind: "file", path, key }, or null for what can't
// be drawn (data:, other schemes): the image shows its alt text.
export function imageSource(raw, file) {
  const src = String(raw ?? "").trim();
  if (src === "") return null;
  const url = src.startsWith("//") ? `https:${src}` : src;
  if (WEB.test(url)) return { kind: "url", url, key: `url:${url}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src)) return null;
  const path = pathOf(src, file);
  return { kind: "file", path, key: `file:${path}` };
}

// What a path is, asked of the shell: `$1` is the path (D8).
export const PATH_PROBE = 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo none; fi';
export const pathKind = (stdout) => {
  const kind = String(stdout ?? "").trim();
  return kind === "dir" || kind === "file" ? kind : "none";
};

// A path as a toast names it: the home as ~.
export const shownPath = (path, home) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
