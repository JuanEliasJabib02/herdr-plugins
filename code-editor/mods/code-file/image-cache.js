// The Markdown preview's images (plan lector-md D3, D12), with no herdr or
// gpui-kit imports so `node --test` can load it. image() draws only paths relative
// to the Herdr home, so every image is copied or downloaded under
// <appHome>/data/code-file/img/ and drawn as data/code-file/img/<name>. The name is
// a content key, so a changed image gets a new name and the loader's cache, which
// isn't documented, can never show the old one:
//   a file:  f<hash of path, mtime and size>.<ext>
//   a URL:   u<hash of the URL>-<md5 of what came>.<ext>
// Each lands as a `.part` first and is renamed once it's known to be an image.
//
// io: { exec(cmd, args) → { code, stdout, stderr }, mkdir(dir), readdir(dir) → names,
//       readText(path) → text, unlink(path) }

import { hashPath } from "./draft-model.js";

export const IMG_DIR = "data/code-file/img";
export const MAX_IMAGE = 10 * 1024 * 1024;
const AT_ONCE = 4;

// sips's format names for what GPUI's loader draws; anything else shows its alt.
const RASTER = Object.freeze({ png: "png", jpeg: "jpg", gif: "gif", bmp: "bmp", tiff: "tiff", webp: "webp", ico: "ico" });

// D12: http(s) only, redirects too, as an array: no shell ever sees the URL.
export const curlArgs = (url, out) => [
  "-fsSL", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-time", "15", "--max-filesize", String(MAX_IMAGE), "-o", out, url,
];

// `stat -L -f '%m %z %HT'`: mtime, size, and the file's type in words.
export function parseStat(stdout) {
  const m = /^(\d+) (\d+) (.+)$/.exec(String(stdout ?? "").trim());
  return m ? { mtime: m[1], size: Number(m[2]), dir: m[3] === "Directory" } : null;
}

// `sips -g format -g pixelWidth -g pixelHeight`.
export function parseSips(stdout) {
  const text = String(stdout ?? "");
  const number = (name) => Number(new RegExp(`${name}:\\s*([\\d.]+)`).exec(text)?.[1] ?? 0);
  return { format: /format:\s*(\S+)/.exec(text)?.[1] ?? "", width: number("pixelWidth"), height: number("pixelHeight") };
}

// D12: an SVG's own width and height (plain or px), the viewBox's ratio for a
// missing one, the viewBox alone, else a browser's 300 × 150.
export function svgSize(text) {
  const attrs = /<svg\b([^>]*)>/i.exec(String(text ?? ""))?.[1] ?? "";
  const attr = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attrs)?.[2] ?? null;
  const length = (name) => {
    const m = /^\s*([\d.]+)\s*(?:px)?\s*$/i.exec(attr(name) ?? "");
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  };
  const box = (attr("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const ratio = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[3] / box[2] : null;
  const width = length("width");
  const height = length("height");
  if (width && height) return { width, height };
  if (width && ratio) return { width, height: width * ratio };
  if (height && ratio) return { width: height / ratio, height };
  if (ratio) return { width: box[2], height: box[3] };
  return { width: 300, height: 150 };
}

// D12: natural size, 1 image px to 1 logical px, no wider than `max`.
export function fitWidth({ width, height }, max) {
  if (!(width > max)) return { width, height };
  return { width: Math.round(max), height: Math.round((height * max) / width) };
}

const FAILED = Object.freeze({ ok: false });
let parts = 0;

export function createImageCache(io, { appHome }) {
  const dir = `${appHome}/${IMG_DIR}`;
  const known = new Map(); // content key or URL → its load, once per cache
  let busy = 0;
  const waiting = [];

  const run = async (cmd, args) => {
    try {
      return await io.exec(cmd, args);
    } catch (e) {
      return { code: -1, stdout: "", stderr: String(e?.message ?? e) };
    }
  };
  const drop = (path) => Promise.resolve().then(() => io.unlink(path)).catch(() => {});
  const partFor = (base) => `${dir}/${base}.${Date.now().toString(36)}${(++parts).toString(36)}.part`;

  // AT_ONCE loads at a time: a README of badges doesn't start twenty curls.
  async function inTurn(work) {
    if (busy >= AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
    busy++;
    try {
      return await work();
    } finally {
      busy--;
      waiting.shift()?.();
    }
  }

  const once = (key, work) => {
    if (!known.has(key)) known.set(key, work());
    return known.get(key);
  };

  // { ext, width, height } of an image GPUI draws, or null.
  async function probe(path) {
    const got = await run("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", path]);
    const sips = got.code === 0 ? parseSips(got.stdout) : { format: "" };
    if (Object.hasOwn(RASTER, sips.format) && sips.width > 0 && sips.height > 0) return { ext: RASTER[sips.format], width: sips.width, height: sips.height };
    let text;
    try {
      text = await io.readText(path);
    } catch {
      return null;
    }
    return /<svg[\s>]/i.test(text) ? { ext: "svg", ...svgSize(text) } : null;
  }

  // The part file becomes <key>.<ext>, or goes.
  async function settle(part, key) {
    const kind = await probe(part);
    if (!kind) {
      await drop(part);
      return FAILED;
    }
    const name = `${key}.${kind.ext}`;
    if ((await run("/bin/mv", ["-f", part, `${dir}/${name}`])).code !== 0) {
      await drop(part);
      return FAILED;
    }
    return { ok: true, path: `${IMG_DIR}/${name}`, width: kind.width, height: kind.height };
  }

  async function loadFile(path) {
    const stat = parseStat((await run("/usr/bin/stat", ["-L", "-f", "%m %z %HT", path])).stdout);
    if (!stat || stat.dir) return FAILED;
    const key = `f${hashPath(`${path}\n${stat.mtime}\n${stat.size}`)}`;
    return once(key, async () => {
      await io.mkdir(dir);
      const part = partFor(key);
      if ((await run("/bin/cp", [path, part])).code !== 0) {
        await drop(part);
        return FAILED;
      }
      return settle(part, key);
    });
  }

  function loadUrl(url) {
    const base = `u${hashPath(url)}`;
    return once(`url:${url}`, async () => {
      await io.mkdir(dir);
      const part = partFor(base);
      if ((await run("/usr/bin/curl", curlArgs(url, part))).code === 0) {
        const sum = (await run("/sbin/md5", ["-q", part])).stdout.trim().slice(0, 12);
        return settle(part, sum ? `${base}-${sum}` : base);
      }
      await drop(part);
      // Offline, or the server's down: what an earlier download of it left.
      let names = [];
      try {
        names = await io.readdir(dir);
      } catch {
        // No folder: nothing was ever downloaded.
      }
      const old = names.find((name) => name.startsWith(`${base}-`) && !name.endsWith(".part"));
      if (!old) return FAILED;
      const kind = await probe(`${dir}/${old}`);
      return kind ? { ok: true, path: `${IMG_DIR}/${old}`, width: kind.width, height: kind.height } : FAILED;
    });
  }

  return {
    // `source`: markdown-model.js's imageSource. Resolves { ok: true, path, width,
    // height } or { ok: false }; never rejects.
    load(source) {
      return inTurn(async () => {
        try {
          if (source?.kind === "file") return await loadFile(source.path);
          if (source?.kind === "url") return await loadUrl(source.url);
        } catch {
          // Whatever broke, the image shows its alt.
        }
        return FAILED;
      });
    },
  };
}
