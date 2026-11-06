// Settings and sleeping records (plan D11): `settings.json` and
// `sleeping.json` under appHome()/agent-sleep. This module is pure: the file
// calls are injected as `io` ({ read(path) → text | null, write(path, text,
// expected), mkdirp?(dir) }), which the mod wires to Herdr's readTextFile /
// writeTextFile (a compare-and-swap: it rejects when the file no longer
// holds `expected`). One writer: only the loop copy saves (D11).
//
// Record states (D4, D13): "live" (a running Claude, kept for restart
// recovery), "stopping" (written before /exit), "asleep" (the shell is back).
// `flags` holds only the user's own flags (D8): launcher flags never get here.

import { DEFAULT_IDLE_MINUTES, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES } from "./rules.js";

export const VERSION = 1;
export const STATES = Object.freeze(["live", "stopping", "asleep"]);
export const BY = Object.freeze(["auto", "manual", "restart"]);
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, idleMinutes: DEFAULT_IDLE_MINUTES });

export function paths(appHome) {
  const dir = `${String(appHome).replace(/\/+$/, "")}/agent-sleep`;
  return {
    dir,
    settings: `${dir}/settings.json`,
    sleeping: `${dir}/sleeping.json`,
    sleepingBak: `${dir}/sleeping.json.bak`,
  };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

// ── settings.json ──────────────────────────────────────────────────────────

const validMinutes = (v) => Number.isInteger(v) && v >= MIN_IDLE_MINUTES && v <= MAX_IDLE_MINUTES;

// A missing file is the defaults; a file that isn't a JSON object is the
// defaults too, flagged `bad`; each field that isn't valid falls back alone.
export function parseSettings(text) {
  if (text == null) return { settings: { ...DEFAULT_SETTINGS }, bad: false };
  const { ok, value } = parseJson(text);
  if (!ok || !isObject(value)) return { settings: { ...DEFAULT_SETTINGS }, bad: true };
  return {
    settings: {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
      idleMinutes: validMinutes(value.idleMinutes) ? value.idleMinutes : DEFAULT_SETTINGS.idleMinutes,
    },
    bad: false,
  };
}

export async function loadSettings(io, p) {
  return parseSettings(await io.read(p.settings)).settings;
}

// ── sleeping.json ──────────────────────────────────────────────────────────

const isText = (v) => typeof v === "string" && v.length > 0;
const isTextOrNull = (v) => v === null || v === undefined || typeof v === "string";
const isCountOrNull = (v) => v === null || v === undefined || (Number.isFinite(v) && v >= 0);

function validRecord(r) {
  return (
    isObject(r) &&
    STATES.includes(r.state) &&
    isText(r.sessionId) &&
    isText(r.cwd) &&
    Array.isArray(r.flags) && r.flags.every((f) => typeof f === "string") &&
    Number.isFinite(r.at) &&
    BY.includes(r.by) &&
    isTextOrNull(r.workspacePath) &&
    isTextOrNull(r.holder) &&
    isCountOrNull(r.rssKb) &&
    isCountOrNull(r.rootPid)
  );
}

// A missing file is no records. A file that isn't version 1 with a records
// object, or that holds an entry that isn't a valid record, is flagged `bad`
// (the caller keeps it as .bak before writing over it); valid entries survive.
export function parseRecords(text) {
  if (text == null) return { records: {}, bad: false };
  const { ok, value } = parseJson(text);
  if (!ok || !isObject(value) || value.version !== VERSION || !isObject(value.records)) {
    return { records: {}, bad: true };
  }
  const records = {};
  let bad = false;
  for (const [address, r] of Object.entries(value.records)) {
    if (validRecord(r)) records[address] = r;
    else bad = true;
  }
  return { records, bad };
}

export function serializeRecords(records) {
  return `${JSON.stringify({ version: VERSION, records }, null, 2)}\n`;
}

// Returns { records, text }: `text` is what is on disk now, the `expected`
// snapshot for the next save. A bad file is copied to .bak first.
export async function loadRecords(io, p) {
  const text = await io.read(p.sleeping);
  const { records, bad } = parseRecords(text);
  if (bad && text != null) {
    const bak = await io.read(p.sleepingBak);
    await io.write(p.sleepingBak, text, bak);
  }
  return { records, text };
}

// Compare-and-swap save: rejects (through io.write) when the file changed
// since `expected` was read. Returns the text written, the next `expected`.
export async function saveRecords(io, p, records, expected) {
  if (typeof io.mkdirp === "function") await io.mkdirp(p.dir);
  const text = serializeRecords(records);
  await io.write(p.sleeping, text, expected);
  return text;
}

// ── pure updates ──────────────────────────────────────────────────────────

export function withRecord(records, address, record) {
  return { ...records, [address]: record };
}

export function withoutRecord(records, address) {
  const next = { ...records };
  delete next[address];
  return next;
}

const statusWord = (s) => (isObject(s) ? s.state : s) ?? null;

// The shell is the foreground again when the foreground process is the
// terminal's root process (Juan's terminals are a login shell with Claude
// on top). Without both pids there is no evidence.
export function foregroundIsShell(t) {
  return Boolean(t && t.foreground && t.pid != null && t.foreground.pid === t.pid);
}

// Brings records in line with the terminals (D4): run every tick and once at
// mod start. Returns { records, failed, changed }; `failed` lists addresses
// that get failed-until (a stop that never finished). Without a terminal
// list nothing is decided.
export function reconcile({ records, terminals, now, idleMs }) {
  if (!Array.isArray(terminals)) return { records, failed: [], changed: false };
  const byAddress = new Map(terminals.map((t) => [t.address, t]));
  let next = records;
  const failed = [];
  for (const [address, r] of Object.entries(records)) {
    const t = byAddress.get(address);
    if (!t) {
      next = withoutRecord(next, address);
      continue;
    }
    if (r.state !== "stopping") continue;
    if (foregroundIsShell(t)) {
      next = withRecord(next, address, { ...r, state: "asleep" });
    } else if (statusWord(t.status) === "working" || now - r.at >= idleMs) {
      next = withoutRecord(next, address);
      failed.push(address);
    }
  }
  return { records: next, failed, changed: next !== records };
}

// Takes one record out for a resume, so it can't be resumed twice. By
// default only "asleep" records are claimable (D8); restart recovery passes
// { states: ["live"] } (D13). Returns { records, claimed }.
export function claim(records, address, { states = ["asleep"] } = {}) {
  const r = Object.hasOwn(records, address) ? records[address] : undefined;
  if (!r || !states.includes(r.state)) return { records, claimed: null };
  return { records: withoutRecord(records, address), claimed: r };
}
