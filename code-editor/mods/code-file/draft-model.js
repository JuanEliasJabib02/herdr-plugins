// Drafts (plan D20): a dirty buffer is kept on disk while it is dirty, not at
// close, because close() doesn't run on a hot reload and shares 250 ms on quit.
// No herdr or gpui-kit imports: the file calls come in as `io`, as in
// agent-sleep's store.js:
//   { mkdir(dir), readdir(dir), readFile(path) → text, writeFile(path, text),
//     unlink(path), realpath(path) → path | null, now() → ms }
//
// One draft is one file in appHome()/code-editor/drafts/, never under mods/,
// which install.sh deletes and reloads. Its name is <hash of realpath>-<doc>-<seq>
// and its content a JSON line { path, baseSig, length, at } and then the text. A
// write goes to a new sequence and only then are the old ones removed, so a
// crash always leaves one whole draft; `length` tells a whole one from a cut one.

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export const draftsDir = (appHome) => `${trimSlash(String(appHome))}/code-editor/drafts`;

// ── Hashes ───────────────────────────────────────────────────────────────────

// Two FNV-1a passes with different seeds over the UTF-16 units, as Orca's disk
// baseline: `hashA-hashB-length`.
function hashes(text) {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ (unit >> 8) ^ (unit << 8), 0x01000193);
  }
  return [(a >>> 0).toString(16), (b >>> 0).toString(16)];
}

export function signature(text) {
  const [a, b] = hashes(text);
  return `${a}-${b}-${text.length}`;
}

// Hex only: the first dash in a draft's name ends the hash.
export function hashPath(path) {
  const [a, b] = hashes(String(path));
  return `${a}${b}`;
}

// ── Names and format ─────────────────────────────────────────────────────────

export const draftName = (hash, doc, seq) => `${hash}-${doc}-${seq}`;

export function parseDraftName(name) {
  const m = /^([0-9a-z]+)-(.+)-(\d+)$/.exec(name);
  return m ? { name, hash: m[1], doc: m[2], seq: Number(m[3]) } : null;
}

export const serializeDraft = (meta, text) => `${JSON.stringify(meta)}\n${text}`;

// Null for anything that isn't a whole draft.
export function parseDraft(raw) {
  const end = raw.indexOf("\n");
  if (end === -1) return null;
  let meta;
  try {
    meta = JSON.parse(raw.slice(0, end));
  } catch {
    return null;
  }
  if (meta === null || typeof meta !== "object" || typeof meta.path !== "string" || !Number.isInteger(meta.length)) return null;
  const text = raw.slice(end + 1);
  return text.length === meta.length ? { meta, text } : null;
}

// ── What a found draft means ─────────────────────────────────────────────────

// `diskText`: the file's text, null if absent, undefined if it couldn't be read.
// The disk holding the draft's own text comes first: that also covers a draft
// equal to its base, which is nothing to bring back.
export function restoreDraft(meta, draftText, diskText) {
  if (diskText === null) return "deleted";
  if (diskText === undefined) return "conflict";
  if (diskText === draftText) return "drop";
  return signature(diskText) === meta.baseSig ? "resume" : "conflict";
}

// ── Finding one ──────────────────────────────────────────────────────────────

const bySeqDown = (a, b) => b.seq - a.seq;

// The highest sequence that reads whole. A read that rejects counts as broken.
async function newestWhole(io, dir, entries) {
  for (const entry of [...entries].sort(bySeqDown)) {
    let raw;
    try {
      raw = await io.readFile(`${dir}/${entry.name}`);
    } catch {
      continue;
    }
    const whole = parseDraft(raw);
    if (whole) return whole;
  }
  return null;
}

// Its own doc first: a restored tab keeps props().doc, and realpath fails on a
// missing file. The hash only with a new doc, which is reopening the file, and
// never a doc alive in another tab. `names`: what the caller's store now answers
// for, so a whole group goes when its newest does. `seq`: the highest of its own.
export async function findDraft(io, { dir, doc, hash, isLive = () => false }) {
  let listed;
  try {
    listed = await io.readdir(dir);
  } catch {
    return { draft: null, names: [], seq: 0 };
  }
  const entries = listed.map(parseDraftName).filter(Boolean);
  const mine = entries.filter((e) => e.doc === doc);
  const seq = mine.reduce((high, e) => Math.max(high, e.seq), 0);
  const mineNames = mine.map((e) => e.name);
  const own = await newestWhole(io, dir, mine);
  if (own) return { draft: { ...own, doc }, names: mineNames, seq };
  if (!hash) return { draft: null, names: mineNames, seq };

  const others = entries.filter((e) => e.hash === hash && e.doc !== doc && !isLive(e.doc));
  let best = null;
  for (const other of new Set(others.map((e) => e.doc))) {
    const whole = await newestWhole(io, dir, others.filter((e) => e.doc === other));
    if (whole && (!best || whole.meta.at > best.meta.at)) best = { ...whole, doc: other };
  }
  if (!best) return { draft: null, names: mineNames, seq };
  return { draft: best, names: [...mineNames, ...others.map((e) => e.name)], seq };
}

