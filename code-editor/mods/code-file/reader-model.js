// Which view a file gets in its tab, and the commands of the two readers (plan
// lector-md: D7, D9, D10). No herdr or gpui-kit imports.

export const MOD = "code-file";

// Orca's rich-editor limit (600 KiB): a bigger Markdown file opens in Source (D9).
export const PREVIEW_LIMIT = 600 * 1024;

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

export const READER_TEXT = Object.freeze({
  source: "Source",
  preview: "Preview",
  loading: "Loading preview...",
});

// A leading dot isn't an extension: `.md` alone is a dotfile, not Markdown.
function extensionOf(path) {
  const name = String(path).slice(String(path).lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

// "markdown", "pdf" or "text".
export function viewKind(path) {
  const ext = extensionOf(path);
  if (MARKDOWN.has(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  return "text";
}

// A tab opened at a line keeps the line view (D16 of code-editor); a PDF has no mode.
export function initialMode(kind, line) {
  if (line) return "lines";
  return kind === "markdown" ? "preview" : "editor";
}

// D9: a Markdown file too big for the preview opens in Source.
export const tooBigForPreview = (text) => typeof text === "string" && text.length > PREVIEW_LIMIT;

// D7: the zoom keys belong to the PDF; anywhere else they are the window's again.
const APP_ZOOM = Object.freeze({ "zoom-in": "app.zoom_in", "zoom-out": "app.zoom_out", "zoom-reset": "app.zoom_reset" });
export const appZoomFor = (name) => (Object.hasOwn(APP_ZOOM, name) ? APP_ZOOM[name] : null);

// A command the readers may take: `code-file.<name>` or `code-file.<name>:<arg>`, the
// prefix optional, as Herdr delivers it. The reader says whether it was its own.
export function splitCommand(raw) {
  const text = String(raw);
  const command = text.startsWith(`${MOD}.`) ? text.slice(MOD.length + 1) : text;
  if (!command) return null;
  const cut = command.indexOf(":");
  return cut === -1 ? { name: command, arg: "" } : { name: command.slice(0, cut), arg: command.slice(cut + 1) };
}