// ── Where a file is ──────────────────────────────────────────────────────────

const quietly = async (f) => {
  try {
    return (await f()) ?? null;
  } catch {
    return null;
  }
};

// `key` names the file for drafts. The file may not exist, and then realpath
// fails: its folder's realpath plus the name, else the path as given. `realDir`
// is what a watch batch is compared against, because watchFolder hands out
// resolved paths (/private/tmp/...).
export async function resolveFile(io, file) {
  const cut = file.lastIndexOf("/");
  const dir = cut > 0 ? file.slice(0, cut) : "/";
  const name = file.slice(cut + 1);
  const real = await quietly(() => io.realpath(file));
  const realDir = await quietly(() => io.realpath(dir));
  return { key: real ?? (realDir ? `${trimSlash(realDir)}/${name}` : file), dir, realDir: realDir ?? dir, name };
}

// ── The queue ────────────────────────────────────────────────────────────────

// Writes and deletes share one serial queue, so a draft can't land after its
// deletion. Everything queued is replaced by what supersedes it: only the latest
// text matters, and a clear makes any write waiting pointless. writeNow and
// clearNow are for close(): it can't wait for work already started, and a
// cancelled task never finishes, so they skip the queue. A write that lands late
// under a lower sequence loses at recovery. The caller keeps the returned promise
// inside a cx.spawn.
export function createDraftStore(io, { dir, doc, hash, path, seq = 0, names = [], onError = () => {} }) {
  let last = seq;
  const known = new Set(names);
  const queue = [];
  let pumping = null;

  const pathOf = (name) => `${dir}/${name}`;

  async function put(text, baseSig) {
    const name = draftName(hash, doc, ++last);
    await io.mkdir(dir);
    await io.writeFile(pathOf(name), serializeDraft({ path, baseSig, length: text.length, at: io.now() }, text));
    return name;
  }

  async function remove(list) {
    for (const name of list) {
      try {
        await io.unlink(pathOf(name));
      } catch {
        // Already gone, or it stays for the next clear to find.
      }
      known.delete(name);
    }
  }

  // Every file of this doc, those a previous copy wrote too, and what it took
  // over from a reopen.
  async function ownNames() {
    const all = new Set(known);
    try {
      for (const name of await io.readdir(dir)) {
        if (parseDraftName(name)?.doc === doc) all.add(name);
      }
    } catch {
      // No folder: only what it already knew about.
    }
    return [...all];
  }

  async function run(op) {
    if (op.kind === "clear") {
      await remove(await ownNames());
      return;
    }
    const name = await put(op.text, op.baseSig);
    const { seq: written } = parseDraftName(name);
    // Older than this one. A write that hung and landed late must not take with it
    // the newer sequence close() wrote meanwhile.
    const old = [...known].filter((other) => {
      const parsed = parseDraftName(other);
      return parsed?.doc !== doc || parsed.seq < written;
    });
    known.add(name);
    await remove(old);
  }

  function pump() {
    if (pumping) return pumping;
    if (queue.length === 0) return Promise.resolve();
    pumping = (async () => {
      while (queue.length > 0) {
        try {
          await run(queue.shift());
        } catch (e) {
          onError(e);
        }
      }
      pumping = null;
    })();
    return pumping;
  }

  return {
    write(text, baseSig) {
      if (queue.at(-1)?.kind === "write") queue.pop();
      queue.push({ kind: "write", text, baseSig });
      return pump();
    },
    // Resolves once the deletion is done, after any write that's running.
    clear() {
      queue.length = 0;
      queue.push({ kind: "clear" });
      return pump();
    },
    async writeNow(text, baseSig) {
      queue.length = 0;
      known.add(await put(text, baseSig));
    },
    async clearNow() {
      queue.length = 0;
      await remove(await ownNames());
    },
    hasDrafts: () => known.size > 0 || pumping !== null,
  };
}
